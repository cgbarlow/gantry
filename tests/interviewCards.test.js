import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #287 (parent #238): rounds of question cards in an AI interview session. A fake `fetch` plays the AI Provider with scripted
// streams, as in tests/interviewSession.test.js; the AI Providers list is the real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

function definition() {
  return {
    id: 'small',
    stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
    artefacts: [{ id: 'light', title: 'Light', purpose: 'The light one', gate: 'shaped', requires: ['details.summary'] }],
    modules: [
      {
        id: 'details',
        title: 'Details',
        purpose: 'What it is',
        fields: [
          { id: 'summary', title: 'Summary', type: 'markdown', required: true, targetWords: { small: 5, medium: 8, large: 20 } },
          { id: 'risk', title: 'Risk level', type: 'select', options: ['Low', 'Medium', 'High', 'Severe', 'Extreme'], default: 'Medium' },
          { id: 'notes', title: 'Notes', type: 'markdown' },
          { id: 'owner', title: 'Owner', type: 'text' },
        ],
      },
    ],
  }
}
const sources = [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: '# Client brief\n\nThe insurer wants faster claims.' }]
const savedNothing = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'risk', value: '' }, { id: 'notes', value: '' }, { id: 'owner', value: '' }] }]
const savedNotes = () => {
  const saved = savedNothing()
  saved[0].fields[2].value = 'Notes the architect already saved.'
  return saved
}

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

function openAiReply(text) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
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

const tested = (id, over = {}) => providers.setAiProviderTest(id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok', ...over }, null)
const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  tested(p.id)
  return p
}
const openAiText = (questionCards = 'text') => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  tested(p.id, { questionCards })
  return p
}

function sessionWith(ai, over = {}) {
  const provider = over.provider ?? anthropic()
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, ...over.context }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl })
  return { session, provider, context }
}

const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}
const lastUserText = (request) => {
  const last = request.body.messages.at(-1)
  return typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? b.content ?? '').join('\n')
}

const card = (over = {}) => ({
  question: 'Which one?',
  options: [{ label: 'Alpha', description: 'First' }, { label: 'Beta', description: 'Second' }],
  recommended: 'Alpha',
  why: 'It is first.',
  ...over,
})
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const draftCall = (id, field, value, extra = {}) => ({ id, input: { field, value, ...extra } })

// ---------- rounds ----------

test('a round holds every ready card, sorted by priority, with the recommendation pre-selected and Other added by Gantry', async () => {
  const ai = fakeAi((request, n) =>
    n === 0
      ? anthropicReply({
          text: 'I read the brief.',
          tools: [
            ask('a1', [
              card({ id: 'opt', header: 'Notes', question: 'Optional?', field: 'details.notes' }),
              card({ id: 'miss', header: 'Gap', question: 'A missing fact?', kind: 'missing' }),
              card({ id: 'dis', header: 'Clash', question: 'Documents disagree?', kind: 'disagreement', source: { document: 'brief', location: 'p. 2' } }),
              card({ id: 'req', header: 'Summary', question: 'Required?', field: 'details.summary' }),
            ]),
          ],
        })
      : anthropicReply({ text: 'Thanks.' })
  )
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()

  assert.equal(snap.phase, 'asking')
  assert.deepEqual(snap.round.cards.map((c) => c.id), ['req', 'dis', 'miss', 'opt'], 'Fields this Gate requires, then disagreements, then missing facts, then optional Fields')
  const first = snap.round.cards[0]
  assert.deepEqual(first.selected, ['Alpha'], 'the recommendation is pre-selected')
  assert.equal(first.allowOther, true)
  assert.equal(snap.round.cards[1].source.title, 'Client brief', 'a cited Source document is named by its title')
  assert.deepEqual(ai.calls[0].body.tools.map((t) => t.name), ['ask_architect', 'draft_field', 'log_decision'])
})

