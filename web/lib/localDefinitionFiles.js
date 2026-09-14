// Browser-side File System Access API counterpart of `lib/definition.js`'s
// disk-backed reader/writer, for a **local-workspace definition** (WI #384,
// ADR-0029, parent Feature #380). Phase 3 (WI #381) gave local *instances* a
// `definitions/` folder pattern to pin a *library* definition against; this
// module is the analogous "mirror `web/lib/localInstanceFiles.js`" piece the
// ticket asks for, but for the definition's own files rather than an
// instance's — `definitions/<id>/<version>/definition.yaml` +
// `modules/<id>.yaml` + `templates/<name>.md.tmpl` + `templates/reference-
// <artefactId>.docx`, read and written straight through a
// `FileSystemDirectoryHandle` (never through the gantry server — a local
// workspace's own definitions/ folder is invisible to it).
//
// Kept in lock-step with `lib/definition.js`'s own builders/readers (see each
// function's doc comment for which one it mirrors), same "verbatim port, not
// an import" convention as `web/lib/localInstanceFiles.js` and
// `web/lib/localStatus.js` — `web/` ships with no build step, so it can't
// import `lib/definition.js` itself (node:fs, etc.).
//
// The "structure" shape every function here reads/writes is the same
// definition-version-projection shape `lib/definition.js`'s
// `definitionVersionProjection` returns and `GET /api/definitions/:id/versions/:n`
// already hands the browser for a *library* definition — so a local-workspace
// definition's structure slots into every existing consumer
// (`findLocalDefinitionProblems`/`validateLocalDefinition`/`getLocalStatus`/
// `checkLocalGate`, `web/lib/localStatus.js`) with no reshaping.

import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { readTextFile, writeTextFile, readBinaryFile, writeBinaryFile, listDir } from './localWorkspace.js'

// Verbatim copy of lib/slug.js's isValidSlug — a single path segment, never
// a traversal token. lib/slug.js has no node-only imports of its own, but
// web/ duplicates rather than imports it, same convention as every other
// file in this directory.
const SINGLE_SEGMENT_RE = /^[^\\/]+$/
export function isValidLocalDefinitionId(id) {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..' && SINGLE_SEGMENT_RE.test(id)
}

const VALID_FIELD_TYPES = new Set(['markdown', 'list'])
export const TEMPLATE_NAME_RE = /^[A-Za-z0-9._-]+\.md\.tmpl$/

function definitionDirPath(definitionId, version) {
  return `definitions/${definitionId}/${version}`
}

function referenceDocxName(artefactId) {
  return `reference-${artefactId}.docx`
}

/**
 * A `.docx` is an OOXML package — same byte-signature check as
 * `lib/definition.js`'s `isValidDocxBuffer`, ported so an uploaded reference
 * doc can be sanity-checked client-side before it's written.
 */
export function isValidDocxBuffer(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false
  const text = new TextDecoder('latin1').decode(bytes)
  return text.includes('[Content_Types].xml') && text.includes('word/document.xml')
}

/**
 * A fresh, blank definition-version-projection structure for a brand-new
 * local-workspace definition — the local-only counterpart of
 * `lib/definition.js`'s `createBlankDefinition` (draft status, version 1, no
 * stages/artefacts/modules yet).
 */
export function blankLocalDefinitionStructure(id, title) {
  return { id, title: title || id, description: '', version: 1, status: 'draft', stages: [], artefacts: [], modules: [] }
}

// ---------------------------------------------------------------------------
// definition.yaml — write side (structure -> text) mirrors
// lib/definition.js's buildDefinitionYamlObject; read side (text -> raw)
// mirrors the plain readYAML(definition.yaml) lib/definition.js's
// loadDefinition/findDefinitionProblems both start from.
// ---------------------------------------------------------------------------

