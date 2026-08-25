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

// ---------- tables (#134) ----------
//
// Microsoft-Loop-style editing over GFM pipe tables, in the same pure-transform
// seam as everything above. One deliberate divergence from the inline/block
// commands: @codemirror/lang-markdown's default parser does not recognise pipe
// tables (its GFM Table extension only marks ranges, not cell structure), so
// the tree is useless here and these commands read a strict line-based parse
// instead — see docs/adr/0018. Strictness IS the graceful-degradation story:
// any line run that isn't an unambiguous, rectangular pipe table parses as
// null, and every command then returns null (no-op) rather than improvising a
// repair the author didn't ask for. Unlike the block toggles, null is a normal
// return here — the dispatcher routes table commands the same way but callers
// must treat null as "nothing happened".

const ALIGNMENT_ORDER = ['left', 'center', 'right']

const DELIMITER_CELL = /^:?-+:?$/

// Unescaped pipe positions in a line — `\|` never separates cells.
function scanPipes(lineText) {
  const pipes = []
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === '\\') {
      i++
      continue
    }
    if (lineText[i] === '|') pipes.push(i)
  }
  return pipes
}

// Split one line into raw cell segments between its unescaped pipes, keeping
// each segment's absolute [start, end) so rebuilds preserve the author's
// internal padding byte-for-byte. Leading/trailing pipes produce edge
// segments that are dropped; interior empties are real empty cells.
function splitSegments(lineText, lineStart) {
  const pipes = scanPipes(lineText)
  if (pipes.length === 0) return null
  const bounds = []
  let prev = -1
  for (const p of [...pipes, lineText.length]) {
    bounds.push([prev, p])
    prev = p
  }
  const segs = []
  for (const [a, b] of bounds) {
    const start = a + 1
    const end = b
    if (start >= end && (a === -1 || b === lineText.length)) continue
    const raw = lineText.slice(start, end)
    const trimmed = raw.trim()
    const leadSpaces = raw.length - raw.trimStart().length
    // Empty cells park the caret mid-padding (Loop-style) rather than flush
    // against the closing pipe; non-empty ones use their real content range.
    const caretOffset = trimmed === '' ? Math.ceil(raw.length / 2) : leadSpaces
    segs.push({
      raw,
      start: lineStart + start,
      end: lineStart + end,
      text: trimmed,
      contentStart: lineStart + start + caretOffset,
      contentEnd: lineStart + start + caretOffset + trimmed.length,
    })
  }
  return segs.length ? segs : null
}

// Parse the run of pipe-bearing lines around `pos` into a table. Returns null
// unless the run contains a rectangular pipe table under the cursor: exactly
// one delimiter row, a header immediately above it, and every row — header,
// delimiter and body alike — carrying the same cell count. Lines the scan
// picked up *above* the header are prose that merely carries pipes, not table
// structure: they're excluded from the parse (and never rewritten), and a
// caret among them means "not in a table". The returned record also locates
// the cursor: rowIndex/colIndex (the delimiter row is a real row index but
// never reported as the cursor's column owner — pipes resolve to the cell on
// their left, padding to its cell).
export function findTable(text, pos) {
  const probe = Math.min(Math.max(pos, 0), text.length)
  const startOfLine = (p) => text.lastIndexOf('\n', p - 1) + 1
  const endOfLine = (p) => {
    const e = text.indexOf('\n', p)
    return e === -1 ? text.length : e
  }
  const hasPipes = (start, end) => scanPipes(text.slice(start, end)).length > 0

  // The candidate region is the maximal run of pipe-bearing lines around the
  // cursor; the delimiter row then decides where the table itself starts.
  const cursorStart = startOfLine(probe)
  if (!hasPipes(cursorStart, endOfLine(cursorStart))) return null

  const lines = []
  const segsPerLine = []
  const push = (ls, atFront) => {
    const end = endOfLine(ls)
    const segs = splitSegments(text.slice(ls, end), ls)
    if (!segs) return false
    // Above-cursor lines arrive scanned bottom-up, so they prepend to keep
    // lines[]/segsPerLine[] in document order.
    if (atFront) {
      lines.unshift({ start: ls, end })
      segsPerLine.unshift(segs)
    } else {
      lines.push({ start: ls, end })
      segsPerLine.push(segs)
    }
    return true
  }

  if (!push(cursorStart)) return null
  for (let up = cursorStart; up > 0; ) {
    const prevStart = startOfLine(up - 1)
    if (!hasPipes(prevStart, up - 1) || !push(prevStart, true)) break
    up = prevStart
  }
  for (let dn = endOfLine(cursorStart); dn < text.length; ) {
    const nextStart = dn + 1
    if (!hasPipes(nextStart, endOfLine(nextStart)) || !push(nextStart)) break
    dn = endOfLine(nextStart)
  }

  const isDelim = segsPerLine.map((segs) => segs.every((c) => DELIMITER_CELL.test(c.text)))
  const delimCandidates = []
  for (let i = 0; i < lines.length; i++) if (isDelim[i]) delimCandidates.push(i)
  if (delimCandidates.length !== 1) return null
  let delimIndex = delimCandidates[0]
  if (delimIndex === 0) return null

  // A GFM table begins at its header — the line immediately above the
  // delimiter. Anything above that is prose with pipes in it: exclude it so
  // commands never rebuild it, and treat a caret there as not-in-a-table.
  if (delimIndex > 1) {
    if (probe < lines[delimIndex - 1].start) return null
    const cut = delimIndex - 1
    lines.splice(0, cut)
    segsPerLine.splice(0, cut)
    delimIndex -= cut
  }

  const colCount = segsPerLine[delimIndex].length
  if (colCount < 1) return null
  for (const segs of segsPerLine) {
    if (segs.length !== colCount) return null
  }

  const alignments = segsPerLine[delimIndex].map((c) =>
    c.text.startsWith(':') && c.text.endsWith(':') ? 'center' : c.text.endsWith(':') ? 'right' : 'left'
  )

  let rowIndex = lines.findIndex((l) => probe >= l.start && probe <= l.end)
  if (rowIndex === -1) rowIndex = lines.length - 1
  const lineStart = lines[rowIndex].start
  const rel = probe - lineStart
  const rawLine = text.slice(lines[rowIndex].start, lines[rowIndex].end)
  const pipesBefore = scanPipes(rawLine.slice(0, rel)).length
  const hasLeadingPipe = rawLine.trimStart().startsWith('|')
  const colIndex = Math.min(Math.max(pipesBefore - (hasLeadingPipe ? 1 : 0), 0), colCount - 1)

  return {
    start: lines[0].start,
    end: lines[lines.length - 1].end,
    lines,
    segs: segsPerLine,
    colCount,
    delimIndex,
    alignments,
    rowIndex,
    colIndex,
  }
}