test('submitting a round answers the ask_architect call; the answers feed a redraft', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) {
      return anthropicReply({
        tools: [draftCall('d1', 'details.risk', 'Low'), ask('a1', [card({ id: 'who', field: 'details.owner', question: 'Who owns it?', options: [{ label: 'Pat', draft: 'Pat' }, { label: 'Sam', draft: 'Sam' }], recommended: 'Pat' })])],
      })
    }
    if (n === 1) return anthropicReply({ tools: [draftCall('d2', 'details.owner', 'Sam')] })
    return anthropicReply({ text: 'Drafted the owner.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  assert.equal(session.snapshot().phase, 'asking')
  assert.deepEqual(Object.keys(session.snapshot().drafts), ['details.risk'], 'drafting is not held up by the cards')

  session.choose('who', 'Sam')
  const result = await session.submitRound()
  assert.equal(result.ok, true)
  const results = toolResults(ai.calls[1])
  assert.deepEqual(results.map((r) => r.tool_use_id).sort(), ['a1', 'd1'])
  const answer = results.find((r) => r.tool_use_id === 'a1').content
  assert.match(answer, /\[who\] Who owns it\? → "Sam" \(not your recommendation\)\. Feeds details\.owner\./)
  assert.match(answer, /Text for "Sam": Sam/)
  const snap = session.snapshot()
  assert.equal(snap.phase, 'waiting')
  assert.equal(snap.round, null)
  assert.equal(snap.drafts['details.owner'].value, 'Sam')
  assert.deepEqual(snap.answered.map((a) => [a.id, a.labels, a.followed]), [['who', ['Sam'], false]])
})

test('a round with a card unanswered is not submitted', async () => {
  const ai = fakeAi(() => anthropicReply({ tools: [ask('a1', [card({ id: 'one', recommended: 'Alpha' })])] }))
  const { session } = sessionWith(ai)
  await session.start()
  session.chooseOther('one')
  const result = await session.submitRound()
  assert.equal(result.ok, false)
  assert.match(result.message, /not answered/)
  assert.equal(ai.calls.length, 1)
  session.setOtherText('one', 'Gamma')
  assert.equal((await session.submitRound()).ok, true)
})

test('a card whose prerequisite is unanswered is not asked yet, and is shown once the prerequisite is answered', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) {
      return anthropicReply({
        tools: [ask('a1', [card({ id: 'first', question: 'First?' }), card({ id: 'second', question: 'Second, which depends on the first?', after: ['first'] })])],
      })
    }
    return anthropicReply({ text: 'Noted.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  let snap = session.snapshot()
  assert.deepEqual(snap.round.cards.map((c) => c.id), ['first'], 'only the ready card is asked')
  assert.equal(snap.held, 1)

  await session.submitRound()
  assert.match(lastUserText(ai.calls[1]), /Held back until the cards they wait on are answered[^]*second/)
  snap = session.snapshot()
  assert.deepEqual(snap.round.cards.map((c) => c.id), ['second'], 'it is shown by itself once its prerequisite is answered')
  assert.equal(snap.held, 0)
})

test('cards the model leaves with the default ids do not collide across rounds', async () => {
  const ai = fakeAi((request, n) => (n < 2 ? anthropicReply({ tools: [ask(`a${n}`, [card({ question: `Round ${n + 1}?` })])] }) : anthropicReply({ text: 'Done.' })))
  const { session } = sessionWith(ai)
  await session.start()
  const firstId = session.snapshot().round.cards[0].id
  await session.submitRound()
  const secondId = session.snapshot().round.cards[0].id
  assert.notEqual(firstId, secondId)
  assert.deepEqual(session.snapshot().answered.map((a) => a.id), [firstId])
})

test("a select Field's card shows exactly the Definition's options, with no Other, and the recommendation mapped onto them", async () => {
  const ai = fakeAi(() => anthropicReply({ tools: [ask('a1', [card({ id: 'risk', field: 'details.risk', question: 'How risky?', options: [{ label: 'low' }, { label: 'a lot' }], recommended: 'low' })])] }))
  const { session } = sessionWith(ai)
  await session.start()
  const c = session.snapshot().round.cards[0]
  assert.deepEqual(c.options.map((o) => o.label), ['Low', 'Medium', 'High', 'Severe', 'Extreme'], "the Definition's options, all five, not the model's two")
  assert.equal(c.allowOther, false)
  assert.deepEqual(c.recommended, ['Low'])
  assert.deepEqual(c.selected, ['Low'])
  session.chooseOther('risk')
  assert.equal(session.snapshot().round.cards[0].otherOn, false, 'there is no Other to choose')
})

test("a select Field whose recommendation is not one of its options falls back to the Field's default", async () => {
  const ai = fakeAi(() => anthropicReply({ tools: [ask('a1', [card({ id: 'risk', field: 'details.risk', options: [{ label: 'Tiny' }, { label: 'Huge' }], recommended: 'Tiny' })])] }))
  const { session } = sessionWith(ai)
  await session.start()
  assert.deepEqual(session.snapshot().round.cards[0].selected, ['Medium'])
})

