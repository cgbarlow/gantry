import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #278 (ADR-0061, ADR-0065): the AI client. A fake `fetch` stands in for `gantry serve`'s relay (and, for a
// local model, for the AI Provider itself), answering with recorded streams or errors. The AI Providers list is
// the real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const client = await import('../web/lib/aiClient.js')
const { ASK_TOOL_NAME } = await import('../web/lib/aiCards.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const fixture = (name) => readFileSync(new URL(`./fixtures/ai-streams/${name}`, import.meta.url), 'utf8')

function sse(text, chunkSize = 13) {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.length; at += chunkSize) controller.enqueue(bytes.subarray(at, at + chunkSize))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}
const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

// A relayed call as the AI Provider would see it.
function seen(url, init) {
  if (url === '/api/ai/relay') {
    const envelope = JSON.parse(init.body)
    return { url: envelope.url, method: envelope.method, headers: envelope.headers, body: envelope.body ? JSON.parse(envelope.body) : null }
  }
  return { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null }
}

// `handler(request, n)` returns the Response for the nth call.
function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const request = seen(url, init)
    calls.push(request)
    return handler(request, calls.length - 1)
  }
  return { fetchImpl, calls }
}

const anthropic = (over = {}) => providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', ...over })
const openai = (over = {}) => providers.addAiProvider({ name: 'OpenAI', type: 'openai', address: 'https://api.openai.com/v1', key: 'sk-1', model: 'gpt-x', ...over })

const validCard = { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }], recommended: 'Red', why: 'Warmer.' }] }
const oneOptionCard = { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }], recommended: 'Red' }] }

// An OpenAI stream carrying one tool call with these arguments.
function openAiToolStream(input, name = ASK_TOOL_NAME) {
  const args = JSON.stringify(input)
  const mid = Math.floor(args.length / 2)
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return (
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: args.slice(0, mid) } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] }) +
    chunk({}, 'tool_calls') +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
  )
}
function openAiTextStream(text) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
}

// ---------- streaming ----------

test('Anthropic: a call goes through the relay and its recorded stream comes back as text, a card call and usage', async () => {
  const p = anthropic()
  const ai = fakeAi(() => sse(fixture('anthropic-tool-call.sse')))
  const events = []
  for await (const e of client.streamChat(p, { system: 'S', messages: [{ role: 'user', text: 'go' }], tools: [] }, { fetchImpl: ai.fetchImpl })) events.push(e)
  assert.equal(ai.calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(ai.calls[0].headers['x-api-key'], 'sk-ant-1')
  assert.deepEqual(events.map((e) => e.type), ['text', 'tool-start', 'tool-call', 'usage', 'done'])
})

test('a local model on this computer is called straight from the browser, with no relay', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'ollama', address: 'http://localhost:11434', model: 'llama3.1:8b' })
  const ai = fakeAi(() => sse(fixture('ollama-tool-call.sse')))
  const events = []
  for await (const e of client.streamChat(p, { messages: [{ role: 'user', text: 'go' }], tools: [] }, { fetchImpl: ai.fetchImpl })) events.push(e)
  assert.equal(ai.calls[0].url, 'http://localhost:11434/v1/chat/completions')
  assert.equal(events.find((e) => e.type === 'tool-call').name, 'ask_architect')
})

test('an endpoint that answers with one JSON body instead of a stream still works', async () => {
  const p = openai()
  const ai = fakeAi(() => jsonRes(200, { choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }))
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'hi' }] }, { fetchImpl: ai.fetchImpl })
  assert.equal(result.kind, 'chat')
  assert.equal(result.text, 'Hi there')
  assert.equal(result.usage.outputTokens, 3)
})

// ---------- turns ----------

test('a card is shown only once its call is complete, with "preparing questions" as soon as it starts, and usage is totalled', async () => {
  const p = anthropic()
  const ai = fakeAi(() => sse(fixture('anthropic-tool-call.sse'), 5))
  const log = []
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], knownSources: ['src-1'] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => log.push(e.type) })
  assert.equal(result.kind, 'cards')
  assert.equal(result.via, 'native')
  assert.equal(result.cards.length, 1)
  assert.equal(result.cards[0].question, 'Which driver leads the problem statement?')
  assert.deepEqual(result.cards[0].source, { document: 'src-1', location: 'p. 4' })
  assert.equal(result.text, 'Three things to settle.')
  assert.deepEqual(log, ['text', 'preparing-questions'])
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0 })
  // the tool was offered with tool_choice auto, never forced
  assert.deepEqual(ai.calls[0].body.tool_choice, { type: 'auto' })
  assert.equal(ai.calls[0].body.tools[0].name, 'ask_architect')
  // what to append to the history keeps the call, so the architect's answer can go back as its result
  assert.deepEqual(result.assistantMessage.toolCalls.map((c) => c.id), ['toolu_01X'])
})

