import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #290 (parent #238, docs/adr/0064 and 0068): an AI interview session that is paused, resumed, copied to the browser's working copy and
// asked to settle a Save's clash. A fake `fetch` plays the AI Provider with scripted streams, as in tests/interviewLog.test.js.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { applyDecisionsDelta, emptyDecisionsLog } = await import('../web/lib/decisionsLog.js')
const { resumeInfo } = await import('../web/lib/interviewResume.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { CLASH_OPTIONS } = await import('../web/lib/interviewRounds.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const definition = () => ({
  id: 'small',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', purpose: 'The light one', gate: 'shaped', requires: ['details.summary'] }],
  modules: [
    {
      id: 'details',
      title: 'Details',
      purpose: 'What it is',
      fields: [
        { id: 'summary', title: 'Summary', type: 'markdown', required: true, targetWords: { small: 5, medium: 8, large: 20 } },
        { id: 'notes', title: 'Notes', type: 'markdown' },
      ],
    },
  ],
})
const sources = [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: '# Client brief\n\nThe insurer wants faster claims.' }]
const savedNothing = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }] }]

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
    calls.push({ url: envelope.url, body: envelope.body ? JSON.parse(envelope.body) : null, raw: envelope.body })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}
const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}
let counter = 0
function sessionWith(ai, over = {}) {
  const provider = over.provider ?? anthropic()
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, actor: 'Alex', ...over.context }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => `s-new${++counter}`, now: () => '2026-11-02T10:00:00.000Z' })
  return { session, provider, context }
}
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const card = (over = {}) => ({ question: 'Which one?', header: 'Choice', options: [{ label: 'Alpha', description: 'First' }, { label: 'Beta', description: 'Second' }], recommended: 'Alpha', why: 'It is first.', ...over })
const firstUser = (request) => {
  const first = request.body.messages[0]
  return typeof first.content === 'string' ? first.content : first.content.map((b) => b.text ?? '').join('\n')
}

// ---------- the working copy ----------

test('a session’s working copy, round trip through JSON, resumes with the open round, the drafts and the history', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Hello.', tools: [{ id: 't1', input: { field: 'details.summary', value: 'Faster claims [Client brief, p. 1](source:brief).' } }, ask('a1', [card({ field: 'details.notes' })])] })
    return anthropicReply({ text: 'Thanks.' })
  })
  const one = sessionWith(ai)
  assert.equal(one.session.canKeepCopy, false, 'nothing to keep before the interview starts')
  await one.session.start()
  assert.equal(one.session.snapshot().phase, 'asking')
  assert.equal(one.session.canKeepCopy, true)
  const copy = JSON.parse(JSON.stringify(one.session.exportState()))
  assert.doesNotMatch(JSON.stringify(copy), /sk-ant-1/, 'no key is in the copy')

  const two = sessionWith(ai, { provider: one.provider })
  assert.equal(two.session.importState(copy), true)
  const snap = two.session.snapshot()
  assert.equal(snap.phase, 'asking')
  assert.deepEqual(Object.keys(snap.drafts), ['details.summary'])
  assert.equal(snap.round.cards.length, 1)
  assert.equal(snap.decisions.session, one.session.snapshot().decisions.session, 'the same session carries on')

  // The restored round can be answered, and the AI is given the whole history (its first message and its own tool call included).
  const sent = ai.calls.length
  await two.session.submitRound()
  const request = ai.calls[sent]
  assert.equal(request.body.messages.length, 3, 'the opening, the AI’s turn, and the answers to the card')
  assert.equal(two.session.decisionsDelta().entries.filter((e) => e.kind === 'answer').length, 1, 'the answer is waiting for a Save')
})

test('a session that has started cannot be overwritten by a copy', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
  const { session } = sessionWith(ai)
  await session.start()
  assert.equal(session.importState({ state: {}, messages: [] }), false)
})

// ---------- Pause ----------

test('Pause ends the run: no more chat, and the status line says paused', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
  const { session } = sessionWith(ai)
  await session.start()
  const delta = session.decisionsDelta({ runState: 'paused', saving: true })
  assert.equal(delta.status.state, 'paused')
  assert.equal(delta.status.lastAiSave, '2026-11-02T10:00:00.000Z')
  session.markPaused()
  assert.equal(session.snapshot().phase, 'paused')
  assert.equal(session.canKeepCopy, false)
  const sent = ai.calls.length
  await session.send('Hello again')
  assert.equal(ai.calls.length, sent)
})

