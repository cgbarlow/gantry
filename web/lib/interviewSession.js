// #286 (parent #238, docs/adr/0061 and 0065): one **AI interview session** for one Stage of an Instance. It owns the
// conversation with the AI, the drafts it has written into the live preview and the checks on them. It draws nothing:
// the Interview page (web/lib/interviewView.js) shows `snapshot()` and calls the methods here.
//
// A session:
//   * builds the interview brief afresh for every turn (web/lib/interviewBrief.js) from `getContext()`, so what the
//     architect saved or uploaded since the last turn is what the AI is told;
//   * runs a turn through the AI client (web/lib/aiClient.js), handing the AI one tool of its own, `draft_field`
//     (web/lib/interviewDraft.js), and carries on until the AI stops calling it. A model that doesn't use tools drafts in
//     fenced `gantry-draft` blocks instead, read from its reply (the text fallback; Gantry never refuses a model);
//   * checks each draft on arrival. A draft with problems goes back to the AI once; whatever is left is a warning in the
//     preview, never a block. A Field that already holds saved content is refused: this release leaves it alone, and
//     changing it through a card comes with question cards (#287);
//   * lets the architect switch AI Provider between any two turns. The history is provider-neutral;
//   * (#292) decides, for the AI Provider in use, how each Source document reaches the AI (web/lib/interviewSources.js): its
//     text in the brief, the original attached to the first message (a picture, a scanned or "Read visually" PDF), or not at
//     all. When the pack is over about half the model's window the brief carries a catalogue and the AI is handed one more
//     tool, `read_source_document(id, range)`. Every read is recorded, and a draft carries the reads made since the last
//     drafts, and the documents it cites, as its inputs (the `fields` part of the decisions log, ADR-0064).
//
// Nothing here saves. Drafts are an unsaved preview until the architect confirms the stage-end card.
import { runTurn, runWithRecovery, questionCardMode, ensureTested, EMPTY_USAGE } from './aiClient.js'
import { getAiProvider } from './aiProviders.js'
import { buildInterviewBrief, normalizeSavedContent } from './interviewBrief.js'
import { DRAFT_TOOL, DRAFT_TOOL_NAME, DRAFT_FENCE, DRAFT_TEXT_FALLBACK_INSTRUCTIONS, checkDraft, extractDraftBlocks, isBlankValue, stripDraftBlocks } from './interviewDraft.js'
import {
  READ_TOOL,
  READ_TOOL_NAME,
  READ_FENCE,
  READ_TEXT_FALLBACK_INSTRUCTIONS,
  accessForBrief,
  attachmentNote,
  describeInput,
  extractReadBlocks,
  inputsForDraft,
  loadAttachments,
  planSourceAccess,
  runReadCall,
  sourcesForBrief,
  stripReadBlocks,
} from './interviewSources.js'

/** The turns one send may run (each draft or read tool round is a turn), so a model that never stops can't loop for ever. */
export const MAX_ROUNDS = 24

// What the architect sees of the AI's text: neither the draft blocks nor the read requests a text-only model writes.
const shownText = (text) => stripReadBlocks(stripDraftBlocks(text))

const OPENING =
  'Begin the interview. Read the Source documents, open with a short summary of what you found in them, then draft every Field they support. ' +
  'Leave out any Field they do not support.'

function sessionNote(textMode, reader) {
  return [
    '## Note for this session',
    '',
    'Question cards are not available in this session yet. Where the rules say to ask a card, ask in short plain chat instead, and only what matters most.',
    textMode
      ? `Write each Field in a fenced \`${DRAFT_FENCE}\` block. ${DRAFT_TEXT_FALLBACK_INSTRUCTIONS}`
      : `Write each Field by calling the \`${DRAFT_TOOL_NAME}\` tool, never as chat. You may call it for several Fields in one reply.`,
    'A Field that already holds saved content is refused by Gantry: leave it alone.',
    ...(reader
      ? [
          textMode
            ? `The Source documents are a catalogue. ${READ_TEXT_FALLBACK_INSTRUCTIONS}`
            : `The Source documents are a catalogue. Read the parts you need with the \`${READ_TOOL_NAME}\` tool before you draft from them; you may call it several times in one reply.`,
        ]
      : []),
  ].join('\n')
}

/** `module.field` split into its two ids, or null. */
function splitRef(ref) {
  const text = String(ref ?? '').trim()
  const dot = text.indexOf('.')
  if (dot <= 0 || dot === text.length - 1) return null
  return { moduleId: text.slice(0, dot), fieldId: text.slice(dot + 1) }
}

