import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from './definition.js'
import { readInstance, parseModuleFile } from './instance.js'

function isFieldRequired(field, gate) {
  if (field.required) return true
  if (field.requiredAt) return field.requiredAt.includes(gate)
  return false
}

function isFieldEmpty(value) {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return value.trim().length === 0
}

/**
 * For `stage`, reports each of its modules' presence and whether its fields
 * required at that stage's gate are non-empty. Shared by `status` (always
 * the instance's current stage, non-strict parsing) and `check` (any gate's
 * stage, strict parsing — a parser anomaly must fail the gate, not pass
 * silently on data the parser wasn't confident about).
 */
export function evaluateStage(definition, stage, slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const strict = options.strict ?? false

  const modules = stage.modules.map((moduleId) => {
    const moduleSpec = definition.modules.get(moduleId)
    const path = join(instancesDir, slug, 'modules', `${moduleId}.md`)
    const exists = existsSync(path)

    const parsedFields = exists
      ? parseModuleFile(readFileSync(path, 'utf8'), moduleSpec, { strict }).fields
      : {}

    const fields = moduleSpec.fields.map((field) => ({
      id: field.id,
      title: field.title,
      required: isFieldRequired(field, stage.gate),
      present: exists && !isFieldEmpty(parsedFields[field.id]),
    }))
    const outstanding = fields.filter((f) => f.required && !f.present).map((f) => f.id)

    return {
      id: moduleId,
      title: moduleSpec.title,
      exists,
      fields,
      outstanding,
      complete: exists && outstanding.length === 0,
    }
  })

  return { modules, complete: modules.every((m) => m.complete) }
}

/**
 * `gantry status <slug>`: for the instance's current stage (or `options.stageId`,
 * for callers browsing a stage other than the instance's current one — e.g.
 * the web form), reports each module's presence and whether its fields
 * required at that stage's gate are non-empty. Presence/non-emptiness only —
 * no gate-validation logic.
 */
export function getStatus(slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const stageId = options.stageId ?? instance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const { modules, complete } = evaluateStage(definition, stage, slug, { instancesDir })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    complete,
  }
}
