import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { artefactRows, beginRun, chosenArtefacts, clearRun, getRun, interviewRuns, nextStage, planRows, resumableRun, resumedArtefacts, runArtefacts, runIsDone, runOpening, runTargets, saveOutcome, updateRun } from '../web/lib/interviewRun.js'
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

// #332: a Definition whose Stages have one candidate, two, or none at their Gates.
const CHOICE_DEFINITION = {
  stages: [
    { id: 'one', title: 'One', gate: 'g1' },
    { id: 'two', title: 'Two', gate: 'g2' },
    { id: 'three', title: 'Three', gate: 'g3' },
    { id: 'four', title: 'Four', gate: 'g4' },
  ],
  artefacts: [
    { id: 'brief', title: 'Brief', gate: 'g1', requires: ['a'] },
    { id: 'full', title: 'Full', gate: 'g2', requires: ['a', 'b', 'c'] },
    { id: 'light', title: 'Light', gate: 'g2', requires: ['a'] },
    { id: 'no-pass', title: 'No pass', gate: 'g3', satisfiesGate: false },
  ],
}

test('#332 the kickoff has one Artefact row per Stage of the run, labelled with its gate, each aiming for the lightest unless another is chosen', () => {
  const stages = CHOICE_DEFINITION.stages
  const one = artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'one', targetStageId: 'one' })
  assert.deepEqual(one.map((r) => [r.id, r.gate, r.chosen?.id]), [['one', 'g1', 'brief']], 'a run of one Stage still has its row')
  const rows = artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'one', targetStageId: 'three' })
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.gate, r.candidates.map((a) => a.id), r.lightest?.id ?? null, r.chosen?.id ?? null]), [
    ['one', 'One', 'g1', ['brief'], 'brief', 'brief'],
    ['two', 'Two', 'g2', ['full', 'light'], 'light', 'light'],
    ['three', 'Three', 'g3', [], null, null],
  ])
  assert.deepEqual(chosenArtefacts(rows), { one: 'brief', two: 'light' }, 'a Stage no Artefact can pass is left out')

  const picked = artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'one', targetStageId: 'two', picked: { two: 'full' } })
  assert.equal(picked[1].chosen.id, 'full')
  const remembered = artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'two', targetStageId: 'two', remembered: { two: 'full' } })
  assert.equal(remembered[0].chosen.id, 'full', 'what the run already chose')
  const both = artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'two', targetStageId: 'two', picked: { two: 'light' }, remembered: { two: 'full' } })
  assert.equal(both[0].chosen.id, 'light', "the architect's pick on this kickoff wins")
  const wrong = artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'one', targetStageId: 'two', picked: { one: 'full', two: 'brief' } })
  assert.deepEqual(chosenArtefacts(wrong), { one: 'brief', two: 'light' }, 'an Artefact that cannot pass the Gate is not used')
  assert.deepEqual(artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'three', targetStageId: 'one' }).map((r) => r.id), ['three'], 'a target behind the current Stage is a run of one')
  assert.deepEqual(artefactRows({ definition: CHOICE_DEFINITION, stages, currentStageId: 'nope', targetStageId: 'two' }), [])
})