test('a citation of a Source document that does not exist is sent back as an error, once; the corrected card is accepted', async () => {
  const p = openai()
  const bad = { questions: [{ ...validCard.questions[0], source: { document: 'src-404' } }] }
  const good = { questions: [{ ...validCard.questions[0], source: { document: 'src-1' } }] }
  const ai = fakeAi((_req, n) => sse(openAiToolStream(n === 0 ? bad : good)))
  const log = []
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], knownSources: ['src-1'] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => log.push(e.type) })
  assert.equal(ai.calls.length, 2)
  assert.equal(result.kind, 'cards')
  assert.equal(result.retried, true)
  assert.ok(log.includes('retry'))
  const second = ai.calls[1].body.messages
  const lastTwo = second.slice(-2)
  assert.equal(lastTwo[0].role, 'assistant')
  assert.equal(lastTwo[0].tool_calls[0].id, 'call_1')
  assert.equal(lastTwo[1].role, 'tool')
  assert.equal(lastTwo[1].tool_call_id, 'call_1')
  assert.match(lastTwo[1].content, /src-404.*not one of this Instance's Source documents/)
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

test('an invalid card is returned once only: still invalid on the retry, the turn shows as chat', async () => {
  const p = openai({ name: 'Tools' })
  const ai = fakeAi(() => sse(openAiToolStream(oneOptionCard)))
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl })
  assert.equal(ai.calls.length, 2, 'one call, one retry, no more')
  assert.equal(result.kind, 'chat')
  assert.match(result.invalidCards[0], /options has 1/)
  assert.equal(result.assistantMessage.toolCalls, undefined, 'the failed card is not left dangling in the history')
})

test('a model that does not use the tool but writes a gantry-questions block gets the same cards', async () => {
  const p = openai()
  const block = '```gantry-questions\n' + JSON.stringify(validCard) + '\n```'
  const ai = fakeAi(() => sse(openAiTextStream(`Some thoughts.\n\n${block}`)))
  const log = []
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => log.push(e) })
  assert.equal(result.kind, 'cards')
  assert.equal(result.via, 'text')
  assert.equal(result.cards[0].question, 'Which colour?')
  assert.equal(result.text, 'Some thoughts.')
  assert.ok(log.some((e) => e.type === 'preparing-questions'))
  assert.ok(log.filter((e) => e.type === 'text').every((e) => !e.text.includes('gantry-questions')), 'the block is never shown as chat while it streams')
})

test('in text-fallback mode no tool is sent and the fallback instructions are added to the system prompt', async () => {
  const p = openai()
  providers.setAiProviderTest(p.id, { status: 'passed', questionCards: 'text' })
  const stored = providers.getAiProvider(p.id)
  assert.equal(client.questionCardMode(stored), 'text')
  const ai = fakeAi(() => sse(openAiTextStream('```gantry-questions\n' + JSON.stringify(validCard) + '\n```')))
  const result = await client.runTurn(stored, { system: 'Base rules.', messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl })
  assert.equal(ai.calls[0].body.tools, undefined)
  assert.equal(ai.calls[0].body.tool_choice, undefined)
  assert.match(ai.calls[0].body.messages[0].content, /^Base rules\.\n\n.*gantry-questions/s)
  assert.equal(result.via, 'text')
  assert.equal(result.cards.length, 1)
})

test('nothing parseable is chat: plain text, a broken block, and an invalid block are all shown as the AI wrote them', async () => {
  const p = openai()
  for (const text of ['What would you like to do next?', '```gantry-questions\n{broken\n```', '```gantry-questions\n' + JSON.stringify(oneOptionCard) + '\n```']) {
    const ai = fakeAi(() => sse(openAiTextStream(text)))
    const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl })
    assert.equal(result.kind, 'chat', text)
    assert.equal(result.text, text)
    assert.equal(ai.calls.length, 1, 'a fenced block is not sent back for correction')
  }
})

test('a call to the caller’s own tool comes back as a tool turn, with the card tool still on offer', async () => {
  const p = openai()
  const ai = fakeAi(() => sse(openAiToolStream({ id: 'src-1' }, 'read_document_section')))
  const tool = { name: 'read_document_section', description: 'Read.', parameters: { type: 'object' } }
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], tools: [tool] }, { fetchImpl: ai.fetchImpl })
  assert.equal(result.kind, 'tools')
  assert.deepEqual(result.otherToolCalls.map((c) => c.name), ['read_document_section'])
  assert.deepEqual(ai.calls[0].body.tools.map((t) => t.function.name), ['ask_architect', 'read_document_section'])
})

// ---------- #344: a reply cut off at the output limit ----------

// An Anthropic stream with some text, one complete draft_field call, and a second one the output limit cut off part-way: its block still
// closes, with arguments that are not whole JSON, and the message stops with `max_tokens`.
function anthropicCutOffStream({ stop = 'max_tokens' } = {}) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return (
    event('message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Drafting both.' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'd1', name: 'draft_field', input: {} } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"field": "details.summary", "value": "Short."}' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'd2', name: 'draft_field', input: {} } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"field": "details.notes", "value": "A very long dra' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 2 }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 4096 } }) +
    event('message_stop', { type: 'message_stop' })
  )
}
const draftTool = { name: 'draft_field', description: 'Draft.', parameters: { type: 'object' } }

