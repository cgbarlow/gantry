import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_SIZE,
  acceptRecommendation,
  answersText,
  cardPriority,
  changeCard,
  choose,
  chooseOther,
  followsRecommendation,
  isAnswered,
  pageCards,
  pageCount,
  releaseHeld,
  shapeCard,
  sortRound,
  splitReady,
} from '../web/lib/interviewRounds.js'
import { fieldDone, minWords, stageReadiness } from '../web/lib/interviewReadiness.js'
import { markTargetAssumptions } from '../web/lib/interviewDraft.js'
import { requiredFieldKeys } from '../web/lib/interviewBrief.js'

// #287 (parent #238): the pure parts of rounds of question cards and of "is this Field done / this Stage ready".

const card = (over = {}) => ({
  id: 'q',
  header: 'H',
  question: 'Which?',
  options: [{ label: 'A', description: '', draft: '' }, { label: 'B', description: '', draft: '' }],
  multiSelect: false,
  recommended: ['A'],
  why: '',
  source: null,
  field: null,
  ...over,
})

// ---------- paging ----------

test('cards show four at a time: a round of ten is three pages of 4, 4 and 2', () => {
  const cards = Array.from({ length: 10 }, (_, i) => card({ id: `c${i}` }))
  assert.equal(PAGE_SIZE, 4)
  assert.equal(pageCount(cards.length), 3)
  assert.deepEqual(pageCards(cards, 0).map((c) => c.id), ['c0', 'c1', 'c2', 'c3'])
  assert.deepEqual(pageCards(cards, 1).map((c) => c.id), ['c4', 'c5', 'c6', 'c7'])
  assert.deepEqual(pageCards(cards, 2).map((c) => c.id), ['c8', 'c9'])
  assert.deepEqual(pageCards(cards, 9).map((c) => c.id), ['c8', 'c9'], 'a page past the end shows the last one')
  assert.deepEqual(pageCards(cards, -3).map((c) => c.id), ['c0', 'c1', 'c2', 'c3'])
  assert.equal(pageCount(0), 1)
  assert.equal(pageCount(4), 1)
  assert.equal(pageCount(5), 2)
})

// ---------- order and prerequisites ----------

test("Gantry's priority order only sorts a round: required Fields, disagreements, missing facts, optional Fields", () => {
  const required = new Set(['m.req'])
  const cards = [
    card({ id: 'optional', field: 'm.opt' }),
    card({ id: 'missing', kind: 'missing' }),
    card({ id: 'clash', kind: 'disagreement' }),
    card({ id: 'req', field: 'm.req' }),
    card({ id: 'req-clash', field: 'm.req', kind: 'disagreement' }),
  ]
  assert.deepEqual(cards.map((c) => cardPriority(c, required)), [3, 2, 1, 0, 0])
  assert.deepEqual(sortRound(cards, required).map((c) => c.id), ['req', 'req-clash', 'clash', 'missing', 'optional'], 'stable within a priority')
})

test('a card waits while a card it comes after is still open; an id nobody asked is not waited for', () => {
  const cards = [card({ id: 'a' }), card({ id: 'b', after: ['a'] }), card({ id: 'c', after: ['b'] }), card({ id: 'd', after: ['never-asked'] })]
  const { ready, held } = splitReady(cards)
  assert.deepEqual(ready.map((c) => c.id), ['a', 'd'])
  assert.deepEqual(held.map((c) => c.id), ['b', 'c'])
  // Once a is answered, b is ready; c still waits on b.
  assert.deepEqual(splitReady(held, new Set(['a']), []).ready.map((c) => c.id), ['b'])
  const released = releaseHeld(held, new Set(['a']))
  assert.deepEqual(released.released.map((c) => c.id), ['b'])
  assert.deepEqual(released.held.map((c) => c.id), ['c'])
  assert.deepEqual(releaseHeld([card({ id: 'x', after: ['y'] })], new Set(), ['y']).released.map((c) => c.id), [], 'a card waits on one that is being asked now')
})

test('cards that wait on each other in a loop are all shown rather than none', () => {
  const { ready, held } = splitReady([card({ id: 'a', after: ['b'] }), card({ id: 'b', after: ['a'] })])
  assert.deepEqual(ready.map((c) => c.id), ['a', 'b'])
  assert.deepEqual(held, [])
})

// ---------- the card ----------

