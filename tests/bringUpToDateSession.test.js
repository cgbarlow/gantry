import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #298 (parent #238, decided in #249): an AI interview session that opens with Bring up to date. A fake `fetch` plays the AI Provider with
// scripted streams, as in tests/interviewResumeSession.test.js. The cards come before the AI is called; each answer is a `source-update`
// entry; a re-cite is Gantry's; a redraft meets the keep / use / merge card; an agreed Module goes back to draft with a note.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { applyDecisionsDelta, emptyDecisionsLog } = await import('../web/lib/decisionsLog.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { findOutOfDateFields } = await import('../web/lib/outOfDate.js')
const { planUpdateRound } = await import('../web/lib/bringUpToDate.js')
const { CHANGE_OPTIONS } = await import('../web/lib/interviewRounds.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const definition = () => ({
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
        { id: 'notes', title: 'Notes', type: 'markdown' },
      ],
    },
  ],
})
const NOW = '2026-11-03T10:00:00.000Z'
const savedContent = (status = 'draft') => [
  {
    id: 'details',
    status,
    fields: [
      { id: 'summary', value: 'Faster claims [Client brief, p. 1](source:brief).' },
      { id: 'notes', value: 'Nothing else [Minutes](source:minutes).' },
    ],
  },
]
// Client brief v3 replaced the brief; the Minutes were removed.
const manifest = (over = {}) => [
  { id: 'brief', title: 'Client brief', filename: 'brief.md', uploadedAt: '2026-11-01T09:00:00.000Z', text: '# Client brief\n\nv1' },
  { id: 'brief-v3', title: 'Client brief v3', filename: 'brief-v3.md', uploadedAt: '2026-11-02T09:00:00.000Z', replaces: 'brief', text: '# Client brief v3\n\nv3' },
  { id: 'minutes', title: 'Minutes', filename: 'minutes.md', uploadedAt: '2026-11-01T09:00:00.000Z', removedAt: '2026-11-02T11:00:00.000Z', ...over },
]

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
    calls.push({ url: envelope.url, body: envelope.body ? JSON.parse(envelope.body) : null, raw: envelope.body })
    return handler(calls.at(-1), calls.length - 1)
  }
  return { fetchImpl, calls }
}
const anthropic = () => {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x' })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  return p
}
const firstUser = (request) => {
  const first = request.body.messages[0]
  return typeof first.content === 'string' ? first.content : first.content.map((b) => b.text ?? '').join('\n')
}

let counter = 0
/** A session on Shape with `details.summary` flagged (the Client brief was replaced) and `details.notes` flagged (the Minutes were removed). */
function sessionWith(ai, over = {}) {
  const provider = anthropic()
  const sources = over.sources ?? manifest()
  const saved = over.saved ?? savedContent()
  const logs = over.logs ?? { shape: emptyDecisionsLog('shape') }
  const def = definition()
  const flags = findOutOfDateFields({ sources, logs, modules: saved })
  const plan = planUpdateRound({ flags, definition: def, pageStageId: 'shape', saved, ...over.plan })
  const context = {
    definition: def,
    stageId: 'shape',
    artefactId: 'light',
    size: 'medium',
    saved,
    sources,
    skills,
    actor: 'Alex',
    newSince: over.newSince,
    update: over.update === null ? undefined : { mode: 'only', items: plan.items, deferred: plan.deferred, elsewhere: plan.elsewhere, logs, stageTitle: () => 'Shape', pageStageTitle: 'Shape', ...over.update },
    ...over.context,
  }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => `s-up${++counter}`, now: () => NOW })
  return { session, context, flags, sources, saved, def }
}
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })

test('the round is asked before the AI is called, with a card for exactly the flagged Fields', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session, flags } = sessionWith(ai)
  assert.deepEqual(flags.map((f) => f.field).sort(), ['details.notes', 'details.summary'])
  await session.start()
  const snap = session.snapshot()
  assert.equal(ai.calls.length, 0, 'the AI is not called to ask them')
  assert.equal(snap.phase, 'asking')
  assert.equal(snap.round.update, true)
  assert.deepEqual(snap.round.cards.map((c) => c.id), ['update:details.notes', 'update:details.summary'])
  const summary = snap.round.cards.find((c) => c.field === 'details.summary')
  assert.deepEqual(summary.options.map((o) => o.label), ['Keep', 'Redraft'])
  const notes = snap.round.cards.find((c) => c.field === 'details.notes')
  assert.deepEqual(notes.options.map((o) => o.label), ['Keep', 'Re-cite to Client brief v3', 'Redraft without it'], 'the replaced brief is not offered as a stand-in')
  assert.equal(snap.update.mode, 'only')
  assert.equal(snap.update.total, 2)
})

