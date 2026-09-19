import { loadDefinition } from './definition.js'
import {
  readInstance,
  writeInstanceStage,
  recordInstanceApprovalState,
  recordInstancePullRequestStatus,
  clearInstanceReopened,
  instanceDefinitionVersion } from './instance.js'
import { resolveCheckStage } from './check.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch } from './gitlabStageBranch.js'
import { findBitbucketStageBranch } from './bitbucketStageBranch.js'
import { AuthenticationError, RequestError } from './providerErrors.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { createGitHubPullRequestsClient, interpretGitHubReviews } from './githubPullRequestsClient.js'
import { createGitHubWorkItemsClient } from './githubWorkItemsClient.js'
import { createGitLabPullRequestsClient, interpretGitLabMergeRequest } from './gitlabPullRequestsClient.js'
import { createGitLabWorkItemsClient } from './gitlabWorkItemsClient.js'
import { createBitbucketPullRequestsClient, interpretBitbucketPullRequest } from './bitbucketPullRequestsClient.js'
import { pickPassedState } from './workItemLink.js'
import { reviewStatusFromVoteState } from './reviewStatus.js'

// Azure DevOps's own signed reviewer-vote scale (lib/azureDevOpsPullRequestsClient.js's getPullRequest doc comment) — the only values this module ever has to interpret, since reading them is that client's job and acting on them is this one's (#125).
const VOTE_APPROVED = 10
const VOTE_APPROVED_WITH_SUGGESTIONS = 5
const VOTE_WAITING_FOR_AUTHOR = -5
const VOTE_REJECTED = -10

/**
 * Interprets a Pull Request's `reviewers` array (each entry's Azure DevOps
 * signed `vote`) into one of four review states — the "distinguish an
 * explicit decision from merely-still-pending" half of #125 (ADR-0014):
 *
 * - `'approved'` — at least one reviewer voted approved (or
 *   approved-with-suggestions, which Azure DevOps itself also counts as an
 *   approving vote for completion purposes), and nobody voted negatively.
 * - `'rejected'` — at least one reviewer voted rejected. Wins over any
 *   approving vote, mirroring Azure DevOps's own behaviour: a single
 *   rejection blocks completion no matter who else approved.
 * - `'changes-requested'` — nobody rejected outright but at least one
 *   reviewer voted waiting-for-author: an explicit "send this back" decision,
 *   which ADR-0014 explicitly wants surfaced as distinct from silence.
 * - `'pending'` — every recorded reviewer is still at no-vote, or there are
 *   no reviewers at all yet: no decision has been made by anyone.
 */
export function interpretReviewerVotes(reviewers) {
  const votes = (reviewers ?? []).map((r) => r.vote ?? 0)
  if (votes.some((v) => v <= VOTE_REJECTED)) return 'rejected'
  if (votes.some((v) => v === VOTE_WAITING_FOR_AUTHOR)) return 'changes-requested'
  if (votes.some((v) => v >= VOTE_APPROVED_WITH_SUGGESTIONS)) return 'approved'
  return 'pending'
}

function reviewerSummary(reviewers) {
  return (reviewers ?? []).map((r) => ({
    id: r.id,
    displayName: r.displayName ?? r.id,
    uniqueName: r.uniqueName,
    vote: r.vote ?? 0,
    voteUpdatedDate: r.voteUpdatedDate ?? null,
    // Azure DevOps's real reviewer field is `isRequired`, not `required`
    // (confirmed live against PR #22662 for WI199) — read that field name
    // here so the "required" flag this module reports is ever actually
    // populated from a real Pull Request's reviewers.
    required: r.isRequired === true,
  }))
}

function commitSummary(commits) {
  return (commits ?? []).map((commit) => ({
    commitId: commit.commitId,
    message: commit.comment ?? commit.message ?? '',
    timestamp: commit.committer?.date ?? commit.author?.date ?? commit.date ?? null,
  }))
}

function reviewSummary(reviewers, invalidated = false) {
  const summary = reviewerSummary(reviewers)
  const approver = summary.find((reviewer) => reviewer.vote >= VOTE_APPROVED_WITH_SUGGESTIONS) ?? summary.find((reviewer) => reviewer.required) ?? summary[0] ?? null
  const state = invalidated ? 'approved-then-invalidated' : interpretReviewerVotes(reviewers)
  return {
    state,
    // ADR-0024: the same five-value Requested/In review/Changes
    // requested/Approved/Rejected vocabulary review work items use,
    // mapped from this vote-derived `state` — one shared status language
    // for review and sign-off alike.
    reviewStatus: reviewStatusFromVoteState(state),
    reviewers: summary,
    approver,
  }
}

/**
 * The common PR payload used by the instance screen and Check status. Keeping
 * commits and reviewer identity together makes the panel useful before and
 * after an approval decision, including after a page reload.
 */
export function summarizePullRequest(pullRequest, commits = [], approvalState = null) {
  return {
    id: pullRequest.pullRequestId,
    status: pullRequest.status,
    commits: commitSummary(commits),
    review: reviewSummary(pullRequest.reviewers, approvalState?.state === 'invalidated'),
  }
}

// GitHub's own commit-list shape (`[{ sha, commit: { message, committer, author } }]`, #13's
// `getPullRequestCommits`) onto the same `{ commitId, message, timestamp }` shape `commitSummary`
// above produces for Azure DevOps — so a caller displaying the commit panel never has to branch on
// provider for the field names.
function githubCommitSummary(commits) {
  return (commits ?? []).map((c) => ({
    commitId: c.sha,
    message: c.commit?.message ?? '',
    timestamp: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
  }))
}

