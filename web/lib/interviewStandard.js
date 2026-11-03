// #291 (parent #238, docs/adr/0065): the AI interview and the three **standard modules**. The interview settles preferred terms,
// offers Key decisions and records open questions, and where each lands depends on whether the Definition mounted that
// standard module on the Stage being interviewed:
//
//   Glossary        a term card's answer is a **term choice** (a `term` entry in the decisions log) that binds this and every later
//                   Stage. With the Glossary mounted on the Stage, the AI drafts `glossary.terms` from the choices; Gantry checks the
//                   draft carries each one. Without it the choice stays in the log.
//   Key decisions   a decision card is offered only when the decision passes the three-part test (hard to reverse, surprising
//                   without context, a real trade-off) and the module is mounted. The AI drafts it as the next numbered decision in
//                   the Definition's prefix and style; Gantry checks the draft's numbers, prefix, parts and links.
//   Open questions  the open questions in the log are drafted into the module, one table row each. Not mounted: log only.
//
// Everything here is pure (no DOM, no network, no clock), like web/lib/interviewBrief.js, so the unit tests drive all of it and the
// browser and Node read the log the same way.
import { currentLogEntries } from './decisionsLog.js'
import { KEY_DECISIONS_ID, STYLE_PARTS, STYLE_TITLES, decisionReference, hasStyleText, keyDecisionProblems, nextDecisionNumber, parseKeyDecisions } from './keyDecisions.js'
import { moduleKeyDecisions } from './standardModules.js'

export const GLOSSARY_ID = 'glossary'
export const OPEN_QUESTIONS_ID = 'open-questions'

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const asModules = (modules) => (!modules ? [] : modules instanceof Map ? [...modules.values()] : Array.isArray(modules) ? modules : [])
const squash = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Which of the three standard modules are on `stageId`. Each role is `{ mounted, inScope, readOnly, key, module }`: `mounted` is on
 * the Stage and Gantry's own; `inScope` is mounted and not read-only here (the AI may draft it); `key` is the `module.field` its one
 * Field is drafted as. Key decisions also carries `prefix` and `style`.
 */
export function standardRoles(definition, stageId) {
  const stage = (definition?.stages ?? []).find((s) => s.id === stageId)
  const byId = new Map(asModules(definition?.modules).map((m) => [m.id, m]))
  const readOnlyIds = new Set(Array.isArray(stage?.readOnlyModules) ? stage.readOnlyModules : [])
  const role = (id) => {
    const module = byId.get(id)
    const mounted = Boolean(module?.standard) && (stage?.modules ?? []).includes(id)
    const readOnly = mounted && readOnlyIds.has(id)
    const field = module?.fields?.[0]
    return { id, module, mounted, readOnly, inScope: mounted && !readOnly, key: field ? `${id}.${field.id}` : null }
  }
  const keyDecisions = role(KEY_DECISIONS_ID)
  return {
    glossary: role(GLOSSARY_ID),
    keyDecisions: { ...keyDecisions, ...(keyDecisions.module ? moduleKeyDecisions(keyDecisions.module) ?? {} : {}) },
    openQuestions: role(OPEN_QUESTIONS_ID),
  }
}

// --- term choices -------------------------------------------------------------------------------------------------------

/** The names a term entry is about: the preferred term and everything to avoid. */
const namesOf = (entry) => [entry.preferred ?? entry.term, ...asArray(entry.avoid)].map(squash).filter(Boolean)

/**
 * The term choices that stand, as `[{ preferred, avoid, meaning, id, stage }]`, oldest Stage first. `earlier` is each earlier Stage's
 * decisions log (`[{ stageId, stageTitle?, entries }]`, in Stage order) and `own` the entries of this Stage's. A choice binds every later
 * Stage, so an earlier Stage's choice stands here; a later choice about the same thing (it shares a name) takes the earlier one's place.
 */