// ---------- resuming ----------

const pausedLog = () =>
  applyDecisionsDelta(
    emptyDecisionsLog('shape'),
    {
      status: { session: 's-old', who: 'Alex', target: 'shape', state: 'paused', lastAiSave: '2026-11-02T09:00:00Z', models: [{ type: 'anthropic', model: 'claude-x', inputTokens: 1000, cachedTokens: 400, outputTokens: 50 }] },
      entries: [{ id: 's-old-1', kind: 'answer', at: '2026-11-02T09:00:00Z', session: 's-old', header: 'Hosting', question: 'Where is it hosted?', answer: ['Azure'], fields: ['details.notes'] }],
    },
    'shape'
  )

test('a resume opens with the recap and the log, takes over the paused session, and keeps its tokens', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Resuming Shape: 1 decision, 0 open questions, last asked about Hosting' }))
  const log = pausedLog()
  const { session, context } = sessionWith(ai)
  Object.defineProperty(context, 'decisions', { get: () => log })
  Object.defineProperty(context, 'resume', { get: () => resumeInfo({ logs: { shape: log }, stageId: 'shape', stageTitle: 'Shape', actor: 'Alex' }) })
  session.loadDecisions(log)
  await session.start()

  const request = ai.calls[0]
  assert.equal(request.body.messages.length, 1)
  assert.match(firstUser(request), /Resume the interview/)
  assert.match(firstUser(request), /Resuming Shape: 1 decision, 0 open questions, last asked about Hosting/)
  const system = typeof request.body.system === 'string' ? request.body.system : request.body.system.map((block) => block.text).join('\n')
  assert.match(system, /Where is it hosted\?/, 'the log is in the brief')
  assert.match(system, /Azure/)
  assert.equal(session.snapshot().resumed, 'Resuming Shape: 1 decision, 0 open questions, last asked about Hosting')

  const delta = session.decisionsDelta({ runState: 'paused', saving: true })
  assert.equal(delta.status.session, 's-old', 'the same session carries on, so there is still one status line')
  const used = delta.status.models.find((m) => m.model === 'claude-x')
  assert.ok(used.inputTokens >= 1000 && used.cachedTokens >= 400, 'the totals so far are kept')
  session.markPaused()
})

test('a card answered after a resume gets an id that does not collide with the session’s earlier entries', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Back.', tools: [ask('a1', [card()])] }) : anthropicReply({ text: 'Thanks.' })))
  const log = pausedLog()
  const { session, context } = sessionWith(ai)
  Object.defineProperty(context, 'decisions', { get: () => log })
  Object.defineProperty(context, 'resume', { get: () => resumeInfo({ logs: { shape: log }, stageId: 'shape', actor: 'Alex' }) })
  session.loadDecisions(log)
  await session.start()
  await session.submitRound()
  const ids = session.decisionsDelta().entries.map((e) => e.id)
  assert.ok(ids.every((id) => id !== 's-old-1'), 'a new id, never the one already in the log')
  assert.ok(ids.some((id) => id.startsWith('s-old-')))
})

test('another session that is not Done gets a warning card; Carry on alongside starts, Cancel does not', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), { status: { session: 's-pat', who: 'Pat', state: 'in-progress', lastAiSave: '2026-11-02T08:00:00Z' } }, 'shape')
  const { session, context } = sessionWith(ai)
  Object.defineProperty(context, 'resume', { get: () => resumeInfo({ logs: { shape: log }, stageId: 'shape', actor: 'Alex' }) })

  await session.start()
  assert.equal(session.snapshot().phase, 'kickoff')
  assert.deepEqual(session.snapshot().sessionWarning.others.map((o) => [o.session, o.who, o.lastAiSave]), [['s-pat', 'Pat', '2026-11-02T08:00:00Z']])
  assert.equal(ai.calls.length, 0, 'nothing was sent to the AI')

  session.dismissSessionWarning()
  assert.equal(session.snapshot().sessionWarning, null)
  await session.start()
  assert.ok(session.snapshot().sessionWarning)
  await session.start({ alongside: true })
  assert.equal(session.snapshot().sessionWarning, null)
  assert.equal(session.snapshot().phase, 'waiting')
  assert.doesNotMatch(firstUser(ai.calls[0]), /Resume the interview/, 'no decisions yet, so this is a first run beside the other')
})

