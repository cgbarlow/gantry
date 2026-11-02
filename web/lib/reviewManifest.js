// #302 (ADR-0066): where an Instance keeps the **Reviewed copies** that came back, and the list that
// describes them. They sit in the Instance's folder under `reviews/`, one `<id>.docx` per copy, with
// `reviews/manifest.yaml` listing them. This file is the part both the server (lib/reviews.js) and a Local
// workspace in the browser use, so the two write the same bytes.
//
// A Reviewed copy is the record of exactly what came back. It is not a Source document and is never cited
// (ADR-0066), so it is kept apart from `assets/` and from anything the interview cites.
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'

export const REVIEWS_DIR = 'reviews'
export const REVIEWS_MANIFEST_PATH = `${REVIEWS_DIR}/manifest.yaml`

/** Where the Reviewed copy with this id is kept, relative to the Instance's folder. */
export function reviewFilePath(id) {
  return `${REVIEWS_DIR}/${id}.docx`
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/

/** Whether `id` can name a Reviewed copy (and so a file under `reviews/`). */
export function isReviewId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/**
 * One manifest entry for a Reviewed copy that has just been read: `id` is fixed here and never changes,
 * `read` is `readReviewedCopy`'s result, `name` the file's name as it came in, and `date` an ISO timestamp.
 * `commentsAnswered` starts at 0 and is only ever raised by working through the comments.
 */
export function reviewManifestEntry({ id, read, name, date, size }) {
  const { properties } = read
  return {
    id,
    file: reviewFilePath(id),
    name,
    artefact: properties.artefact ?? '',
    stage: properties.stage ?? '',
    renderId: properties['render-id'] ?? '',
    ...(properties.commit ? { commit: properties.commit } : {}),
    commenters: read.commenters,
    date,
    comments: read.commentCount,
    commentsAnswered: 0,
    size,
  }
}

/** The entries in a manifest's text (an empty or missing one is no entries); a malformed one reads as none. */
export function parseReviewManifest(text) {
  if (!text || !String(text).trim()) return []
  let parsed
  try {
    parsed = parseYAML(text)
  } catch {
    return []
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.reviews) ? parsed.reviews : []
  return entries.filter((entry) => entry && isReviewId(entry.id) && typeof entry.file === 'string')
}

/** The manifest's text for `entries`, as a YAML list. */
export function stringifyReviewManifest(entries) {
  return stringifyYAML(entries)
}

/**
 * The manifest entries with `commentsAnswered` raised to the counts the decisions logs say (`{ [reviewId]: n }`, web/lib/reviewRound.js
 * `answeredCounts`). A count is only ever raised and never above the comments the copy holds, so a write that arrives twice, or late, changes nothing.
 * Returns `{ entries, changed }`.
 */
export function withAnsweredCounts(entries, counts = {}) {
  let changed = false
  const next = entries.map((entry) => {
    const wanted = Number(counts?.[entry.id])
    if (!Number.isFinite(wanted) || wanted <= (entry.commentsAnswered ?? 0)) return entry
    const capped = Math.min(Math.floor(wanted), Math.max(entry.comments ?? 0, entry.commentsAnswered ?? 0, 0) || Math.floor(wanted))
    if (capped <= (entry.commentsAnswered ?? 0)) return entry
    changed = true
    return { ...entry, commentsAnswered: capped }
  })
  return { entries: next, changed }
}

/** The entry for `id`, or `undefined`. */
export function findReview(entries, id) {
  return entries.find((entry) => entry.id === id)
}

/** A short line for a list: "HLD, Shape stage, 3 comments from Ana and Ben, rendered abc1234". */
export function describeReview(entry, { artefactTitle, stageTitle } = {}) {
  const parts = [artefactTitle ?? entry.artefact, stageTitle ?? entry.stage].filter(Boolean)
  const who = entry.commenters?.length ? ` from ${entry.commenters.join(', ')}` : ''
  const answered = entry.commentsAnswered ? `, ${entry.commentsAnswered} answered` : ''
  return `${parts.join(', ')}: ${entry.comments} ${entry.comments === 1 ? 'comment' : 'comments'}${who}${answered}`
}
