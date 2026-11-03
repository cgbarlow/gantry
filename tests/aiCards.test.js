import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_TOOL,
  extractQuestionBlocks,
  interpretTurn,
  startsQuestionBlock,
  stripQuestionBlock,
  validateCards,
} from '../web/lib/aiCards.js'

// #278 (ADR-0065): question cards. Gantry validates each card itself: 2-4 options, the recommendation is one of
// them, any cited Source document exists. A round holds any number of questions.

const q = (over = {}) => ({
  header: 'Problem',
  question: 'Which driver leads?',
  options: [{ label: 'Cost', description: 'Cheaper' }, { label: 'Speed' }],
  recommended: 'Cost',
  why: 'The business case leads with it.',
  ...over,
})

test('a valid round is accepted and normalised, whatever its size', () => {
  const many = { questions: Array.from({ length: 7 }, (_, i) => q({ question: `Question ${i}?` })) }
  const result = validateCards(many)
  assert.equal(result.ok, true)
  assert.equal(result.cards.length, 7, 'a round holds any number of questions')
  assert.deepEqual(result.cards[0], {
    id: 'q-1',
    header: 'Problem',
    question: 'Question 0?',
    options: [{ label: 'Cost', description: 'Cheaper', draft: '' }, { label: 'Speed', description: '', draft: '' }],
    multiSelect: false,
    recommended: ['Cost'],
    why: 'The business case leads with it.',
    source: null,
    field: null,
  })
})

test('2 to 4 options: one or five is refused, naming the question', () => {
  const one = validateCards({ questions: [q(), q({ options: [{ label: 'Only' }], recommended: 'Only' })] })
  assert.equal(one.ok, false)
  assert.match(one.errors[0], /questions\[1\]\.options has 1: give 2 to 4/)
  const five = validateCards({ questions: [q({ options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label })), recommended: 'A' })] })
  assert.match(five.errors[0], /has 5/)
  for (const n of [2, 3, 4]) {
    const options = ['A', 'B', 'C', 'D'].slice(0, n).map((label) => ({ label }))
    assert.equal(validateCards({ questions: [q({ options, recommended: 'A' })] }).ok, true, `${n} options`)
  }
})

test('the recommendation must be one of the options, matched by label', () => {
  const bad = validateCards({ questions: [q({ recommended: 'Cheapness' })] })
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0], /recommended "Cheapness" is not one of the options/)
  assert.match(validateCards({ questions: [q({ recommended: undefined })] }).errors[0], /recommended is missing/)
  assert.deepEqual(validateCards({ questions: [q({ recommended: 'cost' })] }).cards[0].recommended, ['Cost'], 'case differences are forgiven and the option’s own spelling used')
})

test('multi-select takes several recommendations; single-select takes one', () => {
  const multi = validateCards({ questions: [q({ multiSelect: true, recommended: ['Cost', 'Speed'] })] })
  assert.equal(multi.ok, true)
  assert.deepEqual(multi.cards[0].recommended, ['Cost', 'Speed'])
  assert.equal(multi.cards[0].multiSelect, true)
  assert.match(validateCards({ questions: [q({ recommended: ['Cost', 'Speed'] })] }).errors[0], /multiSelect/)
  assert.equal(validateCards({ questions: [q({ recommended: ['Cost'] })] }).ok, true)
})

test('duplicate or empty labels and a missing question are refused', () => {
  assert.match(validateCards({ questions: [q({ options: [{ label: 'A' }, { label: 'a' }], recommended: 'A' })] }).errors[0], /different from each other/)
  assert.match(validateCards({ questions: [q({ options: [{ label: 'A' }, { description: 'no label' }], recommended: 'A' })] }).errors.join(' '), /needs a "label"/)
  assert.match(validateCards({ questions: [q({ question: ' ' })] }).errors[0], /question is missing/)
})

test('a cited Source document must exist when the Instance’s documents are known', () => {
  const known = [{ id: 'src-1', title: 'Business Case v2' }, 'src-2']
  const ok = validateCards({ questions: [q({ source: { document: 'src-1', location: 'p. 11' } })] }, { knownSources: known })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.cards[0].source, { document: 'src-1', location: 'p. 11' })
  assert.deepEqual(validateCards({ questions: [q({ source: 'Business Case v2' })] }, { knownSources: known }).cards[0].source, { document: 'src-1', location: '' }, 'a title resolves to the id; a bare string is accepted')
  const missing = validateCards({ questions: [q({ source: { document: 'src-9' } })] }, { knownSources: known })
  assert.equal(missing.ok, false)
  assert.match(missing.errors[0], /"src-9" is not one of this Instance's Source documents/)
  assert.equal(validateCards({ questions: [q({ source: { document: 'src-1' } })] }, { knownSources: [] }).ok, false, 'no Source documents means none can be cited')
  assert.equal(validateCards({ questions: [q({ source: { document: 'anything' } })] }).ok, true, 'without a known list the citation is not checked')
})

test('input that is not a list of questions is refused with something the model can act on', () => {
  for (const input of [null, {}, { questions: [] }, 'text', { questions: 'x' }]) {
    const result = validateCards(input)
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /at least one question/)
  }
  assert.match(validateCards({ questions: ['not an object'] }).errors[0], /must be an object/)
})

