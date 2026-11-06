import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #348: the Tokens block shows three figures. **This session** is the running session only, from its start or its last Start this stage
// over; **Earlier sessions** is what the Stage used before it (earlier sessions in the committed log, and the session a start over ended);
// **Context** is how full the AI's conversation is now, the input of the last call against the model's context window. Start this stage
// over begins a new session in the decisions log, and the session it ended keeps its own status line with what it used, so nothing is lost
// from the record. A fake `fetch` plays the AI Provider; the AI Providers list is the real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { createSessionLog } = await import('../web/lib/interviewLog.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { applyDecisionsDelta, emptyDecisionsLog, parseDecisionsLog, serializeDecisionsLog } = await import('../web/lib/decisionsLog.js')
const { otherSessions } = await import('../web/lib/interviewResume.js')
const { EMPTY_TOKENS, addTokens, formatContext, stageTokenFigures, tokensOfLog } = await import('../web/lib/tokenUsage.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))

const definition = () => ({
  id: 'small',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary'] }],
  modules: [{ id: 'details', title: 'Details', fields: [{ id: 'summary', title: 'Problem statement', type: 'markdown', required: true }] }],
})

const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
/** An Anthropic stream that reports `input` tokens of input (`cached` of them read from the cache) and 5 of output. */
function anthropicReply({ text, input = 10, cached = 0 }) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: input - cached, cache_read_input_tokens: cached, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
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

function anthropic(contextWindow) {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', contextWindow })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

function sessionWith(ai, provider, extra = {}) {
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: [], sources: [], skills, actor: 'a.architect', ...extra }
  let n = 0
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => `s-${++n}` })
  return { session, context }
}

const used = (input, cached, output) => ({ input, cached, output })
const claude = { type: 'anthropic', model: 'claude-x' }

// ---------- the decisions log: a start over begins a new session ----------

test('Start this stage over begins a new session in the log: its tokens start at nothing, and the session it ended is kept with what it used', () => {
  let n = 0
  const log = createSessionLog({ stageId: 'shape', newSessionId: () => `s-${++n}`, who: () => 'a.architect' })
  log.addUsage(claude, { inputTokens: 900, cacheReadTokens: 600, outputTokens: 40 })
  const before = log.sessionId
  log.startOver({ opening: 'Focus on hosting.' })
  assert.notEqual(log.sessionId, before, 'a new session')
  assert.deepEqual(log.usage(), [], 'its tokens start at nothing')
  assert.equal(log.entries().at(-1).kind, 'restart')
  assert.equal(log.entries().at(-1).session, before, 'the marker is the last thing the ended session did')
  assert.deepEqual(log.endedSessions(), [{ session: before, models: [{ type: 'anthropic', model: 'claude-x', inputTokens: 900, cachedTokens: 600, outputTokens: 40 }] }])

  log.addUsage(claude, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 5 })
  const delta = log.delta({ status: { state: 'in-progress', target: 'shape' } })
  assert.equal(delta.status.session, log.sessionId)
  assert.deepEqual(delta.status.models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 100, cachedTokens: 0, outputTokens: 5 }])
  assert.equal(delta.earlierSessions.length, 1)
  assert.equal(delta.earlierSessions[0].session, before)
  assert.equal(delta.earlierSessions[0].state, 'started-over')
  assert.equal(delta.earlierSessions[0].opening, 'Focus on hosting.', 'the ended session keeps its own opening message')
  assert.deepEqual(delta.earlierSessions[0].models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 900, cachedTokens: 600, outputTokens: 40 }])
})

test('a session id that comes round again is never reused: the new session always has an id of its own', () => {
  const log = createSessionLog({ stageId: 'shape', newSessionId: () => 's-same', who: () => 'a.architect' })
  log.addUsage(claude, { inputTokens: 10, outputTokens: 1 })
  log.startOver()
  log.addUsage(claude, { inputTokens: 10, outputTokens: 1 })
  log.startOver()
  const ids = [...log.endedSessions().map((e) => e.session), log.sessionId]
  assert.equal(new Set(ids).size, 3, ids.join(', '))
  for (const id of ids) assert.match(id, /^s-same/)
})

