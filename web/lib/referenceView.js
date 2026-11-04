import { signal } from '@preact/signals'
import { logSummary } from './decisionsLog.js'

// #320: the module editor's **Sources & decisions** toggle, next to Navigation in the toolbar. Off (the default) shows the Stage's Fields with
// the status and action panels; on shows the reference panels (Source documents, Review comments, Decisions log) under the toolbar instead.
// Both sides stay mounted and are only hidden, so a Field's unsaved edit, its editor and the Save indicator come through any number of switches.
//
// Deliberately session-only, as web/lib/viewMode.js is: never read from or written to localStorage, so every page load starts off.
export const referenceView = signal(false)

// What the Review comments and Decisions log panels last read, for the toggle's count and whether it has anything to show. `key` says which
// Instance (and, for the log, which Stage) it was read for, so a summary left over from another one is never counted.
export const reviewSummary = signal({ key: '', copies: 0, unanswered: 0, error: false })
export const decisionsSummary = signal({ key: '', total: 0, open: 0 })

/** A Stage's decisions log (or null while it loads) as the toggle counts it: every entry, and the open questions the panel highlights. */
export function decisionsLogCounts(log) {
  if (!log) return { total: 0, open: 0 }
  const summary = logSummary(log)
  return { total: summary.total, open: summary.open.length }
}

export const NOTHING_HERE_YET = 'Nothing here yet: this Stage has no Source documents, review comments or decisions to show.'

/**
 * The toggle's state. `count` is what needs attention, unanswered review comment threads plus open questions (shown only above zero), and
 * `disabled` is true when none of the three panels has anything to show: Source documents are not offered, no Reviewed copy has been brought
 * in, and the Decisions log is empty. It is never an empty view.
 *
 * @param {object} input
 * @param {boolean} input.sourcesOffered  the Source documents panel is offered for this workspace
 * @param {{copies:number, unanswered:number, error?:boolean}|null} input.review  this Instance's `reviewSummary`, or null when not read yet
 * @param {{total:number, open:number}|null} input.decisions  this Stage's `decisionsSummary`, or null when not read yet
 */
export function referenceToggleState({ sourcesOffered = false, review = null, decisions = null } = {}) {
  const count = (review?.unanswered ?? 0) + (decisions?.open ?? 0)
  const hasContent = Boolean(sourcesOffered) || (review?.copies ?? 0) > 0 || Boolean(review?.error) || (decisions?.total ?? 0) > 0
  return { count, disabled: !hasContent }
}
