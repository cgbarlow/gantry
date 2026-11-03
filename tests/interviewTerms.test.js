import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #291 (parent #238, docs/adr/0065): the interview settles preferred terms, offers Key decisions and records open questions. A fake
// `fetch` plays the AI Provider with scripted streams, as in tests/interviewLog.test.js; the Definition mounts the three standard
// modules on its first Stage (and, for the "not mounted" cases, leaves them off).
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { modulesWithStandard } = await import('../web/lib/standardModules.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const MOUNTS = [
  { id: 'glossary', version: 1 },
  { id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' },
  { id: 'open-questions', version: 1 },
]
const own = [
  {
    id: 'details',
    title: 'Details',
    purpose: 'What it is',
    fields: [
      { id: 'summary', title: 'Summary', type: 'markdown', required: true, targetWords: { small: 5, medium: 8, large: 20 } },
      { id: 'notes', title: 'Notes', type: 'markdown' },
    ],
  },
]

/** `mounted`: the standard modules on the first Stage. The second Stage mounts none, to see what an earlier Stage's choices do there. */
function definition({ mounted = ['glossary', 'key-decisions', 'open-questions'] } = {}) {
  return {
    id: 'small',
    stages: [
      { id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details', ...mounted] },
      { id: 'build', title: 'Build', purpose: 'Build it.', gate: 'built', modules: ['details'] },
    ],
    artefacts: [
      { id: 'light', title: 'Light', purpose: 'The light one', gate: 'shaped', requires: ['details.summary'] },
      { id: 'built', title: 'Built', purpose: 'Built', gate: 'built', requires: ['details.summary'] },
    ],
    modules: modulesWithStandard(own, MOUNTS),
  }
}

const sources = [
  { id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: '# Client brief\n\nA customer files a claim.' },
  { id: 'minutes', title: 'Workshop minutes', filename: 'minutes.md', size: 40, text: '# Minutes\n\nThe policyholder opens a case.' },
]
const savedNothing = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }] }]

// ---------- a fake AI Provider ----------
const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })

function anthropicReply({ text, tools = [] }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name ?? 'draft_field', input: {} } }])
    const json = JSON.stringify(tool.input)
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 9) } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(9) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const envelope = JSON.parse(init.body)
    const request = { url: envelope.url, headers: envelope.headers, body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null, raw: envelope.body }
    calls.push(request)
    return handler(request, calls.length - 1)
  }
  return { fetchImpl, calls }
}

const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

function sessionWith(ai, over = {}) {
  const provider = anthropic()
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, actor: 'Alex', instructionsVersion: 'small@2', ...over }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => 's-test', now: () => '2026-11-02T10:00:00.000Z' })
  return { session, context }
}

const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}

const termCard = (over = {}) => ({
  id: 'term-claim',
  kind: 'term',
  header: 'Preferred term',
  question: 'The brief says "claim" and the minutes say "case". Which name should every document use?',
  options: [{ label: 'Claim', description: 'The brief’s word' }, { label: 'Case', description: 'The minutes’ word' }],
  recommended: 'Claim',
  why: 'The brief is the signed-off document.',
  source: { document: 'brief', location: 'p. 1' },
  meaning: 'A request by a policyholder to be paid for a loss.',
  ...over,
})
const decisionCard = (over = {}) => ({
  id: 'ledger',
  kind: 'decision',
  question: 'Where should the ledger live?',
  options: [{ label: 'PostgreSQL' }, { label: 'DynamoDB' }],
  recommended: 'PostgreSQL',
  why: 'The team knows it.',
  decision: { hardToReverse: 'Moving a ledger means migrating every record.', surprising: 'A reader would expect the cloud-native store.', tradeOff: 'Familiarity against scale-out.' },
  ...over,
})
const plainCard = (over = {}) => ({ id: 'plain', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }], recommended: 'Red', why: 'It is first.', ...over })
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const draftCall = (id, field, value, extra = {}) => ({ id, input: { field, value, ...extra } })
const logCall = (id, input) => ({ id, name: 'log_decision', input })
const quiet = () => anthropicReply({ text: 'Okay.' })

const termEntries = (session) => session.snapshot().decisions.history.filter((e) => e.kind === 'term')

// ---------- terms ----------