test('keep answers clear nothing until the Save, then clear exactly those Fields; the AI is never called', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session, sources, saved } = sessionWith(ai)
  await session.start()
  session.choose('update:details.summary', 'Keep')
  session.choose('update:details.notes', 'Keep')
  assert.equal((await session.submitRound()).ok, true)
  assert.equal(ai.calls.length, 0, 'nothing for the AI to write')
  const snap = session.snapshot()
  assert.equal(snap.phase, 'waiting')
  assert.equal(snap.update.answered, true)

  const delta = session.decisionsDelta({ runState: 'done', saving: false })
  const updates = delta.entries.filter((e) => e.kind === 'source-update')
  assert.deepEqual(updates.map((e) => [e.fields[0], e.source, e.outcome, e.change]).sort(), [['details.notes', 'minutes', 'keep', 'removed'], ['details.summary', 'brief', 'keep', 'replaced']])
  assert.equal(delta.status.lastAiSave, null, 'a Save that wrote nothing is not an AI save')
  assert.deepEqual(Object.keys(delta.fields), [])

  // Applied to the log, the flags are gone: answering the cards is what cleared them.
  const before = findOutOfDateFields({ sources, logs: { shape: emptyDecisionsLog('shape') }, modules: saved })
  assert.equal(before.length, 2)
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), delta, 'shape')
  assert.deepEqual(findOutOfDateFields({ sources, logs: { shape: log }, modules: saved }), [])
})

test('an unanswered card cannot be submitted, and a Field left flagged stays flagged', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session, sources, saved } = sessionWith(ai)
  await session.start()
  // Both cards come with a recommendation pre-selected, so clear one to leave it unanswered.
  const snap = session.snapshot()
  assert.ok(snap.round.cards.every((c) => c.selected.length === 1))
  session.choose('update:details.summary', 'Keep')
  await session.submitRound()
  const delta = session.decisionsDelta({ runState: 'done' })
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), delta, 'shape')
  const left = findOutOfDateFields({ sources, logs: { shape: log }, modules: saved }).map((f) => f.field)
  assert.deepEqual(left, [], 'both cards were answered (the second by its recommendation)')
})

test('redraft sends the AI only the Field to redraft; its draft meets the keep / use / merge card; the answer is logged', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Redrafting.', tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Faster claims, now 11 days [Client brief v3](source:brief-v3).' } }] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  session.choose('update:details.summary', 'Redraft')
  session.choose('update:details.notes', 'Keep')
  await session.submitRound()

  const request = ai.calls[0]
  assert.equal(request.body.messages.length, 1, 'the answers are the AI’s opening')
  const text = firstUser(request)
  assert.match(text, /Bring the Out of date Fields up to date/)
  assert.match(text, /details\.summary \(Details · Summary\): REDRAFT\./)
  assert.match(text, /details\.notes \(Details · Notes\): KEPT as it is/)
  assert.doesNotMatch(text, /Begin the interview/, 'a session that only brings Fields up to date does not start the interview')

  // The AI redrafted a Field that holds saved content, so the architect is asked: keep, use the AI's version, or merge.
  const snap = session.snapshot()
  assert.equal(snap.phase, 'asking')
  const change = snap.round.cards.find((c) => c.type === 'change')
  assert.equal(change.field, 'details.summary')
  assert.deepEqual(change.options.map((o) => o.label), [CHANGE_OPTIONS.keep, CHANGE_OPTIONS.use, CHANGE_OPTIONS.merge])
  assert.deepEqual(Object.keys(snap.drafts), [], 'nothing is in the preview until they choose')

  session.choose(change.id, CHANGE_OPTIONS.use)
  await session.submitRound()
  assert.match(session.snapshot().drafts['details.summary'].value, /11 days/)
  const delta = session.decisionsDelta({ runState: 'done', saving: true })
  assert.ok(delta.entries.some((e) => e.kind === 'source-update' && e.fields[0] === 'details.summary' && e.outcome === 'redraft'))
  assert.ok(delta.entries.some((e) => e.kind === 'saved-content' && e.choice === 'replace'))
  assert.ok(delta.fields['details.summary'], 'the redrafted Field’s record is rewritten, which also clears the flag')
})

