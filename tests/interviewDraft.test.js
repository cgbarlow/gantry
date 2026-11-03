import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_TOOL,
  DRAFT_TOOL_NAME,
  checkDraft,
  citationSegments,
  citedSourceIds,
  extractDraftBlocks,
  normaliseDraftValue,
  stripDraftBlocks,
  unsourcedFigures,
} from '../web/lib/interviewDraft.js'

// #286 (parent #238): the draft field step. The AI writes a Field through one tool; Gantry checks the draft before it
// reaches the preview. These are the pure checks and the text-fallback reader.

const markdown = { id: 'summary', type: 'markdown', targetWords: { small: 5, medium: 10, large: 20 } }
const select = { id: 'risk', type: 'select', options: ['Low', 'Medium', 'High'] }
const multi = { id: 'domains', type: 'select', multiple: true, options: ['Claims', 'Finance', 'Brokers'] }
const list = { id: 'goals', type: 'list' }

describe('the tool', () => {
  test('is called draft_field and asks for a Field and a value', () => {
    assert.equal(DRAFT_TOOL.name, DRAFT_TOOL_NAME)
    assert.equal(DRAFT_TOOL_NAME, 'draft_field')
    assert.deepEqual(DRAFT_TOOL.parameters.required, ['field', 'value'])
  })
})

describe('normaliseDraftValue', () => {
  test('a list or multi-select Field holds trimmed, non-empty strings; bullets in text are split', () => {
    assert.deepEqual(normaliseDraftValue(list, ['  one ', '', 'two']), ['one', 'two'])
    assert.deepEqual(normaliseDraftValue(list, '- one\n* two\n\nthree'), ['one', 'two', 'three'])
    assert.deepEqual(normaliseDraftValue(multi, 'Claims'), ['Claims'])
  })
  test('any other Field holds one string', () => {
    assert.equal(normaliseDraftValue(markdown, '  hello\r\nworld  '), 'hello\nworld')
    assert.equal(normaliseDraftValue(markdown, ['a', 'b']), 'a\nb')
  })
})

describe('unsourcedFigures', () => {
  test('a bare figure is caught; a source link or "(target assumption)" after it clears it', () => {
    assert.deepEqual(unsourcedFigures('Claims take 12 days to settle.'), ['12 days'])
    assert.deepEqual(unsourcedFigures('Claims take 12 days to settle [Business case, p. 4](source:business-case).'), [])
    assert.deepEqual(unsourcedFigures('Availability of 99.5% (target assumption).'), [])
    assert.deepEqual(unsourcedFigures('Availability of 99.5% (see the business case).'), ['99.5%'])
  })
  test('one citation covers every figure before it in the clause; a full stop ends the clause', () => {
    assert.deepEqual(unsourcedFigures('70% by 2027, up from 42% today [Case, p. 9](source:case). Costs $1.2M.'), ['$1.2M'])
  })
  test('currency, years and dates are figures; versions, ids and ordinals are not', () => {
    assert.deepEqual(unsourcedFigures('Go-live in 2027, budget $1.2M, signed 2026-11-02.'), ['2027', '$1.2M', '2026-11-02'])
    assert.deepEqual(unsourcedFigures('TLS 1.3, WCAG 2.1, PDM-01, the 95th percentile and ISO 27001.'), [])
  })
  test('a figure the architect typed in the interview needs no source', () => {
    assert.deepEqual(unsourcedFigures('Budget is $1.2M and 38,000 claims a year.', 'the budget is capped at $1.2M'), ['38,000 claims'])
  })
  test('a table cell is its own clause', () => {
    assert.deepEqual(unsourcedFigures('| Production | 400 GB (target assumption) | 2 vCPU |'), ['2 vCPU'])
  })
})

describe('citations', () => {
  test('citedSourceIds and citationSegments read [text](source:id)', () => {
    const text = 'Support ends in March [Case, p. 4](source:case) and again [Workshop](source:notes).'
    assert.deepEqual(citedSourceIds(text), ['case', 'notes'])
    assert.deepEqual(citationSegments(text), [
      { text: 'Support ends in March ' },
      { cite: 'Case, p. 4', id: 'case' },
      { text: ' and again ' },
      { cite: 'Workshop', id: 'notes' },
      { text: '.' },
    ])
  })
})

