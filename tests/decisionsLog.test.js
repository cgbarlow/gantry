import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DecisionsLogError,
  OPENING_MAX,
  appendEntries,
  applyDecisionsDelta,
  assertAppendOnly,
  currentLogEntries,
  decisionsLogPath,
  emptyDecisionsLog,
  findArchitectMessage,
  isAcknowledgement,
  logSummary,
  parseDecisionsLog,
  safeToken,
  serializeDecisionsLog,
  sessionStatus,
} from '../web/lib/decisionsLog.js'

// #288 (parent #238, docs/adr/0064): the decisions log file. Pure, so these drive all of it: the append-only rule, the status
// block's guarantee that no key or address reaches the file, the file round trip and what the editor's panel shows.

const entry = (id, over = {}) => ({ id, kind: 'answer', at: `2026-11-02T10:00:0${id.length}Z`, question: `Q ${id}`, answer: ['A'], ...over })

test('the log lives at interview/<stageId>.yaml', () => {
  assert.equal(decisionsLogPath('shape'), 'interview/shape.yaml')
})

// ---------- append-only ----------

test('entries are appended to the end, oldest first, and the ones already there are untouched', () => {
  const first = appendEntries(emptyDecisionsLog('shape'), [entry('a', { at: '2026-11-02T10:00:00Z' })]).log
  const second = appendEntries(first, [entry('c', { at: '2026-11-02T12:00:00Z' }), entry('b', { at: '2026-11-02T11:00:00Z' })]).log
  assert.deepEqual(second.entries.map((e) => e.id), ['a', 'b', 'c'])
  assert.deepEqual(second.entries[0], first.entries[0])
  assert.equal(first.entries.length, 1, 'the log passed in is not changed')
})

test('writing an entry again with the same content adds nothing; with different content is refused', () => {
  const log = appendEntries(emptyDecisionsLog('shape'), [entry('a')]).log
  assert.equal(appendEntries(log, [entry('a')]).log.entries.length, 1)
  assert.throws(() => appendEntries(log, [entry('a', { answer: ['changed'] })]), (err) => err instanceof DecisionsLogError && err.code === 'append-only' && err.status === 409)
})

test('a check fails if any write changes, reorders or removes an existing entry', () => {
  const before = appendEntries(emptyDecisionsLog('shape'), [entry('a'), entry('bb'), entry('ccc')]).log
  const edit = (fn) => ({ ...before, entries: fn(before.entries.map((e) => ({ ...e }))) })
  assert.doesNotThrow(() => assertAppendOnly(before, { ...before, entries: [...before.entries, entry('dddd')] }))
  assert.throws(() => assertAppendOnly(before, edit((es) => es.slice(1))), /cannot be removed/)
  assert.throws(() => assertAppendOnly(before, edit((es) => es.slice(0, -1))), /cannot be removed/)
  assert.throws(() => assertAppendOnly(before, edit((es) => ((es[1].answer = ['edited']), es))), /cannot be changed/)
  assert.throws(() => assertAppendOnly(before, edit((es) => es.reverse())), /cannot be changed/)
  assert.throws(() => assertAppendOnly(before, edit((es) => ((delete es[0].question), es))), /cannot be changed/)
})

test('no delta, however it is built, can change or remove an entry already in the log', () => {
  let log = appendEntries(emptyDecisionsLog('shape'), [entry('a'), entry('bb')]).log
  const deltas = [
    { entries: [] },
    { entries: [entry('a')] },
    { status: { session: 's-1', who: 'x' }, fields: { 'm.f': { inputs: [], entries: ['a'] } } },
    { entries: [entry('ccc', { replaces: ['a'] })] },
    { entries: [{ id: 'dddd', kind: 'restart', at: '2026-11-02T13:00:00Z' }] },
    {},
    undefined,
  ]
  for (const delta of deltas) {
    const next = applyDecisionsDelta(log, delta, 'shape')
    assertAppendOnly(log, next)
    log = next
  }
  assert.deepEqual(log.entries.slice(0, 2).map((e) => e.id), ['a', 'bb'])
  assert.throws(() => applyDecisionsDelta(log, { entries: [entry('bb', { question: 'rewritten' })] }, 'shape'), DecisionsLogError)
})