/**
 * GitHub's twin of `reviewSummary` above (#13, docs/adr/0040): turns a pull request's raw GitHub
 * reviews into the same `{ state, reviewStatus, reviewers, approver }` shape, via
 * `interpretGitHubReviews` (lib/githubPullRequestsClient.js) for the state itself — COMMENTED and
 * DISMISSED already read as `'pending'` there, per ADR-0040's "still pending, not a verdict".
 * `reviewers` mirrors each GitHub review's own login/state/timestamp rather than Azure DevOps's
 * numeric vote, since GitHub has no equivalent scale.
 */
function githubReviewSummary(reviews) {
  const state = interpretGitHubReviews(reviews)
  const reviewers = (reviews ?? []).map((r) => ({
    login: r.user?.login ?? r.user,
    state: r.state,
    submittedAt: r.submitted_at ?? null,
  }))
  const approver = reviewers.find((r) => r.state === 'APPROVED') ?? reviewers[0] ?? null
  return {
    state,
    reviewStatus: reviewStatusFromVoteState(state),
    reviewers,
    approver,
  }
}

/** GitHub's twin of `summarizePullRequest` above — same `{ id, status, commits, review }` panel shape, over a GitHub pull request's own `{ pullRequestId, status, reviews }` and raw commit list. Exported (unlike the Azure DevOps path's own private helper) because `lib/stageApproval.js`'s `requestGitHubStageApproval` needs the identical panel shape right after opening a Pull Request, not just this module's own Check status path. */
export function summarizeGitHubPullRequest(pullRequest, commits = []) {
  return {
    id: pullRequest.pullRequestId,
    status: pullRequest.status,
    commits: githubCommitSummary(commits),
    review: githubReviewSummary(pullRequest.reviews),
  }
}

/**
 * The Owner-side half of ADR-0014's stage-approval flow (#125): the
 * explicitly-triggered "Check status" action on a Workspace-backed instance's
 * stage — reads that stage's open Pull Request's reviewer votes straight from
 * Azure DevOps and reports what the Owner has actually decided, never
 * polling or guessing (ADR-0014 keeps detection manual, exactly like
 * ADR-0012 did for work-item states). On detecting approval it doesn't stop
 * at reporting: gantry completes (merges) the Pull Request itself, advances
 * the instance's own stage pointer to the definition's next stage, and —
 * where the instance is linked to Azure DevOps work items (#99/#103) —
 * pushes the completed stage's work item to its type's gate-passed state
 * (`pickPassedState`), so one click resolves the whole flow. The PR is the
 * real gate now; the work item is board-visible tracking whose state merge
 * still updates, nothing more (ADR-0014).
 *
 * Resolves the stage to check the same way `requestStageApproval` does —
 * `options.gate` if given, falling back to the instance's current stage —
 * and reads the Pull Request id previously recorded by that action
 * (`instance.pullRequests[stageId]`, lib/instance.js). Throws (checking
 * nothing) if there is no such Pull Request yet — checking status before
 * approval has even been requested is a caller error, not a pending review.
 *
 * Idempotent against a re-click after success: an already-`completed` (or
 * `abandoned`) Pull Request is reported as-is without attempting a second
 * completion, a second stage advance, or a second work-item push — those
 * happened on the first check, and Azure DevOps would reject the duplicate.
 *
 * Workspace-backed instances only — `options.azureDevOps`
 * (`{ organization, project, repository, pat, baseUrl? }`) is required;
 * a local instance has no Pull Request to check (its advancement is
 * lib/stageAdvancement.js's self-serve action).
 *
 * Returns `{ slug, stage, pullRequestId, prStatus, merged, review,
 * advancedTo, workItemSync }`:
 * - `prStatus` — the Pull Request's raw Azure DevOps status as of this check
 *   (`'active'`, or `'completed'` once this very call has merged it);
 * - `merged` — whether the stage's Pull Request is now (or already was)
 *   completed;
 * - `review` — `{ state, reviewers, approver }`, state from
 *   `interpretReviewerVotes` or `'approved-then-invalidated'`;
 * - `pullRequest` — `{ id, status, commits, review }`, the complete panel
 *   summary;
 * - `approvalState` — the persisted invalidation record, or `null`;
 * - `advancedTo` — the next stage advanced to, `null` when nothing advanced
 *   (not merged, already-completed short-circuit, or final stage);
 * - `workItemSync` — `null` when the instance has no linked work item for
 *   this stage; otherwise `{ ok: true, workItemId, state }` or
 *   `{ ok: false, error }` — a failed board-side push never rolls back the
 *   merge or the advance it reports alongside.
 */
