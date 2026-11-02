import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #300 (parent #238, docs/adr/0069): the AI interview respects re-approval of earlier stages. A Field an approved earlier Stage prints
// is approved content: the AI changes it only through a card that names the re-approval, the choice is logged, the stage-end card says
// which earlier documents the Save re-renders, and the run plan shows "changed since approval". A fake `fetch` plays the AI Provider.
const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const providers = await import('../web/lib/aiProviders.js')
const { createInterviewSession } = await import('../web/lib/interviewSession.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { buildInterviewBrief } = await import('../web/lib/interviewBrief.js')
const { approvedEarlierStages, approvedPrintedFields, changedMark, earlierDocumentsToRender, printedKeysOfArtefact, reRenderCardLine, reapprovalNames, reapprovalOf, reapprovalSentence } = await import('../web/lib/interviewReapproval.js')
const { changeCard } = await import('../web/lib/interviewRounds.js')
const { describeEntry } = await import('../web/lib/decisionsLogPanel.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

// Two Stages. Business case (`bc`) is approved and its Artefact prints the whole `background` module and `scope.goal` of the shared `scope`
// module. HLD (`hld`) mounts both modules plus its own `design`, and its own Artefact prints `scope.constraints` as well.
function definition() {
  return {
    id: 'pair',
    stages: [
      { id: 'bc', title: 'Business case', gate: 'g-bc', modules: ['background', 'scope'] },
      { id: 'hld', title: 'HLD', gate: 'g-hld', purpose: 'Design it.', modules: ['background', 'scope', 'design'] },
    ],
    artefacts: [
      { id: 'bc-doc', title: 'Business case document', gate: 'g-bc', requires: ['background', 'scope.goal'] },
      { id: 'hld-doc', title: 'HLD document', gate: 'g-hld', requires: ['design.approach', 'scope.constraints'] },
    ],
    modules: [
      { id: 'background', title: 'Background', fields: [{ id: 'problem', title: 'Problem', type: 'markdown', required: true }] },
      {
        id: 'scope',
        title: 'Scope',
        fields: [
          { id: 'goal', title: 'Goal', type: 'markdown' },
          { id: 'constraints', title: 'Constraints', type: 'markdown' },
        ],
      },
      { id: 'design', title: 'Design', fields: [{ id: 'approach', title: 'Approach', type: 'markdown', required: true }] },
    ],
  }
}
const instanceOf = (over = {}) => ({
  workspaceBacked: true,
  slug: 'atlas',
  stage: { id: 'hld', title: 'HLD' },
  currentStageId: 'hld',
  stages: [{ id: 'bc', title: 'Business case' }, { id: 'hld', title: 'HLD' }],
  pullRequests: { bc: 11 },
  changedSinceApproval: [],
  ...over,
})
const saved = (over = {}) => [
  { id: 'background', status: 'draft', fields: [{ id: 'problem', value: over.problem ?? 'Claims are slow.' }] },
  { id: 'scope', status: 'draft', fields: [{ id: 'goal', value: over.goal ?? '' }, { id: 'constraints', value: over.constraints ?? '' }] },
  { id: 'design', status: 'draft', fields: [{ id: 'approach', value: '' }] },
]
const sources = [{ id: 'brief', title: 'Client brief', filename: 'brief.md', size: 40, text: '# Client brief\n\nThe insurer wants faster claims.' }]

// ---------- the rules, with no session ----------

test('an earlier Stage is approved once its Pull Request is on file and it is before the current Stage; local and server workspaces have none', () => {
  assert.deepEqual(approvedEarlierStages(instanceOf()).map((s) => s.id), ['bc'])
  assert.deepEqual(approvedEarlierStages(instanceOf({ pullRequests: {} })), [], 'no Pull Request, no approval')
  assert.deepEqual(approvedEarlierStages(instanceOf({ stage: { id: 'bc', title: 'Business case' }, currentStageId: 'bc' })), [], 'nothing is before the first Stage')
  assert.deepEqual(approvedEarlierStages(instanceOf({ currentStageId: 'bc' })), [], 'a Stage ahead of the current one cannot have approved an earlier one that is itself still open')
  assert.deepEqual(approvedEarlierStages(instanceOf({ workspaceBacked: false })), [])
})

test('the approved Fields are what the approved Stage\'s documents print, even where they are empty, and not what only a later document prints', () => {
  const approved = approvedPrintedFields({ definition: definition(), instance: instanceOf() })
  assert.deepEqual(Object.keys(approved).sort(), ['background.problem', 'scope.goal'])
  assert.deepEqual(approved['scope.goal'], [{ stageId: 'bc', title: 'Business case' }])
  assert.deepEqual(reapprovalOf(approved, 'scope.constraints'), [], 'only HLD\'s document prints it, so it is free to change')
  assert.deepEqual(reapprovalOf(approved, 'design.approach'), [])
  assert.deepEqual(approvedPrintedFields({ definition: definition(), instance: instanceOf({ workspaceBacked: false }) }), {})
})

test('a Field the server already flags is approved content too', () => {
  const approved = approvedPrintedFields({ definition: definition(), instance: instanceOf({ pullRequests: {}, changedSinceApproval: [{ stageId: 'bc', title: 'Business case', fields: ['scope.goal'], count: 1 }] }) })
  assert.deepEqual(Object.keys(approved), ['scope.goal'])
})

test('requirement entries read as in the Definition: a bare module prints all its Fields, module.field one, and a trailing ? is still printed', () => {
  const def = definition()
  assert.deepEqual([...printedKeysOfArtefact(def, def.artefacts[0])].sort(), ['background.problem', 'scope.goal'])
  assert.deepEqual([...printedKeysOfArtefact(def, { requires: ['scope.constraints?', 'nope.x'] })], ['scope.constraints'])
})

test('the cards name the Stages that need re-approval', () => {
  assert.equal(reapprovalNames([{ title: 'SOAP' }]), 'SOAP')
  assert.equal(reapprovalNames([{ title: 'SOAP' }, { title: 'HLD' }]), 'SOAP and HLD')
  assert.equal(reapprovalNames([{ title: 'A' }, { title: 'B' }, { title: 'C' }]), 'A, B and C')
  assert.match(reapprovalSentence([{ title: 'SOAP' }]), /changes approved content, so SOAP needs re-approval with this Stage/)
})

test('the change card for approved content says it changes approved content that needs re-approval, and keeps the recommendation to keep', () => {
  const card = changeCard({ key: 'scope.goal', fieldTitle: 'Scope · Goal', saved: '', proposed: 'Cut claim time in half.', reapproves: [{ stageId: 'bc', title: 'Business case' }] })
  assert.equal(card.header, 'Needs re-approval')
  assert.match(card.question, /Scope · Goal is printed by Business case, which is already approved/)
  assert.match(card.question, /changes approved content, so Business case needs re-approval with this Stage/)
  assert.deepEqual(card.recommended, ['Keep'])
  assert.deepEqual(card.options.map((o) => o.label), ['Keep', "Use the AI's version", 'Merge'])
  assert.match(card.options[1].description, /Business case is re-approved with this Stage/)
  assert.deepEqual(card.change.reapproves, [{ stageId: 'bc', title: 'Business case' }])
  // Plain saved content is worded as it always was.
  const plain = changeCard({ key: 'scope.goal', fieldTitle: 'Scope · Goal', saved: 'x', proposed: 'y' })
  assert.equal(plain.header, 'Saved content')
  assert.equal(plain.change.reapproves, undefined)
})

test('the stage-end card knows which earlier documents the Save re-renders: those that print a flagged Field or an approved Field in the drafts', () => {
  const def = definition()
  const instance = instanceOf()
  const approved = approvedPrintedFields({ definition: def, instance })
  assert.deepEqual(earlierDocumentsToRender({ definition: def, instance, approved, draftKeys: ['design.approach', 'scope.constraints'] }), [], 'drafts of Fields no approved document prints re-render nothing')
  const fromDraft = earlierDocumentsToRender({ definition: def, instance, approved, draftKeys: ['scope.goal', 'design.approach'] })
  assert.deepEqual(fromDraft, [{ stageId: 'bc', stageTitle: 'Business case', artefactId: 'bc-doc', artefactTitle: 'Business case document', fields: ['scope.goal'], count: 1 }])
  const flagged = instanceOf({ changedSinceApproval: [{ stageId: 'bc', title: 'Business case', fields: ['background.problem'], count: 1 }] })
  assert.deepEqual(earlierDocumentsToRender({ definition: def, instance: flagged, approved, draftKeys: [] }).map((d) => d.fields), [['background.problem']])
  assert.equal(reRenderCardLine([]), null)
  assert.match(reRenderCardLine(fromDraft), /^Saving also re-renders Business case document from the changed wording, then asks for approval of this Stage and Business case together\.$/)
})

test('the run plan mark is the server flag for that Stage', () => {
  const flagged = instanceOf({ changedSinceApproval: [{ stageId: 'bc', title: 'Business case', fields: ['scope.goal'], count: 1 }] })
  assert.deepEqual(changedMark(flagged, 'bc'), { count: 1, fields: ['scope.goal'] })
  assert.equal(changedMark(flagged, 'hld'), null)
  assert.equal(changedMark(instanceOf(), 'bc'), null)
})

test('the decisions log panel words a choice on approved content with the Stage it re-approves', () => {
  const entry = (choice) => ({ id: 'e', kind: 'saved-content', field: 'scope.goal', choice, reapproves: [{ stageId: 'bc', title: 'Business case' }] })
  const title = () => 'Scope · Goal'
  assert.match(describeEntry(entry('keep'), { fieldTitle: title }), /Approved content in Scope · Goal \(printed by Business case\): kept the approved wording$/)
  assert.match(describeEntry(entry('replace'), { fieldTitle: title }), /replaced it with the AI's version, needing re-approval of Business case with this Stage/)
  assert.match(describeEntry(entry('merge'), { fieldTitle: title }), /merged the two, needing re-approval of Business case/)
})

test('the brief tells the AI which Fields are approved content, and says nothing when there are none', () => {
  const approved = approvedPrintedFields({ definition: definition(), instance: instanceOf() })
  const input = { definition: definition(), stageId: 'hld', saved: saved(), sources, skills, decisions: [] }
  const withApproved = buildInterviewBrief({ ...input, approvedPrinted: approved })
  const fields = withApproved.segments.find((s) => s.id === 'fields').text
  assert.match(fields, /`scope\.goal` "Goal"[\s\S]*?Approved content: Business case is approved and prints this Field/)
  assert.doesNotMatch(fields, /`scope\.constraints` "Constraints"[^\n]*\n(?:  - [^\n]*\n)*  - Approved content/, 'a Field only HLD prints is not marked')
  assert.doesNotMatch(buildInterviewBrief(input).text, /Approved content:/)
})

// ---------- a session ----------

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
    calls.push({ url: envelope.url, body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null })
    return handler(calls.at(-1), calls.length - 1)
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
  const def = definition()
  const instance = over.instance ?? instanceOf()
  const context = { definition: def, stageId: 'hld', size: 'medium', saved: saved(over.saved), sources, skills, approvedPrinted: approvedPrintedFields({ definition: def, instance }), ...over.context }
  return { session: createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl }), context }
}
const toolResults = (request) => {
  const last = request.body.messages.at(-1)
  return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
}
const draftCall = (id, field, value) => ({ id, input: { field, value } })

