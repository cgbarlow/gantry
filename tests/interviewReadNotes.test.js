import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'
import { cacheBlocks, createAnthropicCache } from './helpers/anthropicCache.js'

// #328 (docs/adr/0073): an AI interview call costs less. The conversation is cached (a moving cache point on the last message, see
// tests/aiAdapters.test.js), and once a read is more than three AI turns old its text is replaced, in batches worth about 20k tokens, by a
// one-line note naming what was read. A fake `fetch` plays the AI Provider and a fake reader the Gantry server; the tests look at what the
// AI Provider is sent.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, shortenOldReads, READ_NOTE_AFTER_TURNS, READ_NOTE_MIN_SAVING } = await import('../web/lib/interviewSession.js')
const { readNote, runReadCall, runRepositoryCall } = await import('../web/lib/interviewSources.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))
const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'

const definition = () => ({
  id: 'soap',
  stages: [{ id: 'soap', title: 'SOAP', purpose: 'Describe the system as it is.', gate: 'described', modules: ['soap'] }],
  artefacts: [{ id: 'soap', title: 'SOAP', gate: 'described', requires: ['soap.subjective'] }],
  modules: [{ id: 'soap', title: 'SOAP', fields: ['subjective', 'objective', 'assessment', 'plan'].map((id) => ({ id, title: id[0].toUpperCase() + id.slice(1), type: 'markdown' })) }],
})
const savedNothing = () => [{ id: 'soap', status: 'draft', fields: ['subjective', 'objective', 'assessment', 'plan'].map((id) => ({ id, value: '' })) }]

const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
function anthropicReply({ text, tools = [], usage = {} }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1, ...usage } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}
const openAiReply = (text) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    const raw = envelope.body ? JSON.parse(envelope.body) : null
    calls.push({ raw, body: withFlatSystem(raw) })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

/** Text of about `chars` characters that says where it came from. */
const filler = (label, chars) => `${label}: ${'lorem ipsum dolor '.repeat(Math.ceil(chars / 18))}`.slice(0, chars)

// The Gantry server: a file is as long as `sizes` says, and a search finds as many lines as it takes to fill `searchSizes`.
function fakeServer({ sizes = {}, searchSizes = {} } = {}) {
  const reader = () => ({
    list: async ({ path }) => ({ commit: HEAD, path: path ?? '', entries: [{ path: 'src', isFolder: true }] }),
    search: async ({ query }) => ({
      commit: HEAD,
      query,
      matches: Array.from({ length: Math.ceil((searchSizes[query] ?? 200) / 60) }, (_, i) => ({ path: `src/file${i}.ts`, line: i + 1, text: filler(query, 40) })),
      filesSearched: 40,
      truncated: false,
    }),
    read: async ({ path }) => ({ commit: HEAD, path, text: filler(path, sizes[path] ?? 200) }),
  })
  return { reader }
}

function anthropic(contextWindow) {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', contextWindow })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

const repository = { id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository: { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' } }
const brief = (chars) => ({ id: 'brief', title: 'Client brief', filename: 'brief.md', size: chars, text: filler('brief', chars) })

function sessionWith(ai, { provider, sources, server }) {
  const context = { definition: definition(), stageId: 'soap', artefactId: 'soap', size: 'medium', saved: savedNothing(), sources, skills, readRepository: server.reader }
  return createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl })
}

/** The text of every tool result in an Anthropic request, by tool call id. */
const resultsById = (raw) => new Map(raw.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => [b.tool_use_id, b.content]))

// ---------- the note ----------

