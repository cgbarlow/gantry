import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { isValidSlug } from './slug.js'
import { isMultiValuedField } from './fieldShape.js'
import { Eta } from 'eta'
import { readOnlyModuleProblems } from '../web/lib/readOnlyModules.js'

export const TEMPLATE_NAME_RE = /^[A-Za-z0-9._-]+\.md\.tmpl$/

function assertValidTemplateName(name) {
  if (typeof name !== 'string' || !TEMPLATE_NAME_RE.test(name)) {
    throw new Error(`Invalid template name "${name}"`)
  }
}

export function readDefinitionTemplate(definitionId, version, name, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  assertValidTemplateName(name)
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  const dir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const filePath = join(dir, 'templates', name)
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf8')
}

export function writeDefinitionTemplate(definitionId, version, name, source, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  const dir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const yamlPath = join(dir, 'definition.yaml')
  const raw = readYAML(yamlPath)
  if (raw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${raw.status})`)
  }
  assertValidTemplateName(name)
  try {
    new Eta().compile(String(source))
  } catch (e) {
    const err = new Error('Template does not compile')
    err.compileError = e.message
    throw err
  }
  const templatesDir = join(dir, 'templates')
  mkdirSync(templatesDir, { recursive: true })
  writeFileSync(join(templatesDir, name), String(source))
  return { name }
}

// WI #385 — an artefact's reference `.docx` (the Word styling template pandoc merges its output
// into — lib/render.js's `renderArtefactBody`, which already resolves it as
// `templates/reference-<artefactId>.docx`, falling back to `templates/reference.docx`). This
// reuses that exact naming so a docx uploaded here needs no further wiring to be picked up by a
// render. Copying an artefact between definitions (WI #382) does *not* duplicate a version
// directory the way `cloneDefinition`/`createDraftVersion` do with `cpSync` above — it copies
// structurally, via a JSON plan (lib/copyPlanner.js) applied to the in-memory draft, with the
// `.md.tmpl` text and this docx each brought over individually through these same GET/PUT routes
// (web/pages/definition-viewer.js's `applyCopyFlow`), same as Replace/Download in the editor uses.
// Deliberately artefact-specific (never the bare `reference.docx` fallback): both Replace/Download
// and the copy flow always name one particular artefact, so this only ever reads or writes the
// per-artefact file.
function referenceDocxName(artefactId) {
  return `reference-${artefactId}.docx`
}

// A `.docx` is an OOXML package — a zip archive with a fixed internal shape — so its bytes are
// checkable without any zip-parsing dependency: real zips start with the local-file-header magic
// `PK\x03\x04`, and every OOXML package (docx *and* xlsx/pptx, which is why the extension/
// mimetype alone was never enough) declares itself via a top-level `[Content_Types].xml` entry.
// `word/document.xml` is Word's own part name, absent from an xlsx or pptx wearing a `.docx`
// name. Zip entry names are stored as literal, uncompressed bytes in each local file header, so a
// plain substring scan over the raw bytes finds them without unzipping anything.
export function isValidDocxBuffer(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < 4) return false
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) return false
  const text = buffer.toString('latin1')
  return text.includes('[Content_Types].xml') && text.includes('word/document.xml')
}

// Download side of WI #385 — no draft/published guard, same as readDefinitionTemplate: viewing
// (here, downloading) a published version's reference doc is fine, only replacing it is blocked.
// Returns `null` when the artefact has no reference doc uploaded yet (a 404 at the route).
export function readDefinitionReferenceDocx(definitionId, version, artefactId, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  if (!isValidSlug(artefactId)) {
    throw new Error(`Invalid artefact id "${artefactId}"`)
  }
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  const dir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const filePath = join(dir, 'templates', referenceDocxName(artefactId))
  if (!existsSync(filePath)) return null
  return readFileSync(filePath)
}

// Replace (upload) side of WI #385 — same draft-only / published-immutable guard as
// writeDefinitionTemplate, checked the same way (read `definition.yaml`'s status before writing
// anything). `buffer` must already look like a real `.docx` (isValidDocxBuffer above) — the
// caller (lib/server.js) never trusts the upload's declared filename or Content-Type.
export function writeDefinitionReferenceDocx(definitionId, version, artefactId, buffer, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  if (!isValidSlug(artefactId)) {
    throw new Error(`Invalid artefact id "${artefactId}"`)
  }
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  const dir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const yamlPath = join(dir, 'definition.yaml')
  const raw = readYAML(yamlPath)
  if (raw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${raw.status})`)
  }
  if (!isValidDocxBuffer(buffer)) {
    const err = new Error('File is not a valid .docx')
    err.invalidDocx = true
    throw err
  }
  const templatesDir = join(dir, 'templates')
  mkdirSync(templatesDir, { recursive: true })
  writeFileSync(join(templatesDir, referenceDocxName(artefactId)), buffer)
  return { name: referenceDocxName(artefactId) }
}

// #85 (ADR-0044): 'text'/'date' join the vocabulary alongside 'select' — both single-valued,
// neither needing an options:-equivalent key, so nothing else in this file's field-shape
// handling changes for them (see selectOptionsProblem/selectDefaultProblem below, which stay
// scoped to 'select' only).
const VALID_FIELD_TYPES = new Set(['markdown', 'list', 'select', 'text', 'date'])
const VALID_STATUSES = new Set(['draft', 'published'])

// ADR-0044: a `select` field's `options:` is a list of plain strings — no key/label
// indirection, stored and interpolated verbatim. Thrown by both the throwing loader
// (loadModuleSpec) and the report-everything validators (findDefinitionProblems/
// findDefinitionProblemsInStructure) below, and mirrored by web/lib/localDefinitionFiles.js's
// moduleFromRaw for the Local-Workspace twin.
function selectOptionsProblem(moduleId, field) {
  if (field.type !== 'select') return null
  if (!Array.isArray(field.options) || field.options.length === 0) {
    return `Module "${moduleId}" field "${field.id}" is type "select" but declares no "options:" list`
  }
  if (!field.options.every((option) => typeof option === 'string' && option !== '')) {
    return `Module "${moduleId}" field "${field.id}" has an "options:" entry that is not a non-empty string`
  }
  return null
}

// #84 (ADR-0044): default: is optional on a select and must name one of its own options: — an
// out-of-list default would pre-select something the field can never actually hold.
function selectDefaultProblem(moduleId, field) {
  if (field.type !== 'select' || field.default === undefined) return null
  if (!Array.isArray(field.options) || !field.options.includes(field.default)) {
    return `Module "${moduleId}" field "${field.id}" has "default: ${field.default}" which is not in its own "options:" list`
  }
  return null
}

// #87 (ADR-0045): a `requires` entry names a field a `filename:` token may reference either
// directly (`module.field`, with or without the trailing `?`) or by naming its whole module —
// a bare `module` entry already puts every one of that module's fields in the artefact's
// scope, so a pattern referencing one of them is not reaching outside what the artefact
// already requires.
function artefactRequiresField(artefact, moduleId, fieldId) {
  return (artefact.requires ?? []).some((requirement) => {
    const split = splitArtefactRequirement(requirement)
    return split.moduleId === moduleId && (!split.fieldId || split.fieldId === fieldId)
  })
}

