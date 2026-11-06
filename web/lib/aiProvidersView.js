// #277 (parent #238, docs/adr/0061): the Preact pieces for AI Providers on Global Settings: the table
// (Name, Type, Model, Question cards, Reads images, Status; Test, Edit, Delete) and the add/edit dialog. The list
// itself and every rule about it live in web/lib/aiProviders.js; this file only draws them.
// #278: Test runs the full Test connection (web/lib/aiClient.js) and keeps the result with the AI Provider. A
// rejected key shows an inline key prompt and the test is resent once a key is entered; a rate limit or no
// credit shows Retry. `AiRecoveryPrompt` is the same prompt the Interview page puts in the chat.
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  AI_PROVIDER_TYPES,
  REASONING_EFFORTS,
  RUNS_ON,
  aiProviders,
  aiProviderType,
  aiProviderStatusLabel,
  aiProviderQuestionCardsLabel,
  aiProviderReadsImagesLabel,
  addAiProvider,
  updateAiProvider,
  deleteAiProvider,
  setDefaultAiProvider,
  normaliseAiProvider,
  validateAiProviderDraft,
  callsFromBrowser,
  canFetchModels,
  fetchModels,
  fetchOllamaContextWindow,
  contextWindowSource,
  suggestedMaxTokens,
} from './aiProviders.js'
import { testAndStore } from './aiClient.js'

const MODEL_FETCH_DEBOUNCE_MS = 500

// #346: a new AI Provider starts with its type's Max tokens (16,000, or blank for a Custom one; see web/lib/aiProviders.js).
function blankDraft(typeId = 'openai') {
  return normaliseAiProvider({ id: 'new', type: typeId, name: '', temperature: 0.3, maxTokens: suggestedMaxTokens({ type: typeId }) })
}

function textOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * The add/edit dialog. `provider` is the AI Provider being edited, or null to add one. `onClose` is called
 * after Save or Cancel.
 */
