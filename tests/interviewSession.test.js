import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #286 (parent #238): an AI interview session — the conversation, the drafts, the checks on them. A fake `fetch` plays the
// AI Provider (through the relay, as the app calls it), answering with scripted streams; the AI Providers list is the real
// one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, fieldsInScope, artefactChoices } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { draftGateCheck } = await import('../web/lib/interviewGate.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const EXAMPLE_SENTINEL = 'EXAMPLE-INSTANCE-TEXT-THE-AI-MUST-NEVER-SEE'

function definition() {
  return {
    id: 'small',
    stages: [
      { id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details', 'background'], readOnlyModules: ['background'], example: 'some-example-instance' },
      { id: 'later', title: 'Later', purpose: 'Later.', gate: 'done', modules: ['details'] },
    ],
    artefacts: [
      { id: 'light', title: 'Light', purpose: 'The light one', gate: 'shaped', requires: ['details.summary'] },
      { id: 'full', title: 'Full', purpose: 'The full one', gate: 'shaped', requires: ['details.summary', 'details.notes', 'details.risk'] },
    ],
    modules: [
      {
        id: 'details',
        title: 'Details',
        purpose: 'What it is',
        fields: [
          { id: 'summary', title: 'Summary', type: 'markdown', required: true, targetWords: { small: 5, medium: 8, large: 20 }, example: EXAMPLE_SENTINEL },
          { id: 'risk', title: 'Risk level', type: 'select', options: ['Low', 'Medium', 'High'] },
          { id: 'notes', title: 'Notes', type: 'markdown' },
          { id: 'owner', title: 'Owner', type: 'text' },
        ],
      },
      { id: 'background', title: 'Background', purpose: 'Why', fields: [{ id: 'why', title: 'Why', type: 'markdown' }] },
    ],
  }
}

const sources = [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: '# Client brief\n\nThe insurer wants faster claims.' }]

const savedNothing = () => [
  { id: 'details', status: 'draft', fields: [{ id: 'summary', value: '', example: EXAMPLE_SENTINEL }, { id: 'risk', value: '' }, { id: 'notes', value: '' }, { id: 'owner', value: '' }] },
  { id: 'background', status: 'draft', fields: [{ id: 'why', value: '', example: EXAMPLE_SENTINEL }] },
]

// ---------- a fake AI Provider ----------
const sse = (events) =>
  new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

// An Anthropic reply: some text, then tool calls.
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

// An OpenAI-format reply (for the text fallback and the switch).
function openAiReply(text) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const envelope = JSON.parse(init.body)
    const request = { url: envelope.url, headers: envelope.headers, body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null, raw: envelope.body }
    calls.push(request)
    return handler(request, calls.length - 1)
  }
  return { fetchImpl, calls }
}

const tested = (id, over = {}) => providers.setAiProviderTest(id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok', ...over }, null)
const anthropic = (over = {}) => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', ...over })
  tested(p.id)
  return p
}

function sessionWith(ai, over = {}) {
  const provider = over.provider ?? anthropic()
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, ...over.context }
  const snapshots = []
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, onChange: (s) => snapshots.push(s) })
  return { session, provider, context, snapshots }
}

const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}

// ---------- scope ----------

test('the Fields the AI may draft are the Stage\'s Modules that are not read-only', () => {
  assert.deepEqual([...fieldsInScope(definition(), 'shape').keys()], ['details.summary', 'details.risk', 'details.notes', 'details.owner'])
})

test('the lightest Artefact that can pass the Gate is the one pre-selected', () => {
  const { candidates, lightest } = artefactChoices(definition(), 'shape')
  assert.deepEqual(candidates.map((a) => a.id), ['light', 'full'])
  assert.equal(lightest.id, 'light')
})

// ---------- the interview ----------