// #87 (ADR-0045): validates an artefact's `filename:` pattern at definition-publish time —
// never at render time, so a bad token is caught with the definition still on the branch,
// not as a render failure with someone waiting on a document. Every `{token}` must be one of
// the three built-ins (`today`, `instance.name`, `instance.slug`) or a `{module.field}`
// reference that (a) resolves to a real field, (b) is single-valued select/text/date — never
// markdown, list, or a `multiple: true` select, which store more than the one string a
// filename position can hold — and (c) is already in this artefact's own `requires` list
// (`artefactRequiresField` above), the same guarantee that makes ADR-0045 §5's "render before
// the field is filled" case safe: the gate already enforces `requires`, so nothing can reach
// sign-off half-named.
//
// `findField(moduleId, fieldId)` resolves a token to its field spec (or `undefined` for an
// unknown module/field) — the one part that differs between the disk-backed
// (`findDefinitionProblems`), in-memory-structure (`findDefinitionProblemsInStructure`) and
// Local-Workspace (`web/lib/localStatus.js`'s own port) callers, so each supplies its own
// lookup rather than this function knowing how a module is stored.
function filenamePatternProblems(artefact, findField) {
  if (typeof artefact.filename !== 'string' || artefact.filename.trim() === '') return []
  const problems = []
  for (const match of artefact.filename.matchAll(/\{([^{}]+)\}/g)) {
    const token = match[1].trim()
    if (token === 'today' || token === 'instance.name' || token === 'instance.slug') continue
    const dot = token.indexOf('.')
    const moduleId = dot === -1 ? null : token.slice(0, dot)
    const fieldId = dot === -1 ? null : token.slice(dot + 1)
    const field = moduleId ? findField(moduleId, fieldId) : undefined
    if (!field) {
      problems.push({
        type: 'filename-unknown-token',
        message: `Artefact "${artefact.id}" filename: references "{${token}}", which is not a field or a built-in ({instance.name}, {instance.slug}, {today})`,
      })
      continue
    }
    if (!['select', 'text', 'date'].includes(field.type) || isMultiValuedField(field)) {
      problems.push({
        type: 'filename-invalid-field-type',
        message: `Artefact "${artefact.id}" filename: references "{${token}}", but field "${fieldId}" is type "${field.type}"${isMultiValuedField(field) ? ' with multiple: true' : ''} — only single-valued select, text and date fields can name a rendered document`,
      })
      continue
    }
    if (!artefactRequiresField(artefact, moduleId, fieldId)) {
      problems.push({
        type: 'filename-field-not-required',
        message: `Artefact "${artefact.id}" filename: references "{${token}}", but "${moduleId}.${fieldId}" is not in this artefact's own "requires" list`,
      })
    }
  }
  return problems
}

// #150 (ADR-0049): an Artefact's `document-control:` is a plain boolean — `false` leaves the
// Document Control and Review & sign-off tables out of its render, `true` or absent keeps them.
// Anything else ("no", 0, a string "false") is refused rather than guessed at: the render only
// honours a real `false`, so a near-miss would silently still print both tables on a document
// that was meant to leave the organisation clean. `value` is the key read under either spelling
// (camelCase in memory, kebab-case on disk). Mirrored by web/lib/localStatus.js's own port.
function documentControlProblem(artefactId, value) {
  if (value === undefined || typeof value === 'boolean') return null
  return {
    type: 'invalid-document-control',
    message: `Artefact "${artefactId}" sets "document-control" to ${JSON.stringify(value)} — it must be true or false`,
  }
}

function readYAML(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err.message}`)
  }
  try {
    return parseYAML(text)
  } catch (err) {
    throw new Error(`Malformed YAML in ${path}: ${err.message}`)
  }
}

function isVersionDirName(name) {
  return /^[1-9]\d*$/.test(name)
}

export function listVersionNumbers(definitionId, definitionsDir = 'definitions') {
  const idDir = join(definitionsDir, definitionId)
  if (!existsSync(idDir)) return []
  try {
    return readdirSync(idDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isVersionDirName(entry.name) && existsSync(join(idDir, entry.name, 'definition.yaml')))
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

export function getLatestPublishedVersion(definitionId, definitionsDir = 'definitions') {
  const versions = listVersionNumbers(definitionId, definitionsDir)
  let latest = null
  for (const v of versions) {
    const raw = readYAML(join(definitionsDir, definitionId, String(v), 'definition.yaml'))
    if (raw.status === 'published') {
      latest = v
    }
  }
  return latest
}

function getDefinitionVersionsWithStatus(definitionId, definitionsDir = 'definitions') {
  const versions = listVersionNumbers(definitionId, definitionsDir)
  return versions.map((v) => {
    const raw = readYAML(join(definitionsDir, definitionId, String(v), 'definition.yaml'))
    return { version: v, status: raw.status ?? 'published' }
  })
}

/**
 * WI #371: which `definitions/` directory a **CLI command** should read.
 *
 * `definitions/` is a *packaged asset* — it ships inside the install, the same as `web/`, `docs/` and
 * the browser's `node_modules/`. `gantry serve` has resolved it against the package root since WI #278,
 * which is what lets the server run from any working directory; no other command was ever given the
 * same treatment, so an installed `gantry` on PATH could only find the built-in definitions when the
 * working directory happened to be a gantry checkout. `gantry definitions` reported "No definitions
 * found." anywhere else, and `gantry new design …` failed claiming the definition had no version 1.
 *
 * Resolution order, and why:
 * 1. **An explicit `--definitions-dir`** — always wins; the caller has said exactly what they mean.
 * 2. **A `definitions/` directory in the working directory** — a gantry checkout, or any repo keeping
 *    its own definitions alongside its data. This comes *before* the packaged copy so that working in
 *    a checkout keeps operating on that checkout's definitions, exactly as it does today: editing a
 *    definition and immediately validating it must not silently validate the installed copy instead.
 * 3. **The packaged `definitions/`** — resolved against this file's own location (`lib/` sits one level
 *    under the package root), so it is the running install's copy even when invoked through a symlink
 *    on PATH from an unrelated directory.
 *
 * Deliberately *not* applied to `lib/`'s own `options.definitionsDir ?? 'definitions'` defaults: those
 * are library callers (the server passes its own pkgRoot-relative path, tests pass fixtures), and
 * quietly redirecting them at a packaged directory would change behaviour well outside this ticket.
 * Only `bin/gantry.js` calls this.
 */
export function resolveDefinitionsDir(explicitDir) {
  if (explicitDir) return explicitDir
  if (existsSync('definitions')) return 'definitions'
  return join(fileURLToPath(new URL('..', import.meta.url)), 'definitions')
}

function resolveDefinitionDir(definitionId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  // WI #371: a missing definitions *directory* is a different problem from a missing definition inside
  // one, and saying so matters — the old path fell through to "has no version 1", which reads as "your
  // definition is malformed" when the truth is that gantry never found a definitions directory at all.
  if (!existsSync(definitionsDir)) {
    throw new Error(
      `No definitions directory at ${definitionsDir} — nothing to resolve "${definitionId}" against.`
    )
  }
  const idDir = join(definitionsDir, definitionId)
  const versions = listVersionNumbers(definitionId, definitionsDir)

  // Explicit version requested
  if (options.version !== undefined && options.version !== null) {
    const vNum = Number(options.version)
    if (!Number.isInteger(vNum) || vNum < 1) {
      throw new Error(`Invalid definition version "${options.version}" for "${definitionId}"`)
    }
    // If versioned layout exists, enforce it exists
    if (versions.length > 0) {
      if (!versions.includes(vNum)) {
        throw new Error(`Definition "${definitionId}" has no version ${vNum}`)
      }
      return join(idDir, String(vNum))
    }
    // Legacy flat: only version 1 exists implicitly
    if (existsSync(join(idDir, 'definition.yaml'))) {
      if (vNum !== 1) {
        throw new Error(`Definition "${definitionId}" has no version ${vNum}`)
      }
      return idDir
    }
    throw new Error(`Definition "${definitionId}" has no version ${vNum}`)
  }

  // No explicit version: latest published
  if (versions.length > 0) {
    const latest = getLatestPublishedVersion(definitionId, definitionsDir)
    if (latest === null) {
      throw new Error(`Definition "${definitionId}" has no published version`)
    }
    return join(idDir, String(latest))
  }

  // Legacy fallback
  if (existsSync(join(idDir, 'definition.yaml'))) {
    return idDir
  }

  throw new Error(`Definition "${definitionId}" not found at ${idDir}`)
}

function loadModuleSpec(definitionDir, moduleId) {
  const path = join(definitionDir, 'modules', `${moduleId}.yaml`)
  const raw = readYAML(path)

  if (raw.id !== moduleId) {
    throw new Error(
      `Module spec ${path} declares id "${raw.id}", expected "${moduleId}" (filename must match id)`
    )
  }

  for (const field of raw.fields ?? []) {
    if (!VALID_FIELD_TYPES.has(field.type)) {
      throw new Error(
        `Module "${moduleId}" field "${field.id}" has unknown type "${field.type}" (expected "markdown", "list", "select", "text" or "date")`
      )
    }
    if (field.required !== undefined && field['required-at'] !== undefined) {
      throw new Error(
        `Module "${moduleId}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`
      )
    }
    const optionsProblem = selectOptionsProblem(moduleId, field)
    if (optionsProblem) throw new Error(optionsProblem)
    const defaultProblem = selectDefaultProblem(moduleId, field)
    if (defaultProblem) throw new Error(defaultProblem)
  }

  return moduleFromRaw(raw)
}

