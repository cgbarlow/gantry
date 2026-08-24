// The formatting toolbar's engine (#133): deterministic plain-text transforms,
// per docs/adr/0004 and docs/adr/0017 — every affordance computes a new
// (text, from, to) triple from the old one, and the caller lands it in a
// single CodeMirror transaction. Nothing here imports CodeMirror or touches
// the DOM: web/app.js's MarkdownField reads out doc/selection/syntax-tree and
// dispatches what these functions return. That seam is what makes every
// toggle unit-testable in Node against plain strings and fake tree nodes.
//
// Smart toggling consults the lezer syntax tree rather than sniffing for
// markers so the answer survives nesting and partial selections: pressing B
// with the cursor anywhere inside `**a *b* c**` un-bolds the whole strong
// region even though the selection touches none of the asterisks. The tree is
// passed in behind a deliberately tiny contract — `resolveInner(pos)` must
// return nodes shaped `{ name, from, to, parent }`, exactly what @lezer/common's
// SyntaxNode satisfies and what the Node tests stub. A null tree degrades to
// naive checks so transforms stay usable standalone.

export const HEADING_LEVELS = [3, 4, 5, 6]

const INLINE_KINDS = {
  bold: { marker: '**', node: 'StrongEmphasis' },
  italic: { marker: '*', node: 'Emphasis' },
  strikethrough: { marker: '~~', node: 'Strikethrough' },
  inlineCode: { marker: '`', node: 'InlineCode' },
}

// ---------- shared text plumbing ----------

// Half-open line range containing `pos` (trailing newline excluded).
function lineRangeAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1
  const nl = text.indexOf('\n', pos)
  return { start, end: nl === -1 ? text.length : nl }
}

// One entry point for the block-level toggles: walks the lines spanned by
// [from, to], asks `decide(lines)` once for the whole span (add-vs-remove is a
// bulk judgement, not a per-line coin flip), applies `transform` per line with
// that verdict, then maps both selection bounds through each line's length
// delta so the selection stays pinned to the content it pointed at. A bound
// sitting anywhere on a changed line — including at its start, ahead of an
// inserted prefix — rides that line's delta.
function rewriteLines(text, from, to, decide, transform) {
  const first = lineRangeAt(text, from)
  const last = lineRangeAt(text, to > from ? to - 1 : from)

  const lines = []
  let pos = first.start
  while (true) {
    const nl = text.indexOf('\n', pos)
    const end = nl === -1 ? text.length : nl
    lines.push({ start: pos, end, raw: text.slice(pos, end) })
    if (nl === -1 || end >= last.end) break
    pos = nl + 1
  }

  const removing = decide(lines)

  let rebuilt = ''
  let delta = 0
  const deltas = []
  for (const line of lines) {
    // A blank interior line of a multi-line span is a gap between paragraphs,
    // never a list target; a LONE blank line is the empty-cursor case and is.
    const soleTarget = lines.length === 1 && isBlank(line.raw)
    const updated = !removing && isBlank(line.raw) && !soleTarget ? line.raw : transform(line.raw, removing)
    deltas.push(updated.length - line.raw.length)
    delta += updated.length - line.raw.length
    rebuilt += updated
    if (line.end < last.end || (line.end === last.end && text[line.end] === '\n')) rebuilt += '\n'
  }

  const mapBound = (p) => {
    let shift = 0
    for (let i = 0; i < lines.length; i++) {
      if (p < lines[i].start) break
      if (p <= lines[i].end || i === lines.length - 1) {
        // A prefix stripped at the line's own start can push the mapped bound
        // before the span's start — clamp so a cursor parked at the line start
        // stays there instead of sliding negative.
        return Math.max(p + shift + deltas[i], first.start)
      }
      shift += deltas[i]
    }
    return p + delta
  }

  return {
    text: text.slice(0, first.start) + rebuilt + text.slice(lines[lines.length - 1].end),
    from: mapBound(from),
    to: mapBound(to),
  }
}

const isBlank = (line) => line.trim() === ''

// ---------- inline formats (B / I / S / inline code) ----------

// Deepest ancestor of the node at `probe` matching `nodeName` whose *content*
// range (markers stripped) intersects [from, to]. Intersecting is enough —
// mainstream editors un-bold the entire region when any part of it is
// touched, and partial coverage must never double-wrap.
function coveringFormatNode(tree, from, to, nodeName, markerLen) {
  if (!tree || typeof tree.resolveInner !== 'function') return null
  let node = tree.resolveInner(from)
  while (node) {
    if (
      node.name === nodeName &&
      from <= node.to - markerLen &&
      Math.max(to, from) >= node.from + markerLen
    ) {
      return node
    }
    node = node.parent
  }
  return null
}

