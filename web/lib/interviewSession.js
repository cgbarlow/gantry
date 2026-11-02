// #286 and #287 (parent #238, docs/adr/0061 and 0065): one **AI interview session** for one Stage of an Instance. It owns the
// conversation with the AI, the drafts it has written into the live preview, the checks on them and the **rounds of question
// cards** it asks. It draws nothing: the Interview page (web/lib/interviewView.js) shows `snapshot()` and calls the methods here.
//
// A session:
//   * builds the interview brief afresh for every turn (web/lib/interviewBrief.js) from `getContext()`, so what the
//     architect saved or uploaded since the last turn is what the AI is told;
//   * runs a turn through the AI client (web/lib/aiClient.js), handing the AI two tools of its own, `draft_field`
//     (web/lib/interviewDraft.js) and `ask_architect` (web/lib/aiCards.js), and carries on until the AI stops calling
//     `draft_field`. A model that doesn't use tools drafts in fenced `gantry-draft` blocks and asks in `gantry-questions`
//     blocks instead (the text fallback); one that can't follow that either is asked in plain chat. Gantry never refuses a model;
//   * shows what the AI asks as a **round** (web/lib/interviewRounds.js): every card whose prerequisites are settled, sorted
//     by Gantry's priority order, four at a time. A card waiting on an unanswered one is held back and shown once it is
//     answered. The round is submitted together and its answers go back to the AI, which redrafts the Fields they feed;
//   * checks each draft on arrival. A draft with problems goes back to the AI once; whatever is left is a warning in the
//     preview, never a block. A Field that already holds saved content is not drafted into: the AI's version becomes a
//     **keep / use the AI's version / merge** card, and only the architect's answer lets it into the preview;
//   * offers **Finish with your recommendations**: every pending recommendation is accepted (a figure the AI proposed is
//     marked "(target assumption)" by Gantry), then the AI asks one last round about only the Fields it can't responsibly propose;
//   * lets the architect switch AI Provider between any two turns. The history is provider-neutral;
//   * (#292) decides, for the AI Provider in use, how each Source document reaches the AI (web/lib/interviewSources.js): its
//     text in the brief, the original attached to the first message (a picture, a scanned or "Read visually" PDF), or not at
//     all. When the pack is over about half the model's window the brief carries a catalogue and the AI is handed one more
//     tool, `read_source_document(id, range)`. Every read is recorded, and a draft carries the reads made since the last
//     drafts, and the documents it cites, as its inputs (the `fields` part of the decisions log, ADR-0064).
//
// Nothing here saves. Drafts are an unsaved preview until the architect confirms the stage-end card.
import { runTurn, runWithRecovery, ensureTested, EMPTY_USAGE } from './aiClient.js'
import { ASK_TOOL_NAME, FALLBACK_FENCE } from './aiCards.js'
import { getAiProvider } from './aiProviders.js'
import { buildInterviewBrief, normalizeSavedContent, requiredFieldKeys } from './interviewBrief.js'
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
import { fieldsInScope } from './interviewScope.js'
import { CHANGE_OPTIONS, acceptRecommendation, answersText, changeCard, choose, chooseOther, followsRecommendation, isAnswered, isAutoId, otherWords, releaseHeld, shapeCard, sortRound, splitReady } from './interviewRounds.js'

export { fieldsInScope }

/** The turns one send may run (each draft or read tool round is a turn), so a model that never stops can't loop for ever. */
export const MAX_ROUNDS = 24

// What the architect sees of the AI's text: neither the draft blocks nor the read requests a text-only model writes.
const shownText = (text) => stripReadBlocks(stripDraftBlocks(text))

/** After this many turns in a row whose question cards were unusable, the rest of the session is asked in plain chat. */
export const CARD_FAILURES_BEFORE_CHAT = 2

const OPENING =
  'Begin the interview. Read the Source documents, open with a short summary of what you found in them, then draft every Field they support. ' +
  'Then ask your first round of question cards: every question whose prerequisites are settled.'

const FINISH_NOTE =
  'The architect chose "Finish with your recommendations". Accept your own recommendations for everything still open: redraft every Field you can responsibly propose, ' +
  'from the Source documents, the answers so far and your recommendations. Gantry marks any figure you propose "(target assumption)". ' +
  'Then ask ONE last round of cards about only the Fields you cannot responsibly propose, such as a named Owner. Ask nothing else, and do not ask a second round.'

