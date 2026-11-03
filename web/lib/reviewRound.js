// #303 (parent #238, decided in #251; docs/adr/0066, 0063, 0064): **review comments as a focused interview round**. A Reviewed copy that is
// kept with the Instance (web/lib/reviewedCopies.js) has its comment threads read and placed on Fields (web/lib/reviewedCopy.js). This file is the
// pure part of turning those into question cards, with no DOM and no network:
//
//   * `reviewUnits`          the questions a set of Reviewed copies asks: one per unresolved thread, one per commenter's tracked changes in a Field,
//                            one shared card for commenters whose tracked changes collide, and a card for what sits on no Field. Threads resolved in
//                            Word are not asked; they come back as a collapsed list that can be reopened
//   * `planReview`           which of those the Interview page on a Stage can act on, and where each change would land (the same rules as Bring up
//                            to date: in place, on the Stage's own branch, carried forward, a re-open, or an open question; never a drafted-ahead branch)
//   * `reviewCards`          the cards, with the recommendation following whether the Field changed since the render
//   * `resolveReviewCard`, `applyTrackedEdits`, `reviewAnswersText`   what an answer means, the edit applied by Gantry when it can, and what the AI is told
//
// **Privacy (ADR-0066).** The architect sees real names. The AI sees "Reviewer 1", "Reviewer 2": `reviewerLabels` fixes who is who and `scrubNames`
// removes a real name from any text on its way to the AI. Real names stay in the repo (the Reviewed copy, the manifest and the decisions log).
// Nothing here is applied without the architect's answer.
import { fieldBookmarkName } from './fieldBookmark.js'
import { normalizeSavedContent } from './interviewBrief.js'
import { fieldsInScope } from './interviewScope.js'
import { UPDATE_CHOICES, landingNote, planUpdateRound, stagesToUpdate } from './bringUpToDate.js'
import { plainText } from './reviewedCopy.js'

/** The labels of the choices on a review card. An accept-one-edit choice is `Accept <name>'s edit` and a re-open choice `Re-open <Stage>`. */
export const REVIEW_CHOICES = Object.freeze({
  accept: 'Accept the edit',
  revise: 'Revise',
  keep: 'Keep as is',
  cantSettle: "Can't settle yet",
  note: 'Note it',
  assign: 'Assign to a Field',
  openQuestion: UPDATE_CHOICES.openQuestion,
  leave: UPDATE_CHOICES.leave,
})

const ACCEPT_PREFIX = 'Accept '
const REOPEN_PREFIX = 'Re-open '

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim()
const unique = (list) => [...new Set(list.filter(Boolean))]
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

// ---------- who is who ----------

/**
 * "Reviewer 1", "Reviewer 2", ...: a label for each commenter across the Reviewed copies, in the order the copies were brought in (and
 * alphabetically within a copy), so a label does not change when another copy arrives. Returns a Map of real name to label.
 */
export function reviewerLabels(copies = []) {
  const labels = new Map()
  for (const copy of copies) {
    for (const name of [...asList(copy?.read?.commenters)].map((n) => String(n).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))) {
      if (!labels.has(name)) labels.set(name, `Reviewer ${labels.size + 1}`)
    }
  }
  return labels
}

/**
 * `text` with every commenter's real name (a Map from `reviewerLabels`, or any `name -> label` object) replaced by their label. The whole name
 * goes whatever its case; so does each part of it that is a name on its own (a first name the architect typed in a reply, say), where the text
 * spells it as the name does. It is one pass, so a label is never read as a name.
 */
