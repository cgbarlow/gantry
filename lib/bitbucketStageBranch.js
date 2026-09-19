import { createBitbucketClient } from './bitbucketClient.js'
import { stageBranchName } from './stageBranch.js'

/**
 * The Bitbucket twin of `lib/stageBranch.js` (#43, ADR-0037/0042 — Atlassian is a Provider at full
 * parity, stage branches included, identical semantics to Azure DevOps, GitHub and GitLab per
 * ADR-0042's "full capability parity ... is the v1 target"). `stageBranchName` itself is
 * provider-neutral — `gantry-workspace/<slug>/<stageId>` is exactly the same convention on Bitbucket
 * as on every other Provider (CONTEXT.md's **Stage branch** entry) — so it is re-exported here rather
 * than duplicated, mirroring `lib/gitlabStageBranch.js`'s own re-export.
 *
 * Everything else is genuinely per-provider (a different client, a different branch-existence check),
 * hence a sibling file rather than a shared generic implementation — mirrors this codebase's existing
 * convention of a `github*`/`gitlab*`/`bitbucket*` twin per Azure-DevOps-named module
 * (`githubClient.js`/`gitlabClient.js`/`bitbucketClient.js`) rather than branching one shared module on
 * provider. Named `bitbucket*`, not `atlassian*`, because stage branches are a content-store concept
 * (ADR-0042: Bitbucket Cloud is the content-store half of the Atlassian suite) — the same reasoning
 * `lib/bitbucketClient.js`'s own doc comment gives for its own `Bitbucket`-prefixed error classes even
 * though the *registered Provider* every one of its errors carries is `'atlassian'`.
 *
 * A completed stage's branch is recreated from current `main` on re-open (ADR-0026) by the same "fork
 * fresh from main when the preceding branch no longer exists" fallback `resolveBitbucketStageBranch`
 * already implements below for any stage whose predecessor has already merged — re-opening a signed-off
 * stage needs no separate code path here, only `lib/bitbucketClient.js`'s own `createBranch(name, {
 * from: 'main' })`, which a later re-open ticket (mirroring GitHub's #13 and GitLab's #33) calls
 * directly, the same way `lib/stageReopen.js`'s existing Azure DevOps/GitHub/GitLab paths do.
 */
export { stageBranchName }

/**
 * Read-only: reports `stageId`'s own branch name if work has already begun on it (the branch already
 * exists), or `undefined` if nothing has ever been written for that stage yet — meaning a caller
 * should read from `main` instead (the client's own default when no `branch` is given). Never creates
 * anything, same contract as `lib/stageBranch.js`'s `findStageBranch`.
 */
export async function findBitbucketStageBranch(bitbucket, slug, stageId) {
  const client = createBitbucketClient(bitbucket)
  const branch = stageBranchName(slug, stageId)
  return (await client.branchExists(branch)) ? branch : undefined
}

/**
 * The per-stage branch lifecycle (ADR-0014, mirrored onto Atlassian by ADR-0042's "full parity"
 * decision) for a Bitbucket-backed instance: the moment an actual write touches `stageId`'s data, this
 * ensures that stage's own branch exists — creating it if it doesn't — and returns its name. Idempotent:
 * a stage whose branch already exists just returns that name unchanged, never calling `createBranch`
 * again.
 *
 * A freshly-created branch stacks on the immediately preceding stage's own branch when that branch
 * still exists (that stage's own work is still open, not yet merged) — otherwise it forks fresh from
 * `main`. Branch existence itself is the only signal either decision needs, exactly as
 * `lib/stageBranch.js`'s `resolveStageBranch` already establishes for Azure DevOps.
 *
 * Throws if `stageId` isn't one of `definition`'s own stages.
 */
export async function resolveBitbucketStageBranch(bitbucket, definition, slug, stageId) {
  const existing = await findBitbucketStageBranch(bitbucket, slug, stageId)
  if (existing) return existing

  const stageIndex = definition.stages.findIndex((s) => s.id === stageId)
  if (stageIndex === -1) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const client = createBitbucketClient(bitbucket)
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
