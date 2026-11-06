import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #349: the AI is told what keeps a Stage from its stage-end card. When a turn would end with no round of cards open, nothing held and
// the Stage not ready, Gantry sends the AI its verdict (the Gate check's outstanding items, and each Field in scope that isn't done with
// Gantry's reasons) as a note in the conversation, and the AI carries on in the same turn, at most once a turn. The readiness is the
// page's own (`context.readiness`, the rule in web/lib/interviewReadiness.js), so the session never works it out a second way. A fake
// `fetch` plays the AI Provider through the relay; the AI Providers list is the real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession, statusLine, readinessNote } = await import('../web/lib/interviewSession.js')
const { stageReadiness } = await import('../web/lib/interviewReadiness.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { INTERVIEW_RULES: RULES } = await import('../web/lib/interviewRules.js')
const { LOG_TOOL, LOG_TEXT_FALLBACK_INSTRUCTIONS } = await import('../web/lib/interviewLog.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))

// The Gate needs the Problem statement (a budget of 24 to 40 words at medium) and, with `owner`, an Owner only the architect can name.
const definition = ({ owner = false } = {}) => ({
  id: 'small',
  standardModules: [],
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: owner ? ['details.summary', 'details.owner'] : ['details.summary'] }],
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
})
const sources = [{ id: 'tech-lt', title: 'Tech LT deck', filename: 'deck.md', size: 40, text: '# Tech LT deck\n\nThe platform moves to managed hosting.' }]
const words = (n) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ')

const sse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })

function anthropicReply({ text, tools = [] } = {}) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  let out = event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
  let index = 0
  const block = (content, deltas) => {
    out += event('content_block_start', { type: 'content_block_start', index, content_block: content })
    for (const delta of deltas) out += event('content_block_delta', { type: 'content_block_delta', index, delta })
    out += event('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (text) block({ type: 'text', text: '' }, [{ type: 'text_delta', text }])
  for (const tool of tools) block({ type: 'tool_use', id: tool.id, name: tool.name ?? 'draft_field', input: {} }, [{ type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }])
  out += event('message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
  out += event('message_stop', { type: 'message_stop' })
  return sse(out)
}

// An OpenAI-compatible reply, for a model without tool calling (the text fallback).
function openAiReply(text) {
  const chunk = (data) => `data: ${JSON.stringify(data)}\n\n`
  return sse(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + 'data: [DONE]\n\n')
}

const draft = (id, field, value) => ({ id, input: { field, value } })
const ask = { id: 'ask', name: 'ask_architect', input: { questions: [{ header: 'Owner', question: 'Who owns it?', field: 'details.owner', options: [{ label: 'Pat' }, { label: 'Sam' }], recommended: 'Pat', why: 'The deck names Pat.' }] } }

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}
const textOnly = () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'text', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}

// The page's readiness, as web/lib/interviewView.js hands it over: the same rule the live preview shows.
function sessionWith(ai, { owner = false, provider = anthropic(), withReadiness = true } = {}) {
  const def = definition({ owner })
  const saved = [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'owner', value: '' }] }]
  const context = { definition: def, stageId: 'shape', artefactId: 'light', size: 'medium', saved, sources, skills }
  if (withReadiness) context.readiness = ({ drafts, openFields }) => stageReadiness({ definition: def, structure: def, stageId: 'shape', artefactId: 'light', size: 'medium', modules: saved, drafts, openFields })
  const lines = []
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, onChange: (snap) => lines.push(statusLine(snap)) })
  return { session, context, lines }
}

// The text of the last user turn of a request.
function lastUserText(body) {
  if (!body.messages) return ''
  const m = body.messages.filter((x) => x.role === 'user').at(-1)
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}
const NOTE = /^Gantry's check: the Stage is not ready yet/
const notesIn = (ai) => ai.calls.filter((c) => NOTE.test(lastUserText(c.body))).length
const readyNow = ({ session, context }) => context.readiness({ drafts: session.snapshot().drafts, openFields: session.snapshot().openFields })

