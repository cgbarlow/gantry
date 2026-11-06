import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #344 (parent #343): a reply the AI Provider stopped at its output limit (Anthropic's `max_tokens`, an OpenAI-compatible `length`) is
// recovered, not dropped. The call the limit cut off is not run; the AI is told its reply reached the output limit and to send fewer
// Fields per reply, and the interview carries on, with the status line saying so while it asks. A second cut-off in a row names the AI
// Provider's Max tokens setting in the thread, once. A fake `fetch` plays the AI Provider through the relay; the AI Providers list is the
// real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, statusLine } = await import('../web/lib/interviewSession.js')
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

// An Anthropic reply. `cut` is a draft_field call the output limit stopped part-way: its block still closes, with arguments that are not
// whole JSON, and the message stops with `max_tokens`.
function anthropicReply({ text, tools = [], cut = null }) {
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
  if (cut) block({ type: 'tool_use', id: cut.id, name: 'draft_field', input: {} }, [{ type: 'input_json_delta', partial_json: `{"field": "${cut.field}", "value": "A long dra` }])
  const stop = cut ? 'max_tokens' : tools.length ? 'tool_use' : 'end_turn'
  out += event('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: cut ? 4096 : 5 } })
  out += event('message_stop', { type: 'message_stop' })
  return sse(out)
}

// The same from an OpenAI-compatible AI Provider: the cut-off reply finishes with `length`.
function openAiReply({ text, tools = [], cut = null }) {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  let out = text ? chunk({ content: text }) : ''
  const calls = [...tools.map((t) => ({ id: t.id, args: JSON.stringify(t.input) })), ...(cut ? [{ id: cut.id, args: `{"field": "${cut.field}", "value": "A long dra` }] : [])]
  calls.forEach((c, i) => (out += chunk({ tool_calls: [{ index: i, id: c.id, function: { name: 'draft_field', arguments: c.args } }] })))
  out += chunk({}, cut ? 'length' : calls.length ? 'tool_calls' : 'stop')
  return sse(`${out}data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
}

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

const passed = (p) => {
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}
const anthropic = () => passed(providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' }))
const gateway = () => passed(providers.addAiProvider({ name: 'Gateway', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'big' }))

function sessionWith(ai, provider) {
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }] }], sources, skills }
  const lines = []
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, onChange: (snap) => lines.push(statusLine(snap)) })
  const shown = () => lines.filter(Boolean).map((l) => l.text).filter((t, i, all) => t !== all[i - 1])
  return { session, shown }
}

// What the next request said back about each tool call: `{ [callId]: text }`, from either wire format.
function toolResults(body) {
  const out = {}
  for (const m of body.messages) {
    if (m.role === 'tool') out[m.tool_call_id] = m.content
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result') out[b.tool_use_id] = b.content
  }
  return out
}
// The text the AI was sent in the last user turn, either wire format.
function lastUserText(body) {
  const m = body.messages.filter((x) => x.role === 'user').at(-1)
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

const CUT_OFF_LINE = 'Reply cut off at the output limit. Asking for a shorter one…'

for (const [name, provider, reply] of [
  ['Anthropic stopped at max_tokens', anthropic, anthropicReply],
  ['an OpenAI-compatible AI Provider finished with "length"', gateway, openAiReply],
]) {
  test(`${name} part-way through a draft: the cut-off call is not run, the AI is told, and the interview goes on to the draft`, async () => {
    const ai = fakeAi((_req, n) =>
      n === 0
        ? reply({ text: 'Drafting both Fields.', tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Move to managed hosting.' } }], cut: { id: 'd2', field: 'details.notes' } })
        : n === 1
          ? reply({ tools: [{ id: 'd3', input: { field: 'details.notes', value: 'Managed hosting from March.' } }] })
          : reply({ text: 'Both are drafted.' })
    )
    const { session, shown } = sessionWith(ai, provider())
    await session.start()
    const snap = session.snapshot()
    assert.equal(snap.drafts['details.summary'].value, 'Move to managed hosting.', 'the complete call in the cut-off reply is still used')
    assert.equal(snap.drafts['details.notes'].value, 'Managed hosting from March.', 'the interview went on to the draft')
    assert.ok(snap.thread.some((t) => t.who === 'ai' && t.text === 'Drafting both Fields.'), 'the text before the cut-off is still shown')
    assert.equal(snap.thread.filter((t) => t.drafted === 'details.notes').length, 1, 'the cut-off call drafted nothing')
    const told = toolResults(ai.calls[1].body)
    assert.match(told.d2, /output limit/)
    assert.match(told.d2, /fewer Fields/)
    assert.doesNotMatch(told.d2, /not valid JSON/)
    assert.doesNotMatch(told.d1, /output limit/, 'the complete call has its own result')
    const i = shown().indexOf(CUT_OFF_LINE)
    assert.ok(i > 0, shown().join(' | '))
    assert.equal(shown()[i + 1], 'Drafting…', 'the line moves on once the shorter reply arrives')
    assert.ok(!snap.thread.some((t) => /Max tokens/.test(t.text)), 'one cut-off says nothing in the thread')
    assert.equal(snap.phase, 'waiting')
  })
}

test('the cut-off line shows while the next request is under way, with the seconds waited', async () => {
  let release
  const ai = fakeAi((_req, n) =>
    n === 0 ? anthropicReply({ cut: { id: 'd1', field: 'details.summary' } }) : n === 1 ? new Promise((r) => (release = () => r(anthropicReply({ text: 'Shorter now.' })))) : anthropicReply({ text: 'x' })
  )
  const { session } = sessionWith(ai, anthropic())
  const going = session.start()
  for (let i = 0; !release && i < 2000; i++) await new Promise((r) => setTimeout(r, 1))
  assert.ok(release, 'the second request went')
  const line = statusLine(session.snapshot())
  assert.equal(line.text, CUT_OFF_LINE)
  assert.equal(line.kind, 'cut-off')
  assert.equal(line.ticking, true)
  release()
  await going
  assert.equal(statusLine(session.snapshot()), null)
})

test('two cut-offs in a row: the thread says so once, naming the Max tokens setting; a third adds nothing', async () => {
  const ai = fakeAi((_req, n) => (n < 3 ? anthropicReply({ cut: { id: `d${n}`, field: 'details.summary' } }) : anthropicReply({ tools: [{ id: 'ok', input: { field: 'details.summary', value: 'Short.' } }] })))
  const { session } = sessionWith(ai, anthropic())
  await session.start()
  const said = session.snapshot().thread.filter((t) => t.who === 'sys' && /Max tokens/.test(t.text))
  assert.equal(said.length, 1)
  assert.match(said[0].text, /cut off at the output limit/)
  assert.match(said[0].text, /Work Anthropic/)
  assert.match(said[0].text, /Global Settings/)
  assert.equal(session.snapshot().drafts['details.summary'].value, 'Short.', 'the interview still carries on')
})

test('a cut-off then a whole reply then another cut-off is not "in a row": nothing is said', async () => {
  const ai = fakeAi((_req, n) =>
    n === 0 || n === 2
      ? anthropicReply({ cut: { id: `d${n}`, field: 'details.notes' } })
      : n === 1
        ? anthropicReply({ tools: [{ id: 'ok', input: { field: 'details.summary', value: 'Short.' } }] })
        : anthropicReply({ text: 'Done.' })
  )
  const { session } = sessionWith(ai, anthropic())
  await session.start()
  assert.ok(!session.snapshot().thread.some((t) => /Max tokens/.test(t.text)))
})

test('a chat reply cut off with no tool call: what arrived stays in the thread, and the AI is told its reply reached the output limit', async () => {
  const ai = fakeAi((_req, n) => {
    if (n > 0) return anthropicReply({ text: 'In short: managed hosting.' })
    const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    return sse(
      event('message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }) +
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The deck says the platform moves to' } }) +
        event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } }) +
        event('message_stop', { type: 'message_stop' })
    )
  })
  const { session } = sessionWith(ai, anthropic())
  await session.start()
  assert.equal(ai.calls.length, 2)
  assert.match(lastUserText(ai.calls[1].body), /output limit/)
  const said = session.snapshot().thread.filter((t) => t.who === 'ai').map((t) => t.text)
  assert.deepEqual(said, ['The deck says the platform moves to', 'In short: managed hosting.'])
})
