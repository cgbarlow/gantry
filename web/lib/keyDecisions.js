// #284 (ADR-0065): the **Key decisions** standard module. Its one Field holds the Definition's
// significant decisions, each with a stable number (`AD01`, `AD02`, …), written in the decision style
// the Definition chose: the default shape (title, context, decision, why, considered options,
// consequences) or WH(Y) (github.com/cgbarlow/adr: a title, the six-part statement and typed links to
// other Key decisions).
//
// The Field is an ordinary Markdown Field to everything else in Gantry. This file is the one place that
// knows the text inside it, so the editor, the Word render and the checks all read it the same way:
//
//   **AD01: Use PostgreSQL for the ledger**
//
//   **Context:** …                       (default style: Context, Decision, Why,
//                                          Considered options, Consequences)
//
//   **AD02: Keep sessions in Redis**
//
//   **In the context of:** …             (WH(Y): the six parts, then the typed links)
//   **Facing:** …
//   **We decided for:** …
//   **And neglected:** …
//   **To achieve:** …
//   **Accepting that:** …
//   **Depends on:** AD01
//   **Supersedes:** AD07, AD08
//   **Relates to:** AD03
//
//   <!-- next: 9 -->                    (only when it matters: see below)
//
// The number is part of the text, never worked out from a decision's position, so reordering a
// decision moves its block and removing one leaves a gap: the others keep the numbers other documents
// and links already use. The `next` line is the high-water mark; it is written only when it is above
// the highest number present, so that a number whose decision was removed is not handed out again.
// The prefix is the Definition's, applied when the text is written or rendered; reading accepts any, so
// a Definition that changes its prefix on a later version keeps its decisions' numbers.
//
// Pure and dependency-free, like web/lib/standardModules.js, so `lib/` imports it directly.

export const KEY_DECISIONS_ID = 'key-decisions'
export const DEFAULT_PREFIX = 'KD'
export const DECISION_STYLES = Object.freeze(['default', 'why'])
export const DEFAULT_STYLE = 'default'
/** A prefix is 1 to 6 capital letters ("AD", "KD"). Digits would run into the number. */
export const PREFIX_RE = /^[A-Z]{1,6}$/

export const STYLE_TITLES = Object.freeze({ default: 'Default', why: 'WH(Y)' })

/** The parts of each style, in the order they are written. `key` is the property on a parsed decision. */
export const STYLE_PARTS = Object.freeze({
  default: Object.freeze([
    { key: 'context', label: 'Context', hint: 'The situation and forces behind the decision.' },
    { key: 'decision', label: 'Decision', hint: 'What was decided.' },
    { key: 'why', label: 'Why', hint: 'The reasons it was chosen.' },
    { key: 'options', label: 'Considered options', hint: 'What else was weighed, and why it lost.' },
    { key: 'consequences', label: 'Consequences', hint: 'What follows, good and bad.' },
  ]),
  why: Object.freeze([
    { key: 'inContext', label: 'In the context of', hint: 'The situation or use case.' },
    { key: 'facing', label: 'Facing', hint: 'The concern or force being faced.' },
    { key: 'decided', label: 'We decided for', hint: 'The option chosen.' },
    { key: 'neglected', label: 'And neglected', hint: 'The options set aside.' },
    { key: 'achieve', label: 'To achieve', hint: 'The quality or outcome sought.' },
    { key: 'accepting', label: 'Accepting that', hint: 'The downside taken on.' },
  ]),
})

/** The typed links a WH(Y) decision can hold to other Key decisions. */
export const LINK_TYPES = Object.freeze([
  { type: 'depends-on', label: 'Depends on' },
  { type: 'supersedes', label: 'Supersedes' },
  { type: 'relates-to', label: 'Relates to' },
])

const PART_KEYS = [...STYLE_PARTS.default, ...STYLE_PARTS.why].map((part) => part.key)
const LABEL_TO_PART = new Map([...STYLE_PARTS.default, ...STYLE_PARTS.why].map((part) => [part.label.toLowerCase(), part.key]))
const LABEL_TO_LINK = new Map(LINK_TYPES.map((link) => [link.label.toLowerCase(), link.type]))