test('a Field under its word budget and no cards open: the next request in the same turn carries the note, and the AI redrafts it', async () => {
  const ai = fakeAi((_req, n) =>
    [
      anthropicReply({ tools: [draft('d1', 'details.summary', words(5))] }),
      anthropicReply({ text: 'I have drafted the Problem statement.' }),
      anthropicReply({ tools: [draft('d2', 'details.summary', words(30))] }),
      anthropicReply({ text: 'The Problem statement is now full length.' }),
    ][n]
  )
  const s = sessionWith(ai)
  await s.session.start()
  assert.equal(ai.calls.length, 4, 'one turn: the note goes and the AI carries on')
  const note = lastUserText(ai.calls[2].body)
  assert.match(note, NOTE)
  assert.match(note, /- Details · Problem statement \(details\.summary\): 5 words, needs about 24 to 40/)
  assert.doesNotMatch(note, /Gate check/, 'the Gate passes on a short Problem statement, so it is not named')
  assert.match(note, /Redraft now what you can/)
  assert.match(note, /question cards/)
  assert.equal(readyNow(s).ready, true, 'the stage-end card can now appear')
  assert.equal(notesIn(ai), 1)
  const snap = s.session.snapshot()
  assert.equal(snap.phase, 'waiting')
  assert.ok(!snap.thread.some((t) => t.carryOn), 'a turn that ends with replies has no Carry on line')
  assert.ok(!snap.thread.some((t) => NOTE.test(t.text ?? '')), 'the note is for the AI: the thread shows what it does about it')
  // The status line shows the work as usual: the redraft after the note says what it is drafting, as the first draft did.
  const shown = s.lines.filter(Boolean).map((l) => l.text).filter((t, i, all) => t !== all[i - 1])
  assert.equal(shown.filter((t) => t === 'Drafting Details · Problem statement…').length, 2, JSON.stringify(shown))
})

test('a Stage only the architect can make ready: the note goes once, the AI explains, and the turn ends with no second note', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [draft('d1', 'details.summary', words(30))] }) : anthropicReply({ text: n === 1 ? 'Drafted.' : 'I need the Owner from you before the Stage is ready.' })))
  const s = sessionWith(ai, { owner: true })
  await s.session.start()
  assert.equal(ai.calls.length, 3)
  assert.equal(notesIn(ai), 1)
  const note = lastUserText(ai.calls[2].body)
  // The Gate check's outstanding item is named, with the Field's own name.
  assert.match(note, /- The Gate check for Light: outstanding Details · Owner \(details\.owner\)/)
  assert.match(note, /- Details · Owner \(details\.owner\): no content yet/)
  assert.deepEqual(s.session.snapshot().thread.filter((t) => t.who === 'ai').map((t) => t.text), ['Drafted.', 'I need the Owner from you before the Stage is ready.'])
  assert.equal(readyNow(s).ready, false)

  // The next turn is a turn of its own: it may have its note too, once.
  await s.session.send('Still thinking about who owns it.')
  assert.equal(ai.calls.length, 5)
  assert.equal(notesIn(ai), 2)
})

test('no note when the Stage is ready', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [draft('d1', 'details.summary', words(30))] }) : anthropicReply({ text: 'Done.' })))
  const s = sessionWith(ai)
  await s.session.start()
  assert.equal(ai.calls.length, 2)
  assert.equal(notesIn(ai), 0)
})

test('no note while a round of cards is open', async () => {
  const ai = fakeAi(() => anthropicReply({ tools: [draft('d1', 'details.summary', words(5)), ask] }))
  const s = sessionWith(ai, { owner: true })
  await s.session.start()
  assert.equal(s.session.snapshot().phase, 'asking')
  assert.equal(ai.calls.length, 1, 'the cards end the turn')
  assert.equal(notesIn(ai), 0)
})

test('no note in Finish with your recommendations: not while the AI asks its last round, nor once the architect has had it', async () => {
  let n = 0
  const ai = fakeAi((req) => {
    const said = lastUserText(req.body)
    n++
    if (n === 1) return anthropicReply({ tools: [draft('d1', 'details.summary', words(5)), ask] })
    if (/^The architect chose "Finish with your recommendations"/.test(said)) return anthropicReply({ text: 'Accepted my recommendations.' })
    if (/^The architect answered/.test(said)) return anthropicReply({ text: 'That was the last round.' })
    return anthropicReply({ text: 'Noted.' })
  })
  const s = sessionWith(ai, { owner: true })
  await s.session.start()
  assert.equal(s.session.snapshot().phase, 'asking')
  // Finish while the round is open accepts the recommendations and calls the AI for its last round: it asks nothing and ends.
  await s.session.finishWithRecommendations()
  assert.equal(notesIn(ai), 0)
  assert.equal(readyNow(s).ready, false, 'the Problem statement is still short')
  // And once the architect has finished, chat gets no note either: the AI has been told to ask nothing more.
  await s.session.send('Thanks.')
  assert.equal(notesIn(ai), 0)
})

