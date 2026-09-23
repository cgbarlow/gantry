// #142: a Stage is "completed" once the instance has moved on past it — its own index in the
// Definition's stage order is earlier than the instance's persisted current Stage. `GET
// /api/instance` (lib/server.js) already made this exact "index, not id" comparison ad hoc, in more
// than one place, for a Workspace-backed instance's stale-branch reads (WI264) and its sync-status
// skip (WI262); centralised here so the write routes' refusal below — and anything else that needs
// to agree with the read side on what "completed" means — can't drift from it.
//
// Only a Workspace-backed instance (Azure DevOps, GitHub, GitLab) has anything to be "completed"
// against: a local instance has no `main` a Stage's own working copy could fall behind or ahead of,
// so callers never ask this for one.

/**
 * @param {{ id: string }[]} stages
 * @param {string} viewedStageId
 * @param {string} currentStageId
 * @returns {boolean}
 */
export function isCompletedStage(stages = [], viewedStageId, currentStageId) {
  const viewedIdx = stages.findIndex((s) => s.id === viewedStageId)
  const currentIdx = stages.findIndex((s) => s.id === currentStageId)
  return viewedIdx !== -1 && currentIdx !== -1 && viewedIdx < currentIdx
}

/**
 * The refusal a Workspace-backed module-write route (`PUT /api/instance/modules`,
 * `PUT /api/instance/modules/:id`) gives a save aimed at a completed Stage — checked, like #152's
 * `readOnlyWriteRefusal`, before any stage branch is resolved, so a refused save can never create or
 * stack that Stage's already-merged branch (the hazard #142 exists to close: a completed Stage's
 * branch, recreated from a stale `main`, later makes re-opening that Stage fail with "branch already
 * exists"). `null` when `stage` isn't completed relative to `currentStageId`. Re-open (docs/adr/0026)
 * is the only path back to editing a completed Stage — the message says so, matching the read side's
 * own completed-stage label.
 *
 * @param {{ id: string }[]} stages
 * @param {{ id: string, title?: string }} stage  the Stage being written
 * @param {string} currentStageId
 * @returns {string | null}
 */
export function completedStageRefusal(stages, stage, currentStageId) {
  if (!isCompletedStage(stages, stage.id, currentStageId)) return null
  return `Stage "${stage.title ?? stage.id}" (${stage.id}) is complete — it shows the approved version on main. Re-open it to make further edits.`
}