test('Saving after a start over: the ended session line gets its final tokens and is started over, the new one is the latest, and nothing is lost', () => {
  let n = 0
  const log = createSessionLog({ stageId: 'shape', newSessionId: () => `s-${++n}`, who: () => 'a.architect' })
  log.addUsage(claude, { inputTokens: 500, cacheReadTokens: 400, outputTokens: 20 })
  // A Save before the start over committed the first session's line with what it had used then.
  const firstSave = log.delta({ status: { state: 'in-progress', target: 'shape', opening: 'Focus on hosting.' }, saving: true })
  let file = applyDecisionsDelta(emptyDecisionsLog('shape'), firstSave, 'shape')
  log.commit(firstSave)
  log.load(file)
  log.addUsage(claude, { inputTokens: 400, cacheReadTokens: 200, outputTokens: 20 })
  log.startOver()
  log.addUsage(claude, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 5 })

  const second = log.delta({ status: { state: 'in-progress', target: 'shape' }, saving: true })
  file = parseDecisionsLog(serializeDecisionsLog(applyDecisionsDelta(file, second, 'shape')), 'shape')
  assert.deepEqual(
    file.status.map((s) => [s.session, s.state]),
    [
      ['s-1', 'started-over'],
      ['s-2', 'in-progress'],
    ]
  )
  assert.equal(file.status[0].opening, 'Focus on hosting.', 'the line keeps what it was committed with')
  assert.ok(file.status[0].lastAiSave, 'and its last AI save')
  assert.deepEqual(file.status[0].models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 900, cachedTokens: 600, outputTokens: 40 }], 'with everything it used before the start over')
  assert.equal(file.status.at(-1).session, 's-2', 'the running session is the latest line')
  assert.deepEqual(tokensOfLog(file), used(1000, 600, 45), 'the Stage keeps every token')
  assert.deepEqual(otherSessions(file, { self: '' }).map((s) => s.session), ['s-2'], 'a session that was started over is finished: no two-sessions card names it')

  // Another browser reads the file: the same figures, with the running session's as Earlier sessions (it is not running there).
  const elsewhere = stageTokenFigures(file, { session: 's-other', tokens: EMPTY_TOKENS })
  assert.deepEqual(elsewhere.earlier, used(1000, 600, 45))
  assert.deepEqual(elsewhere.stage, used(1000, 600, 45))

  // Saving again changes nothing about the ended session's line.
  const again = applyDecisionsDelta(file, log.delta({ status: { state: 'saved', target: 'shape' } }), 'shape')
  assert.deepEqual(again.status[0], file.status[0])
})

test("the log's working copy keeps the session a start over ended, so a reload shows the same figures", () => {
  let n = 0
  const log = createSessionLog({ stageId: 'shape', newSessionId: () => `s-${++n}`, who: () => 'a.architect' })
  log.addUsage(claude, { inputTokens: 900, cacheReadTokens: 600, outputTokens: 40 })
  log.startOver()
  log.addUsage(claude, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 5 })
  const copy = JSON.parse(JSON.stringify(log.exportState()))
  const other = createSessionLog({ stageId: 'shape', newSessionId: () => 's-new', who: () => 'a.architect' })
  other.importState(copy)
  assert.equal(other.sessionId, log.sessionId)
  assert.deepEqual(other.usage(), log.usage())
  assert.deepEqual(other.endedSessions(), log.endedSessions())
  assert.deepEqual(other.delta({ status: { state: 'saved' } }).earlierSessions, log.delta({ status: { state: 'saved' } }).earlierSessions)
})

// ---------- the figures ----------

test("Earlier sessions is the Stage's other committed sessions plus those a start over ended (from memory); This session is never added in", () => {
  const log = {
    status: [
      { session: 's-old', models: [{ type: 'anthropic', model: 'x', inputTokens: 300, cachedTokens: 100, outputTokens: 30 }] },
      // the ended session's line as last committed: older than what memory holds, so not counted from here
      { session: 's-ended', models: [{ type: 'anthropic', model: 'x', inputTokens: 50, cachedTokens: 0, outputTokens: 5 }] },
      // the running session's own line as last committed: also counted from memory
      { session: 's-now', models: [{ type: 'anthropic', model: 'x', inputTokens: 7, cachedTokens: 0, outputTokens: 1 }] },
    ],
  }
  const figures = stageTokenFigures(log, { session: 's-now', tokens: used(20, 0, 2), ended: [{ session: 's-ended', tokens: used(80, 40, 8) }] })
  assert.deepEqual(figures.thisSession, used(20, 0, 2))
  assert.deepEqual(figures.earlier, used(380, 140, 38))
  assert.deepEqual(figures.stage, addTokens(figures.earlier, figures.thisSession), 'the run plan total is the two together')
  assert.deepEqual(tokensOfLog(log, { exceptSessions: ['s-ended', 's-now'] }), used(300, 100, 30))
  assert.deepEqual(stageTokenFigures(null, {}), { thisSession: EMPTY_TOKENS, earlier: EMPTY_TOKENS, stage: EMPTY_TOKENS })
})

test('Context is said as its size against the window, and as its size alone where the window is not known', () => {
  assert.equal(formatContext({ tokens: 120_000, window: 1_000_000 }), '120k of 1M (12%)')
  assert.equal(formatContext({ tokens: 38_000, window: 200_000 }), '38k of 200k (19%)')
  assert.equal(formatContext({ tokens: 900, window: 200_000 }), '900 of 200k (<1%)')
  assert.equal(formatContext({ tokens: 120_000 }), '120k tokens')
  assert.equal(formatContext({ tokens: 120_000, window: 0 }), '120k tokens')
  assert.equal(formatContext(null), '')
})