test("a \"choose any\" card keeps several choices; Other is the architect's own words, so a figure in it is plain fact", async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [ask('a1', [card({ id: 'multi', multiSelect: true, recommended: ['Alpha', 'Beta'], question: 'Which?' })])] })
    if (n === 1) return anthropicReply({ tools: [draftCall('d1', 'details.notes', 'The budget is $1.2M.')] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  assert.deepEqual(session.snapshot().round.cards[0].selected, ['Alpha', 'Beta'])
  session.choose('multi', 'Beta')
  assert.deepEqual(session.snapshot().round.cards[0].selected, ['Alpha'])
  session.chooseOther('multi')
  session.setOtherText('multi', 'The budget is capped at $1.2M')
  await session.submitRound()
  assert.match(toolResults(ai.calls[1])[0].content, /"Alpha" and Other, in the architect's own words: "The budget is capped at \$1\.2M"/)
  assert.equal(Boolean(toolResults(ai.calls[2])[0].is_error), false, 'no "(target assumption)" is asked for a figure the architect typed')
  assert.equal(session.snapshot().drafts['details.notes'].value, 'The budget is $1.2M.')
})

test('an invalid card goes back to the model once and the corrected round is shown', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [ask('a1', [{ question: 'No options?' }])] })
    if (n === 1) return anthropicReply({ tools: [ask('a2', [card({ question: 'Fixed?' })])] })
    return anthropicReply({ text: 'ok' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  assert.equal(toolResults(ai.calls[1])[0].is_error, true)
  assert.equal(session.snapshot().round.cards[0].question, 'Fixed?')
})

test('typing in the chat while cards are open puts the cards away and tells the AI', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [card({ id: 'one' })])] }) : anthropicReply({ text: 'Understood.' })))
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('Actually, skip that.')
  const results = toolResults(ai.calls[1])
  assert.equal(results[0].tool_use_id, 'a1')
  assert.match(results[0].content, /did not answer these cards/)
  assert.equal(session.snapshot().round, null)
  assert.equal(session.snapshot().phase, 'waiting')
})

// ---------- saved content: keep / use / merge ----------

test('saved content changes only through a keep / use / merge card: nothing reaches the preview before the answer', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'details.notes', 'The AI would write this instead.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  const snap = session.snapshot()
  assert.deepEqual(snap.drafts, {}, 'the saved Field is untouched')
  assert.equal(snap.phase, 'asking')
  const c = snap.round.cards[0]
  assert.equal(c.type, 'change')
  assert.deepEqual(c.options.map((o) => o.label), ['Keep', "Use the AI's version", 'Merge'])
  assert.deepEqual(c.recommended, ['Keep'])
  assert.equal(c.change.saved, 'Notes the architect already saved.')
  assert.equal(c.change.proposed, 'The AI would write this instead.')
  assert.equal(c.allowOther, false)
})

test('keep leaves the Field as saved and the AI is told not to propose again', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [draftCall('d1', 'details.notes', 'Changed.')] })
    if (n === 2) return anthropicReply({ tools: [draftCall('d2', 'details.notes', 'Changed again.')] })
    return anthropicReply({ text: 'ok' })
  })
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  const id = session.snapshot().round.cards[0].id
  session.choose(id, 'Keep')
  await session.submitRound()
  assert.deepEqual(session.snapshot().drafts, {})
  assert.match(lastUserText(ai.calls[2]), /stays as saved/)
  const again = toolResults(ai.calls[3])[0]
  assert.equal(again.is_error, true)
  assert.match(again.content, /chose to keep it/)
  assert.equal(session.snapshot().round, null, 'no second card for a Field the architect kept')
})

test("use the AI's version puts it in the preview, and the AI may then revise it freely", async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [draftCall('d1', 'details.notes', 'AI version one.')] })
    if (n === 2) return anthropicReply({ tools: [draftCall('d2', 'details.notes', 'AI version two.')] })
    return anthropicReply({ text: 'ok' })
  })
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  session.choose(session.snapshot().round.cards[0].id, "Use the AI's version")
  await session.submitRound()
  assert.equal(session.snapshot().drafts['details.notes'].value, 'AI version two.')
  assert.equal(session.snapshot().round, null)
})

test("use shows the AI's version at once when the AI does not revise it", async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'details.notes', 'AI version.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  session.choose(session.snapshot().round.cards[0].id, "Use the AI's version")
  await session.submitRound()
  assert.equal(session.snapshot().drafts['details.notes'].value, 'AI version.')
})

