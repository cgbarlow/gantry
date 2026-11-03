import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFieldIndex, placeReview, readReviewedCopy } from '../web/lib/reviewedCopy.js'
import {
  REVIEW_CHOICES,
  answeredCounts,
  answeredReviewKeys,
  applyTrackedEdits,
  changedSinceRender,
  planReview,
  reviewAnswersText,
  reviewCards,
  reviewEntriesFor,
  reviewNeedsInput,
  reviewUnits,
  reviewerLabels,
  resolveReviewCard,
  scrubNames,
} from '../web/lib/reviewRound.js'
import { describeEntry } from '../web/lib/decisionsLogPanel.js'
import { parseReviewManifest, stringifyReviewManifest, withAnsweredCounts } from '../web/lib/reviewManifest.js'
import { recordAnsweredReviewsLocally } from '../web/lib/reviewedCopies.js'
import { FIELDS, RENDER_PROPERTIES, reviewedCopy } from './helpers/reviewedCopyFixture.js'

// #303 (ADR-0066): the pure part of a review round. A Reviewed copy built by the #302 fixture (Word-saved, with Ana's and Ben's threads and tracked
// changes) becomes cards: one per unresolved thread, one per commenter's tracked changes in a Field, the recommendation following whether the Field
// changed since the render, no real name in what the AI is told.

const fieldIndex = buildFieldIndex(FIELDS)
const BASIS = { basis: 'commit', commit: RENDER_PROPERTIES.commit, fields: FIELDS }

async function loadCopy({ kind = 'word', id = 'copy-aaaa-0001', name = 'review-ana-ben.docx', stage = 'shape' } = {}) {
  const read = await readReviewedCopy(reviewedCopy({ kind }))
  const placed = placeReview(read, { fieldIndex, basis: kind === 'google' ? BASIS : undefined })
  return { entry: { id, name, stage, artefact: 'hld', commentsAnswered: 0 }, read, placed, basis: kind === 'google' ? BASIS : undefined }
}

const definition = () => ({
  id: 'design',
  stages: [
    { id: 'shape', title: 'Shape', modules: ['background'] },
    { id: 'build', title: 'Build', modules: ['background', 'plan'], readOnlyModules: ['background'] },
  ],
  modules: [
    {
      id: 'background',
      title: 'Background and context',
      fields: [
        { id: 'problem', title: 'Problem statement', type: 'markdown' },
        { id: 'opportunity', title: 'Opportunity', type: 'markdown' },
        { id: 'success-criteria', title: 'Success criteria', type: 'markdown' },
      ],
    },
    { id: 'plan', title: 'Plan', fields: [{ id: 'steps', title: 'Steps', type: 'markdown' }] },
  ],
})
// What the Fields say today: the same words the fixture was rendered from.
const saved = (over = {}) => [
  {
    id: 'background',
    status: 'draft',
    fields: [
      { id: 'problem', value: over.problem ?? 'We need a new payments platform.\n\nIt must support card schemes.' },
      { id: 'opportunity', value: over.opportunity ?? 'Reduce cost per transaction.' },
      { id: 'success-criteria', value: over['success-criteria'] ?? 'Payments Engineering' },
    ],
  },
]