test('#344: a reply Anthropic stopped at max_tokens is cut off, and only the call the limit cut short is marked; the complete one is used', async () => {
  const p = anthropic()
  const ai = fakeAi(() => sse(anthropicCutOffStream()))
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: ai.fetchImpl })
  assert.equal(result.kind, 'tools')
  assert.equal(result.cutOff, true)
  assert.equal(result.text, 'Drafting both.', 'the text before the cut-off is kept')
  const [whole, cut] = result.otherToolCalls
  assert.deepEqual(whole.input, { field: 'details.summary', value: 'Short.' })
  assert.equal(whole.cutOff, undefined)
  assert.equal(cut.input, null)
  assert.equal(cut.cutOff, true)
  assert.equal(ai.calls.length, 1, 'runTurn does not send it again itself: the caller answers the calls')
})

test('#344: an OpenAI-compatible reply that finished with "length" is cut off; one that finished normally is not', async () => {
  const p = openai()
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const cut = chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'draft_field', arguments: '{"field": "details.notes", "value": "Lo' } }] }) + chunk({}, 'length') + 'data: [DONE]\n\n'
  let result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: fakeAi(() => sse(cut)).fetchImpl })
  assert.equal(result.cutOff, true)
  assert.equal(result.otherToolCalls[0].cutOff, true)
  result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: fakeAi(() => sse(openAiToolStream({ field: 'details.notes', value: 'x' }, 'draft_field'))).fetchImpl })
  assert.equal(result.cutOff, false)
  assert.equal(result.otherToolCalls[0].cutOff, undefined)
})

test('#344: a question card the output limit cut off goes back once saying the reply reached the output limit, not just that the JSON was invalid', async () => {
  const p = openai()
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const cut = chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: ASK_TOOL_NAME, arguments: '{"questions": [{"question": "Which col' } }] }) + chunk({}, 'length') + 'data: [DONE]\n\n'
  const ai = fakeAi((_req, n) => sse(n === 0 ? cut : openAiToolStream(validCard)))
  const log = []
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => log.push(e) })
  assert.equal(result.kind, 'cards')
  assert.equal(result.cutOff, false, 'the reply the cards came in was whole')
  assert.equal(log.find((e) => e.type === 'retry').cutOff, true)
  const sent = ai.calls[1].body.messages.at(-1)
  assert.equal(sent.role, 'tool')
  assert.match(sent.content, /output limit/)
  assert.doesNotMatch(sent.content, /not valid JSON/)
})

test('#344: a call the output limit cut off before any of its arguments arrived is cut off too, from either wire format', async () => {
  // Anthropic: the last tool_use block opens and closes with no input_json_delta, and the message stops with max_tokens.
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const anthropicStream = (stop) =>
    event('message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'd1', name: 'draft_field', input: {} } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"field": "details.summary", "value": "Short."}' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'd2', name: 'draft_field', input: {} } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 4096 } }) +
    event('message_stop', { type: 'message_stop' })
  let result = await client.runTurn(anthropic(), { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: fakeAi(() => sse(anthropicStream('max_tokens'))).fetchImpl })
  assert.deepEqual(result.otherToolCalls.map((c) => [c.id, c.cutOff]), [['d1', undefined], ['d2', true]], 'only the last call, the one the limit stopped, is cut off')
  // The same reply ended of itself is a call with no arguments, for the tool to answer as usual.
  result = await client.runTurn(anthropic(), { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: fakeAi(() => sse(anthropicStream('tool_use'))).fetchImpl })
  assert.deepEqual(result.otherToolCalls.map((c) => c.cutOff), [undefined, undefined])

  // OpenAI-compatible: the call's name arrived but none of its arguments, and the reply finished with `length`.
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const named = chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'draft_field', arguments: '' } }] }) + chunk({}, 'length') + 'data: [DONE]\n\n'
  result = await client.runTurn(openai(), { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: fakeAi(() => sse(named)).fetchImpl })
  assert.equal(result.cutOff, true)
  assert.equal(result.otherToolCalls[0].cutOff, true)
})

test('#344: a reply with an invalid question card and a draft the output limit cut off: the retry says it was cut off, and so does the draft', async () => {
  const p = openai()
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const badCard = { questions: [{ ...validCard.questions[0], options: [{ label: 'Red' }] }] } // whole JSON, but one option is not a choice
  const reply =
    chunk({ tool_calls: [{ index: 0, id: 'card_1', function: { name: ASK_TOOL_NAME, arguments: JSON.stringify(badCard) } }] }) +
    chunk({ tool_calls: [{ index: 1, id: 'draft_1', function: { name: 'draft_field', arguments: '{"field": "details.notes", "value": "A long dra' } }] }) +
    chunk({}, 'length') +
    'data: [DONE]\n\n'
  const ai = fakeAi((_req, n) => sse(n === 0 ? reply : openAiToolStream(validCard)))
  const log = []
  const result = await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }], tools: [draftTool] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => log.push(e) })
  assert.equal(result.kind, 'cards')
  assert.equal(log.find((e) => e.type === 'retry').cutOff, true, 'the reply reached the output limit, though the card itself was whole')
  const told = Object.fromEntries(ai.calls[1].body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]))
  assert.match(told.card_1, /options has 1/, 'the card has its own error')
  assert.equal(told.draft_1, client.CUT_OFF_CALL_RESULT)
})

