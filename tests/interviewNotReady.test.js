import { test } from 'node:test'
import assert from 'node:assert/strict'

// #350: what keeps a Stage from its stage-end card, shown to the architect on the Not ready yet card and told to the AI in Gantry's note
// (#349), is one list in one wording: web/lib/interviewReadiness.js `outstandingItems`, over the page's own readiness verdict. The card
// links each Field to the live draft preview and its Ask the AI to finish these sends the same list as the architect's message; the
// note names each Field with its key as well, so the AI can draft it. The screen is tests/interviewNotReady.playwright.test.js.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const { stageReadiness, outstandingItems, outstandingLine, finishTheseMessage } = await import('../web/lib/interviewReadiness.js')
const { readinessNote } = await import('../web/lib/interviewSession.js')

// The Gate needs the Problem statement (a budget of 24 to 40 words at medium) and an Owner.
const definition = {
  id: 'small',
  standardModules: [],
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary', 'details.owner'] }],
  modules: [
    {
      id: 'details',
      title: 'Details',
      fields: [
        { id: 'summary', title: 'Problem statement', type: 'markdown', required: true, targetWords: { small: 10, medium: 40, large: 80 } },
        { id: 'owner', title: 'Owner', type: 'text' },
      ],
    },
  ],
}
const saved = [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'owner', value: '' }] }]
const words = (n) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ')
const verdictFor = (drafts) => stageReadiness({ definition, structure: definition, stageId: 'shape', artefactId: 'light', size: 'medium', modules: saved, drafts })
const TITLES = { 'details.summary': 'Details · Problem statement', 'details.owner': 'Details · Owner' }
const title = (key) => TITLES[key] ?? key

test('the list: the Gate check\'s outstanding items first, then each Field in scope that isn\'t done with its reasons', () => {
  const items = outstandingItems(verdictFor({ 'details.summary': { value: words(5) } }), { name: title })
  assert.deepEqual(items, [
    { kind: 'gate', text: 'The Gate check for Light: outstanding Details · Owner' },
    { kind: 'field', key: 'details.summary', name: 'Details · Problem statement', text: '5 words, needs about 24 to 40' },
    { kind: 'field', key: 'details.owner', name: 'Details · Owner', text: 'no content yet' },
  ])
  assert.deepEqual(items.map(outstandingLine), [
    'The Gate check for Light: outstanding Details · Owner',
    'Details · Problem statement: 5 words, needs about 24 to 40',
    'Details · Owner: no content yet',
  ])
})

test('a Field with more than one reason has them in one line; a Gate with no Artefact aimed for says so', () => {
  const verdict = {
    gate: { pass: false, artefact: null, outstanding: [] },
    fields: { 'details.summary': { done: false, reasons: ['50 words, over its budget of 40', 'does not yet cover: who is affected'] }, 'details.owner': { done: true, reasons: [] } },
    ready: false,
  }
  assert.deepEqual(outstandingItems(verdict, { name: title }).map(outstandingLine), [
    'The Gate check: no Artefact is aimed for yet.',
    'Details · Problem statement: 50 words, over its budget of 40; does not yet cover: who is affected',
  ])
  // A Gate that fails with nothing it can name still says so, in the same words.
  assert.deepEqual(outstandingItems({ gate: { pass: false, artefact: { id: 'light', title: 'Light' }, outstanding: [] }, fields: {} }).map(outstandingLine), ['The Gate check for Light: does not pass yet'])
})

test('nothing outstanding when the Stage is ready, or there is no verdict', () => {
  assert.deepEqual(outstandingItems(verdictFor({ 'details.summary': { value: words(30) }, 'details.owner': { value: 'Pat' } })), [])
  assert.deepEqual(outstandingItems(null), [])
})

test('the AI\'s note and the card read the same list: the note names each Field with its key as well', () => {
  const verdict = verdictFor({ 'details.summary': { value: words(5) } })
  const note = readinessNote(verdict, { fieldTitle: title })
  const named = (key) => `${title(key)} (${key})`
  for (const item of outstandingItems(verdict, { name: named })) assert.ok(note.includes(`- ${outstandingLine(item)}\n`), `${outstandingLine(item)} in\n${note}`)
  assert.match(note, /- The Gate check for Light: outstanding Details · Owner \(details\.owner\)/)
  assert.match(note, /- Details · Problem statement \(details\.summary\): 5 words, needs about 24 to 40/)
})

test('Ask the AI to finish these: the architect\'s message is the card\'s own list', () => {
  const items = outstandingItems(verdictFor({ 'details.summary': { value: words(5) } }), { name: title })
  assert.equal(
    finishTheseMessage(items),
    [
      'Please finish these, so the Stage is ready:',
      '- The Gate check for Light: outstanding Details · Owner',
      '- Details · Problem statement: 5 words, needs about 24 to 40',
      '- Details · Owner: no content yet',
    ].join('\n')
  )
})
