import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildChatRequest, createParser, createSseReader, eventsFromCompleteResponse } from '../web/lib/aiAdapters.js'
import { normaliseAiProvider } from '../web/lib/aiProviders.js'

// #278 (ADR-0061): the two wire-format adapters, tested against recorded streams: plain text, a complete tool
// call split across chunks, and token usage. Each recorded stream is also replayed split at awkward places
// (one byte at a time, and 7 bytes at a time) to prove the reader doesn't depend on where a network read ends.
const fixture = (name) => readFileSync(new URL(`./fixtures/ai-streams/${name}`, import.meta.url), 'utf8')

function parse(providerType, stream, chunkSize = Infinity) {
  const provider = normaliseAiProvider({ type: providerType, name: 'P' })
  const parser = createParser(provider)
  const sse = createSseReader()
  const events = []
  const bytes = Buffer.from(stream, 'utf8')
  const decoder = new TextDecoder()
  for (let at = 0; at < bytes.length; at += chunkSize) {
    for (const event of sse.push(decoder.decode(bytes.subarray(at, at + chunkSize), { stream: true }))) events.push(...parser.feed(event))
  }
  for (const event of sse.end()) events.push(...parser.feed(event))
  events.push(...parser.finish())
  return events
}

const CARD_INPUT = {
  questions: [
    {
      header: 'Problem',
      question: 'Which driver leads the problem statement?',
      options: [
        { label: 'Cost', description: 'Reduce running cost' },
        { label: 'Speed', description: 'Faster claims' },
      ],
      recommended: 'Cost',
      why: 'The business case leads with it.',
      source: { document: 'src-1', location: 'p. 4' },
    },
  ],
}

const text = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('')

for (const chunkSize of [Infinity, 7, 1]) {
  const split = chunkSize === Infinity ? 'whole' : `${chunkSize}-byte chunks`

  test(`Anthropic: text and token usage from a recorded stream (${split})`, () => {
    const events = parse('anthropic', fixture('anthropic-text.sse'), chunkSize)
    assert.equal(text(events), 'Hello, architect.')
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 40, outputTokens: 15, cacheReadTokens: 10, cacheWriteTokens: 5 }) // #294: all the input, 25 uncached + 10 read + 5 written
    assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'end_turn' })
    assert.equal(events.filter((e) => e.type === 'tool-call').length, 0)
  })

  test(`Anthropic: a tool call split across chunks arrives whole, after a tool-start (${split})`, () => {
    const events = parse('anthropic', fixture('anthropic-tool-call.sse'), chunkSize)
    assert.equal(text(events), 'Three things to settle.')
    const types = events.map((e) => e.type)
    assert.ok(types.indexOf('tool-start') < types.indexOf('tool-call'))
    assert.deepEqual(events.filter((e) => e.type === 'tool-start'), [{ type: 'tool-start', id: 'toolu_01X', name: 'ask_architect' }])
    assert.deepEqual(events.filter((e) => e.type === 'tool-call'), [{ type: 'tool-call', id: 'toolu_01X', name: 'ask_architect', input: CARD_INPUT }])
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 120, outputTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_use' })
  })

  test(`OpenAI Chat Completions: text and token usage from a recorded stream (${split})`, () => {
    const events = parse('openai', fixture('openai-text.sse'), chunkSize)
    assert.equal(text(events), 'Hello, architect.')
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 31, outputTokens: 6, cacheReadTokens: 8, cacheWriteTokens: 0 })
    assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'stop' })
  })

  test(`OpenAI Chat Completions: a tool call split across chunks arrives whole (${split})`, () => {
    for (const type of ['openai', 'openrouter', 'custom']) {
      const events = parse(type, fixture('openai-tool-call.sse'), chunkSize)
      const types = events.map((e) => e.type)
      assert.ok(types.indexOf('tool-start') < types.indexOf('tool-call'), type)
      assert.deepEqual(events.filter((e) => e.type === 'tool-call'), [{ type: 'tool-call', id: 'call_abc', name: 'ask_architect', input: CARD_INPUT }], type)
      assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 140, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0 }, type)
      assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_calls' }, type)
    }
  })

  test(`Ollama sends a whole tool call in one chunk, and it is the same internal call (${split})`, () => {
    const events = parse('ollama', fixture('ollama-tool-call.sse'), chunkSize)
    const calls = events.filter((e) => e.type === 'tool-call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'ask_architect')
    assert.equal(calls[0].input.questions[0].recommended, 'Red')
  })
}