export function scrubNames(text, labels) {
  const pairs = labels instanceof Map ? [...labels] : Object.entries(labels ?? {})
  const variants = []
  for (const [name, label] of pairs) {
    const full = String(name ?? '').trim()
    if (!full) continue
    variants.push({ text: full, label, exact: false })
    const parts = full.split(/\s+/)
    if (parts.length > 1) for (const part of parts) if (part.replace(/[^\p{L}]/gu, '').length >= 3) variants.push({ text: part, label, exact: true })
  }
  if (variants.length === 0) return String(text ?? '')
  variants.sort((a, b) => b.text.length - a.text.length)
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${variants.map((v) => escape(v.text)).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
  return String(text ?? '').replace(pattern, (hit) => {
    const exactMatch = variants.find((v) => v.exact && v.text === hit)
    if (exactMatch) return exactMatch.label
    const whole = variants.find((v) => !v.exact && v.text.toLowerCase() === hit.toLowerCase())
    return whole ? whole.label : hit
  })
}

// ---------- the questions ----------

const threadKey = (copyId, threadId) => `${copyId}:${threadId}`
const changesKey = (copyId, scope, author) => `${copyId}:changes:${scope}:${author}`

/** The keys of the threads and tracked-change groups the decisions logs say were answered (`review-answered` entries). */
export function answeredReviewKeys(logs) {
  const keys = new Set()
  const lists = Array.isArray(logs) ? logs : Object.values(logs ?? {})
  for (const log of lists) {
    for (const entry of log?.entries ?? []) if (entry?.kind === 'review-answered') for (const key of asList(entry.keys)) keys.add(String(key))
  }
  return keys
}

/** How many comments of each Reviewed copy the logs say were answered: `{ [reviewId]: n }`. A change-only entry counts once, as a thread does. */
export function answeredCounts(logs) {
  const seen = new Map()
  const lists = Array.isArray(logs) ? logs : Object.values(logs ?? {})
  for (const log of lists) {
    for (const entry of log?.entries ?? []) {
      if (entry?.kind !== 'review-answered' || !entry.review) continue
      const set = seen.get(entry.review) ?? new Set()
      for (const key of asList(entry.keys)) set.add(String(key))
      seen.set(entry.review, set)
    }
  }
  return Object.fromEntries([...seen].map(([id, keys]) => [id, keys.size]))
}

const copyName = (copy) => copy?.entry?.name || copy?.entry?.id || 'a Reviewed copy'

/**
 * Splits `copies` (`loadReviewedCopies`' result) into the questions to ask and the threads resolved in Word.
 *
 * A **part** is one thing a commenter said that is answered together: a thread with the tracked changes of the same commenter beside it, or
 * one commenter's tracked changes in one Field when they have no thread there. A **unit** is what one card asks: usually one part, but parts of
 * different commenters whose tracked changes touch the same paragraph disagree and share one card.
 *
 * @param {object} input
 * @param {object[]} input.copies  `{ entry, read, placed }` for each kept Reviewed copy (a copy that could not be read is skipped)
 * @param {Set<string>} [input.answered]  `answeredReviewKeys`
 * @param {Set<string>} [input.reopened]  thread keys of resolved threads the architect asked to have asked after all
 * @returns {{ units: object[], resolved: object[] }}
 */
export function reviewUnits({ copies = [], answered = new Set(), reopened = new Set() } = {}) {
  const units = []
  const resolved = []
  const place = (copy, group) => {
    const copyId = copy.entry.id
    const field = group.kind === 'field' ? group.field : null
    const fieldKey = field ? `${field.moduleId}.${field.fieldId}` : null
    const scope = fieldKey ?? group.kind
    const parts = []
    for (const thread of group.threads) {
      const key = threadKey(copyId, thread.id)
      if (thread.resolved && !reopened.has(key)) {
        resolved.push({ key, copyId, copyName: copyName(copy), field, kind: group.kind, thread, answered: answered.has(key) })
        continue
      }
      if (answered.has(key) && !reopened.has(key)) continue
      parts.push({ key, copyId, author: thread.author || '', thread, changes: [] })
    }
    for (const change of group.changes) {
      const author = change.author || ''
      const same = parts.filter((p) => p.thread && p.author === author)
      // A comment on a heading is about the section, not the words: a change goes with the same commenter's comment on the Field's own text.
      const target = same.find((p) => p.thread.paragraph === change.paragraph) ?? same.find((p) => !p.thread.onHeading)
      if (target) {
        target.changes.push(change)
        continue
      }
      const key = changesKey(copyId, scope, author)
      if (answered.has(key)) continue
      let standalone = parts.find((p) => p.key === key)
      if (!standalone) {
        standalone = { key, copyId, author, thread: null, changes: [] }
        parts.push(standalone)
      }
      standalone.changes.push(change)
    }
    // Commenters whose tracked changes touch the same paragraph disagree about it: they share one card.
    const groups = parts.map((part) => [part])
    const touches = (a, b) => a.changes.some((x) => b.changes.some((y) => x.paragraph !== null && x.paragraph !== undefined && x.paragraph === y.paragraph))
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const authorsA = new Set(groups[i].map((p) => p.author))
        const collides = groups[i].some((a) => groups[j].some((b) => !authorsA.has(b.author) && touches(a, b)))
        if (collides) {
          groups[i] = [...groups[i], ...groups[j]]
          groups.splice(j, 1)
          j = i
        }
      }
    }
    for (const members of groups) {
      units.push({
        id: members.map((p) => p.key).join('+'),
        kind: group.kind,
        copyId,
        copyName: copyName(copy),
        copyStage: copy.entry.stage || '',
        field,
        fieldKey,
        parts: members,
        authors: unique(members.map((p) => p.author)),
        disagree: unique(members.map((p) => p.author)).length > 1,
        bestGuess: members.some((p) => [p.thread, ...p.changes].some((item) => item?.placement?.confidence === 'low')),
        aboutTitle: members.map((p) => p.thread?.placement?.aboutTitle ?? p.changes[0]?.placement?.aboutTitle).find(Boolean) ?? '',
        copy,
      })
    }
  }
  for (const copy of copies) {
    if (!copy?.placed || !copy?.read) continue
    for (const group of copy.placed.groups) place(copy, group)
  }
  return { units, resolved }
}

// ---------- has the Field changed since the render? ----------

const norm = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '')