test('#332 the status block keeps the Artefact chosen for each Stage of the run, and a run resumed elsewhere reads them back', () => {
  const status = sessionStatus({ session: 's-1', target: 'two', artefact: 'brief', artefacts: { one: 'brief', two: 'full', 'bad id': 'x', three: 'https://example.com' } })
  assert.deepEqual(status.artefacts, { one: 'brief', two: 'full' }, 'Stage and Artefact ids only')
  assert.equal(sessionStatus({ session: 's-1' }).artefacts, undefined, 'none when no run chose any')

  let log = applyDecisionsDelta(emptyDecisionsLog('one'), { status: { session: 's-1', who: 'Alex', state: 'paused', target: 'two', artefact: 'brief', artefacts: { one: 'brief', two: 'full' } } }, 'one')
  assert.deepEqual(runArtefacts(log, 'one'), { one: 'brief', two: 'full' })
  log = applyDecisionsDelta(emptyDecisionsLog('two'), { status: { session: 's-0', who: 'Alex', state: 'paused', target: 'two', artefact: 'full' } }, 'two')
  assert.deepEqual(runArtefacts(log, 'two'), { two: 'full' }, 'a log from before the choice per Stage still says what its Stage aimed for')
  assert.deepEqual(runArtefacts(null, 'one'), {})

  const session = createInterviewSession({ providerId: 'p', getContext: () => ({ stageId: 'two', actor: 'a.architect', artefactId: 'full', runArtefacts: { one: 'brief', two: 'full' }, targetStageId: 'two' }) })
  const sent = session.decisionsDelta({ runState: 'paused', saving: true }).status
  assert.equal(sent.artefact, 'full', 'the Stage records the Artefact it aims for')
  assert.deepEqual(sent.artefacts, { one: 'brief', two: 'full' })
})

test('#332 Resume the run keeps the Artefact the run chose for each Stage, unless the architect chooses another on the kickoff', () => {
  const stages = CHOICE_DEFINITION.stages
  // Paused on One after its Save, in a run to Two that chose the heavier Artefact for Two.
  const log = applyDecisionsDelta(emptyDecisionsLog('one'), { status: { session: 's-1', who: 'Alex', state: 'paused', target: 'two', artefact: 'brief', artefacts: { one: 'brief', two: 'full' } } }, 'one')
  const resume = (extra) => resumedArtefacts({ definition: CHOICE_DEFINITION, stages, currentStageId: 'two', targetStageId: 'two', log, fromStageId: 'one', ...extra })
  assert.deepEqual(resume(), { one: 'brief', two: 'full' }, 'the run carries on aiming Two at what it chose, not the lightest')
  // The kickoff is between sessions: its rows can still be changed, as Run until can.
  assert.deepEqual(resume({ picked: { two: 'light' } }), { one: 'brief', two: 'light' }, "the architect's pick on the resume kickoff wins")
  assert.deepEqual(resume({ picked: { two: 'brief' } }), { one: 'brief', two: 'full' }, 'a pick that cannot pass the Gate is not used')
  // Run until moved on to a Stage the run never chose for: it aims for its lightest; one with no candidate has none.
  assert.deepEqual(resume({ targetStageId: 'four' }), { one: 'brief', two: 'full' })
  const further = resumedArtefacts({ definition: { ...CHOICE_DEFINITION, artefacts: [...CHOICE_DEFINITION.artefacts, { id: 'last', gate: 'g4' }] }, stages, currentStageId: 'two', targetStageId: 'four', log, fromStageId: 'one' })
  assert.deepEqual(further, { one: 'brief', two: 'full', four: 'last' })
  assert.deepEqual(resumedArtefacts({ definition: CHOICE_DEFINITION, stages, currentStageId: 'two', targetStageId: 'two', log: null, fromStageId: 'one' }), { two: 'light' }, 'no log: the lightest')
})

// #355: the one rule for "the run is done" on the Interview page, which swaps Pause and Finish with your recommendations for Open in the
// editor and Re-open <Stage>, and disables the chat box.
const doneLog = (state, extra = {}) => ({ status: [{ session: 's-1', target: 'two', state, stages: { two: state }, ...extra }] })

