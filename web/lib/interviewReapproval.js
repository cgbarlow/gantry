// #300 (parent #238, docs/adr/0069): the AI interview respects the re-approval of earlier stages. On an Azure DevOps or GitHub
// workspace an earlier Stage whose Pull Request merged is **approved**, and a Field one of its Artefacts prints is approved content:
// changing it sends that Stage back for approval with the current Stage's Pull Request (#275) and needs its documents re-rendered (#276).
// So the AI may change such a Field only through a card that says so. This file is the interview's side of that rule, with no DOM:
//   * which Fields are approved content, and by which Stage (`approvedPrintedFields`), so the session can hold a draft of one back;
//   * how the cards and the log word it (`reapprovalNames`);
//   * which earlier documents the stage-end Save will re-render before it asks for approval (`earlierDocumentsToRender`), so the card can say so;
//   * the run plan's "changed since approval" mark (`changedMark`).
// The server decides which Fields have *actually* changed (`GET /api/instance`'s `changedSinceApproval`); here "approved content" is every
// Field an approved earlier Stage prints, changed yet or not, because a change needs the card either way (a Field that was empty at approval
// is approved content too: filling it changes what the approved document says).
import { changedEntryFor } from './changedSinceApproval.js'

// `module` / `module.field` / `module.field?`: the same reading as lib/definition.js's splitArtefactRequirement.
function splitRequirement(requirement) {
  let ref = String(requirement)
  if (ref.endsWith('?')) ref = ref.slice(0, -1)
  const dot = ref.indexOf('.')
  return dot === -1 ? { moduleId: ref, fieldId: undefined } : { moduleId: ref.slice(0, dot), fieldId: ref.slice(dot + 1) }
}

const modulesOf = (definition) => (definition?.modules instanceof Map ? [...definition.modules.values()] : Array.isArray(definition?.modules) ? definition.modules : [])

/** The `module.field` keys one Artefact prints: a bare module entry in its `requires` prints all of that module's Fields, a `module.field` entry that one. */
export function printedKeysOfArtefact(definition, artefact) {
  const byId = new Map(modulesOf(definition).map((m) => [m.id, m]))
  const keys = new Set()
  for (const requirement of artefact?.requires ?? []) {
    const { moduleId, fieldId } = splitRequirement(requirement)
    const mod = byId.get(moduleId)
    if (!mod) continue
    if (fieldId) keys.add(`${moduleId}.${fieldId}`)
    else for (const field of mod.fields ?? []) keys.add(`${moduleId}.${field.id}`)
  }
  return keys
}

/** The `module.field` keys any Artefact at `stage`'s Gate prints (lib/changedSinceApproval.js `printedFields`). */
export function printedKeysOfStage(definition, stage) {
  const keys = new Set()
  for (const artefact of (definition?.artefacts ?? []).filter((a) => a.gate === stage.gate)) {
    for (const key of printedKeysOfArtefact(definition, artefact)) keys.add(key)
  }
  return keys
}

/**
 * The earlier Stages of `instance` that are approved, in order. A remote Instance's Stage is approved once its Pull Request merged, which is
 * what moved the Instance past it, so it is one before the Instance's current Stage (and before the Stage being interviewed) with a Pull
 * Request on file. A local or server workspace has no approvals and none are returned.
 */
export function approvedEarlierStages(instance) {
  if (!instance?.workspaceBacked) return []
  const stages = instance.stages ?? []
  const at = (id) => stages.findIndex((s) => s.id === id)
  const limit = Math.min(at(instance.stage?.id), at(instance.currentStageId ?? instance.stage?.id))
  if (limit <= 0) return []
  return stages.slice(0, limit).filter((s) => instance.pullRequests?.[s.id])
}

/**
 * The Fields that are approved content, as `{ 'module.field': [{ stageId, title }] }`: every Field a document of an approved earlier Stage
 * prints (also the ones the server already flags as changed since approval, whichever Stage the Definition says prints them). Empty on a
 * local or server workspace.
 */
