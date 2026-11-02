import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #299 (parent #238, decided in #247): an AI interview session that revises a Stage the Owner sent back. A fake `fetch` plays the AI Provider
// with scripted streams, as in tests/bringUpToDateSession.test.js. The comments are listed and asked about as cards before the AI is called;
// each answer is a `pr-comment-answered` entry; the AI is told only what to change; and an offer to re-open a signed-off Stage becomes a card
// only when the context says Gantry would allow it.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { currentLogEntries } = await import('../web/lib/decisionsLog.js')
const { COMMENT_CHOICES } = await import('../web/lib/prRevision.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const definition = () => ({
  id: 'small',
  stages: [
    { id: 'scope', title: 'Scope', purpose: 'Scope the work.', gate: 'scoped', modules: ['details'] },
    { id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['plan'] },
  ],
  artefacts: [
    { id: 'scope-doc', title: 'Scope document', purpose: 'p', gate: 'scoped', requires: ['details.summary'] },
    { id: 'shape-doc', title: 'Shape document', purpose: 'p', gate: 'shaped', requires: ['plan.body'] },
  ],
  modules: [
    { id: 'details', title: 'Details', purpose: 'What it is', fields: [{ id: 'summary', title: 'Summary', type: 'markdown', required: true }] },
    { id: 'plan', title: 'Plan', purpose: 'How', fields: [{ id: 'body', title: 'Body', type: 'markdown', required: true }] },
  ],
})
const NOW = '2026-11-03T10:00:00.000Z'
const saved = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: 'Faster claims for the insurer.' }] }]

const comments = () => [
  { id: 'c1', kind: 'conversation', author: 'Olivia', body: 'Please name the owner in the summary.', createdAt: '2026-11-03T09:00:00Z', url: 'https://ghe.test/pull/4#c1', path: null, line: null, resolved: false },
  { id: 'c2', kind: 'inline', author: 'Sam', body: 'The word "claims" is repeated.', createdAt: '2026-11-03T09:05:00Z', url: null, threadId: 9, path: 'modules/details.md', line: 3, resolved: true },
]

const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
function anthropicReply({ text, tools = [] }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name ?? 'draft_field', input: {} } }])
    const json = JSON.stringify(tool.input)
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 9) } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(9) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}
function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ url: envelope.url, body: envelope.body ? JSON.parse(envelope.body) : null })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}
const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}
const firstUser = (request) => {
  const first = request.body.messages[0]
  return typeof first.content === 'string' ? first.content : first.content.map((b) => b.text ?? '').join('\n')
}

let counter = 0
function sessionWith(ai, over = {}) {
  const provider = anthropic()
  const context = {
    definition: definition(),
    stageId: 'scope',
    artefactId: 'scope-doc',
    size: 'medium',
    saved: saved(),
    sources: [],
    skills,
    actor: 'Alex',
    revise: over.revise === null ? undefined : { comments: comments(), pullRequestId: 4, pullRequestUrl: 'https://ghe.test/pull/4', stageTitle: 'Scope', ...over.revise },
    ...over.context,
  }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => `s-rv${++counter}`, now: () => NOW })
  return { session, context }
}
const answerAll = (session, cardId, label) => session.choose(cardId, label)

test('the comments are listed in the conversation and asked about before the AI is called, one card each, resolved ones too', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  assert.equal(ai.calls.length, 0, 'the AI is not called to ask them')
  assert.equal(snap.phase, 'asking')
  assert.equal(snap.round.revise, true)
  assert.deepEqual(snap.round.cards.map((c) => c.id), ['comment:c1', 'comment:c2'])
  assert.deepEqual(snap.revise, { total: 2, answered: false, pullRequestId: 4 })
  const listing = snap.thread.find((t) => t.reviseComments)
  assert.match(listing.text, /Scope was sent back\. 2 comments on Pull Request #4, resolved ones included:/)
  assert.match(listing.text, /Olivia: Please name the owner in the summary\./)
  assert.match(listing.text, /Sam on modules\/details\.md \(line 3\) \(resolved\)/)
  assert.deepEqual(snap.round.cards[1].recommended, [COMMENT_CHOICES.none])
})

test('answering logs a PR comment answered entry for each comment, then the AI is told only what to change', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Nothing to redraft.' }))
  const { session } = sessionWith(ai)
  await session.start()
  answerAll(session, 'comment:c1', COMMENT_CHOICES.change)
  answerAll(session, 'comment:c2', COMMENT_CHOICES.none)
  const result = await session.submitRound()
  assert.equal(result.ok, true)
  assert.equal(ai.calls.length, 1)
  const told = firstUser(ai.calls[0])
  assert.match(told, /Revise this Stage\./)
  assert.match(told, /You never write to the Pull Request/)
  assert.doesNotMatch(told, /Olivia|Sam/, 'the AI is never told who wrote a comment (ADR-0066)')
  assert.match(told, /“Please name the owner in the summary\.”\n  CHANGE THE CONTENT/)
  assert.match(told, /“The word "claims" is repeated\.”\n  NO CHANGE NEEDED/)

  const entries = currentLogEntries(session.decisionsDelta({ runState: 'awaiting-approval', saving: true, target: 'shape', stages: { scope: 'awaiting-approval' } }).entries)
  const answered = entries.filter((e) => e.kind === 'pr-comment-answered')
  assert.deepEqual(answered.map((e) => [e.comment, e.author, e.outcome, e.pullRequest]), [['c1', 'Olivia', 'change', 4], ['c2', 'Sam', 'no-change', 4]])
  assert.equal(answered[0].url, 'https://ghe.test/pull/4#c1')
  assert.equal(answered[1].path, 'modules/details.md')
  assert.equal(answered[1].resolved, true)
  for (const entry of answered) {
    assert.equal(entry.entries.length, 1)
    assert.equal(entries.find((e) => e.id === entry.entries[0]).kind, 'answer', 'the entry that answered it is in the log')
  }
  // The names stay in the log, but the entries the brief reads back carry none (ADR-0066).
  assert.doesNotMatch(JSON.stringify(entries.filter((e) => e.kind === 'answer')), /Olivia|Sam/)
})