test('a tool call is announced as soon as it starts, before its arguments are complete', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', name: 'P' })
  const parser = createParser(provider)
  const sse = createSseReader()
  const stream = fixture('anthropic-tool-call.sse')
  const cutAt = stream.indexOf('"partial_json":"{\\"questions')
  const early = []
  for (const event of sse.push(stream.slice(0, cutAt))) early.push(...parser.feed(event))
  assert.deepEqual(early.filter((e) => e.type === 'tool-start').map((e) => e.name), ['ask_architect'])
  assert.equal(early.filter((e) => e.type === 'tool-call').length, 0, 'no card until the call is complete')
})

test('a stream cut off in the middle of a tool call drops it rather than half-using it', () => {
  const stream = fixture('anthropic-tool-call.sse')
  const cut = stream.slice(0, stream.indexOf('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}'))
  const events = parse('anthropic', cut)
  assert.equal(events.filter((e) => e.type === 'tool-call').length, 0)
  assert.equal(events.filter((e) => e.type === 'tool-start').length, 1)
})

test('arguments that are not JSON come through as a call with no input and the reason', () => {
  const stream =
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ask_architect","arguments":"{\\"questions\\": [oops"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
  const call = parse('openai', stream).find((e) => e.type === 'tool-call')
  assert.equal(call.input, null)
  assert.match(call.invalid, /not valid JSON/)
})

test('two tool calls in one OpenAI turn stay apart by index', () => {
  const stream = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } }, { index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
  ]
    .map((o) => `data: ${JSON.stringify(o)}\n\n`)
    .join('')
  const calls = parse('openai', stream).filter((e) => e.type === 'tool-call')
  assert.deepEqual(calls.map((c) => [c.id, c.name, c.input]), [['a', 'one', { x: 1 }], ['b', 'two', {}]])
})

test('an error inside a stream is thrown as the failure it stands for', () => {
  assert.throws(() => parse('anthropic', fixture('anthropic-error.sse')), (e) => e.code === 'rate-limited' && /Overloaded/.test(e.message))
  const quota = 'data: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}\n\n'
  assert.throws(() => parse('openai', quota), (e) => e.code === 'out-of-credit')
  const badKey = 'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\n\n'
  assert.throws(() => parse('anthropic', badKey), (e) => e.code === 'key-rejected')
})

test('the SSE reader handles CRLF, comments, multi-line data and a final event with no blank line', () => {
  const sse = createSseReader()
  assert.deepEqual(sse.push(': keepalive\r\n\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: tail'), [{ event: 'a', data: 'one\ntwo' }])
  assert.deepEqual(sse.end(), [{ event: '', data: 'tail' }])
})