// Canonical line rebuild: outer pipes normalised, interior segments (padding
// included) verbatim.
const rebuildLine = (segs) => '|' + segs.map((c) => c.raw).join('|') + '|'

const emptySegment = (width) => ' '.repeat(Math.max(width, 1))

// Delimiter segment for an alignment at a given total segment width — the
// two-space frame mirrors how rebuildLine's cells read; cores shorter than
// GFM's minimum grow rather than emit `::`.
function alignmentSegment(align, width) {
  const coreWidth = Math.max(width - 2, align === 'center' ? 4 : 3)
  const dashes = '-'.repeat(align === 'center' ? coreWidth - 2 : align === 'right' ? coreWidth - 1 : coreWidth)
  const core = align === 'center' ? ':' + dashes + ':' : align === 'right' ? dashes + ':' : dashes
  return ' ' + core + ' '
}

function clampPos(pos, length) {
  return Math.min(Math.max(pos, 0), length)
}

// Land the cursor inside whatever table now surrounds `pos`: collapse onto the
// owning cell's content start. Tables that stopped parsing under the new text
// degrade to a plain clamped position.
function snapToCell(text, pos) {
  const t = findTable(text, clampPos(pos, text.length))
  if (!t) return clampPos(pos, text.length)
  const r = Math.min(t.rowIndex, t.lines.length - 1)
  const c = Math.min(t.colIndex, t.colCount - 1)
  return t.segs[r][c].contentStart
}

export function insertTable({ text, from, to, rows = 3, cols = 3 }) {
  const rowCount = Math.min(Math.max(Math.round(rows) || 3, 1), 30)
  const colCount = Math.min(Math.max(Math.round(cols) || 3, 1), 15)
  const headers = Array.from({ length: colCount }, (_, i) => `Header ${i + 1}`)
  const widths = headers.map((h) => Math.max(h.length, 3))
  const line = (cells) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
  const headerLine = line(headers)
  const delimLine = line(widths.map((w) => '-'.repeat(w)))
  const table = [
    headerLine,
    delimLine,
    ...Array.from({ length: rowCount }, () => line(widths.map(() => ''))),
  ].join('\n')

  // Same blank-line hygiene as insertHorizontalRule: a table glued to prose
  // stops being a table (or drags the paragraph above into a setext heading).
  const before = text.slice(0, from)
  const after = text.slice(to)
  const lead = from === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = to === text.length ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'

  const inserted = lead + table + trail
  const nextText = before + inserted + after
  return {
    text: nextText,
    // Cursor opens in the first body cell, ready to type over the padding.
    from: snapToCell(nextText, from + lead.length + headerLine.length + 1 + delimLine.length + 1),
    to: snapToCell(nextText, from + lead.length + headerLine.length + 1 + delimLine.length + 1),
  }
}

