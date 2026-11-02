// #278 (parent #238, docs/adr/0061 and 0065): the AI client every part of the AI interview talks through.
//
// What it gives the rest of the app:
//   * `streamChat`   one streamed call to any AI Provider, as the internal stream in web/lib/aiAdapters.js;
//   * `runTurn`      a whole turn: stream it, show text and a "preparing questions" placeholder as they come,
//                    then decide what it was (question cards, an invalid card, or chat) with the one-retry rule;
//   * `testConnection` / `testAndStore` / `ensureTested`  what Test connection checks, and keeping the result;
//   * `runWithRecovery`  a rejected key asks for a key and resends; a rate limit or no credit offers Retry.
//
// Calls reach the AI Provider through `callAiProvider` (web/lib/aiProviders.js): straight from the browser for
// a local model on this computer, otherwise through `gantry serve`'s relay. No DOM here, so the unit tests
// drive all of it with a fake `fetch`.
import {
  AiProviderError,
  RECOVERABLE_CODES,
  callAiProvider,
  failureFromResponse,
  fetchModelsRaw,
  getAiProvider,
  ollamaShowRequest,
  setAiProviderTest,
} from './aiProviders.js'
import { buildChatRequest, createParser, createSseReader, eventsFromCompleteResponse } from './aiAdapters.js'
import { ASK_TOOL, ASK_TOOL_NAME, TEXT_FALLBACK_INSTRUCTIONS, interpretTurn, startsQuestionBlock, stripQuestionBlock, validateCards } from './aiCards.js'

// ---------- streaming one call ----------

/**
 * One streamed call. An async generator of the internal events (text, tool-start, tool-call, usage, done).
 * `params` is `{ system, messages, tools, maxTokens }`; `options` is `{ fetchImpl, origin, signal }`.
 * Throws an `AiProviderError` for a call that failed, whose `code` says what to do about it.
 */
export async function* streamChat(provider, params, options = {}) {
  const request = buildChatRequest(provider, params)
  const res = await callAiProvider(provider, request, options)
  if (!res.ok) throw await failureFromResponse(res, provider)
  const type = res.headers?.get?.('content-type') ?? ''
  if (!res.body || (/json/i.test(type) && !/event-stream/i.test(type))) {
    // An endpoint that ignored `stream: true` and sent one JSON answer.
    const body = await res.json().catch(() => null)
    yield* eventsFromCompleteResponse(provider, body)
    return
  }
  const parser = createParser(provider)
  const sse = createSseReader()
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of sse.push(decoder.decode(value, { stream: true }))) yield* parser.feed(event)
    }
    for (const event of sse.push(decoder.decode())) yield* parser.feed(event)
    for (const event of sse.end()) yield* parser.feed(event)
    yield* parser.finish()
  } finally {
    try {
      await reader.cancel()
    } catch {
      // already closed
    }
  }
}

