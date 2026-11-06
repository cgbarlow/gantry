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
//   * (#319, docs/adr/0072) hands the AI three read-only tools for a **code repository** Source document, `list_repository_folder`,
//     `search_repository` and `read_repository_file`, answered by the Gantry server with the architect's own token (`context.readRepository`).
//     Nothing of a repository is in the brief. A file read is recorded with the commit it saw, as an input of the Fields drafted next.
//   * (#328, docs/adr/0073) shortens **old reads** in the conversation (`shortenOldReads`): once a read is more than three AI turns old its
//     text is replaced by a one-line note naming what was read, in batches so the cached conversation keeps paying off between them.
//   * (#329, docs/adr/0073) **compacts** the conversation before it outgrows the model's context window (`compactNow`, `compactConversation`):
//     a card offers it once the input the AI Provider reported passes about 60% of the window, Compact now does it at any time, and a
//     request the AI Provider refuses as too long is compacted without asking and sent once more. The conversation starts afresh from
//     Gantry's opening, the AI's own "where we are" summary, the drafts and the architect's own messages word for word; the thread, the
//     drafts, the round and the decisions log are untouched but for one line in the thread, and the summary is never logged.
//
//   * (#289) lets the architect **hand-edit** a drafted Field in the preview (`beginHandEdit` / `handEdit`). The edit is theirs from then
//     on: Gantry's per-Field check does not run on it, it is logged as a `hand-edit` entry with the text they typed, and the Field's
//     inputs are rebuilt from that text (only the Source documents it still cites). The AI changes it only through a keep / use the AI's
//     version / merge card. Asking for a change in free chat (the AI logs the request as a fact) or choosing the AI's version on a card
//     hands the Field back. A Field the AI is drafting at that moment (`draftingFields`) cannot be edited.
//
//   * (#298) opens with **Bring up to date** when the context carries `update` (the Fields flagged Out of date that this Stage can act on,
//     web/lib/bringUpToDate.js): a round of cards, one per Field, shown before the AI is called. A session that is only bringing Fields up to
//     date (`update.mode` is `only`) ends there and has nothing else to ask; a normal session goes on to its usual opening afterwards. Each
//     answer is a `source-update` entry in the decisions log (only answering clears a flag); a re-cite is done by Gantry; a redraft is the
//     AI's, and meets the keep / use the AI's version / merge card like any change to saved content. A Module marked `agreed` that a saved
//     draft changes goes back to `draft`, and the log keeps a `returned-to-draft` note saying why. A normal session also tells the AI which
//     Source documents are New since last interview, to read against what is saved.
//
//   * (#303) works through **review comments** when the context carries `review` (the questions a Reviewed copy's threads ask, web/lib/reviewRound.js):
//     as a focused round of cards (`review.mode` is `only`), or joined to the next round of an interview that is going (`joinReview`, or `join` at the start).
//     One card per comment thread, answered accept or revise / keep as is / can't settle yet. An accepted tracked edit is made by Gantry when it can be
//     made without guessing, and sits in the preview like any draft; a revision meets the keep / use the AI's version / merge card. Each answered
//     thread is a `review-answered` entry (real names, the comment word for word); the AI is only told "Reviewer 1", "Reviewer 2".
//
//   * (#299) opens with a **revision** when the context carries `revise` (the Owner sent the Stage back from its Pull Request): Gantry lists every
//     comment on it, resolved ones included, in the conversation and asks one card per comment before the AI is called. Each answer is a
//     `pr-comment-answered` entry in the decisions log (who wrote the comment, where, a link, an excerpt and the entries that answered it); the AI
//     redrafts only what the architect chose to change, and saved content still changes only through keep / use the AI's version / merge. Nothing
//     is ever written to the Pull Request. The AI may also **offer to re-open** a signed-off Stage with a card of `kind: "reopen"`: Gantry makes
//     that card only when it would allow the re-open right then (`context.reopen`), and otherwise logs an open question naming the blocker.
//
//   * (#349) tells the AI what keeps the Stage from its stage-end card (`readinessNote`): when a turn would end with the Stage not ready and
//     nothing open for the architect, Gantry sends the page's own readiness verdict (`context.readiness`, web/lib/interviewReadiness.js) as a
//     note, and the AI carries on in the same turn, once a turn.
//
// Nothing here saves. Drafts are an unsaved preview until the architect confirms the stage-end card.
import { runTurn, runWithRecovery, ensureTested, isTooLong, EMPTY_USAGE, CUT_OFF_CALL_RESULT, CUT_OFF_NOTE } from './aiClient.js'
import { ASK_TOOL_NAME, FALLBACK_FENCE } from './aiCards.js'
import { AiProviderError, getAiProvider } from './aiProviders.js'
import { artefactChoices, buildInterviewBrief, estimateTokens, normalizeSavedContent, requiredFieldKeys } from './interviewBrief.js'
import { DRAFT_TOOL, DRAFT_TOOL_NAME, DRAFT_FENCE, DRAFT_TEXT_FALLBACK_INSTRUCTIONS, checkDraft, extractDraftBlocks, isBlankValue, normaliseDraftValue, citedSourceIds, stripDraftBlocks } from './interviewDraft.js'
import { countWords } from './targetSize.js'
import { outstandingItems, outstandingLine } from './interviewReadiness.js'
import {
  READ_TOOL,
  READ_TOOL_NAME,
  READ_FENCE,
  READ_TEXT_FALLBACK_INSTRUCTIONS,
  REPOSITORY_TEXT_FALLBACK_INSTRUCTIONS,
  REPOSITORY_TOOLS,
  REPOSITORY_TOOL_NAMES,
  FIND_REPOSITORY_TOOL_NAME,
  LIST_REPOSITORY_TOOL_NAME,
  READ_REPOSITORY_TOOL_NAME,
  SEARCH_REPOSITORY_TOOL_NAME,
  runRepositoryCall,
  accessForBrief,
  attachmentNote,
  describeInput,
  extractReadBlocks,
  fingerprintText,
  inputsForDraft,
  loadAttachments,
  planSourceAccess,
  readNote,
  runReadCall,
  sourcesForBrief,
  stripReadBlocks,
} from './interviewSources.js'
import { fieldsInScope } from './interviewScope.js'
import { openQuestionsToCarry, standardDraftProblems, standardRoles, termChoices } from './interviewStandard.js'
import { LOG_TOOL, LOG_TOOL_NAME, LOG_FENCE, LOG_TEXT_FALLBACK_INSTRUCTIONS, createSessionLog, extractLogBlocks, stripLogBlocks } from './interviewLog.js'
import { currentLogEntries, findArchitectMessage, logSummary } from './decisionsLog.js'
import { formatTokens, tokensOfModels } from './tokenUsage.js'
import { resumeOpening } from './interviewResume.js'
import { conflictKey, conflictText, conflictValueFromText } from './stageVersion.js'
import { reapprovalNames, reapprovalOf } from './interviewReapproval.js'
import { UPDATE_OPENING, needsAi, newSinceNote, reciteValue, removedSourcesOf, resolveUpdateCard, returnedToDraftNote, updateAnswersText, updateCards } from './bringUpToDate.js'
import { REVIEW_OPENING, editsToAccept, applyTrackedEdits, reviewAnswersText, reviewCards, reviewEntriesFor, reviewNeedsAi, reviewNeedsInput, reviewOpenQuestion, resolveReviewCard } from './reviewRound.js'
import { REVISION_NO_COMMENTS, REVISION_OPENING, commentAnswersText, commentCards, commentNeedsAi, commentsMessage, reopenBlockedQuestion, reopenCard, resolveCommentCard } from './prRevision.js'
import { CLASH_OPTIONS, CHANGE_OPTIONS, acceptRecommendation, answersText, changeCard, choose, chooseOther, clashCard, followsRecommendation, isAnswered, isAutoId, otherWords, releaseHeld, shapeCard, sortRound, splitReady, termChoice, withMerged } from './interviewRounds.js'

export { fieldsInScope }

/** The turns one send may run (each draft or read tool round is a turn), so a model that never stops can't loop for ever. */
export const MAX_ROUNDS = 24

// What the architect sees of the AI's text: neither the draft blocks nor the read requests a text-only model writes.
const shownText = (text) => stripLogBlocks(stripReadBlocks(stripDraftBlocks(text)))

/** #344: the thread's line when the AI's reply is cut off at the output limit twice in a row, said once a turn. */
export function cutOffAgainLine(providerName) {
  return `The AI's reply was cut off at the output limit again. To give it more room, raise Max tokens for ${providerName || 'this AI Provider'} under AI Providers on Global Settings.`
}

/** #345: what Carry on sends, as the architect's own message, after a turn that ended with nothing to show. */
export const CARRY_ON_MESSAGE = 'go on'

/** #345: the thread's line when a turn ends with nothing new to show: no text, no question card and no draft. */
export const STOPPED_LINE = 'The AI stopped without replying.'

/** #345: the thread's line when a turn ends because the AI used up its rounds of tool calls (`MAX_ROUNDS`) while still calling tools. */
export function roundsUsedUpLine(rounds = MAX_ROUNDS) {
  return `The AI used up its ${rounds} rounds of tool calls for this turn and stopped.`
}

/**
 * #349: Gantry's note to the AI when its turn would end with the Stage not ready and nothing open for the architect: what keeps the Stage
 * from its stage-end card, from the page's own readiness (web/lib/interviewReadiness.js `stageReadiness`): the Gate check's outstanding items
 * for the Artefact aimed for, then each Field in scope that isn't done with Gantry's reasons. `fieldTitle(key)` names a Field
 * ("Module · Field"); `chat` says the architect is asked in plain chat rather than on cards. #350: the list is `outstandingItems`, the one
 * the architect's Not ready yet card shows, with each Field's key after its name so the AI can draft it.
 */
export function readinessNote(readiness, { fieldTitle = (key) => key, chat = false } = {}) {
  const named = (key) => `${fieldTitle(key)} (${key})`
  return [
    "Gantry's check: the Stage is not ready yet, so the architect has no stage-end card. What stands in the way:",
    ...outstandingItems(readiness, { name: named }).map((item) => `- ${outstandingLine(item)}`),
    `Redraft now what you can from the Source documents and the answers you have. Ask the architect${chat ? ', in short plain chat,' : ', with question cards,'} only for what you cannot settle yourself. ` +
      'If nothing here is yours to settle, say in a sentence what stands in the way. Gantry sends this note once a turn.',
  ].join('\n')
}

/** After this many turns in a row whose question cards were unusable, the rest of the session is asked in plain chat. */
export const CARD_FAILURES_BEFORE_CHAT = 2

const OPENING =
  'Begin the interview. Read the Source documents, open with a short summary of what you found in them, then draft every Field they support. ' +
  'Then ask your first round of question cards: every question whose prerequisites are settled.'

/** The opening message of a normal session, with the note about documents that are New since the last interview. */
const openingFor = (context, base = OPENING) => [base, newSinceNote(context?.newSince)].filter(Boolean).join('\n\n')

const FINISH_NOTE =
  'The architect chose "Finish with your recommendations". Accept your own recommendations for everything still open: redraft every Field you can responsibly propose, ' +
  'from the Source documents, the answers so far and your recommendations. Gantry marks any figure you propose "(target assumption)". ' +
  'Then ask ONE last round of cards about only the Fields you cannot responsibly propose, such as a named Owner. Ask nothing else, and do not ask a second round.'

// #296 (docs/adr/0063): a Stage drafted ahead gets a head start only, and the Modules an earlier Stage also mounts are held. When that Stage is approved and merged they open.
const opened = (modules, stageTitle) =>
  `${stageTitle} was approved and merged, so these Modules are no longer held and are now in scope: ${modules.map((m) => `${m.title ?? m.id} (${m.id})`).join(', ')}. ` +
  'Extend their Fields now, from the Source documents, the answers so far and what that Stage settled. Then ask your next round of cards: every question whose prerequisites are settled.'

/** #319: the thread line for a code repository read refused for a reason the architect has to act on (web/lib/interviewSources.js). */
export function repositoryBlockedLine({ title, code, message }) {
  const fix =
    code === 'no-access'
      ? ' Give a token that can read it with "Your token" on its row in the Source documents list, then carry on.'
      : code === 'rate-limited'
        ? ' To carry on now, give a token with "Your token" on its row in the Source documents list.'
        : ''
  return `Can't read the code repository ${title}: ${message}${fix} The AI is told so and won't rely on it.`
}

/**
 * #336: the thread's line for a repository read that failed for a temporary reason (cut off, out of time). The repository isn't blocked:
 * the AI is told the read failed and may try it again.
 */
export function repositoryFailedLine({ title, message }) {
  return `Couldn't read the code repository ${title} just now: ${message} The AI is told, and may try again.`
}

/**
 * #338: the thread's line while a repository tool call waits for the Gantry server to download its copy of the repository:
 * "Preparing Billing API… 12.4 MB". The #341 status line may fold it in; `state.preparingRepository` is what it is made from.
 */
export function preparingRepositoryLine({ title, receivedBytes }) {
  const mb = Number(receivedBytes) > 0 ? ` ${(receivedBytes / (1024 * 1024)).toFixed(1)} MB` : ''
  return `Preparing ${title}…${mb}`
}

/**
 * #341: the one status line at the bottom of the thread while the AI is busy: what is under way, the most specific thing first, so it is
 * never hidden while anything is still going on. Returns null when the AI is not busy (the architect has the turn), else
 * `{ kind, text, detail, ticking }`: `detail` is the part that keeps changing (the seconds waited, the megabytes downloaded), which the page
 * shows beside the text but does not announce; `ticking` says the seconds go up, so the page redraws it every second. `now` is in ms.
 */
export function statusLine(snap, now = Date.now()) {
  if (!snap || snap.phase !== 'working') return null
  const line = (kind, text, detail = null, ticking = false) => ({ kind, text, detail, ticking })
  const seconds = (since) => `${Math.max(0, Math.floor((now - Number(since ?? now)) / 1000))} s`
  const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0])
  if (snap.compacting) return line('compacting', 'Compacting the conversation…')
  if (snap.preparingRepository) {
    const { title, receivedBytes } = snap.preparingRepository
    return line('preparing-repository', `Preparing ${title}…`, Number(receivedBytes) > 0 ? `${(receivedBytes / (1024 * 1024)).toFixed(1)} MB` : null)
  }
  if (snap.tool) return line(snap.tool.kind, toolText(snap.tool))
  if (snap.drafting || snap.draftingFields?.length) {
    const titles = snap.draftingTitles ?? []
    return line('drafting', titles.length ? `Drafting ${listOf(titles)}…` : 'Drafting…')
  }
  if (snap.preparing) return line('preparing', 'Preparing questions…')
  // #344: the reply before reached the output limit, and the request now under way asks for a shorter one.
  if (snap.waiting?.cutOff) return line('cut-off', 'Reply cut off at the output limit. Asking for a shorter one…', seconds(snap.waiting.since), true)
  if (snap.waiting?.without) {
    const plural = / and /.test(snap.waiting.without) ? 'settings' : 'setting'
    return line('retrying', `Trying again without the ${snap.waiting.without} ${plural}…`, seconds(snap.waiting.since), true)
  }
  if (snap.waiting) return line('waiting', 'Waiting for the AI…', seconds(snap.waiting.since), true)
  if (snap.writing) return line('writing', 'Writing…')
  return line('working', 'Working…')
}

// #341: what a read the AI is making says on the status line. `title` is null until the call's arguments name the document or repository.
function toolText({ kind, title, path, range, query, pattern }) {
  const where = (p) => (p ? ` ${p}` : '')
  if (kind === 'searching') return title ? `Searching ${title}${query ? ` for "${query}"` : ''}…` : 'Searching a code repository…'
  if (kind === 'finding') return title ? `Finding files${pattern ? ` named "${pattern}"` : ''} in ${title}…` : 'Finding files in a code repository…'
  if (kind === 'listing') return title ? `Listing ${title}${where(path)}…` : 'Listing a code repository…'
  if (!title) return 'Reading a Source document…'
  return `Reading ${title}${path ? where(path) : range ? `, ${range}` : ''}…`
}

const LAST_ROUND_NOTE = 'That was the last round. Redraft the Fields these answers feed. Ask nothing more: the architect has chosen to finish.'