test('the AI cannot change a Field an approved Stage prints, even an empty one: its draft meets a card that names the re-approval, and nothing reaches the preview', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'scope.goal', 'Cut claim time in half.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  assert.deepEqual(snap.drafts, {}, 'nothing is written before the architect answers')
  assert.equal(snap.phase, 'asking')
  const card = snap.round.cards[0]
  assert.equal(card.type, 'change')
  assert.equal(card.header, 'Needs re-approval')
  assert.match(card.question, /Business case needs re-approval with this Stage/)
  assert.equal(card.change.saved, '')
  assert.equal(card.change.proposed, 'Cut claim time in half.')
  const told = toolResults(ai.calls[1])[0]
  assert.equal(told.is_error, true)
  assert.match(told.content, /scope\.goal is printed by Business case, which is already approved, so it is not changed/)
  assert.match(told.content, /Do not draft scope\.goal again/)
})

test('a Field only this Stage prints is drafted freely, with no card', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'scope.constraints', 'Must run on the existing platform.'), draftCall('d2', 'design.approach', 'Event-driven.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  assert.deepEqual(Object.keys(snap.drafts).sort(), ['design.approach', 'scope.constraints'])
  assert.equal(snap.round, null)
})

test('on a local or server workspace nothing is approved, so a Field the other Stage prints is drafted freely', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'scope.goal', 'Cut claim time in half.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai, { instance: instanceOf({ workspaceBacked: false }) })
  await session.start()
  assert.equal(session.snapshot().drafts['scope.goal'].value, 'Cut claim time in half.')
  assert.equal(session.snapshot().round, null)
})