// #148 (spec #147, "Round trip first"): the one mapping from a raw, kebab-case Definition YAML record
// (`definition.yaml`'s stages/artefacts, a `modules/<id>.yaml`) to the camelCase in-memory shape every
// loader returns — `loadDefinition` here and each Provider's own `load*Definition`
// (lib/definitionAzureDevOps.js, lib/definitionGitHub.js, lib/definitionGitLab.js,
// lib/definitionAtlassian.js). Those four used to carry private copies of this mapping, and the copies
// had drifted: they dropped an Artefact's `filename` and a select Field's `options`/`multiple`/
// `default`, so every Library-cache copy of a Definition with select Fields failed to load. A key
// added here reaches every loader at once. No validation happens here — `loadModuleSpec` above
// validates before mapping; the Provider loaders leave that to their write/publish checks.
//
// `document-control`, `satisfies-gate` (Artefact) and `read-only-modules` (Stage) are carried
// through untouched: this ticket only makes them survive every lifecycle operation, and the #147
// engine tickets give them behaviour.
export function stageFromRaw(stage) {
  return {
    id: stage.id,
    title: stage.title,
    purpose: stage.purpose,
    gate: stage.gate,
    modules: stage.modules ?? [],
    readOnlyModules: stage['read-only-modules'],
    // The instance the web form's "Populate example text" button reads from for this stage — optional, a stage with none just has no example available.
    example: stage.example,
    copiedFrom: stage['copied-from'],
  }
}

export function artefactFromRaw(artefact) {
  return {
    id: artefact.id,
    title: artefact.title,
    purpose: artefact.purpose,
    template: artefact.template,
    gate: artefact.gate,
    requires: artefact.requires ?? [],
    filename: artefact.filename,
    documentControl: artefact['document-control'],
    satisfiesGate: artefact['satisfies-gate'],
    copiedFrom: artefact['copied-from'],
  }
}

function fieldFromRaw(field) {
  return {
    id: field.id,
    title: field.title,
    type: field.type,
    required: field.required,
    requiredAt: field['required-at'],
    guidance: field.guidance,
    copiedFrom: field['copied-from'],
    ...(field.type === 'select'
      ? { options: field.options, multiple: field.multiple === true ? true : undefined, default: field.default }
      : {}),
  }
}

export function moduleFromRaw(raw) {
  return {
    id: raw.id,
    title: raw.title,
    purpose: raw.purpose,
    fields: (raw.fields ?? []).map(fieldFromRaw),
    copiedFrom: raw['copied-from'],
  }
}

// Artefact requirements normally name a whole module (the original schema),
// but may name one field as `module.field` when artefacts sharing a module have
// different required content. Keeping the shorthand means existing
// definitions remain unchanged while allowing proportional artefacts.
//
// A trailing `?` on a field ref (`module.field?`) marks it *optional* (WI #276):
// the field is still in the artefact's scope (rendered, shown in the lightweight
// editor), but it only blocks the gate when the field is independently required
// for that gate via its own `required` / `required-at`. A bare `module.field`
// keeps exactly the original always-gates behaviour. `?` on a whole-module entry
// is meaningless and rejected by `findDefinitionProblems`.
export function splitArtefactRequirement(requirement) {
  let ref = requirement
  let optional = false
  if (ref.endsWith('?')) {
    optional = true
    ref = ref.slice(0, -1)
  }
  const separator = ref.indexOf('.')
  if (separator === -1) return { moduleId: ref, fieldId: undefined, optional }
  return { moduleId: ref.slice(0, separator), fieldId: ref.slice(separator + 1), optional }
}

export function artefactModuleIds(artefact) {
  return [...new Set(artefact.requires.map((requirement) => splitArtefactRequirement(requirement).moduleId))]
}

/**
 * Duplicate stage/artefact/module ids, and duplicate field ids within one module, checked across the
 * *whole* structure — every module (referenced by a stage/artefact or not), unlike the reference-integrity
 * checks below which only walk referenced modules. This is deliberate: an id collision is a problem the
 * moment two things share an id, whether or not anything currently points at either of them, and
 * `writeProposedFilesToDir` writes one file per module id — two modules sharing an id silently collapse
 * to a single file (the second write wins) with no error, which is exactly the shape the caller must
 * reject before any file is touched (see `writeDefinitionVersion`).
 *
 * @param {{ stages?: {id:string}[], artefacts?: {id:string}[], modules?: {id:string, fields?: {id:string}[]}[] }} structure
 * @returns {{ type: string, message: string }[]}
 */
function findDuplicateIdProblems({ stages = [], artefacts = [], modules = [] } = {}) {
  const problems = []
  const countIds = (items) => {
    const counts = new Map()
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue
      counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
    }
    return counts
  }
  // Message shape — `Stage "id"`, `Artefact "id"`, `Module "id"` as the opening quoted token — matches
  // every other problem message findDefinitionProblems/findDefinitionProblemsInStructure produce, which
  // the editor's `problemTarget()` (web/pages/definition-viewer.js) parses to anchor a problem marker to
  // the element that owns it; keep new messages consistent with that shape rather than inventing a new one.
  for (const [id, count] of countIds(stages)) {
    if (count > 1) {
      problems.push({ type: 'duplicate-stage-id', message: `Stage "${id}" is used by ${count} stages — stage ids must be unique` })
    }
  }
  for (const [id, count] of countIds(artefacts)) {
    if (count > 1) {
      problems.push({ type: 'duplicate-artefact-id', message: `Artefact "${id}" is used by ${count} artefacts — artefact ids must be unique` })
    }
  }
  for (const [id, count] of countIds(modules)) {
    if (count > 1) {
      problems.push({ type: 'duplicate-module-id', message: `Module "${id}" is used by ${count} modules — module ids must be unique` })
    }
  }
  for (const mod of modules) {
    if (!mod || typeof mod.id !== 'string') continue
    for (const [fieldId, count] of countIds(mod.fields ?? [])) {
      if (count > 1) {
        problems.push({ type: 'duplicate-field-id', message: `Module "${mod.id}" field "${fieldId}" is used by ${count} fields — field ids must be unique within a module` })
      }
    }
  }
  return problems
}

