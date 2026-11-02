// #286 (parent #238, docs/adr/0065, rules from #246): the **draft field step**. The AI writes each Field of a Stage
// through one `draft_field` tool call (or, for a model that doesn't use tools, a fenced `gantry-draft` block), and
// Gantry checks the draft before it reaches the Interview page's live preview:
//
//   * a select value is one of the Field's `options`;
//   * the word count is within the Field's budget at the Instance's Target size;
//   * every figure is cited with a `source:` link, or marked "(target assumption)", or is one the architect typed
//     in the interview (a fact the architect told the AI is plain fact, and the decisions log is its record).
//
// A draft with problems goes back to the AI once, with the problems named. If it still has them the second time (or
// the AI never answers), the draft reaches the preview anyway with the problems as warnings. A check never blocks.
//
// Pure (no DOM, no network), like web/lib/aiCards.js, so the unit tests drive all of it.
import { countWords, fieldOverBudget, targetSizeLabel } from './targetSize.js'
import { isMultiValuedField } from './fieldShape.js'

export const DRAFT_TOOL_NAME = 'draft_field'
export const DRAFT_FENCE = 'gantry-draft'

/** The tool as the model is told about it. */
export const DRAFT_TOOL = {
  name: DRAFT_TOOL_NAME,
  description:
    'Write one Field of the Stage into the architect’s live draft preview. Call it once per Field you can draft from the Source documents ' +
    'or from what the architect has told you. Gantry checks the draft (a select value must be one of its options, the word count must be ' +
    'within budget, every figure must be cited or marked) and tells you if something must be fixed; fix it once. A Field that already ' +
    'holds saved content is not changed by this call: Gantry shows the architect a keep / use your version / merge card, and a draft you send after they choose to merge is accepted. Nothing is saved until the architect confirms the Stage.',
  parameters: {
    type: 'object',
    properties: {
      field: { type: 'string', description: 'The Field to write, as module.field, exactly as listed under "Fields in scope".' },
      value: {
        description: 'The Field’s content: Markdown text for a text Field, one string per item for a list or a Field that allows several choices, or exactly one of the options for a select Field.',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      uncovered: {
        type: 'array',
        items: { type: 'string' },
        description: 'The points the Field’s guidance asks for that this draft does not cover yet, one short phrase each. Leave it out, or empty, when the draft covers them all. A Field with uncovered points is not done.',
      },
    },
    required: ['field', 'value'],
  },
}

/** What a model without tool calling is told, in place of the tool, so it can still draft (the text fallback). */
export const DRAFT_TEXT_FALLBACK_INSTRUCTIONS =
  `To draft a Field, write one fenced code block tagged ${DRAFT_FENCE} containing JSON of the form ` +
  `{"field":"module.field","value":"the Field's content"} (use an array of strings for a list or a Field that allows several choices; add "uncovered":["a guidance point not yet covered"] if the draft leaves any). ` +
  'Write one block per Field. Gantry checks each draft and replies with anything to fix; fix it once. ' +
  'Keep your chat short and outside the blocks.'

// ---------- the text fallback ----------

const FENCE = new RegExp('```[ \\t]*' + DRAFT_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')

/** Removes draft blocks from text meant for the screen, including one still being written (no closing fence yet). */
export function stripDraftBlocks(text) {
  const closed = String(text ?? '').replace(FENCE, '')
  const open = closed.search(new RegExp('```[ \\t]*' + DRAFT_FENCE))
  return (open === -1 ? closed : closed.slice(0, open)).trim()
}

/** The drafts a model wrote as fenced blocks: `{ drafts: [{ field, value }], errors: [string] }`. */
export function extractDraftBlocks(text) {
  const drafts = []
  const errors = []
  for (const match of String(text ?? '').matchAll(FENCE)) {
    try {
      const parsed = JSON.parse(match[1])
      const list = Array.isArray(parsed) ? parsed : parsed?.drafts ? parsed.drafts : [parsed]
      for (const item of list) {
        if (item && typeof item.field === 'string' && 'value' in item) drafts.push({ field: item.field, value: item.value, ...(Array.isArray(item.uncovered) ? { uncovered: item.uncovered } : {}) })
        else errors.push('A draft block needs {"field": "module.field", "value": ...}.')
      }
    } catch (err) {
      errors.push(`A draft block is not valid JSON (${err.message}).`)
    }
  }
  return { drafts, errors }
}

// ---------- the value ----------

const isBlankValue = (value) => (Array.isArray(value) ? value.every((v) => String(v).trim() === '') : String(value ?? '').trim() === '')
export { isBlankValue }

/** The value as the Field stores it: an array of trimmed non-empty strings for a multi-valued Field, else a string. */
export function normaliseDraftValue(field, value) {
  if (isMultiValuedField(field)) {
    const items = Array.isArray(value) ? value : String(value ?? '').split('\n').map((line) => line.replace(/^\s*[-*]\s+/, ''))
    return items.map((item) => String(item).trim()).filter((item) => item !== '')
  }
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).join('\n')
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

// ---------- figures ----------

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`
// A figure is a number that is a claim: with a unit, a currency sign, a percent, a year or a date. Identifiers (PDM-01,
// R2), versions (TLS 1.3) and ordinals ("95th") are not figures.
const FIGURE = new RegExp(
  [
    String.raw`(?<![\w:.\-§#/])${NUM}(?:\s*|-)(?:%|percent\b|ms\b|milliseconds?\b|seconds?\b|minutes?\b|hours?\b|days?\b|weeks?\b|months?\b|years?\b|[KMGT]B\b|[KMG]bps\b|vCPUs?\b|transactions?\b|claims?\b|registrations?\b|pages?\b|requests?\b|users?\b|members?\b|seats?\b|people\b|staff\b|FTEs?\b|licen[cs]es?\b|servers?\b|sites?\b|customers?\b|employees?\b|million\b|billion\b|thousand\b)`,
    String.raw`(?<![\w:.\-§#/])${NUM}[kKMB]\b`,
    String.raw`(?<![\w])[$€£]\s?${NUM}(?:\s?(?:million|billion|thousand)\b|[kKMB]\b)?`,
    String.raw`(?<![\w.\-:/§#])(?:19|20)\d{2}-\d{2}-\d{2}(?![\w])`,
    String.raw`(?<![\w.\-:/§#])(?:19|20)\d{2}(?![\w]|\.\d)`,
  ].join('|'),
  'gi'
)

const CITED = '⟦cited⟧'

/**
 * Every figure in `text` with no source after it in its clause. A source is a `[title, p. 4](source:<id>)` link or the
 * marker "(target assumption)", anywhere after the figure and before the clause ends (a `;`, a full stop, a line end or a
 * table cell boundary), so one citation can source a pair of figures. A figure that appears in `architectText` (what the
 * architect typed in the interview) needs none.
 */
export function unsourcedFigures(text, architectText = '') {
  const told = new Set([...String(architectText).matchAll(new RegExp(NUM, 'g'))].map((m) => m[0].replace(/,/g, '')))
  const masked = String(text ?? '')
    .replace(/\[[^\]]*\]\(source:[^)]*\)/g, CITED)
    .replace(/\(\s*target assumption\s*\)/gi, CITED)
    .replace(/\]\((?!source:)[^)]*\)/g, ']')
  const found = []
  for (const clause of masked.split(/;|\.(?=\s|$)|\n|\|/)) {
    for (const match of clause.matchAll(FIGURE)) {
      if (clause.slice(match.index + match[0].length).includes(CITED)) continue
      const core = match[0].match(new RegExp(NUM))?.[0]?.replace(/,/g, '')
      if (core && told.has(core)) continue
      found.push(match[0].trim())
    }
  }
  return found
}

