import { test } from 'node:test'
import assert from 'node:assert/strict'

// #277 (ADR-0061): the browser-side AI Provider list and how a call to one is made. The module holds a
// module-level signal read from localStorage at import, so each test imports a fresh copy after arranging
// `globalThis.localStorage` (the same approach as tests/advancedMode.test.js).
async function fresh(initial) {
  const map = new Map(initial === undefined ? [] : [['gantry:ai-providers', JSON.stringify(initial)]])
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  const mod = await import(`../web/lib/aiProviders.js?t=${Math.random()}`)
  return { mod, stored: () => JSON.parse(map.get('gantry:ai-providers') ?? 'null') }
}

const draft = (over = {}) => ({ name: 'Work Anthropic', type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-1', model: 'claude-x', ...over })

test('there are six types, and only Ollama and LM Studio run locally without a key', async () => {
  const { mod } = await fresh()
  assert.deepEqual(mod.AI_PROVIDER_TYPES.map((t) => t.id), ['openai', 'anthropic', 'ollama', 'lmstudio', 'openrouter', 'custom'])
  assert.deepEqual(mod.AI_PROVIDER_TYPES.filter((t) => !t.keyRequired).map((t) => t.id), ['ollama', 'lmstudio'])
  assert.deepEqual(mod.AI_PROVIDER_TYPES.filter((t) => t.local).map((t) => t.id), ['ollama', 'lmstudio'])
})

test('AI Providers are added, edited and deleted, and persist in the browser', async () => {
  const { mod, stored } = await fresh()
  assert.deepEqual(mod.aiProviders.value, [])
  const added = mod.addAiProvider(draft())
  assert.equal(mod.aiProviders.value.length, 1)
  assert.equal(stored()[0].key, 'sk-ant-1')
  mod.updateAiProvider(added.id, { name: 'Renamed', temperature: 0.5 })
  assert.equal(mod.getAiProvider(added.id).name, 'Renamed')
  assert.equal(stored()[0].temperature, 0.5)
  mod.deleteAiProvider(added.id)
  assert.deepEqual(mod.aiProviders.value, [])
  assert.deepEqual(stored(), [])
})

test('a fresh load (another page, another workspace) reads the same list back', async () => {
  const first = await fresh()
  first.mod.addAiProvider(draft({ name: 'Renamed' }))
  const again = await fresh(first.stored())
  assert.equal(again.mod.aiProviders.value.length, 1)
  assert.equal(again.mod.aiProviders.value[0].name, 'Renamed')
  assert.equal(again.mod.aiProviders.value[0].key, 'sk-ant-1')
})

test('exactly one AI Provider is the Default, through add, set, delete and a hand-edited store', async () => {
  const { mod } = await fresh()
  const a = mod.addAiProvider(draft({ name: 'A' }))
  const b = mod.addAiProvider(draft({ name: 'B' }))
  const c = mod.addAiProvider(draft({ name: 'C' }), { makeDefault: true })
  const defaults = () => mod.aiProviders.value.filter((p) => p.isDefault).map((p) => p.name)
  assert.deepEqual(defaults(), ['C'], 'the first is the Default until a later one is made the Default')
  mod.setDefaultAiProvider(b.id)
  assert.deepEqual(defaults(), ['B'])
  mod.updateAiProvider(a.id, {}, { makeDefault: true })
  assert.deepEqual(defaults(), ['A'])
  mod.deleteAiProvider(a.id)
  assert.equal(defaults().length, 1, 'deleting the Default promotes another')
  mod.deleteAiProvider(c.id)
  mod.deleteAiProvider(b.id)
  assert.deepEqual(mod.aiProviders.value, [])

  const first = await fresh()
  assert.equal(first.mod.addAiProvider(draft()).isDefault, true)

  const none = await fresh([draft({ name: 'X', id: 'x' }), draft({ name: 'Y', id: 'y' })])
  assert.deepEqual(none.mod.aiProviders.value.map((p) => p.isDefault), [true, false])
  const many = await fresh([draft({ name: 'X', id: 'x', isDefault: true }), draft({ name: 'Y', id: 'y', isDefault: true })])
  assert.deepEqual(many.mod.aiProviders.value.map((p) => p.isDefault), [true, false])
})

test('changing Type, Address or Model marks an AI Provider untested; nothing else does', async () => {
  const { mod } = await fresh()
  const p = mod.addAiProvider(draft())
  const tested = { status: 'passed', questionCards: 'native' }
  const withResult = () => mod.aiProviders.value.map((x) => (x.id === p.id ? { ...x, test: tested } : x))
  const reseed = () => {
    mod.aiProviders.value = withResult()
  }
  reseed()
  assert.equal(mod.aiProviderStatusLabel(mod.getAiProvider(p.id)).label, 'Ready')
  mod.updateAiProvider(p.id, { name: 'New name', key: 'new-key', temperature: 0.9, maxTokens: 100 })
  assert.deepEqual(mod.getAiProvider(p.id).test, tested, 'name, key and parameters leave a result alone')
  for (const change of [{ model: 'other' }, { address: 'https://proxy.example.com' }, { type: 'custom' }]) {
    reseed()
    mod.updateAiProvider(p.id, change)
    assert.equal(mod.getAiProvider(p.id).test, null, JSON.stringify(change))
    assert.equal(mod.aiProviderStatusLabel(mod.getAiProvider(p.id)).label, 'Untested')
    assert.equal(mod.aiProviderQuestionCardsLabel(mod.getAiProvider(p.id)), '—')
    mod.updateAiProvider(p.id, { model: 'claude-x', address: 'https://api.anthropic.com', type: 'anthropic' })
  }
  assert.equal(mod.changeMarksUntested({ type: 'a', address: 'b', model: 'c' }, { type: 'a', address: 'b', model: 'c' }), false)
})

test('a corrupt or unreadable store is an empty list, not an error', async () => {
  globalThis.localStorage = { getItem: () => '{not json', setItem() {}, removeItem() {} }
  const a = await import(`../web/lib/aiProviders.js?t=${Math.random()}`)
  assert.deepEqual(a.aiProviders.value, [])
  globalThis.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem() {} }
  const b = await import(`../web/lib/aiProviders.js?t=${Math.random()}`)
  assert.deepEqual(b.aiProviders.value, [])
  assert.doesNotThrow(() => b.addAiProvider(draft()))
  delete globalThis.localStorage
})

test('validation: a name, an address, a key where the type needs one, and sane numbers', async () => {
  const { mod } = await fresh()
  assert.deepEqual(mod.validateAiProviderDraft(mod.normaliseAiProvider(draft())), {})
  const errors = mod.validateAiProviderDraft(mod.normaliseAiProvider(draft({ name: ' ', address: 'ftp://x', key: '', temperature: 5, maxTokens: 0, contextWindow: -1 })))
  assert.deepEqual(Object.keys(errors).sort(), ['address', 'contextWindow', 'key', 'maxTokens', 'name', 'temperature'])
  assert.match(mod.validateAiProviderDraft(mod.normaliseAiProvider(draft({ address: 'https://u:p@x.com' }))).address, /user name/)
  // the key is optional for Ollama and LM Studio only
  for (const type of ['ollama', 'lmstudio']) {
    assert.deepEqual(mod.validateAiProviderDraft(mod.normaliseAiProvider(draft({ type, key: '', address: 'http://localhost:1234' }))), {})
  }
  for (const type of ['openai', 'anthropic', 'openrouter', 'custom']) {
    assert.ok(mod.validateAiProviderDraft(mod.normaliseAiProvider(draft({ type, key: '' }))).key, type)
  }
  const dup = mod.validateAiProviderDraft(mod.normaliseAiProvider(draft({ name: 'work anthropic' })), [{ name: 'Work Anthropic' }])
  assert.match(dup.name, /already/)
  const adv = mod.validateAiProviderDraft(mod.normaliseAiProvider(draft({ advanced: { topP: 2, topK: 0, minP: -1, frequencyPenalty: 3, presencePenalty: -3 } })))
  assert.deepEqual(Object.keys(adv).sort(), ['frequencyPenalty', 'minP', 'presencePenalty', 'topK', 'topP'])
})

test('the Advanced settings, stop sequences and reasoning effort round-trip', async () => {
  const { mod } = await fresh()
  const p = mod.addAiProvider(draft({ advanced: { topP: 0.9, topK: 40, minP: 0.05, frequencyPenalty: 0.1, presencePenalty: -0.1, stop: ['END', '', 'STOP'], reasoningEffort: 'high' }, contextWindow: 50000 }))
  assert.deepEqual(mod.getAiProvider(p.id).advanced, { topP: 0.9, topK: 40, minP: 0.05, frequencyPenalty: 0.1, presencePenalty: -0.1, stop: ['END', 'STOP'], reasoningEffort: 'high' })
  assert.equal(mod.getAiProvider(p.id).contextWindow, 50000)
})

// ---------- model lists ----------

test('each type lists its models at its own endpoint, with its own kind of key header', async () => {
  const { mod } = await fresh()
  const req = (type, address, key = 'k') => mod.modelsRequest(mod.normaliseAiProvider({ type, address, key }))
  assert.deepEqual(req('openai', 'https://api.openai.com/v1'), { url: 'https://api.openai.com/v1/models', method: 'GET', headers: { Authorization: 'Bearer k' } })
  assert.deepEqual(req('anthropic', 'https://api.anthropic.com'), { url: 'https://api.anthropic.com/v1/models?limit=1000', method: 'GET', headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } })
  assert.equal(req('anthropic', 'https://api.anthropic.com/v1/').url, 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(req('openrouter', 'https://openrouter.ai/api/v1/').url, 'https://openrouter.ai/api/v1/models')
  assert.equal(req('ollama', 'http://localhost:11434', '').url, 'http://localhost:11434/api/tags')
  assert.deepEqual(req('ollama', 'http://localhost:11434', '').headers, {})
  assert.equal(req('lmstudio', 'http://localhost:1234/v1', '').url, 'http://localhost:1234/api/v0/models')
  assert.equal(req('custom', 'https://llm.example.com/v1').url, 'https://llm.example.com/v1/models')
})

test('model lists are parsed for each type, with context windows where the AI Provider gives them', async () => {
  const { mod } = await fresh()
  assert.deepEqual(mod.parseModels('anthropic', { data: [{ id: 'claude-b', max_input_tokens: 200000, max_tokens: 8192 }, { id: 'claude-a', max_input_tokens: 1000000 }] }), [
    { id: 'claude-a', contextWindow: 1000000, maxOutput: null },
    { id: 'claude-b', contextWindow: 200000, maxOutput: 8192 },
  ])
  assert.deepEqual(mod.parseModels('openrouter', { data: [{ id: 'openai/gpt-5', context_length: 400000, top_provider: { max_completion_tokens: 128000 } }, { id: 'x/y' }] }), [
    { id: 'openai/gpt-5', contextWindow: 400000, maxOutput: 128000 },
    { id: 'x/y', contextWindow: null, maxOutput: null },
  ])
  assert.deepEqual(mod.parseModels('ollama', { models: [{ name: 'llama3.1:8b' }, { name: 'qwen3:4b' }] }), [
    { id: 'llama3.1:8b', contextWindow: null, maxOutput: null },
    { id: 'qwen3:4b', contextWindow: null, maxOutput: null },
  ])
  assert.deepEqual(
    mod.parseModels('lmstudio', { data: [{ id: 'nomic', type: 'embeddings', max_context_length: 2048 }, { id: 'gemma', type: 'llm', max_context_length: 131072, loaded_context_length: 32768 }, { id: 'qwen', type: 'llm', max_context_length: 40960 }] }),
    [
      { id: 'gemma', contextWindow: 32768, maxOutput: null },
      { id: 'qwen', contextWindow: 40960, maxOutput: null },
    ]
  )
  assert.deepEqual(mod.parseModels('openai', { data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }] }), [{ id: 'gpt-5', contextWindow: null, maxOutput: null }])
  assert.deepEqual(mod.parseModels('custom', { data: [{ id: 'local-model' }] }), [{ id: 'local-model', contextWindow: null, maxOutput: null }])
  assert.deepEqual(mod.parseModels('anthropic', null), [])
  assert.equal(mod.parseOllamaContextWindow({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } }), 131072)
  assert.equal(mod.parseOllamaContextWindow({ model_info: {} }), null)
})

