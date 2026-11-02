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