function sessionNote({ cardMode, textDrafts, reader, repositories = false, handEdits = [] }) {
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
      'The architect\'s answers come back to you; redraft the Fields they feed. An answer of "Other" is in the architect\'s own words: write it as plain fact and log it as theirs.',
      'To settle which name to prefer for one thing, ask a card with `kind` "term": each name is an option and `meaning` says what the thing is. Gantry logs the choice, the others become names to avoid, and it binds every later Stage. To offer a Key decision (only where the brief says the module is mounted, and only when it is hard to reverse, surprising and a real trade-off), ask a card with `kind` "decision" and `decision` giving the one-line reason for each of the three.'
    )
  }
  lines.push(
    textDrafts
      ? `Write each Field in a fenced \`${DRAFT_FENCE}\` block. ${DRAFT_TEXT_FALLBACK_INSTRUCTIONS}`
      : `Write each Field by calling the \`${DRAFT_TOOL_NAME}\` tool, never as chat. You may call it for several Fields in one reply.`,
    'A Field that already holds saved content is not changed by a draft: Gantry shows the architect a keep / use your version / merge card, and tells you the answer. Do not call draft_field for it again until they have answered; if they chose merge, call it once with the merged version.',
    textDrafts
      ? `${LOG_TEXT_FALLBACK_INSTRUCTIONS}`
      : `When the architect tells you something in chat that you use in a Field, call the \`${LOG_TOOL_NAME}\` tool (kind "fact") with a quote copied exactly from their message and the Fields it feeds; for a question that stays open (including a select Field where none of the options fits) call it with kind "open-question", which records it and does not hold the Field back. Answers to cards are logged by Gantry itself. Never log thanks or "go on".`,
    'In draft_field, name what each Field is drafted from in `inputs` (Source document ids with a page range, or a Field of an earlier Stage as module.field): Gantry checks they exist and records them in the decisions log.',
    'Gantry works out for itself whether a Field is done: it has content, sits between about 60% of its word budget and its budget, covers each point of its guidance (list any it does not in `uncovered`), and no question card feeding it is still unanswered or held back. Logging an open question records it in the decisions log; it does not hold a Field back. The Stage is ready only when the Gate check passes and every such Field is done.',
    // #349: the AI can't see the page, so it is told how it learns what stands in the way, rather than guessing.
    "You can't see the stage-end card. When your turn would end with the Stage not ready and no card open, Gantry tells you what stands in the way, once a turn: fix what you can, and ask the architect only for the rest."
  )
  if (reader) {
    lines.push(
      textDrafts
        ? `The Source documents are a catalogue. ${READ_TEXT_FALLBACK_INSTRUCTIONS}`
        : `The Source documents are a catalogue. Read the parts you need with the \`${READ_TOOL_NAME}\` tool before you draft from them; you may call it several times in one reply.`
    )
  }
  if (repositories) {
    lines.push(
      textDrafts
        ? REPOSITORY_TEXT_FALLBACK_INSTRUCTIONS
        : `Read a code repository with the \`${FIND_REPOSITORY_TOOL_NAME}\`, \`${SEARCH_REPOSITORY_TOOL_NAME}\`, \`${LIST_REPOSITORY_TOOL_NAME}\` and \`${READ_REPOSITORY_TOOL_NAME}\` tools before you draft from it; you may call them several times in one reply. A search covers every file and its results are paged: ask for the next page when you need more.`
    )
  }
  if (handEdits.length) {
    lines.push(
      '',
      '## Fields the architect edited by hand',
      '',
      'These Fields are now the architect\'s own wording, shown as they stand. Do not redraft them: Gantry holds a draft of one and shows the architect a keep / use your version / merge card instead, and tells you the answer. ' +
        `If the architect asks you in chat to change one, first log their request (\`${LOG_TOOL_NAME}\`, kind "fact", a quote copied exactly from their message, and the Field in \`fields\`), then draft it: Gantry accepts a draft of a hand-edited Field only after that. Treat what they wrote as settled fact, not as something to improve.`,
      ...handEdits.flatMap(({ key, text }) => ['', `### ${key}`, '', text])
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

// The Artefacts that can pass a Stage's Gate, and the lightest: kept with the brief, which names the one aimed for (#332).
export { artefactChoices }

// ---------- shortening old reads (#328, docs/adr/0073) ----------
// Every read the AI makes (a Source document, a repository file, a search) stays in the conversation and is sent again with every later
// call. A message that holds reads says where each sits in its text, `reads: [{ at, length, label }]`; once the message is more than
// READ_NOTE_AFTER_TURNS AI turns old (that many of the AI's replies have come after it), each read is replaced by its `readNote`. That is
// done in batches, only when the batch saves at least READ_NOTE_MIN_SAVING tokens, because changing an early message means the cached
// conversation from there on is written afresh. Citations, Out of date (the Fields' inputs) and the thread's "Read …" lines are untouched.

/** A read is shortened once more than this many of the AI's replies have come after it, so one from the current turn never is. */
export const READ_NOTE_AFTER_TURNS = 3
/** About how many tokens a batch of shortening must save to be done. */
export const READ_NOTE_MIN_SAVING = 20000

/** The `reads` of a message whose whole text is one read or search result (`outcome` is what the tool returned), or nothing. */
const readsOf = (outcome) => (outcome?.ok && outcome.label ? { reads: [{ at: 0, length: String(outcome.content).length, label: outcome.label }] } : {})

/** One tool call's result as a message of the history. */
const toolMessage = (call, outcome) => ({ role: 'tool', toolCallId: call.id, name: call.name, isError: !outcome.ok, content: outcome.content, ...readsOf(outcome) })

/** Joins `parts` (`{ text, reads? }`) with `separator`, keeping where each read sits so the joined text can still be shortened. */
function joinParts(parts, separator) {
  let text = ''
  const reads = []
  parts.forEach((part, i) => {
    if (i) text += separator
    for (const read of part.reads ?? []) reads.push({ ...read, at: read.at + text.length })
    text += part.text
  })
  return { text, ...(reads.length ? { reads } : {}) }
}

/** `message` with each of its reads replaced by the one-line note. */
function shortenMessage(message) {
  const key = message.role === 'tool' ? 'content' : 'text'
  let text = String(message[key] ?? '')
  for (const read of [...message.reads].sort((a, b) => b.at - a.at)) text = `${text.slice(0, read.at)}${readNote(read.label)}${text.slice(read.at + read.length)}`
  const { reads: _reads, ...rest } = message
  return { ...rest, [key]: text }
}

/**
 * The history with its old reads shortened, when that saves enough; otherwise `messages` itself. Pure: the session keeps what it returns, so
 * a read shortened once stays shortened and the start of the conversation is the same from call to call.
 */
export function shortenOldReads(messages, { afterTurns = READ_NOTE_AFTER_TURNS, minSaving = READ_NOTE_MIN_SAVING } = {}) {
  const old = new Set()
  let saving = 0
  let replies = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.reads?.length && replies > afterTurns) {
      old.add(i)
      const text = String((m.role === 'tool' ? m.content : m.text) ?? '')
      for (const read of m.reads) saving += estimateTokens(text.slice(read.at, read.at + read.length)) - estimateTokens(readNote(read.label))
    }
    if (m.role === 'assistant') replies++
  }
  if (!old.size || saving < minSaving) return messages
  return messages.map((m, i) => (old.has(i) ? shortenMessage(m) : m))
}

