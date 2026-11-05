import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #319 (docs/adr/0072): in an AI interview the AI reads a code repository Source document with read-only tools (list a folder, search, read a
// file), answered by the Gantry server. Nothing of the repository is in the brief; every file read names the commit it saw, and a draft
// carries those reads as its inputs. A fake `fetch` plays the AI Provider; a fake reader plays the Gantry server.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, repositoryBlockedLine } = await import('../web/lib/interviewSession.js')
const { REPOSITORY_BLOCKED_CODES } = await import('../web/lib/interviewSources.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { repositoryReaderFor, REPOSITORY_NEEDS_SERVER, REPOSITORY_READ_CUT_OFF } = await import('../web/lib/sourceRepositoryClient.js')
const { SourceDocumentError } = await import('../web/lib/sourceDocuments.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))
const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'

const definition = () => ({
  id: 'small',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary'] }],
  modules: [{ id: 'details', title: 'Details', fields: [{ id: 'summary', title: 'Summary', type: 'markdown', required: true }] }],
})

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
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
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

// The Gantry server, as the session's context sees it: one reader per repository. It records what it was asked.
function fakeServer() {
  const asked = []
  const reader = (entry) => ({
    list: async ({ path }) => (asked.push(['list', entry.id, path ?? '']), { commit: HEAD, path: path ?? '', entries: [{ path: 'src', isFolder: true }, { path: 'README.md', isFolder: false }] }),
    search: async ({ query }) => (asked.push(['search', entry.id, query]), { commit: HEAD, query, matches: [{ path: 'src/orders/limits.ts', line: 1, text: 'export const MAX_ORDER_NZD = 5000' }], filesSearched: 3, truncated: false }),
    read: async ({ path }) => {
      asked.push(['read', entry.id, path])
      if (path.startsWith('node_modules/')) throw new Error(`${path} is vendored code or build output, which Gantry never reads.`)
      return { commit: HEAD, path, text: 'export const MAX_ORDER_NZD = 5000\n' }
    },
  })
  return { asked, reader }
}

const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}

test('the AI lists, searches and reads a repository through tools, skipped paths are refused, and its draft carries the file and commit it read', async () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  const cite = `[Billing API, src/orders/limits.ts](source:billing-api?path=src/orders/limits.ts&commit=${HEAD})`
  const ai = fakeAi((_request, n) => {
    if (n === 0) {
      return anthropicReply({
        text: 'Looking at the code.',
        tools: [
          { id: 'l1', name: 'list_repository_folder', input: { id: 'billing-api' } },
          { id: 's1', name: 'search_repository', input: { id: 'billing-api', query: 'MAX_ORDER' } },
          { id: 'r1', name: 'read_repository_file', input: { id: 'billing-api', path: 'src/orders/limits.ts' } },
          { id: 'r2', name: 'read_repository_file', input: { id: 'billing-api', path: 'node_modules/left-pad/index.js' } },
        ],
      })
    }
    if (n === 1) return anthropicReply({ tools: [{ id: 'd1', input: { field: 'details.summary', value: `Orders are capped at NZD 5,000 ${cite}.` } }] })
    return anthropicReply({ text: 'Drafted.' })
  })
  const server = fakeServer()
  const context = {
    definition: definition(),
    stageId: 'shape',
    artefactId: 'light',
    size: 'medium',
    saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }] }],
    sources: [{ id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository: { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' } }],
    skills,
    readRepository: server.reader,
  }
  const session = createInterviewSession({ providerId: p.id, getContext: () => context, fetchImpl: ai.fetchImpl })
  await session.start()

  const first = ai.calls[0].body
  assert.deepEqual(first.tools.map((t) => t.name), ['ask_architect', 'draft_field', 'log_decision', 'find_repository_files', 'search_repository', 'list_repository_folder', 'read_repository_file'])
  assert.match(first.system, /One Source document is a code repository, read live from its Provider at its branch\. Nothing of it is shown here\./)
  assert.doesNotMatch(first.system, /MAX_ORDER_NZD/, 'nothing from the repository is pasted into the prompt up front')

  assert.deepEqual(server.asked, [['list', 'billing-api', ''], ['search', 'billing-api', 'MAX_ORDER'], ['read', 'billing-api', 'src/orders/limits.ts'], ['read', 'billing-api', 'node_modules/left-pad/index.js']])
  const results = toolResults(ai.calls[1])
  assert.deepEqual(results.map((r) => [r.tool_use_id, Boolean(r.is_error)]), [['l1', false], ['s1', false], ['r1', false], ['r2', true]])
  assert.match(results[0].content, new RegExp(`commit ${HEAD}`))
  assert.match(results[2].content, /Cite it as \[Billing API, src\/orders\/limits\.ts\]/)
  assert.match(results[3].content, /vendored code or build output, which Gantry never reads/)

  const snap = session.snapshot()
  assert.deepEqual(snap.thread.filter((t) => t.read).map((t) => t.text), ['Read Billing API (src/orders/limits.ts at c0ffee1)'])
  assert.deepEqual(
    snap.drafts['details.summary'].inputs.map((i) => [i.source, i.path, i.commit]),
    [['billing-api', 'src/orders/limits.ts', HEAD]],
    'the read, once: the citation names the same file at the same commit'
  )
  assert.match(snap.drafts['details.summary'].value, /source:billing-api\?path=src\/orders\/limits\.ts&commit=c0ffee/)
})

