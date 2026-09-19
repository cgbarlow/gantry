import { loadDefinition } from './definition.js'
import {
  readInstance,
  recordInstanceReviewRequest,
  recordInstanceReviewStatus,
  instanceDefinitionVersion } from './instance.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { AuthenticationError, NotFoundError } from './providerErrors.js'
import { createAzureDevOpsWorkItemsClient, isAzureDevOpsFieldNotFoundError } from './azureDevOpsWorkItemsClient.js'
import { createAzureDevOpsIdentityClient } from './azureDevOpsIdentityClient.js'
import { createGitHubWorkItemsClient } from './githubWorkItemsClient.js'
import { createGitHubIdentityClient } from './githubIdentityClient.js'
import {
  REVIEW_STATUS_FIELD,
  REVIEW_STATUS,
  inferReviewStatusFromNativeState,
  allGitHubReviewLabels,
  reviewStatusToGitHubLabel,
  gitHubLabelToReviewStatus,
} from './reviewStatus.js'

function reviewStage(definition, instance, stageId) {
  const stage = definition.stages.find((candidate) => candidate.id === (stageId ?? instance.stage))
  if (!stage) throw new Error(`Definition "${definition.id}" has no stage "${stageId}"`)
  return stage
}

async function stageContext(slug, options, stageId) {
  const azureDevOpsBase = options.azureDevOps
  if (!azureDevOpsBase) {
    throw new Error('Stage review actions are for Workspace-backed instances only — pass options.azureDevOps or options.github')
  }

  const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: options.definitionsDir ?? 'definitions', version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = reviewStage(definition, bootstrapInstance, stageId)
  const branch = azureDevOpsBase.branch ?? (await findStageBranch(azureDevOpsBase, slug, stage.id))
  const azureDevOps = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
  const instance = branch ? await readInstance(slug, { azureDevOps }) : bootstrapInstance
  return { azureDevOps, definition, stage, instance }
}