test('keeping what is saved at the redraft card still leaves the answer logged', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Redrafting.', tools: [{ id: 'd1', input: { field: 'details.summary', value: 'Something else entirely.' } }] }) : anthropicReply({ text: 'Done.' })))
  const { session, sources, saved } = sessionWith(ai)
  await session.start()
  session.choose('update:details.notes', 'Keep')
  session.choose('update:details.summary', 'Redraft')
  await session.submitRound()
  const change = session.snapshot().round.cards.find((c) => c.type === 'change')
  session.choose(change.id, CHANGE_OPTIONS.keep)
  await session.submitRound()
  assert.deepEqual(Object.keys(session.snapshot().drafts), [])
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), session.decisionsDelta({ runState: 'done' }), 'shape')
  assert.deepEqual(findOutOfDateFields({ sources, logs: { shape: log }, modules: saved }), [])
})

test('re-cite is done by Gantry: the citations move to the other document, the log says so, and the AI is not called', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai, { sources: [...manifest({ removedAt: undefined }).slice(0, 2), { id: 'minutes', title: 'Minutes', filename: 'minutes.md', uploadedAt: '2026-11-01T09:00:00.000Z', removedAt: '2026-11-02T11:00:00.000Z', text: '# Minutes' }, { id: 'workshop', title: 'Workshop notes', filename: 'w.md', uploadedAt: '2026-11-01T09:00:00.000Z', text: '# Workshop' }] })
  await session.start()
  const notes = session.snapshot().round.cards.find((c) => c.field === 'details.notes')
  assert.equal(notes.options.some((o) => o.label === 'Re-cite to Workshop notes'), true)
  session.choose('update:details.summary', 'Keep')
  session.choose('update:details.notes', 'Re-cite to Workshop notes')
  await session.submitRound()
  assert.equal(ai.calls.length, 0)
  const draft = session.snapshot().drafts['details.notes']
  assert.equal(draft.value, 'Nothing else [Workshop notes](source:workshop).')
  assert.ok(draft.inputs.some((i) => i.source === 'workshop'), 'the Field now draws on the new document')
  assert.ok(!draft.inputs.some((i) => i.source === 'minutes'))
  const entry = session.decisionsDelta({ runState: 'done', saving: true }).entries.find((e) => e.kind === 'source-update' && e.outcome === 're-cite')
  assert.equal(entry.source, 'minutes')
  assert.equal(entry.reciteTo, 'Workshop notes')
  assert.deepEqual(entry.fields, ['details.notes'])
})

test('redraft without a removed document tells the AI not to cite it', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'ok', tools: [{ id: 'd1', input: { field: 'details.notes', value: 'Nothing else.' } }] }) : anthropicReply({ text: 'Done.' })))
  const { session } = sessionWith(ai)
  await session.start()
  session.choose('update:details.summary', 'Keep')
  session.choose('update:details.notes', 'Redraft without it')
  await session.submitRound()
  assert.match(firstUser(ai.calls[0]), /details\.notes \(Details · Notes\): REDRAFT WITHOUT source:minutes/)
  const entry = session.decisionsDelta({ runState: 'done' }).entries.find((e) => e.outcome === 'redraft-without')
  assert.equal(entry.source, 'minutes')
})

