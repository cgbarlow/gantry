import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #303 (parent #238, decided in #251, ADR-0066): an AI interview session working through review comments. A fake `fetch` plays the AI Provider with
// scripted streams, as in tests/bringUpToDateSession.test.js. The cards come before the AI is called; an accepted tracked edit is made by Gantry; a
// revision meets the keep / use / merge card; each answered thread is a `review-answered` entry holding the commenter's real name; and no real name
// ever reaches the AI (asserted on the whole request).
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
const { buildFieldIndex, placeReview, readReviewedCopy } = await import('../web/lib/reviewedCopy.js')
const { REVIEW_CHOICES, assignChoices, planReview, reviewerLabels } = await import('../web/lib/reviewRound.js')
const { CHANGE_OPTIONS } = await import('../web/lib/interviewRounds.js')
const { FIELDS, reviewedCopy } = await import('./helpers/reviewedCopyFixture.js')

beforeEach(() => {
  for (const p of [...providers.aiProviders.value]) providers.deleteAiProvider(p.id)
})

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

const definition = () => ({
  id: 'design',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['background'] }],
  artefacts: [{ id: 'hld', title: 'High level design', purpose: 'The HLD', gate: 'shaped', requires: ['background.problem'] }],
  modules: [
    {
      id: 'background',
      title: 'Background and context',
      purpose: 'Why',
      fields: [
        { id: 'problem', title: 'Problem statement', type: 'markdown', required: true, targetWords: { small: 5, medium: 8, large: 40 } },
        { id: 'opportunity', title: 'Opportunity', type: 'markdown', targetWords: { small: 5, medium: 8, large: 40 } },
        { id: 'success-criteria', title: 'Success criteria', type: 'markdown', targetWords: { small: 5, medium: 8, large: 40 } },
      ],
    },
  ],
})
const NOW = '2026-11-04T10:00:00.000Z'
const savedContent = (status = 'draft') => [
  {
    id: 'background',
    status,
    fields: [
      { id: 'problem', value: 'We need a new payments platform.\n\nIt must support card schemes.' },
      { id: 'opportunity', value: 'Reduce cost per transaction.' },
      { id: 'success-criteria', value: 'Payments Engineering' },
    ],
  },
]

const fieldIndex = buildFieldIndex(FIELDS)
async function loadCopy() {
  const read = await readReviewedCopy(reviewedCopy({ kind: 'word' }))
  return { entry: { id: 'copy-aaaa-0001', name: 'review-ana-ben.docx', stage: 'shape', artefact: 'hld' }, read, placed: placeReview(read, { fieldIndex }) }
}
const copy = await loadCopy()

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
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const NAMES = /Ana|Ben|Commenter/

let counter = 0
function sessionWith(ai, over = {}) {
  const provider = anthropic()
  const saved = over.saved ?? savedContent()
  const def = definition()
  const labels = reviewerLabels([copy])
  const plan = planReview({ copies: [copy], logs: over.logs ?? {}, definition: def, pageStageId: 'shape', saved })
  const review = { mode: over.mode ?? 'only', items: plan.items, deferred: plan.deferred, elsewhere: plan.elsewhere, labels, fieldChoices: assignChoices(def, 'shape'), stageTitle: () => 'Shape', pageStageTitle: 'Shape' }
  const context = { definition: def, stageId: 'shape', artefactId: 'hld', size: 'medium', saved, sources: [], skills, actor: 'Alex', review, decisions: over.decisions ?? null, ...over.context }
  const session = createInterviewSession({ providerId: provider.id, getContext: () => context, fetchImpl: ai.fetchImpl, newSessionId: () => `s-rv${++counter}`, now: () => NOW })
  return { session, context, review, plan, saved }
}
const cardWith = (snap, text) => snap.round.cards.find((c) => c.review?.sides.some((s) => s.thread?.text === text))
const cardOfAna = (snap) => snap.round.cards.find((c) => c.review?.sides.some((s) => s.author === 'Ana Reviewer' && s.changes.length))
const answerAll = (session, snap, label) => {
  for (const c of snap.round.cards) session.choose(c.id, c.options.some((o) => o.label === label) ? label : c.recommended[0])
}

