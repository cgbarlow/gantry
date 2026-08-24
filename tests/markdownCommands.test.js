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