// #346 (parent #343): a reply drafting several long Fields runs past 4,096 output tokens, so a new AI Provider starts at 16,000, less where
// its type or the chosen model is known to allow less. A Custom one starts blank: a compatible server may refuse a limit above its own, and
// left out, the server's own limit applies. Saved AI Providers keep what they have.
test('#346: a new AI Provider starts with room to draft several Fields in one reply, and less where its type or model allows less', async () => {
  const { mod } = await fresh()
  assert.equal(mod.DEFAULT_MAX_TOKENS, 16000)
  for (const type of ['anthropic', 'openai', 'openrouter', 'ollama', 'lmstudio']) {
    assert.equal(mod.aiProviderType(type).defaultMaxTokens, 16000, type)
    assert.equal(mod.suggestedMaxTokens({ type, model: '' }), 16000, type)
  }
  assert.equal(mod.aiProviderType('custom').defaultMaxTokens, null, 'a compatible server may refuse a limit above its own')
  assert.equal(mod.suggestedMaxTokens({ type: 'custom', model: 'big' }, { id: 'big', maxOutput: 8192 }), null)

  // A model the list says allows less gets what it allows; one that allows more still starts at 16,000.
  assert.equal(mod.suggestedMaxTokens({ type: 'anthropic', model: 'claude-old' }, { id: 'claude-old', maxOutput: 8192 }), 8192)
  assert.equal(mod.suggestedMaxTokens({ type: 'anthropic', model: 'claude-new' }, { id: 'claude-new', maxOutput: 128000 }), 16000)
  assert.equal(mod.suggestedMaxTokens({ type: 'openrouter', model: 'x/y' }, { id: 'x/y', maxOutput: 4096 }), 4096)
  assert.equal(mod.suggestedMaxTokens({ type: 'openrouter', model: 'x/y' }, { id: 'x/y', maxOutput: null }), 16000)

  // OpenAI's list says nothing about output limits, but its older chat models stop at 4,096 and refuse more.
  for (const model of ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'gpt-4-0125-preview', 'gpt-4o-2024-05-13']) assert.equal(mod.suggestedMaxTokens({ type: 'openai', model }), 4096, model)
  for (const model of ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'o3']) assert.equal(mod.suggestedMaxTokens({ type: 'openai', model }), 16000, model)

  // Saved AI Providers keep their setting, blank included: nothing rewrites them.
  assert.equal(mod.normaliseAiProvider({ type: 'anthropic', maxTokens: 4096 }).maxTokens, 4096)
  assert.equal(mod.normaliseAiProvider({ type: 'anthropic' }).maxTokens, null)
})

