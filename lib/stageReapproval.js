import { findChangedSinceApproval } from './changedSinceApproval.js'
import { completeInstanceReapprovals } from './instance.js'
import { AuthenticationError, NotFoundError } from './providerErrors.js'
import { reviewStatusFromVoteState } from './reviewStatus.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createGitHubPullRequestsClient } from './githubPullRequestsClient.js'
import { createGitLabPullRequestsClient } from './gitlabPullRequestsClient.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { createGitHubWorkItemsClient } from './githubWorkItemsClient.js'
import { createGitLabWorkItemsClient } from './gitlabWorkItemsClient.js'

// The later stage's Pull Request re-approves the earlier stage it changed (#275, docs/adr/0069).
//
// When a stage asks for approval and its content has changed Fields an earlier approved stage prints
// (lib/changedSinceApproval.js says which), that approval is also the earlier stage's: the Pull Request
// lists those Fields, the person who approved the earlier stage is added as an extra required reviewer,
// and Check status waits for their vote as well as everyone else's. When the Pull Request merges the
// earlier stage keeps its original approval and gains a re-approval entry (`reapprovals` in instance.yaml,
// see lib/instance.js), its linked work item gets a comment, and its "changed since approval" flag clears
// because its approved content is now what that merge commit says (lib/changedSinceApproval.js).
//
// Who is "the earlier stage's required reviewer"? Gantry keeps one required reviewer per Instance, not one
// per stage, so the reviewer a stage was approved by is read off that stage's own approval Pull Request:
// whoever voted to approve it. That is also the person the later stage's approval most needs to bring back
// in when the Instance's reviewer has changed since, and it needs nothing stored for an Instance approved
// before this rule existed.
//
// Remote workspaces only, and only the providers lib/changedSinceApproval.js can compare on (Azure DevOps,
// GitHub, GitLab): anything else finds nothing flagged and so nothing to re-approve.

const VOTE_APPROVED_WITH_SUGGESTIONS = 5

const keyOf = (id) => String(id).toLowerCase()

function latestActionableReviewByLogin(reviews) {
  const latest = new Map()
  for (const review of reviews ?? []) {
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') continue
    const login = review.user?.login ?? review.user
    const existing = latest.get(login)
    if (!existing || new Date(review.submitted_at) >= new Date(existing.submitted_at)) latest.set(login, review)
  }
  return latest
}

// What differs per provider: how to read who approved a (merged) Pull Request, whether a given person has
// approved an open one, how to ask a person to review it, and where a stage's linked work item lives.
const PROVIDERS = {
  azureDevOps: {
    pullRequests: createAzureDevOpsPullRequestsClient,
    approversOf: (pullRequest) =>
      (pullRequest.reviewers ?? [])
        .filter((reviewer) => (reviewer.vote ?? 0) >= VOTE_APPROVED_WITH_SUGGESTIONS)
        .map((reviewer) => ({ id: reviewer.id, displayName: reviewer.displayName ?? reviewer.id, uniqueName: reviewer.uniqueName ?? '' })),
    hasApproved: (pullRequest, key) =>
      (pullRequest.reviewers ?? []).some((reviewer) => keyOf(reviewer.id) === key && (reviewer.vote ?? 0) >= VOTE_APPROVED_WITH_SUGGESTIONS),
    reviewerArgument: (reviewer) => ({ id: reviewer.id, required: true }),
    workItem: {
      parentOf: (link) => link.parentId,
      comment: (link, pat, workItemId, text) =>
        createAzureDevOpsWorkItemsClient({ organization: link.organization, project: link.project, pat, baseUrl: link.baseUrl }).updateWorkItem(workItemId, {
          'System.History': text,
        }),
    },
  },
  github: {
    pullRequests: createGitHubPullRequestsClient,
    approversOf: (pullRequest) =>
      [...latestActionableReviewByLogin(pullRequest.reviews).entries()]
        .filter(([, review]) => review.state === 'APPROVED')
        .map(([login]) => ({ id: login, displayName: login, uniqueName: login })),
    hasApproved: (pullRequest, key) =>
      [...latestActionableReviewByLogin(pullRequest.reviews).entries()].some(([login, review]) => keyOf(login) === key && review.state === 'APPROVED'),
    reviewerArgument: (reviewer) => ({ login: reviewer.uniqueName || reviewer.id, required: true }),
    workItem: {
      parentOf: (link) => link.parentNumber,
      comment: (link, pat, workItemId, text) =>
        createGitHubWorkItemsClient({ owner: link.owner, repository: link.repository, pat, baseUrl: link.baseUrl }).addComment(workItemId, text),
    },
  },
  gitlab: {
    pullRequests: createGitLabPullRequestsClient,
    approversOf: (pullRequest) =>
      (pullRequest.approvals?.approved_by ?? [])
        .map((entry) => entry.user)
        .filter((user) => user && user.id !== undefined)
        .map((user) => ({ id: user.id, displayName: user.name ?? user.username ?? String(user.id), uniqueName: user.username ?? '' })),
    hasApproved: (pullRequest, key) => (pullRequest.approvals?.approved_by ?? []).some((entry) => keyOf(entry.user?.id) === key),
    reviewerArgument: (reviewer) => ({ id: reviewer.id, required: true }),
    workItem: {
      parentOf: (link) => link.parentIid,
      comment: (link, pat, workItemId, text) =>
        createGitLabWorkItemsClient({ namespace: link.namespace, repository: link.repository, pat, baseUrl: link.baseUrl }).addComment(workItemId, text),
    },
  },
}