export function tableAddRow({ text, from, to, where }) {
  const t = findTable(text, from)
  if (!t) return null

  let insertAfter
  if (where === 'below') {
    // Above-the-fold rows don't exist: "below" the header or delimiter lands
    // the new row as the first body row.
    insertAfter = Math.max(t.rowIndex, t.delimIndex)
  } else {
    if (t.rowIndex <= t.delimIndex) return null
    insertAfter = t.rowIndex - 1
  }

  // Widths follow the neighbouring row so the column edges stay lined up.
  const widths = t.segs[insertAfter].map((c) => Math.max(c.text.length, 1))
  const newRow = '| ' + widths.map((w) => emptySegment(w)).join(' | ') + ' |'
  const at = t.lines[insertAfter].end
  const nextText = text.slice(0, at) + '\n' + newRow + text.slice(at)
  const cellPos = snapToCell(nextText, at + 3)
  return { text: nextText, from: cellPos, to: cellPos }
}

export function tableDeleteRow({ text, from, to }) {
  const t = findTable(text, from)
  if (!t) return null
  if (t.rowIndex === t.delimIndex) return null

  let nextText
  let roughPos
  if (t.rowIndex === 0) {
    // Deleting the header promotes the first body row into its slot (the
    // delimiter must keep a header above it); with no body rows there is
    // nothing to promote, so the command stands down.
    if (t.lines.length <= 2) return null
    const [, delimLine, firstBody] = t.lines
    nextText =
      text.slice(0, t.start) +
      text.slice(firstBody.start, firstBody.end) +
      '\n' +
      text.slice(delimLine.start, delimLine.end) +
      text.slice(firstBody.end)
    roughPos = t.start
  } else {
    const line = t.lines[t.rowIndex]
    // Eat one adjoining newline so the remaining rows knit back together;
    // at end-of-document the preceding newline goes instead.
    const fromIdx = line.end === text.length && line.start > 0 ? line.start - 1 : line.start
    const toIdx = line.end === text.length ? line.end : Math.min(line.end + 1, text.length)
    nextText = text.slice(0, fromIdx) + text.slice(toIdx)
    roughPos = fromIdx
  }
  const cellPos = snapToCell(nextText, roughPos)
  return { text: nextText, from: cellPos, to: cellPos }
}

export function tableAddColumn({ text, from, to, side }) {
  const t = findTable(text, from)
  if (!t) return null
  const insertAt = side === 'left' ? t.colIndex : t.colIndex + 1

  const rebuilt = []
  for (let r = 0; r < t.lines.length; r++) {
    const segs = t.segs[r].slice()
    // Each row's new cell borrows its neighbour column's own width, keeping
    // every existing edge aligned; the delimiter's fresh cell runs left.
    const width = Math.max(segs[Math.min(insertAt, segs.length - 1)].text.length, 1)
    segs.splice(insertAt, 0, { raw: r === t.delimIndex ? alignmentSegment('left', width + 2) : emptySegment(width) })
    rebuilt.push(rebuildLine(segs))
  }

  const nextText = text.slice(0, t.start) + rebuilt.join('\n') + text.slice(t.end)
  // Cursor rides along in the same row, parked inside the freshly inserted column.
  return parkedCursor(t.start, nextText, rebuilt, t.rowIndex, insertAt)
}

// Shared tail of the column commands: walk to the caret's row in the rebuilt
// text and park inside cell (rowIndex, preferredCol), resolved by re-parsing
// rather than arithmetic — arithmetic through edited pipe lines is exactly how
// off-by-ones happen.
function parkedCursor(tableStart, nextText, rebuiltLines, rowIndex, preferredCol) {
  let roughPos = tableStart
  for (let r = 0; r < rowIndex; r++) roughPos += rebuiltLines[r].length + 1
  const t2 = findTable(nextText, clampPos(roughPos, nextText.length))
  if (!t2) {
    const pos = clampPos(roughPos, nextText.length)
    return { text: nextText, from: pos, to: pos }
  }
  const cell = t2.segs[t2.rowIndex][Math.min(preferredCol, t2.colCount - 1)]
  return { text: nextText, from: cell.contentStart, to: cell.contentEnd }
}

