import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_STATUS_FIELD,
  REVIEW_STATUS,
  REVIEW_STATUS_VALUES,
  inferReviewStatusFromNativeState,
  reviewStatusFromVoteState,
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
