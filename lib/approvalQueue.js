import { requestStageApproval } from './stageApproval.js'
import { readProviderDecisionsLog } from './providerDecisionsLog.js'
import { SOURCE_PROVIDER_KEYS } from './providerSourceDocuments.js'

// #295 (map #238, docs/adr/0063): **Approval queued**. A Stage that is ready while an earlier Stage's Pull Request is still open can't
// ask for approval yet: Request approval refuses a Stage that isn't the Instance's current one (#266), because approving it first
// would carry the earlier Stage's unapproved commits into `main`. The AI interview marks such a Stage `approval-queued` in the status
// block of its decisions log, saved on its own branch. The Pull Request is opened by the Check status that sees the earlier Stage
// merge, which calls `openQueuedApproval` for the Stage the Instance has just moved on to. Nothing polls (ADR-0014): the only
// trigger is the architect's own Check status click.

/** The state a queued Stage's status block carries. */
export const APPROVAL_QUEUED = 'approval-queued'

// The newest status entry of a log (the last session to Save), or null.
const newestStatus = (log) => (Array.isArray(log?.status) && log.status.length ? log.status[log.status.length - 1] : null)

/**
 * After a Check status merged a Stage and the Instance moved on to `stageId`: if that Stage was queued for approval, opens its Pull Request
 * now. `credentialOptions` is `{ azureDevOps | github: { ...location, pat } }` as the Check status route holds it.
 *
 * Resolves `null` when the Stage was not queued (or the Provider keeps no log), else `{ stage, opened: true, pullRequestId, webUrl }` or,
 * when the request was refused (the Gate no longer passes, a document can't be rendered), `{ stage, opened: false, error }`: the merge
 * that triggered this is never undone, and the Stage stays queued for the architect to request again.
 */
export async function openQueuedApproval(slug, credentialOptions, { definitionsDir, stageId } = {}) {
  const key = Object.keys(credentialOptions ?? {})[0]
  if (!stageId || !SOURCE_PROVIDER_KEYS.includes(key)) return null
  try {
    const { log } = await readProviderDecisionsLog({ [key]: credentialOptions[key] }, slug, stageId)
    if (newestStatus(log)?.state !== APPROVAL_QUEUED) return null
  } catch {
    return null
  }
  try {
    const opened = await requestStageApproval(slug, { ...credentialOptions, definitionsDir })
    return { stage: opened.stage ?? { id: stageId }, opened: true, pullRequestId: opened.pullRequestId, webUrl: opened.webUrl ?? null }
  } catch (err) {
    return { stage: { id: stageId }, opened: false, error: err.message }
  }
}