describe('checkDraft', () => {
  test('a clean draft has no problems and is counted', () => {
    const result = checkDraft(markdown, 'Short and clear.', { size: 'medium' })
    assert.deepEqual(result.problems, [])
    assert.equal(result.words, 3)
    assert.equal(result.value, 'Short and clear.')
  })

  test('a select value must be one of the options (matched without regard to case)', () => {
    assert.deepEqual(checkDraft(select, 'High').problems, [])
    assert.equal(checkDraft(select, 'high').value, 'High')
    const bad = checkDraft(select, 'Critical')
    assert.equal(bad.problems[0].kind, 'options')
    assert.match(bad.problems[0].message, /"Critical" is not one of the options/)
    assert.match(bad.problems[0].message, /"Low", "Medium", "High"/)
    assert.equal(checkDraft(select, ['Low', 'High']).problems[0].kind, 'options', 'one option only')
  })

  test('a multi-select takes several options, each checked', () => {
    assert.deepEqual(checkDraft(multi, ['Claims', 'Finance']).problems, [])
    const bad = checkDraft(multi, ['Claims', 'Legal'])
    assert.equal(bad.problems.length, 1)
    assert.match(bad.problems[0].message, /"Legal"/)
  })

  test('an over-budget draft is a problem naming the budget at the Instance size', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve'
    assert.deepEqual(checkDraft(markdown, long, { size: 'large' }).problems, [])
    const over = checkDraft(markdown, long, { size: 'small' })
    assert.equal(over.problems[0].kind, 'budget')
    assert.match(over.problems[0].message, /12 words is over the Small budget of about 5/)
  })

  test('a Field with no budget has no word limit', () => {
    assert.deepEqual(checkDraft({ id: 'free', type: 'markdown' }, 'word '.repeat(500)).problems, [])
  })

  test('an unsourced figure is a problem; a source link, a target assumption or the architect\'s own words clear it', () => {
    const bare = checkDraft({ id: 'f', type: 'markdown' }, 'It will serve 5000 users.')
    assert.equal(bare.problems[0].kind, 'figures')
    assert.match(bare.problems[0].message, /"5000 users"/)
    assert.deepEqual(checkDraft({ id: 'f', type: 'markdown' }, 'It will serve 5000 users [Brief, p. 2](source:brief).', { knownSourceIds: ['brief'] }).problems, [])
    assert.deepEqual(checkDraft({ id: 'f', type: 'markdown' }, 'It will serve 5000 users (target assumption).').problems, [])
    assert.deepEqual(checkDraft({ id: 'f', type: 'markdown' }, 'It will serve 5000 users.', { architectText: 'we expect 5000 users' }).problems, [])
  })

  test('a list Field is checked item by item as one text', () => {
    const result = checkDraft(list, ['Cut costs by 30%', 'Faster claims (target assumption)'])
    assert.equal(result.problems[0].kind, 'figures')
    assert.match(result.problems[0].message, /"30%"/)
  })

  test('a citation to a Source document that is not there is a problem', () => {
    const result = checkDraft({ id: 'f', type: 'markdown' }, 'The insurer wants speed [Brief](source:nope).', { knownSourceIds: ['brief', 'notes'] })
    assert.equal(result.problems[0].kind, 'citation')
    assert.match(result.problems[0].message, /source:nope/)
    assert.match(result.problems[0].message, /brief, notes/)
  })

  test('a date is written YYYY-MM-DD', () => {
    assert.deepEqual(checkDraft({ id: 'd', type: 'date' }, '2026-11-02').problems, [])
    assert.equal(checkDraft({ id: 'd', type: 'date' }, 'next Tuesday').problems[0].kind, 'date')
  })
})

describe('the text fallback', () => {
  test('reads draft blocks, one or several, and strips them from the chat', () => {
    const text = [
      'Here is what I found.',
      '```gantry-draft',
      '{"field":"background.problem","value":"The portal is old."}',
      '```',
      'And the next.',
      '```gantry-draft',
      '{"drafts":[{"field":"background.goals","value":["a","b"]}]}',
      '```',
    ].join('\n')
    const { drafts, errors } = extractDraftBlocks(text)
    assert.deepEqual(errors, [])
    assert.deepEqual(drafts, [
      { field: 'background.problem', value: 'The portal is old.' },
      { field: 'background.goals', value: ['a', 'b'] },
    ])
    assert.equal(stripDraftBlocks(text), 'Here is what I found.\n\nAnd the next.')
  })

  test('a block still being written is hidden, and a broken block is an error, not a crash', () => {
    assert.equal(stripDraftBlocks('Working.\n```gantry-draft\n{"field":"a.b","val'), 'Working.')
    const { drafts, errors } = extractDraftBlocks('```gantry-draft\n{not json}\n```')
    assert.deepEqual(drafts, [])
    assert.match(errors[0], /not valid JSON/)
  })
})