test('an endpoint that ignores streaming and sends one JSON answer is read as the same events', () => {
  const anthropic = normaliseAiProvider({ type: 'anthropic' })
  const a = eventsFromCompleteResponse(anthropic, {
    content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'ask_architect', input: CARD_INPUT }],
    usage: { input_tokens: 5, output_tokens: 7 },
    stop_reason: 'tool_use',
  })
  assert.equal(text(a), 'Hi')
  assert.deepEqual(a.find((e) => e.type === 'tool-call').input, CARD_INPUT)
  assert.equal(a.find((e) => e.type === 'usage').outputTokens, 7)
  const openai = normaliseAiProvider({ type: 'custom' })
  const o = eventsFromCompleteResponse(openai, {
    choices: [{ message: { content: 'Hi', tool_calls: [{ id: 'c1', function: { name: 'ask_architect', arguments: JSON.stringify(CARD_INPUT) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  })
  assert.deepEqual(o.find((e) => e.type === 'tool-call').input, CARD_INPUT)
  assert.equal(o.find((e) => e.type === 'usage').inputTokens, 3)
})

// ---------- requests ----------

const TOOL = { name: 'ask_architect', description: 'Ask.', parameters: { type: 'object', properties: {} } }
const HISTORY = [
  { role: 'user', text: 'Start', images: [{ mediaType: 'image/png', data: 'AAAA' }] },
  { role: 'assistant', text: 'Asking.', toolCalls: [{ id: 'c1', name: 'ask_architect', input: { questions: [] } }] },
  { role: 'tool', toolCallId: 'c1', name: 'ask_architect', content: 'Cost', isError: false },
  { role: 'user', text: 'And one more thing' },
]

test('Anthropic request: Messages API, the tool offered with tool_choice auto, tool results folded into the user turn', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com/v1/', key: 'k', model: 'claude-x', temperature: 0.2, maxTokens: 999, advanced: { topK: 5, stop: ['END'] } })
  const req = buildChatRequest(provider, { system: 'Be brief.', messages: HISTORY, tools: [TOOL] })
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages')
  assert.deepEqual(req.headers, { 'Content-Type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
  assert.equal(req.body.stream, true)
  assert.equal(req.body.model, 'claude-x')
  assert.equal(req.body.max_tokens, 999)
  assert.equal(req.body.system, 'Be brief.')
  assert.deepEqual(req.body.tool_choice, { type: 'auto' })
  assert.deepEqual(req.body.tools, [{ name: 'ask_architect', description: 'Ask.', input_schema: TOOL.parameters }])
  assert.equal(req.body.temperature, 0.2)
  assert.equal(req.body.top_k, 5)
  assert.deepEqual(req.body.stop_sequences, ['END'])
  assert.deepEqual(req.body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
  assert.deepEqual(req.body.messages[1].content.map((b) => b.type), ['text', 'tool_use'])
  assert.deepEqual(req.body.messages.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(req.body.messages[2].content.map((b) => b.type), ['tool_result', 'text'], 'the result and the next message share one user turn')
  assert.equal(req.body.messages[2].content[0].tool_use_id, 'c1')
})

test('Anthropic request: an error result is marked as one, and no tools means no tool_choice', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'm' })
  const req = buildChatRequest(provider, { messages: [{ role: 'user', text: 'x' }, { role: 'assistant', toolCalls: [{ id: 'c', name: 't', input: {} }] }, { role: 'tool', toolCallId: 'c', content: 'bad', isError: true }] })
  assert.equal(req.body.tool_choice, undefined)
  assert.equal(req.body.tools, undefined)
  assert.equal(req.body.messages[2].content[0].is_error, true)
  assert.equal(req.body.max_tokens, 4096, 'Anthropic needs a max_tokens, so a default applies')
})

test('OpenAI request: Chat Completions with tool_choice auto, streamed usage and tool results as tool messages', () => {
  const provider = normaliseAiProvider({ type: 'openai', address: 'https://api.openai.com/v1', key: 'sk-1', model: 'gpt-x', temperature: 0.3, maxTokens: 500, advanced: { topP: 0.9, topK: 40, minP: 0.1, stop: ['END'] } })
  const req = buildChatRequest(provider, { system: 'Be brief.', messages: HISTORY, tools: [TOOL] })
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions')
  assert.deepEqual(req.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer sk-1' })
  assert.equal(req.body.stream, true)
  assert.deepEqual(req.body.stream_options, { include_usage: true })
  assert.equal(req.body.tool_choice, 'auto')
  assert.deepEqual(req.body.tools, [{ type: 'function', function: { name: 'ask_architect', description: 'Ask.', parameters: TOOL.parameters } }])
  assert.equal(req.body.max_completion_tokens, 500)
  assert.equal(req.body.max_tokens, undefined)
  assert.equal(req.body.top_k, undefined, 'the official API rejects top_k and min_p')
  assert.equal(req.body.min_p, undefined)
  assert.equal(req.body.provider, undefined)
  assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user'])
  assert.equal(req.body.messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA')
  assert.equal(req.body.messages[2].tool_calls[0].function.arguments, '{"questions":[]}')
  assert.deepEqual(req.body.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'Cost' })
})

test('OpenRouter is sent require_parameters so tools are not silently dropped', () => {
  const provider = normaliseAiProvider({ type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k', model: 'x/y', advanced: { topK: 40, reasoningEffort: 'high' } })
  const withTools = buildChatRequest(provider, { messages: [{ role: 'user', text: 'x' }], tools: [TOOL] })
  assert.deepEqual(withTools.body.provider, { require_parameters: true })
  assert.deepEqual(withTools.body.reasoning, { effort: 'high' })
  assert.equal(withTools.body.top_k, 40)
  assert.equal(buildChatRequest(provider, { messages: [{ role: 'user', text: 'x' }] }).body.provider, undefined)
})

test('Ollama, LM Studio and custom endpoints use the OpenAI-compatible adapter at their own /v1 path', () => {
  const msgs = [{ role: 'user', text: 'x' }]
  const url = (type, address) => buildChatRequest(normaliseAiProvider({ type, address, model: 'm' }), { messages: msgs }).url
  assert.equal(url('ollama', 'http://localhost:11434'), 'http://localhost:11434/v1/chat/completions')
  assert.equal(url('ollama', 'http://localhost:11434/v1/'), 'http://localhost:11434/v1/chat/completions')
  assert.equal(url('lmstudio', 'http://localhost:1234/v1'), 'http://localhost:1234/v1/chat/completions')
  assert.equal(url('custom', 'https://llm.example.com/v1/'), 'https://llm.example.com/v1/chat/completions')
  const local = buildChatRequest(normaliseAiProvider({ type: 'ollama', address: 'http://localhost:11434', model: 'm' }), { messages: msgs })
  assert.equal(local.headers.Authorization, undefined, 'a local model needs no key')
})

test('the Responses API is never used: the OpenAI type always posts to chat/completions', () => {
  const req = buildChatRequest(normaliseAiProvider({ type: 'openai', address: 'https://api.openai.com/v1', key: 'k', model: 'gpt-6' }), { messages: [{ role: 'user', text: 'x' }] })
  assert.match(req.url, /\/chat\/completions$/)
  assert.ok(!('input' in req.body))
})

test('an OpenAI reasoning model is not sent a temperature', () => {
  const provider = normaliseAiProvider({ type: 'openai', address: 'https://api.openai.com/v1', key: 'k', model: 'o', temperature: 0.3, advanced: { reasoningEffort: 'medium' } })
  const req = buildChatRequest(provider, { messages: [{ role: 'user', text: 'x' }] })
  assert.equal(req.body.temperature, undefined)
  assert.equal(req.body.reasoning_effort, 'medium')
})

// ---------- #294: prompt caching is always on, for one hour ----------

const STABLE = '## 1. Rules\n\nStable brief. Source documents follow here.'
const SYSTEM = `${STABLE}\n\n## 9. Decisions log so far\n\nNothing yet.`

test('#294 Anthropic request: a one-hour cache point sits after the stable part of the system text, which holds the Source documents', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-x' })
  const req = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'x' }] })
  assert.deepEqual(req.body.system, [
    { type: 'text', text: STABLE, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: '\n\n## 9. Decisions log so far\n\nNothing yet.' },
  ])
  assert.equal(req.body.system.map((b) => b.text).join(''), SYSTEM, 'nothing is lost or reordered by the split')
})

test('#294 Anthropic request: no stable part means a plain system string, and a system that is all stable has one block', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-x' })
  assert.equal(buildChatRequest(provider, { system: 'Be brief.', messages: [{ role: 'user', text: 'x' }] }).body.system, 'Be brief.')
  assert.equal(buildChatRequest(provider, { system: 'Be brief.', cachePrefix: 'Something else', messages: [{ role: 'user', text: 'x' }] }).body.system, 'Be brief.')
  assert.deepEqual(buildChatRequest(provider, { system: STABLE, cachePrefix: STABLE, messages: [{ role: 'user', text: 'x' }] }).body.system, [{ type: 'text', text: STABLE, cache_control: { type: 'ephemeral', ttl: '1h' } }])
})

test('#294 Anthropic request: originals attached to the first message are behind a cache point too', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-x' })
  const withPdf = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'Start', documents: [{ mediaType: 'application/pdf', filename: 'a.pdf', data: 'AAAA' }] }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'More' }] })
  const first = withPdf.body.messages[0].content
  assert.deepEqual(first.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(first.filter((b) => b.cache_control).length, 1)
  assert.deepEqual(withPdf.body.messages[1].content, [{ type: 'text', text: 'ok' }], 'a message between the first and the last carries no cache point')
  const plain = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'More' }] })
  assert.equal(plain.body.messages[0].content, 'Start', 'nothing attached, nothing marked')
})

