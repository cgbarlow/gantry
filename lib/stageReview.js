import { loadDefinition } from './definition.js'
import {
  readInstance,
  recordInstanceReviewRequest,
  recordInstanceReviewStatus,
  instanceDefinitionVersion } from './instance.js'
import { findStageBranch } from './stageBranch.js'
import {
  createAzureDevOpsWorkItemsClient,
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  isAzureDevOpsFieldNotFoundError,
} from './azureDevOpsWorkItemsClient.js'
import { createAzureDevOpsIdentityClient } from './azureDevOpsIdentityClient.js'
import { REVIEW_STATUS_FIELD, REVIEW_STATUS, inferReviewStatusFromNativeState } from './reviewStatus.js'

function reviewStage(definition, instance, stageId) {
  const stage = definition.stages.find((candidate) => candidate.id === (stageId ?? instance.stage))
  if (!stage) throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  return stage
}

async function stageContext(slug, options, stageId) {
  const azureDevOpsBase = options.azureDevOps
  if (!azureDevOpsBase) {
    throw new Error('Stage review actions are for Workspace-backed instances only — pass options.azureDevOps')
  }

  const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: options.definitionsDir ?? 'definitions', version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = reviewStage(definition, bootstrapInstance, stageId)
  const branch = azureDevOpsBase.branch ?? (await findStageBranch(azureDevOpsBase, slug, stage.id))
  const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
  const instance = branch ? await readInstance(slug, { azureDevOps }) : bootstrapInstance
  return { azureDevOps, definition, stage, instance }
}

function reviewWebUrl(azureDevOps, workItemId) {
  const base = azureDevOps.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(azureDevOps.organization)}/${encodeURIComponent(azureDevOps.project)}/_workitems/edit/${workItemId}`
}

/**
 * Creates one Task for one reviewer and relates it to the current stage's
 * existing child work item. No gate is checked: review is advisory and does
 * not change the sign-off lifecycle.
 */
export async function requestStageReview(slug, { reviewer, stageId, instanceUrl, requestedBy } = {}, options = {}) {
  const { azureDevOps, stage, instance } = await stageContext(slug, options, stageId)
  if (stage.id !== instance.stage) {
    throw new Error(`Review requests are only available for the instance's current stage ("${instance.stage}")`)
  }
  if (!reviewer || typeof reviewer !== 'string' || !reviewer.trim()) {
    throw new Error('A reviewer is required')
  }
  const relatedWorkItemId = instance.workItem?.stages?.[stage.id]
  if (!relatedWorkItemId) {
    throw new Error(`Instance "${slug}" has no linked work item for stage "${stage.id}"`)
  }

  const identityClient = createAzureDevOpsIdentityClient({
    organization: instance.workItem.organization,
    project: instance.workItem.project,
    baseUrl: instance.workItem.baseUrl,
    pat: azureDevOps.pat,
  })
  let resolvedReviewer
  try {
    resolvedReviewer = await identityClient.resolveIdentity(reviewer)
  } catch (err) {
    if (err instanceof AzureDevOpsAuthenticationError) err.operation = 'resolving the reviewer for Request Review'
    throw err
  }
  if (!resolvedReviewer) {
    throw new Error(`Reviewer "${reviewer}" could not be resolved to a known Azure DevOps identity`)
  }

  const client = createAzureDevOpsWorkItemsClient({
    organization: instance.workItem.organization,
    project: instance.workItem.project,
    baseUrl: instance.workItem.baseUrl,
    pat: azureDevOps.pat,
  })
  let requester = requestedBy?.trim() || ''
  if (!requester) {
    try {
      const currentUser = await client.getCurrentUser()
      requester = currentUser?.displayName || currentUser?.uniqueName || ''
    } catch (err) {
      // Connection data can be unavailable to a PAT limited to Work Items;
      // retain the legacy assignee fallback without blocking review creation.
      if (!(err instanceof AzureDevOpsNotFoundError || err instanceof AzureDevOpsAuthenticationError)) throw err
    }
  }
  requester ||= instance.assignee?.trim() || 'the current Gantry user'
  const baseFields = {
    'System.Title': `Review requested: ${stage.title} — ${slug}`,
    'System.AssignedTo': resolvedReviewer.uniqueName,
    'System.Tags': 'gantry',
    'System.Description':
      `Please review the "${stage.title}" stage of gantry instance "${slug}".\n\n` +
      `Requested by ${requester}.\n\n` +
      (instanceUrl ? `[Open the ${stage.title} stage in gantry](${instanceUrl})` : 'Open the stage in gantry to review the current content.'),
  }
  let created
  try {
    created = await client.createRelatedWorkItem(relatedWorkItemId, 'Task', {
      ...baseFields,
      // ADR-0024: additive alongside native System.State (left at the Task
      // type's default "New" above) — this is the field gantry itself reads
      // as the review's status going forward.
      [REVIEW_STATUS_FIELD]: REVIEW_STATUS.REQUESTED,
    })
  } catch (err) {
    // WI219: Custom.GantryReviewStatus was never provisioned on the real
    // process — creating with it fails TF51535. Retry without it and fall
    // back to native-state inference rather than breaking Request Review
    // entirely; other errors still propagate.
    if (!isAzureDevOpsFieldNotFoundError(err, REVIEW_STATUS_FIELD)) throw err
    created = await client.createRelatedWorkItem(relatedWorkItemId, 'Task', baseFields)
  }

  const review = {
    workItemId: created.id,
    reviewer: resolvedReviewer.uniqueName,
    reviewerDisplayName: resolvedReviewer.displayName,
    status:
      created.fields?.[REVIEW_STATUS_FIELD] ??
      (created.fields?.['System.State']
        ? inferReviewStatusFromNativeState(created.fields['System.State'])
        : REVIEW_STATUS.REQUESTED),
  }
  await recordInstanceReviewRequest(slug, stage.id, review, { azureDevOps })
  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    review,
    webUrl: reviewWebUrl(instance.workItem, created.id),
  }
}

