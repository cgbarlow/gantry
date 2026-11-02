import { test } from 'node:test'
import assert from 'node:assert/strict'

// #290 (parent #238, docs/adr/0064 and 0068): resuming a paused AI interview. The pure parts: how two sessions' logs merge, what a resume
// recaps and which sessions it warns about, and the browser's working copy. The session and the page are covered in
// tests/interviewResumeSession.test.js and tests/interviewResume.playwright.test.js.
const { appendEntries, applyDecisionsDelta, assertAppendOnly, currentLogEntries, emptyDecisionsLog, parseDecisionsLog, serializeDecisionsLog } = await import('../web/lib/decisionsLog.js')
const { adoptableSession, describeSaved, lastAskedAbout, otherSessions, recapLine, resumeInfo, resumeOpening, sessionIsDone } = await import('../web/lib/interviewResume.js')
const { copyStanding, createWorkingCopyStore, makeWorkingCopy } = await import('../web/lib/interviewWorkingCopy.js')

const answer = (id, at, session, over = {}) => ({ id, kind: 'answer', at, session, question: 'Where is it hosted?', answer: ['Azure'], fields: ['m.f'], ...over })

// ---------- logs merge ----------

test('entries from a second session go in among the first session’s by time, and nothing already there moves', () => {
  const first = appendEntries(emptyDecisionsLog('shape'), [answer('a-1', '2026-11-02T10:00:00Z', 'a', { question: 'One?' }), answer('a-2', '2026-11-02T12:00:00Z', 'a', { question: 'Two?' })]).log
  const { log, merged } = appendEntries(first, [answer('b-1', '2026-11-02T11:00:00Z', 'b', { question: 'Three?' })])
  assert.equal(merged, true)
  assert.deepEqual(log.entries.map((e) => e.id), ['a-1', 'b-1', 'a-2'])
  assertAppendOnly(first, log)
})

test('the append-only check still refuses a removed, changed or reordered entry once logs can merge', () => {
  const before = appendEntries(emptyDecisionsLog('shape'), [answer('a-1', '2026-11-02T10:00:00Z', 'a'), answer('a-2', '2026-11-02T12:00:00Z', 'a', { question: 'Two?' })]).log
  assert.throws(() => assertAppendOnly(before, { ...before, entries: [before.entries[1], before.entries[0]] }), /cannot be changed/)
  assert.throws(() => assertAppendOnly(before, { ...before, entries: [before.entries[0]] }), /cannot be removed/)
  assert.throws(() => assertAppendOnly(before, { ...before, entries: [{ ...before.entries[0], answer: ['x'] }, before.entries[1]] }), /cannot be changed/)
  assert.doesNotThrow(() => assertAppendOnly(before, { ...before, entries: [before.entries[0], answer('b-1', '2026-11-02T11:00:00Z', 'b', { question: 'Q?' }), before.entries[1]] }))
})

test('a later answer to the same question from another session replaces the earlier one, and the fields section is rebuilt', () => {
  const start = applyDecisionsDelta(emptyDecisionsLog('shape'), { fields: { 'm.f': { drafted: 't', inputs: [], entries: ['a-1'] } }, entries: [answer('a-1', '2026-11-02T10:00:00Z', 'a')] }, 'shape')
  const next = applyDecisionsDelta(start, { entries: [answer('b-1', '2026-11-02T11:00:00Z', 'b', { answer: ['On site'] })] }, 'shape')
  assert.deepEqual(next.entries.find((e) => e.id === 'b-1').replaces, ['a-1'])
  assert.deepEqual(next.entries.find((e) => e.id === 'a-1'), start.entries[0], 'the earlier entry is not touched')
  assert.deepEqual(currentLogEntries(next).map((e) => e.id), ['b-1'])
  assert.deepEqual(next.fields['m.f'].entries, ['b-1'])
})

test('an answer saved late that is older than the other session’s answer is the replaced one', () => {
  const start = appendEntries(emptyDecisionsLog('shape'), [answer('a-1', '2026-11-02T12:00:00Z', 'a')]).log
  const { log } = appendEntries(start, [answer('b-1', '2026-11-02T09:00:00Z', 'b', { answer: ['On site'] })])
  assert.deepEqual(log.entries.map((e) => e.id), ['b-1', 'a-1'])
  assert.equal(log.entries[0].replacedBy, 'a-1')
  assert.deepEqual(currentLogEntries(log).map((e) => e.id), ['a-1'])
})

