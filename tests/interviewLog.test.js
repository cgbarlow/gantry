import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #288 (parent #238): the decisions log an AI interview session collects. A fake `fetch` plays the AI Provider with scripted
// streams, as in tests/interviewSession.test.js; the AI Providers list is the real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { appendEntries, applyDecisionsDelta, emptyDecisionsLog, serializeDecisionsLog, parseDecisionsLog } = await import('../web/lib/decisionsLog.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

function definition() {
  return {
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
          { id: 'risk', title: 'Risk level', type: 'select', options: ['Low', 'Medium', 'High', 'Severe', 'Extreme'], default: 'Medium' },
          { id: 'notes', title: 'Notes', type: 'markdown' },
          { id: 'owner', title: 'Owner', type: 'text' },
        ],
      },
    ],
  }
}
const sources = [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: '# Client brief\n\nThe insurer wants faster claims.' }]
const savedNothing = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'risk', value: '' }, { id: 'notes', value: '' }, { id: 'owner', value: '' }] }]
const savedNotes = () => {
  const saved = savedNothing()
  saved[0].fields[2].value = 'Notes the architect already saved.'
  return saved
}

// ---------- a fake AI Provider ----------
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
const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  tested(p.id)
  return p
}
const openAiText = (questionCards = 'text') => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  tested(p.id, { questionCards })
  return p
}

function sessionWith(ai, over = {}) {
  const provider = over.provider ?? anthropic()
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, actor: 'Alex', instructionsVersion: 'small@2', ...over.context }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => 's-test', now: () => '2026-11-02T10:00:00.000Z' })
  return { session, provider, context }
}

const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}
const lastUserText = (request) => {
  const last = request.body.messages.at(-1)
  return typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? b.content ?? '').join('\n')
}

const card = (over = {}) => ({
  question: 'Which one?',
  options: [{ label: 'Alpha', description: 'First' }, { label: 'Beta', description: 'Second' }],
  recommended: 'Alpha',
  why: 'It is first.',
  ...over,
})
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const draftCall = (id, field, value, extra = {}) => ({ id, input: { field, value, ...extra } })

const logCall = (id, input) => ({ id, name: 'log_decision', input })
const quiet = () => anthropicReply({ text: 'Okay.' })

// ---------- question cards ----------

test('an answered card is logged: question, options, recommendation, why, cited document, answer, the architect\'s words and the Field it fed', async () => {
  const ai = fakeAi((request, n) =>
    n === 0
      ? anthropicReply({ tools: [ask('a1', [card({ id: 'who', header: 'Owner', question: 'Who owns it?', field: 'details.owner', source: { document: 'brief', location: 'p. 2' }, options: [{ label: 'Pat' }, { label: 'Sam' }], recommended: 'Pat' }), card({ id: 'note', question: 'Anything else?', field: 'details.notes' })])] })
      : quiet()
  )
  const { session } = sessionWith(ai)
  await session.start()
  session.choose('who', 'Sam')
  session.setOtherText('note', 'Keep it away from payroll')
  await session.submitRound()

  const entries = session.snapshot().decisions.latest.filter((e) => e.kind === 'answer')
  assert.equal(entries.length, 2)
  const who = entries.find((e) => e.card === 'who')
  assert.deepEqual(
    { question: who.question, options: who.options, recommendation: who.recommendation, why: who.why, sources: who.sources, answer: who.answer, fields: who.fields, followed: who.followed, session: who.session, who: who.who },
    { question: 'Who owns it?', options: ['Pat', 'Sam'], recommendation: ['Pat'], why: 'It is first.', sources: ['brief, p. 2'], answer: ['Sam'], fields: ['details.owner'], followed: false, session: 's-test', who: 'Alex' }
  )
  const note = entries.find((e) => e.card === 'note')
  assert.equal(note.words, 'Keep it away from payroll', 'what the architect typed in Other is kept word for word')
  assert.deepEqual(note.answer ?? [], [])
})

