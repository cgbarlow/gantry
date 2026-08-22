// gantry's production UI entry point — Preact, delivered via HTM tagged
// templates with no build step, per docs/adr/0006-preact-frontend-framework.md.
// `preact-iso` provides the routing shell (one route today — the module
// editor — so later screens have somewhere to add sibling routes) and
// `@preact/signals` holds the instance-scoped state (the viewed stage, the
// fetched instance data) that's shared across this screen's header, nav,
// and module list, exactly as today's DOM version threaded a `stageId`
// through a single re-render function.
import { html, render } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { signal, effect } from '@preact/signals'
import { LocationProvider, Router, Route } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { theme, cycleTheme } from './lib/theme.js'
import { VIEW_MODES, viewMode, cycleViewMode } from './lib/viewMode.js'
import { assetReference, resolveAssetRefs } from './lib/assetRefs.js'

const md = new MarkdownIt()

// The server always serves the real image bytes for an asset id, regardless
// of which `asset:<id>` reference resolved to it — matches the other
// single-instance routes' convention (defaulting to the server's startup
// slug rather than requiring a `?slug=` the client doesn't otherwise track).
function assetFileUrl(assetId) {
  return `/api/instance/assets/${encodeURIComponent(assetId)}/file`
}

// `image` tokens whose src resolves to gantry's own asset-file route get an
// `asset-thumb` class, so the Gate Ledger stylesheet can size/border an
// inserted asset as a real thumbnail rather than an arbitrary inline image
// (#80's "renders as an actual thumbnail" acceptance criterion).
const defaultImageRenderer = md.renderer.rules.image
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet('src') ?? ''
  if (src.startsWith('/api/instance/assets/')) tokens[idx].attrJoin('class', 'asset-thumb')
  return defaultImageRenderer(tokens, idx, options, env, self)
}

async function loadInstance(stageId) {
  const url = stageId ? `/api/instance?stage=${encodeURIComponent(stageId)}` : '/api/instance'
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to load instance (${res.status})`)
  }
  return res.json()
}

async function fetchAssets() {
  const res = await fetch('/api/instance/assets')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to load assets (${res.status})`)
  }
  return res.json()
}

async function uploadAsset({ filename, dataBase64, name, source, uploadedBy }) {
  const res = await fetch('/api/instance/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, dataBase64, name, source, uploadedBy }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to upload asset (${res.status})`)
  }
  return body
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

// `asset:<id>` references are resolved to the real, fetchable asset-file
// URL before markdown-it ever sees the text — the *stored* markdown source
// keeps the portable `asset:<id>` convention (see web/lib/assetRefs.js),
// only the live preview's rendered HTML points at a real URL.
function renderPreview(node, text) {
  if (!node) return
  node.innerHTML = DOMPurify.sanitize(md.render(resolveAssetRefs(text ?? '', assetFileUrl)))
}

// ---------- Instance-scoped state ----------
// `viewedStage` mirrors the free-browse stage switcher: the stage the form
// is currently displaying, distinct from the instance's own persisted
// current stage until the user picks a different one. `null` means "let
// the server default to the instance's current stage" (the bootstrap case).
const viewedStage = signal(null)
const instanceData = signal(null)
const loadError = signal(null)

effect(() => {
  const stageId = viewedStage.value
  loadInstance(stageId)
    .then((data) => {
      instanceData.value = data
      loadError.value = null
    })
    .catch((err) => {
      loadError.value = err.message
    })
})

// A Rendered-mode editor must be genuinely read-only (#79's acceptance
// criteria: "no edits possible, none saved"), not just visually hidden by
// CSS — `EditorState.readOnly` rejects direct-edit transactions and
// `EditorView.editable` drops `contenteditable`, so neither typing nor
// paste nor drag-drop can land a change while Rendered is active.
function editableExtension(mode) {
  const editable = mode !== 'rendered'
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]
}

