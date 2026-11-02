// #287 (parent #238, docs/adr/0065 and #243): **rounds of question cards**. The AI asks every question whose prerequisites
// are settled as one round; Gantry shows the cards four at a time with Next and Back and the round is submitted together.
// This file is the pure part of that: which cards of a round are ready, in what order, how they page, what the card for a
// select Field looks like, what counts as an answer and how the answers are written back to the AI.
//
//   * The **dependency tree** decides what is ready to ask. A card names the cards it waits for in `after`; Gantry holds it
//     back until they are answered (`splitReady`). The AI's own judgement of the tree is the other half of the rule.
//   * Gantry's **priority order** only sorts the cards within a round (`sortRound`): Fields this Gate requires, then Source
//     documents that disagree, then missing facts, then optional Fields.
//   * A card for a **select Field** shows exactly the Definition's `options` and no "Other" (`shapeCard`).
//   * Every other card gets an "Other", added here rather than by the model, which opens a free-text box.
//
// No DOM, no network: tests/interviewRounds.test.js drives all of it.

/** Cards shown at a time. */
export const PAGE_SIZE = 4

/** The labels of the three choices on a card about saved content that the AI would like to change (ADR-0065, rule 3). */
export const CHANGE_OPTIONS = Object.freeze({
  keep: 'Keep',
  use: "Use the AI's version",
  merge: 'Merge',
})

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

/**
 * The sort key of a card: 0 a Field this Gate requires, 1 Source documents that disagree (a term card is one of these: the
 * names differ, #291), 2 a missing fact, 3 anything else (optional Fields).
 */
export function cardPriority(card, requiredKeys = new Set()) {
  if (card.field && requiredKeys.has(card.field)) return 0
  if (card.kind === 'disagreement' || card.kind === 'term') return 1
  if (card.kind === 'missing') return 2
  return 3
}

/** The cards of a round in Gantry's priority order. The sort is stable, so the AI's own order stands within a priority. */
export function sortRound(cards, requiredKeys = new Set()) {
  return cards.map((card, index) => ({ card, index })).sort((a, b) => cardPriority(a.card, requiredKeys) - cardPriority(b.card, requiredKeys) || a.index - b.index).map((x) => x.card)
}

/**
 * Splits the cards the AI just asked into those ready to show and those that must wait. A card waits while any card in
 * its `after` is still open: asked in this batch or held, and not answered. An id that was never asked is not waited for
 * (there is nothing to wait on). If every card waits on another (a loop), they are all shown rather than none.
 *
 * `answeredIds` is the ids already answered; `pendingIds` is the ids of cards already held back (and so still open).
 */
export function splitReady(cards, answeredIds = new Set(), pendingIds = new Set()) {
  const answered = new Set(answeredIds)
  const open = new Set([...pendingIds, ...cards.map((c) => c.id)])
  for (const id of answered) open.delete(id)
  const blocked = (card) => (card.after ?? []).some((id) => id !== card.id && open.has(id))
  const ready = cards.filter((c) => !blocked(c))
  const held = cards.filter((c) => blocked(c))
  if (ready.length === 0 && held.length > 0) return { ready: held, held: [] }
  return { ready, held }
}

/**
 * From the cards held back, those that can now be shown: every card they wait on is answered, or is no longer open.
 * `openIds` is the ids of cards being asked now and not yet answered. Returns `{ released, held }`.
 */
export function releaseHeld(held, answeredIds, openIds = []) {
  const answered = new Set(answeredIds)
  const open = new Set([...held.map((c) => c.id), ...openIds])
  for (const id of answered) open.delete(id)
  const released = held.filter((c) => !(c.after ?? []).some((id) => id !== c.id && open.has(id)))
  return { released, held: held.filter((c) => !released.includes(c)) }
}

/** The number of pages a round of `count` cards makes, at least one. */
export function pageCount(count, size = PAGE_SIZE) {
  return Math.max(1, Math.ceil(count / size))
}