// A model without tool calling is shown its earlier tool calls as the blocks it would have written, and the
// results as one message from Gantry; two messages from the same side are joined (keeping where their reads sit, #328).
function flattenToolHistory(messages) {
  const out = []
  const push = (message) => {
    const last = out[out.length - 1]
    if (last && last.role === 'user' && message.role === 'user' && !last.images && !message.images && !last.documents && !message.documents) Object.assign(last, joinParts([last, message], '\n\n'))
    else out.push({ ...message })
  }
  let results = []
  let answers = []
  const flush = () => {
    if (results.length) push({ role: 'user', fromGantry: true, ...joinParts([{ text: "Gantry's check of your drafts:" }, ...results], '\n') })
    for (const text of answers) push({ role: 'user', fromGantry: true, text })
    results = []
    answers = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.name === ASK_TOOL_NAME) answers.push(m.content)
      else results.push({ text: `- ${m.content}`, reads: (m.reads ?? []).map((read) => ({ ...read, at: read.at + 2 })) })
      continue
    }
    flush()
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks = m.toolCalls
        .map((c) => {
          if (c.name === DRAFT_TOOL_NAME) return '```' + DRAFT_FENCE + '\n' + JSON.stringify({ field: c.input?.field, value: c.input?.value, ...(c.input?.inputs ? { inputs: c.input.inputs } : {}) }) + '\n```'
          if (c.name === READ_TOOL_NAME) return '```' + READ_FENCE + '\n' + JSON.stringify({ id: c.input?.id, range: c.input?.range }) + '\n```'
          if (c.name === LOG_TOOL_NAME) return '```' + LOG_FENCE + '\n' + JSON.stringify(c.input ?? {}) + '\n```'
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

// ---------- compaction (#329, docs/adr/0073) ----------
// A long interview, above all one over a code repository, is eventually too long for the model. Compaction starts the conversation afresh,
// so the AI forgets some things on purpose: its earlier replies and the text of what it read go (it can read again). What it keeps is
// Gantry's opening as it was, a note carrying its own "where we are" summary and the drafts in the preview, the architect's own messages
// word for word (never summarised: ADR-0064), and where the conversation had got to. The brief, which is the system prompt, still carries the
// saved content and the decisions log, every answer so far as structured facts. The summary is used only as context: it is never logged.

/** The card offering to compact shows once the input the AI Provider reported for a call passes this share of the model's context window. */
export const COMPACT_OFFER_AT = 0.6
/** After "Not now", the card is not shown again until the reported input has grown by this share of the window. */
export const COMPACT_ASK_AGAIN_AFTER = 0.1
/** About how many tokens the AI's summary (at most about 2,000 words) adds, for the card's estimate of the size after. */
const SUMMARY_TOKENS = 3000

/** What the AI is asked for, in one call with no tools, just before the conversation is compacted. */
export const SUMMARY_REQUEST =
  'Gantry is about to start this conversation afresh, because it is getting too long for the model. Write a "where we are" summary for yourself to carry on from, of at most about 2,000 words. ' +
  'Cover: what you learned from each Source document and code repository you read (name the document, and the paths and commits of the files); what is settled; what is still open; and what you were about to do next. ' +
  "Gantry carries the drafts, the decisions log and the architect's own messages over word for word, so do not repeat them. Do not call a tool and write no draft, read, log or question blocks: reply with the summary only."

/** About how many tokens a request of `system` and `list` is. */
const conversationTokens = (system, list) =>
  estimateTokens(system) + list.reduce((sum, m) => sum + estimateTokens(m.role === 'tool' ? m.content : m.text) + (m.toolCalls?.length ? estimateTokens(JSON.stringify(m.toolCalls)) : 0), 0)

/** "612k" for the thread line `Conversation compacted (612k → 38k tokens)`. */
const tokensShort = (n) => formatTokens(n).replace(/ tokens?$/, '')

function compactedNote({ summary, drafts, said }) {
  const draftText = (value) => (Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : String(value ?? ''))
  return [
    'Gantry has compacted this conversation: it starts afresh here so that it fits the model. Your earlier replies and the text of what you read are no longer in it; read a Source document or a repository file again whenever you need it. ' +
      'The brief still carries the saved content and the decisions log, with every answer so far. Carry on from where you were: do not begin the interview again, and do not ask again what is settled.',
    summary
      ? `## Where we are (your own summary from just before)\n\n${summary}`
      : "## Where we are\n\nThere is no summary from you this time. Work out where things stand from the drafts, the decisions log and the architect's messages.",
    drafts.length ? `## The drafts in the preview (not saved yet)\n\n${drafts.map(({ key, value }) => `### ${key}\n\n${draftText(value)}`).join('\n\n')}` : '',
    said ? "## The architect's own messages\n\nWhat the architect typed in this conversation follows, oldest first, word for word." : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The conversation started afresh (#329): `messages[0]` (Gantry's opening, as it was), a note from Gantry with `summary` (none when the AI
 * couldn't write one) and `drafts` (`[{ key, value }]`), then every message the architect typed, word for word and in order, and last
 * whatever came after the AI's last reply (the answers to a round, a note from Gantry, the results of its last tool calls, each read
 * shortened to its note). Nothing else of the old conversation is kept. Pure.
 */
export function compactConversation(messages, { summary = '', drafts = [] } = {}) {
  const [opening, ...rest] = messages
  if (!opening) return []
  const own = (m) => m.role === 'user' && !m.fromGantry
  const lastReply = rest.findLastIndex((m) => m.role === 'assistant')
  const replied = rest.slice(0, lastReply + 1)
  const tail = rest.slice(lastReply + 1)
  const out = [{ ...opening }, { role: 'user', fromGantry: true, text: compactedNote({ summary, drafts, said: rest.some(own) }) }]
  for (const m of replied) if (own(m)) out.push({ role: 'user', text: m.text })
  let gantry = tail.length ? ['Where the conversation had got to when it was compacted. Carry on from here.'] : []
  const flush = () => {
    if (gantry.length) out.push({ role: 'user', fromGantry: true, text: gantry.join('\n\n') })
    gantry = []
  }
  for (const m of tail) {
    if (own(m)) {
      flush()
      out.push({ role: 'user', text: m.text })
      continue
    }
    const short = m.reads?.length ? shortenMessage(m) : m
    gantry.push(m.role === 'tool' ? `- ${short.content}` : short.text)
  }
  flush()
  return out
}

/**
 * Creates a session.
 *
 * @param {object} config
 * @param {string} config.providerId        the AI Provider to use first (any stored one; read afresh on every call)
 * @param {() => object} config.getContext  `{ definition, stageId, artefactId?, size?, saved, sources, skills, earlierDecisions? }`, as for `buildInterviewBrief`
 * @param {object} [config.handlers]        `{ askForKey, askToRetry }` for `runWithRecovery`
 * @param {Function} [config.fetchImpl]
 * @param {string} [config.origin]
 * @param {(snapshot: object) => void} [config.onChange]
 */
export function createInterviewSession(config = {}) {
  let { providerId, getContext, handlers = {}, fetchImpl, origin, onChange } = config
  const clock = config.clock ?? (() => Date.now()) // #341: when a request went, for the status line's seconds count
  // #288: what the decisions log is to hold, collected as the interview goes and handed to the stage Save (`decisionsDelta`).
  const log = createSessionLog({ now: config.now, newSessionId: config.newSessionId, who: () => getContext?.()?.actor ?? '' })
  const state = {
    phase: 'kickoff', // kickoff | testing | working | asking | waiting | error
    providerId,
    thread: [],
    drafts: {},
    drafting: null,
    draftingFields: [], // the Fields whose draft the AI is writing right now (#289): they can't be edited until the draft lands
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
    sessionWarning: null, // { others }: another session on this Stage is not Done; Start waits for Carry on alongside or Cancel (#290)
    clash: null, // { cards, merging, mergeNote }: a Save found Fields both sides changed; a round of cards settles them (#290)
    resumed: null, // the recap line when this run carries on from the decisions log (#290)
    review: null, // Review comments (#303): { mode: 'only'|'join', total, answered, reopen, deferred, elsewhere } while this session has such cards
    update: null, // Bring up to date (#298): { mode: 'only'|'first', total, answered, reopen, deferred, elsewhere } while this session has such a round
    revise: null, // Revising a Stage the Owner sent back (#299): { total, answered, pullRequestId } while this session has its round of comment cards
    reopenRequest: null, // the architect chose the AI's offer to re-open a signed-off Stage (#299): { stageId, stageTitle }; the page carries it out
    opening: '', // #331: what the architect typed in the kickoff's box, word for word: their opening message, which the status block records
    compactOffer: null, // #329: { before, after, window }: the card offering to compact, shown at the end of a turn past about 60% of the window
    compactPending: false, // #329: Compact now was asked for while a round was open or the AI was busy: it is done before the next request
    compacting: false, // #329: the AI is writing its summary and the conversation is being started afresh
    // #345: the id of the line the latest turn left because it ended with nothing to show (the line Carry on answers), or null. Each turn
    // clears it as it starts, so an earlier turn's line stays in the thread as a record but is never offered again.
    carryOnAt: null,
    // #338: { source, title, receivedBytes } while a repository tool call waits for the Gantry server to download its copy of that
    // repository ("Preparing <title>… N MB" in the thread); null otherwise.
    preparingRepository: null,
    // #341: what the status line is made from, besides the above. `waiting`: { since, without } from the moment a request goes to the AI
    // until the first of its answer arrives (`without` names the sampling settings a refused call is going again without). `writing`: the
    // answer is arriving. `tool`: the read the AI is making ({ kind: reading | searching | finding | listing, title, path, range, query,
    // pattern }), from when it starts asking for it until the next request goes.
    waiting: null,
    writing: false,
    tool: null,
    startedOver: false, // #341: Start this stage over was chosen: the next start is a fresh interview, never a resume of the decisions log
  }
  let queuedReview = [] // review cards waiting to join the next round of a session that is going (#303)
  let updateOpening = '' // the opening a normal session gives the AI once its Bring up to date round is answered (#298)
  let openingToSend = '' // #331: the architect's opening message until the AI's first turn carries it
  const updateCauses = new Map() // module.field -> why it was Out of date, for the note when an agreed Module goes back to draft (#298)
  let clashWaiter = null // { resolve, conflicts, entryIds }: the Save waiting on the clash cards
  let messages = []
  let lastInput = 0 // #329: the input tokens the AI Provider reported for the last call, which the card measures against the context window
  // #348: how full the conversation is now, for the Tokens block's Context: the last call's input, or, once Compact now has started the
  // conversation afresh, the size of the compacted one (the figure the thread line gives) until the next call reports. 0 before any call.
  let contextTokens = 0
  let askAgainAt = 0 // #329: after "Not now", the card waits until the reported input reaches this
  let lastSystem = '' // #329: the system text of the last request, for the card's estimate of the size after compacting
  let nextId = 1
  let live = null // the thread item the AI is streaming into
  const bounced = new Set() // Fields already sent back once
  const held = new Map() // a bounced draft that has not been answered yet: shown with its warnings if the AI never answers
  const handled = new Map() // tool call id -> the result, so a draft shown as it arrived is not checked twice
  const pendingChanges = new Map() // module.field -> { saved, proposed, ... }: the AI's version of a Field that holds saved content
  const keptFields = new Set() // the architect chose to keep what is saved
  const authorised = new Set() // the architect chose the AI's version or a merge: this Field may be drafted, until it is saved
  const handOwned = new Map() // module.field -> { text, after }: a drafted Field the architect edited by hand (#289); `after` counts the chat messages they had typed by then
  const editing = new Set() // Fields whose hand edit is open on the page: a draft the AI sends for one meets a card, never overwrites the edit
  const draftingByCall = new Map() // tool call id -> the Field a draft_field call being written is for (#289)
  let textDraftFields = [] // the Fields named in the draft blocks a text-only model has written so far this turn
  const otherTexts = [] // what the architect typed as "Other" on cards: their own words, so plain fact
  let pendingAsk = null // { callIds }: the native ask_architect call the open round answers
  let cardFailures = 0
  let cutOffs = 0 // #344: the replies in a row the output limit cut off, this turn
  let cutOffSaid = false // #344: the thread has named Max tokens this turn
  let controller = null
  let readsSinceDraft = [] // the reads made since the last drafts landed (#292)
  const repositoryBlocks = new Set() // #319: the repositories (and why) the architect has been told this session they can't be read
  const repositoryHiccups = new Set() // #336: the repositories (and why) a read just failed for a temporary reason, until one is read again
  let plan = new Map() // how each Source document reaches the AI Provider in use (#292)
  let announced = '' // what the thread last said about unreadable documents, so a repeat is not said twice
  const attachmentCache = new Map()

  let emitted = 0 // #341: how many changes have been told, so an event that told none can still move the status line on
  const emit = () => {
    emitted++
    onChange?.(snapshot())
  }
  const answeredIds = () => new Set(state.answered.map((a) => a.id))
  const openFields = () => [...new Set([...(state.round?.cards ?? []), ...state.held].map((c) => c.field).filter(Boolean))]
  const snapshot = () => ({
    ...state,
    thread: state.thread.map((t) => ({ ...t })),
    drafts: { ...state.drafts },
    draftingFields: [...state.draftingFields],
    draftingTitles: state.draftingFields.map((key) => fieldTitle(key)), // #341: for the status line
    waiting: state.waiting ? { ...state.waiting } : null,
    tool: state.tool ? { ...state.tool } : null,
    editingFields: [...editing],
    savedKeys: [...state.savedKeys],
    fieldInputs: { ...state.fieldInputs },
    held: state.held.length,
    answered: state.answered.map((a) => ({ ...a })),
    round: state.round ? { ...state.round, cards: state.round.cards.map((c) => ({ ...c, selected: [...c.selected] })) } : null,
    clash: state.clash ? { ...state.clash, cards: state.clash.cards.map((c) => ({ ...c, selected: [...c.selected] })) } : null,
    sessionWarning: state.sessionWarning ? { others: state.sessionWarning.others.map((o) => ({ ...o })) } : null,
    review: state.review ? { ...state.review, reopen: [...state.review.reopen], deferred: state.review.deferred.map((d) => ({ ...d })), elsewhere: state.review.elsewhere.map((d) => ({ ...d })) } : null,
    queuedReview: queuedReview.length,
    revise: state.revise ? { ...state.revise } : null,
    reopenRequest: state.reopenRequest ? { ...state.reopenRequest } : null,
    update: state.update ? { ...state.update, reopen: [...state.update.reopen], deferred: state.update.deferred.map((d) => ({ ...d })), elsewhere: state.update.elsewhere.map((d) => ({ ...d })) } : null,
    openFields: openFields(),
    decisions: { ...logSummary(log.entries()), pending: log.pending().length, session: log.sessionId },
    // #294: this session's tokens on this Stage, as the status block of the log will record them (all the AI Providers it used). Since
    // #348 that is since the session began or was last started over; `endedSessions` is the sessions a start over ended, with theirs.
    tokens: tokensOfModels(log.usage()),
    endedSessions: log.endedSessions().map((e) => ({ session: e.session, tokens: tokensOfModels(e.models) })),
    // #348: how full the AI's conversation is, against the model's context window (null where the AI Provider doesn't know it).
    context: contextTokens ? { tokens: contextTokens, window: getAiProvider(state.providerId)?.contextWindow || null } : null,
    compactOffer: state.compactOffer ? { ...state.compactOffer } : null,
    canCompact: canCompact(),
  })
  // #329: there is something to compact once the AI has replied at least once.
  const canCompact = () => messages.some((m) => m.role === 'assistant')
  const draftList = () => Object.entries(state.drafts).map(([key, d]) => ({ key, value: d.value }))
  const say = (who, text, extra = {}) => {
    const item = { id: nextId++, who, text, ...extra }
    state.thread.push(item)
    return item
  }
  // #331: the AI's first turn carries the architect's opening message, as their own words, right after Gantry's opening. It goes once, and
  // only to the request that opens the conversation: a round that comes before the AI (Bring up to date, review comments) waits for it.
  const withOpening = (list) => {
    if (!openingToSend) return list
    const text = openingToSend
    openingToSend = ''
    return [...list, { role: 'user', text }]
  }
  const architectMessages = () => messages.filter((m) => m.role === 'user' && m !== messages[0] && !m.fromGantry).map((m) => m.text)
  const architectText = () => [...messages.filter((m) => m.role === 'user' && m !== messages[0] && !m.fromGantry).map((m) => m.text), ...otherTexts].join('\n')
  const fieldTitle = (key) => {
    const context = getContext()
    const entry = fieldsInScope(context.definition, context.stageId).get(key)
    if (entry) return `${entry.module.title ?? entry.module.id} · ${entry.field.title ?? entry.field.id}`
    // A Field of a Module this Stage can't edit (a Bring up to date card can be about one) is named from the Definition.
    const parsed = splitRef(key)
    const modules = context.definition?.modules instanceof Map ? [...context.definition.modules.values()] : context.definition?.modules ?? []
    const mod = parsed ? modules.find((m) => m.id === parsed.moduleId) : null
    const field = mod?.fields?.find((f) => f.id === parsed.fieldId)
    return mod && field ? `${mod.title ?? mod.id} · ${field.title ?? field.id}` : key
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
    // #300 (ADR-0069): a Field an approved earlier Stage prints is approved content, held back like saved content even when it is empty.
    const approvedBy = reapprovalOf(context.approvedPrinted, key)
    const knownSourceIds = (context.sources ?? []).filter((s) => s && !s.removedAt).map((s) => s.id)
    const check = checkDraft(entry.field, rawValue, { size: context.size, architectText: architectText(), knownSourceIds, markAssumptions: state.finish !== null })
    // #291: a draft of the Glossary, Key decisions or Open questions is also checked against what the interview settled.
    check.problems.push(...standardProblems(key, check.value, context))
    const uncovered = extra.uncovered ?? []
    // The inputs are what the AI read before this draft plus what it cites. A draft sent back keeps the ones it had, because the reads are cleared once a round of drafts has landed.
    const named = namedInputs(extra.inputs, context)
    const inputs = mergeInputs(held.get(key)?.inputs, [...inputsForDraft({ reads: readsSinceDraft, value: check.value, sources: context.sources }), ...named.found])
    const inputNote = named.missing.length ? ` Not recorded as inputs, because they do not exist: ${named.missing.join(', ')}.` : ''

    // Saved content changes only through a keep / use / merge card (ADR-0065, rule 3). Only a Field the architect has let the AI
    // change, and an unsaved draft of this session, may be written freely. A Field the architect edited by hand (#289) is theirs in the
    // same way: what they typed stands in for the saved content, and the card says so.
    const mine = handOwned.has(key) || editing.has(key)
    if (mine || ((holdsSaved || approvedBy.length > 0) && !authorised.has(key))) {
      const current = mine ? (handOwned.get(key)?.text ?? asText(state.drafts[key]?.value)) : holdsSaved ? saved : ''
      const stages = reapprovalNames(approvedBy)
      const what = mine ? "the architect's own wording (they edited it by hand)" : approvedBy.length ? `approved content (${stages} prints it)` : 'saved content'
      if (keptFields.has(key)) return { ok: false, content: `${key} already holds ${what} and the architect chose to keep it as it is. Do not propose a change to it again${mine ? ' unless they ask you to in chat' : ''}.` }
      if (asText(check.value) === asText(current)) return { ok: false, content: `${key} already holds ${what}, and your version is the same as it, so there is nothing to change.` }
      const existing = pendingChanges.get(key)
      pendingChanges.set(key, { saved: current, proposed: check.value, words: check.words, inputs, warnings: check.problems.map((p) => p.message), uncovered, moduleId: parsed.moduleId, fieldId: parsed.fieldId, shown: existing?.shown ?? false, handEdit: mine, reapproves: approvedBy })
      const approvalNote = approvedBy.length ? ` Changing it changes approved content, so the card tells the architect that ${stages} needs re-approval with this Stage.` : ''
      return {
        ok: false,
        content: mine
          ? `${key} is ${what}, so it is not changed. If the architect asked you in chat to change it, call ${LOG_TOOL_NAME} first (kind "fact", a quote copied exactly from their request, fields ["${key}"]) and then draft it again. Otherwise Gantry will show them a keep / use your version / merge card for it: do not draft ${key} again until they have answered.${approvalNote}${inputNote}`
          : approvedBy.length
            ? `${key} is printed by ${stages}, which is already approved, so it is not changed.${approvalNote} Gantry will show the architect a keep / use your version / merge card for it. Do not draft ${key} again until they have answered.${inputNote}`
            : `${key} already holds saved content, so it is not changed. Gantry will show the architect a keep / use your version / merge card for it. Do not draft ${key} again until they have answered.${inputNote}`,
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
    handOwned.delete(key)
    state.drafts[key] = { value: check.value, words: check.words, warnings: check.problems.map((p) => p.message), uncovered, inputs, moduleId: parsed.moduleId, fieldId: parsed.fieldId }
    state.fieldInputs[key] = inputs
    say('sys', `Drafted ${entry.module.title ?? entry.module.id} · ${entry.field.title ?? entry.field.id}${check.problems.length ? ' (with a warning)' : ''}`, { drafted: key })
    return {
      ok: true,
      content: check.problems.length
        ? `${key} is in the preview, with a warning for the architect: ${check.problems.map((p) => p.message).join(' ')}${inputNote}`
        : `${key} is in the preview (${check.words} words).${inputNote}`,
    }
  }

  /** The earlier Stages' logs and this Stage's, as the standard-module checks and the brief read them. */
  const logsFor = (context) => ({ earlier: (context.earlierDecisions ?? []).map((l) => ({ stageId: l.stageId, entries: l.entries ?? [] })), own: log.entries() })

  function standardProblems(key, value, context) {
    const roles = standardRoles(context.definition, context.stageId)
    if (!roles.glossary.inScope && !roles.keyDecisions.inScope && !roles.openQuestions.inScope) return []
    const logs = logsFor(context)
    return standardDraftProblems({
      roles,
      key,
      value,
      terms: termChoices({ ...logs, stageId: context.stageId }),
      openCount: openQuestionsToCarry(logs).length,
    })
  }

  const mergeInputs = (earlier = [], later = []) => {
    const out = [...earlier]
    for (const input of later) if (!out.some((i) => (i.source ?? i.field) === (input.source ?? input.field) && (i.range ?? null) === (input.range ?? null))) out.push(input)
    return out
  }

  /**
   * The inputs the AI named in its draft (#288): a Source document of this Instance, or a Field of an earlier Stage or a read-only
   * Module that holds content. Each that exists gets a fingerprint of what it holds now; each that doesn't is reported back.
   */
  function namedInputs(list, context) {
    const found = []
    const missing = []
    const savedModules = normalizeSavedContent(context.saved)
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item?.source === 'string' && item.source.trim()) {
        const id = item.source.trim()
        const doc = (context.sources ?? []).find((d) => d && d.id === id && !d.removedAt)
        if (!doc) missing.push(`source ${id}`)
        else found.push({ source: id, title: doc.title || doc.filename || id, range: item.range ? String(item.range).trim() : null, fingerprint: typeof doc.text === 'string' && doc.text.trim() ? fingerprintText(doc.text) : null })
      } else if (typeof item?.field === 'string' && item.field.trim()) {
        const ref = splitRef(item.field)
        const value = ref ? savedModules[ref.moduleId]?.fields?.[ref.fieldId] : undefined
        if (!ref || value === undefined || isBlankValue(value)) missing.push(`field ${item.field}`)
        else found.push({ field: `${ref.moduleId}.${ref.fieldId}`, title: fieldTitle(`${ref.moduleId}.${ref.fieldId}`), range: null, fingerprint: fingerprintText(asText(value)) })
      }
    }
    return { found, missing }
  }

  /** A hand-edited Field goes back to the AI (the architect asked in chat, or chose the AI's version on a card). */
  function handBack(key) {
    handOwned.delete(key)
    keptFields.delete(key)
    pendingChanges.delete(key)
    authorised.add(key)
  }

  // ---------- the decisions log (#288) ----------

  /** One `log_decision` call: a fact the architect typed (kept word for word) or an open question. */
  function runLog(input) {
    const context = getContext()
    const scope = fieldsInScope(context.definition, context.stageId)
    const fields = [...new Set((Array.isArray(input?.fields) ? input.fields : input?.field ? [input.field] : []).map((f) => String(f).trim()).filter((f) => scope.has(f)))]
    if (input?.kind === 'fact') {
      const words = findArchitectMessage(architectMessages(), input.quote)
      if (!words) return { ok: false, content: 'Not logged: that is not something the architect typed in chat (or it is only thanks or "go on"). Only their own words are logged, never yours. Quote part of their message exactly, or do not log it.' }
      if (fields.length === 0) return { ok: false, content: 'Not logged: name the Field it feeds as module.field, one listed under "Fields in scope". A message that feeds nothing is not kept.' }
      const entry = log.addFact(words, fields)
      // #289: a request in free chat, typed after the architect's hand edit, hands that Field back to the AI.
      const handedBack = fields.filter((f) => handOwned.has(f) && architectMessages().lastIndexOf(words) >= handOwned.get(f).after)
      for (const f of handedBack) handBack(f)
      emit()
      const back = handedBack.length ? ` ${handedBack.join(', ')} ${handedBack.length === 1 ? 'was' : 'were'} edited by hand and ${handedBack.length === 1 ? 'is' : 'are'} yours to change now, because the architect asked.` : ''
      return { ok: true, content: (entry ? `Logged the architect's message against ${fields.join(', ')}.` : 'That message is already logged against those Fields.') + back }
    }
    if (input?.kind === 'open-question') {
      if (!String(input.question ?? '').trim()) return { ok: false, content: 'Not logged: an open question needs the question.' }
      const entry = log.addOpenQuestion({ question: input.question, why: input.why, fields })
      emit()
      return { ok: true, content: entry ? 'Logged the open question.' : 'That open question is already logged.' }
    }
    return { ok: false, content: 'Not logged: kind must be "fact" or "open-question".' }
  }

  // ---------- reading (#292) ----------

  /**
   * #319: one call of a repository tool, answered by the Gantry server: what comes back goes to the AI, and a file read is recorded, with the
   * commit it saw, as an input of whatever it drafts next. Resolves, never rejects.
   */
  async function runRepository(name, input) {
    const context = getContext()
    const live = (context.sources ?? []).filter((s) => s && !s.removedAt)
    // #341: the status line says what is searched or read while the call runs.
    state.tool = toolActivity(name, input)
    emit()
    // #338: while the server is still downloading its copy of the repository, the call waits, and the thread says how far it has got.
    const onPreparing = (entry) => ({ receivedBytes }) => {
      state.preparingRepository = { source: entry.id, title: entry.title || entry.id, receivedBytes }
      emit()
    }
    const reader = (entry) => {
      if (!context.readRepository) throw new Error('Code repositories cannot be read here.')
      return context.readRepository(entry, { onPreparing: onPreparing(entry), signal: controller?.signal })
    }
    let result
    try {
      result = await runRepositoryCall(name, input, { lookup: (wanted) => live.find((s) => s.id === wanted), reader })
    } finally {
      if (state.preparingRepository) {
        state.preparingRepository = null
        emit()
      }
    }
    if (result.ok) {
      const id = String(input?.id ?? '')
      for (const said of repositoryHiccups) if (said.startsWith(`${id}|`)) repositoryHiccups.delete(said)
    }
    if (result.ok && result.read) {
      readsSinceDraft.push(result.read)
      say('sys', `Read ${describeInput(result.read)}`, { read: result.read.source })
      emit()
    } else if (result.failed) {
      // #336: said once until the repository is read again, so a run of failed reads is one line and a later one is heard.
      const said = `${result.failed.source}|${result.failed.code}`
      if (!repositoryHiccups.has(said)) {
        repositoryHiccups.add(said)
        say('sys', repositoryFailedLine(result.failed), { repositoryFailed: result.failed.source })
        emit()
      }
    } else if (result.blocked) {
      // Said once per repository and reason: the AI may try several reads in a row, and the architect needs to hear it once.
      const said = `${result.blocked.source}|${result.blocked.code}`
      if (!repositoryBlocks.has(said)) {
        repositoryBlocks.add(said)
        say('sys', repositoryBlockedLine(result.blocked), { repositoryBlocked: result.blocked.source })
        emit()
      }
    }
    return result
  }

  /**
   * #338 (docs/adr/0074): starting an interview (or Bring up to date, which starts the same way) asks the Gantry server to start downloading
   * its copy of each code repository among the Source documents, so the AI's first search rarely waits. Nothing waits on it, and a failure
   * is ignored: the first read meets it, or the download, as it would have anyway.
   */
  function prepareRepositories() {
    const context = getContext?.()
    if (!context?.prepareRepository) return
    for (const source of context.sources ?? []) {
      if (!source || source.removedAt || !source.repository) continue
      try {
        Promise.resolve(context.prepareRepository(source)).catch(() => {})
      } catch {
        // as above: nothing waits on it
      }
    }
  }

  /** One `read_source_document` call: the text back to the AI, and the read recorded as an input of whatever it drafts next. */
  function runRead(input) {
    const context = getContext()
    const live = (context.sources ?? []).filter((s) => s && !s.removedAt)
    const id = String(input?.id ?? '')
    // #319: a model without tools reads a code repository in the same read blocks: a `path` to read, a folder to `list`, or text to `search`.
    // #338: or files to `find` by name; with a find or a search, `path` is the folder to look under. The options are the tools' own.
    if (live.some((s) => s.id === id && s.repository)) {
      const { page, commit } = input ?? {}
      if (typeof input?.find === 'string') return runRepository(FIND_REPOSITORY_TOOL_NAME, { id, pattern: input.find, path: input.path, page, commit })
      if (typeof input?.search === 'string') {
        const { regex, fileTypes, context, filesOnly } = input
        return runRepository(SEARCH_REPOSITORY_TOOL_NAME, { id, query: input.search, path: input.path, regex, fileTypes, context, filesOnly, page, commit })
      }
      if (typeof input?.path === 'string') return runRepository(READ_REPOSITORY_TOOL_NAME, { id, path: input.path, range: input.range, lines: input.lines })
      return runRepository(LIST_REPOSITORY_TOOL_NAME, { id, path: input?.list ?? '', page, commit })
    }
    state.tool = toolActivity(READ_TOOL_NAME, input) // #341: shown until the next request goes
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
    const repositoryTool = REPOSITORY_TOOL_NAMES.includes(call.name)
    if (call.name !== DRAFT_TOOL_NAME && call.name !== READ_TOOL_NAME && call.name !== LOG_TOOL_NAME && !repositoryTool) result = { ok: false, content: `There is no tool called ${call.name}.` }
    else if (call.cutOff) result = { ok: false, content: CUT_OFF_CALL_RESULT } // #344: the output limit cut it short, so it is not run
    else if (call.invalid || call.input === null || call.input === undefined) {
      result = { ok: false, content: `The arguments were not valid JSON: ${call.invalid ?? (call.name === READ_TOOL_NAME ? 'send {"id": "document-id", "range": "pages 3-5"}' : repositoryTool ? 'send {"id": "repository-id", "path": "src/file.ts"}' : 'send {"field": "module.field", "value": ...}')}.` }
    } else if (repositoryTool) result = runRepository(call.name, call.input) // #319: a promise, settled before the result goes back to the AI
    else if (call.name === READ_TOOL_NAME) result = runRead(call.input)
    else if (call.name === LOG_TOOL_NAME) result = runLog(call.input)
    else result = acceptDraft(call.input.field, call.input.value, { uncovered: Array.isArray(call.input.uncovered) ? call.input.uncovered.map(String) : [], inputs: call.input.inputs })
    handled.set(call.id, result)
    return result
  }

  // ---------- rounds of cards ----------

  /**
   * #299: the AI offered to re-open signed-off Stages. For each, Gantry looks at what the page says it would allow right now
   * (`context.reopen`, `[{ id, title, allowed, blocker }]`): a Stage it would allow becomes a card (re-open, or not now); any other becomes an
   * open question in the decisions log naming the blocker, and no card. Returns the cards.
   */
  function handleReopenOffers(offers) {
    const cards = []
    const known = getContext().reopen ?? []
    for (const offer of offers) {
      const info = known.find((k) => k.id === offer.stage)
      const title = info?.title ?? offer.stage
      if (info?.allowed) {
        cards.push(reopenCard({ id: offer.id, stageId: info.id, stageTitle: title, question: offer.question, why: offer.why }))
        continue
      }
      const blocker = info ? info.blocker : `${title} is not a signed-off Stage that can be re-opened.`
      const asked = reopenBlockedQuestion({ stageTitle: title, blocker, why: offer.question })
      log.addOpenQuestion(asked)
      say('sys', `${title} cannot be re-opened right now: ${blocker} Logged as an open question.`, { reopenBlocked: offer.stage })
    }
    return cards
  }

  /** The architect's choice on a re-open card: re-open asks the page to do it (it replaces this page), "Not now" logs an open question so it is not forgotten. */
  function applyReopenDecisions(cards) {
    for (const card of cards) {
      if (card.type !== 'reopen') continue
      if (card.selected[0] === card.options[0].label) {
        state.reopenRequest = { stageId: card.reopen.stageId, stageTitle: card.reopen.stageTitle }
        say('sys', `Re-opening ${card.reopen.stageTitle}`)
      } else {
        log.addOpenQuestion({ question: `${card.reopen.stageTitle} may need to be re-opened: ${String(card.question).trim()}`, why: 'The architect chose not to re-open it now.' })
        say('sys', `${card.reopen.stageTitle} stays signed off; logged as an open question`)
      }
    }
  }

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
    const roles = standardRoles(context.definition, context.stageId)
    // #299: an offer to re-open a signed-off Stage becomes a card only if Gantry would allow it right now; otherwise it becomes an open question.
    const reopenCards = handleReopenOffers(batch.filter((c) => c.kind === 'reopen'))
    const shaped = batch.filter((c) => c.kind !== 'reopen').map((raw) => {
      // #291: a Key decision is offered only where the module is mounted and the card shows all three parts of the test; any other
      // "decision" is a routine question. A term or decision card feeds the module it settles, so that Field waits for the answer.
      let card = raw
      if (card.kind === 'decision' && (!roles.keyDecisions.inScope || !card.decision)) {
        const { kind, decision, ...rest } = card
        card = rest
      }
      if (!card.field && card.kind === 'decision') card = { ...card, field: roles.keyDecisions.key }
      if (!card.field && card.kind === 'term' && roles.glossary.inScope) card = { ...card, field: roles.glossary.key }
      const after = (card.after ?? []).map((a) => idMap.get(a) ?? a)
      const withSource = card.source ? { ...card, source: { ...card.source, title: sources.get(card.source.document) ?? card.source.document } } : card
      const entry = card.field ? scope.get(card.field) : null
      return shapeCard({ ...withSource, after, type: 'question' }, entry)
    })
    shaped.push(...reopenCards)
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
      changes.push(changeCard({ key, fieldTitle: fieldTitle(key), saved: change.saved, proposed: change.proposed, handEdit: change.handEdit === true, reapproves: change.reapproves ?? [] }))
    }
    // #303: review questions the architect asked for while the AI was busy join this round.
    const joining = queuedReview.filter((q) => !answeredIds().has(q.id))
    queuedReview = []
    if (joining.length && state.review) state.review = { ...state.review, total: state.review.total + joining.length }
    const all = [...cards, ...released.filter((r) => !cards.some((c) => c.id === r.id)), ...joining, ...changes]
    if (all.length === 0) {
      state.round = null
      return
    }
    const sorted = sortRound(all, requiredFieldKeys(context.definition, context.stageId, context.artefactId))
    state.round = { id: ++state.roundNo, cards: sorted, page: 0, final: state.finish === 'accepting' }
    if (joining.length) say('sys', `${joining.length} review comment${joining.length === 1 ? ' is' : 's are'} in this round alongside the interview's questions.`, { reviewJoined: true })
    if (state.finish === 'accepting') state.finish = 'final'
  }

  /** The thread keeps a record of what was answered. */
  function recordAnswers(cards) {
    for (const card of cards) {
      const own = otherWords(card)
      if (own) otherTexts.push(own)
      const term = termChoice(card)
      if (term) {
        // #291: a term card's answer is a term choice. It feeds the Glossary Field where one is mounted on this Stage.
        const glossary = standardRoles(getContext().definition, getContext().stageId).glossary
        log.addTerm(card, { round: state.roundNo, words: own, choice: term, followed: followsRecommendation(card), fields: glossary.inScope && glossary.key ? [glossary.key] : card.field ? [card.field] : [] })
      } else if (card.type !== 'change') log.addAnswer(card, { round: state.roundNo, words: own, answers: [...card.selected], followed: followsRecommendation(card) })
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
      const mine = card.change?.handEdit === true
      // #300: a choice on approved content is logged with the Stages it would send back for approval.
      const reapproves = card.change?.reapproves ?? change?.reapproves ?? []
      if (choice === CHANGE_OPTIONS.keep) {
        keptFields.add(key)
        log.addSavedContent(key, 'keep', { handEdit: mine, reapproves })
        say('sys', mine ? `Kept ${fieldTitle(key)} as you edited it` : `Kept ${fieldTitle(key)} as saved`)
      } else if (choice === CHANGE_OPTIONS.use && change) {
        authorised.add(key)
        handOwned.delete(key)
        log.addSavedContent(key, 'replace', { handEdit: mine, reapproves })
        state.drafts[key] = { value: change.proposed, words: change.words, warnings: change.warnings, uncovered: change.uncovered, inputs: change.inputs ?? [], moduleId: change.moduleId, fieldId: change.fieldId }
        state.fieldInputs[key] = change.inputs ?? []
        say('sys', `Using the AI's version of ${fieldTitle(key)}`, { drafted: key })
      } else if (choice === CHANGE_OPTIONS.merge) {
        authorised.add(key)
        handOwned.delete(key)
        log.addSavedContent(key, 'merge', { handEdit: mine, reapproves })
        say('sys', `Merging ${fieldTitle(key)}`)
      }
    }
  }

  // ---------- Bring up to date (#298) ----------

  /** What the Stages' decisions logs recorded a Field as drawn from (the latest record), so a re-cite keeps what else the Field drew on. */
  function recordedInputs(key) {
    let best = null
    for (const log of Object.values(getContext().update?.logs ?? {})) {
      const record = log?.fields?.[key]
      if (record && Array.isArray(record.inputs) && (!best || String(record.drafted ?? '') > String(best.drafted ?? ''))) best = record
    }
    return best ? best.inputs.map((i) => ({ ...i })) : []
  }

  /** Opens the round of cards about the Fields flagged Out of date that this Stage can act on. Nothing is sent to the AI yet. */
  function openUpdateRound() {
    const context = getContext()
    const upd = context.update
    const cards = updateCards({
      items: upd.items,
      sources: context.sources ?? [],
      logs: upd.logs ?? {},
      fieldTitle,
      stageTitle: upd.stageTitle ?? ((id) => id),
      pageStageTitle: upd.pageStageTitle ?? '',
    })
    state.update = { mode: upd.mode === 'only' ? 'only' : 'first', total: cards.length, answered: false, reopen: [], deferred: (upd.deferred ?? []).map((d) => ({ ...d })), elsewhere: (upd.elsewhere ?? []).map((d) => ({ ...d })) }
    state.round = { id: ++state.roundNo, cards, page: 0, final: false, update: true }
    state.phase = 'asking'
    say('sys', `${cards.length} Field${cards.length === 1 ? ' is' : 's are'} Out of date because a Source document changed. Answer ${cards.length === 1 ? 'its card' : 'each card'} to bring ${cards.length === 1 ? 'it' : 'them'} up to date; only an answer clears a flag.`, { updateRound: true })
  }

  /**
   * Carries out what the architect answered on the round's cards: a `source-update` entry for every flag answered (this is what clears it,
   * once saved), Fields kept so the AI proposes nothing for them, a re-cite done here as a draft, an open question recorded.
   */
  function applyUpdateResults(results, context) {
    const content = normalizeSavedContent(context.saved)
    const valueOf = (key) => {
      const ref = splitRef(key)
      return ref ? content[ref.moduleId]?.fields?.[ref.fieldId] : undefined
    }
    for (const r of results) {
      const key = r.key
      const title = fieldTitle(key)
      const update = r.card.update ?? {}
      const stage = update.landing?.kind === 'carry-forward' ? update.landing.stageId : undefined
      const trigger = (f) =>
        f.cause === 'source'
          ? { source: f.source, sourceTitle: f.sourceTitle, change: f.change, replacedBy: f.replacedBy ?? undefined, paths: f.paths, commit: f.head }
          : { inputField: f.inputField, change: f.change, inputFingerprint: fingerprintText(asText(valueOf(f.inputField))) }
      const write = (outcome, extra = {}) => {
        for (const f of update.flags ?? []) log.addSourceUpdate({ field: key, outcome, trigger: trigger(f), stage, ...extra })
      }
      updateCauses.set(key, `because ${(update.reasons ?? []).join('; ')}`)
      if (r.outcome === 'leave') {
        say('sys', `Left ${title} flagged`)
      } else if (r.outcome === 'reopen') {
        if (r.stageId && !state.update.reopen.includes(r.stageId)) state.update.reopen = [...state.update.reopen, r.stageId]
        say('sys', `${title} stays flagged until ${r.stageId} is re-opened`)
      } else if (r.outcome === 'keep') {
        keptFields.add(key)
        write('keep')
        say('sys', `Kept ${title} as it is`)
      } else if (r.outcome === 'redraft' || r.outcome === 'redraft-without') {
        write(r.outcome)
        say('sys', r.outcome === 'redraft' ? `${title} will be redrafted` : `${title} will be redrafted without the removed document`)
      } else if (r.outcome === 'open-question') {
        const why = update.landing?.blocker || `${title} cannot be edited on this Stage.`
        log.addOpenQuestion({ question: `${title} is Out of date (${(update.reasons ?? []).join('; ')}) and cannot be brought up to date here. What should happen?`, why, fields: [key] })
        write('open-question')
        say('sys', `Logged an open question about ${title}`)
      } else if (r.outcome === 're-cite') {
        const saved = valueOf(key)
        const gone = removedSourcesOf(r.card)
        let value = saved
        for (const id of gone) value = reciteValue(value, id, r.reciteTo)
        write('re-cite', { reciteTo: r.reciteTo.title })
        const ref = splitRef(key)
        if (ref && saved !== undefined && asText(value) !== asText(saved)) {
          const kept = recordedInputs(key).filter((i) => !(i.source && gone.includes(i.source)))
          const inputs = mergeInputs(kept, inputsForDraft({ reads: [], value, sources: context.sources }))
          state.drafts[key] = { value, words: countWords(value), warnings: [], uncovered: [], inputs, moduleId: ref.moduleId, fieldId: ref.fieldId }
          state.fieldInputs[key] = inputs
          say('sys', `Re-cited ${title} to ${r.reciteTo.title}`, { drafted: key })
        } else {
          say('sys', `${title} does not cite ${gone.length === 1 ? 'the removed document' : 'the removed documents'} in its text, so only the log changes`)
        }
      }
    }
  }

  /** The architect's answers to the Bring up to date round. */
  async function answerUpdate({ finish }) {
    const round = state.round
    const cards = finish ? round.cards.map(acceptRecommendation) : round.cards
    const open = cards.filter((c) => !isAnswered(c))
    if (open.length) return { ok: false, message: `${open.length} card${open.length === 1 ? ' is' : 's are'} not answered yet.`, firstOpen: open[0].id }
    const context = getContext()
    const results = cards.map(resolveUpdateCard)
    applyUpdateResults(results, context)
    for (const card of cards) state.answered.push({ id: card.id, header: card.header, question: card.question, field: card.field, labels: [...card.selected], other: '', followed: followsRecommendation(card) })
    say('you', cards.map((c) => `${fieldTitle(c.field)}: ${c.selected.join(', ')}`).join('\n'), { answered: cards.length })
    state.round = null
    state.update = { ...state.update, answered: true }
    const mode = state.update.mode
    if (mode === 'only' && !results.some(needsAi)) {
      state.phase = 'waiting'
      emit()
      return { ok: true }
    }
    const opening = mode === 'only' ? UPDATE_OPENING : updateOpening || openingFor(context)
    messages = withOpening([{ role: 'user', text: `${opening}\n\nThe architect's answers to the round that brings the Out of date Fields up to date:\n${updateAnswersText(results, { fieldTitle })}` }])
    await runLoop()
    return { ok: true }
  }

  // ---------- Revising a Stage the Owner sent back (#299) ----------

  /** Lists every comment on the Pull Request in the conversation and opens the round of cards about them. Nothing is sent to the AI yet. */
  function openReviseRound(revise) {
    const cards = commentCards({ comments: revise.comments, pullRequestId: revise.pullRequestId, pullRequestUrl: revise.pullRequestUrl, stageTitle: revise.stageTitle })
    state.revise = { total: cards.length, answered: false, pullRequestId: revise.pullRequestId ?? null }
    say('sys', commentsMessage(revise.comments, { pullRequestId: revise.pullRequestId, stageTitle: revise.stageTitle }), { reviseComments: true })
    state.round = { id: ++state.roundNo, cards, page: 0, final: false, revise: true }
    state.phase = 'asking'
  }

  /**
   * The architect's answers to the comment cards: a `pr-comment-answered` entry for each (with the answer entry and any open question it
   * logged), then the AI is told which comments to act on. Nothing is written to the Pull Request.
   */
  async function answerRevise({ finish }) {
    const round = state.round
    const cards = finish ? round.cards.map(acceptRecommendation) : round.cards
    const open = cards.filter((c) => !isAnswered(c))
    if (open.length) return { ok: false, message: `${open.length} card${open.length === 1 ? ' is' : 's are'} not answered yet.`, firstOpen: open[0].id }
    const results = cards.map((card) => resolveCommentCard(card, otherWords(card)))
    for (const r of results) {
      const card = r.card
      const own = otherWords(card)
      if (own) otherTexts.push(own)
      // The answer entry is read back to the AI in the brief, so it carries the comment without its author's name (ADR-0066); the PR comment answered entry keeps the name.
      const neutral = { ...card, header: `Pull Request${card.comment.pullRequestId ? ` #${card.comment.pullRequestId}` : ''} comment`, question: `A reviewer commented: “${card.comment.excerpt}” What should the Stage do about it?` }
      const answerEntry = log.addAnswer(neutral, { round: state.roundNo, words: own, answers: [...card.selected], followed: followsRecommendation(card) })
      const entries = [answerEntry.id]
      if (r.outcome === 'open-question') {
        const c = card.comment
        const asked = log.addOpenQuestion({
          question: `${c.author || 'The Owner'} commented on Pull Request${c.pullRequestId ? ` #${c.pullRequestId}` : ''}: “${c.excerpt}” How should it be settled?`,
          why: 'Raised when the Stage was sent back; the architect chose to log it rather than change the content now.',
        })
        if (asked) entries.push(asked.id)
      }
      log.addPrCommentAnswered({ comment: card.comment, outcome: r.outcome, words: own, entries })
      state.answered.push({ id: card.id, header: card.header, question: card.question, field: null, labels: [...card.selected], other: own, followed: followsRecommendation(card) })
    }
    say('you', cards.map((c) => `${c.comment.author || 'Owner'}: ${[...c.selected, ...(otherWords(c) ? [`“${otherWords(c)}”`] : [])].join(', ')}`).join('\n'), { answered: cards.length })
    state.round = null
    state.revise = { ...state.revise, answered: true }
    if (!results.some(commentNeedsAi)) {
      state.phase = 'waiting'
      emit()
      return { ok: true }
    }
    messages = [{ role: 'user', text: `${REVISION_OPENING}\n\nThe Owner's comments, and what the architect decided for each:\n${commentAnswersText(results)}` }]
    await runLoop()
    return { ok: true }
  }

  /** Modules marked `agreed` that the drafts about to be saved change go back to `draft`; the log keeps a note saying why (#298). */
  function noteReturnedToDraft() {
    const context = getContext()
    const content = normalizeSavedContent(context.saved)
    log.discard(log.pending().filter((e) => e.kind === 'returned-to-draft').map((e) => e.id))
    const byModule = new Map()
    for (const [key, draft] of Object.entries(state.drafts)) {
      if (content[draft.moduleId]?.status !== 'agreed') continue
      byModule.set(draft.moduleId, [...(byModule.get(draft.moduleId) ?? []), key])
    }
    const modules = context.definition?.modules instanceof Map ? [...context.definition.modules.values()] : context.definition?.modules ?? []
    for (const [moduleId, keys] of byModule) {
      const moduleTitle = modules.find((m) => m.id === moduleId)?.title ?? moduleId
      const causes = [...new Set(keys.map((k) => updateCauses.get(k)).filter(Boolean))]
      log.addReturnedToDraft({ module: moduleId, fields: keys, note: returnedToDraftNote({ moduleTitle, fieldTitles: keys.map(fieldTitle), cause: causes.join('; ') }) })
    }
  }

  // ---------- Review comments (#303) ----------

  const EDITABLE_TYPES = new Set(['markdown', 'text', 'list'])

  /** The cards for the questions in the context's `review` (web/lib/reviewRound.js), not already asked or answered. */
  function reviewCardsFor(review) {
    const taken = new Set([...answeredIds(), ...queuedReview.map((c) => c.id), ...(state.round?.cards ?? []).map((c) => c.id), ...state.held.map((c) => c.id)])
    return reviewCards({
      items: review.items ?? [],
      labels: review.labels ?? new Map(),
      fieldTitle,
      stageTitle: review.stageTitle ?? ((id) => id),
      pageStageTitle: review.pageStageTitle ?? '',
      fieldChoices: review.fieldChoices ?? [],
    }).filter((c) => !taken.has(c.id))
  }

  const reviewStateFor = (review, total, mode) => ({
    mode,
    total,
    answered: false,
    reopen: [],
    deferred: (review.deferred ?? []).map((d) => ({ ...d })),
    elsewhere: (review.elsewhere ?? []).map((d) => ({ ...d })),
  })

  /** Opens the focused round of cards about the review comments this Stage can act on. Nothing is sent to the AI yet. */
  function openReviewRound() {
    const review = getContext().review
    const cards = reviewCardsFor(review)
    state.review = reviewStateFor(review, cards.length, 'only')
    state.round = { id: ++state.roundNo, cards, page: 0, final: false, review: true }
    state.phase = 'asking'
    say('sys', `${cards.length} review comment${cards.length === 1 ? '' : 's'} to work through. Answer ${cards.length === 1 ? 'its card' : 'each card'}; nothing changes until you answer, and nothing is saved until you save.`, { reviewRound: true })
  }

  const savedValue = (context, key) => {
    const ref = splitRef(key)
    return ref ? normalizeSavedContent(context.saved)[ref.moduleId]?.fields?.[ref.fieldId] : undefined
  }

  /**
   * Carries out what the architect answered on review cards: a `review-answered` entry for every thread answered (once saved, it keeps the thread
   * from being asked again), a Field kept so the AI proposes nothing for it, an accepted tracked edit made by Gantry where it can be made without
   * guessing, an open question for what can't be settled. Returns the ids of the cards whose accepted edit is already in the preview.
   */
  function applyReviewResults(results, context) {
    const applied = new Set()
    const scope = fieldsInScope(context.definition, context.stageId)
    for (const r of results) {
      const review = r.card.review ?? {}
      const key = r.outcome === 'assign' ? r.assignTo : r.key
      const title = key ? fieldTitle(key) : review.aboutTitle || 'the document'
      if (r.outcome === 'leave') {
        say('sys', `Left the comment on ${title} unanswered`)
        continue
      }
      if (r.outcome === 'reopen') {
        if (r.stageId && state.review && !state.review.reopen.includes(r.stageId)) state.review = { ...state.review, reopen: [...state.review.reopen, r.stageId] }
        say('sys', `The comment on ${title} stays unanswered until ${r.stageId} is re-opened`)
        continue
      }
      let openQuestion = ''
      if (r.outcome === 'keep') {
        if (key) keptFields.add(key)
        say('sys', `Kept ${title} as it is`)
      } else if (r.outcome === 'note') {
        say('sys', 'Noted the comment about the document')
      } else if (r.outcome === 'cant-settle') {
        openQuestion = reviewOpenQuestion(r, { fieldTitle, labels: context.review?.labels ?? new Map() })
        log.addOpenQuestion({ question: openQuestion, why: review.landing?.blocker || 'A reviewer’s comment that could not be settled yet.', fields: key ? [key] : [] })
        say('sys', `Logged an open question about ${title}`)
      } else if (r.outcome === 'accept' && key) {
        updateCauses.set(key, 'because a reviewer’s edit was accepted')
        const entry = scope.get(key)
        const saved = savedValue(context, key)
        const made = entry && EDITABLE_TYPES.has(entry.field.type) && saved !== undefined ? applyTrackedEdits(saved, editsToAccept(r.card, r.by)) : { ok: false, reason: 'Gantry could not make the edit itself.' }
        if (made.ok) {
          const ref = splitRef(key)
          const inputs = state.fieldInputs[key] ?? recordedInputs(key)
          state.drafts[key] = { value: made.value, words: countWords(made.value), warnings: [], uncovered: [], inputs, moduleId: ref.moduleId, fieldId: ref.fieldId }
          state.fieldInputs[key] = inputs
          applied.add(r.card.id)
          say('sys', `Accepted the edit to ${title}`, { drafted: key })
        } else {
          say('sys', `${made.reason} The AI will make the edit to ${title}, and you will see it before anything is saved.`)
        }
      } else if (r.outcome === 'revise' || r.outcome === 'assign') {
        if (key) updateCauses.set(key, 'because a reviewer’s comment was answered')
        if (r.words) otherTexts.push(r.words)
        say('sys', `${title} will be revised`)
      }
      if (r.words && r.outcome !== 'revise' && r.outcome !== 'assign') otherTexts.push(r.words)
      for (const entry of reviewEntriesFor(r, { stage: context.stageId, openedQuestion: openQuestion })) log.addReviewAnswered(entry)
    }
    return applied
  }

  /** The answered review cards of a round: resolved, carried out, and written for the AI. Returns `{ results, applied, text, ai }`. */
  function answerReviewCards(cards, context) {
    const results = cards.map(resolveReviewCard)
    const applied = applyReviewResults(results, context)
    const keyDecisions = standardRoles(context.definition, context.stageId).keyDecisions.inScope
    for (const card of cards) state.answered.push({ id: card.id, header: card.header, question: card.question, field: card.field, labels: [...card.selected], other: '', followed: followsRecommendation(card) })
    const lines = cards.map((c) => `${c.review?.fieldTitle || 'The document'}: ${c.selected.join(', ')}`)
    say('you', lines.join('\n'), { answered: cards.length })
    const text = reviewAnswersText(results, { fieldTitle, labels: context.review?.labels ?? new Map(), applied, keyDecisions })
    return { results, applied, text, ai: results.some((r) => reviewNeedsAi(r, { applied, keyDecisions })) }
  }

  /** Review cards go back in the queue (chat put them away, or a round was left): they join the next round. */
  function requeueReview(cards) {
    const taken = new Set([...answeredIds(), ...queuedReview.map((c) => c.id)])
    queuedReview = [...queuedReview, ...cards.filter((c) => c.type === 'review' && !taken.has(c.id))]
  }

  // ---------- one send ----------

  // #289: which Field a draft being written is for. A tool call's arguments arrive in pieces (`"field":"module.field"` comes first); a
  // text-only model's draft blocks are read from the text so far. Such a Field shows "drafting…" and can't be hand-edited.
  const FIELD_IN_PARTIAL = /"field"\s*:\s*"([^"]+)"/
  const DRAFT_BLOCK = new RegExp('```[ \\t]*' + DRAFT_FENCE + '[^\\n]*\\n([\\s\\S]*?)(?:```|$)', 'g')
  const setDraftingFields = () => {
    state.draftingFields = [...new Set([...draftingByCall.values(), ...textDraftFields])]
  }
  const stopDrafting = () => {
    state.drafting = false
    draftingByCall.clear()
    textDraftFields = []
    state.draftingFields = []
  }

  // #341: the reads the status line names, and what each says; a call's arguments arrive in pieces, so what is known so far is read from them.
  const READ_TOOLS = [READ_TOOL_NAME, ...REPOSITORY_TOOL_NAMES]
  const TOOL_KINDS = { [SEARCH_REPOSITORY_TOOL_NAME]: 'searching', [FIND_REPOSITORY_TOOL_NAME]: 'finding', [LIST_REPOSITORY_TOOL_NAME]: 'listing' }
  function toolActivity(name, input = {}) {
    const id = typeof input?.id === 'string' ? input.id : ''
    const source = id ? (getContext?.()?.sources ?? []).find((s) => s && s.id === id) : null
    const text = (v) => (typeof v === 'string' && v ? v : undefined)
    const activity = { kind: TOOL_KINDS[name] ?? 'reading', title: source ? source.title || source.id : null }
    for (const [key, value] of Object.entries({ path: text(input?.path ?? input?.list), range: text(input?.range), query: text(input?.query ?? input?.search), pattern: text(input?.pattern ?? input?.find) })) {
      if (value !== undefined) activity[key] = value
    }
    // A repository read through the reader tool (a model without tools) is a find, a search or a list by its arguments.
    if (name === READ_TOOL_NAME && source?.repository) activity.kind = activity.pattern ? 'finding' : activity.query ? 'searching' : typeof input?.path === 'string' ? 'reading' : 'listing'
    return activity
  }
  const partialArguments = (partial) => {
    const found = {}
    for (const m of String(partial ?? '').matchAll(/"(id|path|range|query|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      try {
        found[m[1]] = JSON.parse(`"${m[2]}"`)
      } catch {
        // not complete yet
      }
    }
    return found
  }
  // #341: any event of the stream is the first of the answer having arrived: the line moves on from Waiting for the AI, with the change the
  // event itself makes (a draft starting says Drafting, not Writing first), or on its own when the event changes nothing else.
  function onEvent(event) {
    if (event.type === 'sampling-retry' || event.type === 'retry') return handleEvent(event)
    const wasWaiting = Boolean(state.waiting)
    state.waiting = null
    state.writing = true
    const before = emitted
    try {
      handleEvent(event)
    } finally {
      if (wasWaiting && emitted === before) emit()
    }
  }

  function handleEvent(event) {
    if (event.type === 'sampling-retry') {
      // #341: the model refused a sampling setting; the call goes again without it, and the line says so while it waits.
      state.waiting = { since: clock(), without: event.without }
      emit()
      return
    }
    if (event.type === 'retry') {
      // An invalid card went back to the model: a new request, waiting again. #344: a card the output limit cut off says so on the line.
      if (event.cutOff) cutOffAgain()
      state.waiting = { since: clock(), without: null, ...(event.cutOff ? { cutOff: true } : {}) }
      state.writing = false
      emit()
      return
    }
    if (event.type === 'text') {
      textDraftFields = [...String(event.text ?? '').matchAll(DRAFT_BLOCK)].map((m) => m[1].match(FIELD_IN_PARTIAL)?.[1]).filter(Boolean)
      setDraftingFields()
      const shown = shownText(event.text)
      if (!shown) {
        if (textDraftFields.length) emit()
        return
      }
      if (!live) live = say('ai', '', { streaming: true })
      live.text = shown
      emit()
    } else if (event.type === 'preparing-questions') {
      state.preparing = true
      emit()
    } else if (event.type === 'tool-start') {
      if (event.name === DRAFT_TOOL_NAME) {
        state.drafting = true
        state.tool = null // the AI has moved on from its reads to drafting
        emit()
      } else if (READ_TOOLS.includes(event.name)) {
        state.tool = toolActivity(event.name)
        emit()
      }
    } else if (event.type === 'tool-progress') {
      if (READ_TOOLS.includes(event.name)) {
        const next = toolActivity(event.name, partialArguments(event.partial))
        if (JSON.stringify(next) !== JSON.stringify(state.tool)) {
          state.tool = next
          emit()
        }
        return
      }
      if (event.name !== DRAFT_TOOL_NAME) return
      const field = String(event.partial ?? '').match(FIELD_IN_PARTIAL)?.[1]
      if (field && draftingByCall.get(event.id) !== field) {
        draftingByCall.set(event.id, field)
        setDraftingFields()
        emit()
      }
    } else if (event.type === 'tool-call') {
      // #344: a call whose arguments are not whole JSON, or that has none, is answered once the turn is over, when the stop reason says
      // whether the output limit cut it off; answering it now would tell the AI only that the JSON was invalid, or that no Field was named.
      const input = event.call.input
      if (input !== null && input !== undefined && !(typeof input === 'object' && !Object.keys(input).length)) resultFor(event.call)
      draftingByCall.delete(event.call.id)
      state.drafting = draftingByCall.size > 0
      setDraftingFields()
      emit()
    }
  }

  /**
   * Works out how every Source document reaches `provider`, loads the originals that are to be attached, and builds the brief.
   * Returns what one request needs: the system text, the tools, and a function that puts the attachments on the first message.
   */
  async function prepare(provider) {
    const context = getContext()
    if (context.decisions) log.load(context.decisions)
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
      decisions: log.entries(),
      earlierDecisions: context.earlierDecisions ?? [],
      sources: sourcesForBrief(context.sources, plan),
      skills: context.skills,
      contextWindow: provider.contextWindow,
      readerTool: true,
      sourceAccess: accessForBrief(plan),
      approvedPrinted: context.approvedPrinted ?? {},
      reopenable: context.reopen ?? [],
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
    const handEdits = [...handOwned].map(([key, edit]) => ({ key, text: edit.text }))
    // #319: the repository tools are offered whenever a code repository is among the Source documents.
    const repositories = (brief.sources.repositories ?? []).length > 0 && Boolean(context.readRepository)
    return {
      system: `${brief.text}\n\n${sessionNote({ cardMode: state.cardMode, textDrafts, reader, repositories, handEdits })}`,
      // #294: the part that is the same on every turn, up to and including the Source documents. The cache point goes after it.
      cachePrefix: brief.stableText,
      tools: textDrafts ? [] : [DRAFT_TOOL, LOG_TOOL, ...(reader ? [READ_TOOL] : []), ...(repositories ? REPOSITORY_TOOLS : [])],
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

  /** One AI call's tokens count towards the session (#294), whatever it was for: a turn, a merged wording, or a compaction's summary (#329). */
  function countUsage(provider, usage) {
    state.usage = {
      inputTokens: state.usage.inputTokens + usage.inputTokens,
      outputTokens: state.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: state.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: state.usage.cacheWriteTokens + usage.cacheWriteTokens,
    }
    if (provider) log.addUsage(provider, usage)
  }

  // ---------- compaction (#329, docs/adr/0073) ----------

  /**
   * Compacts the conversation: the AI is asked, in one call with no tools, for its "where we are" summary, and the conversation is started
   * afresh from it (`compactConversation`). If that call fails the conversation is started afresh without it, and the thread line says so.
   * `tooLong`: the AI Provider has just refused the conversation as too long, so the summary call sends every read as its one-line note.
   * Only between turns or before a request: never while a tool call or a round of cards is open.
   */
  async function compact({ tooLong = false } = {}) {
    const provider = getAiProvider(state.providerId)
    if (!provider) throw new Error('This AI Provider no longer exists. Choose another.')
    state.compacting = true
    state.compactOffer = null
    emit()
    try {
      const { system, cachePrefix, withAttachments } = await prepare(provider)
      const before = lastInput || conversationTokens(system, messages)
      let summary = ''
      let failure = ''
      try {
        // Provider-neutral: the tool calls so far are shown as the blocks a model without tools would have written, so no tool is needed.
        const history = tooLong ? shortenOldReads(messages, { afterTurns: -1, minSaving: 0 }) : messages
        const request = withAttachments(flattenToolHistory([...history, { role: 'user', fromGantry: true, text: SUMMARY_REQUEST }]))
        const result = await runWithRecovery(
          () => runTurn(getAiProvider(state.providerId) ?? provider, { system, cachePrefix, messages: request, tools: [], askCards: false }, { fetchImpl, origin, signal: controller?.signal }),
          handlers
        )
        countUsage(provider, result.usage)
        summary = shownText(result.text).trim()
        if (!summary) failure = 'it sent nothing back'
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        failure = err?.message || 'it did not answer'
      }
      messages = compactConversation(messages, { summary, drafts: draftList() })
      const after = conversationTokens(system, messages)
      lastInput = 0
      contextTokens = after
      askAgainAt = 0
      state.compactPending = false
      const without = failure ? `. The AI couldn't write its summary (${failure.replace(/\.$/, '')}), so it carries on from the drafts, the decisions log and your own messages` : ''
      say('sys', `Conversation compacted (${tokensShort(before)} → ${tokensShort(after)} tokens)${without}`, { compacted: true })
    } finally {
      state.compacting = false
      emit()
    }
  }

  /** A request the AI Provider refuses as too long is compacted without asking and sent once more; a second refusal is the error. */
  async function compactingIfTooLong(send) {
    try {
      return await send()
    } catch (err) {
      if (!isTooLong(err) || !canCompact()) throw err
      await compact({ tooLong: true })
      try {
        return await send()
      } catch (again) {
        if (!isTooLong(again)) throw again
        throw new AiProviderError(
          'too-long',
          `${again.message} Gantry compacted the conversation and sent it once more, and it is still too long. Switch to an AI Provider whose model has a larger context window, or start this stage over.`,
          again.status
        )
      }
    }
  }

  /** At the end of a turn: the card offering to compact, once the input the AI Provider reported passes about 60% of the context window. */
  function offerCompaction() {
    const window = getAiProvider(state.providerId)?.contextWindow
    if (!window || !lastInput || state.compactPending || !canCompact()) return
    if (lastInput < window * COMPACT_OFFER_AT || lastInput < askAgainAt) return
    const after = conversationTokens(lastSystem, compactConversation(messages, { drafts: draftList() })) + SUMMARY_TOKENS
    state.compactOffer = { before: lastInput, after: Math.min(after, lastInput), window }
  }

  // #344: one more reply in a row the output limit cut off. The second says in the thread, once a turn, that Max tokens is the fix.
  function cutOffAgain() {
    if (++cutOffs < 2 || cutOffSaid) return
    cutOffSaid = true
    say('sys', cutOffAgainLine(getAiProvider(state.providerId)?.name), { cutOff: true })
  }

  /**
   * #349: at the end of a turn, Gantry's note on what keeps the Stage from its stage-end card, or null when there is nothing to tell. The
   * verdict is the page's own (`context.readiness`, the rule the live preview shows), never worked out a second way here. No note goes:
   *   * when the Stage is ready, or the page gives no readiness;
   *   * while anything is open for the architect: a round of cards, cards held back, a keep / use the AI's version / merge card about to be
   *     shown, review comments waiting to join, a clash;
   *   * once the architect has chosen Finish with your recommendations: the AI has been told to ask nothing more;
   *   * on a session that only brings Fields up to date or works through review comments, which has no stage-end card;
   *   * when every Field in scope is done and the Gate waits only on Fields this Stage can't draft;
   *   * when nothing is drafted this session (there is nothing for a stage-end card to Save), or the turn has nothing to show: an empty
   *     reply is #345's, with Carry on.
   * `firstId` is the first thread item of this turn.
   */
  function readinessCheck(firstId) {
    const context = getContext()
    if (typeof context?.readiness !== 'function') return null
    if (state.finish === 'accepting' || state.finish === 'done') return null
    if (state.update?.mode === 'only' || state.review?.mode === 'only') return null
    if (state.round || state.clash || state.held.length || queuedReview.length || [...pendingChanges.values()].some((c) => !c.shown)) return null
    // A draft the AI was asked to fix and has not sent again reaches the preview once the turn ends, so it is judged as it will stand.
    const drafts = { ...state.drafts }
    for (const [key, draft] of held) drafts[key] = draft
    if (Object.keys(drafts).length === 0) return null
    if (!state.thread.some((t) => t.id >= firstId && (t.who === 'ai' || t.drafted))) return null
    const verdict = context.readiness({ drafts, openFields: openFields() })
    if (!verdict || verdict.ready) return null
    // Every Field this Stage can draft is done, and what the Gate still needs lies outside it (a Module held until an earlier Stage merges,
    // #296, which the Waiting card explains): nothing the AI could fix.
    if (verdict.allDone && verdict.gate?.artefact) return null
    return readinessNote(verdict, { fieldTitle, chat: state.cardMode === 'chat' })
  }

  async function runLoop() {
    state.phase = 'working'
    const firstId = nextId // #345: the thread items from here on are this turn's
    state.carryOnAt = null
    let ended = false // #345: the turn ended of itself, not because its rounds ran out
    cutOffs = 0
    cutOffSaid = false
    state.error = null
    state.preparing = false
    state.compactOffer = null
    // #341: from the moment the architect's turn ends, the line says Waiting for the AI; the seconds count runs on into the first request.
    let carried = { since: clock(), without: null }
    state.waiting = carried
    state.writing = false
    controller = new AbortController()
    emit()
    let incoming = []
    let textRetried = false
    let readinessSaid = false // #349: the AI has been told this turn what keeps the Stage from its stage-end card
    try {
      // #329: Compact now, asked for while a round was open or the AI was busy, is done here, before the next request goes.
      if (state.compactPending && canCompact()) await compact()
      for (let round = 0; round < MAX_ROUNDS; round++) {
        live = null
        // #344: nothing is being drafted as a request goes, so a draft the parser dropped (a cut-off block that never closed) can't hold the
        // line at Drafting over the cut-off line.
        stopDrafting()
        messages = shortenOldReads(messages)
        const result = await compactingIfTooLong(() =>
          runWithRecovery(async () => {
            const provider = getAiProvider(state.providerId)
            if (!provider) throw new Error('This AI Provider no longer exists. Choose another.')
            const { textDrafts } = capabilities(provider)
            const { system, cachePrefix, tools, withAttachments, knownSources } = await prepare(provider)
            lastSystem = system
            const history = withAttachments(textDrafts ? flattenToolHistory(messages) : messages)
            // #341: the request goes: the line says Waiting for the AI, with the seconds, until the first of the answer arrives.
            state.waiting = carried ?? { since: clock(), without: null }
            carried = null
            state.writing = false
            state.tool = null
            emit()
            return runTurn(provider, { system, cachePrefix, messages: history, tools, knownSources, askCards: state.cardMode !== 'chat' }, { fetchImpl, origin, signal: controller.signal, onEvent, toolProgress: true })
          }, handlers)
        )
        state.waiting = null // a reply that sent nothing at all has still ended
        if (result.cutOff) cutOffAgain()
        else cutOffs = 0
        // #344: after a reply the output limit cut off, the next request asks for a shorter one, and the line says so until it answers.
        const askShorter = () => {
          carried = { since: clock(), without: null, cutOff: true }
          state.waiting = carried
        }
        const provider = getAiProvider(state.providerId)
        countUsage(provider, result.usage)
        lastInput = result.usage.inputTokens
        contextTokens = lastInput
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
            for (const call of result.otherToolCalls) messages.push(toolMessage(call, await resultFor(call)))
            if (result.otherToolCalls.some((c) => c.name === DRAFT_TOOL_NAME)) readsSinceDraft = []
          } else {
            const { drafts } = extractDraftBlocks(result.text)
            for (const d of drafts) acceptDraft(d.field, d.value, { uncovered: d.uncovered, inputs: d.inputs })
            for (const request of extractLogBlocks(result.text).requests) runLog(request)
            if (drafts.length) readsSinceDraft = []
          }
          const callIds = (result.assistantMessage.toolCalls ?? []).filter((c) => c.name === ASK_TOOL_NAME).map((c) => c.id)
          if (state.finish === 'done') {
            // The architect chose to finish and has had the last round: the cards are not shown.
            const note = 'Not shown: the architect chose Finish with your recommendations and has had the last round. Write your best drafts and ask nothing more.'
            if (callIds.length) for (const id of callIds) messages.push({ role: 'tool', toolCallId: id, name: ASK_TOOL_NAME, isError: true, content: note })
            else messages.push({ role: 'user', fromGantry: true, text: note })
            stopDrafting()
            emit()
            continue
          }
          pendingAsk = callIds.length ? { callIds } : null
          incoming = result.cards
          ended = true
          break
        }

        if (result.kind === 'tools' && !textDrafts) {
          if (live) live.streaming = false
          messages = [...base, result.assistantMessage]
          for (const call of result.otherToolCalls) messages.push(toolMessage(call, await resultFor(call)))
          // Once a round of drafts has landed, the reads before it are spent: they are inputs of those drafts, not of later ones.
          if (result.otherToolCalls.some((c) => c.name === DRAFT_TOOL_NAME)) readsSinceDraft = []
          if (result.cutOff) {
            // #344: a cut-off call's result says so; a reply the limit cut off between calls has nothing that does, so a note goes with them.
            if (!result.otherToolCalls.some((c) => c.cutOff)) messages.push({ role: 'user', fromGantry: true, text: CUT_OFF_NOTE })
            askShorter()
          }
          stopDrafting()
          emit()
          continue
        }

        // ---- a reply with no more tool calls. Text-fallback drafts and reads are taken from it ----
        const shown = shownText(result.text)
        settleLive(shown)
        messages = [...base, { role: 'assistant', text: result.text }]
        const notes = []
        let retry = false
        let readsReply = null
        if (textDrafts) {
          const { drafts, errors } = extractDraftBlocks(result.text)
          const requested = extractReadBlocks(result.text)
          // Reads are answered first, so a draft in the same reply is checked with them already recorded as its inputs.
          const answers = await Promise.all(requested.reads.map((r) => runRead(r)))
          const outcomes = drafts.map((d) => ({ d, ...acceptDraft(d.field, d.value, { uncovered: d.uncovered, inputs: d.inputs }) }))
          const logged = extractLogBlocks(result.text)
          const logOutcomes = logged.requests.map((request) => runLog(request))
          if (drafts.length) readsSinceDraft = []
          notes.push(...errors, ...requested.errors, ...logged.errors, ...outcomes.filter((o) => !o.ok).map((o) => o.content), ...logOutcomes.filter((o) => !o.ok).map((o) => o.content))
          readsReply = answers.length ? joinParts([{ text: "Gantry's reply to your read requests:" }, ...answers.map((a) => ({ text: a.content, ...readsOf(a) }))], '\n\n') : null
          if (round < MAX_ROUNDS - 1 && (answers.length || (notes.length && outcomes.some((o) => !o.ok) && held.size))) retry = true
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
        // #344: a reply the output limit cut off is answered, so the AI sends a shorter one rather than stopping part-way.
        const cutOff = result.cutOff && round < MAX_ROUNDS - 1
        const check = notes.length ? `Gantry's check of your drafts:\n- ${notes.join('\n- ')}` : ''
        if (retry || cutOff) {
          messages.push({ role: 'user', fromGantry: true, ...joinParts([cutOff ? { text: CUT_OFF_NOTE } : null, readsReply, check ? { text: check } : null].filter(Boolean), '\n\n') })
          if (cutOff) askShorter()
          emit()
          continue
        }
        // #345: reads asked for in the last round, as a native model's read calls would be: the rounds ran out, the turn did not end of
        // itself. Gantry's answers are kept in the history, so "go on" picks up with them, and the thread says the rounds were used up.
        if (readsReply) {
          messages.push({ role: 'user', fromGantry: true, ...joinParts([readsReply, check ? { text: check } : null].filter(Boolean), '\n\n') })
          break
        }
        // #349: the turn would end here. If the Stage is not ready and nothing is open for the architect, the AI is told what stands in the
        // way and carries on, once a turn, so a Stage only the architect can make ready never loops.
        const verdict = !readinessSaid && round < MAX_ROUNDS - 1 ? readinessCheck(firstId) : null
        if (verdict) {
          readinessSaid = true
          messages.push({ role: 'user', fromGantry: true, text: verdict })
          emit()
          continue
        }
        ended = true
        break
      }
      promoteHeld()
      openRound(incoming)
      if (state.finish === 'accepting') state.finish = 'done'
      // #329: Compact now, asked for while the AI was busy, is done as soon as the turn ends with no round of cards open.
      if (state.compactPending && !state.round && !state.clash) await compact()
      // #345: a turn that ends with nothing new to show says why, with Carry on, rather than just stopping: the AI used up its rounds while
      // still calling tools, or its last reply was empty. Reads are not something to show (they were what the turn was spent on).
      if (!ended) state.carryOnAt = say('sys', roundsUsedUpLine(), { carryOn: 'rounds' }).id
      else if (!state.round && !state.clash && !state.thread.some((t) => t.id >= firstId && (t.who === 'ai' || t.drafted))) state.carryOnAt = say('sys', STOPPED_LINE, { carryOn: 'empty' }).id
      state.phase = state.round ? 'asking' : 'waiting'
      offerCompaction()
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
      stopDrafting()
      state.preparing = false
      state.waiting = null
      state.writing = false
      state.tool = null
      for (const t of state.thread) if (t.streaming) t.streaming = false
      emit()
    }
  }

  // The Artefact the architect aims for is a decision of the interview (#288).
  function recordArtefact() {
    const context = getContext()
    const { candidates } = artefactChoices(context.definition, context.stageId)
    const chosen = candidates.find((a) => a.id === context.artefactId)
    if (!chosen) return
    const latest = log.entries().filter((e) => e.kind === 'artefact').at(-1)
    if (latest?.artefact === chosen.id) return
    log.addArtefact({ artefact: chosen.id, title: chosen.title ?? chosen.id, candidates: candidates.map((a) => a.id) })
  }

  // ---------- a Save's clash cards (#290) ----------

  const MERGE_SYSTEM =
    'You merge two versions of one Field of a document, for an architect who has to settle a clash at Save. You are given the Field as it was when the architect began (base), ' +
    'the architect\'s version (mine) and the version saved meanwhile (theirs). Write ONE wording that keeps what is good in both. Add no fact, figure or citation that is in neither. ' +
    'Where the two disagree about a fact, keep the architect\'s (mine) and say nothing about the disagreement. A list Field is one item per line. ' +
    'Reply with JSON only, no code fence and no commentary: {"merges":[{"id":"<the id given>","text":"<the merged wording>"}]}.'

  function parseMerges(text) {
    const body = String(text ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    try {
      const parsed = JSON.parse(body)
      const list = Array.isArray(parsed?.merges) ? parsed.merges : Array.isArray(parsed) ? parsed : []
      return new Map(list.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string' && m.text.trim()).map((m) => [m.id, m.text]))
    } catch {
      return new Map()
    }
  }

  /** Asks the AI for one merged wording per Field it can merge. Never blocks the Save: without it the card has two choices. */
  async function proposeMerges(conflicts, cards) {
    const mergeable = cards.filter((c) => c.clash.mergeable)
    const stillOpen = () => state.clash && clashWaiter && cards.every((c) => state.clash.cards.some((s) => s.id === c.id))
    const finishMerging = (note = '') => {
      if (stillOpen()) {
        state.clash = { ...state.clash, merging: false, mergeNote: note }
        emit()
      }
    }
    const provider = getAiProvider(state.providerId)
    if (mergeable.length === 0 || !provider) return finishMerging()
    const request = mergeable.map((card) => {
      const conflict = conflicts[cards.indexOf(card)]
      return { id: card.id, field: card.field, base: conflict.base === undefined ? '' : conflictText(conflict.base.value), mine: card.clash.mine, theirs: card.clash.theirs }
    })
    try {
      const result = await runTurn(provider, { system: MERGE_SYSTEM, messages: [{ role: 'user', text: JSON.stringify(request, null, 2) }], tools: [], askCards: false }, { fetchImpl, origin, signal: controller?.signal })
      countUsage(provider, result.usage)
      const merges = parseMerges(result.text)
      if (!stillOpen()) return
      state.clash = { ...state.clash, cards: state.clash.cards.map((c) => (merges.has(c.id) ? withMerged(c, merges.get(c.id)) : c)) }
      finishMerging(merges.size < mergeable.length ? "The AI couldn't write a merged wording for every Field." : '')
    } catch (err) {
      finishMerging(`The AI couldn't write a merged wording (${err?.message || 'it did not answer'}). Choose mine or theirs.`)
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
    if (state.round.update) return answerUpdate({ finish })
    if (state.round.revise) return answerRevise({ finish })
    const round = state.round
    const cards = finish ? round.cards.map(acceptRecommendation) : round.cards
    const open = cards.filter((c) => !isAnswered(c))
    if (open.length) return { ok: false, message: `${open.length} card${open.length === 1 ? ' is' : 's are'} not answered yet.`, firstOpen: open[0].id }
    const unfinished = cards.filter(reviewNeedsInput)
    if (unfinished.length) return { ok: false, message: 'Choose the Field each “Assign to a Field” answer is about.', firstOpen: unfinished[0].id }

    // #303: review comments are answered here too, alongside whatever else the round holds.
    const reviewCardsAnswered = cards.filter((c) => c.type === 'review')
    const others = cards.filter((c) => c.type !== 'review')
    let reviewAnswers = null
    if (reviewCardsAnswered.length) {
      reviewAnswers = answerReviewCards(reviewCardsAnswered, getContext())
      if (state.review) state.review = { ...state.review, answered: true }
    }
    if (others.length === 0 && reviewAnswers && !pendingAsk?.callIds.length) {
      // Only review cards were open: the interview (if there is one) is where it was. The AI is called only if something needs writing.
      state.round = null
      if (!reviewAnswers.ai) {
        state.phase = 'waiting'
        emit()
        return { ok: true }
      }
      const opening = round.review ? REVIEW_OPENING : 'The architect answered the review comments that joined this round. Work only on the Fields below, then carry on.'
      const body = `${opening}

The architect's answers to the review comments:
${reviewAnswers.text}`
      if (round.review) messages = withOpening([{ role: 'user', text: body }])
      else messages = [...messages, { role: 'user', fromGantry: true, text: body }]
      await runLoop()
      return { ok: true }
    }

    applyChangeDecisions(others)
    applyReopenDecisions(others)
    if (others.length) recordAnswers(others)
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
      answersText(others, { fieldTitle: (key) => key }),
      reviewAnswers ? `
Review comments they answered in this round:
${reviewAnswers.text}` : '',
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

    /**
     * Tests the chosen AI Provider if it has not been, then opens the interview. Resolves once the first turn has finished. `opening` (#331) is
     * what the architect typed in the kickoff's box: it shows in the thread as theirs and goes with the AI's first turn, never in the system prompt.
     */
    async start({ alongside = false, opening = '' } = {}) {
      if (state.phase !== 'kickoff') return
      state.kickoffError = null
      // #290 (ADR-0068): another session on this Stage that is not Done gets a card naming when it last saved. Carry on alongside
      // starts anyway (the Field-by-Field Save check keeps both safe); Cancel leaves the kickoff as it was.
      const resume = getContext?.()?.resume ?? null
      // #348: a session Start this stage over ended is this one's own past, whatever its committed line still says.
      const own = new Set([log.sessionId, ...log.endedSessions().map((e) => e.session)])
      const others = (resume?.others ?? []).filter((o) => !own.has(o.session))
      if (!alongside && others.length) {
        state.sessionWarning = { others }
        emit()
        return
      }
      state.sessionWarning = null
      const provider = getAiProvider(state.providerId)
      if (!provider) {
        state.kickoffError = 'Choose an AI Provider, or connect one.'
        emit()
        return
      }
      prepareRepositories()
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
      state.opening = String(opening ?? '').trim()
      openingToSend = state.opening
      // The thread shows the opening message as the architect's, where the conversation has it: after a resumed session's recap.
      const showOpening = () => state.opening && say('you', state.opening)
      // #303: a session that is only working through review comments opens its round before the AI is called, and ends there unless an answer needs
      // writing. One that joins review comments to an interview queues the cards for the first round the AI asks.
      const rev = getContext().review
      if (rev?.items?.length && rev.mode === 'only') {
        messages = []
        showOpening()
        openReviewRound()
        emit()
        return
      }
      if (rev?.items?.length && rev.mode === 'join') {
        const cards = reviewCardsFor(rev)
        queuedReview = [...queuedReview, ...cards]
        state.review = reviewStateFor(rev, cards.length, 'join')
      }
      const revise = getContext().revise
      if (revise) {
        // #299: the Owner sent this Stage back. Gantry lists the comments and asks a card for each before the AI is called; with no readable comment
        // the AI asks the architect what the Owner wants changed.
        recordArtefact()
        if (revise.comments?.length) {
          messages = []
          openReviseRound(revise)
          emit()
          return
        }
        messages = [{ role: 'user', text: REVISION_NO_COMMENTS }]
        await runLoop()
        return
      }
      const upd = getContext().update
      const updating = Boolean(upd?.items?.length)
      const updateOnly = updating && upd.mode === 'only'
      // #341: after Start this stage over the interview starts afresh, as the kickoff said (Start interview, not Resume interview).
      if (resume?.resuming && !updateOnly && !state.startedOver) {
        // #290: carrying on from the decisions log. The AI is given the log and the saved content (both are in its brief), not the old
        // conversation, and opens with the recap Gantry worked out.
        if (resume.adopt) log.adopt(resume.adopt)
        for (const entry of currentLogEntries(getContext().decisions)) if (entry.kind === 'saved-content' && entry.choice === 'keep' && entry.field) keptFields.add(entry.field)
        state.resumed = resume.recap
        say('sys', resume.recap, { resumed: true })
        messages = [{ role: 'user', text: openingFor(getContext(), resumeOpening(resume)) }]
      } else {
        messages = [{ role: 'user', text: openingFor(getContext()) }]
      }
      showOpening()
      if (updating) {
        // #298: the round about the Out of date Fields comes first, before the AI is called. A session that is only bringing them up to date
        // has nothing else to do; a normal one gives the AI its usual opening once the round is answered.
        updateOpening = updateOnly ? '' : messages[0].text
        messages = []
        if (!updateOnly) recordArtefact()
        openUpdateRound()
        emit()
        return
      }
      messages = withOpening(messages)
      recordArtefact()
      await runLoop()
    },

    /** The two-sessions card's Cancel: nothing starts and the kickoff stays as it was. */
    dismissSessionWarning() {
      state.sessionWarning = null
      emit()
    },

    /** Free chat: what the architect types goes to the AI as it is. Cards still open are put away and can be asked again. */
    async send(text) {
      const body = String(text ?? '').trim()
      if (!body || state.phase === 'working' || state.phase === 'kickoff' || state.phase === 'testing' || state.phase === 'paused') return
      if (state.round?.review) {
        // The review comments come first: chat would put them away, and the AI has not been told about them yet (#303).
        say('sys', 'Answer the review comment cards first, then chat.')
        emit()
        return
      }
      if (state.round?.revise) {
        // The comment cards come first: chat would put them away, and the AI has not been told about them yet (#299).
        say('sys', "Answer the Owner's comment cards first, then chat.")
        emit()
        return
      }
      if (state.round?.update) {
        // The Bring up to date cards come first: chat would put them away, and the AI has not been told about them yet (#298).
        say('sys', 'Answer the Bring up to date cards first, then chat.')
        emit()
        return
      }
      say('you', body)
      if (state.round) {
        for (const card of state.round.cards) if (card.type === 'change' && pendingChanges.has(card.field)) pendingChanges.get(card.field).shown = false
        requeueReview(state.round.cards)
        state.round = null
      }
      closePendingAsk('The architect did not answer these cards. They wrote in chat instead, below. Ask again if you still need them.')
      messages = [...messages, { role: 'user', text: body }]
      await runLoop()
    },

    /**
     * The earlier Stage this one was drafted ahead of has been approved and merged (#296): the Modules it held back are open, and the AI is told
     * to extend them. `modules` are `{ id, title }`. Only between turns; resolves `{ ok }`.
     */
    async modulesOpened({ modules = [], stageTitle = 'The earlier Stage' } = {}) {
      if (state.phase !== 'waiting' || modules.length === 0) return { ok: false }
      say('sys', `${stageTitle} was approved and merged. Now open: ${modules.map((m) => m.title ?? m.id).join(', ')}.`)
      messages = [...messages, { role: 'user', fromGantry: true, text: opened(modules, stageTitle) }]
      await runLoop()
      return { ok: true }
    },

    /**
     * #329: Compact now, on the card or in the rail's Tokens block. Between turns it is done at once. While a round of cards is open, a Save's
     * clash cards are up or the AI is busy, it waits and is done before the next request goes. Resolves `{ ok, queued?, message? }`.
     */
    async compactNow() {
      if (!canCompact() || ['kickoff', 'testing', 'paused'].includes(state.phase)) return { ok: false, message: 'There is no conversation to compact yet.' }
      state.compactOffer = null
      if (state.phase !== 'waiting' || state.clash) {
        state.compactPending = true
        emit()
        return { ok: true, queued: true }
      }
      state.phase = 'working'
      state.error = null
      controller = new AbortController()
      emit()
      try {
        await compact()
        state.phase = 'waiting'
      } catch (err) {
        state.phase = err?.name === 'AbortError' ? 'waiting' : 'error'
        if (state.phase === 'error') {
          state.compactPending = true
          state.error = { message: err?.message || 'The conversation could not be compacted.', code: err?.code ?? null }
        }
      } finally {
        emit()
      }
      return { ok: true }
    },

    /** #329: "Not now" on the card: it is not shown again until the conversation has grown by another tenth of the model's context window. */
    notNowCompact() {
      askAgainAt = lastInput + (getAiProvider(state.providerId)?.contextWindow ?? 0) * COMPACT_ASK_AGAIN_AFTER
      state.compactOffer = null
      emit()
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

    /**
     * Review comments (#303) join an interview that is going or paused: the questions of `review` (the same shape as the context's) are added to the
     * round that is open, or opened as a round of their own when the AI is waiting, or queued for the next round while it is busy. Resolves
     * `{ ok, added, where }`, `where` being `round`, `new-round` or `next-round`.
     */
    joinReview(review) {
      if (!review?.items?.length) return { ok: true, added: 0, where: 'none' }
      if (['kickoff', 'testing'].includes(state.phase)) return { ok: false, added: 0, where: 'none', message: 'Start the interview first, or work through the review comments on their own.' }
      const cards = reviewCardsFor(review)
      if (cards.length === 0) return { ok: true, added: 0, where: 'none' }
      state.review = state.review ? { ...state.review, total: state.review.total + cards.length, answered: false } : reviewStateFor(review, cards.length, 'join')
      let where = 'next-round'
      if (state.phase === 'asking' && state.round && !state.round.update && !state.round.revise && !state.round.review && !state.clash) {
        state.round = { ...state.round, cards: [...state.round.cards, ...cards] }
        where = 'round'
      } else if (state.phase === 'waiting' && !state.round && !state.clash) {
        state.round = { id: ++state.roundNo, cards, page: 0, final: false, review: false }
        state.phase = 'asking'
        where = 'new-round'
      } else {
        queuedReview = [...queuedReview, ...cards]
      }
      say('sys', `${cards.length} review comment${cards.length === 1 ? '' : 's'} added ${where === 'round' ? 'to this round' : where === 'new-round' ? 'as a round of their own' : 'to the next round'}.`, { reviewJoined: true })
      emit()
      return { ok: true, added: cards.length, where }
    },

    /** Free text under a review card: the architect's own words, logged with the outcome. */
    setReviewReason(cardId, text) {
      setCard(cardId, (c) => (c.type === 'review' ? { ...c, reason: String(text ?? '') } : c))
    },

    /** The Field a review comment on the document is assigned to. Choosing one chooses "Assign to a Field". */
    setReviewAssign(cardId, fieldKey) {
      setCard(cardId, (c) => (c.type === 'review' ? { ...c, assignTo: String(fieldKey ?? ''), selected: fieldKey ? ['Assign to a Field'] : c.selected } : c))
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
      const before = getAiProvider(state.providerId)
      state.providerId = id
      const now = getAiProvider(id)
      if (before && now && (before.type !== now.type || before.model !== now.model)) log.addModelChange({ type: before.type, model: before.model }, { type: now.type, model: now.model })
      state.cardMode = capabilities(now).baseline
      cardFailures = 0
      say('sys', `Switched to ${now?.name ?? 'another AI Provider'}${now?.model ? ` (${now.model})` : ''}`)
      emit()
      return { ok: true }
    },

    /**
     * Pause (#290, ADR-0064) saved the log and the drafts so far: the run stops here and carries on, in this browser or any other,
     * from the decisions log and the saved content. Nothing about the conversation is kept.
     */
    markPaused() {
      controller?.abort()
      state.phase = 'paused'
      state.round = null
      say('sys', 'Paused. The decisions log and the drafts so far are saved. Open the Interview page again, in any browser, to carry on.')
      emit()
    },

    // ---- a Save that found Fields both sides changed (#290, ADR-0068) ----
    /**
     * The Save check found Fields that you and someone else both changed. They are settled here, as a round of cards (keep mine,
     * keep theirs, or a merged wording from the AI), and each choice is logged. `conflicts` are `mergeStage`'s, each given a
     * `label`. Resolves `{ resolutions, entries }` (what `mergeStage` takes, and the log entries to save with this Save), or null
     * when the architect cancels the Save.
     */
    settleClashes(conflicts) {
      if (clashWaiter) return Promise.resolve(null)
      const cards = conflicts.map((c) => {
        const id = `clash:${c.moduleId}:${c.key}`
        const mergeable = c.kind === 'field' || c.kind === 'custom'
        const field = `${c.moduleId}.${c.kind === 'field' ? c.key.slice('field:'.length) : c.key}`
        return clashCard({ id, label: c.label ?? field, field, mine: c.mine === undefined ? '' : conflictText(c.mine.value), theirs: c.theirs === undefined ? '' : conflictText(c.theirs.value), mergeable })
      })
      state.clash = { cards, merging: cards.some((c) => c.clash.mergeable), mergeNote: '' }
      emit()
      const done = new Promise((resolve) => {
        clashWaiter = { resolve, conflicts }
      })
      void proposeMerges(conflicts, cards)
      return done
    },

    chooseClash(cardId, label) {
      if (!state.clash) return
      state.clash = { ...state.clash, cards: state.clash.cards.map((c) => (c.id === cardId ? choose(c, label) : c)) }
      emit()
    },

    /** Settles the clash cards: logs each choice and hands the Save its resolutions. A card without a choice is not settled. */
    submitClash() {
      if (!state.clash || !clashWaiter) return { ok: false, message: 'There is nothing to settle.' }
      const open = state.clash.cards.filter((c) => !isAnswered(c))
      if (open.length) return { ok: false, message: `${open.length} Field${open.length === 1 ? ' is' : 's are'} not settled yet.` }
      const resolutions = {}
      const entries = []
      for (const card of state.clash.cards) {
        const index = state.clash.cards.indexOf(card)
        const conflict = clashWaiter.conflicts[index]
        const choice = card.selected[0]
        const side = choice === CLASH_OPTIONS.mine ? conflict.mine : choice === CLASH_OPTIONS.theirs ? conflict.theirs : null
        if (choice === CLASH_OPTIONS.merged) resolutions[conflictKey(conflict.moduleId, conflict.key)] = { value: conflictValueFromText(card.clash.merged, (conflict.mine ?? conflict.theirs)?.value) }
        else resolutions[conflictKey(conflict.moduleId, conflict.key)] = side === undefined ? { remove: true } : { value: side.value }
        const word = choice === CLASH_OPTIONS.mine ? 'mine' : choice === CLASH_OPTIONS.theirs ? 'theirs' : 'merged'
        const entry = log.addSaveClash(card.field, word, { feeds: conflict.kind === 'field' })
        if (entry) entries.push(entry)
        say('sys', `Settled ${card.field}: ${word === 'merged' ? "the AI's merged wording" : `kept ${word}`}`)
      }
      const waiter = clashWaiter
      clashWaiter = null
      state.clash = null
      emit()
      waiter.resolve({ resolutions, entries: entries.map((e) => ({ ...e })) })
      return { ok: true }
    },

    /** Cancel the Save: nothing is written and the choices made so far are forgotten. */
    cancelClash() {
      if (!clashWaiter) return
      const waiter = clashWaiter
      clashWaiter = null
      state.clash = null
      emit()
      waiter.resolve(null)
    },

    /** Entries of this session that were never sent are taken back (a Save that was cancelled or failed after the clash cards). */
    discardEntries(ids) {
      log.discard(ids)
      emit()
    },

    // ---- the working copy (#290, ADR-0064) ----
    /**
     * True when the session is somewhere a copy can be taken: not mid-turn, under way, and holding something a Save has not taken: a draft
     * not yet saved, an answer not yet in the committed log, or a round of cards waiting. Straight after a Save there is nothing to keep, so
     * a reload shows the Interview page afresh (and, for a run paused by Save and stop, its Resume) rather than a copy of a finished Stage.
     */
    get canKeepCopy() {
      if (['kickoff', 'testing', 'working', 'paused'].includes(state.phase)) return false
      return Object.keys(state.drafts).length > 0 || log.pending().length > 0 || Boolean(state.round)
    },

    /** What the session knows of the committed log, for the working copy to tell later whether the log has moved on. */
    knownLog() {
      return { committedIds: log.committed().map((e) => e.id), lastAiSave: log.lastAiSave() }
    },

    /** The unsaved part of the session and the AI's history, as plain data for the browser's working copy. */
    exportState() {
      const keep = ({ ...rest }) => ({ ...rest })
      return {
        sessionId: log.sessionId,
        nextId,
        messages: messages.map(keep),
        state: {
          providerId: state.providerId,
          thread: state.thread.map((t) => ({ ...t, streaming: false })),
          drafts: state.drafts,
          fieldInputs: state.fieldInputs,
          savedKeys: state.savedKeys,
          cardMode: state.cardMode,
          usage: state.usage,
          round: state.round,
          roundNo: state.roundNo,
          held: state.held,
          answered: state.answered,
          finish: state.finish,
          resumed: state.resumed,
          update: state.update,
          review: state.review,
          revise: state.revise,
          error: state.error,
          phase: state.phase,
          opening: state.opening,
          compactOffer: state.compactOffer,
          compactPending: state.compactPending,
          carryOnAt: state.carryOnAt,
        },
        compaction: { lastInput, askAgainAt, contextTokens },
        pendingChanges: [...pendingChanges],
        queuedReview,
        updateOpening,
        openingToSend,
        updateCauses: [...updateCauses],
        kept: [...keptFields],
        authorised: [...authorised],
        otherTexts: [...otherTexts],
        bounced: [...bounced],
        heldDrafts: [...held],
        readsSinceDraft,
        pendingAsk,
        cardFailures,
        log: log.exportState(),
      }
    },

    /** Picks up from a working copy: the same drafts, open round, answers and history. Only a session that has not started can. */
    importState(saved) {
      if (!saved || state.phase !== 'kickoff' || !saved.state) return false
      const s = saved.state
      Object.assign(state, {
        providerId: s.providerId ?? state.providerId,
        thread: s.thread ?? [],
        drafts: s.drafts ?? {},
        fieldInputs: s.fieldInputs ?? {},
        savedKeys: s.savedKeys ?? [],
        cardMode: s.cardMode ?? 'native',
        usage: s.usage ?? EMPTY_USAGE,
        round: s.round ?? null,
        roundNo: s.roundNo ?? 0,
        held: s.held ?? [],
        answered: s.answered ?? [],
        finish: s.finish ?? null,
        resumed: s.resumed ?? null,
        update: s.update ?? null,
        review: s.review ?? null,
        revise: s.revise ?? null,
        error: s.error ?? null,
        opening: s.opening ?? '',
        compactOffer: s.compactOffer ?? null,
        compactPending: s.compactPending === true,
        carryOnAt: s.carryOnAt ?? null,
        compacting: false,
        kickoffError: null,
        drafting: null,
        preparing: false,
        preparingRepository: null,
        waiting: null,
        writing: false,
        tool: null,
      })
      messages = saved.messages ?? []
      lastInput = saved.compaction?.lastInput ?? 0
      contextTokens = saved.compaction?.contextTokens ?? lastInput
      askAgainAt = saved.compaction?.askAgainAt ?? 0
      nextId = saved.nextId ?? nextId
      pendingChanges.clear()
      for (const [k, v] of saved.pendingChanges ?? []) pendingChanges.set(k, v)
      queuedReview = saved.queuedReview ?? []
      updateOpening = saved.updateOpening ?? ''
      openingToSend = saved.openingToSend ?? ''
      updateCauses.clear()
      for (const [k, v] of saved.updateCauses ?? []) updateCauses.set(k, v)
      keptFields.clear()
      for (const k of saved.kept ?? []) keptFields.add(k)
      authorised.clear()
      for (const k of saved.authorised ?? []) authorised.add(k)
      otherTexts.length = 0
      otherTexts.push(...(saved.otherTexts ?? []))
      bounced.clear()
      for (const k of saved.bounced ?? []) bounced.add(k)
      held.clear()
      for (const [k, v] of saved.heldDrafts ?? []) held.set(k, v)
      readsSinceDraft = saved.readsSinceDraft ?? []
      pendingAsk = saved.pendingAsk ?? null
      cardFailures = saved.cardFailures ?? 0
      log.importState(saved.log)
      state.phase = s.phase === 'error' ? 'error' : state.round ? 'asking' : 'waiting'
      say('sys', 'Picked up where you left off in this browser.')
      emit()
      return true
    },

    /** The drafts were saved: they are no longer an unsaved preview, and the Fields now hold saved content again. */
    markSaved(keys) {
      for (const key of keys) {
        delete state.drafts[key]
        authorised.delete(key)
        pendingChanges.delete(key)
        handOwned.delete(key)
        editing.delete(key)
      }
      state.savedKeys = [...new Set([...state.savedKeys, ...keys])]
      say('sys', `Saved ${keys.length} Field${keys.length === 1 ? '' : 's'}. The Modules stay draft.`)
      emit()
    },

    /**
     * What the stage Save writes into the decisions log (#288): the entries not yet committed, the inputs of every Field in this Save
     * and this session's status. `runState` is `in-progress`, `ready`, `saved`, `paused` or `done`; `saving` stamps the time of the AI save. `target` and `stages` (#293) are the run's target Stage and each Stage's state.
     */
    decisionsDelta({ runState = 'in-progress', saving = false, target, stages } = {}) {
      const context = getContext()
      noteReturnedToDraft()
      const keys = [...new Set([...Object.keys(state.drafts), ...state.savedKeys])]
      return log.delta({
        fieldInputs: state.fieldInputs,
        fieldKeys: keys,
        handEdited: keys.filter((key) => state.drafts[key]?.handEdited === true),
        saving,
        status: { who: context.actor, target: target ?? context.targetStageId ?? context.stageId, state: runState, stages: stages ?? context.runStages, artefact: context.artefactId, artefacts: context.runArtefacts, instructions: context.instructionsVersion, opening: state.opening },
      })
    },

    /** The Stage's committed decisions log as the page read it (again): what the AI is told is settled, and what the rail counts. */
    loadDecisions(file) {
      log.load(file)
      emit()
    },

    /** The Save that carried `delta` worked: its entries are part of the committed log now. */
    commitDecisions(delta) {
      log.commit(delta)
      emit()
    },

    /**
     * "Start this stage over": appends a restart marker (the AI ignores every earlier answer from then on) and puts the session
     * back at the kickoff. Unsaved drafts are dropped; saved content is untouched. The log begins a new session (#348): its tokens start
     * at nothing, and what the ended one used is kept as an earlier session of the Stage.
     */
    startOver() {
      if (state.phase === 'working' || state.phase === 'testing') return { ok: false, message: 'Wait for the AI to finish its turn first.' }
      controller?.abort()
      // #348: a new session begins in the log, so This session counts from nothing; the one ended keeps its line and its tokens.
      log.startOver({ opening: state.opening })
      state.resumed = null
      state.startedOver = true
      messages = []
      lastInput = 0
      contextTokens = 0
      askAgainAt = 0
      state.compactOffer = null
      state.compactPending = false
      state.thread = []
      state.carryOnAt = null
      state.drafts = {}
      state.fieldInputs = {}
      state.savedKeys = []
      state.round = null
      state.held = []
      state.answered = []
      state.finish = null
      state.error = null
      state.update = null
      state.review = null
      queuedReview = []
      state.revise = null
      state.reopenRequest = null
      updateOpening = ''
      state.opening = ''
      openingToSend = ''
      updateCauses.clear()
      state.phase = 'kickoff'
      pendingChanges.clear()
      keptFields.clear()
      authorised.clear()
      handOwned.clear()
      editing.clear()
      stopDrafting()
      otherTexts.length = 0
      bounced.clear()
      held.clear()
      handled.clear()
      readsSinceDraft = []
      pendingAsk = null
      cardFailures = 0
      emit()
      return { ok: true }
    },

    // ---- hand edits (#289) ----
    /**
     * The architect opens a drafted Field to edit it in the preview. Resolves `{ ok, message? }`: refused for a Field with no draft
     * and for one the AI is drafting right now. While it is open, a draft the AI sends for it meets a card instead of replacing it.
     */
    beginHandEdit(key) {
      if (!state.drafts[key]) return { ok: false, message: 'Only a Field with a draft can be edited here. Saved content is edited in the editor.' }
      if (state.draftingFields.includes(key)) return { ok: false, message: 'The AI is drafting this Field. You can edit it once the draft lands.' }
      editing.add(key)
      emit()
      return { ok: true }
    },

    /** The architect closed the editor without keeping what they typed. */
    cancelHandEdit(key) {
      if (editing.delete(key)) emit()
    },

    /**
     * The architect's edit of a drafted Field. `text` is what they typed (a multi-valued Field: one item per line). The Field is theirs
     * from now on: no per-Field check runs on it, a `hand-edit` entry keeps the typed text, and the Field's inputs are rebuilt from the
     * edited text (only the Source documents it still cites). Resolves `{ ok, changed, message? }`.
     */
    handEdit(key, text) {
      const draft = state.drafts[key]
      if (!draft) return { ok: false, changed: false, message: 'Only a Field with a draft can be edited here.' }
      if (state.draftingFields.includes(key)) return { ok: false, changed: false, message: 'The AI is drafting this Field. You can edit it once the draft lands.' }
      const context = getContext()
      const entry = fieldsInScope(context.definition, context.stageId).get(key)
      if (!entry) return { ok: false, changed: false, message: `${key} is not a Field of this Stage.` }
      const value = normaliseDraftValue(entry.field, text)
      if (isBlankValue(value)) return { ok: false, changed: false, message: 'A Field can’t be left empty here. Type its content, or cancel to keep the draft.' }
      editing.delete(key)
      if (asText(value) === asText(draft.value)) {
        emit()
        return { ok: true, changed: false }
      }
      // The inputs are rebuilt from the text: each Source document it still cites (keeping its page range), and nothing else.
      const earlier = state.fieldInputs[key] ?? []
      const cites = new Set(citedSourceIds(Array.isArray(value) ? value.join('\n') : value))
      const kept = earlier.filter((input) => input.source && cites.has(input.source))
      const inputs = [...kept, ...inputsForDraft({ reads: [], value, sources: context.sources }).filter((input) => !kept.some((k) => k.source === input.source))]
      state.drafts[key] = { value, words: countWords(value), warnings: [], uncovered: [], inputs, moduleId: draft.moduleId, fieldId: draft.fieldId, handEdited: true }
      state.fieldInputs[key] = inputs
      handOwned.set(key, { text: asText(value), after: architectMessages().length })
      log.addHandEdit(key, Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : value)
      // A card already waiting for this Field compares against what they typed now.
      const waiting = pendingChanges.get(key)
      if (waiting) {
        if (asText(waiting.proposed) === asText(value)) pendingChanges.delete(key)
        else pendingChanges.set(key, { ...waiting, saved: asText(value), handEdit: true })
      }
      if (state.round) {
        state.round = {
          ...state.round,
          cards: state.round.cards.flatMap((c) => {
            if (c.type !== 'change' || c.field !== key) return [c]
            return waiting && !pendingChanges.has(key) ? [] : [{ ...c, change: { ...c.change, saved: asText(value), handEdit: true } }]
          }),
        }
        if (state.round.cards.length === 0) {
          state.round = null
          if (state.phase === 'asking') state.phase = 'waiting'
        }
      }
      say('sys', `You edited ${fieldTitle(key)} by hand. It is yours now: the AI changes it only if you ask in chat or choose its version on a card.`, { handEdited: key })
      emit()
      return { ok: true, changed: true }
    },

    /** Drops every unsaved draft. */
    discardDrafts() {
      state.drafts = {}
      authorised.clear()
      handOwned.clear()
      editing.clear()
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
