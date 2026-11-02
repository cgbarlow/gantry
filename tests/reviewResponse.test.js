import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFieldIndex, placeReview, readReviewedCopy } from '../web/lib/reviewedCopy.js'
import { REVIEW_CHOICES, planReview, resolveReviewCard, reviewCards, reviewEntriesFor } from '../web/lib/reviewRound.js'
import { readPackageTexts } from '../web/lib/definitionLogo.js'
import { hasReviewResponses, downloadReviewResponseList, reviewResponseDocx, reviewResponseFilename, reviewResponseRows } from '../web/lib/reviewResponse.js'
import { FIELDS, reviewedCopy } from './helpers/reviewedCopyFixture.js'

// #304 (ADR-0066): the Review response list. Built from the decisions log alone: each answered thread's comment, commenter, outcome and reason, as a Word
// document made on demand. These tests build the log the way a review round does (real cards from the #302 fixture, answered, turned into `review-answered`
// entries), then read the list and the .docx back.

const fieldIndex = buildFieldIndex(FIELDS)
const definition = {
  id: 'design',
  stages: [{ id: 'shape', title: 'Shape', modules: ['background'] }],
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
  ],
}
const saved = [
  {
    id: 'background',
    status: 'draft',
    fields: [
      { id: 'problem', value: 'We need a new payments platform.\n\nIt must support card schemes.' },
      { id: 'opportunity', value: 'Reduce cost per transaction.' },
      { id: 'success-criteria', value: 'Payments Engineering' },
    ],
  },
]
const fieldTitle = (key) => {
  const [moduleId, fieldId] = key.split('.')
  const mod = definition.modules.find((m) => m.id === moduleId)
  return mod ? `${mod.title} · ${mod.fields.find((f) => f.id === fieldId)?.title ?? fieldId}` : key
}

async function buildCards() {
  const read = await readReviewedCopy(reviewedCopy({ kind: 'word' }))
  const placed = placeReview(read, { fieldIndex })
  const copy = { entry: { id: 'copy-aaaa-0001', name: 'HLD - Ana and Ben.docx', stage: 'shape', artefact: 'hld', commentsAnswered: 0 }, read, placed }
  const plan = planReview({ copies: [copy], definition, pageStageId: 'shape', saved })
  return reviewCards({ items: plan.items, pageStageTitle: 'Shape' })
}

const offers = (card, label) => (card.options ?? card.choices ?? []).some((o) => (o.label ?? o) === label)

// Answers every card by `choose(card)` and returns the Stage's log, the way a Save leaves it.
function logFor(cards, choose) {
  const entries = []
  for (const card of cards) {
    const { selected, reason } = choose(card)
    for (const entry of reviewEntriesFor(resolveReviewCard({ ...card, selected, reason: reason ?? '' }), { stage: 'shape' })) entries.push({ id: `e-${entries.length + 1}`, kind: 'review-answered', ...entry })
  }
  return { version: 1, stage: 'shape', entries }
}

