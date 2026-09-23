// Browser-side port of `lib/status.js` / `lib/check.js` / `lib/validate.js`'s
// gate-evaluation core (WI #313, ADR-0029). A **local workspace** instance's
// `status`, `check` and `validate` used to run server-side, either through the
// stateless `/api/local/{status,check,validate}` routes (`lib/localWorkspace.js`)
// or — for the module-card "outstanding fields" hint — a deliberately scoped-down
// client-side approximation. Those code paths are already `node:fs` + YAML-parsing
// only for a local workspace's own data (no `pandoc`/`git`, unlike `render`), so
// this ports the exact same computation to run entirely in the browser: zero round
// trip to the gantry server for these three operations (only `render`, which needs
// native `pandoc`/`git`, still calls it).
//
// Kept in lock-step with `lib/status.js` / `lib/check.js` / `lib/definition.js`'s
// own pure helpers — every function below names which server-side function it
// mirrors. Like `web/lib/localInstanceFiles.js` (the same "verbatim port, not an
// import" convention: `web/` is served straight to the browser with no build step,
// so it can't import `lib/status.js` itself — that pulls in `node:fs`, the Azure
// DevOps client, etc.
//
// Operates on the *definition version projection* shape a local workspace already
// has in memory — `GET /api/definitions/:id/versions/:n`'s response body,
// `lib/definition.js`'s `definitionVersionProjection` (see `loadLocalInstance` in
// `web/app.js`, which already fetches it once per editor load) — rather than the
// server's `Map`-keyed `loadDefinition` shape: same field names, a plain array
// instead of a `Map` for `modules`. That GET call is a one-time, cacheable read of
// static definition content (not instance compute) and is unaffected by this
// ticket — see its own "Not doing" scope.
//
// Module-file reads go through `readTextFile` (web/lib/localWorkspace.js, the File
// System Access API wrapper) in place of `node:fs`'s `existsSync`/`readFileSync`,
// and parsing goes through `parseLocalModuleFile` (web/lib/localInstanceFiles.js,
// already a verbatim port of `lib/instance.js`'s `parseModuleFile`) — so this file
// adds no new parsing logic of its own.

import { readTextFile } from './localWorkspace.js'
import { parseLocalModuleFile } from './localInstanceFiles.js'
import { isMultiValuedField } from './fieldShape.js'
import { readOnlyModuleProblems } from './readOnlyModules.js'

// ---------------------------------------------------------------------------
// definition/module lookup — the projection's `modules` is a plain array;
// index it once so the rest of this file can `.get()` the way lib/status.js's
// `definition.modules` (a `Map`) does.
// ---------------------------------------------------------------------------

function moduleMap(structure) {
  return new Map((structure.modules ?? []).map((m) => [m.id, m]))
}

