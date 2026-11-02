import { signal } from '@preact/signals'

// #277 (parent #238, docs/adr/0061-ai-providers-belong-to-the-browser.md): the architect's AI Providers.
//
// One list per browser, used in every workspace. Keys are held in this browser's localStorage the way
// Workspace PATs are (web/lib/credential.js) and are sent with each request that needs them; `gantry serve`
// never stores them (lib/aiRelay.js is a pass-through). That is a deliberate exception to ADR-0038: an AI
// key is only ever sent to the address of the AI Provider it was entered for, whatever the workspace.
//
// This module owns four things, kept together because they change together:
//   1. what each AI Provider *type* is (its default address, whether a key is needed, how to list its models);
//   2. the stored list, with the rule that exactly one AI Provider is the Default;
//   3. validation of what the Settings dialog collects;
//   4. how a call is made: straight from the browser for a local model on this computer, otherwise through
//      `gantry serve`'s relay.
// It has no DOM or network dependency beyond a guarded `localStorage` and an injectable `fetch`, so the unit
// tests drive all of it directly.

const STORAGE_KEY = 'gantry:ai-providers'

/** Used when an AI Provider doesn't say how big a model's context window is. */
export const DEFAULT_CONTEXT_WINDOW = 32000

export const REASONING_EFFORTS = ['low', 'medium', 'high']

/**
 * The six types ADR-0061 offers. `local` types say where they run (this computer or the Gantry server);
 * `keyRequired` is false only for those. `contextWindowFrom` says where Gantry can read a model's context
 * window, or null when the type can't say and `defaultContextWindow` applies.
 */
export const AI_PROVIDER_TYPES = [
  { id: 'openai', label: 'OpenAI', defaultAddress: 'https://api.openai.com/v1', keyRequired: true, local: false, contextWindowFrom: null, defaultContextWindow: 128000 },
  { id: 'anthropic', label: 'Anthropic', defaultAddress: 'https://api.anthropic.com', keyRequired: true, local: false, contextWindowFrom: 'the model list', defaultContextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'ollama', label: 'Ollama', defaultAddress: 'http://localhost:11434', keyRequired: false, local: true, contextWindowFrom: 'the model', defaultContextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'lmstudio', label: 'LM Studio', defaultAddress: 'http://localhost:1234/v1', keyRequired: false, local: true, contextWindowFrom: 'the model list', defaultContextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'openrouter', label: 'OpenRouter', defaultAddress: 'https://openrouter.ai/api/v1', keyRequired: true, local: false, contextWindowFrom: 'the model list', defaultContextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', defaultAddress: '', keyRequired: true, local: false, contextWindowFrom: null, defaultContextWindow: DEFAULT_CONTEXT_WINDOW },
]

export function aiProviderType(typeId) {
  return AI_PROVIDER_TYPES.find((t) => t.id === typeId) ?? null
}

/** Where a local AI Provider runs. */
export const RUNS_ON = { browser: 'This computer', server: 'The Gantry server' }

// ---------- the stored list ----------

function safeGetItem(key) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Ignore: storage blocked by the browser must never take the app down (see web/lib/credential.js).
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Coerces anything read from storage (or a dialog) into the one shape the rest of the app relies on. */
export function normaliseAiProvider(raw) {
  const type = aiProviderType(raw?.type) ? raw.type : 'custom'
  const typeInfo = aiProviderType(type)
  const advanced = raw?.advanced && typeof raw.advanced === 'object' ? raw.advanced : {}
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw?.name === 'string' ? raw.name : '',
    type,
    address: typeof raw?.address === 'string' ? raw.address : typeInfo.defaultAddress,
    key: typeof raw?.key === 'string' ? raw.key : '',
    model: typeof raw?.model === 'string' ? raw.model : '',
    runsOn: typeInfo.local ? (raw?.runsOn === 'server' ? 'server' : 'browser') : null,
    temperature: numberOrNull(raw?.temperature),
    maxTokens: numberOrNull(raw?.maxTokens),
    contextWindow: numberOrNull(raw?.contextWindow) ?? typeInfo.defaultContextWindow,
    // Whether the architect typed the context window themselves. While false, choosing a model refreshes it
    // from what the AI Provider says; once true it is left alone.
    contextWindowEdited: raw?.contextWindowEdited === true,
    advanced: {
      topP: numberOrNull(advanced.topP),
      topK: numberOrNull(advanced.topK),
      minP: numberOrNull(advanced.minP),
      frequencyPenalty: numberOrNull(advanced.frequencyPenalty),
      presencePenalty: numberOrNull(advanced.presencePenalty),
      stop: Array.isArray(advanced.stop) ? advanced.stop.filter((s) => typeof s === 'string' && s !== '') : [],
      reasoningEffort: REASONING_EFFORTS.includes(advanced.reasoningEffort) ? advanced.reasoningEffort : '',
    },
    isDefault: raw?.isDefault === true,
    // The result of the last Test connection (web/lib/aiClient.js writes it); null means untested.
    test: raw?.test && typeof raw.test === 'object' ? raw.test : null,
  }
}