/** Verbatim port of `lib/definition.js`'s `buildDefinitionYamlObject`, minus the disk-only `onDiskRaw` fallback (a local-workspace caller always has the full structure already in memory — see this file's header comment). */
export function renderDefinitionYaml(structure) {
  const obj = {}
  obj.id = structure.id
  obj.version = structure.version
  obj.status = structure.status
  obj.title = structure.title
  obj.description = structure.description
  obj.stages = (structure.stages ?? []).map((s) => {
    const entry = { id: s.id, title: s.title, purpose: s.purpose, gate: s.gate, modules: s.modules ?? [] }
    if (s.example !== undefined) entry.example = s.example
    if (s.copiedFrom !== undefined) entry['copied-from'] = s.copiedFrom
    return entry
  })
  obj.artefacts = (structure.artefacts ?? []).map((a) => {
    const entry = { id: a.id, title: a.title, purpose: a.purpose, template: a.template, gate: a.gate, requires: a.requires ?? [] }
    if (a.copiedFrom !== undefined) entry['copied-from'] = a.copiedFrom
    return entry
  })
  return stringifyYAML(obj)
}

/** Parse `definition.yaml` text into its raw record — the same bare `parseYAML` `lib/definition.js`'s readers do. */
export function parseDefinitionYaml(text) {
  return parseYAML(text) ?? {}
}

/** Verbatim port of `lib/definition.js`'s `buildModuleYamlObject`. */
export function renderModuleYaml(mod) {
  const obj = { id: mod.id, title: mod.title, purpose: mod.purpose }
  obj.fields = (mod.fields ?? []).map((f) => {
    const field = { id: f.id, title: f.title, type: f.type }
    if (f.required === true) field.required = true
    else if (f.requiredAt) field['required-at'] = f.requiredAt
    if (f.guidance !== undefined && f.guidance !== null) field.guidance = f.guidance
    if (f.copiedFrom !== undefined) field['copied-from'] = f.copiedFrom
    return field
  })
  if (mod.copiedFrom !== undefined) obj['copied-from'] = mod.copiedFrom
  return stringifyYAML(obj)
}

/** Parse `modules/<id>.yaml` text into its raw record. */
export function parseModuleYaml(text) {
  return parseYAML(text) ?? {}
}

// Raw module YAML (on-disk shape, `required-at`/`copied-from`) -> the
// projection shape (`requiredAt`/`copiedFrom`) every consumer of `structure`
// expects — mirrors lib/definition.js's (private) loadModuleSpec's field
// mapping.
// `copiedFrom` (and, on a stage, `example`) is only ever an own key on a
// projection object when the source actually set it — never present-but-
// undefined — exactly matching `lib/definition.js`'s `definitionVersionProjection`
// (whose own field/stage/artefact/module builders add each of these
// conditionally, `if (x.copiedFrom !== undefined) base.copiedFrom = ...`).
// Matters beyond cosmetics: a caller that diffs two structures by their own
// key sets (dirty-checking an unsaved draft, e.g.) would otherwise see a
// definition just read off disk as different from the identical one it
// wrote a moment ago.
function withOptional(base, extra) {
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) base[key] = value
  }
  return base
}

function moduleFromRaw(raw) {
  const fields = (raw.fields ?? []).map((field) => {
    if (!VALID_FIELD_TYPES.has(field.type)) {
      throw new Error(`Module "${raw.id}" field "${field.id}" has unknown type "${field.type}" (expected "markdown" or "list")`)
    }
    if (field.required !== undefined && field['required-at'] !== undefined) {
      throw new Error(`Module "${raw.id}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`)
    }
    return withOptional(
      { id: field.id, title: field.title, type: field.type, required: field.required, requiredAt: field['required-at'], guidance: field.guidance },
      { copiedFrom: field['copied-from'] }
    )
  })
  return withOptional({ id: raw.id, title: raw.title, purpose: raw.purpose, fields }, { copiedFrom: raw['copied-from'] })
}

/**
 * List the module ids currently on disk at `definitions/<id>/<version>/modules/` —
 * `[]` when the directory doesn't exist yet (a brand-new blank definition).
 */
async function listLocalModuleIds(handle, definitionId, version) {
  let entries
  try {
    entries = await listDir(handle, `${definitionDirPath(definitionId, version)}/modules`)
  } catch {
    return []
  }
  return entries.filter((e) => e.kind === 'file' && e.name.endsWith('.yaml')).map((e) => e.name.slice(0, -'.yaml'.length))
}