test('two Source documents naming one thing differently produce a term card, and the choice is logged', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [termCard()])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()

  const shown = session.snapshot().round.cards[0]
  assert.equal(shown.kind, 'term')
  assert.equal(shown.multiSelect, false)
  assert.equal(shown.allowOther, true, 'the architect can give their own name')
  assert.equal(shown.field, 'glossary.terms', 'a term card feeds the Glossary where it is mounted, so that Field waits for the answer')

  session.choose('term-claim', 'Case')
  await session.submitRound()
  const [entry] = termEntries(session)
  assert.equal(entry.kind, 'term')
  assert.equal(entry.preferred, 'Case')
  assert.deepEqual(entry.avoid, ['Claim'])
  assert.equal(entry.meaning, 'A request by a policyholder to be paid for a loss.')
  assert.deepEqual(entry.sources, ['brief, p. 1'])
  assert.deepEqual(entry.recommendation, ['Claim'])
  assert.equal(entry.followed, false)
  assert.deepEqual(entry.fields, ['glossary.terms'])
  assert.equal(session.snapshot().decisions.history.filter((e) => e.kind === 'answer').length, 0, 'a term choice is its own kind of entry, not a plain answer')
  assert.match(toolResults(ai.calls[1])[0].content, /Term choice, logged: prefer "Case", avoid "Claim"/)
})

test('a term choice is given to the AI on every later turn, and to the next Stage', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [termCard()])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  await session.submitRound()
  await session.send('Carry on.')
  assert.match(ai.calls.at(-1).body.system, /Use "Claim", not "Case"/, 'the choice is in the brief on the turn after it was made')

  // The next Stage reads this Stage's committed log.
  const delta = session.decisionsDelta()
  const later = fakeAi(() => quiet())
  const next = sessionWith(later, { stageId: 'build', artefactId: 'built', earlierDecisions: [{ stageId: 'shape', stageTitle: 'Shape', entries: delta.entries }] })
  await next.session.start()
  assert.match(later.calls[0].body.system, /Use "Claim", not "Case"/)
  assert.match(later.calls[0].body.system, /at Stage "Shape"/)
})

test('fuzzy wording in the architect\'s own answer produces a term card, and their own name is the preferred term', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [ask('a1', [plainCard({ id: 'who', question: 'Who files it?', options: [{ label: 'The customer' }, { label: 'A broker' }], recommended: 'The customer' })])] })
    if (n === 1) return anthropicReply({ tools: [ask('a2', [termCard({ id: 'term-punter', question: 'You said "punter". Is that the same as the Policyholder in the brief?', options: [{ label: 'Policyholder' }, { label: 'Customer' }], recommended: 'Policyholder', meaning: 'The person who holds a policy.', source: undefined })])] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  session.chooseOther('who')
  session.setOtherText('who', 'the punter')
  await session.submitRound() // typed as Other
  assert.equal(session.snapshot().round.cards[0].kind, 'term', 'the AI follows the architect\'s fuzzy wording with a term card')

  session.chooseOther('term-punter')
  session.setOtherText('term-punter', 'Insured')
  await session.submitRound()
  const [entry] = termEntries(session)
  assert.equal(entry.preferred, 'Insured', 'their own wording')
  assert.deepEqual(entry.avoid, ['Policyholder', 'Customer'])
  assert.equal(entry.words, 'Insured')
})