function addUsage(total, next) {
  return {
    inputTokens: total.inputTokens + (next.inputTokens ?? 0),
    outputTokens: total.outputTokens + (next.outputTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (next.cacheWriteTokens ?? 0),
  }
}

export const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** How the AI is asked for question cards, from what Test connection found. An untested AI Provider is tried natively. */
export function questionCardMode(provider) {
  return provider.test?.questionCards === 'text' ? 'text' : 'native'
}

// ---------- one turn ----------

/**
 * Runs one turn and says what it was.
 *
 * `input`: `{ system, messages, tools, knownSources }`. `tools` are the other tools to offer; `ask_architect` is
 * added unless the AI Provider's question cards are in text-fallback mode, when the fallback instructions are
 * added to the system prompt instead. `options`: `{ fetchImpl, origin, signal, onEvent }`.
 *
 * `onEvent` is told, as they happen: `{ type: 'text', delta, text }` (`text` is everything so far, with any
 * question block hidden), `{ type: 'preparing-questions' }` the moment a question call (or block) starts,
 * `{ type: 'retry', errors }` when an invalid card is going back to the model, and, for the caller's own tools,
 * `{ type: 'tool-start', id, name }` and `{ type: 'tool-call', call }` (#286). `input.askCards` (default true)
 * set to false offers no question cards.
 *
 * Returns `{ kind, ... }`:
 *   'cards'  `{ via: 'native'|'text', cards, text, otherToolCalls }`  show the cards only now they are complete
 *   'tools'  `{ otherToolCalls, text }`                                 only calls for the caller's own tools
 *   'chat'   `{ text, invalidCards? }`                                  nothing usable as a card: show it as chat
 * and always `usage`, `retried`, `assistantMessage` (what to append to the history) and `messages` (the history
 * to continue from: it includes the failed attempt and its error result when a card was sent back).
 * A card is shown only when its tool call is complete; an invalid one goes back to the model once.
 */
export async function runTurn(provider, { system = '', messages = [], tools = [], knownSources, askCards = true } = {}, options = {}) {
  const mode = questionCardMode(provider)
  // #286: `askCards: false` offers no question cards at all (the Interview page drafts and chats before the cards of #287 arrive).
  const fullSystem = mode === 'text' && askCards ? [system, TEXT_FALLBACK_INSTRUCTIONS].filter(Boolean).join('\n\n') : system
  const offered = mode === 'text' || !askCards ? tools : [ASK_TOOL, ...tools]
  let history = messages
  let usage = EMPTY_USAGE
  let retried = false
  for (;;) {
    let text = ''
    let announced = false
    const toolCalls = []
    for await (const event of streamChat(provider, { system: fullSystem, messages: history, tools: offered }, options)) {
      if (event.type === 'text') {
        text += event.text
        if (!announced && startsQuestionBlock(text)) {
          announced = true
          options.onEvent?.({ type: 'preparing-questions' })
        }
        options.onEvent?.({ type: 'text', delta: event.text, text: stripQuestionBlock(text) })
      } else if (event.type === 'tool-start') {
        if (event.name === ASK_TOOL_NAME && !announced) {
          announced = true
          options.onEvent?.({ type: 'preparing-questions' })
        } else if (event.name !== ASK_TOOL_NAME) {
          options.onEvent?.({ type: 'tool-start', id: event.id, name: event.name })
        }
      } else if (event.type === 'tool-call') {
        toolCalls.push(event)
        // #286: one of the caller's own tools is complete; the Interview page puts a drafted Field in the preview now.
        if (event.name !== ASK_TOOL_NAME) options.onEvent?.({ type: 'tool-call', call: event })
      } else if (event.type === 'usage') {
        usage = addUsage(usage, event)
      }
    }
    const turn = interpretTurn({ text, toolCalls }, { knownSources })
    const otherToolCalls = toolCalls.filter((c) => c.name !== ASK_TOOL_NAME)
    const assistantWith = (calls) => ({ role: 'assistant', text, ...(calls.length ? { toolCalls: calls.map(({ id, name, input }) => ({ id, name, input: input ?? {} })) } : {}) })

    if (turn.kind === 'invalid' && !retried) {
      // The error result goes back to the model once, so it can correct itself. Other calls in the same turn
      // still need an answer for the history to stay well formed; the caller's tools are not run on a retry.
      retried = true
      options.onEvent?.({ type: 'retry', errors: turn.errors })
      const answered = new Set(turn.results.map((r) => r.toolCallId))
      const skipped = otherToolCalls
        .filter((c) => !answered.has(c.id))
        .map((c) => ({ toolCallId: c.id, name: c.name, isError: true, content: 'Not run: the question card in the same turn was invalid. Call it again with the card.' }))
      history = [...history, assistantWith(toolCalls), ...[...turn.results, ...skipped].map((r) => ({ role: 'tool', ...r }))]
      continue
    }
    if (turn.kind === 'cards') {
      const calls = [...turn.calls, ...otherToolCalls]
      return { kind: 'cards', via: turn.via, cards: turn.cards, text: turn.text, otherToolCalls, usage, retried, assistantMessage: assistantWith(calls), messages: history }
    }
    if (turn.kind === 'invalid') {
      // Still invalid after the one retry: the turn shows as chat. The failed card is left out of the history.
      return { kind: 'chat', text: turn.text, invalidCards: turn.errors, usage, retried, assistantMessage: assistantWith(otherToolCalls), otherToolCalls, messages: history }
    }
    if (otherToolCalls.length) {
      return { kind: 'tools', text: turn.text, otherToolCalls, usage, retried, assistantMessage: assistantWith(otherToolCalls), messages: history }
    }
    return { kind: 'chat', text: turn.text, ...(turn.invalidBlock ? { invalidCards: turn.invalidBlock } : {}), usage, retried, assistantMessage: assistantWith([]), otherToolCalls: [], messages: history }
  }
}

// ---------- recovering from a failed call ----------

/**
 * Runs `attempt()` and recovers from the failures a person can fix, then runs it again (#244 item 7):
 *   * a rejected key: `askForKey(error)` shows the inline key prompt and resolves with the key once it is entered
 *     (and has stored it), or with null to give up. The same request is then sent again;
 *   * a rate limit or no credit left: `askToRetry(error)` shows a Retry button and resolves true to retry.
 * `attempt` must read the AI Provider afresh each time (`getAiProvider(id)`) so it sees the new key. Any other
 * failure, and a refusal to recover, is thrown. Nothing is lost on a pause because only confirmed stage summaries
 * are ever saved.
 */
export async function runWithRecovery(attempt, { askForKey, askToRetry, maxRecoveries = 50 } = {}) {
  for (let recoveries = 0; ; recoveries++) {
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof AiProviderError) || !RECOVERABLE_CODES.includes(err.code) || recoveries >= maxRecoveries) throw err
      if (err.code === 'key-rejected') {
        if (!askForKey || !(await askForKey(err))) throw err
      } else if (!askToRetry || !(await askToRetry(err))) {
        throw err
      }
    }
  }
}