/**
 * Re-reads one review Task's status on demand and caches that result on the
 * stage record. Reads ADR-0024's custom REVIEW_STATUS_FIELD as the source
 * of truth; a review Task created before that field existed falls back to
 * `inferReviewStatusFromNativeState` (Requested/In review inferred from
 * native `System.State`, no forced backfill migration). It never treats the
 * status as a gate decision.
 */
export async function checkStageReviewStatus(slug, { reviewId, stageId } = {}, options = {}) {
  if (!reviewId || !/^\d+$/.test(String(reviewId))) throw new Error('A valid review work item id is required')
  const { azureDevOps, stage, instance } = await stageContext(slug, options, stageId)
  const review = (instance.reviewRequests?.[stage.id] ?? []).find(
    (candidate) => Number(candidate.workItemId) === Number(reviewId)
  )
  if (!review) {
    throw new Error(`Instance "${slug}" has no review request for work item #${reviewId} on stage "${stage.id}"`)
  }
  const client = createAzureDevOpsWorkItemsClient({
    organization: instance.workItem.organization,
    project: instance.workItem.project,
    baseUrl: instance.workItem.baseUrl,
    pat: azureDevOps.pat,
  })
  let workItem
  try {
    workItem = await client.getWorkItem(review.workItemId, { fields: ['System.State', REVIEW_STATUS_FIELD] })
  } catch (err) {
    // WI219: reading Custom.GantryReviewStatus fails TF51535 when the field
    // was never provisioned — retry with System.State alone and infer via
    // inferReviewStatusFromNativeState rather than failing outright; other
    // errors still propagate.
    if (!isAzureDevOpsFieldNotFoundError(err, REVIEW_STATUS_FIELD)) throw err
    workItem = await client.getWorkItem(review.workItemId, { fields: ['System.State'] })
  }
  const status =
    workItem.fields?.[REVIEW_STATUS_FIELD] ??
    (workItem.fields?.['System.State']
      ? inferReviewStatusFromNativeState(workItem.fields['System.State'])
      : (review.status ?? 'Unknown'))
  await recordInstanceReviewStatus(slug, stage.id, review.workItemId, status, { azureDevOps })
  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    review: { ...review, status },
    webUrl: reviewWebUrl(instance.workItem, review.workItemId),
  }
}