test('a changed term choice replaces the earlier one about the same thing', async () => {
  const ai = fakeAi((request, n) => (n === 0 || n === 2 ? anthropicReply({ tools: [ask(`a${n}`, [termCard({ id: n === 0 ? 'one' : 'two' })])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  await session.submitRound() // Claim
  await session.send('Ask me again about that term.')
  session.choose('two', 'Case')
  await session.submitRound()
  const all = termEntries(session)
  assert.equal(all.length, 2)
  assert.deepEqual(all[1].replaces, [all[0].id])
  assert.deepEqual(session.snapshot().decisions.latest.filter((e) => e.kind === 'term').map((e) => e.preferred), ['Case'])
})

test('with the Glossary mounted the draft carries the chosen terms; a draft that leaves one out is sent back once', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [ask('a1', [termCard()])] })
    if (n === 1) return anthropicReply({ tools: [draftCall('g1', 'glossary.terms', '| Preferred term | Definition | Avoid |\n| --- | --- | --- |\n| Policy | A contract. | — |')] })
    if (n === 2) return anthropicReply({ tools: [draftCall('g2', 'glossary.terms', '| Preferred term | Definition | Avoid |\n| --- | --- | --- |\n| Claim | A request to be paid for a loss. | Case |')] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.submitRound()
  const bounced = toolResults(ai.calls[2])[0]
  assert.match(bounced.content, /"Claim" as preferred term/)
  assert.match(bounced.content, /Preferred term \| Definition \| Avoid/)
  assert.match(toolResults(ai.calls[3])[0].content, /in the preview/)
  assert.match(session.snapshot().drafts['glossary.terms'].value, /Claim/)
  assert.deepEqual(session.snapshot().drafts['glossary.terms'].warnings, [])
  // And the brief hands the AI the rows to start from.
  assert.match(ai.calls[1].body.system, /Draft `glossary\.terms` from the term choices/)
  assert.match(ai.calls[1].body.system, /\| Claim \| A request by a policyholder to be paid for a loss\. \| Case \|/)
})

test('without the Glossary mounted the choice is only in the log', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [termCard()])] }) : quiet()))
  const { session } = sessionWith(ai, { definition: definition({ mounted: [] }) })
  await session.start()
  assert.equal(session.snapshot().round.cards[0].field, null, 'there is no Field for it to feed')
  await session.submitRound()
  assert.deepEqual(termEntries(session).map((e) => ({ preferred: e.preferred, fields: e.fields })), [{ preferred: 'Claim', fields: undefined }])
  assert.match(ai.calls[1].body.system, /The Glossary is not drafted on this Stage, so the choices stay in the decisions log only/)
  assert.doesNotMatch(ai.calls[1].body.system, /Draft `glossary\.terms`/)
})

// ---------- Key decisions ----------

test('a significant decision is offered as a Key decision card with its three-part test, feeding the Key decisions Field', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [decisionCard()])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  const shown = session.snapshot().round.cards[0]
  assert.equal(shown.kind, 'decision')
  assert.equal(shown.field, 'key-decisions.decisions')
  assert.equal(shown.decision.tradeOff, 'Familiarity against scale-out.')

  await session.submitRound()
  const [answer] = session.snapshot().decisions.history.filter((e) => e.kind === 'answer')
  assert.equal(answer.keyDecision, true)
  assert.deepEqual(answer.fields, ['key-decisions.decisions'])
  assert.equal(answer.significance.hardToReverse, 'Moving a ledger means migrating every record.')
  assert.match(toolResults(ai.calls[1])[0].content, /Key decision, logged\. Draft it into the Key decisions Field as the next numbered decision/)
  assert.match(ai.calls[0].body.system, /Key decisions\*\* is mounted \(`key-decisions\.decisions`\): numbered AD01, AD02/)
  assert.match(ai.calls[0].body.system, /draft it as AD01, the next number/)
})

test('a routine answer is not offered as a Key decision: without all three parts the card is an ordinary question', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [decisionCard({ id: 'routine', question: 'Which colour for the button?', decision: { hardToReverse: 'It is not hard to change.', surprising: '', tradeOff: '' } })])] }) : quiet()))
  const { session } = sessionWith(ai)
  await session.start()
  const shown = session.snapshot().round.cards[0]
  assert.equal(shown.kind, undefined)
  assert.equal(shown.field, null)
  await session.submitRound()
  const [answer] = session.snapshot().decisions.history.filter((e) => e.kind === 'answer')
  assert.equal(answer.keyDecision, undefined, 'still logged as an answer, since the log records every answer')
})

test('where Key decisions is not mounted, nothing is offered as a Key decision and the answer is only in the log', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [decisionCard()])] }) : quiet()))
  const { session } = sessionWith(ai, { definition: definition({ mounted: ['glossary'] }) })
  await session.start()
  assert.equal(session.snapshot().round.cards[0].kind, undefined)
  await session.submitRound()
  const [answer] = session.snapshot().decisions.history.filter((e) => e.kind === 'answer')
  assert.equal(answer.keyDecision, undefined)
  assert.match(ai.calls[0].body.system, /\*\*Key decisions:\*\* Key decisions is not mounted on this Stage\. Do not offer a Key decision/)
})

