import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #289 (parent #238): the architect hand-edits an AI draft in the Interview page's preview. Built on the session harness of tests/interviewLog.test.js.
// (#288 was: the decisions log an AI interview session collects.) A fake `fetch` plays the AI Provider with scripted
// streams, as in tests/interviewSession.test.js; the AI Providers list is the real one, kept in a fake localStorage.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { applyDecisionsDelta, emptyDecisionsLog, parseDecisionsLog, serializeDecisionsLog } = await import('../web/lib/decisionsLog.js')
const { fieldDone } = await import('../web/lib/interviewReadiness.js')
const { changeCard, answersText } = await import('../web/lib/interviewRounds.js')
const { createAnthropicParser, createOpenAiParser } = await import('../web/lib/aiAdapters.js')
const { describeEntry } = await import('../web/lib/decisionsLogPanel.js')
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
    const request = { url: envelope.url, headers: envelope.headers, body: envelope.body ? JSON.parse(envelope.body) : null, raw: envelope.body }
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
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills, actor: 'Alex', instructionsVersion: 'small@2', ...over.context }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => 's-test', now: () => '2026-11-02T10:00:00.000Z' })
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

const logCall = (id, input) => ({ id, name: 'log_decision', input })
const quiet = () => anthropicReply({ text: 'Okay.' })


const MINE = 'Mine: the budget is 2 million and 14 staff will work on it, which is far more than the short word target of this Field allows for.'
const systemText = (request) => JSON.stringify(request.body.system)
const drafted = async (over = {}) => {
  // The first call drafts the Field (`over.first` says otherwise); `over.script` plays the later calls.
  const first = over.first ?? (() => anthropicReply({ tools: [draftCall('d1', 'details.notes', 'The AI wrote this first.')] }))
  const ai = fakeAi((request, n) => (n === 0 ? first() : over.script ? over.script(request, n) : quiet()))
  const made = sessionWith(ai, over.session)
  await made.session.start()
  return { ai, ...made }
}

// ---------- the edit sticks and is the architect's ----------

test("a hand edit of a drafted Field sticks, is marked as the architect's, and no per-Field check runs on it", async () => {
  const { session } = await drafted()
  assert.equal(session.beginHandEdit('details.notes').ok, true)
  assert.deepEqual(session.snapshot().editingFields, ['details.notes'])
  const result = session.handEdit('details.notes', MINE)
  assert.deepEqual(result, { ok: true, changed: true })
  const draft = session.snapshot().drafts['details.notes']
  assert.equal(draft.value, MINE)
  assert.equal(draft.handEdited, true)
  assert.deepEqual(draft.warnings, [], 'the 2 million is an unsourced figure and the text is long, and neither is checked')
  assert.deepEqual(session.snapshot().editingFields, [])
})

test('a hand edit appends a hand-edit entry with the typed text, and a later edit of the same Field replaces it', async () => {
  const { session } = await drafted()
  session.handEdit('details.notes', MINE)
  session.handEdit('details.notes', 'Second thoughts.')
  const history = session.snapshot().decisions.history.filter((e) => e.kind === 'hand-edit')
  assert.equal(history.length, 2)
  assert.deepEqual({ field: history[0].field, words: history[0].words, fields: history[0].fields, session: history[0].session, who: history[0].who }, { field: 'details.notes', words: MINE, fields: ['details.notes'], session: 's-test', who: 'Alex' })
  assert.deepEqual(history[1].replaces, [history[0].id])
  assert.deepEqual(session.snapshot().decisions.latest.filter((e) => e.kind === 'hand-edit').map((e) => e.words), ['Second thoughts.'])
  // It goes to the Save as an ordinary append-only entry.
  const delta = session.decisionsDelta()
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), delta, 'shape')
  assert.equal(parseDecisionsLog(serializeDecisionsLog(log), 'shape').entries.filter((e) => e.kind === 'hand-edit').length, 2)
})

test('an edit that changes nothing is not logged, and a blank one is refused', async () => {
  const { session } = await drafted()
  assert.deepEqual(session.handEdit('details.notes', 'The AI wrote this first.'), { ok: true, changed: false })
  assert.equal(session.snapshot().drafts['details.notes'].handEdited, undefined)
  const blank = session.handEdit('details.notes', '   ')
  assert.equal(blank.ok, false)
  assert.match(blank.message, /can’t be left empty/)
  assert.equal(session.snapshot().decisions.history.filter((e) => e.kind === 'hand-edit').length, 0)
})