test('a Field that cannot be changed here becomes an open question naming the blocker', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  // A remote workspace whose current Stage cannot edit the Module: the Field belongs to an approved Stage that cannot be re-opened.
  const def = definition()
  def.stages = [{ id: 'early', title: 'Early', gate: 'g0', modules: ['details'] }, { id: 'shape', title: 'Shape', purpose: 'Shape.', gate: 'shaped', modules: ['details'], readOnlyModules: ['details'] }]
  const sources = manifest()
  const saved = savedContent()
  const flags = findOutOfDateFields({ sources, logs: { early: { stage: 'early', fields: {}, entries: [] } }, modules: saved, stageModules: { early: ['details'], shape: ['details'] } })
  const plan = planUpdateRound({ flags, definition: def, pageStageId: 'shape', currentStageId: 'shape', remote: true, inProgress: ['shape'], saved })
  const provider = anthropic()
  const context = { definition: def, stageId: 'shape', artefactId: null, size: 'medium', saved, sources, skills, actor: 'Alex', update: { mode: 'only', items: plan.items, deferred: [], elsewhere: [], logs: {}, stageTitle: (id) => ({ early: 'Early', shape: 'Shape' })[id], pageStageTitle: 'Shape' } }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => 's-oq', now: () => NOW })
  await session.start()
  const card = session.snapshot().round.cards.find((c) => c.field === 'details.summary')
  assert.deepEqual(card.options.map((o) => o.label), ['Log an open question', 'Leave it flagged'])
  assert.equal(card.update.landing.kind, 'open-question')
  session.choose('update:details.notes', 'Leave it flagged')
  await session.submitRound()
  const delta = session.decisionsDelta({ runState: 'done' })
  const question = delta.entries.find((e) => e.kind === 'open-question')
  assert.deepEqual(question.fields, ['details.summary'])
  assert.match(question.why, /Shape is already in progress|already in progress/)
  assert.ok(delta.entries.some((e) => e.kind === 'source-update' && e.outcome === 'open-question' && e.fields[0] === 'details.summary'))
  assert.ok(!delta.entries.some((e) => e.kind === 'source-update' && e.fields[0] === 'details.notes'), 'a Field left flagged writes nothing, so it stays flagged')
})

test('a re-open choice is held for the architect to act on, and writes nothing', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const def = definition()
  def.stages = [{ id: 'early', title: 'Early', gate: 'g0', modules: ['details'] }, { id: 'shape', title: 'Shape', purpose: 'Shape.', gate: 'shaped', modules: ['details'], readOnlyModules: ['details'] }]
  const sources = manifest()
  const saved = savedContent()
  const flags = findOutOfDateFields({ sources, logs: { early: { stage: 'early', fields: {}, entries: [] } }, modules: saved, stageModules: { early: ['details'], shape: ['details'] } })
  const plan = planUpdateRound({ flags, definition: def, pageStageId: 'shape', currentStageId: 'shape', remote: true, saved })
  const provider = anthropic()
  const context = { definition: def, stageId: 'shape', size: 'medium', saved, sources, skills, actor: 'Alex', update: { mode: 'only', items: plan.items, deferred: [], elsewhere: [], logs: {}, stageTitle: (id) => ({ early: 'Early', shape: 'Shape' })[id], pageStageTitle: 'Shape' } }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => 's-ro', now: () => NOW })
  await session.start()
  const cards = session.snapshot().round.cards
  assert.ok(cards.every((c) => c.recommended[0] === 'Re-open Early'))
  await session.submitRound()
  assert.deepEqual(session.snapshot().update.reopen, ['early'])
  assert.equal(session.decisionsDelta({ runState: 'done' }).entries.filter((e) => e.kind === 'source-update').length, 0)
})

test('an accepted change to an agreed Module sets it back to draft, with a note that says why', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai, { saved: savedContent('agreed'), sources: [...manifest({ removedAt: undefined }).slice(0, 2), { id: 'minutes', title: 'Minutes', filename: 'minutes.md', uploadedAt: '2026-11-01T09:00:00.000Z', removedAt: '2026-11-02T11:00:00.000Z', text: '# Minutes' }, { id: 'workshop', title: 'Workshop notes', filename: 'w.md', uploadedAt: '2026-11-01T09:00:00.000Z', text: '# Workshop' }] })
  await session.start()
  session.choose('update:details.summary', 'Keep')
  session.choose('update:details.notes', 'Re-cite to Workshop notes')
  await session.submitRound()
  const entries = session.decisionsDelta({ runState: 'done', saving: true }).entries
  const returned = entries.filter((e) => e.kind === 'returned-to-draft')
  assert.equal(returned.length, 1)
  assert.equal(returned[0].module, 'details')
  assert.deepEqual(returned[0].fields, ['details.notes'])
  assert.match(returned[0].note, /^Details was agreed and is back to draft\./)
  assert.match(returned[0].note, /because Minutes was removed/)
  assert.match(returned[0].note, /Only a person marks a Module agreed/)
  // Asking for the delta again does not add a second note.
  assert.equal(session.decisionsDelta({ runState: 'done', saving: true }).entries.filter((e) => e.kind === 'returned-to-draft').length, 1)
})