// ---------- Test connection ----------

// A 64 x 64 solid red PNG: what the image probe shows the model.
const RED_SQUARE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg=='

/** The check that a model can ask a card through the streaming adapter: one small call with the real tool. */
const CARD_PROBE = {
  system: 'This is a connection test. Do not explain anything.',
  messages: [{ role: 'user', text: 'Call the ask_architect tool once with a single question "Which colour?", the options "Red" and "Blue", recommended "Red" and a one-line reason.' }],
  maxTokens: 2048,
}

/** The check that a model can read an image. */
const IMAGE_PROBE = {
  system: 'This is a connection test.',
  messages: [{ role: 'user', text: 'What colour is this square? Answer with one word.', images: [{ mediaType: 'image/png', data: RED_SQUARE_PNG }] }],
  maxTokens: 2048,
}

// What the models list (or Ollama's /api/show) says about a model, where the AI Provider publishes it:
// { tools, images } each true / false / null (unsaid).
function modelHints(type, body, modelId) {
  const entries = Array.isArray(body?.data) ? body.data : []
  const entry = entries.find((m) => m?.id === modelId)
  const hints = { tools: null, images: null }
  if (!entry) return hints
  if (type === 'anthropic') {
    hints.tools = true
    if (typeof entry.capabilities?.image_input?.supported === 'boolean') hints.images = entry.capabilities.image_input.supported
  } else if (type === 'openrouter') {
    if (Array.isArray(entry.supported_parameters)) hints.tools = entry.supported_parameters.includes('tools')
    const modalities = entry.architecture?.input_modalities
    if (Array.isArray(modalities)) hints.images = modalities.includes('image')
  } else if (type === 'lmstudio') {
    const caps = Array.isArray(entry.capabilities) ? entry.capabilities : null
    if (typeof entry.trained_for_tool_use === 'boolean') hints.tools = entry.trained_for_tool_use
    else if (caps) hints.tools = caps.includes('tool_use')
    if (entry.type === 'vlm' || caps?.includes('vision')) hints.images = true
    else if (entry.type === 'llm') hints.images = false
  }
  return hints
}

