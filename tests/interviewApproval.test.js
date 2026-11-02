import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { approvalStatusLine, lastSavedBy, openApproval, pullRequestLink, remoteRecord, withLastSaved } from '../web/lib/interviewApproval.js'
import { planRows, resumableRun, saveOutcome } from '../web/lib/interviewRun.js'
import { applyDecisionsDelta, emptyDecisionsLog } from '../web/lib/decisionsLog.js'

// #295 (parent #238, docs/adr/0063): the AI interview on Azure DevOps and GitHub workspaces. The rules for approvals in a session, with no DOM.

const STAGES = [
  { id: 'one', title: 'One' },
  { id: 'two', title: 'Two' },
  { id: 'three', title: 'Three' },
]
const ado = { organization: 'acme', project: 'proj', repository: 'repo' }
const gh = { owner: 'acme', repository: 'repo' }
const instance = (over = {}) => ({ workspaceBacked: true, workspace: ado, stage: { id: 'one' }, currentStageId: 'one', pullRequests: {}, pullRequest: null, ...over })
const log = (state, target = 'three') => ({ status: [{ session: 's', state, target }] })

test('a Pull Request is linked on Azure DevOps and on GitHub, and on neither when the workspace is unknown', () => {
  assert.equal(pullRequestLink(instance(), 7), 'https://dev.azure.com/acme/proj/_git/repo/pullrequest/7')
  assert.equal(pullRequestLink(instance({ workspace: { ...ado, baseUrl: 'http://ado.test' } }), 7), 'http://ado.test/acme/proj/_git/repo/pullrequest/7')
  assert.equal(pullRequestLink(instance({ workspace: gh }), 7), 'https://github.com/acme/repo/pull/7')
  assert.equal(pullRequestLink(instance({ workspace: { ...gh, baseUrl: 'https://ghe.test/api/v3' } }), 7), 'https://ghe.test/acme/repo/pull/7')
  assert.equal(pullRequestLink(instance({ workspace: null }), 7), null)
  assert.equal(pullRequestLink(instance(), 0), null)
})

test("the Provider says whether the current Stage is awaiting approval: a Pull Request on file that is still active, for the Instance's current Stage", () => {
  assert.equal(openApproval(instance()), null, 'no Pull Request yet')
  assert.deepEqual(openApproval(instance({ pullRequests: { one: 4 } })), { id: 4, url: 'https://dev.azure.com/acme/proj/_git/repo/pullrequest/4' })
  assert.equal(openApproval(instance({ pullRequests: { one: 4 }, pullRequest: { status: 'active' } })).id, 4)
  assert.equal(openApproval(instance({ pullRequests: { one: 4 }, pullRequest: { status: 'abandoned' } })), null, 'an abandoned Pull Request is not awaiting anyone')
  assert.equal(openApproval(instance({ stage: { id: 'two' }, pullRequests: { two: 5 } })), null, 'a Stage that is not the current one is never awaiting, only queued')
  assert.equal(openApproval({ workspaceBacked: false, stage: { id: 'one' }, currentStageId: 'one', pullRequests: { one: 4 } }), null, 'a local or server workspace has none')
})

test("the run plan takes the Provider's word over the log's: a Pull Request open means awaiting approval, a queued later Stage shows Approval queued", () => {
  const remote = remoteRecord({ instance: instance({ pullRequests: { one: 4 } }), stages: STAGES, logs: { one: log('saved'), two: log('approval-queued') } })
  assert.deepEqual(Object.keys(remote.pullRequests), ['one'])
  assert.deepEqual(remote.queued, { two: true })
  const rows = planRows({ stages: STAGES, currentStageId: 'one', targetStageId: 'three', current: 'idle', remote })
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['one', 'awaiting-approval'], ['two', 'approval-queued'], ['three', 'waiting']])
  assert.deepEqual(rows[0].pullRequest, { id: 4, url: 'https://dev.azure.com/acme/proj/_git/repo/pullrequest/4' })
  assert.equal(rows[0].checkable, true, 'an awaiting-approval row is the one that runs Check status')
  assert.deepEqual(rows.map((r) => r.checkable), [true, false, false])
  assert.equal(rows[0].note, 'awaiting approval')
  assert.equal(rows[1].note, 'approval queued')

  // The log says the Stage was awaiting approval, but the Provider has no Pull Request: the log does not make it so.
  const none = remoteRecord({ instance: instance(), stages: STAGES, logs: { one: log('awaiting-approval') } })
  assert.equal(planRows({ stages: STAGES, currentStageId: 'one', targetStageId: 'three', current: 'idle', remote: none })[0].state, 'waiting')
  // A queued Stage that already has its Pull Request on file is not queued any more.
  assert.deepEqual(remoteRecord({ instance: instance({ pullRequests: { one: 4, two: 5 } }), stages: STAGES, logs: { two: log('approval-queued') } }).queued, {})
  // The newest session line is the one that counts.
  assert.deepEqual(remoteRecord({ instance: instance(), stages: STAGES, logs: { two: { status: [{ state: 'approval-queued' }, { state: 'paused' }] } } }).queued, {})
})