/**
 * Read `definitions/<definitionId>/<version>/` into a definition-version-
 * projection `structure` — `definition.yaml` plus every `modules/*.yaml` —
 * the FSA-backed counterpart of `GET /api/definitions/:id/versions/:n`
 * (`fetchLocalDefinitionStructure` in `web/app.js`) for a definition that
 * lives in this workspace's own folder rather than the server's library.
 */
export async function readLocalDefinitionStructure(handle, definitionId, version) {
  const dir = definitionDirPath(definitionId, version)
  const yamlText = await readTextFile(handle, `${dir}/definition.yaml`)
  const raw = parseDefinitionYaml(yamlText)
  if (raw.id !== definitionId) {
    throw new Error(`Definition at ${dir} declares id "${raw.id}", expected "${definitionId}" (folder must match id)`)
  }
  const moduleIds = await listLocalModuleIds(handle, definitionId, version)
  const modulesById = new Map()
  for (const moduleId of moduleIds) {
    const modText = await readTextFile(handle, `${dir}/modules/${moduleId}.yaml`)
    const modRaw = parseModuleYaml(modText)
    if (modRaw.id !== moduleId) {
      throw new Error(`Module spec ${dir}/modules/${moduleId}.yaml declares id "${modRaw.id}", expected "${moduleId}" (filename must match id)`)
    }
    modulesById.set(moduleId, moduleFromRaw(modRaw))
  }
  // Same "referenced-by-a-stage-first, then referenced-by-an-artefact, then
  // whatever's left" order as lib/definition.js's `definitionVersionProjection`
  // — the order the editor lists modules in matters for parity even though a
  // `Map`-keyed lookup (as `getLocalStatus`/`checkLocalGate` both do) never
  // cares about it. Where the two genuinely can't match byte-for-byte: a
  // module referenced by *neither* a stage nor an artefact falls back here to
  // `listLocalDir`'s alphabetical order rather than the server's on-disk
  // `readdirSync` order — deliberately, since alphabetical is the one
  // deterministic order a directory listing can promise.
  const stages = raw.stages ?? []
  const artefacts = raw.artefacts ?? []
  const orderedIds = []
  const seen = new Set()
  for (const stage of stages) {
    for (const mid of stage.modules ?? []) {
      if (!seen.has(mid)) {
        seen.add(mid)
        orderedIds.push(mid)
      }
    }
  }
  for (const artefact of artefacts) {
    for (const requirement of artefact.requires ?? []) {
      const mid = requirement.includes('.') ? requirement.slice(0, requirement.indexOf('.')) : requirement
      if (!seen.has(mid)) {
        seen.add(mid)
        orderedIds.push(mid)
      }
    }
  }
  for (const mid of moduleIds) {
    if (!seen.has(mid)) {
      seen.add(mid)
      orderedIds.push(mid)
    }
  }
  const modules = orderedIds.filter((id) => modulesById.has(id)).map((id) => modulesById.get(id))

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    version: raw.version ?? version,
    status: raw.status,
    stages: (raw.stages ?? []).map((s) =>
      withOptional(
        { id: s.id, title: s.title, purpose: s.purpose, gate: s.gate, modules: s.modules ?? [] },
        { example: s.example, copiedFrom: s['copied-from'] }
      )
    ),
    artefacts: (raw.artefacts ?? []).map((a) =>
      withOptional(
        { id: a.id, title: a.title, purpose: a.purpose, template: a.template, gate: a.gate, requires: a.requires ?? [] },
        { copiedFrom: a['copied-from'] }
      )
    ),
    modules,
  }
}

/**
 * Write `structure` back to `definitions/<definitionId>/<version>/` —
 * `definition.yaml` plus the managed `modules/*.yaml` set, deleting any
 * module file whose id is no longer in `structure.modules` — the FSA-backed
 * counterpart of `lib/definition.js`'s `writeDefinitionVersion` (minus the
 * disk-only version-history bookkeeping, out of scope for a single-version
 * local-workspace definition). Never touches `templates/` — template text and
 * reference `.docx` bytes are saved separately, only when actually edited
 * (see `writeLocalDefinitionTemplate`/`writeLocalDefinitionReferenceDocx`
 * below), the same "structure save is cheap, template save is its own step"
 * split the library editor's own Save button follows.
 */
