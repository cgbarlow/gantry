// #286 (parent #238, docs/adr/0061 and 0065; layout B of #243): the **Interview page** — the AI interview for the current
// Stage of a local or server workspace Instance. Left rail: the Source documents. Centre: the conversation, with the
// kickoff form first and the free-chat composer pinned at the bottom. Right: the live draft preview of the Stage's Modules,
// where the AI's drafts appear as they are written, marked "AI draft · unsaved".
//
// This file only draws the page and wires it up. The conversation, the drafting, the rounds of question cards (#287) and the
// checks on each draft are web/lib/interviewSession.js; the rules for a round are web/lib/interviewRounds.js; "is this Field done
// and this Stage ready" is web/lib/interviewReadiness.js (over the Gate check of web/lib/interviewGate.js); the brief the AI is
// given is web/lib/interviewBrief.js. A drafted Field can be hand-edited in the preview (#289): click it, type, Done. Saving is the editor's own stage Save (the Save check of ADR-0068 and all), handed in as
// `onSaveDrafts`, so a Save from here is the same Save, one commit, with the Modules left `draft`.
import { html } from 'htm/preact'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { isMultiValuedField } from './fieldShape.js'
import { aiProviders, defaultAiProvider, updateAiProvider } from './aiProviders.js'
import { AiProviderDialog, AiRecoveryPrompt } from './aiProvidersView.js'
import { SourceDocumentsPanel } from './sourceDocumentsPanel.js'
import { repositoryReaderFor } from './sourceRepositoryClient.js'
import { citationIndex, openCitation, renderMarkdownPreview } from './markdownPreview.js'
import { createInterviewSession, statusLine, CARRY_ON_MESSAGE } from './interviewSession.js'
import { stageReadiness } from './interviewReadiness.js'
import { PAGE_SIZE, isAnswered, pageCards, pageCount } from './interviewRounds.js'
import { loadInterviewSkillsInBrowser } from './interviewSkills.js'
import { modulesWithStandard } from './standardModules.js'
import { citationSegments, isBlankValue } from './interviewDraft.js'
import { describeInput, planSourceAccess } from './interviewSources.js'
import { effectiveTargetSize, fieldTargetWords, targetSizeLabel } from './targetSize.js'
import { OPENING_MAX, logSummary } from './decisionsLog.js'
import { outOfDateCountByStage, findOutOfDateFields, flagsForField } from './outOfDate.js'
import { planUpdateRound, stagesToUpdate } from './bringUpToDate.js'
import { answeredCounts, assignChoices, planReview, reviewerLabels } from './reviewRound.js'
import { ReviewContext, ReviewInputs, ReviewSection } from './reviewView.js'
import { downloadReviewResponseList, hasReviewResponses, reviewResponseRows } from './reviewResponse.js'
import { artefactRows, beginRun, chosenArtefacts, clearRun, interviewRuns, nextStage, planRows, resumableRun, resumedArtefacts, runArtefacts, runOpening, runStartStage, runTargets, saveOutcome, updateRun } from './interviewRun.js'
import { EMPTY_TOKENS, addTokens, formatTokens, hasTokens, tokenBreakdown, tokensOfLog, totalTokens } from './tokenUsage.js'
import { describeSaved, resumeInfo } from './interviewResume.js'
import { isRemoteInstance, lastSavedBy, openApproval, pullRequestLink, remoteRecord } from './interviewApproval.js'
import { SENT_BACK_CHOICES, reopenOffer, staleLaterFields } from './prRevision.js'
import { approvedPrintedFields, changedMark, earlierDocumentsToRender, reRenderCardLine } from './interviewReapproval.js'
import { fieldCountLabel } from './changedSinceApproval.js'
import { copyStanding, createWorkingCopyStore, makeWorkingCopy } from './interviewWorkingCopy.js'
import { heldModules, isDraftingAhead, withHeldModules } from './draftAhead.js'
import { fieldsInScope } from './interviewScope.js'

// One session per Instance Stage while the editor page is open, so going to the editor and back keeps the conversation and the drafts.
const sessions = new Map()
/** A Stage that was re-opened (#299) starts afresh in this tab: the session it had before is dropped. */
export function forgetInterviewSession(slug, stageId) {
  sessions.get(`${slug}|${stageId}`)?.cancel()
  sessions.delete(`${slug}|${stageId}`)
}
export function clearInterviewSessions() {
  for (const session of sessions.values()) session.cancel()
  sessions.clear()
}
/**
 * The Modules of this Stage that hold unsaved drafts from the interview (#289), for the editor's banner: the editor shows saved content
 * only, so it points to the Interview page, where those drafts are edited. `[]` when no interview is open for the Stage.
 */
export function unsavedDraftModules(slug, stageId) {
  const session = sessions.get(`${slug}|${stageId}`)
  if (!session) return []
  const modules = new Map()
  for (const draft of Object.values(session.snapshot().drafts)) modules.set(draft.moduleId, (modules.get(draft.moduleId) ?? 0) + 1)
  return [...modules].map(([moduleId, fields]) => ({ moduleId, fields }))
}

// #290: the browser's working copy of an unsaved session (web/lib/interviewWorkingCopy.js).
const workingCopies = createWorkingCopyStore()
let skillsPromise = null
const loadSkills = () => (skillsPromise ??= loadInterviewSkillsInBrowser().catch((err) => {
  skillsPromise = null
  throw err
}))

const PROGRESS_LABELS = { key: 'Checking the key…', model: 'Checking the model…', cards: 'Checking question cards…', images: 'Checking whether it reads images…' }

/**
 * #347: an AI reply in the thread, drawn as Markdown by the module editor's preview (web/lib/markdownPreview.js): the same renderer and
 * sanitising, asset images, and Source document citations that open the document. `preview` is `{ resolveAssets, sources }` for it. A reply
 * is drawn again as each piece arrives, so half-finished Markdown (an unclosed fence or table) may show raw until it closes; its Mermaid
 * diagrams are drawn once, when it is finished.
 */
export function AiReply({ m, preview }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    renderMarkdownPreview(ref.current, m.text, { ...preview, mermaid: !m.streaming })
  }, [m.text, m.streaming, preview])
  return html`<div class=${`msg ai md${m.streaming ? ' streaming caret' : ''}`} data-testid="interview-msg" data-who="ai" ref=${ref}></div>`
}

/**
 * One message of the thread. #347: only the AI's replies are Markdown; the architect's messages and Gantry's system lines are plain text, as
 * typed. #345: `carryOn` marks the system line a quiet turn left while Carry on still answers it, and `onCarryOn` sends "go on".
 */
export function ThreadMessage({ m, preview, carryOn = false, onCarryOn }) {
  if (carryOn) {
    return html`<div class="msg sys carry-on" data-testid="interview-msg" data-who="sys" data-carry-on=${m.carryOn}>
      ${m.text} <button type="button" class="btn small" data-testid="interview-carry-on" title=${`Send "${CARRY_ON_MESSAGE}" to the AI, so it picks up where it stopped.`} onClick=${onCarryOn}>Carry on</button>
    </div>`
  }
  if (m.who === 'ai') return html`<${AiReply} m=${m} preview=${preview} />`
  return html`<div class=${`msg ${m.who}${m.streaming ? ' streaming caret' : ''}`} data-testid="interview-msg" data-who=${m.who} data-carry-on=${m.carryOn}>${m.text}</div>`
}

function ValueView({ value }) {
  if (Array.isArray(value)) return html`<ul class="interview-value-list">${value.map((item, i) => html`<li key=${i}><${ValueView} value=${item} /></li>`)}</ul>`
  return html`${citationSegments(value).map((seg, i) =>
    seg.cite ? html`<span key=${i} class="cite" data-source-id=${seg.id} title=${`Source document ${seg.id}`}>${seg.cite}</span>` : seg.text
  )}`
}

/**
 * The in-place editor of one drafted Field (#289). Text is a text box showing the Markdown as stored (a citation is the link
 * `[title, p. 4](source:id)`: delete it to drop the citation), a list is one item per line, a select is its options, a date is a date.
 */
function HandEditor({ field, value, error, onDone, onCancel }) {
  const multi = isMultiValuedField(field)
  const [text, setText] = useState(Array.isArray(value) ? value.join('\n') : String(value ?? ''))
  const [picked, setPicked] = useState(Array.isArray(value) ? value : value ? [value] : [])
  const done = () => onDone(field.type === 'select' ? (multi ? picked : picked[0] ?? '') : text)
  let control
  if (field.type === 'select' && multi) {
    control = html`<div role="group" aria-label=${field.title ?? field.id} data-testid="interview-field-input">
      ${(field.options ?? []).map((option) => html`<label key=${option} class="opt-inline"><input type="checkbox" checked=${picked.includes(option)} onChange=${() => setPicked(picked.includes(option) ? picked.filter((o) => o !== option) : [...picked, option])} /> ${option}</label>`)}
    </div>`
  } else if (field.type === 'select') {
    control = html`<select data-testid="interview-field-input" aria-label=${field.title ?? field.id} value=${picked[0] ?? ''} onChange=${(e) => setPicked([e.currentTarget.value])}>
      ${(field.options ?? []).map((option) => html`<option key=${option} value=${option} selected=${picked[0] === option}>${option}</option>`)}
    </select>`
  } else if (field.type === 'date') {
    control = html`<input type="date" data-testid="interview-field-input" aria-label=${field.title ?? field.id} value=${text} onInput=${(e) => setText(e.currentTarget.value)} />`
  } else {
    control = html`<textarea
      class="hand-edit-input"
      data-testid="interview-field-input"
      aria-label=${field.title ?? field.id}
      rows=${Math.min(14, Math.max(4, text.split('\n').length + 1))}
      value=${text}
      onInput=${(e) => setText(e.currentTarget.value)}
    ></textarea>`
  }
  return html`<div class="hand-edit" data-testid="interview-field-editor">
    ${control}
    ${multi && field.type !== 'select' ? html`<p class="hand-edit-note">One item per line.</p>` : null}
    ${error ? html`<p class="inline-error" role="alert" data-testid="interview-hand-error">${error}</p>` : null}
    <div class="hand-edit-actions">
      <button type="button" class="btn small primary" data-testid="interview-hand-done" onClick=${done}>Done</button>
      <button type="button" class="btn small ghost" data-testid="interview-hand-cancel" onClick=${onCancel}>Cancel</button>
    </div>
  </div>`
}

/** Whether a Stage's decisions log shows the Stage was worked on and saved (a branch exists for it on a remote workspace). */
function logHasSaved(log) {
  if (!log) return false
  return Object.keys(log.fields ?? {}).length > 0 || (Array.isArray(log.status) && log.status.some((s) => s?.lastAiSave))
}

// Instances (by slug) whose architect asked, in this tab, for the review questions to join the interview that resumes or starts next (#303).
const reviewJoinWanted = new Set()

const MODE_LABELS = { native: 'native', text: 'text fallback', chat: 'plain chat' }

/** One question card: header chip, the Field it feeds, the question, option tiles, "Why I recommend it" with its citation, and Other where it applies. */
function QuestionCard({ card, fieldTitle, session }) {
  const type = card.multiSelect ? 'checkbox' : 'radio'
  const recommended = new Set(card.recommended)
  return html`<div class="qcard" data-testid="interview-card" data-card-id=${card.id} data-card-type=${card.type ?? 'question'} data-card-kind=${card.kind ?? ''}>
    <div class="qchip">
      ${card.header || (card.type === 'update' ? 'Out of date' : card.type === 'review' ? 'Review comment' : card.type === 'change' ? 'Saved content' : card.kind === 'term' ? 'Preferred term' : card.kind === 'decision' ? 'Key decision' : 'Question')}${card.multiSelect ? ' · choose any' : ''}
      ${card.field ? html` · feeds <span data-testid="card-feeds">${fieldTitle(card.field)}</span>` : null}
    </div>
    <p class="qhead" data-testid="card-question">${card.question}</p>
    ${card.kind === 'term' && card.meaning ? html`<p class="qmeaning" data-testid="card-meaning"><strong>What it is:</strong> ${card.meaning}</p>` : null}
    ${card.kind === 'decision' && card.decision
      ? html`<ul class="qsignificance" data-testid="card-significance" aria-label="Why this is a Key decision">
          <li><strong>Hard to reverse:</strong> ${card.decision.hardToReverse}</li>
          <li><strong>Surprising without context:</strong> ${card.decision.surprising}</li>
          <li><strong>A real trade-off:</strong> ${card.decision.tradeOff}</li>
        </ul>`
      : null}
    ${card.change?.reapproves?.length
      ? html`<p class="kick-note reapproval-note" data-testid="change-reapproval" role="note">Approved by ${card.change.reapproves.map((s) => s.title).join(', ')}. Changing this Field changes approved content, so ${card.change.reapproves.map((s) => s.title).join(', ')} is re-approved with this Stage: its documents are re-rendered and its approver must approve too.</p>`
      : null}
    ${card.comment
      ? html`<p class="kick-note" data-testid="comment-card-note">
          ${card.comment.resolved ? 'The Owner marked this thread resolved, and it is asked about all the same. ' : ''}${card.comment.url
            ? html`<a href=${card.comment.url} target="_blank" rel="noopener noreferrer" data-testid="comment-link">Open the comment on the Provider</a>`
            : null}
        </p>`
      : null}
    ${card.update
      ? html`<div class="update-current" data-testid="update-current">
          ${card.update.saved ? html`<div><span class="qchip">Saved</span><div class="value" data-testid="update-card-saved"><${ValueView} value=${card.update.saved} /></div></div>` : null}
          ${card.update.note ? html`<p class="kick-note" data-testid="update-landing">${card.update.note}</p>` : null}
        </div>`
      : null}
    ${card.review ? html`<${ReviewContext} card=${card} />` : null}
    ${card.change
      ? html`<div class="change-compare" data-testid="change-compare">
          <div><span class="qchip">${card.change.reapproves?.length ? 'Approved' : 'Saved'}</span><div class="value" data-testid="change-saved">${isBlankValue(card.change.saved) ? 'Empty' : html`<${ValueView} value=${card.change.saved} />`}</div></div>
          <div><span class="qchip">The AI's version</span><div class="value ai" data-testid="change-proposed"><${ValueView} value=${card.change.proposed} /></div></div>
        </div>`
      : null}
    <div class="opts-tiles" role=${card.multiSelect ? 'group' : 'radiogroup'} aria-label=${card.question}>
      ${card.options.map((option) => {
        const chosen = card.selected.includes(option.label)
        return html`<label key=${option.label} class=${'opt' + (chosen ? ' chosen' : '')} data-testid="card-option" data-option=${option.label} data-chosen=${chosen ? 'true' : 'false'}>
          <input type=${type} name=${card.id} checked=${chosen} onChange=${() => session.choose(card.id, option.label)} />
          <span>
            <span class="olabel">${option.label}</span>${recommended.has(option.label) ? html`<span class="rec" data-testid="card-recommended">RECOMMENDED</span>` : null}
            ${option.description ? html`<span class="odesc">${option.description}</span>` : null}
          </span>
        </label>`
      })}
      ${card.allowOther
        ? html`<label class=${'opt' + (card.otherOn ? ' chosen' : '')} data-testid="card-other" data-chosen=${card.otherOn ? 'true' : 'false'}>
            <input type=${type} name=${card.id} checked=${card.otherOn} onChange=${() => session.chooseOther(card.id)} />
            <span style="flex:1">
              <span class="olabel">Other</span>
              ${card.otherOn
                ? html`<input class="other-input" data-testid="card-other-input" aria-label="Your own answer" placeholder="Type your answer…" value=${card.otherText} onInput=${(e) => session.setOtherText(card.id, e.currentTarget.value)} />`
                : null}
            </span>
          </label>`
        : null}
    </div>
    ${card.review ? html`<${ReviewInputs} card=${card} session=${session} fieldTitle=${fieldTitle} />` : null}
    ${card.why || card.source
      ? html`<p class="why" data-testid="card-why">
          <strong>Why I recommend it:</strong> ${card.why}
          ${card.source ? html` <span class="cite" data-testid="card-cite" data-source-id=${card.source.document} title=${`Source document ${card.source.document}`}>${card.source.title ?? card.source.document}${card.source.location ? `, ${card.source.location}` : ''}</span>` : null}
        </p>`
      : null}
  </div>`
}

/** A Field both you and someone else changed (#290, ADR-0068): the wordings side by side and a choice, nothing pre-selected. */
function ClashCard({ card, session }) {
  const shown = [
    ['mine', 'Yours', card.clash.mine],
    ['theirs', 'Theirs, saved meanwhile', card.clash.theirs],
    ...(card.clash.merged !== null ? [['merged', "The AI's merged wording", card.clash.merged]] : []),
  ]
  return html`<div class="qcard" data-testid="clash-card" data-card-id=${card.id} data-field=${card.field}>
    <div class="qchip">${card.header} · <span data-testid="clash-field">${card.field}</span></div>
    <p class="qhead">${card.question}</p>
    <div class="change-compare" data-testid="clash-compare">
      ${shown.map(([side, label, text]) => html`<div key=${side}><span class="qchip">${label}</span><pre class="clash-text value" data-testid=${`clash-${side}`}>${text === '' ? '(removed)' : text}</pre></div>`)}
    </div>
    <div class="opts-tiles" role="radiogroup" aria-label=${card.question}>
      ${card.options.map((option) => {
        const chosen = card.selected.includes(option.label)
        return html`<label key=${option.label} class=${'opt' + (chosen ? ' chosen' : '')} data-testid="clash-option" data-option=${option.label} data-chosen=${chosen ? 'true' : 'false'}>
          <input type="radio" name=${card.id} checked=${chosen} onChange=${() => session.chooseClash(card.id, option.label)} />
          <span><span class="olabel">${option.label}</span><span class="odesc">${option.description}</span></span>
        </label>`
      })}
    </div>
  </div>`
}

/** What the kickoff says about how this AI Provider will ask its questions: native, then text, then plain chat. */
function CardModeNote({ provider }) {
  const found = provider.test?.questionCards
  const mode = found === 'text' ? 'text' : found === 'chat' ? 'chat' : 'native'
  return html`<div data-testid="interview-card-mode" data-mode=${mode}>
    <p class="kick-note">
      <strong>Question cards:</strong>
      ${mode === 'native'
        ? found === 'native'
          ? ' native. This model asks with a tool, so every question appears as a card.'
          : ' native, tried first. Gantry finds out when you start.'
        : mode === 'text'
          ? ' text fallback. This model can\'t use tools, so it asks and drafts in text. That works, but it is less reliable.'
          : ' plain chat. This model can\'t produce question cards, so it asks in chat and you answer there. That works, but it is less reliable.'}
      Gantry never refuses a model: it tries native, then text, then plain chat.
    </p>
    ${mode !== 'native' ? html`<div class="warn" role="status" data-testid="interview-text-fallback">${mode === 'text' ? "This model can't use tools, so Gantry will ask for its drafts and questions in text (the text fallback)." : 'Questions will be asked in plain chat.'}</div>` : null}
  </div>`
}

/** `module.field` as "Module · Field" from a Definition, or the key as it is. */
function fieldLabel(definition, key) {
  const [moduleId, ...rest] = String(key).split('.')
  const mod = definition?.modules?.find((m) => m.id === moduleId)
  const field = mod?.fields?.find((f) => f.id === rest.join('.'))
  return mod && field ? `${mod.title ?? mod.id} · ${field.title ?? field.id}` : String(key)
}

function providerLabel(p) {
  return `${p.name || p.type}${p.model ? ` · ${p.model}` : ''}${p.isDefault ? ' (Default)' : ''}`
}

