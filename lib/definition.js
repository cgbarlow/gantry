import { readFileSync, readdirSync } from 'node:fs'
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
 * Load a definition (e.g. "design") and every module spec it references,
 * validating that all stage/artefact module references resolve.
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

  const stages = (raw.stages ?? []).map((stage) => ({
    id: stage.id,
    title: stage.title,
    gate: stage.gate,
    modules: stage.modules ?? [],
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

  const availableModuleIds = new Set(
    readdirSync(join(definitionDir, 'modules'))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.slice(0, -'.yaml'.length))
  )

  for (const stage of stages) {
    for (const moduleId of stage.modules) {
      if (!availableModuleIds.has(moduleId)) {
        throw new Error(
          `Stage "${stage.id}" references module "${moduleId}", but ${definitionDir}/modules/${moduleId}.yaml does not exist`
        )
      }
    }
  }
  for (const artefact of artefacts) {
    for (const moduleId of artefact.requires) {
      if (!availableModuleIds.has(moduleId)) {
        throw new Error(
          `Artefact "${artefact.id}" requires module "${moduleId}", but ${definitionDir}/modules/${moduleId}.yaml does not exist`
        )
      }
    }
  }

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