// Problem types that block web-editor save, publish and `gantry validate` (and show as Definitions
// page markers) but never `loadDefinition`: an instance already running on a Definition written
// before the check existed must keep loading after an upgrade (spec #147). A later check with the
// same "authoring-time only" standing joins this set rather than growing its own exemption.
// #152's read-only-modules checks join it: a bad entry only ever affects editing surfaces, which
// consult it alongside `modules` (an id the Stage doesn't mount is simply never shown). So does
// #151's unsatisfiable-gate.
const AUTHORING_ONLY_PROBLEM_TYPES = new Set([
  'unknown-artefact-gate',
  'unknown-required-at-gate',
  'invalid-required-at',
  'invalid-read-only-modules',
  'unknown-read-only-module',
  'unsatisfiable-gate',
])

// #149 (spec #147): an Artefact's `gate` and a Field's `required-at` entries name Stage gates, and a
// name that matches none silently disables the requirement — an Artefact that never counts toward any
// Gate, a Field required nowhere. `required-at` must also be a list: a bare string still "works" at
// gate-check time (`String.prototype.includes`), but as a substring match, so `required-at: gate`
// would also require the field at any gate whose id contains it. A blank Artefact gate (the
// Definitions page's old "+ Artefact" default) names no Stage gate either.
//
// #151 (ADR-0051): a Stage whose Artefacts all set `satisfies-gate: false` can never pass its Gate —
// every document there is excluded from counting toward it. A Stage with no Artefacts at all is not
// this problem: it has no document to be excluded, and is a Definition still being written.
//
// `stages`/`artefacts` carry `id` and `gate` (and an Artefact its `satisfiesGate`); `modules` carry `id` and `fields: [{ id, requiredAt }]`
// (the camelCase projection shape) — the disk-backed caller maps its raw YAML into that shape, so both
// validators share this one rule set.
function gateReferenceProblems(stages, artefacts, modules) {
  const problems = []
  const stageGates = [...new Set(stages.map((stage) => stage.gate).filter((gate) => typeof gate === 'string' && gate !== ''))]
  const gateList = stageGates.length > 0 ? `the stages' gates are ${stageGates.map((gate) => `"${gate}"`).join(', ')}` : "this definition's stages declare no gates yet"
  for (const artefact of artefacts) {
    if (typeof artefact.gate !== 'string' || artefact.gate.trim() === '') {
      problems.push({
        type: 'unknown-artefact-gate',
        message: `Artefact "${artefact.id}" has no gate — set it to one of the stages' gates (${gateList})`,
      })
    } else if (!stageGates.includes(artefact.gate)) {
      problems.push({
        type: 'unknown-artefact-gate',
        message: `Artefact "${artefact.id}" has gate "${artefact.gate}", which is not any stage's gate (${gateList})`,
      })
    }
  }
  for (const stage of stages) {
    const atGate = artefacts.filter((artefact) => typeof stage.gate === 'string' && stage.gate !== '' && artefact.gate === stage.gate)
    if (atGate.length === 0 || atGate.some((artefact) => artefact.satisfiesGate !== false)) continue
    problems.push({
      type: 'unsatisfiable-gate',
      message: `Stage "${stage.id}" has gate "${stage.gate}", but every artefact at that gate (${atGate.map((artefact) => `"${artefact.id}"`).join(', ')}) sets "satisfies-gate: false", so the gate can never pass — let at least one of them count toward the gate`,
    })
  }
  for (const mod of modules) {
    for (const field of mod.fields ?? []) {
      const requiredAt = field.requiredAt
      if (requiredAt === undefined || requiredAt === null) continue
      if (!Array.isArray(requiredAt) || !requiredAt.every((gate) => typeof gate === 'string' && gate !== '')) {
        problems.push({
          type: 'invalid-required-at',
          message: `Module "${mod.id}" field "${field.id}" has "required-at: ${JSON.stringify(requiredAt)}", which is not a list of gate ids — write it as a list, e.g. "required-at: [${stageGates[0] ?? 'gate-id'}]"`,
        })
        continue
      }
      for (const gate of requiredAt) {
        if (stageGates.includes(gate)) continue
        problems.push({
          type: 'unknown-required-at-gate',
          message: `Module "${mod.id}" field "${field.id}" is required at gate "${gate}", which is not any stage's gate (${gateList})`,
        })
      }
    }
  }
  return problems
}

/**
 * Structural problems with a definition: module references that don't resolve, invalid field types, and required/required-at mutual-exclusivity violations. Returns every problem found in one pass (never throws), so `gantry validate` can report all of them instead of just the first.
 *
 * @param {string} definitionId
 * @param {{ definitionsDir?: string, version?: number }} [options]
 * @returns {{ type: string, message: string }[]}
 */
export function findDefinitionProblems(definitionId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const definitionDir = resolveDefinitionDir(definitionId, options)
  const raw = readYAML(join(definitionDir, 'definition.yaml'))
  const problems = []

  const stages = (raw.stages ?? []).map((stage) => ({
    id: stage.id,
    gate: stage.gate,
    modules: stage.modules ?? [],
    readOnlyModules: stage['read-only-modules'],
  }))
  const artefacts = (raw.artefacts ?? []).map((artefact) => ({
    id: artefact.id,
    gate: artefact.gate,
    requires: artefact.requires ?? [],
    filename: artefact.filename,
    documentControl: artefact['document-control'],
    satisfiesGate: artefact['satisfies-gate'],
  }))

  const referencedModuleIds = new Set([
    ...stages.flatMap((stage) => stage.modules),
    ...artefacts.flatMap((artefact) => artefact.requires.map((requirement) => splitArtefactRequirement(requirement).moduleId)),
  ])
  const availableModuleIds = new Set(
    readdirSync(join(definitionDir, 'modules'))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.slice(0, -'.yaml'.length))
  )

  problems.push(...findDuplicateIdProblems({
    stages,
    artefacts,
    modules: [...availableModuleIds].map((moduleId) => {
      const rawModule = readYAML(join(definitionDir, 'modules', `${moduleId}.yaml`))
      return { id: rawModule.id, fields: rawModule.fields ?? [] }
    }),
  }))

  for (const stage of stages) {
    for (const moduleId of stage.modules) {
      if (!availableModuleIds.has(moduleId)) {
        problems.push({
          type: 'missing-module',
          message: `Stage "${stage.id}" references module "${moduleId}", but ${definitionDir}/modules/${moduleId}.yaml does not exist`,
        })
      }
    }
  }
  for (const artefact of artefacts) {
    for (const requirement of artefact.requires) {
      const { moduleId, fieldId, optional } = splitArtefactRequirement(requirement)
      if (optional && !fieldId) {
        problems.push({
          type: 'optional-whole-module',
          message: `Artefact "${artefact.id}" requires "${requirement}", but the "?" (optional) suffix is only valid on a field reference (module.field?), not a whole module`,
        })
        continue
      }
      if (!availableModuleIds.has(moduleId)) {
        problems.push({
          type: 'missing-module',
          message: `Artefact "${artefact.id}" requires module "${moduleId}", but ${definitionDir}/modules/${moduleId}.yaml does not exist`,
        })
        continue
      }
      if (fieldId) {
        const moduleSpec = readYAML(join(definitionDir, 'modules', `${moduleId}.yaml`))
        if (!(moduleSpec.fields ?? []).some((field) => field.id === fieldId)) {
          problems.push({
            type: 'missing-field',
            message: `Artefact "${artefact.id}" requires field "${requirement}", but module "${moduleId}" does not define it`,
          })
        }
      }
    }
  }

  const referencedModules = []
  for (const moduleId of referencedModuleIds) {
    if (!availableModuleIds.has(moduleId)) continue
    const rawModule = readYAML(join(definitionDir, 'modules', `${moduleId}.yaml`))
    referencedModules.push({ id: moduleId, fields: (rawModule.fields ?? []).map((field) => ({ id: field.id, requiredAt: field['required-at'] })) })
    for (const field of rawModule.fields ?? []) {
      if (!VALID_FIELD_TYPES.has(field.type)) {
        problems.push({
          type: 'unknown-field-type',
          message: `Module "${moduleId}" field "${field.id}" has unknown type "${field.type}" (expected "markdown", "list", "select", "text" or "date")`,
        })
      }
      if (field.required !== undefined && field['required-at'] !== undefined) {
        problems.push({
          type: 'mutually-exclusive-required',
          message: `Module "${moduleId}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`,
        })
      }
      const optionsProblem = selectOptionsProblem(moduleId, field)
      if (optionsProblem) problems.push({ type: 'select-missing-options', message: optionsProblem })
      const defaultProblem = selectDefaultProblem(moduleId, field)
      if (defaultProblem) problems.push({ type: 'select-invalid-default', message: defaultProblem })
    }
  }

  const findFilenameField = (moduleId, fieldId) => {
    if (!availableModuleIds.has(moduleId)) return undefined
    const rawModule = readYAML(join(definitionDir, 'modules', `${moduleId}.yaml`))
    return (rawModule.fields ?? []).find((field) => field.id === fieldId)
  }
  for (const artefact of artefacts) {
    problems.push(...filenamePatternProblems(artefact, findFilenameField))
    const controlProblem = documentControlProblem(artefact.id, artefact.documentControl)
    if (controlProblem) problems.push(controlProblem)
  }

  problems.push(...gateReferenceProblems(stages, artefacts, referencedModules))
  problems.push(...readOnlyModuleProblems(stages))

  return problems
}