/**
 * `text` with "(target assumption)" added to every clause that holds a figure with no source (#287, "Finish with your
 * recommendations"): the AI proposed the figure and the architect accepted it without a source, which is exactly what the
 * marker says. A cited figure, an already marked one, and one the architect typed (`architectText`) are left alone. The
 * marker goes at the end of the clause, before its closing full stop, so one mark covers a clause's figures.
 */
export function markTargetAssumptions(text, architectText = '') {
  const originals = []
  const masked = String(text ?? '')
    .replace(/\[[^\]]*\]\(source:[^)]*\)|\(\s*target assumption\s*\)/gi, (m) => {
      originals.push(m)
      return CITED
    })
  const pieces = masked.split(/(;|\.(?=\s|$)|\n|\|)/)
  for (let i = 0; i < pieces.length; i += 2) {
    const clause = pieces[i]
    if (!clause.trim() || unsourcedFigures(clause, architectText).length === 0) continue
    const trailing = clause.match(/\s*$/)[0]
    pieces[i] = `${clause.slice(0, clause.length - trailing.length)} (target assumption)${trailing}`
  }
  let n = 0
  return pieces.join('').replace(new RegExp(CITED, 'g'), () => originals[n++])
}

/** The ids of the Source documents a text cites, in order, as `[...](source:<id>)`. */
export function citedSourceIds(text) {
  return [...String(text ?? '').matchAll(/\]\(source:([^)\s]+)\)/g)].map((m) => m[1])
}