describe('the questions a Reviewed copy asks', async () => {
  const copy = await loadCopy()
  const { units, resolved } = reviewUnits({ copies: [copy] })
  const unitFor = (fieldKey) => units.filter((u) => u.fieldKey === fieldKey)

  test('is one per unresolved thread, and threads resolved in Word are listed apart', () => {
    assert.deepEqual(resolved.map((r) => r.thread.text), ['Which card schemes?'])
    assert.equal(resolved[0].thread.replies[0].text, 'Visa and Mastercard.')
    const asked = units.flatMap((u) => u.parts.map((p) => p.thread?.text).filter(Boolean))
    assert.ok(!asked.includes('Which card schemes?'), 'the resolved thread is not asked')
    for (const text of ['Say who signs this off', 'Point comment with no range', 'Add the team', 'Put the date on the cover', 'Is this the right version?', 'Why is this here?', 'Rename to Purpose']) {
      assert.ok(asked.includes(text), text)
    }
  })

  test("one commenter's tracked changes in a Field are one question, kept with that commenter's thread when they have one beside it", () => {
    const problem = unitFor('background.problem')
    // Ana's must -> should has no thread of hers in Problem (hers is resolved), so it is a question of its own.
    const ana = problem.find((u) => u.parts.some((p) => p.author === 'Ana Reviewer' && p.changes.length))
    assert.ok(ana)
    assert.equal(ana.parts.length, 1)
    assert.equal(ana.parts[0].thread, null)
    assert.deepEqual(ana.parts[0].changes.map((c) => [c.kind, c.text]), [['deletion', 'must'], ['insertion', 'should']])
    // Ben's inserted paragraph in Opportunity is his, with no thread of his there: one question of its own.
    const ben = unitFor('background.opportunity').find((u) => u.parts.some((p) => p.author === 'Ben Commenter' && p.changes.length))
    assert.ok(ben)
    assert.deepEqual(ben.parts[0].changes.map((c) => c.text), ['Improve settlement speed.'])
  })

  test('cover, Document Control, table of contents and unplaceable comments are their own cards', () => {
    const document = units.filter((u) => u.kind === 'document')
    assert.deepEqual(document.map((u) => u.parts[0].thread.text).sort(), ['Is this the right version?', 'Put the date on the cover', 'Why is this here?'])
  })

  test('answered threads are not asked again, and a resolved one can be reopened', () => {
    const key = `${copy.entry.id}:2`
    const again = reviewUnits({ copies: [copy], answered: new Set([key]) })
    assert.ok(!again.units.some((u) => u.parts.some((p) => p.key === key)))
    const reopened = reviewUnits({ copies: [copy], reopened: new Set([`${copy.entry.id}:0`]) })
    assert.ok(reopened.units.some((u) => u.parts.some((p) => p.thread?.text === 'Which card schemes?')))
    assert.equal(reopened.resolved.length, 0)
  })

  test('commenters whose tracked changes touch the same paragraph share one card', () => {
    const change = (author, kind, text) => ({ author, kind, text, paragraph: 4, order: 1, date: '2026-11-03T10:00:00Z', placement: { confidence: 'high' } })
    const synthetic = {
      entry: { id: 'copy-bbbb-0002', name: 'two.docx', stage: 'shape' },
      read: { paragraphs: [], commenters: ['Ana Reviewer', 'Ben Commenter'] },
      placed: {
        groups: [
          {
            kind: 'field',
            field: { moduleId: 'background', moduleTitle: 'Background and context', fieldId: 'problem', fieldTitle: 'Problem statement' },
            threads: [],
            changes: [change('Ana Reviewer', 'deletion', 'must'), change('Ana Reviewer', 'insertion', 'should'), change('Ben Commenter', 'deletion', 'must'), change('Ben Commenter', 'insertion', 'may')],
          },
        ],
      },
    }
    const { units: shared } = reviewUnits({ copies: [synthetic] })
    assert.equal(shared.length, 1)
    assert.equal(shared[0].disagree, true)
    assert.deepEqual(shared[0].authors, ['Ana Reviewer', 'Ben Commenter'])
    assert.equal(shared[0].parts.length, 2)
  })
})

