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

/**
 * GitHub's own carrier for this same five-value lifecycle (#15, docs/adr/0040 "Review status rides
 * reserved labels"): GitHub issues have no custom fields and open/closed can't carry five values, so
 * each status maps to one reserved `gantry:review/<slug>` label, created on demand
 * (`lib/githubWorkItemsClient.js`'s `ensureLabelsExist`) rather than assumed to pre-exist on the repo.
 */
export const GITHUB_REVIEW_LABEL_PREFIX = 'gantry:review/'

const GITHUB_REVIEW_LABEL_SLUGS = Object.freeze({
  [REVIEW_STATUS.REQUESTED]: 'requested',
  [REVIEW_STATUS.IN_REVIEW]: 'in-review',
  [REVIEW_STATUS.CHANGES_REQUESTED]: 'changes-requested',
  [REVIEW_STATUS.APPROVED]: 'approved',
  [REVIEW_STATUS.REJECTED]: 'rejected',
})

// One fixed, readable colour per status (GitHub label colours are a bare 6-digit hex, no leading
// "#") — chosen so the five read as a small traffic-light-ish set in GitHub's own label list, not
// picked for any deeper meaning. Never consulted by gantry itself; purely a one-time creation hint,
// since `ensureLabelsExist` never touches a label that already exists.
const GITHUB_REVIEW_LABEL_COLORS = Object.freeze({
  [REVIEW_STATUS.REQUESTED]: 'fbca04',
  [REVIEW_STATUS.IN_REVIEW]: '1d76db',
  [REVIEW_STATUS.CHANGES_REQUESTED]: 'd93f0b',
  [REVIEW_STATUS.APPROVED]: '0e8a16',
  [REVIEW_STATUS.REJECTED]: 'b60205',
})

/** The `gantry:review/<slug>` label name carrying `status`. Throws for anything outside `REVIEW_STATUS_VALUES` — every caller here already has a value from that vocabulary, never arbitrary user input. */
export function reviewStatusToGitHubLabel(status) {
  const slug = GITHUB_REVIEW_LABEL_SLUGS[status]
  if (!slug) throw new Error(`No gantry:review/* label is mapped for review status "${status}"`)
  return `${GITHUB_REVIEW_LABEL_PREFIX}${slug}`
}

/**
 * The reverse of `reviewStatusToGitHubLabel`, applied to a whole label-name list (an issue can carry
 * unrelated labels too): returns the first `REVIEW_STATUS` value whose reserved label is present, or
 * `undefined` if none is — a human can remove every gantry:review/* label from an issue, or an issue
 * can predate this feature entirely, and this never guesses a status for that case.
 */
export function gitHubLabelToReviewStatus(labelNames) {
  for (const status of REVIEW_STATUS_VALUES) {
    if (labelNames.includes(reviewStatusToGitHubLabel(status))) return status
  }
  return undefined
}

/** The full set of `{ name, color, description }` label definitions `ensureLabelsExist` creates on demand — every `REVIEW_STATUS_VALUES` entry, in order. */
export function allGitHubReviewLabels() {
  return REVIEW_STATUS_VALUES.map((status) => ({
    name: reviewStatusToGitHubLabel(status),
    color: GITHUB_REVIEW_LABEL_COLORS[status],
    description: `Gantry Request Review status: ${status}`,
  }))
}

/**
 * GitLab's own carrier for this same five-value lifecycle (#34, docs/adr/0041 "same per-reviewer-
 * status-expressible shape ADR-0040 established for GitHub, applied here to GitLab's Issues"): GitLab
 * issues have no custom fields either, so each status maps to one reserved `gantry:review/<slug>`
 * label, created on demand (`lib/gitlabWorkItemsClient.js`'s own `ensureLabelsExist`) rather than
 * assumed to pre-exist on the project. Same prefix and slug vocabulary as GitHub's own — this is one
 * gantry-owned convention applied identically to two different providers' issues, not a GitHub-specific
 * naming choice — kept as its own constant here rather than imported from the GitHub section above,
 * mirroring how `lib/gitlabWorkItemsClient.js` keeps its own `STAGES_SECTION_MARKER` rather than
 * importing GitHub's.
 */
export const GITLAB_REVIEW_LABEL_PREFIX = 'gantry:review/'

const GITLAB_REVIEW_LABEL_SLUGS = Object.freeze({
  [REVIEW_STATUS.REQUESTED]: 'requested',
  [REVIEW_STATUS.IN_REVIEW]: 'in-review',
  [REVIEW_STATUS.CHANGES_REQUESTED]: 'changes-requested',
  [REVIEW_STATUS.APPROVED]: 'approved',
  [REVIEW_STATUS.REJECTED]: 'rejected',
})

// The same five colours as GITHUB_REVIEW_LABEL_COLORS, re-prefixed `#` — GitLab's Labels API requires
// a `#RRGGBB` hex string, unlike GitHub's bare hex. Never consulted by gantry itself; purely a
// one-time creation hint.
const GITLAB_REVIEW_LABEL_COLORS = Object.freeze({
  [REVIEW_STATUS.REQUESTED]: '#fbca04',
  [REVIEW_STATUS.IN_REVIEW]: '#1d76db',
  [REVIEW_STATUS.CHANGES_REQUESTED]: '#d93f0b',
  [REVIEW_STATUS.APPROVED]: '#0e8a16',
  [REVIEW_STATUS.REJECTED]: '#b60205',
})

/** The `gantry:review/<slug>` label name carrying `status`, GitLab's twin of `reviewStatusToGitHubLabel`. Throws for anything outside `REVIEW_STATUS_VALUES`. */
export function reviewStatusToGitLabLabel(status) {
  const slug = GITLAB_REVIEW_LABEL_SLUGS[status]
  if (!slug) throw new Error(`No gantry:review/* label is mapped for review status "${status}"`)
  return `${GITLAB_REVIEW_LABEL_PREFIX}${slug}`
}

/**
 * The reverse of `reviewStatusToGitLabLabel`, applied to a whole label-name list — GitLab's twin of
 * `gitHubLabelToReviewStatus`. Note GitLab's own Issues API already returns `labels` as an array of
 * plain name strings (unlike GitHub's array of `{ name, color, description }` objects), so a caller
 * here passes `issue.labels` straight through with no `.map((l) => l.name)` step first.
 */
export function gitlabLabelToReviewStatus(labelNames) {
  for (const status of REVIEW_STATUS_VALUES) {
    if (labelNames.includes(reviewStatusToGitLabLabel(status))) return status
  }
  return undefined
}

/** The full set of `{ name, color, description }` label definitions `ensureLabelsExist` creates on demand — GitLab's twin of `allGitHubReviewLabels`. */
export function allGitLabReviewLabels() {
  return REVIEW_STATUS_VALUES.map((status) => ({
    name: reviewStatusToGitLabLabel(status),
    color: GITLAB_REVIEW_LABEL_COLORS[status],
    description: `Gantry Request Review status: ${status}`,
  }))
}
