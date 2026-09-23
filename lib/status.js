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

// #82 (ADR-0044): a select field's stored value that isn't in its own `options:` list — hand-edited
// content, or a draft Definition whose options changed — is preserved (never overwritten) and
// flagged here rather than blocking the Gate. Shared by every evaluateStage backend below via
// buildModuleStatus, so a warning appears identically for a local, remote (Provider-backed) or
// server-directory instance.
function selectOffListWarnings(moduleSpec, exists, parsedFields) {
  if (!exists) return []
  const warnings = []
  for (const field of moduleSpec.fields) {
    if (field.type !== 'select') continue
    const value = parsedFields[field.id]
    const options = field.options ?? []
    if (field.multiple === true) {
      const offList = (Array.isArray(value) ? value : []).filter((v) => !options.includes(v))
      if (offList.length) {
        warnings.push(`Module "${moduleSpec.title}" field "${field.title}" has values (${offList.map((v) => `"${v}"`).join(', ')}) that are not in its option list`)
      }
      continue
    }
    if (value === undefined || value === '') continue
    if (!options.includes(value)) {
      warnings.push(`Module "${moduleSpec.title}" field "${field.title}" has a value ("${value}") that is not in its option list`)
    }
  }
  return warnings
}

// #85 (ADR-0044): a `date` field's stored value that isn't a real ISO 8601 calendar date —
// hand-edited content, or a draft template that never went through the date picker — is the
// same category of problem as #82's off-list select value: content, not a structural error, so
// it warns rather than blocking the Gate. Strict regex first (rules out "3 Nov 2026" and
// anything with a time component) then a real round-trip through Date.UTC so a calendar
// impossibility like 2026-02-30 (which JS otherwise silently rolls over into March) is caught
// too. An empty value isn't malformed — nothing was typed — so it warns on neither.
function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function dateFormatWarnings(moduleSpec, exists, parsedFields) {
  if (!exists) return []
  const warnings = []
  for (const field of moduleSpec.fields) {
    if (field.type !== 'date') continue
    const value = parsedFields[field.id]
    if (value === undefined || value === '') continue
    if (!isValidIsoDate(value)) {
      warnings.push(`Module "${moduleSpec.title}" field "${field.title}" has a value ("${value}") that is not a valid date (expected YYYY-MM-DD)`)
    }
  }
  return warnings
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
    warnings: [...selectOffListWarnings(moduleSpec, exists, parsedFields), ...dateFormatWarnings(moduleSpec, exists, parsedFields)],
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
    // #151 (ADR-0051): whether this Artefact can pass its Gate. `satisfies-gate: false` (an
    // audience document) is still evaluated and reported above, but never counts in gatePasses.
    satisfiesGate: artefact.satisfiesGate !== false,
  }
}

function evaluateArtefacts(definition, stage, moduleData) {
  return definition.artefacts
    .filter((artefact) => artefact.gate === stage.gate)
    .map((artefact) => buildArtefactStatus(definition, stage, artefact, moduleData))
}

// ADR-0019 as amended by ADR-0051: a Gate passes when any one Artefact that satisfies it is complete.
function gatePasses(artefacts) {
  return artefacts.some((artefact) => artefact.satisfiesGate && artefact.complete)
}

/**
 * For `stage`, reports each of its modules' presence and whether its fields required at that stage's gate are non-empty, plus the completeness of each artefact matched to that gate. `complete` is true when at least one matched artefact that satisfies the gate (#151, ADR-0051 — every artefact but a `satisfies-gate: false` one) is complete. Shared by `status` (always the instance's current stage, non-strict parsing) and `check` (any gate's stage, strict parsing — a parser anomaly must fail the gate, not pass silently on data the parser wasn't confident about).
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
  if (options.atlassian) {
    return evaluateStageFromAtlassian(definition, stage, slug, options)
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

  return { modules, artefacts, complete: gatePasses(artefacts), warnings: modules.flatMap((m) => m.warnings) }
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

  return { modules, artefacts, complete: gatePasses(artefacts), warnings: modules.flatMap((m) => m.warnings) }
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

  return { modules, artefacts, complete: gatePasses(artefacts), warnings: modules.flatMap((m) => m.warnings) }
}

// The GitLab twin of evaluateStageFromGitHub above (#33, #35, ADR-0041) — identical shape, over
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

  return { modules, artefacts, complete: gatePasses(artefacts), warnings: modules.flatMap((m) => m.warnings) }
}

// The Atlassian (Bitbucket-backed) twin of evaluateStageFromGitLab above (#46, ADR-0042) — identical
// shape, over readModule's `{ atlassian }` option instead (`lib/instance.js`'s own atlassian-backed
// read, landed with #43's content-store wiring). Needed for `lib/repoCheck.js`'s `checkAtlassianRepo`
// to report a real `status: 'complete' | 'incomplete'` for an already-discovered instance the same way
// every other provider's own repo check already does — without this, `evaluateStage(definition, stage,
// slug, { atlassian })` would silently fall through to this function's own local-filesystem branch
// instead (no `options.atlassian` case to dispatch to), reading a directory that's never actually there
// rather than throwing — exactly the kind of quietly-wrong-instead-of-loud gap #48 was warned not to
// repeat.
async function evaluateStageFromAtlassian(definition, stage, slug, options) {
  const strict = options.strict ?? false

  const moduleDataEntries = await Promise.all(
    stage.modules.map(async (moduleId) => {
      let exists = true
      let parsedFields = {}
      try {
        const data = await readModule(definition, slug, moduleId, { atlassian: options.atlassian, strict })
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

  return { modules, artefacts, complete: gatePasses(artefacts), warnings: modules.flatMap((m) => m.warnings) }
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
  if (options.gitlab) {
    return getStatusFromGitLab(slug, options)
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

// The GitLab twin of getStatusFromGitHub above (#35, ADR-0041) — identical shape, over GitLab-backed
// instance/module data.
async function getStatusFromGitLab(slug, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { gitlab: options.gitlab })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const stageId = options.stageId ?? instance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const { modules, artefacts, complete } = await evaluateStage(definition, stage, slug, { gitlab: options.gitlab })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
  }
}