// ---------- #328: the conversation is cached too ----------

/** Every cache point in an Anthropic request body: the system blocks, then each message's blocks. */
const cachePoints = (body) => [...(Array.isArray(body.system) ? body.system : []), ...body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))].filter((b) => b.cache_control)

test('#328 Anthropic request: the last message carries a moving one-hour cache point, so the conversation so far is read from cache on the next call', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-x' })
  const messages = [
    { role: 'user', text: 'Start' },
    { role: 'assistant', text: 'Reading.', toolCalls: [{ id: 'r1', name: 'read_repository_file', input: { id: 'api', path: 'a.ts' } }] },
    { role: 'tool', toolCallId: 'r1', name: 'read_repository_file', content: 'export const A = 1' },
  ]
  const req = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages })
  assert.deepEqual(req.body.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'r1', content: 'export const A = 1', cache_control: { type: 'ephemeral', ttl: '1h' } }])
  assert.equal(req.body.messages[1].content.some((b) => b.cache_control), false, 'only the last message moves')

  const answered = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [...messages.slice(0, 2), { role: 'user', text: 'A is 1.' }] })
  assert.deepEqual(answered.body.messages.at(-1).content, [{ type: 'text', text: 'A is 1.', cache_control: { type: 'ephemeral', ttl: '1h' } }], 'a plain message becomes one block with the point on it')
})