test('the context window is filled in for Anthropic, OpenRouter, Ollama and LM Studio, and a default is used otherwise', async () => {
  const { mod } = await fresh()
  for (const id of ['anthropic', 'openrouter', 'ollama', 'lmstudio']) {
    assert.ok(mod.aiProviderType(id).contextWindowFrom, id)
  }
  for (const id of ['openai', 'custom']) assert.equal(mod.aiProviderType(id).contextWindowFrom, null, id)
  const p = mod.normaliseAiProvider({ type: 'custom' })
  assert.equal(p.contextWindow, mod.aiProviderType('custom').defaultContextWindow)
  assert.ok(p.contextWindow > 0)
})

// ---------- calling ----------

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('a local model on this computer is called straight from the browser; everything else goes through the relay', async () => {
  const { mod } = await fresh()
  const ollama = mod.normaliseAiProvider({ type: 'ollama', address: 'http://localhost:11434', name: 'Local' })
  assert.equal(ollama.runsOn, 'browser')
  assert.equal(mod.callsFromBrowser(ollama), true)
  const direct = fakeFetch(() => json(200, { models: [{ name: 'llama3.1:8b' }] }))
  assert.deepEqual(await mod.fetchModels(ollama, { fetchImpl: direct.fetchImpl }), [{ id: 'llama3.1:8b', contextWindow: null, maxOutput: null }])
  assert.deepEqual(direct.calls.map((c) => c.url), ['http://localhost:11434/api/tags'])

  const onServer = { ...ollama, runsOn: 'server' }
  assert.equal(mod.callsFromBrowser(onServer), false)
  const relayed = fakeFetch(() => json(200, { models: [] }))
  await mod.fetchModels(onServer, { fetchImpl: relayed.fetchImpl })
  assert.equal(relayed.calls[0].url, '/api/ai/relay')
  assert.equal(JSON.parse(relayed.calls[0].init.body).url, 'http://localhost:11434/api/tags')

  const anthropic = mod.normaliseAiProvider({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'sk-ant-9', name: 'A' })
  assert.equal(mod.callsFromBrowser(anthropic), false)
  const viaRelay = fakeFetch(() => json(200, { data: [{ id: 'claude-x', max_input_tokens: 200000 }] }))
  assert.deepEqual(await mod.fetchModels(anthropic, { fetchImpl: viaRelay.fetchImpl }), [{ id: 'claude-x', contextWindow: 200000, maxOutput: null }])
  const envelope = JSON.parse(viaRelay.calls[0].init.body)
  assert.equal(viaRelay.calls[0].url, '/api/ai/relay')
  assert.equal(envelope.headers['x-api-key'], 'sk-ant-9')
  assert.equal(envelope.url, 'https://api.anthropic.com/v1/models?limit=1000')
})