/** The wording of a Field as the Reviewed copy printed it (tracked insertions left out), from the paragraphs under its bookmark; '' when it has none. */
export function renderedFieldText(read, fieldKey) {
  const [moduleId, ...rest] = String(fieldKey).split('.')
  const bookmark = fieldBookmarkName(moduleId, rest.join('.'))
  return (read?.paragraphs ?? [])
    .filter((p) => asList(p.fields).includes(bookmark))
    .map((p) => squash(p.original))
    .filter(Boolean)
    .join('\n')
}

/**
 * Whether a Field's saved wording differs from the wording the document was rendered from. The render's wording is read from the document
 * itself (the paragraphs under the Field's bookmark), else from `basis` (the content at the render's commit, which a copy that lost its
 * bookmarks was placed against), else judged by whether the words the commenters touched are all still there. A server or Local workspace has no
 * history to compare with, so any Field that differs from the document counts as changed (ADR-0066).
 *
 * @returns {{ changed: boolean, rendered: string }}  `rendered` is the wording at the render, '' when it could not be found
 */
export function changedSinceRender({ read, basis = null, fieldKey, today, anchors = [] }) {
  const current = plainText(asText(today))
  let rendered = renderedFieldText(read, fieldKey)
  if (!rendered && basis?.fields) {
    const [moduleId, ...rest] = String(fieldKey).split('.')
    const found = basis.fields.find((f) => f.moduleId === moduleId && f.fieldId === rest.join('.'))
    if (found && found.text !== undefined) rendered = plainText(asText(found.text))
  }
  if (rendered) return { changed: norm(rendered) !== norm(current), rendered }
  const have = norm(current)
  const missing = anchors.map(norm).filter(Boolean).some((a) => !have.includes(a))
  return { changed: missing, rendered: '' }
}

// ---------- where the change lands ----------

/**
 * Which questions the Interview page on `pageStageId` asks, and where each change would land (the rules of Bring up to date: web/lib/bringUpToDate.js).
 * `items` are units with a `landing`, a `saved` wording for a Field and `changed` / `rendered` (has the Field changed since the render). A unit on a
 * Field of a drafted-ahead Stage goes to `deferred` and is never asked; on a local or server workspace one whose Module is edited on another Stage goes
 * to `elsewhere` (asked when the page is on that Stage). `resolved` are the threads resolved in Word. `stages` are the Stages that have questions
 * for a local or server workspace to go through, in order.
 */
export function planReview({ copies = [], logs = {}, reopened = new Set(), definition, pageStageId, currentStageId = pageStageId, remote = false, awaiting = [], inProgress = [], saved = [] } = {}) {
  const answered = answeredReviewKeys(logs)
  const { units, resolved } = reviewUnits({ copies, answered, reopened })
  const content = normalizeSavedContent(saved)
  const valueOf = (key) => {
    const [moduleId, ...rest] = String(key).split('.')
    return content[moduleId]?.fields?.[rest.join('.')]
  }
  const fieldUnits = units.filter((u) => u.kind === 'field')
  const flags = unique(fieldUnits.map((u) => u.fieldKey)).map((key) => ({
    field: key,
    cause: 'review',
    stages: unique(fieldUnits.filter((u) => u.fieldKey === key).map((u) => u.copyStage)),
  }))
  const round = planUpdateRound({ flags, definition, pageStageId, currentStageId, remote, awaiting, inProgress, saved })
  const landings = new Map(round.items.map((item) => [item.key, item.landing]))
  const deferredKeys = new Set(round.deferred.map((d) => d.key))
  const items = []
  const deferred = []
  const elsewhere = []
  for (const unit of units) {
    if (unit.kind !== 'field') {
      items.push({ ...unit, landing: { kind: 'in-place' }, saved: '', changed: null, rendered: '' })
      continue
    }
    const landing = landings.get(unit.fieldKey)
    if (!landing) {
      if (deferredKeys.has(unit.fieldKey)) deferred.push({ id: unit.id, key: unit.fieldKey, stageId: round.deferred.find((d) => d.key === unit.fieldKey)?.stageId ?? pageStageId })
      else elsewhere.push({ id: unit.id, key: unit.fieldKey, stageId: round.elsewhere.find((d) => d.key === unit.fieldKey)?.stageId ?? null })
      continue
    }
    const today = valueOf(unit.fieldKey)
    const anchors = unit.parts.flatMap((p) => [p.thread?.anchor?.original, ...p.changes.filter((c) => c.kind === 'deletion').map((c) => c.text)]).filter(Boolean)
    const since = changedSinceRender({ read: unit.copy.read, basis: unit.copy.basis ?? null, fieldKey: unit.fieldKey, today, anchors })
    // A Module a person marked `agreed` goes back to `draft` when a change to it is saved, and the card says so before it is answered (ADR-0066).
    const agreed = content[unit.field.moduleId]?.status === 'agreed'
    items.push({ ...unit, landing, saved: asText(today), changed: since.changed, rendered: since.rendered, agreed })
  }
  const elsewhereFlags = unique(elsewhere.map((e) => e.key)).map((key) => ({ field: key, cause: 'review', stages: [] }))
  const stages = stagesToUpdate({ flags: elsewhereFlags, definition, remote, currentStageId })
  return { items, deferred, elsewhere, resolved, stages }
}