const LAST_ROUND_NOTE = 'That was the last round. Redraft the Fields these answers feed. Ask nothing more: the architect has chosen to finish.'

function sessionNote({ cardMode, textDrafts, reader }) {
  const lines = ['## Note for this session', '']
  if (cardMode === 'chat') {
    lines.push('Question cards are not available in this session (this model could not produce them). Where the rules say to ask a card, ask in short plain chat instead, and only what matters most.')
  } else {
    lines.push(
      textDrafts
        ? `Ask the architect with question cards, written as the \`${FALLBACK_FENCE}\` block described below, one round at a time.`
        : `Ask the architect with question cards: call the \`${ASK_TOOL_NAME}\` tool, one round at a time.`,
      'A round is every question whose prerequisites are settled, asked together. Give a card an `id` when another card waits on it, and put the ids it waits on in that card\'s `after`: Gantry holds it back and shows it once they are answered. Do not put a card in a round if its answer depends on another card of the same round: hold it with `after`.',
      'Set `field` to the Field a card feeds, as `module.field`. Set `kind` to `disagreement` when Source documents disagree and `missing` for a fact none of them has. Gantry orders a round itself (Fields this Gate requires, then disagreements, then missing facts, then optional Fields).',
      'A select Field\'s card shows exactly the Definition\'s options and Gantry adds no "Other" to it; every other card gets an "Other" from Gantry, so never add one. Pre-select your recommendation, give a one-line why, and cite the Source document when there is one.',
      'The architect\'s answers come back to you; redraft the Fields they feed. An answer of "Other" is in the architect\'s own words: write it as plain fact and log it as theirs.'
    )
  }
  lines.push(
    textDrafts
      ? `Write each Field in a fenced \`${DRAFT_FENCE}\` block. ${DRAFT_TEXT_FALLBACK_INSTRUCTIONS}`
      : `Write each Field by calling the \`${DRAFT_TOOL_NAME}\` tool, never as chat. You may call it for several Fields in one reply.`,
    'A Field that already holds saved content is not changed by a draft: Gantry shows the architect a keep / use your version / merge card, and tells you the answer. Do not call draft_field for it again until they have answered; if they chose merge, call it once with the merged version.',
    'Gantry works out for itself whether a Field is done: it has content, sits between about 60% of its word budget and its budget, covers each point of its guidance (list any it does not in `uncovered`), and no open question feeds it. The Stage is ready only when the Gate check passes and every such Field is done.'
  )
  if (reader) {
    lines.push(
      textDrafts
        ? `The Source documents are a catalogue. ${READ_TEXT_FALLBACK_INSTRUCTIONS}`
        : `The Source documents are a catalogue. Read the parts you need with the \`${READ_TOOL_NAME}\` tool before you draft from them; you may call it several times in one reply.`
    )
  }
  return lines.join('\n')
}

/** What the AI Provider can do, from its Test connection result: `textDrafts` (no tool calling) and where the card mode `baseline` starts. */
function capabilities(provider) {
  const q = provider?.test?.questionCards
  return { textDrafts: q === 'text' || q === 'chat', baseline: q === 'text' ? 'text' : q === 'chat' ? 'chat' : 'native' }
}

/** `module.field` split into its two ids, or null. */
function splitRef(ref) {
  const text = String(ref ?? '').trim()
  const dot = text.indexOf('.')
  if (dot <= 0 || dot === text.length - 1) return null
  return { moduleId: text.slice(0, dot), fieldId: text.slice(dot + 1) }
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
  let answers = []
  const flush = () => {
    if (results.length) push({ role: 'user', fromGantry: true, text: `Gantry's check of your drafts:\n${results.join('\n')}` })
    for (const text of answers) push({ role: 'user', fromGantry: true, text })
    results = []
    answers = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.name === ASK_TOOL_NAME) answers.push(m.content)
      else results.push(`- ${m.content}`)
      continue
    }
    flush()
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks = m.toolCalls
        .map((c) => {
          if (c.name === DRAFT_TOOL_NAME) return '```' + DRAFT_FENCE + '\n' + JSON.stringify({ field: c.input?.field, value: c.input?.value }) + '\n```'
          if (c.name === READ_TOOL_NAME) return '```' + READ_FENCE + '\n' + JSON.stringify({ id: c.input?.id, range: c.input?.range }) + '\n```'
          if (c.name === ASK_TOOL_NAME) return '```' + FALLBACK_FENCE + '\n' + JSON.stringify({ questions: c.input?.questions ?? [] }) + '\n```'
          return null
        })
        .filter(Boolean)
      push({ role: 'assistant', text: [m.text, ...blocks].filter(Boolean).join('\n\n') || '…' })
    } else {
      push(m)
    }
  }
  flush()
  return out
}

