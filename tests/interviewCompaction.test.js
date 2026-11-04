import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #329 (docs/adr/0073): an AI interview compacts its conversation before it outgrows the model's context window. A card offers it past about
// 60% of the window, Compact now does it at any time, and a request the AI Provider refuses as too long is compacted without asking and sent
// once more. The new conversation is Gantry's opening, the AI's own summary, the drafts and the architect's own words; the decisions log is in
// the brief. A fake `fetch` plays the AI Provider; the tests look at what it is sent and at the session's snapshot.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, compactConversation, COMPACT_OFFER_AT, COMPACT_ASK_AGAIN_AFTER, SUMMARY_REQUEST } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))

const definition = () => ({
  id: 'soap',
  stages: [{ id: 'soap', title: 'SOAP', purpose: 'Describe the system as it is.', gate: 'described', modules: ['soap'] }],
  artefacts: [{ id: 'soap', title: 'SOAP', gate: 'described', requires: ['soap.subjective'] }],
  modules: [{ id: 'soap', title: 'SOAP', fields: ['subjective', 'objective', 'assessment', 'plan'].map((id) => ({ id, title: id[0].toUpperCase() + id.slice(1), type: 'markdown' })) }],
})
const savedNothing = () => [{ id: 'soap', status: 'draft', fields: ['subjective', 'objective', 'assessment', 'plan'].map((id) => ({ id, value: '' })) }]

const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
/** An Anthropic stream that reports `input` tokens of input. */
function anthropicReply({ text, tools = [], input = 10 }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: input, output_tokens: 1 } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}
const openAiReply = (text) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ANTHROPIC_TOO_LONG = () => jsonRes(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 215000 tokens > 200000 maximum' } })
const OPENAI_TOO_LONG = () =>
  jsonRes(400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130112 tokens. Please reduce the length of the messages.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } })

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    const raw = envelope.body ? JSON.parse(envelope.body) : null
    calls.push({ raw, body: withFlatSystem(raw) })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

function anthropic(contextWindow = 10000) {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', contextWindow })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}
function openAiCompatible() {
  const p = providers.addAiProvider({ name: 'Gateway', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'big', contextWindow: 128000 })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

function sessionWith(ai, provider) {
  const context = { definition: definition(), stageId: 'soap', artefactId: 'soap', size: 'medium', saved: savedNothing(), sources: [], skills }
  return createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl })
}

const draft = (id, value) => ({ id, name: 'draft_field', input: { field: 'soap.subjective', value } })
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const card = (id) => ({ id, header: `Topic ${id}`, question: `Question ${id}?`, options: [{ label: `${id} yes`, description: 'Say yes' }, { label: `${id} no`, description: 'Say no' }], recommended: `${id} yes`, why: `Because ${id}.` })

/** What a request (the raw Anthropic body, or an OpenAI-compatible one) holds as text, message by message. */
const textsOf = (raw) => raw.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, text: typeof m.content === 'string' ? m.content : (m.content ?? []).map((b) => b.text ?? b.content ?? '').join('\n') }))
const isSummaryCall = (call) => JSON.stringify(call.raw.messages).includes('where we are')
const compactedLines = (session) => session.snapshot().thread.filter((t) => t.compacted).map((t) => t.text)

const DRAFT = 'Claims take too long to settle.'
const SUMMARY = 'SUMMARY: we read nothing yet; the subjective Field is drafted; the objective is open; next I was going to ask about it.'
const CHAT = 'Please note the budget is capped at NZD 1.2M, and leave out Finance.'

// ---------- the card ----------

test('a reported input past about 60% of the window shows the card, with the count before and an estimate after', async () => {
  assert.equal(COMPACT_OFFER_AT, 0.6)
  const inputs = [100000, 122000]
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ text: 'Drafting.', tools: [draft('d1', DRAFT)], input: 3000 }) : anthropicReply({ text: 'Done for now.', input: inputs.shift() })))
  const session = sessionWith(ai, anthropic(200000))
  await session.start()
  assert.equal(session.snapshot().compactOffer, null, 'at 50% of the window there is no card')

  await session.send(CHAT)
  const offer = session.snapshot().compactOffer
  assert.equal(offer.before, 122000, 'what the AI Provider reported for the last call')
  assert.equal(offer.window, 200000)
  assert.ok(offer.after > 0 && offer.after < offer.before, `an estimate after: ${offer.after}`)
  assert.equal(ai.calls.length, 3, 'the card asks: nothing is compacted by itself')
})