// ---------- the cards ----------

/**
 * Where a paragraph a commenter inserted whole belongs: the wording of the paragraph above it, which is the paragraph it follows. `null` when the change is
 * not a whole new paragraph, or nothing above it has wording of its own (so Gantry cannot tell where it goes).
 */
function insertedAfter(read, change) {
  const at = change.paragraph
  const paragraphs = read?.paragraphs
  if (change.kind !== 'insertion' || at === null || at === undefined || !paragraphs?.[at] || squash(paragraphs[at].original) !== '') return null
  for (let i = at - 1; i >= 0; i--) {
    const above = squash(paragraphs[i].original)
    if (above) return above
  }
  return null
}

function sideOf(part, labels, read) {
  return {
    key: part.key,
    author: part.author,
    label: labels.get(part.author) ?? 'Reviewer',
    thread: part.thread
      ? {
          id: part.thread.id,
          author: part.thread.author,
          date: part.thread.date,
          text: part.thread.text,
          resolved: Boolean(part.thread.resolved),
          anchor: part.thread.anchor?.text ?? '',
          replies: asList(part.thread.replies).map((r) => ({ id: r.id, author: r.author, date: r.date, text: r.text })),
        }
      : null,
    changes: part.changes.map((c) => ({ kind: c.kind, author: c.author, date: c.date, text: c.text, paragraph: c.paragraph ?? null, order: c.order ?? 0, ...(insertedAfter(read, c) ? { after: insertedAfter(read, c) } : {}) })),
  }
}

const authorsWithEdits = (item) => unique(item.parts.filter((p) => p.changes.length).map((p) => p.author))