test('#344: an invalid question card in a reply the output limit cut off after its calls: the retry carries a note that the reply was cut off', async () => {
  const p = openai()
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const badCard = { questions: [{ ...validCard.questions[0], options: [{ label: 'Red' }] }] }
  const reply = chunk({ tool_calls: [{ index: 0, id: 'card_1', function: { name: ASK_TOOL_NAME, arguments: JSON.stringify(badCard) } }] }) + chunk({}, 'length') + 'data: [DONE]\n\n'
  const ai = fakeAi((_req, n) => sse(n === 0 ? reply : openAiToolStream(validCard)))
  const log = []
  await client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => log.push(e) })
  assert.equal(log.find((e) => e.type === 'retry').cutOff, true)
  const sent = ai.calls[1].body.messages.at(-1)
  assert.equal(sent.role, 'user')
  assert.equal(sent.content, client.CUT_OFF_NOTE)
})

// ---------- failures ----------

test('each failure says what to do: key, credit, rate limit, address and model', async () => {
  const p = anthropic()
  const fail = async (res) => {
    const ai = fakeAi(() => res)
    return client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl }).then(
      () => assert.fail('should have failed'),
      (e) => e
    )
  }
  const key = await fail(jsonRes(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
  assert.equal(key.code, 'key-rejected')
  assert.match(key.message, /rejected the key: invalid x-api-key/)
  const limited = await fail(jsonRes(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } }, { 'retry-after': '12' }))
  assert.equal(limited.code, 'rate-limited')
  assert.equal(limited.retryAfter, 12)
  assert.match(limited.message, /about 12 seconds/)
  assert.equal((await fail(jsonRes(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))).code, 'rate-limited')
  assert.equal((await fail(jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }))).code, 'out-of-credit')
  assert.equal((await fail(jsonRes(402, { error: { message: 'Insufficient credits' } }))).code, 'out-of-credit')
  assert.equal((await fail(jsonRes(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }))).code, 'out-of-credit', 'a 429 that is really about quota is a credit problem')
  assert.equal((await fail(jsonRes(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } }))).code, 'model-not-found')
  assert.equal((await fail(jsonRes(400, { error: 'ai_address_refused', message: 'set GANTRY_AI_ALLOW_PRIVATE_URLS' }))).code, 'address-refused')
  assert.equal((await fail(jsonRes(502, { error: 'ai_unreachable', message: 'could not reach' }))).code, 'failed')
})

// #329: a request too long for the model is told apart from any other 400, whoever words it, so the interview can compact and send it again.
test('a refusal of a request as too long for the model is "too-long", from every AI Provider, and is not retried as a sampling refusal', async () => {
  const p = anthropic({ temperature: 0.3 })
  const failOf = async (res, provider = p) => {
    const ai = fakeAi(() => res)
    const err = await client.runTurn(provider, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl }).then(
      () => assert.fail('should have failed'),
      (e) => e
    )
    return { err, calls: ai.calls.length }
  }
  const anthropicTooLong = await failOf(jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 215000 tokens > 200000 maximum' } }))
  assert.equal(anthropicTooLong.err.code, 'too-long')
  assert.ok(client.isTooLong(anthropicTooLong.err))
  assert.match(anthropicTooLong.err.message, /Work Anthropic says the conversation is too long for the model: prompt is too long/)
  assert.equal(anthropicTooLong.calls, 1, 'not sent again without its temperature: that would not make it shorter')

  const o = openai()
  const tooLong = [
    jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'input length and `max_tokens` exceed context limit: 190000 + 21333 > 200000, decrease input length or `max_tokens` and try again' } }),
    jsonRes(413, { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' } }),
    jsonRes(400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130112 tokens.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }),
    jsonRes(400, { error: { message: "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens.", code: 400 } }),
    jsonRes(400, { error: { message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }),
    jsonRes(400, { object: 'error', message: 'Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length', type: 'invalid_request_message_error' }),
    jsonRes(400, { error: { message: 'the input length exceeds the context length' } }),
  ]
  for (const res of tooLong) assert.equal((await failOf(res, o)).err.code, 'too-long')
  for (const res of [jsonRes(400, { error: { message: 'messages: field required' } }), jsonRes(429, { error: { message: 'Request too large for gpt-x on tokens per min (TPM): Limit 30000, Requested 50000.', code: 'rate_limit_exceeded' } })]) {
    const { err } = await failOf(res, o)
    assert.notEqual(err.code, 'too-long')
    assert.ok(!client.isTooLong(err))
  }
})

test('a failure in the middle of a stream is the same kind of failure', async () => {
  const p = anthropic()
  const ai = fakeAi(() => sse(fixture('anthropic-error.sse')))
  await assert.rejects(() => client.runTurn(p, { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl }), (e) => e.code === 'rate-limited')
})