test('only a Field with a draft can be edited in the preview', async () => {
  const { session } = await drafted()
  const result = session.beginHandEdit('details.owner')
  assert.equal(result.ok, false)
  assert.match(result.message, /Only a Field with a draft/)
  assert.equal(session.handEdit('details.owner', 'Pat').ok, false)
})

test('a select Field and a hand edit: the value is the option picked', async () => {
  const { session } = await drafted({ first: () => anthropicReply({ tools: [draftCall('d1', 'details.risk', 'Low')] }) })
  session.handEdit('details.risk', 'High')
  assert.equal(session.snapshot().drafts['details.risk'].value, 'High')
})

test('a hand-edited Field is done when it has content, whatever its length', () => {
  const field = { id: 'summary', type: 'markdown', targetWords: { small: 50, medium: 80, large: 120 } }
  assert.equal(fieldDone({ field, value: 'Too short.', size: 'medium' }).done, false)
  assert.equal(fieldDone({ field, value: 'Too short.', size: 'medium', handEdited: true }).done, true)
  assert.equal(fieldDone({ field, value: '', size: 'medium', handEdited: true }).done, false)
})

// ---------- the AI changes it only through a card ----------

test("the AI's next turn proposes a change to a hand-edited Field only through a card", async () => {
  const { session, ai } = await drafted({
    script: (request, n) => (n === 2 ? anthropicReply({ tools: [draftCall('d2', 'details.notes', 'The AI would rather say this.')] }) : quiet()),
  })
  session.handEdit('details.notes', MINE)
  await session.send('Anything else?')
  // The AI is told which Fields are the architect's, and what they say.
  assert.match(systemText(ai.calls[2]), /Fields the architect edited by hand/)
  assert.ok(systemText(ai.calls[2]).includes('Mine: the budget is 2 million'))
  assert.ok(!systemText(ai.calls[0]).includes('Fields the architect edited by hand'), 'and not before there is one')
  // Its draft did not land; the architect has a card with their text beside the AI's.
  const refused = toolResults(ai.calls[3])[0]
  assert.equal(refused.is_error, true)
  assert.match(refused.content, /own wording/)
  assert.match(refused.content, /log_decision/)
  const snap = session.snapshot()
  assert.equal(snap.drafts['details.notes'].value, MINE)
  assert.equal(snap.phase, 'asking')
  const c = snap.round.cards[0]
  assert.equal(c.type, 'change')
  assert.equal(c.header, 'Your edit')
  assert.equal(c.change.handEdit, true)
  assert.equal(c.change.saved, MINE)
  assert.equal(c.change.proposed, 'The AI would rather say this.')
  assert.deepEqual(c.recommended, ['Keep'])
})

test("keep leaves the architect's text, is logged as about their edit, and the AI is told not to propose again", async () => {
  const { session, ai } = await drafted({
    script: (request, n) => (n === 2 || n === 5 ? anthropicReply({ tools: [draftCall(`d${n}`, 'details.notes', `AI version ${n}.`)] }) : quiet()),
  })
  session.handEdit('details.notes', MINE)
  await session.send('Anything else?')
  session.choose('change:details.notes', 'Keep')
  await session.submitRound()
  assert.equal(session.snapshot().drafts['details.notes'].value, MINE)
  assert.match(lastUserText(ai.calls[4]), /stays as the architect wrote it/)
  const entry = session.snapshot().decisions.latest.find((e) => e.kind === 'saved-content')
  assert.deepEqual({ field: entry.field, choice: entry.choice, handEdit: entry.handEdit }, { field: 'details.notes', choice: 'keep', handEdit: true })
  assert.match(describeEntry(entry, {}), /Their own edit of details\.notes: kept their own edit/)
  await session.send('Carry on')
  const again = toolResults(ai.calls[6])[0]
  assert.equal(again.is_error, true)
  assert.match(again.content, /chose to keep it/)
  assert.equal(session.snapshot().round, null)
})