/** The cards on `page` (0-based), clamped into range. */
export function pageCards(cards, page, size = PAGE_SIZE) {
  const last = pageCount(cards.length, size) - 1
  const at = Math.min(Math.max(0, page), last)
  return cards.slice(at * size, at * size + size)
}

// ---------- a card as the architect sees it ----------

/** The default id the validator hands a card the AI gave none: `q-1`, `q-2`, ... Only these are renamed, so a card the AI named keeps its name. */
export const isAutoId = (id) => /^q-\d+$/.test(String(id))

/**
 * A card from the validator (web/lib/aiCards.js) made ready to show: a select Field's card gets exactly the Definition's
 * options (no "Other", one choice unless the Field allows several, the recommendation mapped onto them); every other card
 * gets "Other". `entry` is the Field's `{ module, field }` from `fieldsInScope`, when the card feeds one.
 * Adds `allowOther`, `selected` (the recommendation, pre-selected), `otherOn` and `otherText`.
 */
export function shapeCard(card, entry) {
  const field = entry?.field
  let { options, recommended, multiSelect } = card
  let allowOther = true
  if (field?.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
    allowOther = false
    multiSelect = field.multiple === true
    const described = new Map(card.options.map((o) => [o.label.toLowerCase(), o]))
    options = field.options.map((label) => ({ label, description: described.get(String(label).toLowerCase())?.description ?? '', draft: described.get(String(label).toLowerCase())?.draft ?? '' }))
    recommended = recommended.map((r) => options.find((o) => same(o.label, r))?.label).filter(Boolean)
    if (recommended.length === 0 && field.default !== undefined && options.some((o) => o.label === field.default)) recommended = [field.default]
    if (!multiSelect) recommended = recommended.slice(0, 1)
  }
  return { ...card, options, recommended, multiSelect, allowOther, selected: [...recommended], otherOn: false, otherText: '' }
}

/** A card about saved content the AI would change: keep, use the AI's version, or merge. The recommendation is to keep. */
export function changeCard({ key, fieldTitle, saved, proposed, handEdit = false }) {
  return {
    id: `change:${key}`,
    type: 'change',
    header: handEdit ? 'Your edit' : 'Saved content',
    question: handEdit ? `${fieldTitle} is your own wording: you edited it by hand. The AI would change it. What should happen?` : `${fieldTitle} already holds content. The AI would change it. What should happen?`,
    options: [
      { label: CHANGE_OPTIONS.keep, description: handEdit ? 'Leave your edit exactly as it is.' : 'Leave what is saved exactly as it is.', draft: '' },
      { label: CHANGE_OPTIONS.use, description: handEdit ? 'Put the AI’s version in the preview in place of your edit. Nothing is written until you save the Stage.' : 'Put the AI’s version in the preview in place of what is saved. Nothing is written until you save the Stage.', draft: '' },
      { label: CHANGE_OPTIONS.merge, description: handEdit ? 'The AI writes one version that keeps what is good in your edit and in its own.' : 'The AI writes one version that keeps what is good in both.', draft: '' },
    ],
    multiSelect: false,
    recommended: [CHANGE_OPTIONS.keep],
    why: handEdit ? 'Your own wording changes only when you say so, so keeping it is the safe default.' : 'Saved content changes only when you say so, so keeping it is the safe default.',
    source: null,
    field: key,
    allowOther: false,
    selected: [CHANGE_OPTIONS.keep],
    otherOn: false,
    otherText: '',
    change: { saved, proposed, ...(handEdit ? { handEdit: true } : {}) },
  }
}

/** Whether the architect has given an answer to a card. */
export function isAnswered(card) {
  return card.selected.length > 0 || (card.otherOn && card.otherText.trim() !== '')
}

/** What a click on option `label` does to the card's selection. Returns the card changed. */
export function choose(card, label) {
  if (!card.options.some((o) => o.label === label)) return card
  if (card.multiSelect) {
    const selected = card.selected.includes(label) ? card.selected.filter((l) => l !== label) : [...card.selected, label]
    return { ...card, selected }
  }
  return { ...card, selected: [label], otherOn: false }
}