/** The Fields the AI may draft on `stageId`: every Field of the Stage's Modules that are not read-only here, keyed `module.field`. */
export function fieldsInScope(definition, stageId) {
  const stage = (definition?.stages ?? []).find((s) => s.id === stageId)
  const modules = definition?.modules instanceof Map ? [...definition.modules.values()] : definition?.modules ?? []
  const byId = new Map(modules.map((m) => [m.id, m]))
  const readOnly = new Set(stage?.readOnlyModules ?? [])
  const scope = new Map()
  for (const id of stage?.modules ?? []) {
    const mod = byId.get(id)
    if (!mod || readOnly.has(id)) continue
    for (const field of mod.fields ?? []) scope.set(`${id}.${field.id}`, { module: mod, field })
  }
  return scope
}

/** The Artefacts that can pass `stage`'s Gate, and the lightest (fewest requirements), which is pre-selected. */
export function artefactChoices(definition, stageId) {
  const stage = (definition?.stages ?? []).find((s) => s.id === stageId)
  const candidates = (definition?.artefacts ?? []).filter((a) => a.gate === stage?.gate && a.satisfiesGate !== false)
  const lightest = candidates.length ? candidates.reduce((best, a) => ((a.requires?.length ?? 0) < (best.requires?.length ?? 0) ? a : best)) : null
  return { candidates, lightest }
}

// A model without tool calling is shown its earlier tool calls as the blocks it would have written, and the
// results as one message from Gantry; two messages from the same side are joined.
function flattenToolHistory(messages) {
  const out = []
  const push = (message) => {
    const last = out[out.length - 1]
    if (last && last.role === 'user' && message.role === 'user' && !last.images && !message.images && !last.documents && !message.documents) last.text = `${last.text}\n\n${message.text}`
    else out.push({ ...message })
  }
  let results = []
  const flush = () => {
    if (results.length) push({ role: 'user', fromGantry: true, text: `Gantry's check of your drafts:\n${results.join('\n')}` })
    results = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      results.push(`- ${m.content}`)
      continue
    }
    flush()
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks = m.toolCalls
        .filter((c) => c.name === DRAFT_TOOL_NAME || c.name === READ_TOOL_NAME)
        .map((c) =>
          c.name === READ_TOOL_NAME
            ? '```' + READ_FENCE + '\n' + JSON.stringify({ id: c.input?.id, range: c.input?.range }) + '\n```'
            : '```' + DRAFT_FENCE + '\n' + JSON.stringify({ field: c.input?.field, value: c.input?.value }) + '\n```'
        )
      push({ role: 'assistant', text: [m.text, ...blocks].filter(Boolean).join('\n\n') || '…' })
    } else {
      push(m)
    }
  }
  flush()
  return out
}

/**
 * Creates a session.
 *
 * @param {object} config
 * @param {string} config.providerId        the AI Provider to use first (any stored one; read afresh on every call)
 * @param {() => object} config.getContext  `{ definition, stageId, artefactId?, size?, saved, sources, skills }`, as for `buildInterviewBrief`
 * @param {object} [config.handlers]        `{ askForKey, askToRetry }` for `runWithRecovery`
 * @param {Function} [config.fetchImpl]
 * @param {string} [config.origin]
 * @param {(snapshot: object) => void} [config.onChange]
 */
