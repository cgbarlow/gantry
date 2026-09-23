import { AuthenticationError, RequestError } from './providerErrors.js'
import { createAzureDevOpsClient, PROVIDER } from './azureDevOpsClient.js'
import { AZURE_DEVOPS_WORKSPACE_ROOT } from './instance.js'

/**
 * The per-stage branch name for a Workspace-backed instance (#122, ADR-0014) — `gantry-workspace/<slug>/<stageId>`, mirroring the existing `gantry-workspace/<slug>/` file-path prefix (`AZURE_DEVOPS_WORKSPACE_ROOT`, lib/instance.js) that already disambiguates one Azure DevOps repo ("workspace") hosting more than one instance. Deliberately deterministic — a pure function of `slug`/`stageId`, never looked up or persisted anywhere — so "which branch does stage X of instance Y use" never needs its own stored state: whether that branch actually exists yet is answered dynamically (see findStageBranch/resolveStageBranch below), not by reading some other record of it.
 */
export function stageBranchName(slug, stageId) {
  return `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/${stageId}`
}

/**
 * Read-only: reports `stageId`'s own branch name if work has already begun on it (the branch already exists), or `undefined` if nothing has ever been written for that stage yet — meaning a caller should read from `main` instead (the client's own default when no `branch` is given). Never creates anything: viewing an instance, checking a gate, or listing the dashboard must not itself start a stage's branch lifecycle — only an actual write does (see resolveStageBranch below). Safe to call for a stage that's already fully merged (whose branch was deleted on PR completion) too — that's indistinguishable here from "never started", and correctly falls back to reading `main`, which is exactly where that stage's approved content now lives.
 */
export async function findStageBranch(azureDevOps, slug, stageId) {
  const client = createAzureDevOpsClient(azureDevOps)
  const branch = stageBranchName(slug, stageId)
  return (await client.branchExists(branch)) ? branch : undefined
}

/**
 * WI256/#140: cheap advisory sync status for a stage branch vs main, scoped to
 * gantry-workspace/<slug>/. Never creates a branch — only compares when one
 * already exists (respects "opening the editor must not create a branch").
 * Returns `{ behind, behindFiles, ahead }` where `behind` = main has changes
 * under that subtree the stage branch doesn't contain.
 *
 * #140 fixed this reporting the stage branch's *own* edits as "behind": the
 * old implementation took "main has any commit absent from the branch" as
 * license to snapshot-diff *every* file under the scope on `main` against
 * the branch, with no merge base — every file the branch itself had edited
 * differed from `main` there too, so it was reported "behind" regardless of
 * which side actually changed it. This version asks Azure DevOps for the
 * merge-base-aware diff directly (`getCommitDiffs`, `diffCommonCommit: true`),
 * so `behindFiles` is exactly what `main` changed since the branch diverged
 * from it — never the branch's own commits — and `ahead`/`behind` come from
 * that same call's `aheadCount`/`behindCount`, not a second, differently-
 * directioned one (`syncStageBranch` below now shares the same call).
 */
export async function getStageSyncStatus(azureDevOps, slug, stageId) {
  const branch = await findStageBranch(azureDevOps, slug, stageId)
  if (!branch) return { behind: false, behindFiles: [], ahead: false }
  const client = createAzureDevOpsClient(azureDevOps)
  const diff = await getMainDiff(client, branch)
  // targetVersion is 'main' here, so aheadCount = commits main has that the
  // branch lacks (main is ahead = the branch is behind); behindCount = the
  // reverse (main is behind = the branch has its own commits = ahead).
  const mainHasNewCommits = diff.aheadCount > 0
  const ahead = diff.behindCount > 0
  let behindFiles = []
  if (mainHasNewCommits) {
    const scopePath = `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}`
    const scopePrefix = `/${scopePath}/`
    behindFiles = (diff.changes ?? [])
      .filter((change) => !change.item?.isFolder && change.item?.path && (change.item.path === `/${scopePath}` || change.item.path.startsWith(scopePrefix)))
      .map((change) => change.item.path)
    behindFiles.sort()
  }
  const behind = behindFiles.length > 0
  return { behind, behindFiles, ahead }
}

// Shared by getStageSyncStatus and syncStageBranch (#140's acceptance
// criterion that the advisory and the "Sync from main" action make the same
// ahead/behind decision): `baseVersion` is the stage branch, `targetVersion`
// is 'main', with `diffCommonCommit: true` so `changes` reflects what main
// changed since the merge base — the file list getStageSyncStatus reports,
// computed in the one call rather than a second round trip.
async function getMainDiff(client, branch) {
  return client.getCommitDiffs(branch, 'main', { diffCommonCommit: true })
}

/**
 * WI256/#140: sync `main` into the stage branch via real Azure DevOps primitives.
 * Fast-forward when the stage branch has no commits absent from main
 * (refs update), otherwise open a PR main→stage and auto-complete it.
 * On merge conflict the PR is left open and `{ conflict:true, pullRequestId, pullRequestUrl }` is returned.
 *
 * #140: the ahead/behind decision made here is the same `getCommitDiffs`
 * call (via `getMainDiff`) `getStageSyncStatus` above uses for its advisory
 * — this and the advisory must never disagree about which direction a stage
 * branch has diverged in.
 */
