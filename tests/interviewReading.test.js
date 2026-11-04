import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #292 (parent #238): the AI interview session reading large Source document packs, scanned PDFs and pictures. A fake `fetch`
// plays the AI Provider and the tests look at what it was sent and how the session records what the AI read.
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

const definition = () => ({
  id: 'small',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary'] }],
  modules: [
    {
      id: 'details',
      title: 'Details',
      fields: [
        { id: 'summary', title: 'Summary', type: 'markdown', required: true },
        { id: 'notes', title: 'Notes', type: 'markdown' },
      ],
    },
  ],
})
const savedNothing = () => [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }, { id: 'notes', value: '' }] }]

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
const openAiReply = (text) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

function fakeAi(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ url: envelope.url, body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null, raw: envelope.body })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}

const tested = (id, over = {}) => providers.setAiProviderTest(id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok', ...over }, null)
function anthropic({ readsImages = false, contextWindow } = {}) {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', ...(contextWindow ? { contextWindow } : {}) })
  tested(p.id, { readsImages })
  return p
}

function sessionWith(ai, { provider, sources, readOriginal, window } = {}) {
  const chosen = provider ?? anthropic({ contextWindow: window })
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, readOriginal }
  const session = createInterviewSession({ providerId: chosen.id, getContext: () => context, fetchImpl: ai.fetchImpl })
  return { session, context }
}

const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}

const word = (n, label) => `${label} `.repeat(n)
// A pack too big for a small window: three documents of about 2,000 tokens each against a 4,000-token window.
const bigPack = () => [
  { id: 'brief', title: 'Client brief', filename: 'brief.md', size: 9000, text: `# Client brief\n\n## Scope\n\nClaims are slow. ${word(900, 'alpha')}\n\n## Budget\n\nThe budget is capped. ${word(900, 'beta')}` },
  { id: 'costs', title: 'Costs', filename: 'costs.md', size: 9000, text: `# Costs\n\n${word(1500, 'gamma')}` },
  { id: 'spec', title: 'Spec', filename: 'spec.pdf', size: 9000, text: Array.from({ length: 4 }, (_, i) => `## Page ${i + 1}\n\nSpec page ${i + 1} ${word(400, 'delta')}`).join('\n\n') },
]

// ---------- a pack over the threshold ----------