test('a Module that was already draft gets no such note', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  session.choose('update:details.summary', 'Keep')
  session.choose('update:details.notes', 'Keep')
  await session.submitRound()
  assert.equal(session.decisionsDelta({ runState: 'done' }).entries.filter((e) => e.kind === 'returned-to-draft').length, 0)
})

test('a normal session starts with the round, then gives the AI its usual opening with the answers', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Reading the documents.' }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai, { update: { mode: 'first' } })
  await session.start()
  assert.equal(ai.calls.length, 0)
  assert.equal(session.snapshot().update.mode, 'first')
  session.choose('update:details.summary', 'Keep')
  session.choose('update:details.notes', 'Keep')
  await session.submitRound()
  assert.equal(ai.calls.length, 1)
  const text = firstUser(ai.calls[0])
  assert.match(text, /Begin the interview/)
  assert.match(text, /KEPT as it is/)
})

test('#331 the opening message waits for the round: it goes with the AI\'s first request, after the answers, whether the session only brings Fields up to date or carries on', async () => {
  const words = 'The hosting decision matters most; redraft with that in mind.'
  const userTexts = (request) => request.body.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n')))
  for (const mode of ['only', 'first']) {
    const ai = fakeAi(() => anthropicReply({ text: 'Redrafting.' }))
    const { session } = sessionWith(ai, { update: { mode } })
    await session.start({ opening: words })
    assert.equal(ai.calls.length, 0, `${mode}: the round still comes before the AI`)
    assert.deepEqual(session.snapshot().thread.filter((t) => t.who === 'you').map((t) => t.text), [words], `${mode}: the thread shows it as the architect's`)
    // Chat is refused while the round is open (that is unchanged), and the working copy keeps the opening message waiting.
    const copy = JSON.parse(JSON.stringify(session.exportState()))
    const resumed = sessionWith(ai, { update: { mode } }).session
    assert.equal(resumed.importState(copy), true)
    resumed.choose('update:details.summary', 'Redraft')
    resumed.choose('update:details.notes', 'Keep')
    await resumed.submitRound()
    const texts = userTexts(ai.calls[0])
    assert.equal(texts.length, 2, `${mode}: Gantry's opening with the answers, then the architect's words`)
    assert.match(texts[0], /REDRAFT/)
    assert.equal(texts[1], words)
  }
})

test('a normal session with nothing flagged starts as it always did, and says which documents are New since the last interview', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Reading.' }))
  const { session } = sessionWith(ai, { update: null, sources: manifest({ removedAt: undefined }).slice(0, 1), newSince: [{ id: 'workshop', title: 'Workshop notes' }] })
  await session.start()
  assert.equal(ai.calls.length, 1)
  const text = firstUser(ai.calls[0])
  assert.match(text, /Begin the interview/)
  assert.match(text, /New since the last interview: "Workshop notes"/)
  assert.match(text, /only where a document adds to or contradicts something already saved/)
})

test('without New documents the opening says nothing about them', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'Reading.' }))
  const { session } = sessionWith(ai, { update: null, sources: manifest({ removedAt: undefined }).slice(0, 1) })
  await session.start()
  assert.doesNotMatch(firstUser(ai.calls[0]), /New since the last interview/)
})

test('chat is refused while the cards are open, and the open round survives a working copy', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const one = sessionWith(ai)
  await one.session.start()
  await one.session.send('Hello')
  assert.equal(ai.calls.length, 0)
  assert.ok(one.session.snapshot().round.update, 'the round is still open')
  assert.ok(one.session.snapshot().thread.some((t) => /Answer the Bring up to date cards first/.test(t.text)))

  const copy = JSON.parse(JSON.stringify(one.session.exportState()))
  const two = sessionWith(ai)
  assert.equal(two.session.importState(copy), true)
  assert.equal(two.session.snapshot().round.update, true)
  assert.equal(two.session.snapshot().update.total, 2)
})

test('the AI’s brief lists the answers in the decisions log', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Redrafting.', tools: [ask('q1', [])].slice(0, 0) }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai)
  await session.start()
  session.choose('update:details.summary', 'Redraft')
  session.choose('update:details.notes', 'Keep')
  await session.submitRound()
  const system = typeof ai.calls[0].body.system === 'string' ? ai.calls[0].body.system : ai.calls[0].body.system.map((b) => b.text).join('\n')
  assert.match(system, /source-update: keep \(Minutes removed\)/)
})
