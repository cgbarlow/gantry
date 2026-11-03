import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalIsOpen, heldModules, heldModulesRefusal, isDraftingAhead, pendingStagesBefore, withHeldModules } from '../web/lib/draftAhead.js'
import { buildInterviewBrief } from '../web/lib/interviewBrief.js'
import { fieldsInScope } from '../web/lib/interviewScope.js'
import { planRows, saveOutcome } from '../web/lib/interviewRun.js'
import { remoteRecord } from '../web/lib/interviewApproval.js'
import { createSessionLog } from '../web/lib/interviewLog.js'
import { applyDecisionsDelta, emptyDecisionsLog } from '../web/lib/decisionsLog.js'
import { readFileSync } from 'node:fs'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'

// #296 (parent #238, docs/adr/0063): drafting ahead. While an earlier Stage awaits approval, a later Stage gets a head start only: the
// Modules no pending Stage mounts. The rules, with no DOM and no network.

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const STAGES = [
  { id: 's1', title: 'Scope', gate: 'g1', modules: ['intro', 'shared', 'scope-only'] },
  { id: 's2', title: 'Shape', gate: 'g2', modules: ['shared', 'shape-only', 'ro'], readOnlyModules: ['ro'] },
  { id: 's3', title: 'Ship', gate: 'g3', modules: ['shared', 'shape-only', 'ship-only', 'scope-only'] },
]

test('a Stage is drafted ahead when it comes after the Stage the Instance is on', () => {
  assert.equal(isDraftingAhead(STAGES, 's2', 's1'), true)
  assert.equal(isDraftingAhead(STAGES, 's3', 's1'), true)
  assert.equal(isDraftingAhead(STAGES, 's1', 's1'), false)
  assert.equal(isDraftingAhead(STAGES, 's1', 's2'), false, 'a Stage already passed is not ahead')
  assert.equal(isDraftingAhead(STAGES, 'nope', 's1'), false)
})

test('the pending Stages are those from the Instance\'s Stage up to the one before the Stage drafted ahead', () => {
  assert.deepEqual(pendingStagesBefore(STAGES, 's2', 's1').map((s) => s.id), ['s1'])
  assert.deepEqual(pendingStagesBefore(STAGES, 's3', 's1').map((s) => s.id), ['s1', 's2'])
  assert.deepEqual(pendingStagesBefore(STAGES, 's3', 's2').map((s) => s.id), ['s2'])
  assert.deepEqual(pendingStagesBefore(STAGES, 's1', 's1'), [])
})

test('a Module is held when a pending Stage can also edit it: shared Modules wait, the rest is the head start', () => {
  assert.deepEqual(heldModules(STAGES, 's2', 's1'), [{ id: 'shared', stageId: 's1', stageTitle: 'Scope' }])
  // Read-only here is not the Stage's to write, so it is never held (it is not editable either way).
  assert.ok(!heldModules(STAGES, 's2', 's1').some((h) => h.id === 'ro'))
  // Two Stages ahead: what Scope or Shape can edit is held, and the Stage whose approval opens it is the earliest that mounts it.
  assert.deepEqual(heldModules(STAGES, 's3', 's1'), [
    { id: 'shared', stageId: 's1', stageTitle: 'Scope' },
    { id: 'shape-only', stageId: 's2', stageTitle: 'Shape' },
    { id: 'scope-only', stageId: 's1', stageTitle: 'Scope' },
  ])
  // Once Scope has merged and the Instance is on Shape, only Shape's own Modules are pending for Ship.
  assert.deepEqual(heldModules(STAGES, 's3', 's2').map((h) => h.id), ['shared', 'shape-only'])
  assert.deepEqual(heldModules(STAGES, 's2', 's2'), [], 'nothing is held on the Stage the Instance is on')
})

test('a write to a held Module is refused with a message naming the Stage whose approval opens it; the head start is not', () => {
  const stage = STAGES[1]
  const title = (id) => id.toUpperCase()
  assert.equal(heldModulesRefusal(STAGES, stage, 's1', ['shape-only'], title), null)
  const refusal = heldModulesRefusal(STAGES, stage, 's1', ['shape-only', 'shared'], title)
  assert.match(refusal, /Stage "Shape" \(s2\) is being drafted ahead/)
  assert.match(refusal, /"SHARED" \(shared\) with Stage "Scope" \(s1\)/)
  assert.doesNotMatch(refusal, /shape-only/)
  assert.equal(heldModulesRefusal(STAGES, STAGES[0], 's1', ['shared'], title), null, "the Instance's own Stage is never held")
})