test('the tool offered to the model is ask_architect, with the bounds in its schema', () => {
  assert.equal(ASK_TOOL.name, 'ask_architect')
  const options = ASK_TOOL.parameters.properties.questions.items.properties.options
  assert.equal(options.minItems, 2)
  assert.equal(options.maxItems, 4)
  assert.ok(ASK_TOOL.parameters.properties.questions.items.required.includes('recommended'))
})

// ---------- the text fallback ----------

const BLOCK = (obj) => 'Here are my questions.\n\n```gantry-questions\n' + JSON.stringify(obj, null, 2) + '\n```\n'

test('a gantry-questions block parses into the same cards as a native call', () => {
  const input = { questions: [q()] }
  const native = interpretTurn({ toolCalls: [{ id: 'c1', name: 'ask_architect', input }] })
  const text = interpretTurn({ text: BLOCK(input) })
  assert.equal(native.kind, 'cards')
  assert.equal(native.via, 'native')
  assert.equal(text.kind, 'cards')
  assert.equal(text.via, 'text')
  assert.deepEqual(text.cards, native.cards)
  assert.equal(text.text, 'Here are my questions.', 'the block is taken out of the chat text')
  // a bare array of questions is accepted too
  assert.equal(interpretTurn({ text: '```gantry-questions\n' + JSON.stringify([q()]) + '\n```' }).kind, 'cards')
})

test('several blocks add up to one round', () => {
  const text = BLOCK({ questions: [q({ question: 'One?' })] }) + BLOCK({ questions: [q({ question: 'Two?' })] })
  const turn = interpretTurn({ text })
  assert.deepEqual(turn.cards.map((c) => c.question), ['One?', 'Two?'])
})

test('unparseable or invalid fallback output becomes chat, never an error', () => {
  const broken = interpretTurn({ text: 'Sure.\n```gantry-questions\n{not json\n```' })
  assert.equal(broken.kind, 'chat')
  assert.match(broken.invalidBlock[0], /not valid JSON/)
  assert.match(broken.text, /Sure\./)
  const invalid = interpretTurn({ text: BLOCK({ questions: [q({ recommended: 'Nothing' })] }) })
  assert.equal(invalid.kind, 'chat')
  assert.match(invalid.invalidBlock[0], /not one of the options/)
  const plain = interpretTurn({ text: 'What would you like to do next?' })
  assert.deepEqual(plain, { kind: 'chat', text: 'What would you like to do next?' })
})

test('a native tool call wins over a block in the same turn', () => {
  const turn = interpretTurn({ text: BLOCK({ questions: [q({ question: 'From the block?' })] }), toolCalls: [{ id: 'c', name: 'ask_architect', input: { questions: [q({ question: 'From the tool?' })] } }] })
  assert.equal(turn.via, 'native')
  assert.equal(turn.cards[0].question, 'From the tool?')
})

test('an invalid native call is reported once with an error result per call, naming what is wrong', () => {
  const turn = interpretTurn({ toolCalls: [{ id: 'c1', name: 'ask_architect', input: { questions: [q({ options: [{ label: 'Only' }], recommended: 'Only' })] } }] })
  assert.equal(turn.kind, 'invalid')
  assert.equal(turn.results.length, 1)
  assert.equal(turn.results[0].toolCallId, 'c1')
  assert.equal(turn.results[0].isError, true)
  assert.match(turn.results[0].content, /options has 1: give 2 to 4/)
  const unparseable = interpretTurn({ toolCalls: [{ id: 'c2', name: 'ask_architect', input: null, invalid: 'The arguments were not valid JSON (x).' }] })
  assert.equal(unparseable.kind, 'invalid')
  assert.match(unparseable.results[0].content, /not valid JSON/)
})

test('text meant for the screen never shows the block, even one still being written', () => {
  assert.equal(stripQuestionBlock('Hello\n```gantry-questions\n{"questions":[{"que'), 'Hello')
  assert.equal(stripQuestionBlock(BLOCK({ questions: [q()] })), 'Here are my questions.')
  assert.equal(stripQuestionBlock('Just text'), 'Just text')
  assert.equal(startsQuestionBlock('Hello\n```gantry-questions\n{'), true)
  assert.equal(startsQuestionBlock('```json\n{}\n```'), false)
  assert.equal(extractQuestionBlocks('no block').found, false)
})

test('a card can name the cards it comes after and say what kind of question it is (#287); both are optional', () => {
  const plain = validateCards({ questions: [q()] }).cards[0]
  assert.equal('after' in plain, false)
  assert.equal('kind' in plain, false)
  const card = validateCards({ questions: [q({ id: 'second', after: ['first', ' '], kind: 'Disagreement' }), q({ kind: 'surprise', after: 'one' })] }).cards
  assert.equal(card[0].id, 'second')
  assert.deepEqual(card[0].after, ['first'])
  assert.equal(card[0].kind, 'disagreement')
  assert.equal('kind' in card[1], false, 'an unknown kind is ignored')
  assert.deepEqual(card[1].after, ['one'], 'a single id is accepted')
  const props = ASK_TOOL.parameters.properties.questions.items.properties
  assert.ok(props.id && props.after && props.kind, 'the model is told about them')
})