describe('has the Field changed since the render', async () => {
  const copy = await loadCopy()

  test('compares the wording under the Field bookmark with what is saved', () => {
    const same = changedSinceRender({ read: copy.read, fieldKey: 'background.problem', today: 'We need a new payments platform.\n\nIt must support card schemes.' })
    assert.equal(same.changed, false)
    assert.match(same.rendered, /It must support card schemes\./)
    const other = changedSinceRender({ read: copy.read, fieldKey: 'background.problem', today: 'We need a new platform.\n\nIt must support card schemes.' })
    assert.equal(other.changed, true)
  })

  test('ignores Markdown formatting, which Word does not print as characters', () => {
    const r = changedSinceRender({ read: copy.read, fieldKey: 'background.opportunity', today: '**Reduce** cost per _transaction_.' })
    assert.equal(r.changed, false)
  })

  test('judges a copy that lost its bookmarks by the commit it was placed against, else by the words the commenters touched', async () => {
    const google = await loadCopy({ kind: 'google' })
    assert.equal(changedSinceRender({ read: google.read, basis: BASIS, fieldKey: 'background.problem', today: FIELDS[0].text }).changed, false)
    assert.equal(changedSinceRender({ read: google.read, basis: BASIS, fieldKey: 'background.problem', today: 'Something else entirely.' }).changed, true)
    assert.equal(changedSinceRender({ read: google.read, fieldKey: 'background.problem', today: 'Something else entirely.', anchors: ['must'] }).changed, true)
    assert.equal(changedSinceRender({ read: google.read, fieldKey: 'background.problem', today: 'It must support.', anchors: ['must'] }).changed, false)
  })
})

