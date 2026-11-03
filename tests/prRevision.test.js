import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMENT_CHOICES,
  commentAnswersText,
  commentCards,
  commentExcerpt,
  commentLink,
  commentNeedsAi,
  commentsMessage,
  fingerprintOf,
  reopenBlockedQuestion,
  reopenCard,
  reopenOffer,
  resolveCommentCard,
  sentBackOf,
  staleLaterFields,
} from '../web/lib/prRevision.js'
import { planUpdateRound, updateCards } from '../web/lib/bringUpToDate.js'
import { planRows } from '../web/lib/interviewRun.js'
import { applyDecisionsDelta, emptyDecisionsLog, logSummary } from '../web/lib/decisionsLog.js'

// #299 (parent #238, decided in #247): the rules for revising a Stage the Owner sent back, with no DOM and no network.

const comment = (over = {}) => ({ id: 'c1', kind: 'conversation', author: 'Olivia', body: 'Please name the owner.', createdAt: '2026-11-03T10:00:00Z', url: null, path: null, line: null, resolved: false, ...over })

test('Check status: changes requested and a rejection send a Stage back; pending, approved and merged do not', () => {
  const body = (over) => ({ merged: false, prStatus: 'active', review: { state: 'pending' }, stage: { id: 's1', title: 'Scope' }, pullRequestId: 4, ...over })
  assert.deepEqual(sentBackOf(body({ review: { state: 'changes-requested' } })), { kind: 'changes-requested', stageId: 's1', stageTitle: 'Scope', pullRequestId: 4 })
  assert.equal(sentBackOf(body({ review: { state: 'rejected' } })).kind, 'rejected')
  assert.equal(sentBackOf(body({ prStatus: 'abandoned' })).kind, 'rejected', 'a Pull Request closed without merging is its rejection (GitHub has no reject vote)')
  assert.equal(sentBackOf(body()), null)
  assert.equal(sentBackOf(body({ review: { state: 'approved' } })), null)
  assert.equal(sentBackOf(body({ merged: true, review: { state: 'approved' } })), null)
  assert.equal(sentBackOf(null), null)
})

test('a comment links to the Provider: its own address, else the thread on the Pull Request, else the Pull Request', () => {
  assert.equal(commentLink(comment({ url: 'https://github.example/pull/4#r1' }), 'https://x/pull/4'), 'https://github.example/pull/4#r1')
  assert.equal(commentLink(comment({ threadId: 7 }), 'https://ado/pullrequest/4'), 'https://ado/pullrequest/4?discussionId=7')
  assert.equal(commentLink(comment(), 'https://ado/pullrequest/4'), 'https://ado/pullrequest/4')
  assert.equal(commentLink(comment(), null), null)
})

test('an excerpt is on one line and short', () => {
  assert.equal(commentExcerpt('a\n\n  b   c'), 'a b c')
  const long = commentExcerpt('word '.repeat(100), 40)
  assert.ok(long.length <= 40 && long.endsWith('…'))
})