const HEADER_RE = /^\*\*([A-Za-z]{1,6})(\d+)(?:\s*:\s*(.*?))?\*\*\s*$/
const LABEL_RE = /^\*\*([^*:]+):\*\*[ \t]*(.*)$/
const NEXT_RE = /^<!--\s*next:\s*(\d+)\s*-->\s*$/
const REFERENCE_RE = /^([A-Za-z]{1,6})(\d+)$/

const isStructural = (line) => {
  if (HEADER_RE.test(line) || NEXT_RE.test(line)) return true
  const label = LABEL_RE.exec(line)
  if (!label) return false
  const name = label[1].trim().toLowerCase()
  return LABEL_TO_PART.has(name) || LABEL_TO_LINK.has(name)
}

// A line of a decision's own words that looks like structure is written with a leading backslash and
// read back without it, so what the architect typed always comes back as typed.
const escapeLine = (line) => (isStructural(line) ? `\\${line}` : line)
const unescapeLine = (line) => (line.startsWith('\\') && isStructural(line.slice(1)) ? line.slice(1) : line)

const escapeFollowingLines = (text) => text.split('\n').map((line, index) => (index === 0 ? line : escapeLine(line))).join('\n')

const padNumber = (n) => String(n).padStart(2, '0')

/** The text for decision number `n` under `prefix`: `AD01`. */
export const decisionReference = (prefix, n) => `${prefix}${padNumber(n)}`

function blankDecision(number) {
  const decision = { number, title: '', lead: '', links: [] }
  for (const key of PART_KEYS) decision[key] = ''
  return decision
}

function parseLinkTargets(content) {
  return content
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((raw) => {
      const match = REFERENCE_RE.exec(raw)
      return { raw, to: match ? Number(match[2]) : null }
    })
}

/**
 * The text of a Key decisions Field read into `{ preamble, decisions, next }`. Each decision is
 * `{ number, title, lead, <the parts of both styles>, links: [{ type, to, raw }] }` (`to` is null for a
 * link that is not a decision number). Text before the first decision is kept as `preamble`; text under
 * a decision that follows no label is kept as its `lead`. `next` is the lowest number never to hand out
 * again (at least one above the highest present).
 */
export function parseKeyDecisions(text) {
  const decisions = []
  let preamble = []
  let next = 0
  let current = null
  let target = null // { type: 'part', key } | { type: 'link', link } | { type: 'lead' } | null

  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const buffer = { lines: [] }
  const flush = () => {
    const value = buffer.lines.join('\n').trim()
    buffer.lines = []
    if (!target) {
      if (value !== '') preamble.push(value)
      return
    }
    if (target.type === 'part') current[target.key] = value
    else if (target.type === 'lead') current.lead = value
    else if (target.type === 'link') target.links.push(...parseLinkTargets(value).map((entry) => ({ type: target.linkType, ...entry })))
  }

  for (const line of lines) {
    const header = HEADER_RE.exec(line)
    if (header) {
      flush()
      current = blankDecision(Number(header[2]))
      current.title = (header[3] ?? '').trim()
      decisions.push(current)
      target = { type: 'lead' }
      continue
    }
    const nextMark = NEXT_RE.exec(line)
    if (nextMark) {
      flush()
      next = Math.max(next, Number(nextMark[1]))
      target = null
      continue
    }
    const label = current ? LABEL_RE.exec(line) : null
    if (label) {
      const name = label[1].trim().toLowerCase()
      if (LABEL_TO_PART.has(name)) {
        flush()
        target = { type: 'part', key: LABEL_TO_PART.get(name) }
        buffer.lines.push(label[2])
        continue
      }
      if (LABEL_TO_LINK.has(name)) {
        flush()
        target = { type: 'link', linkType: LABEL_TO_LINK.get(name), links: current.links }
        buffer.lines.push(label[2])
        continue
      }
    }
    buffer.lines.push(unescapeLine(line))
  }
  flush()

  const highest = decisions.reduce((max, d) => Math.max(max, d.number), 0)
  return { preamble: preamble.join('\n\n'), decisions, next: Math.max(next, highest + 1) }
}

/**
 * Writes `{ preamble, decisions, next }` back as the Field's text. `prefix` is the Definition's (default
 * `KD`). Every part with words in it is written, whichever style it belongs to, so changing a
 * Definition's style never loses what was written in the other.
 */
