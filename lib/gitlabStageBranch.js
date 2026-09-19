import { createGitLabClient } from './gitlabClient.js'
import { stageBranchName } from './stageBranch.js'

/**
 * The GitLab twin of `lib/stageBranch.js` (#29, ADR-0037/0041 — GitLab is a Provider at full parity,
 * stage branches included, identical semantics to Azure DevOps and GitHub per ADR-0041's "full
 * capability parity ... is the v1 target"). `stageBranchName` itself is provider-neutral —
 * `gantry-workspace/<slug>/<stageId>` is exactly the same convention on GitLab as on Azure DevOps and
 * GitHub (CONTEXT.md's **Stage branch** entry) — so it is re-exported here rather than duplicated,
 * mirroring `lib/githubStageBranch.js`'s own re-export.
 *
 * Everything else is genuinely per-provider (a different client, a different branch-existence check),
 * hence a sibling file rather than a shared generic implementation — mirrors this codebase's existing
 * convention of a `github*`/`gitlab*` twin per Azure-DevOps-named module (`githubClient.js`/
 * `gitlabClient.js`, `definitionGitHub.js`/`definitionGitLab.js`) rather than branching one shared
 * module on provider.
 *
 * A completed stage's branch is recreated from current `main` on re-open (ADR-0026) by the same
 * "fork fresh from main when the preceding branch no longer exists" fallback `resolveGitLabStageBranch`
 * already implements below for any stage whose predecessor has already merged — re-opening a signed-off
 * stage needs no separate code path here, only `lib/gitlabClient.js`'s own `createBranch(name, { from:
 * 'main' })` (already in place since #26), which the later re-open ticket (#33, mirroring GitHub's #13)
 * calls directly, the same way `lib/stageReopen.js`'s existing Azure DevOps/GitHub paths do.
 */
export { stageBranchName }

/**
 * Read-only: reports `stageId`'s own branch name if work has already begun on it (the branch already
 * exists), or `undefined` if nothing has ever been written for that stage yet — meaning a caller
 * should read from `main` instead (the client's own default when no `branch` is given). Never creates
 * anything, same contract as `lib/stageBranch.js`'s `findStageBranch`.
 */
export async function findGitLabStageBranch(gitlab, slug, stageId) {
  const client = createGitLabClient(gitlab)
  const branch = stageBranchName(slug, stageId)
  return (await client.branchExists(branch)) ? branch : undefined
}

/**
 * The per-stage branch lifecycle (ADR-0014, mirrored onto GitLab by ADR-0041's "full parity"
 * decision) for a GitLab-backed instance: the moment an actual write touches `stageId`'s data, this
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
export async function resolveGitLabStageBranch(gitlab, definition, slug, stageId) {
  const existing = await findGitLabStageBranch(gitlab, slug, stageId)
  if (existing) return existing

  const stageIndex = definition.stages.findIndex((s) => s.id === stageId)
  if (stageIndex === -1) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const client = createGitLabClient(gitlab)
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
