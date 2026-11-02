// "Changed since approval" (#273, docs/adr/0069), as the screens show it. The server decides which earlier
// approved stages are flagged (`changedSinceApproval` on GET /api/instance, `[{ stageId, title, fields,
// count }]`; dashboard rows carry the same without `fields`). Everything here only words that list, so the
// stage tab, the stage status, the Request approval panel and the dashboard all say the same thing.

/** `2 Fields`, `1 Field`. */
export function fieldCountLabel(count) {
  return `${count} ${count === 1 ? 'Field' : 'Fields'}`
}

/** The flagged entry for `stageId`, or `undefined`. */
export function changedEntryFor(changed, stageId) {
  return (changed ?? []).find((entry) => entry.stageId === stageId)
}

/** `SOAP: 2 Fields` — one flagged stage. */
export function changedEntryLabel(entry) {
  return `${entry.title}: ${fieldCountLabel(entry.count)}`
}

/**
 * The Request approval panel's line: `also re-approves SOAP: 2 Fields`, naming every flagged stage
 * (`also re-approves SOAP: 2 Fields, Business case: 1 Field`). `null` when nothing is flagged.
 */
export function alsoReapprovesLine(changed) {
  if (!changed?.length) return null
  return `also re-approves ${changed.map(changedEntryLabel).join(', ')}`
}

/** Dashboard badge text: `CHANGED SINCE APPROVAL`. `null` when nothing is flagged. */
export function dashboardBadgeText(changed) {
  return changed?.length ? 'CHANGED SINCE APPROVAL' : null
}

/** Its hover text: `SOAP: 2 Fields`, one per flagged stage. */
export function dashboardBadgeTitle(changed) {
  return (changed ?? []).map(changedEntryLabel).join('; ')
}

// ---- Restore approved text (#274, ADR-0069) ----
// On the current stage's editor, each flagged Field shows its approved wording beside its current wording,
// with a Restore approved text button. The server sends each flagged stage's `changes` (one per Field:
// `{ ref, moduleId, moduleTitle, fieldId, title, type, approved, current }`, values shaped as the editor holds
// them — text, or an array of items for a list Field).

/** A Field's wording as the side-by-side shows it: a list's items one per line, anything else as written. */
export function wordingText(value) {
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${item}`).join('\n') : ''
  return String(value ?? '')
}

/**
 * Whether the viewed stage can hold a restore of `change`: it mounts the Field's Module and does not carry it
 * read-only. A Field flagged from a Module this stage does not show cannot be put back from here.
 */
export function canRestoreChange(change, modules) {
  const mod = (modules ?? []).find((m) => m.id === change.moduleId)
  return Boolean(mod && !mod.readOnly && mod.fields.some((field) => field.id === change.fieldId))
}

/** `Background › Problem statement`: how the panel names a flagged Field. */
export function changeLabel(change) {
  return `${change.moduleTitle} › ${change.title}`
}

/** The panel's heading for one flagged stage: `SOAP was approved with different wording in 2 Fields`. */
export function restorePanelHeading(entry) {
  return `${entry.title} was approved with different wording in ${fieldCountLabel(entry.count)}`
}

// Re-approval (#275, docs/adr/0069): the later stage's Pull Request re-approves the earlier stage it changed. The server
// reports what an open Pull Request also re-approves (`alsoReapproving`, `[{ stageId, title, fields, count, reviewers }]`),
// who Check status is still waiting for (`waitingForReviewers`, `[{ displayName, forStages }]`) and, on a stage that was
// re-approved, the history (`reapprovals`, `[{ by, byTitle, pullRequestId, fields, reviewers, approvedAt }]`).

function peopleList(reviewers) {
  return (reviewers ?? []).map((reviewer) => reviewer.displayName).join(', ')
}

/**
 * The Sign-off section's line for an open Pull Request that also re-approves earlier stages:
 * `Needs The Owner to approve SOAP: 2 Fields`. `null` when it re-approves nothing.
 */
export function reapprovingLine(alsoReapproving) {
  if (!alsoReapproving?.length) return null
  return alsoReapproving
    .map((entry) => {
      const who = peopleList(entry.reviewers)
      return `${who ? `Needs ${who} to approve ` : 'Re-approves '}${entry.title}: ${fieldCountLabel(entry.count)}`
    })
    .join('; ')
}

/** What the Request approval panel says once a Pull Request is opened that also re-approves earlier stages. */
export function requestedStatusWithReapproval(pullRequestId, alsoReapproves) {
  const base = `Pull Request #${pullRequestId} opened — awaiting the Owner's review.`
  if (!alsoReapproves?.length) return base
  const parts = alsoReapproves.map((entry) => {
    const who = peopleList(entry.reviewers)
    return `${entry.title} (${fieldCountLabel(entry.count)})${who ? `, so ${who} must approve too` : ''}`
  })
  return `${base} It also re-approves ${parts.join('; ')}.`
}

/** Check status's message while a re-approving reviewer hasn't approved: `Still waiting — Pull Request #7 needs The Owner, whose approval re-approves SOAP, before it can merge.` */
export function waitingForReapproversLine(pullRequestId, waitingForReviewers) {
  const parts = (waitingForReviewers ?? []).map((person) =>
    person.forStages?.length ? `${person.displayName}, whose approval re-approves ${person.forStages.join(', ')}` : person.displayName
  )
  return `Still waiting — Pull Request #${pullRequestId} needs ${parts.join('; ')} before it can merge.`
}

/** One history entry: `Re-approved 2026-10-12 by High-level Design (Pull Request #12): 2 Fields. Approved by The Owner.` */
export function reapprovalHistoryLine(entry) {
  const when = String(entry.approvedAt ?? '').slice(0, 10)
  const who = peopleList(entry.reviewers)
  return `Re-approved${when ? ` ${when}` : ''} by ${entry.byTitle} (Pull Request #${entry.pullRequestId}): ${fieldCountLabel(entry.fields?.length ?? 0)}.${who ? ` Approved by ${who}.` : ''}`
}