test('the AI opens with a summary, drafts Fields through draft_field, and the drafts reach the preview', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) {
      return anthropicReply({
        text: 'I found one brief: the insurer wants faster claims.',
        tools: [
          { id: 't1', input: { field: 'details.summary', value: 'Faster claims [Client brief, p. 1](source:brief).' } },
          { id: 't2', input: { field: 'details.risk', value: 'Medium' } },
        ],
      })
    }
    return anthropicReply({ text: 'Drafted what the brief supports. Who owns this?' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()

  assert.equal(snap.phase, 'waiting')
  assert.deepEqual(Object.keys(snap.drafts).sort(), ['details.risk', 'details.summary'])
  assert.equal(snap.drafts['details.summary'].value, 'Faster claims [Client brief, p. 1](source:brief).')
  assert.deepEqual(snap.drafts['details.summary'].warnings, [])
  assert.equal(snap.drafts['details.risk'].value, 'Medium')
  const ai1 = snap.thread.filter((t) => t.who === 'ai').map((t) => t.text)
  assert.deepEqual(ai1, ['I found one brief: the insurer wants faster claims.', 'Drafted what the brief supports. Who owns this?'])
  assert.equal(snap.thread.filter((t) => t.drafted).length, 2)

  // The AI was offered the question card tool and the draft tool, and told the Stage's rules and the Source document.
  const first = ai.calls[0].body
  assert.deepEqual(first.tools.map((t) => t.name), ['ask_architect', 'draft_field', 'log_decision'])
  assert.match(first.system, /Draft first/)
  assert.match(first.system, /The insurer wants faster claims\./)
  assert.match(first.system, /call the `ask_architect` tool, one round at a time/)
  // The tool results went back to the AI in the second request.
  assert.deepEqual(toolResults(ai.calls[1]).map((r) => [r.tool_use_id, Boolean(r.is_error)]), [['t1', false], ['t2', false]])
})

test('no example Instance content reaches the AI', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Nothing to draft yet.' }))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Please look again.')
  assert.ok(ai.calls.length >= 2)
  for (const call of ai.calls) assert.ok(!call.raw.includes(EXAMPLE_SENTINEL), 'the request has no example text')
})

test('a draft that is over budget goes back once; a corrected one is accepted clean', async () => {
  const long = 'one two three four five six seven eight nine ten'
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [{ id: 't1', input: { field: 'details.summary', value: long } }] })
    if (n === 1) return anthropicReply({ tools: [{ id: 't2', input: { field: 'details.summary', value: 'Faster claims.' } }] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  const result = toolResults(ai.calls[1])[0]
  assert.equal(result.is_error, true)
  assert.match(result.content, /was not shown yet/)
  assert.match(result.content, /10 words is over the Medium budget of about 8/)
  const draft = session.snapshot().drafts['details.summary']
  assert.equal(draft.value, 'Faster claims.')
  assert.deepEqual(draft.warnings, [])
})

test('a draft still wrong the second time reaches the preview with a warning, never a block', async () => {
  const long = 'one two three four five six seven eight nine ten'
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [{ id: 't1', input: { field: 'details.summary', value: long } }] })
    if (n === 1) return anthropicReply({ tools: [{ id: 't2', input: { field: 'details.summary', value: `${long} eleven` } }] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  assert.equal(Boolean(toolResults(ai.calls[2])[0].is_error), false, 'the second attempt is accepted')
  const draft = session.snapshot().drafts['details.summary']
  assert.equal(draft.value, `${long} eleven`)
  assert.equal(draft.warnings.length, 1)
  assert.match(draft.warnings[0], /over the Medium budget/)
})

test('a draft sent back and never corrected still shows, with its problems as warnings', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [{ id: 't1', input: { field: 'details.risk', value: 'Critical' } }] }) : anthropicReply({ text: 'I could not decide.' })))
  const { session } = sessionWith(ai)
  await session.start()
  const draft = session.snapshot().drafts['details.risk']
  assert.equal(draft.value, 'Critical')
  assert.match(draft.warnings[0], /not one of the options/)
})