export function createInterviewSession(config = {}) {
  let { providerId, getContext, handlers = {}, fetchImpl, origin, onChange } = config
  const state = {
    phase: 'kickoff', // kickoff | testing | working | waiting | error
    providerId,
    thread: [],
    drafts: {},
    drafting: null,
    error: null,
    kickoffError: null,
    testStep: null,
    usage: EMPTY_USAGE,
    savedKeys: [],
    fieldInputs: {}, // `module.field` -> the inputs it was drafted from (#292), kept after a Save: it is the log's `fields` part
  }
  let messages = []
  let nextId = 1
  let live = null // the thread item the AI is streaming into
  const bounced = new Set() // Fields already sent back once
  const held = new Map() // a bounced draft that has not been answered yet: shown with its warnings if the AI never answers
  const handled = new Map() // tool call id -> the result, so a draft shown as it arrived is not checked twice
  let controller = null
  let readsSinceDraft = [] // the reads made since the last drafts landed (#292)
  let plan = new Map() // how each Source document reaches the AI Provider in use (#292)
  let announced = '' // what the thread last said about unreadable documents, so a repeat is not said twice
  const attachmentCache = new Map()

  const emit = () => onChange?.(snapshot())
  const snapshot = () => ({ ...state, thread: state.thread.map((t) => ({ ...t })), drafts: { ...state.drafts }, savedKeys: [...state.savedKeys], fieldInputs: { ...state.fieldInputs } })
  const say = (who, text, extra = {}) => {
    const item = { id: nextId++, who, text, ...extra }
    state.thread.push(item)
    return item
  }
  const architectText = () => messages.filter((m) => m.role === 'user' && m !== messages[0] && !m.fromGantry).map((m) => m.text).join('\n')

  // ---------- drafting ----------

  /** Checks one draft and, if it passes (or has already been sent back once), puts it in the preview. Returns `{ ok, content }` for the AI. */
  function acceptDraft(ref, rawValue) {
    const context = getContext()
    const scope = fieldsInScope(context.definition, context.stageId)
    const parsed = splitRef(ref)
    const key = parsed ? `${parsed.moduleId}.${parsed.fieldId}` : String(ref)
    const entry = scope.get(key)
    if (!entry) {
      return { ok: false, content: `${ref} is not a Field you can draft on this Stage. Use one listed under "Fields in scope" as module.field. Read-only Modules are context, not yours to write.` }
    }
    const saved = normalizeSavedContent(context.saved)[parsed.moduleId]?.fields?.[parsed.fieldId]
    if (saved !== undefined && !isBlankValue(saved)) {
      return { ok: false, content: `${key} already holds saved content, so it is left as it is. Do not draft it; if it needs to change, say so in chat.` }
    }
    if (isBlankValue(rawValue)) return { ok: false, content: `${key}: the value is empty. Send the Field's content, or leave the Field out.` }

    const knownSourceIds = (context.sources ?? []).filter((s) => s && !s.removedAt).map((s) => s.id)
    const check = checkDraft(entry.field, rawValue, { size: context.size, architectText: architectText(), knownSourceIds })
    // The inputs are what the AI read before this draft plus what it cites. A draft sent back keeps the ones it had, because the reads are cleared once a round of drafts has landed.
    const inputs = mergeInputs(held.get(key)?.inputs, inputsForDraft({ reads: readsSinceDraft, value: check.value, sources: context.sources }))
    if (check.problems.length && !bounced.has(key)) {
      bounced.add(key)
      held.set(key, { value: check.value, words: check.words, inputs, warnings: check.problems.map((p) => p.message) })
      return {
        ok: false,
        content: `${key} was not shown yet. Fix this and call ${DRAFT_TOOL_NAME} for ${key} once more:\n- ${check.problems.map((p) => p.message).join('\n- ')}`,
      }
    }
    bounced.delete(key)
    held.delete(key)
    state.drafts[key] = { value: check.value, words: check.words, warnings: check.problems.map((p) => p.message), inputs, moduleId: parsed.moduleId, fieldId: parsed.fieldId }
    state.fieldInputs[key] = inputs
    say('sys', `Drafted ${entry.module.title ?? entry.module.id} · ${entry.field.title ?? entry.field.id}${check.problems.length ? ' (with a warning)' : ''}`, { drafted: key })
    return {
      ok: true,
      content: check.problems.length
        ? `${key} is in the preview, with a warning for the architect: ${check.problems.map((p) => p.message).join(' ')}`
        : `${key} is in the preview (${check.words} words).`,
    }
  }

  const mergeInputs = (earlier = [], later = []) => {
    const out = [...earlier]
    for (const input of later) if (!out.some((i) => i.source === input.source && (i.range ?? null) === (input.range ?? null))) out.push(input)
    return out
  }

  // ---------- reading (#292) ----------

  /** One `read_source_document` call: the text back to the AI, and the read recorded as an input of whatever it drafts next. */
  function runRead(input) {
    const context = getContext()
    const live = (context.sources ?? []).filter((s) => s && !s.removedAt)
    const id = String(input?.id ?? '')
    const result = runReadCall({ id, range: input?.range }, { lookup: (wanted) => live.find((s) => s.id === wanted), access: plan.get(id) })
    if (result.ok) {
      readsSinceDraft.push(result.read)
      say('sys', `Read ${describeInput(result.read)}`, { read: result.read.source })
    }
    return result
  }

  // Drafts the AI was asked to fix and never sent again reach the preview with their problems as warnings.
  function promoteHeld() {
    const context = getContext()
    const scope = fieldsInScope(context.definition, context.stageId)
    for (const [key, draft] of held) {
      const entry = scope.get(key)
      const parsed = splitRef(key)
      if (!entry || !parsed) continue
      state.drafts[key] = { ...draft, moduleId: parsed.moduleId, fieldId: parsed.fieldId }
      state.fieldInputs[key] = draft.inputs ?? []
      say('sys', `Drafted ${entry.module.title ?? entry.module.id} · ${entry.field.title ?? entry.field.id} (with a warning)`, { drafted: key })
    }
    held.clear()
  }

  function resultFor(call) {
    if (handled.has(call.id)) return handled.get(call.id)
    let result
    if (call.name !== DRAFT_TOOL_NAME && call.name !== READ_TOOL_NAME) result = { ok: false, content: `There is no tool called ${call.name}.` }
    else if (call.invalid || call.input === null || call.input === undefined) {
      result = { ok: false, content: `The arguments were not valid JSON: ${call.invalid ?? (call.name === READ_TOOL_NAME ? 'send {"id": "document-id", "range": "pages 3-5"}' : 'send {"field": "module.field", "value": ...}')}.` }
    } else if (call.name === READ_TOOL_NAME) result = runRead(call.input)
    else result = acceptDraft(call.input.field, call.input.value)
    handled.set(call.id, result)
    return result
  }

  // ---------- one send ----------

  function onEvent(event) {
    if (event.type === 'text') {
      const shown = shownText(event.text)
      if (!shown) return
      if (!live) live = say('ai', '', { streaming: true })
      live.text = shown
      emit()
    } else if (event.type === 'tool-start') {
      if (event.name === DRAFT_TOOL_NAME) {
        state.drafting = true
        emit()
      }
    } else if (event.type === 'tool-call') {
      resultFor(event.call)
      state.drafting = false
      emit()
    }
  }

  /**
   * Works out how every Source document reaches `provider`, loads the originals that are to be attached, and builds the brief.
   * Returns what one request needs: the system text, the tools, and a function that puts the attachments on the first message.
   */
  async function prepare(provider) {
    const context = getContext()
    plan = planSourceAccess({ sources: context.sources, provider })
    const attachments = await loadAttachments({ sources: context.sources, plan, loadBytes: context.readOriginal, cache: attachmentCache })
    for (const [id, reason] of Object.entries(attachments.problems)) plan.set(id, { how: 'unreadable', kind: plan.get(id)?.kind, reason })
    announceAccess(context, provider)
    const brief = buildInterviewBrief({
      definition: context.definition,
      stageId: context.stageId,
      artefactId: context.artefactId,
      size: context.size,
      saved: context.saved,
      decisions: [],
      sources: sourcesForBrief(context.sources, plan),
      skills: context.skills,
      contextWindow: provider.contextWindow,
      readerTool: true,
      sourceAccess: accessForBrief(plan),
    })
    // The catalogue is only offered with a way to read it.
    const reader = brief.sources.mode === 'catalogue'
    const textMode = questionCardMode(provider) === 'text'
    const withAttachments = (list) => {
      if (!attachments.images.length && !attachments.documents.length) return list
      const [first, ...rest] = list
      return [
        {
          ...first,
          text: `${first.text}${attachmentNote(attachments)}`,
          images: attachments.images.map(({ mediaType, data }) => ({ mediaType, data })),
          documents: attachments.documents.map(({ filename, mediaType, data }) => ({ filename, mediaType, data })),
        },
        ...rest,
      ]
    }
    return {
      system: `${brief.text}\n\n${sessionNote(textMode, reader)}`,
      tools: textMode ? [] : [DRAFT_TOOL, ...(reader ? [READ_TOOL] : [])],
      withAttachments,
      knownSources: (context.sources ?? []).filter((s) => !s.removedAt).map((s) => ({ id: s.id, title: s.title })),
    }
  }

  // Says, once in the thread, which Source documents this AI Provider cannot read and which it is sent as the original.
  function announceAccess(context, provider) {
    const titleOf = (id) => (context.sources ?? []).find((s) => s.id === id)?.title ?? id
    const unreadable = [...plan].filter(([, a]) => a.how === 'unreadable')
    const sent = [...plan].filter(([, a]) => a.how === 'attach')
    const notes = [...plan].filter(([, a]) => a.note)
    const signature = JSON.stringify([provider.id, unreadable.map(([id, a]) => [id, a.reason]), sent.map(([id]) => id), notes.map(([id]) => id)])
    if (signature === announced) return
    announced = signature
    const model = provider.model ? ` (${provider.model})` : ''
    if (sent.length) say('sys', `Sent to the AI as the original: ${sent.map(([id, a]) => `${titleOf(id)} (${a.kind === 'pdf' ? 'PDF' : 'picture'})`).join(', ')}.`, { sentOriginals: sent.map(([id]) => id) })
    for (const [id, a] of unreadable) say('sys', `Can't be read${model}: ${titleOf(id)}, because ${a.reason}. The AI is told so and won't rely on it.`, { unreadable: id })
    for (const [id, a] of notes) say('sys', `${titleOf(id)} is ${a.note}.`)
  }

  async function runLoop() {
    state.phase = 'working'
    state.error = null
    controller = new AbortController()
    emit()
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        live = null
        const result = await runWithRecovery(async () => {
          const provider = getAiProvider(state.providerId)
          if (!provider) throw new Error('This AI Provider no longer exists. Choose another.')
          const text = questionCardMode(provider) === 'text'
          const { system, tools, withAttachments, knownSources } = await prepare(provider)
          const history = withAttachments(text ? flattenToolHistory(messages) : messages)
          return runTurn(provider, { system, messages: history, tools, knownSources, askCards: false }, { fetchImpl, origin, signal: controller.signal, onEvent })
        }, handlers)
        state.usage = {
          inputTokens: state.usage.inputTokens + result.usage.inputTokens,
          outputTokens: state.usage.outputTokens + result.usage.outputTokens,
          cacheReadTokens: state.usage.cacheReadTokens + result.usage.cacheReadTokens,
          cacheWriteTokens: state.usage.cacheWriteTokens + result.usage.cacheWriteTokens,
        }
        const provider = getAiProvider(state.providerId)
        const textMode = provider ? questionCardMode(provider) === 'text' : false
        // The attachments go on the first message of each request and are not kept in the history, so a switch of AI Provider can decide them afresh.
        const base = (result.messages ?? messages).map((m, i) => (i === 0 ? messages[0] : m))

        if (result.kind === 'tools' && !textMode) {
          if (live) live.streaming = false
          messages = [...base, result.assistantMessage]
          for (const call of result.otherToolCalls) {
            const outcome = resultFor(call)
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, isError: !outcome.ok, content: outcome.content })
          }
          // Once a round of drafts has landed, the reads before it are spent: they are inputs of those drafts, not of later ones.
          if (result.otherToolCalls.some((c) => c.name === DRAFT_TOOL_NAME)) readsSinceDraft = []
          state.drafting = false
          emit()
          continue
        }

        // A reply with no more tool calls. Text-fallback drafts and reads are taken from it.
        const shown = shownText(result.text)
        if (live) {
          live.text = shown
          live.streaming = false
        } else if (shown) {
          say('ai', shown)
        }
        if (live && !shown) state.thread = state.thread.filter((t) => t !== live)
        messages = [...base, { role: 'assistant', text: result.text }]
        if (textMode) {
          const { drafts, errors } = extractDraftBlocks(result.text)
          const requested = extractReadBlocks(result.text)
          // Reads are answered first, so a draft in the same reply is checked with them already recorded as its inputs.
          const answers = requested.reads.map((r) => runRead(r))
          const outcomes = drafts.map((d) => ({ d, ...acceptDraft(d.field, d.value) }))
          if (drafts.length) readsSinceDraft = []
          const notes = [...errors, ...requested.errors, ...outcomes.filter((o) => !o.ok).map((o) => o.content)]
          if (round < MAX_ROUNDS - 1 && (answers.length || (notes.length && outcomes.some((o) => !o.ok) && held.size))) {
            const check = notes.length ? `Gantry's check of your drafts:\n- ${notes.join('\n- ')}` : ''
            const reads = answers.length ? `Gantry's reply to your read requests:\n\n${answers.map((a) => a.content).join('\n\n')}` : ''
            messages.push({ role: 'user', fromGantry: true, text: [reads, check].filter(Boolean).join('\n\n') })
            emit()
            continue
          }
        }
        break
      }
      promoteHeld()
      state.phase = 'waiting'
    } catch (err) {
      if (err?.name === 'AbortError') {
        state.phase = 'waiting'
      } else {
        promoteHeld()
        state.phase = 'error'
        state.error = { message: err?.message || 'The AI Provider did not answer.', code: err?.code ?? null }
      }
    } finally {
      live = null
      state.drafting = false
      for (const t of state.thread) if (t.streaming) t.streaming = false
      emit()
    }
  }

  // ---------- the session's methods ----------

  return {
    snapshot,
    get providerId() {
      return state.providerId
    },

    /** Tests the chosen AI Provider if it has not been, then opens the interview. Resolves once the first turn has finished. */
    async start() {
      if (state.phase !== 'kickoff') return
      state.kickoffError = null
      const provider = getAiProvider(state.providerId)
      if (!provider) {
        state.kickoffError = 'Choose an AI Provider, or connect one.'
        emit()
        return
      }
      state.phase = 'testing'
      emit()
      try {
        const tested = await ensureTested(state.providerId, {
          fetchImpl,
          origin,
          handlers,
          onProgress: (step) => {
            state.testStep = step
            emit()
          },
        })
        if (tested?.test?.status === 'failed') {
          state.phase = 'kickoff'
          state.kickoffError = tested.test.message || 'The AI Provider did not pass its test.'
          emit()
          return
        }
      } catch (err) {
        state.phase = 'kickoff'
        state.kickoffError = err?.message || 'The AI Provider could not be tested.'
        emit()
        return
      } finally {
        state.testStep = null
      }
      const started = getAiProvider(state.providerId)
      say('sys', `Interview started with ${started?.name ?? 'the AI Provider'}`)
      if (started?.test?.questionCards === 'text') {
        say('sys', "This model doesn't use tools, so it drafts in text (the text fallback). That works, but is less reliable.")
      }
      messages = [{ role: 'user', text: OPENING }]
      await runLoop()
    },

    /** Free chat: what the architect types goes to the AI as it is. */
    async send(text) {
      const body = String(text ?? '').trim()
      if (!body || state.phase === 'working' || state.phase === 'kickoff' || state.phase === 'testing') return
      say('you', body)
      messages = [...messages, { role: 'user', text: body }]
      await runLoop()
    },

    /** Carries on after a failure (the history is intact: the architect's last message is already in it). */
    async retry() {
      if (state.phase !== 'error') return
      await runLoop()
    },

    /** Switch AI Provider between any two turns. Resolves `{ ok, message? }`. */
    async setProvider(id) {
      if (state.phase === 'working' || state.phase === 'testing') return { ok: false, message: 'Wait for the AI to finish its turn first.' }
      if (id === state.providerId) return { ok: true }
      const provider = getAiProvider(id)
      if (!provider) return { ok: false, message: 'That AI Provider no longer exists.' }
      if (state.phase === 'kickoff') {
        state.providerId = id
        state.kickoffError = null
        emit()
        return { ok: true }
      }
      try {
        const tested = await ensureTested(id, { fetchImpl, origin, handlers })
        if (tested?.test?.status === 'failed') return { ok: false, message: tested.test.message || 'That AI Provider did not pass its test.' }
      } catch (err) {
        return { ok: false, message: err?.message || 'That AI Provider could not be tested.' }
      }
      state.providerId = id
      const now = getAiProvider(id)
      say('sys', `Switched to ${now?.name ?? 'another AI Provider'}${now?.model ? ` (${now.model})` : ''}`)
      emit()
      return { ok: true }
    },

    /** The drafts were saved: they are no longer an unsaved preview. */
    markSaved(keys) {
      for (const key of keys) delete state.drafts[key]
      state.savedKeys = [...new Set([...state.savedKeys, ...keys])]
      say('sys', `Saved ${keys.length} Field${keys.length === 1 ? '' : 's'}. The Modules stay draft.`)
      emit()
    },

    /** Drops every unsaved draft. */
    discardDrafts() {
      state.drafts = {}
      emit()
    },

    cancel() {
      controller?.abort()
    },

    /**
     * The page that shows the session changes when the architect goes to the editor and back, so it hands its own
     * `getContext`, `handlers`, `fetchImpl`, `origin` and `onChange` over again each time it opens.
     */
    bind(patch = {}) {
      if ('getContext' in patch) getContext = patch.getContext
      if ('handlers' in patch) handlers = patch.handlers ?? {}
      if ('fetchImpl' in patch) fetchImpl = patch.fetchImpl
      if ('origin' in patch) origin = patch.origin
      if ('onChange' in patch) onChange = patch.onChange
      emit()
    },
  }
}
