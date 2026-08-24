import { createAzureDevOpsClient } from './azureDevOpsClient.js'
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