/** What a click on "Other" does. */
export function chooseOther(card) {
  if (!card.allowOther) return card
  if (card.multiSelect) return { ...card, otherOn: !card.otherOn }
  return { ...card, selected: [], otherOn: true }
}

/** The card with every unanswered question answered by its recommendation ("Finish with your recommendations"). */
export function acceptRecommendation(card) {
  if (isAnswered(card)) return card
  const fallback = card.recommended.length ? card.recommended : card.options.length ? [card.options[0].label] : []
  return { ...card, selected: fallback, otherOn: false }
}

/** Which of the card's choices is the architect's own wording, as the text to log, or ''. */
export const otherWords = (card) => (card.otherOn ? card.otherText.trim() : '')

/** True when the answer given is exactly the AI's recommendation. */
export function followsRecommendation(card) {
  if (card.otherOn && card.otherText.trim()) return false
  const a = [...card.selected].sort().join('\n')
  const b = [...card.recommended].sort().join('\n')
  return a === b
}

// ---------- term cards (#291) ----------

/**
 * What a term card's answer settles: the **preferred term** (the option chosen, or the architect's own wording if they typed
 * "Other") and the names to **avoid** (every other option). Only for a card with `kind: 'term'`; otherwise null.
 */
export function termChoice(card) {
  if (card.kind !== 'term' || card.type === 'change') return null
  const own = otherWords(card)
  const preferred = own || card.selected[0]
  if (!preferred) return null
  return { preferred, avoid: card.options.map((o) => o.label).filter((label) => !same(label, preferred)), own: Boolean(own), meaning: card.meaning ?? '' }
}

// ---------- the answers, for the AI ----------

/**
 * The round's answers as the text the AI receives (the `ask_architect` result for a native call, a message from Gantry
 * for the text fallback). One line per card; the architect's own words are quoted as theirs; the text a chosen option
 * would put in its Field is included so the AI redrafts from it.
 */
export function answersText(cards, { fieldTitle = (key) => key } = {}) {
  const lines = []
  for (const card of cards) {
    const chosen = card.selected.map((l) => `"${l}"`)
    const own = otherWords(card)
    if (own) chosen.push(`Other, in the architect's own words: "${own}"`)
    const how = card.type === 'change' ? '' : followsRecommendation(card) ? ' (your recommendation)' : ' (not your recommendation)'
    const feeds = card.field && card.type !== 'change' ? ` Feeds ${card.field}.` : ''
    lines.push(`- [${card.id}] ${card.question} → ${chosen.join(' and ') || '(no answer)'}${how}.${feeds}`)
    for (const label of card.selected) {
      const draft = card.options.find((o) => o.label === label)?.draft
      if (draft) lines.push(`  Text for "${label}": ${draft}`)
    }
    const term = termChoice(card)
    if (term) {
      lines.push(`  Term choice, logged: prefer "${term.preferred}"${term.avoid.length ? `, avoid ${term.avoid.map((a) => `"${a}"`).join(', ')}` : ''}. Use "${term.preferred}" in every Field, heading, table and diagram from now on, and in every later Stage; draft it into the Glossary where one is mounted.`)
    }
    if (card.kind === 'decision' && card.type !== 'change') {
      lines.push('  Key decision, logged. Draft it into the Key decisions Field as the next numbered decision, in the style and prefix that module uses.')
    }
    if (card.type === 'change') {
      const what = card.selected[0]
      const title = fieldTitle(card.field)
      const mine = card.change?.handEdit
      if (what === CHANGE_OPTIONS.keep) lines.push(mine ? `  ${title} stays as the architect wrote it. Do not propose a change to it again unless they ask you to in chat.` : `  ${title} stays as saved. Do not propose a change to it again.`)
      else if (what === CHANGE_OPTIONS.use) lines.push(`  ${title} now shows your version in the preview. You may revise it freely until it is saved.`)
      else if (what === CHANGE_OPTIONS.merge) lines.push(`  Write one merged version of ${card.field} with draft_field now; Gantry accepts it. Keep what is good in ${mine ? "the architect's edit" : 'the saved text'} and in yours.`)
    }
  }
  return lines.join('\n')
}