/** The first words of a comment, for a card's question. */
function brief(text, max = 90) {
  const t = squash(text)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * The cards of the round, one per unit in `items` (`planReview`'s), ready for the Interview page: `type: 'review'`, a recommendation pre-selected,
 * no "Other" (an optional `reason` box holds the architect's own words). Each card's `review` holds what answering it means.
 *
 * @param {object} input
 * @param {object[]} input.items
 * @param {Map<string,string>} input.labels  `reviewerLabels`
 * @param {(key: string) => string} [input.fieldTitle]
 * @param {(id: string) => string} [input.stageTitle]
 * @param {string} [input.pageStageTitle]
 * @param {{ key: string, title: string }[]} [input.fieldChoices]  the Fields in scope on this Stage, for "Assign to a Field"
 */
export function reviewCards({ items = [], labels = new Map(), fieldTitle = (key) => key, stageTitle = (id) => id, pageStageTitle = '', fieldChoices = [] } = {}) {
  return items.map((item) => {
    const sides = item.parts.map((p) => sideOf(p, labels, item.copy?.read))
    const who = item.authors.join(' and ') || 'A reviewer'
    const edits = authorsWithEdits(item)
    const hasEdit = edits.length > 0
    const title = item.field ? `${item.field.moduleTitle} · ${item.field.fieldTitle}` : fieldTitle(item.fieldKey ?? '')
    const firstText = item.parts.map((p) => p.thread?.text).find(Boolean)
    const blocked = item.landing.kind === 'reopen' || item.landing.kind === 'open-question'
    let kind
    let header
    let question
    let options
    let recommended
    let why
    if (item.kind !== 'field') {
      kind = item.kind
      header = item.kind === 'document' ? 'Review comment · about the document' : "Review comment · couldn't be placed"
      question = `${who} commented ${item.kind === 'document' ? `on ${item.aboutTitle || 'a part of the document Gantry supplies'}` : "where Gantry could not find a Field"}${firstText ? `: “${brief(firstText)}”` : ''}. What should happen to it?`
      options = [
        { label: REVIEW_CHOICES.note, description: 'Keep it in the log as a note and change nothing.' },
        ...(fieldChoices.length ? [{ label: REVIEW_CHOICES.assign, description: 'Choose the Field it is really about. It is then asked as a comment on that Field.' }] : []),
        { label: REVIEW_CHOICES.openQuestion, description: 'Record it as an open question to settle later. Nothing changes now.' },
      ]
      recommended = [item.kind === 'unplaced' && fieldChoices.length ? REVIEW_CHOICES.assign : REVIEW_CHOICES.note]
      why =
        item.kind === 'document'
          ? 'The cover, Document Control and the table of contents come from Gantry and the Definition, not from a Field, so a note is the safe default.'
          : 'Gantry could not match this to a Field, so you choose where it belongs.'
    } else if (blocked) {
      kind = 'blocked'
      header = 'Review comment · cannot change here'
      question = `${title}: ${who} commented${firstText ? ` “${brief(firstText)}”` : ''}. It cannot be changed from ${pageStageTitle}. What should happen?`
      const stage = stageTitle(item.landing.stageId)
      const open = { label: REVIEW_CHOICES.openQuestion, description: `Record it as an open question naming what stops the change: ${item.landing.blocker || 'nothing in this Stage can edit it'} The Field stays as it is.` }
      options =
        item.landing.kind === 'reopen'
          ? [
              { label: `${REOPEN_PREFIX}${stage}`, description: `Re-open ${stage} (a new branch from main), so the change can be made there and approved again. You confirm at the end of the round; re-opening drops the round's other unsaved answers, and the comment stays unanswered until then.` },
              open,
              { label: REVIEW_CHOICES.keep, description: 'Leave the Field as it is. The comment is logged as answered.' },
            ]
          : [open, { label: REVIEW_CHOICES.keep, description: 'Leave the Field as it is. The comment is logged as answered.' }, { label: REVIEW_CHOICES.leave, description: 'Change nothing and write nothing. The comment stays unanswered.' }]
      recommended = [options[0].label]
      why = item.landing.kind === 'reopen' ? `${stage} is approved and ${title} cannot be edited on ${pageStageTitle}, but Gantry allows ${stage} to be re-opened.` : item.landing.blocker || `${title} cannot be edited on ${pageStageTitle}.`
    } else {
      kind = item.disagree ? 'disagree' : hasEdit ? 'edit' : 'comment'
      header = item.disagree ? 'Review comment · reviewers disagree' : hasEdit ? 'Review comment · tracked change' : 'Review comment'
      question = item.disagree
        ? `${title}: ${item.authors.join(' and ')} changed the same wording differently. Which should stand?`
        : `${title}: ${who} ${hasEdit && !firstText ? 'tracked a change' : `commented${hasEdit ? ' and tracked a change' : ''}`}${firstText ? `: “${brief(firstText)}”` : ''}. What should happen?`
      const acceptLabels = edits.length > 1 ? edits.map((name) => `${ACCEPT_PREFIX}${name}'s edit`) : hasEdit ? [REVIEW_CHOICES.accept] : []
      const acceptDescription = (name) =>
        item.changed
          ? `Apply ${name ? `${name}'s` : 'the'} tracked change to what the Field says now. The Field has changed since the render, so it is applied only where their wording still matches; otherwise the AI applies it, and you see the result before anything is saved.`
          : `Make ${name ? `${name}'s` : 'the reviewer’s'} tracked change exactly as they tracked it. You see the result before anything is saved.`
      options = [
        ...acceptLabels.map((label, i) => ({ label, description: acceptDescription(edits.length > 1 ? edits[i] : '') })),
        { label: REVIEW_CHOICES.revise, description: item.changed ? 'The AI proposes one merged wording from the Field as it is now, the old wording and what the reviewer asked. You see its version and choose to keep what is saved, use its version, or merge.' : 'The AI redrafts the Field to deal with the comment. You see its version and choose to keep what is saved, use its version, or merge.' },
        { label: REVIEW_CHOICES.keep, description: 'Leave the Field exactly as it is. You can say why in your own words; it is logged.' },
        { label: REVIEW_CHOICES.cantSettle, description: 'Record it as an open question. The Field stays as it is, and it is not asked again.' },
      ]
      if (hasEdit && !item.changed && !item.disagree) {
        recommended = [acceptLabels[0]]
        why = 'The Field is unchanged since the render, so the reviewer’s edit applies as they wrote it.'
      } else if (item.disagree) {
        recommended = [REVIEW_CHOICES.revise]
        why = `${item.authors.length} reviewers changed the same wording, so no single edit is the obvious answer: the AI weighs them and proposes one wording for you to check.`
      } else if (item.changed) {
        recommended = [REVIEW_CHOICES.revise]
        why = hasEdit ? 'The Field has changed since the render, so the reviewer’s edit may no longer fit. The AI proposes a merged wording and nothing is applied automatically.' : 'The Field has changed since the render, so the AI proposes a wording that takes both into account.'
      } else {
        recommended = [REVIEW_CHOICES.revise]
        why = 'A reviewer asked for something; the AI drafts it and you see it before anything is saved.'
      }
    }
    const note = item.kind === 'field' ? landingNote(item.landing, { stageTitle, currentTitle: pageStageTitle }) : ''
    return {
      id: `review:${item.id}`,
      type: 'review',
      kind: 'review',
      header,
      question,
      options,
      multiSelect: false,
      recommended,
      why,
      source: null,
      field: item.fieldKey ?? undefined,
      allowOther: false,
      selected: [...recommended],
      otherOn: false,
      otherText: '',
      reason: '',
      assignTo: '',
      review: {
        unitKind: kind,
        field: item.fieldKey,
        fieldTitle: title,
        copy: { id: item.copyId, name: item.copyName },
        sides,
        disagree: item.disagree,
        bestGuess: item.bestGuess,
        changed: item.changed,
        rendered: item.rendered,
        saved: item.saved,
        landing: item.landing,
        note,
        aboutTitle: item.aboutTitle,
        agreedNote: item.agreed ? `${item.field.moduleTitle} is agreed. Accepting or revising a change to it returns it to draft, and a person has to agree it again.` : '',
        assign: item.kind === 'field' ? null : fieldChoices.map((c) => ({ key: c.key, title: c.title })),
        keys: item.parts.map((p) => p.key),
      },
    }
  })
}

/** True when an answered card still needs something from the architect: "Assign to a Field" with no Field picked. */
export const reviewNeedsInput = (card) => card.type === 'review' && card.selected[0] === REVIEW_CHOICES.assign && !card.assignTo

// ---------- what an answer means ----------

/**
 * The outcome of one answered card: `{ key, card, outcome, words, ... }`. `outcome` is `accept` (with `by`, the commenter whose edit, when the card
 * offered one each), `revise`, `keep`, `cant-settle` (an open question), `note`, `assign` (with `assignTo`, a Field key), `reopen` (re-open the Stage once
 * the round is saved, with `stageId`) or `leave` (nothing is written and the comment stays unanswered). `words` is what the architect wrote in the
 * card's own box, if anything.
 */
export function resolveReviewCard(card) {
  const chosen = card.selected[0]
  const words = squash(card.reason)
  const base = { key: card.field ?? null, card, words }
  if (chosen === REVIEW_CHOICES.accept) return { ...base, outcome: 'accept', by: null }
  if (typeof chosen === 'string' && chosen.startsWith(ACCEPT_PREFIX) && chosen.endsWith("'s edit")) return { ...base, outcome: 'accept', by: chosen.slice(ACCEPT_PREFIX.length, -"'s edit".length) }
  if (chosen === REVIEW_CHOICES.revise) return { ...base, outcome: 'revise' }
  if (chosen === REVIEW_CHOICES.keep) return { ...base, outcome: 'keep' }
  if (chosen === REVIEW_CHOICES.cantSettle || chosen === REVIEW_CHOICES.openQuestion) return { ...base, outcome: 'cant-settle' }
  if (chosen === REVIEW_CHOICES.note) return { ...base, outcome: 'note' }
  if (chosen === REVIEW_CHOICES.assign && card.assignTo) return { ...base, outcome: 'assign', assignTo: card.assignTo }
  if (typeof chosen === 'string' && chosen.startsWith(REOPEN_PREFIX)) return { ...base, outcome: 'reopen', stageId: card.review?.landing?.stageId }
  return { ...base, outcome: 'leave' }
}

// ---------- applying a reviewer's tracked edit ----------

/**
 * The Field's wording with a commenter's tracked changes made, when they can be made without guessing: each deleted run of words is replaced by the
 * insertion beside it (paired in order within a paragraph) or removed, and the deleted words occur exactly once in the Field. A whole new paragraph goes
 * after the paragraph it followed in the document (`change.after`, its wording, which must occur once in the Field). Words inserted with nothing deleted
 * have no place to go, and a deletion that is not in the text, or is in it twice, cannot be located, so those return `{ ok: false, reason }` and the AI is asked
 * to make the edit instead. `value` is a string or a list of items. Nothing is written here.
 *
 * @param {string|string[]} value
 * @param {{ kind: 'insertion'|'deletion', text: string, paragraph?: number|null, order?: number }[]} changes
 * @returns {{ ok: true, value: string|string[] } | { ok: false, reason: string }}
 */
export function applyTrackedEdits(value, changes) {
  const list = asList(changes).filter((c) => c && squash(c.text) !== '')
  if (list.length === 0) return { ok: false, reason: 'There is no tracked change to apply.' }
  const byParagraph = new Map()
  const added = []
  for (const change of [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    // A whole paragraph the reviewer inserted goes after the paragraph it followed in the document.
    if (change.kind === 'insertion' && change.after) {
      added.push({ after: squash(change.after), text: squash(change.text) })
      continue
    }
    const key = change.paragraph ?? 'none'
    const entry = byParagraph.get(key) ?? { deletions: [], insertions: [] }
    entry[change.kind === 'deletion' ? 'deletions' : 'insertions'].push(change)
    byParagraph.set(key, entry)
  }
  const edits = []
  for (const { deletions, insertions } of byParagraph.values()) {
    if (deletions.length === 0) return { ok: false, reason: 'The reviewer inserted words with nothing deleted beside them, so Gantry cannot tell where they go.' }
    if (insertions.length !== 0 && insertions.length !== deletions.length) return { ok: false, reason: 'The reviewer’s insertions and deletions do not pair up one for one.' }
    deletions.forEach((d, i) => edits.push({ from: squash(d.text), to: insertions[i] ? squash(insertions[i].text) : '' }))
  }
  const items = Array.isArray(value) ? value.map(String) : [String(value ?? '')]
  for (const edit of edits) {
    // A run of words may have been wrapped across lines in the Field, so the deleted words are looked for with any run of white space.
    const source = edit.from.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    const found = items.reduce((n, item) => n + (item.match(new RegExp(source, 'g'))?.length ?? 0), 0)
    if (found === 0) return { ok: false, reason: `“${edit.from}” is no longer in the Field.` }
    if (found > 1) return { ok: false, reason: `“${edit.from}” is in the Field more than once, so Gantry cannot tell which the reviewer meant.` }
    // A deleted run takes the space before it with it, so no double space is left; a whole deleted paragraph leaves no run of blank lines.
    const replacing = edit.to !== ''
    const pattern = new RegExp(replacing ? source : `[ \\t]?${source}`, 'g')
    for (let i = 0; i < items.length; i++) {
      const edited = items[i].replace(pattern, () => edit.to)
      items[i] = replacing ? edited : edited.replace(/\n{3,}/g, '\n\n')
    }
  }
  for (const add of added) {
    const source = add.after.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    const at = items.map((item, i) => [i, [...item.matchAll(new RegExp(source, 'g'))]]).filter(([, hits]) => hits.length > 0)
    if (at.length === 0) return { ok: false, reason: `“${add.after}”, which the reviewer’s new paragraph follows, is no longer in the Field.` }
    if (at.length > 1 || at[0][1].length > 1) return { ok: false, reason: `“${add.after}”, which the reviewer’s new paragraph follows, is in the Field more than once.` }
    const [i, [hit]] = [at[0][0], at[0][1]]
    if (Array.isArray(value)) {
      items.splice(i + 1, 0, add.text)
    } else {
      const end = items[i].indexOf('\n\n', hit.index + hit[0].length)
      const split = end === -1 ? items[i].length : end
      items[i] = `${items[i].slice(0, split)}\n\n${add.text}${items[i].slice(split)}`
    }
  }
  const next = Array.isArray(value) ? items.filter((item) => item.trim() !== '') : items[0]
  if (asText(next) === asText(value)) return { ok: false, reason: 'Making the tracked change leaves the Field as it was.' }
  return { ok: true, value: next }
}

/** The tracked changes an `accept` answer applies: the named commenter's, or all of the card's when it did not name one. */
export function editsToAccept(card, by) {
  const sides = asList(card.review?.sides)
  const chosen = by ? sides.filter((s) => s.author === by) : sides
  return chosen.flatMap((s) => s.changes)
}

// ---------- what the AI is told ----------

const quote = (text) => `“${squash(text)}”`

/** The comment, replies and tracked changes of one side, with every real name replaced by its label, as the AI is told them. */
function sideText(side, labels) {
  const lines = []
  const who = (name) => labels.get(name) ?? side.label
  if (side.thread) {
    lines.push(`${who(side.thread.author)} commented${side.thread.anchor ? ` on ${quote(scrubNames(side.thread.anchor, labels))}` : ''}: ${quote(scrubNames(side.thread.text, labels))}`)
    for (const reply of side.thread.replies) lines.push(`  ${who(reply.author)} replied: ${quote(scrubNames(reply.text, labels))}`)
  }
  for (const change of side.changes) lines.push(`${who(change.author)} tracked ${change.kind === 'insertion' ? 'an insertion' : 'a deletion'}: ${quote(scrubNames(change.text, labels))}`)
  return lines
}

/**
 * What the AI is told after the round, one block per answered card. Real names never appear in it: every commenter is "Reviewer N" and the
 * comment texts are scrubbed. `applied` is the set of card ids whose accepted edit Gantry has already put in the preview.
 */
export function reviewAnswersText(results, { fieldTitle = (key) => key, labels = new Map(), applied = new Set(), keyDecisions = false } = {}) {
  const out = []
  for (const r of results) {
    const key = r.key ?? r.assignTo
    const title = key ? fieldTitle(key) : 'the document'
    const sides = asList(r.card.review?.sides)
    const detail = sides.flatMap((s) => sideText(s, labels)).map((l) => `    ${l}`).join('\n')
    const own = r.words ? `\n    The architect's own words: ${quote(scrubNames(r.words, labels))}` : ''
    const staleness = r.card.review?.changed
      ? `\n    The Field changed since the render. At the render it said: ${quote(scrubNames(r.card.review.rendered || '(not known)', labels))}. It says now: ${quote(scrubNames(r.card.review.saved || '(empty)', labels))}. Propose ONE wording that takes both into account.`
      : ''
    if (r.outcome === 'accept') {
      if (applied.has(r.card.id)) out.push(`- ${key} (${title}): ACCEPTED. Gantry made the tracked change itself and it is in the preview. Nothing for you to do.`)
      else out.push(`- ${key} (${title}): ACCEPT THE EDIT. Make the reviewer's tracked change below to the Field, word for word, and change nothing else. Call draft_field once. It holds saved content, so Gantry shows the architect a keep / use your version / merge card; do not draft it again until they have answered.\n${detail}${staleness}${own}`)
    } else if (r.outcome === 'revise' || r.outcome === 'assign') {
      out.push(`- ${key} (${title}): REVISE. Redraft the Field to deal with the review comment below. Call draft_field once. It holds saved content, so Gantry shows the architect a keep / use your version / merge card; do not draft it again until they have answered.\n${detail}${staleness}${own}`)
    } else if (r.outcome === 'keep') {
      out.push(`- ${key ?? 'the document'} (${title}): KEPT as it is. Do not propose a change to it for this comment.${own}`)
    } else if (r.outcome === 'cant-settle') {
      out.push(
        `- ${key ?? 'the document'} (${title}): CANNOT BE SETTLED YET. Gantry logged an open question. Change nothing.${keyDecisions ? ' If, and only if, it is hard to reverse, surprising without context and a real trade-off, you may offer it as a Key decision card (kind "decision").' : ''}\n${detail}${own}`
      )
    } else if (r.outcome === 'note') {
      out.push(`- the document: NOTED. Gantry logged it as a note. Nothing for you to do.`)
    } else {
      out.push(`- ${key ?? 'the document'} (${title}): cannot be changed on this Stage. Leave it alone.`)
    }
  }
  return out.join('\n')
}

/** True when an answered card needs the AI to write something (or, with Key decisions mounted, to consider offering one). */
export const reviewNeedsAi = (result, { applied = new Set(), keyDecisions = false } = {}) =>
  (result.outcome === 'accept' && !applied.has(result.card.id)) || result.outcome === 'revise' || result.outcome === 'assign' || (result.outcome === 'cant-settle' && keyDecisions)

/** What the AI is told to begin a session that is only working through review comments. */
export const REVIEW_OPENING =
  'Work through the review comments. Reviewers commented on a Word document Gantry rendered, and the architect has answered a card for each thread. ' +
  'The answers are below. Work only on the Fields they chose to accept or revise. Do not begin the interview, do not read the Source documents for anything else, ' +
  'and do not ask about anything else; when you are done, say so in one line. Reviewers are named "Reviewer 1", "Reviewer 2": use only those names, never a real one.'

/** The line added to the next round of a session that is already going, telling the AI review questions are in it. */
export const REVIEW_JOINED_NOTE = 'Some cards in this round are review comments the architect is answering alongside the interview. Their answers come back with the rest.'

// ---------- the decisions log ----------

/**
 * The `review-answered` entries (ADR-0066) one answered card writes, one per thread (a change-only group counts as one): the Reviewed copy and the
 * thread id, the commenter's real name and the date, the comment, its replies and the tracked changes word for word, the Fields and whether each
 * changed since the render, and the outcome with the architect's words. Each stands on its own, with no need for the file. Returns
 * `[{ keys, review, reviewName, threads, changes, fields, changedSinceRender, outcome, words, ... }]`.
 */
export function reviewEntriesFor(result, { stage, openedQuestion = '' } = {}) {
  const review = result.card.review ?? {}
  const sides = asList(review.sides)
  const outcome = result.outcome === 'assign' ? 'assign' : result.outcome
  const fieldKey = result.outcome === 'assign' ? result.assignTo : review.field
  return sides.map((side) => ({
    review: review.copy?.id,
    reviewName: review.copy?.name,
    keys: [side.key],
    threads: side.thread
      ? [{ id: side.thread.id, author: side.thread.author, date: side.thread.date, text: side.thread.text, anchor: side.thread.anchor, replies: side.thread.replies.map((r) => ({ author: r.author, date: r.date, text: r.text })) }]
      : [],
    changes: side.changes.map((c) => ({ kind: c.kind, author: c.author, date: c.date, text: c.text })),
    fields: fieldKey ? [fieldKey] : [],
    ...(fieldKey && review.changed !== null && review.changed !== undefined && result.outcome !== 'assign' ? { changedSinceRender: { [fieldKey]: Boolean(review.changed) } } : {}),
    outcome,
    ...(result.by ? { accepted: result.by } : {}),
    ...(result.words ? { words: result.words } : {}),
    ...(review.landing?.kind === 'carry-forward' ? { stage: review.landing.stageId } : stage ? { stage } : {}),
    ...(review.unitKind === 'disagree' ? { sharedCard: true } : {}),
    ...(review.aboutTitle ? { about: review.aboutTitle } : {}),
    ...(openedQuestion ? { openQuestion: openedQuestion } : {}),
  }))
}

/** The sentence an open question made by "Can't settle yet" holds. Real names do not appear in it: it is carried into the Open questions module. */
export function reviewOpenQuestion(result, { fieldTitle = (key) => key, labels = new Map() } = {}) {
  const review = result.card.review ?? {}
  const side = asList(review.sides)[0]
  const text = side?.thread?.text ?? side?.changes?.[0]?.text ?? ''
  const where = review.field ? fieldTitle(review.field) : review.aboutTitle || 'the document'
  const who = asList(review.sides).map((s) => labels.get(s.author) ?? s.label).filter(Boolean)
  return `Review comment on ${where} is not settled: ${quote(scrubNames(brief(text, 200), labels))} (${unique(who).join(', ') || 'a reviewer'}). What should happen?`
}

/** Fields in scope on a Stage as `[{ key, title }]`, for "Assign to a Field". */
export function assignChoices(definition, stageId) {
  return [...fieldsInScope(definition, stageId)].map(([key, entry]) => ({ key, title: `${entry.module.title ?? entry.module.id} · ${entry.field.title ?? entry.field.id}` }))
}
