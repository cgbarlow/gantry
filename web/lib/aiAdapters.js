// #278 (parent #238, docs/adr/0061): the two wire formats the AI client speaks, normalised to one internal
// stream. Anthropic Messages is one; OpenAI Chat Completions is the other, and OpenRouter, Ollama, LM Studio
// and custom endpoints all use it (the OpenAI type uses Chat Completions only, not the Responses API).
//
// Everything here is pure: a request builder per format, an incremental Server-Sent-Events reader, and a
// stream parser per format. The unit tests run them against recorded streams, split at awkward places.
//
// The internal conversation, whichever AI Provider it goes to:
//   { role: 'user', text, images?: [{ mediaType, data }], documents?: [{ mediaType, filename, data }] }
//                                                                          `data` is base64; a document is a PDF (#292)
//   { role: 'assistant', text?, toolCalls?: [{ id, name, input }] }
//   { role: 'tool', toolCallId, name?, content, isError? }                 the result of one tool call
// The internal stream the parsers produce:
//   { type: 'text', text }                        a piece of the reply
//   { type: 'tool-start', id, name }              a tool call has begun (before its arguments are complete)
//   { type: 'tool-call', id, name, input }        a tool call is complete; `input` is null and `invalid` says why
//                                                 when the arguments were not valid JSON
//   { type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
//   { type: 'done', stopReason }
import { classifyFailure } from './aiProviders.js'

const DEFAULT_MAX_TOKENS = 4096

function trimSlash(address) {
  return address.trim().replace(/\/+$/, '')
}

function stripSuffix(address, ...suffixes) {
  let out = trimSlash(address)
  for (const suffix of suffixes) {
    if (out.toLowerCase().endsWith(suffix)) {
      out = out.slice(0, -suffix.length)
      break
    }
  }
  return out
}

/** Which of the two wire formats a type speaks. */
export function wireFormat(type) {
  return type === 'anthropic' ? 'anthropic' : 'openai'
}

function set(body, key, value) {
  if (value !== null && value !== undefined && value !== '') body[key] = value
}

// ---------- requests ----------

function anthropicMessages(messages) {
  const wire = []
  const lastIsToolResults = () => {
    const last = wire[wire.length - 1]
    return last && last.role === 'user' && Array.isArray(last.content) && last.content.length > 0 && last.content.every((b) => b.type === 'tool_result')
  }
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = [
        ...(m.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        ...(m.documents ?? []).map((d) => ({ type: 'document', title: d.filename, source: { type: 'base64', media_type: d.mediaType, data: d.data } })),
        { type: 'text', text: m.text ?? '' },
      ]
      const content = blocks.length === 1 ? m.text ?? '' : blocks
      if (lastIsToolResults()) {
        // Tool results and the next thing the architect says are one user turn on this wire format.
        wire[wire.length - 1].content.push(...blocks)
      } else {
        wire.push({ role: 'user', content })
      }
    } else if (m.role === 'assistant') {
      const blocks = []
      if (m.text) blocks.push({ type: 'text', text: m.text })
      for (const call of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })
      wire.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] })
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') }
      if (m.isError) block.is_error = true
      if (lastIsToolResults()) wire[wire.length - 1].content.push(block)
      else wire.push({ role: 'user', content: [block] })
    }
  }
  return wire
}

function openAiMessages(system, messages) {
  const wire = []
  if (system) wire.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images?.length || m.documents?.length) {
        wire.push({
          role: 'user',
          content: [
            { type: 'text', text: m.text ?? '' },
            ...(m.images ?? []).map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
            ...(m.documents ?? []).map((d) => ({ type: 'file', file: { filename: d.filename, file_data: `data:${d.mediaType};base64,${d.data}` } })),
          ],
        })
      } else {
        wire.push({ role: 'user', content: m.text ?? '' })
      }
    } else if (m.role === 'assistant') {
      const entry = { role: 'assistant', content: m.text || (m.toolCalls?.length ? null : '') }
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }))
      }
      wire.push(entry)
    } else if (m.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') })
    }
  }
  return wire
}