test('a changed answer is a new entry with replaces, and an open question is closed by an entry with resolves; both leave the old entry in the file', () => {
  const log = appendEntries(emptyDecisionsLog('shape'), [
    entry('a', { fields: ['m.f'] }),
    { id: 'q1', kind: 'open-question', at: '2026-11-02T10:01:00Z', question: 'Which?', fields: ['m.g'] },
    entry('b', { replaces: ['a'], at: '2026-11-02T10:02:00Z' }),
    entry('c', { resolves: ['q1'], at: '2026-11-02T10:03:00Z' }),
  ]).log
  assert.equal(log.entries.length, 4)
  assert.deepEqual(currentLogEntries(log).map((e) => e.id), ['b', 'c'])
  const summary = logSummary(log)
  assert.deepEqual(summary.latest.map((e) => e.id), ['b', 'c'])
  assert.deepEqual(summary.open, [])
  assert.equal(summary.history.length, 4, 'history is on request')
})

test('a restart marker makes the AI ignore everything before it, and the file still has it all', () => {
  const log = appendEntries(emptyDecisionsLog('shape'), [entry('a'), { id: 'r', kind: 'restart', at: '2026-11-02T10:05:00Z' }, entry('bb', { at: '2026-11-02T10:06:00Z' })]).log
  assert.deepEqual(currentLogEntries(log).map((e) => e.id), ['bb'])
  assert.equal(log.entries.length, 3)
})

// ---------- the status block ----------

test('a status entry keeps only known keys: nothing that looks like a key, an address or a custom name gets in', () => {
  const status = sessionStatus({
    session: 's-1',
    who: 'Alex',
    target: 'design',
    state: 'in-progress',
    artefact: 'soap',
    lastAiSave: '2026-11-02T10:00:00.000Z',
    models: [
      { type: 'anthropic', model: 'claude-x', inputTokens: 10, cachedTokens: 4, outputTokens: 2, key: 'sk-ant-SECRET0123456789', address: 'https://private.example.com', name: 'Custom name' },
      { type: 'custom', model: 'https://private.example.com/v1' },
      { type: 'openai', model: 'sk-proj-ABCDEFGH12345678' },
    ],
    instructions: 'design@3',
    skills: { grilling: '1.2.3' },
    apiKey: 'sk-ant-SECRET0123456789',
    address: 'https://private.example.com',
    customName: 'My team AI',
  })
  assert.deepEqual(Object.keys(status).sort(), ['artefact', 'instructions', 'lastAiSave', 'models', 'session', 'skills', 'state', 'target', 'who'])
  assert.deepEqual(status.models, [{ type: 'anthropic', model: 'claude-x', inputTokens: 10, cachedTokens: 4, outputTokens: 2 }])
  const text = JSON.stringify(status)
  for (const secret of ['SECRET', 'private.example', 'Custom name', 'My team AI']) assert.ok(!text.includes(secret), `${secret} is not in the status`)
})

test('#331 a status entry keeps the architect\'s opening message word for word, and none when they typed nothing', () => {
  const words = 'Focus on the hosting decision; the budget is capped at NZD 1.2M.\nAsk about https://intranet first.'
  const status = sessionStatus({ session: 's-1', who: 'Alex', opening: `  ${words}  ` })
  assert.equal(status.opening, words, 'trimmed, and otherwise as typed: it is the architect\'s words, not a token')
  assert.equal('opening' in sessionStatus({ session: 's-1', opening: '   ' }), false)
  assert.equal('opening' in sessionStatus({ session: 's-1' }), false)
  assert.equal('opening' in sessionStatus({ session: 's-1', opening: { text: 'x' } }), false, 'only text is kept')
  assert.equal(sessionStatus({ session: 's-1', opening: 'x'.repeat(OPENING_MAX + 50) }).opening.length, OPENING_MAX)
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), { status: { session: 's-1', who: 'Alex', opening: words } }, 'shape')
  assert.equal(parseDecisionsLog(serializeDecisionsLog(log), 'shape').status[0].opening, words, 'it survives the file')
})

test('an outside agent\'s model is recorded with its tokens as "not reported"', () => {
  const status = sessionStatus({ session: 's-2', models: [{ type: 'outside-agent', model: 'claude-opus', reported: false }] })
  assert.deepEqual(status.models, [{ type: 'outside-agent', model: 'claude-opus', tokens: 'not reported' }])
})