/** Verbatim port of `lib/definition.js`'s `splitArtefactRequirement`. */
export function splitLocalArtefactRequirement(requirement) {
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

// Verbatim port of lib/status.js's (private) isFieldRequired.
function isFieldRequired(field, gate) {
  if (field.required) return true
  if (field.requiredAt) return field.requiredAt.includes(gate)
  return false
}

// Verbatim port of lib/status.js's (private) isFieldEmpty.
function isFieldEmpty(value) {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return value.trim().length === 0
}

// Verbatim port of lib/status.js's (private) selectOffListWarnings.
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

// Verbatim port of lib/status.js's (private) isValidIsoDate.
function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

// Verbatim port of lib/status.js's (private) dateFormatWarnings.
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

// Verbatim port of lib/status.js's (private) buildModuleStatus, over the
// projection's modulesById Map instead of definition.modules.
function buildModuleStatus(modulesById, stage, moduleId, exists, parsedFields) {
  const moduleSpec = modulesById.get(moduleId)
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

// Verbatim port of lib/status.js's (private) artefactRequirements.
function artefactRequirements(modulesById, artefact, gate) {
  const moduleIds = new Set()
  const fields = []

  for (const requirement of artefact.requires) {
    const { moduleId, fieldId, optional } = splitLocalArtefactRequirement(requirement)
    moduleIds.add(moduleId)
    if (fieldId) {
      if (optional) {
        const fieldSpec = modulesById.get(moduleId).fields.find((f) => f.id === fieldId)
        if (isFieldRequired(fieldSpec, gate)) {
          fields.push({ moduleId, fieldId, reference: `${moduleId}.${fieldId}` })
        }
        continue
      }
      fields.push({ moduleId, fieldId, reference: requirement })
      continue
    }

    const moduleSpec = modulesById.get(moduleId)
    for (const field of moduleSpec.fields) {
      if (isFieldRequired(field, gate)) fields.push({ moduleId, fieldId: field.id, reference: `${moduleId}.${field.id}` })
    }
  }

  return { moduleIds, fields }
}

// Verbatim port of lib/status.js's (private) buildArtefactStatus.
function buildArtefactStatus(modulesById, stage, artefact, moduleData) {
  const requirements = artefactRequirements(modulesById, artefact, stage.gate)
  const outstanding = []
  const missingModules = new Set()

  for (const moduleId of requirements.moduleIds) {
    if (!moduleData.get(moduleId)?.exists) {
      const title = modulesById.get(moduleId)?.title ?? moduleId
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
    // #151 (ADR-0051): the projection carries `satisfiesGate` only when it is false.
    satisfiesGate: artefact.satisfiesGate !== false,
  }
}

// Verbatim port of lib/status.js's (private) evaluateArtefacts.
function evaluateArtefacts(modulesById, stage, artefacts, moduleData) {
  return (artefacts ?? [])
    .filter((artefact) => artefact.gate === stage.gate)
    .map((artefact) => buildArtefactStatus(modulesById, stage, artefact, moduleData))
}

// Verbatim port of lib/status.js's (private) gatePasses.
function gatePasses(artefacts) {
  return artefacts.some((artefact) => artefact.satisfiesGate && artefact.complete)
}

/**
 * The pure tail shared by `lib/status.js`'s `evaluateStage` (both its local-fs
 * and Azure-DevOps-backed halves) — given `stage` and already-read/parsed
 * `moduleData` (a `Map<moduleId, { exists, fields }>`), reports each module's
 * status and each gate-matched artefact's completeness. Exported so
 * `getLocalStatus`/`checkLocalGate` below can call it, and so a caller that
 * already has `moduleData` some other way (e.g. a future batch read) can too.
 */
export function evaluateLocalStage(structure, stage, moduleData) {
  const modulesById = moduleMap(structure)
  const modules = stage.modules.map((moduleId) => {
    const data = moduleData.get(moduleId) ?? { exists: false, fields: {} }
    return buildModuleStatus(modulesById, stage, moduleId, data.exists, data.fields)
  })
  const artefacts = evaluateArtefacts(modulesById, stage, structure.artefacts, moduleData)

  return {
    modules,
    artefacts,
    complete: gatePasses(artefacts),
    warnings: modules.flatMap((m) => m.warnings),
  }
}

/**
 * Reads and parses each of `stage`'s module files through `handle` (the File
 * System Access API root directory handle for the workspace folder) — the
 * FSA-backed equivalent of `lib/status.js`'s local-filesystem branch
 * (`existsSync` + `readFileSync` + `parseModuleFile`). Existence is checked
 * strictly before parsing, exactly like the local-fs path's `existsSync`
 * guard — so a genuine parse failure (a `strict`-mode anomaly) always
 * propagates as a real error, never gets silently folded into "module
 * missing" the way a single try/catch around both steps would.
 */
export async function readLocalModuleData(handle, slug, stage, structure, options = {}) {
  const strict = options.strict ?? false
  const modulesById = moduleMap(structure)
  const moduleData = new Map()

  for (const moduleId of stage.modules) {
    const moduleSpec = modulesById.get(moduleId)
    let text
    let exists = true
    try {
      text = await readTextFile(handle, `gantry-workspace/${slug}/modules/${moduleId}.md`)
    } catch {
      exists = false
    }
    const fields = exists ? parseLocalModuleFile(text, moduleSpec, { strict }).fields : {}
    moduleData.set(moduleId, { exists, fields })
  }

  return moduleData
}

/**
 * Client-side port of `lib/status.js`'s `getStatus`, for a local workspace
 * (ADR-0029) — reports the given stage's module presence/completeness and
 * artefact completeness, reading module files through `handle` instead of
 * `node:fs`. `structure` is the definition version projection the editor
 * already has in memory (see this file's header comment); `stageId` is
 * whichever stage is being viewed (the instance's current stage, or one
 * explicitly browsed via the stage switcher — the same `options.stageId`
 * `getStatus` itself accepts).
 */
export async function getLocalStatus(handle, slug, structure, stageId) {
  const stage = structure.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }

  const moduleData = await readLocalModuleData(handle, slug, stage, structure, { strict: false })
  const { modules, artefacts, complete } = evaluateLocalStage(structure, stage, moduleData)

  return {
    slug,
    definition: structure.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
  }
}

/** Verbatim port of lib/check.js's resolveCheckStage. */
export function resolveLocalCheckStage(structure, instanceStageId, slug, options = {}) {
  if (options.gate) {
    const stage = structure.stages.find((s) => s.gate === options.gate)
    if (!stage) {
      throw new Error(`Definition "${structure.id}" has no stage with gate "${options.gate}"`)
    }
    return stage
  }
  const stage = structure.stages.find((s) => s.id === instanceStageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" is at unknown stage "${instanceStageId}"`)
  }
  return stage
}

// Verbatim port of lib/check.js's (private) checkResultFor.
function checkResultFor(slug, structure, stage, modules, artefacts, complete, warnings) {
  return {
    slug,
    definition: structure.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
    pass: complete,
    gate: stage.gate,
    warnings: warnings ?? [],
  }
}

/**
 * Client-side port of `lib/check.js`'s `checkGate`, for a local workspace —
 * strict parsing (a parser anomaly throws rather than warns), same
 * `options.gate` stage-resolution as the server-side function. `instanceStageId`
 * is the instance's own persisted `stage` (`instance.yaml`'s `stage` field);
 * `options.gate` resolves any stage whose `gate` matches, even if it isn't
 * the instance's current one, exactly like `checkGate`'s own contract.
 */
export async function checkLocalGate(handle, slug, structure, instanceStageId, options = {}) {
  const stage = resolveLocalCheckStage(structure, instanceStageId, slug, options)
  const moduleData = await readLocalModuleData(handle, slug, stage, structure, { strict: true })
  const { modules, artefacts, complete, warnings } = evaluateLocalStage(structure, stage, moduleData)

  return checkResultFor(slug, structure, stage, modules, artefacts, complete, warnings)
}

/**
 * Verbatim port of `lib/check.js`'s `formatGateOutstanding` — reports the
 * closest incomplete artefact that can pass the gate (#151, ADR-0051) rather
 * than the stage's full union of modules.
 */
export function formatLocalGateOutstanding(checkResult) {
  const artefacts = checkResult.artefacts ?? []
  const satisfying = artefacts.filter((artefact) => artefact.satisfiesGate !== false)
  const incomplete = satisfying.filter((artefact) => !artefact.complete)
  if (incomplete.length) {
    const closest = incomplete.reduce((best, artefact) =>
      artefact.outstanding.length < best.outstanding.length ? artefact : best
    )
    return `${closest.title}: ${closest.outstanding.join(', ') || 'see required modules'}`
  }
  if (artefacts.length && !satisfying.length) return 'no artefact counts toward this gate'

  const outstanding = (checkResult.modules ?? []).filter((module) => !module.complete).map((module) => module.title)
  return outstanding.join(', ') || 'see modules'
}

// ---------------------------------------------------------------------------
// validate — lib/validate.js's `validateDefinition` is really
// `lib/definition.js`'s `findDefinitionProblems`: structural problems with a
// *definition* (module references that don't resolve, invalid field types,
// required/required-at conflicts). A local workspace never holds a
// definition's raw YAML — only the already-loaded, already-`loadDefinition`-
// validated projection (`structure`, see this file's header comment), fetched
// once from the server's bundled `definitions/`. Since `loadDefinition`
// itself fails fast on the first such problem, a `structure` a local
// workspace ever actually has in hand is, by construction, always already
// free of them — bar the authoring-only gate-reference (#149) and
// read-only-modules (#152) problems (lib/definition.js's
// AUTHORING_ONLY_PROBLEM_TYPES), which loadDefinition
// deliberately lets through so existing instances keep loading. This ports
// the same checks `findDefinitionProblems` runs (over `structure` instead of
// raw per-module YAML files) for full parity with the server-side function's
// contract and test coverage, rather than assuming that invariant everywhere
// it's used.
// ---------------------------------------------------------------------------

// Verbatim port of lib/definition.js's artefactRequiresField (ADR-0045 §4).
function artefactRequiresLocalField(artefact, moduleId, fieldId) {
  return (artefact.requires ?? []).some((requirement) => {
    const split = splitLocalArtefactRequirement(requirement)
    return split.moduleId === moduleId && (!split.fieldId || split.fieldId === fieldId)
  })
}

// Verbatim port of lib/definition.js's filenamePatternProblems — see that file for the full
// rationale (ADR-0045). `findField(moduleId, fieldId)` resolves a token against this
// structure's own `modulesById`, built by the caller the same way `moduleMap` already does.
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
    if (!artefactRequiresLocalField(artefact, moduleId, fieldId)) {
      problems.push({
        type: 'filename-field-not-required',
        message: `Artefact "${artefact.id}" filename: references "{${token}}", but "${moduleId}.${fieldId}" is not in this artefact's own "requires" list`,
      })
    }
  }
  return problems
}