const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim()

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
    phase: 'kickoff', // kickoff | testing | working | asking | waiting | error
    providerId,
    thread: [],
    drafts: {},
    drafting: null,
    preparing: false, // the AI is writing a round of cards
    error: null,
    kickoffError: null,
    testStep: null,
    usage: EMPTY_USAGE,
    savedKeys: [],
    fieldInputs: {}, // `module.field` -> the inputs it was drafted from (#292), kept after a Save: it is the log's `fields` part
    cardMode: 'native', // native | text | chat: how the AI asks, falling back as a model can't manage the one before
    round: null, // { id, cards, page, final }: the cards the architect is answering now
    roundNo: 0,
    held: [], // cards waiting on a card that isn't answered yet
    answered: [], // every card answered so far: { id, header, question, field, labels, other, followed }
    finish: null, // null | accepting | final | done: "Finish with your recommendations"
  }
  let messages = []
  let nextId = 1
  let live = null // the thread item the AI is streaming into
  const bounced = new Set() // Fields already sent back once
  const held = new Map() // a bounced draft that has not been answered yet: shown with its warnings if the AI never answers
  const handled = new Map() // tool call id -> the result, so a draft shown as it arrived is not checked twice
  const pendingChanges = new Map() // module.field -> { saved, proposed, ... }: the AI's version of a Field that holds saved content
  const keptFields = new Set() // the architect chose to keep what is saved
  const authorised = new Set() // the architect chose the AI's version or a merge: this Field may be drafted, until it is saved
  const otherTexts = [] // what the architect typed as "Other" on cards: their own words, so plain fact
  let pendingAsk = null // { callIds }: the native ask_architect call the open round answers
  let cardFailures = 0
  let controller = null
  let readsSinceDraft = [] // the reads made since the last drafts landed (#292)
  let plan = new Map() // how each Source document reaches the AI Provider in use (#292)
  let announced = '' // what the thread last said about unreadable documents, so a repeat is not said twice
  const attachmentCache = new Map()

  const emit = () => onChange?.(snapshot())
  const answeredIds = () => new Set(state.answered.map((a) => a.id))
  const openFields = () => [...new Set([...(state.round?.cards ?? []), ...state.held].map((c) => c.field).filter(Boolean))]
  const snapshot = () => ({
    ...state,
    thread: state.thread.map((t) => ({ ...t })),
    drafts: { ...state.drafts },
    savedKeys: [...state.savedKeys],
    fieldInputs: { ...state.fieldInputs },
    held: state.held.length,
    answered: state.answered.map((a) => ({ ...a })),
    round: state.round ? { ...state.round, cards: state.round.cards.map((c) => ({ ...c, selected: [...c.selected] })) } : null,
    openFields: openFields(),
  })
  const say = (who, text, extra = {}) => {
    const item = { id: nextId++, who, text, ...extra }
    state.thread.push(item)
    return item
  }
  const architectText = () => [...messages.filter((m) => m.role === 'user' && m !== messages[0] && !m.fromGantry).map((m) => m.text), ...otherTexts].join('\n')
  const fieldTitle = (key) => {
    const context = getContext()
    const entry = fieldsInScope(context.definition, context.stageId).get(key)
    return entry ? `${entry.module.title ?? entry.module.id} · ${entry.field.title ?? entry.field.id}` : key
  }

  // ---------- drafting ----------

  /** Checks one draft and, if it passes (or has already been sent back once), puts it in the preview. Returns `{ ok, content }` for the AI. */
  function acceptDraft(ref, rawValue, extra = {}) {
    const context = getContext()
    const scope = fieldsInScope(context.definition, context.stageId)
    const parsed = splitRef(ref)
    const key = parsed ? `${parsed.moduleId}.${parsed.fieldId}` : String(ref)
    const entry = scope.get(key)
    if (!entry) {
      return { ok: false, content: `${ref} is not a Field you can draft on this Stage. Use one listed under "Fields in scope" as module.field. Read-only Modules are context, not yours to write.` }
    }
    if (isBlankValue(rawValue)) return { ok: false, content: `${key}: the value is empty. Send the Field's content, or leave the Field out.` }

    const saved = normalizeSavedContent(context.saved)[parsed.moduleId]?.fields?.[parsed.fieldId]
    const holdsSaved = saved !== undefined && !isBlankValue(saved)
    const knownSourceIds = (context.sources ?? []).filter((s) => s && !s.removedAt).map((s) => s.id)
    const check = checkDraft(entry.field, rawValue, { size: context.size, architectText: architectText(), knownSourceIds, markAssumptions: state.finish !== null })
    const uncovered = extra.uncovered ?? []
    // The inputs are what the AI read before this draft plus what it cites. A draft sent back keeps the ones it had, because the reads are cleared once a round of drafts has landed.
    const inputs = mergeInputs(held.get(key)?.inputs, inputsForDraft({ reads: readsSinceDraft, value: check.value, sources: context.sources }))

    // Saved content changes only through a keep / use / merge card (ADR-0065, rule 3). Only a Field the architect has let the AI
    // change, and an unsaved draft of this session, may be written freely.
    if (holdsSaved && !authorised.has(key)) {
      if (keptFields.has(key)) return { ok: false, content: `${key} already holds saved content and the architect chose to keep it as it is. Do not propose a change to it again.` }
      if (asText(check.value) === asText(saved)) return { ok: false, content: `${key} already holds saved content, and your version is the same as it, so there is nothing to change.` }
      const existing = pendingChanges.get(key)
      pendingChanges.set(key, { saved, proposed: check.value, words: check.words, inputs, warnings: check.problems.map((p) => p.message), uncovered, moduleId: parsed.moduleId, fieldId: parsed.fieldId, shown: existing?.shown ?? false })
      return {
        ok: false,
        content: `${key} already holds saved content, so it is not changed. Gantry will show the architect a keep / use your version / merge card for it. Do not draft ${key} again until they have answered.`,
      }
    }

    if (check.problems.length && !bounced.has(key)) {
      bounced.add(key)
      held.set(key, { value: check.value, words: check.words, inputs, warnings: check.problems.map((p) => p.message), uncovered })
      return {
        ok: false,
        content: `${key} was not shown yet. Fix this and call ${DRAFT_TOOL_NAME} for ${key} once more:\n- ${check.problems.map((p) => p.message).join('\n- ')}`,
      }
    }
    bounced.delete(key)
    held.delete(key)
    state.drafts[key] = { value: check.value, words: check.words, warnings: check.problems.map((p) => p.message), uncovered, inputs, moduleId: parsed.moduleId, fieldId: parsed.fieldId }
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
    else result = acceptDraft(call.input.field, call.input.value, { uncovered: Array.isArray(call.input.uncovered) ? call.input.uncovered.map(String) : [] })
    handled.set(call.id, result)
    return result
  }

  // ---------- rounds of cards ----------

  /**
   * Takes the cards the AI just asked: gives each a unique id, shapes it (select Fields, "Other"), puts cards that wait on an
   * unanswered one aside, and returns those ready to show.
   */
  function ingest(cards) {
    if (cards.length === 0) return []
    const context = getContext()
    const scope = fieldsInScope(context.definition, context.stageId)
    const taken = new Set([...answeredIds(), ...(state.round?.cards ?? []).map((c) => c.id)])
    const idMap = new Map()
    const batch = []
    for (const card of cards) {
      let id = card.id
      if (isAutoId(id) || taken.has(id) || batch.some((b) => b.id === id)) {
        let n = 1
        let candidate = isAutoId(id) ? `r${state.roundNo + 1}-${id}` : `${id}-${n}`
        while (taken.has(candidate) || batch.some((b) => b.id === candidate)) candidate = `${id}-${++n}`
        idMap.set(card.id, candidate)
        id = candidate
      }
      batch.push({ ...card, id })
    }
    const sources = new Map((context.sources ?? []).map((s) => [s.id, s.title || s.filename || s.id]))
    const shaped = batch.map((card) => {
      const after = (card.after ?? []).map((a) => idMap.get(a) ?? a)
      const withSource = card.source ? { ...card, source: { ...card.source, title: sources.get(card.source.document) ?? card.source.document } } : card
      const entry = card.field ? scope.get(card.field) : null
      return shapeCard({ ...withSource, after, type: 'question' }, entry)
    })
    // A card the AI sends again under the id of one held back replaces it.
    state.held = state.held.filter((h) => !shaped.some((c) => c.id === h.id))
    const { ready, held: waiting } = splitReady(shaped, answeredIds(), state.held.map((h) => h.id))
    state.held = [...state.held, ...waiting]
    return ready
  }

  /** At the end of a turn: what the architect is asked next. Opens a round, or leaves none open. */
  function openRound(incoming) {
    const context = getContext()
    const cards = state.finish === 'done' ? [] : ingest(incoming)
    const { released, held: stillHeld } = releaseHeld(state.held, answeredIds(), cards.map((c) => c.id))
    state.held = stillHeld
    const changes = []
    for (const [key, change] of pendingChanges) {
      if (change.shown) continue
      change.shown = true
      changes.push(changeCard({ key, fieldTitle: fieldTitle(key), saved: change.saved, proposed: change.proposed }))
    }
    const all = [...cards, ...released.filter((r) => !cards.some((c) => c.id === r.id)), ...changes]
    if (all.length === 0) {
      state.round = null
      return
    }
    const sorted = sortRound(all, requiredFieldKeys(context.definition, context.stageId, context.artefactId))
    state.round = { id: ++state.roundNo, cards: sorted, page: 0, final: state.finish === 'accepting' }
    if (state.finish === 'accepting') state.finish = 'final'
  }

  /** The thread keeps a record of what was answered. */
  function recordAnswers(cards) {
    for (const card of cards) {
      const own = otherWords(card)
      if (own) otherTexts.push(own)
      state.answered.push({ id: card.id, header: card.header, question: card.question, field: card.field, labels: [...card.selected], other: own, followed: followsRecommendation(card) })
    }
    const lines = cards.map((c) => `${c.header || c.question}: ${[...c.selected, ...(otherWords(c) ? [`“${otherWords(c)}”`] : [])].join(', ')}`)
    say('you', lines.join('\n'), { answered: cards.length })
  }

  /** The architect's decision on each saved-content card. */
  function applyChangeDecisions(cards) {
    for (const card of cards.filter((c) => c.type === 'change')) {
      const key = card.field
      const change = pendingChanges.get(key)
      pendingChanges.delete(key)
      const choice = card.selected[0]
      if (choice === CHANGE_OPTIONS.keep) {
        keptFields.add(key)
        say('sys', `Kept ${fieldTitle(key)} as saved`)
      } else if (choice === CHANGE_OPTIONS.use && change) {
        authorised.add(key)
        state.drafts[key] = { value: change.proposed, words: change.words, warnings: change.warnings, uncovered: change.uncovered, inputs: change.inputs ?? [], moduleId: change.moduleId, fieldId: change.fieldId }
        state.fieldInputs[key] = change.inputs ?? []
        say('sys', `Using the AI's version of ${fieldTitle(key)}`, { drafted: key })
      } else if (choice === CHANGE_OPTIONS.merge) {
        authorised.add(key)
        say('sys', `Merging ${fieldTitle(key)}`)
      }
    }
  }

  // ---------- one send ----------

  function onEvent(event) {
    if (event.type === 'text') {
      const shown = shownText(event.text)
      if (!shown) return
      if (!live) live = say('ai', '', { streaming: true })
      live.text = shown
      emit()
    } else if (event.type === 'preparing-questions') {
      state.preparing = true
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
    const { textDrafts } = capabilities(provider)
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
      system: `${brief.text}\n\n${sessionNote({ cardMode: state.cardMode, textDrafts, reader })}`,
      tools: textDrafts ? [] : [DRAFT_TOOL, ...(reader ? [READ_TOOL] : [])],
      withAttachments,
      knownSources: (context.sources ?? []).filter((s) => !s.removedAt).map((s) => ({ id: s.id, title: s.title })),
    }
  }

  function settleLive(shown) {
    if (live) {
      live.text = shown
      live.streaming = false
      if (!shown) state.thread = state.thread.filter((t) => t !== live)
    } else if (shown) {
      say('ai', shown)
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
    state.preparing = false
    controller = new AbortController()
    emit()
    let incoming = []
    let textRetried = false
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        live = null
        const result = await runWithRecovery(async () => {
          const provider = getAiProvider(state.providerId)
          if (!provider) throw new Error('This AI Provider no longer exists. Choose another.')
          const { textDrafts } = capabilities(provider)
          const { system, tools, withAttachments, knownSources } = await prepare(provider)
          const history = withAttachments(textDrafts ? flattenToolHistory(messages) : messages)
          return runTurn(provider, { system, messages: history, tools, knownSources, askCards: state.cardMode !== 'chat' }, { fetchImpl, origin, signal: controller.signal, onEvent })
        }, handlers)
        state.usage = {
          inputTokens: state.usage.inputTokens + result.usage.inputTokens,
          outputTokens: state.usage.outputTokens + result.usage.outputTokens,
          cacheReadTokens: state.usage.cacheReadTokens + result.usage.cacheReadTokens,
          cacheWriteTokens: state.usage.cacheWriteTokens + result.usage.cacheWriteTokens,
        }
        const provider = getAiProvider(state.providerId)
        const textDrafts = provider ? capabilities(provider).textDrafts : false
        // The attachments go on the first message of each request and are not kept in the history, so a switch of AI Provider can decide them afresh.
        const base = (result.messages ?? messages).map((m, i) => (i === 0 ? messages[0] : m))
        state.preparing = false

        // ---- a round of question cards ----
        if (result.kind === 'cards') {
          cardFailures = 0
          settleLive(shownText(result.text))
          messages = [...base, result.assistantMessage]
          if (!textDrafts) {
            for (const call of result.otherToolCalls) {
              const outcome = resultFor(call)
              messages.push({ role: 'tool', toolCallId: call.id, name: call.name, isError: !outcome.ok, content: outcome.content })
            }
            if (result.otherToolCalls.some((c) => c.name === DRAFT_TOOL_NAME)) readsSinceDraft = []
          } else {
            const { drafts } = extractDraftBlocks(result.text)
            for (const d of drafts) acceptDraft(d.field, d.value, { uncovered: d.uncovered })
            if (drafts.length) readsSinceDraft = []
          }
          const callIds = (result.assistantMessage.toolCalls ?? []).filter((c) => c.name === ASK_TOOL_NAME).map((c) => c.id)
          if (state.finish === 'done') {
            // The architect chose to finish and has had the last round: the cards are not shown.
            const note = 'Not shown: the architect chose Finish with your recommendations and has had the last round. Write your best drafts and ask nothing more.'
            if (callIds.length) for (const id of callIds) messages.push({ role: 'tool', toolCallId: id, name: ASK_TOOL_NAME, isError: true, content: note })
            else messages.push({ role: 'user', fromGantry: true, text: note })
            state.drafting = false
            emit()
            continue
          }
          pendingAsk = callIds.length ? { callIds } : null
          incoming = result.cards
          break
        }

        if (result.kind === 'tools' && !textDrafts) {
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

        // ---- a reply with no more tool calls. Text-fallback drafts and reads are taken from it ----
        const shown = shownText(result.text)
        settleLive(shown)
        messages = [...base, { role: 'assistant', text: result.text }]
        const notes = []
        let retry = false
        let readsReply = ''
        if (textDrafts) {
          const { drafts, errors } = extractDraftBlocks(result.text)
          const requested = extractReadBlocks(result.text)
          // Reads are answered first, so a draft in the same reply is checked with them already recorded as its inputs.
          const answers = requested.reads.map((r) => runRead(r))
          const outcomes = drafts.map((d) => ({ d, ...acceptDraft(d.field, d.value, { uncovered: d.uncovered }) }))
          if (drafts.length) readsSinceDraft = []
          notes.push(...errors, ...requested.errors, ...outcomes.filter((o) => !o.ok).map((o) => o.content))
          if (round < MAX_ROUNDS - 1 && (answers.length || (notes.length && outcomes.some((o) => !o.ok) && held.size))) {
            retry = true
            readsReply = answers.length ? `Gantry's reply to your read requests:\n\n${answers.map((a) => a.content).join('\n\n')}` : ''
          }
        }
        // Question cards the model wrote that were unusable: a text-fallback model is told once; a model that keeps failing is asked in plain chat.
        if (result.invalidCards?.length && state.cardMode !== 'chat') {
          if (textDrafts && !textRetried && round < MAX_ROUNDS - 1) {
            textRetried = true
            retry = true
            notes.push(`Your question block was not usable:\n  - ${result.invalidCards.join('\n  - ')}\nSend it again as one \`${FALLBACK_FENCE}\` block.`)
          } else if (++cardFailures >= CARD_FAILURES_BEFORE_CHAT) {
            state.cardMode = 'chat'
            say('sys', 'This model could not produce valid question cards, so Gantry will ask in plain chat from here on. That works, but is less reliable.')
          }
        }
        if (retry) {
          const check = notes.length ? `Gantry's check of your drafts:\n- ${notes.join('\n- ')}` : ''
          messages.push({ role: 'user', fromGantry: true, text: [readsReply, check].filter(Boolean).join('\n\n') })
          emit()
          continue
        }
        break
      }
      promoteHeld()
      openRound(incoming)
      if (state.finish === 'accepting') state.finish = 'done'
      state.phase = state.round ? 'asking' : 'waiting'
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
      state.preparing = false
      for (const t of state.thread) if (t.streaming) t.streaming = false
      emit()
    }
  }

  // ---------- the session's methods ----------

  function setCard(cardId, change) {
    if (state.phase !== 'asking' || !state.round) return
    state.round = { ...state.round, cards: state.round.cards.map((c) => (c.id === cardId ? change(c) : c)) }
    emit()
  }

  /** A native ask_architect call that was never answered needs a result before anything else can be said. */
  function closePendingAsk(note) {
    if (!pendingAsk?.callIds.length) return
    for (const id of pendingAsk.callIds) messages.push({ role: 'tool', toolCallId: id, name: ASK_TOOL_NAME, content: note })
    pendingAsk = null
  }

  async function answer({ finish }) {
    if (state.phase !== 'asking' || !state.round) return { ok: false, message: 'There is no round to answer.' }
    const round = state.round
    const cards = finish ? round.cards.map(acceptRecommendation) : round.cards
    const open = cards.filter((c) => !isAnswered(c))
    if (open.length) return { ok: false, message: `${open.length} card${open.length === 1 ? ' is' : 's are'} not answered yet.`, firstOpen: open[0].id }

    applyChangeDecisions(cards)
    recordAnswers(cards)
    state.round = null
    const last = round.final || state.finish === 'final'
    if (finish && !last) {
      state.finish = 'accepting'
      state.held = []
    }
    if (last) state.finish = 'done'
    const heldIds = state.held.map((h) => h.id)
    const body = [
      `The architect answered ${cards.length === 1 ? 'the card' : `all ${cards.length} cards`} of round ${round.id}:`,
      answersText(cards, { fieldTitle: (key) => key }),
      heldIds.length ? `\nHeld back until the cards they wait on are answered (Gantry shows them then; send a card again under the same id to change it): ${heldIds.join(', ')}.` : '',
      last ? `\n${LAST_ROUND_NOTE}` : finish ? `\n${FINISH_NOTE}` : '\nRedraft the Fields these answers feed, then ask the next round of whatever is now ready, or say that you are done.',
    ]
      .filter(Boolean)
      .join('\n')
    if (pendingAsk?.callIds.length) {
      const [first, ...rest] = pendingAsk.callIds
      messages.push({ role: 'tool', toolCallId: first, name: ASK_TOOL_NAME, content: body })
      for (const id of rest) messages.push({ role: 'tool', toolCallId: id, name: ASK_TOOL_NAME, content: 'Answered together with the first ask_architect call.' })
    } else {
      messages.push({ role: 'user', fromGantry: true, text: body })
    }
    pendingAsk = null
    await runLoop()
    return { ok: true }
  }

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
      state.cardMode = capabilities(started).baseline
      cardFailures = 0
      say('sys', `Interview started with ${started?.name ?? 'the AI Provider'}`)
      if (state.cardMode === 'text') {
        say('sys', "This model doesn't use tools, so it asks and drafts in text (the text fallback). That works, but is less reliable.")
      } else if (state.cardMode === 'chat') {
        say('sys', 'This model cannot produce question cards, so it asks in plain chat. That works, but is less reliable.')
      }
      messages = [{ role: 'user', text: OPENING }]
      await runLoop()
    },

    /** Free chat: what the architect types goes to the AI as it is. Cards still open are put away and can be asked again. */
    async send(text) {
      const body = String(text ?? '').trim()
      if (!body || state.phase === 'working' || state.phase === 'kickoff' || state.phase === 'testing') return
      say('you', body)
      if (state.round) {
        for (const card of state.round.cards) if (card.type === 'change' && pendingChanges.has(card.field)) pendingChanges.get(card.field).shown = false
        state.round = null
      }
      closePendingAsk('The architect did not answer these cards. They wrote in chat instead, below. Ask again if you still need them.')
      messages = [...messages, { role: 'user', text: body }]
      await runLoop()
    },

    /** Carries on after a failure (the history is intact: the architect's last message is already in it). */
    async retry() {
      if (state.phase !== 'error') return
      await runLoop()
    },

    // ---- the open round ----
    /** Choose option `label` on a card. */
    choose(cardId, label) {
      setCard(cardId, (c) => choose(c, label))
    },
    /** Choose (or, on a "choose any" card, toggle) "Other". */
    chooseOther(cardId) {
      setCard(cardId, (c) => chooseOther(c))
    },
    /** The text of "Other". Typing in it chooses it. */
    setOtherText(cardId, text) {
      setCard(cardId, (c) => ({ ...(c.otherOn ? c : chooseOther(c)), otherText: String(text ?? '') }))
    },
    /** Move to page `page` (0-based) of the round. */
    setPage(page) {
      if (!state.round) return
      state.round = { ...state.round, page: Math.max(0, page) }
      emit()
    },
    /** Submit the whole round. Resolves `{ ok, message? }`; a round with an unanswered card is not submitted. */
    submitRound() {
      return answer({ finish: false })
    },
    /**
     * "Finish with your recommendations", always available: accepts every pending recommendation, then the AI asks one last
     * round about only the Fields it can't responsibly propose. The stage-end card waits for that round.
     */
    async finishWithRecommendations() {
      if (state.phase === 'asking') return answer({ finish: true })
      if (state.phase !== 'waiting') return { ok: false, message: 'Wait for the AI to finish its turn first.' }
      state.finish = 'accepting'
      state.held = []
      say('you', 'Finish with your recommendations')
      closePendingAsk('The architect did not answer these cards. They chose Finish with your recommendations, below.')
      messages = [...messages, { role: 'user', fromGantry: true, text: FINISH_NOTE }]
      await runLoop()
      return { ok: true }
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
      state.cardMode = capabilities(now).baseline
      cardFailures = 0
      say('sys', `Switched to ${now?.name ?? 'another AI Provider'}${now?.model ? ` (${now.model})` : ''}`)
      emit()
      return { ok: true }
    },

    /** The drafts were saved: they are no longer an unsaved preview, and the Fields now hold saved content again. */
    markSaved(keys) {
      for (const key of keys) {
        delete state.drafts[key]
        authorised.delete(key)
        pendingChanges.delete(key)
      }
      state.savedKeys = [...new Set([...state.savedKeys, ...keys])]
      say('sys', `Saved ${keys.length} Field${keys.length === 1 ? '' : 's'}. The Modules stay draft.`)
      emit()
    },

    /** Drops every unsaved draft. */
    discardDrafts() {
      state.drafts = {}
      authorised.clear()
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