test('a Key decision draft is checked for its prefix, parts and numbers', async () => {
  const wrong = '**KD01: Ledger**\n\n**In the context of:** claims\n\n**Facing:** volume'
  const right = '**AD01: Ledger in PostgreSQL**\n\n**In the context of:** claims\n\n**Facing:** volume\n\n**We decided for:** PostgreSQL'
  const ai = fakeAi((request, n) => {
    if (n === 0) return quiet()
    if (n === 1) return anthropicReply({ tools: [draftCall('k1', 'key-decisions.decisions', wrong)] })
    if (n === 2) return anthropicReply({ tools: [draftCall('k2', 'key-decisions.decisions', right)] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Record the ledger decision.')
  assert.match(toolResults(ai.calls[2])[0].content, /numbered with the prefix AD/)
  assert.match(toolResults(ai.calls[3])[0].content, /in the preview/)
  assert.deepEqual(session.snapshot().drafts['key-decisions.decisions'].warnings, [])
})

// ---------- open questions ----------

test('open questions land in the Open questions module where it is mounted; a draft that drops one is sent back', async () => {
  const table = (rows) => `| Question | Who resolves | By when | Status |\n| --- | --- | --- | --- |\n${rows.join('\n')}`
  const ai = fakeAi((request, n) => {
    if (n === 0) return quiet()
    if (n === 1) return anthropicReply({ tools: [logCall('l1', { kind: 'open-question', question: 'Who signs off the ledger design?', why: 'Needed before build' }), logCall('l2', { kind: 'open-question', question: 'Is the retention period seven years?' })] })
    if (n === 2) return quiet()
    if (n === 3) return anthropicReply({ tools: [draftCall('o1', 'open-questions.questions', table(['| Who signs off the ledger design? | — | — | Open |']))] })
    if (n === 4) return anthropicReply({ tools: [draftCall('o2', 'open-questions.questions', table(['| Who signs off the ledger design? | — | — | Open |', '| Is the retention period seven years? | — | — | Open |']))] })
    return quiet()
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('I do not know who signs off, or the retention period.')
  assert.equal(session.snapshot().decisions.open.length, 2)
  await session.send('Please put those in the Open questions.')
  assert.match(toolResults(ai.calls[4])[0].content, /2 open questions are logged but the draft lists 1/)
  assert.match(toolResults(ai.calls[5])[0].content, /in the preview/)
  assert.match(ai.calls[3].body.system, /Open questions to draft into `open-questions\.questions` \(2\), one row each/)
  assert.match(ai.calls[3].body.system, /Who signs off the ledger design\? \(Needed before build\)/)
})

test('where Open questions is not mounted, the question stays in the log only', async () => {
  const ai = fakeAi((request, n) => (n === 1 ? anthropicReply({ tools: [logCall('l1', { kind: 'open-question', question: 'Who signs off?' })] }) : quiet()))
  const { session } = sessionWith(ai, { definition: definition({ mounted: [] }) })
  await session.start()
  await session.send('Not sure who signs off.')
  assert.equal(session.snapshot().decisions.open.length, 1)
  assert.match(ai.calls.at(-1).body.system, /\*\*Open questions:\*\* Open questions is not mounted on this Stage\. An open question is logged in the decisions log only/)
  assert.doesNotMatch(ai.calls.at(-1).body.system, /Open questions to draft into/)
})

test('an open question left at an earlier Stage is carried to the Open questions module of a later one', async () => {
  const def = definition()
  def.stages[1].modules = ['details', 'open-questions']
  const earlier = [{ stageId: 'shape', stageTitle: 'Shape', entries: [{ id: 's-1', kind: 'open-question', question: 'Who owns the data?', why: 'Not in the brief' }] }]
  const ai = fakeAi(() => quiet())
  const { session } = sessionWith(ai, { definition: def, stageId: 'build', artefactId: 'built', earlierDecisions: earlier })
  await session.start()
  assert.match(ai.calls[0].body.system, /Open questions to draft into `open-questions\.questions` \(1\)/)
  assert.match(ai.calls[0].body.system, /Who owns the data\? \(Not in the brief\) \[raised at Stage "Shape"\]/)
})