function reviewerRecord(approver) {
  return { key: keyOf(approver.id), id: approver.id, displayName: approver.displayName, uniqueName: approver.uniqueName }
}

function fieldLabel(definition, reference) {
  const [moduleId, fieldId] = reference.split('.')
  const moduleSpec = definition.modules.get(moduleId)
  const field = moduleSpec?.fields.find((candidate) => candidate.id === fieldId)
  return field ? `${moduleSpec.title}: ${field.title}` : reference
}

/**
 * Whether approving `stage` also re-approves earlier stages, and who must sign those off. `instance` is the copy
 * read from `main` and `branch` the stage's own branch (what Request approval already holds). Returns
 *
 *   { stages: [{ stageId, title, fields: ['module.field', ...], fieldLabels: ['Module: Field', ...],
 *                pullRequestId, reviewers: [{ key, id, displayName, uniqueName }] }] }
 *
 * in stage order, `stages` empty when nothing is flagged (and always for a provider that can't compare). Each entry's
 * `reviewers` are the people who approved that stage's own Pull Request.
 */
export async function planReapproval({ providerKey, base, slug, definition, instance, branch }) {
  const provider = PROVIDERS[providerKey]
  if (!provider) return { stages: [] }
  const flagged = await findChangedSinceApproval({ providerKey, base, slug, definition, instance, currentBranch: branch ?? null })
  if (flagged.length === 0) return { stages: [] }

  const client = provider.pullRequests(base)
  const stages = []
  for (const entry of flagged) {
    let approvers = []
    try {
      approvers = provider.approversOf(await client.getPullRequest(entry.pullRequestId))
    } catch (err) {
      // A Pull Request the Provider no longer has names nobody; anything else (a network failure, a refused
      // credential) must not quietly drop a required reviewer, so it stops the request.
      if (!(err instanceof NotFoundError)) throw err
    }
    stages.push({
      stageId: entry.stageId,
      title: entry.title,
      fields: entry.fields,
      fieldLabels: entry.fields.map((reference) => fieldLabel(definition, reference)),
      pullRequestId: entry.pullRequestId,
      reviewers: approvers.map(reviewerRecord),
    })
  }
  return { stages }
}

/** The part of the Pull Request description that lists what this approval also re-approves. Empty when nothing does. */
export function reapprovalDescription(stages) {
  if (!stages.length) return ''
  const lines = stages.map((stage) => {
    const fields = stage.fieldLabels.map((label) => `  - ${label}`).join('\n')
    const who = stage.reviewers.length ? stage.reviewers.map((reviewer) => reviewer.displayName).join(', ') : 'its original reviewer'
    return `- **${stage.title}** (approved in Pull Request #${stage.pullRequestId}) has ${stage.fields.length === 1 ? 'a Field' : 'Fields'} changed since its approval, which ${who} must approve again:\n${fields}`
  })
  return `\n\nThis Pull Request also re-approves earlier stages. It changes Fields they print:\n\n${lines.join('\n')}`
}

/**
 * The Pull Request's own required reviewer (the Instance's override, else the workspace Owner) as a reviewer record, or
 * `null` when none is configured. `resolved` is what the Provider's identity lookup returned.
 */
export function primaryReviewerRecord(providerKey, resolved) {
  if (!resolved) return null
  // GitHub names people by login; the others by an id of their own.
  const id = providerKey === 'github' ? resolved.uniqueName : resolved.id
  return reviewerRecord({ id, displayName: resolved.displayName ?? String(id), uniqueName: resolved.uniqueName ?? '' })
}

