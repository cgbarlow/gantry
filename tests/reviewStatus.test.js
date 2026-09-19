import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_STATUS_FIELD,
  REVIEW_STATUS,
  REVIEW_STATUS_VALUES,
  inferReviewStatusFromNativeState,
  reviewStatusFromVoteState,
  GITHUB_REVIEW_LABEL_PREFIX,
  reviewStatusToGitHubLabel,
  gitHubLabelToReviewStatus,
  allGitHubReviewLabels,
  GITLAB_REVIEW_LABEL_PREFIX,
  reviewStatusToGitLabLabel,
  gitlabLabelToReviewStatus,
  allGitLabReviewLabels,
} from '../lib/reviewStatus.js'

// Lib-level tests for ADR-0024 (docs/adr/0024-custom-review-status-field.md)
// — the shared Requested/In review/Changes requested/Approved/Rejected
// vocabulary review work items and sign-off's PR-vote reading both speak.

test('REVIEW_STATUS carries exactly the five ADR-0024 lifecycle values', () => {
  assert.deepEqual(REVIEW_STATUS_VALUES, ['Requested', 'In review', 'Changes requested', 'Approved', 'Rejected'])
  assert.equal(REVIEW_STATUS.REQUESTED, 'Requested')
  assert.equal(REVIEW_STATUS.IN_REVIEW, 'In review')
  assert.equal(REVIEW_STATUS.CHANGES_REQUESTED, 'Changes requested')
  assert.equal(REVIEW_STATUS.APPROVED, 'Approved')
  assert.equal(REVIEW_STATUS.REJECTED, 'Rejected')
})

test('REVIEW_STATUS_FIELD is a Custom.* Azure DevOps field reference name', () => {
  // WI213's UI build reads this same reference name — keep it a stable,
  // predictable constant rather than a magic string scattered around.
  assert.equal(REVIEW_STATUS_FIELD, 'Custom.GantryReviewStatus')
})

test('inferReviewStatusFromNativeState maps a pre-existing work item\'s native System.State to Requested/In review only, never an outcome', () => {
  assert.equal(inferReviewStatusFromNativeState('New'), 'Requested')
  assert.equal(inferReviewStatusFromNativeState('Active'), 'In review')
  // Closed/Removed/anything else native carries no "changes
  // requested"/"approved"/"rejected" distinction gantry can trust — never
  // guess an outcome, and never return blank/undefined.
  assert.equal(inferReviewStatusFromNativeState('Closed'), 'In review')
  assert.equal(inferReviewStatusFromNativeState('Removed'), 'In review')
  assert.equal(inferReviewStatusFromNativeState(undefined), 'In review')
})

test('reviewStatusFromVoteState maps sign-off\'s PR-reviewer-vote states onto the same vocabulary review work items use', () => {
  assert.equal(reviewStatusFromVoteState('pending'), REVIEW_STATUS.IN_REVIEW)
  assert.equal(reviewStatusFromVoteState('approved'), REVIEW_STATUS.APPROVED)
  assert.equal(reviewStatusFromVoteState('rejected'), REVIEW_STATUS.REJECTED)
  assert.equal(reviewStatusFromVoteState('changes-requested'), REVIEW_STATUS.CHANGES_REQUESTED)
  assert.equal(reviewStatusFromVoteState('approved-then-invalidated'), REVIEW_STATUS.IN_REVIEW)
})

// #15, docs/adr/0040 "Review status rides reserved labels" — GitHub's own carrier for this same
// five-value vocabulary.

test('reviewStatusToGitHubLabel maps every REVIEW_STATUS value to its own reserved gantry:review/* label', () => {
  assert.equal(reviewStatusToGitHubLabel(REVIEW_STATUS.REQUESTED), 'gantry:review/requested')
  assert.equal(reviewStatusToGitHubLabel(REVIEW_STATUS.IN_REVIEW), 'gantry:review/in-review')
  assert.equal(reviewStatusToGitHubLabel(REVIEW_STATUS.CHANGES_REQUESTED), 'gantry:review/changes-requested')
  assert.equal(reviewStatusToGitHubLabel(REVIEW_STATUS.APPROVED), 'gantry:review/approved')
  assert.equal(reviewStatusToGitHubLabel(REVIEW_STATUS.REJECTED), 'gantry:review/rejected')
  assert.throws(() => reviewStatusToGitHubLabel('Not a real status'), /No gantry:review\/\* label is mapped/)
})

