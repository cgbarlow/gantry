import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beginRun, clearRun, getRun, interviewRuns, nextStage, planRows, resumableRun, runOpening, runTargets, saveOutcome, updateRun } from '../web/lib/interviewRun.js'
import { applyDecisionsDelta, emptyDecisionsLog, sessionStatus } from '../web/lib/decisionsLog.js'
import { createInterviewSession } from '../web/lib/interviewSession.js'

// #293 (parent #238): "Run until stage X" across Stages on local and server workspaces. The rules of a run, with no DOM.

const STAGES = [
  { id: 'one', title: 'One' },
  { id: 'two', title: 'Two' },
  { id: 'three', title: 'Three' },
  { id: 'four', title: 'Four' },
]

test('a run can be aimed at the current Stage or any later one, never an earlier one', () => {
  assert.deepEqual(runTargets(STAGES, 'two').map((s) => s.id), ['two', 'three', 'four'])
  assert.deepEqual(runTargets(STAGES, 'four').map((s) => s.id), ['four'])
  assert.deepEqual(runTargets(STAGES, 'nope'), [])
  assert.equal(nextStage(STAGES, 'two').id, 'three')
  assert.equal(nextStage(STAGES, 'four'), null)
})

test('the run plan has one row per Stage: done before, the current one in its state, waiting after, struck through beyond the target', () => {
  const rows = planRows({ stages: STAGES, currentStageId: 'two', targetStageId: 'three', current: 'drafting' })
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.target]), [
    ['one', 'done', false],
    ['two', 'drafting', false],
    ['three', 'waiting', true],
    ['four', 'beyond', false],
  ])
  assert.equal(rows[2].note, 'waiting · target')
  assert.equal(rows[3].note, 'beyond target')
  assert.equal(rows[1].note, 'drafting')
})

test('the current Stage moves through drafting, awaiting confirmation and done; before the interview starts it is waiting', () => {
  const state = (current) => planRows({ stages: STAGES, currentStageId: 'one', targetStageId: 'two', current })[0].state
  assert.equal(state('idle'), 'waiting')
  assert.equal(state('drafting'), 'drafting')
  assert.equal(state('awaiting-confirmation'), 'awaiting-confirmation')
  assert.equal(state('paused'), 'paused')
  assert.equal(state('done'), 'done')
})

test('a target that is not ahead of the current Stage is the current Stage: a run of one', () => {
  const rows = planRows({ stages: STAGES, currentStageId: 'three', targetStageId: 'one', current: 'drafting' })
  assert.equal(rows.find((r) => r.target).id, 'three')
  assert.equal(rows.find((r) => r.id === 'four').state, 'beyond')
})

test('Save, advance, carry on saves and moves on; Save and stop here pauses; the target Stage finishes the run either way', () => {
  const base = { stages: STAGES, currentStageId: 'one', targetStageId: 'three', startStageId: 'one' }
  const carry = saveOutcome({ ...base, action: 'advance' })
  assert.deepEqual([carry.state, carry.finished, carry.advances, carry.nextStageId], ['saved', false, true, 'two'])
  assert.deepEqual(carry.stages, { one: 'done', two: 'waiting', three: 'waiting' })

  const stop = saveOutcome({ ...base, action: 'stop' })
  assert.deepEqual([stop.state, stop.finished, stop.advances, stop.nextStageId], ['paused', false, false, null])
  assert.deepEqual(stop.stages, { one: 'paused', two: 'waiting', three: 'waiting' })

  for (const action of ['advance', 'stop']) {
    const last = saveOutcome({ ...base, currentStageId: 'three', action })
    assert.deepEqual([last.state, last.finished, last.advances, last.nextStageId], ['done', true, false, null])
    assert.deepEqual(last.stages, { one: 'done', two: 'done', three: 'done' })
  }
})

test('a run of one Stage is done when its card is confirmed', () => {
  const out = saveOutcome({ stages: STAGES, currentStageId: 'two', targetStageId: 'two', startStageId: 'two', action: 'stop' })
  assert.deepEqual([out.state, out.finished], ['done', true])
  assert.deepEqual(out.stages, { two: 'done' })
})

test('the status block records the run target and each Stage state, and nothing but safe words', () => {
  const status = sessionStatus({ session: 's-1', who: 'a.architect', target: 'three', state: 'paused', stages: { one: 'paused', two: 'waiting', 'bad id': 'x y', three: 'https://example.com' } })
  assert.equal(status.target, 'three')
  assert.equal(status.state, 'paused')
  assert.deepEqual(status.stages, { one: 'paused', two: 'waiting' })
  assert.equal('stages' in sessionStatus({ session: 's-2', who: 'a' }), false, 'a status without a run is as it was before')
})