test('one session’s own repeated answer is left to that session; a Save sent twice adds nothing, even after a merge linked it', () => {
  const start = appendEntries(emptyDecisionsLog('shape'), [answer('a-1', '2026-11-02T10:00:00Z', 'a')]).log
  const sent = answer('b-1', '2026-11-02T11:00:00Z', 'b')
  const once = appendEntries(start, [sent]).log
  assert.equal(once.entries.find((e) => e.id === 'b-1').replaces?.[0], 'a-1')
  const twice = appendEntries(once, [sent])
  assert.equal(twice.log.entries.length, 2, 'the retry is the same entry')
  const same = appendEntries(start, [answer('a-2', '2026-11-02T10:30:00Z', 'a', { answer: ['Changed my mind'] })]).log
  assert.equal(same.entries.find((e) => e.id === 'a-2').replaces, undefined, 'a session links its own replacements itself')
})

test('the merged log survives the file', () => {
  const merged = applyDecisionsDelta(applyDecisionsDelta(emptyDecisionsLog('shape'), { entries: [answer('a-1', '2026-11-02T10:00:00Z', 'a')] }, 'shape'), { entries: [answer('b-1', '2026-11-02T09:00:00Z', 'b')] }, 'shape')
  assert.deepEqual(parseDecisionsLog(serializeDecisionsLog(merged), 'shape').entries, merged.entries)
})

// ---------- what a resume knows ----------

const status = (over) => ({ session: 's-1', who: 'Alex', state: 'paused', lastAiSave: '2026-11-02T10:00:00Z', ...over })
const logWith = (entries, statuses = [status()]) => ({ ...emptyDecisionsLog('shape'), status: statuses, entries })