test('a changed answer is a new entry that replaces the old one; the old one stays in the history', async () => {
  const ai = fakeAi((request, n) => (n === 0 || n === 2 ? anthropicReply({ tools: [ask(`a${n}`, [card({ id: n === 0 ? 'one' : 'two', question: 'Who owns it?', field: 'details.owner' })])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  await session.submitRound() // Alpha, the recommendation
  await session.send('Actually, ask me again.')
  session.choose('two', 'Beta')
  await session.submitRound()

  const all = session.snapshot().decisions.history.filter((e) => e.kind === 'answer')
  assert.equal(all.length, 2)
  assert.deepEqual(all[1].replaces, [all[0].id])
  const { latest } = session.snapshot().decisions
  assert.deepEqual(latest.filter((e) => e.kind === 'answer').map((e) => e.answer), [['Beta']])
})

// ---------- free chat ----------

test('a fact the architect typed is kept word for word, against the Field it fed', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return quiet()
    if (n === 1) return anthropicReply({ tools: [logCall('l1', { kind: 'fact', quote: 'capped at $1.2M', fields: ['details.notes'] }), draftCall('d1', 'details.notes', 'The budget is capped at $1.2M.')] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Please note the budget is capped at $1.2M, and finance signs off.')
  const facts = session.snapshot().decisions.latest.filter((e) => e.kind === 'fact')
  assert.equal(facts.length, 1)
  assert.equal(facts[0].words, 'Please note the budget is capped at $1.2M, and finance signs off.', 'the whole message, as typed, not the AI\'s quote or wording')
  assert.deepEqual(facts[0].fields, ['details.notes'])
  assert.equal(toolResults(ai.calls[2]).find((r) => r.tool_use_id === 'l1').is_error ?? false, false)
})

test('thanks and "go on" are never kept, and the AI cannot log words the architect did not type', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return quiet()
    if (n === 1) return anthropicReply({ tools: [logCall('l1', { kind: 'fact', quote: 'Thanks', fields: ['details.notes'] })] })
    if (n === 2) return quiet()
    if (n === 3) return anthropicReply({ tools: [logCall('l2', { kind: 'fact', quote: 'the budget is two million', fields: ['details.notes'] })] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Thanks, go on.')
  assert.equal(toolResults(ai.calls[2])[0].is_error, true)
  assert.match(toolResults(ai.calls[2])[0].content, /only thanks|not something the architect typed/)
  await session.send('Sounds good')
  assert.equal(session.snapshot().decisions.latest.filter((e) => e.kind === 'fact').length, 0)
  assert.equal(toolResults(ai.calls[4])[0].is_error, true, 'a quote that is not in anything the architect typed is refused')
  assert.deepEqual(session.snapshot().decisions.history.map((e) => e.kind), ['artefact'], 'only the Artefact choice is in the log')
})

test('the AI\'s own replies are never in the log', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'ZZZ-AI-REPLY-SENTINEL I read the brief.' }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('The sponsor is the COO and she wants it by June.')
  const delta = session.decisionsDelta()
  assert.ok(!JSON.stringify(delta).includes('ZZZ-AI-REPLY-SENTINEL'))
  assert.ok(!JSON.stringify(delta).includes('I read the brief'))
})

test('the text fallback logs facts in a gantry-log block', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  tested(p.id, { questionCards: 'text' })
  const ai = fakeAi((request, n) =>
    n === 1 ? openAiReply('Noted.\n```gantry-log\n{"kind":"fact","quote":"leave out Finance","fields":["details.notes"]}\n```') : openAiReply('Hello.')
  )
  const { session } = sessionWith(ai, { provider: p })
  await session.start()
  await session.send('Please leave out Finance from this.')
  const facts = session.snapshot().decisions.latest.filter((e) => e.kind === 'fact')
  assert.equal(facts[0]?.words, 'Please leave out Finance from this.')
  assert.ok(!session.snapshot().thread.some((t) => t.text?.includes('gantry-log')), 'the block is not shown')
})

// ---------- saved content, open questions, Artefact, restart, model change ----------

test('keep / replace / merge on saved content is logged', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'details.notes', 'The AI would rewrite the notes.')] }) : quiet()))
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  assert.equal(session.snapshot().round.cards[0].type, 'change')
  session.choose('change:details.notes', "Use the AI's version")
  await session.submitRound()
  const entry = session.snapshot().decisions.latest.find((e) => e.kind === 'saved-content')
  assert.equal(entry.field, 'details.notes')
  assert.equal(entry.choice, 'replace')
})