function ollamaHints(showBody) {
  const caps = showBody?.capabilities
  if (!Array.isArray(caps)) return { tools: null, images: null }
  return { tools: caps.includes('tools'), images: caps.includes('vision') }
}

// An error status that means "this model/endpoint doesn't do that" rather than "something went wrong".
const NOT_SUPPORTED_STATUS = [400, 404, 405, 415, 422, 501]

function notSupported(err) {
  return err instanceof AiProviderError && (err.code === 'failed' || err.code === 'model-not-found') && NOT_SUPPORTED_STATUS.includes(err.status)
}

async function collect(provider, params, options) {
  let text = ''
  const toolCalls = []
  for await (const event of streamChat(provider, params, options)) {
    if (event.type === 'text') text += event.text
    else if (event.type === 'tool-call') toolCalls.push(event)
  }
  return { text, toolCalls }
}

function hasModel(models, wanted, type) {
  return models.some((m) => m.id === wanted || (type === 'ollama' && m.id === `${wanted}:latest`))
}

/**
 * Checks an AI Provider, in order: key accepted, model exists, question cards (the metadata hint where the AI
 * Provider publishes one, then an authoritative probe call), and whether it can read images. Returns the result
 * to store: `{ status: 'passed' | 'failed', testedAt, questionCards: 'native' | 'text' | null, readsImages:
 * true | false | null, steps: [{ id, label, ok, detail }], message }`.
 *
 * A failure the architect can fix mid-call (a rejected key, a rate limit, no credit) is thrown as an
 * `AiProviderError` for `runWithRecovery` to handle. Anything else that goes wrong is a `failed` result.
 * `options`: `{ fetchImpl, origin, signal, onProgress(stepId) }`.
 */
