import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #345 (parent #343): an AI interview turn that ends with nothing new in the thread says so. A reply with no text, no question card, no
// draft and no tool call puts a system line in the thread saying the AI stopped without replying; a turn the per-turn limit of tool-call
// rounds ended says that instead. Both lines carry Carry on, which sends "go on" as the architect's message. A turn that ends with text,
// cards or a draft is unchanged. A fake `fetch` plays Anthropic through the relay; the AI Providers list is the real one, kept in a fake
// localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, statusLine, MAX_ROUNDS, CARRY_ON_MESSAGE } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))

const definition = () => ({
  id: 'small',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary'] }],
  modules: [
    {
      id: 'details',
      title: 'Details',
      fields: [
        { id: 'summary', title: 'Problem statement', type: 'markdown', required: true },
        { id: 'notes', title: 'Notes', type: 'markdown' },
      ],
    },
  ],
})
const sources = [{ id: 'tech-lt', title: 'Tech LT deck', filename: 'deck.md', size: 40, text: '# Tech LT deck\n\nThe platform moves to managed hosting.' }]

const sse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })

// An Anthropic reply: optional text, then tool calls. With neither it is the empty reply this ticket is about.
function anthropicReply({ text, tools = [] } = {}) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  let out = event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
  let index = 0
  const block = (content, deltas) => {
    out += event('content_block_start', { type: 'content_block_start', index, content_block: content })
    for (const delta of deltas) out += event('content_block_delta', { type: 'content_block_delta', index, delta })
    out += event('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (text) block({ type: 'text', text: '' }, [{ type: 'text_delta', text }])
  for (const tool of tools) block({ type: 'tool_use', id: tool.id, name: tool.name ?? 'draft_field', input: {} }, [{ type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }])
  out += event('message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
  out += event('message_stop', { type: 'message_stop' })
  return sse(out)
}
const read = (id) => ({ id, name: 'read_source_document', input: { id: 'tech-lt' } })
const card = { id: 'ask', name: 'ask_architect', input: { questions: [{ header: 'Problem', question: 'Which driver leads?', options: [{ label: 'Cost' }, { label: 'Speed' }], recommended: 'Cost', why: 'The deck leads with it.' }] } }

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

function sessionWith(ai) {
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }] }], sources, skills }
  const lines = []
  const session = createInterviewSession({ providerId: anthropic().id, getContext: () => context, fetchImpl: ai.fetchImpl, onChange: (snap) => lines.push(statusLine(snap)) })
  return { session, lines }
}

const carryOnLines = (snap) => snap.thread.filter((t) => t.carryOn)
// The text the AI was sent in the last user turn.
function lastUserText(body) {
  const m = body.messages.filter((x) => x.role === 'user').at(-1)
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

test('a reply with no text and no tool calls: the thread says the AI stopped without replying, with Carry on', async () => {
  const ai = fakeAi(() => anthropicReply())
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  const said = carryOnLines(snap)
  assert.equal(said.length, 1)
  assert.equal(said[0].who, 'sys')
  assert.equal(said[0].carryOn, 'empty')
  assert.equal(said[0].text, 'The AI stopped without replying.')
  assert.equal(snap.thread.at(-1), said[0], 'it is the last thing in the thread')
  assert.ok(!snap.thread.some((t) => t.who === 'ai'), 'the empty reply leaves no bubble')
  assert.equal(snap.phase, 'waiting')
  assert.equal(ai.calls.length, 1, 'Gantry does not ask again on its own')
})

test('reads and then an empty reply (the #343 session): the reads are not something to show, so the line is said', async () => {
  const ai = fakeAi((_req, n) => (n < 2 ? anthropicReply({ tools: [read(`r${n}`)] }) : anthropicReply()))
  const { session } = sessionWith(ai)
  await session.start()
  const said = carryOnLines(session.snapshot())
  assert.deepEqual(said.map((t) => t.carryOn), ['empty'])
})

test('Carry on sends "go on" as the architect\'s message, and the next turn runs with the status line showing as usual', async () => {
  assert.equal(CARRY_ON_MESSAGE, 'go on')
  let release
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply() : new Promise((r) => (release = () => r(anthropicReply({ text: 'Picking up from the deck.' }))))))
  const { session } = sessionWith(ai)
  await session.start()
  const going = session.send(CARRY_ON_MESSAGE)
  for (let i = 0; !release && i < 2000; i++) await new Promise((r) => setTimeout(r, 1))
  assert.ok(release, 'the next request went')
  assert.equal(statusLine(session.snapshot())?.text, 'Waiting for the AI…')
  assert.equal(lastUserText(ai.calls[1].body), 'go on')
  release()
  await going
  const snap = session.snapshot()
  assert.deepEqual(snap.thread.slice(-2).map((t) => [t.who, t.text]), [['you', 'go on'], ['ai', 'Picking up from the deck.']])
  assert.equal(carryOnLines(snap).length, 1, 'the earlier line stays as a record; the turn that replied adds none')
  assert.equal(statusLine(snap), null)
})

test('an AI that keeps calling read tools until the per-turn limit: the thread says the rounds were used up, with Carry on', async () => {
  const ai = fakeAi((_req, n) => anthropicReply({ tools: [read(`r${n}`)] }))
  const { session } = sessionWith(ai)
  await session.start()
  assert.equal(ai.calls.length, MAX_ROUNDS)
  const said = carryOnLines(session.snapshot())
  assert.equal(said.length, 1, 'one line: the rounds, not also "stopped without replying"')
  assert.equal(said[0].carryOn, 'rounds')
  assert.equal(said[0].text, `The AI used up its ${MAX_ROUNDS} rounds of tool calls for this turn and stopped.`)
  assert.equal(session.snapshot().phase, 'waiting')
})

test('Carry on after the rounds ran out: "go on" follows the last round\'s tool results, and the AI carries on', async () => {
  const ai = fakeAi((_req, n) => (n < MAX_ROUNDS ? anthropicReply({ tools: [read(`r${n}`)] }) : anthropicReply({ text: 'Read enough; drafting next.' })))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send(CARRY_ON_MESSAGE)
  assert.equal(ai.calls.length, MAX_ROUNDS + 1)
  assert.match(lastUserText(ai.calls[MAX_ROUNDS].body), /go on/)
  assert.equal(session.snapshot().thread.at(-1).text, 'Read enough; drafting next.')
})

for (const [name, reply, shows] of [
  ['text', () => anthropicReply({ text: 'The deck says managed hosting.' }), (snap) => snap.thread.at(-1).who === 'ai'],
  ['question cards', () => anthropicReply({ tools: [card] }), (snap) => snap.round?.cards.length === 1 && snap.phase === 'asking'],
]) {
  test(`a turn ending in ${name} shows no such line`, async () => {
    const ai = fakeAi(reply)
    const { session } = sessionWith(ai)
    await session.start()
    assert.ok(shows(session.snapshot()), `the turn ended in ${name}`)
    assert.deepEqual(carryOnLines(session.snapshot()), [])
  })
}

test('a turn that drafted and then ended with an empty reply shows no such line: the draft is something to show', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Move to managed hosting.' } }] }) : anthropicReply()))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  assert.equal(snap.drafts['details.summary'].value, 'Move to managed hosting.')
  assert.deepEqual(carryOnLines(snap), [])
})

test('an earlier turn\'s text does not count: a later turn that replies with nothing still says so', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ text: 'Hello.' }) : anthropicReply()))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('What next?')
  assert.deepEqual(carryOnLines(session.snapshot()).map((t) => t.carryOn), ['empty'])
})