describe('the rows', async () => {
  const cards = await buildCards()
  const keepAll = logFor(cards, (card) => (offers(card, REVIEW_CHOICES.keep) ? { selected: [REVIEW_CHOICES.keep], reason: 'Out of scope for this document.' } : { selected: [REVIEW_CHOICES.note] }))

  test('there is one row for every answered thread, with comment, commenter, outcome and reason', () => {
    const { rows, copies } = reviewResponseRows({ shape: keepAll }, { fieldTitle })
    assert.equal(rows.length, keepAll.entries.length)
    assert.equal(copies.length, 1)
    assert.equal(copies[0].name, 'HLD - Ana and Ben.docx')
    const team = rows.find((r) => r.comment.join(' ').includes('Add the team'))
    assert.equal(team.commenter, 'Ben Commenter')
    assert.equal(team.date, '2026-11-04')
    assert.equal(team.field, 'Background and context · Success criteria')
    assert.match(team.comment[0], /^On “Payments Engineering”: Add the team$/)
    assert.equal(team.outcome, 'Kept as it was')
    assert.equal(team.reason, 'Out of scope for this document.')
  })

  test('a tracked change is quoted word for word, and a comment about the document has no Field', () => {
    const { rows } = reviewResponseRows({ shape: keepAll }, { fieldTitle })
    const edit = rows.find((r) => r.comment.some((l) => l.includes('Tracked change')))
    assert.ok(edit.comment.some((l) => /deleted “must”/.test(l)))
    assert.ok(edit.comment.some((l) => /inserted “should”/.test(l)))
    const cover = rows.find((r) => r.comment.join(' ').includes('Put the date on the cover'))
    assert.equal(cover.outcome, 'Noted')
    assert.ok(!/·/.test(cover.field))
    assert.equal(cover.reason, '—', 'with no words from the architect the reason is left blank rather than invented')
  })

  test('each outcome reads as it was decided, and a revision the architect then did not take is not reported as made', () => {
    const accept = logFor(cards, (card) => (offers(card, REVIEW_CHOICES.accept) ? { selected: [REVIEW_CHOICES.accept] } : offers(card, REVIEW_CHOICES.revise) ? { selected: [REVIEW_CHOICES.revise] } : { selected: [REVIEW_CHOICES.note] }))
    const revised = reviewResponseRows({ shape: accept }, { fieldTitle }).rows
    assert.ok(revised.some((r) => r.outcome === 'Edit accepted'))
    assert.ok(revised.some((r) => r.outcome === 'Wording revised'))
    const field = accept.entries.find((e) => e.outcome === 'revise').fields[0]
    const kept = { ...accept, entries: [...accept.entries, { id: 'sc-1', kind: 'saved-content', field, choice: 'keep', fields: [field] }] }
    const after = reviewResponseRows({ shape: kept }, { fieldTitle }).rows
    assert.ok(after.some((r) => r.outcome === 'Looked at; the wording stayed as it was' && r.field === fieldTitle(field)))
    assert.ok(!after.some((r) => r.outcome === 'Wording revised' && r.field === fieldTitle(field)))
    const cant = logFor(cards.slice(0, 1), () => ({ selected: [REVIEW_CHOICES.cantSettle] }))
    assert.equal(reviewResponseRows({ shape: cant }, { fieldTitle }).rows[0].outcome, 'Not settled yet (logged as an open question)')
  })

  test('a thread answered in two logs is one row, and nothing else in a log is listed', () => {
    const second = { ...keepAll, stage: 'build', entries: [...keepAll.entries, { id: 'q-1', kind: 'open-question', question: 'Who?' }] }
    const { rows } = reviewResponseRows({ shape: keepAll, build: second }, { fieldTitle })
    assert.equal(rows.length, keepAll.entries.length)
    assert.equal(hasReviewResponses({ shape: { entries: [{ id: 'q-1', kind: 'open-question' }] } }), false)
    assert.equal(hasReviewResponses({ shape: keepAll }), true)
    assert.equal(hasReviewResponses({}), false)
    assert.equal(hasReviewResponses(null), false)
  })

  test('a shared card where the architect accepted one commenter leaves the other as not accepted', () => {
    const base = { id: 'x', kind: 'review-answered', review: 'r1', reviewName: 'Doc.docx', outcome: 'accept', accepted: 'Ana Reviewer', fields: ['background.problem'] }
    const log = {
      entries: [
        { ...base, keys: ['r1:a'], changes: [{ kind: 'insertion', author: 'Ana Reviewer', text: 'must' }] },
        { ...base, id: 'y', keys: ['r1:b'], changes: [{ kind: 'insertion', author: 'Ben Commenter', text: 'should' }] },
      ],
    }
    const { rows } = reviewResponseRows([log], { fieldTitle })
    assert.equal(rows[0].outcome, 'Edit accepted')
    assert.equal(rows[1].outcome, "Another commenter's edit was accepted instead")
  })

  test('the file is named for the Instance', () => {
    assert.equal(reviewResponseFilename('Payments: HLD'), 'Payments HLD - Review response list.docx')
    assert.equal(reviewResponseFilename(''), 'Review response list.docx')
  })
})

describe('the Word document', async () => {
  const cards = await buildCards()
  const log = logFor(cards, (card) => (offers(card, REVIEW_CHOICES.keep) ? { selected: [REVIEW_CHOICES.keep], reason: 'Not <for> this & that.' } : { selected: [REVIEW_CHOICES.note] }))
  const list = reviewResponseRows({ shape: log }, { fieldTitle })
  const bytes = reviewResponseDocx(list, { instanceName: 'Payments HLD', date: '2026-11-05' })

  test('is a Word package whose table holds every answered comment, with the XML escaped', async () => {
    const parts = await readPackageTexts(bytes, (name) => name.endsWith('.xml'))
    const document = parts.get('word/document.xml')
    assert.ok(parts.get('word/styles.xml') && parts.get('docProps/core.xml'))
    assert.match(document, /Review response list/)
    assert.match(document, new RegExp(`Payments HLD\\. ${list.rows.length} comments answered\\. Made 2026-11-05\\.`))
    assert.match(document, /HLD - Ana and Ben\.docx/)
    assert.match(document, /Not &lt;for&gt; this &amp; that\./)
    for (const heading of ['Comment', 'Commenter', 'Where', 'Outcome', 'Reason']) assert.match(document, new RegExp(`>${heading}<`))
    assert.equal((document.match(/<w:tr>/g) ?? []).length, 1 + list.rows.length, 'a header row and one row for each comment')
    assert.match(document, /Add the team/)
    assert.match(document, /Ben Commenter \(2026-11-04\)/)
  })

  test('opens as a valid zip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-response-'))
    const file = join(dir, 'list.docx')
    writeFileSync(file, bytes)
    const out = execFileSync('python3', ['-I', '-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(sorted(z.namelist())))', file]).toString()
    assert.match(out, /word\/document\.xml/)
    assert.match(out, /\[Content_Types\]\.xml/)
  })

  test('downloading builds the file on demand and nothing when there is nothing to list', () => {
    const made = []
    assert.equal(downloadReviewResponseList({ shape: log }, { instanceName: 'Payments HLD', fieldTitle, download: (b, name) => made.push([b.length > 0, name]) }), list.rows.length)
    assert.deepEqual(made, [[true, 'Payments HLD - Review response list.docx']])
    assert.equal(downloadReviewResponseList({ shape: { entries: [] } }, { download: () => made.push('no') }), 0)
    assert.equal(made.length, 1)
  })
})
