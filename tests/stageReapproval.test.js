import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reapprovalGate,
  reapprovalRecord,
  reapprovalDescription,
  primaryReviewerRecord,
  holdReviewForReapprovers,
  holdSummaryForReapprovers,
  waitingForReapproversMessage,
  pendingReapprovals,
  reapprovalHistory,
  pendingReapprovalSummary,
} from '../lib/stageReapproval.js'
import {
  reapprovingLine,
  requestedStatusWithReapproval,
  waitingForReapproversLine,
  reapprovalHistoryLine,
} from '../web/lib/changedSinceApproval.js'

// #275, docs/adr/0069 — the pure parts of re-approval: who a Pull Request still waits for, how that holds the review at
// pending, and how it is worded. The routes are covered end to end in tests/serverReapproval.test.js.

const soapOwner = { key: 'soap-owner', id: 'soap-owner', displayName: 'SOAP Owner', uniqueName: 'soap-owner' }
const hldOwner = { key: 'hld-owner', id: 'hld-owner', displayName: 'HLD Owner', uniqueName: 'hld-owner' }

function instanceWith(entries) {
  return {
    stage: 'hld-define',
    pullRequests: { 'hld-define': 7 },
    reapprovals: { shape: entries.map((e) => ({ by: 'hld-define', pullRequestId: 7, fields: ['background.problem'], title: 'SOAP', ...e })) },
  }
}

const githubPullRequest = (reviews) => ({ pullRequestId: 7, status: 'active', reviews })
const review = (login, state, at = '2026-11-02T10:00:00Z') => ({ user: { login }, state, submitted_at: at })

test('the Pull Request waits for the earlier stage reviewer and for its own reviewer, both', () => {
  const instance = instanceWith([{ reviewers: [soapOwner], primary: hldOwner }])
  const none = reapprovalGate('github', githubPullRequest([]), instance, 'hld-define', 7)
  assert.deepEqual(none.waitingFor.map((w) => [w.displayName, w.forStages]), [['HLD Owner', []], ['SOAP Owner', ['SOAP']]])

  const onlyOwn = reapprovalGate('github', githubPullRequest([review('hld-owner', 'APPROVED')]), instance, 'hld-define', 7)
  assert.deepEqual(onlyOwn.waitingFor.map((w) => w.displayName), ['SOAP Owner'])

  const both = reapprovalGate('github', githubPullRequest([review('hld-owner', 'APPROVED'), review('Soap-Owner', 'APPROVED')]), instance, 'hld-define', 7)
  assert.deepEqual(both.waitingFor, [])
})

test('an approval only counts if it is the reviewer latest word', () => {
  const instance = instanceWith([{ reviewers: [soapOwner] }])
  const changed = githubPullRequest([review('soap-owner', 'APPROVED', '2026-11-02T10:00:00Z'), review('soap-owner', 'CHANGES_REQUESTED', '2026-11-02T11:00:00Z')])
  assert.deepEqual(reapprovalGate('github', changed, instance, 'hld-define', 7).waitingFor.map((w) => w.displayName), ['SOAP Owner'])
})

test('Azure DevOps reads a reviewer vote of 5 or more as approval, matched by reviewer id', () => {
  const instance = instanceWith([{ reviewers: [{ ...soapOwner, key: 'abc-123', id: 'ABC-123' }] }])
  const pullRequest = (vote) => ({ pullRequestId: 7, status: 'active', reviewers: [{ id: 'abc-123', vote }] })
  assert.equal(reapprovalGate('azureDevOps', pullRequest(0), instance, 'hld-define', 7).waitingFor.length, 1)
  assert.equal(reapprovalGate('azureDevOps', pullRequest(-5), instance, 'hld-define', 7).waitingFor.length, 1)
  assert.equal(reapprovalGate('azureDevOps', pullRequest(5), instance, 'hld-define', 7).waitingFor.length, 0)
  assert.equal(reapprovalGate('azureDevOps', pullRequest(10), instance, 'hld-define', 7).waitingFor.length, 0)
})

test('GitLab reads approved_by user ids', () => {
  const instance = instanceWith([{ reviewers: [{ ...soapOwner, key: '42', id: 42 }] }])
  assert.equal(reapprovalGate('gitlab', { approvals: { approved_by: [] } }, instance, 'hld-define', 7).waitingFor.length, 1)
  assert.equal(reapprovalGate('gitlab', { approvals: { approved_by: [{ user: { id: 42 } }] } }, instance, 'hld-define', 7).waitingFor.length, 0)
})

test('only entries for this stage and this Pull Request, not yet completed, are pending', () => {
  const instance = instanceWith([{ reviewers: [soapOwner] }, { pullRequestId: 3, reviewers: [soapOwner] }, { approvedAt: '2026-10-01T00:00:00Z', reviewers: [soapOwner] }])
  assert.equal(pendingReapprovals(instance, 'hld-define', 7).length, 1)
  assert.equal(pendingReapprovals(instance, 'shape', 7).length, 0)
  assert.equal(reapprovalGate('github', githubPullRequest([]), { reapprovals: {} }, 'hld-define', 7).waitingFor.length, 0)
  assert.equal(reapprovalGate('bitbucket', githubPullRequest([]), instance, 'hld-define', 7).waitingFor.length, 0, 'a provider with no comparison waits for nobody')
})

