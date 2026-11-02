// #286 (parent #238, docs/adr/0061 and 0065; layout B of #243): the **Interview page** — the AI interview for the current
// Stage of a local or server workspace Instance. Left rail: the Source documents. Centre: the conversation, with the
// kickoff form first and the free-chat composer pinned at the bottom. Right: the live draft preview of the Stage's Modules,
// where the AI's drafts appear as they are written, marked "AI draft · unsaved".
//
// This file only draws the page and wires it up. The conversation, the drafting and the checks on each draft are
// web/lib/interviewSession.js; "is this Stage ready" is web/lib/interviewGate.js; the brief the AI is given is
// web/lib/interviewBrief.js. Saving is the editor's own stage Save (the Save check of ADR-0068 and all), handed in as
// `onSaveDrafts`, so a Save from here is the same Save, one commit, with the Modules left `draft`.
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { aiProviders, defaultAiProvider, updateAiProvider } from './aiProviders.js'
import { AiProviderDialog, AiRecoveryPrompt } from './aiProvidersView.js'
import { SourceDocumentsPanel } from './sourceDocumentsPanel.js'
import { artefactChoices, createInterviewSession } from './interviewSession.js'
import { draftGateCheck } from './interviewGate.js'
import { loadInterviewSkillsInBrowser } from './interviewSkills.js'
import { modulesWithStandard } from './standardModules.js'
import { citationSegments, isBlankValue } from './interviewDraft.js'
import { effectiveTargetSize, fieldTargetWords, targetSizeLabel } from './targetSize.js'

// One session per Instance Stage while the editor page is open, so going to the editor and back keeps the conversation and the drafts.
const sessions = new Map()
export function clearInterviewSessions() {
  for (const session of sessions.values()) session.cancel()
  sessions.clear()
}
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
 *   onSaveDrafts    (drafts, { artefactId }) => { ok, message?, check? }  puts the drafts in the Modules and does the stage Save
 */