test('an open question is logged, and an answer on the same Field closes it', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [logCall('o1', { kind: 'open-question', question: 'Is the risk Severe or Extreme?', why: 'None of the options fits the brief.', fields: ['details.risk'] })] })
    if (n === 1) return anthropicReply({ text: 'Logged.' })
    if (n === 2) return anthropicReply({ tools: [ask('a1', [card({ id: 'risk', question: 'Which risk level?', field: 'details.risk', options: [{ label: 'Low' }, { label: 'High' }], recommended: 'Low' })])] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  assert.equal(session.snapshot().decisions.open.length, 1)
  assert.equal(session.snapshot().decisions.open[0].question, 'Is the risk Severe or Extreme?')
  await session.send('Ask me about the risk.')
  await session.submitRound()
  const snap = session.snapshot().decisions
  assert.equal(snap.open.length, 0, 'closed')
  const answer = snap.history.find((e) => e.kind === 'answer')
  assert.deepEqual(answer.resolves, [snap.history.find((e) => e.kind === 'open-question').id])
  assert.equal(snap.history.filter((e) => e.kind === 'open-question').length, 1, 'the open question itself is still in the history')
})

test('the Artefact aimed for is logged, a model change is logged, and Start this stage over appends a restart marker', async () => {
  const ai = fakeAi(() => quiet())
  const { session } = sessionWith(ai)
  const second = providers.addAiProvider({ name: 'Other', type: 'openrouter', address: 'https://openrouter.ai/api/v1', key: 'k2', model: 'some/model' })
  tested(second.id)
  await session.start()
  await session.setProvider(second.id)
  const history = session.snapshot().decisions.history
  assert.deepEqual(history.map((e) => e.kind), ['artefact', 'model-change'])
  assert.equal(history[0].artefact, 'light')
  assert.deepEqual(history[1].from, { type: 'anthropic', model: 'claude-x' })
  assert.deepEqual(history[1].to, { type: 'openrouter', model: 'some/model' })

  session.startOver()
  const after = session.snapshot()
  assert.equal(after.phase, 'kickoff')
  assert.equal(after.decisions.history.at(-1).kind, 'restart')
  assert.equal(after.decisions.count, 0, 'nothing before the marker holds any more')
})

// ---------- fields: inputs and fingerprints ----------

test('each drafted Field records its inputs with fingerprints, the AI-named ones checked and the reads Gantry saw added', async () => {
  const saved = [...savedNothing(), { id: 'earlier', status: 'agreed', fields: [{ id: 'goal', value: 'Faster claims' }] }]
  const ai = fakeAi((request, n) =>
    n === 0
      ? anthropicReply({
          tools: [draftCall('d1', 'details.notes', 'Claims must be faster [Client brief](source:brief).', { inputs: [{ source: 'brief', range: 'pages 1-2' }, { field: 'earlier.goal' }, { source: 'ghost' }, { field: 'earlier.nothing' }] })],
        })
      : quiet()
  )
  const { session } = sessionWith(ai, { context: { saved } })
  await session.start()
  const result = toolResults(ai.calls[1])[0].content
  assert.match(result, /Not recorded as inputs, because they do not exist: source ghost, field earlier\.nothing/)
  const record = session.decisionsDelta().fields['details.notes']
  assert.ok(record)
  const bySource = record.inputs.find((i) => i.source === 'brief' && i.range === 'pages 1-2')
  assert.match(bySource.fingerprint, /^[0-9a-f]{14}$/)
  const byField = record.inputs.find((i) => i.field === 'earlier.goal')
  assert.match(byField.fingerprint, /^[0-9a-f]{14}$/)
  assert.ok(record.inputs.some((i) => i.source === 'brief' && i.range === null), 'the citation Gantry saw is an input too')
  assert.equal(record.inputs.length, 3)
})