describe('where the change lands', async () => {
  const copy = await loadCopy()
  const labels = reviewerLabels([copy])
  const plan = (over = {}) => planReview({ copies: [copy], definition: definition(), pageStageId: 'shape', saved: saved(), ...over })
  const cards = (p) => reviewCards({ items: p.items, labels, pageStageTitle: 'Shape', fieldChoices: [{ key: 'background.problem', title: 'Background and context · Problem statement' }] })
  const cardFor = (cs, text) => cs.find((c) => c.review.sides.some((s) => s.thread?.text === text))

  test('asks on the Stage in place on a local workspace and keeps the resolved list', () => {
    const p = plan()
    assert.ok(p.items.every((i) => i.landing.kind === 'in-place'))
    assert.equal(p.resolved.length, 1)
    assert.equal(p.deferred.length, 0)
  })

  test('a Field of a Stage drafted ahead is never asked, and is left unanswered', () => {
    const open = definition()
    delete open.stages[1].readOnlyModules
    const p = plan({ definition: open, remote: true, pageStageId: 'build', currentStageId: 'shape' })
    assert.equal(p.items.filter((i) => i.kind === 'field').length, 0)
    assert.ok(p.deferred.length > 0)
  })

  test('on a remote workspace a Field of an approved Stage is carried forward to the current one, and a Stage awaiting approval takes it on its own branch', () => {
    const editable = definition()
    delete editable.stages[1].readOnlyModules // the current Stage can edit the Module that Shape (now approved) printed
    const carried = plan({ definition: editable, remote: true, pageStageId: 'build', currentStageId: 'build' })
    const landings = carried.items.filter((i) => i.kind === 'field').map((i) => [i.landing.kind, i.landing.stageId])
    assert.ok(landings.length > 0)
    assert.ok(landings.every(([kind, stage]) => kind === 'carry-forward' && stage === 'shape'), JSON.stringify(landings))
    const note = cards(carried).find((c) => c.review.field).review.note
    assert.match(note, /is approved\. A change is carried forward/)
    assert.match(note, /re-approved with/)
    const awaiting = plan({ definition: editable, remote: true, pageStageId: 'build', currentStageId: 'build', awaiting: ['build'] })
    assert.ok(awaiting.items.filter((i) => i.kind === 'field').every((i) => i.landing.kind === 'carry-forward' && i.landing.awaiting === true))
    assert.match(cards(awaiting).find((c) => c.review.field).review.note, /awaiting approval, so the change is saved on its branch and updates its Pull Request/)
    // The Stage itself awaiting approval, with the comments on its own Fields: its own branch.
    const own = plan({ remote: true, pageStageId: 'shape', currentStageId: 'shape', awaiting: ['shape'] })
    assert.ok(own.items.filter((i) => i.kind === 'field').every((i) => i.landing.kind === 'own-branch'))
  })

  test('on a remote workspace a Field of an approved Stage the current Stage cannot edit is re-opened, or an open question', () => {
    // Build is the current Stage; background is read-only there, so Shape's Fields cannot be edited from it.
    const p = plan({ remote: true, pageStageId: 'build', currentStageId: 'build', inProgress: [] })
    const kinds = new Set(p.items.filter((i) => i.kind === 'field').map((i) => i.landing.kind))
    assert.ok([...kinds].every((k) => k === 'reopen' || k === 'open-question'), [...kinds].join())
    const cs = cards(p)
    const field = cs.find((c) => c.review.field)
    assert.match(field.header, /cannot change here/)
    assert.ok(field.options.some((o) => o.label === REVIEW_CHOICES.openQuestion))
  })

  test('the recommendation is the accept choice only when the Field is unchanged since the render', () => {
    const unchanged = cards(plan())
    const ana = unchanged.find((c) => c.review.sides.some((s) => s.author === 'Ana Reviewer' && s.changes.length))
    assert.equal(ana.review.changed, false)
    assert.deepEqual(ana.recommended, [REVIEW_CHOICES.accept])
    assert.deepEqual(ana.selected, [REVIEW_CHOICES.accept])
    assert.match(ana.why, /unchanged since the render/)

    const changed = cards(plan({ saved: saved({ problem: 'We need a new platform.\n\nIt must support card schemes and wallets.' }) }))
    const anaChanged = changed.find((c) => c.review.sides.some((s) => s.author === 'Ana Reviewer' && s.changes.length))
    assert.equal(anaChanged.review.changed, true)
    assert.deepEqual(anaChanged.recommended, [REVIEW_CHOICES.revise])
    assert.match(anaChanged.why, /changed since the render/)
    assert.match(anaChanged.review.rendered, /new payments platform/)
    assert.match(anaChanged.review.saved, /wallets/)
    // Accept is still on offer: nothing is chosen for the architect.
    assert.ok(anaChanged.options.some((o) => o.label === REVIEW_CHOICES.accept))
  })

  test('a comment with no tracked change is revised by default and offers the three choices', () => {
    const card = cardFor(cards(plan()), 'Add the team')
    assert.deepEqual(card.options.map((o) => o.label), [REVIEW_CHOICES.revise, REVIEW_CHOICES.keep, REVIEW_CHOICES.cantSettle])
    assert.deepEqual(card.recommended, [REVIEW_CHOICES.revise])
    assert.equal(card.allowOther, false)
  })

  test("a paragraph a reviewer inserted whole knows the paragraph it follows, so accepting it needs no AI", () => {
    const ben = cards(plan()).find((c) => c.review.sides.some((s) => s.author === 'Ben Commenter' && s.changes.length && !s.thread))
    assert.equal(ben.review.sides[0].changes[0].after, 'Reduce cost per transaction.')
    assert.deepEqual(applyTrackedEdits('Reduce cost per transaction.', ben.review.sides[0].changes), { ok: true, value: 'Reduce cost per transaction.\n\nImprove settlement speed.' })
  })

  test('a comment on the cover offers note, assign and open question', () => {
    const card = cardFor(cards(plan()), 'Put the date on the cover')
    assert.deepEqual(card.options.map((o) => o.label), [REVIEW_CHOICES.note, REVIEW_CHOICES.assign, REVIEW_CHOICES.openQuestion])
    assert.deepEqual(card.recommended, [REVIEW_CHOICES.note])
  })

  test('the architect sees real names; the card keeps both', () => {
    const card = cardFor(cards(plan()), 'Add the team')
    assert.match(card.question, /Ben Commenter/)
    assert.equal(card.review.sides[0].label, 'Reviewer 2')
  })
})