test('a select Field card shows the Definition\'s options only, with no Other; any other card has Other', () => {
  const field = { id: 'risk', type: 'select', options: ['Low', 'Medium', 'High', 'Severe', 'Extreme'], default: 'Medium' }
  const shaped = shapeCard(card({ options: [{ label: 'low', description: 'Little', draft: '' }, { label: 'lots', description: '', draft: '' }], recommended: ['low'] }), { field })
  assert.deepEqual(shaped.options.map((o) => o.label), field.options)
  assert.equal(shaped.options[0].description, 'Little', 'the model\'s description is kept where the label matches')
  assert.equal(shaped.allowOther, false)
  assert.deepEqual(shaped.selected, ['Low'])
  assert.equal(chooseOther(shaped), shaped)
  const plain = shapeCard(card(), { field: { id: 'notes', type: 'markdown' } })
  assert.equal(plain.allowOther, true)
  assert.deepEqual(plain.selected, ['A'])
  assert.equal(shapeCard(card(), null).allowOther, true)
})

test('a select Field that allows several choices makes a "choose any" card', () => {
  const field = { id: 'tags', type: 'select', multiple: true, options: ['X', 'Y', 'Z'] }
  const shaped = shapeCard(card({ recommended: ['x', 'z'], multiSelect: true }), { field })
  assert.equal(shaped.multiSelect, true)
  assert.deepEqual(shaped.selected, ['X', 'Z'])
})

test('choosing: one choice on a single card, several on a "choose any" card, and Other', () => {
  let single = shapeCard(card(), null)
  single = choose(single, 'B')
  assert.deepEqual(single.selected, ['B'])
  single = chooseOther(single)
  assert.deepEqual(single.selected, [])
  assert.equal(single.otherOn, true)
  assert.equal(isAnswered(single), false, 'Other with nothing typed is not an answer')
  single = { ...single, otherText: ' Gamma ' }
  assert.equal(isAnswered(single), true)
  assert.equal(followsRecommendation(single), false)
  assert.deepEqual(choose(single, 'A').selected, ['A'])
  assert.equal(choose(single, 'A').otherOn, false)
  assert.equal(choose(single, 'nope'), single, 'an unknown option changes nothing')

  let multi = shapeCard(card({ multiSelect: true, recommended: ['A'] }), null)
  multi = choose(multi, 'B')
  assert.deepEqual(multi.selected, ['A', 'B'])
  multi = choose(multi, 'A')
  assert.deepEqual(multi.selected, ['B'])
  multi = chooseOther(multi)
  assert.equal(multi.otherOn, true)
  assert.deepEqual(multi.selected, ['B'], 'Other sits beside the other choices')
})

test('Finish with your recommendations: an unanswered card takes its recommendation, an answered one keeps its answer', () => {
  const blank = { ...shapeCard(card(), null), selected: [] }
  assert.deepEqual(acceptRecommendation(blank).selected, ['A'])
  const chosen = choose(shapeCard(card(), null), 'B')
  assert.deepEqual(acceptRecommendation(chosen).selected, ['B'])
  const noRec = { ...blank, recommended: [] }
  assert.deepEqual(acceptRecommendation(noRec).selected, ['A'], 'with no recommendation the first option stands in')
})