export async function checkStageApprovalStatus(slug, options = {}) {
  if (options.github) {
    return checkGitHubStageApprovalStatus(slug, options)
  }
  if (options.gitlab) {
    return checkGitLabStageApprovalStatus(slug, options)
  }
  if (options.atlassian) {
    return checkBitbucketStageApprovalStatus(slug, options)
  }
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const azureDevOpsBase = options.azureDevOps
  if (!azureDevOpsBase) {
    throw new Error('checkStageApprovalStatus is for Workspace-backed instances only — pass options.azureDevOps or options.github')
  }

  const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate: options.gate })

  // `requestStageApproval` recorded the Pull Request id on the stage's own
  // branch's copy of instance.yaml (#124 wrote it through the branch-scoped
  // client, and #122 puts every stage write there) — so read the same copy
  // the instance screen itself shows (branch if it exists, main otherwise,
  // mirroring GET /api/instance), never main alone.
  const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
  const azureDevOpsForStage = branch ? { ...azureDevOpsBase, branch } : azureDevOpsBase
  const instance = branch ? await readInstance(slug, { azureDevOps: azureDevOpsForStage }) : bootstrapInstance

  const pullRequestId = instance.pullRequests?.[stage.id]
  if (!pullRequestId) {
    throw new Error(
      `Instance "${slug}" has no Pull Request open requesting approval for stage "${stage.id}" — ` +
        'request approval first; there is no status to check before that'
    )
  }

  const client = createAzureDevOpsPullRequestsClient(azureDevOpsBase)
  const pullRequest = await client.getPullRequest(pullRequestId)
  const commits = await client.getPullRequestCommits(pullRequestId)
  const persistedApprovalState = instance.approvalStates?.[stage.id] ?? null

  if (instance.pullRequestStatuses?.[stage.id] !== pullRequest.status) {
    await recordInstancePullRequestStatus(slug, stage.id, pullRequest.status, { azureDevOps: azureDevOpsForStage })
  }

  const baseReview = reviewSummary(pullRequest.reviewers)
  const newestCommitAt = commits
    .map((commit) => commit.committer?.date ?? commit.author?.date ?? commit.date)
    .filter(Boolean)
    .sort()
    .at(-1)
  const approvedReviewer = (pullRequest.reviewers ?? []).find(
    (reviewer) =>
      (reviewer.vote ?? 0) >= VOTE_APPROVED_WITH_SUGGESTIONS &&
      reviewer.voteUpdatedDate &&
      newestCommitAt &&
      new Date(newestCommitAt) > new Date(reviewer.voteUpdatedDate)
  )
  const approvalInvalidated = Boolean(approvedReviewer)
  const approvalState = approvalInvalidated
    ? {
        state: 'invalidated',
        reviewerId: approvedReviewer.id,
        reviewerDisplayName: approvedReviewer.displayName ?? approvedReviewer.id,
        approvedAt: approvedReviewer.voteUpdatedDate,
        latestCommitAt: newestCommitAt,
      }
    : persistedApprovalState && baseReview.state === 'approved'
      ? persistedApprovalState
      : null
  const review = reviewSummary(pullRequest.reviewers, approvalState?.state === 'invalidated')
  const pullRequestSummary = summarizePullRequest(pullRequest, commits, approvalState)

  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const nextStage = stageIndex >= 0 ? definition.stages[stageIndex + 1] ?? null : null
  const isAtPersistedStage = bootstrapInstance.stage === stage.id
  const workItemId = instance.workItem?.stages?.[stage.id]

  if (approvalInvalidated && persistedApprovalState?.state !== 'invalidated') {
    await recordInstanceApprovalState(slug, stage.id, approvalState, { azureDevOps: azureDevOpsForStage })
  }

  // Already resolved elsewhere (a re-click after this same action succeeded,
  // or the Owner completed/rejected the PR manually in Azure DevOps): report
  // faithfully, act never — completion, advancement and the work-item push
  // each happened once already, and repeating any of them would either fail
  // outright (Azure DevOps rejects completing an already-completed PR) or
  // double-write gantry's own records.
  if (pullRequest.status !== 'active') {
    let advancedTo = null
    let workItemSync = null

    if (pullRequest.status === 'completed' && isAtPersistedStage) {
      if (nextStage) {
        await writeInstanceStage(slug, nextStage.id, { azureDevOps: azureDevOpsBase })
        advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
      }
      // WI265: clear re-opened marker for the stage that just completed (no-op if none)
      try {
        await clearInstanceReopened(slug, stage.id, { azureDevOps: azureDevOpsBase })
      } catch (_) {}

      if (workItemId) {
        try {
          const workItemsClient = createAzureDevOpsWorkItemsClient({
            organization: instance.workItem.organization,
            project: instance.workItem.project,
            pat: azureDevOpsBase.pat,
            baseUrl: instance.workItem.baseUrl,
          })
          const states = await workItemsClient.getWorkItemTypeStates(instance.workItem.workItemType)
          const state = pickPassedState(states)
          await workItemsClient.updateWorkItem(workItemId, { 'System.State': state })
          workItemSync = { ok: true, workItemId, state }
        } catch (err) {
          if (err instanceof AuthenticationError) throw err
          workItemSync = { ok: false, workItemId, error: err.message }
        }
      }
    }

    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: pullRequest.status === 'completed',
      review,
      pullRequest: pullRequest.status === 'completed' ? { ...pullRequestSummary, status: 'completed' } : pullRequestSummary,
      approvalState: pullRequest.status === 'completed' ? null : approvalState,
      advancedTo,
      workItemSync,
    }
  }

  if (review.state !== 'approved') {
    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: false,
      review,
      pullRequest: pullRequestSummary,
      approvalState,
      advancedTo: null,
      workItemSync: null,
    }
  }

  await client.completePullRequest(pullRequestId, {
    mergeCommitMessage: `Merge stage "${stage.title}" of gantry instance "${slug}" (gate "${stage.gate}", approved via Pull Request #${pullRequestId})`,
  })

  await recordInstancePullRequestStatus(slug, stage.id, 'completed', { azureDevOps: azureDevOpsForStage })

  let advancedTo = null
  if (nextStage) {
    // Written to `main` (writeInstanceStage's Azure DevOps path targets no
    // stage branch deliberately): the just-completed merge put this stage's
    // approved content on main, so main is where "the instance now sits at
    // the next stage" belongs. Any later stage branch that already stacked
    // on this one keeps its own instance.yaml copy untouched — out of scope
    // here, matching #122's per-branch record model.
    await writeInstanceStage(slug, nextStage.id, { azureDevOps: azureDevOpsBase })
    advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
  }
  // WI265: clear re-opened marker for the stage that just completed (no-op if none)
  try {
    await clearInstanceReopened(slug, stage.id, { azureDevOps: azureDevOpsBase })
  } catch (_) {}

  let workItemSync = null
  if (workItemId) {
    try {
      const workItemsClient = createAzureDevOpsWorkItemsClient({
        organization: instance.workItem.organization,
        project: instance.workItem.project,
        pat: azureDevOpsBase.pat,
        baseUrl: instance.workItem.baseUrl,
      })
      const states = await workItemsClient.getWorkItemTypeStates(instance.workItem.workItemType)
      const state = pickPassedState(states)
      await workItemsClient.updateWorkItem(workItemId, { 'System.State': state })
      workItemSync = { ok: true, workItemId, state }
    } catch (err) {
      if (err instanceof AuthenticationError) throw err
      // Board-side tracking only (ADR-0014): a failed push must not undo the
      // merge or the advance this response already records — surface it.
      workItemSync = { ok: false, workItemId, error: err.message }
    }
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    pullRequestId,
    prStatus: 'completed',
    merged: true,
    review,
    pullRequest: { ...pullRequestSummary, status: 'completed' },
    approvalState: null,
    advancedTo,
    workItemSync,
  }
}