test('an existing pointer this architect cannot read: the thread says so plainly, once, as well as the AI, and nothing is recorded as read', async () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  const refusal = "You can't read the GitHub repository acme/billing-api without a token. If it is private, give a token that can read it."
  const ai = fakeAi((_request, n) => {
    if (n === 0) {
      return anthropicReply({
        tools: [
          { id: 'l1', name: 'list_repository_folder', input: { id: 'billing-api' } },
          { id: 'r1', name: 'read_repository_file', input: { id: 'billing-api', path: 'src/orders/limits.ts' } },
        ],
      })
    }
    if (n === 1) return anthropicReply({ tools: [{ id: 'r2', name: 'read_repository_file', input: { id: 'billing-api', path: 'node_modules/x.js' } }] })
    return anthropicReply({ text: 'I could not read the repository.' })
  })
  // The Gantry server as a teammate (or another browser) without a token for this repository sees it: every read refused, with the server's sentence.
  const refuse = async () => Promise.reject(new SourceDocumentError(refusal, { code: 'no-access', status: 403 }))
  const refusing = { list: refuse, read: refuse, search: refuse }
  const skipping = { ...refusing, read: async ({ path }) => Promise.reject(new SourceDocumentError(`${path} is vendored code or build output, which Gantry never reads.`, { code: 'skipped', status: 400 })) }
  let calls = 0
  const context = {
    definition: definition(),
    stageId: 'shape',
    artefactId: 'light',
    size: 'medium',
    saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }] }],
    sources: [{ id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository: { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' } }],
    skills,
    readRepository: () => (calls++ < 2 ? refusing : skipping),
  }
  const session = createInterviewSession({ providerId: p.id, getContext: () => context, fetchImpl: ai.fetchImpl })
  await session.start()

  const results = toolResults(ai.calls[1])
  assert.deepEqual(results.map((r) => [r.tool_use_id, Boolean(r.is_error)]), [['l1', true], ['r1', true]])
  assert.match(results[0].content, /Billing API: You can't read the GitHub repository acme\/billing-api without a token/, 'the AI is told')
  const snap = session.snapshot()
  const blocked = snap.thread.filter((t) => t.repositoryBlocked)
  assert.equal(blocked.length, 1, 'the architect is told once, not once per attempt')
  assert.equal(blocked[0].who, 'sys')
  assert.equal(blocked[0].repositoryBlocked, 'billing-api')
  assert.match(blocked[0].text, /^Can't read the code repository Billing API: You can't read the GitHub repository acme\/billing-api without a token\./)
  assert.match(blocked[0].text, /Give a token that can read it with "Your token" on its row in the Source documents list/)
  assert.deepEqual(snap.thread.filter((t) => t.read), [], 'nothing was read, so nothing is recorded as read')
  assert.ok(!snap.thread.some((t) => /vendored/.test(t.text)), "a skipped path is the AI's to sort out, not the architect's")
})

// #325: a Provider's used-up rate limit reaches the thread as itself, with a token offered as the way to carry on now.
test('a used-up rate limit is told to the architect in the thread, with a token as the way to carry on now', () => {
  const line = repositoryBlockedLine({ title: 'gantry', code: 'rate-limited', message: 'GitHub limits how much this Gantry server can read without a token, and that limit is used up until 08:00 UTC.' })
  assert.match(line, /^Can't read the code repository gantry: GitHub limits how much this Gantry server can read without a token/)
  assert.match(line, /To carry on now, give a token with "Your token" on its row in the Source documents list\. The AI is told so and won't rely on it\.$/)
  assert.ok(REPOSITORY_BLOCKED_CODES.includes('rate-limited'), 'it is shown to the architect, not only to the AI')
})

// #336: a repository read that is cut off on its way from the Gantry server is asked once more; cut off twice, that read has failed, not
// the repository. It doesn't block the repository: the AI is told the read failed and may try it again, and its next read is still made.
describe('a repository read cut off on its way from the Gantry server', () => {
  const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const readOf = (path) => ({ commit: HEAD, path, text: 'export const MAX_ORDER_NZD = 5000\n' })

  // The Gantry server, behind `fetch`: `plan` says for each request, in turn, whether it is cut off ('cut'), a proxy gave up on it
  // ('gateway'), or is answered (anything else). Records each request's action and path.
  function server(plan) {
    const asked = []
    const fetchImpl = async (_url, init) => {
      const { action, path } = JSON.parse(init.body)
      const what = plan[asked.length] ?? 'answer'
      asked.push(`${action} ${path ?? ''}`.trim())
      if (what === 'cut') throw new TypeError('Failed to fetch')
      if (what === 'gateway') return new Response('<html>A timeout occurred</html>', { status: 524, headers: { 'content-type': 'text/html' } })
      if (what === 'no-access') return answer(403, { error: "You can't read the GitHub repository acme/billing-api without a token. If it is private, give a token that can read it.", code: 'no-access' })
      return answer(200, readOf(path))
    }
    return { asked, fetchImpl }
  }

  test('cut off once, it is asked again and the read succeeds; cut off by a proxy giving up, the same', async () => {
    for (const first of ['cut', 'gateway']) {
      const gantry = server([first])
      const reader = repositoryReaderFor(repository, { fetchImpl: gantry.fetchImpl, token: null, retryWaitMs: 0 })
      assert.equal((await reader.read({ path: 'src/orders/limits.ts' })).text, 'export const MAX_ORDER_NZD = 5000\n', first)
      assert.deepEqual(gantry.asked, ['read src/orders/limits.ts', 'read src/orders/limits.ts'])
    }
  })

  test('cut off twice after the server has answered, it says the read took too long or was cut off; with no server at all, that the server can\'t be reached', async () => {
    const gantry = server(['answer', 'cut', 'cut'])
    const reader = repositoryReaderFor(repository, { fetchImpl: gantry.fetchImpl, token: null, retryWaitMs: 0 })
    await reader.read({ path: 'README.md' })
    await assert.rejects(reader.read({ path: 'src/orders/limits.ts' }), (err) => err instanceof SourceDocumentError && err.code === 'cut-off' && err.message === REPOSITORY_READ_CUT_OFF)
    assert.match(REPOSITORY_READ_CUT_OFF, /took too long or was cut off/)
    assert.doesNotMatch(REPOSITORY_READ_CUT_OFF, /can't be reached/)

    const proxy = server(['gateway', 'gateway'])
    await assert.rejects(repositoryReaderFor(repository, { fetchImpl: proxy.fetchImpl, token: null, retryWaitMs: 0 }).read({ path: 'README.md' }), (err) => err.code === 'cut-off', 'a proxy answered, so something is there')

    // A Local Workspace with no Gantry server running: nothing has ever answered.
    const none = server(['cut', 'cut'])
    await assert.rejects(repositoryReaderFor(repository, { fetchImpl: none.fetchImpl, token: null, retryWaitMs: 0 }).read({ path: 'README.md' }), (err) => err.code === 'server-unreachable' && err.message === REPOSITORY_NEEDS_SERVER)
    assert.equal(none.asked.length, 2, 'asked once more before saying so')
  })

  function interview(fetchImpl, aiTools) {
    const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
    providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
    const ai = fakeAi((_request, n) => (aiTools[n] ? anthropicReply({ tools: aiTools[n] }) : anthropicReply({ text: 'Done.' })))
    const context = {
      definition: definition(),
      stageId: 'shape',
      artefactId: 'light',
      size: 'medium',
      saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }] }],
      sources: [{ id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository }],
      skills,
      readRepository: (entry) => repositoryReaderFor(entry.repository, { fetchImpl, token: null, retryWaitMs: 0 }),
    }
    return { ai, session: createInterviewSession({ providerId: p.id, getContext: () => context, fetchImpl: ai.fetchImpl }) }
  }
  const read = (id, path) => ({ id, name: 'read_repository_file', input: { id: 'billing-api', path } })

  test('in an interview: cut off once, the read succeeds and the thread shows nothing unusual', async () => {
    const gantry = server(['cut'])
    const { ai, session } = interview(gantry.fetchImpl, [[read('r1', 'src/orders/limits.ts')]])
    await session.start()
    assert.deepEqual(toolResults(ai.calls[1]).map((r) => Boolean(r.is_error)), [false])
    const snap = session.snapshot()
    assert.deepEqual(snap.thread.filter((t) => t.who === 'sys' && !/^Interview started/.test(t.text)).map((t) => t.text), ['Read Billing API (src/orders/limits.ts at c0ffee1)'])
  })

  test('in an interview: cut off twice, the AI is told that read failed and may try again, the repository is not blocked, and the next read is made and succeeds', async () => {
    const gantry = server(['answer', 'cut', 'cut'])
    const { ai, session } = interview(gantry.fetchImpl, [[read('r0', 'README.md'), read('r1', 'src/orders/limits.ts')], [read('r2', 'src/orders/limits.ts')]])
    await session.start()
    const failed = toolResults(ai.calls[1])
    assert.deepEqual(failed.map((r) => Boolean(r.is_error)), [false, true])
    assert.match(failed[1].content, /^Billing API: This read of the code repository took too long or was cut off/)
    assert.match(failed[1].content, /try it again, or something narrower/i)
    assert.doesNotMatch(failed[1].content, /won't rely|can't be reached/)
    assert.deepEqual(toolResults(ai.calls[2]).map((r) => Boolean(r.is_error)), [false], 'the next read of the same repository is made, and succeeds')
    assert.deepEqual(gantry.asked, ['read README.md', 'read src/orders/limits.ts', 'read src/orders/limits.ts', 'read src/orders/limits.ts'])

    const snap = session.snapshot()
    assert.deepEqual(snap.thread.filter((t) => t.repositoryBlocked), [], 'not blocked for the session')
    const line = snap.thread.find((t) => t.repositoryFailed)
    assert.equal(line.repositoryFailed, 'billing-api')
    assert.match(line.text, /^Couldn't read the code repository Billing API just now: This read of the code repository took too long or was cut off/)
    assert.doesNotMatch(line.text, /can't be reached|won't rely/)
  })

  test('in an interview: no access still blocks the repository; a Local Workspace with no server still says the server can\'t be reached', async () => {
    const refused = server(['no-access'])
    const one = interview(refused.fetchImpl, [[read('r1', 'src/orders/limits.ts')]])
    await one.session.start()
    assert.equal(one.session.snapshot().thread.filter((t) => t.repositoryBlocked).length, 1)

    const none = server(['cut', 'cut'])
    const two = interview(none.fetchImpl, [[read('r1', 'src/orders/limits.ts')]])
    await two.session.start()
    const lines = two.session.snapshot().thread.filter((t) => t.repositoryBlocked || t.repositoryFailed)
    assert.equal(lines.length, 1)
    assert.match(lines[0].text, /Reading a code repository needs the Gantry server, which can't be reached right now\./)
  })

  // #338 (docs/adr/0074): a copy still downloading is answered "preparing" (202); the browser asks again every few seconds until it is
  // ready, saying how far it has got, so the AI's tool call simply resolves with the result.
  test('a copy still downloading: the browser asks again until it is ready, reporting what has been received, and stops when the call is abandoned', async () => {
    const asked = []
    let preparing = 2
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body)
      asked.push(body)
      if (preparing-- > 0) return answer(202, { preparing: true, commit: HEAD, receivedBytes: (2 - preparing) * 1024 * 1024, repository: 'acme/billing-api' })
      return answer(200, { commit: HEAD, query: body.query, matches: [], filesSearched: 3, truncated: false, totalMatches: 0, totalFiles: 0, page: 1, pageSize: 50, total: 0, pages: 0 })
    }
    const progress = []
    const reader = repositoryReaderFor(repository, { fetchImpl, token: null, retryWaitMs: 0, pollMs: 0, onPreparing: (p) => progress.push(p) })
    const found = await reader.search({ query: 'MAX_ORDER', regex: true, fileTypes: ['ts'], context: 2, filesOnly: false, page: 1 })
    assert.equal(found.totalMatches, 0)
    assert.equal(asked.length, 3, 'asked again until the copy was ready')
    assert.deepEqual(progress.map((p) => p.receivedBytes), [1024 * 1024, 2 * 1024 * 1024])
    assert.deepEqual(asked[0], { action: 'search', repository, query: 'MAX_ORDER', regex: true, fileTypes: ['ts'], context: 2, filesOnly: false, page: 1 })

    // Abandoned (the architect stopped the turn): no further request is made.
    const stop = new AbortController()
    let calls = 0
    const forever = async () => (calls++, answer(202, { preparing: true, commit: HEAD, receivedBytes: 0, repository: 'acme/billing-api' }))
    const waiting = repositoryReaderFor(repository, { fetchImpl: forever, token: null, retryWaitMs: 0, pollMs: 20 }).find({ pattern: '**/*.tf' }, { signal: stop.signal })
    await new Promise((resolve) => setTimeout(resolve, 50))
    stop.abort()
    await assert.rejects(waiting, (err) => err.code === 'abandoned')
    const after = calls
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(calls, after, 'nothing more is asked once abandoned')
  })

  test('the reader asks for find, prepare, a paged list and a line-range read with what the server takes', async () => {
    const asked = []
    const fetchImpl = async (_url, init) => (asked.push(JSON.parse(init.body)), answer(200, { commit: HEAD }))
    const reader = repositoryReaderFor(repository, { fetchImpl, token: null, retryWaitMs: 0 })
    await reader.find({ pattern: '**/*.tf', path: 'infra', page: 2 })
    await reader.prepare()
    await reader.list({ path: 'src', page: 3 })
    await reader.read({ path: 'src/a.ts', lines: '10-20' })
    assert.deepEqual(asked, [
      { action: 'find', repository, pattern: '**/*.tf', path: 'infra', page: 2 },
      { action: 'prepare', repository },
      { action: 'list', repository, path: 'src', page: 3 },
      { action: 'read', repository, path: 'src/a.ts', lines: '10-20' },
    ])
  })

  test('cut off and timed-out reads never block a repository; definite answers do', () => {
    for (const code of ['cut-off', 'timed-out', 'unreachable']) assert.ok(!REPOSITORY_BLOCKED_CODES.includes(code), code)
    for (const code of ['no-access', 'rate-limited', 'no-branch', 'base-url-not-allowed', 'server-unreachable']) assert.ok(REPOSITORY_BLOCKED_CODES.includes(code), code)
  })
})