describe('what an answer means', async () => {
  const copy = await loadCopy()
  const labels = reviewerLabels([copy])
  const p = planReview({ copies: [copy], definition: definition(), pageStageId: 'shape', saved: saved() })
  const cs = reviewCards({ items: p.items, labels, pageStageTitle: 'Shape', fieldChoices: [{ key: 'background.problem', title: 'Problem' }] })
  const find = (text) => cs.find((c) => c.review.sides.some((s) => s.thread?.text === text))
  const ana = cs.find((c) => c.review.sides.some((s) => s.author === 'Ana Reviewer' && s.changes.length))
  const answer = (card, label, extra = {}) => resolveReviewCard({ ...card, selected: [label], ...extra })

  test('resolves every choice', () => {
    assert.equal(answer(ana, REVIEW_CHOICES.accept).outcome, 'accept')
    assert.equal(answer(ana, REVIEW_CHOICES.revise).outcome, 'revise')
    assert.equal(answer(ana, REVIEW_CHOICES.keep, { reason: '  Out of scope. ' }).words, 'Out of scope.')
    assert.equal(answer(ana, REVIEW_CHOICES.cantSettle).outcome, 'cant-settle')
    const cover = find('Put the date on the cover')
    assert.equal(answer(cover, REVIEW_CHOICES.note).outcome, 'note')
    assert.equal(answer(cover, REVIEW_CHOICES.openQuestion).outcome, 'cant-settle')
    assert.equal(answer(cover, REVIEW_CHOICES.assign).outcome, 'leave', 'no Field picked yet')
    assert.equal(reviewNeedsInput({ ...cover, selected: [REVIEW_CHOICES.assign], assignTo: '' }), true)
    const assigned = answer(cover, REVIEW_CHOICES.assign, { assignTo: 'background.problem' })
    assert.deepEqual([assigned.outcome, assigned.assignTo], ['assign', 'background.problem'])
  })

  test("a card that offers one edit each names whose edit was accepted", () => {
    const change = (author, text) => ({ author, kind: 'deletion', text, paragraph: 4, order: 1, placement: { confidence: 'high' } })
    const two = {
      entry: { id: 'copy-bbbb-0002', name: 'two.docx', stage: 'shape' },
      read: { paragraphs: [], commenters: ['Ana Reviewer', 'Ben Commenter'] },
      placed: { groups: [{ kind: 'field', field: { moduleId: 'background', moduleTitle: 'B', fieldId: 'problem', fieldTitle: 'P' }, threads: [], changes: [change('Ana Reviewer', 'must'), { ...change('Ana Reviewer', 'should'), kind: 'insertion' }, change('Ben Commenter', 'must'), { ...change('Ben Commenter', 'may'), kind: 'insertion' }] }] },
    }
    const plan2 = planReview({ copies: [two], definition: definition(), pageStageId: 'shape', saved: saved() })
    const [card] = reviewCards({ items: plan2.items, labels: reviewerLabels([two]), pageStageTitle: 'Shape' })
    assert.deepEqual(card.options.slice(0, 2).map((o) => o.label), ["Accept Ana Reviewer's edit", "Accept Ben Commenter's edit"])
    const r = answer(card, "Accept Ben Commenter's edit")
    assert.deepEqual([r.outcome, r.by], ['accept', 'Ben Commenter'])
  })

  test('the AI is told commenters as Reviewer N and never sees a real name', () => {
    const results = [
      answer(ana, REVIEW_CHOICES.revise, { reason: 'Ana is right, but keep the card schemes.' }),
      answer(find('Add the team'), REVIEW_CHOICES.revise),
      answer(find('Say who signs this off'), REVIEW_CHOICES.cantSettle),
    ]
    const text = reviewAnswersText(results, { fieldTitle: (k) => k, labels, keyDecisions: true })
    assert.doesNotMatch(text, /Ana|Reviewer Ana|Ben|Commenter/)
    assert.match(text, /Reviewer 1/)
    assert.match(text, /Reviewer 2/)
    assert.match(text, /Add the team/, 'the comment itself is passed on')
    assert.match(text, /Key decision/)
  })

  test('scrubNames replaces whole names only, whatever the case', () => {
    const m = new Map([['Ana Reviewer', 'Reviewer 1'], ['Ben', 'Reviewer 2']])
    assert.equal(scrubNames('ana reviewer and Ben said Benedict is out', m), 'Reviewer 1 and Reviewer 2 said Benedict is out')
    // A first name typed on its own goes too, in the spelling the name has; the labels it makes are not read as names again.
    assert.equal(scrubNames('Ana is right, Reviewer wins', new Map([['Ana Reviewer', 'Reviewer 1']])), 'Reviewer 1 is right, Reviewer 1 wins')
  })
})