export async function writeLocalDefinitionStructure(handle, definitionId, version, structure) {
  const dir = definitionDirPath(definitionId, version)
  await writeTextFile(handle, `${dir}/definition.yaml`, renderDefinitionYaml(structure))
  const wanted = new Set((structure.modules ?? []).map((m) => m.id))
  for (const mod of structure.modules ?? []) {
    await writeTextFile(handle, `${dir}/modules/${mod.id}.yaml`, renderModuleYaml(mod))
  }
  const onDisk = await listLocalModuleIds(handle, definitionId, version)
  for (const moduleId of onDisk) {
    if (wanted.has(moduleId)) continue
    try {
      const modulesDir = await handle
        .getDirectoryHandle('definitions', { create: false })
        .then((d) => d.getDirectoryHandle(definitionId, { create: false }))
        .then((d) => d.getDirectoryHandle(String(version), { create: false }))
        .then((d) => d.getDirectoryHandle('modules', { create: false }))
      await modulesDir.removeEntry(`${moduleId}.yaml`)
    } catch {
      // Already gone, or the browser can't remove it — leave it; the next
      // read simply ignores any module file structure.modules no longer lists.
    }
  }
}

// ---------------------------------------------------------------------------
// templates/ — artefact markdown template text + reference .docx bytes.
// Plain read/write, no reshaping (mirrors lib/definition.js's
// readDefinitionTemplate/writeDefinitionTemplate/readDefinitionReferenceDocx/
// writeDefinitionReferenceDocx, minus the server's draft-only write guard —
// a local-workspace definition has no separate "published, now immutable"
// enforcement path; Publish here only flips `status`, see
// `web/pages/local-definition-editor.js`).
// ---------------------------------------------------------------------------

/** Read an artefact template's source text, or `null` if it hasn't been saved yet. */
export async function readLocalDefinitionTemplate(handle, definitionId, version, name) {
  if (!TEMPLATE_NAME_RE.test(name)) throw new Error(`Invalid template name "${name}"`)
  try {
    return await readTextFile(handle, `${definitionDirPath(definitionId, version)}/templates/${name}`)
  } catch {
    return null
  }
}

/** Write an artefact template's source text. */
export async function writeLocalDefinitionTemplate(handle, definitionId, version, name, source) {
  if (!TEMPLATE_NAME_RE.test(name)) throw new Error(`Invalid template name "${name}"`)
  await writeTextFile(handle, `${definitionDirPath(definitionId, version)}/templates/${name}`, String(source ?? ''))
}

/** Read an artefact's reference `.docx` bytes, or `null` if none has been uploaded. */
export async function readLocalDefinitionReferenceDocx(handle, definitionId, version, artefactId) {
  try {
    return await readBinaryFile(handle, `${definitionDirPath(definitionId, version)}/templates/${referenceDocxName(artefactId)}`)
  } catch {
    return null
  }
}

/** Write an artefact's reference `.docx` bytes — caller validates with `isValidDocxBuffer` first. */
export async function writeLocalDefinitionReferenceDocx(handle, definitionId, version, artefactId, bytes) {
  await writeBinaryFile(handle, `${definitionDirPath(definitionId, version)}/templates/${referenceDocxName(artefactId)}`, bytes)
}

/**
 * Whether `definitions/<definitionId>/<version>/definition.yaml` exists in
 * this workspace folder — a plain existence check, no read/parse, mirroring
 * `lib/definitionHome.js`'s server-side `definitionIdExistsIn` (which checks
 * a server workspace's own `definitions/` folder the same way). This is the
 * single "does this local workspace author this id itself" test every
 * local-workspace consumer of a definition should run first (see
 * `resolveDefinitionStructure` just below) — WI #384's create-time
 * uniqueness check guarantees an id can never exist both here and in the
 * server library, so an existence check alone is enough to disambiguate,
 * with no separate "where does this instance's definition live" flag needed
 * anywhere on disk.
 */
export async function localDefinitionExists(handle, definitionId, version) {
  try {
    const definitionsDir = await handle.getDirectoryHandle('definitions', { create: false })
    const idDir = await definitionsDir.getDirectoryHandle(definitionId, { create: false })
    const versionDir = await idDir.getDirectoryHandle(String(version), { create: false })
    await versionDir.getFileHandle('definition.yaml', { create: false })
    return true
  } catch {
    return false
  }
}