test('the round is asked before the AI is called: one card per unresolved thread, none for what Word resolved', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  assert.equal(ai.calls.length, 0)
  assert.equal(snap.phase, 'asking')
  assert.equal(snap.round.review, true)
  assert.equal(snap.review.mode, 'only')
  const asked = snap.round.cards.flatMap((c) => c.review.sides.map((s) => s.thread?.text).filter(Boolean))
  assert.ok(!asked.includes('Which card schemes?'))
  assert.ok(asked.includes('Add the team'))
  assert.equal(snap.round.cards.every((c) => c.type === 'review'), true)
  assert.equal(snap.review.total, snap.round.cards.length)
})

test('accepting an edit on an unchanged Field is made by Gantry: it is in the preview, logged with the real name, and the AI is never called', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  let snap = session.snapshot()
  const ana = cardOfAna(snap)
  assert.deepEqual(ana.selected, [REVIEW_CHOICES.accept], 'recommended because the Field is unchanged')
  // Everything else is kept, so only the accept needs anything done.
  for (const c of snap.round.cards) if (c.id !== ana.id) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  assert.equal((await session.submitRound()).ok, true)
  assert.equal(ai.calls.length, 0)
  snap = session.snapshot()
  assert.equal(snap.phase, 'waiting')
  assert.equal(snap.drafts['background.problem'].value, 'We need a new payments platform.\n\nIt should support card schemes.')
  const delta = session.decisionsDelta({ runState: 'done', saving: false })
  const answered = delta.entries.filter((e) => e.kind === 'review-answered')
  const entry = answered.find((e) => e.outcome === 'accept')
  assert.equal(entry.review, 'copy-aaaa-0001')
  assert.deepEqual(entry.fields, ['background.problem'])
  assert.deepEqual(entry.changes.map((c) => [c.kind, c.author, c.text]), [['deletion', 'Ana Reviewer', 'must'], ['insertion', 'Ana Reviewer', 'should']])
  assert.deepEqual(entry.changedSinceRender, { 'background.problem': false })
  assert.equal(entry.stage, 'shape')
})

test('a revision sends the AI the comment as Reviewer N, never a real name, and its draft meets the keep / use / merge card', async () => {
  const ai = fakeAi((request, n) => {
    if (n === 0) return anthropicReply({ text: 'Revising.', tools: [{ id: 'd1', input: { field: 'background.success-criteria', value: 'Payments Engineering and Risk.' } }] })
    return anthropicReply({ text: 'Done.' })
  })
  const { session } = sessionWith(ai)
  await session.start()
  let snap = session.snapshot()
  for (const c of snap.round.cards) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  const team = cardWith(snap, 'Add the team')
  session.choose(team.id, REVIEW_CHOICES.revise)
  session.setReviewReason(team.id, 'Ben is right: add Risk too.')
  assert.equal((await session.submitRound()).ok, true)

  assert.equal(ai.calls.length, 2, 'the redraft, then its tool result')
  const sent = JSON.stringify(ai.calls.map((c) => c.body))
  assert.doesNotMatch(sent, NAMES, 'no commenter’s real name reaches the AI')
  const text = firstUser(ai.calls[0])
  assert.match(text, /Work through the review comments/)
  assert.match(text, /REVISE\. Redraft the Field to deal with the review comment/)
  assert.match(text, /Reviewer 2 commented/)
  assert.match(text, /Add the team/)
  assert.match(text, /Reviewer 2 is right: add Risk too\./, 'even the architect’s own words are scrubbed')
  assert.doesNotMatch(text, /Begin the interview/)

  snap = session.snapshot()
  const change = snap.round.cards.find((c) => c.type === 'change')
  assert.equal(change.field, 'background.success-criteria')
  assert.deepEqual(change.options.map((o) => o.label), [CHANGE_OPTIONS.keep, CHANGE_OPTIONS.use, CHANGE_OPTIONS.merge])
  assert.deepEqual(Object.keys(snap.drafts), [], 'nothing is applied until they choose')
  session.choose(change.id, CHANGE_OPTIONS.use)
  await session.submitRound()
  assert.match(session.snapshot().drafts['background.success-criteria'].value, /Risk/)
  const entry = session.decisionsDelta({ runState: 'done', saving: true }).entries.find((e) => e.kind === 'review-answered' && e.outcome === 'revise')
  assert.equal(entry.threads[0].author, 'Ben Commenter', 'the repo keeps the real name')
  assert.equal(entry.words, 'Ben is right: add Risk too.')
})