test('a review is held at pending only while someone is waited for, and only from approved', () => {
  const approved = { state: 'approved', reviewStatus: 'Approved', reviewers: [], approver: null }
  const waitingFor = [{ displayName: 'SOAP Owner', forStages: ['SOAP'] }]
  const held = holdReviewForReapprovers(approved, waitingFor)
  assert.equal(held.state, 'pending')
  assert.equal(held.reviewStatus, 'In review')
  assert.deepEqual(held.waitingFor, waitingFor)

  assert.equal(holdReviewForReapprovers(approved, []), approved)
  const changes = { state: 'changes-requested' }
  assert.equal(holdReviewForReapprovers(changes, waitingFor), changes, 'a stronger answer is left alone')
  assert.equal(holdSummaryForReapprovers({ id: 7, review: approved }, waitingFor).review.state, 'pending')
  assert.equal(holdSummaryForReapprovers({ id: 7 }, waitingFor).review, undefined)
})

test('the Pull Request description lists each stage, its Fields and who approves again', () => {
  const text = reapprovalDescription([
    { stageId: 'shape', title: 'SOAP', fields: ['background.problem', 'background.affected-domains'], fieldLabels: ['Background: Problem statement', 'Background: Affected domains'], pullRequestId: 3, reviewers: [soapOwner] },
  ])
  assert.match(text, /also re-approves earlier stages/)
  assert.match(text, /\*\*SOAP\*\* \(approved in Pull Request #3\) has Fields changed since its approval, which SOAP Owner must approve again/)
  assert.match(text, /  - Background: Problem statement\n  - Background: Affected domains/)
  assert.equal(reapprovalDescription([]), '')
})

test('the record Request approval stores carries the reviewers, the Pull Request own reviewer and when', () => {
  const record = reapprovalRecord(
    [{ stageId: 'shape', title: 'SOAP', fields: ['background.problem'], reviewers: [soapOwner] }],
    hldOwner,
    new Date('2026-11-02T01:02:03Z')
  )
  assert.deepEqual(record, { shape: { title: 'SOAP', fields: ['background.problem'], reviewers: [soapOwner], primary: hldOwner, requestedAt: '2026-11-02T01:02:03.000Z' } })
  assert.equal('primary' in reapprovalRecord([{ stageId: 'shape', title: 'SOAP', fields: [], reviewers: [] }], null).shape, false)
})

test('the Pull Request own reviewer is recorded by login on GitHub and by id elsewhere', () => {
  assert.deepEqual(primaryReviewerRecord('github', { id: 99, displayName: 'Hld Owner', uniqueName: 'Hld-Owner' }), {
    key: 'hld-owner', id: 'Hld-Owner', displayName: 'Hld Owner', uniqueName: 'Hld-Owner',
  })
  assert.equal(primaryReviewerRecord('azureDevOps', { id: 'ABC', displayName: 'A', uniqueName: 'a@x' }).key, 'abc')
  assert.equal(primaryReviewerRecord('github', null), null)
})

test('the history lists only completed re-approvals, naming the stage that did it', () => {
  const definition = { stages: [{ id: 'shape', title: 'SOAP' }, { id: 'hld-define', title: 'High-level Design' }] }
  const instance = instanceWith([
    { reviewers: [soapOwner], requestedAt: '2026-11-01T00:00:00Z' },
    { pullRequestId: 5, reviewers: [soapOwner], requestedAt: '2026-10-01T00:00:00Z', approvedAt: '2026-10-02T00:00:00Z' },
  ])
  const history = reapprovalHistory(instance, 'shape', definition)
  assert.deepEqual(history.map((h) => [h.byTitle, h.pullRequestId, h.approvedAt]), [['High-level Design', 5, '2026-10-02T00:00:00Z']])
  assert.deepEqual(history[0].reviewers, [{ displayName: 'SOAP Owner', uniqueName: 'soap-owner' }])
  assert.deepEqual(reapprovalHistory(instance, 'hld-define', definition), [])

  const pending = pendingReapprovalSummary(instance, 'hld-define')
  assert.deepEqual(pending.map((p) => [p.stageId, p.title, p.count]), [['shape', 'SOAP', 1]])
  assert.deepEqual(pendingReapprovalSummary({ pullRequests: {} }, 'hld-define'), [])
})

test('the messages name who Check status is waiting for', () => {
  const waitingFor = [{ displayName: 'SOAP Owner', forStages: ['SOAP', 'Business case'] }, { displayName: 'HLD Owner', forStages: [] }]
  assert.equal(
    waitingForReapproversMessage(waitingFor),
    'Waiting for SOAP Owner (their approval re-approves SOAP, Business case); HLD Owner to approve before this Pull Request can merge.'
  )
  assert.equal(
    waitingForReapproversLine(7, waitingFor),
    'Still waiting — Pull Request #7 needs SOAP Owner, whose approval re-approves SOAP, Business case; HLD Owner before it can merge.'
  )
})

test('the screens word what a Pull Request also re-approves', () => {
  const entries = [{ stageId: 'shape', title: 'SOAP', fields: ['a.b', 'a.c'], count: 2, reviewers: [{ displayName: 'SOAP Owner' }] }]
  assert.equal(reapprovingLine(entries), 'Needs SOAP Owner to approve SOAP: 2 Fields')
  assert.equal(reapprovingLine([]), null)
  assert.equal(reapprovingLine([{ title: 'SOAP', count: 1, reviewers: [] }]), 'Re-approves SOAP: 1 Field')
  assert.equal(requestedStatusWithReapproval(9, entries), "Pull Request #9 opened — awaiting the Owner's review. It also re-approves SOAP (2 Fields), so SOAP Owner must approve too.")
  assert.equal(requestedStatusWithReapproval(9, undefined), "Pull Request #9 opened — awaiting the Owner's review.")
  assert.equal(
    reapprovalHistoryLine({ approvedAt: '2026-10-12T09:00:00Z', byTitle: 'High-level Design', pullRequestId: 12, fields: ['a.b'], reviewers: [{ displayName: 'SOAP Owner' }] }),
    'Re-approved 2026-10-12 by High-level Design (Pull Request #12): 1 Field. Approved by SOAP Owner.'
  )
})