test('a pack over the threshold is a catalogue, and the AI reads a section by id and range', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) {
      return anthropicReply({
        text: 'Reading the brief and the spec.',
        tools: [
          { id: 'r1', name: 'read_source_document', input: { id: 'brief', range: 'section: Scope' } },
          { id: 'r2', name: 'read_source_document', input: { id: 'spec', range: 'pages 2-3' } },
        ],
      })
    }
    if (n === 1) return anthropicReply({ tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Claims are slow [Client brief, p. 1](source:brief).' } }] })
    return anthropicReply({ text: 'Drafted.' })
  })
  const { session } = sessionWith(ai, { sources: bigPack(), window: 4000 })
  await session.start()

  // The brief carried a catalogue, not the text, and the AI was handed the reader beside the draft tool.
  const first = ai.calls[0].body
  assert.deepEqual(first.tools.map((t) => t.name), ['ask_architect', 'draft_field', 'log_decision', 'read_source_document'])
  assert.match(first.system, /only a catalogue is shown/)
  assert.match(first.system, /read_source_document\(id, range\)/)
  assert.match(first.system, /\*\*Client brief\*\* \(id `brief`/)
  assert.match(first.system, /Outline: Client brief \/ Scope \/ Budget/)
  assert.doesNotMatch(first.system, /alpha alpha/, 'none of the text is in the catalogue')
  assert.match(first.system, /The Source documents are a catalogue/)

  // The section and the pages came back as tool results, with only what was asked for.
  const results = toolResults(ai.calls[1])
  assert.deepEqual(results.map((r) => [r.tool_use_id, Boolean(r.is_error)]), [['r1', false], ['r2', false]])
  assert.match(results[0].content, /^\[Client brief · section "Scope"/)
  assert.match(results[0].content, /Claims are slow\./)
  assert.doesNotMatch(results[0].content, /The budget is capped/)
  assert.match(results[1].content, /^\[Spec · pages 2–3/)
  assert.match(results[1].content, /Spec page 2/)
  assert.doesNotMatch(results[1].content, /Spec page 4/)

  // The thread says what was read.
  const snap = session.snapshot()
  assert.deepEqual(snap.thread.filter((t) => t.read).map((t) => t.text), ['Read Client brief (section "Scope")', 'Read Spec (pages 2–3)'])
})

test('reads show up as inputs of the Fields they feed, kept with the log after a Save', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [{ id: 'r1', name: 'read_source_document', input: { id: 'brief', range: 'section: Scope' } }] })
    if (n === 1) {
      return anthropicReply({
        tools: [
          { id: 'd1', input: { field: 'details.summary', value: 'Claims are slow [Client brief, p. 1](source:brief) and the costs are in [Costs](source:costs).' } },
        ],
      })
    }
    if (n === 2) return anthropicReply({ tools: [{ id: 'r2', name: 'read_source_document', input: { id: 'costs', range: '0-100' } }] })
    if (n === 3) return anthropicReply({ tools: [{ id: 'd2', input: { field: 'details.notes', value: 'See the costs.' } }] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai, { sources: bigPack(), window: 4000 })
  await session.start()
  const snap = session.snapshot()

  const summary = snap.drafts['details.summary'].inputs
  assert.deepEqual(summary.map((i) => [i.source, i.range]), [['brief', 'section "Scope"'], ['costs', null]], 'the read, then the document it cites but did not read')
  assert.ok(summary[0].fingerprint && summary[1].fingerprint)

  // The next draft got only the read made after the first one: reads are spent once a round of drafts has landed.
  assert.deepEqual(snap.drafts['details.notes'].inputs.map((i) => [i.source, i.range]), [['costs', 'characters 0–100']])

  session.markSaved(['details.summary', 'details.notes'])
  const after = session.snapshot()
  assert.deepEqual(after.drafts, {})
  assert.equal(after.fieldInputs['details.summary'].length, 2, 'the log keeps the inputs after the Save')
})

test('a draft sent back for a fix keeps the inputs it had', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [{ id: 'r1', name: 'read_source_document', input: { id: 'brief', range: 'section: Budget' } }] })
    // The first draft has an unsourced figure and is sent back.
    if (n === 1) return anthropicReply({ tools: [{ id: 'd1', input: { field: 'details.summary', value: 'The budget is $5 million.' } }] })
    if (n === 2) return anthropicReply({ tools: [{ id: 'd2', input: { field: 'details.summary', value: 'The budget is $5 million (target assumption).' } }] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai, { sources: bigPack(), window: 4000 })
  await session.start()
  assert.equal(toolResults(ai.calls[2])[0].is_error, true)
  assert.deepEqual(session.snapshot().drafts['details.summary'].inputs.map((i) => [i.source, i.range]), [['brief', 'section "Budget"']])
})

test('a read of something that is not there tells the AI, and records nothing', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [{ id: 'r1', name: 'read_source_document', input: { id: 'ghost' } }, { id: 'r2', name: 'read_source_document', input: { id: 'brief', range: 'section: Nope' } }] })
    return anthropicReply({ text: 'OK.' })
  })
  const { session } = sessionWith(ai, { sources: bigPack(), window: 4000 })
  await session.start()
  const results = toolResults(ai.calls[1])
  assert.deepEqual(results.map((r) => Boolean(r.is_error)), [true, true])
  assert.match(results[0].content, /no Source document "ghost"/)
  assert.match(results[1].content, /No section called "Nope"/)
  assert.equal(session.snapshot().thread.filter((t) => t.read).length, 0)
})

test('a small pack is sent whole and the AI is not offered the reader', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Nothing to draft.' }))
  const { session } = sessionWith(ai, { sources: [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: 'The insurer wants faster claims.' }] })
  await session.start()
  assert.deepEqual(ai.calls[0].body.tools.map((t) => t.name), ['ask_architect', 'draft_field', 'log_decision'])
  assert.match(ai.calls[0].body.system, /The insurer wants faster claims\./)
  assert.doesNotMatch(ai.calls[0].body.system, /The Source documents are a catalogue/)
})