/**
 * GitHub's twin of `checkStageApprovalStatus` above (#13, ADR-0040) — same "Check status" contract
 * and same returned shape (`{ slug, stage, pullRequestId, prStatus, merged, review, pullRequest,
 * approvalState, advancedTo, workItemSync }`), read from a GitHub pull request's reviews instead of
 * Azure DevOps reviewer votes:
 *
 * - `review.state` comes from `interpretGitHubReviews` (lib/githubPullRequestsClient.js):
 *   `'approved'`, `'changes-requested'`, or `'pending'` — a COMMENTED or DISMISSED review is folded
 *   into `'pending'` there, never read as a verdict (ADR-0040).
 * - On `'approved'`, merges with `completePullRequest` — always a merge commit (ADR-0040, "Merge
 *   commit only"). A refusal (branch protection, a required check) throws GitHub's own message
 *   verbatim as a blocked sign-off: never retried, never downgraded to another merge method, and
 *   nothing else in this call (no stage advance, no work-item push, no persisted PR status) happens
 *   once that throw happens.
 * - `approvalState`/the ADR-0018 approval-invalidated-by-post-approval-commits flow has no GitHub
 *   counterpart in this ticket — `approvalState` is always `null` here. Left out of scope
 *   deliberately: it is Azure DevOps's own reviewer-vote-reset mechanism (`updateReviewerVote`,
 *   `commentOnPullRequest`), neither of which `lib/githubPullRequestsClient.js` implements, and #13's
 *   acceptance criteria don't call for it.
 * - Reads whichever copy of `instance.yaml` `checkStageApprovalStatus` itself reads — the stage's own
 *   branch if it exists, `main` otherwise — via `findGitHubStageBranch`.
 */