test('safeToken refuses keys, addresses and prose', () => {
  assert.equal(safeToken('claude-sonnet-4-5'), 'claude-sonnet-4-5')
  assert.equal(safeToken('meta/llama-3.1:8b'), 'meta/llama-3.1:8b')
  assert.equal(safeToken('sk-ant-abcdefghij'), '')
  assert.equal(safeToken('http://localhost:11434'), '')
  assert.equal(safeToken('my team model'), '')
  assert.equal(safeToken('x'.repeat(200)), '')
})

test('applying a delta replaces the session\'s own status line in place and overwrites a Field record, leaving other sessions alone', () => {
  let log = applyDecisionsDelta(emptyDecisionsLog('shape'), { status: { session: 's-1', who: 'A', state: 'in-progress' }, fields: { 'm.f': { inputs: [{ source: 'x', fingerprint: '1' }], entries: ['a'] } } }, 'shape')
  log = applyDecisionsDelta(log, { status: { session: 's-2', who: 'B', state: 'in-progress' } }, 'shape')
  log = applyDecisionsDelta(log, { status: { session: 's-1', who: 'A', state: 'saved' }, fields: { 'm.f': { inputs: [{ source: 'y', fingerprint: '2' }], entries: [] } } }, 'shape')
  assert.deepEqual(log.status.map((s) => [s.session, s.state]), [['s-1', 'saved'], ['s-2', 'in-progress']])
  assert.deepEqual(log.fields['m.f'].inputs, [{ source: 'y', fingerprint: '2' }])
})

// ---------- the file ----------

test('the log round-trips through its YAML file', () => {
  const log = applyDecisionsDelta(
    emptyDecisionsLog('shape'),
    {
      status: { session: 's-1', who: 'A', target: 'shape', models: [{ type: 'anthropic', model: 'claude-x', inputTokens: 5 }] },
      fields: { 'm.f': { drafted: '2026-11-02T10:00:00Z', inputs: [{ source: 'brief', title: 'Brief', range: 'pages 1-2', fingerprint: 'abc' }], entries: ['a'] } },
      entries: [entry('a', { words: 'The architect said: "multi\nline" - and more: yes' })],
    },
    'shape'
  )
  const text = serializeDecisionsLog(log)
  assert.match(text, /^version: 1\nstage: shape\nstatus:/)
  assert.deepEqual(parseDecisionsLog(text, 'shape'), log)
  assert.equal(serializeDecisionsLog(parseDecisionsLog(text, 'shape')), text, 'stable bytes')
})

test('a missing or blank file is an empty log; one that does not parse is an error, never silently emptied', () => {
  assert.deepEqual(parseDecisionsLog(null, 'shape'), emptyDecisionsLog('shape'))
  assert.deepEqual(parseDecisionsLog('', 'shape'), emptyDecisionsLog('shape'))
  assert.throws(() => parseDecisionsLog('entries: [unclosed', 'shape'), (err) => err instanceof DecisionsLogError && err.code === 'unreadable-log')
  assert.throws(() => parseDecisionsLog('- just\n- a list\n', 'shape'), DecisionsLogError)
})

// ---------- chat that feeds nothing ----------

test('thanks, go on and other acknowledgements are not kept; a message that says something is', () => {
  for (const text of ['Thanks', 'thanks!', 'Thank you', 'go on', 'OK, go on.', 'ok sounds good', 'Yes please', 'Great, carry on', 'perfect, thanks a lot', '']) {
    assert.equal(isAcknowledgement(text), true, text)
  }
  for (const text of ['The budget is capped at $1.2M', 'Leave out Finance', 'Yes, but only for the claims team', 'No payroll data']) {
    assert.equal(isAcknowledgement(text), false, text)
  }
})

test('a fact is found only in a message the architect typed, and is returned whole', () => {
  const typed = ['Thanks, go on', 'Please note the budget is capped at $1.2M, and finance signs off.']
  assert.equal(findArchitectMessage(typed, 'capped at $1.2m'), typed[1])
  assert.equal(findArchitectMessage(typed, 'Capped  at   $1.2M'), typed[1], 'whitespace and case do not matter')
  assert.equal(findArchitectMessage(typed, 'the budget is two million'), null)
  assert.equal(findArchitectMessage(typed, 'Thanks'), null, 'an acknowledgement is never a fact')
  assert.equal(findArchitectMessage(typed, 'ab'), null)
})
