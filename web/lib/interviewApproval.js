// #295 (parent #238, docs/adr/0063): the AI interview on an Azure DevOps or GitHub workspace, where a Stage moves on only when its Pull
// Request merges. This is the part of the Interview page that is about approvals, with no DOM:
//   * what the Provider says about the current Stage (`openApproval`) and where its Pull Request is (`pullRequestLink`);
//   * the run plan's record of the Provider (`remoteRecord`), which overrides what the decisions log says;
//   * the sentence the page shows for the answer to a Check status (`approvalStatusLine`);
//   * who last saved a Stage, as a resuming session's card names them (`lastSavedBy`).
// Nothing here calls the Provider and nothing polls it (ADR-0014): the page runs Check status when the architect clicks an
// "awaiting approval" row or the Check status button, on each stage-end confirm that follows, and once when a session resumes.

/** Whether the Instance is on an Azure DevOps or GitHub workspace, the two the AI interview requests approval on. */
export const isRemoteInstance = (instance) => Boolean(instance?.workspaceBacked)

// The web address of a GitHub API address: github.com for api.github.com, and the Enterprise host without /api/v3 otherwise.
function githubWebBase(workspace) {
  const raw = (workspace.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  return raw === 'https://api.github.com' ? 'https://github.com' : raw.replace(/\/api\/v3$/i, '')
}

/** The web address of Pull Request `id` on this Instance's workspace, or null when it can't be built. */
export function pullRequestLink(instance, id) {
  const ws = instance?.workspace
  if (!ws || !id) return null
  if (ws.organization) {
    const base = ws.baseUrl ?? 'https://dev.azure.com'
    return `${base}/${encodeURIComponent(ws.organization)}/${encodeURIComponent(ws.project)}/_git/${encodeURIComponent(ws.repository)}/pullrequest/${id}`
  }
  if (ws.owner) return `${githubWebBase(ws)}/${encodeURIComponent(ws.owner)}/${encodeURIComponent(ws.repository)}/pull/${id}`
  return null
}

/**
 * The Pull Request open for the Instance's current Stage, as the Provider reports it: `{ id, url }`, or null when there is none. A Stage
 * the Instance has moved past has none (it merged), and one that is not the current Stage is never awaiting approval, only queued.
 */
export function openApproval(instance) {
  if (!isRemoteInstance(instance)) return null
  const id = instance.pullRequests?.[instance.stage?.id]
  if (!id || instance.stage.id !== instance.currentStageId) return null
  const status = instance.pullRequest?.status
  if (status && status !== 'active') return null
  return { id, url: pullRequestLink(instance, id) }
}

/**
 * The record of the Provider the run plan draws from: the Pull Request awaiting approval, by Stage, the later Stages the AI interview queued
 * for approval, and (#296) the later Stages that hold a saved head start. `logs` maps a Stage id to its committed decisions log. A Stage is
 * queued when its newest session line says so and the Provider has no Pull Request for it; the Provider's word overrides the log's.
 *
 * The page may be on a Stage ahead of the Instance's current one (the AI is drafting ahead). The Pull Request awaiting approval is then the
 * current Stage's, which this Stage's own branch carries the record of.
 */
export function remoteRecord({ instance, stages = [], logs = {} }) {
  const pullRequests = {}
  const viewed = instance?.stage?.id
  const current = instance?.currentStageId
  if (viewed && current && viewed !== current) {
    const id = instance.pullRequests?.[current]
    if (id) pullRequests[current] = { id, url: pullRequestLink(instance, id) }
  } else {
    const open = openApproval(instance)
    if (open) pullRequests[viewed] = open
  }
  const queued = {}
  const headStart = {}
  for (const stage of stages) {
    if (pullRequests[stage.id]) continue
    const status = logs[stage.id]?.status
    const newest = Array.isArray(status) && status.length ? status[status.length - 1].state : null
    if (newest === 'approval-queued' && !instance?.pullRequests?.[stage.id]) queued[stage.id] = true
    else if (newest === 'head-start' && stage.id !== current) headStart[stage.id] = true
  }
  return { pullRequests, queued, headStart }
}

const named = (id) => (id === undefined || id === null || id === '' ? '' : ` #${id}`)

/**
 * The sentence for the answer to a Check status (`POST /api/instance/check-status`), as the page shows it under the run plan. \`body\` is the
 * response; the Stage it is about is \`stageTitle\`. A merge says where the Instance went; anything else says why it has not.
 */
export function approvalStatusLine(body, stageTitle = 'this Stage') {
  const pr = `Pull Request${named(body?.pullRequestId)}`
  let line
  if (body?.merged) {
    line = body.advancedTo
      ? `Approved: ${pr} merged, and the Instance moved on to ${body.advancedTo.title}.`
      : `Approved: ${pr} merged. That was the final Stage, so the Instance is complete.`
  } else if (body?.waitingForStage) {
    line = body.message ?? `${stageTitle} waits for the earlier Stage "${body.waitingForStage.title}" to be approved first.`
  } else if (body?.review?.state === 'approved-then-invalidated') {
    line = `The approval was invalidated: commits landed after ${body.review.approver?.displayName ?? 'the Owner'} approved ${pr}. Request approval again for a fresh review.`
  } else if (body?.review?.state === 'rejected') {
    line = `Rejected: the Owner voted to reject ${pr}. The session stops here until you decide what to do.`
  } else if (body?.review?.state === 'changes-requested') {
    line = `Changes requested: the Owner sent ${pr} back for more work before approving.`
  } else if (Array.isArray(body?.waitingForReviewers) && body.waitingForReviewers.length) {
    line = `${pr} still needs ${body.waitingForReviewers.map((r) => r.displayName ?? r.login ?? r.name ?? 'a reviewer').join(', ')} to approve it too.`
  } else {
    line = `Still pending: the Owner has not reviewed ${pr} yet.`
  }
  const queuedLine = body?.queuedApproval
    ? body.queuedApproval.opened
      ? ` ${body.queuedApproval.stage?.title ?? 'The next Stage'} was queued for approval, so its Pull Request${named(body.queuedApproval.pullRequestId)} is open now.`
      : ` ${body.queuedApproval.stage?.title ?? 'The next Stage'} was queued for approval, but its Pull Request could not be opened: ${body.queuedApproval.error}`
    : ''
  return line + queuedLine
}

// Hidden on the log, so it is never serialised or compared: who last saved it, as the Provider records it.
const SAVED_BY = Symbol('lastSaved')

/** Remembers `lastSaved` (`{ by, at }`, the commit author) on a decisions log that was read, without making it part of the log. */
export function withLastSaved(log, lastSaved) {
  if (log && lastSaved && typeof lastSaved === 'object') Object.defineProperty(log, SAVED_BY, { value: lastSaved, enumerable: false })
  return log
}

/**
 * Who last saved the Stage, for the second-session card: `{ by, at }`, or null when nothing was ever saved. On a remote workspace it is
 * the commit author the Provider reports; otherwise (or when the Provider will not say) the name on the newest session line.
 */
export function lastSavedBy(log) {
  const status = Array.isArray(log?.status) && log.status.length ? log.status[log.status.length - 1] : null
  const provider = log?.[SAVED_BY] ?? null
  if (!provider && !status) return null
  return { by: provider?.by || status?.who || '', at: provider?.at || status?.lastAiSave || null }
}