test('a recap names the decisions, the open questions and what was last asked', () => {
  const log = logWith([
    answer('a-1', '2026-11-02T10:00:00Z', 's-1', { header: 'Sizing', fields: ['m.size'] }),
    answer('a-2', '2026-11-02T10:05:00Z', 's-1', { header: 'Hosting', question: 'Hosting?' }),
    { id: 'a-3', kind: 'open-question', at: '2026-11-02T10:06:00Z', question: 'Who is the sponsor?' },
  ])
  assert.equal(recapLine(log, { stageTitle: 'Shape' }), 'Resuming Shape: 2 decisions, 1 open question, last asked about Who is the sponsor?')
  assert.equal(lastAskedAbout(logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1', { header: 'Hosting' })])), 'Hosting')
  assert.equal(recapLine(logWith([]), { stageTitle: 'Shape' }), 'Resuming Shape: 0 decisions, 0 open questions')
})

test('a Stage with decisions or a paused session is a resume; one that was started over is not', () => {
  const logs = { shape: logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1')]) }
  assert.equal(resumeInfo({ logs, stageId: 'shape', stageTitle: 'Shape', actor: 'Alex' }).resuming, true)
  assert.equal(resumeInfo({ logs: {}, stageId: 'shape' }).resuming, false)
  const startedOver = logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1'), { id: 'r', kind: 'restart', at: '2026-11-02T10:10:00Z' }], [status({ state: 'in-progress', who: 'Pat' })])
  assert.equal(resumeInfo({ logs: { shape: startedOver }, stageId: 'shape', actor: 'Alex' }).resuming, false)
})

test('the architect’s own paused session is taken over, not warned about; anyone else’s unfinished session is', () => {
  const log = logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1')], [status(), status({ session: 's-2', who: 'Pat', state: 'in-progress' }), status({ session: 's-3', who: 'Sam', state: 'saved' })])
  assert.equal(adoptableSession(log, 'alex').session, 's-1', 'matched on the name, whatever its case')
  assert.equal(adoptableSession(log, 'Pat'), null, 'only a paused session can be taken over')
  const info = resumeInfo({ logs: { shape: log }, stageId: 'shape', actor: 'Alex' })
  assert.equal(info.adopt.session, 's-1')
  assert.deepEqual(info.others.map((o) => o.session), ['s-2'], 'a Done session is not a warning')
  assert.deepEqual(otherSessions(log, { self: 's-1' }).map((o) => o.session), ['s-2'])
})

test('what the Provider reports overrides the file: a Stage that has moved on has no session still going', () => {
  const log = logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1')], [status({ session: 's-2', who: 'Pat', state: 'in-progress' })])
  assert.equal(sessionIsDone({ state: 'in-progress' }, null), false)
  assert.equal(sessionIsDone({ state: 'in-progress' }, 'approved'), true)
  assert.equal(resumeInfo({ logs: { shape: log }, stageId: 'shape', actor: 'Alex' }).others.length, 1)
  const info = resumeInfo({ logs: { shape: log }, stageId: 'shape', actor: 'Alex', providerStates: { shape: 'approved' } })
  assert.equal(info.others.length, 0)
  assert.equal(info.stageState, 'approved')
  assert.match(resumeOpening(info), /Check status reports this Stage as approved/)
})

test('earlier Stages’ logs are read too and mentioned to the AI', () => {
  const logs = { frame: { ...logWith([answer('f-1', '2026-11-01T10:00:00Z', 's-0', { fields: ['x.y'] })]), stage: 'frame' }, shape: logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1')]) }
  const info = resumeInfo({ logs, stageId: 'shape', stageTitle: 'Shape', actor: 'Alex', stages: [{ id: 'frame', title: 'Frame' }, { id: 'shape', title: 'Shape' }, { id: 'build', title: 'Build' }] })
  assert.deepEqual(info.earlier.map((s) => [s.title, s.decisions]), [['Frame', 1]])
  const text = resumeOpening(info)
  assert.match(text, /Open with this recap, in one short line: "Resuming Shape: 1 decision/)
  assert.match(text, /you do not have the earlier conversation/)
  assert.match(text, /Frame \(1 decision, 0 open questions\)/)
})

test('"last saved" is said plainly', () => {
  const now = Date.parse('2026-11-02T12:00:00Z')
  assert.equal(describeSaved('2026-11-02T11:58:00Z', now), 'last saved 2 minutes ago')
  assert.equal(describeSaved('2026-11-02T09:00:00Z', now), 'last saved 3 hours ago')
  assert.equal(describeSaved('2026-10-30T12:00:00Z', now), 'last saved 3 days ago')
  assert.equal(describeSaved(null, now), 'has not saved yet')
})

// ---------- the working copy ----------

const memoryStorage = () => {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map }
}

test('a copy matches the committed log until it holds an entry the copy does not know', () => {
  const copy = makeWorkingCopy({ state: { sessionId: 's-1' }, committedIds: ['a-1'], lastAiSave: '2026-11-02T10:00:00Z' })
  const log = logWith([answer('a-1', '2026-11-02T10:00:00Z', 's-1')])
  assert.equal(copyStanding(copy, log), 'fresh')
  assert.equal(copyStanding(copy, logWith([...log.entries, answer('b-1', '2026-11-02T11:00:00Z', 's-2', { question: 'Other?' })])), 'moved-on')
  assert.equal(copyStanding(copy, logWith(log.entries, [status({ lastAiSave: '2026-11-02T11:00:00Z' })])), 'moved-on', 'this session saved again from elsewhere')
  assert.equal(copyStanding(copy, logWith(log.entries, [status({ session: 's-9', lastAiSave: '2026-11-02T11:00:00Z' })])), 'fresh', 'another session’s status alone is not a move')
  assert.equal(copyStanding(null, log), 'unusable')
  assert.equal(copyStanding({ ...copy, version: 99 }, log), 'unusable')
})

test('the working copy store keeps, sets aside and clears a copy, and never throws when storage fails', () => {
  const storage = memoryStorage()
  const store = createWorkingCopyStore(storage)
  const copy = makeWorkingCopy({ state: { sessionId: 's-1' }, committedIds: [] })
  assert.equal(store.save('k', copy), true)
  assert.equal(store.load('k').session, 's-1')
  assert.equal(store.setAside('k', copy, 'moved-on'), true)
  assert.equal(store.load('k'), null)
  assert.equal(store.aside('k').reason, 'moved-on')
  store.clearAside('k')
  assert.equal(store.aside('k'), null)

  const broken = createWorkingCopyStore({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('blocked') } })
  assert.equal(broken.save('k', copy), false)
  assert.equal(broken.load('k'), null)
  assert.doesNotThrow(() => broken.clear('k'))
  assert.equal(createWorkingCopyStore(null).save('k', copy), false)
  storage.map.set('gantry:interview-copy:bad', '{not json')
  assert.equal(store.load('bad'), null)
})