// ---------- the session ----------

test('a session that used tokens, then Start this stage over: This session is nothing until the AI is called again, Earlier sessions has what came before', async () => {
  const replies = [
    { input: 9000, cached: 8000 },
    { input: 12000, cached: 10000 },
    { input: 3000, cached: 0 },
  ]
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.', ...replies.shift() }))
  const { session } = sessionWith(ai, anthropic(200000))
  await session.start()
  await session.send('The budget is capped.')
  let snap = session.snapshot()
  assert.deepEqual(snap.tokens, used(21000, 18000, 10))
  assert.deepEqual(snap.endedSessions, [])
  assert.deepEqual(snap.context, { tokens: 12000, window: 200000 }, "the last call's input against the window")
  const first = snap.decisions.session

  session.startOver()
  snap = session.snapshot()
  assert.deepEqual(snap.tokens, EMPTY_TOKENS, 'This session goes back to nothing')
  assert.notEqual(snap.decisions.session, first, 'a new session')
  assert.deepEqual(snap.endedSessions, [{ session: first, tokens: used(21000, 18000, 10) }])
  assert.equal(snap.context, null, 'the conversation was cleared')

  await session.start()
  snap = session.snapshot()
  assert.deepEqual(snap.tokens, used(3000, 0, 5), 'only the new calls')
  assert.deepEqual(snap.context, { tokens: 3000, window: 200000 })
  const figures = stageTokenFigures(null, { session: snap.decisions.session, tokens: snap.tokens, ended: snap.endedSessions })
  assert.deepEqual(figures.earlier, used(21000, 18000, 10))

  // What the Save sends: the new session's line and the ended one's, so another browser has the same figures.
  const delta = session.decisionsDelta({ runState: 'in-progress' })
  assert.equal(delta.status.session, snap.decisions.session)
  assert.deepEqual(delta.earlierSessions.map((s) => [s.session, s.state]), [[first, 'started-over']])
  const file = applyDecisionsDelta(emptyDecisionsLog('shape'), delta, 'shape')
  assert.deepEqual(tokensOfLog(file), used(24000, 18000, 15))
})

test('Context is hidden before the first call and drops after Compact now', async () => {
  const ai = fakeAi((call) => (JSON.stringify(call.body.messages).includes('where we are') ? anthropicReply({ text: 'SUMMARY: nothing much yet.', input: 500 }) : anthropicReply({ text: 'Hello.', input: 40000 })))
  const { session } = sessionWith(ai, anthropic(200000))
  assert.equal(session.snapshot().context, null, 'nothing before the first call')
  await session.start()
  assert.deepEqual(session.snapshot().context, { tokens: 40000, window: 200000 })
  await session.compactNow()
  const after = session.snapshot().context
  assert.ok(after && after.tokens > 0 && after.tokens < 40000, `it drops to the compacted conversation's size: ${JSON.stringify(after)}`)
  assert.ok(session.snapshot().thread.some((t) => t.compacted && t.text.includes(`→ ${formatContext({ tokens: after.tokens }).replace(/ tokens?$/, '')} tokens`)), 'the same size the thread line gives')
})

test('a working copy reloaded after a start over shows the same three figures', async () => {
  const replies = [{ input: 9000 }, { input: 2000 }]
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.', ...replies.shift() }))
  const provider = anthropic(200000)
  const { session, context } = sessionWith(ai, provider)
  await session.start()
  session.startOver()
  await session.start()
  const before = session.snapshot()
  const copy = JSON.parse(JSON.stringify(session.exportState()))
  const other = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl })
  assert.equal(other.importState(copy), true)
  const after = other.snapshot()
  assert.equal(after.decisions.session, before.decisions.session)
  assert.deepEqual(after.tokens, before.tokens)
  assert.deepEqual(after.endedSessions, before.endedSessions)
  assert.deepEqual(after.context, before.context)
})

test('after a start over, the session it ended is never named as another session still going on the Stage', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
  const provider = anthropic(200000)
  const resume = { resuming: false, recap: '', others: [] }
  const { session } = sessionWith(ai, provider, { resume })
  await session.start()
  const first = session.snapshot().decisions.session
  session.startOver()
  // The page works out the other sessions from the committed log, where the ended session's line may still say in-progress.
  resume.others = [{ session: first, who: 'a.architect', state: 'in-progress', lastAiSave: '2026-11-06T00:00:00Z' }]
  await session.start()
  assert.equal(session.snapshot().sessionWarning, null)
  assert.notEqual(session.snapshot().phase, 'kickoff', 'the interview started')
})