export function serialiseKeyDecisions(parsed, { prefix = DEFAULT_PREFIX } = {}) {
  const blocks = []
  if (parsed.preamble && parsed.preamble.trim() !== '') blocks.push(parsed.preamble.trim())
  for (const decision of parsed.decisions ?? []) {
    const heading = `**${decisionReference(prefix, decision.number)}${decision.title.trim() === '' ? '' : `: ${decision.title.trim().replace(/\s+/g, ' ')}`}**`
    const lines = [heading]
    if (decision.lead && decision.lead.trim() !== '') lines.push('', decision.lead.trim().split('\n').map(escapeLine).join('\n'))
    const written = []
    for (const part of [...STYLE_PARTS.default, ...STYLE_PARTS.why]) {
      const value = (decision[part.key] ?? '').trim()
      // The first line follows its label, so it is never at the start of a line; only the lines after it can look like structure.
      if (value !== '') written.push(`**${part.label}:** ${escapeFollowingLines(value)}`)
    }
    for (const link of LINK_TYPES) {
      const targets = (decision.links ?? []).filter((entry) => entry.type === link.type)
      if (targets.length === 0) continue
      written.push(`**${link.label}:** ${targets.map((entry) => (entry.to !== null && entry.to !== undefined ? decisionReference(prefix, entry.to) : entry.raw)).join(', ')}`)
    }
    // A blank line between every part: parts of one paragraph would otherwise run together in Word.
    for (const part of written) lines.push('', part)
    blocks.push(lines.join('\n'))
  }
  const highest = (parsed.decisions ?? []).reduce((max, d) => Math.max(max, d.number), 0)
  if ((parsed.next ?? 0) > highest + 1) blocks.push(`<!-- next: ${parsed.next} -->`)
  return blocks.join('\n\n')
}

/** The number the next new decision takes: above every number present and every number ever handed out. */
export function nextDecisionNumber(parsed) {
  const highest = (parsed.decisions ?? []).reduce((max, d) => Math.max(max, d.number), 0)
  return Math.max(parsed.next ?? 0, highest + 1)
}

/** `parsed` with one new, empty decision on the end (it takes the next number, and the high-water mark moves on). */
export function addDecision(parsed) {
  const number = nextDecisionNumber(parsed)
  return { ...parsed, decisions: [...parsed.decisions, blankDecision(number)], next: number + 1 }
}

/** `parsed` without the decision numbered `number`. The high-water mark stays, so the number is never reused. */
export function removeDecision(parsed, number) {
  return { ...parsed, next: nextDecisionNumber(parsed), decisions: parsed.decisions.filter((d) => d.number !== number) }
}

/** `parsed` with the decision numbered `number` moved by `delta` places (negative is up). Numbers do not change. */
export function moveDecision(parsed, number, delta) {
  const from = parsed.decisions.findIndex((d) => d.number === number)
  const to = from + delta
  if (from < 0 || to < 0 || to >= parsed.decisions.length) return parsed
  const decisions = parsed.decisions.slice()
  const [moved] = decisions.splice(from, 1)
  decisions.splice(to, 0, moved)
  return { ...parsed, decisions }
}

/** Whether a decision has words in any part of the given style. */
export function hasStyleText(decision, style) {
  return STYLE_PARTS[style].some((part) => (decision[part.key] ?? '').trim() !== '')
}

const sentenceBit = (text) => text.replace(/\s+/g, ' ').trim().replace(/[.;,\s]+$/, '')

