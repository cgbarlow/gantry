import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'

const VALID_FIELD_TYPES = new Set(['markdown', 'list'])

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

/**
 * Structural problems with a definition: module references that don't resolve, invalid field types, and required/required-at mutual-exclusivity violations. Returns every problem found in one pass (never throws), so `gantry validate` can report all of them instead of just the first.
 *
 * @param {string} definitionId
 * @param {{ definitionsDir?: string }} [options]
 * @returns {{ type: string, message: string }[]}
 */
export function findDefinitionProblems(definitionId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const definitionDir = join(definitionsDir, definitionId)
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
    ...artefacts.flatMap((artefact) => artefact.requires),
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
    for (const moduleId of artefact.requires) {
      if (!availableModuleIds.has(moduleId)) {
        problems.push({
          type: 'missing-module',
          message: `Artefact "${artefact.id}" requires module "${moduleId}", but ${definitionDir}/modules/${moduleId}.yaml does not exist`,
        })
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
 * @param {{ definitionsDir?: string }} [options]
 */
export function loadDefinition(definitionId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const definitionDir = join(definitionsDir, definitionId)
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
    gate: stage.gate,
    modules: stage.modules ?? [],
    // The instance the web form's "Populate example text" button reads from for this stage — optional, a stage with none just has no example available.
    example: stage.example,
  }))

  const artefacts = (raw.artefacts ?? []).map((artefact) => ({
    id: artefact.id,
    title: artefact.title,
    template: artefact.template,
    gate: artefact.gate,
    requires: artefact.requires ?? [],
  }))

  const referencedModuleIds = new Set([
    ...stages.flatMap((stage) => stage.modules),
    ...artefacts.flatMap((artefact) => artefact.requires),
  ])

  const modules = new Map()
  for (const moduleId of referencedModuleIds) {
    modules.set(moduleId, loadModuleSpec(definitionDir, moduleId))
  }

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    stages,
    artefacts,
    modules,
  }
}

/**
 * `gantry definitions` / `GET /api/definitions`: every definition available in `definitionsDir`, sorted by id, with just what a picker screen needs to render a choice — id, title, and each stage's id/title — not the full `loadDefinition` shape (module specs, artefacts), which is more than a picker (the instance-setup wizard, #78) needs to show.
 *
 * @param {{ definitionsDir?: string }} [options]
 * @returns {{ id: string, title: string, stages: { id: string, title: string }[] }[]}
 */
export function listDefinitions(options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  if (!existsSync(definitionsDir)) return []

  return readdirSync(definitionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(definitionsDir, entry.name, 'definition.yaml')))
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const definition = loadDefinition(id, { definitionsDir })
      return {
        id: definition.id,
        title: definition.title,
        stages: definition.stages.map((stage) => ({ id: stage.id, title: stage.title })),
      }
    })
}
