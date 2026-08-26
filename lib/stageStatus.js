import { loadDefinition } from './definition.js'
import { readInstance, writeInstanceStage, recordInstanceApprovalState } from './instance.js'
import { resolveCheckStage } from './check.js'
import { findStageBranch } from './stageBranch.js'
import {
  createAzureDevOpsPullRequestsClient,
  AzureDevOpsAuthenticationError,
} from './azureDevOpsPullRequestsClient.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { pickPassedState } from './workItemLink.js'

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
    required: r.required === true,
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
  return {
    state: invalidated ? 'approved-then-invalidated' : interpretReviewerVotes(reviewers),
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
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const azureDevOpsBase = options.azureDevOps
  if (!azureDevOpsBase) {
    throw new Error('checkStageApprovalStatus is for Workspace-backed instances only — pass options.azureDevOps')
  }

  const bootstrapInstance = await readInstance(slug, { azureDevOps: azureDevOpsBase })
  const definition = loadDefinition(bootstrapInstance.definition, { definitionsDir })
  const stage = resolveCheckStage(definition, bootstrapInstance, slug, { gate: options.gate })

  // `requestStageApproval` recorded the Pull Request id on the stage's own
  // branch's copy of instance.yaml (#124 wrote it through the branch-scoped
  // client, and #122 puts every stage write there) — so read the same copy
  // the instance screen itself shows (branch if it exists, main otherwise,
  // mirroring GET /api/instance), never main alone.
  const branch = await findStageBranch(azureDevOpsBase, slug, stage.id)
  const instance = branch
    ? await readInstance(slug, { azureDevOps: { ...azureDevOpsBase, branch } })
    : bootstrapInstance

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

  if (approvalInvalidated && persistedApprovalState?.state !== 'invalidated') {
    await recordInstanceApprovalState(slug, stage.id, approvalState, {
      azureDevOps: { ...azureDevOpsBase, branch },
    })
  }

  // Already resolved elsewhere (a re-click after this same action succeeded,
  // or the Owner completed/rejected the PR manually in Azure DevOps): report
  // faithfully, act never — completion, advancement and the work-item push
  // each happened once already, and repeating any of them would either fail
  // outright (Azure DevOps rejects completing an already-completed PR) or
  // double-write gantry's own records.
  if (pullRequest.status !== 'active') {
    return {
      slug,
      stage: { id: stage.id, title: stage.title, gate: stage.gate },
      pullRequestId,
      prStatus: pullRequest.status,
      merged: pullRequest.status === 'completed',
      review,
      pullRequest: pullRequestSummary,
      approvalState,
      advancedTo: null,
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
      approvalState,
      advancedTo: null,
      workItemSync: null,
    }
  }

  await client.completePullRequest(pullRequestId, {
    mergeCommitMessage: `Merge stage "${stage.title}" of gantry instance "${slug}" (gate "${stage.gate}", approved via Pull Request #${pullRequestId})`,
  })

  const stageIndex = definition.stages.findIndex((s) => s.id === stage.id)
  const nextStage = definition.stages[stageIndex + 1] ?? null
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

  const workItemId = instance.workItem?.stages?.[stage.id]
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
      if (err instanceof AzureDevOpsAuthenticationError) throw err
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
