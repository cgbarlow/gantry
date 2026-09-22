import { loadDefinition } from './definition.js'
import { readInstance, recordInstanceWorkItemLink, recordSyncedFieldOverrides, instanceDefinitionVersion } from './instance.js'
import { findStageBranch, resolveStageBranch } from './stageBranch.js'
import { findGitHubStageBranch, resolveGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch, resolveGitLabStageBranch } from './gitlabStageBranch.js'
import { AuthenticationError, NotFoundError } from './providerErrors.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { interpretReviewerVotes } from './stageStatus.js'
import { reviewStatusFromVoteState } from './reviewStatus.js'
import { DEFAULT_WORK_ITEM_TYPE } from './workItemLink.js'

/**
 * The synced-fields panel's auto-populated title for a stage (#111): "{instance name} — {stage title}". The instance's name is its slug — the same identifier the dashboard, header and instance.yaml all use; an override recorded on the stage (see saveStageSyncedFieldOverrides below) replaces this, and clearing the override restores it.
 */
export function defaultSyncedTitle(slug, stageTitle) {
  return `${slug} — ${stageTitle}`
}

// #124: which Workspace-backed provider `options` names, and that provider's own
// find/resolve-stage-branch pair — the genuine N-way dispatch this module lacked before (it used to
// test only `options.azureDevOps`, falling through to a *local* read/write for a GitHub- or
// GitLab-backed instance whenever that test failed). `null` for a local instance (no
// azureDevOps/github/gitlab base supplied at all).
function syncedFieldsProvider(options) {
  if (options.azureDevOps) return { key: 'azureDevOps', base: options.azureDevOps, findBranch: findStageBranch, resolveBranch: resolveStageBranch }
  if (options.github) return { key: 'github', base: options.github, findBranch: findGitHubStageBranch, resolveBranch: resolveGitHubStageBranch }
  if (options.gitlab) return { key: 'gitlab', base: options.gitlab, findBranch: findGitLabStageBranch, resolveBranch: resolveGitLabStageBranch }
  return null
}

// The instance-data read options (local vs. Workspace-backed, any provider) implied by `options` — the same dual-backend convention every other module in lib/ follows, generalized (#124) from an Azure-DevOps-only test to every provider `syncedFieldsProvider` above recognizes.
function instanceReadOptions(options) {
  const provider = syncedFieldsProvider(options)
  return provider ? { [provider.key]: provider.base } : { instancesDir: options.instancesDir }
}

/**
 * Everything the instance screen's synced-fields panel (#111) shows for one stage: the work item type, the auto-populated (or overridden) title, the linked work item's own current state, the stage's Pull Request state, and the assignee (per-stage override or the inherited instance assignee).
 *
 * Resolves the viewed stage from `options.stageId`, falling back to the instance's persisted current stage. For a Workspace-backed instance (`options.azureDevOps`, `options.github` or `options.gitlab` given — #124's genuine per-provider dispatch, `syncedFieldsProvider` above), reads the viewed stage's own branch copy of instance.yaml when that branch exists — mirroring GET /api/instance's read rule exactly, since title/assignee overrides and open-Pull-Request ids live on that copy — falling back to `main` otherwise.
 *
 * The two Azure DevOps *reads* (the stage child work item's `System.State` via #121's getWorkItem, and the stage Pull Request's status/review votes via #120's getPullRequest + #125's vote interpretation) each need a PAT (`options.pat` or `options.azureDevOps.pat`); with no PAT they're skipped rather than attempted (workItemState/pullRequest stay null) so the route layer can decide credential policy itself. A not-found work item or Pull Request (a stale/deleted link) reads as null too rather than failing the whole panel — the panel is a display, and one broken link mustn't blank the other four fields; a rejected PAT still propagates as AuthenticationError so the server's credential-gating layer can respond with its structured "authentication required" shape. Both reads stay Azure-DevOps-only for now — the Pull Request read already gates on `options.azureDevOps` explicitly, and a GitHub/GitLab-backed instance simply reports `pullRequest: null`; wiring up their own work-item-state/PR reads is separate follow-on work, not #124's storage-location dispatch fix.
 *
 * Returns `{ slug, stage, linked, type, title, titleOverridden, workItemId, workItemState, pullRequest, assignee, assigneeInherited }` — `linked` false (and workItemId/workItemState null) for an instance with no parent work item at all, which is the panel's "show a Link to a work item prompt instead" case.
 */