describe('applying a reviewer’s tracked edit', () => {
  const del = (text, paragraph = 1, order = 1) => ({ kind: 'deletion', text, paragraph, order })
  const ins = (text, paragraph = 1, order = 2) => ({ kind: 'insertion', text, paragraph, order })

  test('replaces the deleted words with the inserted ones, exactly once', () => {
    const r = applyTrackedEdits('We need a platform.\n\nIt must support card schemes.', [del('must'), ins('should')])
    assert.deepEqual(r, { ok: true, value: 'We need a platform.\n\nIt should support card schemes.' })
  })

  test('removes a deletion with the space before it, and works on a list of items', () => {
    assert.equal(applyTrackedEdits('It must support it.', [del('must')]).value, 'It support it.')
    assert.deepEqual(applyTrackedEdits(['one two', 'three four'], [del('three'), ins('3')]).value, ['one two', '3 four'])
  })

  test('puts a whole paragraph the reviewer inserted after the paragraph it followed, in a string or a list', () => {
    const paragraph = { kind: 'insertion', text: 'Improve settlement speed.', paragraph: 3, order: 1, after: 'Reduce cost per transaction.' }
    assert.deepEqual(applyTrackedEdits('Reduce cost per transaction.', [paragraph]), { ok: true, value: 'Reduce cost per transaction.\n\nImprove settlement speed.' })
    assert.equal(applyTrackedEdits('Reduce cost.\n\nLater paragraph.', [{ ...paragraph, after: 'Reduce cost.' }]).value, 'Reduce cost.\n\nImprove settlement speed.\n\nLater paragraph.')
    assert.deepEqual(applyTrackedEdits(['one', 'Reduce cost per transaction.', 'three'], [paragraph]).value, ['one', 'Reduce cost per transaction.', 'Improve settlement speed.', 'three'])
    assert.match(applyTrackedEdits('Something else.', [paragraph]).reason, /no longer in the Field/)
  })

  test('does not guess: an insertion with nothing deleted, words that are gone or are there twice are refused', () => {
    assert.equal(applyTrackedEdits('abc', [ins('new')]).ok, false)
    assert.match(applyTrackedEdits('abc def', [del('xyz'), ins('q')]).reason, /no longer in the Field/)
    assert.match(applyTrackedEdits('must and must', [del('must'), ins('should')]).reason, /more than once/)
    assert.match(applyTrackedEdits('a b c', [del('a'), del('b'), ins('x')]).reason, /pair up/)
  })
})