test('a plan with no Provider record is as it was for a local or server workspace', () => {
  const rows = planRows({ stages: STAGES, currentStageId: 'two', targetStageId: 'three', current: 'drafting' })
  assert.deepEqual(rows.map((r) => [r.state, r.pullRequest, r.checkable]), [['done', null, false], ['drafting', null, false], ['waiting', null, false]])
})

test('Save, request approval waits for the Owner: the Stage is awaiting approval, never advanced, and at the target the run is done', () => {
  const base = { stages: STAGES, currentStageId: 'one', targetStageId: 'three', startStageId: 'one', action: 'approval' }
  const asked = saveOutcome(base)
  assert.deepEqual([asked.state, asked.finished, asked.advances, asked.requestsApproval, asked.nextStageId], ['awaiting-approval', false, false, true, null])
  assert.deepEqual(asked.stages, { one: 'awaiting-approval', two: 'waiting', three: 'waiting' })

  const queued = saveOutcome({ ...base, currentStageId: 'two', queued: true })
  assert.deepEqual([queued.state, queued.requestsApproval], ['approval-queued', true])
  assert.deepEqual(queued.stages, { one: 'done', two: 'approval-queued', three: 'waiting' })

  const last = saveOutcome({ ...base, currentStageId: 'three' })
  assert.deepEqual([last.state, last.finished, last.advances, last.requestsApproval], ['done', true, false, true])
  assert.equal(last.stages.three, 'awaiting-approval', 'the target is done as a session, and its approval is still the Owner\'s')

  const stop = saveOutcome({ ...base, action: 'stop' })
  assert.deepEqual([stop.state, stop.requestsApproval], ['paused', false], 'Save and stop here asks for nothing')
  const local = saveOutcome({ ...base, action: 'advance' })
  assert.deepEqual([local.state, local.advances, local.requestsApproval], ['saved', true, false], 'a local or server workspace is unchanged')
})

test('the status block records a Stage awaiting approval or queued, and nothing but safe words', () => {
  const awaiting = applyDecisionsDelta(emptyDecisionsLog('one'), { status: { session: 's-1', who: 'A', target: 'three', state: 'awaiting-approval', stages: { one: 'awaiting-approval', two: 'waiting' } } }, 'one')
  assert.equal(awaiting.status[0].state, 'awaiting-approval')
  assert.deepEqual(awaiting.status[0].stages, { one: 'awaiting-approval', two: 'waiting' })
  const queued = applyDecisionsDelta(emptyDecisionsLog('two'), { status: { session: 's-2', who: 'A', target: 'three', state: 'approval-queued' } }, 'two')
  assert.equal(queued.status[0].state, 'approval-queued')
})