test('#355 a Save made on this page says whether the run is done: at its target, single-Stage runs included', () => {
  // A run of one Stage: the start is its target, so the one Save finishes it.
  const single = saveOutcome({ stages: STAGES, currentStageId: 'two', targetStageId: 'two', startStageId: 'two', action: 'stop' })
  assert.equal(single.finished, true)
  assert.equal(runIsDone({ stageId: 'two', saving: { phase: 'saved', finished: single.finished } }), true, 'a run of one Stage is done after its Save')
  // A run to a later Stage, saved and stopped before it: paused, not done (Resume the run is the way on).
  const before = saveOutcome({ stages: STAGES, currentStageId: 'two', targetStageId: 'three', startStageId: 'two', action: 'stop' })
  assert.equal(runIsDone({ stageId: 'two', saving: { phase: 'saved', finished: before.finished } }), false)
  // A remote Save at the target is done whether approval was asked for, queued behind an earlier Stage, or failed: the card's own actions stay.
  for (const saved of [{ approval: 'requested' }, { approval: 'queued' }, { approval: null }, { approval: 'requested', approvalError: 'no' }]) {
    assert.equal(runIsDone({ stageId: 'two', remote: true, saving: { phase: 'saved', finished: true, ...saved } }), true)
  }
  // Anything else this page is doing is not a done run: a Save going, a Pause, a Save that failed, moving on or drafting ahead.
  for (const phase of ['saving', 'paused', 'error', 'advancing', 'drafting-ahead']) {
    assert.equal(runIsDone({ stageId: 'two', saving: { phase }, log: doneLog('done') }), false, phase)
  }
})

test('#355 with no Save on this page, the run in this tab says, else (at the kickoff, after a reload) the decisions log', () => {
  // Back on the page in the same tab: the run this tab holds finished here.
  assert.equal(runIsDone({ stageId: 'two', run: { phase: 'done', at: 'two' }, started: true }), true)
  assert.equal(runIsDone({ stageId: 'two', run: { phase: 'running', at: 'two' }, started: true, log: doneLog('done') }), false, 'a new run on the Stage is going')
  assert.equal(runIsDone({ stageId: 'two', run: { phase: 'paused', at: 'two' }, log: doneLog('done') }), false)
  // A run carrying on into this Stage starts it, whatever an earlier run's log said.
  assert.equal(runIsDone({ stageId: 'two', run: { phase: 'running', at: 'one', carryOn: 'two' }, log: doneLog('done') }), false)
  // A reload: the tab holds no run, the page is at the kickoff, and the log's newest status line is the done one.
  assert.equal(runIsDone({ stageId: 'two', log: doneLog('done') }), true)
  assert.equal(runIsDone({ stageId: 'two', run: { phase: 'done', at: 'one' }, log: doneLog('done') }), true, "a run elsewhere in the tab doesn't change this Stage's")
  for (const state of ['paused', 'saved', 'in-progress', 'awaiting-approval', 'approval-queued', 'head-start']) {
    assert.equal(runIsDone({ stageId: 'two', log: doneLog(state) }), false, state)
  }
  assert.equal(runIsDone({ stageId: 'two', log: null }), false, 'a Stage never interviewed')
  assert.equal(runIsDone({ stageId: 'two', log: { status: [...doneLog('done').status, { session: 's-2', state: 'paused', stages: { two: 'in-progress' } }] } }), false, 'a later session paused part-way')
  // A session going without a run here, and a remote workspace, whose Provider (not the log) says where approval stands, do not read the log.
  assert.equal(runIsDone({ stageId: 'two', started: true, log: doneLog('done') }), false)
  assert.equal(runIsDone({ stageId: 'two', remote: true, log: doneLog('done') }), false)
})

test('#355 Re-open <Stage> ends the done state until the next Save finishes the run again', () => {
  assert.equal(runIsDone({ stageId: 'two', reopened: true, log: doneLog('done') }), false)
  assert.equal(runIsDone({ stageId: 'two', reopened: true, run: { phase: 'done', at: 'two' } }), false)
  assert.equal(runIsDone({ stageId: 'two', reopened: true, saving: { phase: 'saved', finished: true } }), true, "the re-opened Stage's own Save at the target")
})

test("#355 the user guide's The AI interview section says what you can do when the run is done", () => {
  const guide = readFileSync('docs/user-guide/index.md', 'utf8')
  const section = guide.slice(guide.indexOf('## The AI interview'), guide.indexOf('## Settings'))
  for (const phrase of ['**When the run is done.**', '**Open in the editor**', '**Re-open <Stage>**', 'Saved. The run is done.', 'paused, not done']) {
    assert.ok(section.includes(phrase), `the guide's AI interview section says ${phrase}`)
  }
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
