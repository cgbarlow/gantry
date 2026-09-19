import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition, splitArtefactRequirement } from './definition.js'
import { readInstance, readModule, parseModuleFile, instanceDefinitionVersion } from './instance.js'
import { AuthenticationError } from './providerErrors.js'

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

function artefactRequirements(definition, artefact, gate) {
  const moduleIds = new Set()
  const fields = []

  for (const requirement of artefact.requires) {
    const { moduleId, fieldId, optional } = splitArtefactRequirement(requirement)
    moduleIds.add(moduleId)
    if (fieldId) {
      // A bare `module.field` always gates. An optional `module.field?` is in
      // scope (its module is loaded above) but only gates when the field is
      // independently required at this gate via its own `required`/`required-at`.
      if (optional) {
        // Validation guarantees this module/field resolves (findDefinitionProblems
        // rejects an unknown `module.field?`), so no defensive guard here — same
        // as the whole-module branch below.
        const fieldSpec = definition.modules.get(moduleId).fields.find((f) => f.id === fieldId)
        if (isFieldRequired(fieldSpec, gate)) {
          fields.push({ moduleId, fieldId, reference: `${moduleId}.${fieldId}` })
        }
        continue
      }
      fields.push({ moduleId, fieldId, reference: requirement })
      continue
    }

    const moduleSpec = definition.modules.get(moduleId)
    for (const field of moduleSpec.fields) {
      if (isFieldRequired(field, gate)) fields.push({ moduleId, fieldId: field.id, reference: `${moduleId}.${field.id}` })
    }
  }

  return { moduleIds, fields }
}

function buildArtefactStatus(definition, stage, artefact, moduleData) {
  const requirements = artefactRequirements(definition, artefact, stage.gate)
  const outstanding = []
  const missingModules = new Set()

  for (const moduleId of requirements.moduleIds) {
    if (!moduleData.get(moduleId)?.exists) {
      const title = definition.modules.get(moduleId)?.title ?? moduleId
      outstanding.push(`${title} (file missing)`)
      missingModules.add(moduleId)
    }
  }
  for (const field of requirements.fields) {
    if (missingModules.has(field.moduleId)) continue
    const data = moduleData.get(field.moduleId)
    if (!data?.exists || isFieldEmpty(data.fields[field.fieldId])) outstanding.push(field.reference)
  }
  return {
    id: artefact.id,
    title: artefact.title,
    gate: artefact.gate,
    requires: artefact.requires,
    outstanding: [...new Set(outstanding)],
    complete: outstanding.length === 0,
  }
}

function evaluateArtefacts(definition, stage, moduleData) {
  return definition.artefacts
    .filter((artefact) => artefact.gate === stage.gate)
    .map((artefact) => buildArtefactStatus(definition, stage, artefact, moduleData))
}
/**
 * For `stage`, reports each of its modules' presence and whether its fields required at that stage's gate are non-empty, plus the completeness of each artefact matched to that gate. `complete` is true when at least one matched artefact is complete. Shared by `status` (always the instance's current stage, non-strict parsing) and `check` (any gate's stage, strict parsing — a parser anomaly must fail the gate, not pass silently on data the parser wasn't confident about).
 *
 * With `options.azureDevOps` supplied, reads each module file from that Azure DevOps repo instead of the local filesystem (see evaluateStageFromAzureDevOps below) and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem read it always was.
 */
export function evaluateStage(definition, stage, slug, options = {}) {
  if (options.azureDevOps) {
    return evaluateStageFromAzureDevOps(definition, stage, slug, options)
  }
  if (options.github) {
    return evaluateStageFromGitHub(definition, stage, slug, options)
  }
  if (options.gitlab) {
    return evaluateStageFromGitLab(definition, stage, slug, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const strict = options.strict ?? false

  const moduleData = new Map()
  const modules = stage.modules.map((moduleId) => {
    const moduleSpec = definition.modules.get(moduleId)
    const path = join(instancesDir, slug, 'modules', `${moduleId}.md`)
    const exists = existsSync(path)

    const parsedFields = exists
      ? parseModuleFile(readFileSync(path, 'utf8'), moduleSpec, { strict }).fields
      : {}

    moduleData.set(moduleId, { exists, fields: parsedFields })
    return buildModuleStatus(definition, stage, moduleId, exists, parsedFields)
  })
  const artefacts = evaluateArtefacts(definition, stage, moduleData)

  return { modules, artefacts, complete: artefacts.some((artefact) => artefact.complete) }
}

// The Azure-DevOps-backed half of evaluateStage (#86) — reuses `readModule` (lib/instance.js) rather than a raw fetch, so a module's presence is judged the exact same way readModule itself distinguishes "no saved data" from a real read failure. Only `readModule`'s "no saved data" error is treated as `exists: false` (mirroring the local path's `existsSync` check); an `AuthenticationError` propagates so the server's credential-gating layer can turn it into the structured "authentication required" response, and any other error propagates as a genuine failure rather than being silently read as "module missing". `options.strict` is forwarded to `readModule` (which forwards it to `parseModuleFile`), so a parser anomaly throws here exactly as it does on the local path, rather than this backend silently applying non-strict semantics regardless of what the caller asked for.
async function evaluateStageFromAzureDevOps(definition, stage, slug, options) {
  const strict = options.strict ?? false

  const moduleDataEntries = await Promise.all(
    stage.modules.map(async (moduleId) => {
      let exists = true
      let parsedFields = {}
      try {
        const data = await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps, strict })
        parsedFields = data.fields
      } catch (err) {
        if (err instanceof AuthenticationError) throw err
        if (!/has no saved data/.test(err.message)) throw err
        exists = false
      }
      return [moduleId, { exists, fields: parsedFields }]
    })
  )
  const moduleData = new Map(moduleDataEntries)
  const modules = stage.modules.map((moduleId) => {
    const data = moduleData.get(moduleId)
    return buildModuleStatus(definition, stage, moduleId, data.exists, data.fields)
  })
  const artefacts = evaluateArtefacts(definition, stage, moduleData)

  return { modules, artefacts, complete: artefacts.some((artefact) => artefact.complete) }
}