test('resuming: a Stage that was waiting for approval continues on the next Stage once the Owner has approved; the Provider overrides the log', () => {
  // The Owner approved: the Instance is on Stage two, whose log is empty, and the log of Stage one says it was awaiting approval.
  assert.deepEqual(resumableRun({ stages: STAGES, currentStageId: 'two', logs: { one: log('awaiting-approval'), two: emptyDecisionsLog('two') } }), { mode: 'continue', targetStageId: 'three', fromStageId: 'one' })
  // Still waiting: the Provider has a Pull Request open for Stage one, so there is nothing to resume from the log.
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'one', logs: { one: log('awaiting-approval') }, openPullRequests: { one: { id: 4 } } }), null)
  // The log says awaiting approval but the Provider has no Pull Request (the request failed, or it was closed): resuming asks again.
  assert.deepEqual(resumableRun({ stages: STAGES, currentStageId: 'one', logs: { one: log('awaiting-approval') } }), { mode: 'advance', targetStageId: 'three', fromStageId: 'one' })
  // The target's own Save ends the run whatever the Owner says.
  assert.equal(resumableRun({ stages: STAGES, currentStageId: 'three', logs: { three: log('done', 'three'), two: log('awaiting-approval', 'three') } }), null)
})

test('what a Check status answered, in a sentence', () => {
  assert.match(approvalStatusLine({ merged: true, pullRequestId: 4, advancedTo: { title: 'Two' } }), /Approved: Pull Request #4 merged, and the Instance moved on to Two\./)
  assert.match(approvalStatusLine({ merged: true, pullRequestId: 4 }), /final Stage/)
  assert.match(approvalStatusLine({ merged: false, pullRequestId: 4, review: { state: 'pending' } }), /Still pending: the Owner has not reviewed Pull Request #4 yet\./)
  assert.match(approvalStatusLine({ merged: false, pullRequestId: 4, review: { state: 'changes-requested' } }), /Changes requested/)
  assert.match(approvalStatusLine({ merged: false, pullRequestId: 4, review: { state: 'rejected' } }), /Rejected/)
  assert.match(approvalStatusLine({ merged: false, pullRequestId: 4, review: { state: 'approved-then-invalidated', approver: { displayName: 'Ola' } } }), /invalidated.*Ola/)
  assert.match(approvalStatusLine({ merged: false, waitingForStage: { title: 'One' }, pullRequestId: 5 }, 'Two'), /Two waits for the earlier Stage "One"/)
  assert.match(approvalStatusLine({ merged: true, pullRequestId: 4, advancedTo: { title: 'Two' }, queuedApproval: { opened: true, pullRequestId: 5, stage: { title: 'Two' } } }), /Two was queued for approval, so its Pull Request #5 is open now/)
  assert.match(approvalStatusLine({ merged: true, pullRequestId: 4, advancedTo: { title: 'Two' }, queuedApproval: { opened: false, error: 'the Gate has not passed', stage: { title: 'Two' } } }), /could not be opened: the Gate has not passed/)
})

test('who last saved a Stage is the commit author the Provider reports, else the name on the newest session line', () => {
  const read = { status: [{ session: 'a', who: 'First' }, { session: 'b', who: 'a.architect', lastAiSave: '2026-11-02T10:00:00Z' }] }
  assert.deepEqual(lastSavedBy(read), { by: 'a.architect', at: '2026-11-02T10:00:00Z' })
  assert.deepEqual(lastSavedBy(withLastSaved(read, { by: 'Fake Pusher', at: '2026-11-02T11:00:00Z' })), { by: 'Fake Pusher', at: '2026-11-02T11:00:00Z' })
  assert.equal(lastSavedBy(emptyDecisionsLog('one')), null, 'a Stage nobody has saved has no one')
  assert.equal(lastSavedBy(null), null)
  assert.equal(Object.keys(withLastSaved({ status: [] }, { by: 'x' })).includes('lastSaved'), false, 'it rides on the log without becoming part of it')
  assert.equal(JSON.stringify(withLastSaved({ status: [] }, { by: 'x' })), '{"status":[]}')
})

test("the user guide's The AI interview section covers approvals in a session", () => {
  const guide = readFileSync('docs/user-guide/index.md', 'utf8')
  const section = guide.slice(guide.indexOf('## The AI interview'), guide.indexOf('## Settings'))
  for (const phrase of ['### Approvals in a session', 'Save, request approval, draft ahead', 'Awaiting approval', 'Approval queued', 'Check status', 'never polls', 'Provider']) {
    assert.ok(section.includes(phrase), `the guide's AI interview section says ${phrase}`)
  }
})