/**
 * The same structural checks as `findDefinitionProblems` — module references that don't resolve,
 * invalid field types, required/required-at mutual exclusivity — run directly against an in-memory
 * definition structure instead of reading `definitionsDir` from disk. `data.modules` must carry every
 * module the definition currently has (whether referenced by a stage/artefact yet or not) as
 * `{ id, fields: [{ id, type, required, requiredAt }] }` — the same shape `definitionVersionProjection`
 * returns and the definition editor's unsaved draft already holds, so a caller on either side of the
 * wire can pass its own structure straight through with no reshaping.
 *
 * WI #381: backs `POST /api/definitions/:id/versions/:n/validate`, which the definition editor's live
 * validation markers call on every draft change — sharing this one rule set with the disk-based save
 * path (`writeDefinitionVersion`'s own validate-then-write, still disk-based since it must also catch
 * things a JSON body can't express, like a stray file left at rest) rather than the UI guessing at its
 * own copy of "what's wrong" that could quietly drift from what Save actually enforces.
 *
 * @param {{ stages?: any[], artefacts?: any[], modules?: any[] }} data
 * @returns {{ type: string, message: string }[]}
 */
export function findDefinitionProblemsInStructure(data) {
  // #152: a Provider publish passes stages as loaded (camelCase); accept the raw kebab key too.
  const stages = (data.stages ?? []).map((stage) => ({
    id: stage.id,
    gate: stage.gate,
    modules: stage.modules ?? [],
    readOnlyModules: stage.readOnlyModules ?? stage['read-only-modules'],
  }))
  const artefacts = (data.artefacts ?? []).map((artefact) => ({
    id: artefact.id,
    gate: artefact.gate,
    requires: artefact.requires ?? [],
    filename: artefact.filename,
    documentControl: keyOf(artefact, 'documentControl', 'document-control'),
    satisfiesGate: keyOf(artefact, 'satisfiesGate', 'satisfies-gate'),
  }))
  const modules = data.modules ?? []
  const problems = []

  problems.push(...findDuplicateIdProblems({ stages, artefacts, modules }))

  const referencedModuleIds = new Set([
    ...stages.flatMap((stage) => stage.modules),
    ...artefacts.flatMap((artefact) => artefact.requires.map((requirement) => splitArtefactRequirement(requirement).moduleId)),
  ])
  const moduleById = new Map(modules.map((m) => [m.id, m]))

  for (const stage of stages) {
    for (const moduleId of stage.modules) {
      if (!moduleById.has(moduleId)) {
        problems.push({
          type: 'missing-module',
          message: `Stage "${stage.id}" references module "${moduleId}", which does not exist in this definition`,
        })
      }
    }
  }
  for (const artefact of artefacts) {
    for (const requirement of artefact.requires) {
      const { moduleId, fieldId, optional } = splitArtefactRequirement(requirement)
      if (optional && !fieldId) {
        problems.push({
          type: 'optional-whole-module',
          message: `Artefact "${artefact.id}" requires "${requirement}", but the "?" (optional) suffix is only valid on a field reference (module.field?), not a whole module`,
        })
        continue
      }
      const mod = moduleById.get(moduleId)
      if (!mod) {
        problems.push({
          type: 'missing-module',
          message: `Artefact "${artefact.id}" requires module "${moduleId}", which does not exist in this definition`,
        })
        continue
      }
      if (fieldId && !(mod.fields ?? []).some((field) => field.id === fieldId)) {
        problems.push({
          type: 'missing-field',
          message: `Artefact "${artefact.id}" requires field "${requirement}", but module "${moduleId}" does not define it`,
        })
      }
    }
  }
  for (const moduleId of referencedModuleIds) {
    const mod = moduleById.get(moduleId)
    if (!mod) continue
    for (const field of mod.fields ?? []) {
      if (!VALID_FIELD_TYPES.has(field.type)) {
        problems.push({
          type: 'unknown-field-type',
          message: `Module "${moduleId}" field "${field.id}" has unknown type "${field.type}" (expected "markdown", "list", "select", "text" or "date")`,
        })
      }
      const optionsProblem = selectOptionsProblem(moduleId, field)
      if (optionsProblem) problems.push({ type: 'select-missing-options', message: optionsProblem })
      const defaultProblem = selectDefaultProblem(moduleId, field)
      if (defaultProblem) problems.push({ type: 'select-invalid-default', message: defaultProblem })
      if (field.required !== undefined && field.required !== false && field.requiredAt !== undefined) {
        problems.push({
          type: 'mutually-exclusive-required',
          message: `Module "${moduleId}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`,
        })
      }
    }
  }

  const findFilenameField = (moduleId, fieldId) => moduleById.get(moduleId)?.fields?.find((field) => field.id === fieldId)
  for (const artefact of artefacts) {
    problems.push(...filenamePatternProblems(artefact, findFilenameField))
    const controlProblem = documentControlProblem(artefact.id, artefact.documentControl)
    if (controlProblem) problems.push(controlProblem)
  }

  problems.push(...gateReferenceProblems(stages, artefacts, [...referencedModuleIds].filter((id) => moduleById.has(id)).map((id) => moduleById.get(id))))
  problems.push(...readOnlyModuleProblems(stages))

  return problems
}

/**
 * Load a definition (e.g. "design") and every module spec it references, validating that all stage/artefact module references resolve. Fails fast on the first structural problem found, except the authoring-only ones in `AUTHORING_ONLY_PROBLEM_TYPES` (see `findDefinitionProblems` for the non-throwing, report-everything variant used by `gantry validate`).
 *
 * @param {string} definitionId
 * @param {{ definitionsDir?: string, version?: number }} [options]
 */
