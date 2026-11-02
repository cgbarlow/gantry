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
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { isMultiValuedField } from './fieldShape.js'
import { aiProviders, defaultAiProvider, updateAiProvider } from './aiProviders.js'
import { AiProviderDialog, AiRecoveryPrompt } from './aiProvidersView.js'
import { SourceDocumentsPanel } from './sourceDocumentsPanel.js'
import { artefactChoices, createInterviewSession } from './interviewSession.js'
import { stageReadiness } from './interviewReadiness.js'
import { PAGE_SIZE, isAnswered, pageCards, pageCount } from './interviewRounds.js'
import { loadInterviewSkillsInBrowser } from './interviewSkills.js'
import { modulesWithStandard } from './standardModules.js'
import { citationSegments, isBlankValue } from './interviewDraft.js'
import { describeInput, planSourceAccess } from './interviewSources.js'
import { effectiveTargetSize, fieldTargetWords, targetSizeLabel } from './targetSize.js'
import { logSummary } from './decisionsLog.js'
import { outOfDateCountByStage } from './outOfDate.js'
import { beginRun, clearRun, interviewRuns, nextStage, planRows, resumableRun, runStartStage, runTargets, saveOutcome, updateRun } from './interviewRun.js'
import { EMPTY_TOKENS, addTokens, formatTokens, hasTokens, tokenBreakdown, tokensOfLog, totalTokens } from './tokenUsage.js'
import { describeSaved, resumeInfo } from './interviewResume.js'
import { isRemoteInstance, lastSavedBy, openApproval, remoteRecord } from './interviewApproval.js'
import { approvedPrintedFields, changedMark, earlierDocumentsToRender, reRenderCardLine } from './interviewReapproval.js'
import { fieldCountLabel } from './changedSinceApproval.js'
import { copyStanding, createWorkingCopyStore, makeWorkingCopy } from './interviewWorkingCopy.js'
import { heldModules, isDraftingAhead, withHeldModules } from './draftAhead.js'
import { fieldsInScope } from './interviewScope.js'

// One session per Instance Stage while the editor page is open, so going to the editor and back keeps the conversation and the drafts.
const sessions = new Map()
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

const MODE_LABELS = { native: 'native', text: 'text fallback', chat: 'plain chat' }