/**
 * What Request approval records in instance.yaml for this Pull Request:
 * `{ [earlierStageId]: { title, fields, reviewers, primary, requestedAt } }`. `primary` is the Pull Request's own reviewer
 * (`primaryReviewerRecord`): with an earlier stage to re-approve, Check status waits for both votes, so it is recorded too.
 */
export function reapprovalRecord(stages, primary = null, now = new Date()) {
  const requestedAt = now.toISOString()
  return Object.fromEntries(
    stages.map((stage) => [
      stage.stageId,
      { title: stage.title, fields: stage.fields, reviewers: stage.reviewers, ...(primary ? { primary } : {}), requestedAt },
    ])
  )
}

/** The summary Request approval returns for the web UI and MCP: `[{ stageId, title, fields, count, reviewers: [{ displayName, uniqueName }] }]`. */
export function alsoReapproves(stages) {
  return stages.map((stage) => ({
    stageId: stage.stageId,
    title: stage.title,
    fields: stage.fields,
    count: stage.fields.length,
    reviewers: stage.reviewers.map(({ displayName, uniqueName }) => ({ displayName, uniqueName })),
  }))
}

/**
 * Asks the earlier stages' reviewers to review the Pull Request too, as required reviewers where the Provider has that
 * idea. The person already attached as the Pull Request's own reviewer (`primaryId`) isn't added twice. Whether a request
 * to review lands (GitHub, for one, refuses to ask the Pull Request's author) never decides the outcome: Gantry waits for
 * the vote itself in Check status, and the description names the person.
 */
export async function addReapprovers(providerKey, client, pullRequestId, stages, primaryId) {
  const provider = PROVIDERS[providerKey]
  const seen = new Set(primaryId === undefined || primaryId === null ? [] : [keyOf(primaryId)])
  const extras = []
  for (const stage of stages) {
    for (const reviewer of stage.reviewers) {
      if (seen.has(reviewer.key)) continue
      seen.add(reviewer.key)
      extras.push(reviewer)
    }
  }
  if (extras.length === 0) return
  try {
    await client.addReviewers(pullRequestId, extras.map(provider.reviewerArgument))
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
  }
}

/** Entries recorded for `stageId`'s Pull Request `pullRequestId` that haven't been completed by a merge: `[{ stageId (the earlier), by, ... }]`. */
export function pendingReapprovals(instance, stageId, pullRequestId) {
  const pending = []
  for (const [earlierId, entries] of Object.entries(instance?.reapprovals ?? {})) {
    for (const entry of entries) {
      if (entry.by === stageId && entry.pullRequestId === pullRequestId && !entry.approvedAt) pending.push({ stageId: earlierId, ...entry })
    }
  }
  return pending
}

/**
 * The people whose approval an open Pull Request still lacks because it re-approves earlier stages:
 * `{ waitingFor: [{ displayName, uniqueName, forStages: ['SOAP'] }] }`, empty when everyone has approved or the Pull Request
 * re-approves nothing. Someone who asked for changes isn't listed: that already reads as changes requested.
 */
export function reapprovalGate(providerKey, pullRequest, instance, stageId, pullRequestId) {
  const provider = PROVIDERS[providerKey]
  const waiting = new Map()
  if (provider) {
    for (const entry of pendingReapprovals(instance, stageId, pullRequestId)) {
      // Both votes: the Pull Request's own reviewer as well as each person who approved the earlier stage.
      for (const [reviewer, forStage] of [...(entry.primary ? [[entry.primary, null]] : []), ...(entry.reviewers ?? []).map((r) => [r, entry.title ?? entry.stageId])]) {
        if (provider.hasApproved(pullRequest, reviewer.key)) continue
        const known = waiting.get(reviewer.key) ?? { displayName: reviewer.displayName, uniqueName: reviewer.uniqueName, forStages: [] }
        if (forStage && !known.forStages.includes(forStage)) known.forStages.push(forStage)
        waiting.set(reviewer.key, known)
      }
    }
  }
  return { waitingFor: [...waiting.values()] }
}

/** `review` held at pending while `waitingFor` hasn't approved; unchanged when it's anything but approved or nobody is waited for. */
export function holdReviewForReapprovers(review, waitingFor) {
  if (!waitingFor.length || review?.state !== 'approved') return review
  return { ...review, state: 'pending', reviewStatus: reviewStatusFromVoteState('pending'), waitingFor }
}