test('gitHubLabelToReviewStatus is the exact reverse of reviewStatusToGitHubLabel, and undefined when no reserved label is present', () => {
  for (const status of REVIEW_STATUS_VALUES) {
    assert.equal(gitHubLabelToReviewStatus([reviewStatusToGitHubLabel(status)]), status)
  }
  // Unrelated labels alongside a real one are ignored, not treated as a second/conflicting signal.
  assert.equal(gitHubLabelToReviewStatus(['bug', reviewStatusToGitHubLabel(REVIEW_STATUS.APPROVED), 'good first issue']), REVIEW_STATUS.APPROVED)
  assert.equal(gitHubLabelToReviewStatus(['bug', 'good first issue']), undefined)
  assert.equal(gitHubLabelToReviewStatus([]), undefined)
})

test('allGitHubReviewLabels returns one { name, color, description } definition per REVIEW_STATUS_VALUES entry, prefixed gantry:review/', () => {
  const labels = allGitHubReviewLabels()
  assert.equal(labels.length, REVIEW_STATUS_VALUES.length)
  for (const label of labels) {
    assert.ok(label.name.startsWith(GITHUB_REVIEW_LABEL_PREFIX))
    assert.match(label.color, /^[0-9a-f]{6}$/)
    assert.match(label.description, /Gantry Request Review status/)
  }
  // Distinct names and colours — five genuinely different labels, not five copies.
  assert.equal(new Set(labels.map((l) => l.name)).size, labels.length)
})

// #34, docs/adr/0041 "applied here to GitLab's Issues" — GitLab's own carrier for this same
// five-value vocabulary, deliberately identical prefix/slugs to GitHub's own.

test('reviewStatusToGitLabLabel maps every REVIEW_STATUS value to its own reserved gantry:review/* label, identical to GitHub\'s own vocabulary', () => {
  assert.equal(reviewStatusToGitLabLabel(REVIEW_STATUS.REQUESTED), 'gantry:review/requested')
  assert.equal(reviewStatusToGitLabLabel(REVIEW_STATUS.IN_REVIEW), 'gantry:review/in-review')
  assert.equal(reviewStatusToGitLabLabel(REVIEW_STATUS.CHANGES_REQUESTED), 'gantry:review/changes-requested')
  assert.equal(reviewStatusToGitLabLabel(REVIEW_STATUS.APPROVED), 'gantry:review/approved')
  assert.equal(reviewStatusToGitLabLabel(REVIEW_STATUS.REJECTED), 'gantry:review/rejected')
  assert.throws(() => reviewStatusToGitLabLabel('Not a real status'), /No gantry:review\/\* label is mapped/)
  for (const status of REVIEW_STATUS_VALUES) {
    assert.equal(reviewStatusToGitLabLabel(status), reviewStatusToGitHubLabel(status))
  }
})

test('gitlabLabelToReviewStatus is the exact reverse of reviewStatusToGitLabLabel, and undefined when no reserved label is present', () => {
  for (const status of REVIEW_STATUS_VALUES) {
    assert.equal(gitlabLabelToReviewStatus([reviewStatusToGitLabLabel(status)]), status)
  }
  // Unrelated labels alongside a real one are ignored, not treated as a second/conflicting signal.
  assert.equal(gitlabLabelToReviewStatus(['bug', reviewStatusToGitLabLabel(REVIEW_STATUS.APPROVED), 'good first issue']), REVIEW_STATUS.APPROVED)
  assert.equal(gitlabLabelToReviewStatus(['bug', 'good first issue']), undefined)
  assert.equal(gitlabLabelToReviewStatus([]), undefined)
})

test('allGitLabReviewLabels returns one { name, color, description } definition per REVIEW_STATUS_VALUES entry, prefixed gantry:review/, with GitLab-shaped #RRGGBB colours', () => {
  const labels = allGitLabReviewLabels()
  assert.equal(labels.length, REVIEW_STATUS_VALUES.length)
  for (const label of labels) {
    assert.ok(label.name.startsWith(GITLAB_REVIEW_LABEL_PREFIX))
    assert.match(label.color, /^#[0-9a-f]{6}$/)
    assert.match(label.description, /Gantry Request Review status/)
  }
  // Distinct names and colours — five genuinely different labels, not five copies.
  assert.equal(new Set(labels.map((l) => l.name)).size, labels.length)
})
