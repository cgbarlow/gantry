import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateCards, ASK_TOOL_SCHEMA } from '../web/lib/aiCards.js'
import { answersText, cardPriority, shapeCard, sortRound, termChoice } from '../web/lib/interviewRounds.js'
import { glossarySeed, missingTerms, nextDecisionReference, openQuestionsToCarry, standardDraftProblems, standardRoles, standardRolesLines, tableRowCount, termChoices } from '../web/lib/interviewStandard.js'
import { modulesWithStandard } from '../web/lib/standardModules.js'
import { buildInterviewBrief } from '../web/lib/interviewBrief.js'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'
import { describeEntry } from '../web/lib/decisionsLogPanel.js'
import { INTERVIEW_RULES, interviewRulesText } from '../web/lib/interviewRules.js'

// #291 (parent #238, docs/adr/0065): terms, Key decisions and open questions in the AI interview. The pure parts, driven directly;
// tests/interviewTerms.test.js drives the same through a session with a scripted AI.

const skills = await loadInterviewSkills((path) => readFileSync(new URL(`../web/interview-skills/${path}`, import.meta.url), 'utf8'))

const MOUNTS = [
  { id: 'glossary', version: 1 },
  { id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' },
  { id: 'open-questions', version: 1 },
]
const definition = (stageModules = ['glossary', 'key-decisions', 'open-questions'], extra = {}) => ({
  id: 'd',
  stages: [{ id: 's1', title: 'One', gate: 'g1', modules: ['details', ...stageModules], ...extra }, { id: 's2', title: 'Two', gate: 'g2', modules: ['details'] }],
  artefacts: [{ id: 'a', gate: 'g1', requires: ['details.summary'] }],
  modules: modulesWithStandard([{ id: 'details', title: 'Details', fields: [{ id: 'summary', title: 'Summary', type: 'markdown', required: true }] }], MOUNTS),
})

const term = (id, preferred, avoid, extra = {}) => ({ id, kind: 'term', preferred, avoid, ...extra })

describe('which standard modules are on the Stage', () => {
  test('mounted and in scope, with the Key decisions prefix and style', () => {
    const roles = standardRoles(definition(), 's1')
    assert.deepEqual([roles.glossary.inScope, roles.keyDecisions.inScope, roles.openQuestions.inScope], [true, true, true])
    assert.equal(roles.glossary.key, 'glossary.terms')
    assert.equal(roles.keyDecisions.key, 'key-decisions.decisions')
    assert.equal(roles.openQuestions.key, 'open-questions.questions')
    assert.deepEqual([roles.keyDecisions.prefix, roles.keyDecisions.style], ['AD', 'why'])
  })

  test('not mounted on the Stage, or mounted read-only, is not in scope', () => {
    const none = standardRoles(definition([]), 's1')
    assert.deepEqual([none.glossary.mounted, none.keyDecisions.mounted, none.openQuestions.mounted], [false, false, false])
    const readOnly = standardRoles(definition(['glossary'], { readOnlyModules: ['glossary'] }), 's1')
    assert.deepEqual([readOnly.glossary.mounted, readOnly.glossary.readOnly, readOnly.glossary.inScope], [true, true, false])
    assert.match(standardRolesLines(readOnly).join('\n'), /Glossary:\*\* the Glossary is on this Stage but read-only/)
  })

  test('a Module of the Definition\'s own with a standard module\'s name is not the standard module', () => {
    const def = definition([])
    def.modules = [...def.modules.filter((m) => m.id !== 'glossary'), { id: 'glossary', title: 'Own', fields: [{ id: 'terms', title: 'T', type: 'markdown' }] }]
    def.stages[0].modules.push('glossary')
    assert.equal(standardRoles(def, 's1').glossary.mounted, false)
  })

  test('the brief says where each role lands, and the next Key decision number', () => {
    const lines = standardRolesLines(standardRoles(definition(), 's1'), { savedDecisions: '**AD03: Earlier**\n\n**Facing:** x' }).join('\n')
    assert.match(lines, /Glossary\*\* is mounted \(`glossary\.terms`\)/)
    assert.match(lines, /numbered AD01, AD02, …, WH\(Y\) style/)
    assert.match(lines, /draft it as AD04, the next number/)
    assert.match(lines, /Open questions\*\* is mounted/)
    const off = standardRolesLines(standardRoles(definition([]), 's1')).join('\n')
    assert.match(off, /term choice stays in the decisions log only; it still binds every later Stage/)
    assert.match(off, /Do not offer a Key decision/)
    assert.match(off, /logged in the decisions log only/)
  })

  test('the next number is above every saved decision and every number ever handed out', () => {
    assert.equal(nextDecisionReference('', 'AD'), 'AD01')
    assert.equal(nextDecisionReference('**AD02: Two**\n\n<!-- next: 7 -->', 'AD'), 'AD07')
  })
})

describe('term choices', () => {
  test('come from the log, this Stage\'s and the earlier Stages\'', () => {
    const choices = termChoices({ earlier: [{ stageId: 's1', entries: [term('a', 'Claim', ['Case'], { meaning: 'A request to be paid.' })] }], own: [term('b', 'Policyholder', ['Customer'])], stageId: 's2' })
    assert.deepEqual(choices.map((c) => [c.preferred, c.avoid, c.stage]), [['Claim', ['Case'], 's1'], ['Policyholder', ['Customer'], 's2']])
    assert.equal(choices[0].meaning, 'A request to be paid.')
  })

  test('a later choice about the same thing takes an earlier one\'s place', () => {
    const choices = termChoices({ earlier: [{ stageId: 's1', entries: [term('a', 'Claim', ['Case'])] }], own: [term('b', 'Case', ['Claim', 'Incident'])], stageId: 's2' })
    assert.deepEqual(choices.map((c) => c.preferred), ['Case'])
  })

  test('an entry a later one replaces, or from before a restart, does not stand', () => {
    const entries = [term('a', 'Claim', ['Case']), term('b', 'Case', ['Claim'], { replaces: ['a'] })]
    assert.deepEqual(termChoices({ own: entries }).map((c) => c.preferred), ['Case'])
    assert.deepEqual(termChoices({ own: [term('a', 'Claim', ['Case']), { id: 'r', kind: 'restart' }] }), [])
  })

  test('a choice with no preferred term is ignored', () => {
    assert.deepEqual(termChoices({ own: [{ id: 'x', kind: 'term', avoid: ['Case'] }] }), [])
  })

  test('the Glossary rows seed from the choices, and a draft missing one is found', () => {
    const choices = [{ preferred: 'Claim', avoid: ['Case', 'Incident'], meaning: 'A request to be paid.' }, { preferred: 'Policyholder', avoid: [], meaning: '' }]
    assert.deepEqual(glossarySeed(choices), ['| Claim | A request to be paid. | Case, Incident |', '| Policyholder | (define from the Source documents) | — |'])
    assert.deepEqual(missingTerms('| claim | x | y |', choices).map((c) => c.preferred), ['Policyholder'])
    assert.deepEqual(missingTerms(['Claim', 'Policyholder'], choices), [])
  })
})

describe('a term card and a decision card from the AI', () => {
  const base = (over = {}) => ({ question: 'Which name?', options: [{ label: 'Claim' }, { label: 'Case' }], recommended: 'Claim', ...over })

  test('the tool offers the kinds (#299 adds an offer to re-open a signed-off Stage)', () => {
    assert.deepEqual(ASK_TOOL_SCHEMA.properties.questions.items.properties.kind.enum, ['disagreement', 'missing', 'term', 'decision', 'reopen'])
  })

  test('a term card keeps its meaning and takes one choice only', () => {
    const { ok, cards } = validateCards({ questions: [base({ kind: 'term', meaning: ' A request. ', multiSelect: true })] })
    assert.equal(ok, true)
    assert.equal(cards[0].kind, 'term')
    assert.equal(cards[0].meaning, 'A request.')
    assert.equal(cards[0].multiSelect, false)
  })

  test('a decision card keeps its three-part test only when all three are given', () => {
    const whole = validateCards({ questions: [base({ kind: 'decision', decision: { hardToReverse: 'a', surprising: 'b', tradeOff: 'c' } })] }).cards[0]
    assert.deepEqual(whole.decision, { hardToReverse: 'a', surprising: 'b', tradeOff: 'c' })
    const partial = validateCards({ questions: [base({ kind: 'decision', decision: { hardToReverse: 'a', surprising: '', tradeOff: 'c' } })] }).cards[0]
    assert.equal(partial.kind, 'decision')
    assert.equal(partial.decision, undefined)
  })

  test('an unknown kind is still left out', () => {
    assert.equal('kind' in validateCards({ questions: [base({ kind: 'whatever' })] }).cards[0], false)
  })

  test('a term card sorts with the disagreements', () => {
    const cards = [{ id: 'o' }, { id: 'm', kind: 'missing' }, { id: 't', kind: 'term' }, { id: 'd', kind: 'disagreement' }]
    assert.equal(cardPriority(cards[2]), 1)
    assert.deepEqual(sortRound(cards).map((c) => c.id), ['t', 'd', 'm', 'o'])
  })

  test('the choice is the option picked and the other options are to be avoided; their own wording wins', () => {
    const card = shapeCard(validateCards({ questions: [base({ kind: 'term', meaning: 'A request.' })] }).cards[0], null)
    assert.deepEqual(termChoice({ ...card, selected: ['Case'] }), { preferred: 'Case', avoid: ['Claim'], own: false, meaning: 'A request.' })
    const own = termChoice({ ...card, selected: [], otherOn: true, otherText: ' Insured ' })
    assert.deepEqual([own.preferred, own.avoid, own.own], ['Insured', ['Claim', 'Case'], true])
    assert.equal(termChoice({ ...card, selected: [] }), null)
    assert.equal(termChoice({ ...card, kind: undefined, selected: ['Case'] }), null, 'only a term card settles a term')
  })

  test('the AI is told the choice, and that a Key decision is to be drafted', () => {
    const term = { ...shapeCard(validateCards({ questions: [base({ id: 't', kind: 'term' })] }).cards[0], null), selected: ['Case'] }
    assert.match(answersText([term]), /Term choice, logged: prefer "Case", avoid "Claim"\. Use "Case" in every Field/)
    const decision = { ...shapeCard(validateCards({ questions: [base({ id: 'k', kind: 'decision', decision: { hardToReverse: 'a', surprising: 'b', tradeOff: 'c' } })] }).cards[0], null), selected: ['Claim'] }
    assert.match(answersText([decision]), /Key decision, logged\. Draft it into the Key decisions Field as the next numbered decision/)
  })
})

describe('checks on a draft of a standard module', () => {
  const roles = standardRoles(definition(), 's1')
  const check = (key, value, extra = {}) => standardDraftProblems({ roles, key, value, ...extra })

  test('the Glossary draft must carry every chosen term', () => {
    const terms = [{ preferred: 'Claim', avoid: ['Case'] }, { preferred: 'Policyholder', avoid: [] }]
    const problems = check('glossary.terms', '| Claim | x | Case |', { terms })
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /"Policyholder" as preferred term/)
    assert.deepEqual(check('glossary.terms', '| Claim | x | Case |\n| Policyholder | y | — |', { terms }), [])
    assert.deepEqual(check('glossary.terms', 'anything', { terms: [] }), [])
  })

  test('a Glossary that is not on the Stage is never checked', () => {
    assert.deepEqual(standardDraftProblems({ roles: standardRoles(definition([]), 's1'), key: 'glossary.terms', value: 'x', terms: [{ preferred: 'Claim', avoid: [] }] }), [])
  })

  test('Key decisions: numbered, in the Definition\'s prefix, with the style\'s parts, no loops', () => {
    assert.match(check('key-decisions.decisions', 'We chose PostgreSQL.')[0].message, /no numbered decision found/)
    assert.match(check('key-decisions.decisions', '**KD01: x**\n\n**Facing:** y')[0].message, /prefix AD/)
    assert.match(check('key-decisions.decisions', '**AD01: x**\n\n**Context:** y').map((p) => p.message).join(' '), /none of the WH\(Y\) parts/, 'the default style\'s parts are not the WH(Y) style\'s')
    assert.deepEqual(check('key-decisions.decisions', '**AD01: x**\n\n**Facing:** y\n\n**We decided for:** z'), [])
    assert.match(check('key-decisions.decisions', '**AD01: x**\n\n**Facing:** y\n\n**Depends on:** AD09').map((p) => p.message).join(' '), /AD09, which is not in this list/)
    assert.match(check('key-decisions.decisions', '**AD01: x**\n\n**Facing:** y\n\n**AD01: again**\n\n**Facing:** z').map((p) => p.message).join(' '), /AD01 is used by more than one decision/)
  })

  // #356: the AI wrote every WH(Y) part with a plain label and was warned, round after round, that it had written none of them.
  test('Key decisions: a part read in any common layout clears the warning, and the warning shows the exact layout', () => {
    const plain = '**AD01: Use PostgreSQL for the ledger**\n\nIn the context of: the payments ledger\nFacing: lost payments\nWe decided for: PostgreSQL 16\nAnd neglected: DynamoDB\nTo achieve: consistency\nAccepting that: we run a cluster\nRelates to: AD02\n\n**AD02: Cache balances**\n\n- **In the context of**: balance look-ups\n- **Facing**: slow reads\n- **We decided for**: a cache\n- **And neglected**: the ledger\n- **To achieve**: fast pages\n- **Accepting that**: stale balances\n- **Depends on**: AD01'
    assert.deepEqual(check('key-decisions.decisions', plain), [])

    const [empty] = check('key-decisions.decisions', '**AD03: Cache reads**\n\nWe chose a cache in front of the ledger.')
    assert.match(empty.message, /AD03 has none of the WH\(Y\) parts written/)
    assert.ok(empty.message.includes('**AD03: Cache reads**, **In the context of:** …, **Facing:** …, **We decided for:** …, **And neglected:** …, **To achieve:** …, **Accepting that:** …, **Relates to:** AD01'), empty.message)
    assert.doesNotMatch(empty.message, /\n/, 'one line, as the preview and the tool result show it')

    const [none] = check('key-decisions.decisions', 'We chose PostgreSQL.')
    assert.ok(none.message.includes('**AD01: Short title**, **In the context of:** …'), none.message)

    // A Markdown heading is a header too, so its prefix is checked like a bold one.
    assert.match(check('key-decisions.decisions', '### KD01: x\n\nFacing: y')[0].message, /prefix AD/)
  })

  test('Key decisions in the default style: the warning shows that style\'s parts, under the Definition\'s prefix, and no links', () => {
    const roles = standardRoles({ ...definition(), modules: modulesWithStandard([{ id: 'details', title: 'Details', fields: [{ id: 'summary', title: 'Summary', type: 'markdown', required: true }] }], [{ id: 'key-decisions', version: 1, prefix: 'DEC' }]) }, 's1')
    const [problem] = standardDraftProblems({ roles, key: 'key-decisions.decisions', value: '**DEC01: x**\n\nFacing: y' })
    assert.ok(problem.message.includes('**DEC01: x**, **Context:** …, **Decision:** …, **Why:** …, **Considered options:** …, **Consequences:** ….'), problem.message)
    assert.deepEqual(standardDraftProblems({ roles, key: 'key-decisions.decisions', value: '**DEC01: x**\n\n* Context: y' }), [])
  })

  test('Open questions: a row for each logged question', () => {
    const table = '| Question | Who resolves | By when | Status |\n| --- | --- | --- | --- |\n| One? | — | — | Open |'
    assert.equal(tableRowCount(table), 1)
    assert.equal(check('open-questions.questions', table, { openCount: 2 }).length, 1)
    assert.deepEqual(check('open-questions.questions', table, { openCount: 1 }), [])
    assert.deepEqual(check('open-questions.questions', table, { openCount: 0 }), [])
  })

  test('another Field is not checked', () => {
    assert.deepEqual(check('details.summary', 'x', { openCount: 5, terms: [{ preferred: 'Claim', avoid: [] }] }), [])
  })
})

