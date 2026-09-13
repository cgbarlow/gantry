import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  toggleInline,
  toggleList,
  toggleBlockquote,
  toggleHeading,
  toggleLink,
  insertHorizontalRule,
  toggleFencedCode,
  findTable,
  insertTable,
  findAllTables,
  tableCellText,
  tableCellSourceOffset,
  tableCellEdit,
  diffRange,
} from '../web/lib/markdownCommands.js'

// Fake syntax-tree pieces honouring the same contract as @lezer/common's
// SyntaxNode: { name, from, to, parent }, reached through resolveInner(pos).
// resolveInner always hands back the DEEPEST node here (real lezer may hand
// back a sibling mark or text node whose ancestor chain still contains these;
// the climb-under-parents logic under test is what matters). The chain reads
// outside-in — [encloser, ..., deepest] — and parent pointers point up.
function makeTree(chain) {
  for (let i = 1; i < chain.length; i++) chain[i].parent = chain[i - 1]
  const deepest = chain[chain.length - 1]
  return { resolveInner: () => deepest }
}

const strong = (from, to) => ({ name: 'StrongEmphasis', from, to })
const emphasis = (from, to) => ({ name: 'Emphasis', from, to })
const strike = (from, to) => ({ name: 'Strikethrough', from, to })
const code = (from, to) => ({ name: 'InlineCode', from, to })
const fenced = (from, to) => ({ name: 'FencedCode', from, to })

// ---------- inline formats ----------

test('bold wraps a selection and reports the content range', () => {
  assert.deepEqual(toggleInline({ tree: null, text: 'hello world', from: 0, to: 5, kind: 'bold' }), {
    text: '**hello** world',
    from: 2,
    to: 7,
  })
})

test('bold un-bolds when the cursor sits anywhere inside an existing strong region', () => {
  // "**hello** world", cursor between the l's — touches none of the asterisks.
  const tree = makeTree([strong(0, 9)])
  assert.deepEqual(toggleInline({ tree, text: '**hello** world', from: 4, to: 4, kind: 'bold' }), {
    text: 'hello world',
    from: 2,
    to: 2,
  })
})

test('bold un-bolds the whole region when only part of it is selected', () => {
  const tree = makeTree([strong(0, 9)])
  assert.deepEqual(toggleInline({ tree, text: '**hello** world', from: 2, to: 5, kind: 'bold' }), {
    text: 'hello world',
    from: 0,
    to: 3,
  })
})

test('empty cursor lays down an empty pair so typed text lands inside', () => {
  assert.deepEqual(toggleInline({ tree: null, text: 'ab', from: 1, to: 1, kind: 'italic' }), {
    text: 'a**b',
    from: 2,
    to: 2,
  })
  assert.deepEqual(toggleInline({ tree: null, text: '', from: 0, to: 0, kind: 'bold' }), {
    text: '****',
    from: 2,
    to: 2,
  })
  assert.deepEqual(toggleInline({ tree: null, text: '', from: 0, to: 0, kind: 'inlineCode' }), {
    text: '``',
    from: 1,
    to: 1,
  })
})

test('nested emphasis toggles the requested level, not the outermost', () => {
  // "***x***" modelled as Emphasis wrapping StrongEmphasis.
  const tree = makeTree([emphasis(0, 7), strong(0, 7)])
  assert.deepEqual(toggleInline({ tree, text: '***x***', from: 3, to: 3, kind: 'bold' }), {
    text: '*x*',
    from: 1,
    to: 1,
  })
  assert.deepEqual(toggleInline({ tree, text: '***x***', from: 3, to: 3, kind: 'italic' }), {
    text: '**x**',
    from: 2,
    to: 2,
  })
})

test('strikethrough and inline code toggle their own markers', () => {
  assert.equal(
    toggleInline({ tree: null, text: 'gone', from: 0, to: 4, kind: 'strikethrough' }).text,
    '~~gone~~'
  )
  const tree = makeTree([strike(0, 8)])
  assert.equal(
    toggleInline({ tree, text: '~~gone~~', from: 2, to: 4, kind: 'strikethrough' }).text,
    'gone'
  )
  const tree2 = makeTree([code(0, 5)])
  assert.equal(toggleInline({ tree: tree2, text: '`sig`', from: 1, to: 4, kind: 'inlineCode' }).text, 'sig')
})