test('#328 Anthropic request: never more than 4 cache points, the system, the originals and the moving one together', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-x' })
  const pdf = { mediaType: 'application/pdf', filename: 'a.pdf', data: 'AAAA' }
  const long = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'Start', documents: [pdf] }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'More' }] })
  assert.equal(cachePoints(long.body).length, 3)
  assert.ok(long.body.messages.at(-1).content.at(-1).cache_control)
  const one = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'Start', documents: [pdf] }] })
  assert.equal(cachePoints(one.body).length, 2, 'the first message is also the last: one point covers both')
  for (const body of [long.body, one.body]) assert.ok(cachePoints(body).length <= 4)
})

test('#328 a request that asks for no caching (a connection test, a merge) gets no moving cache point', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'claude-x' })
  const req = buildChatRequest(provider, { system: 'Be brief.', messages: [{ role: 'user', text: 'x' }] })
  assert.equal(req.body.messages[0].content, 'x')
  assert.ok(!JSON.stringify(req.body).includes('cache_control'))
})

test('#328 OpenRouter to an Anthropic model: the last message carries the moving cache point; other models and OpenAI-style Providers get nothing new', () => {
  const claude = normaliseAiProvider({ type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k', model: 'anthropic/claude-x' })
  const messages = [
    { role: 'user', text: 'Start' },
    { role: 'assistant', toolCalls: [{ id: 'r1', name: 'read_repository_file', input: { id: 'api', path: 'a.ts' } }] },
    { role: 'tool', toolCallId: 'r1', name: 'read_repository_file', content: 'export const A = 1' },
  ]
  const req = buildChatRequest(claude, { system: SYSTEM, cachePrefix: STABLE, messages })
  assert.deepEqual(req.body.messages.at(-1), { role: 'tool', tool_call_id: 'r1', content: [{ type: 'text', text: 'export const A = 1', cache_control: { type: 'ephemeral', ttl: '1h' } }] })
  assert.equal(JSON.stringify(req.body).match(/cache_control/g).length, 2, 'the system and the last message')
  const user = buildChatRequest(claude, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'x' }] })
  assert.deepEqual(user.body.messages.at(-1).content, [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }])
  for (const provider of [
    normaliseAiProvider({ type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k', model: 'meta/llama' }),
    normaliseAiProvider({ type: 'openai', address: 'https://api.openai.com/v1', key: 'k', model: 'gpt-x' }),
    normaliseAiProvider({ type: 'ollama', address: 'http://localhost:11434', model: 'llama' }),
  ]) {
    const plain = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages })
    assert.ok(!JSON.stringify(plain.body).includes('cache_control'), provider.type)
    assert.equal(plain.body.messages.at(-1).content, 'export const A = 1', provider.type)
  }
})

test('#294 OpenAI-style requests are left as they are: the order of the prompt is what lets the AI Provider cache it', () => {
  for (const type of ['openai', 'ollama', 'lmstudio', 'custom']) {
    const provider = normaliseAiProvider({ type, address: 'http://localhost:1234', key: 'k', model: 'm' })
    const req = buildChatRequest(provider, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'x' }] })
    assert.deepEqual(req.body.messages[0], { role: 'system', content: SYSTEM }, type)
    assert.ok(!JSON.stringify(req.body).includes('cache_control'), type)
  }
})

test('#294 OpenRouter: a cache point for the Anthropic models it routes to, nothing for the others', () => {
  const claude = normaliseAiProvider({ type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k', model: 'anthropic/claude-x' })
  const req = buildChatRequest(claude, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'x' }] })
  assert.deepEqual(req.body.messages[0].content[0], { type: 'text', text: STABLE, cache_control: { type: 'ephemeral', ttl: '1h' } })
  const other = normaliseAiProvider({ type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k', model: 'meta/llama' })
  assert.equal(buildChatRequest(other, { system: SYSTEM, cachePrefix: STABLE, messages: [{ role: 'user', text: 'x' }] }).body.messages[0].content, SYSTEM)
})

test('#294 a complete (non-streamed) Anthropic answer counts all the input, cached or not', () => {
  const provider = normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'm' })
  const events = eventsFromCompleteResponse(provider, { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 7, cache_read_input_tokens: 90, cache_creation_input_tokens: 3, output_tokens: 4 } })
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 100, outputTokens: 4, cacheReadTokens: 90, cacheWriteTokens: 3 })
})