async function checkGitHubStageApprovalStatus(slug, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const githubBase = options.github

  const bootstrapInstance = await readInstance(slug, { github: githubBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate: options.gate })

  const branch = await findGitHubStageBranch(githubBase, slug, stage.id)
  const githubForStage = branch ? { ...githubBase, branch } : githubBase
  const instance = branch ? await readInstance(slug, { github: githubForStage }) : bootstrapInstance

  const pullRequestId = instance.pullRequests?.[stage.id]
  if (!pullRequestId) {
    throw new Error(
      `Instance "${slug}" has no Pull Request open requesting approval for stage "${stage.id}" — ` +
        'request approval first; there is no status to check before that'
    )
  }

  const client = createGitHubPullRequestsClient(githubBase)
  const pullRequest = await client.getPullRequest(pullRequestId)
  const commits = await client.getPullRequestCommits(pullRequestId)

  if (instance.pullRequestStatuses?.[stage.id] !== pullRequest.status) {
    await recordInstancePullRequestStatus(slug, stage.id, pullRequest.status, { github: githubForStage })
  }

  const review = githubReviewSummary(pullRequest.reviews)
  const pullRequestSummary = summarizeGitHubPullRequest(pullRequest, commits)

  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const nextStage = stageIndex >= 0 ? definition.stages[stageIndex + 1] ?? null : null
  const isAtPersistedStage = bootstrapInstance.stage === stage.id
  const workItemId = instance.workItem?.stages?.[stage.id]

  // Already resolved elsewhere (a re-click after this same action succeeded, or the PR was
  // completed/closed directly in GitHub): report faithfully, act never — same idempotency contract as
  // the Azure DevOps path above.
  if (pullRequest.status !== 'active') {
    let advancedTo = null
    let workItemSync = null

    if (pullRequest.status === 'completed' && isAtPersistedStage) {
      if (nextStage) {
        await writeInstanceStage(slug, nextStage.id, { github: githubBase })
        advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
      }
      try {
        await clearInstanceReopened(slug, stage.id, { github: githubBase })
      } catch (_) {}

      if (workItemId) {
        workItemSync = await syncGitHubStageWorkItem(instance, workItemId, githubBase.pat)
      }
    }

    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: pullRequest.status === 'completed',
      review,
      pullRequest: pullRequestSummary,
      approvalState: null,
      advancedTo,
      workItemSync,
    }
  }

  if (review.state !== 'approved') {
    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: false,
      review,
      pullRequest: pullRequestSummary,
      approvalState: null,
      advancedTo: null,
      workItemSync: null,
    }
  }

  try {
    await client.completePullRequest(pullRequestId, {
      mergeCommitMessage: `Merge stage "${stage.title}" of gantry instance "${slug}" (gate "${stage.gate}", approved via Pull Request #${pullRequestId})`,
    })
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    if (err instanceof RequestError) {
      let reason = err.message
      try {
        reason = JSON.parse(err.body)?.message ?? reason
      } catch (_) {}
      throw new Error(
        `Cannot complete sign-off for stage "${stage.id}" of instance "${slug}": GitHub refused to merge ` +
          `Pull Request #${pullRequestId} — "${reason}". Resolve this in GitHub (branch protection or a ` +
          'required check); gantry will not retry or merge with a different method.'
      )
    }
    throw err
  }

  await recordInstancePullRequestStatus(slug, stage.id, 'completed', { github: githubForStage })

  let advancedTo = null
  if (nextStage) {
    await writeInstanceStage(slug, nextStage.id, { github: githubBase })
    advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
  }
  try {
    await clearInstanceReopened(slug, stage.id, { github: githubBase })
  } catch (_) {}

  let workItemSync = null
  if (workItemId) {
    workItemSync = await syncGitHubStageWorkItem(instance, workItemId, githubBase.pat)
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    pullRequestId,
    prStatus: 'completed',
    merged: true,
    review,
    pullRequest: { ...pullRequestSummary, status: 'completed' },
    approvalState: null,
    advancedTo,
    workItemSync,
  }
}

// Pushes a merged stage's "done" state to its linked GitHub issue (closed, completed) — the same
// board-side tracking push `syncGatePassToWorkItem` (lib/workItemLink.js) performs for a confirmed
// gate-check, applied here on a merge Check status just detected. A failed push never rolls back the
// merge or the advance it's reported alongside (same non-gating contract as the Azure DevOps path).
async function syncGitHubStageWorkItem(instance, workItemId, pat) {
  try {
    const client = createGitHubWorkItemsClient({
      owner: instance.workItem.owner,
      repository: instance.workItem.repository,
      pat,
      baseUrl: instance.workItem.baseUrl,
    })
    const updated = await client.updateIssue(workItemId, { state: 'closed', state_reason: 'completed' })
    return { ok: true, workItemId, state: 'closed', workItem: updated }
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    return { ok: false, workItemId, error: err.message }
  }
}

// GitLab's own commit-list shape (`[{ id, message, committed_date, authored_date }]`, #33's
// `getPullRequestCommits`) onto the same `{ commitId, message, timestamp }` shape `commitSummary`
// above produces for Azure DevOps, so a caller displaying the commit panel never has to branch on
// provider for the field names.
function gitlabCommitSummary(commits) {
  return (commits ?? []).map((c) => ({
    commitId: c.id,
    message: c.message ?? c.title ?? '',
    timestamp: c.committed_date ?? c.authored_date ?? null,
  }))
}

/**
 * GitLab's twin of `reviewSummary`/`githubReviewSummary` above (#33, ADR-0041): turns a Merge
 * Request's raw approvals summary and discussion list into the same `{ state, reviewStatus,
 * reviewers, approver }` shape, via `interpretGitLabMergeRequest`
 * (lib/gitlabPullRequestsClient.js) for the state itself. `reviewers` lists everyone who has
 * approved so far (GitLab's own `approved_by`) — there is no GitLab equivalent of a "changes
 * requested" reviewer entry to also list, since that reading is inferred from unresolved discussion
 * threads rather than read off a named reviewer's own vote (ADR-0041).
 */
function gitlabReviewSummary(approvals, discussions) {
  const state = interpretGitLabMergeRequest({ approvals, discussions })
  const reviewers = (approvals?.approved_by ?? []).map((entry) => ({
    login: entry.user?.username ?? entry.user,
    state: 'APPROVED',
    submittedAt: null,
  }))
  const approver = reviewers[0] ?? null
  return {
    state,
    reviewStatus: reviewStatusFromVoteState(state),
    reviewers,
    approver,
  }
}

/** GitLab's twin of `summarizePullRequest`/`summarizeGitHubPullRequest` above — same `{ id, status, commits, review }` panel shape, over a GitLab Merge Request's own `{ pullRequestId, status, approvals, discussions }` and raw commit list. Exported for the same reason `summarizeGitHubPullRequest` is: `lib/stageApproval.js`'s `requestGitLabStageApproval` needs the identical panel shape right after opening a Merge Request, not just this module's own Check status path. */
export function summarizeGitLabPullRequest(pullRequest, commits = []) {
  return {
    id: pullRequest.pullRequestId,
    status: pullRequest.status,
    commits: gitlabCommitSummary(commits),
    review: gitlabReviewSummary(pullRequest.approvals, pullRequest.discussions),
  }
}