export function toggleInline({ tree, text, from, to, kind }) {
  const { marker, node: nodeName } = INLINE_KINDS[kind]
  const len = marker.length

  const node = coveringFormatNode(tree, from, to, nodeName, len)
  if (node) {
    const contentFrom = node.from + len
    const contentTo = node.to - len
    const next =
      text.slice(0, node.from) + text.slice(contentFrom, contentTo) + text.slice(node.to)
    const map = (p) => Math.min(Math.max(p - len, node.from), contentTo)
    return { text: next, from: map(from), to: map(Math.max(to, from)) }
  }

  if (from === to) {
    // Empty cursor: lay down an empty pair (`****`) so whatever is typed next
    // lands between the markers, like typing-into-format in any mainstream
    // editor.
    return {
      text: text.slice(0, from) + marker + marker + text.slice(to),
      from: from + len,
      to: to + len,
    }
  }

  return {
    text: text.slice(0, from) + marker + text.slice(from, to) + marker + text.slice(to),
    from: from + len,
    to: to + len,
  }
}

// ---------- links ----------

const LINK_LITERAL = /^\[[^\]]*\]\([^)]*\)$/

export function toggleLink({ tree, text, from, to }) {
  // Inside a Link node (lezer knows even mid-label)? Or, treeless, does some
  // `[label](target)` literal straddle the selection? Either way, unwrap to
  // the label.
  let span = null
  let node = null
  if (tree && typeof tree.resolveInner === 'function') {
    node = tree.resolveInner(from)
    while (node) {
      if (node.name === 'Link' && node.from <= from && Math.max(to, from) <= node.to) break
      node = node.parent
    }
  }
  if (!node) {
    const open = text.lastIndexOf('[', Math.max(from - 1, 0))
    const close = text.indexOf(')', Math.max(to - 1, 0))
    if (open !== -1 && close !== -1 && LINK_LITERAL.test(text.slice(open, close + 1))) {
      node = { from: open, to: close + 1 }
    }
  }
  if (node) {
    const m = LINK_LITERAL.exec(text.slice(node.from, node.to))
    if (m) span = node
  }

  if (span) {
    const label = text.slice(span.from + 1, text.indexOf(']', span.from))
    return { text: text.slice(0, span.from) + label + text.slice(span.to), from: span.from, to: span.from + label.length }
  }

  if (from !== to) {
    const selected = text.slice(from, to)
    // A bare URL becomes `[](url)` ready for a label; anything else wraps as
    // `[text](url)` with the url slot selected for immediate typing.
    if (!/\s/.test(selected.trim()) && /^(https?:\/\/|\/|mailto:|#)/.test(selected.trim())) {
      return {
        text: text.slice(0, from) + '[](' + selected.trim() + ')' + text.slice(to),
        from: from + 1,
        to: from + 1,
      }
    }
    return {
      text: text.slice(0, from) + '[' + selected + '](url)' + text.slice(to),
      from: from + selected.length + 3,
      to: from + selected.length + 6,
    }
  }

  return { text: text.slice(0, from) + '[text](url)' + text.slice(to), from: from + 1, to: from + 5 }
}

// ---------- block-level prefixes ----------

const LIST_PREFIX = /^([ \t]*)(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]+/
const TASK_PREFIX = /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/
const BULLET_PREFIX = /^[ \t]*[-*+][ \t]+(?!\[[ xX]\])/
const NUMBERED_PREFIX = /^[ \t]*\d+[.)][ \t]+/
const QUOTE_PREFIX = /^([ \t]*)>[ ]?/

function listMarker(kind) {
  return kind === 'bullet' ? '- ' : kind === 'numbered' ? '1. ' : '- [ ] '
}

export function toggleList({ text, from, to, kind }) {
  const own =
    kind === 'bullet' ? BULLET_PREFIX : kind === 'numbered' ? NUMBERED_PREFIX : TASK_PREFIX
  // Each remove keeps the line's indent and drops exactly that kind's marker.
  const stripOwn =
    kind === 'bullet'
      ? /^([ \t]*)[-*+][ \t]+/
      : kind === 'numbered'
        ? /^([ \t]*)\d+[.)][ \t]+/
        : /^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/

  return rewriteLines(
    text,
    from,
    to,
    // Remove only when every non-blank line already carries THIS kind — but a
    // lone blank line (the empty-cursor case) is always an add target: it
    // starts the list rather than "removing" from nothing.
    (lines) =>
      lines.every((l) => isBlank(l.raw) || own.test(l.raw)) &&
      !(lines.length === 1 && isBlank(lines[0].raw)),
    (line, removing) =>
      removing
        ? line.replace(stripOwn, '$1')
        : listMarker(kind) + line.replace(LIST_PREFIX, '$1').replace(QUOTE_PREFIX, '')
  )
}