// ---------- recovery ----------

test('a rejected key asks for a key and sends the same request again with it', async () => {
  const p = anthropic({ key: 'old-key' })
  const ai = fakeAi((req) => (req.headers['x-api-key'] === 'new-key' ? sse(fixture('anthropic-text.sse')) : jsonRes(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })))
  const prompts = []
  const result = await client.runWithRecovery(() => client.runTurn(providers.getAiProvider(p.id), { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl }), {
    askForKey: async (err) => {
      prompts.push(err.code)
      providers.updateAiProvider(p.id, { key: 'new-key' })
      return 'new-key'
    },
  })
  assert.deepEqual(prompts, ['key-rejected'])
  assert.equal(ai.calls.length, 2)
  assert.deepEqual(ai.calls[1].body, ai.calls[0].body, 'the very same request is sent again')
  assert.equal(result.text, 'Hello, architect.')
})

test('declining to enter a key leaves the failure standing', async () => {
  const p = anthropic()
  const ai = fakeAi(() => jsonRes(401, { error: { message: 'no' } }))
  await assert.rejects(
    () => client.runWithRecovery(() => client.runTurn(providers.getAiProvider(p.id), { messages: [] }, { fetchImpl: ai.fetchImpl }), { askForKey: async () => null }),
    (e) => e.code === 'key-rejected'
  )
  assert.equal(ai.calls.length, 1)
})

test('a rate limit or no credit offers Retry, and Retry sends the request again', async () => {
  const p = anthropic()
  for (const [status, body, code] of [[429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate-limited'], [402, { error: { message: 'no credit' } }, 'out-of-credit']]) {
    const ai = fakeAi((_req, n) => (n === 0 ? jsonRes(status, body) : sse(fixture('anthropic-text.sse'))))
    const offered = []
    const result = await client.runWithRecovery(() => client.runTurn(providers.getAiProvider(p.id), { messages: [{ role: 'user', text: 'go' }] }, { fetchImpl: ai.fetchImpl }), {
      askToRetry: async (err) => {
        offered.push(err.code)
        return true
      },
    })
    assert.deepEqual(offered, [code])
    assert.equal(result.text, 'Hello, architect.')
    assert.equal(ai.calls.length, 2)
  }
})

test('anything else is not retried, and a Retry that is declined throws the failure', async () => {
  const p = anthropic()
  const ai = fakeAi(() => jsonRes(500, { error: { message: 'boom' } }))
  let asked = 0
  await assert.rejects(
    () => client.runWithRecovery(() => client.runTurn(providers.getAiProvider(p.id), { messages: [] }, { fetchImpl: ai.fetchImpl }), { askForKey: async () => (asked++, true), askToRetry: async () => (asked++, true) }),
    (e) => e.code === 'failed'
  )
  assert.equal(asked, 0)
  const limited = fakeAi(() => jsonRes(429, { error: { message: 'slow' } }))
  await assert.rejects(
    () => client.runWithRecovery(() => client.runTurn(providers.getAiProvider(p.id), { messages: [] }, { fetchImpl: limited.fetchImpl }), { askToRetry: async () => false }),
    (e) => e.code === 'rate-limited'
  )
})

// ---------- Test connection ----------

// A stand-in AI Provider for Test connection: lists models, answers the card probe and the image probe.
function connectionAi({ models, card = 'tool', image = 'red', tools = true } = {}) {
  return fakeAi((req) => {
    if (req.method === 'GET') return jsonRes(200, models ?? { data: [{ id: 'claude-x', max_input_tokens: 200000, capabilities: { image_input: { supported: true } } }] })
    const isCard = Boolean(req.body.tools)
    if (isCard) {
      if (card === 'tool') return sse(fixture('anthropic-tool-call.sse'))
      if (card === 'text') return sse(fixture('anthropic-text.sse'))
      if (card === 'unsupported') return jsonRes(400, { error: { message: 'this model does not support tools' } })
      if (card === 'invalid-tool') return sse(fixture('anthropic-tool-call.sse').replace('Cost', 'Cost').replace('\\"recommended\\": \\"Cost\\"', '\\"recommended\\": \\"Neither\\"'))
    }
    if (image === 'red') return sse(fixture('anthropic-text.sse').replace('Hello, ', 'It is ').replace('architect.', 'red.'))
    if (image === 'unsupported') return jsonRes(400, { error: { message: 'image input is not supported' } })
    return sse(fixture('anthropic-text.sse'))
  })
}

test('Test connection checks the key, the model, question cards and images, in that order, and the labels follow', async () => {
  const p = anthropic()
  const ai = connectionAi()
  const steps = []
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: ai.fetchImpl, onProgress: (s) => steps.push(s) })
  assert.deepEqual(steps, ['key', 'model', 'cards', 'images'])
  assert.equal(result.status, 'passed')
  assert.equal(result.questionCards, 'native')
  assert.equal(result.readsImages, true)
  assert.deepEqual(result.steps.map((s) => [s.id, s.ok]), [['key', true], ['model', true], ['cards', true], ['images', true]])
  // key + model from one list call, then the card probe; the image answer came from published metadata, so no probe
  assert.equal(ai.calls.length, 2)
  assert.equal(ai.calls[1].body.tool_choice.type, 'auto')

  providers.setAiProviderTest(p.id, result)
  const stored = providers.getAiProvider(p.id)
  assert.equal(providers.aiProviderStatusLabel(stored).label, 'Ready')
  assert.equal(providers.aiProviderQuestionCardsLabel(stored), 'Native')
  assert.equal(providers.aiProviderReadsImagesLabel(stored), 'Yes')
})