describe('open questions to carry', () => {
  const q = (id, question, extra = {}) => ({ id, kind: 'open-question', question, ...extra })

  test('this Stage\'s still open, then those left open earlier, once each', () => {
    const carried = openQuestionsToCarry({
      earlier: [{ stageId: 's1', entries: [q('e1', 'Who owns the data?', { why: 'Not in the brief' }), q('e2', 'Resolved one?'), { id: 'x', kind: 'answer', resolves: ['e2'] }] }],
      own: [q('o1', 'Who signs off?'), q('o2', 'who owns the data?')],
    })
    assert.deepEqual(carried.map((c) => [c.question, c.stage]), [['Who owns the data?', 's1'], ['Who signs off?', '']])
  })
})

describe('the brief', () => {
  const brief = (input = {}) => buildInterviewBrief({ definition: definition(), stageId: 's1', skills, contextWindow: 200000, ...input })

  test('gives the term choices of earlier Stages, and the rows to draft the Glossary from', () => {
    const result = brief({ earlierDecisions: [{ stageId: 's0', entries: [term('a', 'Claim', ['Case'], { meaning: 'A request to be paid.' })] }], decisions: [term('b', 'Policyholder', ['Customer'])] })
    const text = result.segments.find((s) => s.id === 'glossary').text
    assert.match(text, /Use "Claim", not "Case"/)
    assert.match(text, /Use "Policyholder", not "Customer"/)
    assert.match(text, /\| Claim \| A request to be paid\. \| Case \|/)
    assert.match(text, /Draft `glossary\.terms` from the term choices/)
  })

  test('says the choices stay in the log where the Glossary is not drafted', () => {
    const text = brief({ definition: definition([]), decisions: [term('b', 'Policyholder', ['Customer'])] }).segments.find((s) => s.id === 'glossary').text
    assert.match(text, /Use "Policyholder", not "Customer"/)
    assert.match(text, /stay in the decisions log only/)
  })

  test('the Stage part names the standard modules and where each lands', () => {
    const stage = brief().segments.find((s) => s.id === 'stage').text
    assert.match(stage, /Standard modules on this Stage/)
    assert.match(stage, /Glossary\*\* is mounted/)
  })
})

describe('the rules and the log', () => {
  test('Gantry\'s rules cover terms, Key decisions, open questions and scenarios', () => {
    const text = interviewRulesText()
    assert.ok(INTERVIEW_RULES.some((r) => r.id === 'terms'))
    assert.match(text, /term card/)
    assert.match(text, /hard to reverse, surprising without its context, and the result of a real trade-off/)
    assert.match(text, /Never invent who resolves a question or by when/)
    assert.match(text, /concrete scenario that probes an edge case/)
  })

  test('the Decisions log panel reads a term choice as a sentence', () => {
    const entry = term('t', 'Claim', ['Case', 'Incident'], { fields: ['glossary.terms'] })
    assert.equal(describeEntry(entry, { fieldTitle: () => 'Glossary' }), 'Prefer “Claim”, avoid “Case”, “Incident” (feeds Glossary)')
    assert.match(describeEntry({ ...term('t', 'Insured', ['Customer']), words: 'Insured' }), /their own wording/)
    assert.match(describeEntry({ id: 'a', kind: 'answer', keyDecision: true, question: 'Where?', answer: ['PostgreSQL'] }), /^Key decision: Where\?/)
  })
})