export async function syncStageBranch(azureDevOps, slug, stageId) {
  const branch = await findStageBranch(azureDevOps, slug, stageId)
  if (!branch) {
    throw new Error(`No stage branch for "${slug}" stage "${stageId}" — nothing to sync`)
  }
  const client = createAzureDevOpsClient(azureDevOps)
  const { createAzureDevOpsPullRequestsClient } = await import('./azureDevOpsPullRequestsClient.js')
  const prClient = createAzureDevOpsPullRequestsClient(azureDevOps)

  const diff = await getMainDiff(client, branch)
  const hasAhead = diff.behindCount > 0

  if (!hasAhead) {
    // Fast-forward: stage is ancestor of main, just move the ref
    const targetObjectId = await client.getBranchObjectId(branch)
    const sourceObjectId = await client.getBranchObjectId('main')
    if (targetObjectId === sourceObjectId) {
      return { branch, objectId: targetObjectId, fastForward: false, alreadyUpToDate: true }
    }
    // Use the same refs update path createBranch uses
    const baseUrl = azureDevOps.baseUrl ?? 'https://dev.azure.com'
    const apiVersion = '7.1'
    const repoUrl = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(azureDevOps.organization)}/${encodeURIComponent(azureDevOps.project)}/_apis/git/repositories/${encodeURIComponent(azureDevOps.repository)}`
    const url = new URL(`${repoUrl}/refs`)
    url.searchParams.set('api-version', apiVersion)
    let res
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`:${azureDevOps.pat}`, 'utf8').toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify([{ name: `refs/heads/${branch}`, oldObjectId: targetObjectId, newObjectId: sourceObjectId }]),
      })
    } catch (err) {
      throw new RequestError(`Network error fast-forwarding branch "${branch}": ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`Azure DevOps rejected the supplied PAT (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new RequestError(`Failed to fast-forward branch "${branch}": ${res.status} ${text}`, { provider: PROVIDER, status: res.status, body: text })
    }
    const { value = [] } = await res.json()
    const [update] = value
    if (!update?.success) {
      const reason = update?.customMessage ?? update?.updateStatus ?? 'unknown'
      throw new RequestError(`Azure DevOps rejected fast-forwarding "${branch}": ${reason}`, { provider: PROVIDER, body: update })
    }
    return { branch, objectId: sourceObjectId, fastForward: true }
  }

  // Divergent: PR-based sync
  const title = `Sync main into ${branch}`
  const description = `Automated sync of main into ${branch} (gantry stage-branch sync)`
  const pr = await prClient.createPullRequest({ sourceBranch: 'main', targetBranch: branch, title, description })
  const pullRequestId = pr.pullRequestId
  const pullRequestUrl = pr.url ?? `${azureDevOps.baseUrl ?? 'https://dev.azure.com'}/${encodeURIComponent(azureDevOps.organization)}/${encodeURIComponent(azureDevOps.project)}/_git/${encodeURIComponent(azureDevOps.repository)}/pullrequest/${pullRequestId}`

  try {
    const completed = await prClient.completePullRequest(pullRequestId, { mergeStrategy: 'noFastForward' })
    // Real ADO on conflict returns mergeStatus 'conflicts' even on 200; fake may throw 409
    if (completed && (completed.mergeStatus === 'conflicts' || completed.mergeStatus === 'conflict' || completed.status === 'active')) {
      // Treat as conflict — leave PR open
      return { branch, conflict: true, pullRequestId, pullRequestUrl, mergeStatus: completed.mergeStatus }
    }
    // Success: fetch new head
    const newHead = await client.getBranchObjectId(branch)
    return { branch, objectId: newHead, fastForward: false, pullRequestId, pullRequestUrl }
  } catch (err) {
    // Fake signals conflict as 409; real may also 409
    if (err.status === 409 || err.message?.includes('conflict') || err.body?.includes?.('conflict')) {
      return { branch, conflict: true, pullRequestId, pullRequestUrl }
    }
    throw err
  }
}

/**
 * The per-stage branch lifecycle ADR-0014 describes for a Workspace-backed instance: the moment an actual write touches `stageId`'s data, this ensures that stage's own branch exists — creating it if it doesn't — and returns its name for every read/write of this request (and every later request, once created) to target instead of `main`. Idempotent: a stage whose branch already exists (this request isn't the first write to touch it) just returns that name unchanged, without calling `createBranch` again.
 *
 * A freshly-created branch stacks on the immediately preceding stage's own branch when that branch still exists (i.e. that stage's own work is still open — not yet merged into `main`, per ADR-0014's "if an earlier stage's branch/PR is still open, the next stage's branch stacks on top of it") — otherwise (there's no preceding stage, or its branch has already merged/been deleted) it forks fresh from `main` instead. Branch existence itself is the only signal either decision needs — no separate "which stage's branch stacks on which" record is kept anywhere.
 *
 * `definition` (lib/definition.js's `loadDefinition` shape) supplies stage order — "immediately preceding" is simply `definition.stages[i - 1]` for `stageId`'s own index `i`. Throws if `stageId` isn't one of `definition`'s own stages, the same "caller's job to pass a real stage" contract every other stage-taking function in this codebase already has (lib/check.js's resolveCheckStage, lib/status.js's evaluateStage, etc.).
 */
export async function resolveStageBranch(azureDevOps, definition, slug, stageId) {
  const existing = await findStageBranch(azureDevOps, slug, stageId)
  if (existing) return existing

  const stageIndex = definition.stages.findIndex((s) => s.id === stageId)
  if (stageIndex === -1) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const client = createAzureDevOpsClient(azureDevOps)
  const branch = stageBranchName(slug, stageId)

  let from = 'main'
  if (stageIndex > 0) {
    const precedingStageId = definition.stages[stageIndex - 1].id
    const precedingBranch = stageBranchName(slug, precedingStageId)
    if (await client.branchExists(precedingBranch)) {
      from = precedingBranch
    }
  }

  await client.createBranch(branch, { from })
  return branch
}
