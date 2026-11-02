// #299 (parent #238, decided in #247; docs/adr/0063, 0064, 0066, 0069): the AI interview **revises a Stage the Owner sent back**. This is the pure
// part of it, with no DOM and no network:
//
//   * `sentBackOf`          reads the answer to a Check status and says whether the Owner sent the Stage back (changes requested) or rejected it;
//   * `commentCards`        one card per comment on the Stage's Pull Request, resolved ones included, asked before the AI is called;
//   * `resolveCommentCard`, `commentAnswersText`  what an answer means, and what the AI is told;
//   * `revisionOpening`     the first message of a revision, which lists the comments for the AI;
//   * `staleLaterFields`    the Fields of a later Stage that were drafted from content the revision changed (by fingerprint), which get a keep / redraft round;
//   * `reopenOffer`         whether the AI may offer to re-open a signed-off Stage right now, and the open question it logs when it may not.
//
// The AI never writes to the Pull Request: no comments, no replies, no resolved threads. The comments are read through `GET /api/instance/pull-request-comments`
// and answered only in the decisions log (a **PR comment answered** entry); saved content changes only through keep / use the AI's version / merge cards.
import { findOutOfDateFields } from './outOfDate.js'
import { reopenOutlook } from './bringUpToDate.js'
import { fingerprintText } from './sourceDocuments.js'

/** The labels of the choices on a comment card. */
export const COMMENT_CHOICES = Object.freeze({
  change: 'Change the content',
  none: 'No change needed',
  open: 'Log an open question',
})

/** The labels of the two choices on the card shown when a Stage is sent back or rejected while the session is drafting ahead. */
export const SENT_BACK_CHOICES = Object.freeze({
  revise: (title) => `Revise ${title} with the AI`,
  stop: 'Stop the session here',
})

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim()
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

// ---------- the Owner sent the Stage back ----------

/**
 * What the Provider said about the Stage's Pull Request, from the body of a Check status: `{ kind, stageId, stageTitle, pullRequestId }`, where
 * `kind` is `changes-requested` (the Owner asked for changes) or `rejected` (a reject vote, or a Pull Request closed without merging); null when the
 * Stage was not sent back (pending, approved, merged).
 */
export function sentBackOf(body) {
  if (!body || body.merged) return null
  const state = body.review?.state
  const kind = state === 'rejected' || body.prStatus === 'abandoned' ? 'rejected' : state === 'changes-requested' ? 'changes-requested' : null
  if (!kind) return null
  return { kind, stageId: body.stage?.id ?? null, stageTitle: body.stage?.title ?? body.stage?.id ?? 'The Stage', pullRequestId: body.pullRequestId ?? null }
}

// ---------- the comments ----------

/** A comment's web address: the Provider's own for a GitHub comment, else the Pull Request's with the thread (Azure DevOps), else the Pull Request. */
export function commentLink(comment, pullRequestLink) {
  if (comment?.url) return comment.url
  if (!pullRequestLink) return null
  return comment?.threadId ? `${pullRequestLink}?discussionId=${comment.threadId}` : pullRequestLink
}