export function AiProviderDialog({ provider, onClose }) {
  const isNew = !provider
  const [draft, setDraft] = useState(() => (provider ? normaliseAiProvider(provider) : blankDraft()))
  const [makeDefault, setMakeDefault] = useState(() => (provider ? provider.isDefault : aiProviders.value.length === 0))
  const [stopText, setStopText] = useState(() => (provider ? provider.advanced.stop.join('\n') : ''))
  const [errors, setErrors] = useState({})
  const [models, setModels] = useState({ status: 'idle', list: [], message: '' })
  // A model that runs on this computer is called straight from the browser, which Chrome only allows after the
  // person agrees to let this site reach their device. So its list loads when they press Load models, not
  // as a side effect of choosing the type; `loadedFor` is the address/key it was pressed for.
  const [loadedFor, setLoadedFor] = useState(null)
  const [contextSource, setContextSource] = useState(provider?.contextWindowEdited ? 'edited' : 'default')
  const autoKnown = useRef(false)
  // #346: Max tokens follows the type and the chosen model only for a new AI Provider, and only until the architect types their own. A
  // saved one keeps its setting.
  const maxTokensTyped = useRef(!isNew)
  const [maxTokensForModel, setMaxTokensForModel] = useState(false)
  const nameRef = useRef(null)
  const others = aiProviders.value.filter((p) => p.id !== provider?.id)
  const typeInfo = aiProviderType(draft.type)

  function set(patch) {
    setDraft((d) => ({ ...d, ...patch }))
  }
  function setAdvanced(patch) {
    setDraft((d) => ({ ...d, advanced: { ...d.advanced, ...patch } }))
  }

  useEffect(() => {
    nameRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // The model list is fetched once the address (and key, where one is needed) are filled in. Fetching again
  // whenever the type, address, key or where it runs changes; free text in the Model field is always allowed.
  const fetchKey = [draft.type, draft.address, draft.key, draft.runsOn].join('\u0000')
  const needsPress = callsFromBrowser(draft)
  useEffect(() => {
    if (!canFetchModels(draft) || (needsPress && loadedFor !== fetchKey)) {
      setModels({ status: 'idle', list: [], message: '' })
      return undefined
    }
    let cancelled = false
    setModels((m) => ({ ...m, status: 'loading', message: '' }))
    const timer = setTimeout(async () => {
      try {
        const list = await fetchModels(draft)
        if (!cancelled) setModels({ status: 'ok', list, message: list.length ? '' : 'The AI Provider lists no models. Type one in.' })
      } catch (err) {
        if (!cancelled) setModels({ status: 'error', list: [], message: err.message })
      }
    }, MODEL_FETCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fetchKey, loadedFor])

  // The context window follows the chosen model while the architect hasn't typed their own: the AI Provider's
  // figure where it gives one, otherwise the type's default.
  useEffect(() => {
    if (draft.contextWindowEdited || models.status === 'loading') return undefined
    let cancelled = false
    const found = models.list.find((m) => m.id === draft.model)
    if (found?.contextWindow) {
      autoKnown.current = true
      setContextSource('known')
      set({ contextWindow: found.contextWindow })
    } else if (draft.type === 'ollama' && found) {
      fetchOllamaContextWindow(draft, draft.model)
        .then((n) => {
          if (cancelled) return
          if (n) {
            autoKnown.current = true
            setContextSource('known')
            set({ contextWindow: n })
          } else {
            setContextSource('default')
          }
        })
        .catch(() => {})
    } else if (autoKnown.current) {
      autoKnown.current = false
      setContextSource('default')
      set({ contextWindow: typeInfo.defaultContextWindow })
    } else {
      setContextSource('default')
    }
    return () => {
      cancelled = true
    }
  }, [draft.model, models, draft.contextWindowEdited])

  useEffect(() => {
    if (maxTokensTyped.current || models.status === 'loading') return
    const found = models.list.find((m) => m.id === draft.model) ?? null
    const next = suggestedMaxTokens(draft, found)
    setMaxTokensForModel(next !== null && next < (typeInfo.defaultMaxTokens ?? Infinity))
    if (next !== draft.maxTokens) set({ maxTokens: next })
  }, [draft.type, draft.model, models])

  function onTypeChange(nextTypeId) {
    const next = aiProviderType(nextTypeId)
    setDraft((d) => {
      const wasDefaultAddress = d.address === '' || d.address === aiProviderType(d.type).defaultAddress
      return {
        ...d,
        type: nextTypeId,
        address: wasDefaultAddress ? next.defaultAddress : d.address,
        runsOn: next.local ? (d.runsOn ?? 'browser') : null,
        contextWindow: d.contextWindowEdited ? d.contextWindow : next.defaultContextWindow,
        maxTokens: maxTokensTyped.current ? d.maxTokens : suggestedMaxTokens({ type: nextTypeId, model: d.model }),
      }
    })
    autoKnown.current = false
    setContextSource(draft.contextWindowEdited ? 'edited' : 'default')
  }

  function save() {
    const candidate = {
      ...draft,
      name: draft.name.trim(),
      address: draft.address.trim(),
      key: draft.key.trim(),
      model: draft.model.trim(),
      advanced: { ...draft.advanced, stop: stopText.split('\n').map((s) => s.trim()).filter(Boolean) },
    }
    const found = validateAiProviderDraft(candidate, others)
    setErrors(found)
    if (Object.keys(found).length) return
    if (isNew) addAiProvider(candidate, { makeDefault })
    else updateAiProvider(provider.id, candidate, { makeDefault })
    onClose()
  }

  const err = (field) => (errors[field] ? html`<p class="inline-error" id=${`ai-provider-${field}-error`}>${errors[field]}</p>` : null)
  const numberInput = (id, value, onInput, extra = {}) =>
    html`<input id=${id} class="wizard-input" type="number" step="any" value=${textOrEmpty(value)} onInput=${(e) => onInput(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} ...${extra} />`

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal ai-provider-dialog" role="dialog" aria-modal="true" aria-label=${isNew ? 'Add AI Provider' : 'Edit AI Provider'}>
        <h3>${isNew ? 'Add AI Provider' : 'Edit AI Provider'}</h3>
        <div class="ai-provider-form">
          <label class="field-label" for="ai-provider-name">Name</label>
          <input id="ai-provider-name" ref=${nameRef} class="wizard-input" value=${draft.name} onInput=${(e) => set({ name: e.currentTarget.value })} />
          ${err('name')}

          <label class="field-label" for="ai-provider-type">Type</label>
          <select id="ai-provider-type" class="wizard-input" value=${draft.type} onChange=${(e) => onTypeChange(e.currentTarget.value)}>
            ${AI_PROVIDER_TYPES.map((t) => html`<option key=${t.id} value=${t.id}>${t.label}</option>`)}
          </select>

          ${typeInfo.local
            ? html`
                <fieldset class="settings-radio-group ai-provider-runs-on">
                  <legend class="field-label">Runs on</legend>
                  ${Object.entries(RUNS_ON).map(
                    ([value, label]) => html`
                      <label class="settings-radio" key=${value}>
                        <input type="radio" name="ai-provider-runs-on" value=${value} checked=${draft.runsOn === value} onChange=${() => set({ runsOn: value })} />
                        ${label}
                      </label>
                    `
                  )}
                </fieldset>
                <p class="workspace-field-hint">
                  ${draft.runsOn === 'browser'
                    ? html`Your browser calls it directly, so it can reach a model on this computer. ${draft.type === 'ollama'
                        ? html`Ollama has to allow this page: set <code>OLLAMA_ORIGINS</code> and restart it.`
                        : html`LM Studio has to allow this page: turn on CORS in its server settings.`}`
                    : html`Gantry's server calls it. It has to be able to reach the address, and private addresses are refused unless the operator sets <code>GANTRY_AI_ALLOW_PRIVATE_URLS</code>.`}
                </p>
              `
            : null}

          <label class="field-label" for="ai-provider-address">Address</label>
          <input id="ai-provider-address" class="wizard-input" value=${draft.address} placeholder="https://…" onInput=${(e) => set({ address: e.currentTarget.value })} />
          ${err('address')}

          <label class="field-label" for="ai-provider-key">Key${typeInfo.keyRequired ? '' : ' (optional)'}</label>
          <input id="ai-provider-key" class="wizard-input" type="password" autocomplete="off" value=${draft.key} onInput=${(e) => set({ key: e.currentTarget.value })} />
          <p class="workspace-field-hint">Kept in this browser only and sent with each request. Gantry's server never stores it.</p>
          ${err('key')}

          <label class="field-label" for="ai-provider-model">Model</label>
          <input id="ai-provider-model" class="wizard-input" list="ai-provider-model-options" autocomplete="off" value=${draft.model} onInput=${(e) => set({ model: e.currentTarget.value })} />
          <datalist id="ai-provider-model-options">
            ${models.list.map((m) => html`<option key=${m.id} value=${m.id}></option>`)}
          </datalist>
          <p class="workspace-field-hint ai-provider-model-status" role="status" data-state=${models.status}>
            ${models.status === 'loading'
              ? 'Fetching the model list…'
              : models.status === 'ok'
                ? models.message || `${models.list.length} model${models.list.length === 1 ? '' : 's'} found. Pick one or type your own.`
                : models.status === 'error'
                  ? models.message
                  : needsPress
                    ? 'Press Load models to list the models on this computer. Your browser may ask to let this site reach apps on your device; allow it to continue. You can always type a model in.'
                    : `The model list is fetched once the address${typeInfo.keyRequired ? ' and key are' : ' is'} entered. You can always type a model in.`}
          </p>
          ${needsPress && canFetchModels(draft) && models.status !== 'loading'
            ? html`<button type="button" class="btn btn-secondary ai-provider-load-models" onClick=${() => setLoadedFor(fetchKey)}>Load models</button>`
            : null}

          <div class="ai-provider-row">
            <div>
              <label class="field-label" for="ai-provider-temperature">Temperature</label>
              ${numberInput('ai-provider-temperature', draft.temperature, (v) => set({ temperature: v }), { min: 0, max: 2 })}
              ${err('temperature')}
            </div>
            <div>
              <label class="field-label" for="ai-provider-max-tokens">Max tokens</label>
              ${numberInput(
                'ai-provider-max-tokens',
                draft.maxTokens,
                (v) => {
                  maxTokensTyped.current = true
                  setMaxTokensForModel(false)
                  set({ maxTokens: v })
                },
                { min: 1 }
              )}
              ${maxTokensForModel
                ? html`<p class="workspace-field-hint" id="ai-provider-max-tokens-hint">The most this model allows.</p>`
                : draft.type === 'custom' && draft.maxTokens === null
                  ? html`<p class="workspace-field-hint" id="ai-provider-max-tokens-hint">Blank leaves it to the service's own limit. Some refuse a figure above it.</p>`
                  : null}
              ${err('maxTokens')}
            </div>
          </div>

          <details class="ai-provider-advanced" open=${Boolean(errors.contextWindow || errors.topP || errors.topK || errors.minP || errors.frequencyPenalty || errors.presencePenalty) || undefined}>
            <summary>Advanced</summary>
            <label class="field-label" for="ai-provider-context-window">Context window (tokens)</label>
            <input
              id="ai-provider-context-window"
              class="wizard-input"
              type="number"
              min="1"
              value=${textOrEmpty(draft.contextWindow)}
              onInput=${(e) => {
                setContextSource('edited')
                autoKnown.current = false
                set({ contextWindow: e.currentTarget.value === '' ? null : Number(e.currentTarget.value), contextWindowEdited: true })
              }}
            />
            <p class="workspace-field-hint" data-source=${contextSource}>
              ${contextSource === 'edited' ? 'You set this.' : contextWindowSource({ ...draft, contextWindowEdited: false }, contextSource === 'known')}
              ${' '}Gantry uses it to choose between putting the whole document pack in the prompt and a catalogue.
            </p>
            ${err('contextWindow')}
            <div class="ai-provider-row">
              <div>
                <label class="field-label" for="ai-provider-top-p">top_p</label>
                ${numberInput('ai-provider-top-p', draft.advanced.topP, (v) => setAdvanced({ topP: v }), { min: 0, max: 1 })}
                ${err('topP')}
              </div>
              <div>
                <label class="field-label" for="ai-provider-top-k">top_k</label>
                ${numberInput('ai-provider-top-k', draft.advanced.topK, (v) => setAdvanced({ topK: v }), { min: 1 })}
                ${err('topK')}
              </div>
              <div>
                <label class="field-label" for="ai-provider-min-p">min_p</label>
                ${numberInput('ai-provider-min-p', draft.advanced.minP, (v) => setAdvanced({ minP: v }), { min: 0, max: 1 })}
                ${err('minP')}
              </div>
            </div>
            <div class="ai-provider-row">
              <div>
                <label class="field-label" for="ai-provider-frequency-penalty">Frequency penalty</label>
                ${numberInput('ai-provider-frequency-penalty', draft.advanced.frequencyPenalty, (v) => setAdvanced({ frequencyPenalty: v }), { min: -2, max: 2 })}
                ${err('frequencyPenalty')}
              </div>
              <div>
                <label class="field-label" for="ai-provider-presence-penalty">Presence penalty</label>
                ${numberInput('ai-provider-presence-penalty', draft.advanced.presencePenalty, (v) => setAdvanced({ presencePenalty: v }), { min: -2, max: 2 })}
                ${err('presencePenalty')}
              </div>
            </div>
            <label class="field-label" for="ai-provider-stop">Stop sequences (one per line)</label>
            <textarea id="ai-provider-stop" class="wizard-input" rows="2" value=${stopText} onInput=${(e) => setStopText(e.currentTarget.value)}></textarea>
            <label class="field-label" for="ai-provider-reasoning-effort">Reasoning effort</label>
            <select id="ai-provider-reasoning-effort" class="wizard-input" value=${draft.advanced.reasoningEffort} onChange=${(e) => setAdvanced({ reasoningEffort: e.currentTarget.value })}>
              <option value="">Not set</option>
              ${REASONING_EFFORTS.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
            </select>
          </details>

          <label class="settings-checkbox ai-provider-default">
            <input
              id="ai-provider-default"
              type="checkbox"
              checked=${makeDefault}
              disabled=${Boolean(provider?.isDefault)}
              onChange=${(e) => setMakeDefault(e.currentTarget.checked)}
            />
            Use as the Default${provider?.isDefault ? ' (it is the Default now; make another AI Provider the Default to change this)' : ''}
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
          <button type="button" class="btn primary" onClick=${save}>${isNew ? 'Add AI Provider' : 'Save'}</button>
        </div>
      </div>
    </div>
  `
}

const PROGRESS_LABELS = {
  key: 'Checking the key…',
  model: 'Checking the model…',
  cards: 'Checking question cards…',
  images: 'Checking whether it reads images…',
}

/**
 * The inline prompt for a call that failed in a way a person can fix (#244 item 7): a rejected key shows a key
 * field and resends once it is entered; a rate limit or no credit shows Retry. Nothing is lost while it waits.
 */
export function AiRecoveryPrompt({ kind, message, onKey, onRetry, onCancel }) {
  const [key, setKey] = useState('')
  return html`
    <div class="ai-recovery-prompt" role="alert" data-kind=${kind}>
      <p class="inline-error">${message}</p>
      ${kind === 'key'
        ? html`
            <div class="ai-recovery-row">
              <input
                type="password"
                class="wizard-input ai-recovery-key"
                autocomplete="off"
                aria-label="New key"
                placeholder="Enter a key"
                value=${key}
                onInput=${(e) => setKey(e.currentTarget.value)}
                onKeyDown=${(e) => e.key === 'Enter' && key.trim() && onKey(key.trim())}
              />
              <button type="button" class="btn small primary ai-recovery-submit" disabled=${!key.trim()} onClick=${() => onKey(key.trim())}>Use this key and resend</button>
              <button type="button" class="btn small ghost" onClick=${onCancel}>Cancel</button>
            </div>
          `
        : html`
            <div class="ai-recovery-row">
              <button type="button" class="btn small primary ai-recovery-retry" onClick=${onRetry}>Retry</button>
              <button type="button" class="btn small ghost" onClick=${onCancel}>Cancel</button>
            </div>
          `}
    </div>
  `
}

/** The AI Providers section of Global Settings: the table, with Add, Test, Edit and Delete. */
export function AiProvidersSection() {
  const [dialog, setDialog] = useState(null) // null | { provider: AiProvider | null }
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [testing, setTesting] = useState(null) // { id, step } while a test runs
  const [prompt, setPrompt] = useState(null) // { id, kind, message, resolve } while a test waits for a person
  const [testMessages, setTestMessages] = useState({}) // { [id]: { ok, text, steps } }
  const list = aiProviders.value

  async function runTest(provider) {
    const id = provider.id
    setTestMessages((m) => ({ ...m, [id]: undefined }))
    setTesting({ id, step: 'key' })
    const ask = (kind) => (err) =>
      new Promise((resolve) => {
        setPrompt({ id, kind, message: err.message, resolve })
      })
    try {
      const result = await testAndStore(id, {
        onProgress: (step) => setTesting({ id, step }),
        handlers: { askForKey: ask('key'), askToRetry: ask('retry') },
      })
      setTestMessages((m) => ({ ...m, [id]: { ok: result.status === 'passed', text: result.message, steps: result.steps } }))
    } catch (e) {
      setTestMessages((m) => ({ ...m, [id]: { ok: false, text: e.message, steps: [] } }))
    } finally {
      setTesting(null)
      setPrompt(null)
    }
  }

  function answerPrompt(value) {
    const waiting = prompt
    setPrompt(null)
    waiting?.resolve(value)
  }

  return html`
    <section class="settings-section" id="ai-providers">
      <h2>AI Providers</h2>
      <p class="guidance">
        The AI services that read an Instance's source material and interview you to draft it. They belong to
        this browser and work in every workspace. Keys are kept in this browser only, like Workspace PATs, and
        are sent with each request; Gantry's server never stores or logs them.
      </p>
      ${list.length === 0
        ? html`<p class="guidance ai-providers-empty">No AI Providers yet. Add one to use the AI interview.</p>`
        : html`
            <table class="ai-provider-table">
              <thead>
                <tr><th>Name</th><th>Type</th><th>Model</th><th>Question cards</th><th>Reads images</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                ${list.map((p) => {
                  const status = aiProviderStatusLabel(p)
                  const typeInfo = aiProviderType(p.type)
                  const message = testMessages[p.id]
                  const running = testing?.id === p.id
                  const waiting = prompt?.id === p.id ? prompt : null
                  return html`
                    <tr key=${p.id} data-ai-provider=${p.name}>
                      <td>
                        ${p.name}
                        ${p.isDefault ? html` <span class="stamp agreed ai-provider-default-stamp">Default</span>` : null}
                      </td>
                      <td>${typeInfo?.label ?? p.type}${p.runsOn ? html` <span class="ai-provider-runs-on-label">(${RUNS_ON[p.runsOn].toLowerCase()})</span>` : null}</td>
                      <td>${p.model || html`<span class="ai-provider-none">Not chosen</span>`}</td>
                      <td>${aiProviderQuestionCardsLabel(p)}</td>
                      <td>${aiProviderReadsImagesLabel(p)}</td>
                      <td><span class=${'stamp ' + status.tone}>${status.label}</span></td>
                      <td>
                       <div class="ai-provider-actions">
                        ${confirmDelete === p.id
                          ? html`
                              <span>Delete ${p.name}?</span>
                              <button type="button" class="btn small" onClick=${() => { deleteAiProvider(p.id); setConfirmDelete(null) }}>Yes, delete</button>
                              <button type="button" class="btn small ghost" onClick=${() => setConfirmDelete(null)}>Keep</button>
                            `
                          : html`
                              <button type="button" class="btn small ghost" disabled=${Boolean(testing)} onClick=${() => runTest(p)}>${running ? 'Testing…' : 'Test'}</button>
                              <button type="button" class="btn small ghost" onClick=${() => setDialog({ provider: p })}>Edit</button>
                              ${p.isDefault ? null : html`<button type="button" class="btn small ghost" onClick=${() => setDefaultAiProvider(p.id)}>Make Default</button>`}
                              <button type="button" class="btn small ghost" onClick=${() => setConfirmDelete(p.id)}>Delete</button>
                            `}
                      </div>
                      </td>
                    </tr>
                    ${waiting
                      ? html`
                          <tr key=${p.id + '-prompt'} class="ai-provider-test-row ai-provider-prompt-row">
                            <td colspan="7">
                              <${AiRecoveryPrompt}
                                kind=${waiting.kind}
                                message=${waiting.message}
                                onKey=${(key) => {
                                  updateAiProvider(p.id, { key })
                                  answerPrompt(true)
                                }}
                                onRetry=${() => answerPrompt(true)}
                                onCancel=${() => answerPrompt(false)}
                              />
                            </td>
                          </tr>
                        `
                      : running
                        ? html`<tr key=${p.id + '-progress'} class="ai-provider-test-row"><td colspan="7" role="status" class="ai-provider-test-ok">${PROGRESS_LABELS[testing.step] ?? 'Testing…'}</td></tr>`
                        : message
                          ? html`
                              <tr key=${p.id + '-test'} class="ai-provider-test-row">
                                <td colspan="7" role="status" class=${message.ok ? 'ai-provider-test-ok' : 'inline-error'}>
                                  <p class="ai-provider-test-summary">${message.text}</p>
                                  ${message.steps?.length
                                    ? html`<ul class="ai-provider-test-steps">
                                        ${message.steps.map((step) => html`<li key=${step.id} data-step=${step.id} data-ok=${String(step.ok)}><strong>${step.label}.</strong> ${step.detail}</li>`)}
                                      </ul>`
                                    : null}
                                </td>
                              </tr>
                            `
                          : null}
                  `
                })}
              </tbody>
            </table>
          `}
      <div class="settings-actions">
        <button type="button" class="btn primary" onClick=${() => setDialog({ provider: null })}>Add AI Provider</button>
      </div>
      ${dialog ? html`<${AiProviderDialog} provider=${dialog.provider} onClose=${() => setDialog(null)} />` : null}
    </section>
  `
}
