import { test, beforeEach } from 'node:test'
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
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')

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
  assert.deepEqual(first.tools.map((t) => t.name), ['ask_architect', 'draft_field', 'log_decision', 'list_repository_folder', 'search_repository', 'read_repository_file'])
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
  const { SourceDocumentError } = await import('../web/lib/sourceDocuments.js')
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