test('#331 the opening message waits for the review round and goes with the AI\'s first request, after the answers', async () => {
  const words = 'Reviewer 2 speaks for the delivery team; weigh that.'
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Revising.' }) : anthropicReply({ text: 'Done.' })))
  const { session } = sessionWith(ai)
  await session.start({ opening: words })
  assert.equal(ai.calls.length, 0, 'the round still comes before the AI')
  let snap = session.snapshot()
  assert.deepEqual(snap.thread.filter((t) => t.who === 'you').map((t) => t.text), [words])
  for (const c of snap.round.cards) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  session.choose(cardWith(snap, 'Add the team').id, REVIEW_CHOICES.revise)
  assert.equal((await session.submitRound()).ok, true)
  const messages = ai.calls[0].body.messages
  assert.equal(messages.length, 2)
  assert.match(firstUser(ai.calls[0]), /Work through the review comments/)
  assert.deepEqual(messages[1], { role: 'user', content: words })
})

test('keep as is writes the reason in the architect’s words and nothing else; can’t settle yet is an open question with no real name in it', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  for (const c of snap.round.cards) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  const team = cardWith(snap, 'Add the team')
  session.choose(team.id, REVIEW_CHOICES.keep)
  session.setReviewReason(team.id, 'The team goes in the Plan, not here.')
  const signs = cardWith(snap, 'Say who signs this off')
  session.choose(signs.id, REVIEW_CHOICES.cantSettle)
  await session.submitRound()
  assert.equal(ai.calls.length, 0)
  const delta = session.decisionsDelta({ runState: 'done' })
  const keep = delta.entries.find((e) => e.kind === 'review-answered' && e.outcome === 'keep' && e.threads?.[0]?.text === 'Add the team')
  assert.equal(keep.words, 'The team goes in the Plan, not here.')
  const open = delta.entries.find((e) => e.kind === 'open-question')
  assert.match(open.question, /Reviewer 2/)
  assert.doesNotMatch(open.question, NAMES)
  assert.deepEqual(open.fields, ['background.problem'])
  const settled = delta.entries.find((e) => e.kind === 'review-answered' && e.outcome === 'cant-settle')
  assert.equal(settled.openQuestion, open.question)
  assert.equal(settled.threads[0].text, 'Say who signs this off', 'the whole comment is kept in the entry')
})

test('an answered thread is not asked again once its entry is in the log', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const first = sessionWith(ai)
  await first.session.start()
  answerAll(first.session, first.session.snapshot(), REVIEW_CHOICES.keep)
  await first.session.submitRound()
  const log = applyDecisionsDelta(emptyDecisionsLog('shape'), first.session.decisionsDelta({ runState: 'done' }), 'shape')
  const answered = log.entries.filter((e) => e.kind === 'review-answered')
  assert.ok(answered.length >= 6)
  const next = planReview({ copies: [copy], logs: { shape: log }, definition: definition(), pageStageId: 'shape', saved: savedContent() })
  assert.equal(next.items.length, 0, 'every thread and edit was answered')
  assert.equal(next.resolved.length, 1, 'the one resolved in Word is still listed')
})

test('accepting a change to an agreed Module returns it to draft, with a note in the log, and the card said so first', async () => {
  const ai = fakeAi(() => anthropicReply({ text: 'unexpected' }))
  const { session } = sessionWith(ai, { saved: savedContent('agreed') })
  await session.start()
  const snap = session.snapshot()
  const ana = cardOfAna(snap)
  assert.match(ana.review.agreedNote, /Background and context is agreed\. Accepting or revising a change to it returns it to draft/)
  for (const c of snap.round.cards) if (c.id !== ana.id) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  await session.submitRound()
  const returned = session.decisionsDelta({ runState: 'done' }).entries.find((e) => e.kind === 'returned-to-draft')
  assert.equal(returned.module, 'background')
  assert.match(returned.note, /was agreed and is back to draft/)
  assert.match(returned.note, /reviewer’s edit was accepted/)
})

test('assigning a comment on the document to a Field asks the AI to revise that Field', async () => {
  const ai = fakeAi((request, n) => (n === 0 ? anthropicReply({ text: 'Revising.', tools: [{ id: 'd1', input: { field: 'background.opportunity', value: 'Reduce cost per transaction and settlement time.' } }] }) : anthropicReply({ text: 'Done.' })))
  const { session } = sessionWith(ai)
  await session.start()
  const snap = session.snapshot()
  for (const c of snap.round.cards) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  const cover = cardWith(snap, 'Put the date on the cover')
  session.choose(cover.id, REVIEW_CHOICES.assign)
  const refused = await session.submitRound()
  assert.equal(refused.ok, false, 'a Field has to be chosen')
  session.setReviewAssign(cover.id, 'background.opportunity')
  assert.equal((await session.submitRound()).ok, true)
  assert.match(firstUser(ai.calls[0]), /background\.opportunity .*REVISE/)
  assert.doesNotMatch(JSON.stringify(ai.calls.map((c) => c.body)), NAMES)
  const entry = session.decisionsDelta({ runState: 'done' }).entries.find((e) => e.outcome === 'assign')
  assert.deepEqual(entry.fields, ['background.opportunity'])
})

