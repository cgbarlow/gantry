import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'

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
  if (!existsSync(definitionsDir)) return []

  return readdirSync(definitionsDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false
      const id = entry.name
      const versions = listVersionNumbers(id, definitionsDir)
      if (versions.length > 0) return true
      return existsSync(join(definitionsDir, id, 'definition.yaml'))
    })
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const versions = listVersionNumbers(id, definitionsDir)
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
        return {
          id: definition.id,
          title: definition.title,
          description: definition.description ?? null,
          stages: definition.stages.map((stage) => ({ id: stage.id, title: stage.title })),
          latestPublished,
          versions: versionsWithStatus,
        }
      }
      // Legacy flat
      const definition = loadDefinition(id, { definitionsDir })
      return {
        id: definition.id,
        title: definition.title,
        description: definition.description ?? null,
        stages: definition.stages.map((stage) => ({ id: stage.id, title: stage.title })),
        latestPublished: 1,
        versions: [{ version: 1, status: 'published' }],
      }
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