/**
 * The streaming chat request for `provider`. `params`: `{ system, messages, tools, maxTokens }` (see the header
 * for the message shape; a tool is `{ name, description, parameters }`). The AI Provider's own settings
 * (temperature, max tokens, the Advanced set) are applied here. Returns `{ url, method, headers, body }`.
 */
export function buildChatRequest(provider, { system = '', messages = [], tools = [], maxTokens } = {}) {
  const key = provider.key?.trim()
  const adv = provider.advanced ?? {}
  const address = provider.address.trim()
  const outputLimit = maxTokens ?? provider.maxTokens
  if (provider.type === 'anthropic') {
    const body = { model: provider.model, max_tokens: outputLimit ?? DEFAULT_MAX_TOKENS, messages: anthropicMessages(messages), stream: true }
    set(body, 'system', system)
    if (tools.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      body.tool_choice = { type: 'auto' }
    }
    set(body, 'temperature', provider.temperature)
    set(body, 'top_p', adv.topP)
    set(body, 'top_k', adv.topK)
    if (adv.stop?.length) body.stop_sequences = adv.stop
    return {
      url: `${stripSuffix(address, '/v1')}/v1/messages`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
      body,
    }
  }
  // OpenAI Chat Completions, and everything that speaks it.
  const body = { model: provider.model, messages: openAiMessages(system, messages), stream: true, stream_options: { include_usage: true } }
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    body.tool_choice = 'auto'
    // OpenRouter routes to whichever endpoint it likes; without this it can pick one that silently drops the tools.
    if (provider.type === 'openrouter') body.provider = { require_parameters: true }
  }
  // #292: a PDF through OpenRouter is read by whichever engine it picks unless told. `native` hands the PDF to the model itself,
  // so there is never a surprise OCR charge on the architect's OpenRouter account (the default fallback, mistral-ocr, is billed).
  if (provider.type === 'openrouter' && messages.some((m) => m.documents?.length)) body.plugins = [{ id: 'file-parser', pdf: { engine: 'native' } }]
  const isOpenAi = provider.type === 'openai'
  // OpenAI's reasoning models only accept their default temperature.
  if (!(isOpenAi && adv.reasoningEffort)) set(body, 'temperature', provider.temperature)
  set(body, isOpenAi ? 'max_completion_tokens' : 'max_tokens', outputLimit)
  set(body, 'top_p', adv.topP)
  set(body, 'frequency_penalty', adv.frequencyPenalty)
  set(body, 'presence_penalty', adv.presencePenalty)
  if (adv.stop?.length) body.stop = adv.stop
  if (!isOpenAi) {
    // The official API rejects these; the others accept or ignore them.
    set(body, 'top_k', adv.topK)
    set(body, 'min_p', adv.minP)
  }
  if (adv.reasoningEffort) {
    if (provider.type === 'openrouter') body.reasoning = { effort: adv.reasoningEffort }
    else body.reasoning_effort = adv.reasoningEffort
  }
  // Ollama and LM Studio publish the OpenAI-style API under /v1; the others' addresses already include it.
  const base = provider.type === 'ollama' ? `${stripSuffix(address, '/v1', '/api')}/v1` : provider.type === 'lmstudio' ? `${stripSuffix(address, '/v1')}/v1` : trimSlash(address)
  return {
    url: `${base}/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body,
  }
}

// ---------- Server-Sent Events ----------

/**
 * An incremental SSE reader. `push(text)` takes whatever arrived (split anywhere, even mid-line) and returns the
 * complete events so far as `{ event, data }`; `end()` returns a final event left without its blank line.
 */
export function createSseReader() {
  let buffer = ''
  const take = (block) => {
    let event = ''
    const data = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    return data.length || event ? { event, data: data.join('\n') } : null
  }
  return {
    push(text) {
      buffer += text.replace(/\r\n?/g, '\n')
      const out = []
      let at
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const event = take(buffer.slice(0, at))
        buffer = buffer.slice(at + 2)
        if (event) out.push(event)
      }
      return out
    },
    end() {
      const event = buffer.trim() ? take(buffer) : null
      buffer = ''
      return event ? [event] : []
    },
  }
}

// ---------- stream parsers ----------

function parseToolInput(json) {
  if (json === '' || json === undefined) return { input: {} }
  try {
    return { input: JSON.parse(json) }
  } catch (err) {
    return { input: null, invalid: `The arguments were not valid JSON (${err.message}).` }
  }
}

const ANTHROPIC_ERROR_STATUS = { authentication_error: 401, permission_error: 403, rate_limit_error: 429, overloaded_error: 529, billing_error: 402 }

/**
 * Parser for the Anthropic Messages stream. `feed({ event, data })` takes each SSE event and returns the
 * internal events it yields; `finish()` returns what is left (the usage, and `done`). Throws an
 * `AiProviderError` for an `error` event in the stream.
 */
export function createAnthropicParser(provider) {
  const blocks = new Map() // content block index -> { id, name, json }
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let stopReason = null
  let finished = false
  return {
    /** The tool calls still being written, with their arguments so far (`{ id, name, json }`): lets a caller see which Field a draft is for before the call is complete. */
    partials: () => [...blocks.values()].map(({ id, name, json }) => ({ id, name, json })),
    feed({ data }) {
      if (!data || data === '[DONE]') return []
      let obj
      try {
        obj = JSON.parse(data)
      } catch {
        return []
      }
      const out = []
      switch (obj.type) {
        case 'message_start': {
          const u = obj.message?.usage ?? {}
          usage.inputTokens = u.input_tokens ?? 0
          usage.outputTokens = u.output_tokens ?? 0
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0
          break
        }
        case 'content_block_start': {
          const block = obj.content_block ?? {}
          if (block.type === 'tool_use') {
            blocks.set(obj.index, { id: block.id, name: block.name, json: '' })
            out.push({ type: 'tool-start', id: block.id, name: block.name })
          }
          break
        }
        case 'content_block_delta': {
          const delta = obj.delta ?? {}
          if (delta.type === 'text_delta' && delta.text) out.push({ type: 'text', text: delta.text })
          else if (delta.type === 'input_json_delta' && blocks.has(obj.index)) blocks.get(obj.index).json += delta.partial_json ?? ''
          break
        }
        case 'content_block_stop': {
          const block = blocks.get(obj.index)
          if (block) {
            blocks.delete(obj.index)
            out.push({ type: 'tool-call', id: block.id, name: block.name, ...parseToolInput(block.json) })
          }
          break
        }
        case 'message_delta': {
          if (obj.delta?.stop_reason) stopReason = obj.delta.stop_reason
          const u = obj.usage ?? {}
          if (u.output_tokens !== undefined) usage.outputTokens = u.output_tokens
          if (u.input_tokens !== undefined && u.input_tokens > 0) usage.inputTokens = u.input_tokens
          if (u.cache_read_input_tokens !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens
          if (u.cache_creation_input_tokens !== undefined) usage.cacheWriteTokens = u.cache_creation_input_tokens
          break
        }
        case 'error': {
          const type = obj.error?.type ?? ''
          throw classifyFailure(ANTHROPIC_ERROR_STATUS[type] ?? 0, { error: { type, message: obj.error?.message } }, provider)
        }
        default:
          break
      }
      return out
    },
    finish() {
      if (finished) return []
      finished = true
      // A tool call cut off before its block closed is not complete: it is dropped, never half-used.
      return [{ type: 'usage', ...usage }, { type: 'done', stopReason }]
    },
  }
}

/**
 * Parser for the OpenAI Chat Completions stream, with the same interface as `createAnthropicParser`.
 */
export function createOpenAiParser(provider) {
  const calls = new Map() // index -> { id, name, args, started }
  let lastIndex = 0
  let anonymous = 0
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let stopReason = null
  let finished = false

  const flush = () => {
    const out = []
    for (const index of [...calls.keys()].sort((a, b) => a - b)) {
      const call = calls.get(index)
      if (!call.name) continue
      out.push({ type: 'tool-call', id: call.id, name: call.name, ...parseToolInput(call.args) })
    }
    calls.clear()
    return out
  }

  return {
    partials: () => [...calls.values()].filter((c) => c.name).map(({ id, name, args }) => ({ id, name, json: args })),
    feed({ data }) {
      if (!data || data === '[DONE]') return []
      let obj
      try {
        obj = JSON.parse(data)
      } catch {
        return []
      }
      if (obj.error) {
        const status = Number(obj.error.code ?? obj.error.status)
        throw classifyFailure(Number.isInteger(status) ? status : 0, { error: obj.error }, provider)
      }
      const out = []
      if (obj.usage) {
        usage.inputTokens = obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? usage.inputTokens
        usage.outputTokens = obj.usage.completion_tokens ?? obj.usage.output_tokens ?? usage.outputTokens
        usage.cacheReadTokens = obj.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheReadTokens
      }
      const choice = obj.choices?.[0]
      if (!choice) return out
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) out.push({ type: 'text', text: delta.content })
      for (const fragment of delta.tool_calls ?? []) {
        let index = fragment.index
        if (index === undefined || index === null) index = fragment.id && calls.size ? lastIndex + 1 : lastIndex
        lastIndex = index
        let call = calls.get(index)
        if (!call) {
          call = { id: fragment.id || `call_${++anonymous}`, name: '', args: '', started: false }
          calls.set(index, call)
        }
        if (fragment.id && !call.started) call.id = fragment.id
        if (fragment.function?.name) call.name += fragment.function.name
        const args = fragment.function?.arguments
        if (typeof args === 'string') call.args += args
        else if (args && typeof args === 'object') call.args = JSON.stringify(args)
        if (call.name && !call.started) {
          call.started = true
          out.push({ type: 'tool-start', id: call.id, name: call.name })
        }
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason
        out.push(...flush())
      }
      return out
    },
    finish() {
      if (finished) return []
      finished = true
      // A server that closes the stream without a finish_reason has still sent whole calls; complete ones are kept.
      return [...flush(), { type: 'usage', ...usage }, { type: 'done', stopReason }]
    },
  }
}

export function createParser(provider) {
  return wireFormat(provider.type) === 'anthropic' ? createAnthropicParser(provider) : createOpenAiParser(provider)
}

/**
 * Turns a complete (non-streamed) answer into the same internal events, for an endpoint that ignores
 * `stream: true` and replies with one JSON body.
 */
export function eventsFromCompleteResponse(provider, body) {
  const out = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let stopReason = null
  if (wireFormat(provider.type) === 'anthropic') {
    for (const block of body?.content ?? []) {
      if (block.type === 'text' && block.text) out.push({ type: 'text', text: block.text })
      if (block.type === 'tool_use') {
        out.push({ type: 'tool-start', id: block.id, name: block.name }, { type: 'tool-call', id: block.id, name: block.name, input: block.input ?? {} })
      }
    }
    usage.inputTokens = body?.usage?.input_tokens ?? 0
    usage.outputTokens = body?.usage?.output_tokens ?? 0
    usage.cacheReadTokens = body?.usage?.cache_read_input_tokens ?? 0
    usage.cacheWriteTokens = body?.usage?.cache_creation_input_tokens ?? 0
    stopReason = body?.stop_reason ?? null
  } else {
    const choice = body?.choices?.[0]
    const message = choice?.message ?? {}
    if (typeof message.content === 'string' && message.content) out.push({ type: 'text', text: message.content })
    for (const [i, call] of (message.tool_calls ?? []).entries()) {
      const id = call.id || `call_${i + 1}`
      const args = call.function?.arguments
      out.push({ type: 'tool-start', id, name: call.function?.name }, { type: 'tool-call', id, name: call.function?.name, ...parseToolInput(typeof args === 'string' ? args : JSON.stringify(args ?? {})) })
    }
    usage.inputTokens = body?.usage?.prompt_tokens ?? 0
    usage.outputTokens = body?.usage?.completion_tokens ?? 0
    usage.cacheReadTokens = body?.usage?.prompt_tokens_details?.cached_tokens ?? 0
    stopReason = choice?.finish_reason ?? null
  }
  out.push({ type: 'usage', ...usage }, { type: 'done', stopReason })
  return out
}