test('review questions join a running session’s next round, and its open round', async () => {
  let turn = 0
  const ai = fakeAi(() => {
    turn++
    if (turn === 1) return anthropicReply({ text: 'Reading.', tools: [ask('a1', [{ question: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }], recommended: ['EU'], why: 'Because.', field: 'background.problem' }])] })
    return anthropicReply({ text: 'Thanks.' })
  })
  const { session, review } = sessionWith(ai, { mode: 'join' })
  const run = session.start()
  // The AI is busy: the review questions are queued for the round it is about to ask.
  await run
  let snap = session.snapshot()
  assert.equal(snap.phase, 'asking')
  const interview = snap.round.cards.filter((c) => c.type !== 'review')
  const reviews = snap.round.cards.filter((c) => c.type === 'review')
  assert.equal(interview.length, 1, 'the AI’s own question')
  assert.ok(reviews.length >= 6, 'the review questions are in the same round')
  assert.equal(snap.round.review, undefined, 'it is the interview’s round, not a focused one')
  assert.match(snap.thread.map((t) => t.text).join('\n'), /review comments? (is|are) in this round/)

  // Answering the whole round: the interview’s question goes to the AI along with the review answers, scrubbed.
  for (const c of reviews) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  await session.submitRound()
  const second = ai.calls.at(-1)
  const sentText = JSON.stringify(second.body)
  assert.match(sentText, /Review comments they answered in this round/)
  assert.doesNotMatch(JSON.stringify(ai.calls.map((c) => c.body)), NAMES)

  // A session that is waiting gets them as a round of their own.
  snap = session.snapshot()
  assert.equal(snap.phase, 'waiting')
  const other = { ...review, items: review.items }
  const joined = session.joinReview(other)
  assert.equal(joined.added, 0, 'the ones already answered in this session are not asked twice')
})

test('joining a waiting session opens a round of just the review questions, and answering needs the AI only if something must be written', async () => {
  const ai = fakeAi((request, n) => anthropicReply({ text: 'Nothing to ask.' }))
  const { session, review } = sessionWith(ai, { mode: 'join' })
  // Start an interview that asks nothing, so the session is waiting.
  await session.start()
  const snap0 = session.snapshot()
  // The queued cards came with the first round the AI "asked" (it asked none, so they open one).
  assert.equal(snap0.phase, 'asking')
  for (const c of snap0.round.cards) session.choose(c.id, c.options.find((o) => [REVIEW_CHOICES.keep, REVIEW_CHOICES.note].includes(o.label)).label)
  const before = ai.calls.length
  await session.submitRound()
  assert.equal(ai.calls.length, before, 'keep and note need nothing written')
  assert.equal(session.snapshot().phase, 'waiting')
  void review
})

test('a real name in the saved decisions log never reaches the AI in the brief', async () => {
  const decisions = {
    version: 1,
    stage: 'shape',
    status: [],
    fields: {},
    entries: [
      {
        id: 's-old-1',
        kind: 'review-answered',
        at: NOW,
        review: 'copy-aaaa-0001',
        keys: ['copy-aaaa-0001:4'],
        threads: [{ id: '4', author: 'Ben Commenter', date: NOW, text: 'Add the team', replies: [] }],
        fields: ['background.success-criteria'],
        outcome: 'keep',
        words: 'Ben Commenter is wrong about this.',
      },
    ],
  }
  const ai = fakeAi(() => anthropicReply({ text: 'Nothing to ask.' }))
  const { session } = sessionWith(ai, { mode: 'join', decisions, context: { review: undefined } })
  await session.start()
  assert.ok(ai.calls.length >= 1)
  const sent = JSON.stringify(ai.calls.map((c) => ({ system: c.body.system, messages: c.body.messages })))
  assert.match(sent, /a reviewer's comment was answered: keep/)
  assert.doesNotMatch(sent, NAMES)
})