test("choosing the AI's version on the re-approval card puts it in the preview and logs the choice with the Stage it re-approves", async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ tools: [draftCall('d1', 'scope.goal', 'Cut claim time in half.')] }) : anthropicReply({ text: 'ok' })))
  const { session } = sessionWith(ai)
  await session.start()
  session.choose(session.snapshot().round.cards[0].id, "Use the AI's version")
  await session.submitRound()
  const snap = session.snapshot()
  assert.equal(snap.drafts['scope.goal'].value, 'Cut claim time in half.')
  const entry = snap.decisions.latest.find((e) => e.kind === 'saved-content')
  assert.equal(entry.choice, 'replace')
  assert.equal(entry.field, 'scope.goal')
  assert.deepEqual(entry.reapproves, [{ stageId: 'bc', title: 'Business case' }])
})

test('keeping the approved wording is logged too, and the AI is not asked about that Field again', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [draftCall('d1', 'background.problem', 'A different problem statement.')] })
    if (n === 2) return anthropicReply({ tools: [draftCall('d2', 'background.problem', 'Yet another problem statement.')] })
    return anthropicReply({ text: 'ok' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  const card = session.snapshot().round.cards[0]
  assert.equal(card.change.saved, 'Claims are slow.', 'a Field with approved content shows it')
  session.choose(card.id, 'Keep')
  await session.submitRound()
  const snap = session.snapshot()
  assert.deepEqual(snap.drafts, {})
  assert.equal(snap.round, null, 'no second card for a Field the architect kept')
  const entry = snap.decisions.latest.find((e) => e.kind === 'saved-content')
  assert.equal(entry.choice, 'keep')
  assert.deepEqual(entry.reapproves, [{ stageId: 'bc', title: 'Business case' }])
  assert.match(toolResults(ai.calls[3])[0].content, /chose to keep it/)
})