test('the note names the document, file or search, the commit if any, and how long it was', async () => {
  const doc = brief(50000)
  const read = runReadCall({ id: 'brief', range: 'pages 3-5' }, { lookup: () => ({ ...doc, text: '## Page 3\n\nOne\n\n## Page 4\n\nTwo\n\n## Page 5\n\nThree' }), access: { how: 'text' } })
  assert.equal(readNote(read.label), '[Read earlier: Client brief pages 3–5, 48 characters. Read it again if you need it.]')
  const whole = runReadCall({ id: 'brief', range: '0-40000' }, { lookup: () => doc, access: { how: 'text' } })
  assert.equal(readNote(whole.label), '[Read earlier: Client brief characters 0–40,000 (the first 30,000 characters), 30,000 characters. Read it again if you need it.]')

  const server = fakeServer({ sizes: { 'src/orders.ts': 1200, 'src/big.ts': 45000 }, searchSizes: { MAX_ORDER: 600 } })
  const lookup = () => repository
  const file = await runRepositoryCall('read_repository_file', { id: 'billing-api', path: 'src/orders.ts' }, { lookup, reader: server.reader })
  assert.equal(readNote(file.label), `[Read earlier: Billing API src/orders.ts at ${HEAD}, 1,200 characters. Read it again if you need it.]`)
  const big = await runRepositoryCall('read_repository_file', { id: 'billing-api', path: 'src/big.ts' }, { lookup, reader: server.reader })
  assert.equal(readNote(big.label), `[Read earlier: Billing API src/big.ts (characters 0–30,000) at ${HEAD}, ${big.read.chars.toLocaleString('en-US')} characters. Read it again if you need it.]`, 'a part of a file says which part')
  const search = await runRepositoryCall('search_repository', { id: 'billing-api', query: 'MAX_ORDER', path: 'src' }, { lookup, reader: server.reader })
  assert.equal(readNote(search.label), `[Read earlier: Billing API search "MAX_ORDER" under src at ${HEAD}, ${search.content.length.toLocaleString('en-US')} characters. Read it again if you need it.]`)
  const listing = await runRepositoryCall('list_repository_folder', { id: 'billing-api' }, { lookup, reader: server.reader })
  assert.equal(listing.label, undefined, 'a folder listing is not a read of anything')
})

// ---------- shortenOldReads, on its own ----------

const label = (where, chars) => ({ title: 'Billing API', where, commit: HEAD, chars })
const readMessage = (id, chars) => ({ role: 'tool', toolCallId: id, name: 'read_repository_file', content: filler(id, chars), reads: [{ at: 0, length: chars, label: label(id, chars) }] })
const reply = (id) => ({ role: 'assistant', text: 'Reading.', toolCalls: [{ id, name: 'read_repository_file', input: {} }] })
const history = (...ages) => {
  // One read per call, `age` AI replies ago, each big enough to clear the batch threshold on its own.
  const out = [{ role: 'user', text: 'Begin.' }]
  for (let i = 0; i < Math.max(...ages) + 1; i++) {
    out.push(reply(`r${i}`))
    if (ages.includes(Math.max(...ages) - i)) out.push(readMessage(`r${i}`, 100000))
  }
  return out
}

test('a read more than three AI turns old is replaced by its note; a newer one is not', () => {
  assert.equal(READ_NOTE_AFTER_TURNS, 3)
  const messages = history(4, 3, 0)
  const shortened = shortenOldReads(messages)
  const byId = new Map(shortened.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]))
  // The read 4 replies ago is old; 3 ago is not yet; the one from the current turn never is.
  assert.equal(byId.get('r0').content, readNote(label('r0', 100000)))
  assert.equal(byId.get('r0').reads, undefined, 'once shortened, a read is not shortened again')
  assert.equal(byId.get('r1').content.length, 100000)
  assert.equal(byId.get('r4').content.length, 100000)
  assert.deepEqual(shortened.filter((m) => m.role !== 'tool'), messages.filter((m) => m.role !== 'tool'), 'nothing else changes')
  assert.equal(shortenOldReads(shortened), shortened, 'nothing more to do is the same history back')
})

test('nothing is shortened until the old reads would save about 20k tokens, and then all of them go at once', () => {
  assert.equal(READ_NOTE_MIN_SAVING, 20000)
  const small = [{ role: 'user', text: 'Begin.' }, reply('a'), readMessage('a', 30000), reply('b'), readMessage('b', 30000), reply('c'), reply('d'), reply('e'), reply('f')]
  assert.equal(shortenOldReads(small), small, 'two old reads of 30,000 characters save about 15k tokens: not worth breaking the cache for')
  const enough = [...small.slice(0, 5), reply('g'), readMessage('g', 30000), reply('c'), reply('d'), reply('e'), reply('f')]
  const shortened = shortenOldReads(enough)
  assert.deepEqual(shortened.filter((m) => m.role === 'tool').map((m) => m.content.startsWith('[Read earlier:')), [true, true, true], 'three of them save about 22k tokens: all three go')
})

test('reads inside one message from Gantry are each replaced in place, and the rest of the message is kept', () => {
  const first = filler('first', 50000)
  const second = filler('second', 50000)
  const text = `Gantry's reply to your read requests:\n\n${first}\n\n${second}\n\nGantry's check of your drafts:\n- Fine.`
  const message = { role: 'user', fromGantry: true, text, reads: [{ at: 39, length: first.length, label: label('a.ts', 50000) }, { at: 39 + first.length + 2, length: second.length, label: label('b.ts', 50000) }] }
  const [, shortened] = shortenOldReads([{ role: 'user', text: 'Begin.' }, message, reply('a'), reply('b'), reply('c'), reply('d')])
  assert.equal(shortened.text, `Gantry's reply to your read requests:\n\n${readNote(label('a.ts', 50000))}\n\n${readNote(label('b.ts', 50000))}\n\nGantry's check of your drafts:\n- Fine.`)
})