// The GitHub twin of stageContext above (#15) — same shape, resolving a GitHub-backed instance's
// already-existing stage branch (never creating one: a review request is never the first write to
// touch a stage) instead of an Azure DevOps one.
async function githubStageContext(slug, options, stageId) {
  const githubBase = options.github
  const bootstrapInstance = await readInstance(slug, { github: githubBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir: options.definitionsDir ?? 'definitions', version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = reviewStage(definition, bootstrapInstance, stageId)
  const branch = githubBase.branch ?? (await findGitHubStageBranch(githubBase, slug, stage.id))
  const github = branch ? { ...githubBase, branch } : githubBase
  const instance = branch ? await readInstance(slug, { github }) : bootstrapInstance
  return { github, definition, stage, instance }
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
  if (options.github) {
    return requestStageReviewGitHub(slug, { reviewer, stageId, instanceUrl }, options)
  }
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
    if (err instanceof AuthenticationError) err.operation = 'resolving the reviewer for Request Review'
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
      if (!(err instanceof NotFoundError || err instanceof AuthenticationError)) throw err
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
  if (options.github) {
    return checkStageReviewStatusGitHub(slug, { reviewId, stageId }, options)
  }
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

/**
 * The GitHub twin of `requestStageReview` above (#15, docs/adr/0040): creates one issue per reviewer,
 * assigned to that reviewer, carrying the `gantry:review/requested` status label (created on demand —
 * `ensureLabelsExist` never assumes a repo has already been set up for this) and a "Related to #<n>"
 * reference to the stage's own linked issue in its body — GitHub's own cross-reference mechanism is
 * what makes that relationship visible from either issue's timeline, so no second write against the
 * stage issue is needed here.
 *
 * Mirrors every one of `requestStageReview`'s own preconditions (current stage only, a non-blank
 * reviewer, a linked work item for this stage) and adds one more GitHub has no Azure DevOps
 * equivalent for: a reviewer who resolves to a real GitHub identity but can't actually be assigned
 * (docs/adr/0040's person-picker access gate) is rejected here too, with the same guidance
 * `lib/githubIdentityClient.js` already attaches as `blockedReason` — never silently assigned anyway
 * only to have GitHub itself reject the request.
 */
async function requestStageReviewGitHub(slug, { reviewer, stageId, instanceUrl } = {}, options) {
  const { github, stage, instance } = await githubStageContext(slug, options, stageId)
  if (stage.id !== instance.stage) {
    throw new Error(`Review requests are only available for the instance's current stage ("${instance.stage}")`)
  }
  if (!reviewer || typeof reviewer !== 'string' || !reviewer.trim()) {
    throw new Error('A reviewer is required')
  }
  const relatedIssueNumber = instance.workItem?.stages?.[stage.id]
  if (!relatedIssueNumber) {
    throw new Error(`Instance "${slug}" has no linked work item for stage "${stage.id}"`)
  }

  const identityClient = createGitHubIdentityClient({
    owner: instance.workItem.owner,
    repository: instance.workItem.repository,
    baseUrl: instance.workItem.baseUrl,
    pat: github.pat,
  })
  let resolvedReviewer
  try {
    resolvedReviewer = await identityClient.resolveIdentity(reviewer)
  } catch (err) {
    if (err instanceof AuthenticationError) err.operation = 'resolving the reviewer for Request Review'
    throw err
  }
  if (!resolvedReviewer) {
    throw new Error(`Reviewer "${reviewer}" could not be resolved to a known GitHub identity`)
  }
  if (!resolvedReviewer.canAssign) {
    throw new Error(resolvedReviewer.blockedReason)
  }

  const client = createGitHubWorkItemsClient({
    owner: instance.workItem.owner,
    repository: instance.workItem.repository,
    baseUrl: instance.workItem.baseUrl,
    pat: github.pat,
  })
  await client.ensureLabelsExist(allGitHubReviewLabels())

  const created = await client.createIssue({
    title: `Review requested: ${stage.title} — ${slug}`,
    body:
      `Please review the "${stage.title}" stage of gantry instance "${slug}".\n\n` +
      `Related to #${relatedIssueNumber}.\n\n` +
      (instanceUrl ? `[Open the ${stage.title} stage in gantry](${instanceUrl})` : 'Open the stage in gantry to review the current content.'),
    assignees: [resolvedReviewer.uniqueName],
    labels: [reviewStatusToGitHubLabel(REVIEW_STATUS.REQUESTED)],
  })

  const review = {
    workItemId: created.number,
    reviewer: resolvedReviewer.uniqueName,
    reviewerDisplayName: resolvedReviewer.displayName,
    status: REVIEW_STATUS.REQUESTED,
  }
  await recordInstanceReviewRequest(slug, stage.id, review, { github })
  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    review,
    webUrl: created.html_url,
  }
}

/**
 * The GitHub twin of `checkStageReviewStatus` above (#15): re-reads the review issue's own current
 * `gantry:review/*` label on demand — never polling — and caches the result on the stage record
 * exactly like the Azure DevOps half does. A human is free to remove every gantry:review/* label (or
 * this issue could predate the feature entirely); `gitHubLabelToReviewStatus` returns `undefined` for
 * that case, which falls back to whatever status was already recorded rather than reporting a blank
 * or invented one.
 */
async function checkStageReviewStatusGitHub(slug, { reviewId, stageId } = {}, options) {
  const { github, stage, instance } = await githubStageContext(slug, options, stageId)
  const review = (instance.reviewRequests?.[stage.id] ?? []).find(
    (candidate) => Number(candidate.workItemId) === Number(reviewId)
  )
  if (!review) {
    throw new Error(`Instance "${slug}" has no review request for work item #${reviewId} on stage "${stage.id}"`)
  }
  const client = createGitHubWorkItemsClient({
    owner: instance.workItem.owner,
    repository: instance.workItem.repository,
    baseUrl: instance.workItem.baseUrl,
    pat: github.pat,
  })
  const issue = await client.getIssue(review.workItemId)
  const labelNames = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name))
  const status = gitHubLabelToReviewStatus(labelNames) ?? review.status ?? 'Unknown'

  await recordInstanceReviewStatus(slug, stage.id, review.workItemId, status, { github })
  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    review: { ...review, status },
    webUrl: issue.html_url,
  }
}