export function tableDeleteColumn({ text, from, to }) {
  const t = findTable(text, from)
  if (!t) return null

  if (t.colCount === 1) {
    // Out of columns, out of table — the Loop convention. Take one adjoining
    // newline with it so the neighbours don't fuse.
    const fromIdx = t.start > 0 && text[t.start - 1] === '\n' && text[t.end] === '\n' ? t.start - 1 : t.start
    const toIdx = text[t.end] === '\n' ? t.end + 1 : t.end
    const nextText = text.slice(0, fromIdx) + text.slice(toIdx)
    const pos = clampPos(fromIdx, nextText.length)
    return { text: nextText, from: pos, to: pos }
  }

  const rebuilt = t.segs.map((segs) => rebuildLine(segs.filter((_, c) => c !== t.colIndex)))
  const nextText = text.slice(0, t.start) + rebuilt.join('\n') + text.slice(t.end)
  // The caret stays in its own row, clamped to the nearest surviving column.
  return parkedCursor(t.start, nextText, rebuilt, t.rowIndex, t.colIndex)
}

export function tableCycleAlignment({ text, from, to }) {
  const t = findTable(text, from)
  if (!t) return null
  const next = ALIGNMENT_ORDER[(ALIGNMENT_ORDER.indexOf(t.alignments[t.colIndex]) + 1) % ALIGNMENT_ORDER.length]

  const segs = t.segs[t.delimIndex].slice()
  segs[t.colIndex] = { raw: alignmentSegment(next, segs[t.colIndex].raw.length) }
  const rebuilt = rebuildLine(segs)
  const line = t.lines[t.delimIndex]

  // Only the delimiter line is rewritten; positions past it ride the delta.
  const delta = rebuilt.length - (line.end - line.start)
  const map = (p) => (p <= line.start ? p : p >= line.end ? p + delta : line.start + rebuilt.length)
  const nextText = text.slice(0, line.start) + rebuilt + text.slice(line.end)
  const pos = map(from)
  return { text: nextText, from: pos, to: pos }
}

// Cell-to-cell walking skips the delimiter row — it's furniture, not a cell.
// Forward off the last cell appends a row (Loop behaviour); backward off the
// first reports null so the caller decides whether to consume the keypress.
function stepCell(t, r, c, dir) {
  if (dir === 'forward') {
    if (c < t.colCount - 1) return [r, c + 1]
    let nr = r + 1
    if (nr === t.delimIndex) nr++
    return nr < t.lines.length ? [nr, 0] : null
  }
  if (c > 0) return [r, c - 1]
  let nr = r - 1
  if (nr === t.delimIndex) nr--
  return nr >= 0 ? [nr, t.colCount - 1] : null
}

function cellFor(t, r, c) {
  return t.segs[r][c]
}

export function tableNextCell(state) {
  const t = findTable(state.text, state.from)
  if (!t) return null
  const next = stepCell(t, t.rowIndex, t.colIndex, 'forward')
  if (!next) return tableAddRow({ ...state, where: 'below' })
  const cell = cellFor(t, next[0], next[1])
  return { text: state.text, from: cell.contentStart, to: cell.contentEnd }
}

export function tablePrevCell(state) {
  const t = findTable(state.text, state.from)
  if (!t) return null
  const prev = stepCell(t, t.rowIndex, t.colIndex, 'back')
  if (!prev) return null
  const cell = cellFor(t, prev[0], prev[1])
  return { text: state.text, from: cell.contentStart, to: cell.contentEnd }
}

// ---------- dispatcher ----------

// One entry point for the toolbar/keymap layer: names mirror button
// identities; headings arrive as `heading3`..`heading6`. Table commands
// (#134) return null to mean "no well-formed table here — do nothing"
// instead of throwing; the keymap glue decides whether that consumes the
// keypress (Shift-Tab on the first cell) or falls through to plain typing
// (Enter anywhere but the last cell).
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
    case 'insertTable':
      return insertTable(state)
    case 'tableAddRowAbove':
      return tableAddRow({ ...state, where: 'above' })
    case 'tableAddRowBelow':
      return tableAddRow({ ...state, where: 'below' })
    case 'tableDeleteRow':
      return tableDeleteRow(state)
    case 'tableAddColumnLeft':
      return tableAddColumn({ ...state, side: 'left' })
    case 'tableAddColumnRight':
      return tableAddColumn({ ...state, side: 'right' })
    case 'tableDeleteColumn':
      return tableDeleteColumn(state)
    case 'tableCycleAlignment':
      return tableCycleAlignment(state)
    case 'tableNextCell':
      return tableNextCell(state)
    case 'tablePrevCell':
      return tablePrevCell(state)
    default: {
      const heading = /^heading([3-6])$/.exec(command)
      if (heading) return toggleHeading({ ...state, level: Number(heading[1]) })
      throw new Error(`Unknown markdown command: ${command}`)
    }
  }
}