export function termChoices({ earlier = [], own = [], stageId } = {}) {
  const out = []
  const take = (entries, stage) => {
    for (const entry of currentLogEntries(entries)) {
      if (entry.kind !== 'term') continue
      const preferred = String(entry.preferred ?? entry.term ?? '').trim()
      if (!preferred) continue
      const names = new Set(namesOf(entry))
      for (let i = out.length - 1; i >= 0; i--) if (namesOf(out[i]).some((name) => names.has(name))) out.splice(i, 1)
      out.push({ preferred, avoid: asArray(entry.avoid).map(String), meaning: entry.meaning ? String(entry.meaning) : '', id: entry.id, stage })
    }
  }
  for (const log of earlier) take(log.entries ?? [], log.stageId)
  take(own, stageId)
  return out
}

/** The Glossary's table rows for the choices: `| Preferred term | Definition | Avoid |`, with "(define from the Source documents)" where no meaning was given. */
export function glossarySeed(choices) {
  const cell = (text) => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
  return choices.map((c) => `| ${cell(c.preferred)} | ${cell(c.meaning) || '(define from the Source documents)'} | ${c.avoid.length ? c.avoid.map(cell).join(', ') : '—'} |`)
}

/** The term choices a Glossary draft leaves out: those whose preferred term appears nowhere in `text`. */
export function missingTerms(text, choices) {
  const body = squash(Array.isArray(text) ? text.join('\n') : text)
  return choices.filter((c) => !body.includes(squash(c.preferred)))
}

// --- open questions -----------------------------------------------------------------------------------------------------

/** The open questions still open in a log's entries (`[{ question, why, fields, id }]`). */
export function openQuestionsIn(entries) {
  return currentLogEntries(entries).filter((e) => e.kind === 'open-question' && String(e.question ?? '').trim())
}

/**
 * Every open question to carry into the Open questions module: this Stage's still-open ones, then those left open at earlier Stages
 * (the module may be mounted on a later Stage than the one that raised them), without repeats.
 */
export function openQuestionsToCarry({ earlier = [], own = [] } = {}) {
  const seen = new Set()
  const out = []
  for (const [stage, entries] of [...earlier.map((log) => [log.stageId, log.entries ?? []]), ['', own]]) {
    for (const q of openQuestionsIn(entries)) {
      const key = squash(q.question)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ question: String(q.question).trim(), why: q.why ? String(q.why) : '', fields: asArray(q.fields), id: q.id, stage })
    }
  }
  return out
}