/**
 * The page. Props:
 *   instance        the Instance as the editor holds it (`GET /api/instance`'s shape); its Modules are the saved content
 *   store           the Instance's Source document store (list / upload / readText …)
 *   actor           the name stamped on Source documents uploaded here
 *   editorHref      where "← Editor" goes
 *   blockedReason   a sentence when the Instance can't be written to (archived, no write access), else ''
 *   loadStructure   () => the Definition version projection
 *   loadOtherSaved  () => the other Stages' Modules (same shape as `instance.modules`), for the brief
 *   decisionsStore  { read(stageId) } the Stage's decisions log (#288, web/lib/decisionsStore.js)
 *   onSaveDrafts    (drafts, { artefactId, decisions, settleClashes }) => { ok, message?, check?, decisions?, settledIds? }  puts the drafts in the Modules and does the stage Save, writing the
 *                   decisions log in the same Save. A Field both sides changed goes to `settleClashes` (a round of cards, #290) instead of the editor's dialog
 *   onAdvance       () => { ok, message? }  moves the Instance on to its next Stage, for a run's "Save, advance, carry on" (#293); the page for that Stage then replaces this one
 *   checkStatus     () => { [stageId]: state }  Check status, run once when the page opens (#290); what it reports overrides the file. The app leaves it out on an Azure DevOps or GitHub workspace,
 *                   where the page runs Check status itself (once, when it opens on a Stage with a Pull Request on file, #295) so it can show the answer
 *   onRequestApproval  () => { ok, pullRequestId?, webUrl?, message? }  an Azure DevOps or GitHub workspace's "request approval" (#295): opens the Stage's Pull Request and loads the Instance again
 *   onReRenderEarlier  (item) => { ok, message? }  renders one earlier approved Stage's document onto this Stage's branch (#300, ADR-0069); the stage-end Save does it, for the documents
 *                      Request approval would refuse over, before it asks. `item` is one entry of the refusal's `reRenderRequired` (`{ artefactId, artefactTitle, stageTitle, ... }`)
 *   onCheckApproval    () => { ok, merged, message }  Check status (#295); when the Pull Request has merged the Instance has moved on and the page of the next Stage replaces this one
 *   onDraftAhead       (stageId) => { ok, message? }  moves the page on to a later Stage while the earlier one awaits approval (#296, docs/adr/0063): the Instance stays where it is and the page for that Stage replaces this one
 *   flagsReady         false until the Out of date check for this Stage has run once, so an interview that starts by itself waits to know whether a round of cards comes first (it waits no more than a few seconds)
 *   stageStarted       whether the current Stage has a branch, read fresh for this page (the Instance in the editor may predate a Source document upload); undefined when not known
 *   update             true when the page was opened with "Bring up to date" (#298): a round of cards about exactly the Fields flagged Out of date on this Stage, and nothing else
 *   onReopenStage      (stageId) => { ok, message? }  re-opens a signed-off Stage (ADR-0026) for a Field only that Stage can change (a remote workspace), when the architect chooses it instead of saving
 *   onOpenStage        (stageId) => void  shows the Interview page on another Stage (a local or server workspace): "Bring up to date" works through the Stages in order
 *   review             true when the page was opened with "Bring in review comments" (#303): a focused round of cards, one per unresolved comment thread of a Reviewed copy, and nothing else
 *   reviewCopies       the kept Reviewed copies, read and placed on Fields (`loadReviewedCopies`), or null while they load
 *   onBringInReview    () => void  opens the dialog that brings review comments in
 *   onOpenReview       () => void  shows the Interview page as a focused review round
 *   onReviewAnswered   ({ [reviewId]: n }) => Promise  raises the manifest's answered counts once answers are saved
 *   resolveAssets      (text) => text  rewrites asset references to images, as the editor's preview does, for the AI's replies in the thread (#347); none when left out
 */