test("merge lets the AI's next draft of that Field through", async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [draftCall('d1', 'details.notes', 'AI version.')] })
    if (n === 2) return anthropicReply({ tools: [draftCall('d2', 'details.notes', 'Saved notes, merged with the AI version.')] })
    return anthropicReply({ text: 'ok' })
  })
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  session.choose(session.snapshot().round.cards[0].id, 'Merge')
  await session.submitRound()
  assert.match(lastUserText(ai.calls[2]), /Write one merged version of details\.notes/)
  assert.equal(session.snapshot().drafts['details.notes'].value, 'Saved notes, merged with the AI version.')
})

test('a draft identical to the saved text is no change and raises no card', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'details.notes', 'Notes the architect already saved.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai, { context: { saved: savedNotes() } })
  await session.start()
  assert.equal(session.snapshot().round, null)
  assert.match(toolResults(ai.calls[1])[0].content, /nothing to change/)
})

// ---------- Finish with your recommendations ----------

test('Finish with your recommendations accepts the pending recommendations, marks proposed figures, and asks one last round', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [ask('a1', [card({ id: 'cost', question: 'Cost?', field: 'details.notes', options: [{ label: 'Low', draft: 'A low cost' }, { label: 'High' }], recommended: 'Low' })])] })
    if (n === 1) {
      return anthropicReply({
        tools: [
          draftCall('d1', 'details.notes', 'Delivery takes 12 weeks and costs $50k.'),
          ask('a2', [card({ id: 'owner', question: 'Who owns it?', field: 'details.owner', options: [{ label: 'Leave blank' }, { label: 'Name one' }], recommended: 'Leave blank' })]),
        ],
      })
    }
    if (n === 2) return anthropicReply({ text: 'Done.' })
    return anthropicReply({ tools: [ask('a3', [card({ id: 'more', question: 'One more?' })])] })
  })
  const { session } = sessionWith(ai)
  await session.start()
  session.choose('cost', 'High')
  session.choose('cost', 'Low')
  const result = await session.finishWithRecommendations()
  assert.equal(result.ok, true)

  assert.match(toolResults(ai.calls[1])[0].content, /\(your recommendation\)/)
  assert.match(toolResults(ai.calls[1])[0].content, /Finish with your recommendations/)
  let snap = session.snapshot()
  assert.equal(snap.drafts['details.notes'].value, 'Delivery takes 12 weeks and costs $50k (target assumption).', 'one mark covers the clause')
  assert.deepEqual(snap.drafts['details.notes'].warnings, [], 'marked by Gantry, not sent back')
  assert.equal(snap.finish, 'final')
  assert.equal(snap.phase, 'asking')
  assert.equal(snap.round.final, true)
  assert.deepEqual(snap.round.cards.map((c) => c.id), ['owner'], 'one last round, about only what the AI cannot propose')

  await session.submitRound()
  assert.match(lastUserText(ai.calls[2]), /last round/)
  snap = session.snapshot()
  assert.equal(snap.finish, 'done')
  assert.equal(snap.phase, 'waiting')

  // A further round of cards after that is not shown.
  await session.send('Anything else?')
  snap = session.snapshot()
  assert.equal(snap.round, null)
  assert.equal(toolResults(ai.calls[4])[0].is_error, true)
  assert.match(toolResults(ai.calls[4])[0].content, /Not shown/)
})