/** The data rows of a Markdown table in `text` (the header and separator rows left out). */
export function tableRowCount(text) {
  let rows = 0
  for (const raw of String(Array.isArray(text) ? text.join('\n') : text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue
    if (/^question$/i.test(cells[0])) continue
    rows++
  }
  return rows
}

// --- Key decisions ------------------------------------------------------------------------------------------------------

/** The reference the next Key decision takes in `savedText` (the Field as saved), for example `AD04`. */
export function nextDecisionReference(savedText, prefix) {
  return decisionReference(prefix, nextDecisionNumber(parseKeyDecisions(savedText)))
}

// --- the checks on a draft ----------------------------------------------------------------------------------------------

/**
 * Problems with a draft of a standard module's Field, as `{ kind, message }` like `checkDraft`'s, to be sent back to the AI once and
 * then shown as warnings (a check never blocks).
 *
 * @param {object} input
 * @param {object} input.roles     from `standardRoles`
 * @param {string} input.key       the `module.field` being drafted
 * @param {*} input.value          the draft as the Field stores it
 * @param {object[]} [input.terms] `termChoices(...)`, for the Glossary
 * @param {number} [input.openCount] how many open questions are logged, for Open questions
 */
export function standardDraftProblems({ roles, key, value, terms = [], openCount = 0 }) {
  const problems = []
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
  if (roles.glossary.inScope && key === roles.glossary.key) {
    const missing = missingTerms(text, terms)
    if (missing.length) {
      problems.push({
        kind: 'terms',
        message: `${key}: the architect settled ${missing.map((c) => `"${c.preferred}"`).join(', ')} as preferred term${missing.length === 1 ? '' : 's'} and ${missing.length === 1 ? 'it is' : 'they are'} not in the draft. Draft the Glossary from the term choices: a row for each, Preferred term | Definition | Avoid.`,
      })
    }
  }
  if (roles.keyDecisions.inScope && key === roles.keyDecisions.key) {
    const { prefix, style } = roles.keyDecisions
    const parsed = parseKeyDecisions(text)
    if (parsed.decisions.length === 0) {
      problems.push({ kind: 'decisions', message: `${key}: no numbered decision found. Write each Key decision under a heading such as **${decisionReference(prefix, 1)}: Short title**, then its parts in the ${STYLE_TITLES[style]} style (${STYLE_PARTS[style].map((p) => p.label).join(', ')}).` })
    } else {
      const others = [...text.matchAll(/^\*\*([A-Za-z]{1,6})\d+(?:\s*:[^\n]*?)?\*\*\s*$/gm)].map((m) => m[1]).filter((p) => p !== prefix)
      if (others.length) problems.push({ kind: 'decisions', message: `${key}: decisions are numbered with the prefix ${prefix} (${decisionReference(prefix, 1)}, ${decisionReference(prefix, 2)}, …), not ${[...new Set(others)].join(', ')}.` })
      for (const decision of parsed.decisions) {
        if (!hasStyleText(decision, style)) problems.push({ kind: 'decisions', message: `${key}: ${decisionReference(prefix, decision.number)} has none of the ${STYLE_TITLES[style]} parts written (${STYLE_PARTS[style].map((p) => p.label).join(', ')}). Write the decision in that style.` })
      }
      for (const problem of keyDecisionProblems(text, { prefix, style })) problems.push({ kind: 'decisions', message: `${key}: ${problem}.` })
    }
  }
  if (roles.openQuestions.inScope && key === roles.openQuestions.key && openCount > 0) {
    const rows = tableRowCount(text)
    if (rows < openCount) {
      problems.push({ kind: 'open-questions', message: `${key}: ${openCount} open question${openCount === 1 ? ' is' : 's are'} logged but the draft lists ${rows}. Draft a row for each one logged: Question | Who resolves | By when | Status.` })
    }
  }
  return problems
}

// --- what the brief says ------------------------------------------------------------------------------------------------

/**
 * The lines of the brief that say where each standard module's role lands on this Stage: drafted into the module where it is mounted
 * and in scope, and "log only" where it is not. `saved` is the Key decisions Field as saved, for the next number.
 */
export function standardRolesLines(roles, { savedDecisions = '' } = {}) {
  const lines = []
  const where = (role, name) => (role.inScope ? null : role.mounted ? `${name} is on this Stage but read-only, so it is context only` : `${name} is not mounted on this Stage`)
  const g = roles.glossary
  lines.push(
    g.inScope
      ? `- **Glossary** is mounted (\`${g.key}\`). Settled term choices are drafted into it, one row each, rather than written into it as they come up.`
      : `- **Glossary:** ${where(g, 'the Glossary')}. A term choice stays in the decisions log only; it still binds every later Stage.`
  )
  const k = roles.keyDecisions
  lines.push(
    k.inScope
      ? `- **Key decisions** is mounted (\`${k.key}\`): numbered ${k.prefix}01, ${k.prefix}02, …, ${STYLE_TITLES[k.style]} style (${STYLE_PARTS[k.style].map((p) => p.label).join(', ')}). Offer a decision as a card (kind "decision") only when it is hard to reverse, surprising without context and a real trade-off, and draft it as ${nextDecisionReference(savedDecisions, k.prefix)}, the next number, keeping every saved decision's number.`
      : `- **Key decisions:** ${where(k, 'Key decisions')}. Do not offer a Key decision; the decisions log records every answer.`
  )
  const q = roles.openQuestions
  lines.push(
    q.inScope
      ? `- **Open questions** is mounted (\`${q.key}\`): every open question in the decisions log is drafted into it, one row each (Question | Who resolves | By when | Status).`
      : `- **Open questions:** ${where(q, 'Open questions')}. An open question is logged in the decisions log only.`
  )
  return lines
}
