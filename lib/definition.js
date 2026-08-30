import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { isValidSlug } from './slug.js'

const VALID_FIELD_TYPES = new Set(['markdown', 'list'])
const VALID_STATUSES = new Set(['draft', 'published'])

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

function resolveDefinitionDir(definitionId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
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

  const fields = (raw.fields ?? []).map((field) => {
    if (!VALID_FIELD_TYPES.has(field.type)) {
      throw new Error(
        `Module "${moduleId}" field "${field.id}" has unknown type "${field.type}" (expected "markdown" or "list")`
      )
    }
    if (field.required !== undefined && field['required-at'] !== undefined) {
      throw new Error(
        `Module "${moduleId}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`
      )
    }
    return {
      id: field.id,
      title: field.title,
      type: field.type,
      required: field.required,
      requiredAt: field['required-at'],
      guidance: field.guidance,
    }
  })

  return {
    id: raw.id,
    title: raw.title,
    purpose: raw.purpose,
    fields,
  }
}

// Artefact requirements normally name a whole module (the original schema),
// but may name one field as `module.field` when artefacts sharing a module have
// different required content. Keeping the shorthand means existing
// definitions remain unchanged while allowing proportional artefacts.
export function splitArtefactRequirement(requirement) {
  const separator = requirement.indexOf('.')
  if (separator === -1) return { moduleId: requirement, fieldId: undefined }
  return { moduleId: requirement.slice(0, separator), fieldId: requirement.slice(separator + 1) }
}

export function artefactModuleIds(artefact) {
  return [...new Set(artefact.requires.map((requirement) => splitArtefactRequirement(requirement).moduleId))]
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
    modules: stage.modules ?? [],
  }))
  const artefacts = (raw.artefacts ?? []).map((artefact) => ({
    id: artefact.id,
    requires: artefact.requires ?? [],
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
      const { moduleId, fieldId } = splitArtefactRequirement(requirement)
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

  for (const moduleId of referencedModuleIds) {
    if (!availableModuleIds.has(moduleId)) continue
    const rawModule = readYAML(join(definitionDir, 'modules', `${moduleId}.yaml`))
    for (const field of rawModule.fields ?? []) {
      if (!VALID_FIELD_TYPES.has(field.type)) {
        problems.push({
          type: 'unknown-field-type',
          message: `Module "${moduleId}" field "${field.id}" has unknown type "${field.type}" (expected "markdown" or "list")`,
        })
      }
      if (field.required !== undefined && field['required-at'] !== undefined) {
        problems.push({
          type: 'mutually-exclusive-required',
          message: `Module "${moduleId}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`,
        })
      }
    }
  }

  return problems
}

/**
 * Load a definition (e.g. "design") and every module spec it references, validating that all stage/artefact module references resolve. Fails fast on the first structural problem found (see `findDefinitionProblems` for the non-throwing, report-everything variant used by `gantry validate`).
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

  const problems = findDefinitionProblems(definitionId, options)
  if (problems.length > 0) {
    throw new Error(problems[0].message)
  }

  const stages = (raw.stages ?? []).map((stage) => ({
    id: stage.id,
    title: stage.title,
    purpose: stage.purpose,
    gate: stage.gate,
    modules: stage.modules ?? [],
    // The instance the web form's "Populate example text" button reads from for this stage — optional, a stage with none just has no example available.
    example: stage.example,
  }))

  const artefacts = (raw.artefacts ?? []).map((artefact) => ({
    id: artefact.id,
    title: artefact.title,
    purpose: artefact.purpose,
    template: artefact.template,
    gate: artefact.gate,
    requires: artefact.requires ?? [],
  }))

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
    return { id: m.id, title: m.title, purpose: m.purpose, fields: m.fields.map((f) => ({ id: f.id, title: f.title, type: f.type, required: f.required === true ? true : undefined, requiredAt: f.requiredAt, guidance: f.guidance })) }
  })
  const stages = def.stages.map((s) => {
    const base = { id: s.id, title: s.title, purpose: s.purpose, gate: s.gate, modules: s.modules }
    if (s.example !== undefined) base.example = s.example
    return base
  })
  const artefacts = def.artefacts.map((a) => ({ id: a.id, title: a.title, purpose: a.purpose, template: a.template, gate: a.gate, requires: a.requires }))
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

function buildDefinitionYamlObject(definitionId, version, status, structure, onDiskRaw) {
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
    if (s.example !== undefined) entry.example = s.example
    else if (onDiskStage?.example !== undefined) entry.example = onDiskStage.example
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
    return entry
  })
  return obj
}

function buildModuleYamlObject(mod) {
  // Preserves key order: id, title, purpose, fields; each field: id, title, type, required/required-at, guidance
  const obj = {}
  obj.id = mod.id
  obj.title = mod.title
  obj.purpose = mod.purpose
  obj.fields = (mod.fields ?? []).map((f) => {
    const field = {}
    field.id = f.id
    field.title = f.title
    field.type = f.type
    if (f.required === true) field.required = true
    else if (f.requiredAt) field['required-at'] = f.requiredAt
    if (f.guidance !== undefined && f.guidance !== null) field.guidance = f.guidance
    return field
  })
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