test('an unsourced figure is sent back, and one the architect typed is not', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Opening.' })
    if (n === 1) return anthropicReply({ tools: [{ id: 't1', input: { field: 'details.notes', value: 'The budget is $1.2M.' } }] })
    return anthropicReply({ text: 'Noted.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('The budget is capped at $1.2M.')
  assert.equal(Boolean(toolResults(ai.calls[2])[0].is_error), false, 'the architect said it, so it is plain fact')
  assert.equal(session.snapshot().drafts['details.notes'].value, 'The budget is $1.2M.')
})

test('Fields with saved content, read-only Modules and unknown Fields are left alone', async () => {
  const saved = savedNothing()
  saved[0].fields[2].value = 'Notes the architect already saved.'
  const ai = fakeAi((request, n) =>
    n === 0
      ? anthropicReply({
          tools: [
            { id: 't1', input: { field: 'details.notes', value: 'My rewrite.' } },
            { id: 't2', input: { field: 'background.why', value: 'Because.' } },
            { id: 't3', input: { field: 'details.nope', value: 'x' } },
            { id: 't4', input: { field: 'details.owner', value: 'Pat' } },
          ],
        })
      : anthropicReply({ text: 'Done.' })
  )
  const { session } = sessionWith(ai, { context: { saved } })
  await session.start()
  const results = toolResults(ai.calls[1])
  assert.deepEqual(results.map((r) => Boolean(r.is_error)), [true, true, true, false])
  assert.match(results[0].content, /already holds saved content/)
  assert.match(results[1].content, /not a Field you can draft/)
  assert.deepEqual(Object.keys(session.snapshot().drafts), ['details.owner'])
})

test('the AI Provider can be switched between two turns, and the history carries over', async () => {
  const first = anthropic({ name: 'First' })
  const second = providers.addAiProvider({ name: 'Second', type: 'openai', address: 'https://api.openai.com/v1', key: 'sk-2', model: 'gpt-x' })
  tested(second.id)
  const ai = fakeAi((request) => (request.url.includes('anthropic') ? anthropicReply({ text: 'Hello from the first.' }) : openAiReply('Hello from the second.')))
  const { session } = sessionWith(ai, { provider: first })
  await session.start()
  const result = await session.setProvider(second.id)
  assert.equal(result.ok, true)
  await session.send('Carry on.')
  assert.ok(ai.calls[0].url.includes('anthropic'))
  assert.ok(ai.calls.at(-1).url.includes('openai'))
  assert.equal(session.providerId, second.id)
  const snap = session.snapshot()
  assert.ok(snap.thread.some((t) => t.who === 'sys' && /Switched to Second/.test(t.text)))
  // The second AI Provider was given the earlier turns.
  const sent = ai.calls.at(-1).body.messages.map((m) => m.role)
  assert.deepEqual(sent.filter((r) => r !== 'system'), ['user', 'assistant', 'user'])
})

test('a model that doesn\'t use tools drafts in text blocks (the text fallback)', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  tested(p.id, { questionCards: 'text' })
  const reply = 'I found the brief.\n```gantry-draft\n{"field":"details.risk","value":"Low"}\n```\n```gantry-draft\n{"field":"details.owner","value":"Pat"}\n```'
  const ai = fakeAi((request, n) => openAiReply(n === 0 ? reply : 'Anything else?'))
  const { session } = sessionWith(ai, { provider: p })
  await session.start()
  assert.equal(ai.calls[0].body.tools, undefined, 'no tools are offered')
  assert.match(ai.calls[0].body.messages[0].content, /gantry-draft/)
  const snap = session.snapshot()
  assert.deepEqual(Object.keys(snap.drafts).sort(), ['details.owner', 'details.risk'])
  assert.ok(snap.thread.some((t) => t.who === 'sys' && /text fallback/.test(t.text)))
  assert.deepEqual(snap.thread.filter((t) => t.who === 'ai').map((t) => t.text), ['I found the brief.'])
})

