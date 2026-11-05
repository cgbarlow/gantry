import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #341: the one status line at the bottom of the interview's thread. While the AI is busy the session says what is under way and since
// when (`waiting`, `writing`, `tool`, `drafting`, `preparing`, `compacting`, `preparingRepository`); `statusLine` turns that into the words
// the page shows, so it is never hidden while anything is still going on. A fake `fetch` plays the AI Provider through the relay; the AI
// Providers list is the real one, kept in a fake localStorage.
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
  map.delete('gantry:ai-refuses-sampling')
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))
const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'

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

const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
const sources = [
  { id: 'tech-lt', title: 'Tech LT deck', filename: 'deck.md', size: 40, text: '# Tech LT deck\n\nThe platform moves to managed hosting.' },
  { id: 'billing-api', title: 'billing-api', uploadedAt: '2026-11-01T00:00:00.000Z', repository },
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
const refusal = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` may only be set to 1 for this model.' } }), { status: 400, headers: { 'content-type': 'application/json' } })

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

const anthropic = (over = {}) => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', ...over })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

// A session whose every change is turned into the status line it would show, at a clock the test moves.
function sessionWith(ai, { provider = anthropic(), context: extra = {} } = {}) {
  const clock = { now: 1_000_000 }
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }] }], sources, skills, ...extra }
  const lines = []
  const session = createInterviewSession({
    providerId: provider.id,
    getContext: () => context,
    fetchImpl: ai.fetchImpl,
    clock: () => clock.now,
    onChange: (snap) => lines.push(statusLine(snap, clock.now)),
  })
  // The distinct lines in the order they were shown, idle (null) left out.
  const shown = () => lines.filter(Boolean).map((l) => l.text).filter((t, i, all) => t !== all[i - 1])
  return { session, clock, context, lines, shown }
}

// ---------- the words ----------

test('the status line names what is under way, the most specific thing first, and is empty when the AI is not busy', () => {
  const working = { phase: 'working', thread: [] }
  assert.equal(statusLine({ ...working, phase: 'waiting' }), null, 'nothing while the architect has the turn')
  assert.equal(statusLine({ ...working, phase: 'asking' }), null)
  assert.equal(statusLine({ ...working, phase: 'kickoff' }), null)
  assert.deepEqual(statusLine(working), { kind: 'working', text: 'Working…', detail: null, ticking: false })
  assert.deepEqual(statusLine({ ...working, waiting: { since: 0, without: null } }, 12_400), { kind: 'waiting', text: 'Waiting for the AI…', detail: '12 s', ticking: true })
  assert.deepEqual(statusLine({ ...working, waiting: { since: 0, without: 'temperature' } }, 3_000), { kind: 'retrying', text: 'Trying again without the temperature setting…', detail: '3 s', ticking: true })
  assert.equal(statusLine({ ...working, waiting: { since: 0, without: 'temperature and top_p' } }, 0).text, 'Trying again without the temperature and top_p settings…')
  assert.equal(statusLine({ ...working, writing: true }).text, 'Writing…')
  assert.equal(statusLine({ ...working, writing: true, preparing: true }).text, 'Preparing questions…')
  assert.equal(statusLine({ ...working, writing: true, drafting: true, draftingTitles: [] }).text, 'Drafting…')
  assert.equal(statusLine({ ...working, writing: true, drafting: true, draftingTitles: ['Problem statement'] }).text, 'Drafting Problem statement…')
  assert.equal(statusLine({ ...working, drafting: true, draftingTitles: ['Problem statement', 'Notes', 'Scope'] }).text, 'Drafting Problem statement, Notes and Scope…')
  assert.equal(statusLine({ ...working, tool: { kind: 'reading', title: 'Tech LT deck' } }).text, 'Reading Tech LT deck…')
  assert.equal(statusLine({ ...working, tool: { kind: 'reading', title: 'Tech LT deck', range: 'pages 3-5' } }).text, 'Reading Tech LT deck, pages 3-5…')
  assert.equal(statusLine({ ...working, tool: { kind: 'reading', title: 'billing-api', path: 'src/retry.ts' } }).text, 'Reading billing-api src/retry.ts…')
  assert.equal(statusLine({ ...working, tool: { kind: 'reading', title: null } }).text, 'Reading a Source document…')
  assert.equal(statusLine({ ...working, tool: { kind: 'searching', title: 'billing-api', query: 'retry' } }).text, 'Searching billing-api for "retry"…')
  assert.equal(statusLine({ ...working, tool: { kind: 'searching', title: null } }).text, 'Searching a code repository…')
  assert.equal(statusLine({ ...working, tool: { kind: 'finding', title: 'billing-api', pattern: '**/*.tf' } }).text, 'Finding files named "**/*.tf" in billing-api…')
  assert.equal(statusLine({ ...working, tool: { kind: 'listing', title: 'billing-api', path: 'src' } }).text, 'Listing billing-api src…')
  assert.equal(statusLine({ ...working, tool: { kind: 'listing', title: 'billing-api', path: '' } }).text, 'Listing billing-api…')
  assert.deepEqual(statusLine({ ...working, tool: { kind: 'searching', title: 'billing-api', query: 'retry' }, preparingRepository: { title: 'billing-api', receivedBytes: 12.4 * 1024 * 1024 } }), {
    kind: 'preparing-repository',
    text: 'Preparing billing-api…',
    detail: '12.4 MB',
    ticking: false,
  })
  assert.equal(statusLine({ ...working, preparingRepository: { title: 'billing-api', receivedBytes: 0 } }).detail, null)
  assert.equal(statusLine({ ...working, compacting: true, waiting: { since: 0 }, preparingRepository: { title: 'x', receivedBytes: 1 } }).text, 'Compacting the conversation…')
})

// ---------- a turn ----------

test('a turn shows Waiting for the AI with a count that goes up, then Writing, then the Field being drafted, and nothing once it ends', async () => {
  let resolveFirst
  const ai = fakeAi((_req, n) =>
    n === 0
      ? new Promise((resolve) => (resolveFirst = () => resolve(anthropicReply({ text: 'I\'ll draft what the Tech LT deck supports.', tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Move to managed hosting.' } }] }))))
      : anthropicReply({ text: 'Drafted.' })
  )
  const { session, clock, shown } = sessionWith(ai)
  const going = session.start()
  for (let i = 0; !resolveFirst && i < 2000; i++) await new Promise((r) => setTimeout(r, 1))
  assert.ok(resolveFirst, 'the request went to the AI')
  const waiting = session.snapshot()
  assert.equal(statusLine(waiting, clock.now).text, 'Waiting for the AI…')
  assert.equal(statusLine(waiting, clock.now).detail, '0 s')
  assert.equal(statusLine(waiting, clock.now + 12_000).detail, '12 s', 'the seconds count goes up while no byte has come')
  clock.now += 12_000
  resolveFirst()
  await going
  assert.deepEqual(shown(), ['Waiting for the AI…', 'Writing…', 'Drafting…', 'Drafting Details · Problem statement…', 'Writing…', 'Waiting for the AI…', 'Writing…'])
  assert.equal(statusLine(session.snapshot(), clock.now), null, 'the turn is over: nothing is shown')
  assert.equal(session.snapshot().waiting, null)
})

test('a model that refuses the temperature setting: the line says the call is going again without it', async () => {
  const provider = anthropic({ model: 'claude-no-sampling', temperature: 0.3 })
  const ai = fakeAi((req) => (req.body.temperature !== undefined ? refusal() : anthropicReply({ text: 'Hello.' })))
  const { session, shown } = sessionWith(ai, { provider })
  await session.start()
  assert.deepEqual(shown(), ['Waiting for the AI…', 'Trying again without the temperature setting…', 'Writing…'])
  assert.equal(ai.calls.length, 2)
  assert.equal(providers.getAiProvider(provider.id).temperature, 0.3, "the architect's setting stays")
})

test('reading a Source document names it while the AI asks for it, until the next request goes', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [{ id: 'r1', name: 'read_source_document', input: { id: 'tech-lt', range: 'pages 3-5' } }] }) : anthropicReply({ text: 'Read it.' })))
  const { session, shown } = sessionWith(ai)
  await session.start()
  assert.deepEqual(shown(), ['Waiting for the AI…', 'Reading a Source document…', 'Reading Tech LT deck, pages 3-5…', 'Waiting for the AI…', 'Writing…'])
})

test('searching and reading a code repository say what is searched or read while the call runs', async () => {
  const during = []
  let session
  const readRepository = () => ({
    search: async ({ query }) => {
      during.push(statusLine(session.snapshot()).text)
      return { commit: HEAD, query, matches: [], filesSearched: 3, truncated: false, totalMatches: 0, totalFiles: 0, page: 1, pageSize: 50, total: 0, pages: 0 }
    },
    read: async ({ path }) => {
      during.push(statusLine(session.snapshot()).text)
      return { commit: HEAD, path, text: 'export const RETRIES = 3\n' }
    },
  })
  const ai = fakeAi((_req, n) =>
    n === 0
      ? anthropicReply({ tools: [{ id: 's1', name: 'search_repository', input: { id: 'billing-api', query: 'retry' } }] })
      : n === 1
        ? anthropicReply({ tools: [{ id: 'f1', name: 'read_repository_file', input: { id: 'billing-api', path: 'src/retry.ts' } }] })
        : anthropicReply({ text: 'Done.' })
  )
  const made = sessionWith(ai, { context: { readRepository } })
  session = made.session
  await session.start()
  assert.deepEqual(during, ['Searching billing-api for "retry"…', 'Reading billing-api src/retry.ts…'])
  assert.ok(made.shown().includes('Searching billing-api for "retry"…'))
  assert.equal(statusLine(session.snapshot()), null)
})

test('while the repository is being prepared, the one line says so, with how far the download has got', async () => {
  const during = []
  let session
  const readRepository = (_entry, how) => ({
    search: async ({ query }) => {
      how.onPreparing({ receivedBytes: 12.4 * 1024 * 1024 })
      during.push(statusLine(session.snapshot()))
      return { commit: HEAD, query, matches: [], filesSearched: 3, truncated: false, totalMatches: 0, totalFiles: 0, page: 1, pageSize: 50, total: 0, pages: 0 }
    },
  })
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [{ id: 's1', name: 'search_repository', input: { id: 'billing-api', query: 'retry' } }] }) : anthropicReply({ text: 'Done.' })))
  session = sessionWith(ai, { context: { readRepository } }).session
  await session.start()
  assert.deepEqual(during, [{ kind: 'preparing-repository', text: 'Preparing billing-api…', detail: '12.4 MB', ticking: false }])
})

test('compacting shows on the same line', async () => {
  const ai = fakeAi((_req, n) => anthropicReply({ text: n === 1 ? 'Where we are: drafting the problem statement.' : 'Hello.' }))
  const { session, shown } = sessionWith(ai)
  await session.start()
  await session.compactNow()
  assert.ok(shown().includes('Compacting the conversation…'), shown().join(' | '))
})

// ---------- Start this stage over ----------

test('after Start this stage over, the next start is a fresh interview, not a resume of the decisions log', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
  const resume = { resuming: true, recap: 'Carrying on: 3 decisions so far', others: [] }
  const { session } = sessionWith(ai, { context: { resume } })
  await session.start()
  assert.ok(session.snapshot().thread.some((t) => t.resumed), 'the first start resumes')
  assert.equal(session.snapshot().startedOver, false)
  session.startOver()
  assert.equal(session.snapshot().phase, 'kickoff')
  assert.equal(session.snapshot().startedOver, true, 'the page reads this to label the kickoff Start interview')
  await session.start()
  assert.ok(!session.snapshot().thread.some((t) => t.resumed), 'no recap after a start over')
  assert.doesNotMatch(JSON.stringify(ai.calls.at(-1).body.messages[0]), /Resume the interview/)
})