test('a local model the browser cannot reach is explained, naming OLLAMA_ORIGINS or LM Studio’s CORS setting', async () => {
  const { mod } = await fresh()
  const blocked = fakeFetch(() => {
    throw new TypeError('Failed to fetch')
  })
  const ollama = mod.normaliseAiProvider({ type: 'ollama', address: 'http://localhost:11434', name: 'Local' })
  await assert.rejects(
    () => mod.fetchModels(ollama, { fetchImpl: blocked.fetchImpl, origin: 'https://gantry.example.com' }),
    (err) => err.code === 'blocked' && err.message.includes('OLLAMA_ORIGINS') && err.message.includes('https://gantry.example.com')
  )
  const lm = mod.normaliseAiProvider({ type: 'lmstudio', address: 'http://localhost:1234/v1', name: 'LM' })
  await assert.rejects(
    () => mod.fetchModels(lm, { fetchImpl: blocked.fetchImpl, origin: 'https://gantry.example.com' }),
    (err) => err.code === 'blocked' && /CORS/.test(err.message) && /LM Studio/.test(err.message)
  )
})

test('a rejected key, a refused address and an unreachable relay each say what happened', async () => {
  const { mod } = await fresh()
  const p = mod.normaliseAiProvider({ type: 'openai', address: 'https://api.openai.com/v1', key: 'bad', name: 'OpenAI' })
  await assert.rejects(() => mod.fetchModels(p, { fetchImpl: fakeFetch(() => json(401, { error: { message: 'Incorrect API key' } })).fetchImpl }), (e) => e.code === 'key-rejected' && /Incorrect API key/.test(e.message))
  await assert.rejects(
    () => mod.fetchModels(p, { fetchImpl: fakeFetch(() => json(400, { error: 'ai_address_refused', message: 'set GANTRY_AI_ALLOW_PRIVATE_URLS' })).fetchImpl }),
    (e) => e.code === 'address-refused' && /GANTRY_AI_ALLOW_PRIVATE_URLS/.test(e.message)
  )
  await assert.rejects(() => mod.fetchModels(p, { fetchImpl: fakeFetch(() => { throw new TypeError('x') }).fetchImpl }), (e) => e.code === 'relay-unreachable')
  await assert.rejects(() => mod.fetchModels(p, { fetchImpl: fakeFetch(() => json(500, null)).fetchImpl }), (e) => e.code === 'failed')
})