test('Finish with your recommendations is available with no card open, and a figure the AI proposes is still marked', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Opening.' })
    if (n === 1) return anthropicReply({ tools: [draftCall('d1', 'details.notes', 'It takes 12 weeks.')] })
    return anthropicReply({ text: 'Nothing I cannot propose.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.finishWithRecommendations()
  const snap = session.snapshot()
  assert.equal(snap.drafts['details.notes'].value, 'It takes 12 weeks (target assumption).')
  assert.equal(snap.finish, 'done', 'with nothing left to ask, it is finished')
  assert.equal(snap.round, null)
})

test('a figure that cites a Source document, or that the architect typed, is left unmarked after Finish', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Opening.' })
    if (n === 1) return anthropicReply({ text: 'Noted.' })
    if (n === 2) return anthropicReply({ tools: [draftCall('d1', 'details.notes', 'It takes 12 weeks [Client brief, p. 1](source:brief). Budget is $1.2M.')] })
    return anthropicReply({ text: 'ok' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  await session.send('The budget is $1.2M.')
  await session.finishWithRecommendations()
  assert.equal(session.snapshot().drafts['details.notes'].value, 'It takes 12 weeks [Client brief, p. 1](source:brief). Budget is $1.2M.')
})

// ---------- modes without native tools ----------

test('the text fallback works end to end with a model that does not call tools (recorded responses)', async () => {
  const p = openAiText('text')
  const questions = (id, label) => '```gantry-questions\n' + JSON.stringify({ questions: [{ id, question: `Which ${label}?`, field: 'details.owner', options: [{ label: 'Pat' }, { label: 'Sam' }], recommended: 'Pat', why: 'Named in the brief.' }] }) + '\n```'
  const ai = fakeAi((request, n) => {
    if (n === 0) return openAiReply('I read the brief.\n```gantry-draft\n{"field":"details.risk","value":"Low"}\n```\n' + questions('who', 'owner'))
    if (n === 1) return openAiReply('```gantry-draft\n{"field":"details.owner","value":"Sam"}\n```\nAll drafted.')
    return openAiReply('Anything else?')
  })
  const { session } = sessionWith(ai, { provider: p })
  await session.start()
  assert.equal(ai.calls[0].body.tools, undefined, 'no tools are offered')
  assert.match(ai.calls[0].body.messages[0].content, /gantry-questions/)
  let snap = session.snapshot()
  assert.equal(snap.cardMode, 'text')
  assert.equal(snap.phase, 'asking')
  assert.equal(snap.drafts['details.risk'].value, 'Low')
  assert.equal(snap.round.cards[0].id, 'who')
  assert.deepEqual(snap.thread.filter((t) => t.who === 'ai').map((t) => t.text), ['I read the brief.'], 'the blocks are not shown as chat')

  session.choose('who', 'Sam')
  await session.submitRound()
  // The answers went back as a message from Gantry, after the AI's own block.
  const sent = ai.calls[1].body.messages
  assert.equal(sent.at(-1).role, 'user')
  assert.match(sent.at(-1).content, /"Sam" \(not your recommendation\)/)
  assert.match(sent.at(-2).content, /gantry-questions/, 'the AI sees its own question block in the history')
  snap = session.snapshot()
  assert.equal(snap.drafts['details.owner'].value, 'Sam')
  assert.equal(snap.phase, 'waiting')
})

test('an unusable text block is sent back once; a model that keeps failing is asked in plain chat, and chat still works', async () => {
  const p = openAiText('text')
  const bad = '```gantry-questions\n{"questions":[{"question":"No options"}]}\n```'
  const ai = fakeAi((request, n) => (n <= 3 ? openAiReply(`Let me ask.\n${bad}`) : openAiReply('Who owns this?')))
  const { session } = sessionWith(ai, { provider: p })
  await session.start()
  assert.match(ai.calls[1].body.messages.at(-1).content, /question block was not usable/)
  let snap = session.snapshot()
  assert.equal(snap.round, null)
  assert.equal(snap.cardMode, 'text', 'one failed turn is not yet plain chat')

  await session.send('Please ask again.')
  snap = session.snapshot()
  assert.equal(snap.cardMode, 'chat')
  assert.ok(snap.thread.some((t) => t.who === 'sys' && /plain chat/.test(t.text)))
  // From then on the card instructions are not sent.
  const calls = ai.calls.length
  await session.send('Over to you.')
  assert.doesNotMatch(ai.calls[calls].body.messages[0].content, /Ask the architect with question cards/)
  assert.match(ai.calls[calls].body.messages[0].content, /ask in short plain chat/)
  assert.equal(session.snapshot().phase, 'waiting')
})

test('a model whose Test connection found plain chat only starts in chat mode', async () => {
  const p = openAiText('chat')
  const ai = fakeAi(() => openAiReply('Who is the sponsor?'))
  const { session } = sessionWith(ai, { provider: p })
  await session.start()
  const snap = session.snapshot()
  assert.equal(snap.cardMode, 'chat')
  assert.ok(snap.thread.some((t) => t.who === 'sys' && /plain chat/.test(t.text)))
  assert.equal(ai.calls[0].body.tools, undefined)
  assert.doesNotMatch(ai.calls[0].body.messages[0].content, /gantry-questions/)
})

test('switching from a native AI Provider to a text one carries the earlier cards over as blocks', async () => {
  const first = anthropic()
  const second = openAiText('text')
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [ask('a1', [card({ id: 'one' })])] }) : openAiReply('Fine.')))
  const { session } = sessionWith(ai, { provider: first })
  await session.start()
  await session.submitRound()
  const switched = await session.setProvider(second.id)
  assert.equal(switched.ok, true)
  assert.equal(session.snapshot().cardMode, 'text')
  await session.send('Carry on.')
  const sent = ai.calls.at(-1).body.messages
  assert.ok(sent.some((m) => typeof m.content === 'string' && /gantry-questions/.test(m.content)), 'the earlier card is shown to the second model as its own block')
  assert.ok(sent.every((m) => m.role !== 'tool'))
})