export function loadDefinition(definitionId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const definitionDir = resolveDefinitionDir(definitionId, options)
  const raw = readYAML(join(definitionDir, 'definition.yaml'))

  if (raw.id !== definitionId) {
    throw new Error(
      `Definition at ${definitionDir} declares id "${raw.id}", expected "${definitionId}" (directory must match id)`
    )
  }

  const problems = findDefinitionProblems(definitionId, options).filter((problem) => !AUTHORING_ONLY_PROBLEM_TYPES.has(problem.type))
  if (problems.length > 0) {
    throw new Error(problems[0].message)
  }

  const stages = (raw.stages ?? []).map(stageFromRaw)
  const artefacts = (raw.artefacts ?? []).map(artefactFromRaw)

  const referencedModuleIds = new Set([
    ...stages.flatMap((stage) => stage.modules),
    ...artefacts.flatMap((artefact) => artefact.requires.flatMap((requirement) => splitArtefactRequirement(requirement).moduleId)),
  ])

  const modules = new Map()
  for (const moduleId of referencedModuleIds) {
    modules.set(moduleId, loadModuleSpec(definitionDir, moduleId))
  }

  // Version metadata: versioned layout carries version/status in YAML; legacy flat omits them.
  const versions = listVersionNumbers(definitionId, definitionsDir)
  const isVersioned = versions.length > 0
  const version = isVersioned ? (raw.version ?? Number(definitionDir.split('/').pop())) : (raw.version ?? 1)
  const status = isVersioned ? (raw.status ?? 'published') : (raw.status ?? 'published')

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    version,
    status,
    definitionDir,
    stages,
    artefacts,
    modules,
  }
}

export function isDefinitionArchived(definitionId, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  return existsSync(join(definitionsDir, definitionId, '.archived'))
}

export function archiveDefinition(definitionId, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const idDir = join(definitionsDir, definitionId)
  if (!existsSync(idDir)) {
    throw new Error(`Definition "${definitionId}" not found at ${idDir}`)
  }
  const marker = join(idDir, '.archived')
  if (!existsSync(marker)) {
    writeFileSync(marker, '')
  }
  return { id: definitionId, archived: true }
}

export function restoreDefinition(definitionId, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const idDir = join(definitionsDir, definitionId)
  if (!existsSync(idDir)) {
    throw new Error(`Definition "${definitionId}" not found at ${idDir}`)
  }
  const marker = join(idDir, '.archived')
  if (existsSync(marker)) {
    rmSync(marker, { force: true })
  }
  return { id: definitionId, archived: false }
}

/**
 * `gantry definitions` / `GET /api/definitions`: every definition available in `definitionsDir`, sorted by id, with just what a picker screen needs to render a choice — id, title, description and each stage's id/title — not the full `loadDefinition` shape (module specs, artefacts), which is more than a picker (the instance-setup wizard, #78) needs to show.
 *
 * Now also carries `latestPublished` and `versions` per definition for the version picker (#231), and `description` from the latest published (else max) version's definition.yaml (#234).
 *
 * @param {{ definitionsDir?: string }} [options]
 * @returns {{ id: string, title: string, description: string|null, stages: { id: string, title: string }[], latestPublished: number|null, versions: { version:number, status:string }[] }[]}
 */
export function listDefinitions(options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const includeArchived = Boolean(options.includeArchived)
  if (!existsSync(definitionsDir)) return []

  return readdirSync(definitionsDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false
      const id = entry.name
      if (!includeArchived && isDefinitionArchived(id, { definitionsDir })) return false
      const versions = listVersionNumbers(id, definitionsDir)
      if (versions.length > 0) return true
      return existsSync(join(definitionsDir, id, 'definition.yaml'))
    })
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const versions = listVersionNumbers(id, definitionsDir)
      const archived = isDefinitionArchived(id, { definitionsDir })
      if (versions.length > 0) {
        const versionsWithStatus = getDefinitionVersionsWithStatus(id, definitionsDir)
        const latestPublished = getLatestPublishedVersion(id, definitionsDir)
        let definition
        if (latestPublished !== null) {
          definition = loadDefinition(id, { definitionsDir, version: latestPublished })
        } else {
          // No published versions: use latest version for title/stages display
          const maxVersion = Math.max(...versions)
          definition = loadDefinition(id, { definitionsDir, version: maxVersion })
        }
        const row = {
          id: definition.id,
          title: definition.title,
          description: definition.description ?? null,
          stages: definition.stages.map((stage) => ({ id: stage.id, title: stage.title })),
          latestPublished,
          versions: versionsWithStatus,
        }
        if (includeArchived) row.archived = Boolean(archived)
        return row
      }
      // Legacy flat
      const definition = loadDefinition(id, { definitionsDir })
      const row = {
        id: definition.id,
        title: definition.title,
        description: definition.description ?? null,
        stages: definition.stages.map((stage) => ({ id: stage.id, title: stage.title })),
        latestPublished: 1,
        versions: [{ version: 1, status: 'published' }],
      }
      if (includeArchived) row.archived = Boolean(archived)
      return row
    })
}

/**
 * Load the CHANGELOG.md for a specific definition version, if present.
 *
 * Convention: `definitions/<id>/<n>/CHANGELOG.md`, freeform Markdown, one file per version dir, git-diffable. A missing file is valid (returns `null`).
 *
 * Validates `definitionId` against the known-ids guard (as at `lib/server.js:761`) — the value must exactly match a known id from `listDefinitions()` — and coerces/validates `version` to a positive integer, rejecting traversal attempts.
 *
 * @param {string} definitionId
 * @param {number|string} version
 * @param {{ definitionsDir?: string }} [options]
 * @returns {string|null}
 */
export function loadDefinitionChangelog(definitionId, version, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const knownIds = new Set(listDefinitions({ definitionsDir }).map((d) => d.id))
  if (typeof definitionId !== 'string' || !knownIds.has(definitionId)) {
    throw new Error(`Unknown definition "${definitionId}"`)
  }
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  // Resolve through existing helper so version directory validation and path traversal checks are centralised.
  const dir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const changelogPath = join(dir, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) return null
  return readFileSync(changelogPath, 'utf8')
}

export function definitionVersionProjection(def) {
  const orderedIds = []
  const seen = new Set()
  for (const stage of def.stages) {
    for (const mid of stage.modules) {
      if (!seen.has(mid)) { seen.add(mid); orderedIds.push(mid) }
    }
  }
  for (const artefact of def.artefacts) {
    for (const req of artefact.requires) {
      const mid = req.includes('.') ? req.slice(0, req.indexOf('.')) : req
      if (!seen.has(mid)) { seen.add(mid); orderedIds.push(mid) }
    }
  }
  for (const [mid] of def.modules) {
    if (!seen.has(mid)) { seen.add(mid); orderedIds.push(mid) }
  }
  const remaining = [...def.modules.keys()].filter((k) => !orderedIds.includes(k)).sort()
  const finalOrder = [...orderedIds.filter((id) => def.modules.has(id)), ...remaining]
  const modules = finalOrder.map((mid) => {
    const m = def.modules.get(mid)
    const base = { id: m.id, title: m.title, purpose: m.purpose, fields: m.fields.map((f) => {
      const fbase = { id: f.id, title: f.title, type: f.type, required: f.required === true ? true : undefined, requiredAt: f.requiredAt, guidance: f.guidance }
      if (f.copiedFrom !== undefined) fbase.copiedFrom = f.copiedFrom
      if (f.type === 'select') {
        fbase.options = f.options
        if (f.multiple === true) fbase.multiple = true
        if (f.default !== undefined) fbase.default = f.default
      }
      return fbase
    }) }
    if (m.copiedFrom !== undefined) base.copiedFrom = m.copiedFrom
    return base
  })
  const stages = def.stages.map((s) => {
    const base = { id: s.id, title: s.title, purpose: s.purpose, gate: s.gate, modules: s.modules }
    if (s.readOnlyModules !== undefined) base.readOnlyModules = s.readOnlyModules
    if (s.example !== undefined) base.example = s.example
    if (s.copiedFrom !== undefined) base.copiedFrom = s.copiedFrom
    return base
  })
  const artefacts = def.artefacts.map((a) => {
    const base = { id: a.id, title: a.title, purpose: a.purpose, template: a.template, gate: a.gate, requires: a.requires }
    if (a.filename !== undefined) base.filename = a.filename
    // #148: both default to true, so only an opt-out is projected — every Definition that doesn't
    // use them projects exactly as it did before they existed. #150: a `document-control` that
    // isn't a boolean ("no") is projected as it is, so the Definitions page's markers and Save's
    // validation see it — dropping it here would print both tables and delete the key on Save.
    if (a.documentControl !== undefined && a.documentControl !== true) base.documentControl = a.documentControl
    if (a.satisfiesGate === false) base.satisfiesGate = false
    if (a.copiedFrom !== undefined) base.copiedFrom = a.copiedFrom
    return base
  })
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    version: def.version,
    status: def.status,
    stages,
    artefacts,
    modules,
  }
}