// ---------- links ----------

test('link wraps prose with the url slot selected', () => {
  assert.deepEqual(toggleLink({ tree: null, text: 'see this now', from: 4, to: 8 }), {
    text: 'see [this](url) now',
    from: 11,
    to: 14,
  })
})

test('link turns a bare URL into [](url) ready for a label', () => {
  assert.deepEqual(toggleLink({ tree: null, text: 'open https://example.com now', from: 5, to: 24 }), {
    text: 'open [](https://example.com) now',
    from: 6,
    to: 6,
  })
})

test('link unwraps an existing link back to its label, tree or no tree', () => {
  const treeless = toggleLink({ tree: null, text: 'a [b](c.md) d', from: 4, to: 4 })
  assert.equal(treeless.text, 'a b d')
  assert.deepEqual([treeless.from, treeless.to], [2, 3])

  const treed = toggleLink(
    { text: 'a [b](c.md) d', from: 4, to: 4 },
  )
  assert.equal(treed.text, 'a b d')

  const linkNode = { name: 'Link', from: 2, to: 11 }
  const withTree = toggleLink({ tree: makeTree([{ name: 'CodeText', from: 4, to: 4 }, linkNode]), text: 'a [b](c.md) d', from: 4, to: 4 })
  assert.equal(withTree.text, 'a b d')
})

// ---------- lists ----------

test('bullet list adds, removes, and converts', () => {
  assert.deepEqual(toggleList({ text: '', from: 0, to: 0, kind: 'bullet' }), {
    text: '- ',
    from: 2,
    to: 2,
  })
  assert.deepEqual(toggleList({ text: '- item', from: 0, to: 6, kind: 'bullet' }), {
    text: 'item',
    from: 0,
    to: 4,
  })
  assert.equal(toggleList({ text: '1. step', from: 0, to: 7, kind: 'task' }).text, '- [ ] step')
  assert.equal(toggleList({ text: '- x', from: 0, to: 3, kind: 'numbered' }).text, '1. x')
})

test('multi-line list add skips interior blank lines and maps the selection', () => {
  const res = toggleList({ text: 'one\n\ntwo', from: 0, to: 8, kind: 'bullet' })
  assert.equal(res.text, '- one\n\n- two')
  assert.equal(res.from, 2)
  assert.equal(res.to, 12)
})

test('numbered items all emit 1. and let the renderer renumber', () => {
  const res = toggleList({ text: 'a\nb', from: 0, to: 3, kind: 'numbered' })
  assert.equal(res.text, '1. a\n1. b')
})

test('blockquote wraps and unwraps, keeping list content intact', () => {
  assert.equal(toggleBlockquote({ text: 'plain', from: 0, to: 5 }).text, '> plain')
  assert.equal(toggleBlockquote({ text: '> - kept', from: 0, to: 8 }).text, '- kept')
  assert.equal(toggleBlockquote({ text: '- x', from: 0, to: 3 }).text, '> - x')
})

// ---------- headings ----------

test('headings apply H3-H6, re-level, and toggle off on repeat', () => {
  assert.equal(toggleHeading({ text: 'Title', from: 0, to: 5, level: 3 }).text, '### Title')
  assert.equal(toggleHeading({ text: '### Title', from: 0, to: 9, level: 3 }).text, 'Title')
  assert.equal(toggleHeading({ text: '### Title', from: 0, to: 9, level: 5 }).text, '##### Title')
  assert.equal(toggleHeading({ text: '##### T', from: 0, to: 7, level: 6 }).text, '###### T')
})

test('heading markers without a trailing space stay content and get prefixed', () => {
  assert.equal(toggleHeading({ text: '#tag', from: 0, to: 4, level: 3 }).text, '### #tag')
})

// ---------- horizontal rule ----------

