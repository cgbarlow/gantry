// #287 (parent #238, docs/adr/0065): "is this Field done?" and "is this Stage ready?". The rules are the AI interview's rule
// on when a Field is done and a Stage is ready (web/lib/interviewRules.js), worked out here by Gantry rather than left to the
// model's judgement:
//
//   A Field is **done** when it has content; it is between about 60% of its word budget and the over-budget threshold (its
//   budget); each point its guidance asks for is covered (the AI says which it has not covered, in `uncovered`); and no open
//   question feeds it.
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
 * not covered, `open` whether an open question feeds it. `handEdited` (#289): the architect wrote it themselves, so it is done when it has
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