test('Not now does not ask again until the conversation has grown a further 10% of the window', async () => {
  assert.equal(COMPACT_ASK_AGAIN_AFTER, 0.1)
  const inputs = [124000, 138000, 146000]
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ text: 'Drafting.', tools: [draft('d1', DRAFT)], input: 3000 }) : anthropicReply({ text: 'Noted.', input: inputs.shift() })))
  const session = sessionWith(ai, anthropic(200000))
  await session.start()
  assert.ok(session.snapshot().compactOffer)
  session.notNowCompact()
  assert.equal(session.snapshot().compactOffer, null)
  await session.send('Two.')
  assert.equal(session.snapshot().compactOffer, null, '138k is less than 124k plus 20k')
  await session.send('Three.')
  assert.equal(session.snapshot().compactOffer.before, 146000, 'past 144k it asks again')
})

// ---------- Compact now ----------

// n0 drafts and n1 says so; the architect chats (n2 logs it, n3 replies). Then Compact now: n4 is the summary call. The architect chats again: n5.
function chattySession(provider = anthropic(10000), { summary = () => anthropicReply({ text: SUMMARY, input: 900 }) } = {}) {
  const ai = fakeAi((req, n) => {
    if (isSummaryCall(req)) return summary()
    if (n === 0) return anthropicReply({ text: 'I drafted the subjective Field.', tools: [draft('d1', DRAFT)], input: 3000 })
    if (n === 1) return anthropicReply({ text: 'That is the first draft.', input: 3200 })
    if (n === 2) return anthropicReply({ tools: [{ id: 'l1', name: 'log_decision', input: { kind: 'fact', quote: 'the budget is capped at NZD 1.2M', fields: ['soap.subjective'] } }], input: 6000 })
    return anthropicReply({ text: 'Noted, carrying on.', input: 6500 })
  })
  return { ai, session: sessionWith(ai, provider) }
}

test('Compact now asks the AI for its summary in one call with no tools, and the next request has the summary, the drafts, the log and the architect messages, and none of the old history', async () => {
  const { ai, session } = chattySession()
  await session.start()
  await session.send(CHAT)
  assert.equal(ai.calls.length, 4)
  const before = session.snapshot()

  const done = await session.compactNow()
  assert.deepEqual(done, { ok: true })
  assert.equal(ai.calls.length, 5)
  const summaryCall = ai.calls[4].raw
  assert.ok(!summaryCall.tools?.length, 'no tools are offered')
  const summaryTexts = textsOf(summaryCall)
  assert.ok(summaryTexts.at(-1).text.includes(SUMMARY_REQUEST), 'the last thing it is told is to write the summary')
  assert.ok(!JSON.stringify(summaryCall.messages).includes('tool_use'), 'the tool calls so far are shown as text')
  assert.ok(summaryTexts.some((m) => m.text.includes('I drafted the subjective Field.')), 'the summary is written from the whole conversation')

  // The thread, drafts, round and log are as they were, apart from one line.
  const after = session.snapshot()
  assert.equal(after.phase, 'waiting')
  assert.deepEqual(after.thread.slice(0, -1), before.thread)
  assert.match(after.thread.at(-1).text, /^Conversation compacted \(6\.5k → [\d.]+k? tokens\)$/)
  assert.deepEqual(after.drafts, before.drafts)
  assert.deepEqual(after.decisions, before.decisions)
  assert.ok(after.tokens.input > before.tokens.input, "the summary call's tokens count towards the session")
  const delta = session.decisionsDelta()
  assert.ok(!JSON.stringify(delta).includes('SUMMARY:'), 'the summary is never in the decisions log')

  await session.send('What next?')
  const next = ai.calls[5]
  const texts = textsOf(next.raw)
  assert.match(texts[0].text, /^Begin the interview\./, "Gantry's opening, as it was")
  assert.ok(texts[1].text.includes(SUMMARY), 'the summary')
  assert.ok(texts[1].text.includes(`### soap.subjective\n\n${DRAFT}`), 'the drafts')
  assert.deepEqual(texts.slice(2).map((m) => m.text), [CHAT, 'What next?'], "the architect's own messages, word for word")
  assert.ok(next.body.system.includes('the architect\'s words: "Please note the budget is capped at NZD 1.2M, and leave out Finance."'), 'the decisions log, in the brief')
  const sent = JSON.stringify(next.raw.messages)
  for (const old of ['I drafted the subjective Field.', 'That is the first draft.', 'Noted, carrying on.', 'tool_use', 'tool_result', 'is in the preview']) assert.ok(!sent.includes(old), `none of the old history: ${old}`)
  assert.equal(next.raw.messages.at(-1).role, 'user')
})