test('Ollama’s context window is read from /api/show', async () => {
  const { mod } = await fresh()
  const ollama = mod.normaliseAiProvider({ type: 'ollama', address: 'http://localhost:11434', name: 'Local' })
  const f = fakeFetch(() => json(200, { model_info: { 'llama.context_length': 131072 } }))
  assert.equal(await mod.fetchOllamaContextWindow(ollama, 'llama3.1:8b', { fetchImpl: f.fetchImpl }), 131072)
  assert.equal(f.calls[0].url, 'http://localhost:11434/api/show')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { model: 'llama3.1:8b' })
})

test('the model list is only fetched once the address, and a key where one is needed, are entered', async () => {
  const { mod } = await fresh()
  assert.equal(mod.canFetchModels({ type: 'anthropic', address: 'https://api.anthropic.com', key: '' }), false)
  assert.equal(mod.canFetchModels({ type: 'anthropic', address: 'https://api.anthropic.com', key: 'k' }), true)
  assert.equal(mod.canFetchModels({ type: 'ollama', address: 'http://localhost:11434', key: '' }), true)
  assert.equal(mod.canFetchModels({ type: 'custom', address: '', key: 'k' }), false)
  assert.equal(mod.canFetchModels({ type: 'custom', address: 'nonsense', key: 'k' }), false)
})