/** One question card: header chip, the Field it feeds, the question, option tiles, "Why I recommend it" with its citation, and Other where it applies. */
function QuestionCard({ card, fieldTitle, session }) {
  const type = card.multiSelect ? 'checkbox' : 'radio'
  const recommended = new Set(card.recommended)
  return html`<div class="qcard" data-testid="interview-card" data-card-id=${card.id} data-card-type=${card.type ?? 'question'} data-card-kind=${card.kind ?? ''}>
    <div class="qchip">
      ${card.header || (card.type === 'change' ? 'Saved content' : card.kind === 'term' ? 'Preferred term' : card.kind === 'decision' ? 'Key decision' : 'Question')}${card.multiSelect ? ' · choose any' : ''}
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
 */
// #297: `outOfDate` is the Fields flagged Out of date (web/lib/outOfDate.js) and `newSince` the documents marked New since last interview; the run plan marks each Stage that has flagged Fields and the Source documents rail marks the new documents.
export function InterviewPage({ instance, store, actor = '', editorHref, blockedReason = '', loadStructure, loadOtherSaved, decisionsStore, onSaveDrafts, onAdvance, checkStatus = null, onRequestApproval, onReRenderEarlier = null, onCheckApproval, onDraftAhead, outOfDate = [], newSince = [] }) {
  const key = `${instance.slug}|${instance.stage.id}`
  // #295: on an Azure DevOps or GitHub workspace a Stage moves on only when its Pull Request merges, so the stage-end card asks for approval instead of advancing.
  const remote = isRemoteInstance(instance)
  const awaiting = openApproval(instance) // the Pull Request the Provider says is open for this Stage, else null: it overrides what the log says
  const [approval, setApproval] = useState({ phase: 'idle', message: '' })
  const [headStart, setHeadStart] = useState(null) // #296: the head start saved from the Waiting card: { fields, stopped }
  const lastHeld = useRef({ key: '', list: [] }) // the Modules held when the AI was last told about them (#296)
  const [setup, setSetup] = useState({ status: 'loading' })
  const [sources, setSources] = useState(null)
  const [snap, setSnap] = useState(null)
  // #293: the run in this tab for this Instance, if any. A run that has carried on into this Stage starts it by itself.
  const run = interviewRuns.value[instance.slug] ?? null
  const carryingOn = run?.carryOn === instance.stage.id
  const [pickedProvider, setPickedProvider] = useState(carryingOn ? run.providerId ?? null : null)
  const [pickedArtefact, setPickedArtefact] = useState(null)
  const [pickedTarget, setPickedTarget] = useState(carryingOn ? run.target : null)
  const [resumeLogs, setResumeLogs] = useState(null) // the committed logs of this Stage and the one before it, which say whether a run was left part-way
  const [resumeMessage, setResumeMessage] = useState('')
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

  const choices = useMemo(() => (setup.status === 'ready' ? artefactChoices(setup.definition, instance.stage.id) : { candidates: [], lightest: null }), [setup, instance.stage.id])
  const artefactId = pickedArtefact ?? choices.lightest?.id ?? null

  // #293: the run's target Stage ("Run until"). The current Stage when no other is picked, which is a run of one Stage.
  const stagesList = instance.stages ?? []
  const targets = runTargets(stagesList, instance.stage.id)
  // #295: a session that opens on a Stage already awaiting approval has no picker to read, so its run target is the one the log recorded.
  const loggedTarget = awaiting && Array.isArray(committedLog?.status) && committedLog.status.length ? committedLog.status[committedLog.status.length - 1].target : null
  const wantedTarget = pickedTarget ?? (targets.some((t) => t.id === loggedTarget) ? loggedTarget : null)
  const target = targets.some((t) => t.id === wantedTarget) ? wantedTarget : instance.stage.id
  const followingStage = nextStage(stagesList, instance.stage.id)

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
            return resumeInfo({
              logs: { ...setup.logs, [instance.stage.id]: committedLog },
              stageId: instance.stage.id,
              stageTitle: instance.stage.title,
              actor,
              providerStates: setup.providerStates,
              stages: setup.structure.stages ?? [],
              fieldTitle: (fieldKey) => fieldLabel(setup.definition, fieldKey),
            })
          },
          actor,
          targetStageId: target,
          instructionsVersion: `${setup.definition.id ?? instance.definition}@${instance.definitionVersion ?? setup.structure.version ?? 1}`,
          // #292: a picture, or a scanned or "Read visually" PDF, is sent as the original; the session reads it when it builds a request.
          readOriginal: async (id) => (await store.readOriginal(id)).bytes ?? null,
        }
      : null

  // ---- the session ----
  function ask(kind) {
    return (err) => new Promise((resolve) => setRecovery({ kind, message: err.message, resolve }))
  }
  useEffect(() => {
    if (setup.status !== 'ready') return undefined
    let session = sessions.get(key)
    const fresh = !session
    if (fresh) {
      session = createInterviewSession({ providerId })
      sessions.set(key, session)
    }
    sessionRef.current = session
    // #290: every stable moment, the browser keeps a working copy of the unsaved session, so closing the tab loses nothing.
    const keepCopy = (snapshot) => {
      setSnap(snapshot)
      if (session.canKeepCopy) {
        const known = session.knownLog()
        workingCopies.save(key, makeWorkingCopy({ state: session.exportState(), committedIds: known.committedIds, lastAiSave: known.lastAiSave }))
      }
    }
    session.bind({ getContext: () => ctxRef.current, handlers: { askForKey: ask('key'), askToRetry: ask('retry') }, onChange: keepCopy })
    if (fresh) {
      // The same browser resumes exactly where it stopped, unless the committed log has moved on since the copy began: then the
      // committed log wins and the copy is set aside, with a notice.
      const copy = workingCopies.load(key)
      if (copy) {
        const standing = copyStanding(copy, setup.logs?.[instance.stage.id] ?? null)
        if (standing === 'fresh') session.loadDecisions(setup.logs?.[instance.stage.id] ?? null)
        if (standing === 'fresh' && session.importState(copy.state)) setCopyRestored(true)
        else {
          workingCopies.setAside(key, copy, standing)
          setAsideNotice({ savedAt: copy.savedAt })
        }
      }
    }
    return () => session.bind({ onChange: null })
  }, [key, setup.status])

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
  const resuming = resumeNow?.resuming ? resumeNow : null
  const started = phase !== 'kickoff' && phase !== 'testing'
  const busy = phase === 'working' || phase === 'testing'
  const finishing = snap?.finish === 'accepting' || snap?.finish === 'final'
  const stage = setup.status === 'ready' ? definitionNow.stages.find((s) => s.id === instance.stage.id) : null
  const readOnlyIds = new Set(stage?.readOnlyModules ?? [])
  const stageModules = stage ? stage.modules.map((id) => setup.definition.modules.find((m) => m.id === id)).filter((m) => m && !readOnlyIds.has(m.id)) : []

  // ---- the run (#293) ----
  const providerInUse = snap?.providerId ?? providerId
  const runStart = run?.startStageId ?? instance.stage.id // the Stage this run began on
  const multiStage = stagesList.findIndex((st) => st.id === target) > stagesList.findIndex((st) => st.id === runStart) // more than one Stage in the run
  const stageEndReady = phase === 'waiting' && draftKeys.length > 0 && Boolean(readiness?.ready) && !snap?.round && !finishing
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
  // #294: tokens, from what each AI Provider reported. A Stage's total is every session's status line in its committed log, except this
  // session's own (it is counted in full from memory, so its older committed line is not added twice). The session total is this run:
  // the Stages it went through before this one (from their logs) and what this session has used on this one.
  const mineHere = snap?.tokens ?? EMPTY_TOKENS
  const stageTokens = (id) => (id === instance.stage.id ? addTokens(tokensOfLog(stageLogs[id], { exceptSession: snap?.decisions?.session }), mineHere) : tokensOfLog(stageLogs[id]))
  const currentAt = stagesList.findIndex((st) => st.id === instance.stage.id)
  const runStartAt = Math.max(0, Math.min(currentAt, stagesList.findIndex((st) => st.id === runStart)))
  const sessionTokens = stagesList.slice(runStartAt, currentAt).reduce((sum, st) => addTokens(sum, tokensOfLog(stageLogs[st.id])), mineHere)
  const thisStageTokens = stageTokens(instance.stage.id)
  const resume = resumeLogs && !carryingOn && phase === 'kickoff' ? resumableRun({ stages: stagesList, currentStageId: instance.stage.id, logs: resumeLogs, openPullRequests: remoteRows?.pullRequests ?? {} }) : null
  const stageTitleOf = (id) => stagesList.find((s) => s.id === id)?.title ?? id

  async function startInterview(options) {
    // A run of one Stage is still a run: its plan and its status block say where it stands. A Stage the run carried on into carries on the same run.
    const sameRun = run && run.phase === 'running' && run.target === target
    if (carryingOn) updateRun(instance.slug, { carryOn: null, at: instance.stage.id })
    else beginRun(instance.slug, { target, startStageId: sameRun ? run.startStageId : instance.stage.id, providerId: providerInUse, at: instance.stage.id })
    await sessionRef.current?.start(options)
  }

  // #295: a session that opens on a Stage with a Pull Request already open runs Check status once, so what the Provider says (merged,
  // still waiting, sent back) overrides what the log last recorded. A page that was open when the request was made does not: it knows.
  const openedAwaiting = useRef(awaiting !== null)
  useEffect(() => {
    if (remote && openedAwaiting.current && !carryingOn && onCheckApproval) checkApproval({ carry: false })
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
    autoStarted.current = true
    startInterview()
  }, [carryingOn, setup.status, sources, snap?.phase, providerId])

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
    if (resume.mode === 'advance' && remote) {
      // #295: a remote Stage was saved but its approval never asked for (Save and stop here, or the request failed): resuming asks for it, then the session waits for the Owner.
      const startStageId = runStartStage(stagesList, resumeLogs?.[resume.fromStageId], resume.fromStageId)
      beginRun(instance.slug, { target: resume.targetStageId, startStageId, providerId, at: instance.stage.id })
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
    beginRun(instance.slug, { target: resume.targetStageId, startStageId, providerId, at: instance.stage.id, carryOn: follow ? follow.id : instance.stage.id })
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
      workingCopies.clear(key) // everything the working copy held is saved
      if (pause) {
        sessionRef.current?.markPaused()
        updateRun(instance.slug, { phase: 'paused', at: instance.stage.id })
        setSaving({ phase: 'paused', fields: keys.length })
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
      const saved = { phase: 'saved', check: result.check ?? null, finished: outcome.finished, approval: outcome.requestsApproval ? (queued ? 'queued' : 'requested') : null, willReRender }
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

  // Opens the page afresh from the saved log and content, as it would be in any browser (#290).
  function resumeAfterPause() {
    sessions.delete(key)
    workingCopies.clear(key)
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
      else beginRun(instance.slug, { target, startStageId: instance.stage.id, providerId: providerInUse, at: instance.stage.id, carryOn: followingStage.id })
    }
    let result
    try {
      result = await onCheckApproval()
    } catch (err) {
      result = { ok: false, merged: false, message: err.message }
    }
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
    else beginRun(instance.slug, { target, startStageId: instance.stage.id, providerId: providerInUse, at: instance.stage.id, carryOn: followingStage.id })
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
        <p class="kick-intro">
          The AI reads this Instance's Source documents, drafts the Fields they support, then talks them through with you. Nothing is saved
          until you confirm the Stage, and it never passes a Gate that needs approval or review.
        </p>
        ${blockedReason ? html`<p class="inline-error" role="alert" data-testid="interview-blocked">${blockedReason}</p>` : null}
        ${held.length
          ? html`<p class="kick-note" data-testid="interview-head-start-note">This Stage is drafted ahead of ${pendingTitles.join(' and ')}, which awaits approval, so the AI gets a head start only: it drafts the Modules no pending Stage mounts. Held until then: ${held.map((h) => setup.definition.modules.find((m) => m.id === h.id)?.title ?? h.id).join(', ')}.</p>`
          : null}
        ${asideNotice
          ? html`<div class="warn" role="status" data-testid="interview-copy-aside">
              A copy of unsaved work kept in this browser${asideNotice.savedAt ? ` (${new Date(asideNotice.savedAt).toLocaleString()})` : ''} was set aside, because this Stage's decisions log has been saved since it began. The saved log and content are what this interview carries on from.
              <button type="button" class="btn small ghost" data-testid="interview-copy-aside-dismiss" onClick=${() => { workingCopies.clearAside(key); setAsideNotice(null) }}>Dismiss</button>
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

        ${choices.candidates.length > 1
          ? html`<label for="interview-artefact">Artefact to aim for</label>
            <select id="interview-artefact" data-testid="interview-artefact" onChange=${(e) => setPickedArtefact(e.currentTarget.value)}>
              ${choices.candidates.map((a) => html`<option key=${a.id} value=${a.id} selected=${a.id === artefactId}>${a.title ?? a.id}${a.id === choices.lightest?.id ? ' (lightest)' : ''}</option>`)}
            </select>
            <p class="kick-note">More than one Artefact can pass this Stage's Gate. The lightest is pre-selected; the AI drafts what the one you choose requires.</p>`
          : null}

        ${targets.length > 1
          ? html`<label for="interview-run-until">Run until</label>
            <select id="interview-run-until" data-testid="interview-run-until" onChange=${(e) => setPickedTarget(e.currentTarget.value)}>
              ${targets.map((t) => html`<option key=${t.id} value=${t.id} selected=${t.id === target}>${t.title}${t.id === instance.stage.id ? ' (this Stage only)' : ''} (gate: ${t.gate})</option>`)}
            </select>
            <p class="kick-note" data-testid="interview-run-until-note">
              ${target === instance.stage.id
                ? 'The interview covers this Stage only. Pick a later Stage to carry on into it: the run plan on the left shows the Stages in order.'
                : `The AI drafts each Stage in order, up to and including ${stageTitleOf(target)}, and you confirm each one. A Stage is never skipped. Later Stages aim for their lightest Artefact.`}
            </p>`
          : null}

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
        <button
          type="button"
          class="btn primary"
          data-testid="interview-start"
          disabled=${!providerId || phase === 'testing' || sources === null || Boolean(blockedReason) || !snap || Boolean(snap?.sessionWarning)}
          onClick=${() => startInterview()}
        >
          ${phase === 'testing' ? PROGRESS_LABELS[snap?.testStep] ?? 'Testing the AI Provider…' : resuming ? 'Resume interview' : 'Start interview'}
        </button>
      </div>
    `
  }

  const thread = () =>
    (snap?.thread ?? []).map(
      (m) => html`<div key=${m.id} class=${`msg ${m.who}${m.streaming ? ' streaming caret' : ''}`} data-testid="interview-msg" data-who=${m.who}>${m.text}</div>`
    )

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
          ? html`<div class="dl-restart" data-testid="interview-restart-confirm" role="alert">
              <p class="kick-note">Start over: the AI ignores every earlier answer from now on. Saved content is not touched, and the log keeps what was said before.</p>
              <button type="button" class="btn small" data-testid="interview-restart-yes" onClick=${() => { sessionRef.current?.startOver(); clearRun(instance.slug); setConfirmRestart(false); setSaving(null) }}>Start this stage over</button>
              <button type="button" class="btn small ghost" onClick=${() => setConfirmRestart(false)}>Keep going</button>
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
        ${round.final ? 'Last round' : `Round ${round.id}`} · ${round.cards.length} question${round.cards.length === 1 ? '' : 's'}
        ${total > 1 ? ` · cards ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + shown.length} of ${round.cards.length}` : ''}
      </div>
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

  // Pause saved the decisions log and the drafts so far (#290): this run stops here, and carries on from them in any browser.
  const pausedView = () => {
    if (phase !== 'paused') return null
    return html`<div class="qcard stage-end saved" data-testid="interview-paused" role="status">
      <p class="qhead">Paused</p>
      <p>
        ${saving?.fields ? `${saving.fields} Field${saving.fields === 1 ? '' : 's'} and the decisions log are saved as one Save. ` : 'The decisions log is saved. '}The Modules stay <strong>draft</strong>.
        Open the Interview page on this Instance again, in this browser or any other, and the AI recaps from the log and carries on. The earlier conversation is not kept.
      </p>
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

  const stageEnd = () => {
    if (saving?.phase === 'drafting-ahead') {
      return html`<div class="qcard stage-end saved" data-testid="interview-drafting-ahead" role="status">
        <p class="qhead">Saved. Drafting ahead on ${followingStage?.title ?? 'the next Stage'}…</p>
      </div>`
    }
    if (waitingNow || (headStart?.stopped && ahead && held.length > 0)) return waitingCard()
    if (remote && awaiting) return awaitingCard()
    if (saving?.phase === 'saved' && remote) {
      // A remote Save that is not (yet) awaiting a Pull Request: queued behind an earlier Stage, refused by the Provider, or "Save and stop here".
      return html`<div class="qcard stage-end saved" data-testid="interview-saved" role="status">
        <p class="qhead">${approval.phase === 'requesting' ? 'Saved. Asking for approval…' : 'Saved'}</p>
        <p>${stage?.title ?? instance.stage.title} is saved as one Stage Save. The Modules stay <strong>draft</strong>: a person marks them agreed.</p>
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
        </div>
        <div class="interview-thread" data-testid="interview-thread" ref=${threadRef}>
          <div class="inner">
            ${setup.status === 'loading' ? html`<p class="loading">Loading…</p>` : null}
            ${setup.status === 'error' ? html`<p class="inline-error" role="alert">${setup.message}</p>` : null}
            ${setup.status === 'ready' && !started && !(remote && awaiting) && !(waitingNow && phase === 'kickoff') ? kickoff() : null}
            ${setup.status === 'ready' && started ? thread() : null}
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
            ${busy && started && snap?.preparing ? html`<p class="msg sys" data-testid="interview-preparing">Preparing questions<span class="caret"></span></p>` : null}
            ${busy && started && !snap?.drafting && !snap?.preparing && !(snap.thread[snap.thread.length - 1]?.streaming) ? html`<p class="msg sys" data-testid="interview-working">Working<span class="caret"></span></p>` : null}
            ${stageEnd()}
          </div>
        </div>
        <div class="interview-composer">
          ${started && phase !== 'paused'
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