export function InterviewPage({ instance, store, actor = '', editorHref, blockedReason = '', loadStructure, loadOtherSaved, onSaveDrafts }) {
  const key = `${instance.slug}|${instance.stage.id}`
  const [setup, setSetup] = useState({ status: 'loading' })
  const [sources, setSources] = useState(null)
  const [snap, setSnap] = useState(null)
  const [pickedProvider, setPickedProvider] = useState(null)
  const [pickedArtefact, setPickedArtefact] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [recovery, setRecovery] = useState(null)
  const [switchMessage, setSwitchMessage] = useState('')
  const [chat, setChat] = useState('')
  const [saving, setSaving] = useState(null)
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
    Promise.all([loadStructure(), loadSkills(), loadOtherSaved().catch(() => [])])
      .then(([structure, skills, otherSaved]) => {
        if (cancelled) return
        const definition = { ...structure, modules: modulesWithStandard(structure.modules, structure.standardModules) }
        setSetup({ status: 'ready', structure, definition, skills, otherSaved })
      })
      .catch((err) => !cancelled && setSetup({ status: 'error', message: err.message }))
    return () => {
      cancelled = true
    }
  }, [key])

  // ---- the Source documents, with the text read out of each, whenever the list changes ----
  async function onSourceList(list) {
    const entries = []
    for (const entry of list.entries) {
      if (entry.removedAt || !entry.text) {
        entries.push(entry)
        continue
      }
      let text = null
      try {
        text = await store.readText(entry.id)
      } catch {
        // an unreadable text is left out; the brief lists the document as having none
      }
      entries.push(text ? { ...entry, text } : { ...entry, text: undefined })
    }
    setSources(entries)
  }

  const choices = useMemo(() => (setup.status === 'ready' ? artefactChoices(setup.definition, instance.stage.id) : { candidates: [], lightest: null }), [setup, instance.stage.id])
  const artefactId = pickedArtefact ?? choices.lightest?.id ?? null

  const otherSaved = setup.status === 'ready' ? setup.otherSaved.filter((m) => !instance.modules.some((own) => own.id === m.id)) : []
  ctxRef.current =
    setup.status === 'ready'
      ? { definition: setup.definition, stageId: instance.stage.id, artefactId, size: instance.size, saved: [...instance.modules, ...otherSaved], sources: sources ?? [], skills: setup.skills }
      : null

  // ---- the session ----
  function ask(kind) {
    return (err) => new Promise((resolve) => setRecovery({ kind, message: err.message, resolve }))
  }
  useEffect(() => {
    if (setup.status !== 'ready') return undefined
    let session = sessions.get(key)
    if (!session) {
      session = createInterviewSession({ providerId })
      sessions.set(key, session)
    }
    sessionRef.current = session
    session.bind({ getContext: () => ctxRef.current, handlers: { askForKey: ask('key'), askToRetry: ask('retry') }, onChange: setSnap })
    return () => session.bind({ onChange: null })
  }, [key, setup.status])

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

  // ---- readiness ----
  const gate = useMemo(
    () => (setup.status === 'ready' && draftKeys.length ? draftGateCheck({ structure: setup.structure, stageId: instance.stage.id, artefactId, modules: instance.modules, drafts }) : null),
    [setup, instance.modules, artefactId, snap?.drafts]
  )

  const phase = snap?.phase ?? 'kickoff'
  const started = phase !== 'kickoff' && phase !== 'testing'
  const busy = phase === 'working' || phase === 'testing'
  const stage = setup.status === 'ready' ? setup.definition.stages.find((s) => s.id === instance.stage.id) : null
  const readOnlyIds = new Set(stage?.readOnlyModules ?? [])
  const stageModules = stage ? stage.modules.map((id) => setup.definition.modules.find((m) => m.id === id)).filter((m) => m && !readOnlyIds.has(m.id)) : []

  async function startInterview() {
    await sessionRef.current?.start()
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

  async function saveStage() {
    setSaving({ phase: 'saving' })
    const keys = Object.keys(drafts)
    let result
    try {
      result = await onSaveDrafts(drafts, { artefactId })
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    if (result.ok) {
      sessionRef.current?.markSaved(keys)
      setSaving({ phase: 'saved', check: result.check ?? null })
    } else {
      setSaving({ phase: 'error', message: result.message || 'The Save did not go through.' })
    }
  }

  // ---------- pieces ----------
  const kickoff = () => {
    const status = provider?.test?.status
    const sourceCount = (sources ?? []).filter((s) => !s.removedAt).length
    return html`
      <div class="kick" data-testid="interview-kickoff">
        <p class="kick-intro">
          The AI reads this Instance's Source documents, drafts the Fields they support, then talks them through with you. Nothing is saved
          until you confirm the Stage, and it never passes a Gate that needs approval or review.
        </p>
        ${blockedReason ? html`<p class="inline-error" role="alert" data-testid="interview-blocked">${blockedReason}</p>` : null}

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
        ${provider?.test?.questionCards === 'text'
          ? html`<div class="warn" role="status" data-testid="interview-text-fallback">
              This model can't use tools, so it can't produce question cards natively. Gantry will ask it to write its drafts in text instead (the text fallback). That works, but it is less reliable.
            </div>`
          : null}

        ${choices.candidates.length > 1
          ? html`<label for="interview-artefact">Artefact to aim for</label>
            <select id="interview-artefact" data-testid="interview-artefact" onChange=${(e) => setPickedArtefact(e.currentTarget.value)}>
              ${choices.candidates.map((a) => html`<option key=${a.id} value=${a.id} selected=${a.id === artefactId}>${a.title ?? a.id}${a.id === choices.lightest?.id ? ' (lightest)' : ''}</option>`)}
            </select>
            <p class="kick-note">More than one Artefact can pass this Stage's Gate. The lightest is pre-selected; the AI drafts what the one you choose requires.</p>`
          : null}

        <p class="kick-sources" data-testid="interview-source-count">
          ${sources === null ? 'Reading the Source documents…' : sourceCount === 0 ? 'No Source documents yet. Add some in the left rail so the AI has something to read.' : `${sourceCount} Source document${sourceCount === 1 ? '' : 's'} for the AI to read.`}
        </p>
        ${snap?.kickoffError ? html`<p class="inline-error" role="alert" data-testid="interview-kickoff-error">${snap.kickoffError}</p>` : null}
        <button
          type="button"
          class="btn primary"
          data-testid="interview-start"
          disabled=${!providerId || phase === 'testing' || sources === null || Boolean(blockedReason) || !snap}
          onClick=${startInterview}
        >
          ${phase === 'testing' ? PROGRESS_LABELS[snap?.testStep] ?? 'Testing the AI Provider…' : 'Start interview'}
        </button>
      </div>
    `
  }

  const thread = () =>
    (snap?.thread ?? []).map(
      (m) => html`<div key=${m.id} class=${`msg ${m.who}${m.streaming ? ' streaming caret' : ''}`} data-testid="interview-msg" data-who=${m.who}>${m.text}</div>`
    )

  const stageEnd = () => {
    if (saving?.phase === 'saved') {
      return html`<div class="qcard stage-end saved" data-testid="interview-saved" role="status">
        <p class="qhead">Saved</p>
        <p>${stage?.title ?? instance.stage.title} is saved as one Stage Save. The Modules stay <strong>draft</strong>: a person marks them agreed.</p>
        ${saving.check ? html`<p class="gate-ok" data-testid="interview-saved-gate">${saving.check.pass ? `The ${instance.stage.gate} Gate check passes.` : `The Gate check still reports: ${saving.check.outstanding?.join(', ') || 'see the editor'}.`}</p>` : null}
      </div>`
    }
    if (phase !== 'waiting' || draftKeys.length === 0 || !gate?.pass) return null
    return html`<div class="qcard stage-end" data-testid="interview-stage-end">
      <div class="qchip">Stage</div>
      <p class="qhead">${stage?.title ?? instance.stage.title} is ready. Save it?</p>
      <p>${draftKeys.length} Field${draftKeys.length === 1 ? '' : 's'} drafted. The ${instance.stage.gate} Gate check passes for ${gate.artefact?.title ?? 'the Artefact'}. One Save writes them; the Modules stay <strong>draft</strong>.</p>
      ${saving?.phase === 'error' ? html`<p class="inline-error" role="alert" data-testid="interview-save-error">${saving.message}</p>` : null}
      <div class="round-actions">
        <button type="button" class="btn primary" data-testid="interview-save" disabled=${saving?.phase === 'saving' || Boolean(blockedReason)} onClick=${saveStage}>
          ${saving?.phase === 'saving' ? 'Saving…' : 'Save and stop here'}
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
            return html`<div key=${fieldKey} class="field-proto" data-testid="interview-field" data-field-key=${fieldKey} data-state=${draft ? 'draft' : isBlankValue(savedValue) ? 'empty' : 'saved'}>
              <span class="field-label">${field.title ?? field.id}
                ${draft ? html`<span class="ai-mark" data-testid="interview-ai-mark">AI draft · unsaved</span>` : null}
                ${draft && budget !== null ? html`<span class="field-words" title=${`${targetSizeLabel(size)} target`}>${draft.words} / ~${budget} words</span>` : null}
              </span>
              <div class=${'value' + (draft ? ' ai' : isBlankValue(savedValue) ? ' empty' : '')}>
                ${draft ? html`<${ValueView} value=${draft.value} />` : isBlankValue(savedValue) ? 'Empty' : html`<${ValueView} value=${savedValue} />`}
              </div>
              ${draft?.warnings?.length
                ? html`<ul class="interview-warnings" data-testid="interview-warning">${draft.warnings.map((w, i) => html`<li key=${i} class="warn">${w}</li>`)}</ul>`
                : null}
            </div>`
          })}
        </section>`
      })}
      ${draftKeys.length && gate
        ? html`<p class=${'gate-line' + (gate.pass ? ' gate-ok' : '')} data-testid="interview-gate-line">
            Gate check (${gate.artefact?.title ?? 'no Artefact'}): ${gate.pass ? 'passes' : `not yet. Outstanding: ${gate.outstanding.join(', ') || 'see the editor'}`}
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
        <h3 class="side">Source documents</h3>
        <${SourceDocumentsPanel} store=${store} actor=${actor} readOnly=${Boolean(blockedReason)} compact=${true} onList=${onSourceList} />
      </aside>

      <section class="interview-convo">
        <div class="interview-head">
          <strong>✦ AI interview</strong>
          ${started
            ? html`<select class="interview-switch" data-testid="interview-switch" aria-label="AI Provider" disabled=${busy} value=${snap?.providerId} onChange=${(e) => switchProvider(e.currentTarget.value)}>
                ${providers.map((p) => html`<option key=${p.id} value=${p.id} selected=${p.id === snap?.providerId}>${providerLabel(p)}</option>`)}
              </select>`
            : null}
          ${switchMessage ? html`<span class="inline-error" role="alert" data-testid="interview-switch-error">${switchMessage}</span>` : null}
        </div>
        <div class="interview-thread" data-testid="interview-thread" ref=${threadRef}>
          <div class="inner">
            ${setup.status === 'loading' ? html`<p class="loading">Loading…</p>` : null}
            ${setup.status === 'error' ? html`<p class="inline-error" role="alert">${setup.message}</p>` : null}
            ${setup.status === 'ready' && !started ? kickoff() : null}
            ${setup.status === 'ready' && started ? thread() : null}
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
            ${busy && started && !snap?.drafting && !(snap.thread[snap.thread.length - 1]?.streaming) ? html`<p class="msg sys" data-testid="interview-working">Working<span class="caret"></span></p>` : null}
            ${stageEnd()}
          </div>
        </div>
        <div class="interview-composer">
          <div class="inner chatbox">
            <textarea
              data-testid="interview-chat"
              aria-label="Tell the AI anything"
              placeholder=${started ? 'Tell the AI anything — "the budget is capped at $1.2M", "leave out Finance"…' : 'Start the interview to chat with the AI.'}
              disabled=${!started || busy}
              value=${chat}
              onInput=${(e) => setChat(e.currentTarget.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendChat()
                }
              }}
            ></textarea>
            <button type="button" class="btn small" data-testid="interview-send" disabled=${!started || busy || !chat.trim()} onClick=${sendChat}>Send</button>
          </div>
        </div>
      </section>

      <aside class="interview-preview" data-testid="interview-preview">${preview()}</aside>
      ${connecting ? html`<${AiProviderDialog} provider=${null} onClose=${() => setConnecting(false)} />` : null}
    </div>
  `
}