test('no note when nothing has been drafted this session, nor when the page gives no readiness', async () => {
  const quiet = fakeAi(() => anthropicReply({ text: 'What would you like to start with?' }))
  await sessionWith(quiet).session.start()
  assert.equal(quiet.calls.length, 1)
  const noReadiness = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [draft('d1', 'details.summary', words(5))] }) : anthropicReply({ text: 'Drafted.' })))
  await sessionWith(noReadiness, { withReadiness: false }).session.start()
  assert.equal(noReadiness.calls.length, 2)
})

test('no note when every Field this Stage can draft is done and the Gate waits on one it can\'t (a Module held until an earlier Stage merges)', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [draft('d1', 'details.summary', words(30))] }) : anthropicReply({ text: 'Drafted.' })))
  const s = sessionWith(ai)
  // The page's verdict for a Stage drafted ahead: its own Fields done, the Gate still needing a held Module's Field.
  s.context.readiness = () => ({ gate: { pass: false, artefact: { id: 'light', title: 'Light' }, outstanding: ['shared.more'] }, fields: { 'details.summary': { done: true, reasons: [], required: true } }, allDone: true, ready: false })
  await s.session.start()
  assert.equal(ai.calls.length, 2)
  assert.equal(notesIn(ai), 0)
})

test('a turn with nothing to show is still #345\'s: the thread says the AI stopped, with Carry on, and no note goes', async () => {
  const ai = fakeAi((_req, n) => (n === 0 ? anthropicReply({ tools: [draft('d1', 'details.summary', words(5))] }) : n < 3 ? anthropicReply({ text: 'Drafted.' }) : anthropicReply()))
  const s = sessionWith(ai)
  await s.session.start()
  assert.equal(notesIn(ai), 1)
  await s.session.send('Anything else?')
  assert.equal(ai.calls.length, 4, 'the empty reply ends the turn: Gantry does not ask again on its own')
  assert.equal(notesIn(ai), 1)
  assert.deepEqual(s.session.snapshot().thread.filter((t) => t.carryOn).map((t) => t.carryOn), ['empty'])
})

test('the text fallback gets the same note, and the AI redrafts in a fenced block', async () => {
  const block = (value) => '```gantry-draft\n' + JSON.stringify({ field: 'details.summary', value }) + '\n```'
  const ai = fakeAi((_req, n) => openAiReply(n === 0 ? `I drafted the Problem statement.\n${block(words(5))}` : `Now at full length.\n${block(words(30))}`))
  const s = sessionWith(ai, { provider: textOnly() })
  await s.session.start()
  assert.equal(ai.calls.length, 2)
  const said = ai.calls[1].body.messages.filter((m) => m.role === 'user').at(-1).content
  assert.match(typeof said === 'string' ? said : JSON.stringify(said), /Gantry's check: the Stage is not ready yet[\s\S]*Details · Problem statement \(details\.summary\): 5 words, needs about 24 to 40/)
  assert.equal(readyNow(s).ready, true)
})

test('in plain-chat mode the note says to ask in chat', () => {
  const verdict = { gate: { pass: true, outstanding: [], artefact: { title: 'Light' } }, fields: { 'details.owner': { done: false, reasons: ['no content yet'], required: true } }, ready: false }
  const note = readinessNote(verdict, { fieldTitle: () => 'Details · Owner', chat: true })
  assert.match(note, /- Details · Owner \(details\.owner\): no content yet/)
  assert.match(note, /in short plain chat/)
  assert.doesNotMatch(note, /question cards/)
})

test('the AI\'s rules say what Gantry checks: an open question card holds a Field, a logged open question does not', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Hello.' }))
  await sessionWith(ai).session.start()
  const system = ai.calls[0].body.system
  assert.doesNotMatch(system, /no open question feeds it/)
  assert.match(system, /no question card feeding it is still unanswered or held back/)
  assert.match(system, /Logging an open question records it in the decisions log; it does not hold a Field back/)
  assert.match(system, /You can't see the stage-end card/)
  const rule = RULES.find((r) => r.id === 'stage-ready').text
  assert.doesNotMatch(rule, /no open question feeds it/)
  assert.match(rule, /question card/)
  assert.match(LOG_TOOL.description, /does not hold the Field back/)
  assert.match(LOG_TEXT_FALLBACK_INSTRUCTIONS, /does not hold the Field back/)
})
