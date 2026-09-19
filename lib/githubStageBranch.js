import { createGitHubClient } from './githubClient.js'
import { stageBranchName } from './stageBranch.js'

/**
 * The GitHub twin of `lib/stageBranch.js` (#12, ADR-0037/0040 — GitHub is a Provider at full parity,
 * stage branches included). `stageBranchName` itself is provider-neutral — `gantry-workspace/<slug>/<stageId>`
 * is exactly the same convention on GitHub as on Azure DevOps (CONTEXT.md's **Stage branch** entry;
 * `lib/instance.js`'s `githubInstancePath`/`githubModulePath` already reuse the same
 * `gantry-workspace/<slug>/` file-path prefix for the identical reason) — so it is re-exported here
 * rather than duplicated.
 *
 * Everything else is genuinely per-provider (a different client, a different branch-existence check),
 * hence a sibling file rather than a shared generic implementation — mirrors this codebase's existing
 * convention of a `github*` twin per Azure-DevOps-named module (`githubClient.js`, `githubIdentityClient.js`,
 * `definitionGitHub.js`) rather than branching one shared module on provider.
 */
export { stageBranchName }

/**
 * Read-only: reports `stageId`'s own branch name if work has already begun on it (the branch already
 * exists), or `undefined` if nothing has ever been written for that stage yet — meaning a caller
 * should read from `main` instead (the client's own default when no `branch` is given). Never creates
 * anything, same contract as `lib/stageBranch.js`'s `findStageBranch`.
 */
export async function findGitHubStageBranch(github, slug, stageId) {
  const client = createGitHubClient(github)
  const branch = stageBranchName(slug, stageId)
  return (await client.branchExists(branch)) ? branch : undefined
}

/**
 * The per-stage branch lifecycle (ADR-0014, mirrored onto GitHub by ADR-0040's "full parity"
 * decision) for a GitHub-backed instance: the moment an actual write touches `stageId`'s data, this
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
export async function resolveGitHubStageBranch(github, definition, slug, stageId) {
  const existing = await findGitHubStageBranch(github, slug, stageId)
  if (existing) return existing

  const stageIndex = definition.stages.findIndex((s) => s.id === stageId)
  if (stageIndex === -1) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const client = createGitHubClient(github)
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