// Exported for lib/definitionAzureDevOps.js (WI #383): the Azure-DevOps-backed write path builds the
// exact same definition.yaml / modules/*.yaml shape this local-filesystem path does — same key order,
// same `copied-from`/`required-at` conventions — it just pushes the resulting text to a repo instead of
// writing it to disk here, so it reuses these two builders rather than re-deriving the shape.
//
// #148: `structure` may be either form of a Definition — the camelCase in-memory/projection form
// (the web editor's save, the Library cache, a local workspace's inline definition) or the raw
// kebab-case YAML record read straight off disk or a repo (publish, new draft version, clone, which
// all rebuild `definition.yaml` from what they just read). `keyOf` reads a key under either spelling,
// so a key survives whichever form a caller has; before this, publish passed raw YAML and silently
// dropped Stage/Artefact `copied-from`.
function keyOf(obj, camel, kebab) {
  return obj[camel] !== undefined ? obj[camel] : obj[kebab]
}

export function buildDefinitionYamlObject(definitionId, version, status, structure, onDiskRaw) {
  // Preserves key order: id, version, status, title, description, stages, artefacts
  const obj = {}
  obj.id = definitionId
  obj.version = version
  obj.status = status
  obj.title = structure.title
  obj.description = structure.description
  obj.stages = (structure.stages ?? []).map((s) => {
    const onDiskStage = (onDiskRaw.stages ?? []).find((x) => x.id === s.id)
    const entry = {}
    entry.id = s.id
    entry.title = s.title
    entry.purpose = s.purpose
    entry.gate = s.gate
    entry.modules = s.modules ?? []
    const readOnlyModules = keyOf(s, 'readOnlyModules', 'read-only-modules')
    if (readOnlyModules !== undefined) entry['read-only-modules'] = readOnlyModules
    if (s.example !== undefined) entry.example = s.example
    else if (onDiskStage?.example !== undefined) entry.example = onDiskStage.example
    const copiedFrom = keyOf(s, 'copiedFrom', 'copied-from')
    if (copiedFrom !== undefined) entry['copied-from'] = copiedFrom
    return entry
  })
  obj.artefacts = (structure.artefacts ?? []).map((a) => {
    const entry = {}
    entry.id = a.id
    entry.title = a.title
    entry.purpose = a.purpose
    entry.template = a.template
    entry.gate = a.gate
    entry.requires = a.requires ?? []
    if (a.filename !== undefined) entry.filename = a.filename
    const documentControl = keyOf(a, 'documentControl', 'document-control')
    if (documentControl !== undefined) entry['document-control'] = documentControl
    const satisfiesGate = keyOf(a, 'satisfiesGate', 'satisfies-gate')
    if (satisfiesGate !== undefined) entry['satisfies-gate'] = satisfiesGate
    const copiedFrom = keyOf(a, 'copiedFrom', 'copied-from')
    if (copiedFrom !== undefined) entry['copied-from'] = copiedFrom
    return entry
  })
  return obj
}

export function buildModuleYamlObject(mod) {
  // Preserves key order: id, title, purpose, fields; each field: id, title, type, required/required-at, guidance
  // #148: like buildDefinitionYamlObject above, accepts a module in either its camelCase or raw kebab-case form.
  const obj = {}
  obj.id = mod.id
  obj.title = mod.title
  obj.purpose = mod.purpose
  obj.fields = (mod.fields ?? []).map((f) => {
    const field = {}
    field.id = f.id
    field.title = f.title
    field.type = f.type
    const requiredAt = keyOf(f, 'requiredAt', 'required-at')
    if (f.required === true) field.required = true
    else if (requiredAt) field['required-at'] = requiredAt
    if (f.guidance !== undefined && f.guidance !== null) field.guidance = f.guidance
    if (f.type === 'select') {
      field.options = f.options ?? []
      if (f.multiple === true) field.multiple = true
      if (f.default !== undefined) field.default = f.default
    }
    const fieldCopiedFrom = keyOf(f, 'copiedFrom', 'copied-from')
    if (fieldCopiedFrom !== undefined) field['copied-from'] = fieldCopiedFrom
    return field
  })
  const copiedFrom = keyOf(mod, 'copiedFrom', 'copied-from')
  if (copiedFrom !== undefined) obj['copied-from'] = copiedFrom
  return obj
}

function writeProposedFilesToDir(dir, definitionId, version, status, structure, onDiskRaw) {
  // dir is expected to already contain a full copy of the version dir (templates/, CHANGELOG.md, etc.)
  // This helper only owns definition.yaml and the managed modules/*.yaml set.
  mkdirSync(join(dir, 'modules'), { recursive: true })
  const defObj = buildDefinitionYamlObject(definitionId, version, status, structure, onDiskRaw)
  writeFileSync(join(dir, 'definition.yaml'), stringifyYAML(defObj))
  const wanted = new Set((structure.modules ?? []).map((m) => m.id))
  for (const mod of structure.modules ?? []) {
    const modObj = buildModuleYamlObject(mod)
    writeFileSync(join(dir, 'modules', `${mod.id}.yaml`), stringifyYAML(modObj))
  }
  // Delete any stale modules/*.yaml whose id is not in the new structure — but preserve everything else (templates/, CHANGELOG.md)
  try {
    for (const name of readdirSync(join(dir, 'modules'))) {
      if (!name.endsWith('.yaml')) continue
      const id = name.slice(0, -'.yaml'.length)
      if (!wanted.has(id)) {
        rmSync(join(dir, 'modules', name), { force: true })
      }
    }
  } catch {}
}