test('#346: Test connection keeps its own small output limit, whatever the AI Provider\'s Max tokens says', async () => {
  for (const [name, maxTokens] of [['Blank', null], ['Big', 16000]]) {
    const p = anthropic({ name, maxTokens })
    const ai = connectionAi({ image: 'red', models: { data: [{ id: 'claude-x', max_input_tokens: 200000 }] } })
    await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: ai.fetchImpl })
    const sent = ai.calls.filter((c) => c.method === 'POST').map((c) => c.body.max_tokens)
    assert.ok(sent.length >= 2, name)
    assert.ok(sent.every((n) => n === 2048), `${name}: ${sent}`)
  }
})

test('a model that cannot use the tool is a text fallback, not a failure', async () => {
  for (const card of ['text', 'unsupported', 'invalid-tool']) {
    const p = anthropic({ name: `A-${card}` })
    const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: connectionAi({ card }).fetchImpl })
    assert.equal(result.status, 'passed', card)
    assert.equal(result.questionCards, 'text', card)
    assert.match(result.steps.find((s) => s.id === 'cards').detail, /text fallback/)
  }
})

test('the metadata hint can rule native out without a probe call, and a hint of "yes" is still probed', async () => {
  const p = providers.addAiProvider({ name: 'OR', type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k', model: 'x/y' })
  const noTools = fakeAi((req) => (req.method === 'GET' ? jsonRes(200, { data: [{ id: 'x/y', context_length: 8000, supported_parameters: ['temperature'], architecture: { input_modalities: ['text'] } }] }) : assert.fail('no probe expected')))
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: noTools.fetchImpl })
  assert.equal(result.questionCards, 'text')
  assert.equal(result.readsImages, false)
  assert.equal(noTools.calls.length, 1)

  const hinted = fakeAi((req) => (req.method === 'GET' ? jsonRes(200, { data: [{ id: 'x/y', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } }] }) : sse(openAiTextStream('I will not use the tool'))))
  const probed = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: hinted.fetchImpl })
  assert.equal(probed.questionCards, 'text', 'metadata is optimistic: only a real card counts as native')
  assert.equal(probed.readsImages, true)
  assert.equal(hinted.calls.length, 2)
  assert.equal(hinted.calls[1].body.provider.require_parameters, true)
})

test('Ollama’s /api/show capabilities are the hint', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'ollama', address: 'http://localhost:11434', model: 'llama3.1:8b' })
  const ai = fakeAi((req) => {
    if (req.url.endsWith('/api/tags')) return jsonRes(200, { models: [{ name: 'llama3.1:8b' }] })
    if (req.url.endsWith('/api/show')) return jsonRes(200, { capabilities: ['completion', 'vision'] })
    return assert.fail('no probe expected')
  })
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: ai.fetchImpl })
  assert.equal(result.questionCards, 'text')
  assert.equal(result.readsImages, true)
  assert.equal(result.status, 'passed')
})

test('images are probed with a picture when nothing is published, and a refusal means "no"', async () => {
  const p = openai()
  const models = { data: [{ id: 'gpt-x' }] }
  const reads = fakeAi((req) => (req.method === 'GET' ? jsonRes(200, models) : req.body.tools ? sse(openAiToolStream(validCard)) : sse(openAiTextStream('Red'))))
  const yes = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: reads.fetchImpl })
  assert.equal(yes.readsImages, true)
  assert.equal(yes.questionCards, 'native')
  const imageCall = reads.calls.at(-1).body.messages.find((m) => m.role === 'user')
  assert.equal(imageCall.content[1].image_url.url.startsWith('data:image/png;base64,'), true)

  const refuses = fakeAi((req) => (req.method === 'GET' ? jsonRes(200, models) : req.body.tools ? sse(openAiToolStream(validCard)) : jsonRes(400, { error: { message: 'images are not supported' } })))
  assert.equal((await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: refuses.fetchImpl })).readsImages, false)
  const blind = fakeAi((req) => (req.method === 'GET' ? jsonRes(200, models) : req.body.tools ? sse(openAiToolStream(validCard)) : sse(openAiTextStream('I cannot see an image'))))
  assert.equal((await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: blind.fetchImpl })).readsImages, false)
})