// #338 (docs/adr/0074): the AI's call waits while the Gantry server downloads its copy of the repository, and the thread says so; starting
// the interview starts that download.
describe('a repository copy that is preparing, in an interview', () => {
  const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
  const contextWith = (extra) => ({
    definition: definition(),
    stageId: 'shape',
    artefactId: 'light',
    size: 'medium',
    saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }] }],
    sources: [
      { id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository },
      { id: 'old-api', title: 'Old API', uploadedAt: '2026-10-01T00:00:00.000Z', removedAt: '2026-10-02T00:00:00.000Z', repository },
    ],
    skills,
    ...extra,
  })
  const anthropicProvider = () => {
    const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
    providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
    return p
  }

  test('while a search waits on the download, the session says "Preparing Billing API… N MB"; once answered, it says nothing', async () => {
    const { preparingRepositoryLine } = await import('../web/lib/interviewSession.js')
    const p = anthropicProvider()
    const ai = fakeAi((_request, n) => (n === 0 ? anthropicReply({ tools: [{ id: 's1', name: 'search_repository', input: { id: 'billing-api', query: 'MAX_ORDER' } }] }) : anthropicReply({ text: 'Done.' })))
    const seen = []
    let session
    const readRepository = (entry, how) => ({
      search: async ({ query }) => {
        assert.equal(typeof how?.onPreparing, 'function', 'the session hears how the download is going')
        assert.ok(how.signal instanceof AbortSignal, 'and the call is stopped with the turn')
        how.onPreparing({ receivedBytes: 3 * 1024 * 1024 })
        seen.push(session.snapshot().preparingRepository)
        how.onPreparing({ receivedBytes: 12.4 * 1024 * 1024 })
        seen.push(session.snapshot().preparingRepository)
        return { commit: HEAD, query, matches: [], filesSearched: 3, truncated: false, totalMatches: 0, totalFiles: 0, page: 1, pageSize: 50, total: 0, pages: 0 }
      },
    })
    session = createInterviewSession({ providerId: p.id, getContext: () => contextWith({ readRepository }), fetchImpl: ai.fetchImpl })
    await session.start()
    assert.deepEqual(seen, [{ source: 'billing-api', title: 'Billing API', receivedBytes: 3 * 1024 * 1024 }, { source: 'billing-api', title: 'Billing API', receivedBytes: 12.4 * 1024 * 1024 }])
    assert.equal(preparingRepositoryLine(seen[1]), 'Preparing Billing API… 12.4 MB')
    assert.equal(preparingRepositoryLine({ title: 'Billing API', receivedBytes: 0 }), 'Preparing Billing API…')
    assert.equal(session.snapshot().preparingRepository, null, 'the call resolved: nothing is preparing')
    assert.deepEqual(toolResults(ai.calls[1]).map((r) => Boolean(r.is_error)), [false], "the AI's call simply resolved")
  })

  test('starting the interview asks the server to prepare each repository among the live Source documents, and waits on none', async () => {
    const p = anthropicProvider()
    const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
    const prepared = []
    const prepareRepository = (entry) => {
      prepared.push(entry.id)
      return new Promise(() => {}) // never settles: nothing waits on it
    }
    const session = createInterviewSession({ providerId: p.id, getContext: () => contextWith({ prepareRepository, readRepository: () => ({}) }), fetchImpl: ai.fetchImpl })
    await session.start()
    assert.deepEqual(prepared, ['billing-api'], 'the removed one is left alone')

    // A server that refuses changes nothing for the interview.
    const refusing = createInterviewSession({ providerId: p.id, getContext: () => contextWith({ prepareRepository: () => Promise.reject(new Error('no server')), readRepository: () => ({}) }), fetchImpl: fakeAi(() => anthropicReply({ text: 'Hello.' })).fetchImpl })
    await refusing.start()
    assert.equal(refusing.snapshot().phase === 'error', false)
  })

  test('a model without tools finds, searches with options, lists a page and reads lines in read blocks', async () => {
    const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
    providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'text', readsImages: false, steps: [], message: 'ok' }, null)
    const openAiReply = (text) =>
      new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const blocks = [
      { id: 'billing-api', find: '**/*.tf', page: 2 },
      { id: 'billing-api', search: 'retry\\w*', regex: true, path: 'src', fileTypes: ['ts'], context: 2, filesOnly: true, page: 3 },
      { id: 'billing-api', list: 'src', page: 2 },
      { id: 'billing-api', path: 'src/a.ts', lines: '10-20' },
    ]
    const ai = fakeAi((_request, n) => (n === 0 ? openAiReply('Reading.\n\n```gantry-read\n' + JSON.stringify(blocks) + '\n```') : openAiReply('Done.')))
    const asked = []
    const readRepository = () => ({
      find: async (o) => (asked.push(['find', o]), { commit: HEAD, pattern: o.pattern, path: '', paths: ['infra/main.tf'], page: 2, pageSize: 200, total: 201, pages: 2 }),
      search: async (o) => (asked.push(['search', o]), { commit: HEAD, query: o.query, matches: [], filesSearched: 1, truncated: false, totalMatches: 0, totalFiles: 0, page: 3, pageSize: 200, total: 0, pages: 0 }),
      list: async (o) => (asked.push(['list', o]), { commit: HEAD, path: 'src', entries: [] }),
      read: async (o) => (asked.push(['read', o]), { commit: HEAD, path: o.path, text: 'ten', lines: { from: 10, to: 10, total: 10 } }),
    })
    const session = createInterviewSession({ providerId: p.id, getContext: () => contextWith({ readRepository }), fetchImpl: ai.fetchImpl })
    await session.start()
    assert.match(ai.calls[0].body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'), /"find":"\*\*\/\*\.tf"/, 'the model is told how to find')
    assert.deepEqual(asked, [
      ['find', { pattern: '**/*.tf', path: undefined, page: 2 }],
      ['search', { query: 'retry\\w*', path: 'src', regex: true, fileTypes: ['ts'], context: 2, filesOnly: true, page: 3 }],
      ['list', { path: 'src', page: 2 }],
      ['read', { path: 'src/a.ts', lines: '10-20' }],
    ])
  })
})
