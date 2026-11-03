// #296 (parent #238, docs/adr/0063): **drafting ahead**. On an Azure DevOps or GitHub workspace a Stage moves on only when its Pull Request
// merges, so the AI interview carries on into the later Stages of its run while an earlier one awaits approval. Each later Stage's branch is
// stacked on the one before it (ADR-0014), and one rule keeps that safe: **shared Modules wait**. While a Stage is pending (the Instance has not
// moved past it), nothing is written to a Module that Stage also mounts, so the Owner's requested changes on the earlier Stage can never
// conflict with a later one. A drafted-ahead Stage gets a **head start** only: the Modules no pending Stage mounts.
//
// This file is that rule, with no DOM and no network, shared by the server (which enforces it on every Module write, lib/draftAheadGuard.js)
// and the Interview page (which tells the AI what is held, and when it has nothing draftable left).

const indexOf = (stages, id) => (stages ?? []).findIndex((s) => s.id === id)

// The Modules a Stage can edit: those it mounts that are not read-only there (a read-only Module is edited at the Stage that owns it).
const writable = (stage) => {
  const readOnly = new Set(stage?.readOnlyModules ?? [])
  return (stage?.modules ?? []).filter((id) => !readOnly.has(id))
}

/** Whether `stageId` is after the Instance's current Stage, so drafting it is drafting ahead. */
export function isDraftingAhead(stages, stageId, currentStageId) {
  const at = indexOf(stages, stageId)
  const current = indexOf(stages, currentStageId)
  return at !== -1 && current !== -1 && at > current
}

/** The Stages `stageId` waits on: from the Instance's current Stage up to the one before `stageId` (none unless `stageId` is ahead). */
export function pendingStagesBefore(stages, stageId, currentStageId) {
  if (!isDraftingAhead(stages, stageId, currentStageId)) return []
  return stages.slice(indexOf(stages, currentStageId), indexOf(stages, stageId))
}

/**
 * The Modules of `stageId` that are held: ones it can edit that a pending Stage can also edit. `[{ id, stageId, stageTitle }]`, where
 * `stageTitle` is the earliest pending Stage that mounts it, the one whose approval opens it.
 */
export function heldModules(stages, stageId, currentStageId) {
  const pending = pendingStagesBefore(stages, stageId, currentStageId)
  if (pending.length === 0) return []
  const stage = stages[indexOf(stages, stageId)]
  const held = []
  for (const id of writable(stage)) {
    const holder = pending.find((p) => writable(p).includes(id))
    if (holder) held.push({ id, stageId: holder.id, stageTitle: holder.title ?? holder.id })
  }
  return held
}

/**
 * The refusal the server gives a write that would put content in a held Module, or `null` when none of `moduleIds` is held. Names the Stage
 * whose approval opens each Module.
 */
export function heldModulesRefusal(stages, stage, currentStageId, moduleIds, moduleTitle = (id) => id) {
  const held = heldModules(stages, stage.id, currentStageId)
  const refused = held.filter((h) => moduleIds.includes(h.id))
  if (refused.length === 0) return null
  const named = refused.map((h) => `"${moduleTitle(h.id)}" (${h.id}) with Stage "${h.stageTitle}" (${h.stageId})`).join(', ')
  return `Stage "${stage.title ?? stage.id}" (${stage.id}) is being drafted ahead of the Instance's current Stage, so it gets a head start only: ${refused.length === 1 ? 'module' : 'modules'} ${named} cannot be written until ${refused.length === 1 ? 'that Stage is' : 'those Stages are'} approved and merged. Write the Modules only this Stage mounts, or Check status once the earlier Stage has merged.`
}

/**
 * `definition` as the AI is to see it while `stageId` is drafted ahead: the held Modules are read-only on that Stage (so nothing in scope, the
 * readiness check or the brief treats them as the AI's to write), and the Stage carries `heldModules` so the brief can say why. The same
 * object when nothing is held.
 */
export function withHeldModules(definition, stageId, held) {
  if (!held?.length) return definition
  return {
    ...definition,
    stages: (definition.stages ?? []).map((stage) =>
      stage.id === stageId ? { ...stage, readOnlyModules: [...new Set([...(stage.readOnlyModules ?? []), ...held.map((h) => h.id)])], heldModules: held } : stage
    ),
  }
}

/**
 * Whether the Pull Request recorded for `stageId` in an Instance record is still open (not completed or abandoned). The status is optional:
 * a record that has the Pull Request and no status for it counts as open.
 */
export function approvalIsOpen(record, stageId) {
  const id = record?.pullRequests?.[stageId]
  if (!id) return false
  const status = record?.pullRequestStatuses?.[stageId]
  return !status || status === 'active'
}