test('horizontal rule keeps blank-line hygiene in every position', () => {
  assert.deepEqual(insertHorizontalRule({ text: 'abcd', from: 2, to: 2 }), {
    text: 'ab\n\n---\n\ncd',
    from: 7,
    to: 7,
  })
  assert.equal(insertHorizontalRule({ text: 'x\n\n', from: 3, to: 3 }).text, 'x\n\n---')
  assert.equal(insertHorizontalRule({ text: 'doc start', from: 0, to: 0 }).text, '---\n\ndoc start')
  assert.equal(insertHorizontalRule({ text: 'the end', from: 7, to: 7 }).text, 'the end\n\n---')
  // Replaces any selection.
  assert.equal(insertHorizontalRule({ text: 'keep out', from: 5, to: 8 }).text, 'keep \n\n---')
})

// ---------- fenced code blocks ----------

test('fenced code drops an empty pair for an empty cursor and wraps real content', () => {
  assert.deepEqual(toggleFencedCode({ tree: null, text: '', from: 0, to: 0 }), {
    text: '```\n\n```',
    from: 4,
    to: 4,
  })
  const wrapped = toggleFencedCode({ tree: null, text: 'let x = 1', from: 0, to: 9 })
  assert.equal(wrapped.text, '```\nlet x = 1\n```')
  assert.deepEqual([wrapped.from, wrapped.to], [4, 13])
})

test('fenced code strips existing fence lines when the cursor is inside one', () => {
  const doc = '```js\nhi\n```'
  const tree = makeTree([fenced(0, doc.length)])
  assert.deepEqual(toggleFencedCode({ tree, text: doc, from: 7, to: 7 }), {
    text: 'hi',
    from: 0,
    to: 2,
  })
})

// ---------- tables (#134) ----------
//
// The table commands are exercised through the same apply() dispatcher the
// toolbar and keymap use, so name routing is covered alongside behaviour.

const TABLE = '| A | B |\n| --- | :--: |\n| one | two |\n| three | four |'

function posOf(text, needle, occurrence = 1) {
  let idx = -1
  for (let i = 0; i < occurrence; i++) idx = text.indexOf(needle, idx + 1)
  return idx
}

function dispatch(command, text, from, extra = {}) {
  return apply(command, { tree: null, text, from, to: from, ...extra })
}

test('findTable parses a rectangular pipe table and locates the cursor', () => {
  const t = findTable(TABLE, posOf(TABLE, 'three'))
  assert.ok(t)
  assert.equal(t.colCount, 2)
  assert.equal(t.delimIndex, 1)
  assert.deepEqual(t.alignments, ['left', 'center'])
  assert.equal(t.rowIndex, 3)
  assert.equal(t.colIndex, 0)
  // Cell content ranges exclude padding.
  const three = t.segs[3][0]
  assert.equal(three.text, 'three')
  assert.equal(TABLE.slice(three.contentStart, three.contentEnd), 'three')
})

test('findTable resolves a cursor sitting on a pipe or in padding to its cell', () => {
  const pipeBetweenBodyCells = TABLE.indexOf('|', TABLE.indexOf('one'))
  const t = findTable(TABLE, pipeBetweenBodyCells)
  assert.equal(t.colIndex, 0, 'cursor on the pipe owns the cell to its LEFT')
})

test('findTable rejects non-tables: no delimiter, ragged rows, two delimiter rows', () => {
  assert.equal(findTable('| just prose | with pipes |', 4), null)
  assert.equal(findTable('| a | b |\n| - |', 3), null)
  assert.equal(
    findTable('| a | b |\n| - | - |\n| c | d |\n| e | f |\n| - | - |', 10),
    null,
    'ambiguous double-delimiter run'
  )
  assert.equal(findTable('no pipes at all', 2), null)
})

test('findTable honours escaped pipes as content, not separators', () => {
  const doc = '| a \\| b | c |\n| --- | --- |\n| x | y |'
  const t = findTable(doc, 0)
  assert.ok(t)
  assert.equal(t.colCount, 2)
  assert.equal(t.segs[0][0].text, 'a \\| b')
})

test('findTable anchors on the header: pipe-bearing prose above it is not table structure', () => {
  const doc = 'note a | b\n| H1 | H2 |\n| -- | -- |\n| x | y |'
  const t = findTable(doc, posOf(doc, 'x'))
  assert.ok(t, 'valid table below prose still parses')
  assert.equal(t.colCount, 2)
  assert.equal(t.delimIndex, 1)
  assert.equal(t.start, doc.indexOf('| H1'), 'parse starts at the header line')
  // A caret sitting on the prose line was never "in a table".
  assert.equal(findTable(doc, 5), null)
})

