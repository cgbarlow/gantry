// #286 (parent #238): "is this Stage ready to save?". The stage-end card shows when **Gantry's real Gate check** passes
// for the Artefact being aimed for. The check is the same code the editor's own status and Check use
// (web/lib/localStatus.js's `evaluateLocalStage`, a verbatim port of lib/status.js); here it runs over the Instance's
// saved content with the AI's unsaved drafts laid over it, because that is what a Save would write.
import { evaluateLocalStage } from './localStatus.js'

/**
 * `structure` is the Definition version projection (`modules`, `standardModules`, `stages`, `artefacts`); `modules` is the
 * Stage's Modules as the editor holds them (`GET /api/instance`'s shape: `[{ id, fields: [{ id, value }] }]`); `drafts` is
 * `{ 'module.field': { value } }`. Returns `{ pass, artefact: { id, title, outstanding } | null, outstanding, warnings }`.
 * `artefactId` is the Artefact aimed for; with none, the Gate's only candidate.
 */
export function draftGateCheck({ structure, stageId, artefactId, modules, drafts = {} }) {
  const stage = (structure?.stages ?? []).find((s) => s.id === stageId)
  if (!stage) return { pass: false, artefact: null, outstanding: [], warnings: [] }
  const moduleData = new Map()
  for (const moduleId of stage.modules) {
    const entry = (modules ?? []).find((m) => m.id === moduleId)
    const fields = {}
    for (const field of entry?.fields ?? []) if (!field.custom) fields[field.id] = field.value
    for (const [key, draft] of Object.entries(drafts)) {
      const dot = key.indexOf('.')
      if (key.slice(0, dot) === moduleId) fields[key.slice(dot + 1)] = draft.value
    }
    // A Module the Stage mounts counts as present: a Save writes the ones with drafts, and a Module with nothing in it can't satisfy a Field anyway.
    moduleData.set(moduleId, { exists: true, fields })
  }
  const result = evaluateLocalStage(structure, stage, moduleData)
  const candidates = result.artefacts.filter((a) => a.satisfiesGate)
  const aimed = artefactId ? result.artefacts.find((a) => a.id === artefactId) : candidates.length === 1 ? candidates[0] : undefined
  return {
    pass: Boolean(aimed && aimed.satisfiesGate && aimed.complete),
    artefact: aimed ? { id: aimed.id, title: aimed.title, outstanding: aimed.outstanding } : null,
    outstanding: aimed?.outstanding ?? [],
    warnings: result.warnings,
  }
}