export function toggleBlockquote({ text, from, to }) {
  return rewriteLines(
    text,
    from,
    to,
    (lines) => lines.every((l) => isBlank(l.raw) || QUOTE_PREFIX.test(l.raw)),
    (line, removing) => (removing ? line.replace(QUOTE_PREFIX, '$1') : '> ' + line)
  )
}

export function toggleHeading({ text, from, to, level }) {
  const wanted = '#'.repeat(level) + ' '
  return rewriteLines(
    text,
    from,
    to,
    // Headings are set-level, not add/remove: re-invoking the current level is
    // what strips the markers; picking any other level rewrites in place.
    () => false,
    (line) => {
      const m = /^([ \t]*)(#{1,6})(?:[ \t]+|$)/.exec(line)
      if (!m) return wanted + line.replace(LIST_PREFIX, '$1')
      const [, indent, hashes] = m
      const rest = line.slice(m[0].length)
      return hashes.length === level ? indent + rest : indent + wanted + rest
    }
  )
}

// ---------- horizontal rule & fenced code block ----------

export function insertHorizontalRule({ text, from, to }) {
  const before = text.slice(0, from)
  const after = text.slice(to)

  // Blank-line hygiene: `---` needs an empty line on both sides to stay a
  // thematic break rather than gluing onto prose (or becoming a setext
  // underline for the paragraph above).
  const lead = from === 0 ? '' : /(\n\n|\n)$/.test(before) ? (before.endsWith('\n\n') ? '' : '\n') : '\n\n'
  const trail = to === text.length ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'

  return {
    text: before + lead + '---' + trail + after,
    from: from + lead.length + 3,
    to: from + lead.length + 3,
  }
}

export function toggleFencedCode({ tree, text, from, to }) {
  // Already inside a fence (the tree knows even when the selection excludes
  // the backticks)? Strip the fence lines themselves, keeping the body.
  let fence = null
  if (tree && typeof tree.resolveInner === 'function') {
    let node = tree.resolveInner(from)
    while (node) {
      if (node.name === 'FencedCode') {
        fence = node
        break
      }
      node = node.parent
    }
  }

  if (fence) {
    const openStart = lineRangeAt(text, fence.from).start
    const openNl = text.indexOf('\n', fence.from)
    const bodyStart = openNl === -1 ? openStart : openNl + 1
    const closeStart = text.lastIndexOf('\n', Math.max(fence.to - 1, 0)) + 1
    const closingLine = text.slice(closeStart, fence.to)
    if (bodyStart <= closeStart && closingLine.trim().startsWith('```')) {
      const body = text.slice(bodyStart, closeStart).replace(/\n$/, '')
      return {
        text: text.slice(0, openStart) + body + text.slice(fence.to),
        from: openStart,
        to: openStart + body.length,
      }
    }
  }

  const first = lineRangeAt(text, from)
  const last = lineRangeAt(text, Math.max(to, from))
  const body = text.slice(first.start, last.end)

  if (isBlank(body)) {
    // Empty cursor (or blank lines): drop an empty fence pair with the cursor
    // parked on the middle line, ready for the snippet.
    return {
      text: text.slice(0, first.start) + '```\n\n```' + text.slice(last.end),
      from: first.start + 4,
      to: first.start + 4,
    }
  }

  return {
    text: text.slice(0, first.start) + '```\n' + body + '\n```' + text.slice(last.end),
    from: first.start + 4,
    to: first.start + 4 + body.length,
  }
}

// ---------- dispatcher ----------

// One entry point for the toolbar/keymap layer: names mirror button
// identities; headings arrive as `heading3`..`heading6`.
export function apply(command, state) {
  if (INLINE_KINDS[command]) return toggleInline({ ...state, kind: command })
  switch (command) {
    case 'link':
      return toggleLink(state)
    case 'bulletList':
      return toggleList({ ...state, kind: 'bullet' })
    case 'numberedList':
      return toggleList({ ...state, kind: 'numbered' })
    case 'taskList':
      return toggleList({ ...state, kind: 'task' })
    case 'blockquote':
      return toggleBlockquote(state)
    case 'horizontalRule':
      return insertHorizontalRule(state)
    case 'codeBlock':
      return toggleFencedCode(state)
    default: {
      const heading = /^heading([3-6])$/.exec(command)
      if (heading) return toggleHeading({ ...state, level: Number(heading[1]) })
      throw new Error(`Unknown markdown command: ${command}`)
    }
  }
}