test('column commands never rebuild pipe-bearing prose above the table', () => {
  const doc = 'note a | b\n| H1 | H2 |\n| -- | -- |\n| x | y |'
  const res = dispatch('tableAddColumnRight', doc, doc.indexOf('| y'))
  assert.ok(res)
  assert.ok(res.text.startsWith('note a | b\n'), 'prose line untouched byte-for-byte')
})

test('findTable still rejects genuinely ragged tables under its own header', () => {
  assert.equal(findTable('| H1 | H2 |\n| - | - |\n| one | two | three |', 8), null)
})

test('insertTable builds the requested size with blank-line hygiene and opens in the first body cell', () => {
  const res = dispatch('insertTable', 'before after', 6, { rows: 2, cols: 3 })
  assert.match(res.text, /^before\n\n\| Header 1 \| Header 2 \| Header 3 \|\n\| -{8} \| -{8} \| -{8} \|/)
  assert.match(res.text, /\|\s{10}\|\s{10}\|\s{10}\|\n\n after$/, 'trailing blank line restored mid-document')
  // Cursor collapsed inside the first body cell — typing lands there.
  const typed = res.text.slice(0, res.from) + 'X' + res.text.slice(res.to)
  const t = findTable(typed, res.from)
  assert.equal(t.rowIndex, 2)
  assert.equal(t.colIndex, 0)
  assert.equal(t.segs[2][0].text, 'X')
  // End of document gets no trailing blank line; mid-document gets both.
  const atEnd = dispatch('insertTable', 'prose', 5, { rows: 1, cols: 1 })
  assert.match(atEnd.text, /^prose\n\n\| Header 1 \|\n\| -{8} \|\n\| {10}\|$/)
})

test('tableAddRowBelow inserts under the cursor row with matching widths; header/delegate case lands first body row', () => {
  const below = dispatch('tableAddRowBelow', TABLE, posOf(TABLE, 'two'))
  assert.equal(
    below.text,
    '| A | B |\n| --- | :--: |\n| one | two |\n|     |     |\n| three | four |'
  )
  // Cursor parked inside the new (empty) row's first cell.
  const t = findTable(below.text, below.from)
  assert.equal(t.rowIndex, 3)

  // "Below" while on the header inserts the FIRST BODY ROW, never between
  // header and delimiter; the new row borrows the delimiter's widths.
  const fromHeader = dispatch('tableAddRowBelow', TABLE, posOf(TABLE, 'A'))
  assert.equal(
    fromHeader.text,
    '| A | B |\n| --- | :--: |\n|     |      |\n| one | two |\n| three | four |'
  )
  const th = findTable(fromHeader.text, fromHeader.from)
  assert.equal(th.rowIndex, 2)
  assert.equal(th.segs[2][0].text, '')

  // "Above" on the header stands down rather than corrupting the structure.
  assert.equal(dispatch('tableAddRowAbove', TABLE, posOf(TABLE, 'A')), null)
  const above = dispatch('tableAddRowAbove', TABLE, posOf(TABLE, 'four'))
  assert.equal(
    above.text,
    '| A | B |\n| --- | :--: |\n| one | two |\n|     |     |\n| three | four |'
  )
})

test('tableDeleteRow removes a body row, promotes on the header, and refuses the delimiter', () => {
  const del = dispatch('tableDeleteRow', TABLE, posOf(TABLE, 'one'))
  assert.equal(del.text, '| A | B |\n| --- | :--: |\n| three | four |')
  assert.equal(dispatch('tableDeleteRow', TABLE, TABLE.indexOf(':--')), null)

  // Deleting the header promotes the first body row into its place.
  const promoted = dispatch('tableDeleteRow', TABLE, posOf(TABLE, 'A'))
  assert.equal(promoted.text, '| one | two |\n| --- | :--: |\n| three | four |')

  // Last body row may go, leaving a header-only table.
  const headerOnly = dispatch('tableDeleteRow', TABLE, posOf(TABLE, 'four'))
  assert.equal(headerOnly.text, '| A | B |\n| --- | :--: |\n| one | two |')
})