/**
 * The text split into plain pieces and citations, for showing a citation as a mark instead of a link:
 * `[{ text }, { cite: 'title, p. 4', id }]`.
 */
export function citationSegments(text) {
  const out = []
  let at = 0
  const source = String(text ?? '')
  for (const match of source.matchAll(/\[([^\]]*)\]\(source:([^)\s]+)\)/g)) {
    if (match.index > at) out.push({ text: source.slice(at, match.index) })
    out.push({ cite: match[1], id: match[2] })
    at = match.index + match[0].length
  }
  if (at < source.length) out.push({ text: source.slice(at) })
  return out
}

// ---------- the check ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Checks one draft. `field` is the Definition's Field (camelCase: `{ id, type, options, multiple, targetWords }`).
 * `input`: `{ size, architectText, knownSourceIds, exact, label, markAssumptions }`. `exact` (the stage Save's check of what an outside agent wrote,
 * #306) takes a select value as written instead of matching an option case-insensitively, since the written value is what
 * gets stored; `label` replaces the Field id in the messages (`module.field`); `markAssumptions` marks unsourced figures
 * "(target assumption)" instead of reporting them (#287). Returns `{ value, words, problems }`: `value` is the draft as the Field
 * stores it, `problems` is a list of `{ kind, message }` (`options`, `budget`, `figures`, `citation`, `date`), each written
 * to be sent back to the model.
 */
export function checkDraft(field, rawValue, { size, architectText = '', knownSourceIds, exact = false, label, markAssumptions = false } = {}) {
  let value = normaliseDraftValue(field, rawValue)
  const words = countWords(value)
  const problems = []
  const where = label ?? `${field.id}`

  if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : []
    const canon = (v) => options.find((o) => o === v) ?? (exact ? undefined : options.find((o) => o.toLowerCase() === String(v).trim().toLowerCase()))
    const chosen = Array.isArray(value) ? value : value === '' ? [] : [value]
    const fixed = chosen.map((v) => canon(v) ?? v)
    const off = fixed.filter((v) => !options.includes(v))
    if (off.length) {
      problems.push({ kind: 'options', message: `${where}: ${off.map((v) => `"${v}"`).join(', ')} ${off.length === 1 ? 'is' : 'are'} not one of the options. Use exactly: ${options.map((o) => `"${o}"`).join(', ')}.` })
    } else if (field.multiple !== true && fixed.length > 1) {
      problems.push({ kind: 'options', message: `${where}: this Field takes one option, not ${fixed.length}. Choose one of: ${options.map((o) => `"${o}"`).join(', ')}.` })
    }
    return { value: field.multiple === true ? fixed : fixed[0] ?? '', words, problems }
  }

  if (field.type === 'date') {
    if (value !== '' && !ISO_DATE.test(value)) problems.push({ kind: 'date', message: `${where}: a date is written YYYY-MM-DD, not "${value}".` })
    return { value, words, problems }
  }

  // #287: after "Finish with your recommendations" Gantry marks the unsourced figures itself instead of sending the draft back.
  if (markAssumptions) value = Array.isArray(value) ? value.map((item) => markTargetAssumptions(item, architectText)) : markTargetAssumptions(value, architectText)
  const proseWords = markAssumptions ? countWords(value) : words
  const over = fieldOverBudget(field, value, size)
  if (over !== null) {
    problems.push({ kind: 'budget', message: `${where}: ${over.words} words is over the ${targetSizeLabel(size)} budget of about ${over.target}. Tighten it to ${over.target} words or fewer.` })
  }
  const text = Array.isArray(value) ? value.join('\n') : value
  const figures = unsourcedFigures(text, architectText)
  if (figures.length) {
    const list = [...new Set(figures)].slice(0, 6).map((f) => `"${f}"`).join(', ')
    problems.push({
      kind: 'figures',
      message: `${where}: ${list}${figures.length > 6 ? ' and more' : ''} ha${new Set(figures).size === 1 ? 's' : 've'} no source. Cite each figure as [title, p. 4](source:<id>) from a Source document, or mark it "(target assumption)" if you are proposing it. If the architect told you, it needs no mark. Never invent a figure.`,
    })
  }
  if (knownSourceIds) {
    const unknown = [...new Set(citedSourceIds(text))].filter((id) => !knownSourceIds.includes(id))
    if (unknown.length) {
      problems.push({ kind: 'citation', message: `${where}: ${unknown.map((id) => `source:${id}`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a Source document of this Instance. Cite one that is listed: ${knownSourceIds.join(', ') || '(none)'}.` })
    }
  }
  return { value, words: proseWords, problems }
}
