import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from './definition.js'
import { readInstance, readModule, parseModuleFile } from './instance.js'
import { AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'

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

function buildModuleStatus(definition, stage, moduleId, exists, parsedFields) {
  const moduleSpec = definition.modules.get(moduleId)
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
}

/**
 * For `stage`, reports each of its modules' presence and whether its fields
 * required at that stage's gate are non-empty. Shared by `status` (always
 * the instance's current stage, non-strict parsing) and `check` (any gate's
 * stage, strict parsing — a parser anomaly must fail the gate, not pass
 * silently on data the parser wasn't confident about).
 *
 * With `options.azureDevOps` supplied, reads each module file from that
 * Azure DevOps repo instead of the local filesystem (see
 * evaluateStageFromAzureDevOps below) and returns a Promise the caller must
 * `await`. Without it — every existing caller — this stays exactly the
 * synchronous local-filesystem read it always was.
 */
export function evaluateStage(definition, stage, slug, options = {}) {
  if (options.azureDevOps) {
    return evaluateStageFromAzureDevOps(definition, stage, slug, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const strict = options.strict ?? false

  const modules = stage.modules.map((moduleId) => {
    const moduleSpec = definition.modules.get(moduleId)
    const path = join(instancesDir, slug, 'modules', `${moduleId}.md`)
    const exists = existsSync(path)

    const parsedFields = exists
      ? parseModuleFile(readFileSync(path, 'utf8'), moduleSpec, { strict }).fields
      : {}

    return buildModuleStatus(definition, stage, moduleId, exists, parsedFields)
  })

  return { modules, complete: modules.every((m) => m.complete) }
}

// The Azure-DevOps-backed half of evaluateStage (#86) — reuses `readModule`
// (lib/instance.js) rather than a raw fetch, so a module's presence is
// judged the exact same way readModule itself distinguishes "no saved
// data" from a real read failure. Only `readModule`'s "no saved data" error
// is treated as `exists: false` (mirroring the local path's `existsSync`
// check); an `AzureDevOpsAuthenticationError` propagates so the server's
// credential-gating layer can turn it into the structured "authentication
// required" response, and any other error propagates as a genuine failure
// rather than being silently read as "module missing". `options.strict` is
// forwarded to `readModule` (which forwards it to `parseModuleFile`), so a
// parser anomaly throws here exactly as it does on the local path, rather
// than this backend silently applying non-strict semantics regardless of
// what the caller asked for.
async function evaluateStageFromAzureDevOps(definition, stage, slug, options) {
  const strict = options.strict ?? false

  const modules = await Promise.all(
    stage.modules.map(async (moduleId) => {
      let exists = true
      let parsedFields = {}
      try {
        const data = await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps, strict })
        parsedFields = data.fields
      } catch (err) {
        if (err instanceof AzureDevOpsAuthenticationError) throw err
        if (!/has no saved data/.test(err.message)) throw err
        exists = false
      }
      return buildModuleStatus(definition, stage, moduleId, exists, parsedFields)
    })
  )

  return { modules, complete: modules.every((m) => m.complete) }
}

/**
 * `gantry status <slug>`: for the instance's current stage (or `options.stageId`,
 * for callers browsing a stage other than the instance's current one — e.g.
 * the web form), reports each module's presence and whether its fields
 * required at that stage's gate are non-empty. Presence/non-emptiness only —
 * no gate-validation logic.
 *
 * With `options.azureDevOps` supplied, reads the instance/modules from that
 * Azure DevOps repo instead of the local filesystem and returns a Promise
 * the caller must `await`. Without it — every existing caller — this stays
 * exactly the synchronous local-filesystem read it always was.
 */
export function getStatus(slug, options = {}) {
  if (options.azureDevOps) {
    return getStatusFromAzureDevOps(slug, options)
  }

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

// The Azure-DevOps-backed half of getStatus (#86) — the exact same shape
// as the local path, over instance/module data read from Azure DevOps.
async function getStatusFromAzureDevOps(slug, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const stageId = options.stageId ?? instance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const { modules, complete } = await evaluateStage(definition, stage, slug, { azureDevOps: options.azureDevOps })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    complete,
  }
}