test('a cited document with no read is still an input', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Faster claims [Client brief, p. 1](source:brief).' } }] }) : anthropicReply({ text: 'Done.' })))
  const { session } = sessionWith(ai, { sources: [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: 'The insurer wants faster claims.' }] })
  await session.start()
  assert.deepEqual(session.snapshot().drafts['details.summary'].inputs.map((i) => [i.source, i.range]), [['brief', null]])
})

test('a model that does not use tools reads a catalogued document in a fenced block', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small', contextWindow: 4000 })
  tested(p.id, { questionCards: 'text' })
  const read = '```gantry-read\n{"id":"brief","range":"section: Scope"}\n```'
  const draft = '```gantry-draft\n' + JSON.stringify({ field: 'details.summary', value: 'Claims are slow [Client brief, p. 1](source:brief).' }) + '\n```'
  const ai = fakeAi((request, n) => openAiReply(n === 0 ? `Let me read.\n\n${read}` : n === 1 ? draft : 'Done.'))
  const { session } = sessionWith(ai, { provider: p, sources: bigPack() })
  await session.start()

  assert.match(ai.calls[0].body.messages[0].content, /gantry-read/, 'the model is told how to ask')
  const reply = ai.calls[1].body.messages.at(-1)
  assert.equal(reply.role, 'user')
  assert.match(reply.content, /Gantry's reply to your read requests/)
  assert.match(reply.content, /Claims are slow\./)
  const snap = session.snapshot()
  assert.deepEqual(snap.drafts['details.summary'].inputs.map((i) => [i.source, i.range]), [['brief', 'section "Scope"']])
  assert.ok(snap.thread.every((t) => !String(t.text).includes('gantry-read')), 'the read request is not shown as chat')
})

// ---------- pictures ----------

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const pic = { id: 'whiteboard', title: 'Whiteboard', filename: 'whiteboard.png', size: PNG.length }

test('a picture goes to a model that reads images, as an image on the first message, and is not re-sent in the history', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [{ id: 'd1', input: { field: 'details.summary', value: 'The whiteboard shows a flow.' } }] }) : anthropicReply({ text: 'Done.' })))
  const loads = []
  const { session } = sessionWith(ai, {
    provider: anthropic({ readsImages: true }),
    sources: [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 10, text: 'Faster claims.' }, pic],
    readOriginal: async (id) => {
      loads.push(id)
      return PNG
    },
  })
  await session.start()
  const first = ai.calls[0].body.messages[0]
  assert.deepEqual(first.content.map((b) => b.type), ['image', 'text'])
  assert.equal(first.content[0].source.media_type, 'image/png')
  assert.equal(first.content[0].source.data, Buffer.from(PNG).toString('base64'))
  assert.match(first.content[1].text, /image 1 is Source document `whiteboard` \("Whiteboard"\)/)
  assert.match(ai.calls[0].body.system, /whiteboard\.png\): attached to the first message as a picture/)
  // It rides on the first message of the follow-up request too (the history holds no bytes, so a switch can re-decide), loaded once.
  assert.deepEqual(ai.calls[1].body.messages[0].content.map((b) => b.type), ['image', 'text'])
  assert.deepEqual(loads, ['whiteboard'])
  assert.ok(session.snapshot().thread.some((t) => /Sent to the AI as the original: Whiteboard \(picture\)/.test(t.text)))
})