/** The first `max` characters of a comment, on one line. */
export function commentExcerpt(body, max = 200) {
  const text = oneLine(body)
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

const whereOf = (comment) => (comment.path ? ` on ${String(comment.path).replace(/^\/+/, '').replace(/^gantry-workspace\/[^/]+\//, '')}${comment.line ? ` (line ${comment.line})` : ''}` : '')

/** The comments as the conversation shows them: who wrote each, where, whether the thread was resolved, and the words. */
export function commentsMessage(comments, { pullRequestId = null, stageTitle = 'this Stage' } = {}) {
  const lines = comments.map((c, i) => `${i + 1}. ${c.author || 'Someone'}${whereOf(c)}${c.resolved ? ' (resolved)' : ''}: ${commentExcerpt(c.body, 240)}`)
  return `${stageTitle} was sent back. ${comments.length} comment${comments.length === 1 ? '' : 's'} on Pull Request${pullRequestId ? ` #${pullRequestId}` : ''}, resolved ones included:\n${lines.join('\n')}`
}

/**
 * The cards of the round, one per comment, ready for the Interview page: `type: 'comment'`, a recommendation pre-selected, an "Other" for the
 * architect's own words. Each card's `comment` holds what answering it means. Comments in the same thread are separate cards: each was said.
 */
export function commentCards({ comments = [], pullRequestId = null, pullRequestUrl = null, stageTitle = 'this Stage' } = {}) {
  return comments.map((comment) => {
    const excerpt = commentExcerpt(comment.body)
    const resolved = comment.resolved === true
    const options = [
      {
        label: COMMENT_CHOICES.change,
        description: 'The AI redrafts the Field or Fields this is about, from the comment. You see its version before anything is saved, and choose to keep what is saved, use its version, or merge.',
      },
      { label: COMMENT_CHOICES.none, description: 'The content already answers it. Nothing is changed. Say why in "Other" if you want the reason kept.' },
      { label: COMMENT_CHOICES.open, description: 'Record it as an open question in the decisions log, to settle later. Nothing is changed.' },
    ]
    const recommended = [resolved ? COMMENT_CHOICES.none : COMMENT_CHOICES.change]
    return {
      id: `comment:${comment.id}`,
      type: 'comment',
      kind: 'comment',
      header: `${comment.author || 'Owner'} · Pull Request${pullRequestId ? ` #${pullRequestId}` : ''}`,
      question: `${comment.author || 'The Owner'} wrote${whereOf(comment)}${resolved ? ' (the thread is resolved)' : ''}: “${excerpt}” What should ${stageTitle} do about it?`,
      options,
      multiSelect: false,
      recommended,
      why: resolved ? 'The Owner marked this thread resolved on the Provider, so it was probably dealt with already.' : 'The Owner raised it when they sent the Stage back.',
      source: null,
      field: null,
      allowOther: true,
      selected: [...recommended],
      otherOn: false,
      otherText: '',
      comment: {
        id: comment.id,
        author: comment.author || '',
        url: commentLink(comment, pullRequestUrl),
        excerpt,
        body: asText(comment.body),
        path: comment.path ?? null,
        line: comment.line ?? null,
        resolved,
        pullRequestId,
      },
    }
  })
}

/**
 * The outcome of one answered comment card: `{ id, outcome, words, card }`, where `outcome` is `change` (the AI redrafts), `no-change`,
 * `open-question`, or `other` (the architect's own words, which are followed as they wrote them).
 */
export function resolveCommentCard(card, ownWords = '') {
  const chosen = card.selected?.[0]
  const base = { id: card.comment?.id, words: ownWords, card }
  if (card.otherOn && ownWords) return { ...base, outcome: 'other' }
  if (chosen === COMMENT_CHOICES.change) return { ...base, outcome: 'change' }
  if (chosen === COMMENT_CHOICES.open) return { ...base, outcome: 'open-question' }
  return { ...base, outcome: 'no-change' }
}

/** True when an answered comment card needs the AI to write something. */
export const commentNeedsAi = (result) => result.outcome === 'change' || result.outcome === 'other'

/** What the AI is told after the round: each comment, and what the architect decided. */
export function commentAnswersText(results) {
  return results
    .map((r) => {
      const c = r.card.comment
      // The AI is never told who wrote a comment (ADR-0066): real names stay in the repo, in the decisions log.
      const head = `- A reviewer's comment${whereOf(c)}${c.resolved ? ' (resolved)' : ''}: “${c.body}”`
      if (r.outcome === 'change') return `${head}\n  CHANGE THE CONTENT. Work out which Field or Fields this is about and redraft them with draft_field. A Field that holds saved content meets a keep / use your version / merge card, so do not draft it again until the architect has answered.`
      if (r.outcome === 'other') return `${head}\n  THE ARCHITECT'S OWN WORDS: “${r.words}”. Do what they say, in the Fields it is about, with draft_field.`
      if (r.outcome === 'open-question') return `${head}\n  LOGGED AS AN OPEN QUESTION by Gantry. Change nothing for it.`
      return `${head}\n  NO CHANGE NEEDED${r.words ? `: “${r.words}”` : ''}. Do not propose a change for it.`
    })
    .join('\n')
}

/** The message a revision opens with: the comments the AI is to treat, and the rules that hold for it (the AI never writes to the Pull Request). */
export const REVISION_OPENING =
  'Revise this Stage. The Owner sent it back from its Pull Request, and Gantry read every comment on it, resolved ones included. ' +
  'The architect has been shown a card for each comment, and their answers are below. Work only on what they chose to change. ' +
  'You never write to the Pull Request: no comments, no replies, no resolving threads; the architect tells the Owner when it is ready. ' +
  'Saved content changes only through the keep / use your version / merge cards. Do not begin the interview again, and do not ask about anything else; when the redrafts are done, say so in one line.'

// ---------- later drafts the revision made stale ----------

/**
 * The Fields of Stages after `revisedStageId` that were drafted from content the revision changed, found by fingerprint (the decisions log
 * remembers what each Field's inputs read as when it was drafted; the saved content now reads differently): `{ field, inputField, stages }[]`.
 *
 * @param {object} input
 * @param {{id: string}[]} input.stages  the Stages in order
 * @param {string} input.revisedStageId
 * @param {Record<string, object>} input.logs  every Stage's committed decisions log
 * @param {object[]} input.modules  the saved content of every Module, with the revision in it
 * @param {Record<string, string[]>} input.stageModules  `{ stageId: [moduleId] }`
 */
export function staleLaterFields({ stages = [], revisedStageId, logs = {}, modules = [], stageModules = {} } = {}) {
  const order = stages.map((s) => s.id)
  const at = order.indexOf(revisedStageId)
  if (at === -1) return []
  const later = new Set(order.slice(at + 1))
  return findOutOfDateFields({ sources: [], logs, modules, stageModules })
    .filter((flag) => flag.cause === 'field' && flag.stages.some((id) => later.has(id)))
    .map((flag) => ({ field: flag.field, inputField: flag.inputField, stages: flag.stages.filter((id) => later.has(id)) }))
}

/** The fingerprint of a Field's saved text, for the answer that records what it read as when the architect decided. */
export const fingerprintOf = (value) => fingerprintText(asText(value))

// ---------- re-opening a signed-off Stage ----------

/**
 * Whether the AI may offer to re-open `targetId` right now, judged from what the page knows (ADR-0026; the server has the last word):
 * `{ allowed, blocker }`. Only the Stage just before the current one can be re-opened, and only while no Stage after it has a branch.
 */
export function reopenOffer({ stages = [], currentStageId, targetId, inProgress = [] } = {}) {
  return reopenOutlook({ stages, currentStageId, targetId, inProgress })
}

/** The open question the session logs when the AI would have offered a re-open that Gantry would not allow, naming what stops it. */
export function reopenBlockedQuestion({ stageTitle, blocker, why = '' }) {
  return {
    question: `${stageTitle} is signed off, but approved content there may need to change${why ? `: ${oneLine(why).replace(/[.\s]+$/, '')}` : ''}. It cannot be re-opened now. What should happen?`,
    why: blocker || `${stageTitle} cannot be re-opened.`,
  }
}

/** The labels of the choices on a re-open card Gantry builds for a Stage it would let the architect re-open. */
export const REOPEN_CHOICES = Object.freeze({
  reopen: (title) => `Re-open ${title}`,
  later: 'Not now',
})

/** The card for a re-open the AI offered and Gantry allows: re-open the Stage, or not now. `question` is the AI's own reason. */
export function reopenCard({ id, stageId, stageTitle, question, why }) {
  const options = [
    { label: REOPEN_CHOICES.reopen(stageTitle), description: `Re-open ${stageTitle} (a new branch from main) so the content can be changed there and approved again. Unsaved drafts here are not carried over, so save first if you want to keep them.` },
    { label: REOPEN_CHOICES.later, description: 'Carry on without re-opening. The AI logs an open question so it is not forgotten.' },
  ]
  return {
    id,
    type: 'reopen',
    kind: 'reopen',
    header: `Re-open ${stageTitle}?`,
    question,
    options,
    multiSelect: false,
    recommended: [options[0].label],
    why: why || `${stageTitle} is signed off and Gantry allows it to be re-opened now.`,
    source: null,
    field: null,
    allowOther: false,
    selected: [options[0].label],
    otherOn: false,
    otherText: '',
    reopen: { stageId, stageTitle },
  }
}

/** The opening of a revision when the Owner sent the Stage back but left no comment Gantry could read: the AI asks the architect what the Owner wants changed. */
export const REVISION_NO_COMMENTS =
  'Revise this Stage. The Owner sent it back from its Pull Request, but Gantry found no comment on it to read. ' +
  'Ask the architect, with question cards, what the Owner wants changed, then redraft the Fields they name. ' +
  'You never write to the Pull Request: no comments, no replies, no resolving threads; the architect tells the Owner when it is ready. Saved content changes only through the keep / use your version / merge cards.'
