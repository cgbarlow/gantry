import { test } from 'node:test'
import assert from 'node:assert/strict'

// #347: the AI interview's thread draws the AI's replies as Markdown, with the module editor's preview (web/lib/markdownPreview.js), and
// leaves the architect's messages and Gantry's system lines as plain text. Under node --test there is no DOM, so this reads what the thread
// asks Preact to draw for each kind of message; the drawing itself, citations and diagrams included, is in
// tests/interviewMarkdown.playwright.test.js.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const { ThreadMessage, AiReply, replyDrawing, caretBlock } = await import('../web/lib/interviewView.js')

const preview = { resolveAssets: null, sources: { index: {}, open: () => {} } }

test("an AI reply, still arriving or finished, is drawn by the preview, with what the page hands it to draw with", () => {
  const m = { id: 3, who: 'ai', text: '**Bold** and a [citation](source:client-brief).', streaming: true }
  const vnode = ThreadMessage({ m, preview })
  assert.equal(vnode.type, AiReply)
  assert.equal(vnode.props.m, m)
  assert.equal(vnode.props.preview, preview)
  assert.equal(ThreadMessage({ m: { ...m, streaming: false }, preview }).type, AiReply)
})

test("the architect's message and a system line stay plain text, as typed", () => {
  for (const m of [
    { id: 1, who: 'you', text: '**not bold** and `not code`' },
    { id: 2, who: 'sys', text: 'Drafted *Scope notes · Body*.' },
  ]) {
    const vnode = ThreadMessage({ m, preview })
    assert.equal(vnode.type, 'div', m.who)
    assert.equal(vnode.props.class, `msg ${m.who}`)
    assert.equal(vnode.props['data-who'], m.who)
    assert.equal(vnode.props.children, m.text, 'the text itself, not HTML')
    assert.equal(vnode.props.dangerouslySetInnerHTML, undefined)
  }
})

test('#345: the system line a quiet turn left keeps its Carry on button, and the button sends "go on"', () => {
  let sent = 0
  const m = { id: 4, who: 'sys', text: 'The AI stopped without replying.', carryOn: 'empty' }
  const vnode = ThreadMessage({ m, preview, carryOn: true, onCarryOn: () => sent++ })
  assert.equal(vnode.type, 'div')
  assert.equal(vnode.props.class, 'msg sys carry-on')
  assert.equal(vnode.props['data-carry-on'], 'empty')
  const button = [vnode.props.children].flat(Infinity).find((child) => child?.type === 'button')
  assert.equal(button.props['data-testid'], 'interview-carry-on')
  button.props.onClick()
  assert.equal(sent, 1)
  // Once Carry on no longer answers it, it is a plain system line like any other.
  assert.equal(ThreadMessage({ m, preview }).props.class, 'msg sys')
})

// #347: a finished reply is drawn again only when that would change what it shows. The page hands the thread a new set of things to draw with
// whenever the Source documents panel lists again (after an upload, say) or the Instance's assets are read again; drawing every reply again
// then would draw each of their diagrams again from scratch, the code showing in place of each while it does.
test('a reply is drawn again when its text, its diagrams or a Source document it cites changes, and not for a document it does not cite', () => {
  const notes = { title: 'Workshop notes', filename: 'Notes.txt', removed: false }
  const index = { notes }
  const drawn = replyDrawing('See [notes](source:notes).', { index, mermaid: true, cited: ['notes'] })
  // A document uploaded since, which this reply does not cite, and a new index object with the same documents in it: nothing to draw again.
  assert.equal(replyDrawing('See [notes](source:notes).', { index: { ...index, brief: { title: 'Client brief', filename: 'brief.md', removed: false } }, mermaid: true, cited: ['notes'] }), drawn)
  // The document it cites was removed or renamed: drawn again, so the citation says so.
  assert.notEqual(replyDrawing('See [notes](source:notes).', { index: { notes: { ...notes, removed: true } }, mermaid: true, cited: ['notes'] }), drawn)
  assert.notEqual(replyDrawing('See [notes](source:notes).', { index: { notes: { ...notes, title: 'Notes' } }, mermaid: true, cited: ['notes'] }), drawn)
  // The Source documents have not been listed yet (none kept), then they are.
  assert.notEqual(replyDrawing('See [notes](source:notes).', { index: null, mermaid: true, cited: [] }), replyDrawing('See [notes](source:notes).', { index: {}, mermaid: true, cited: [] }))
  // More text arrived, or the reply finished and its diagrams are drawn now.
  assert.notEqual(replyDrawing('See [notes](source:notes). More.', { index, mermaid: true, cited: ['notes'] }), drawn)
  assert.notEqual(replyDrawing('See [notes](source:notes).', { index, mermaid: false, cited: ['notes'] }), drawn)
})

// #347: while a reply arrives, the caret sits at the end of what has arrived: the innermost block its last words are in. A stand-in for the
// drawn reply's elements, each with its tag and children.
const el = (tagName, ...children) => ({ tagName, children, get lastElementChild() { return children[children.length - 1] ?? null } })

test('the caret goes in the block the last words are in: a paragraph, the last cell of a table, the innermost last item of a list', () => {
  const p = el('P', el('STRONG'))
  assert.equal(caretBlock(el('DIV', el('H3'), p)), p)
  const pre = el('PRE', el('CODE'))
  assert.equal(caretBlock(el('DIV', pre)), pre)
  // A table: its last row's last cell, in the body or, while only the header row has arrived, the header.
  const td = el('TD')
  assert.equal(caretBlock(el('DIV', el('TABLE', el('THEAD', el('TR', el('TH'))), el('TBODY', el('TR', el('TD'), td))))), td)
  const th = el('TH')
  assert.equal(caretBlock(el('DIV', el('TABLE', el('THEAD', el('TR', el('TH'), th))))), th)
  // A list: its last item, or the last item of the list nested in it, or the paragraph of a loose list's item.
  const item = el('LI', el('CODE'))
  assert.equal(caretBlock(el('DIV', el('UL', el('LI'), item))), item)
  const inner = el('LI')
  assert.equal(caretBlock(el('DIV', el('OL', el('LI'), el('LI', el('STRONG'), el('UL', el('LI'), inner))))), inner)
  const loose = el('P')
  assert.equal(caretBlock(el('DIV', el('UL', el('LI', el('P'), loose)))), loose)
  const quoted = el('P')
  assert.equal(caretBlock(el('DIV', el('BLOCKQUOTE', el('P'), quoted))), quoted)
  // A rule, or nothing yet: no block to put it in.
  assert.equal(caretBlock(el('DIV', el('P'), el('HR'))), null)
  assert.equal(caretBlock(el('DIV')), null)
})