test("choosing the AI's version on a card puts its text in, logs it, and hands the Field back", async () => {
  const { session } = await drafted({
    script: (request, n) => (n === 2 ? anthropicReply({ tools: [draftCall('d2', 'details.notes', 'AI version.')] }) : n === 5 ? anthropicReply({ tools: [draftCall('d3', 'details.notes', 'AI revised.')] }) : quiet()),
  })
  session.handEdit('details.notes', MINE)
  await session.send('Anything else?')
  session.choose('change:details.notes', "Use the AI's version")
  await session.submitRound()
  const draft = session.snapshot().drafts['details.notes']
  assert.equal(draft.value, 'AI version.')
  assert.equal(draft.handEdited, undefined)
  const entry = session.snapshot().decisions.latest.find((e) => e.kind === 'saved-content')
  assert.deepEqual({ choice: entry.choice, handEdit: entry.handEdit }, { choice: 'replace', handEdit: true })
  // It is the AI's to revise again, with no card.
  await session.send('Revise it')
  assert.equal(session.snapshot().drafts['details.notes'].value, 'AI revised.')
  assert.equal(session.snapshot().round, null)
})

test('merge hands the Field back for one merged draft', async () => {
  const { session, ai } = await drafted({
    script: (request, n) => (n === 2 ? anthropicReply({ tools: [draftCall('d2', 'details.notes', 'AI version.')] }) : n === 4 ? anthropicReply({ tools: [draftCall('d3', 'details.notes', 'Merged text.')] }) : quiet()),
  })
  session.handEdit('details.notes', MINE)
  await session.send('Anything else?')
  session.choose('change:details.notes', 'Merge')
  await session.submitRound()
  assert.match(lastUserText(ai.calls[4]), /merged version/)
  assert.match(lastUserText(ai.calls[4]), /the architect's edit/)
  assert.equal(session.snapshot().drafts['details.notes'].value, 'Merged text.')
})

// ---------- handing back in free chat ----------

test("asking for the change in free chat puts the AI's text in, and it is logged as the architect's request", async () => {
  const { session, ai } = await drafted({
    script: (request, n) =>
      n === 2
        ? anthropicReply({ tools: [logCall('l1', { kind: 'fact', quote: 'make the notes shorter', fields: ['details.notes'] }), draftCall('d2', 'details.notes', 'Shorter.')] })
        : quiet(),
  })
  session.handEdit('details.notes', MINE)
  await session.send('Please make the notes shorter.')
  const results = toolResults(ai.calls[3])
  assert.equal(results.find((r) => r.tool_use_id === 'l1').is_error ?? false, false)
  assert.match(results.find((r) => r.tool_use_id === 'l1').content, /yours to change now/)
  assert.equal(results.find((r) => r.tool_use_id === 'd2').is_error ?? false, false)
  const snap = session.snapshot()
  assert.equal(snap.drafts['details.notes'].value, 'Shorter.')
  assert.equal(snap.drafts['details.notes'].handEdited, undefined)
  assert.equal(snap.round, null, 'no card: they asked')
  const fact = snap.decisions.latest.find((e) => e.kind === 'fact')
  assert.equal(fact.words, 'Please make the notes shorter.')
})

test('a draft that comes before the request is logged is held, and logging the request clears the card', async () => {
  const { session } = await drafted({
    script: (request, n) =>
      n === 2
        ? anthropicReply({ tools: [draftCall('d2', 'details.notes', 'Shorter.'), logCall('l1', { kind: 'fact', quote: 'make the notes shorter', fields: ['details.notes'] })] })
        : quiet(),
  })
  session.handEdit('details.notes', MINE)
  await session.send('Please make the notes shorter.')
  const snap = session.snapshot()
  assert.equal(snap.drafts['details.notes'].value, MINE, 'the refused draft did not land')
  assert.equal(snap.round, null, 'and the request means no card is needed')
})

test('a message typed before the hand edit does not hand the Field back', async () => {
  const { session } = await drafted({
    script: (request, n) =>
      n === 3
        ? anthropicReply({ tools: [logCall('l1', { kind: 'fact', quote: 'keep the notes short', fields: ['details.notes'] }), draftCall('d2', 'details.notes', 'AI version.')] })
        : quiet(),
  })
  await session.send('Please keep the notes short.')
  session.handEdit('details.notes', MINE)
  await session.send('Also the owner is Pat.')
  const snap = session.snapshot()
  assert.equal(snap.drafts['details.notes'].value, MINE)
  assert.equal(snap.round.cards[0].type, 'change', 'it still meets a card')
})

// ---------- inputs ----------

test('the log record is rebuilt from the edited text: the Source documents it still cites, plus the hand edit', async () => {
  const twoSources = [...sources, { id: 'memo', title: 'Memo', filename: 'memo.md', size: 30, text: '# Memo\n\nA second document.' }]
  const saved = [...savedNothing(), { id: 'earlier', status: 'agreed', fields: [{ id: 'goal', value: 'Faster claims' }] }]
  const cited = 'Claims must be faster [Client brief, p. 1](source:brief) and cheaper [Memo, p. 2](source:memo).'
  const { session } = await drafted({
    first: () => anthropicReply({ tools: [draftCall('d1', 'details.notes', cited, { inputs: [{ source: 'brief', range: 'pages 1-2' }, { field: 'earlier.goal' }] })] }),
    session: { context: { sources: twoSources, saved } },
  })
  const before = session.decisionsDelta().fields['details.notes']
  assert.deepEqual(before.inputs.map((i) => i.source ?? i.field).sort(), ['brief', 'brief', 'earlier.goal', 'memo'])

  session.handEdit('details.notes', 'Claims must be faster [Client brief, p. 1](source:brief), whatever the Memo said.')
  const delta = session.decisionsDelta()
  const record = delta.fields['details.notes']
  assert.deepEqual([...new Set(record.inputs.map((i) => i.source))], ['brief'], 'the Memo citation and the earlier Field are no longer inputs')
  assert.ok(record.inputs.some((i) => i.range === 'pages 1-2'), 'the cited document keeps the range it was read at')
  assert.match(record.inputs[0].fingerprint, /^[0-9a-f]{14}$/)
  const edit = delta.entries.find((e) => e.kind === 'hand-edit')
  assert.deepEqual(record.entries, [edit.id], 'and the entries are the hand edit')
  assert.deepEqual([...new Set(session.snapshot().fieldInputs['details.notes'].map((i) => i.source))], ['brief'])
})

test('a text with no citation has no Source document inputs', async () => {
  const { session } = await drafted({ first: () => anthropicReply({ tools: [draftCall('d1', 'details.notes', 'From the brief [Client brief](source:brief).')] }) })
  assert.equal(session.decisionsDelta().fields['details.notes'].inputs.length, 1)
  session.handEdit('details.notes', 'Plain words, no citation.')
  assert.deepEqual(session.decisionsDelta().fields['details.notes'].inputs, [])
})

// ---------- a Field the AI is drafting ----------

test("a Field the AI is drafting is shown as drafting and can't be edited until its draft lands", async () => {
  const ai = fakeAi((request, n) => (n === 2 ? anthropicReply({ tools: [draftCall('d2', 'details.notes', 'Redrafted.')] }) : n === 0 ? anthropicReply({ tools: [draftCall('d1', 'details.notes', 'First.')] }) : quiet()))
  const provider = anthropic()
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills }
  const seen = []
  let attempt = null
  let firstAttempt = null
  let session
  session = createInterviewSession({
    providerId: provider.id,
    getContext: () => context,
    fetchImpl: ai.fetchImpl,
    onChange: (s) => {
      seen.push(s.draftingFields)
      if (s.draftingFields.includes('details.notes')) {
        if (!s.drafts['details.notes']) firstAttempt ??= session.beginHandEdit('details.notes')
        else attempt ??= session.beginHandEdit('details.notes')
      }
    },
  })
  await session.start()
  assert.equal(firstAttempt.ok, false, 'a first draft has nothing to edit yet')
  assert.equal(attempt, null)
  await session.send('Redo it')
  assert.ok(seen.some((f) => f.includes('details.notes')), 'the preview was told which Field was being drafted')
  assert.equal(attempt.ok, false)
  assert.match(attempt.message, /AI is drafting this Field/)
  assert.deepEqual(session.snapshot().draftingFields, [], 'and nothing is left drafting once the turn ends')
  assert.equal(session.snapshot().drafts['details.notes'].value, 'Redrafted.')
  assert.equal(session.beginHandEdit('details.notes').ok, true, 'editable once the draft landed')
})