/** The WH(Y) statement as one sentence, from the parts that have words: "In the context of …, facing …, we decided for … and neglected …, to achieve …, accepting that …." */
export function whySentence(decision) {
  const get = (key) => sentenceBit(decision[key] ?? '')
  const clauses = []
  if (get('inContext')) clauses.push(`In the context of ${get('inContext')}`)
  if (get('facing')) clauses.push(`facing ${get('facing')}`)
  let decided = ''
  if (get('decided')) decided = `we decided for ${get('decided')}`
  if (get('neglected')) decided += `${decided ? ' and ' : ''}neglected ${get('neglected')}`
  if (decided) clauses.push(decided)
  if (get('achieve')) clauses.push(`to achieve ${get('achieve')}`)
  if (get('accepting')) clauses.push(`accepting that ${get('accepting')}`)
  if (clauses.length === 0) return ''
  const sentence = clauses.join(', ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

/**
 * The Field's text as the document prints it. The default style prints as written. WH(Y) prints each
 * decision's six parts as the one sentence the style is named for, then a line for each kind of link
 * ("Depends on AD01, AD04."), with every reference spelt with the Definition's current prefix. Text with
 * no decisions in it is returned as it is, so a Field written by hand before it was a Key decisions
 * Field still prints.
 */
export function renderKeyDecisions(text, { prefix = DEFAULT_PREFIX, style = DEFAULT_STYLE } = {}) {
  const parsed = parseKeyDecisions(text)
  if (parsed.decisions.length === 0) return String(text ?? '')
  if (style !== 'why') return serialiseKeyDecisions({ ...parsed, next: 0 }, { prefix })
  const blocks = []
  if (parsed.preamble !== '') blocks.push(parsed.preamble)
  for (const decision of parsed.decisions) {
    const heading = `**${decisionReference(prefix, decision.number)}${decision.title.trim() === '' ? '' : `: ${decision.title.trim().replace(/\s+/g, ' ')}`}**`
    const lines = [heading]
    if (decision.lead.trim() !== '') lines.push('', decision.lead.trim())
    const sentence = whySentence(decision)
    if (sentence) lines.push('', sentence)
    // A default-style part written before the Definition moved to WH(Y) is kept, as it was written.
    for (const part of STYLE_PARTS.default) {
      const value = (decision[part.key] ?? '').trim()
      if (value !== '') lines.push('', `**${part.label}:** ${value}`)
    }
    for (const link of LINK_TYPES) {
      const targets = decision.links.filter((entry) => entry.type === link.type)
      if (targets.length === 0) continue
      lines.push('', `${link.label} ${targets.map((entry) => (entry.to !== null ? decisionReference(prefix, entry.to) : entry.raw)).join(', ')}.`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

/**
 * What is wrong with the Field's decisions, as plain sentences: a number used twice, a decision that
 * links to a number that is not there, to itself, or by something that is not a decision number, and a
 * `depends on` or `supersedes` loop. Content problems, so they warn rather than block (as an off-list
 * select value does, ADR-0044). `style` is the Definition's: links belong to WH(Y), so a default-style
 * Field holding any is flagged.
 */
export function keyDecisionProblems(text, { prefix = DEFAULT_PREFIX, style = DEFAULT_STYLE } = {}) {
  const parsed = parseKeyDecisions(text)
  const problems = []
  const ref = (n) => decisionReference(prefix, n)
  const seen = new Set()
  const duplicated = new Set()
  for (const decision of parsed.decisions) {
    if (seen.has(decision.number)) duplicated.add(decision.number)
    seen.add(decision.number)
  }
  for (const n of duplicated) problems.push(`${ref(n)} is used by more than one decision`)
  for (const decision of parsed.decisions) {
    for (const link of decision.links) {
      const label = LINK_TYPES.find((entry) => entry.type === link.type).label.toLowerCase()
      if (link.to === null) problems.push(`${ref(decision.number)} ${label} "${link.raw}", which is not a decision number`)
      else if (link.to === decision.number) problems.push(`${ref(decision.number)} ${label} itself`)
      else if (!seen.has(link.to)) problems.push(`${ref(decision.number)} ${label} ${ref(link.to)}, which is not in this list`)
    }
    if (style !== 'why' && decision.links.length > 0) problems.push(`${ref(decision.number)} has links, but this Definition uses the default decision style, which has none`)
  }
  for (const type of ['depends-on', 'supersedes']) {
    const edges = new Map()
    for (const decision of parsed.decisions) {
      for (const link of decision.links) if (link.type === type && link.to !== null && link.to !== decision.number && seen.has(link.to)) edges.set(decision.number, [...(edges.get(decision.number) ?? []), link.to])
    }
    const reported = new Set()
    const walk = (start, node, path) => {
      for (const to of edges.get(node) ?? []) {
        if (to === start) {
          const loop = [...path, node].sort((a, b) => a - b).join(',')
          if (!reported.has(loop)) {
            reported.add(loop)
            problems.push(`${type === 'depends-on' ? 'Depends on' : 'Supersedes'} loops back on itself through ${[...path, node].map(ref).join(', ')}`)
          }
        } else if (!path.includes(to) && path.length < 50) walk(start, to, [...path, node])
      }
    }
    for (const start of edges.keys()) walk(start, start, [])
  }
  return problems
}