test('the Field record lists the entries that fed it', async () => {
  const ai = fakeAi((request, n) =>
    n === 0 ? anthropicReply({ tools: [ask('a1', [card({ id: 'who', field: 'details.owner', question: 'Who owns it?' })]), draftCall('d1', 'details.owner', 'Pat')] }) : quiet()
  )
  const { session } = sessionWith(ai)
  await session.start()
  await session.submitRound()
  const delta = session.decisionsDelta()
  const answer = delta.entries.find((e) => e.kind === 'answer')
  assert.deepEqual(delta.fields['details.owner'].entries, [answer.id])
})

// ---------- the status block ----------

test('the status block names the session, who, target, state, Artefact, last AI save, models with tokens, instructions and skill versions', async () => {
  const ai = fakeAi(() => quiet())
  const { session } = sessionWith(ai)
  await session.start()
  const s = session.decisionsDelta({ runState: 'saved', saving: true }).status
  assert.equal(s.session, 's-test')
  assert.equal(s.who, 'Alex')
  assert.equal(s.target, 'shape')
  assert.equal(s.state, 'saved')
  assert.equal(s.artefact, 'light')
  assert.equal(s.lastAiSave, '2026-11-02T10:00:00.000Z')
  assert.equal(s.instructions, 'small@2')
  assert.deepEqual(s.models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 10, cachedTokens: 0, outputTokens: 5 }])
  assert.ok(Object.keys(s.skills).includes('grilling'))
})

test('the status block never holds a key, an address or a custom name, even after a Save round-trip', async () => {
  const provider = providers.addAiProvider({ name: 'My secret custom name', type: 'anthropic', address: 'https://very-private.example.com', key: 'sk-ant-SECRETKEY123456', model: 'claude-x' })
  tested(provider.id)
  const ai = fakeAi(() => quiet())
  const { session } = sessionWith(ai, { provider })
  await session.start()
  const file = serializeDecisionsLog(applyDecisionsDelta(emptyDecisionsLog('shape'), session.decisionsDelta(), 'shape'))
  for (const secret of ['SECRETKEY', 'very-private', 'My secret custom name', 'https://']) assert.ok(!file.includes(secret), `${secret} is not in the file`)
  assert.match(file, /type: anthropic/)
  assert.match(file, /model: claude-x/)
})

// ---------- commit and append-only ----------

test('after a Save the entries are committed and are not sent again; a log round-trips through the file', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [card({ id: 'one', field: 'details.owner', question: 'Who?' })])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  await session.submitRound()
  const delta = session.decisionsDelta({ saving: true })
  assert.ok(delta.entries.length >= 2)
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), delta, 'shape')
  session.commitDecisions(delta)
  assert.equal(session.decisionsDelta().entries.length, 0)
  const again = parseDecisionsLog(serializeDecisionsLog(log), 'shape')
  assert.deepEqual(again.entries, log.entries)
  assert.deepEqual(applyDecisionsDelta(again, delta, 'shape').entries, log.entries, 'saving the same delta twice adds nothing')
})

test('a resumed session is told what the committed log already settled', async () => {
  const committed = appendEntries(emptyDecisionsLog('shape'), [{ id: 'old-1', kind: 'answer', at: '2026-11-01T00:00:00Z', question: 'Who owns the budget?', answer: ['The COO'], fields: ['details.owner'] }]).log
  const ai = fakeAi(() => quiet())
  const { session } = sessionWith(ai, { context: { decisions: committed } })
  await session.start()
  assert.match(ai.calls[0].body.system, /Who owns the budget\?/)
  assert.match(ai.calls[0].body.system, /answer: The COO/)
})