test("a Stage's decisions log keeps the run in its own status entry", () => {
  const log = applyDecisionsDelta(emptyDecisionsLog('one'), { status: { session: 's-1', who: 'A', target: 'two', state: 'saved', stages: { one: 'done', two: 'waiting' } } }, 'one')
  assert.deepEqual(log.status[0].stages, { one: 'done', two: 'waiting' })
  assert.equal(log.status[0].target, 'two')
})

test("the session's Save sends the run's target and each Stage's state", () => {
  const session = createInterviewSession({ providerId: 'p', getContext: () => ({ stageId: 'one', actor: 'a.architect', artefactId: 'soap', targetStageId: 'one' }) })
  const status = session.decisionsDelta({ runState: 'saved', saving: true, target: 'three', stages: { one: 'done', two: 'waiting', three: 'waiting' } }).status
  assert.equal(status.target, 'three')
  assert.equal(status.state, 'saved')
  assert.deepEqual(status.stages, { one: 'done', two: 'waiting', three: 'waiting' })
  const plain = session.decisionsDelta({}).status
  assert.equal(plain.target, 'one', 'with no run given it is the context target, as before')
})

test('a run left paused is found from the Stage logs: advance first when the Stage was saved and stopped, interview this Stage when the run had already moved on', () => {
  const log = (state, target) => ({ status: [{ session: 's', state, target }] })
  // saved with "Save and stop here" on the current Stage
  assert.deepEqual(resumableRun({ stages: STAGES, currentStageId: 'one', logs: { one: log('paused', 'three') } }), { mode: 'advance', targetStageId: 'three', fromStageId: 'one' })
  // saved, advance chosen, but the advance never happened
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'one', logs: { one: log('saved', 'three') } }).mode, 'advance')
  // the previous Stage carried on (or was paused) and this Stage has no log yet
  assert.deepEqual(resumableRun({ stages: STAGES, currentStageId: 'two', logs: { one: log('saved', 'three'), two: emptyDecisionsLog('two') } }), { mode: 'continue', targetStageId: 'three', fromStageId: 'one' })
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'two', logs: { one: log('paused', 'three') } }).mode, 'continue')
})

test('a Pause part-way through a Stage (#290) is not a run to resume: that Stage is still in progress', () => {
  const paused = { status: [{ session: 's', state: 'paused', target: 'three', stages: { one: 'in-progress', two: 'waiting', three: 'waiting' } }] }
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'one', logs: { one: paused } }), null)
})

test('a finished run, a run of one Stage and a run already under way are not offered for resuming', () => {
  const log = (state, target) => ({ status: [{ session: 's', state, target }] })
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'three', logs: { three: log('done', 'three'), two: log('saved', 'three') } }), null, 'the target was confirmed')
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'one', logs: { one: log('done', 'one') } }), null)
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'one', logs: {} }), null)
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'three', logs: { two: log('saved', 'two') } }), null, 'the previous run stopped at its own target')
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'three', logs: { two: log('saved', 'four'), three: log('saved', 'three') } }), null, 'this Stage has its own log, which says the run ended')
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'nope', logs: {} }), null)
})

test('#331 a run resumed elsewhere takes its opening message from the status block of the last Save, and none when it had none', () => {
  const words = 'Focus on the hosting decision.'
  let log = applyDecisionsDelta(emptyDecisionsLog('one'), { status: { session: 's-1', who: 'Alex', state: 'paused', target: 'three', opening: words } }, 'one')
  assert.equal(runOpening(log), words)
  log = applyDecisionsDelta(log, { status: { session: 's-2', who: 'Alex', state: 'saved', target: 'three' } }, 'one')
  assert.equal(runOpening(log), '', 'the newest session is the run, and it had none')
  assert.equal(runOpening(null), '')
  assert.equal(runOpening(emptyDecisionsLog('one')), '')
})

test('the run held in the tab is replaced, changed and cleared by Instance', () => {
  try {
    beginRun('inst', { target: 'three', startStageId: 'one', providerId: 'p' })
    assert.deepEqual(getRun('inst'), { carryOn: null, phase: 'running', target: 'three', startStageId: 'one', providerId: 'p' })
    updateRun('inst', { carryOn: 'two' })
    assert.equal(getRun('inst').carryOn, 'two')
    updateRun('other', { carryOn: 'x' })
    assert.equal(getRun('other'), null, 'changing a run that does not exist starts nothing')
    clearRun('inst')
    assert.equal(getRun('inst'), null)
  } finally {
    interviewRuns.value = {}
  }
})

test("the user guide's The AI interview section covers Run until, the run plan, the two buttons, pausing and the status block", () => {
  const guide = readFileSync('docs/user-guide/index.md', 'utf8')
  const section = guide.slice(guide.indexOf('## The AI interview'), guide.indexOf('## Settings'))
  for (const phrase of ['**Run until.**', '### Running until a later Stage', '**Run plan.**', 'Save, advance, carry on', 'Save and stop here', 'Resume the run', 'own decisions log', '**run target**']) {
    assert.ok(section.includes(phrase), `the guide's AI interview section says ${phrase}`)
  }
})