test('the answers sent back name each card, say whether it followed the recommendation, and quote the architect\'s own words', () => {
  const a = choose(shapeCard(card({ id: 'one', question: 'One?', field: 'm.f', options: [{ label: 'A', description: '', draft: 'Draft A' }, { label: 'B', description: '', draft: '' }] }), null), 'A')
  const b = { ...chooseOther(shapeCard(card({ id: 'two', question: 'Two?' }), null)), otherText: 'Our own way' }
  const text = answersText([a, b])
  assert.match(text, /\[one\] One\? → "A" \(your recommendation\)\. Feeds m\.f\./)
  assert.match(text, /Text for "A": Draft A/)
  assert.match(text, /\[two\] Two\? → Other, in the architect's own words: "Our own way" \(not your recommendation\)\./)
})

test('a saved-content card offers Keep, the AI\'s version and Merge, and recommends keeping', () => {
  const c = changeCard({ key: 'm.f', fieldTitle: 'M · F', saved: 'old', proposed: 'new' })
  assert.deepEqual(c.options.map((o) => o.label), ['Keep', "Use the AI's version", 'Merge'])
  assert.deepEqual(c.recommended, ['Keep'])
  assert.equal(c.allowOther, false)
  assert.match(answersText([choose(c, 'Merge')]), /Write one merged version of m\.f/)
  assert.match(answersText([c]), /stays as saved/)
})

// ---------- target assumptions ----------

test('Finish marks an unsourced figure "(target assumption)" once per clause, and leaves cited or told figures alone', () => {
  assert.equal(markTargetAssumptions('Delivery takes 12 weeks and costs $50k.'), 'Delivery takes 12 weeks and costs $50k (target assumption).')
  assert.equal(markTargetAssumptions('It takes 12 weeks [Brief, p. 1](source:brief); then 3 servers join.'), 'It takes 12 weeks [Brief, p. 1](source:brief); then 3 servers join (target assumption).')
  assert.equal(markTargetAssumptions('It takes 12 weeks (target assumption).'), 'It takes 12 weeks (target assumption).', 'already marked')
  assert.equal(markTargetAssumptions('Budget is $1.2M.', 'the budget is $1.2M'), 'Budget is $1.2M.', 'the architect said it')
  assert.equal(markTargetAssumptions('No numbers here.'), 'No numbers here.')
  assert.equal(markTargetAssumptions('- first 5 days\n- second'), '- first 5 days (target assumption)\n- second')
})

// ---------- done and ready ----------

const field = { id: 'f', type: 'markdown', targetWords: { small: 10, medium: 100, large: 200 } }
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

test('a Field is done at about 60% of its budget, up to the budget, covering its guidance, with no open question', () => {
  assert.equal(minWords(100), 60)
  assert.equal(fieldDone({ field, value: '' }).done, false)
  assert.match(fieldDone({ field, value: '' }).reasons[0], /no content/)
  assert.match(fieldDone({ field, value: words(59) }).reasons[0], /59 words, needs about 60 to 100/)
  assert.equal(fieldDone({ field, value: words(60) }).done, true)
  assert.equal(fieldDone({ field, value: words(100) }).done, true)
  assert.match(fieldDone({ field, value: words(101) }).reasons[0], /over its budget of 100/)
  assert.match(fieldDone({ field, value: words(80), uncovered: ['the rollout date'] }).reasons[0], /does not yet cover: the rollout date/)
  assert.match(fieldDone({ field, value: words(80), open: true }).reasons[0], /question feeding it is still open/)
  assert.equal(fieldDone({ field: { id: 's', type: 'select' }, value: 'Low' }).done, true, 'a Field with no budget needs only content')
  assert.equal(fieldDone({ field, value: words(80), size: 'small' }).done, false, 'the budget follows the Target size')
})

function structure() {
  return {
    id: 'small',
    standardModules: [],
    stages: [{ id: 'shape', title: 'Shape', gate: 'shaped', modules: ['details'] }],
    artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary'] }],
    modules: [
      {
        id: 'details',
        title: 'Details',
        fields: [
          { id: 'summary', title: 'Summary', type: 'markdown', required: true, targetWords: { small: 10, medium: 100, large: 200 } },
          { id: 'notes', title: 'Notes', type: 'markdown' },
          { id: 'owner', title: 'Owner', type: 'text' },
        ],
      },
    ],
  }
}
const saved = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }, { id: 'owner', value: '' }] }]

test('the Stage is ready only when the Gate check passes and every Field in scope is done', () => {
  const s = structure()
  const base = { definition: s, structure: s, stageId: 'shape', artefactId: 'light', size: 'medium', modules: saved() }
  assert.deepEqual([...requiredFieldKeys(s, 'shape', 'light')], ['details.summary'])

  const empty = stageReadiness({ ...base })
  assert.equal(empty.ready, false)
  assert.deepEqual(Object.keys(empty.fields), ['details.summary'], 'an empty optional Field is not in scope')

  // The Gate would pass on a short summary, but the Field is not done: not ready.
  const short = stageReadiness({ ...base, drafts: { 'details.summary': { value: words(10) } } })
  assert.equal(short.gate.pass, true)
  assert.equal(short.allDone, false)
  assert.equal(short.ready, false)

  const full = stageReadiness({ ...base, drafts: { 'details.summary': { value: words(80) } } })
  assert.equal(full.ready, true)

  // An optional Field with content joins the scope and has to be done too.
  const withNotes = stageReadiness({ ...base, drafts: { 'details.summary': { value: words(80) }, 'details.owner': { value: 'Pat' }, 'details.notes': { value: 'tiny', uncovered: [] } } })
  assert.equal(withNotes.ready, true, 'a Field with no budget needs only content')

  // An open question feeding a Field stops it being done.
  const open = stageReadiness({ ...base, drafts: { 'details.summary': { value: words(80) } }, openFields: ['details.summary'] })
  assert.equal(open.ready, false)
  assert.match(open.fields['details.summary'].reasons[0], /still open/)

  // Saved content counts.
  const savedFull = saved()
  savedFull[0].fields[0].value = words(70)
  assert.equal(stageReadiness({ ...base, modules: savedFull }).ready, true)

  // A draft with an uncovered guidance point is not done.
  const uncovered = stageReadiness({ ...base, drafts: { 'details.summary': { value: words(80), uncovered: ['risks'] } } })
  assert.equal(uncovered.ready, false)
})