/**
 * GitLab's twin of `checkGitHubStageApprovalStatus` above (#33, ADR-0041) — same "Check status"
 * contract and same returned shape (`{ slug, stage, pullRequestId, prStatus, merged, review,
 * pullRequest, approvalState, advancedTo, workItemSync }`), read from a GitLab Merge Request's
 * approvals/discussions instead of GitHub reviews:
 *
 * - `review.state` comes from `interpretGitLabMergeRequest` (lib/gitlabPullRequestsClient.js):
 *   `'approved'`, `'changes-requested'`, or `'pending'` per ADR-0041's own not-approved-plus-
 *   unresolved-thread / not-approved-plus-no-thread / approved mapping — already honouring enforced
 *   Approval Rules on a Premium/Ultimate instance where they exist (GitLab's own `approved` field
 *   accounts for those), falling back to the toggle-plus-threads reading elsewhere.
 * - On `'approved'`, merges with `completePullRequest` — always a merge commit, source branch never
 *   auto-deleted (ADR-0041's "full capability parity", mirroring ADR-0040's GitHub stance). A refusal
 *   (a protected branch, a push rule, an unresolved discussion GitLab itself requires resolved before
 *   merge) throws GitLab's own message verbatim as a blocked sign-off: never retried, never downgraded
 *   to another merge method, and nothing else in this call happens once that throw happens.
 * - `approvalState`/the ADR-0018 approval-invalidated-by-post-approval-commits flow has no GitLab
 *   counterpart, same deliberate scope note the GitHub path above carries — `approvalState` is always
 *   `null` here.
 * - Reads whichever copy of `instance.yaml` `checkStageApprovalStatus` itself reads — the stage's own
 *   branch if it exists, `main` otherwise — via `findGitLabStageBranch`.
 */
async function checkGitLabStageApprovalStatus(slug, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const gitlabBase = options.gitlab

  const bootstrapInstance = await readInstance(slug, { gitlab: gitlabBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate: options.gate })

  const branch = await findGitLabStageBranch(gitlabBase, slug, stage.id)
  const gitlabForStage = branch ? { ...gitlabBase, branch } : gitlabBase
  const instance = branch ? await readInstance(slug, { gitlab: gitlabForStage }) : bootstrapInstance

  const pullRequestId = instance.pullRequests?.[stage.id]
  if (!pullRequestId) {
    throw new Error(
      `Instance "${slug}" has no Pull Request open requesting approval for stage "${stage.id}" — ` +
        'request approval first; there is no status to check before that'
    )
  }

  const client = createGitLabPullRequestsClient(gitlabBase)
  const pullRequest = await client.getPullRequest(pullRequestId)
  const commits = await client.getPullRequestCommits(pullRequestId)

  if (instance.pullRequestStatuses?.[stage.id] !== pullRequest.status) {
    await recordInstancePullRequestStatus(slug, stage.id, pullRequest.status, { gitlab: gitlabForStage })
  }

  const review = gitlabReviewSummary(pullRequest.approvals, pullRequest.discussions)
  const pullRequestSummary = summarizeGitLabPullRequest(pullRequest, commits)

  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const nextStage = stageIndex >= 0 ? definition.stages[stageIndex + 1] ?? null : null
  const isAtPersistedStage = bootstrapInstance.stage === stage.id
  const workItemId = instance.workItem?.stages?.[stage.id]

  // Already resolved elsewhere (a re-click after this same action succeeded, or the MR was
  // merged/closed directly in GitLab): report faithfully, act never — same idempotency contract as
  // the Azure DevOps/GitHub paths above.
  if (pullRequest.status !== 'active') {
    let advancedTo = null
    let workItemSync = null

    if (pullRequest.status === 'completed' && isAtPersistedStage) {
      if (nextStage) {
        await writeInstanceStage(slug, nextStage.id, { gitlab: gitlabBase })
        advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
      }
      try {
        await clearInstanceReopened(slug, stage.id, { gitlab: gitlabBase })
      } catch (_) {}

      if (workItemId) {
        workItemSync = await syncGitLabStageWorkItem(instance, workItemId, gitlabBase.pat)
      }
    }

    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: pullRequest.status === 'completed',
      review,
      pullRequest: pullRequestSummary,
      approvalState: null,
      advancedTo,
      workItemSync,
    }
  }

  if (review.state !== 'approved') {
    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: false,
      review,
      pullRequest: pullRequestSummary,
      approvalState: null,
      advancedTo: null,
      workItemSync: null,
    }
  }

  try {
    await client.completePullRequest(pullRequestId, {
      mergeCommitMessage: `Merge stage "${stage.title}" of gantry instance "${slug}" (gate "${stage.gate}", approved via Merge Request !${pullRequestId})`,
    })
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    if (err instanceof RequestError) {
      let reason = err.message
      try {
        reason = JSON.parse(err.body)?.message ?? reason
      } catch (_) {}
      throw new Error(
        `Cannot complete sign-off for stage "${stage.id}" of instance "${slug}": GitLab refused to merge ` +
          `Merge Request !${pullRequestId} — "${reason}". Resolve this in GitLab (a protected branch, push ` +
          'rule, or unresolved discussion); gantry will not retry or merge with a different method.'
      )
    }
    throw err
  }

  await recordInstancePullRequestStatus(slug, stage.id, 'completed', { gitlab: gitlabForStage })

  let advancedTo = null
  if (nextStage) {
    await writeInstanceStage(slug, nextStage.id, { gitlab: gitlabBase })
    advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
  }
  try {
    await clearInstanceReopened(slug, stage.id, { gitlab: gitlabBase })
  } catch (_) {}

  let workItemSync = null
  if (workItemId) {
    workItemSync = await syncGitLabStageWorkItem(instance, workItemId, gitlabBase.pat)
  }

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    pullRequestId,
    prStatus: 'completed',
    merged: true,
    review,
    pullRequest: { ...pullRequestSummary, status: 'completed' },
    approvalState: null,
    advancedTo,
    workItemSync,
  }
}