test("a text-only model's draft block names the Field it is drafting while it is written", async () => {
  const p = providers.addAiProvider({ name: 'Local', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'small' })
  tested(p.id, { questionCards: 'text' })
  const ai = fakeAi((request, n) => (n === 1 ? openAiReply('Here.\n```gantry-draft\n{"field":"details.notes","value":"Text draft."}\n```') : openAiReply('Hello.')))
  const seen = []
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: savedNothing(), sources, skills }
  const session = createInterviewSession({ providerId: p.id, getContext: () => context, fetchImpl: ai.fetchImpl, onChange: (s) => seen.push(s.draftingFields) })
  await session.start()
  await session.send('Draft it.')
  assert.ok(seen.some((f) => f.includes('details.notes')))
  assert.deepEqual(session.snapshot().draftingFields, [])
  assert.equal(session.snapshot().drafts['details.notes'].value, 'Text draft.')
})

test('while an edit is open, a draft the AI sends for the Field meets a card and never overwrites the edit', async () => {
  const { session } = await drafted({ script: (request, n) => (n === 2 ? anthropicReply({ tools: [draftCall('d2', 'details.notes', 'AI wants this.')] }) : quiet()) })
  assert.equal(session.beginHandEdit('details.notes').ok, true)
  await session.send('Anything else?')
  assert.equal(session.snapshot().drafts['details.notes'].value, 'The AI wrote this first.')
  const c = session.snapshot().round.cards[0]
  assert.equal(c.type, 'change')
  assert.equal(c.change.saved, 'The AI wrote this first.')
  // Finishing the edit updates the card to compare against what they typed.
  session.handEdit('details.notes', MINE)
  const after = session.snapshot().round.cards[0]
  assert.equal(after.change.saved, MINE)
  assert.equal(after.change.handEdit, true)
  assert.equal(session.snapshot().drafts['details.notes'].value, MINE)
})