// ---------- in a session ----------

// Call 0 reads an uploaded document, a repository file and a search; calls 1 to 5 each list a folder (small, never shortened) and call 3
// reads one more file. The first reads are first sent in call 1, so by call 5 four of the AI's replies have come after them.
function readingSession({ sizes, searchSizes, docChars }) {
  const server = fakeServer({ sizes, searchSizes })
  const ai = fakeAi((_request, n) => {
    if (n === 0) {
      return anthropicReply({
        text: 'Reading.',
        tools: [
          { id: 'doc', name: 'read_source_document', input: { id: 'brief', range: '0-30000' } },
          { id: 'file', name: 'read_repository_file', input: { id: 'billing-api', path: 'src/orders.ts' } },
          { id: 'search', name: 'search_repository', input: { id: 'billing-api', query: 'MAX_ORDER' } },
        ],
      })
    }
    if (n === 3) return anthropicReply({ tools: [{ id: 'later', name: 'read_repository_file', input: { id: 'billing-api', path: 'src/later.ts' } }] })
    if (n <= 5) return anthropicReply({ tools: [{ id: `list${n}`, name: 'list_repository_folder', input: { id: 'billing-api' } }] })
    if (n === 6) return anthropicReply({ tools: [{ id: 'd1', name: 'draft_field', input: { field: 'soap.subjective', value: 'Orders are capped.' } }] })
    return anthropicReply({ text: 'Drafted.' })
  })
  const session = sessionWith(ai, { provider: anthropic(40000), sources: [brief(docChars), repository], server })
  return { ai, session }
}

test('in a session, an uploaded document read, a repository file read and a search are each shortened once old, and a newer read is not', async () => {
  const { ai, session } = readingSession({ sizes: { 'src/orders.ts': 30000, 'src/later.ts': 30000 }, searchSizes: { MAX_ORDER: 30000 }, docChars: 100000 })
  await session.start()
  assert.equal(ai.calls.length, 8)
  const full = resultsById(ai.calls[4].raw)
  for (const id of ['doc', 'file', 'search']) assert.ok(full.get(id).length >= 30000, `${id}: three AI replies later it is still there in full`)

  const later = resultsById(ai.calls[5].raw)
  assert.equal(later.get('doc'), '[Read earlier: Client brief characters 0–30,000, 30,000 characters. Read it again if you need it.]')
  assert.equal(later.get('file'), `[Read earlier: Billing API src/orders.ts at ${HEAD}, 30,000 characters. Read it again if you need it.]`)
  assert.match(later.get('search'), new RegExp(`^\\[Read earlier: Billing API search "MAX_ORDER" at ${HEAD}, [\\d,]+ characters\\. Read it again if you need it\\.\\]$`))
  assert.ok(later.get('later').length >= 30000, 'the read made two calls ago is kept')
  assert.match(later.get('list1'), /src\//, 'a folder listing is kept as it was')
  assert.deepEqual(resultsById(ai.calls[7].raw).get('doc'), later.get('doc'), 'shortened once, it stays the same, so the cache holds')

  // What was read is still recorded as it was read: the thread's lines and the draft's inputs.
  const snap = session.snapshot()
  assert.deepEqual(snap.thread.filter((t) => t.read).map((t) => t.text), ['Read Client brief (characters 0–30,000)', 'Read Billing API (src/orders.ts at c0ffee1)', 'Read Billing API (src/later.ts at c0ffee1)'])
  assert.deepEqual(snap.drafts['soap.subjective'].inputs.map((i) => [i.source, i.range]), [['brief', 'characters 0–30,000'], ['billing-api', 'src/orders.ts'], ['billing-api', 'src/later.ts']])
})

test('in a session, reads that would save less than the batch threshold are never shortened', async () => {
  const { ai, session } = readingSession({ sizes: { 'src/orders.ts': 4000, 'src/later.ts': 4000 }, searchSizes: { MAX_ORDER: 4000 }, docChars: 100000 })
  await session.start()
  const last = resultsById(ai.calls.at(-1).raw)
  assert.ok(![...last.values()].some((text) => text.startsWith('[Read earlier:')))
  assert.ok(last.get('file').length >= 4000)
})

test('a model without tools has its old read replies shortened in place too', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small', contextWindow: 40000 })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'text', readsImages: false, steps: [], message: 'ok' }, null)
  const block = (json) => '```gantry-read\n' + JSON.stringify(json) + '\n```'
  const ai = fakeAi((_request, n) => {
    if (n === 0) return openAiReply(`Reading.\n\n${block([{ id: 'brief', range: '0-30000' }, { id: 'billing-api', path: 'src/orders.ts' }, { id: 'billing-api', search: 'MAX_ORDER' }])}`)
    if (n <= 5) return openAiReply(`More.\n\n${block({ id: 'billing-api', list: '' })}`)
    return openAiReply('Done.')
  })
  const server = fakeServer({ sizes: { 'src/orders.ts': 30000 }, searchSizes: { MAX_ORDER: 30000 } })
  const session = sessionWith(ai, { provider: p, sources: [brief(100000), repository], server })
  await session.start()
  const replyText = (n) => ai.calls[n].body.messages.find((m) => m.role === 'user' && m.content.startsWith("Gantry's reply to your read requests:") && m.content.includes('Client brief')).content
  assert.ok(replyText(4).length > 90000, 'three AI replies later the reads are still there')
  const shortened = replyText(5)
  assert.equal(shortened.match(/\[Read earlier:/g).length, 3)
  assert.match(shortened, /^Gantry's reply to your read requests:\n\n\[Read earlier: Client brief characters 0–30,000, 30,000 characters\. Read it again if you need it\.\]\n\n\[Read earlier: Billing API src\/orders\.ts at c0ffee/)
  assert.ok(shortened.length < 1000)
})

// ---------- a long interview costs at least half as much uncached input ----------
// The interview is tests/fixtures/long-interview.json, a reconstruction of a long SOAP interview (no real one was recorded). Each answer of
// the fake Anthropic AI Provider reports the usage the real one would, worked out by tests/helpers/anthropicCache.js from Anthropic's
// published caching rules (its 20-position lookback included), and the saving is read back from the session's own token count: the
// numbers the Tokens hover shows. "Before" is the same requests as Gantry sent them before #328, put through a cache of their own.

/** The same requests as Gantry sent them before #328: every read in full, and no cache point in the conversation. */
function asBefore(requests) {
  const full = new Map()
  return requests.map((raw) => {
    const copy = structuredClone(raw)
    for (const m of copy.messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          if (!full.has(b.tool_use_id)) full.set(b.tool_use_id, b.content)
          b.content = full.get(b.tool_use_id)
        }
        delete b.cache_control
      }
    }
    return copy
  })
}