// Pushes a merged stage's "done" state to its linked GitLab issue (closed) — the GitLab twin of
// syncGitHubStageWorkItem above. GitLab only ever accepts a state *transition*
// (`state_event: 'close'`), never a bare `state` field directly (lib/gitlabWorkItemsClient.js's own
// updateIssue doc comment) — the one place this differs from GitHub's own `updateIssue({ state:
// 'closed', ... })` call. A failed push never rolls back the merge or the advance it's reported
// alongside (same non-gating contract as every other provider's path).
async function syncGitLabStageWorkItem(instance, workItemId, pat) {
  try {
    const client = createGitLabWorkItemsClient({
      namespace: instance.workItem.namespace,
      repository: instance.workItem.repository,
      pat,
      baseUrl: instance.workItem.baseUrl,
    })
    const updated = await client.updateIssue(workItemId, { state_event: 'close' })
    return { ok: true, workItemId, state: 'closed', workItem: updated }
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    return { ok: false, workItemId, error: err.message }
  }
}

// Bitbucket's own per-PR commit-list shape (`[{ hash, date, message }]`, #46's own
// `getPullRequestCommits`) onto the same `{ commitId, message, timestamp }` shape `commitSummary`
// above produces for Azure DevOps, so a caller displaying the commit panel never has to branch on
// provider for the field names.
function bitbucketCommitSummary(commits) {
  return (commits ?? []).map((c) => ({
    commitId: c.hash,
    message: c.message ?? '',
    timestamp: c.date ?? null,
  }))
}

/**
 * Bitbucket's twin of `reviewSummary`/`githubReviewSummary`/`gitlabReviewSummary` above (#46, ADR-
 * 0042): turns a pull request's raw `participants` array into the same `{ state, reviewStatus,
 * reviewers, approver }` shape, via `interpretBitbucketPullRequest` (lib/bitbucketPullRequestsClient.js)
 * for the state itself. `reviewers` lists every `role === 'REVIEWER'` participant with their own raw
 * tri-state `state` ('approved'/'changes_requested'/`null`) — unlike GitHub/GitLab, Bitbucket's own
 * resource carries this directly with no inference needed (see that function's own doc comment).
 */
function bitbucketReviewSummary(participants) {
  const state = interpretBitbucketPullRequest(participants)
  const reviewers = (participants ?? [])
    .filter((p) => p.role === 'REVIEWER')
    .map((p) => ({
      login: p.user?.nickname ?? p.user?.display_name ?? p.user?.uuid,
      state: p.state,
      submittedAt: null,
    }))
  const approver = reviewers.find((r) => r.state === 'approved') ?? reviewers[0] ?? null
  return {
    state,
    reviewStatus: reviewStatusFromVoteState(state),
    reviewers,
    approver,
  }
}

/** Bitbucket's twin of `summarizePullRequest`/`summarizeGitHubPullRequest`/`summarizeGitLabPullRequest` above (#46) — same `{ id, status, commits, review }` panel shape, over a Bitbucket pull request's own `{ pullRequestId, status, participants }` and raw commit list. Exported for the same reason those functions are: `lib/stageApproval.js`'s `requestAtlassianStageApproval` needs the identical panel shape right after opening a pull request, not just this module's own Check status path. */
export function summarizeBitbucketPullRequest(pullRequest, commits = []) {
  return {
    id: pullRequest.pullRequestId,
    status: pullRequest.status,
    commits: bitbucketCommitSummary(commits),
    review: bitbucketReviewSummary(pullRequest.participants),
  }
}