test("cancelling an edit leaves the draft as it was, and saving clears the Field's hand-edited state", async () => {
  const { session } = await drafted()
  session.beginHandEdit('details.notes')
  session.cancelHandEdit('details.notes')
  assert.deepEqual(session.snapshot().editingFields, [])
  session.handEdit('details.notes', MINE)
  session.markSaved(['details.notes'])
  assert.equal(session.snapshot().drafts['details.notes'], undefined)
  assert.equal(session.decisionsDelta().entries.filter((e) => e.kind === 'hand-edit').length, 1, 'the hand edit is still sent with the Save')
})

// ---------- wording and plumbing ----------

test("the hand-edit card and the log panel speak of the architect's own edit", () => {
  const card = changeCard({ key: 'details.notes', fieldTitle: 'Notes', saved: 'mine', proposed: 'ai', handEdit: true })
  assert.equal(card.header, 'Your edit')
  assert.match(card.question, /your own wording/)
  assert.equal(card.change.handEdit, true)
  const chosen = { ...card, selected: ['Merge'] }
  assert.match(answersText([chosen]), /architect's edit/)
  assert.equal(describeEntry({ kind: 'hand-edit', field: 'details.notes', words: 'Mine.' }, {}), 'The architect edited details.notes by hand: “Mine.”')
})

test('a stream parser can say which tool calls are still being written', () => {
  const parser = createAnthropicParser({ type: 'anthropic' })
  parser.feed({ data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'draft_field', input: {} } }) })
  parser.feed({ data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"field":"details.notes"' } }) })
  assert.deepEqual(parser.partials(), [{ id: 'x', name: 'draft_field', json: '{"field":"details.notes"' }])
  parser.feed({ data: JSON.stringify({ type: 'content_block_stop', index: 0 }) })
  assert.deepEqual(parser.partials(), [])
  const open = createOpenAiParser({ type: 'custom' })
  open.feed({ data: JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'y', function: { name: 'draft_field', arguments: '{"field":"a.b"' } }] } }] }) })
  assert.deepEqual(open.partials(), [{ id: 'y', name: 'draft_field', json: '{"field":"a.b"' }])
})