// Verbatim port of lib/definition.js's gateReferenceProblems (#149) — see that file for the full
// rationale. `modules` is this structure's own module list, already in the camelCase shape it takes.
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
  // #151 (ADR-0051): unsatisfiable-gate.
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
 * Client-side port of `lib/definition.js`'s `findDefinitionProblems`, over an
 * already-loaded definition version projection (`structure`) instead of
 * `definitions/<id>/<version>/*.yaml` read off disk.
 */
export function findLocalDefinitionProblems(structure) {
  const problems = []
  const modulesById = moduleMap(structure)
  const availableModuleIds = new Set(modulesById.keys())

  const stages = structure.stages ?? []
  const artefacts = structure.artefacts ?? []

  for (const stage of stages) {
    for (const moduleId of stage.modules ?? []) {
      if (!availableModuleIds.has(moduleId)) {
        problems.push({
          type: 'missing-module',
          message: `Stage "${stage.id}" references module "${moduleId}", but the definition has no such module`,
        })
      }
    }
  }

  for (const artefact of artefacts) {
    for (const requirement of artefact.requires ?? []) {
      const { moduleId, fieldId, optional } = splitLocalArtefactRequirement(requirement)
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
          message: `Artefact "${artefact.id}" requires module "${moduleId}", but the definition has no such module`,
        })
        continue
      }
      if (fieldId) {
        const moduleSpec = modulesById.get(moduleId)
        if (!(moduleSpec.fields ?? []).some((field) => field.id === fieldId)) {
          problems.push({
            type: 'missing-field',
            message: `Artefact "${artefact.id}" requires field "${requirement}", but module "${moduleId}" does not define it`,
          })
        }
      }
    }
  }

  for (const moduleSpec of modulesById.values()) {
    for (const field of moduleSpec.fields ?? []) {
      if (!['markdown', 'list', 'select', 'text', 'date'].includes(field.type)) {
        problems.push({
          type: 'unknown-field-type',
          message: `Module "${moduleSpec.id}" field "${field.id}" has unknown type "${field.type}" (expected "markdown", "list", "select", "text" or "date")`,
        })
      }
      if (field.required !== undefined && field.requiredAt !== undefined) {
        problems.push({
          type: 'mutually-exclusive-required',
          message: `Module "${moduleSpec.id}" field "${field.id}" sets both "required" and "required-at" — they are mutually exclusive`,
        })
      }
      if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) {
        problems.push({
          type: 'select-missing-options',
          message: `Module "${moduleSpec.id}" field "${field.id}" is type "select" but declares no "options:" list`,
        })
      }
      if (field.type === 'select' && field.default !== undefined && !(field.options ?? []).includes(field.default)) {
        problems.push({
          type: 'select-invalid-default',
          message: `Module "${moduleSpec.id}" field "${field.id}" has "default: ${field.default}" which is not in its own "options:" list`,
        })
      }
    }
  }

  const findFilenameField = (moduleId, fieldId) => modulesById.get(moduleId)?.fields?.find((field) => field.id === fieldId)
  for (const artefact of artefacts) {
    problems.push(...filenamePatternProblems(artefact, findFilenameField))
    // Port of lib/definition.js's documentControlProblem (#150, ADR-0049).
    const documentControl = artefact.documentControl
    if (documentControl !== undefined && typeof documentControl !== 'boolean') {
      problems.push({
        type: 'invalid-document-control',
        message: `Artefact "${artefact.id}" sets "document-control" to ${JSON.stringify(documentControl)} — it must be true or false`,
      })
    }
  }

  problems.push(...gateReferenceProblems(stages, artefacts, [...modulesById.values()]))
  // #152: shared with lib/definition.js rather than ported — see web/lib/readOnlyModules.js.
  problems.push(...readOnlyModuleProblems(stages))

  return problems
}

/** Client-side port of `lib/validate.js`'s `validateDefinition`, over `structure`. */
export function validateLocalDefinition(structure) {
  const problems = findLocalDefinitionProblems(structure)
  return { definition: structure.id, valid: problems.length === 0, problems }
}