describe('the decisions log', async () => {
  const copy = await loadCopy()
  const labels = reviewerLabels([copy])
  const p = planReview({ copies: [copy], definition: definition(), pageStageId: 'shape', saved: saved() })
  const cs = reviewCards({ items: p.items, labels, pageStageTitle: 'Shape' })
  const ana = cs.find((c) => c.review.sides.some((s) => s.author === 'Ana Reviewer' && s.changes.length))

  test('an answered thread stands on its own: copy, thread, real name, date, comment, replies and the tracked change word for word', () => {
    const team = cs.find((c) => c.review.sides.some((s) => s.thread?.text === 'Add the team'))
    const [entry] = reviewEntriesFor(resolveReviewCard({ ...team, selected: [REVIEW_CHOICES.keep], reason: 'Not for this document.' }), { stage: 'shape' })
    assert.equal(entry.review, copy.entry.id)
    assert.equal(entry.reviewName, 'review-ana-ben.docx')
    assert.deepEqual(entry.keys, [`${copy.entry.id}:4`])
    assert.equal(entry.threads[0].author, 'Ben Commenter')
    assert.equal(entry.threads[0].text, 'Add the team')
    assert.match(entry.threads[0].date, /^2026-11-04/)
    assert.deepEqual(entry.fields, ['background.success-criteria'])
    assert.deepEqual(entry.changedSinceRender, { 'background.success-criteria': false })
    assert.equal(entry.outcome, 'keep')
    assert.equal(entry.words, 'Not for this document.')
    const [edit] = reviewEntriesFor(resolveReviewCard({ ...ana, selected: [REVIEW_CHOICES.accept] }), { stage: 'shape' })
    assert.deepEqual(edit.changes.map((c) => [c.kind, c.author, c.text]), [['deletion', 'Ana Reviewer', 'must'], ['insertion', 'Ana Reviewer', 'should']])
  })

  test('the Decisions log panel reads an entry as a sentence that stands on its own', () => {
    const team = cs.find((c) => c.review.sides.some((s) => s.thread?.text === 'Add the team'))
    const [entry] = reviewEntriesFor(resolveReviewCard({ ...team, selected: [REVIEW_CHOICES.keep], reason: 'Not for this document.' }), { stage: 'shape' })
    const sentence = describeEntry({ id: 'x-1', kind: 'review-answered', ...entry }, { fieldTitle: (k) => k })
    assert.match(sentence, /Review comment in review-ana-ben\.docx on background\.success-criteria\./)
    assert.match(sentence, /Ben Commenter \(2026-11-04\) commented on “Payments Engineering”: “Add the team”/)
    assert.match(sentence, /The architect kept the Field as it is\./)
    assert.match(sentence, /In their own words: “Not for this document\.”/)
  })

  test('answered keys and counts are read back from the logs of every Stage', () => {
    const logs = {
      shape: { entries: [{ id: 'a-1', kind: 'review-answered', review: 'copy-aaaa-0001', keys: ['copy-aaaa-0001:2', 'copy-aaaa-0001:3'] }, { id: 'a-2', kind: 'answer', fields: [] }] },
      build: { entries: [{ id: 'b-1', kind: 'review-answered', review: 'copy-aaaa-0001', keys: ['copy-aaaa-0001:2'] }, { id: 'b-2', kind: 'review-answered', review: 'copy-bbbb-0002', keys: ['copy-bbbb-0002:9'] }] },
    }
    assert.deepEqual([...answeredReviewKeys(logs)].sort(), ['copy-aaaa-0001:2', 'copy-aaaa-0001:3', 'copy-bbbb-0002:9'])
    assert.deepEqual(answeredCounts(logs), { 'copy-aaaa-0001': 2, 'copy-bbbb-0002': 1 })
  })
})

describe('the manifest’s answered count', () => {
  const entries = [
    { id: 'copy-aaaa-0001', file: 'reviews/copy-aaaa-0001.docx', comments: 9, commentsAnswered: 0 },
    { id: 'copy-bbbb-0002', file: 'reviews/copy-bbbb-0002.docx', comments: 3, commentsAnswered: 2 },
  ]

  test('only goes up, and never past the comments the copy holds', () => {
    const raised = withAnsweredCounts(entries, { 'copy-aaaa-0001': 4, 'copy-bbbb-0002': 1 })
    assert.equal(raised.changed, true)
    assert.deepEqual(raised.entries.map((e) => e.commentsAnswered), [4, 2])
    assert.equal(withAnsweredCounts(raised.entries, { 'copy-aaaa-0001': 4 }).changed, false)
    assert.equal(withAnsweredCounts(entries, { 'copy-bbbb-0002': 50 }).entries[1].commentsAnswered, 3)
    assert.equal(withAnsweredCounts(entries, { 'copy-aaaa-0001': 'many', nobody: 2 }).changed, false)
  })

  test('a Local workspace writes its own manifest, and writes nothing when no count goes up', async () => {
    const files = new Map([['gantry-workspace/acme/reviews/manifest.yaml', stringifyReviewManifest(entries)]])
    let writes = 0
    const io = {
      readText: async (path) => {
        if (!files.has(path)) throw new Error('missing')
        return files.get(path)
      },
      writeText: async (path, text) => {
        writes++
        files.set(path, text)
      },
    }
    const after = await recordAnsweredReviewsLocally('acme', { 'copy-aaaa-0001': 5 }, io)
    assert.equal(after[0].commentsAnswered, 5)
    assert.equal(parseReviewManifest(files.get('gantry-workspace/acme/reviews/manifest.yaml'))[0].commentsAnswered, 5)
    await recordAnsweredReviewsLocally('acme', { 'copy-aaaa-0001': 5 }, io)
    assert.equal(writes, 1)
  })
})
