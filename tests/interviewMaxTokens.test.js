import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withFlatSystem } from './helpers/aiRequest.js'

// #346 (parent #343): the output limit an AI interview request asks for. An AI Provider saved with no Max tokens gets the higher fallback
// (16,000, room to draft several Fields in one reply) where its wire format needs a number, which is Anthropic's; one saved with 4,096 still
// asks for 4,096. A fake `fetch` plays the AI Provider through the relay; the AI Providers list is the real one, kept in a fake localStorage.
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

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))

const definition = () => ({
  id: 'small',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the work.', gate: 'shaped', modules: ['details'] }],
  artefacts: [{ id: 'light', title: 'Light', gate: 'shaped', requires: ['details.summary'] }],
  modules: [{ id: 'details', title: 'Details', fields: [{ id: 'summary', title: 'Problem statement', type: 'markdown', required: true }] }],
})
const sources = [{ id: 'tech-lt', title: 'Tech LT deck', filename: 'deck.md', size: 40, text: '# Tech LT deck\n\nThe platform moves to managed hosting.' }]

function anthropicReply(text) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const out =
    event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) +
    event('message_stop', { type: 'message_stop' })
  return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function fakeAi() {
  const calls = []
  const fetchImpl = async (_url, init = {}) => {
    const envelope = JSON.parse(init.body)
    calls.push({ body: envelope.body ? withFlatSystem(JSON.parse(envelope.body)) : null })
    return anthropicReply('What problem are we solving?')
  }
  return { fetchImpl, calls }
}

async function interviewWith(over) {
  const p = providers.addAiProvider({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', ...over })
  providers.setAiProviderTest(p.id, { status: 'passed', testedAt: 'now', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }, null)
  const context = { definition: definition(), stageId: 'shape', artefactId: 'light', size: 'medium', saved: [{ id: 'details', status: 'draft', fields: [{ id: 'summary', value: '' }] }], sources, skills }
  const ai = fakeAi()
  const session = createInterviewSession({ providerId: p.id, getContext: () => context, fetchImpl: ai.fetchImpl })
  await session.start()
  assert.ok(ai.calls.length >= 1)
  return ai.calls.map((c) => c.body.max_tokens)
}

test('an AI Provider saved with no Max tokens asks for the higher fallback on an interview request', async () => {
  const sent = await interviewWith({})
  assert.ok(sent.every((n) => n === 16000), String(sent))
})

test('an AI Provider saved with 4,096 still asks for 4,096', async () => {
  const sent = await interviewWith({ maxTokens: 4096 })
  assert.ok(sent.every((n) => n === 4096), String(sent))
})