test('an untested AI Provider is tested when the interview starts, and a failed test stops it', async () => {
  const p = providers.addAiProvider({ name: 'Untested', type: 'anthropic', address: 'https://api.anthropic.com', key: 'bad', model: 'claude-x' })
  const ai = fakeAi((request) => {
    if (request.url.includes('/v1/models')) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } })
    return anthropicReply({ text: 'should not get here' })
  })
  const { session } = sessionWith(ai, { provider: p })
  // The test hits a rejected key, which a person can fix; with nobody to ask, the start gives up with the reason.
  await session.start()
  const snap = session.snapshot()
  assert.equal(snap.phase, 'kickoff')
  assert.ok(snap.kickoffError)
  assert.ok(ai.calls.every((c) => !c.body?.messages), 'no interview call was made')
})

test('markSaved clears the drafts that were saved', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [{ id: 't1', input: { field: 'details.owner', value: 'Pat' } }] }) : anthropicReply({ text: 'Done.' })))
  const { session } = sessionWith(ai)
  await session.start()
  session.markSaved(['details.owner'])
  assert.deepEqual(session.snapshot().drafts, {})
  assert.ok(session.snapshot().thread.some((t) => /Saved 1 Field/.test(t.text)))
})

test('in the text fallback a draft that fails its check is sent back in a message from Gantry, once', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  tested(p.id, { questionCards: 'text' })
  const block = (value) => '```gantry-draft\n' + JSON.stringify({ field: 'details.risk', value }) + '\n```'
  const ai = fakeAi((request, n) => openAiReply(n === 0 ? block('Critical') : n === 1 ? block('High') : 'Done.'))
  const { session } = sessionWith(ai, { provider: p })
  await session.start()
  const sentBack = ai.calls[1].body.messages.at(-1)
  assert.equal(sentBack.role, 'user')
  assert.match(sentBack.content, /Gantry's check of your drafts/)
  assert.match(sentBack.content, /not one of the options/)
  assert.equal(session.snapshot().drafts['details.risk'].value, 'High')
  assert.deepEqual(session.snapshot().drafts['details.risk'].warnings, [])
})

// ---------- the Gate check over drafts ----------

test('the Gate check runs over saved content with the drafts laid on top', () => {
  const structure = { ...definition(), standardModules: [] }
  const modules = savedNothing()
  const none = draftGateCheck({ structure, stageId: 'shape', artefactId: 'light', modules, drafts: {} })
  assert.equal(none.pass, false)
  assert.deepEqual(none.outstanding, ['details.summary'])
  const some = draftGateCheck({ structure, stageId: 'shape', artefactId: 'light', modules, drafts: { 'details.summary': { value: 'Faster claims.' } } })
  assert.equal(some.pass, true)
  const full = draftGateCheck({ structure, stageId: 'shape', artefactId: 'full', modules, drafts: { 'details.summary': { value: 'x' } } })
  assert.equal(full.pass, false)
  assert.deepEqual(full.outstanding, ['details.notes', 'details.risk'])
})

// ---------- #294: tokens, and prompt caching that is always on ----------

test('#294 an Anthropic request carries a one-hour cache point right after the Source documents, and the decisions log follows it', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Nothing to draft yet.' }))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Please look again.')
  assert.ok(ai.calls.length >= 2)
  for (const call of ai.calls) {
    const blocks = call.body.systemBlocks
    assert.equal(blocks.length, 2, 'the stable brief, then what changes')
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(blocks[1].cache_control, undefined, 'one cache point, none after the part that changes')
    assert.match(blocks[0].text, /## 8\. Source documents/)
    assert.match(blocks[0].text, /The insurer wants faster claims\./, 'the Source documents are in front of the cache point')
    assert.doesNotMatch(blocks[0].text, /## 9\. Decisions log so far/)
    assert.match(blocks[1].text, /## 9\. Decisions log so far/)
  }
  assert.equal(ai.calls[0].body.systemBlocks[0].text, ai.calls[1].body.systemBlocks[0].text, 'the same bytes on every turn, so the cache can be read')
})

test("#294 the snapshot carries this session's tokens: all the input, how much was read from the cache, and the output", async () => {
  const ai = fakeAi(() =>
    sse([
      ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 20, cache_read_input_tokens: 700, cache_creation_input_tokens: 80, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }],
      ['message_stop', { type: 'message_stop' }],
    ])
  )
  const { session } = sessionWith(ai)
  await session.start()
  assert.deepEqual(session.snapshot().tokens, { input: 800, cached: 700, output: 30 })
  await session.send('Again.')
  assert.deepEqual(session.snapshot().tokens, { input: 1600, cached: 1400, output: 60 })
  const delta = session.decisionsDelta({ runState: 'in-progress' })
  assert.deepEqual(delta.status.models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 1600, cachedTokens: 1400, outputTokens: 60 }])
})