test("the architect's answers and chat messages reach the new conversation word for word", async () => {
  const OTHER = 'Our own words, exactly: 42 widgets a day, not 40.'
  const ai = fakeAi((req, n) => {
    if (isSummaryCall(req)) return anthropicReply({ text: SUMMARY })
    if (n === 0) return anthropicReply({ text: 'One question.', tools: [draft('d1', DRAFT), ask('a1', [{ ...card('volume'), field: 'soap.objective' }])] })
    return anthropicReply({ text: 'Thanks.' })
  })
  const session = sessionWith(ai, anthropic())
  await session.start()
  const [asked] = session.snapshot().round.cards
  session.setOtherText(asked.id, OTHER)
  assert.deepEqual(await session.submitRound(), { ok: true })
  await session.send(CHAT)
  await session.send('And the second message, also verbatim.')
  await session.compactNow()
  await session.send('Carry on.')

  const next = ai.calls.at(-1)
  assert.ok(next.body.system.includes(`the architect's words: "${OTHER}"`), "an answer's own words are in the log the brief carries")
  assert.deepEqual(textsOf(next.raw).slice(2).map((m) => m.text), [CHAT, 'And the second message, also verbatim.', 'Carry on.'])
  assert.ok(!JSON.stringify(next.raw.messages).includes('answered the card'), 'the old round result is not carried as history')
})

test('Compact now while a round of cards is open waits for the round, then compacts before the next request', async () => {
  const ai = fakeAi((req, n) => {
    if (isSummaryCall(req)) return anthropicReply({ text: SUMMARY })
    if (n === 0) return anthropicReply({ text: 'One question.', tools: [draft('d1', DRAFT), ask('a1', [card('scope')])] })
    return anthropicReply({ text: 'Next round.', tools: [ask('a2', [card('next')])] })
  })
  const session = sessionWith(ai, anthropic())
  await session.start()
  assert.equal(session.snapshot().phase, 'asking')
  assert.deepEqual(await session.compactNow(), { ok: true, queued: true })
  assert.equal(ai.calls.length, 1, 'nothing is compacted while the round is open')
  assert.equal(session.snapshot().compactPending, true)

  session.choose(session.snapshot().round.cards[0].id, 'scope yes')
  await session.submitRound()
  assert.equal(ai.calls.length, 3)
  assert.ok(isSummaryCall(ai.calls[1]), 'the summary is asked for first')
  const texts = textsOf(ai.calls[2].raw)
  assert.ok(texts[1].text.includes(SUMMARY))
  assert.match(texts.at(-1).text, /^Where the conversation had got to when it was compacted\. Carry on from here\.\n\n- soap\.subjective is in the preview/, 'the results of its last tool calls')
  assert.ok(texts.at(-1).text.includes('- The architect answered the card of round 1:\n- [scope] Question scope? → "scope yes"'), "and the round's answers, which is where it carries on from")
  assert.ok(!JSON.stringify(ai.calls[2].raw.messages).includes('tool_use'))
  const snap = session.snapshot()
  assert.equal(snap.compactPending, false)
  assert.equal(snap.phase, 'asking')
  assert.equal(snap.round.cards[0].header, 'Topic next', 'the interview carries on to its next round')
  assert.equal(compactedLines(session).length, 1)
})