export async function getStageSyncedFields(slug, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  let bootstrapInstance = await readInstance(slug, instanceReadOptions(options))
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stageId = options.stageId ?? bootstrapInstance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  // Same branch-aware read rule as GET /api/instance: the viewed stage's branch copy of instance.yaml
  // once work has begun on that stage, main otherwise — for whichever Workspace-backed provider (#124)
  // `options` actually names, not Azure DevOps only.
  let instance = bootstrapInstance
  const provider = syncedFieldsProvider(options)
  if (provider) {
    const branch = await provider.findBranch(provider.base, slug, stage.id)
    if (branch) {
      instance = await readInstance(slug, { [provider.key]: { ...provider.base, branch } })
    }
  }

  // Recovers a work item link recorded on some other stage's branch onto main (Azure DevOps only:
  // `recordInstanceWorkItemLink` has no GitLab twin at all, and this cross-branch recovery search was
  // never ported to GitHub either — left exactly as narrow as it already was; broadening it to every
  // provider is a separate ticket's job, not #124's storage-location dispatch fix).
  if (options.azureDevOps && !bootstrapInstance.workItem) {
    const checkedStages = new Set([stage.id])
    let workItem = instance.workItem
    for (const candidateStage of definition.stages) {
      if (workItem || checkedStages.has(candidateStage.id)) continue
      checkedStages.add(candidateStage.id)
      const candidateBranch = await findStageBranch(options.azureDevOps, slug, candidateStage.id)
      if (!candidateBranch) continue
      const candidateInstance = await readInstance(slug, {
        azureDevOps: { ...options.azureDevOps, branch: candidateBranch },
      })
      workItem = candidateInstance.workItem
    }
    if (workItem) {
      bootstrapInstance = { ...bootstrapInstance, workItem }
      instance = { ...instance, workItem }
      // #109 (docs/adr/0047): never persist this recovery with a credential this read resolved to
      // nothing but the workspace's shared, read-only-intended one — `sharedCache.cacheReads`
      // (lib/server.js's `sharedCacheContext`) is true exactly when that happened; see
      // lib/instance.js's `readIsSharedCredentialOnly`, which this mirrors, for the fuller
      // rationale. The recovered link is still reflected in this response either way (`instance`/
      // `bootstrapInstance` above are already updated) — only the write-back is skipped, deferred to
      // the next read that brings a real credential.
      if (!options.azureDevOps.sharedCache?.cacheReads) {
        await recordInstanceWorkItemLink(slug, workItem, { azureDevOps: options.azureDevOps, definitionsDir })
      }
    }
  }

  const overrides = instance.syncedFields?.[stage.id] ?? {}
  const workItem = instance.workItem ?? null
  const workItemId = workItem?.stages?.[stage.id] ?? null
  // The credential for the two Azure DevOps reads: an explicit `options.pat` (the local-instance route passes one), or the PAT already riding on `options.azureDevOps` (what withAzureDevOpsCredential hands the Workspace-backed route).
  const pat = options.pat ?? options.azureDevOps?.pat

  let workItemState = null
  if (workItem && workItemId && pat) {
    try {
      const client = createAzureDevOpsWorkItemsClient({
        organization: workItem.organization,
        project: workItem.project,
        pat,
        baseUrl: workItem.baseUrl,
      })
      const item = await client.getWorkItem(workItemId, { fields: ['System.State'] })
      workItemState = item.fields?.['System.State'] ?? null
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      if (!(err instanceof NotFoundError)) throw err
      // Stale/deleted link: reported as "no state", never fatal to the panel.
    }
  }

  let pullRequest = null
  const pullRequestId = instance.pullRequests?.[stage.id]
  if (pullRequestId && pat && options.azureDevOps) {
    try {
      const client = createAzureDevOpsPullRequestsClient({
        organization: options.azureDevOps.organization,
        project: options.azureDevOps.project,
        repository: options.azureDevOps.repository,
        pat,
        baseUrl: options.azureDevOps.baseUrl,
      })
      const pr = await client.getPullRequest(pullRequestId)
      const reviewState = interpretReviewerVotes(pr.reviewers)
      pullRequest = {
        id: pullRequestId,
        status: pr.status,
        reviewState,
        // ADR-0024: the same five-value review/sign-off status vocabulary,
        // mapped from `reviewState`.
        reviewStatus: reviewStatusFromVoteState(reviewState),
      }
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      if (!(err instanceof NotFoundError)) throw err
      // The recorded Pull Request no longer exists (completed-and-pruned, deleted manually): same treatment as a stale work-item link.
    }
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    linked: Boolean(workItem),
    type: workItem?.workItemType ?? DEFAULT_WORK_ITEM_TYPE,
    title: overrides.title ?? defaultSyncedTitle(slug, stage.title),
    titleOverridden: typeof overrides.title === 'string',
    workItemId,
    workItemState,
    pullRequest,
    assignee: overrides.assignee ?? instance.assignee ?? '',
    assigneeInherited: typeof overrides.assignee !== 'string',
  }
}

/**
 * Persists the synced-fields panel's per-stage overrides (#111) — `{ stageId?, title?, assignee? }` onto the instance record via `recordSyncedFieldOverrides` (lib/instance.js). For a Workspace-backed instance (any provider `syncedFieldsProvider` above recognizes — #124) the write targets whichever stage's branch is in progress via that provider's own `resolveStageBranch`/`resolveGitHubStageBranch`/`resolveGitLabStageBranch` (creating/stacking it if this is the first write to reach it), the same convention every other instance.yaml write on this codebase's server follows (#122); a local instance writes directly.
 *
 * An explicit empty string clears that override (title reverts to "{instance name} — {stage title}", assignee to the inherited instance assignee); an absent key leaves it untouched. Resolves/validates the stage against the instance's own definition exactly as `getStageSyncedFields` does, then returns that function's freshly-read payload — the caller's response is what the panel will show on its next load, not a client-side guess.
 */
export async function saveStageSyncedFieldOverrides(slug, updates, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const bootstrapInstance = await readInstance(slug, instanceReadOptions(options))
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stageId = updates.stageId ?? bootstrapInstance.stage
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  }

  const writeOptions = { ...instanceReadOptions(options), definitionsDir }
  const provider = syncedFieldsProvider(options)
  if (provider) {
    const branch = await provider.resolveBranch(provider.base, definition, slug, stage.id)
    writeOptions[provider.key] = { ...provider.base, branch }
  }

  await recordSyncedFieldOverrides(
    slug,
    stage.id,
    { title: updates.title, assignee: updates.assignee },
    writeOptions
  )

  return getStageSyncedFields(slug, { ...options, stageId: stage.id })
}