test('tableAddColumnLeft/Right insert into every row and park the cursor in the new column', () => {
  const right = dispatch('tableAddColumnRight', TABLE, posOf(TABLE, 'two'))
  assert.equal(
    right.text,
    '| A | B | |\n| --- | :--: | ---- |\n| one | two |   |\n| three | four |    |'
  )
  const rt = findTable(right.text, right.from)
  assert.equal(rt.colCount, 3)
  assert.equal(rt.colIndex, 2)
  assert.equal(rt.rowIndex, 2)

  const left = dispatch('tableAddColumnLeft', TABLE, posOf(TABLE, 'two'))
  assert.equal(
    left.text,
    '| A | | B |\n| --- | ---- | :--: |\n| one |   | two |\n| three |    | four |'
  )
  const lt = findTable(left.text, left.from)
  assert.equal(lt.colCount, 3)
  assert.equal(lt.colIndex, 1)
  assert.equal(lt.alignments[1], 'left', 'fresh delimiter column runs left')
})

test('tableDeleteColumn drops the column everywhere; the last column takes the whole table', () => {
  const del = dispatch('tableDeleteColumn', TABLE, posOf(TABLE, 'three'))
  assert.equal(del.text, '| B |\n| :--: |\n| two |\n| four |')

  const single = '| Only |\n| ---- |\n| cell |'
  const gone = dispatch('tableDeleteColumn', single, posOf(single, 'cell'))
  assert.equal(gone.text.replace(/\n+$/, ''), '')
})

test('tableCycleAlignment walks the cursor column through centre and right without touching its neighbour', () => {
  // Column 2 starts centred (`:--:`): one click -> right, two -> left.
  const toRight = dispatch('tableCycleAlignment', TABLE, posOf(TABLE, 'two'))
  assert.equal(toRight.text.split('\n')[1], '| --- | ---: |')
  const toLeft = dispatch('tableCycleAlignment', toRight.text, toRight.from)
  assert.equal(toLeft.text.split('\n')[1], '| --- | ---- |')
  // Column 1 starts left-aligned: one click centres it, leaving column 2 alone.
  const toCenter = dispatch('tableCycleAlignment', TABLE, posOf(TABLE, 'one'))
  assert.equal(toCenter.text.split('\n')[1], '| :--: | :--: |')
})

test('tableNextCell walks cell to cell, skips the delimiter, and appends a row after the last cell', () => {
  let state = { tree: null, text: TABLE, from: posOf(TABLE, 'one'), to: posOf(TABLE, 'one') }
  state.to = state.from

  // Forward: second cell of this row...
  let r = apply('tableNextCell', state)
  assert.equal(r.text.slice(r.from, r.to), 'two')
  // ...first cell of the NEXT BODY ROW (delimiter skipped)...
  r = apply('tableNextCell', { ...state, from: r.from, to: r.to })
  assert.equal(r.text.slice(r.from, r.to), 'three')
  // ...second cell of it...
  r = apply('tableNextCell', { ...state, from: r.from, to: r.to })
  assert.equal(r.text.slice(r.from, r.to), 'four')
  // ...and off the very last cell a fresh row appears, caret in its first cell.
  r = apply('tableNextCell', { ...state, from: r.from, to: r.to })
  assert.notEqual(r.text, TABLE)
  assert.match(r.text, /\| four \|\n\| +\| +\|$/)
  const nt = findTable(r.text, r.from)
  assert.equal(nt.rowIndex, 4)
  assert.equal(nt.colIndex, 0)

  // Backward retraces; Shift-Tab off the first cell reports null.
  const back = apply('tablePrevCell', { tree: null, text: r.text, from: r.from, to: r.to })
  assert.equal(back.text.slice(back.from, back.to), 'four')
  const stuck = apply('tablePrevCell', { tree: null, text: TABLE, from: posOf(TABLE, 'A'), to: posOf(TABLE, 'A') })
  assert.equal(stuck, null)
})

test('malformed tables no-op through the dispatcher instead of rewriting text', () => {
  const ragged = '| a | b |\n| - |'
  for (const cmd of [
    'tableAddRowBelow',
    'tableDeleteRow',
    'tableAddColumnRight',
    'tableDeleteColumn',
    'tableCycleAlignment',
    'tableNextCell',
    'tablePrevCell',
    'tableDelete',
  ]) {
    assert.equal(dispatch(cmd, ragged, 3), null, cmd)
  }
})