// ---------- #331: the opening message from the kickoff ----------

const OPENING_WORDS = 'Focus on the hosting decision; the budget is capped at NZD 1.2M.'
const userTexts = (request) => request.body.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n')))

test('#331 an opening message goes with the first request as the architect\'s own message, after Gantry\'s opening, and shows in the thread as theirs', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Looking at hosting first.', tools: [{ id: 't1', input: { field: 'details.risk', value: 'Medium' } }] }) : anthropicReply({ text: 'Drafted.' })))
  const { session } = sessionWith(ai)
  await session.start({ opening: `  ${OPENING_WORDS}  ` })

  const first = ai.calls[0].body
  assert.equal(first.messages.length, 2, 'Gantry\'s opening, then the architect\'s')
  assert.match(userTexts(ai.calls[0])[0], /^Begin the interview\./)
  assert.deepEqual(first.messages[1], { role: 'user', content: OPENING_WORDS }, 'word for word, as a chat message would be')
  assert.ok(!first.system.includes(OPENING_WORDS), 'never in the system prompt')
  assert.equal(userTexts(ai.calls[1]).filter((t) => t === OPENING_WORDS).length, 1, 'sent once: later turns carry it as history')

  const snap = session.snapshot()
  const yours = snap.thread.filter((t) => t.who === 'you')
  assert.deepEqual(yours.map((t) => t.text), [OPENING_WORDS])
  assert.ok(snap.thread.indexOf(yours[0]) < snap.thread.findIndex((t) => t.who === 'ai'), 'it comes before the AI\'s reply')
  assert.equal(snap.opening, OPENING_WORDS)
  assert.equal(session.decisionsDelta({ runState: 'in-progress' }).status.opening, OPENING_WORDS, 'the status block keeps it, for a run resumed elsewhere')
})

test('#331 an empty box changes nothing about the first request', async () => {
  const requests = []
  for (const opening of [undefined, '', '   \n ']) {
    const ai = fakeAi(() => anthropicReply({ text: 'Nothing to draft.' }))
    const { session } = sessionWith(ai)
    await session.start(opening === undefined ? undefined : { opening })
    requests.push(ai.calls[0].body.messages)
    assert.equal(session.snapshot().thread.some((t) => t.who === 'you'), false)
    assert.equal('opening' in session.decisionsDelta({ runState: 'in-progress' }).status, false)
  }
  assert.equal(requests[0].length, 1)
  assert.deepEqual(requests[1], requests[0])
  assert.deepEqual(requests[2], requests[0])
})

test('#331 Start this stage over forgets the opening message; a working copy keeps it', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Nothing to draft.' }))
  const { session, context } = sessionWith(ai)
  await session.start({ opening: OPENING_WORDS })

  const copy = JSON.parse(JSON.stringify(session.exportState()))
  const other = createInterviewSession({ providerId: session.providerId, getContext: () => context, fetchImpl: ai.fetchImpl })
  assert.equal(other.importState(copy), true)
  assert.equal(other.snapshot().opening, OPENING_WORDS)
  assert.equal(other.decisionsDelta({ runState: 'paused' }).status.opening, OPENING_WORDS)

  session.startOver()
  assert.equal(session.snapshot().opening, '')
  const before = ai.calls.length
  await session.start()
  assert.equal(ai.calls[before].body.messages.length, 1, 'the next start opens without it')
})