export async function testConnection(provider, options = {}) {
  const steps = []
  const result = { status: 'failed', testedAt: new Date().toISOString(), questionCards: null, readsImages: null, steps, message: '' }
  const progress = (id) => options.onProgress?.(id)
  const fail = (id, label, detail) => {
    steps.push({ id, label, ok: false, detail })
    result.message = detail
    return result
  }
  const callOptions = { fetchImpl: options.fetchImpl, origin: options.origin, signal: options.signal }
  // A failure that becomes a `failed` result. Fixable ones (and anything unexpected, such as an abort) are thrown on.
  const handled = (err) => err instanceof AiProviderError && !RECOVERABLE_CODES.includes(err.code)

  // 1 and 2: the key is accepted, and the model exists, in one look at the model list.
  progress('key')
  let listing
  try {
    listing = await fetchModelsRaw(provider, callOptions)
  } catch (err) {
    if (!handled(err)) throw err
    if (provider.type === 'custom' && notSupported(err)) {
      listing = { models: [], body: null } // a custom endpoint need not list models; the probe calls will say
      steps.push({ id: 'key', label: 'Key accepted', ok: true, detail: 'This AI Provider doesn’t list its models, so the key is checked by the calls below.' })
    } else {
      return fail('key', 'Key accepted', err.message || 'Could not reach the AI Provider.')
    }
  }
  if (!steps.some((s) => s.id === 'key')) steps.push({ id: 'key', label: 'Key accepted', ok: true, detail: `${provider.name || 'The AI Provider'} accepted the key and listed ${listing.models.length} model${listing.models.length === 1 ? '' : 's'}.` })

  progress('model')
  if (!provider.model?.trim()) return fail('model', 'Model exists', 'No model is chosen. Edit this AI Provider and choose one.')
  if (listing.models.length && !hasModel(listing.models, provider.model, provider.type)) {
    return fail('model', 'Model exists', `${provider.name || 'The AI Provider'} doesn’t list a model called ${provider.model}.`)
  }
  steps.push({ id: 'model', label: 'Model exists', ok: true, detail: listing.models.length ? `${provider.model} is listed.` : `${provider.model} will be checked by the calls below.` })

  // 3: question cards. The metadata hint can rule native out; only a probe call can rule it in.
  progress('cards')
  let hints = modelHints(listing.parsedAs ?? provider.type, listing.body, provider.model)
  if (provider.type === 'ollama') {
    try {
      const show = await callAiProvider(provider, ollamaShowRequest(provider, provider.model), callOptions)
      if (show.ok) hints = ollamaHints(await show.json().catch(() => null))
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      // the hint is optional; the probe decides
    }
  }
  try {
    if (hints.tools === false) {
      result.questionCards = 'text'
      steps.push({ id: 'cards', label: 'Question cards', ok: true, detail: 'The AI Provider says this model doesn’t use tools, so Gantry will ask for questions in text (text fallback).' })
    } else {
      let native = false
      try {
        const reply = await collect(provider, { ...CARD_PROBE, tools: [ASK_TOOL] }, callOptions)
        const call = reply.toolCalls.find((c) => c.name === ASK_TOOL_NAME)
        native = Boolean(call && !call.invalid && validateCards(call.input).ok)
      } catch (err) {
        if (!notSupported(err)) throw err
      }
      result.questionCards = native ? 'native' : 'text'
      steps.push({
        id: 'cards',
        label: 'Question cards',
        ok: true,
        detail: native
          ? 'The model asked a complete, valid question card using a tool call (native).'
          : 'The model didn’t answer with a valid tool call, so Gantry will ask for questions in text (text fallback).',
      })
    }
  } catch (err) {
    if (!handled(err)) throw err
    return fail('cards', 'Question cards', err.message)
  }

  // 4: images. A published "yes" or "no" is believed; otherwise the model is shown a picture.
  progress('images')
  try {
    if (hints.images !== null) {
      result.readsImages = hints.images
    } else {
      try {
        const reply = await collect(provider, IMAGE_PROBE, callOptions)
        result.readsImages = /red/i.test(reply.text)
      } catch (err) {
        if (!notSupported(err)) throw err
        result.readsImages = false
      }
    }
    steps.push({ id: 'images', label: 'Reads images', ok: true, detail: result.readsImages ? 'It can read images, so Source documents that are pictures can be sent to it.' : 'It can’t read images. Pictures in Source documents will be left out for this model.' })
  } catch (err) {
    if (!handled(err)) throw err
    // Everything the interview needs has been checked; an image probe that failed for other reasons is "unknown".
    result.readsImages = null
    steps.push({ id: 'images', label: 'Reads images', ok: false, detail: err.message })
  }

  result.status = 'passed'
  result.message = `${provider.name || 'The AI Provider'} is ready.`
  return result
}

/**
 * Tests the stored AI Provider `id`, recovering from a rejected key / rate limit / no credit through `handlers`
 * (see `runWithRecovery`), and stores the result with it. Resolves with the result; throws only if the architect
 * gave up on a recoverable failure (nothing is stored then) or the AI Provider was deleted meanwhile.
 */
export async function testAndStore(id, { handlers = {}, ...options } = {}) {
  let tested = null
  const result = await runWithRecovery(() => {
    const provider = getAiProvider(id)
    if (!provider) throw new Error('This AI Provider no longer exists.')
    tested = { type: provider.type, address: provider.address, model: provider.model }
    return testConnection(provider, options)
  }, handlers)
  setAiProviderTest(id, result, tested)
  return result
}

/**
 * An untested AI Provider can still be used: it is tested when a session starts. Returns the stored AI Provider
 * afterwards (the result is on `.test`). An already-tested one is returned as it is.
 */
export async function ensureTested(id, options = {}) {
  const provider = getAiProvider(id)
  if (!provider) return null
  if (provider.test) return provider
  await testAndStore(id, options)
  return getAiProvider(id)
}