// ---------- a Save's clash cards ----------

const conflict = (over = {}) => ({
  moduleId: 'details',
  key: 'field:notes',
  kind: 'field',
  label: 'Details · Notes',
  base: { value: 'Original.' },
  mine: { value: 'Mine changed it.' },
  theirs: { value: 'Theirs changed it.' },
  ...over,
})

test('a clash becomes a card per Field with the AI’s merged wording as a third choice; nothing is pre-selected; the choice is logged', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Hello.' })
    return anthropicReply({ text: JSON.stringify({ merges: [{ id: 'clash:details:field:notes', text: 'Both changed it.' }] }) })
  })
  const { session } = sessionWith(ai)
  await session.start()
  const waiting = session.settleClashes([conflict(), conflict({ key: 'status', kind: 'status', mine: { value: 'draft' }, theirs: { value: 'agreed' }, base: { value: 'draft' }, label: 'Details · Status' })])
  const first = session.snapshot().clash
  assert.equal(first.cards.length, 2)
  assert.equal(first.cards[0].selected.length, 0)
  assert.equal(first.cards[0].clash.mine, 'Mine changed it.')
  assert.equal(first.cards[0].clash.theirs, 'Theirs changed it.')
  assert.equal(session.submitClash().ok, false, 'a Field not settled blocks the Save')

  await new Promise((resolve) => setTimeout(resolve, 20))
  const settled = session.snapshot().clash
  assert.equal(settled.merging, false)
  assert.deepEqual(settled.cards[0].options.map((o) => o.label), [CLASH_OPTIONS.mine, CLASH_OPTIONS.theirs, CLASH_OPTIONS.merged])
  assert.deepEqual(settled.cards[1].options.map((o) => o.label), [CLASH_OPTIONS.mine, CLASH_OPTIONS.theirs], 'a status is not merged')
  assert.match(ai.calls[1].body.system, /You merge two versions/)
  assert.match(ai.calls[1].raw, /Original\./, 'the AI is given the base, mine and theirs')

  session.chooseClash('clash:details:field:notes', CLASH_OPTIONS.merged)
  session.chooseClash('clash:details:status', CLASH_OPTIONS.theirs)
  assert.equal(session.submitClash().ok, true)
  const out = await waiting
  assert.deepEqual(out.resolutions['details\u0000field:notes'], { value: 'Both changed it.' })
  assert.deepEqual(out.resolutions['details\u0000status'], { value: 'agreed' })
  assert.deepEqual(out.entries.map((e) => [e.kind, e.field, e.choice]), [['save-clash', 'details.notes', 'merged'], ['save-clash', 'details.status', 'theirs']])
  assert.equal(JSON.stringify(out.entries).includes('Both changed it.'), false, 'the AI’s merged wording is not kept in the log, only that it was chosen')
  assert.equal(session.snapshot().clash, null)
  assert.equal(session.decisionsDelta().entries.filter((e) => e.kind === 'save-clash').length, 2)
})

test('a section one side removed settles as removed; cancelling resolves null and takes the choices back', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'not json' }))
  const { session } = sessionWith(ai)
  await session.start()
  const custom = conflict({ key: 'custom:extra', kind: 'custom', mine: undefined, theirs: { custom: true, title: 'Extra', type: 'markdown', value: 'Their section.' } })
  const keep = session.settleClashes([custom])
  assert.equal(session.snapshot().clash.cards[0].clash.mine, '')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(session.snapshot().clash.mergeNote, /couldn't write a merged wording/, 'a merge that did not come back leaves two choices')
  session.chooseClash('clash:details:custom:extra', CLASH_OPTIONS.mine)
  session.submitClash()
  const out = await keep
  assert.deepEqual(out.resolutions['details\u0000custom:extra'], { remove: true })

  session.discardEntries(out.entries.map((e) => e.id))
  assert.equal(session.decisionsDelta().entries.filter((e) => e.kind === 'save-clash').length, 0)

  const cancelled = session.settleClashes([conflict()])
  session.cancelClash()
  assert.equal(await cancelled, null)
  assert.equal(session.snapshot().clash, null)
})