// ---------- whole-table structure (#374) ----------

const WIDE = '| A  | B |   C   |\n| -- | :-: | --: |\n| a1 |b1| c1 |\n| a2 | b2 | c2 |'

test('tableMoveColumn moves a column in every row, keeping each cell\'s padding byte-for-byte', () => {
  const res = dispatch('tableMoveColumn', WIDE, posOf(WIDE, 'a1'), { fromIndex: 2, toIndex: 0 })
  assert.equal(res.text, '|   C   | A  | B |\n| --: | -- | :-: |\n| c1 | a1 |b1|\n| c2 | a2 | b2 |')
  // Alignment travels with its column because the delimiter cell moves too.
  assert.deepEqual(findTable(res.text, 0).alignments, ['right', 'left', 'center'])
  assert.equal(res.from, 0)
})

test('tableMoveColumn normalises outer pipes like the other column commands and leaves text around the table alone', () => {
  const doc = 'intro\n\nA | B\n--|--\nx | y\n\noutro'
  const res = dispatch('tableMoveColumn', doc, posOf(doc, 'x'), { fromIndex: 0, toIndex: 1 })
  assert.equal(res.text, 'intro\n\n| B|A |\n|--|--|\n| y|x |\n\noutro')
})

test('tableMoveColumn refuses the same index, an out-of-range index, and a malformed table', () => {
  const at = posOf(WIDE, 'a1')
  assert.equal(dispatch('tableMoveColumn', WIDE, at, { fromIndex: 1, toIndex: 1 }), null)
  assert.equal(dispatch('tableMoveColumn', WIDE, at, { fromIndex: 0, toIndex: 3 }), null)
  assert.equal(dispatch('tableMoveColumn', WIDE, at, { fromIndex: -1, toIndex: 0 }), null)
  assert.equal(dispatch('tableMoveColumn', WIDE, at, {}), null)
  assert.equal(dispatch('tableMoveColumn', '| a | b |\n| - |', 3, { fromIndex: 0, toIndex: 1 }), null)
})

test('tableMoveRow swaps whole raw lines, so every row stays byte-identical', () => {
  const doc = 'before\n\n' + TABLE + '\n| five |six|\n\nafter'
  const res = dispatch('tableMoveRow', doc, posOf(doc, 'one'), { fromIndex: 4, toIndex: 2 })
  assert.equal(res.text, 'before\n\n| A | B |\n| --- | :--: |\n| five |six|\n| one | two |\n| three | four |\n\nafter')
  assert.deepEqual(res.text.split('\n').sort(), doc.split('\n').sort(), 'same lines, new order')
})

test('tableMoveRow refuses the header, the delimiter, the same row, out-of-range rows and malformed tables', () => {
  const at = posOf(TABLE, 'one')
  assert.equal(dispatch('tableMoveRow', TABLE, at, { fromIndex: 0, toIndex: 2 }), null, 'header')
  assert.equal(dispatch('tableMoveRow', TABLE, at, { fromIndex: 2, toIndex: 0 }), null, 'into the header')
  assert.equal(dispatch('tableMoveRow', TABLE, at, { fromIndex: 1, toIndex: 3 }), null, 'delimiter')
  assert.equal(dispatch('tableMoveRow', TABLE, at, { fromIndex: 2, toIndex: 2 }), null, 'same row')
  assert.equal(dispatch('tableMoveRow', TABLE, at, { fromIndex: 2, toIndex: 4 }), null, 'past the end')
  assert.equal(dispatch('tableMoveRow', '| a | b |\n| - |', 3, { fromIndex: 2, toIndex: 3 }), null, 'malformed')
})

