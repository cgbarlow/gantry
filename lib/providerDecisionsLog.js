import { AZURE_DEVOPS_WORKSPACE_ROOT } from './instance.js'
import { NotFoundError } from './providerErrors.js'
import { providerClient } from './reviews.js'
import { stageBranchName } from './stageBranch.js'
import { DecisionsLogError, applyDecisionsDelta, decisionsLogPath, parseDecisionsLog, serializeDecisionsLog } from '../web/lib/decisionsLog.js'

// #295 (map #238, docs/adr/0064 and 0063): a Stage's decisions log, `interview/<stageId>.yaml`, on an Azure DevOps or GitHub workspace.
// The file's shape, the append-only rule and the status block are web/lib/decisionsLog.js's, shared with every other workspace kind; this
// file is only where it lives on a Provider: on the Stage's own branch (stacked branches never touch each other's log, so drafting ahead
// cannot make two logs conflict), and in `main` once the Stage's Pull Request has merged and its branch is gone.
//
//   * A **read** never starts a branch: the Stage's branch when it has begun, else `main`.
//   * A **write** is one commit on the Stage's branch, started (stacked on the nearest earlier Stage's) only by a write that has something to commit.
//   * A stage Save carries its log in the same commit as the Modules (`planProviderDecisionsWrite`), so the log and the content land together.

const repoPath = (slug, relative) => `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/${relative}`

const isMissing = (err) => err instanceof NotFoundError || err?.name === 'NotFoundError' || err?.name === 'GitHubNotFoundError'

/** The stage id is part of a file name, so it has to be a plain id. */
function assertStageId(stageId) {
  if (typeof stageId !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(stageId)) throw new DecisionsLogError(`"${stageId}" is not a Stage id.`, { code: 'bad-request' })
}

/** The branch a read of `stageId`'s log uses: the Stage's own branch when it has begun, else `main`. */
export async function decisionsReadBranch(options, slug, stageId) {
  const { client } = providerClient(options)
  const branch = stageBranchName(slug, stageId)
  return (await client.branchExists(branch)) ? branch : 'main'
}

/** The Stage's committed log and the branch it was read from (an empty log when there is none). */
export async function readProviderDecisionsLog(options, slug, stageId) {
  assertStageId(stageId)
  const { client } = providerClient(options)
  const branch = await decisionsReadBranch(options, slug, stageId)
  let text = null
  try {
    text = await client.getFileContent(repoPath(slug, decisionsLogPath(stageId)), { branch })
  } catch (err) {
    if (!isMissing(err)) throw err
  }
  return { log: parseDecisionsLog(text, stageId), branch }
}

/**
 * Who last saved the Stage, as the Provider records it: the author of the newest commit on the Stage's branch (or `null` when the Stage
 * has no branch yet, or the Provider's client cannot say). A resuming session names them on its second-session card.
 */
export async function lastSavedOnBranch(options, slug, stageId) {
  const { client, key } = providerClient(options)
  const branch = stageBranchName(slug, stageId)
  try {
    if (key === 'github') {
      const head = await client.getBranchHeadCommit?.(branch)
      const by = head?.author?.name ?? head?.committer?.name ?? null
      return by ? { by, at: head.author?.date ?? head.committer?.date ?? null } : null
    }
    if (!(await client.branchExists(branch))) return null
    const [newest] = await client.listBranchCommits(branch, { compareTo: 'main', top: 1 })
    const by = newest?.author?.name ?? newest?.committer?.name ?? null
    return by ? { by, at: newest.author?.date ?? newest.committer?.date ?? newest.date ?? null } : null
  } catch {
    // Who saved is a courtesy on a card: a Provider that will not say leaves the card without a name.
    return null
  }
}

/**
 * The file a Save is to write for `delta` (`{ status?, fields?, entries? }`): the committed log with the delta applied, as
 * `{ path, text, log }` where `path` is relative to the Instance's folder (what `writeModules`'s `extraFiles` takes). Throws
 * `DecisionsLogError` when the delta would change or remove an entry already in the log. Nothing is written here.
 */
export async function planProviderDecisionsWrite(options, slug, stageId, delta) {
  const { log: before } = await readProviderDecisionsLog(options, slug, stageId)
  const after = applyDecisionsDelta(before, delta, stageId)
  return { path: decisionsLogPath(stageId), text: serializeDecisionsLog(after), log: after }
}

/**
 * A change to the log alone (a Pause, say): one commit on the Stage's branch. `resolveWriteBranch()` starts the branch if it has not begun
 * and returns its name. Returns the log after the change.
 */
export async function writeProviderDecisionsLog(options, slug, stageId, delta, { resolveWriteBranch, message } = {}) {
  const plan = await planProviderDecisionsWrite(options, slug, stageId, delta)
  const { client } = providerClient(options)
  const branch = await resolveWriteBranch()
  await client.writeFiles([{ path: repoPath(slug, plan.path), content: plan.text }], { branch, message: message ?? `Update the decisions log for ${stageId}` })
  return plan.log
}