/** The same hold applied to a Pull Request summary's embedded review (the panel shape). */
export function holdSummaryForReapprovers(summary, waitingFor) {
  return summary?.review ? { ...summary, review: holdReviewForReapprovers(summary.review, waitingFor) } : summary
}

/** The sentence Check status gives when the Pull Request waits for a re-approving reviewer. */
export function waitingForReapproversMessage(waitingFor) {
  const parts = waitingFor.map((person) =>
    person.forStages.length ? `${person.displayName} (their approval re-approves ${person.forStages.join(', ')})` : person.displayName
  )
  return `Waiting for ${parts.join('; ')} to approve before this Pull Request can merge.`
}

function commentText(slug, entry, byTitle, approvedAt) {
  const count = entry.fields.length
  const reviewers = (entry.reviewers ?? []).map((reviewer) => reviewer.displayName)
  return (
    `Stage '${entry.stageId}' (${entry.title ?? entry.stageId}) of instance '${slug}' was re-approved on ${approvedAt.slice(0, 10)}: ` +
    `stage '${entry.by}' (${byTitle}) changed ${count} ${count === 1 ? 'Field' : 'Fields'} it prints (${entry.fields.join(', ')}) ` +
    `and Pull Request #${entry.pullRequestId} approved them` +
    `${reviewers.length ? `, with ${reviewers.join(', ')}` : ''}.`
  )
}

/**
 * Called once a stage's Pull Request has merged. Stamps the re-approval entries that merge completed (on `main`, where the
 * merge put them), then comments on each re-approved stage's linked work item the way a re-open does. Each re-approval is
 * stamped and commented once: a repeated Check status finds nothing left to do and returns `null`. Never throws over a
 * failure after the merge — the merge and the stage advance it follows already happened — and reports it instead.
 *
 *   { reapprovals: [{ stageId, title, by, pullRequestId, fields, reviewers, requestedAt, approvedAt }],
 *     workItemSync: [{ ok, stageId, workItemId?, error? }] }
 */
export async function finishReapprovals({ providerKey, base, slug, definition, instance, stage, pullRequestId, now = new Date() }) {
  const provider = PROVIDERS[providerKey]
  if (!provider) return null
  const approvedAt = now.toISOString()
  let stamped
  try {
    stamped = await completeInstanceReapprovals(slug, stage.id, pullRequestId, approvedAt, { [providerKey]: base })
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    return { reapprovals: [], error: `Could not record the re-approval: ${err.message}`, workItemSync: [] }
  }
  if (stamped.length === 0) return null

  const link = instance?.workItem
  const workItemSync = []
  for (const entry of stamped) {
    if (!link) continue
    const workItemId = link.stages?.[entry.stageId] ?? provider.workItem.parentOf(link)
    if (!workItemId) continue
    try {
      await provider.workItem.comment(link, base.pat, workItemId, commentText(slug, entry, stage.title, approvedAt))
      workItemSync.push({ ok: true, stageId: entry.stageId, workItemId })
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      workItemSync.push({ ok: false, stageId: entry.stageId, workItemId, error: err.message })
    }
  }
  return { reapprovals: stamped, workItemSync }
}

/** The re-approval history of `stageId`, oldest first: when a later stage's merged Pull Request re-approved it. */
export function reapprovalHistory(instance, stageId, definition) {
  return (instance?.reapprovals?.[stageId] ?? [])
    .filter((entry) => entry.approvedAt)
    .map((entry) => ({
      by: entry.by,
      byTitle: definition?.stages.find((s) => s.id === entry.by)?.title ?? entry.by,
      pullRequestId: entry.pullRequestId,
      fields: entry.fields ?? [],
      reviewers: (entry.reviewers ?? []).map(({ displayName, uniqueName }) => ({ displayName, uniqueName })),
      requestedAt: entry.requestedAt ?? null,
      approvedAt: entry.approvedAt,
    }))
}

/** What the viewed stage's own open Pull Request also re-approves, from the copy of instance.yaml that Request approval wrote. */
export function pendingReapprovalSummary(instance, stageId) {
  const pullRequestId = instance?.pullRequests?.[stageId]
  if (!pullRequestId) return []
  return pendingReapprovals(instance, stageId, pullRequestId).map((entry) => ({
    stageId: entry.stageId,
    title: entry.title ?? entry.stageId,
    fields: entry.fields ?? [],
    count: (entry.fields ?? []).length,
    reviewers: (entry.reviewers ?? []).map(({ displayName, uniqueName }) => ({ displayName, uniqueName })),
  }))
}
