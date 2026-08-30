import { loadDefinition } from './definition.js'
import { readInstance, recordInstanceWorkItemLink, recordSyncedFieldOverrides, instanceDefinitionVersion } from './instance.js'
import { findStageBranch, resolveStageBranch } from './stageBranch.js'
import { createAzureDevOpsPullRequestsClient, AzureDevOpsNotFoundError as PrNotFoundError } from './azureDevOpsPullRequestsClient.js'
import {
  createAzureDevOpsWorkItemsClient,
  AzureDevOpsNotFoundError as WorkItemNotFoundError,
} from './azureDevOpsWorkItemsClient.js'
import { AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'
import { interpretReviewerVotes } from './stageStatus.js'
import { reviewStatusFromVoteState } from './reviewStatus.js'
import { DEFAULT_WORK_ITEM_TYPE } from './workItemLink.js'

export { AzureDevOpsAuthenticationError }

/**
 * The synced-fields panel's auto-populated title for a stage (#111): "{instance name} — {stage title}". The instance's name is its slug — the same identifier the dashboard, header and instance.yaml all use; an override recorded on the stage (see saveStageSyncedFieldOverrides below) replaces this, and clearing the override restores it.
 */
export function defaultSyncedTitle(slug, stageTitle) {
  return `${slug} — ${stageTitle}`
}

// The instance-data read options (local vs. Azure-DevOps-backed) implied by `options.azureDevOps` — the same dual-backend convention every other module in lib/ follows.
function instanceReadOptions(options) {
  return options.azureDevOps ? { azureDevOps: options.azureDevOps } : { instancesDir: options.instancesDir }
}

/**
 * Everything the instance screen's synced-fields panel (#111) shows for one stage: the work item type, the auto-populated (or overridden) title, the linked work item's own current state, the stage's Pull Request state, and the assignee (per-stage override or the inherited instance assignee).
 *
 * Resolves the viewed stage from `options.stageId`, falling back to the instance's persisted current stage. For a Workspace-backed instance (`options.azureDevOps` given), reads the viewed stage's own branch copy of instance.yaml when that branch exists — mirroring GET /api/instance's read rule exactly, since title/assignee overrides and open-Pull-Request ids live on that copy — falling back to `main` otherwise.
 *
 * The two Azure DevOps *reads* (the stage child work item's `System.State` via #121's getWorkItem, and the stage Pull Request's status/review votes via #120's getPullRequest + #125's vote interpretation) each need a PAT (`options.pat` or `options.azureDevOps.pat`); with no PAT they're skipped rather than attempted (workItemState/pullRequest stay null) so the route layer can decide credential policy itself. A not-found work item or Pull Request (a stale/deleted link) reads as null too rather than failing the whole panel — the panel is a display, and one broken link mustn't blank the other four fields; a rejected PAT still propagates as AzureDevOpsAuthenticationError so the server's credential-gating layer can respond with its structured "authentication required" shape.
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

  // Same branch-aware read rule as GET /api/instance: the viewed stage's branch copy of instance.yaml once work has begun on that stage, main otherwise.
  let instance = bootstrapInstance
  if (options.azureDevOps) {
    const checkedStages = new Set([stage.id])
    const branch = await findStageBranch(options.azureDevOps, slug, stage.id)
    if (branch) {
      instance = await readInstance(slug, { azureDevOps: { ...options.azureDevOps, branch } })
    }

    if (!bootstrapInstance.workItem) {
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
      if (err instanceof AzureDevOpsAuthenticationError) throw err
      if (!(err instanceof WorkItemNotFoundError)) throw err
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
      if (err instanceof AzureDevOpsAuthenticationError) throw err
      if (!(err instanceof PrNotFoundError)) throw err
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
 * Persists the synced-fields panel's per-stage overrides (#111) — `{ stageId?, title?, assignee? }` onto the instance record via `recordSyncedFieldOverrides` (lib/instance.js). For a Workspace-backed instance the write targets whichever stage's branch is in progress via `resolveStageBranch` (creating/stacking it if this is the first write to reach it), the same convention every other instance.yaml write on this codebase's server follows (#122); a local instance writes directly.
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
  if (options.azureDevOps) {
    const branch = await resolveStageBranch(options.azureDevOps, definition, slug, stage.id)
    writeOptions.azureDevOps = { ...options.azureDevOps, branch }
  }

  await recordSyncedFieldOverrides(
    slug,
    stage.id,
    { title: updates.title, assignee: updates.assignee },
    writeOptions
  )

  return getStageSyncedFields(slug, { ...options, stageId: stage.id })
}