test('the AI sees held Modules as read-only on a Stage drafted ahead, and the Stage carries why', () => {
  const definition = {
    stages: STAGES,
    modules: STAGES.flatMap((s) => s.modules).filter((m, i, all) => all.indexOf(m) === i).map((id) => ({ id, title: id, fields: [{ id: 'body', title: 'Body', type: 'markdown' }] })),
  }
  const held = heldModules(STAGES, 's2', 's1')
  const view = withHeldModules(definition, 's2', held)
  assert.deepEqual([...fieldsInScope(view, 's2').keys()], ['shape-only.body'])
  assert.deepEqual([...fieldsInScope(definition, 's2').keys()], ['shared.body', 'shape-only.body'], 'the Definition itself is not changed')
  assert.equal(withHeldModules(definition, 's2', []), definition, 'nothing held leaves the Definition as it is')
  assert.deepEqual(view.stages.find((s) => s.id === 's2').heldModules, held)
  assert.deepEqual(view.stages.find((s) => s.id === 's1'), STAGES[0])
})

test('a Pull Request is open when it is on file and not completed or abandoned', () => {
  assert.equal(approvalIsOpen({ pullRequests: { s1: 4 } }, 's1'), true)
  assert.equal(approvalIsOpen({ pullRequests: { s1: 4 }, pullRequestStatuses: { s1: 'active' } }, 's1'), true)
  assert.equal(approvalIsOpen({ pullRequests: { s1: 4 }, pullRequestStatuses: { s1: 'completed' } }, 's1'), false)
  assert.equal(approvalIsOpen({ pullRequests: { s1: 4 }, pullRequestStatuses: { s1: 'abandoned' } }, 's1'), false)
  assert.equal(approvalIsOpen({ pullRequests: {} }, 's1'), false)
  assert.equal(approvalIsOpen(null, 's1'), false)
})

test('the brief tells the AI it has a head start only, which Modules are held and until which Stage is approved', () => {
  const definition = {
    id: 'demo',
    stages: STAGES.map((s) => ({ ...s, purpose: `Purpose of ${s.title}` })),
    artefacts: [],
    modules: ['intro', 'shared', 'scope-only', 'shape-only', 'ro', 'ship-only'].map((id) => ({ id, title: `T-${id}`, fields: [{ id: 'body', title: 'Body', type: 'markdown' }] })),
  }
  const view = withHeldModules(definition, 's2', heldModules(definition.stages, 's2', 's1'))
  const brief = buildInterviewBrief({ definition: view, stageId: 's2', size: 'medium', saved: [], sources: [], skills })
  assert.match(brief.text, /Head start only: this Stage is being drafted ahead, while Scope awaits approval/)
  assert.match(brief.text, /T-shared \(`shared`, held until Scope is approved\)/)
  assert.match(brief.text, /### T-shared \(`shared`, held until Scope is approved\)/)
  assert.doesNotMatch(brief.text, /`shared\.body` "Body"/, 'the held Module\'s Fields are not listed as the AI\'s to draft')
  assert.match(brief.text, /`shape-only\.body`/)
  const plain = buildInterviewBrief({ definition, stageId: 's2', size: 'medium', saved: [], sources: [], skills })
  assert.doesNotMatch(plain.text, /Head start only/)
})

test('the run plan shows a Stage the Instance has not moved past as awaiting approval or queued, and the Stage being drafted ahead as drafting ahead', () => {
  const stages = STAGES.map(({ id, title }) => ({ id, title }))
  const remote = remoteRecord({
    instance: { workspaceBacked: true, workspace: { owner: 'a', repository: 'r' }, stage: { id: 's3' }, currentStageId: 's1', pullRequests: { s1: 9 } },
    stages,
    logs: { s2: { status: [{ state: 'approval-queued' }] } },
  })
  assert.deepEqual(Object.keys(remote.pullRequests), ['s1'], "the open Pull Request is the Instance's current Stage's, though the page is on Ship")
  assert.deepEqual(remote.queued, { s2: true })
  const rows = planRows({ stages, currentStageId: 's3', targetStageId: 's3', current: 'drafting-ahead', remote, instanceStageId: 's1' })
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['s1', 'awaiting-approval'], ['s2', 'approval-queued'], ['s3', 'drafting-ahead']])
  assert.equal(rows[0].checkable, true, 'the row of the Stage under review still runs Check status')
  assert.equal(rows[0].pullRequest.id, 9)
  assert.equal(rows[2].note, 'drafting ahead · target')

  const waiting = planRows({ stages, currentStageId: 's2', targetStageId: 's3', current: 'waiting-for-approval', remote: { pullRequests: {} }, instanceStageId: 's1' })
  assert.deepEqual(waiting.map((r) => r.state), ['awaiting-approval', 'waiting-for-approval', 'waiting'], 'with no Pull Request on this branch, the Instance\'s own Stage is still not done')
  assert.equal(waiting[1].note, 'waiting for approval')

  // A Stage that saved a head start shows as waiting for approval when the page is elsewhere.
  const logged = remoteRecord({ instance: { workspaceBacked: true, stage: { id: 's1' }, currentStageId: 's1', pullRequests: {} }, stages, logs: { s2: { status: [{ state: 'head-start' }] } } })
  assert.deepEqual(logged.headStart, { s2: true })
  assert.equal(planRows({ stages, currentStageId: 's1', targetStageId: 's3', current: 'drafting', remote: logged })[1].state, 'waiting-for-approval')
})