// The GitHub twin of evaluateStageFromAzureDevOps above (#11) — identical shape, over readModule's
// `{ github }` option instead.
async function evaluateStageFromGitHub(definition, stage, slug, options) {
  const strict = options.strict ?? false

  const moduleDataEntries = await Promise.all(
    stage.modules.map(async (moduleId) => {
      let exists = true
      let parsedFields = {}
      try {
        const data = await readModule(definition, slug, moduleId, { github: options.github, strict })
        parsedFields = data.fields
      } catch (err) {
        if (err instanceof AuthenticationError) throw err
        if (!/has no saved data/.test(err.message)) throw err
        exists = false
      }
      return [moduleId, { exists, fields: parsedFields }]
    })
  )
  const moduleData = new Map(moduleDataEntries)
  const modules = stage.modules.map((moduleId) => {
    const data = moduleData.get(moduleId)
    return buildModuleStatus(definition, stage, moduleId, data.exists, data.fields)
  })
  const artefacts = evaluateArtefacts(definition, stage, moduleData)

  return { modules, artefacts, complete: artefacts.some((artefact) => artefact.complete) }
}

// The GitLab twin of evaluateStageFromGitHub above (#33, ADR-0041) — identical shape, over
// readModule's `{ gitlab }` option instead.
async function evaluateStageFromGitLab(definition, stage, slug, options) {
  const strict = options.strict ?? false

  const moduleDataEntries = await Promise.all(
    stage.modules.map(async (moduleId) => {
      let exists = true
      let parsedFields = {}
      try {
        const data = await readModule(definition, slug, moduleId, { gitlab: options.gitlab, strict })
        parsedFields = data.fields
      } catch (err) {
        if (err instanceof AuthenticationError) throw err
        if (!/has no saved data/.test(err.message)) throw err
        exists = false
      }
      return [moduleId, { exists, fields: parsedFields }]
    })
  )
  const moduleData = new Map(moduleDataEntries)
  const modules = stage.modules.map((moduleId) => {
    const data = moduleData.get(moduleId)
    return buildModuleStatus(definition, stage, moduleId, data.exists, data.fields)
  })
  const artefacts = evaluateArtefacts(definition, stage, moduleData)

  return { modules, artefacts, complete: artefacts.some((artefact) => artefact.complete) }
}

/**
 * `gantry status <slug>`: for the instance's current stage (or `options.stageId`, for callers browsing a stage other than the instance's current one — e.g. the web form), reports each module's presence and whether its fields required at that stage's gate are non-empty, together with per-artefact gate completeness.
 *
 * With `options.azureDevOps` supplied, reads the instance/modules from that Azure DevOps repo instead of the local filesystem and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem read it always was.
 */
export function getStatus(slug, options = {}) {
  if (options.azureDevOps) {
    return getStatusFromAzureDevOps(slug, options)
  }
  if (options.github) {
    return getStatusFromGitHub(slug, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const stageId = options.stageId ?? instance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const { modules, artefacts, complete } = evaluateStage(definition, stage, slug, { instancesDir })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
  }
}

// The Azure-DevOps-backed half of getStatus (#86) — the exact same shape as the local path, over instance/module data read from Azure DevOps.
async function getStatusFromAzureDevOps(slug, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const stageId = options.stageId ?? instance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const { modules, artefacts, complete } = await evaluateStage(definition, stage, slug, { azureDevOps: options.azureDevOps })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
  }
}

// The GitHub twin of getStatusFromAzureDevOps above (#11) — identical shape, over GitHub-backed
// instance/module data.
async function getStatusFromGitHub(slug, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { github: options.github })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const stageId = options.stageId ?? instance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const { modules, artefacts, complete } = await evaluateStage(definition, stage, slug, { github: options.github })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
  }
}