test('a picture is left out for a model that can\'t read images, and listed as unreadable', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'OK.' }))
  const { session } = sessionWith(ai, { provider: anthropic({ readsImages: false }), sources: [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 10, text: 'Faster claims.' }, pic], readOriginal: async () => PNG })
  await session.start()
  const first = ai.calls[0].body.messages[0]
  // #328: the only message is also the last, so it carries the moving cache point as one text block.
  assert.deepEqual(first.content.map((b) => b.type), ['text'], 'no image block')
  assert.match(ai.calls[0].body.system, /whiteboard\.png\): UNREADABLE \(it is a picture and this model can't read images\)/)
  assert.ok(session.snapshot().thread.some((t) => t.unreadable === 'whiteboard' && /Can't be read \(claude-x\): Whiteboard/.test(t.text)))
})

test('switching to a model that reads images sends the picture from then on', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'OK.' }))
  const blind = anthropic({ readsImages: false })
  const { session } = sessionWith(ai, { provider: blind, sources: [pic], readOriginal: async () => PNG })
  await session.start()
  assert.deepEqual(ai.calls[0].body.messages[0].content.map((b) => b.type), ['text'])
  const sighted = providers.addAiProvider({ name: 'Sighted', type: 'anthropic', address: 'https://api.anthropic.com', key: 'k2', model: 'claude-y' })
  tested(sighted.id, { readsImages: true })
  assert.deepEqual(await session.setProvider(sighted.id), { ok: true })
  await session.send('Look again.')
  assert.deepEqual(ai.calls.at(-1).body.messages[0].content.map((b) => b.type), ['image', 'text'])
})

// ---------- scanned PDFs ----------

const scan = { id: 'scan', title: 'Scanned spec', filename: 'scan.pdf', size: 8 }
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])

test('a scanned PDF is sent as a PDF to a provider that takes them', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'OK.' }))
  const { session } = sessionWith(ai, { sources: [scan], readOriginal: async () => PDF })
  await session.start()
  const first = ai.calls[0].body.messages[0]
  assert.deepEqual(first.content.map((b) => b.type), ['document', 'text'])
  assert.equal(first.content[0].source.media_type, 'application/pdf')
  assert.equal(first.content[0].source.data, Buffer.from(PDF).toString('base64'))
  assert.match(first.content[1].text, /PDF 1 is Source document `scan`/)
  assert.match(ai.calls[0].body.system, /scan\.pdf\): attached to the first message as the PDF itself/)
})

test('a scanned PDF is listed as unreadable to a provider that does not take PDFs', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'llama' })
  tested(p.id)
  const ai = fakeAi(() => openAiReply('OK.'))
  const { session } = sessionWith(ai, { provider: p, sources: [scan], readOriginal: async () => PDF })
  await session.start()
  const body = ai.calls[0].body
  assert.equal(typeof body.messages[1].content, 'string', 'nothing attached')
  assert.match(body.messages[0].content, /scan\.pdf\): UNREADABLE \(it is a scanned PDF with no text layer and this AI Provider doesn't take PDFs\)/)
  assert.ok(session.snapshot().thread.some((t) => t.unreadable === 'scan'))
})

test('a PDF marked Read visually is sent as the PDF and its text is left out of the brief', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'OK.' }))
  const text = '## Page 1\n\nDiagram labels jumbled Step Step Outcome'
  const { session } = sessionWith(ai, { sources: [{ id: 'flow', title: 'Flow', filename: 'flow.pdf', size: 8, text, readVisually: true }], readOriginal: async () => PDF })
  await session.start()
  assert.deepEqual(ai.calls[0].body.messages[0].content.map((b) => b.type), ['document', 'text'])
  assert.doesNotMatch(ai.calls[0].body.system, /Diagram labels jumbled/)
})

test('a PDF marked Read visually falls back to its text where the provider cannot take PDFs', async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'qwen' })
  tested(p.id)
  const ai = fakeAi(() => openAiReply('OK.'))
  const text = '## Page 1\n\nDiagram labels jumbled Step Step Outcome'
  const { session } = sessionWith(ai, { provider: p, sources: [{ id: 'flow', title: 'Flow', filename: 'flow.pdf', size: 8, text, readVisually: true }], readOriginal: async () => PDF })
  await session.start()
  assert.match(ai.calls[0].body.messages[0].content, /Diagram labels jumbled/)
  assert.ok(session.snapshot().thread.some((t) => /Flow is marked Read visually, but this AI Provider doesn't take PDFs/.test(t.text)))
})

test('an original that cannot be loaded becomes unreadable rather than failing the interview', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'OK.' }))
  const { session } = sessionWith(ai, { sources: [scan], readOriginal: async () => null })
  await session.start()
  assert.equal(session.snapshot().phase, 'waiting')
  assert.match(ai.calls[0].body.system, /scan\.pdf\): UNREADABLE \(its file could not be read from the Instance\)/)
})