test('tableDelete removes the table and one framing blank line wherever it sits', () => {
  const at = (doc) => posOf(doc, 'one')
  assert.deepEqual(dispatch('tableDelete', 'a\n\n' + TABLE + '\n\nb', at('a\n\n' + TABLE)), { text: 'a\n\nb', from: 3, to: 3 })
  assert.equal(dispatch('tableDelete', TABLE + '\n\nb', at(TABLE)).text, 'b', 'at the start')
  assert.equal(dispatch('tableDelete', 'a\n\n' + TABLE, at('a\n\n' + TABLE)).text, 'a', 'at the end')
  assert.equal(dispatch('tableDelete', 'a\n' + TABLE + '\nb', at('a\n' + TABLE)).text, 'a\nb', 'glued to its neighbours')
  assert.equal(dispatch('tableDelete', TABLE, at(TABLE)).text, '', 'the whole document')
  assert.equal(dispatch('tableDelete', 'x\n\n| a | b |\n| - |', 5), null, 'malformed')
})

test('findAllTables lists every well-formed table in order and skips ragged runs', () => {
  const doc = TABLE + '\n\nprose | with a pipe\n\n| a | b |\n| - |\n\n' + WIDE
  const tables = findAllTables(doc)
  assert.equal(tables.length, 2)
  assert.equal(tables[0].start, 0)
  assert.equal(tables[1].start, doc.indexOf(WIDE))
  assert.deepEqual(findAllTables(''), [])
  assert.deepEqual(findAllTables('no tables here'), [])
})

test('a cell reads with its pipes unescaped and maps display offsets back to the source', () => {
  const doc = '| a \\| b | c |\n| --- | --- |\n| x | y |'
  const seg = findTable(doc, 0).segs[0][0]
  assert.equal(tableCellText(seg), 'a | b')
  assert.equal(tableCellSourceOffset(seg.text, 2), 2)
  assert.equal(tableCellSourceOffset(seg.text, 3), 4, 'past the pipe is two source characters on')
  assert.equal(tableCellSourceOffset(seg.text, 99), seg.text.length)
})

test('tableCellEdit rewrites one segment only, flattening breaks and escaping pipes', () => {
  const at = posOf(WIDE, 'b1')
  const edit = tableCellEdit({ text: WIDE, from: at, row: 2, col: 1, value: 'new | value\nhere ' })
  assert.deepEqual(edit, { from: WIDE.indexOf('b1'), to: WIDE.indexOf('b1') + 2, insert: ' new \\| value here ' })
  const next = WIDE.slice(0, edit.from) + edit.insert + WIDE.slice(edit.to)
  const before = WIDE.split('\n')
  const after = next.split('\n')
  assert.deepEqual(after.filter((line, i) => line !== before[i]).length, 1, 'exactly one line differs')
  assert.equal(tableCellEdit({ text: WIDE, from: at, row: 1, col: 0, value: 'x' }), null, 'the delimiter is not a cell')
  assert.equal(tableCellEdit({ text: WIDE, from: at, row: 9, col: 0, value: 'x' }), null)
  assert.equal(tableCellEdit({ text: 'no table', from: 0, row: 0, col: 0, value: 'x' }), null)
})

test('diffRange finds the one replacement between two texts', () => {
  assert.deepEqual(diffRange('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' })
  assert.deepEqual(diffRange('abc', 'abc'), { from: 3, to: 3, insert: '' })
  assert.deepEqual(diffRange('aXa', 'aa'), { from: 1, to: 2, insert: '' })
  assert.deepEqual(diffRange('', 'new'), { from: 0, to: 0, insert: 'new' })
})

// ---------- dispatcher ----------

test('apply dispatches every toolbar command name', () => {
  const s = { tree: null, text: 'x', from: 0, to: 1 }
  assert.equal(apply('bold', s).text, '**x**')
  assert.equal(apply('italic', s).text, '*x*')
  assert.equal(apply('strikethrough', s).text, '~~x~~')
  assert.equal(apply('inlineCode', s).text, '`x`')
  assert.equal(apply('link', s).text, '[x](url)')
  assert.equal(apply('bulletList', s).text, '- x')
  assert.equal(apply('numberedList', s).text, '1. x')
  assert.equal(apply('taskList', s).text, '- [ ] x')
  assert.equal(apply('blockquote', s).text, '> x')
  assert.equal(apply('heading4', s).text, '#### x')
  assert.equal(apply('codeBlock', s).text, '```\nx\n```')
  assert.equal(apply('horizontalRule', s).text, '---')
  assert.throws(() => apply('underline', s))
})