/** `raw` without the bridge point: a cache point on the last message only, as before the lookback was handled. */
function withoutBridge(raw) {
  const copy = structuredClone(raw)
  for (const m of copy.messages.slice(0, -1)) if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control
  return copy
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/long-interview.json', import.meta.url), 'utf8'))

/** Plays the fixture through a session, every file read and search `scale` times as long (a document read is of the range it names); the AI Provider's usage comes from `cache`. */
async function replay({ scale = 1, cache = createAnthropicCache() } = {}) {
  const sizes = {}
  const searchSizes = {}
  const script = []
  let id = 0
  for (const exchange of fixture.exchanges) {
    for (const call of exchange.calls) {
      if (call.text) {
        script.push((usage) => anthropicReply({ text: call.text, usage }))
        continue
      }
      const tools = (call.reads ?? []).map(([kind, what, chars]) => {
        id++
        if (kind === 'file') {
          sizes[what] = Math.round(chars * scale)
          return { id: `t${id}`, name: 'read_repository_file', input: { id: fixture.repository.id, path: what } }
        }
        if (kind === 'search') {
          searchSizes[what] = Math.round(chars * scale)
          return { id: `t${id}`, name: 'search_repository', input: { id: fixture.repository.id, query: what } }
        }
        return { id: `t${id}`, name: 'read_source_document', input: { id: fixture.document.id, range: what } }
      })
      for (const field of call.drafts ?? []) tools.push({ id: `t${++id}`, name: 'draft_field', input: { field, value: `What the code shows for ${field}.` } })
      script.push((usage) => anthropicReply({ tools, usage }))
    }
  }
  const reported = []
  const ai = fakeAi((request, n) => {
    reported.push(cache.usage(request.raw))
    return script[n](reported.at(-1))
  })
  const server = fakeServer({ sizes, searchSizes })
  const session = sessionWith(ai, { provider: anthropic(40000), sources: [brief(fixture.document.chars), { ...repository, id: fixture.repository.id, title: fixture.repository.title }], server })
  await session.start()
  for (const exchange of fixture.exchanges.slice(1)) await session.send(exchange.architect)
  assert.equal(ai.calls.length, script.length, 'every call of the interview was made')
  return { requests: ai.calls.map((c) => c.raw), reported, usage: session.snapshot().usage }
}

/** The input of a run of requests not read from the cache, by what `cache` reports for each. */
const uncachedOf = (requests, cache) => requests.map((raw) => cache.usage(raw)).reduce((n, u) => n + u.input_tokens + u.cache_creation_input_tokens, 0)

for (const { scale, collapseToolRuns } of [
  { scale: 1, collapseToolRuns: false },
  { scale: 1, collapseToolRuns: true },
  { scale: 0.5, collapseToolRuns: false },
  { scale: 2, collapseToolRuns: false },
  { scale: 0.1, collapseToolRuns: false },
]) {
  const how = `${scale === 1 ? 'reads as recorded' : `every file read and search ${scale} times as long`}, ${collapseToolRuns ? 'a run of tool calls counted as one position (the Claude API)' : 'every block a position'}`
  test(`a long interview over a repository sends at least 50% fewer uncached input tokens than before, by the AI Provider's usage (${how})`, async (t) => {
    const { requests, reported, usage } = await replay({ scale, cache: createAnthropicCache({ collapseToolRuns }) })
    const sum = (key) => reported.reduce((n, u) => n + u[key], 0)
    assert.equal(usage.cacheReadTokens, sum('cache_read_input_tokens'), "the session's count is what the AI Provider reported")
    assert.equal(usage.inputTokens, sum('input_tokens') + sum('cache_read_input_tokens') + sum('cache_creation_input_tokens'))
    const after = usage.inputTokens - usage.cacheReadTokens
    const before = uncachedOf(asBefore(requests), createAnthropicCache({ collapseToolRuns }))
    t.diagnostic(`uncached input: ${before} tokens before, ${after} now (${Math.round((1 - after / before) * 100)}% fewer)`)
    assert.ok(after <= before * 0.5, `uncached input: ${before} tokens before, ${after} now`)
    const sent = (raw) => JSON.stringify(raw.messages).length
    assert.ok(sent(requests.at(-1)) < sent(asBefore(requests).at(-1)) / 2, 'the last call carries far less of the conversation too')
  })
}

test('after a burst of tool calls at once, the next call still reads the whole conversation so far from the cache', async () => {
  const { requests, reported } = await replay()
  const blocks = (raw) => cacheBlocks(raw).map((b) => b.text)
  const tokens = (raw) => Math.round(blocks(raw).join('').length / 4)
  // The calls that send the results of a burst (nine or more tool calls in the AI's last reply), and that change nothing before them.
  const afterBurst = requests
    .map((raw, n) => ({ raw, n }))
    .filter(({ raw, n }) => {
      const reply = raw.messages.findLast((m) => m.role === 'assistant')
      if (!reply || reply.content.filter((b) => b.type === 'tool_use').length < 9) return false
      const previous = blocks(requests[n - 1])
      return blocks(raw).slice(0, previous.length).every((text, i) => text === previous[i])
    })
  assert.ok(afterBurst.length >= 2, `the interview has bursts to test (${afterBurst.length})`)
  const stripped = createAnthropicCache()
  const unbridged = requests.map((raw) => stripped.usage(withoutBridge(raw)))
  let beyondReach = 0
  for (const { raw, n } of afterBurst) {
    assert.ok(reported[n].cache_read_input_tokens >= tokens(requests[n - 1]) - 1, `call ${n} reads everything the previous call sent (${reported[n].cache_read_input_tokens} of ${tokens(requests[n - 1])} tokens)`)
    assert.ok(raw.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control).length + raw.system.filter((b) => b.cache_control).length <= 4)
    // Ten or more calls and their results are 20 blocks or more: without the bridge the moving point finds nothing within reach, and the
    // call reads only the system text from the cache. (Nine and their results are 18: just within reach, and bridged all the same.)
    if (raw.messages.findLast((m) => m.role === 'assistant').content.filter((b) => b.type === 'tool_use').length < 10) continue
    beyondReach++
    const head = Math.round(cacheBlocks(raw).filter((b) => b.type === 'head').reduce((c, b) => c + b.text.length, 0) / 4)
    assert.ok(unbridged[n].cache_read_input_tokens <= head, `without the bridge point, call ${n} would have read only the system text from the cache (${unbridged[n].cache_read_input_tokens} of ${head} tokens)`)
  }
  assert.ok(beyondReach >= 2, `the interview has bursts beyond the lookback (${beyondReach})`)
})