test('a Field the architect let the AI change is drafted freely until it is saved, and is held back again after the Save', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ tools: [draftCall('d1', 'scope.goal', 'Version one.')] })
    if (n === 2) return anthropicReply({ tools: [draftCall('d2', 'scope.goal', 'Version two.')] })
    if (n === 4) return anthropicReply({ tools: [draftCall('d3', 'scope.goal', 'Version three.')] })
    return anthropicReply({ text: 'ok' })
  })
  const { session, context } = sessionWith(ai)
  await session.start()
  session.choose(session.snapshot().round.cards[0].id, 'Merge')
  await session.submitRound()
  assert.equal(session.snapshot().drafts['scope.goal'].value, 'Version two.', 'the architect said yes once; the AI may revise it')
  session.markSaved(['scope.goal'])
  assert.deepEqual(session.snapshot().drafts, {})
  context.saved = saved({ goal: 'Version two.' })
  await session.send('Please tighten the goal.')
  const snap = session.snapshot()
  assert.deepEqual(snap.drafts, {}, 'after the Save it is approved content again')
  assert.equal(snap.round.cards[0].type, 'change')
  assert.equal(snap.round.cards[0].change.saved, 'Version two.')
  assert.deepEqual(snap.round.cards[0].change.reapproves, [{ stageId: 'bc', title: 'Business case' }])
})