// ---------- Markdown field ----------
// EditorView.updateListener -> markdown-it -> DOMPurify -> sibling preview
// pane, per docs/adr/0004-markdown-editor-codemirror.md. The CodeMirror
// instance is the source of truth for the field's value, so getValue/setValue
// read and write it directly rather than duplicating it into component state.
function MarkdownField({ field, onRegister, onFocus }) {
  const hostRef = useRef(null)
  const previewRef = useRef(null)

  useEffect(() => {
    const editableCompartment = new Compartment()
    const state = EditorState.create({
      doc: field.value ?? '',
      extensions: [
        basicSetup,
        markdown(),
        editableCompartment.of(editableExtension(viewMode.value)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) renderPreview(previewRef.current, update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    renderPreview(previewRef.current, field.value ?? '')

    // Track the global view-mode signal for as long as this editor is
    // mounted, so switching into/out of Rendered toggles read-only live —
    // the ticket requires it enforced immediately, not just on next mount.
    const stopViewModeSync = effect(() => {
      view.dispatch({ effects: editableCompartment.reconfigure(editableExtension(viewMode.value)) })
    })

    // Reports focus up to ModuleCard so its single, per-module
    // "+ Insert asset" affordance (#80) knows which field's cursor to
    // insert the reference at — the module's fields aren't otherwise
    // tracked anywhere once mounted.
    function handleFocusIn() {
      onFocus?.()
    }
    view.dom.addEventListener('focusin', handleFocusIn)

    onRegister({
      getValue: () => view.state.doc.toString(),
      setValue: (text) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
        renderPreview(previewRef.current, text ?? '')
      },
      // Inserts an asset reference at the current cursor position (or over
      // the current selection), on its own line — "clicking one inserts
      // its reference at the trigger point" (#80). The preview updates via
      // the same updateListener/docChanged path a normal edit takes.
      insertAtCursor: (snippet) => {
        const { from, to } = view.state.selection.main
        const needsLeadingNewline = from > 0 && view.state.doc.sliceString(from - 1, from) !== '\n'
        const insertText = `${needsLeadingNewline ? '\n' : ''}${snippet}\n`
        view.dispatch({
          changes: { from, to, insert: insertText },
          selection: { anchor: from + insertText.length },
        })
        view.focus()
      },
    })

    return () => {
      view.dom.removeEventListener('focusin', handleFocusIn)
      stopViewModeSync()
      view.destroy()
    }
    // One editor per mount — the enclosing stage screen remounts wholesale
    // (keyed by stage id) on stage switch, matching the old full-rebuild
    // behaviour, so this never needs to react to `field` changing in place.
    // eslint-disable-next-line
  }, [])

  return html`
    <div class="field field-markdown">
      <label>${field.title}${field.required ? ' *' : ''}</label>
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <div class="split">
        <div class="editor-host" ref=${hostRef}></div>
        <div class="preview" ref=${previewRef}></div>
      </div>
    </div>
  `
}

// ---------- List field ----------
function ListField({ field, onRegister }) {
  const rowsRef = useRef(field.value?.length ? [...field.value] : [''])
  const [, bump] = useState(0)
  const rerender = () => bump((n) => n + 1)

  useEffect(() => {
    onRegister({
      getValue: () => rowsRef.current.filter((v) => v.trim() !== ''),
      setValue: (values) => {
        rowsRef.current = values?.length ? [...values] : ['']
        rerender()
      },
    })
    // eslint-disable-next-line
  }, [])

  function updateRow(i, value) {
    rowsRef.current = rowsRef.current.map((v, idx) => (idx === i ? value : v))
    rerender()
  }
  function removeRow(i) {
    rowsRef.current = rowsRef.current.filter((_, idx) => idx !== i)
    rerender()
  }
  function addRow() {
    rowsRef.current = [...rowsRef.current, '']
    rerender()
  }

  return html`
    <div class="field field-list">
      <label>${field.title}${field.required ? ' *' : ''}</label>
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <div class="list-rows">
        ${rowsRef.current.map(
          (value, i) => html`
            <div class="list-row" key=${i}>
              <input type="text" value=${value} onInput=${(e) => updateRow(i, e.currentTarget.value)} />
              <button type="button" class="btn small" onClick=${() => removeRow(i)}>Remove</button>
            </div>
          `
        )}
      </div>
      <button type="button" class="btn small" onClick=${addRow}>Add</button>
    </div>
  `
}

// ---------- One module's card: fields + its own Save button/status ----------
function ModuleCard({ mod, stageId, onFieldRegistered }) {
  const [status, setStatus] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const controlsRef = useRef([])
  // Which field an inserted asset lands in: whichever markdown field the
  // author last focused, defaulting to the module's first markdown field
  // (a module may have none — all-list modules simply get no insert
  // affordance at all, see hasMarkdownField below).
  const activeFieldIndexRef = useRef(mod.fields.findIndex((f) => f.type !== 'list'))

  async function handleSave() {
    const fields = {}
    mod.fields.forEach((field, i) => {
      fields[field.id] = controlsRef.current[i].getValue()
    })
    setStatus('Saving…')
    const res = await fetch(`/api/instance/modules/${mod.id}?stage=${encodeURIComponent(stageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: mod.status, owner: mod.owner, fields }),
    })
    if (!res.ok) {
      setStatus('Save failed.')
      return
    }
    const instanceStatus = await res.json()
    const thisModule = instanceStatus.modules.find((m) => m.id === mod.id)
    setStatus(
      thisModule?.complete ? 'Saved — complete.' : `Saved — outstanding: ${thisModule?.outstanding.join(', ') || 'none'}`
    )
  }

  function handleInsert(asset) {
    const control = controlsRef.current[activeFieldIndexRef.current]
    control?.insertAtCursor?.(assetReference(asset))
    setModalOpen(false)
  }

  const hasMarkdownField = mod.fields.some((f) => f.type !== 'list')

  return html`
    <section class="module">
      <h2>${mod.title}</h2>
      ${mod.purpose ? html`<p class="purpose">${mod.purpose}</p>` : null}
      ${mod.fields.map((field, i) => {
        const onRegister = (control) => {
          controlsRef.current[i] = control
          onFieldRegistered(field, control)
        }
        return field.type === 'list'
          ? html`<${ListField} key=${field.id} field=${field} onRegister=${onRegister} />`
          : html`<${MarkdownField}
              key=${field.id}
              field=${field}
              onRegister=${onRegister}
              onFocus=${() => (activeFieldIndexRef.current = i)}
            />`
      })}
      <div class="save-status">${status}</div>
      <button type="button" class="btn primary" onClick=${handleSave}>Save ${mod.title}</button>
      ${hasMarkdownField && viewMode.value !== 'rendered'
        ? html`
            <div class="insert-affordance">
              <button type="button" onClick=${() => setModalOpen(true)}>+ Insert asset</button>
            </div>
          `
        : null}
      ${modalOpen ? html`<${AssetInsertModal} onInsert=${handleInsert} onClose=${() => setModalOpen(false)} />` : null}
    </section>
  `
}

// ---------- Insert-asset modal: Upload new / Choose existing ----------
// Opened by a module's "+ Insert asset" affordance (hidden in Rendered-only
// view, since that view is read-only — see ModuleCard). Ported from
// Variant A of web/prototypes/asset-insertion.prototype.html (#73), the
// variant #74 locked in: a modal with two tabs, the "Upload new" tab
// blocked by an inline error until both the file and the mandatory
// source-location field are valid.
function AssetInsertModal({ onInsert, onClose }) {
  const [tab, setTab] = useState('upload')
  const [file, setFile] = useState(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [existing, setExisting] = useState(null)
  const [existingError, setExistingError] = useState('')

  useEffect(() => {
    if (tab !== 'existing' || existing !== null) return
    fetchAssets()
      .then(setExisting)
      .catch((err) => setExistingError(err.message))
  }, [tab, existing])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function handleSubmitUpload() {
    if (!source.trim()) {
      setSourceError('Source location is required — link to the originating file (e.g. a Draw.io diagram).')
      return
    }
    if (!file) {
      setSourceError('An image file is required.')
      return
    }
    setSourceError('')
    setSubmitting(true)
    try {
      const dataBase64 = await readFileAsBase64(file)
      const asset = await uploadAsset({ filename: file.name, dataBase64, name, source })
      onInsert(asset)
    } catch (err) {
      setSourceError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Insert asset">
        <h3>Insert asset</h3>
        <div class="modal-tabs">
          <button
            type="button"
            class=${tab === 'upload' ? 'active' : ''}
            aria-pressed=${tab === 'upload'}
            onClick=${() => setTab('upload')}
          >
            Upload new
          </button>
          <button
            type="button"
            class=${tab === 'existing' ? 'active' : ''}
            aria-pressed=${tab === 'existing'}
            onClick=${() => setTab('existing')}
          >
            Choose existing
          </button>
        </div>

        ${tab === 'upload'
          ? html`
              <div class="upload-field">
                <label class="field-label">Image file</label>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange=${(e) => setFile(e.currentTarget.files?.[0] ?? null)}
                />
              </div>
              <div class="upload-field">
                <label class="field-label">Name (optional)</label>
                <input
                  class="text-field"
                  type="text"
                  value=${name}
                  placeholder=${file?.name ?? 'Defaults to the file name'}
                  onInput=${(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div class="upload-field">
                <label class="field-label">Source location (required)</label>
                <input
                  class=${'text-field' + (sourceError ? ' has-error' : '')}
                  type="text"
                  value=${source}
                  placeholder="https://draw.io/diagrams/…"
                  onInput=${(e) => {
                    setSource(e.currentTarget.value)
                    if (sourceError) setSourceError('')
                  }}
                />
                ${sourceError ? html`<div class="inline-error">${sourceError}</div>` : null}
              </div>
              <div class="modal-actions">
                <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
                <button type="button" class="btn primary" disabled=${submitting} onClick=${handleSubmitUpload}>
                  ${submitting ? 'Inserting…' : 'Insert'}
                </button>
              </div>
            `
          : html`
              ${existingError ? html`<p class="load-error">${existingError}</p>` : null}
              ${existing === null && !existingError ? html`<p class="loading">Loading…</p>` : null}
              ${existing !== null
                ? html`
                    <div class="grid-library">
                      ${existing.length === 0
                        ? html`<p class="empty">No assets yet — switch to "Upload new" to add the first one.</p>`
                        : existing.map(
                            (asset) => html`
                              <button type="button" class="card" key=${asset.id} onClick=${() => onInsert(asset)}>
                                <img src=${assetFileUrl(asset.id)} alt=${asset.name} />
                                <div class="name">${asset.name}</div>
                              </button>
                            `
                          )}
                    </div>
                  `
                : null}
            `}
      </div>
    </div>
  `
}

// ---------- Asset library screen ----------
// A new instance-level screen (#80): every asset registered against this
// instance as a thumbnail-grid card, each flagged USED IN N / UNUSED so
// orphaned assets are visible without opening every module.
function AssetLibraryPage() {
  const [assets, setAssets] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAssets()
      .then(setAssets)
      .catch((err) => setError(err.message))
  }, [])

  return html`
    <main class="asset-library">
      <a class="back-link" href="/">← Back to module editor</a>
      <h1>Asset library</h1>
      ${error ? html`<p class="load-error">${error}</p>` : null}
      ${assets === null && !error ? html`<p class="loading">Loading…</p>` : null}
      ${assets !== null
        ? html`
            <div class="lib-grid">
              ${assets.length === 0
                ? html`<p class="empty">No assets registered yet.</p>`
                : assets.map(
                    (asset) => html`
                      <div class="card" key=${asset.id}>
                        <img src=${assetFileUrl(asset.id)} alt=${asset.name} />
                        <div class="name">${asset.name}</div>
                        <div class="meta">
                          ${asset.uploadedBy ? html`${asset.uploadedBy} · ` : null}
                          <a href=${asset.source} target="_blank" rel="noreferrer">${asset.source}</a>
                        </div>
                        <span class=${'stamp used-badge ' + (asset.usedIn.length ? 'agreed' : 'review')}>
                          ${asset.usedIn.length ? `USED IN ${asset.usedIn.length}` : 'UNUSED'}
                        </span>
                      </div>
                    `
                  )}
            </div>
          `
        : null}
    </main>
  `
}

// ---------- Render section ----------
function ArtefactsSection({ instance }) {
  const [status, setStatus] = useState('')

  async function handleRender(artefact) {
    setStatus('Rendering…')
    const res = await fetch(`/api/instance/render/${artefact.id}`, { method: 'POST' })
    const body = await res.json()
    setStatus(res.ok ? `Rendered to ${body.docxPath}` : `Render failed: ${body.error}`)
  }

  return html`
    <section class="artefacts">
      <h2>Render</h2>
      ${instance.artefacts.map(
        (artefact) => html`
          <button type="button" class="btn" key=${artefact.id} onClick=${() => handleRender(artefact)}>
            Render ${artefact.title}
          </button>
        `
      )}
      <div class="save-status">${status}</div>
    </section>
  `
}

// ---------- The viewed stage's whole screen: stage actions, modules, artefacts ----------
// Keyed by stage id from the parent (see ModuleEditorPage) so switching
// stages remounts this wholesale — fresh CodeMirror instances and a fresh
// field registry per stage, matching the old full-DOM-rebuild behaviour.
function StageScreen({ instance }) {
  const registryRef = useRef([])

  function registerField(field, control) {
    registryRef.current.push({ field, control })
  }

  function clearAllFields() {
    registryRef.current.forEach(({ field, control }) => control.setValue(field.type === 'list' ? [] : ''))
  }

  return html`
    <div class="stage-actions">
      <button type="button" class="btn" onClick=${clearAllFields}>Clear all fields</button>
    </div>
    <main id="modules" data-view-mode=${viewMode.value}>
      ${instance.modules.map(
        (mod) => html`
          <${ModuleCard}
            key=${mod.id}
            mod=${mod}
            stageId=${instance.stage.id}
            onFieldRegistered=${registerField}
          />
        `
      )}
      <${ArtefactsSection} instance=${instance} />
    </main>
  `
}

// ---------- View-mode toolbar: Markdown/Split/Rendered segmented control ----------
// One toolbar for the whole editor screen (see web/lib/viewMode.js) — sits
// below AppHeader, above the viewed stage's screen, and (like AppHeader) is
// never remounted by a stage switch, so `viewMode` reads back the same
// value the author left it in after navigating fields/modules/stages.
const VIEW_MODE_LABELS = { markdown: 'Markdown', split: 'Split', rendered: 'Rendered' }
const VIEW_MODE_HOTKEY = { ctrlKey: true, shiftKey: true, key: 'v' }

function ViewModeToolbar() {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key.toLowerCase() !== VIEW_MODE_HOTKEY.key) return
      if (e.ctrlKey !== VIEW_MODE_HOTKEY.ctrlKey || e.shiftKey !== VIEW_MODE_HOTKEY.shiftKey) return
      // Fires even while a CodeMirror editor or other field has focus —
      // it's a distinctive combo unlikely to collide with normal editing,
      // and the ticket asks for a hotkey that cycles the whole screen's
      // view regardless of what the author was just doing.
      e.preventDefault()
      cycleViewMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return html`
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="View mode">
        ${VIEW_MODES.map(
          (mode) => html`
            <button
              type="button"
              key=${mode}
              class=${'btn small' + (viewMode.value === mode ? ' active' : '')}
              aria-pressed=${viewMode.value === mode}
              onClick=${() => (viewMode.value = mode)}
            >
              ${VIEW_MODE_LABELS[mode]}
            </button>
          `
        )}
      </div>
      <a class="btn small" href="/assets">View asset library</a>
    </div>
  `
}

// ---------- Header: title, stage line, free-browse stage nav, theme ----------
function AppHeader({ instance }) {
  return html`
    <header>
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>${instance.slug} — ${instance.definition}</h1>
        <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
          Theme: ${theme.value}
        </button>
      </div>
      <p id="stage-line">${instance.stage.title} (gate: ${instance.stage.gate})</p>
      <nav id="stage-nav">
        ${instance.stages.map((stage) => {
          const isCurrent = stage.id === instance.currentStageId
          const isViewed = stage.id === instance.stage.id
          return html`
            <button
              type="button"
              key=${stage.id}
              class=${'btn small' + (isViewed ? ' active' : '') + (isCurrent ? ' stage-current' : '')}
              onClick=${() => (viewedStage.value = stage.id)}
            >
              ${stage.title}${isCurrent ? ' (current)' : ''}
            </button>
          `
        })}
      </nav>
    </header>
  `
}

// ---------- Page: composes header + the viewed stage's screen ----------
function ModuleEditorPage() {
  const instance = instanceData.value
  const error = loadError.value

  if (error) return html`<p class="load-error">Failed to load: ${error}</p>`
  if (!instance) return html`<p class="loading">Loading…</p>`

  return html`
    <${AppHeader} instance=${instance} />
    <${ViewModeToolbar} />
    <${StageScreen} key=${instance.stage.id} instance=${instance} />
  `
}

// ---------- App shell: preact-iso routing ----------
// Two routes today: the module editor (default) and the asset library
// (#80) — `instanceData`/`loadError` above are populated regardless of
// which route is active (the `effect()` isn't scoped to a component), so
// the library screen never has to re-fetch instance data just to know
// which instance it's browsing.
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} path="/assets" component=${AssetLibraryPage} />
        <${Route} default component=${ModuleEditorPage} />
      <//>
    <//>
  `
}

render(html`<${App} />`, document.getElementById('app'))