export function approvedPrintedFields({ definition, instance }) {
  const approved = {}
  const add = (key, stage) => {
    const list = (approved[key] ??= [])
    if (!list.some((s) => s.stageId === stage.id)) list.push({ stageId: stage.id, title: stage.title ?? stage.id })
  }
  const defStage = (id) => (definition?.stages ?? []).find((s) => s.id === id)
  for (const stage of approvedEarlierStages(instance)) {
    const found = defStage(stage.id)
    if (!found) continue
    for (const key of printedKeysOfStage(definition, found)) add(key, { id: stage.id, title: stage.title ?? found.title })
  }
  for (const entry of instance?.changedSinceApproval ?? []) for (const key of entry.fields ?? []) add(key, { id: entry.stageId, title: entry.title })
  return approved
}

/** The Stages that approved `key`'s content, or `[]` when it is not approved content. */
export const reapprovalOf = (approved, key) => (approved && Object.hasOwn(approved, key) ? approved[key] : [])

/** `SOAP`, `SOAP and Business case`, `SOAP, HLD and Business case`. */
export function reapprovalNames(stages) {
  const names = (stages ?? []).map((s) => s.title ?? s.stageId)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** What the card for an approved Field says it does: the sentence ADR-0069 asks for. */
export const reapprovalSentence = (stages) => `Changing it changes approved content, so ${reapprovalNames(stages)} needs re-approval with this Stage.`

/**
 * The earlier documents the stage-end Save will re-render before it asks for approval: for each approved Stage that has Fields to
 * re-approve, the Artefacts at its Gate that print one of them. The Fields are those the server already flags (`changedSinceApproval`) and
 * those in the unsaved `draftKeys` that are approved content (only a card lets one into the drafts). Returns
 * `[{ stageId, stageTitle, artefactId, artefactTitle, fields, count }]` in Stage order, none when nothing is to be re-approved.
 */
export function earlierDocumentsToRender({ definition, instance, approved, draftKeys = [] }) {
  const involved = new Map()
  const note = (stageId, key) => {
    const set = involved.get(stageId) ?? new Set()
    set.add(key)
    involved.set(stageId, set)
  }
  for (const entry of instance?.changedSinceApproval ?? []) for (const key of entry.fields ?? []) note(entry.stageId, key)
  for (const key of draftKeys) for (const stage of reapprovalOf(approved, key)) note(stage.stageId, key)
  const out = []
  for (const stage of definition?.stages ?? []) {
    const fields = involved.get(stage.id)
    if (!fields) continue
    for (const artefact of (definition.artefacts ?? []).filter((a) => a.gate === stage.gate)) {
      const printed = printedKeysOfArtefact(definition, artefact)
      const hit = [...fields].filter((key) => printed.has(key))
      if (hit.length) out.push({ stageId: stage.id, stageTitle: stage.title ?? stage.id, artefactId: artefact.id, artefactTitle: artefact.title ?? artefact.id, fields: hit, count: hit.length })
    }
  }
  return out
}

/** The stage-end card's sentence about re-rendering: `Saving also re-renders Solution on a Page (SOAP) from the changed wording, then asks for approval of this Stage and SOAP together.` */
export function reRenderCardLine(documents) {
  if (!documents?.length) return null
  const titles = [...new Set(documents.map((d) => d.stageTitle))]
  const names = documents.map((d) => d.artefactTitle).join(', ')
  return `Saving also re-renders ${names} from the changed wording, then asks for approval of this Stage and ${reapprovalNames(titles.map((title) => ({ title })))} together.`
}

/** The run plan's mark for a Stage: `{ count, title }` when the server flags it as changed since approval, else `null`. */
export function changedMark(instance, stageId) {
  const entry = changedEntryFor(instance?.changedSinceApproval, stageId)
  return entry ? { count: entry.count, fields: entry.fields } : null
}