test('every comment is listed in the conversation, resolved ones marked', () => {
  const text = commentsMessage([comment(), comment({ id: 'c2', author: 'Sam', body: 'Typo.', resolved: true, path: '/gantry-workspace/x/modules/m1.md', line: 3 })], { pullRequestId: 4, stageTitle: 'Scope' })
  assert.match(text, /^Scope was sent back\. 2 comments on Pull Request #4, resolved ones included:/)
  assert.match(text, /1\. Olivia: Please name the owner\./)
  assert.match(text, /2\. Sam on modules\/m1\.md \(line 3\) \(resolved\): Typo\./)
})

test('one card per comment, resolved or not, each with the three choices and an Other', () => {
  const cards = commentCards({ comments: [comment(), comment({ id: 'c2', resolved: true, url: 'https://x/c2' })], pullRequestId: 4, pullRequestUrl: 'https://ado/pullrequest/4', stageTitle: 'Scope' })
  assert.equal(cards.length, 2)
  assert.deepEqual(cards[0].options.map((o) => o.label), [COMMENT_CHOICES.change, COMMENT_CHOICES.none, COMMENT_CHOICES.open])
  assert.equal(cards[0].allowOther, true)
  assert.equal(cards[0].type, 'comment')
  assert.deepEqual(cards[0].recommended, [COMMENT_CHOICES.change], 'a comment still open recommends changing the content')
  assert.deepEqual(cards[1].recommended, [COMMENT_CHOICES.none], 'a resolved thread recommends leaving it, but is still asked')
  assert.match(cards[1].question, /the thread is resolved/)
  assert.equal(cards[0].comment.url, 'https://ado/pullrequest/4')
  assert.equal(cards[1].comment.url, 'https://x/c2')
  assert.equal(new Set(cards.map((c) => c.id)).size, 2)
})

test('an answer means: change (the AI redrafts), no change, an open question, or the architect\'s own words', () => {
  const [card] = commentCards({ comments: [comment()] })
  const answer = (selected, other = '') => resolveCommentCard({ ...card, selected, otherOn: Boolean(other), otherText: other }, other)
  assert.equal(answer([COMMENT_CHOICES.change]).outcome, 'change')
  assert.equal(answer([COMMENT_CHOICES.none]).outcome, 'no-change')
  assert.equal(answer([COMMENT_CHOICES.open]).outcome, 'open-question')
  assert.equal(answer([], 'Name Dana as owner').outcome, 'other')
  assert.deepEqual([answer([COMMENT_CHOICES.change]), answer([COMMENT_CHOICES.none]), answer([COMMENT_CHOICES.open]), answer([], 'x')].map(commentNeedsAi), [true, false, false, true])
})

test('the AI is told each comment and what was decided, and never to write to the Pull Request', () => {
  const cards = commentCards({ comments: [comment(), comment({ id: 'c2', body: 'Typo.' })] })
  const results = [resolveCommentCard({ ...cards[0], selected: [COMMENT_CHOICES.change] }), resolveCommentCard({ ...cards[1], selected: [COMMENT_CHOICES.none] }, 'already fixed')]
  const text = commentAnswersText(results)
  assert.match(text, /“Please name the owner\.”\n  CHANGE THE CONTENT\./)
  assert.match(text, /“Typo\.”\n  NO CHANGE NEEDED/)
})

test('a PR comment answered entry keeps the author, link, excerpt and the entries that answered it, and the log shows it', () => {
  const entry = { id: 's-1', kind: 'pr-comment-answered', pullRequest: 4, comment: 'c1', author: 'Olivia', url: 'https://x/c1', excerpt: 'Please name the owner.', outcome: 'change', entries: ['s-0'], at: '2026-11-03T10:00:00Z' }
  const log = applyDecisionsDelta(emptyDecisionsLog('s1'), { entries: [entry] }, 's1')
  assert.deepEqual(log.entries[0], entry)
  assert.equal(logSummary(log).latest.length, 1, 'it counts as a decision in the rail')
})

test('later Fields drafted from content a revision changed are found by fingerprint, on later Stages only', () => {
  const stages = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
  const stageModules = { s1: ['m1'], s2: ['m2'], s3: ['m3'] }
  const logs = {
    s1: { stage: 's1', fields: { 'm1.body': { drafted: '2026-11-03T09:00:00Z', inputs: [] } }, entries: [] },
    s2: { stage: 's2', fields: { 'm2.body': { drafted: '2026-11-03T09:30:00Z', inputs: [{ field: 'm1.body', fingerprint: fingerprintOf('Old scope.') }] } }, entries: [] },
    s3: { stage: 's3', fields: { 'm3.body': { drafted: '2026-11-03T09:45:00Z', inputs: [{ field: 'm2.body', fingerprint: fingerprintOf('Shape.') }] } }, entries: [] },
  }
  const modules = (scope) => [
    { id: 'm1', fields: [{ id: 'body', value: scope }] },
    { id: 'm2', fields: [{ id: 'body', value: 'Shape.' }] },
    { id: 'm3', fields: [{ id: 'body', value: 'Ship.' }] },
  ]
  assert.deepEqual(staleLaterFields({ stages, revisedStageId: 's1', logs, modules: modules('Old scope.'), stageModules }), [], 'nothing changed, nothing is stale')
  const stale = staleLaterFields({ stages, revisedStageId: 's1', logs, modules: modules('New scope, owner named.'), stageModules })
  assert.deepEqual(stale, [{ field: 'm2.body', inputField: 'm1.body', stages: ['s2'] }])
  assert.deepEqual(staleLaterFields({ stages, revisedStageId: 's2', logs, modules: modules('New scope, owner named.'), stageModules }), [], 'a Field of an earlier Stage is not asked about')
})

test('on a drafted-ahead Stage the stale Field is asked about (keep or redraft), on its own branch; a Source document\'s change still waits', () => {
  const definition = {
    stages: [
      { id: 's1', modules: ['m1'] },
      { id: 's2', modules: ['m2', 'mx'], readOnlyModules: ['mx'] },
    ],
    modules: [
      { id: 'm1', fields: [{ id: 'body', type: 'markdown' }] },
      { id: 'm2', fields: [{ id: 'body', type: 'markdown' }] },
      { id: 'mx', fields: [{ id: 'body', type: 'markdown' }] },
    ],
  }
  const flags = [
    { field: 'm2.body', cause: 'field', inputField: 'm1.body', change: 'changed', via: ['drafted'], stages: ['s2'] },
    { field: 'mx.body', cause: 'field', inputField: 'm1.body', change: 'changed', via: ['drafted'], stages: ['s2'] },
  ]
  const saved = [{ id: 'm2', fields: [{ id: 'body', value: 'Shape.' }] }]
  const plan = planUpdateRound({ flags, definition, pageStageId: 's2', currentStageId: 's1', remote: true, staleLater: true, saved })
  assert.deepEqual(plan.items.map((i) => [i.key, i.landing.kind]), [['m2.body', 'in-place']])
  assert.deepEqual(plan.deferred, [], 'a Module the page cannot edit is not in scope, so it is not asked about here')
  const cards = updateCards({ items: plan.items, fieldTitle: (k) => k })
  assert.deepEqual(cards[0].options.map((o) => o.label), ['Keep', 'Redraft'])
  // The same flags without the revision's ask are deferred, as Bring up to date has always done on a drafted-ahead Stage.
  assert.deepEqual(planUpdateRound({ flags: [flags[0]], definition, pageStageId: 's2', currentStageId: 's1', remote: true, saved }).items, [])
  const sourceFlag = { field: 'm2.body', cause: 'source', source: 'brief', sourceTitle: 'Brief', change: 'replaced', since: '2026-11-03T00:00:00Z', via: ['drafted'], stages: ['s2'] }
  assert.deepEqual(planUpdateRound({ flags: [sourceFlag], definition, pageStageId: 's2', currentStageId: 's1', remote: true, staleLater: true, saved }).deferred, [{ key: 'm2.body', stageId: 's2' }])
})

test('re-open is offered only when Gantry would allow it right now; otherwise the open question names the blocker', () => {
  const stages = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }, { id: 'c', title: 'Gamma' }]
  assert.deepEqual(reopenOffer({ stages, currentStageId: 'b', targetId: 'a', inProgress: [] }), { allowed: true, blocker: '' })
  const started = reopenOffer({ stages, currentStageId: 'b', targetId: 'a', inProgress: ['b'] })
  assert.equal(started.allowed, false)
  assert.match(started.blocker, /Beta is already in progress, and a Stage cannot be re-opened while a later one is \(ADR-0026\)/)
  const far = reopenOffer({ stages, currentStageId: 'c', targetId: 'a', inProgress: [] })
  assert.equal(far.allowed, false)
  assert.match(far.blocker, /only the Stage just before the current one can be re-opened/)
  assert.equal(reopenOffer({ stages, currentStageId: 'a', targetId: 'a' }).allowed, false, 'the current Stage is not signed off')
  const question = reopenBlockedQuestion({ stageTitle: 'Alpha', blocker: started.blocker, why: 'A new brief contradicts the scope.' })
  assert.match(question.question, /Alpha is signed off, but approved content there may need to change: A new brief contradicts the scope\. It cannot be re-opened now/)
  assert.equal(question.why, started.blocker)
  const card = reopenCard({ id: 'q-1', stageId: 'a', stageTitle: 'Alpha', question: 'A new brief contradicts the scope.' })
  assert.deepEqual(card.options.map((o) => o.label), ['Re-open Alpha', 'Not now'])
  assert.deepEqual(card.recommended, ['Re-open Alpha'])
  assert.equal(card.allowOther, false)
})

test('the run plan shows a Stage being revised, and back to awaiting approval once the revision is saved', () => {
  const stages = [{ id: 's1', title: 'Scope' }, { id: 's2', title: 'Shape' }]
  const remote = { pullRequests: { s1: { id: 4, url: null } }, queued: { s2: true }, headStart: {} }
  const revising = planRows({ stages, currentStageId: 's1', targetStageId: 's2', current: 'revising', remote })
  assert.deepEqual(revising.map((r) => [r.id, r.state]), [['s1', 'revising'], ['s2', 'approval-queued']])
  assert.equal(revising[0].checkable, false)
  const saved = planRows({ stages, currentStageId: 's1', targetStageId: 's2', current: 'awaiting-approval', remote })
  assert.equal(saved[0].state, 'awaiting-approval')
  assert.equal(saved[0].checkable, true)
})
