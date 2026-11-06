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
const { ThreadMessage, AiReply } = await import('../web/lib/interviewView.js')

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