function newId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    // fall through
  }
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Exactly one Default when there is at least one AI Provider: the first marked one, else the first. */
export function withExactlyOneDefault(list) {
  if (list.length === 0) return list
  const index = Math.max(0, list.findIndex((p) => p.isDefault))
  return list.map((p, i) => (p.isDefault === (i === index) ? p : { ...p, isDefault: i === index }))
}

function readStoredList() {
  const raw = safeGetItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return withExactlyOneDefault(parsed.filter((p) => p && typeof p === 'object').map(normaliseAiProvider))
  } catch {
    return []
  }
}

/** Every AI Provider in this browser, in the order they were added. */
export const aiProviders = signal(readStoredList())

function commit(list) {
  const next = withExactlyOneDefault(list)
  aiProviders.value = next
  safeSetItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function getAiProvider(id) {
  return aiProviders.value.find((p) => p.id === id) ?? null
}

/** The AI Provider the Interview page pre-selects, or null when none has been added yet. */
export function defaultAiProvider() {
  return aiProviders.value.find((p) => p.isDefault) ?? null
}

/** Adds an AI Provider. The first one added is the Default; `makeDefault` makes a later one the Default. */
export function addAiProvider(draft, { makeDefault = false } = {}) {
  const provider = normaliseAiProvider({ ...draft, id: undefined, test: null, isDefault: makeDefault })
  const list = aiProviders.value.map((p) => (makeDefault ? { ...p, isDefault: false } : p))
  commit([...list, provider])
  return getAiProvider(provider.id)
}

/** True when changing from `before` to `after` invalidates a Test connection result. */
export function changeMarksUntested(before, after) {
  return before.type !== after.type || before.address !== after.address || before.model !== after.model
}

/**
 * Applies the dialog's values to an AI Provider. Changing the Type, Address or Model marks it untested
 * (clears the stored test result); nothing else does.
 */
export function updateAiProvider(id, changes, { makeDefault } = {}) {
  const before = getAiProvider(id)
  if (!before) return null
  const merged = normaliseAiProvider({ ...before, ...changes, id })
  const after = changeMarksUntested(before, merged) ? { ...merged, test: null } : merged
  commit(
    aiProviders.value.map((p) => {
      if (p.id === id) return { ...after, isDefault: makeDefault === true ? true : makeDefault === false ? false : p.isDefault }
      return makeDefault === true ? { ...p, isDefault: false } : p
    })
  )
  return getAiProvider(id)
}

/** Makes one AI Provider the Default (and so every other one not). */
export function setDefaultAiProvider(id) {
  if (!getAiProvider(id)) return
  commit(aiProviders.value.map((p) => ({ ...p, isDefault: p.id === id })))
}

/** Deletes an AI Provider. Deleting the Default makes the first remaining one the Default. */
export function deleteAiProvider(id) {
  commit(aiProviders.value.filter((p) => p.id !== id))
}

/** What the table's Status column says. Test connection stores the result. */
export function aiProviderStatusLabel(provider) {
  const status = provider.test?.status
  if (status === 'passed') return { label: 'Ready', tone: 'agreed' }
  if (status === 'failed') return { label: 'Failed', tone: 'error' }
  return { label: 'Untested', tone: 'draft' }
}

/**
 * Stores a Test connection result with its AI Provider (#278). Written only if the Type, Address and Model are
 * still what they were when the test began, so a result for an AI Provider the architect has since edited is
 * dropped rather than shown against the wrong settings. Returns the updated AI Provider, or null.
 */
export function setAiProviderTest(id, result, tested) {
  const current = getAiProvider(id)
  if (!current) return null
  if (tested && changeMarksUntested(tested, current)) return null
  commit(aiProviders.value.map((p) => (p.id === id ? { ...p, test: result } : p)))
  return getAiProvider(id)
}

/** What the table's Reads images column says. */
export function aiProviderReadsImagesLabel(provider) {
  const reads = provider.test?.readsImages
  if (reads === true) return 'Yes'
  if (reads === false) return 'No'
  return '—'
}

/** What the table's Question cards column says. */
export function aiProviderQuestionCardsLabel(provider) {
  const mode = provider.test?.questionCards
  if (mode === 'native') return 'Native'
  if (mode === 'text') return 'Text fallback'
  return '—'
}

// ---------- validation ----------

function positiveInt(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Checks what the dialog collected. Returns `{ field: message }`, empty when it is fine. `others` is every
 * other AI Provider (to keep names distinct).
 */
export function validateAiProviderDraft(draft, others = []) {
  const errors = {}
  const type = aiProviderType(draft.type)
  if (!draft.name?.trim()) errors.name = 'Give this AI Provider a name.'
  else if (others.some((p) => p.name.trim().toLowerCase() === draft.name.trim().toLowerCase())) errors.name = 'Another AI Provider already has this name.'
  if (!type) errors.type = 'Choose a type.'
  const address = draft.address?.trim() ?? ''
  if (!address) errors.address = 'Enter the address of the AI Provider.'
  else {
    let parsed = null
    try {
      parsed = new URL(address)
    } catch {
      // handled below
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) errors.address = 'The address must start with http:// or https://.'
    else if (parsed.username || parsed.password) errors.address = 'Leave the user name and password out of the address; use the Key field.'
  }
  if (type?.keyRequired && !draft.key?.trim()) errors.key = `${type.label} needs a key.`
  const temperature = numberOrNull(draft.temperature)
  if (draft.temperature !== null && draft.temperature !== undefined && draft.temperature !== '' && (temperature === null || temperature < 0 || temperature > 2)) {
    errors.temperature = 'Temperature is a number from 0 to 2.'
  }
  const maxTokens = numberOrNull(draft.maxTokens)
  if (draft.maxTokens !== null && draft.maxTokens !== undefined && draft.maxTokens !== '' && !positiveInt(maxTokens)) errors.maxTokens = 'Max tokens is a whole number above 0.'
  const contextWindow = numberOrNull(draft.contextWindow)
  if (!positiveInt(contextWindow)) errors.contextWindow = 'Context window is a whole number of tokens above 0.'
  const adv = draft.advanced ?? {}
  const checkRange = (key, label, min, max) => {
    const raw = adv[key]
    if (raw === null || raw === undefined || raw === '') return
    const n = numberOrNull(raw)
    if (n === null || n < min || n > max) errors[key] = `${label} is a number from ${min} to ${max}.`
  }
  checkRange('topP', 'top_p', 0, 1)
  checkRange('minP', 'min_p', 0, 1)
  checkRange('frequencyPenalty', 'Frequency penalty', -2, 2)
  checkRange('presencePenalty', 'Presence penalty', -2, 2)
  const topK = adv.topK
  if (topK !== null && topK !== undefined && topK !== '' && !positiveInt(numberOrNull(topK))) errors.topK = 'top_k is a whole number above 0.'
  return errors
}

// ---------- calling an AI Provider ----------

/** Thrown for a call that failed in a way the architect can act on. `code` is stable; `message` is for people. */
export class AiProviderError extends Error {
  constructor(code, message, status, { retryAfter = null } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

/** The codes a person can fix mid-call: a rejected key (enter another), no credit left or a rate limit (retry). */
export const RECOVERABLE_CODES = ['key-rejected', 'rate-limited', 'out-of-credit']

/** True when the browser calls this AI Provider itself: a local model that runs on this computer. */
export function callsFromBrowser(provider) {
  return aiProviderType(provider.type)?.local === true && provider.runsOn !== 'server'
}

function stripTrailing(address, ...suffixes) {
  let out = address.trim().replace(/\/+$/, '')
  for (const suffix of suffixes) {
    if (out.toLowerCase().endsWith(suffix)) {
      out = out.slice(0, -suffix.length)
      break
    }
  }
  return out
}

/** The request headers for `provider`'s key, in the form its type expects. */
export function authHeaders(provider) {
  const key = provider.key?.trim()
  if (provider.type === 'anthropic') {
    return { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
  }
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/** The request that lists this AI Provider's models. */
export function modelsRequest(provider) {
  const address = provider.address.trim()
  switch (provider.type) {
    case 'anthropic':
      return { url: `${stripTrailing(address, '/v1')}/v1/models?limit=1000`, method: 'GET', headers: authHeaders(provider) }
    case 'ollama':
      return { url: `${stripTrailing(address, '/v1', '/api')}/api/tags`, method: 'GET', headers: authHeaders(provider) }
    case 'lmstudio':
      // LM Studio's own listing carries each model's context window; the OpenAI-style one doesn't.
      return { url: `${stripTrailing(address, '/v1')}/api/v0/models`, method: 'GET', headers: authHeaders(provider) }
    default:
      return { url: `${stripTrailing(address)}/models`, method: 'GET', headers: authHeaders(provider) }
  }
}

const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|image|audio/i

/** Turns a model-list response body into `[{ id, contextWindow }]`, sorted by id. `contextWindow` is null when unsaid. */
export function parseModels(type, body) {
  const data = Array.isArray(body?.data) ? body.data : []
  let models = []
  if (type === 'ollama') {
    models = (Array.isArray(body?.models) ? body.models : []).map((m) => ({ id: m?.name ?? m?.model, contextWindow: null }))
  } else if (type === 'anthropic') {
    models = data.map((m) => ({ id: m?.id, contextWindow: numberOrNull(m?.max_input_tokens) }))
  } else if (type === 'openrouter') {
    models = data.map((m) => ({ id: m?.id, contextWindow: numberOrNull(m?.context_length) }))
  } else if (type === 'lmstudio') {
    models = data
      .filter((m) => m?.type !== 'embeddings')
      .map((m) => ({ id: m?.id, contextWindow: numberOrNull(m?.loaded_context_length) ?? numberOrNull(m?.max_context_length) }))
  } else if (type === 'openai') {
    models = data.filter((m) => typeof m?.id === 'string' && !NON_CHAT_MODEL.test(m.id)).map((m) => ({ id: m.id, contextWindow: null }))
  } else {
    models = data.map((m) => ({ id: m?.id, contextWindow: numberOrNull(m?.context_length) ?? numberOrNull(m?.context_window) }))
  }
  return models.filter((m) => typeof m.id === 'string' && m.id).sort((a, b) => a.id.localeCompare(b.id))
}

/** Ollama's `POST /api/show` request for one model: the only place it states the context length. */
export function ollamaShowRequest(provider, model) {
  return {
    url: `${stripTrailing(provider.address, '/v1', '/api')}/api/show`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
    body: { model },
  }
}

/** Reads the context length out of an Ollama `/api/show` body (`model_info["<architecture>.context_length"]`). */
export function parseOllamaContextWindow(body) {
  const info = body?.model_info
  if (!info || typeof info !== 'object') return null
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length')) return numberOrNull(value)
  }
  return null
}

function errorMessageFromBody(body) {
  if (!body || typeof body !== 'object') return null
  if (typeof body.message === 'string') return body.message
  if (typeof body.error === 'string') return body.error
  if (body.error && typeof body.error.message === 'string') return body.error.message
  return null
}

/** What to tell the architect when the browser couldn't reach a local model on this computer. */
export function blockedLocalMessage(provider, origin) {
  const where = origin || 'this page’s address'
  if (provider.type === 'ollama') {
    return (
      `Your browser couldn’t reach Ollama at ${provider.address}. If Ollama is running, it is probably refusing requests from this page. ` +
      `Set OLLAMA_ORIGINS to include ${where} (for example OLLAMA_ORIGINS=${origin || 'https://your-gantry-address'}) and restart Ollama. ` +
      `If it isn’t running yet, start it first.`
    )
  }
  return (
    `Your browser couldn’t reach LM Studio at ${provider.address}. If LM Studio’s server is running, it is probably refusing requests from this page. ` +
    `Turn on CORS in LM Studio’s server settings (Developer tab, "Enable CORS"), allow ${where}, and restart the server. ` +
    `If the server isn’t started yet, start it first.`
  )
}

/**
 * Makes one call to an AI Provider and returns the `fetch` Response. A local model on this computer is called
 * straight from the browser (its address means *this* computer); everything else goes through `gantry serve`'s
 * relay, which forwards it and never stores the key. The relay answers its own refusals as JSON with a
 * `message`, which `readJsonOrThrow` surfaces.
 */
export async function callAiProvider(provider, request, { fetchImpl = globalThis.fetch, origin = globalThis.location?.origin, signal } = {}) {
  const wireBody = request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
  if (callsFromBrowser(provider)) {
    try {
      return await fetchImpl(request.url, { method: request.method, headers: request.headers, body: wireBody, signal })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new AiProviderError('blocked', blockedLocalMessage(provider, origin))
    }
  }
  let res
  try {
    res = await fetchImpl('/api/ai/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: request.url, method: request.method, headers: request.headers, body: wireBody }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new AiProviderError('relay-unreachable', 'Could not reach the Gantry server to make this call.')
  }
  return res
}

const OUT_OF_CREDIT = /credit balance|insufficient[ _](funds|credit|quota|balance)|out of credits?|payment required|billing|exceeded your current quota|add (more )?credits?/i

function errorCodeFromBody(body) {
  if (!body || typeof body !== 'object') return ''
  const e = body.error
  if (e && typeof e === 'object') return String(e.code ?? e.type ?? '')
  return typeof e === 'string' ? e : ''
}

/**
 * Turns a failed answer from an AI Provider into the `AiProviderError` that says what to do (#278):
 *   key-rejected  401/403, or an `authentication_error`           -> ask for a key and resend
 *   out-of-credit 402, or a credit/quota message on 400/402/429  -> offer Retry
 *   rate-limited  429, 503, 529 and "overloaded"                  -> offer Retry
 *   address-refused  the relay's own refusal of a private address
 *   model-not-found  404 or a "model ... not found" message
 *   failed        anything else
 * `status` may be 0 when the failure arrived inside a stream, where only the body's error type is known.
 */
export function classifyFailure(status, body, provider, { retryAfter = null } = {}) {
  const detail = errorMessageFromBody(body)
  const code = errorCodeFromBody(body)
  const name = provider?.name || provider?.type || 'The AI Provider'
  const creditSaid = OUT_OF_CREDIT.test(`${detail ?? ''} ${code}`)
  if (code === 'ai_address_refused') return new AiProviderError('address-refused', detail, status)
  if (status === 401 || status === 403 || /authentication_error|permission_error|invalid_api_key/.test(code)) {
    return new AiProviderError('key-rejected', `${name} rejected the key${detail ? `: ${detail}` : '.'}`, status)
  }
  if (status === 402 || ((status === 400 || status === 429 || status === 0) && creditSaid)) {
    return new AiProviderError('out-of-credit', `${name} says there is no credit left${detail ? `: ${detail}` : '.'} Add credit with them, then retry.`, status)
  }
  if (status === 429 || status === 503 || status === 529 || /rate_limit|overloaded/.test(code)) {
    const wait = retryAfter ? ` Try again in about ${retryAfter} second${retryAfter === 1 ? '' : 's'}.` : ''
    return new AiProviderError('rate-limited', `${name} is limiting requests right now${detail ? `: ${detail}` : '.'}${wait}`, status, { retryAfter })
  }
  if (status === 404 || code === 'model_not_found' || (/model/i.test(detail ?? '') && /not found|does not exist|no such/i.test(detail ?? ''))) {
    return new AiProviderError('model-not-found', detail ?? `${name} doesn’t have that model.`, status)
  }
  return new AiProviderError('failed', detail ?? `The AI Provider answered ${status}.`, status)
}

function retryAfterSeconds(res) {
  const raw = res?.headers?.get?.('retry-after')
  const n = raw === null || raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null
}

/** Reads a non-OK `fetch` Response into the `AiProviderError` it stands for. */
export async function failureFromResponse(res, provider) {
  let body = null
  try {
    body = typeof res.text === 'function' ? JSON.parse(await res.text()) : await res.json()
  } catch {
    // a non-JSON error page: classified from the status alone
  }
  return classifyFailure(res.status, body, provider, { retryAfter: retryAfterSeconds(res) })
}

async function readJsonOrThrow(res, provider) {
  if (res.ok) return res.json().catch(() => null)
  throw await failureFromResponse(res, provider)
}

/**
 * Fetches the models this AI Provider offers: `[{ id, contextWindow }]`. Needs the address (and key, where the
 * type wants one) to be filled in. Throws an `AiProviderError` whose message says what to do.
 */
export async function fetchModels(provider, options = {}) {
  return (await fetchModelsRaw(provider, options)).models
}

/** Like `fetchModels`, but also returns the AI Provider's own answer (`body`), which Test connection reads hints from. */
export async function fetchModelsRaw(provider, options = {}) {
  const res = await callAiProvider(provider, modelsRequest(provider), options)
  if (!res.ok && provider.type === 'lmstudio' && (res.status === 404 || res.status === 405)) {
    // An older LM Studio without the native listing: fall back to the OpenAI-style one (no context windows).
    const fallback = await callAiProvider(provider, { url: `${stripTrailing(provider.address)}/models`, method: 'GET', headers: authHeaders(provider) }, options)
    const body = await readJsonOrThrow(fallback, provider)
    return { models: parseModels('custom', body), body, parsedAs: 'custom' }
  }
  const body = await readJsonOrThrow(res, provider)
  return { models: parseModels(provider.type, body), body, parsedAs: provider.type }
}

/** The context window Ollama states for one model, or null when it doesn't say. */
export async function fetchOllamaContextWindow(provider, model, options = {}) {
  const res = await callAiProvider(provider, ollamaShowRequest(provider, model), options)
  return parseOllamaContextWindow(await readJsonOrThrow(res, provider))
}

/** What to show next to the Context window field once a model is chosen. */
export function contextWindowSource(provider, knownContextWindow) {
  if (provider.contextWindowEdited) return 'You set this.'
  const type = aiProviderType(provider.type)
  if (knownContextWindow) return `Read from ${type?.label ?? 'the AI Provider'}.`
  return `A default — ${type?.label ?? 'this AI Provider'} doesn’t say. Change it if you know the model’s limit.`
}

/** True when an AI Provider can have its model list fetched: address filled in, and a key where one is needed. */
export function canFetchModels(draft) {
  const type = aiProviderType(draft.type)
  if (!type || !draft.address?.trim()) return false
  try {
    const u = new URL(draft.address.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  } catch {
    return false
  }
  return !type.keyRequired || Boolean(draft.key?.trim())
}