test('when nothing is to be changed the AI is not called at all, and an open question is logged for a comment left to settle later', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  answerAll(session, 'comment:c1', COMMENT_CHOICES.open)
  answerAll(session, 'comment:c2', COMMENT_CHOICES.none)
  await session.submitRound()
  assert.equal(ai.calls.length, 0)
  assert.equal(session.snapshot().phase, 'waiting')
  const entries = session.decisionsDelta({ runState: 'awaiting-approval', saving: true, target: 'shape' }).entries
  const open = entries.find((e) => e.kind === 'open-question')
  assert.match(open.question, /Olivia commented on Pull Request #4: “Please name the owner in the summary\.”/)
  const answered = entries.find((e) => e.kind === 'pr-comment-answered' && e.comment === 'c1')
  assert.ok(answered.entries.includes(open.id), 'the open question is one of the entries that answered the comment')
})

test('chat waits for the comment cards: they come first', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Hello?')
  assert.equal(ai.calls.length, 0)
  assert.match(session.snapshot().thread.at(-1).text, /Answer the Owner's comment cards first/)
})

test('a Pull Request with no readable comment opens with the AI asking the architect what the Owner wants changed', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'What did the Owner want changed?' }))
  const { session } = sessionWith(ai, { revise: { comments: [] } })
  await session.start()
  assert.equal(ai.calls.length, 1)
  assert.match(firstUser(ai.calls[0]), /Gantry found no comment on it to read\. Ask the architect/)
})

// ---------- offering to re-open a signed-off Stage ----------

const reopenAsk = (stage = 'scope') => ({ id: 'ask-1', name: 'ask_architect', input: { questions: [{ id: 'reopen-1', kind: 'reopen', stage, question: 'The new brief contradicts the approved scope.' }] } })
const reopenContext = (allowed, blocker = '') => ({ revise: undefined, stageId: 'shape', artefactId: 'shape-doc', saved: [], reopen: [{ id: 'scope', title: 'Scope', allowed, blocker }] })

test('an offer to re-open becomes a card when Gantry would allow it, and choosing it asks the page to re-open the Stage', async () => {
  const ai = fakeAi((_, i) => (i === 0 ? anthropicReply({ text: 'A contradiction.', tools: [reopenAsk()] }) : anthropicReply({ text: 'Understood.' })))
  const { session } = sessionWith(ai, { revise: null, context: reopenContext(true) })
  await session.start()
  const snap = session.snapshot()
  assert.equal(snap.phase, 'asking')
  assert.deepEqual(snap.round.cards.map((c) => [c.id, c.type, c.options.map((o) => o.label)]), [['reopen-1', 'reopen', ['Re-open Scope', 'Not now']]])
  assert.equal(snap.reopenRequest, null)
  await session.submitRound()
  assert.deepEqual(session.snapshot().reopenRequest, { stageId: 'scope', stageTitle: 'Scope' })
})

test('"Not now" on a re-open card logs an open question and re-opens nothing', async () => {
  const ai = fakeAi((_, i) => (i === 0 ? anthropicReply({ text: 'A contradiction.', tools: [reopenAsk()] }) : anthropicReply({ text: 'Understood.' })))
  const { session } = sessionWith(ai, { revise: null, context: reopenContext(true) })
  await session.start()
  session.choose('reopen-1', 'Not now')
  await session.submitRound()
  assert.equal(session.snapshot().reopenRequest, null)
  const open = session.decisionsDelta({ runState: 'in-progress' }).entries.find((e) => e.kind === 'open-question')
  assert.match(open.question, /Scope may need to be re-opened: The new brief contradicts the approved scope\./)
})

test('an offer Gantry would not allow is no card: it is an open question naming what stops it', async () => {
  const blocker = 'Shape is already in progress, and a Stage cannot be re-opened while a later one is (ADR-0026).'
  const ai = fakeAi(() => anthropicReply({ text: 'A contradiction.', tools: [reopenAsk()] }))
  const { session } = sessionWith(ai, { revise: null, context: reopenContext(false, blocker) })
  await session.start()
  const snap = session.snapshot()
  assert.equal(snap.round, null, 'no card is shown')
  assert.match(snap.thread.find((t) => t.reopenBlocked).text, /Scope cannot be re-opened right now: Shape is already in progress/)
  const open = session.decisionsDelta({ runState: 'in-progress' }).entries.find((e) => e.kind === 'open-question')
  assert.match(open.question, /Scope is signed off, but approved content there may need to change: The new brief contradicts the approved scope\. It cannot be re-opened now/)
  assert.equal(open.why, blocker)
  assert.equal(snap.reopenRequest, null)
})

test('an offer for a Stage that is not signed off is refused the same way', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'A contradiction.', tools: [reopenAsk('nowhere')] }))
  const { session } = sessionWith(ai, { revise: null, context: reopenContext(true) })
  await session.start()
  assert.equal(session.snapshot().round, null)
  assert.match(session.decisionsDelta({ runState: 'in-progress' }).entries.find((e) => e.kind === 'open-question').why, /nowhere is not a signed-off Stage that can be re-opened/)
})