// #297: `outOfDate` is the Fields flagged Out of date (web/lib/outOfDate.js) and `newSince` the documents marked New since last interview; the run plan marks each Stage that has flagged Fields and the Source documents rail marks the new documents.
export function InterviewPage({ instance, store, actor = '', editorHref, blockedReason = '', loadStructure, loadOtherSaved, decisionsStore, onSaveDrafts, onAdvance, checkStatus = null, onRequestApproval, onReRenderEarlier = null, onCheckApproval, onDraftAhead, outOfDate = [], newSince = [], flagsReady = true, stageStarted, update = false, onReopenStage, onOpenStage, review = false, reviewCopies = null, onBringInReview, onOpenReview, onReviewAnswered, revise = false, loadPrComments = null, onReviseStage = null, onLeaveRevision = null, onUpdateStage = null, resolveAssets = null }) {
  const key = `${instance.slug}|${instance.stage.id}`
  // #298: Bring up to date has its own session and working copy, so it never takes over an interview that is part-way.
  // #299: a revision of a Stage the Owner sent back has its own session too.
  const sessionKey = update ? `${key}|update` : revise ? `${key}|revise` : review ? `${key}|review` : key
  // #295: on an Azure DevOps or GitHub workspace a Stage moves on only when its Pull Request merges, so the stage-end card asks for approval instead of advancing.
  const remote = isRemoteInstance(instance)
  const awaiting = openApproval(instance) // the Pull Request the Provider says is open for this Stage, else null: it overrides what the log says
  const [approval, setApproval] = useState({ phase: 'idle', message: '' })
  const [headStart, setHeadStart] = useState(null) // #296: the head start saved from the Waiting card: { fields, stopped }
  // #299: what the last Check status said when the Owner sent the Stage back or rejected it: { kind, stageId, stageTitle, pullRequestId, stopped? }
  const [sentBack, setSentBack] = useState(null)
  // #299: every comment on the Stage's Pull Request, read when a revision opens: { status: 'idle'|'loading'|'ready'|'error', list, pullRequestId, message }
  const [prComments, setPrComments] = useState({ status: revise ? 'loading' : 'idle', list: [], pullRequestId: null, message: '' })
  const lastHeld = useRef({ key: '', list: [] }) // the Modules held when the AI was last told about them (#296)
  const [setup, setSetup] = useState({ status: 'loading' })
  const [sources, setSources] = useState(null)
  const [snap, setSnap] = useState(null)
  // #293: the run in this tab for this Instance, if any. A run that has carried on into this Stage starts it by itself.
  const run = interviewRuns.value[instance.slug] ?? null
  const carryingOn = run?.carryOn === instance.stage.id
  const [pickedProvider, setPickedProvider] = useState(carryingOn ? run.providerId ?? null : null)
  const [pickedArtefacts, setPickedArtefacts] = useState({}) // #332: the Artefact the architect chose on this kickoff, by Stage id
  const [pickedTarget, setPickedTarget] = useState(carryingOn ? run.target : null)
  const [resumeLogs, setResumeLogs] = useState(null) // the committed logs of this Stage and the one before it, which say whether a run was left part-way
  const [resumeMessage, setResumeMessage] = useState('')
  // #331: the kickoff's optional box, sent as the architect's opening message. It starts blank on every kickoff and is never remembered;
  // a run carries what was sent to each Stage it reaches. `startedOver` stops a Start this stage over picking up a paused session's.
  const [opening, setOpening] = useState('')
  const startedOver = useRef(false)
  const autoStarted = useRef(false)
  const [connecting, setConnecting] = useState(false)
  const [recovery, setRecovery] = useState(null)
  const [switchMessage, setSwitchMessage] = useState('')
  const [chat, setChat] = useState('')
  const [saving, setSaving] = useState(null)
  const [committedLog, setCommittedLog] = useState(null) // the Stage's decisions log as committed (#288)
  const [stageLogs, setStageLogs] = useState({}) // every Stage's committed log, by Stage id: the tokens each Stage has used (#294)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [handEditing, setHandEditing] = useState(null) // { key, error? }: the drafted Field open for a hand edit (#289)
  const [generation, setGeneration] = useState(0) // bumped to open the page afresh after a Pause (#290)
  const [flagsWaited, setFlagsWaited] = useState(false) // the wait for the Out of date check ran out (#298)
  const [reopenedThreads, setReopenedThreads] = useState(() => new Set()) // threads resolved in Word that the architect asked to have asked after all (#303)
  const [joinWanted, setJoinWanted] = useState(() => reviewJoinWanted.has(instance.slug)) // the review questions join the interview (#303)
  const [reviewMessage, setReviewMessage] = useState('')
  const [asideNotice, setAsideNotice] = useState(null) // a working copy that was set aside because the committed log moved on (#290)
  const [copyRestored, setCopyRestored] = useState(false)
  const sessionRef = useRef(null)
  const ctxRef = useRef(null)
  const threadRef = useRef(null)
  const providers = aiProviders.value

  const providerId = (providers.find((p) => p.id === pickedProvider) ?? defaultAiProvider())?.id ?? null
  const provider = providers.find((p) => p.id === (snap?.providerId ?? providerId)) ?? null

  // ---- load what the brief needs: the Definition, the bundled skills, the other Stages' saved content ----
  useEffect(() => {
    let cancelled = false
    setSetup({ status: 'loading' })
    // #290: opening the page on an Instance with logs runs Check status once, then reads each Stage's status block and log. What the
    // Provider reports overrides the file. A local or server workspace has no Provider to ask: its own record of which Stage is current is
    // the report, and every Stage before it has moved on.
    loadStructure()
      .then(async (structure) => {
        const stages = structure.stages ?? []
        const [skills, otherSaved, logList, asked] = await Promise.all([
          loadSkills(),
          loadOtherSaved().catch(() => []),
          Promise.all(stages.map((st) => (decisionsStore?.read(st.id) ?? Promise.resolve(null)).catch(() => null))),
          Promise.resolve(checkStatus?.() ?? {}).catch(() => ({})),
        ])
        return { structure, skills, otherSaved, logs: Object.fromEntries(stages.map((st, i) => [st.id, logList[i]])), asked: asked ?? {} }
      })
      .then(({ structure, skills, otherSaved, logs, asked }) => {
        if (cancelled) return
        const definition = { ...structure, modules: modulesWithStandard(structure.modules, structure.standardModules) }
        const providerStates = { ...asked }
        const order = (structure.stages ?? []).map((st) => st.id)
        const current = order.indexOf(instance.currentStageId)
        if (current > 0) for (const id of order.slice(0, current)) providerStates[id] ??= 'advanced'
        // #291: a term choice made at an earlier Stage binds this one, and an open question left there is carried to the Open questions
        // module, so the earlier Stages' logs are read too. A log that can't be read is left out: the interview carries on without it.
        const stageAt = order.indexOf(instance.stage.id)
        const earlierDecisions = (structure.stages ?? [])
          .slice(0, Math.max(0, stageAt))
          .map((st) => ({ stageId: st.id, stageTitle: st.title ?? st.id, entries: logs[st.id]?.entries ?? [] }))
          .filter((l) => l.entries.length)
        setSetup({ status: 'ready', structure, definition, skills, otherSaved, logs, providerStates, earlierDecisions })
        setCommittedLog(logs[instance.stage.id] ?? null)
        setStageLogs(logs) // #294: what each Stage has used, for the run plan
        // #293: the committed logs of this Stage and the one before it say whether a run was left part-way.
        const instStageAt = (instance.stages ?? []).findIndex((st) => st.id === instance.stage.id)
        const previousId = instStageAt > 0 ? instance.stages[instStageAt - 1].id : null
        setResumeLogs({ [instance.stage.id]: logs[instance.stage.id] ?? null, ...(previousId ? { [previousId]: logs[previousId] ?? null } : {}) })
      })
      .catch((err) => !cancelled && setSetup({ status: 'error', message: err.message }))
    return () => {
      cancelled = true
    }
  }, [key, generation])

  // #299: a revision reads every comment on the Stage's Pull Request, resolved ones included, when it opens. Read-only: nothing is written to the Pull Request.
  useEffect(() => {
    if (!revise) return undefined
    if (!loadPrComments) {
      setPrComments({ status: 'error', list: [], pullRequestId: null, message: 'The Pull Request comments cannot be read here.' })
      return undefined
    }
    let live = true
    setPrComments({ status: 'loading', list: [], pullRequestId: null, message: '' })
    Promise.resolve(loadPrComments(instance.stage.id))
      .then((result) => live && setPrComments(result?.ok ? { status: 'ready', list: result.comments ?? [], pullRequestId: result.pullRequestId ?? null, message: '' } : { status: 'error', list: [], pullRequestId: null, message: result?.message || 'The Pull Request comments could not be read.' }))
      .catch((err) => live && setPrComments({ status: 'error', list: [], pullRequestId: null, message: err.message }))
    return () => {
      live = false
    }
  }, [revise, key, generation])

  // ---- the Source documents, with the text read out of each, whenever the list changes ----
  // Stable between renders: the panel reloads its list whenever this changes, and every list it reads sets state here (#292).
  const storeRef = useRef(store)
  storeRef.current = store
  const onSourceList = useCallback(async (list) => {
    const entries = []
    for (const entry of list.entries) {
      if (entry.removedAt || !entry.text) {
        entries.push(entry)
        continue
      }
      let text = null
      try {
        text = await storeRef.current.readText(entry.id)
      } catch {
        // an unreadable text is left out; the brief lists the document as having none
      }
      entries.push(text ? { ...entry, text } : { ...entry, text: undefined })
    }
    setSources(entries)
  }, [])

  // #347: what the thread's AI replies are drawn with: this Instance's asset images (`resolveAssets`, the editor's) and its Source documents,
  // so a citation opens the document from here as it does from the editor's preview. A document that can't be opened says so in the header.
  const [citeMessage, setCiteMessage] = useState('')
  const replyPreview = useMemo(() => {
    const index = citationIndex(sources ?? [])
    const open = (ref) => {
      setCiteMessage('')
      openCitation(storeRef.current, index, ref).catch((err) => setCiteMessage(err.message))
    }
    return { resolveAssets, sources: { index, open } }
  }, [sources, resolveAssets])

  // #293: the run's target Stage ("Run until"). The current Stage when no other is picked, which is a run of one Stage.
  const stagesList = instance.stages ?? []
  const targets = runTargets(stagesList, instance.stage.id)
  // #295: a session that opens on a Stage already awaiting approval has no picker to read, so its run target is the one the log recorded.
  const loggedTarget = awaiting && Array.isArray(committedLog?.status) && committedLog.status.length ? committedLog.status[committedLog.status.length - 1].target : null
  const wantedTarget = pickedTarget ?? (targets.some((t) => t.id === loggedTarget) ? loggedTarget : null)
  const target = targets.some((t) => t.id === wantedTarget) ? wantedTarget : instance.stage.id
  const followingStage = nextStage(stagesList, instance.stage.id)
  // #331, #332: the run in this tab that this Stage is part of: the one that carried on into it, or one still running to the same target.
  const sameRun = Boolean(run && run.phase === 'running' && run.target === target)

  // #332: the Artefact each Stage of the run aims for ("Artefact for each Stage"). What the run already chose comes from the run in this tab, or
  // else from the status blocks of this Stage and the one before it, so a run or a paused session resumed in another browser keeps its choices.
  // Bring up to date, review comments and a revision have no Artefact to choose: they aim for this Stage's lightest, as before.
  const choosing = !update && !review && !revise
  const previousStageId = stagesList[stagesList.findIndex((st) => st.id === instance.stage.id) - 1]?.id ?? null
  const rememberedArtefacts =
    !choosing || setup.status !== 'ready'
      ? {}
      : carryingOn || sameRun
        ? run.artefacts ?? {}
        : { ...(previousStageId ? runArtefacts(setup.logs?.[previousStageId], previousStageId) : {}), ...runArtefacts(committedLog, instance.stage.id) }
  const stageArtefacts =
    setup.status === 'ready'
      ? artefactRows({ definition: setup.definition, stages: stagesList, currentStageId: instance.stage.id, targetStageId: choosing ? target : instance.stage.id, picked: choosing ? pickedArtefacts : {}, remembered: rememberedArtefacts })
      : []
  const runArtefactsNow = chosenArtefacts(stageArtefacts)
  const artefactId = stageArtefacts[0]?.chosen?.id ?? null

  // #296 (docs/adr/0063): this Stage is being drafted ahead of the Instance's current one. It gets a head start only: the Modules an earlier,
  // still pending Stage also mounts are held, so the AI sees them as read-only here and Gantry refuses any write to them until that Stage merges.
  const ahead = remote && isDraftingAhead(stagesList, instance.stage.id, instance.currentStageId)
  const held = remote && setup.status === 'ready' ? heldModules(setup.definition.stages, instance.stage.id, instance.currentStageId) : []
  const heldKey = held.map((h) => h.id).join('|')
  const definitionNow = setup.status === 'ready' ? withHeldModules(setup.definition, instance.stage.id, held) : null
  const pendingTitles = [...new Set(held.map((h) => h.stageTitle))]
  const otherSaved = setup.status === 'ready' ? setup.otherSaved.filter((m) => !instance.modules.some((own) => own.id === m.id)) : []
  // A held Module's saved content is the earlier Stage's, which this Stage's own branch may not have yet: take it from there.
  const heldIds = new Set(held.map((h) => h.id))
  const heldFresh = setup.status === 'ready' ? [...heldIds].map((id) => setup.otherSaved.find((m) => m.id === id)).filter(Boolean) : []
  const ownSaved = instance.modules.filter((m) => !heldFresh.some((f) => f.id === m.id))
  // #300 (ADR-0069): on an Azure DevOps or GitHub workspace, the Fields an approved earlier Stage prints are approved content, which the AI changes only through a card that names the re-approval.
  const approvedPrinted = useMemo(
    () => (setup.status === 'ready' ? approvedPrintedFields({ definition: setup.definition, instance }) : {}),
    [setup, instance.stages, instance.pullRequests, instance.currentStageId, instance.stage.id, instance.changedSinceApproval, instance.workspaceBacked]
  )
  ctxRef.current =
    setup.status === 'ready'
      ? {
          definition: definitionNow,
          approvedPrinted,
          stageId: instance.stage.id,
          artefactId,
          // #332: the Artefact chosen for each Stage of the run, which the status block records with each Save.
          runArtefacts: { ...(carryingOn || sameRun ? run.artefacts : {}), ...runArtefactsNow },
          size: instance.size,
          saved: [...ownSaved, ...heldFresh, ...otherSaved],
          sources: sources ?? [],
          skills: setup.skills,
          // #288: what the decisions log already holds, who is interviewing, and the Interview instructions version the status block records.
          decisions: committedLog,
          earlierDecisions: setup.earlierDecisions ?? [],
          // #290: whether this run carries on from the decisions log, the earlier session of this architect it takes over, and the other
          // sessions still going on this Stage. Worked out when Start is pressed, from the logs as they are then.
          get resume() {
            if (update || review || revise) return null // Bring up to date, review comments and a revision are never a resumed interview (#298, #303, #299)
            return resumeInfo({
              logs: { ...setup.logs, [instance.stage.id]: committedLog },
              stageId: instance.stage.id,
              stageTitle: instance.stage.title,
              actor,
              // A Stage re-opened for this run (#299) was approved and merged: the sessions that interviewed it before are finished with it.
              providerStates: run?.reopened === instance.stage.id ? { ...setup.providerStates, [instance.stage.id]: 'approved' } : setup.providerStates,
              stages: setup.structure.stages ?? [],
              fieldTitle: (fieldKey) => fieldLabel(setup.definition, fieldKey),
            })
          },
          actor,
          // #298: the documents New since last interview (a normal session's AI reads them against what is saved) and the Out of date Fields
          // this Stage can act on (the session opens with a round of cards about them). Worked out when Start is pressed.
          newSince: update || review || revise ? [] : newSince,
          // #299: the Owner sent this Stage back: every comment on its Pull Request, for the round of cards that opens the revision. And the signed-off
          // Stages the AI may offer to re-open, each with whether Gantry would allow it right now.
          get revise() {
            return revise && prComments.status === 'ready'
              ? { comments: prComments.list, pullRequestId: prComments.pullRequestId, pullRequestUrl: pullRequestLink(instance, prComments.pullRequestId), stageTitle: instance.stage.title }
              : undefined
          },
          get reopen() {
            return reopenList
          },
          // #303: the review comments this Stage can act on. `mode` is `only` on a focused round, `join` when the architect asked for them to come
          // with the interview, else `none` (the labels are still there, so anything the AI is told is scrubbed of real names).
          get review() {
            return reviewPlan ? reviewContext(review ? 'only' : joinWanted ? 'join' : 'none') : undefined
          },
          get update() {
            return !review && !revise && updatePlan && updatePlan.items.length
              ? {
                  mode: update ? 'only' : 'first',
                  items: updatePlan.items,
                  deferred: updatePlan.deferred,
                  elsewhere: updatePlan.elsewhere,
                  logs: { ...setup.logs, [instance.stage.id]: committedLog },
                  stageTitle: stageTitleOf,
                  pageStageTitle: instance.stage.title,
                }
              : undefined
          },
          targetStageId: target,
          instructionsVersion: `${setup.definition.id ?? instance.definition}@${instance.definitionVersion ?? setup.structure.version ?? 1}`,
          // #292: a picture, or a scanned or "Read visually" PDF, is sent as the original; the session reads it when it builds a request.
          readOriginal: async (id) => (await store.readOriginal(id)).bytes ?? null,
          // #319: a code repository is read live by the Gantry server, with the architect's own token for it. #338: a call waits while
          // the server downloads its copy, telling the session how far it has got (`how`: { onPreparing, signal }).
          readRepository: (entry, how) => repositoryReaderFor(entry.repository, how),
          // #338: starting the interview (or Bring up to date) starts that download, so the AI's first search rarely waits.
          prepareRepository: (entry) => repositoryReaderFor(entry.repository).prepare(),
        }
      : null

  // ---- the session ----
  function ask(kind) {
    return (err) => new Promise((resolve) => setRecovery({ kind, message: err.message, resolve }))
  }
  useEffect(() => {
    if (setup.status !== 'ready') return undefined
    let session = sessions.get(sessionKey)
    const fresh = !session
    if (fresh) {
      session = createInterviewSession({ providerId })
      sessions.set(sessionKey, session)
    }
    sessionRef.current = session
    // #290: every stable moment, the browser keeps a working copy of the unsaved session, so closing the tab loses nothing.
    const keepCopy = (snapshot) => {
      setSnap(snapshot)
      if (session.canKeepCopy) {
        const known = session.knownLog()
        workingCopies.save(sessionKey, makeWorkingCopy({ state: session.exportState(), committedIds: known.committedIds, lastAiSave: known.lastAiSave }))
      }
    }
    session.bind({ getContext: () => ctxRef.current, handlers: { askForKey: ask('key'), askToRetry: ask('retry') }, onChange: keepCopy })
    if (fresh) {
      // The same browser resumes exactly where it stopped, unless the committed log has moved on since the copy began: then the
      // committed log wins and the copy is set aside, with a notice.
      const copy = workingCopies.load(sessionKey)
      if (copy) {
        const standing = copyStanding(copy, setup.logs?.[instance.stage.id] ?? null)
        if (standing === 'fresh') session.loadDecisions(setup.logs?.[instance.stage.id] ?? null)
        if (standing === 'fresh' && session.importState(copy.state)) setCopyRestored(true)
        else {
          workingCopies.setAside(sessionKey, copy, standing)
          setAsideNotice({ savedAt: copy.savedAt })
        }
      }
    }
    return () => session.bind({ onChange: null })
  }, [sessionKey, setup.status])

  // #303: once answers are saved, the manifest of each Reviewed copy says how many of its comments are answered. It follows the committed logs,
  // and only ever goes up, so a write that is repeated or late changes nothing.
  const sentCounts = useRef({})
  useEffect(() => {
    if (!onReviewAnswered || !reviewCopies?.length) return
    const counts = answeredCounts({ ...stageLogs, [instance.stage.id]: committedLog })
    const raise = {}
    for (const { entry } of reviewCopies) {
      const n = counts[entry.id] ?? 0
      if (n > (entry.commentsAnswered ?? 0) && n > (sentCounts.current[entry.id] ?? 0)) raise[entry.id] = n
    }
    if (Object.keys(raise).length === 0) return
    sentCounts.current = { ...sentCounts.current, ...raise }
    Promise.resolve(onReviewAnswered(raise)).catch((err) => {
      for (const id of Object.keys(raise)) delete sentCounts.current[id]
      setReviewMessage(`The answered count could not be updated: ${err.message}`)
    })
  }, [stageLogs, committedLog, reviewCopies])

  // The Stage's committed decisions log is what the rail counts and what the AI is told is settled (#288).
  useEffect(() => {
    if (setup.status === 'ready' && committedLog && sessionRef.current) sessionRef.current.loadDecisions(committedLog)
  }, [committedLog, setup.status])

  // Before the interview starts, the session follows the picker (and a Default that arrives from "Connect an AI Provider").
  useEffect(() => {
    const session = sessionRef.current
    if (session && providerId && session.providerId !== providerId && snap?.phase === 'kickoff') session.setProvider(providerId)
  }, [providerId, snap?.phase])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [snap?.thread?.length, snap?.thread?.[snap.thread.length - 1]?.text])

  const drafts = snap?.drafts ?? {}
  const draftKeys = Object.keys(drafts)
  useEffect(() => {
    if (draftKeys.length === 0) return undefined
    const guard = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [draftKeys.length > 0])

  // ---- readiness: the Gate check passes for the Artefact aimed for and every Field in scope is done ----
  const readiness = useMemo(
    () =>
      setup.status === 'ready' && snap && snap.phase !== 'kickoff'
        ? stageReadiness({ definition: definitionNow, structure: setup.structure, stageId: instance.stage.id, artefactId, size: instance.size, modules: instance.modules, drafts, openFields: snap.openFields ?? [] })
        : null,
    [setup, heldKey, instance.modules, instance.size, artefactId, snap?.drafts, snap?.openFields?.join('|'), snap?.phase]
  )
  const gate = draftKeys.length ? readiness?.gate ?? null : null

  const phase = snap?.phase ?? 'kickoff'
  // #290: opening the page on a Stage whose decisions log has entries is a resume: Start becomes Resume and the recap shows before it.
  const resumeNow = setup.status === 'ready' && phase === 'kickoff' ? ctxRef.current?.resume : null
  // #341: after Start this stage over the next start is a fresh interview (the session doesn't resume it), so the kickoff says Start interview.
  const resuming = resumeNow?.resuming && !snap?.startedOver ? resumeNow : null
  const started = phase !== 'kickoff' && phase !== 'testing'
  const busy = phase === 'working' || phase === 'testing'
  // #341: the one status line at the bottom of the thread, the whole time the AI is busy. While it waits for the first of an answer its
  // seconds count goes up, so the page is drawn again every second.
  const status = started ? statusLine(snap, Date.now()) : null
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!status?.ticking) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [status?.ticking, status?.kind])
  // #341: Start this stage over asks beside its button, and the question takes the focus, so the click shows where the architect is looking.
  const restartYes = useRef(null)
  useEffect(() => {
    if (confirmRestart) restartYes.current?.focus()
  }, [confirmRestart])
  // Once the interview has started the box has done its job, so the next kickoff (Start this stage over included) has it blank.
  useEffect(() => {
    if (started) setOpening('')
  }, [started])
  const finishing = snap?.finish === 'accepting' || snap?.finish === 'final'
  const stage = setup.status === 'ready' ? definitionNow.stages.find((s) => s.id === instance.stage.id) : null
  const readOnlyIds = new Set(stage?.readOnlyModules ?? [])
  const stageModules = stage ? stage.modules.map((id) => setup.definition.modules.find((m) => m.id === id)).filter((m) => m && !readOnlyIds.has(m.id)) : []

  // ---- the run (#293) ----
  const providerInUse = snap?.providerId ?? providerId
  const runStart = run?.startStageId ?? instance.stage.id // the Stage this run began on
  const multiStage = stagesList.findIndex((st) => st.id === target) > stagesList.findIndex((st) => st.id === runStart) // more than one Stage in the run
  const stageEndReady = !update && !review && phase === 'waiting' && draftKeys.length > 0 && Boolean(readiness?.ready) && !snap?.round && !finishing
  // #296: nothing draftable is left on a Stage drafted ahead, but Modules an earlier Stage also mounts are still held: the Waiting card offers
  // Check approval now or Stop here. Either saves the head start. A Stage whose every Module is held has nothing to draft at all, so the card
  // comes before the AI would start.
  const nothingDraftable = setup.status === 'ready' && ahead && held.length > 0 && fieldsInScope(definitionNow, instance.stage.id).size === 0
  const waitingNow =
    ahead &&
    held.length > 0 &&
    !stageEndReady &&
    saving?.phase !== 'drafting-ahead' &&
    ((phase === 'waiting' && !snap?.round && !finishing && Boolean(readiness) && readiness.allDone && !readiness.ready) || (phase === 'kickoff' && nothingDraftable))
  // Where the current Stage stands in the run plan.
  const settled = run && run.at === instance.stage.id && (run.phase === 'paused' || run.phase === 'done') ? run.phase : null
  let planCurrent = 'idle'
  if (saving?.phase === 'advancing') planCurrent = 'done'
  // #299: a revision is under way (the row says so), and once it is saved the Stage is back to awaiting approval.
  else if (saving?.phase === 'saved' && saving.revision) planCurrent = 'awaiting-approval'
  else if (revise && (started || phase === 'testing')) planCurrent = 'revising'
  else if (saving?.phase === 'saved' && saving.approval) planCurrent = saving.approval === 'queued' ? 'approval-queued' : 'awaiting-approval'
  else if (stageEndReady) planCurrent = 'awaiting-confirmation'
  else if (waitingNow || (headStart?.stopped && ahead && held.length > 0)) planCurrent = 'waiting-for-approval'
  else if (settled && draftKeys.length === 0) planCurrent = settled
  else if (started || phase === 'testing') planCurrent = ahead ? 'drafting-ahead' : 'drafting'
  const outOfDateByStage = outOfDateCountByStage(outOfDate)
  // #295: the Provider's word about the Pull Requests, which overrides the log's (a Stage with one open is awaiting approval; a later Stage the log queued shows Approval queued).
  const remoteRows = remote ? remoteRecord({ instance, stages: stagesList, logs: { ...stageLogs, [instance.stage.id]: committedLog } }) : null
  const planRowsNow = planRows({ stages: stagesList, currentStageId: instance.stage.id, targetStageId: target, current: planCurrent, remote: remoteRows, instanceStageId: instance.currentStageId }).map((row) => ({ ...row, outOfDate: outOfDateByStage[row.id] ?? 0, changedSinceApproval: remote ? changedMark(instance, row.id) : null }))
  // #300 (ADR-0069): the earlier documents the stage-end Save re-renders before it asks for approval, so the card says so.
  const earlierToRender = remote && setup.status === 'ready' ? earlierDocumentsToRender({ definition: setup.definition, instance, approved: approvedPrinted, draftKeys }) : []
  const newSinceIds = new Set(newSince.map((s) => s.id))
  // #298: the Out of date Fields this page can bring up to date, and where each change would land. A Stage counts as started (a branch exists, so
  // a Stage before it cannot be re-opened, ADR-0026) when it is the current Stage or later and has a Pull Request open or a decisions log that has saved.
  const startedStages = stagesList
    .filter(
      (st, at) =>
        at >= stagesList.findIndex((s) => s.id === instance.currentStageId) &&
        (remoteRows?.pullRequests?.[st.id] || (st.id === instance.currentStageId && (stageStarted ?? instance.stageBranchExists)) || logHasSaved(st.id === instance.stage.id ? committedLog : stageLogs[st.id]))
    )
    .map((st) => st.id)
  // #299: after a revision, the Fields of a Stage drafted ahead that were drafted from content the revision changed (found by fingerprint in the
  // decisions logs) get a keep / redraft round before the run carries on. Only Fields no pending Stage holds, and only on their own branch.
  const staleHere =
    setup.status === 'ready' && ahead && remote
      ? findOutOfDateFields({
          sources: [],
          logs: { ...setup.logs, [instance.stage.id]: committedLog },
          modules: [...instance.modules, ...otherSaved],
          stageModules: Object.fromEntries((setup.definition.stages ?? []).map((st) => [st.id, st.modules ?? []])),
        }).filter((flag) => flag.cause === 'field' && flag.stages.includes(instance.stage.id))
      : []
  const updatePlan =
    setup.status === 'ready' && staleHere.length
      ? planUpdateRound({ flags: staleHere, definition: definitionNow, pageStageId: instance.stage.id, currentStageId: instance.currentStageId, remote, staleLater: true, saved: [...instance.modules, ...otherSaved] })
      : setup.status === 'ready' && outOfDate.length && !ahead // a drafted-ahead branch is never changed by a Source document's change (ADR-0063): its flagged Fields wait until it is the current Stage
      ? planUpdateRound({
          flags: outOfDate,
          definition: definitionNow,
          pageStageId: instance.stage.id,
          currentStageId: instance.currentStageId,
          remote,
          awaiting: Object.keys(remoteRows?.pullRequests ?? {}),
          inProgress: startedStages,
          saved: [...instance.modules, ...otherSaved],
        })
      : null
  // The Stages that have something to bring up to date, in order, other than this one (a local or server workspace goes through them one by one).
  const currentAtIndex = stagesList.findIndex((st) => st.id === instance.currentStageId)
  const reopenList =
    remote && setup.status === 'ready' && !ahead
      ? stagesList.slice(0, Math.max(0, currentAtIndex)).map((st) => ({ id: st.id, title: st.title, ...reopenOffer({ stages: stagesList, currentStageId: instance.currentStageId, targetId: st.id, inProgress: startedStages }) }))
      : []
  const otherUpdateStages = setup.status === 'ready' && outOfDate.length ? stagesToUpdate({ flags: outOfDate, definition: setup.definition, remote, currentStageId: instance.currentStageId }).filter((st) => st.stageId !== instance.stage.id) : []
  // #303: the review comments of the kept Reviewed copies that this Stage can act on, where each change would land (the rules of Bring up to date), and the threads Word resolved.
  const reviewLabelMap = useMemo(() => reviewerLabels(reviewCopies ?? []), [reviewCopies])
  const reviewPlan =
    setup.status === 'ready' && reviewCopies
      ? planReview({
          copies: reviewCopies.filter((c) => !c.error),
          logs: { ...stageLogs, [instance.stage.id]: committedLog },
          reopened: reopenedThreads,
          definition: definitionNow,
          pageStageId: instance.stage.id,
          currentStageId: instance.currentStageId,
          remote,
          awaiting: Object.keys(remoteRows?.pullRequests ?? {}),
          inProgress: startedStages,
          saved: [...instance.modules, ...otherSaved],
        })
      : null
  const reviewContext = (mode) => ({
    mode,
    items: reviewPlan.items,
    deferred: reviewPlan.deferred,
    elsewhere: reviewPlan.elsewhere,
    labels: reviewLabelMap,
    fieldChoices: assignChoices(definitionNow, instance.stage.id),
    stageTitle: stageTitleOf,
    pageStageTitle: instance.stage.title,
  })
  // #294: tokens, from what each AI Provider reported. A Stage's total is every session's status line in its committed log, except this
  // session's own (it is counted in full from memory, so its older committed line is not added twice). The session total is this run:
  // the Stages it went through before this one (from their logs) and what this session has used on this one.
  const mineHere = snap?.tokens ?? EMPTY_TOKENS
  const stageTokens = (id) => (id === instance.stage.id ? addTokens(tokensOfLog(stageLogs[id], { exceptSession: snap?.decisions?.session }), mineHere) : tokensOfLog(stageLogs[id]))
  const currentAt = stagesList.findIndex((st) => st.id === instance.stage.id)
  const runStartAt = Math.max(0, Math.min(currentAt, stagesList.findIndex((st) => st.id === runStart)))
  const sessionTokens = stagesList.slice(runStartAt, currentAt).reduce((sum, st) => addTokens(sum, tokensOfLog(stageLogs[st.id])), mineHere)
  const thisStageTokens = stageTokens(instance.stage.id)
  const resume = resumeLogs && !carryingOn && !update && !review && phase === 'kickoff' ? resumableRun({ stages: stagesList, currentStageId: instance.stage.id, logs: resumeLogs, openPullRequests: remoteRows?.pullRequests ?? {} }) : null
  const stageTitleOf = (id) => stagesList.find((s) => s.id === id)?.title ?? id

  async function startInterview(options) {
    // #331: the opening message is what the architect typed; else, on a Stage of a run, the run's; else, resuming the session they paused, that session's.
    const words = opening.trim() || ((carryingOn || sameRun) && run.opening) || (startedOver.current ? '' : ctxRef.current?.resume?.adopt?.opening ?? '')
    // Bring up to date, a review round and a revision are not runs: they have no target Stage and never move the Instance on (#298, #303, #299).
    // A revision has no box: its round is the Owner's comments.
    if (update || review || revise) {
      await sessionRef.current?.start({ ...options, opening: revise ? '' : words })
      return
    }
    // A run of one Stage is still a run: its plan and its status block say where it stands. A Stage the run carried on into carries on the same run.
    if (carryingOn) updateRun(instance.slug, { carryOn: null, at: instance.stage.id })
    else beginRun(instance.slug, { target, startStageId: sameRun ? run.startStageId : instance.stage.id, providerId: providerInUse, at: instance.stage.id, opening: words, artefacts: { ...(sameRun ? run.artefacts : {}), ...runArtefactsNow } })
    await sessionRef.current?.start({ ...options, opening: words })
  }

  // #295: a session that opens on a Stage with a Pull Request already open runs Check status once, so what the Provider says (merged,
  // still waiting, sent back) overrides what the log last recorded. A page that was open when the request was made does not: it knows.
  const openedAwaiting = useRef(awaiting !== null)
  useEffect(() => {
    if (remote && openedAwaiting.current && !carryingOn && !revise && onCheckApproval) checkApproval({ carry: false })
  }, [])

  // The Stage before this one carried on into it: start the interview by itself, with the AI Provider the run was using.
  useEffect(() => {
    if (!carryingOn) return
    if (snap && snap.phase !== 'kickoff') {
      updateRun(instance.slug, { carryOn: null })
      return
    }
    // #295: the Stage was queued for approval, so its Pull Request opened as the one before it merged: it is already drafted and waiting for the Owner.
    if (remote && awaiting) {
      updateRun(instance.slug, { carryOn: null, at: instance.stage.id })
      return
    }
    if (autoStarted.current || setup.status !== 'ready' || sources === null || !snap || !providerId || blockedReason) return
    if (!flagsReady && !flagsWaited) return // a round about Out of date Fields may come first
    autoStarted.current = true
    startInterview()
  }, [carryingOn, setup.status, sources, snap?.phase, providerId, flagsReady, flagsWaited])

  // Start waits for the Out of date check, which is quick, but never for long: it is only there to know whether a round of cards opens the interview (#298).
  useEffect(() => {
    if (flagsReady) return undefined
    const timer = setTimeout(() => setFlagsWaited(true), 4000)
    return () => clearTimeout(timer)
  }, [flagsReady])

  // #296: the earlier Stage this one was drafted ahead of has merged (Check approval now found it): the Modules it held are open, so the AI is told.
  useEffect(() => {
    if (!started) {
      lastHeld.current = { key: heldKey, list: held }
      return
    }
    if (lastHeld.current.key === heldKey || phase !== 'waiting') return
    const nowHeld = new Set(held.map((h) => h.id))
    const opened = lastHeld.current.list.filter((h) => !nowHeld.has(h.id))
    lastHeld.current = { key: heldKey, list: held }
    if (opened.length === 0 || !sessionRef.current) return
    const titleOf = (id) => setup.definition.modules.find((m) => m.id === id)?.title ?? id
    const stageTitle = [...new Set(opened.map((h) => h.stageTitle))].join(' and ')
    sessionRef.current.modulesOpened({ modules: opened.map((h) => ({ id: h.id, title: titleOf(h.id) })), stageTitle })
  }, [heldKey, phase, started])

  // "Resume the run" on a kickoff whose logs say a run was left part-way.
  async function resumeRun() {
    setResumeMessage('')
    if (!resume) return
    if (!providerId) {
      setResumeMessage('Choose an AI Provider, or connect one.')
      return
    }
    setPickedTarget(resume.targetStageId)
    // #331: the run carries on with the opening message it was started with, unless the architect typed a new one here.
    const words = opening.trim() || runOpening(resumeLogs?.[resume.fromStageId])
    // #332: and with the Artefact it chose for each Stage, unless the architect chose another here (the kickoff is between sessions).
    const artefacts = resumedArtefacts({ definition: setup.definition, stages: stagesList, currentStageId: instance.stage.id, targetStageId: resume.targetStageId, picked: pickedArtefacts, log: resumeLogs?.[resume.fromStageId], fromStageId: resume.fromStageId })
    if (resume.mode === 'advance' && remote) {
      // #295: a remote Stage was saved but its approval never asked for (Save and stop here, or the request failed): resuming asks for it, then the session waits for the Owner.
      const startStageId = runStartStage(stagesList, resumeLogs?.[resume.fromStageId], resume.fromStageId)
      beginRun(instance.slug, { target: resume.targetStageId, startStageId, providerId, at: instance.stage.id, opening: words, artefacts })
      const asked = await requestApproval()
      if (!asked.ok) setResumeMessage(asked.message)
      else if (resume.targetStageId !== instance.stage.id && followingStage) await draftAhead({ phase: 'saved', approval: 'requested' }) // and the session drafts ahead while the Owner reviews (#296)
      return
    }
    const follow = resume.mode === 'advance' ? followingStage : null
    if (resume.mode === 'advance' && !follow) {
      setResumeMessage('There is no next Stage to carry on with.')
      return
    }
    const startStageId = runStartStage(stagesList, resumeLogs?.[resume.fromStageId], resume.fromStageId)
    beginRun(instance.slug, { target: resume.targetStageId, startStageId, providerId, at: instance.stage.id, carryOn: follow ? follow.id : instance.stage.id, opening: words, artefacts })
    if (follow) {
      const result = await onAdvance()
      if (!result.ok) {
        updateRun(instance.slug, { carryOn: null })
        setResumeMessage(result.message || 'The Stage could not be advanced.')
      }
    }
  }

  async function sendChat() {
    const text = chat.trim()
    if (!text || busy || !started) return
    setChat('')
    await sessionRef.current?.send(text)
  }

  async function switchProvider(id) {
    setSwitchMessage('')
    setPickedProvider(id)
    const result = await sessionRef.current?.setProvider(id)
    if (result && !result.ok) {
      setSwitchMessage(result.message)
      setPickedProvider(snap?.providerId ?? null)
    }
  }

  const [submitMessage, setSubmitMessage] = useState('')
  async function submitRound() {
    setSubmitMessage('')
    const result = await sessionRef.current?.submitRound()
    if (result && !result.ok) setSubmitMessage(result.message)
  }
  async function finishNow() {
    setSubmitMessage('')
    const result = await sessionRef.current?.finishWithRecommendations()
    if (result && !result.ok && result.message) setSubmitMessage(result.message)
  }
  // #329: Compact now, on the card or in the rail's Tokens block. With a round open it waits for the round (the session says so).
  const compactNow = () => sessionRef.current?.compactNow()
  function openHandEdit(fieldKey) {
    const result = sessionRef.current?.beginHandEdit(fieldKey)
    if (result?.ok) setHandEditing({ key: fieldKey, error: '' })
  }
  function closeHandEdit(fieldKey) {
    sessionRef.current?.cancelHandEdit(fieldKey)
    setHandEditing(null)
  }
  function finishHandEdit(fieldKey, text) {
    const result = sessionRef.current?.handEdit(fieldKey, text)
    if (result?.ok) setHandEditing(null)
    else setHandEditing({ key: fieldKey, error: result?.message ?? 'That edit could not be kept.' })
  }
  const fieldTitle = (key) => {
    const [moduleId, ...rest] = String(key).split('.')
    const mod = setup.status === 'ready' ? setup.definition.modules.find((m) => m.id === moduleId) : null
    const field = mod?.fields?.find((f) => f.id === rest.join('.'))
    return mod && field ? `${mod.title ?? mod.id} · ${field.title ?? field.id}` : key
  }

  // One Save of the session: the drafts and the decisions log in a single stage Save, through the Save check (ADR-0068). A Field both
  // sides changed comes back here as a round of clash cards (#290). `action` is the stage-end card's "advance" (Save, advance, carry on) or
  // "stop" (Save and stop here, #293); both make the one stage Save, and "advance" then moves the Instance on so the next Stage's interview
  // starts by itself. `pause` is Pause (#290): the same Save, asked for by the architect mid-Stage, which leaves the session to be resumed.
  // The status block of the decisions log, written in the same Save, records the run's target and each Stage's state. Resolves true when
  // the Save worked.
  async function runSave({ action = 'stop', pause = false } = {}) {
    setSaving({ phase: 'saving', pause })
    const keys = Object.keys(drafts)
    // #300: what the card said the Save would re-render; once the drafts are saved the page can no longer work it out from them.
    const willReRender = action === 'approval' && !pause && earlierToRender.length > 0
    // #295: a Stage that isn't the Instance's current one can't ask for approval yet (Request approval refuses it), so it is queued.
    const queued = remote && action === 'approval' && instance.stage.id !== instance.currentStageId
    const outcome = saveOutcome({ stages: stagesList, currentStageId: instance.stage.id, targetStageId: target, startStageId: runStart, action, queued, instanceStageId: instance.currentStageId })
    // #288: the decisions log goes in the same Save as the content.
    // A Pause is not the end of the Stage: the status line says `paused` and the Stage stays "in-progress" in the run's map, so a paused
    // session is not mistaken for a run that stopped after finishing the Stage (web/lib/interviewRun.js `resumableRun`).
    const runState = pause ? 'paused' : outcome.state
    const runStages = pause ? { ...outcome.stages, [instance.stage.id]: 'in-progress' } : outcome.stages
    const decisions = sessionRef.current?.decisionsDelta({ runState, saving: true, target, stages: runStages }) ?? null
    let result
    try {
      result = await onSaveDrafts(drafts, { artefactId, decisions, settleClashes: (conflicts) => sessionRef.current.settleClashes(conflicts) })
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (result.ok) {
      if (keys.length) sessionRef.current?.markSaved(keys)
      if (decisions) {
        sessionRef.current?.commitDecisions(result.decisions ?? decisions)
        const fresh = await decisionsStore?.read(instance.stage.id).catch(() => null)
        if (fresh) {
          setCommittedLog(fresh)
          setStageLogs((logs) => ({ ...logs, [instance.stage.id]: fresh }))
          sessionRef.current?.loadDecisions(fresh)
        }
      }
      workingCopies.clear(sessionKey) // everything the working copy held is saved
      // #298: a Module marked agreed that this Save changed is back to draft; the log kept why, and the card says so.
      const returned = (decisions?.entries ?? []).filter((e) => e.kind === 'returned-to-draft')
      if (pause) {
        sessionRef.current?.markPaused()
        updateRun(instance.slug, { phase: 'paused', at: instance.stage.id })
        setSaving({ phase: 'paused', fields: keys.length, returned })
        return true
      }
      if (action === 'head-start') {
        // #296: the head start of a Stage drafted ahead is saved (one commit on this Stage's branch, its decisions log in it). The Stage is not
        // finished: it gets its full Save later, when it is ready.
        setSaving(null)
        setHeadStart((was) => ({ fields: (was?.fields ?? 0) + keys.length, stopped: false }))
        return true
      }
      updateRun(instance.slug, { phase: outcome.finished ? 'done' : outcome.advances || outcome.requestsApproval ? 'running' : 'paused', at: instance.stage.id })
      const saved = { phase: 'saved', check: result.check ?? null, finished: outcome.finished, approval: outcome.requestsApproval ? (queued ? 'queued' : 'requested') : null, willReRender, returned }
      setSaving(saved)
      if (outcome.advances) await carryOn(saved)
      else if (outcome.requestsApproval && !queued) {
        // The content and its log are saved; now the Pull Request (after the earlier documents the card named are re-rendered). A refusal leaves the Save as it is and says why, with a button to ask again.
        const asked = await requestApproval({ reRender: willReRender })
        if (!asked.ok) setSaving({ ...saved, approvalError: asked.message })
        else if (!outcome.finished) await draftAhead(saved)
      } else if (outcome.requestsApproval && queued && !outcome.finished) {
        await draftAhead(saved)
      }
      return true
    }
    // The Save did not happen, so the choices made on clash cards for it are taken back.
    if (result.settledIds?.length) sessionRef.current?.discardEntries(result.settledIds)
    setSaving({ phase: 'error', message: result.message || 'The Save did not go through.', pause: runState === 'paused' })
    return false
  }
  const saveStage = (action = 'stop') => runSave({ action })
  const pauseInterview = () => runSave({ pause: true })

  // Saves what Bring up to date settled (#298): the answers in the decisions log, with any re-cited or redrafted Fields, as one stage Save through
  // the Save check. It is not the end of a Stage: no run, no advance, no request for approval. The session's status line is written only when the
  // AI was used (its tokens are kept there); an answer that needed no AI leaves the Stage's status exactly as it was.
  async function saveUpdate(kind = 'source-update') {
    setSaving({ phase: 'saving' })
    const keys = Object.keys(drafts)
    const usedAi = hasTokens(snap?.tokens ?? EMPTY_TOKENS)
    // A Stage that is awaiting approval, queued for it or holding a head start keeps that status: bringing a Field up to date must not make it look finished (#299).
    const before = Array.isArray(committedLog?.status) && committedLog.status.length ? committedLog.status[committedLog.status.length - 1] : null
    const keepsState = ['approval-queued', 'awaiting-approval', 'head-start'].includes(before?.state)
    const delta = keepsState
      ? sessionRef.current?.decisionsDelta({ runState: before.state, saving: usedAi, target: before.target ?? instance.stage.id, stages: before.stages ?? { [instance.stage.id]: before.state } }) ?? null
      : sessionRef.current?.decisionsDelta({ runState: 'done', saving: usedAi, target: instance.stage.id, stages: { [instance.stage.id]: 'done' } }) ?? null
    const decisions = delta && !usedAi ? { ...delta, status: undefined } : delta
    // Every Field was left flagged: nothing was answered, so there is nothing to write (and no empty log file or commit to make).
    if (keys.length === 0 && (decisions?.entries ?? []).length === 0) {
      setSaving({ phase: 'saved', update: true, fields: 0, answers: 0, returned: [] })
      return true
    }
    let result
    try {
      result = await onSaveDrafts(drafts, { artefactId, decisions, settleClashes: (conflicts) => sessionRef.current.settleClashes(conflicts) })
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (!result.ok) {
      if (result.settledIds?.length) sessionRef.current?.discardEntries(result.settledIds)
      setSaving({ phase: 'error', message: result.message || 'The Save did not go through.' })
      return false
    }
    if (keys.length) sessionRef.current?.markSaved(keys)
    if (decisions) {
      sessionRef.current?.commitDecisions(result.decisions ?? decisions)
      const fresh = await decisionsStore?.read(instance.stage.id).catch(() => null)
      if (fresh) {
        setCommittedLog(fresh)
        setStageLogs((logs) => ({ ...logs, [instance.stage.id]: fresh }))
        sessionRef.current?.loadDecisions(fresh)
      }
    }
    workingCopies.clear(sessionKey)
    const returned = (decisions?.entries ?? []).filter((e) => e.kind === 'returned-to-draft')
    setSaving({ phase: 'saved', update: true, fields: keys.length, answers: (decisions?.entries ?? []).filter((e) => e.kind === kind).length, returned })
    return true
  }

  // #299: saves the revision of a Stage the Owner sent back: the drafts and the decisions log (with each comment answered) as one stage Save on the
  // Stage's own branch, which updates its open Pull Request. It asks for nothing and writes nothing to the Pull Request; the Stage goes back to awaiting approval.
  async function saveRevision() {
    setSaving({ phase: 'saving', revision: true })
    const keys = Object.keys(drafts)
    const before = Array.isArray(committedLog?.status) && committedLog.status.length ? committedLog.status[committedLog.status.length - 1] : null
    const decisions =
      sessionRef.current?.decisionsDelta({ runState: 'awaiting-approval', saving: true, target: before?.target ?? instance.stage.id, stages: { ...(before?.stages ?? {}), [instance.stage.id]: 'awaiting-approval' } }) ?? null
    let result
    try {
      result = await onSaveDrafts(drafts, { artefactId, decisions, settleClashes: (conflicts) => sessionRef.current.settleClashes(conflicts) })
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (!result.ok) {
      if (result.settledIds?.length) sessionRef.current?.discardEntries(result.settledIds)
      setSaving({ phase: 'error', revision: true, message: result.message || 'The Save did not go through.' })
      return false
    }
    if (keys.length) sessionRef.current?.markSaved(keys)
    if (decisions) {
      sessionRef.current?.commitDecisions(result.decisions ?? decisions)
      const fresh = await decisionsStore?.read(instance.stage.id).catch(() => null)
      if (fresh) {
        setCommittedLog(fresh)
        setStageLogs((logs) => ({ ...logs, [instance.stage.id]: fresh }))
        sessionRef.current?.loadDecisions(fresh)
      }
    }
    workingCopies.clear(sessionKey)
    const returned = (decisions?.entries ?? []).filter((e) => e.kind === 'returned-to-draft')
    setSaving({ phase: 'saved', revision: true, check: result.check ?? null, fields: keys.length, answers: (decisions?.entries ?? []).filter((e) => e.kind === 'pr-comment-answered').length, returned })
    return true
  }

  // Drafting ahead is paused (#299): whatever the AI drafted ahead on this Stage is kept, as a head start saved on its branch, before the session
  // goes back to revise the Stage the Owner sent back, or stops.
  async function keepDraftedAhead() {
    if (!ahead || Object.keys(drafts).length === 0) return true
    return runSave({ action: 'head-start' })
  }
  async function reviseSentBack() {
    if (!sentBack || !onReviseStage) return
    if (!(await keepDraftedAhead())) return
    onReviseStage(sentBack.stageId)
  }
  async function stopSession() {
    if (!(await keepDraftedAhead())) return
    updateRun(instance.slug, { phase: 'paused', at: instance.stage.id })
    setSentBack((was) => (was ? { ...was, stopped: true } : was))
  }

  const [reopening, setReopening] = useState({ stageId: null, message: '' })
  // #299: the architect chose the AI's offer to re-open a signed-off Stage. The re-opened Stage joins the run, and the page for it starts by itself;
  // its decisions log carries on in the same file. This tab's old session for that Stage is dropped, since the Stage is open again.
  const reopenHandled = useRef(null)
  async function reopenForRun(stageId) {
    setReopening({ stageId, message: '' })
    sessions.delete(`${instance.slug}|${stageId}`)
    workingCopies.clear(`${instance.slug}|${stageId}`)
    if (run) updateRun(instance.slug, { carryOn: stageId, phase: 'running', providerId: providerInUse, at: stageId, startStageId: stageId, reopened: stageId })
    else beginRun(instance.slug, { target, startStageId: stageId, providerId: providerInUse, at: stageId, carryOn: stageId, reopened: stageId, opening: snap?.opening ?? '', artefacts: runArtefactsNow })
    let result
    try {
      result = await onReopenStage(stageId)
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (!result?.ok) updateRun(instance.slug, { carryOn: null })
    setReopening({ stageId: null, message: result?.ok ? '' : result?.message || 'The Stage could not be re-opened.' })
  }
  useEffect(() => {
    const request = snap?.reopenRequest
    if (!request || !onReopenStage || reopenHandled.current === request.stageId) return
    reopenHandled.current = request.stageId
    reopenForRun(request.stageId)
  }, [snap?.reopenRequest?.stageId])
  async function reopen(stageId) {
    setReopening({ stageId, message: '' })
    let result
    try {
      result = await onReopenStage(stageId)
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    // A re-open that worked replaces this page with the one for the re-opened Stage.
    setReopening({ stageId: null, message: result?.ok ? '' : result?.message || 'The Stage could not be re-opened.' })
  }

  // Opens the page afresh from the saved log and content, as it would be in any browser (#290).
  function resumeAfterPause() {
    sessions.delete(sessionKey)
    workingCopies.clear(sessionKey)
    sessionRef.current = null
    setSnap(null)
    setSaving(null)
    setSubmitMessage('')
    setGeneration((n) => n + 1)
  }

  // #295: asks for the Stage's approval (a Pull Request into main) and waits for it. The AI never passes a gate and has no part in Request
  // Review: only this click, after a Save, asks; only a person's approval on the Provider lets the Stage move on. Resolves the result.
  //
  // `reRender` (#300, ADR-0069): the stage-end card said the Save re-renders the earlier approved documents this Stage's changes touch. Request
  // approval names those it will not go ahead without; each is rendered onto this Stage's branch (the approved copy is kept in out/approved/)
  // and approval is asked for again, so the Pull Request opens with the re-rendered documents already in it. Without `reRender` the refusal is
  // shown as it is, for the architect to render from the editor.
  async function requestApproval({ reRender = false } = {}) {
    setApproval({ phase: 'requesting', message: '' })
    let result
    const rendered = []
    try {
      result = await onRequestApproval()
      if (!result.ok && reRender && result.reRenderRequired?.length && onReRenderEarlier) {
        let failure = null
        for (const item of result.reRenderRequired) {
          setApproval({ phase: 'requesting', message: `Re-rendering ${item.artefactTitle} (${item.stageTitle}) onto this Stage…` })
          const done = await onReRenderEarlier(item)
          if (!done?.ok) {
            failure = { ok: false, message: done?.message || `${item.artefactTitle} could not be re-rendered.` }
            break
          }
          rendered.push(item)
        }
        if (failure) result = failure
        else {
          setApproval({ phase: 'requesting', message: '' })
          result = await onRequestApproval()
        }
      }
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (result.ok) {
      setSaving((was) => (was ? { ...was, approvalError: '', reRendered: rendered.map((r) => r.artefactTitle), reRenderedStages: rendered.map((r) => r.stageTitle) } : was))
      setApproval({ phase: 'idle', message: `Approval requested: Pull Request #${result.pullRequestId}.${rendered.length ? ` Re-rendered ${rendered.map((r) => r.artefactTitle).join(', ')} first, so it is re-approved with this Stage.` : ''}` })
    } else {
      setApproval({ phase: 'idle', message: '' })
      setSaving((was) => (was?.phase === 'saved' ? { ...was, approvalError: result.message || 'Approval could not be requested.' } : was))
    }
    return result
  }

  // Check status (#295): the one way the session learns the Owner has approved. It runs when the architect clicks an "awaiting approval"
  // row or the Check status button, and once when a session opens on a Stage that has a Pull Request. When the Pull Request has merged the
  // Instance moves on and, if this run goes on, the page of the next Stage starts by itself (the same carry-on as a local run); otherwise
  // it says what the Owner has done.
  async function checkApproval({ carry = true } = {}) {
    if (approval.phase === 'checking') return
    setApproval({ phase: 'checking', message: '' })
    // Asking is consent to carry on: if the Owner has approved, the next Stage starts by itself. The Check status that runs as a session
    // opens (`carry: false`) only finds out; it does not spend the AI's time until the architect resumes.
    // A page drafting ahead stays where it is when the earlier Stage merges: the held Modules open and the AI carries on with them (#296).
    const carries = carry && !ahead && target !== instance.stage.id && Boolean(followingStage) && Boolean(providerInUse)
    if (carries) {
      if (run) updateRun(instance.slug, { carryOn: followingStage.id, phase: 'running', providerId: providerInUse })
      else beginRun(instance.slug, { target, startStageId: instance.stage.id, providerId: providerInUse, at: instance.stage.id, carryOn: followingStage.id, opening: snap?.opening ?? '', artefacts: runArtefactsNow })
    }
    let result
    try {
      result = await onCheckApproval()
    } catch (err) {
      result = { ok: false, merged: false, message: err.message }
    }
    // #299: the Owner sent the Stage back (changes requested) or rejected it. Drafting ahead pauses: a turn the AI is in the middle of is stopped, and
    // one card asks to revise the Stage with the AI or to stop the session. Whatever was drafted ahead is kept either way.
    setSentBack(result.sentBack ?? null)
    if (result.sentBack && ahead && sessionRef.current && snap?.phase === 'working') sessionRef.current.cancel()
    if (!result.merged) {
      if (carries) updateRun(instance.slug, { carryOn: null })
      setApproval({ phase: 'idle', message: result.message || '' })
    } else if (ahead) {
      setApproval({ phase: 'idle', message: result.message || '' })
    }
    return result
  }

  // Moves the run on to the next Stage, which has been saved. The page for that Stage replaces this one and starts by itself;
  // if the Instance can't be advanced (the Gate no longer passes, say), the run stays paused here and the card says why.
  async function carryOn(saved = saving) {
    if (!followingStage) return
    setSaving({ ...saved, phase: 'advancing', advanceError: '' })
    updateRun(instance.slug, { carryOn: followingStage.id, phase: 'running', providerId: providerInUse })
    let result
    try {
      result = await onAdvance()
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (!result?.ok) {
      updateRun(instance.slug, { carryOn: null, phase: 'paused', at: instance.stage.id })
      setSaving({ ...saved, phase: 'saved', advanceError: result?.message || 'The Stage could not be advanced.' })
    }
  }

  // #296 (docs/adr/0063): the Stage is saved and its approval asked for (or queued), so the session moves on to the next Stage of the run
  // while the Owner reviews: the Instance stays where it is and the page for the next Stage replaces this one and starts by itself. If the
  // page can't move on, the run stays here and the card says why.
  async function draftAhead(saved = saving) {
    if (!followingStage || !onDraftAhead) return
    setSaving({ ...saved, phase: 'drafting-ahead', advanceError: '' })
    if (run) updateRun(instance.slug, { carryOn: followingStage.id, phase: 'running', providerId: providerInUse })
    else beginRun(instance.slug, { target, startStageId: instance.stage.id, providerId: providerInUse, at: instance.stage.id, carryOn: followingStage.id, opening: snap?.opening ?? '', artefacts: runArtefactsNow })
    let result
    try {
      result = await onDraftAhead(followingStage.id)
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (!result?.ok) {
      updateRun(instance.slug, { carryOn: null, phase: 'paused', at: instance.stage.id })
      setSaving({ ...saved, phase: 'saved', advanceError: result?.message || 'The next Stage could not be opened.' })
    }
  }

  // The Waiting card (#296). Either button saves the head start first (one commit on this Stage's branch), if there is anything unsaved.
  // "Check approval now" then runs Check status and, if the earlier Stage merged, the held Modules open and the AI carries on with them;
  // "Stop here" ends the session. The Stage gets its full Save later, when it is ready.
  async function waitingAction(kind) {
    if (Object.keys(drafts).length) {
      const saved = await runSave({ action: 'head-start' })
      if (!saved) return
    }
    if (kind === 'stop') {
      updateRun(instance.slug, { phase: 'paused', at: instance.stage.id })
      setHeadStart((was) => ({ fields: was?.fields ?? 0, stopped: true }))
      return
    }
    await checkApproval({ carry: false })
  }

  // ---------- pieces ----------
  // #332: "Artefact for each Stage", under Run until: one row per Stage of the run, each with the Artefacts that can pass its Gate. The rows always
  // show, so it is clear what the AI drafts towards; a row with nothing to choose is ghosted.
  const artefactBlock = () => html`<fieldset class="kick-artefacts" data-testid="interview-artefacts">
    <legend>Artefact for each Stage</legend>
    ${stageArtefacts.map((row) => {
      const only = row.candidates.length === 1
      const none = row.candidates.length === 0
      const why = none ? 'No Artefact passes this Gate' : only ? 'Only one Artefact can pass this Gate' : undefined
      return html`<div key=${row.id} class="kick-artefact-row" data-testid="interview-artefact-row" data-stage-id=${row.id}>
        <label for=${`interview-artefact-${row.id}`}>${row.title} (gate: ${row.gate})</label>
        <select
          id=${`interview-artefact-${row.id}`}
          data-testid="interview-artefact"
          data-stage-id=${row.id}
          disabled=${only || none || phase === 'testing'}
          title=${why}
          onChange=${(e) => {
            const value = e.currentTarget.value
            setPickedArtefacts((was) => ({ ...was, [row.id]: value }))
          }}
        >
          ${none
            ? html`<option value="">No Artefact passes this Gate</option>`
            : row.candidates.map((a) => html`<option key=${a.id} value=${a.id} selected=${a.id === row.chosen?.id}>${a.title ?? a.id}${row.candidates.length > 1 && a.id === row.lightest?.id ? ' (lightest)' : ''}</option>`)}
        </select>
      </div>`
    })}
    <p class="kick-note" data-testid="interview-artefacts-note">The AI drafts what the Artefact chosen for each Stage requires. Where more than one can pass a Gate, the lightest is pre-selected.</p>
  </fieldset>`

  // Before Start: which Source documents this AI Provider can't read, so the architect can choose another (#292).
  const unreadableNote = () => {
    if (!provider?.test || !sources) return null // an untested AI Provider is tested on Start, and only then is it known what it reads
    const plan = planSourceAccess({ sources, provider })
    const lost = (sources ?? []).filter((s) => !s.removedAt && plan.get(s.id)?.how === 'unreadable')
    if (lost.length === 0) return null
    return html`<div class="warn" role="status" data-testid="interview-kickoff-unreadable">
      ${provider.model || 'This model'} can't read ${lost.length === 1 ? 'one Source document' : `${lost.length} Source documents`}: ${lost.map((s) => `${s.title} (${plan.get(s.id).reason})`).join('; ')}. The AI is told so and won't rely on ${lost.length === 1 ? 'it' : 'them'}. Choose an AI Provider that can, or carry on without.
    </div>`
  }

  // Bring up to date (#298): what this Stage has, what waits for another Stage, and what is left flagged on purpose.
  const updateKickoffExtras = () => {
    if (setup.status !== 'ready') return null
    const here = updatePlan?.items.length ?? 0
    const next = otherUpdateStages[0] ?? null
    return html`<div data-testid="interview-update-plan">
      ${here
        ? html`<p class="kick-note" data-testid="interview-update-count"><strong>${here} Field${here === 1 ? '' : 's'}</strong> on ${instance.stage.title} ${here === 1 ? 'is' : 'are'} Out of date.</p>`
        : html`<p class="kick-note" data-testid="interview-update-none">Nothing on ${instance.stage.title} is Out of date.</p>`}
      ${updateDeferredNote()}
      ${next && !remote
        ? html`<p class="kick-note" data-testid="interview-update-next">
            ${next.count} Field${next.count === 1 ? '' : 's'} on ${stageTitleOf(next.stageId)} ${next.count === 1 ? 'is' : 'are'} Out of date too.
            <button type="button" class="btn small ghost" data-testid="interview-update-goto" disabled=${!onOpenStage} onClick=${() => onOpenStage?.(next.stageId)}>${here ? `Go to ${stageTitleOf(next.stageId)} first` : `Go to ${stageTitleOf(next.stageId)}`}</button>
          </p>`
        : null}
    </div>`
  }

  // Review comments (#303): what this Stage has, what waits for another Stage, and what stays unanswered on a drafted-ahead Stage.
  const reviewKickoffExtras = () => {
    if (setup.status !== 'ready') return null
    const here = reviewPlan?.items.length ?? 0
    const next = reviewPlan?.stages?.[0] ?? null
    return html`<div data-testid="interview-review-plan">
      ${reviewCopies === null
        ? html`<p class="kick-note" data-testid="interview-review-loading">Reading the Reviewed copies…</p>`
        : here
          ? html`<p class="kick-note" data-testid="interview-review-count"><strong>${here} review ${here === 1 ? 'question' : 'questions'}</strong> on ${instance.stage.title}.</p>`
          : html`<p class="kick-note" data-testid="interview-review-none">No review comment waits on ${instance.stage.title}.</p>`}
      ${reviewPlan?.deferred?.length
        ? html`<p class="kick-note" data-testid="interview-review-deferred">${reviewPlan.deferred.length} review ${reviewPlan.deferred.length === 1 ? 'comment' : 'comments'} on a drafted-ahead Stage stay unanswered: a drafted-ahead branch is never changed. Ask ${reviewPlan.deferred.length === 1 ? 'it' : 'them'} once that Stage is the current one.</p>`
        : null}
      ${next && !remote
        ? html`<p class="kick-note" data-testid="interview-review-next">
            ${next.count} more on ${stageTitleOf(next.stageId)}.
            <button type="button" class="btn small ghost" data-testid="interview-review-goto" disabled=${!onOpenStage} onClick=${() => onOpenStage?.(next.stageId)}>${here ? `Go to ${stageTitleOf(next.stageId)} first` : `Go to ${stageTitleOf(next.stageId)}`}</button>
          </p>`
        : null}
    </div>`
  }

  function toggleJoinWanted(on) {
    if (on) reviewJoinWanted.add(instance.slug)
    else reviewJoinWanted.delete(instance.slug)
    setJoinWanted(on)
  }

  // The review questions join the interview that is going: the open round, a round of their own, or the next one (the session decides).
  function joinReviewNow() {
    setReviewMessage('')
    if (phase === 'paused' || !started) {
      toggleJoinWanted(true)
      return
    }
    const result = sessionRef.current?.joinReview(reviewContext('join'))
    if (result && !result.ok) setReviewMessage(result.message || 'The review questions could not be added.')
  }

  // Fields of a drafted-ahead Stage are left flagged and never written (ADR-0063).
  const updateDeferredNote = () => {
    const deferred = snap?.update?.deferred ?? updatePlan?.deferred ?? []
    if (!deferred.length) return null
    const stageIds = [...new Set(deferred.map((d) => d.stageId))]
    return html`<p class="kick-note" data-testid="interview-update-deferred">
      ${deferred.length} Field${deferred.length === 1 ? '' : 's'} on ${stageIds.map(stageTitleOf).join(', ')} stay${deferred.length === 1 ? 's' : ''} flagged: ${stageIds.length === 1 ? 'that Stage is' : 'those Stages are'} drafted ahead, and a drafted-ahead branch is never changed. Bring ${deferred.length === 1 ? 'it' : 'them'} up to date once ${stageIds.length === 1 ? 'it is' : 'they are'} the current Stage.
    </p>`
  }

  // #304 (ADR-0066): the Review response list, built on demand from the Stages' committed decisions logs. Gantry never writes it anywhere: it is a download.
  const responseLogs = { ...stageLogs, [instance.stage.id]: committedLog }
  const responseList = reviewResponseRows(responseLogs, { fieldTitle: (key) => fieldLabel(setup.definition, key), stageTitle: stageTitleOf })
  const downloadResponseList = () => downloadReviewResponseList(responseLogs, { instanceName: instance.name || instance.slug, fieldTitle: (key) => fieldLabel(setup.definition, key), stageTitle: stageTitleOf })
  // The documents the answered comments were made on: the ones to render again for the commenters to see the changes (a Save never renders, ADR-0034).
  const answeredNow = answeredCounts(responseLogs)
  const toRenderAgain = [...new Set((reviewCopies ?? []).filter(({ entry }) => answeredNow[entry.id] > 0).map(({ entry }) => (instance.artefacts ?? []).find((a) => a.id === entry.artefact)?.title ?? entry.artefact))]

  // The rail's Review comments panel (#303).
  const reviewRail = () => {
    const running = started && phase !== 'paused'
    const queued = snap?.queuedReview ?? 0
    return html`<${ReviewSection}
      copies=${reviewCopies}
      plan=${reviewPlan}
      running=${running}
      paused=${phase === 'paused'}
      joined=${queued > 0 || (phase === 'paused' && joinWanted) || (snap?.review?.mode === 'join' && !snap?.review?.answered && Boolean(snap?.round?.cards?.some((c) => c.type === 'review')))}
      blocked=${Boolean(blockedReason)}
      reviewPage=${review}
      canOpen=${Boolean(onOpenReview)}
      pageStageTitle=${instance.stage.title}
      error=${reviewMessage}
      stageTitleOf=${stageTitleOf}
      onOpenStage=${onOpenStage}
      onBringIn=${() => onBringInReview?.()}
      onWorkThrough=${() => onOpenReview?.()}
      onJoin=${joinReviewNow}
      onReopen=${(threadKey) => setReopenedThreads((was) => new Set([...was, threadKey]))}
      responseCount=${responseList.rows.length}
      onDownloadResponse=${downloadResponseList}
    />`
  }

  const kickoff = () => {
    const status = provider?.test?.status
    const sourceCount = (sources ?? []).filter((s) => !s.removedAt).length
    // A run that carried on into this Stage starts it by itself: the form only comes back if that start fails.
    if (carryingOn && !snap?.kickoffError) {
      return html`<div class="kick" data-testid="interview-kickoff">
        <p class="kick-intro" data-testid="interview-carrying-on" role="status">Carrying on the run to ${stageTitleOf(target)}: starting ${instance.stage.title}…</p>
      </div>`
    }
    return html`
      <div class="kick" data-testid="interview-kickoff">
        ${review
          ? html`<p class="kick-intro" data-testid="interview-review-intro">
              <strong>Review comments.</strong> Reviewers commented on a Word document Gantry rendered. You get one card for each comment thread, and for each reviewer's tracked changes in a Field.
              Nothing is applied automatically, and nothing is saved until you save the round.
            </p>`
          : revise
          ? html`<p class="kick-intro" data-testid="interview-revise-intro">
              <strong>Revise ${instance.stage.title}.</strong> The Owner sent it back from its Pull Request. Gantry reads every comment on it, resolved ones included, lists them here and asks you one card for each,
              before the AI is called. The AI only redrafts what you choose to change, and saved content changes only through keep / use the AI's version / merge. Nothing is written to the Pull Request.
            </p>
            ${prComments.status === 'loading'
              ? html`<p class="kick-note" data-testid="interview-revise-loading">Reading the comments on the Pull Request…</p>`
              : prComments.status === 'error'
                ? html`<p class="inline-error" role="alert" data-testid="interview-revise-error">${prComments.message}</p>`
                : html`<p class="kick-note" data-testid="interview-revise-count">${prComments.list.length ? `${prComments.list.length} comment${prComments.list.length === 1 ? '' : 's'} on Pull Request #${prComments.pullRequestId}.` : `Pull Request #${prComments.pullRequestId} has no comment to read. The AI asks you what the Owner wants changed.`}</p>`}`
          : update
          ? html`<p class="kick-intro" data-testid="interview-update-intro">
              <strong>Bring up to date.</strong> Some Fields drew on a Source document that has since changed. You get one card for each of them, ${instance.stage.title} first
              and the other Stages in order. Only answering a card clears its flag, and nothing is saved until you save the round.
            </p>`
          : html`<p class="kick-intro">
              The AI reads this Instance's Source documents, drafts the Fields they support, then talks them through with you. Nothing is saved
              until you confirm the Stage, and it never passes a Gate that needs approval or review.
            </p>`}
        ${review ? reviewKickoffExtras() : null}
        ${!update && !review && !revise && reviewPlan?.items.length
          ? html`<label class="kick-note kick-review-join" data-testid="interview-kickoff-review-note">
              <input type="checkbox" data-testid="interview-review-with-interview" checked=${joinWanted} onChange=${(e) => toggleJoinWanted(e.currentTarget.checked)} />
              Also ask the <strong>${reviewPlan.items.length} review ${reviewPlan.items.length === 1 ? 'question' : 'questions'}</strong> in the first round. Nothing is applied until you answer.
            </label>`
          : null}
        ${!update && !review && !revise && updatePlan?.items.length
          ? html`<p class="kick-note" data-testid="interview-kickoff-update-note">
              <strong>${updatePlan.items.length} Field${updatePlan.items.length === 1 ? ' is' : 's are'} Out of date.</strong>
              ${` The interview starts with a round of cards about ${updatePlan.items.length === 1 ? 'it' : 'them'}, then carries on.`}
            </p>`
          : null}
        ${!update && !review && !revise && newSince.length
          ? html`<p class="kick-note" data-testid="interview-kickoff-new-since">
              <strong>${newSince.length} Source document${newSince.length === 1 ? ' is' : 's are'} New since the last interview.</strong>
              ${` The AI reads ${newSince.length === 1 ? 'it' : 'them'} against what is saved, and asks a card only where ${newSince.length === 1 ? 'it adds' : 'they add'} to or ${newSince.length === 1 ? 'contradicts' : 'contradict'} something.`}
            </p>`
          : null}
        ${update ? updateKickoffExtras() : null}
        ${blockedReason ? html`<p class="inline-error" role="alert" data-testid="interview-blocked">${blockedReason}</p>` : null}
        ${held.length
          ? html`<p class="kick-note" data-testid="interview-head-start-note">This Stage is drafted ahead of ${pendingTitles.join(' and ')}, which awaits approval, so the AI gets a head start only: it drafts the Modules no pending Stage mounts. Held until then: ${held.map((h) => setup.definition.modules.find((m) => m.id === h.id)?.title ?? h.id).join(', ')}.</p>`
          : null}
        ${asideNotice
          ? html`<div class="warn" role="status" data-testid="interview-copy-aside">
              A copy of unsaved work kept in this browser${asideNotice.savedAt ? ` (${new Date(asideNotice.savedAt).toLocaleString()})` : ''} was set aside, because this Stage's decisions log has been saved since it began. The saved log and content are what this interview carries on from.
              <button type="button" class="btn small ghost" data-testid="interview-copy-aside-dismiss" onClick=${() => { workingCopies.clearAside(sessionKey); setAsideNotice(null) }}>Dismiss</button>
            </div>`
          : null}
        ${resuming
          ? html`<div class="resume-recap" role="status" data-testid="interview-resume-recap">
              <strong>${resuming.recap}</strong>
              <span>. Pick an AI Provider and carry on: the AI is given the decisions log and the saved content, not the earlier conversation.</span>
            </div>`
          : null}
        ${resume
          ? html`<div class="kick-resume" data-testid="interview-resume-note" role="status">
              <p class="kick-note">
                <strong>A run to ${stageTitleOf(resume.targetStageId)} was paused${resume.mode === 'advance' ? ` after ${stageTitleOf(resume.fromStageId)} was saved` : ` before ${instance.stage.title}`}.</strong>
                Resuming ${resume.mode === 'advance' ? `moves on to ${followingStage?.title ?? 'the next Stage'} and ` : ''}carries on to ${stageTitleOf(resume.targetStageId)}.
              </p>
              <button type="button" class="btn small primary" data-testid="interview-resume" disabled=${!providerId || Boolean(blockedReason) || !snap} onClick=${resumeRun}>Resume the run</button>
              ${resumeMessage ? html`<p class="inline-error" role="alert" data-testid="interview-resume-error">${resumeMessage}</p>` : null}
            </div>`
          : null}

        <label for="interview-provider">AI Provider</label>
        ${providers.length
          ? html`<select id="interview-provider" data-testid="interview-provider" value=${providerId ?? ''} disabled=${phase === 'testing'} onChange=${(e) => switchProvider(e.currentTarget.value)}>
              ${providers.map((p) => html`<option key=${p.id} value=${p.id} selected=${p.id === providerId}>${providerLabel(p)}</option>`)}
            </select>`
          : html`<p class="muted" data-testid="interview-no-provider">No AI Provider has been added in this browser yet.</p>`}
        <div class="kick-row">
          <button type="button" class=${'btn small' + (providers.length ? ' ghost' : ' primary')} data-testid="interview-connect" onClick=${() => setConnecting(true)}>Connect an AI Provider</button>
        </div>
        ${provider
          ? html`<p class="kick-note" data-testid="interview-provider-status">
              ${status === 'passed' ? `Ready. ${provider.model} passed its test.` : status === 'failed' ? `Its last test failed: ${provider.test.message}` : 'Untested. Gantry tests it when you start.'}
            </p>`
          : null}
        ${provider ? html`<${CardModeNote} provider=${provider} />` : null}

        ${!update && !review && !revise && targets.length > 1
          ? html`<label for="interview-run-until">Run until</label>
            <select id="interview-run-until" data-testid="interview-run-until" onChange=${(e) => setPickedTarget(e.currentTarget.value)}>
              ${targets.map((t) => html`<option key=${t.id} value=${t.id} selected=${t.id === target}>${t.title}${t.id === instance.stage.id ? ' (this Stage only)' : ''} (gate: ${t.gate})</option>`)}
            </select>
            <p class="kick-note" data-testid="interview-run-until-note">
              ${target === instance.stage.id
                ? 'The interview covers this Stage only. Pick a later Stage to carry on into it: the run plan on the left shows the Stages in order.'
                : `The AI drafts each Stage in order, up to and including ${stageTitleOf(target)}, and you confirm each one. A Stage is never skipped.`}
            </p>`
          : null}
        ${choosing ? artefactBlock() : null}

        ${unreadableNote()}
        <p class="kick-sources" data-testid="interview-source-count">
          ${sources === null ? 'Reading the Source documents…' : sourceCount === 0 ? 'No Source documents yet. Add some in the left rail so the AI has something to read.' : `${sourceCount} Source document${sourceCount === 1 ? '' : 's'} for the AI to read.`}
        </p>
        ${snap?.kickoffError ? html`<p class="inline-error" role="alert" data-testid="interview-kickoff-error">${snap.kickoffError}</p>` : null}
        ${snap?.sessionWarning
          ? html`<div class="qcard session-warning" role="alert" data-testid="interview-session-warning">
              <div class="qchip">Another session</div>
              <p class="qhead">Another session on ${instance.stage.title} isn't done.</p>
              <ul class="session-others">
                ${snap.sessionWarning.others.map(
                  (other) => html`<li key=${other.session} data-testid="interview-other-session" data-session=${other.session}>
                    A session${instance.workspaceBacked && other.who ? ` by ${other.who}` : ''} (${other.state}) ${describeSaved(other.lastAiSave)}.
                  </li>`
                )}
              </ul>
              ${remote && lastSavedBy(committedLog)?.by
                ? html`<p class="kick-note" data-testid="interview-last-saved-by-note">Last saved by <strong data-testid="interview-last-saved-by">${lastSavedBy(committedLog).by}</strong> (the commit author).</p>`
                : null}
              <p class="kick-note">If you carry on alongside it, each Save is checked Field by Field against the other's, and the two decisions logs merge in time order.</p>
              <div class="round-actions">
                <button type="button" class="btn primary" data-testid="interview-warning-carry-on" onClick=${() => startInterview({ alongside: true })}>Carry on alongside</button>
                <button type="button" class="btn ghost" data-testid="interview-warning-cancel" onClick=${() => sessionRef.current?.dismissSessionWarning()}>Cancel</button>
              </div>
            </div>`
          : null}
        ${revise
          ? null
          : html`<label for="interview-opening">Anything the AI should know before it starts? (optional)</label>
            <textarea
              id="interview-opening"
              data-testid="interview-opening"
              rows="3"
              maxlength=${OPENING_MAX}
              placeholder="Focus on the hosting decision; the budget is capped at NZD 1.2M"
              value=${opening}
              disabled=${phase === 'testing'}
              onInput=${(e) => setOpening(e.currentTarget.value)}
            ></textarea>
            <p class="kick-note" data-testid="interview-opening-note">
              Sent as your first message, in your own words${update || review ? '' : ', and on a run as the first message of every Stage'}. It steers what the AI reads and asks first, and never overrides
              Gantry's rules or the Definition's Interview instructions.
            </p>`}
        <button
          type="button"
          class="btn primary"
          data-testid="interview-start"
          disabled=${!providerId || phase === 'testing' || sources === null || Boolean(blockedReason) || !snap || Boolean(snap?.sessionWarning) || (update && !updatePlan?.items.length) || (review && !reviewPlan?.items.length) || (revise && prComments.status !== 'ready') || (!revise && !flagsReady && !flagsWaited)}
          onClick=${() => startInterview()}
        >
          ${phase === 'testing' ? PROGRESS_LABELS[snap?.testStep] ?? 'Testing the AI Provider…' : review ? 'Work through review comments' : revise ? 'Start the revision' : update ? 'Bring up to date' : resuming ? 'Resume interview' : 'Start interview'}
        </button>
      </div>
    `
  }

  // #345: the line a turn that ended with nothing to show left, while Carry on still answers it: between turns, with no round of cards open,
  // and with nothing from the architect or the AI after it.
  const carryOnAt = (() => {
    const list = snap?.thread ?? []
    if (phase !== 'waiting' || snap?.round || snap?.clash) return null
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].carryOn) return list[i].id
      if (list[i].who !== 'sys') return null
    }
    return null
  })()
  const sendCarryOn = () => sessionRef.current?.send(CARRY_ON_MESSAGE)
  const thread = () => (snap?.thread ?? []).map((m) => html`<${ThreadMessage} key=${m.id} m=${m} preview=${replyPreview} carryOn=${m.id === carryOnAt} onCarryOn=${sendCarryOn} />`)

  // The `fields` part of the decisions log (ADR-0064): what each drafted Field was drafted from, including every read the AI made (#292).
  const inputsLog = () => {
    const entries = Object.entries(snap?.fieldInputs ?? {}).filter(([, inputs]) => inputs.length)
    if (entries.length === 0) return null
    return html`<div data-testid="interview-inputs">
      <h3 class="side">Decisions log · inputs</h3>
      <ul class="inputs-log">
        ${entries.map(
          ([fieldKey, inputs]) => html`<li key=${fieldKey} data-field-key=${fieldKey}>
            <span class="inputs-field">${fieldKey}</span>
            ${inputs.map((input, i) => html`<span key=${i} class="inputs-read" data-source-id=${input.source} data-testid="interview-input">${describeInput(input)}</span>`)}
          </li>`
        )}
      </ul>
    </div>`
  }

  // Tokens (#294), never money: what each AI Provider reported, with no budgets or limits. Hovering shows input, cached and output tokens
  // and the share of input read from cache. Nothing per round, and nothing in AI Provider settings.
  const rowTokens = (stageId) => {
    const at = stagesList.findIndex((st) => st.id === stageId)
    const used = at !== -1 && at <= currentAt ? stageTokens(stageId) : null
    if (!used || !hasTokens(used)) return null
    return html`<span class="rp-tokens" data-testid="run-plan-tokens" title=${tokenBreakdown(used)} tabindex="0">${formatTokens(totalTokens(used))}</span>`
  }
  const tokensRail = () => {
    if (!hasTokens(sessionTokens) && !hasTokens(thisStageTokens)) return null
    return html`<div class="rail-tokens" data-testid="interview-tokens">
      <h3 class="side">Tokens</h3>
      <dl>
        <dt>This session</dt>
        <dd data-testid="interview-tokens-session" title=${tokenBreakdown(sessionTokens)} tabindex="0">${formatTokens(totalTokens(sessionTokens))}</dd>
        <dt>This stage</dt>
        <dd data-testid="interview-tokens-stage" title=${tokenBreakdown(thisStageTokens)} tabindex="0">${formatTokens(totalTokens(thisStageTokens))}</dd>
      </dl>
      ${started && snap?.canCompact && phase !== 'paused'
        ? snap.compactPending
          ? html`<p class="rail-compact-note" data-testid="interview-compact-pending">${phase === 'asking' ? 'Compacts once you answer this round.' : 'Compacts when this turn ends.'}</p>`
          : html`<button type="button" class="btn small ghost rail-compact" data-testid="interview-compact" disabled=${snap.compacting} title="Start the conversation afresh so it fits the model: the AI keeps the drafts, the decisions log and your own messages word for word, with a short summary of where things stand." onClick=${compactNow}>Compact now</button>`
        : null}
    </div>`
  }

  // #329 (docs/adr/0073): past about 60% of the model's context window, a card offers to compact the conversation. Not now waits until it has
  // grown by another tenth of the window. Compacting keeps the architect's words; it forgets the AI's earlier replies and the text of its reads.
  const compactOfferCard = () => {
    const offer = snap?.compactOffer
    if (!offer || busy) return null
    const share = Math.round((offer.before / offer.window) * 100)
    return html`<div class="qcard compact-offer" role="status" data-testid="interview-compact-offer">
      <div class="qchip">Long conversation</div>
      <p class="qhead">This conversation is ${formatTokens(offer.before)}, about ${share}% of what the model can take. Compact it?</p>
      <p class="kick-note">
        Compacting starts it afresh at about ${formatTokens(offer.after)}. The AI keeps the drafts, the decisions log and your own messages word for word, with a short summary of where things stand. It
        forgets its earlier replies and the text of what it read, and reads again whatever it needs.${phase === 'asking' ? ' It happens once you answer this round.' : ''}
      </p>
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="interview-compact-offer-now" onClick=${compactNow}>Compact now</button>
        <button type="button" class="btn ghost" data-testid="interview-compact-offer-not-now" onClick=${() => sessionRef.current?.notNowCompact()}>Not now</button>
      </div>
    </div>`
  }

  // The decisions log (#288): a count in the rail, with the open questions called out. The full, read-only panel is in the editor.
  const decisionsRail = () => {
    const summary = snap?.decisions ?? logSummary(committedLog)
    return html`<div data-testid="interview-decisions">
      <h3 class="side">Decisions log <span class="dl-count" data-testid="interview-decisions-count">${summary.count}</span></h3>
      <p class="dl-summary" data-testid="interview-decisions-summary">
        ${summary.count === 0 ? 'Nothing decided yet.' : `${summary.latest.length} decision${summary.latest.length === 1 ? '' : 's'}`}
        ${summary.open.length ? html` · <span class="dl-open-count" data-testid="interview-decisions-open">${summary.open.length} open question${summary.open.length === 1 ? '' : 's'}</span>` : null}
        ${snap?.decisions?.pending ? html` · <span data-testid="interview-decisions-unsaved">${snap.decisions.pending} not saved yet</span>` : null}
      </p>
      ${started && !blockedReason
        ? confirmRestart
          ? html`<div class="dl-restart" data-testid="interview-restart-confirm" role="group" aria-labelledby="interview-restart-question">
              <p class="kick-note" id="interview-restart-question">Start over: the AI ignores every earlier answer from now on. Saved content is not touched, and the log keeps what was said before.</p>
              <button type="button" class="btn small" data-testid="interview-restart-yes" ref=${restartYes} onClick=${() => { sessionRef.current?.startOver(); clearRun(instance.slug); startedOver.current = true; setOpening(''); setConfirmRestart(false); setSaving(null) }}>Start this stage over</button>
              <button type="button" class="btn small ghost" data-testid="interview-restart-no" onClick=${() => setConfirmRestart(false)}>Keep going</button>
            </div>`
          : html`<button type="button" class="btn small ghost dl-restart" data-testid="interview-restart" disabled=${busy} onClick=${() => setConfirmRestart(true)}>Start this stage over</button>`
        : null}
    </div>`
  }

  const roundView = () => {
    const round = snap?.round
    if (!round || phase !== 'asking') return null
    const total = pageCount(round.cards.length)
    const page = Math.min(round.page, total - 1)
    const shown = pageCards(round.cards, page)
    const unanswered = round.cards.filter((c) => !isAnswered(c)).length
    const last = page === total - 1
    return html`<div class="round" data-testid="interview-round" data-round=${round.id} data-final=${round.final ? 'true' : 'false'} data-page=${page + 1} data-pages=${total}>
      <div class="round-head" data-testid="round-head">
        ${round.update ? 'Bring up to date' : round.review ? 'Review comments' : round.revise ? "The Owner's comments" : round.final ? 'Last round' : `Round ${round.id}`} · ${round.cards.length} ${round.update ? 'Field' : round.review || round.revise ? 'comment' : 'question'}${round.cards.length === 1 ? '' : 's'}
        ${total > 1 ? ` · cards ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + shown.length} of ${round.cards.length}` : ''}
      </div>
      ${round.revise ? html`<p class="round-note" data-testid="revise-round-note">One card for each comment on the Pull Request, resolved ones included. Nothing is written to the Pull Request; your answers go in the decisions log.</p>` : null}
      ${round.update ? html`<p class="round-note" data-testid="update-round-note">One card for each Field that is Out of date. Only your answer clears a flag.</p>` : null}
      ${round.review ? html`<p class="round-note" data-testid="review-round-note">One card for each comment thread, and for each reviewer's tracked changes in a Field. Nothing is applied until you answer, and the AI sees reviewers only as Reviewer 1, Reviewer 2.</p>` : null}
      ${round.update ? updateDeferredNote() : null}
      ${round.final ? html`<p class="round-note">You chose to finish with the AI's recommendations. This is the one last round: only what the AI can't responsibly propose.</p>` : null}
      ${snap.held > 0 ? html`<p class="round-note" data-testid="round-held">${snap.held} more question${snap.held === 1 ? '' : 's'} will follow once these are answered.</p>` : null}
      ${shown.map((card) => html`<${QuestionCard} key=${card.id} card=${card} fieldTitle=${fieldTitle} session=${sessionRef.current} />`)}
      <div class="round-actions">
        ${total > 1 ? html`<button type="button" class="btn small ghost" data-testid="round-back" disabled=${page === 0} onClick=${() => sessionRef.current?.setPage(page - 1)}>Back</button>` : null}
        ${total > 1 ? html`<span class="round-page" data-testid="round-page">${page + 1} of ${total}</span>` : null}
        ${!last ? html`<button type="button" class="btn small" data-testid="round-next" onClick=${() => sessionRef.current?.setPage(page + 1)}>Next</button>` : null}
        ${last
          ? html`<button type="button" class="btn primary" data-testid="round-submit" disabled=${unanswered > 0} onClick=${submitRound}>Submit ${round.cards.length} answer${round.cards.length === 1 ? '' : 's'}</button>`
          : null}
        ${unanswered > 0 ? html`<span class="round-page" data-testid="round-unanswered">${unanswered} still to answer</span>` : null}
      </div>
      ${submitMessage ? html`<p class="inline-error" role="alert" data-testid="round-error">${submitMessage}</p>` : null}
    </div>`
  }

  // The Save check found Fields you and someone else both changed (#290, ADR-0068): a round of cards, one per Field.
  const clashView = () => {
    const clash = snap?.clash
    if (!clash) return null
    const unsettled = clash.cards.filter((c) => !isAnswered(c)).length
    return html`<div class="round clash-round" data-testid="interview-clash" role="alert">
      <div class="round-head">Settle before saving · ${clash.cards.length} Field${clash.cards.length === 1 ? '' : 's'} changed on both sides</div>
      <p class="round-note">Someone saved ${clash.cards.length === 1 ? 'this Field' : 'these Fields'} after you began, and you changed ${clash.cards.length === 1 ? 'it' : 'them'} too. Nothing is overwritten without your say. Your choice is logged.</p>
      ${clash.merging ? html`<p class="round-note" data-testid="clash-merging">The AI is writing a merged wording<span class="caret"></span></p>` : null}
      ${clash.mergeNote ? html`<p class="round-note" data-testid="clash-merge-note">${clash.mergeNote}</p>` : null}
      ${clash.cards.map((card) => html`<${ClashCard} key=${card.id} card=${card} session=${sessionRef.current} />`)}
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="clash-submit" disabled=${unsettled > 0} onClick=${() => sessionRef.current?.submitClash()}>Settle and save</button>
        <button type="button" class="btn ghost" data-testid="clash-cancel" onClick=${() => sessionRef.current?.cancelClash()}>Cancel the Save</button>
        ${unsettled > 0 ? html`<span class="round-page" data-testid="clash-unsettled">${unsettled} still to settle</span>` : null}
      </div>
    </div>`
  }

  // Modules marked agreed that a Save took back to draft, with the note the decisions log keeps (#298).
  const returnedList = (list) =>
    list?.length
      ? html`<ul class="update-returned" data-testid="interview-returned-to-draft">
          ${list.map((e) => html`<li key=${e.id} data-module=${e.module}>${e.note}</li>`)}
        </ul>`
      : null

  // Pause saved the decisions log and the drafts so far (#290): this run stops here, and carries on from them in any browser.
  const pausedView = () => {
    if (phase !== 'paused') return null
    return html`<div class="qcard stage-end saved" data-testid="interview-paused" role="status">
      <p class="qhead">Paused</p>
      <p>
        ${saving?.fields ? `${saving.fields} Field${saving.fields === 1 ? '' : 's'} and the decisions log are saved as one Save. ` : 'The decisions log is saved. '}The Modules stay <strong>draft</strong>.
        Open the Interview page on this Instance again, in this browser or any other, and the AI recaps from the log and carries on. The earlier conversation is not kept.
      </p>
      ${returnedList(saving?.returned)}
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="interview-resume" onClick=${resumeAfterPause}>Resume now</button>
        <a class="btn ghost" href=${editorHref} data-testid="interview-paused-editor">Back to the editor</a>
      </div>
    </div>`
  }

  // #295: the Pull Request is open and the Owner has not approved it yet. The session waits here: nothing checks on its own, so the card
  // and the Stage's row in the run plan both offer Check status. The Provider's word puts this card up, so it is the same after a reload.
  const awaitingCard = () => {
    const checking = approval.phase === 'checking'
    const goesOn = target !== instance.stage.id && Boolean(followingStage)
    return html`<div class="qcard stage-end awaiting" data-testid="interview-awaiting-approval" role="status">
      <div class="qchip">Awaiting approval</div>
      <p class="qhead">${stage?.title ?? instance.stage.title} is waiting for approval</p>
      <p>
        ${saving?.phase === 'saved' ? 'It is saved as one Stage Save and its Pull Request is open: ' : 'Its Pull Request is open: '}
        ${awaiting.url ? html`<a href=${awaiting.url} target="_blank" rel="noopener noreferrer" data-testid="interview-pr-link">Pull Request #${awaiting.id}</a>` : html`<span data-testid="interview-pr-link">Pull Request #${awaiting.id}</span>`}.
        The AI never approves it, and a Stage moves on only when a person does. The session waits here; nothing checks on its own, so press Check status once the Owner has reviewed it.
      </p>
      ${saving?.reRendered?.length ? html`<p data-testid="interview-rerendered">Re-rendered ${saving.reRendered.join(', ')} onto this Stage's branch before asking, with the approved ${saving.reRendered.length === 1 ? 'copy' : 'copies'} kept in out/approved/. The Pull Request also re-approves ${[...new Set(saving.reRenderedStages ?? [])].join(', ') || 'the earlier Stage'}.</p>` : null}
      ${goesOn
        ? html`<p class="kick-note" data-testid="interview-awaiting-next">Once it is approved, the run goes on to ${followingStage.title}${target === followingStage.id ? ', its target' : `, then to ${stageTitleOf(target)}`}.</p>`
        : html`<p class="kick-note" data-testid="interview-awaiting-last">This is the last Stage of the run. Once it is approved, the Instance moves on.</p>`}
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="interview-check-status" disabled=${checking} onClick=${() => checkApproval()}>${checking ? 'Checking…' : 'Check status'}</button>
        ${goesOn && onDraftAhead && providerInUse
          ? html`<button type="button" class="btn ghost" data-testid="interview-draft-ahead" disabled=${checking || Boolean(blockedReason)} onClick=${() => draftAhead({ phase: 'saved' })} title="Draft the next Stage's head start while the Owner reviews this one.">Draft ahead on ${followingStage.title}</button>`
          : null}
      </div>
      ${saving?.advanceError ? html`<p class="inline-error" role="alert" data-testid="interview-advance-error">${saving.advanceError}</p>` : null}
      ${approval.message ? html`<p class="kick-note" data-testid="interview-approval-message" role="status">${approval.message}</p>` : null}
    </div>`
  }

  // #299: the Owner sent the Stage back (changes requested) or rejected it. One card: revise the Stage with the AI, or stop the session here.
  // Drafting ahead is paused; what was drafted ahead is kept either way. The AI never writes to the Pull Request.
  const sentBackCard = () => {
    const title = stageTitleOf(sentBack.stageId)
    const rejected = sentBack.kind === 'rejected'
    const checking = approval.phase === 'checking'
    const saving_ = saving?.phase === 'saving'
    return html`<div class="qcard stage-end sent-back" data-testid="interview-sent-back" data-kind=${sentBack.kind} role="status">
      <div class="qchip">${rejected ? 'Rejected' : 'Changes requested'}</div>
      <p class="qhead">${rejected ? `${title} was rejected` : `${title} was sent back`}${sentBack.pullRequestId ? html` · <a href=${pullRequestLink(instance, sentBack.pullRequestId)} target="_blank" rel="noopener noreferrer" data-testid="sent-back-pr-link">Pull Request #${sentBack.pullRequestId}</a>` : null}</p>
      <p data-testid="sent-back-note">
        ${rejected ? `The Owner rejected ${title}.` : `The Owner asked for changes to ${title}.`}
        ${ahead ? ' Drafting ahead is paused, and what the AI drafted ahead is kept. ' : ' '}
        Revising reads every comment on the Pull Request, resolved ones included, and asks you one card for each. The AI never writes to the Pull Request.
      </p>
      ${sentBack.stopped ? html`<p class="kick-note" data-testid="sent-back-stopped">The session stopped here.${ahead ? ' What was drafted ahead is saved on its Stage.' : ''} Open the Interview page again, or press Revise, whenever you are ready.</p>` : null}
      ${saving?.phase === 'error' && !saving.pause ? html`<p class="inline-error" role="alert" data-testid="interview-save-error">${saving.message}</p>` : null}
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="interview-revise" disabled=${saving_ || checking || !onReviseStage || Boolean(blockedReason && !ahead)} onClick=${reviseSentBack}>
          ${SENT_BACK_CHOICES.revise(title)}
          <span class="rec">RECOMMENDED</span>
        </button>
        ${sentBack.stopped
          ? null
          : html`<button type="button" class="btn ghost" data-testid="interview-stop-session" disabled=${saving_ || checking} onClick=${stopSession}>${SENT_BACK_CHOICES.stop}</button>`}
        <button type="button" class="btn ghost" data-testid="interview-check-status" disabled=${checking} onClick=${() => checkApproval()}>${checking ? 'Checking…' : 'Check status again'}</button>
      </div>
      ${approval.message ? html`<p class="kick-note" data-testid="interview-approval-message" role="status">${approval.message}</p>` : null}
    </div>`
  }

  // The later Stages' Fields drafted from content this revision changed (by fingerprint), which are asked about before the run carries on.
  const staleAfterRevision =
    revise && saving?.phase === 'saved' && saving.revision && setup.status === 'ready'
      ? staleLaterFields({
          stages: stagesList,
          revisedStageId: instance.stage.id,
          logs: { ...setup.logs, ...stageLogs, [instance.stage.id]: committedLog },
          modules: [...instance.modules, ...otherSaved],
          stageModules: Object.fromEntries((setup.definition.stages ?? []).map((st) => [st.id, st.modules ?? []])),
        })
      : []

  // The end of a revision (#299): the comments are answered and the drafts are ready to save, or the revision has been saved.
  const reviseEnd = () => {
    if (!started) return null
    const prId = prComments.pullRequestId ?? awaiting?.id ?? null
    const prUrl = pullRequestLink(instance, prId)
    if (saving?.phase === 'saved' && saving.revision) {
      const stageIds = [...new Set(staleAfterRevision.flatMap((f) => f.stages))].sort((a, b) => stagesList.findIndex((x) => x.id === a) - stagesList.findIndex((x) => x.id === b))
      const reviewStage = stageIds[0] ?? null
      return html`<div class="qcard stage-end saved" data-testid="revise-saved" role="status">
        <div class="qchip">Revision saved</div>
        <p class="qhead">${stage?.title ?? instance.stage.title} is back to awaiting approval</p>
        <p data-testid="revise-saved-summary">
          ${saving.answers} comment${saving.answers === 1 ? '' : 's'} answered${saving.fields ? `, ${saving.fields} Field${saving.fields === 1 ? '' : 's'} changed` : ', no Field text changed'}, saved as one Stage Save on ${stage?.title ?? instance.stage.title}'s branch.
          ${prId && awaiting ? html`The open ${prUrl ? html`<a href=${prUrl} target="_blank" rel="noopener noreferrer" data-testid="revise-pr-link">Pull Request #${prId}</a>` : `Pull Request #${prId}`} now includes it.` : ''}
          The Modules stay <strong>draft</strong>: a person marks them agreed.
        </p>
        ${returnedList(saving.returned)}
        ${prId && !awaiting
          ? html`<p class="kick-note" data-testid="revise-pr-closed">${prUrl ? html`<a href=${prUrl} target="_blank" rel="noopener noreferrer" data-testid="revise-pr-link">Pull Request #${prId}</a>` : `Pull Request #${prId}`} is closed, so it does not carry the revision: the revision is on ${stage?.title ?? instance.stage.title}'s branch. A new Pull Request for it is opened on the Provider.</p>`
          : null}
        <p class="kick-note" data-testid="revise-tell-owner">Nothing was written to the Pull Request: no comments, no replies, no resolved threads. Tell the Owner it is ready for another look.</p>
        ${staleAfterRevision.length
          ? html`<div data-testid="revise-stale">
              <p class="kick-note" data-testid="revise-stale-note">
                ${staleAfterRevision.length} Field${staleAfterRevision.length === 1 ? '' : 's'} on ${stageIds.map(stageTitleOf).join(', ')} ${staleAfterRevision.length === 1 ? 'was' : 'were'} drafted from content this revision changed: ${staleAfterRevision.map((f) => fieldTitle(f.field)).join(', ')}. You are asked to keep or redraft each before the run carries on.
              </p>
            </div>`
          : null}
        <div class="round-actions">
          ${reviewStage && onUpdateStage
            ? html`<button type="button" class="btn primary" data-testid="revise-review-later" onClick=${() => onUpdateStage(reviewStage)}>Review ${staleAfterRevision.length === 1 ? 'it' : 'them'} on ${stageTitleOf(reviewStage)}</button>`
            : null}
          <button type="button" class=${'btn' + (reviewStage ? ' ghost' : ' primary')} data-testid="revise-done" disabled=${!onLeaveRevision} onClick=${() => onLeaveRevision?.()}>Back to the run</button>
        </div>
      </div>`
    }
    if (snap?.round || snap?.clash || phase !== 'waiting') return null
    if (snap?.revise && !snap.revise.answered) return null
    const pending = snap?.decisions?.pending ?? 0
    return html`<div class="qcard stage-end" data-testid="revise-ready">
      <div class="qchip">Revision</div>
      <p class="qhead">${snap?.revise ? `${snap.revise.total} comment${snap.revise.total === 1 ? '' : 's'} answered. ` : ''}Save the revision?</p>
      <p>${draftKeys.length ? `${draftKeys.length} Field${draftKeys.length === 1 ? ' is' : 's are'} changed in the preview. ` : 'No Field text changes. '}${pending} answer${pending === 1 ? ' is' : 's are'} waiting in the decisions log. Saving is one Stage Save on ${stage?.title ?? instance.stage.title}'s branch, which updates its open Pull Request. It asks for nothing, and nothing is written to the Pull Request.</p>
      ${saving?.phase === 'error' ? html`<p class="inline-error" role="alert" data-testid="revise-save-error">${saving.message}</p>` : null}
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="revise-save" disabled=${saving?.phase === 'saving' || Boolean(blockedReason) || handEditing !== null} onClick=${saveRevision}>
          ${saving?.phase === 'saving' ? 'Saving…' : 'Save the revision'}
        </button>
      </div>
    </div>`
  }

  // #296: nothing is left to draft on this Stage until the earlier one is approved (docs/adr/0063). One card, two choices; both save the
  // head start as one commit on this Stage's branch. "Check approval now" runs Check status and carries on if the earlier Stage merged.
  const waitingCard = () => {
    const checking = approval.phase === 'checking'
    const busySaving = saving?.phase === 'saving' || Boolean(blockedReason) || handEditing !== null
    const titleOfModule = (id) => setup.definition.modules.find((m) => m.id === id)?.title ?? id
    const unsaved = draftKeys.length
    const waitsFor = pendingTitles.join(' and ')
    return html`<div class="qcard stage-end waiting" data-testid="interview-waiting" role="status">
      <div class="qchip">Waiting</div>
      <p class="qhead">${stage?.title ?? instance.stage.title} waits for ${waitsFor} to be approved</p>
      <p data-testid="interview-waiting-held">
        ${nothingDraftable
          ? html`Every Module this Stage can edit is also mounted by ${waitsFor}, so there is nothing to draft yet.`
          : html`The AI has drafted what it can: the Modules no pending Stage mounts${unsaved ? ` (${unsaved} Field${unsaved === 1 ? '' : 's'} not saved yet)` : ''}.`}
        Held until ${waitsFor} is approved and merged: ${held.map((h) => titleOfModule(h.id)).join(', ')}. Gantry refuses any write to them before then.
      </p>
      ${headStart?.fields ? html`<p class="gate-ok" data-testid="interview-head-start-saved">The head start is saved: ${headStart.fields} Field${headStart.fields === 1 ? '' : 's'}, as one commit on ${stage?.title ?? instance.stage.title}'s branch.</p>` : null}
      ${saving?.phase === 'error' && !saving.pause ? html`<p class="inline-error" role="alert" data-testid="interview-save-error">${saving.message}</p>` : null}
      ${headStart?.stopped
        ? html`<p class="kick-note" data-testid="interview-waiting-stopped">The session stops here. ${stage?.title ?? instance.stage.title} gets its full Save later, when it is ready: open the Interview page again and press Check status once ${waitsFor} is approved.</p>`
        : html`<p class="kick-note" data-testid="interview-waiting-note">Confirming either choice saves the head start${unsaved ? '' : ' (already saved)'} as one commit on ${stage?.title ?? instance.stage.title}'s branch. ${stage?.title ?? instance.stage.title} gets its full Save later, when it is ready.</p>
          <div class="round-actions">
            <button type="button" class="btn primary" data-testid="interview-check-approval-now" disabled=${busySaving || checking} onClick=${() => waitingAction('check')}>
              ${saving?.phase === 'saving' ? 'Saving…' : checking ? 'Checking…' : 'Check approval now'}
              <span class="rec">RECOMMENDED</span>
            </button>
            <button type="button" class="btn ghost" data-testid="interview-stop-here" disabled=${busySaving || checking} onClick=${() => waitingAction('stop')}>Stop here</button>
          </div>`}
      ${approval.message ? html`<p class="kick-note" data-testid="interview-approval-message" role="status">${approval.message}</p>` : null}
    </div>`
  }

  const askAgain = async () => {
    const asked = await requestApproval({ reRender: saving?.willReRender === true })
    if (asked.ok) setSaving((was) => (was ? { ...was, approval: 'requested' } : was))
  }

  // Bring up to date (#298): the answers are ready to save, or have been. Nothing here advances the Instance or asks for approval.
  const updateEnd = () => {
    const u = snap?.update
    if (!u?.answered || snap?.round || snap?.clash) return null
    const pending = snap?.decisions?.pending ?? 0
    if (saving?.phase === 'saved' && saving.update) {
      const next = otherUpdateStages[0] ?? null
      return html`<div class="qcard stage-end saved" data-testid="update-saved" role="status">
        <p class="qhead">${saving.answers || saving.fields ? 'Brought up to date and saved' : 'Nothing to save'}</p>
        <p data-testid="update-saved-summary">
          ${saving.answers || saving.fields
            ? html`${saving.answers} answer${saving.answers === 1 ? '' : 's'} logged${saving.fields ? `, ${saving.fields} Field${saving.fields === 1 ? '' : 's'} changed` : ''}. The Modules stay <strong>draft</strong>: a person marks them agreed.`
            : 'Every Field was left flagged, so nothing was written and the flags stay.'}
        </p>
        ${saving.returned.length
          ? html`<ul class="update-returned" data-testid="update-returned">
              ${saving.returned.map((e) => html`<li key=${e.id} data-module=${e.module}>${e.note}</li>`)}
            </ul>`
          : null}
        ${next && !remote
          ? html`<p class="kick-note" data-testid="update-next">
              ${next.count} Field${next.count === 1 ? '' : 's'} on ${stageTitleOf(next.stageId)} ${next.count === 1 ? 'is' : 'are'} still Out of date.
              <button type="button" class="btn small primary" data-testid="update-next-button" disabled=${!onOpenStage} onClick=${() => onOpenStage?.(next.stageId)}>Next: ${stageTitleOf(next.stageId)}</button>
            </p>`
          : null}
        <div class="round-actions"><a class="btn ghost" href=${editorHref} data-testid="update-back-to-editor">Back to the editor</a></div>
      </div>`
    }
    if (phase === 'working' || phase === 'testing' || phase === 'asking') return null
    const kept = u.total
    return html`<div class="qcard stage-end" data-testid="update-ready">
      <div class="qchip">Bring up to date</div>
      <p class="qhead">${kept} Field${kept === 1 ? '' : 's'} answered. Save the round?</p>
      <p>${draftKeys.length ? `${draftKeys.length} Field${draftKeys.length === 1 ? ' is' : 's are'} changed in the preview. ` : 'No Field text changes. '}${pending} answer${pending === 1 ? ' is' : 's are'} waiting in the decisions log. Saving is one Stage Save, and a flag clears only for a Field you answered.</p>
      ${u.reopen.length
        ? html`<div data-testid="update-reopen">
            <p class="kick-note" data-testid="update-reopen-note">
              You chose to re-open ${u.reopen.map(stageTitleOf).join(', ')}, because ${u.reopen.length === 1 ? 'a Field' : 'Fields'} there can't be changed from ${instance.stage.title}. Saving this round starts ${instance.stage.title} (it gets a branch),
              and while ${instance.stage.title} is in progress ${u.reopen.map(stageTitleOf).join(', ')} cannot be re-opened (ADR-0026). So either re-open now, and the other answers in this round are not saved: bring the Stage up to date again from there, and it asks about all of them. Or save the other answers, and the Fields that need ${u.reopen.map(stageTitleOf).join(', ')} stay flagged.
            </p>
            <div class="round-actions">
              ${u.reopen.map(
                (id) => html`<button key=${id} type="button" class="btn primary" data-testid="update-reopen-button" data-stage-id=${id} disabled=${reopening.stageId !== null || saving?.phase === 'saving' || !onReopenStage} onClick=${() => reopen(id)}>
                  ${reopening.stageId === id ? 'Re-opening…' : `Re-open ${stageTitleOf(id)}`}
                </button>`
              )}
            </div>
            ${reopening.message ? html`<p class="inline-error" role="alert" data-testid="update-reopen-error">${reopening.message}</p>` : null}
          </div>`
        : null}
      ${saving?.phase === 'error' ? html`<p class="inline-error" role="alert" data-testid="update-save-error">${saving.message}</p>` : null}
      <div class="round-actions">
        <button type="button" class=${'btn' + (u.reopen.length ? '' : ' primary')} data-testid="update-save" disabled=${saving?.phase === 'saving' || Boolean(blockedReason) || handEditing !== null} onClick=${() => saveUpdate()}>
          ${saving?.phase === 'saving' ? 'Saving…' : u.reopen.length ? 'Save the other answers instead' : 'Save the round'}
        </button>
      </div>
    </div>`
  }

  // Review comments (#303): the answers are ready to save, or have been. Nothing here advances the Instance or asks for approval.
  const reviewEnd = () => {
    const r = snap?.review
    if (!r?.answered || snap?.round || snap?.clash) return null
    const pending = snap?.decisions?.pending ?? 0
    if (saving?.phase === 'saved' && saving.update) {
      const next = reviewPlan?.stages?.[0] ?? null
      return html`<div class="qcard stage-end saved" data-testid="review-saved" role="status">
        <p class="qhead">${saving.answers || saving.fields ? 'Review comments answered and saved' : 'Nothing to save'}</p>
        <p data-testid="review-saved-summary">
          ${saving.answers || saving.fields
            ? html`${saving.answers} comment${saving.answers === 1 ? '' : 's'} logged${saving.fields ? `, ${saving.fields} Field${saving.fields === 1 ? '' : 's'} changed` : ''}. The Modules stay <strong>draft</strong>: a person marks them agreed.`
            : 'Every comment was left unanswered, so nothing was written.'}
        </p>
        ${saving.answers
          ? html`<p class="kick-note" data-testid="review-rerender-nudge" role="note">
              <strong>Render again</strong> when you want the commenters to see the changes: a Save never renders the Word documents${toRenderAgain.length ? html`, so ${toRenderAgain.join(', ')} still ${toRenderAgain.length === 1 ? 'reads' : 'read'} as it did when they commented` : ''}.
              Gantry does not edit the Reviewed copy or reply to the commenters; the <strong>Review response list</strong> is what you can send them.
            </p>`
          : null}
        ${responseList.rows.length
          ? html`<div class="round-actions"><button type="button" class="btn small" data-testid="review-response-download" onClick=${downloadResponseList}>Download the Review response list (Word)</button></div>`
          : null}
        ${saving.returned.length
          ? html`<ul class="update-returned" data-testid="review-returned">
              ${saving.returned.map((e) => html`<li key=${e.id} data-module=${e.module}>${e.note}</li>`)}
            </ul>`
          : null}
        ${next && !remote
          ? html`<p class="kick-note" data-testid="review-next">
              ${next.count} more comment${next.count === 1 ? '' : 's'} on ${stageTitleOf(next.stageId)}.
              <button type="button" class="btn small primary" data-testid="review-next-button" disabled=${!onOpenStage} onClick=${() => onOpenStage?.(next.stageId)}>Next: ${stageTitleOf(next.stageId)}</button>
            </p>`
          : null}
        <div class="round-actions"><a class="btn ghost" href=${editorHref} data-testid="review-back-to-editor">Back to the editor</a></div>
      </div>`
    }
    if (phase === 'working' || phase === 'testing' || phase === 'asking') return null
    return html`<div class="qcard stage-end" data-testid="review-ready">
      <div class="qchip">Review comments</div>
      <p class="qhead">${r.total} comment${r.total === 1 ? '' : 's'} answered. Save the round?</p>
      <p>${draftKeys.length ? `${draftKeys.length} Field${draftKeys.length === 1 ? ' is' : 's are'} changed in the preview. ` : 'No Field text changes. '}${pending} answer${pending === 1 ? ' is' : 's are'} waiting in the decisions log. Saving is one Stage Save.</p>
      ${r.reopen.length
        ? html`<div data-testid="review-reopen">
            <p class="kick-note" data-testid="review-reopen-note">
              You chose to re-open ${r.reopen.map(stageTitleOf).join(', ')}, because ${r.reopen.length === 1 ? 'a Field' : 'Fields'} there can't be changed from ${instance.stage.title}. Re-opening drops the other answers in this round that are not saved: bring the review comments in again from there.
              Or save the other answers, and the comments that need ${r.reopen.map(stageTitleOf).join(', ')} stay unanswered.
            </p>
            <div class="round-actions">
              ${r.reopen.map(
                (id) => html`<button key=${id} type="button" class="btn primary" data-testid="review-reopen-button" data-stage-id=${id} disabled=${reopening.stageId !== null || saving?.phase === 'saving' || !onReopenStage} onClick=${() => reopen(id)}>
                  ${reopening.stageId === id ? 'Re-opening…' : `Re-open ${stageTitleOf(id)}`}
                </button>`
              )}
            </div>
            ${reopening.message ? html`<p class="inline-error" role="alert" data-testid="review-reopen-error">${reopening.message}</p>` : null}
          </div>`
        : null}
      ${saving?.phase === 'error' ? html`<p class="inline-error" role="alert" data-testid="review-save-error">${saving.message}</p>` : null}
      <div class="round-actions">
        <button type="button" class=${'btn' + (r.reopen.length ? '' : ' primary')} data-testid="review-save" disabled=${saving?.phase === 'saving' || Boolean(blockedReason) || handEditing !== null} onClick=${() => saveUpdate('review-answered')}>
          ${saving?.phase === 'saving' ? 'Saving…' : r.reopen.length ? 'Save the other answers instead' : 'Save the round'}
        </button>
      </div>
    </div>`
  }

  const stageEnd = () => {
    if (review) return reviewEnd()
    if (update) return updateEnd()
    if (revise) return reviseEnd()
    // #299: the Owner sent the Instance's current Stage back or rejected it: that comes before anything else this page would offer.
    if (sentBack && sentBack.stageId === instance.currentStageId) return sentBackCard()
    if (saving?.phase === 'drafting-ahead') {
      return html`<div class="qcard stage-end saved" data-testid="interview-drafting-ahead" role="status">
        <p class="qhead">Saved. Drafting ahead on ${followingStage?.title ?? 'the next Stage'}…</p>
      </div>`
    }
    if (waitingNow || (headStart?.stopped && ahead && held.length > 0)) return waitingCard()
    if (remote && awaiting && !revise) return awaitingCard()
    if (saving?.phase === 'saved' && remote) {
      // A remote Save that is not (yet) awaiting a Pull Request: queued behind an earlier Stage, refused by the Provider, or "Save and stop here".
      return html`<div class="qcard stage-end saved" data-testid="interview-saved" role="status">
        <p class="qhead">${approval.phase === 'requesting' ? 'Saved. Asking for approval…' : 'Saved'}</p>
        <p>${stage?.title ?? instance.stage.title} is saved as one Stage Save. The Modules stay <strong>draft</strong>: a person marks them agreed.</p>
        ${returnedList(saving.returned)}
        ${saving.check ? html`<p class="gate-ok" data-testid="interview-saved-gate">${saving.check.pass ? `The ${instance.stage.gate} Gate check passes.` : `The Gate check still reports: ${saving.check.outstanding?.join(', ') || 'see the editor'}.`}</p>` : null}
        ${saving.reRendered?.length ? html`<p data-testid="interview-rerendered">Re-rendered ${saving.reRendered.join(', ')} onto this Stage's branch before asking, with the approved ${saving.reRendered.length === 1 ? 'copy' : 'copies'} kept in out/approved/.</p>` : null}
        ${saving.approval === 'queued'
          ? html`<p data-testid="interview-approval-queued">Approval is queued. ${stage?.title ?? instance.stage.title} is not the Instance's current Stage, so its Pull Request opens by itself once Check status sees the earlier Stage merge.</p>`
          : null}
        ${saving.approvalError
          ? html`<p class="inline-error" role="alert" data-testid="interview-approval-error">${saving.approvalError}</p>
              <div class="round-actions"><button type="button" class="btn primary" data-testid="interview-request-approval" disabled=${approval.phase === 'requesting'} onClick=${askAgain}>Request approval</button></div>`
          : null}
        ${saving.finished && multiStage ? html`<p data-testid="interview-run-done">${stageTitleOf(target)} was the target, so the run is done.</p>` : null}
        ${!saving.approval
          ? html`<p data-testid="interview-run-paused">${saving.finished ? 'The run is done, but approval has not been asked for.' : `The run is paused here${followingStage ? `, before ${followingStage.title}` : ''}.`} A Stage moves on only when its Pull Request is approved, so ${saving.finished ? 'press Request approval to ask for approval of' : 'resuming asks for approval of'} ${stage?.title ?? instance.stage.title}${saving.finished ? '.' : ' and then waits for the Owner. You can also come back to this page later and resume from the kickoff.'}</p>
              <div class="round-actions"><button type="button" class="btn primary" data-testid="interview-request-approval" disabled=${approval.phase === 'requesting'} onClick=${askAgain}>Request approval</button></div>`
          : null}
        ${approval.message ? html`<p class="kick-note" data-testid="interview-approval-message" role="status">${approval.message}</p>` : null}
      </div>`
    }
    if (saving?.phase === 'saved') {
      return html`<div class="qcard stage-end saved" data-testid="interview-saved" role="status">
        <p class="qhead">${saving.finished && multiStage ? 'Saved. The run is done.' : 'Saved'}</p>
        <p>${stage?.title ?? instance.stage.title} is saved as one Stage Save. The Modules stay <strong>draft</strong>: a person marks them agreed.</p>
        ${returnedList(saving.returned)}
        ${saving.check ? html`<p class="gate-ok" data-testid="interview-saved-gate">${saving.check.pass ? `The ${instance.stage.gate} Gate check passes.` : `The Gate check still reports: ${saving.check.outstanding?.join(', ') || 'see the editor'}.`}</p>` : null}
        ${saving.finished && multiStage ? html`<p data-testid="interview-run-done">${stageTitleOf(target)} was the target, so the run is done.</p>` : null}
        ${!saving.finished && followingStage
          ? html`<p data-testid="interview-run-paused">The run is paused here, before ${followingStage.title}. Resume moves on to ${followingStage.title} and carries on to ${stageTitleOf(target)}. You can also come back to this page later and resume from the kickoff.</p>
              ${saving.advanceError ? html`<p class="inline-error" role="alert" data-testid="interview-advance-error">${saving.advanceError}</p>` : null}
              <div class="round-actions">
                <button type="button" class="btn primary" data-testid="interview-resume" onClick=${() => carryOn(saving)}>Resume the run</button>
              </div>`
          : null}
      </div>`
    }
    if (saving?.phase === 'advancing') {
      return html`<div class="qcard stage-end saved" data-testid="interview-advancing" role="status">
        <p class="qhead">Saved. Moving on to ${followingStage?.title ?? 'the next Stage'}…</p>
      </div>`
    }
    // Only when the Gate check passes for the Artefact aimed for and every Field in scope is done; and, after "Finish with your recommendations", once the last round has been answered.
    if (!stageEndReady) return null
    const more = target !== instance.stage.id && Boolean(followingStage)
    const busySaving = saving?.phase === 'saving' || Boolean(blockedReason) || handEditing !== null // a hand edit that is still open waits for Done (#289)
    return html`<div class="qcard stage-end" data-testid="interview-stage-end" data-run-more=${more ? 'true' : 'false'}>
      <div class="qchip">Stage</div>
      <p class="qhead">${stage?.title ?? instance.stage.title} is ready. ${remote ? 'Save and ask for approval?' : more ? 'Save and carry on?' : 'Save it?'}</p>
      <p>${draftKeys.length} Field${draftKeys.length === 1 ? '' : 's'} drafted; all ${readiness.total} Field${readiness.total === 1 ? '' : 's'} in scope are done. The ${instance.stage.gate} Gate check passes for ${readiness.gate.artefact?.title ?? 'the Artefact'}. One Save writes them; the Modules stay <strong>draft</strong>.</p>
      ${saving?.phase === 'error' ? html`<p class="inline-error" role="alert" data-testid="interview-save-error">${saving.message}</p>` : null}
      ${more
        ? html`<p class="kick-note" data-testid="interview-run-next">This run goes on to ${followingStage.title}${target === followingStage.id ? ', its target' : `, then to ${stageTitleOf(target)}`}${remote ? ' once this Stage is approved' : ''}.</p>`
        : null}
      ${remote
        ? html`<p class="kick-note" data-testid="interview-approval-note">A Stage moves on only when its Pull Request is approved by a person. ${ahead ? `Saving queues that approval: this Stage's Pull Request opens by itself once Check status sees the earlier Stage merge.` : 'Saving asks for that approval, then the session waits for the Owner.'} The AI never passes a gate.</p>`
        : null}
      ${earlierToRender.length
        ? html`<p class="kick-note rerender-note" data-testid="interview-rerender-note">${reRenderCardLine(earlierToRender)} The approved copies are kept in out/approved/. Choosing <strong>Save and stop here</strong> saves the content and leaves the documents as they are.</p>`
        : null}
      <div class="round-actions">
        ${remote
          ? html`<button type="button" class="btn primary" data-testid="interview-save-approval" disabled=${busySaving} onClick=${() => saveStage('approval')}>
              ${saving?.phase === 'saving' ? 'Saving…' : more ? 'Save, request approval, draft ahead' : 'Save and request approval'}
              <span class="rec">RECOMMENDED</span>
            </button>`
          : more
            ? html`<button type="button" class="btn primary" data-testid="interview-save-advance" disabled=${busySaving} onClick=${() => saveStage('advance')}>
                ${saving?.phase === 'saving' ? 'Saving…' : 'Save, advance, carry on'}
                <span class="rec">RECOMMENDED</span>
              </button>`
            : null}
        <button type="button" class=${'btn' + (more || remote ? ' ghost' : ' primary')} data-testid="interview-save" disabled=${busySaving} onClick=${() => saveStage('stop')}>
          ${saving?.phase === 'saving' && !more && !remote ? 'Saving…' : more || remote ? 'Save and stop here' : multiStage ? 'Save and finish the run' : 'Save and stop here'}
        </button>
      </div>
    </div>`
  }

  const preview = () => {
    if (setup.status === 'loading') return html`<p class="loading">Loading…</p>`
    if (setup.status === 'error') return html`<p class="inline-error" role="alert">${setup.message}</p>`
    const size = effectiveTargetSize(instance.size)
    return html`
      <div class="qchip preview-chip">Live draft · ${stage?.title ?? instance.stage.title}${snap?.drafting ? html` <span class="drafting" data-testid="interview-drafting">drafting<span class="caret"></span></span>` : null}</div>
      ${stageModules.map((mod) => {
        const entry = instance.modules.find((m) => m.id === mod.id)
        return html`<section key=${mod.id} class="preview-module" data-module=${mod.id}>
          <h4>${mod.title ?? mod.id}</h4>
          ${(mod.fields ?? []).map((field) => {
            const fieldKey = `${mod.id}.${field.id}`
            const draft = drafts[fieldKey]
            const savedValue = entry?.fields?.find((f) => f.id === field.id)?.value
            const budget = fieldTargetWords(field, size)
            // #289: a drafted Field is edited in place; one the AI is drafting right now shows "drafting…" and waits for its draft.
            const drafting = (snap?.draftingFields ?? []).includes(fieldKey)
            const open = handEditing?.key === fieldKey && Boolean(draft)
            const editable = Boolean(draft) && !drafting && !open && !blockedReason
            return html`<div key=${fieldKey} class="field-proto" data-testid="interview-field" data-field-key=${fieldKey} data-state=${draft ? 'draft' : isBlankValue(savedValue) ? 'empty' : 'saved'} data-drafting=${drafting ? 'true' : 'false'} data-hand-edited=${draft?.handEdited ? 'true' : 'false'}>
              <span class="field-label">${field.title ?? field.id}
                ${draft && !draft.handEdited ? html`<span class="ai-mark" data-testid="interview-ai-mark">AI draft · unsaved</span>` : null}
                ${draft?.handEdited ? html`<span class="ai-mark hand-mark" data-testid="interview-hand-mark">Your edit · unsaved</span>` : null}
                ${flagsForField(outOfDate, fieldKey).length ? html`<span class="ai-mark ood-mark" data-testid="interview-field-out-of-date">Out of date</span>` : null}
                ${drafting ? html`<span class="ai-mark drafting-mark" data-testid="interview-field-drafting">drafting…</span>` : null}
                ${draft && budget !== null ? html`<span class="field-words" title=${`${targetSizeLabel(size)} target`}>${draft.words} / ~${budget} words</span>` : null}
                ${editable ? html`<button type="button" class="btn small ghost hand-edit-open" data-testid="interview-field-edit" onClick=${() => openHandEdit(fieldKey)}>Edit</button>` : null}
              </span>
              ${open
                ? html`<${HandEditor} field=${field} value=${draft.value} error=${handEditing.error} onDone=${(text) => finishHandEdit(fieldKey, text)} onCancel=${() => closeHandEdit(fieldKey)} />`
                : html`<div
                    class=${'value' + (draft ? ' ai' : isBlankValue(savedValue) ? ' empty' : '') + (editable ? ' hand-editable' : '') + (draft?.handEdited ? ' hand-edited' : '')}
                    data-testid="interview-field-value"
                    title=${editable ? 'Click to edit' : undefined}
                    onClick=${editable ? (e) => !e.target.closest?.('.cite') && openHandEdit(fieldKey) : undefined}
                  >
                    ${draft ? html`<${ValueView} value=${draft.value} />` : drafting ? 'drafting…' : isBlankValue(savedValue) ? 'Empty' : html`<${ValueView} value=${savedValue} />`}
                  </div>`}
              ${draft?.inputs?.length
                ? html`<p class="field-inputs" data-testid="interview-field-inputs">Drew on: ${draft.inputs.map(describeInput).join('; ')}</p>`
                : null}
              ${readiness?.fields?.[fieldKey]
                ? html`<span class=${'field-done' + (readiness.fields[fieldKey].done ? ' is-done' : '')} data-testid="interview-field-done" data-done=${readiness.fields[fieldKey].done ? 'true' : 'false'}>
                    ${readiness.fields[fieldKey].done ? '✓ Done' : `Not done: ${readiness.fields[fieldKey].reasons.join('; ')}`}
                  </span>`
                : null}
              ${draft?.warnings?.length
                ? html`<ul class="interview-warnings" data-testid="interview-warning">${draft.warnings.map((w, i) => html`<li key=${i} class="warn">${w}</li>`)}</ul>`
                : null}
            </div>`
          })}
        </section>`
      })}
      ${draftKeys.length && gate
        ? html`<p class=${'gate-line' + (gate.pass ? ' gate-ok' : '')} data-testid="interview-gate-line">
            Gate check (${gate.artefact?.title ?? 'no Artefact'}): ${gate.pass ? 'passes' : `not yet. Outstanding: ${gate.outstanding.join(', ') || 'see the editor'}`}${readiness ? `. ${readiness.doneCount} of ${readiness.total} Field${readiness.total === 1 ? '' : 's'} in scope done` : ''}
          </p>`
        : null}
    `
  }

  return html`
    <div class="interview-page" data-testid="interview-page">
      <aside class="interview-rail">
        <a class="btn small ghost" href=${editorHref} data-testid="interview-back">← Editor</a>
        <div class="interview-instance">${instance.name || instance.slug}</div>
        <div class="cite">${instance.stage.title} (gate: ${instance.stage.gate})</div>
        <div data-testid="run-plan">
          <h3 class="side">Run plan</h3>
          <ol class="runplan">
            ${planRowsNow.map(
              (row) => html`<li
                key=${row.id}
                class=${`rp-${row.state}${row.target ? ' rp-target' : ''}${row.checkable ? ' rp-checkable' : ''}`}
                data-testid="run-plan-row"
                data-stage-id=${row.id}
                data-state=${row.state}
                data-target=${row.target ? 'true' : 'false'}
                role=${row.checkable ? 'button' : undefined}
                tabindex=${row.checkable ? 0 : undefined}
                title=${row.checkable ? 'Check status: has the Owner approved this Stage?' : undefined}
                onClick=${row.checkable ? () => checkApproval() : undefined}
                onKeyDown=${row.checkable ? (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), checkApproval()) : undefined}
              >
                <span class="dot"></span><span class="rp-title">${row.title}</span>
                ${row.outOfDate
                  ? html`<span class="rp-ood" data-testid="run-plan-out-of-date" title="Fields on this Stage drew on a Source document that has since changed">${row.outOfDate} Out of date</span>`
                  : null}
                ${row.changedSinceApproval
                  ? html`<span class="rp-ood rp-changed" data-testid="run-plan-changed-since-approval" title=${`${fieldCountLabel(row.changedSinceApproval.count)} this Stage's documents print changed after it was approved. The current Stage's approval re-approves it.`}>changed since approval</span>`
                  : null}
                ${rowTokens(row.id)}
                <span class="rp-note">${row.note}</span>
                ${row.pullRequest
                  ? row.pullRequest.url
                    ? html`<a class="rp-pr" href=${row.pullRequest.url} target="_blank" rel="noopener noreferrer" data-testid="run-plan-pr-link" onClick=${(e) => e.stopPropagation()}>Pull Request #${row.pullRequest.id}</a>`
                    : html`<span class="rp-pr" data-testid="run-plan-pr-link">Pull Request #${row.pullRequest.id}</span>`
                  : null}
              </li>`
            )}
          </ol>
        </div>
        ${tokensRail()}
        <h3 class="side">Source documents</h3>
        <${SourceDocumentsPanel} store=${store} actor=${actor} readOnly=${Boolean(blockedReason)} compact=${true} onList=${onSourceList} newSince=${newSinceIds} />
        ${setup.status === 'ready' ? reviewRail() : null}
        ${decisionsRail()}
        ${inputsLog()}
      </aside>

      <section class="interview-convo">
        <div class="interview-head">
          <strong>✦ AI interview</strong>
          ${started
            ? html`<select class="interview-switch" data-testid="interview-switch" aria-label="AI Provider" disabled=${busy} value=${snap?.providerId} onChange=${(e) => switchProvider(e.currentTarget.value)}>
                ${providers.map((p) => html`<option key=${p.id} value=${p.id} selected=${p.id === snap?.providerId}>${providerLabel(p)}</option>`)}
              </select>`
            : null}
          ${started ? html`<span class="mode-chip" data-testid="interview-mode" data-mode=${snap?.cardMode} title="How the AI asks its questions: a native tool call, then text, then plain chat.">Cards: ${MODE_LABELS[snap?.cardMode] ?? 'native'}</span>` : null}
          ${switchMessage ? html`<span class="inline-error" role="alert" data-testid="interview-switch-error">${switchMessage}</span>` : null}
          ${citeMessage ? html`<span class="inline-error" role="alert" data-testid="interview-cite-error">${citeMessage}</span>` : null}
        </div>
        <div class="interview-thread" data-testid="interview-thread" ref=${threadRef}>
          <div class="inner">
            ${setup.status === 'loading' ? html`<p class="loading">Loading…</p>` : null}
            ${setup.status === 'error' ? html`<p class="inline-error" role="alert">${setup.message}</p>` : null}
            ${setup.status === 'ready' && !started && !(remote && awaiting && !revise) && !(waitingNow && phase === 'kickoff') && !(sentBack && sentBack.stageId === instance.currentStageId && !revise) ? kickoff() : null}
            ${setup.status === 'ready' && started ? thread() : null}
            ${setup.status === 'ready' && started ? compactOfferCard() : null}
            ${setup.status === 'ready' && started ? roundView() : null}
            ${setup.status === 'ready' && started ? clashView() : null}
            ${setup.status === 'ready' ? pausedView() : null}
            ${saving?.phase === 'error' && saving.pause ? html`<p class="inline-error" role="alert" data-testid="interview-pause-error">${saving.message}</p>` : null}
            ${copyRestored && phase !== 'kickoff' ? html`<p class="kick-note" data-testid="interview-copy-restored">Picked up from the working copy this browser kept.</p>` : null}
            ${recovery
              ? html`<${AiRecoveryPrompt}
                  kind=${recovery.kind}
                  message=${recovery.message}
                  onKey=${(newKey) => {
                    updateAiProvider(snap?.providerId ?? providerId, { key: newKey })
                    recovery.resolve(true)
                    setRecovery(null)
                  }}
                  onRetry=${() => {
                    recovery.resolve(true)
                    setRecovery(null)
                  }}
                  onCancel=${() => {
                    recovery.resolve(false)
                    setRecovery(null)
                  }}
                />`
              : null}
            ${phase === 'error' && !recovery
              ? html`<div class="interview-error" role="alert" data-testid="interview-error">
                  <p class="inline-error">${snap.error?.message}</p>
                  <button type="button" class="btn small primary" data-testid="interview-retry" onClick=${() => sessionRef.current?.retry()}>Try again</button>
                  <span class="muted"> or switch AI Provider above.</span>
                </div>`
              : null}
            ${started
              ? html`<div class="interview-status" role="status" aria-live="polite" aria-atomic="false">
                  ${status
                    ? html`<p class="msg sys" data-testid="interview-status" data-activity=${status.kind}>
                        <span data-testid="interview-status-text">${status.text}</span>${status.detail ? html` <span class="status-detail" data-testid="interview-status-detail" aria-hidden="true">${status.detail}</span>` : null}<span class="caret"></span>
                      </p>`
                    : carryOnAt !== null
                      ? html`<span class="visually-hidden" data-testid="interview-carry-on-announce">${snap.thread.find((t) => t.id === carryOnAt).text} Choose Carry on to let it continue.</span>`
                      : null}
                </div>`
              : null}
            ${reopening.message && !update ? html`<p class="inline-error" role="alert" data-testid="interview-reopen-error">${reopening.message}</p>` : null}
            ${reopening.stageId && !update ? html`<p class="msg sys" data-testid="interview-reopening" role="status">Re-opening ${stageTitleOf(reopening.stageId)}…</p>` : null}
            ${stageEnd()}
          </div>
        </div>
        <div class="interview-composer">
          ${started && phase !== 'paused' && !update && !review && !revise
            ? html`<div class="inner composer-actions">
                <button type="button" class="btn small ghost" data-testid="interview-pause" disabled=${busy || phase === 'kickoff' || saving?.phase === 'saving' || Boolean(blockedReason) || Boolean(snap?.clash)} title="Save the decisions log and the drafts so far, then carry on later in this browser or any other. The Modules stay draft." onClick=${pauseInterview}>
                  ${saving?.phase === 'saving' && saving.pause ? 'Pausing…' : 'Pause'}
                </button>
                <button type="button" class="btn small ghost" data-testid="interview-finish" disabled=${busy || phase === 'kickoff'} title="Accept every recommendation, then answer one last round about only what the AI can't responsibly propose." onClick=${finishNow}>
                  Finish with your recommendations
                </button>
              </div>`
            : null}
          <div class="inner chatbox">
            <textarea
              data-testid="interview-chat"
              aria-label="Tell the AI anything"
              placeholder=${started ? 'Tell the AI anything — "the budget is capped at $1.2M", "leave out Finance"…' : 'Start the interview to chat with the AI.'}
              disabled=${!started || busy || phase === 'paused'}
              value=${chat}
              onInput=${(e) => setChat(e.currentTarget.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendChat()
                }
              }}
            ></textarea>
            <button type="button" class="btn small" data-testid="interview-send" disabled=${!started || busy || phase === 'paused' || !chat.trim()} onClick=${sendChat}>Send</button>
          </div>
        </div>
      </section>

      <aside class="interview-preview" data-testid="interview-preview">${preview()}</aside>
      ${connecting ? html`<${AiProviderDialog} provider=${null} onClose=${() => setConnecting(false)} />` : null}
    </div>
  `
}