test('a model the AI Provider does not list, or none chosen, fails the model step and goes no further', async () => {
  const p = anthropic({ model: 'claude-missing' })
  const ai = connectionAi()
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: ai.fetchImpl })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /doesn’t list a model called claude-missing/)
  assert.deepEqual(result.steps.map((s) => [s.id, s.ok]), [['key', true], ['model', false]])
  assert.equal(ai.calls.length, 1)
  assert.equal(providers.aiProviderStatusLabel({ test: result }).label, 'Failed')

  const q = providers.getAiProvider(anthropic({ name: 'No model', model: '' }).id)
  assert.match((await client.testConnection(q, { fetchImpl: ai.fetchImpl })).message, /No model is chosen/)
})

test('a rejected key during Test connection is thrown for the key prompt; any other failure is a failed result', async () => {
  const p = anthropic()
  const rejected = fakeAi(() => jsonRes(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
  await assert.rejects(() => client.testConnection(providers.getAiProvider(p.id), { fetchImpl: rejected.fetchImpl }), (e) => e.code === 'key-rejected')
  const down = fakeAi(() => jsonRes(500, { error: { message: 'boom' } }))
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: down.fetchImpl })
  assert.equal(result.status, 'failed')
  assert.equal(result.steps[0].ok, false)
})

test('a custom endpoint that has no model list is checked by the probe calls instead', async () => {
  const p = providers.addAiProvider({ name: 'Custom', type: 'custom', address: 'https://llm.example.com/v1', key: 'k', model: 'whatever' })
  const ai = fakeAi((req) => (req.method === 'GET' ? jsonRes(404, { error: 'not found' }) : req.body.tools ? sse(openAiToolStream(validCard)) : sse(openAiTextStream('red'))))
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: ai.fetchImpl })
  assert.equal(result.status, 'passed')
  assert.equal(result.questionCards, 'native')
})

test('testAndStore recovers from a rejected key, stores the result with the AI Provider and shows it as labels', async () => {
  const p = anthropic({ key: 'old' })
  const ai = fakeAi((req) => {
    if (req.headers['x-api-key'] !== 'good') return jsonRes(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    return req.method === 'GET' ? jsonRes(200, { data: [{ id: 'claude-x' }] }) : req.body.tools ? sse(fixture('anthropic-tool-call.sse')) : sse(fixture('anthropic-text.sse').replace('architect.', 'red.'))
  })
  let prompts = 0
  const result = await client.testAndStore(p.id, {
    fetchImpl: ai.fetchImpl,
    handlers: {
      askForKey: async () => {
        prompts++
        providers.updateAiProvider(p.id, { key: 'good' })
        return 'good'
      },
    },
  })
  assert.equal(prompts, 1)
  assert.equal(result.status, 'passed')
  const stored = providers.getAiProvider(p.id)
  assert.equal(stored.test.status, 'passed')
  assert.equal(stored.test.questionCards, 'native')
  assert.equal(stored.key, 'good')
  // changing the model afterwards marks it untested again
  providers.updateAiProvider(p.id, { model: 'claude-y' })
  assert.equal(providers.getAiProvider(p.id).test, null)
})

test('a result for an AI Provider edited while the test ran is dropped, not shown against the new settings', async () => {
  const p = anthropic()
  const ai = connectionAi()
  const slow = async (url, init) => {
    providers.updateAiProvider(p.id, { model: 'claude-other' })
    return ai.fetchImpl(url, init)
  }
  await client.testAndStore(p.id, { fetchImpl: slow })
  assert.equal(providers.getAiProvider(p.id).test, null)
})

test('an untested AI Provider is tested automatically when a session starts; a tested one is left alone', async () => {
  const p = anthropic()
  const ai = connectionAi()
  assert.equal(providers.getAiProvider(p.id).test, null)
  const tested = await client.ensureTested(p.id, { fetchImpl: ai.fetchImpl })
  assert.equal(tested.test.status, 'passed')
  const calls = ai.calls.length
  await client.ensureTested(p.id, { fetchImpl: ai.fetchImpl })
  assert.equal(ai.calls.length, calls, 'no second test')
  assert.equal(await client.ensureTested('nope'), null)
})

// ---------- models that refuse sampling settings ----------

// A model that answers 400 to any request carrying temperature, top_p or top_k, as the newest Claude models do.
function noSamplingAi() {
  return fakeAi((req) => {
    if (req.method === 'GET') return jsonRes(200, { data: [{ id: 'claude-no-sampling', max_input_tokens: 200000, capabilities: { image_input: { supported: true } } }] })
    if (req.body.temperature !== undefined || req.body.top_p !== undefined || req.body.top_k !== undefined) {
      return jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: '`temperature` may only be set to 1 for this model.' } })
    }
    return sse(fixture('anthropic-tool-call.sse'))
  })
}

test('a model that refuses sampling settings is called again without them, once, and then remembered', async () => {
  const p = anthropic({ model: 'claude-no-sampling', temperature: 0.3 })
  const ai = noSamplingAi()
  const events = []
  for await (const e of client.streamChat(providers.getAiProvider(p.id), { messages: [{ role: 'user', text: 'go' }], tools: [] }, { fetchImpl: ai.fetchImpl })) events.push(e)
  assert.deepEqual(events.map((e) => e.type), ['text', 'tool-start', 'tool-call', 'usage', 'done'])
  assert.equal(ai.calls.length, 2, 'refused once, then answered')
  assert.equal(ai.calls[0].body.temperature, 0.3)
  assert.equal(ai.calls[1].body.temperature, undefined)
  // The next call leaves them out from the start, and the saved setting is untouched.
  for await (const e of client.streamChat(providers.getAiProvider(p.id), { messages: [{ role: 'user', text: 'again' }], tools: [] }, { fetchImpl: ai.fetchImpl })) void e
  assert.equal(ai.calls.length, 3)
  assert.equal(ai.calls[2].body.temperature, undefined)
  assert.equal(providers.getAiProvider(p.id).temperature, 0.3)
})

