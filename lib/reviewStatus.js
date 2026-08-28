/**
 * Gantry's own review/sign-off status vocabulary (ADR-0024,
 * docs/adr/0024-custom-review-status-field.md) — shared by review work
 * items (lib/stageReview.js) and sign-off's Pull-Request-vote reading
 * (lib/stageStatus.js) so both concepts speak the same five-value
 * lifecycle: Requested, In review, Changes requested, Approved, Rejected.
 *
 * The field is additive, layered alongside native Azure DevOps
 * `System.State` — never a replacement for it. This project's `Task` work
 * item type has a locked `System.State` process field (fixed
 * New/Active/Closed/Removed transitions), so the richer lifecycle lives in
 * a separate Gantry-owned custom field instead (ADR-0024 rejects making
 * these the literal `System.State` values as out of proportion).
 */

// The Azure DevOps field reference name gantry writes/reads for this
// lifecycle. WI213's UI build reads this same reference name.
export const REVIEW_STATUS_FIELD = 'Custom.GantryReviewStatus'

export const REVIEW_STATUS = Object.freeze({
  REQUESTED: 'Requested',
  IN_REVIEW: 'In review',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
})

export const REVIEW_STATUS_VALUES = Object.freeze(Object.values(REVIEW_STATUS))

/**
 * Infers a status for a review/sign-off work item that predates
 * REVIEW_STATUS_FIELD (ADR-0024 §4: no forced backfill migration) from its
 * native `System.State` alone. Native state can only ever tell "not yet
 * actioned" (`New`) from "someone's on it" (`Active`, or anything else this
 * fake/real process might report) apart — it has no concept of a reviewer
 * having asked for changes, approved, or rejected, which is exactly the gap
 * ADR-0024 exists to close — so this never guesses an outcome, only
 * Requested/In review.
 */
export function inferReviewStatusFromNativeState(state) {
  return state === 'New' ? REVIEW_STATUS.REQUESTED : REVIEW_STATUS.IN_REVIEW
}

/**
 * Maps a Pull Request reviewer-vote interpretation — `interpretReviewerVotes`
 * (lib/stageStatus.js)'s `'approved' | 'rejected' | 'changes-requested' |
 * 'pending'`, plus its `'approved-then-invalidated'` extension — onto the
 * same five-value vocabulary review work items use, per ADR-0024's "one
 * shared vocabulary, not two" decision.
 *
 * `'approved-then-invalidated'` (a stale approval a later commit voided)
 * reads as `In review`, not `Approved`: the approval no longer stands and
 * the stage is once again awaiting a decision, mirroring ADR-0014's
 * treatment of invalidation as "back to needing a look", not a rejection.
 */
export function reviewStatusFromVoteState(voteState) {
  switch (voteState) {
    case 'approved':
      return REVIEW_STATUS.APPROVED
    case 'rejected':
      return REVIEW_STATUS.REJECTED
    case 'changes-requested':
      return REVIEW_STATUS.CHANGES_REQUESTED
    case 'approved-then-invalidated':
    case 'pending':
    default:
      return REVIEW_STATUS.IN_REVIEW
  }
}
