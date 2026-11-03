/**
 * Approvals go in stage order (ADR-0063, #266). A stage branch can stack on an earlier stage's branch that is still
 * waiting for its own approval, so merging a later stage's Pull Request first would carry the earlier stage's
 * unapproved commits into `main` and pass its gate without its own sign-off. Request approval and Check status
 * therefore only act on the instance's **current stage on `main`** (`instance.stage`, as read without a branch).
 */

function stageSummary(stage) {
  return { id: stage.id, title: stage.title, gate: stage.gate }
}

function currentStageOf(definition, instance) {
  return definition.stages.find((s) => s.id === instance.stage) ?? { id: instance.stage, title: instance.stage }
}

/**
 * Throws (opening nothing) if `stage` isn't the instance's current stage on `main`. `instance` must be the copy read
 * from `main` (the `bootstrapInstance` both Request approval and Check status already read first), not a stage
 * branch's copy. The message names the current stage, and says whether `stage` is still ahead of it or already behind.
 */
export function assertStageIsCurrentForApproval(slug, definition, instance, stage) {
  if (stage.id === instance.stage) return
  const current = currentStageOf(definition, instance)
  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const currentIndex = definition.stages.findIndex((s) => s.id === instance.stage)
  const behind = stageIndex >= 0 && currentIndex >= 0 && stageIndex < currentIndex
  const currentLabel = `"${current.title}" (stage "${current.id}")`
  const reason = behind
    ? `stage "${stage.id}" is already behind the instance's current stage, ${currentLabel}`
    : `the instance's current stage is ${currentLabel}, and stages are approved in order — approve it first`
  throw new Error(`Cannot request approval for stage "${stage.id}" (gate "${stage.gate}") of instance "${slug}": ${reason}`)
}

/**
 * The Check status result for an approved Pull Request on a stage that isn't current: nothing was merged or advanced.
 * `review`/`pullRequest` are the same pieces the provider's own "not approved yet" result carries.
 */
export function waitingForEarlierStageResult({ slug, definition, instance, stage, pullRequestId, prStatus, review, pullRequest, approvalState = null }) {
  const current = currentStageOf(definition, instance)
  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const currentIndex = definition.stages.findIndex((s) => s.id === instance.stage)
  const behind = stageIndex >= 0 && currentIndex >= 0 && stageIndex < currentIndex
  return {
    slug,
    stage: stageSummary(stage),
    pullRequestId,
    prStatus,
    merged: false,
    review,
    pullRequest,
    approvalState,
    advancedTo: null,
    workItemSync: null,
    waitingForStage: stageSummary(current),
    message: behind
      ? `Stage "${stage.id}" is already behind the instance's current stage "${current.id}". Nothing was merged or advanced.`
      : `Stage "${stage.id}" is approved but waits for the earlier stage "${current.id}", the instance's current stage. ` +
        `Nothing was merged or advanced. Approve "${current.id}" first, then check this one again.`,
  }
}