test("saving a head start leaves the Stage waiting, not finished, even at the run's target", () => {
  const stages = STAGES.map(({ id, title }) => ({ id, title }))
  const outcome = saveOutcome({ stages, currentStageId: 's2', targetStageId: 's2', startStageId: 's1', action: 'head-start', instanceStageId: 's1' })
  assert.equal(outcome.state, 'head-start')
  assert.equal(outcome.requestsApproval, false)
  assert.equal(outcome.advances, false)
  assert.deepEqual(outcome.stages, { s1: 'awaiting-approval', s2: 'head-start' })
  // The full Save after the earlier Stage merged is the ordinary one.
  const full = saveOutcome({ stages, currentStageId: 's2', targetStageId: 's2', startStageId: 's1', action: 'approval' })
  assert.deepEqual([full.state, full.finished, full.requestsApproval], ['done', true, true])
})

test('a Stage can have more than one AI Save, and its decisions log records each', () => {
  let tick = 0
  const at = () => `2026-11-02T10:0${tick++}:00.000Z`
  const log = createSessionLog({ now: at, newSessionId: () => 's-one', who: () => 'a.architect' })
  const first = log.delta({ saving: true, status: { who: 'a.architect', target: 's2', state: 'head-start' } })
  assert.deepEqual(first.status.saves, ['2026-11-02T10:00:00.000Z'])
  // A Save that failed and is tried again is one Save, not two.
  const retried = log.delta({ saving: true, status: { who: 'a.architect', target: 's2', state: 'head-start' } })
  assert.equal(retried.status.saves.length, 1)
  log.commit(retried)
  const second = log.delta({ saving: true, status: { who: 'a.architect', target: 's2', state: 'awaiting-approval' } })
  assert.equal(second.status.saves.length, 2)
  assert.equal(second.status.lastAiSave, second.status.saves[1])

  // The file keeps both on the session's one status line.
  let file = applyDecisionsDelta(emptyDecisionsLog('s2'), first, 's2')
  file = applyDecisionsDelta(file, second, 's2')
  assert.equal(file.status.length, 1)
  assert.deepEqual(file.status[0].saves, second.status.saves)
  assert.equal(file.status[0].state, 'awaiting-approval')

  // A session that takes over (a resume in another browser) carries on the count.
  const resumed = createSessionLog({ now: at, newSessionId: () => 's-two' })
  resumed.adopt(file.status[0])
  assert.equal(resumed.delta({ saving: true, status: {} }).status.saves.length, 3)
})

test("the user guide's The AI interview section covers drafting ahead, the head start, the Waiting card and two AI Saves", () => {
  const guide = readFileSync('docs/user-guide/index.md', 'utf8')
  const section = guide.slice(guide.indexOf('## The AI interview'), guide.indexOf('## Settings'))
  for (const phrase of ['### Drafting ahead', 'head start', 'held', 'Gantry refuses any write to it', 'The Waiting card', 'Check approval now', 'Stop here', 'more than one AI Save', 'Drafting ahead']) {
    assert.ok(section.includes(phrase), `the guide's AI interview section says ${phrase}`)
  }
})