/**
 * Resolves a definition's structure the way every local-workspace-aware
 * caller should (WI #384 item 4): this workspace's own `definitions/`
 * folder first (`localDefinitionExists` above), falling back to the gantry
 * server's library (`GET /api/definitions/:id/versions/:n`) — the same
 * "closer-scoped home first" order `lib/definitionHome.js`'s
 * `definitionsDirForInstanceScope` already uses server-side for a server
 * workspace's own definitions. Used by the "+ New Instance" wizard's Create
 * step, `loadLocalInstance` (the module editor's local-workspace read path)
 * and the dashboard's per-row status build — every place that today only
 * ever fetched from the library — so a local instance can pin either a
 * library definition or one this same workspace authored, with no caller
 * needing to know or record which.
 */
export async function resolveDefinitionStructure(handle, definitionId, definitionVersion) {
  if (await localDefinitionExists(handle, definitionId, definitionVersion)) {
    return readLocalDefinitionStructure(handle, definitionId, definitionVersion)
  }
  const res = await fetch(
    `/api/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(String(definitionVersion))}`
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? body.message ?? `Failed to load definition "${definitionId}" (${res.status})`)
  }
  return res.json()
}

/**
 * List every `definitions/<id>/<version>/` this workspace folder currently
 * holds, as `[{ id, versions: number[] }]` sorted by id — used both for the
 * "open a local definition" picker and (with the library's own `GET
 * /api/definitions` list) for the create-time id-uniqueness check WI #384
 * asks for ("checked against the library at create time — the server cannot
 * see other local workspaces", so the local-*workspace* half of that check
 * is just this). `[]` when the workspace has no `definitions/` folder at
 * all yet (every local workspace before this ticket).
 */
export async function listLocalDefinitions(handle) {
  let idEntries
  try {
    idEntries = await listDir(handle, 'definitions')
  } catch {
    return []
  }
  const result = []
  for (const idEntry of idEntries) {
    if (idEntry.kind !== 'directory') continue
    let versionEntries
    try {
      versionEntries = await listDir(handle, `definitions/${idEntry.name}`)
    } catch {
      continue
    }
    const versions = versionEntries
      .filter((v) => v.kind === 'directory' && /^\d+$/.test(v.name))
      .map((v) => Number(v.name))
      .sort((a, b) => a - b)
    if (versions.length) result.push({ id: idEntry.name, versions })
  }
  result.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

/**
 * The "+ New Instance" wizard's Definition picker needs the same row shape
 * `lib/definition.js`'s `listDefinitions` builds for a library/server-
 * workspace row — `{ id, title, description, stages, latestPublished,
 * versions }` — plus a `home` tag the picker uses to tell a local-workspace
 * row apart from a library one (`{ kind: 'local-workspace' }`, mirroring
 * `lib/definitionHome.js`'s `{ kind: 'library' }`/`{ kind: 'server-workspace',
 * ... }` tags for the same purpose server-side). Same "prefer the latest
 * *published* version for the card's own title/description/stages display,
 * falling back to the latest version at all when nothing is published yet"
 * rule `listDefinitions` itself follows.
 */
export async function listLocalDefinitionRows(handle) {
  const entries = await listLocalDefinitions(handle)
  const rows = []
  for (const { id, versions } of entries) {
    const versionsWithStatus = []
    let latestPublished = null
    let maxVersion = null
    for (const version of versions) {
      const structure = await readLocalDefinitionStructure(handle, id, version)
      versionsWithStatus.push({ version, status: structure.status })
      if (structure.status === 'published' && (latestPublished === null || version > latestPublished)) {
        latestPublished = version
      }
      if (maxVersion === null || version > maxVersion) maxVersion = version
    }
    if (maxVersion === null) continue
    const display = await readLocalDefinitionStructure(handle, id, latestPublished ?? maxVersion)
    rows.push({
      id,
      title: display.title,
      description: display.description ?? null,
      stages: (display.stages ?? []).map((s) => ({ id: s.id, title: s.title })),
      latestPublished,
      versions: versionsWithStatus,
      home: { kind: 'local-workspace' },
    })
  }
  return rows
}