/**
 * Bitbucket's twin of `checkGitHubStageApprovalStatus`/`checkGitLabStageApprovalStatus` above (#46,
 * ADR-0042) — same "Check status" contract and same returned shape (`{ slug, stage, pullRequestId,
 * prStatus, merged, review, pullRequest, approvalState, advancedTo, workItemSync }`), read from a
 * Bitbucket pull request's `participants` instead of GitHub reviews or GitLab approvals/discussions:
 *
 * - `review.state` comes from `interpretBitbucketPullRequest`: `'approved'`, `'changes-requested'` or
 *   `'pending'`, read directly off each reviewer's own tri-state `state` field — no inference needed,
 *   per ADR-0042's own "no GitLab-style toggle-plus-threads workaround needed here".
 * - On `'approved'`, merges with `completePullRequest` — always a merge commit (mirrors ADR-0040/0041's
 *   "merge commit only" stance). A refusal (a branch restriction, a failed merge check) throws
 *   Bitbucket's own message verbatim as a blocked sign-off: never retried, never downgraded to another
 *   merge strategy, and nothing else in this call (no stage advance, no persisted PR status) happens
 *   once that throw happens.
 * - `approvalState`/the ADR-0018 approval-invalidated-by-post-approval-commits flow has no Bitbucket
 *   counterpart in this ticket, same deliberate scope note the GitHub/GitLab paths above carry —
 *   `approvalState` is always `null` here.
 * - `workItemSync` is always `null` — linking a Gantry instance to a Jira issue hierarchy has no
 *   mechanism yet (no ticket in the current Atlassian batch, #40-#49, adds one; `lib/jiraWorkItemsClient.js`,
 *   #42, is ready for a later ticket to build that linker on), so `instance.workItem` is never
 *   populated for an Atlassian-backed instance today — this mirrors GitHub's/GitLab's own deliberate
 *   "no counterpart yet" scope notes rather than inventing a linking mechanism this ticket's own
 *   acceptance criteria don't call for.
 * - Reads whichever copy of `instance.yaml` `checkStageApprovalStatus` itself reads — the stage's own
 *   branch if it exists, `main` otherwise — via `findBitbucketStageBranch`.
 */
async function checkBitbucketStageApprovalStatus(slug, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const atlassianBase = options.atlassian

  const bootstrapInstance = await readInstance(slug, { atlassian: atlassianBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir, version: instanceDefinitionVersion(bootstrapInstance) })
  const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate: options.gate })

  const branch = await findBitbucketStageBranch(atlassianBase, slug, stage.id)
  const atlassianForStage = branch ? { ...atlassianBase, branch } : atlassianBase
  const instance = branch ? await readInstance(slug, { atlassian: atlassianForStage }) : bootstrapInstance

  const pullRequestId = instance.pullRequests?.[stage.id]
  if (!pullRequestId) {
    throw new Error(
      `Instance "${slug}" has no Pull Request open requesting approval for stage "${stage.id}" — ` +
        'request approval first; there is no status to check before that'
    )
  }

  const client = createBitbucketPullRequestsClient(atlassianBase)
  const pullRequest = await client.getPullRequest(pullRequestId)
  const commits = await client.getPullRequestCommits(pullRequestId)

  if (instance.pullRequestStatuses?.[stage.id] !== pullRequest.status) {
    await recordInstancePullRequestStatus(slug, stage.id, pullRequest.status, { atlassian: atlassianForStage })
  }

  const review = bitbucketReviewSummary(pullRequest.participants)
  const pullRequestSummary = summarizeBitbucketPullRequest(pullRequest, commits)

  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const nextStage = stageIndex >= 0 ? definition.stages[stageIndex + 1] ?? null : null
  const isAtPersistedStage = bootstrapInstance.stage === stage.id

  // Already resolved elsewhere (a re-click after this same action succeeded, or the pull request was
  // merged/declined directly in Bitbucket): report faithfully, act never — same idempotency contract as
  // the Azure DevOps/GitHub/GitLab paths above.
  if (pullRequest.status !== 'active') {
    let advancedTo = null

    if (pullRequest.status === 'completed' && isAtPersistedStage) {
      if (nextStage) {
        await writeInstanceStage(slug, nextStage.id, { atlassian: atlassianBase })
        advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
      }
      try {
        await clearInstanceReopened(slug, stage.id, { atlassian: atlassianBase })
      } catch (_) {}
    }

    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: pullRequest.status === 'completed',
      review,
      pullRequest: pullRequestSummary,
      approvalState: null,
      advancedTo,
      workItemSync: null,
    }
  }

  if (review.state !== 'approved') {
    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: false,
      review,
      pullRequest: pullRequestSummary,
      approvalState: null,
      advancedTo: null,
      workItemSync: null,
    }
  }

  try {
    await client.completePullRequest(pullRequestId, {
      mergeCommitMessage: `Merge stage "${stage.title}" of gantry instance "${slug}" (gate "${stage.gate}", approved via Pull Request #${pullRequestId})`,
    })
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    if (err instanceof RequestError) {
      let reason = err.message
      try {
        const parsed = JSON.parse(err.body)
        reason = parsed?.error?.message ?? parsed?.message ?? reason
      } catch (_) {}
      throw new Error(
        `Cannot complete sign-off for stage "${stage.id}" of instance "${slug}": Bitbucket refused to merge ` +
          `Pull Request #${pullRequestId} — "${reason}". Resolve this in Bitbucket (a branch restriction or a ` +
          'failed merge check); gantry will not retry or merge with a different strategy.'
      )
    }
    throw err
  }

  await recordInstancePullRequestStatus(slug, stage.id, 'completed', { atlassian: atlassianForStage })

  let advancedTo = null
  if (nextStage) {
    await writeInstanceStage(slug, nextStage.id, { atlassian: atlassianBase })
    advancedTo = { id: nextStage.id, title: nextStage.title, gate: nextStage.gate }
  }
  try {
    await clearInstanceReopened(slug, stage.id, { atlassian: atlassianBase })
  } catch (_) {}

  return {
    slug,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    pullRequestId,
    prStatus: 'completed',
    merged: true,
    review,
    pullRequest: { ...pullRequestSummary, status: 'completed' },
    approvalState: null,
    advancedTo,
    workItemSync: null,
  }
}