test('a failed summary call rebuilds the conversation without it, and the thread says so', async () => {
  const { ai, session } = chattySession(anthropic(10000), { summary: () => jsonRes(500, { error: { message: 'Internal error' } }) })
  await session.start()
  await session.send(CHAT)
  await session.compactNow()
  const [line] = compactedLines(session)
  assert.match(line, /^Conversation compacted \(6\.5k → [\d.]+k? tokens\)\. The AI couldn't write its summary \(Internal error\), so it carries on from the drafts, the decisions log and your own messages$/)
  assert.equal(session.snapshot().phase, 'waiting')

  await session.send('What next?')
  const texts = textsOf(ai.calls.at(-1).raw)
  assert.match(texts[1].text, /There is no summary from you this time/)
  assert.ok(texts[1].text.includes(DRAFT))
  assert.deepEqual(texts.slice(2).map((m) => m.text), [CHAT, 'What next?'])
  assert.ok(!JSON.stringify(ai.calls.at(-1).raw.messages).includes('Noted, carrying on.'))
})

// ---------- a too-long refusal ----------

for (const [name, provider, tooLong, reply] of [
  ['Anthropic', () => anthropic(200000), ANTHROPIC_TOO_LONG, (text) => anthropicReply({ text })],
  ['an OpenAI-compatible AI Provider', openAiCompatible, OPENAI_TOO_LONG, openAiReply],
]) {
  test(`a too-long refusal from ${name} compacts without asking and sends the request once more`, async () => {
    const ai = fakeAi((req, n) => {
      if (isSummaryCall(req)) return reply(SUMMARY)
      if (n === 0) return reply('Here is what I found.')
      if (n === 1) return tooLong()
      return reply('Carrying on after compacting.')
    })
    const session = sessionWith(ai, provider())
    await session.start()
    await session.send(CHAT)
    assert.equal(ai.calls.length, 4, 'the refused request, the summary, and the same request once more')
    assert.ok(isSummaryCall(ai.calls[2]))
    const summaryTexts = textsOf(ai.calls[2].raw)
    assert.ok(summaryTexts.at(-1).text.includes(SUMMARY_REQUEST))
    const retried = textsOf(ai.calls[3].raw)
    assert.ok(retried.some((m) => m.text.includes(SUMMARY)))
    assert.equal(retried.at(-1).text, CHAT, "the architect's message is what it answers")
    assert.ok(!JSON.stringify(ai.calls[3].raw.messages).includes('Here is what I found.'))
    const snap = session.snapshot()
    assert.equal(snap.phase, 'waiting')
    assert.equal(snap.error, null)
    assert.equal(compactedLines(session).length, 1)
    assert.ok(snap.thread.some((t) => t.who === 'ai' && t.text === 'Carrying on after compacting.'))
  })

  test(`a second too-long refusal from ${name} is shown as an error`, async () => {
    const ai = fakeAi((req, n) => {
      if (isSummaryCall(req)) return reply(SUMMARY)
      if (n === 0) return reply('Here is what I found.')
      return tooLong()
    })
    const session = sessionWith(ai, provider())
    await session.start()
    await session.send(CHAT)
    assert.equal(ai.calls.length, 4, 'compacted and retried once, and no more')
    const snap = session.snapshot()
    assert.equal(snap.phase, 'error')
    assert.equal(snap.error.code, 'too-long')
    assert.match(snap.error.message, /too long for the model.*Gantry compacted the conversation and sent it once more, and it is still too long/s)
  })
}

test('a too-long refusal of the summary call itself still rebuilds the conversation, with every read as its note', async () => {
  const ai = fakeAi((req, n) => {
    if (isSummaryCall(req)) return ANTHROPIC_TOO_LONG()
    if (n === 0) return anthropicReply({ text: 'Here is what I found.' })
    if (n === 1) return ANTHROPIC_TOO_LONG()
    return anthropicReply({ text: 'Carrying on.' })
  })
  const session = sessionWith(ai, anthropic(200000))
  await session.start()
  await session.send(CHAT)
  assert.equal(ai.calls.length, 4)
  assert.match(compactedLines(session)[0], /The AI couldn't write its summary \(Work Anthropic says the conversation is too long for the model: prompt is too long/)
  assert.equal(session.snapshot().phase, 'waiting')
})

// ---------- compactConversation, on its own ----------

test('the rebuilt conversation keeps the opening, the architect messages in order and what came after the last reply, with reads as notes', () => {
  const label = { title: 'Billing API', where: 'src/a.ts', commit: 'c0ffee1234567890', chars: 50000 }
  const messages = [
    { role: 'user', text: 'Begin the interview.' },
    { role: 'user', text: 'My opening words.' },
    { role: 'assistant', text: 'Reading.', toolCalls: [{ id: 't1', name: 'read_repository_file', input: {} }] },
    { role: 'tool', toolCallId: 't1', name: 'read_repository_file', content: 'x'.repeat(50000), reads: [{ at: 0, length: 50000, label }] },
    { role: 'assistant', text: 'What is the budget?' },
    { role: 'user', text: 'NZD 1.2M.' },
    { role: 'assistant', text: 'Reading more.', toolCalls: [{ id: 't2', name: 'read_repository_file', input: {} }] },
    { role: 'tool', toolCallId: 't2', name: 'read_repository_file', content: 'y'.repeat(50000), reads: [{ at: 0, length: 50000, label }] },
  ]
  const out = compactConversation(messages, { summary: 'Where we are.', drafts: [{ key: 'soap.plan', value: ['One', 'Two'] }] })
  assert.equal(out[0].text, 'Begin the interview.')
  assert.ok(out[1].fromGantry)
  assert.ok(out[1].text.includes('Where we are.'))
  assert.ok(out[1].text.includes('### soap.plan\n\n- One\n- Two'))
  assert.deepEqual(out.slice(2, 4).map((m) => [m.text, Boolean(m.fromGantry)]), [['My opening words.', false], ['NZD 1.2M.', false]])
  assert.match(out[4].text, /^Where the conversation had got to when it was compacted\. Carry on from here\.\n\n- \[Read earlier: Billing API src\/a\.ts at c0ffee1234567890, 50,000 characters\./)
  assert.equal(out.length, 5)
  assert.ok(!out.some((m) => m.role === 'assistant' || m.role === 'tool'))
})