export function writeDefinitionVersion(definitionId, version, structure, { definitionsDir = 'definitions' } = {}) {
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  const targetDir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const onDiskRaw = readYAML(join(targetDir, 'definition.yaml'))
  if (onDiskRaw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${onDiskRaw.status})`)
  }
  // Validate module ids are slugs
  for (const mod of structure.modules ?? []) {
    if (!isValidSlug(mod.id)) {
      throw new Error(`Invalid module id "${mod.id}"`)
    }
  }

  // Duplicate ids must be caught on the *incoming* structure, before writeProposedFilesToDir ever runs —
  // it writes one file per module id, so two modules sharing an id would silently collapse to a single
  // file (second write wins, first module's content lost) and the validate-then-write pass below, which
  // reads the result back off disk, would find nothing wrong because the collision is already gone by then.
  const duplicateProblems = findDuplicateIdProblems(structure)
  if (duplicateProblems.length > 0) {
    return { problems: duplicateProblems }
  }

  const versionVal = onDiskRaw.version
  const statusVal = onDiskRaw.status

  // Validate-then-write: build prospective file set in a temp definitionsDir and run findDefinitionProblems before touching real dir
  const tempRoot = mkdtempSync(join(tmpdir(), 'gantry-defn-validate-'))
  const tempVersionDir = join(tempRoot, definitionId, String(vNum))
  // Start from a full copy of the real version dir so templates/ and CHANGELOG.md are present for validation
  mkdirSync(join(tempRoot, definitionId), { recursive: true })
  cpSync(targetDir, tempVersionDir, { recursive: true })
  writeProposedFilesToDir(tempVersionDir, definitionId, versionVal, statusVal, structure, onDiskRaw)
  const problems = findDefinitionProblems(definitionId, { definitionsDir: tempRoot, version: vNum })
  if (problems.length > 0) {
    rmSync(tempRoot, { recursive: true, force: true })
    const err = new Error(problems[0].message)
    err.problems = problems
    // Return { problems } for callers that check return value (tests), but also carry .problems for server catch
    // We return object to satisfy "return { problems }" contract; server will also handle thrown err path
    return { problems }
  }
  rmSync(tempRoot, { recursive: true, force: true })

  // Atomic install via sibling temp dir + renameSync — single comment stating strategy
  // atomic install: write into sibling temp dir then renameSync over target
  const siblingTmp = join(join(definitionsDir, definitionId), `.tmp-${vNum}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  // Concurrent-edit locking is not implemented; assume single operator
  // copy-then-overwrite-then-swap: preserve every file in targetDir that this feature does not own (templates/, CHANGELOG.md)
  cpSync(targetDir, siblingTmp, { recursive: true })
  try {
    writeProposedFilesToDir(siblingTmp, definitionId, versionVal, statusVal, structure, onDiskRaw)
    // Remove old target and atomically replace
    rmSync(targetDir, { recursive: true, force: true })
    renameSync(siblingTmp, targetDir)
  } catch (err) {
    rmSync(siblingTmp, { recursive: true, force: true })
    throw err
  }

  const fresh = loadDefinition(definitionId, { definitionsDir, version: vNum })
  return definitionVersionProjection(fresh)
}

export function createDraftVersion(definitionId, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const idDir = join(definitionsDir, definitionId)
  if (!existsSync(idDir)) {
    throw new Error(`Definition "${definitionId}" not found at ${idDir}`)
  }
  if (isDefinitionArchived(definitionId, { definitionsDir })) {
    throw new Error(`Definition "${definitionId}" is archived`)
  }
  const versions = listVersionNumbers(definitionId, definitionsDir)
  if (versions.length === 0) {
    throw new Error(`Definition "${definitionId}" has no versions`)
  }
  const max = Math.max(...versions)
  const n = max + 1
  const srcDir = join(idDir, String(max))
  const dstDir = join(idDir, String(n))
  cpSync(srcDir, dstDir, { recursive: true })
  const raw = readYAML(join(dstDir, 'definition.yaml'))
  const newObj = buildDefinitionYamlObject(definitionId, n, 'draft', raw, raw)
  writeFileSync(join(dstDir, 'definition.yaml'), stringifyYAML(newObj))
  writeFileSync(join(dstDir, 'CHANGELOG.md'), `## v${n}\n\nDraft.\n`)
  return { version: n }
}

export function cloneDefinition(sourceId, newId, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const versions = listVersionNumbers(sourceId, definitionsDir)
  if (versions.length === 0 && !existsSync(join(definitionsDir, sourceId))) {
    throw new Error(`Unknown definition "${sourceId}"`)
  }
  if (versions.length === 0) {
    throw new Error(`Unknown definition "${sourceId}"`)
  }
  // Validate source exists via known ids check
  const sourceExists = existsSync(join(definitionsDir, sourceId))
  if (!sourceExists) {
    throw new Error(`Unknown definition "${sourceId}"`)
  }
  if (!isValidSlug(newId)) {
    throw new Error(`Invalid slug "${newId}"`)
  }
  const newDir = join(definitionsDir, newId)
  if (existsSync(newDir)) {
    throw new Error(`Definition "${newId}" already exists`)
  }
  const latestPublished = getLatestPublishedVersion(sourceId, definitionsDir)
  const srcVersion = latestPublished ?? Math.max(...versions)
  const srcDir = join(definitionsDir, sourceId, String(srcVersion))
  const dstDir = join(newDir, '1')
  mkdirSync(newDir, { recursive: true })
  cpSync(srcDir, dstDir, { recursive: true })
  const raw = readYAML(join(dstDir, 'definition.yaml'))
  const newObj = buildDefinitionYamlObject(newId, 1, 'draft', raw, raw)
  // Ensure id is newId even if raw had different
  newObj.id = newId
  // buildDefinitionYamlObject already sets id, but ensure
  writeFileSync(join(dstDir, 'definition.yaml'), stringifyYAML(newObj))
  writeFileSync(join(dstDir, 'CHANGELOG.md'), `## v1\n\nDraft.\n`)
  return { id: newId }
}

// A brand-new definition with no stages, artefacts or modules yet — the "Blank" half of the
// definition editor's New definition choice (WI #381; "Clone" is `cloneDefinition` above). Starts at
// v1 draft, same on-disk shape as every other definition so it immediately works with every other
// function here (`loadDefinition`, `writeDefinitionVersion`, `publishDefinitionVersion`, …).
export function createBlankDefinition(newId, { definitionsDir, title } = {}) {
  definitionsDir ??= 'definitions'
  if (!isValidSlug(newId)) {
    throw new Error(`Invalid slug "${newId}"`)
  }
  const newDir = join(definitionsDir, newId)
  if (existsSync(newDir)) {
    throw new Error(`Definition "${newId}" already exists`)
  }
  const dstDir = join(newDir, '1')
  mkdirSync(join(dstDir, 'modules'), { recursive: true })
  mkdirSync(join(dstDir, 'templates'), { recursive: true })
  const obj = { id: newId, version: 1, status: 'draft', title: title || newId, description: '', stages: [], artefacts: [] }
  writeFileSync(join(dstDir, 'definition.yaml'), stringifyYAML(obj))
  writeFileSync(join(dstDir, 'CHANGELOG.md'), `## v1\n\nDraft.\n`)
  return { id: newId }
}

export function publishDefinitionVersion(definitionId, version, { definitionsDir } = {}) {
  definitionsDir ??= 'definitions'
  const vNum = Number(version)
  if (!Number.isInteger(vNum) || vNum < 1) {
    throw new Error(`Invalid definition version "${version}" for "${definitionId}"`)
  }
  const targetDir = resolveDefinitionDir(definitionId, { definitionsDir, version: vNum })
  const raw = readYAML(join(targetDir, 'definition.yaml'))
  if (raw.status !== 'draft') {
    throw new Error(`Version ${vNum} of "${definitionId}" is not a draft (status: ${raw.status})`)
  }
  const problems = findDefinitionProblems(definitionId, { definitionsDir, version: vNum })
  if (problems.length > 0) {
    const err = new Error(problems[0].message)
    err.problems = problems
    // Return { problems } for callers checking return value, but also ensure server can handle thrown case
    return { problems }
  }
  const newObj = buildDefinitionYamlObject(definitionId, vNum, 'published', raw, raw)
  writeFileSync(join(targetDir, 'definition.yaml'), stringifyYAML(newObj))
  const fresh = loadDefinition(definitionId, { definitionsDir, version: vNum })
  return definitionVersionProjection(fresh)
}