// #341: the refusal is remembered in this browser's storage, per AI Provider type, address and model, so a reload does not make the first
// call (on a resume, the one that carries the whole brief) twice. The caller hears that the call is going again without the setting.
test('a refused sampling setting is remembered in this browser, so after a reload the first call leaves it out and is not refused', async () => {
  map.delete(client.SAMPLING_REFUSALS_KEY)
  // A page that has not met this model yet (the test above taught the shared copy of the module).
  const page = await import(`../web/lib/aiClient.js?page=${Date.now()}`)
  const p = anthropic({ model: 'claude-no-sampling', temperature: 0.3 })
  const ai = noSamplingAi()
  const heard = []
  for await (const e of page.streamChat(providers.getAiProvider(p.id), { messages: [{ role: 'user', text: 'go' }], tools: [] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => heard.push(e) })) void e
  assert.deepEqual(heard, [{ type: 'sampling-retry', without: 'temperature' }], 'the caller is told the call is going again, and without what')
  const stored = map.get(client.SAMPLING_REFUSALS_KEY)
  assert.ok(stored, 'kept in storage')
  assert.ok(!stored.includes('sk-ant-1'), 'never the key')
  assert.deepEqual(JSON.parse(stored), [{ type: 'anthropic', address: 'https://api.anthropic.com', model: 'claude-no-sampling' }])

  // A reload: a fresh copy of the module, with nothing in memory.
  const reloaded = await import(`../web/lib/aiClient.js?reload=${Date.now()}`)
  const after = noSamplingAi()
  const again = []
  for await (const e of reloaded.streamChat(providers.getAiProvider(p.id), { messages: [{ role: 'user', text: 'again' }], tools: [] }, { fetchImpl: after.fetchImpl, onEvent: (e) => again.push(e) })) void e
  assert.equal(after.calls.length, 1, 'one call, not refused')
  assert.equal(after.calls[0].body.temperature, undefined)
  assert.deepEqual(again, [])
  assert.equal(providers.getAiProvider(p.id).temperature, 0.3, "the architect's setting is not changed")

  // Another model at the same AI Provider is not affected.
  const other = anthropic({ name: 'Other', model: 'claude-x', temperature: 0.3 })
  const ok = fakeAi(() => sse(fixture('anthropic-tool-call.sse')))
  for await (const e of reloaded.streamChat(providers.getAiProvider(other.id), { messages: [{ role: 'user', text: 'go' }], tools: [] }, { fetchImpl: ok.fetchImpl })) void e
  assert.equal(ok.calls[0].body.temperature, 0.3)
  map.delete(client.SAMPLING_REFUSALS_KEY)
})

test('a refused sampling setting is still remembered for the page when the browser blocks storage', async () => {
  const saved = globalThis.localStorage
  globalThis.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
  try {
    const fresh = await import(`../web/lib/aiClient.js?blocked=${Date.now()}`)
    const p = { id: 'x', name: 'Blocked', type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-no-sampling', temperature: 0.3, advanced: { topP: 0.9 }, test: null }
    const ai = noSamplingAi()
    const heard = []
    for await (const e of fresh.streamChat(p, { messages: [{ role: 'user', text: 'go' }], tools: [] }, { fetchImpl: ai.fetchImpl, onEvent: (e) => heard.push(e) })) void e
    assert.deepEqual(heard, [{ type: 'sampling-retry', without: 'temperature and top_p' }])
    for await (const e of fresh.streamChat(p, { messages: [{ role: 'user', text: 'again' }], tools: [] }, { fetchImpl: ai.fetchImpl })) void e
    assert.equal(ai.calls.length, 3, 'refused once, answered, then left out from the start')
  } finally {
    globalThis.localStorage = saved
  }
})

test('Test connection on a model that refuses sampling settings still finds native question cards', async () => {
  const p = anthropic({ model: 'claude-no-sampling', name: 'No sampling', temperature: 0.3 })
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: noSamplingAi().fetchImpl })
  assert.equal(result.status, 'passed')
  assert.equal(result.questionCards, 'native')
})

test('a text fallback after a refused tool check says what the AI Provider answered', async () => {
  const p = anthropic({ name: 'Refuses tools' })
  const result = await client.testConnection(providers.getAiProvider(p.id), { fetchImpl: connectionAi({ card: 'unsupported' }).fetchImpl })
  assert.equal(result.questionCards, 'text')
  assert.match(result.steps.find((s) => s.id === 'cards').detail, /refused the tool-call check \(this model does not support tools\)/)
})
