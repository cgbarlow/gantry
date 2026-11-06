// #287 (parent #238, docs/adr/0065): "is this Field done?" and "is this Stage ready?". The rules are the AI interview's rule
// on when a Field is done and a Stage is ready (web/lib/interviewRules.js), worked out here by Gantry rather than left to the
// model's judgement:
//
//   A Field is **done** when it has content; it is between about 60% of its word budget and the over-budget threshold (its
//   budget); each point its guidance asks for is covered (the AI says which it has not covered, in `uncovered`); and no open
//   question card feeds it (#349: a card still unanswered or held back; a question the AI logged as open does not hold a Field).
//
//   The Stage is **ready** when Gantry's real Gate check passes for the Artefact aimed for and every Field in scope is done.
//
// "In scope" for readiness is a Field the Gate requires for the Artefact aimed for, and any other Field that has content,
// saved or drafted. An optional Field with nothing in it is not in scope: the AI drafts optional Fields only when the Source
// documents support them (rule 3), so an empty one is the answer "not needed", not unfinished work.
//
// Pure: no DOM, no network.
import { countWords, fieldTargetWords } from './targetSize.js'
import { isBlankValue } from './interviewDraft.js'
import { draftGateCheck } from './interviewGate.js'
import { normalizeSavedContent, requiredFieldKeys } from './interviewBrief.js'
import { fieldsInScope } from './interviewScope.js'

/** A Field's content has to reach this share of its word budget to be done. */
export const MIN_BUDGET_SHARE = 0.6

/** The fewest words a Field with a budget of `budget` words can have and be done. */
export const minWords = (budget) => Math.round(budget * MIN_BUDGET_SHARE)

/**
 * Whether one Field is done. `value` is its content (draft over saved), `uncovered` the guidance points the AI said it has
 * not covered, `open` whether an open question card feeds it. `handEdited` (#289): the architect wrote it themselves, so it is done when it has
 * content: its length and coverage are theirs to judge, and Gantry's per-Field check does not run on their text. Returns `{ done, reasons }`, each reason a short phrase.
 */
export function fieldDone({ field, value, size, uncovered = [], open = false, handEdited = false }) {
  const reasons = []
  if (isBlankValue(value)) {
    reasons.push('no content yet')
  } else if (!handEdited) {
    const budget = fieldTargetWords(field, size)
    if (budget !== null) {
      const words = countWords(value)
      if (words < minWords(budget)) reasons.push(`${words} words, needs about ${minWords(budget)} to ${budget}`)
      else if (words > budget) reasons.push(`${words} words, over its budget of ${budget}`)
    }
    if (uncovered.length) reasons.push(`does not yet cover: ${uncovered.join('; ')}`)
  }
  if (open) reasons.push('a question feeding it is still open')
  return { done: reasons.length === 0, reasons }
}

/**
 * The Stage's readiness. `definition` is the Definition with the standard modules mounted (as the session holds it),
 * `structure` the Definition version projection the Gate check reads; `modules` is the Stage's saved Modules in the editor's
 * shape; `drafts` is `{ 'module.field': { value, uncovered? } }`; `openFields` the `module.field` keys a question still
 * feeds. Returns `{ gate, fields: { key: { done, reasons, required } }, allDone, ready, doneCount, total }`.
 */
export function stageReadiness({ definition, structure, stageId, artefactId, size, modules, drafts = {}, openFields = [] }) {
  const scope = fieldsInScope(definition, stageId)
  const required = requiredFieldKeys(definition, stageId, artefactId)
  const saved = normalizeSavedContent(modules)
  const open = new Set(openFields)
  const fields = {}
  for (const [key, { module, field }] of scope) {
    const draft = drafts[key]
    const value = draft ? draft.value : saved[module.id]?.fields?.[field.id]
    const isRequired = required.has(key)
    if (!isRequired && isBlankValue(value)) continue
    fields[key] = { ...fieldDone({ field, value, size, uncovered: draft?.uncovered ?? [], open: open.has(key), handEdited: draft?.handEdited === true }), required: isRequired }
  }
  const gate = draftGateCheck({ structure, stageId, artefactId, modules, drafts })
  const entries = Object.values(fields)
  const allDone = entries.every((f) => f.done)
  return { gate, fields, allDone, ready: gate.pass && allDone, doneCount: entries.filter((f) => f.done).length, total: entries.length }
}

// A Gate check's outstanding item that is a Field, as `module.field`, rather than words of its own.
const isFieldKey = (item) => /^[^\s.]+\.[^\s.]+$/.test(String(item))

/**
 * #350: what keeps the Stage from its stage-end card, in Gantry's words, from a `stageReadiness` verdict: the Gate check's outstanding
 * items for the Artefact aimed for, then each Field in scope that isn't done with its reasons. It is the one list both the architect (the
 * Not ready yet card, web/lib/interviewView.js) and the AI (the session's note, web/lib/interviewSession.js `readinessNote`, #349) are
 * given, so the two never word it differently. `name(key)` names a Field, in the Gate's items as in the Fields'. Returns
 * `[{ kind: 'gate', text } | { kind: 'field', key, name, text }]`, empty when the Stage is ready; `outstandingLine` writes one as a line.
 */
export function outstandingItems(readiness, { name = (key) => key } = {}) {
  const items = []
  const gate = readiness?.gate
  if (gate && !gate.pass) {
    const outstanding = (gate.outstanding ?? []).map((item) => (isFieldKey(item) ? name(item) : item))
    if (!gate.artefact) items.push({ kind: 'gate', text: 'The Gate check: no Artefact is aimed for yet.' })
    else items.push({ kind: 'gate', text: `The Gate check for ${gate.artefact.title ?? gate.artefact.id}: ${outstanding.length ? `outstanding ${outstanding.join(', ')}` : 'does not pass yet'}` })
  }
  for (const [key, field] of Object.entries(readiness?.fields ?? {})) if (!field.done) items.push({ kind: 'field', key, name: name(key), text: field.reasons.join('; ') })
  return items
}

/**
 * #350: whether what keeps the Stage lies only outside the Fields it drafts: every Field in scope is done and the Gate check for the
 * Artefact aimed for waits on Fields this Stage can't draft (a Module it mounts read-only, #152, or one held until an earlier Stage merges,
 * #296). Then there is nothing for the AI to finish: the session sends it no note (#349) and the Not ready yet card doesn't offer to ask it.
 */
export const onlyOutsideTheStage = (readiness) => Boolean(readiness && !readiness.ready && readiness.allDone && readiness.gate?.artefact)

/** One item of `outstandingItems` as a line: a Field is "its name: its reasons". */
export const outstandingLine = (item) => (item.kind === 'field' ? `${item.name}: ${item.text}` : item.text)

/** #350: the architect's message that the Not ready yet card's Ask the AI to finish these sends: the card's own list. */
export const finishTheseMessage = (items) => ['Please finish these, so the Stage is ready:', ...items.map((item) => `- ${outstandingLine(item)}`)].join('\n')
