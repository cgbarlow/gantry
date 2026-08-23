// gantry's production UI entry point — Preact, delivered via HTM tagged
// templates with no build step, per docs/adr/0006-preact-frontend-framework.md.
// `preact-iso` provides the routing shell — the instance dashboard (#77) at
// `/`, the module editor at `/instance/:slug`, the instance-setup wizard at
// `/setup` (see web/pages/setup-wizard.js) — and `@preact/signals` holds
// the instance-scoped state (the viewed slug and stage, the fetched
// instance data) that's shared across the module editor screen's header,
// nav, and module list, exactly as today's DOM version threaded a `stageId`
// through a single re-render function.
import { html, render } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { signal, effect, batch } from '@preact/signals'
import { LocationProvider, Router, Route } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { theme, cycleTheme } from './lib/theme.js'
import { pat, clearPat, requestPat, promptOpen, resolvePromptWith } from './lib/credential.js'
import { apiFetch } from './lib/apiFetch.js'
import { SetupWizardPage } from './pages/setup-wizard.js'
// Two distinct "view mode" concepts collide on the same export names — the
// dashboard's (#77) master-detail/swimlanes toggle and the module editor's
// (#79) markdown/split/rendered toggle are unrelated signals that happen to
// share a shape. The dashboard's is aliased here; the module editor's keeps
// the bare names since it's used throughout the rest of this file.
import { VIEW_MODES as DASHBOARD_VIEW_MODES, viewMode as dashboardViewMode } from './lib/dashboardView.js'
import { VIEW_MODES, viewMode, cycleViewMode } from './lib/viewMode.js'
import { assetReference, resolveAssetRefs } from './lib/assetRefs.js'

const md = new MarkdownIt()

// The server always serves the real image bytes for an asset id, regardless
// of which `asset:<id>` reference resolved to it — matches the other
// single-instance routes' convention (defaulting to the server's startup
// slug rather than requiring a `?slug=` the client doesn't otherwise track).
// Known gap exposed by #77's multi-instance routing, not fixed by this
// merge: this (and fetchAssets/uploadAsset below) still resolve against the
// server's default startup instance regardless of which slug the module
// editor is actually viewing — pre-existing from #80's single-instance-era
// scope, worth its own follow-up ticket rather than silently expanding here.
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

async function loadInstance(slug, stageId) {
  const params = new URLSearchParams()
  if (slug) params.set('slug', slug)
  if (stageId) params.set('stage', stageId)
  const qs = params.toString()
  const res = await apiFetch(qs ? `/api/instance?${qs}` : '/api/instance')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instance (${res.status})`)
  }
  return res.json()
}

async function fetchAssets() {
  const res = await apiFetch('/api/instance/assets')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load assets (${res.status})`)
  }
  return res.json()
}

async function uploadAsset({ filename, dataBase64, name, source, uploadedBy }) {
  const res = await apiFetch('/api/instance/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, dataBase64, name, source, uploadedBy }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to upload asset (${res.status})`)
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
// `currentSlug` is the instance the module editor route (`/instance/:slug`)
// is currently mounted for. `viewedStage` mirrors the free-browse stage
// switcher: the stage the form is currently displaying, distinct from the
// instance's own persisted current stage until the user picks a different
// one. `viewedStage` of `null` means "let the server default to the
// instance's current stage" (the bootstrap case, on first load of a slug).
const currentSlug = signal(null)
const viewedStage = signal(null)
const instanceData = signal(null)
const loadError = signal(null)

// Fires only while a slug is actually pinned — i.e. while ModuleEditorPage
// is mounted (see its own useEffect below) — not on every page load
// regardless of route, so landing on a sibling route with no instance
// pinned (e.g. /setup, the instance-setup wizard, #78, or the dashboard)
// never fires this fetch or surfaces a spurious "no instance slug given"
// failure.
effect(() => {
  const slug = currentSlug.value
  if (!slug) return
  const stageId = viewedStage.value
  loadInstance(slug, stageId)
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
    // `slug` is required here (not just `stage`) now that a server can host
    // any number of instances at once with no fixed default (#88/#92) —
    // without it, this PUT only ever resolved against whichever slug (if
    // any) the server happened to be started with, silently 400ing for
    // every other instance a multi-instance deployment serves. Surfaced by
    // #94's own "Open instance ... allows editing end-to-end" acceptance
    // criterion once a freshly adopted/created instance had no such
    // server-pinned default to fall back on.
    const params = new URLSearchParams({ stage: stageId, slug: currentSlug.value })
    const res = await apiFetch(`/api/instance/modules/${mod.id}?${params}`, {
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
    // See ModuleCard's handleSave for why `?slug=` is required here now —
    // the same gap, for the module editor's own "Render" action.
    const res = await apiFetch(`/api/instance/render/${artefact.id}?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
    })
    const body = await res.json()
    // Azure-DevOps-backed instances report `azureDevOpsPath` (where the
    // pandoc-rendered .docx was pushed back to, in the same repo the rest
    // of the instance's data lives in); local instances report `docxPath`
    // (a path on the machine running `gantry serve`).
    setStatus(
      res.ok
        ? `Rendered to ${body.azureDevOpsPath ?? body.docxPath}`
        : `Render failed: ${body.message ?? body.error}`
    )
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
        <a class="btn small ghost" href="/">← Instances</a>
        <h1>${instance.slug} — ${instance.definition}</h1>
        <a class="btn small ghost" href="/setup">+ New instance</a>
        <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
          Theme: ${theme.value}
        </button>
        ${pat.value
          ? html`
              <button type="button" class="btn small ghost" onClick=${() => requestPat()}>
                Replace Azure DevOps PAT
              </button>
              <button type="button" class="btn small ghost" onClick=${clearPat}>Clear Azure DevOps PAT</button>
            `
          : null}
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
// `slug` arrives as a route param from `/instance/:slug` (preact-iso passes
// matched params as top-level props). Re-pins the shared instance-scoped
// signals to this slug on mount and whenever the route's slug changes —
// e.g. following an "Open workspace" link from one instance straight to
// another without an intervening full page load — clearing the previous
// instance's stale data first so it's never shown against the new slug.
// `batch()` matters here: without it, `currentSlug.value = slug` alone
// fires the instance-loading effect below (it's already subscribed to
// `currentSlug`) using whatever `viewedStage` was still left over from the
// instance just navigated away from — a stage that may not even be this
// new instance's current one — before the very next line resets it. That
// fires a real, wasted request for the wrong stage, whose response can
// race the correct one. Batching applies all four writes as one update, so
// the effect runs exactly once, with the new slug and `viewedStage: null`
// together.
function ModuleEditorPage({ slug }) {
  useEffect(() => {
    batch(() => {
      currentSlug.value = slug
      viewedStage.value = null
      instanceData.value = null
      loadError.value = null
    })
  }, [slug])

  const instance = instanceData.value
  const error = loadError.value

  if (error) return html`<p class="load-error">Failed to load: ${error}</p>`
  if (!instance || instance.slug !== slug) return html`<p class="loading">Loading…</p>`

  return html`
    <${AppHeader} instance=${instance} />
    <${ViewModeToolbar} />
    <${StageScreen} key=${instance.stage.id} instance=${instance} />
  `
}

// ============================================================
// Instance dashboard (#77) — the landing screen at `/`. Two togglable
// views over the multi-instance registry (`GET /api/instances`, #76):
// master-detail (default) and stage swimlanes. The view choice is a
// persisted signal (web/lib/dashboardView.js), not local state, so it
// survives remounting this page and reloading the app.
// ============================================================

async function loadInstances() {
  const res = await apiFetch('/api/instances')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instances (${res.status})`)
  }
  return res.json()
}

// Registry `status` is only ever 'complete'/'incomplete' (the current
// stage's requirements) — a different, coarser vocabulary than a module's
// own draft/review/agreed frontmatter status. Reuses the same `.stamp`
// tokens (agreed = done, draft = still in progress) rather than inventing
// a third visual language, since the Gate Ledger only defines those three.
function statusStampClass(status) {
  return status === 'complete' ? 'agreed' : 'draft'
}

function StatusStamp({ status }) {
  return html`<span class="stamp ${statusStampClass(status)}">${status.toUpperCase()}</span>`
}

function ViewToggle() {
  return html`
    <div class="view-toggle" role="group" aria-label="Dashboard view">
      ${DASHBOARD_VIEW_MODES.map(
        (mode) => html`
          <button
            type="button"
            key=${mode}
            class=${'btn small' + (dashboardViewMode.value === mode ? ' active' : '')}
            aria-pressed=${dashboardViewMode.value === mode}
            onClick=${() => (dashboardViewMode.value = mode)}
          >
            ${mode === 'master-detail' ? 'Master-detail' : 'Stage swimlanes'}
          </button>
        `
      )}
    </div>
  `
}

function EmptyState() {
  return html`
    <div class="dashboard-empty">
      <p>No instances registered yet.</p>
      <a class="btn primary" href="/setup">+ New instance</a>
    </div>
  `
}

// Runs an instance's Check or Render action against the registry-listing
// API's slug (not the module editor's shared signals, which only track
// whichever single instance is currently open) — the dashboard can trigger
// either action for any listed instance without navigating away from it.
async function runCheck(slug) {
  const res = await apiFetch(`/api/instance/check?slug=${encodeURIComponent(slug)}`)
  const body = await res.json()
  if (!res.ok) return `Check failed: ${body.message ?? body.error}`
  if (body.pass) return 'PASS — gate requirements met.'
  const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
  return `FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`
}

async function runRender(slug) {
  const detailRes = await apiFetch(`/api/instance?slug=${encodeURIComponent(slug)}`)
  const detail = await detailRes.json()
  if (!detailRes.ok) return `Render failed: ${detail.message ?? detail.error}`
  if (!detail.artefacts.length) return 'No artefact available to render for this stage yet.'
  const results = []
  for (const artefact of detail.artefacts) {
    const res = await apiFetch(`/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}`, { method: 'POST' })
    const body = await res.json()
    results.push(res.ok ? `Rendered ${artefact.title}` : `${artefact.title} failed: ${body.message ?? body.error}`)
  }
  return results.join(' · ')
}

// Persists the instance record's own stored `assignee` (#97) — the instance
// detail pane's edit affordance for it, distinct from `PUT
// /api/instance/modules/:id`'s module-level `owner` (the untouched Design
// Authority sign-off convention). Not routed through ModuleCard's per-module
// save flow: this is instance-scoped, not module-scoped.
async function saveAssignee(slug, assignee) {
  const res = await apiFetch(`/api/instance/assignee?slug=${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to save assignee (${res.status})`)
  }
  return body
}

// ---------- Master-detail view ----------
function MasterDetailView({ instances, onInstancesChange }) {
  const [filter, setFilter] = useState('')
  const [selectedSlug, setSelectedSlug] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [actionStatus, setActionStatus] = useState('')
  const [assigneeDraft, setAssigneeDraft] = useState('')
  const [assigneeStatus, setAssigneeStatus] = useState('')

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? instances.filter((inst) => inst.slug.toLowerCase().includes(needle) || inst.assignee.toLowerCase().includes(needle))
    : instances

  const effectiveSlug = filtered.some((inst) => inst.slug === selectedSlug) ? selectedSlug : (filtered[0]?.slug ?? null)
  const selectedInstance = instances.find((inst) => inst.slug === effectiveSlug) ?? null

  useEffect(() => {
    if (!effectiveSlug) {
      setDetail(null)
      return
    }
    setDetail(null)
    setDetailError(null)
    setActionStatus('')
    apiFetch(`/api/instance?slug=${encodeURIComponent(effectiveSlug)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load "${effectiveSlug}" (${res.status})`)
        return res.json()
      })
      .then(setDetail)
      .catch((err) => setDetailError(err.message))
    // eslint-disable-next-line
  }, [effectiveSlug])

  // Mirrors the registry's own `assignee` into the editable draft whenever
  // the selected instance changes — never while it's still the same
  // instance (that would clobber an in-progress edit on every unrelated
  // `instances` refresh).
  useEffect(() => {
    setAssigneeDraft(selectedInstance?.assignee ?? '')
    setAssigneeStatus('')
    // eslint-disable-next-line
  }, [effectiveSlug])

  async function handleCheck() {
    setActionStatus('Checking…')
    setActionStatus(await runCheck(effectiveSlug))
  }

  async function handleRender() {
    setActionStatus('Rendering…')
    setActionStatus(await runRender(effectiveSlug))
  }

  async function handleAssigneeSave() {
    if (!effectiveSlug || assigneeDraft === (selectedInstance?.assignee ?? '')) return
    setAssigneeStatus('Saving…')
    try {
      const saved = await saveAssignee(effectiveSlug, assigneeDraft)
      setAssigneeStatus('Saved.')
      onInstancesChange?.((prev) =>
        prev.map((inst) => (inst.slug === effectiveSlug ? { ...inst, assignee: saved.assignee } : inst))
      )
    } catch (err) {
      setAssigneeStatus(`Failed to save: ${err.message}`)
    }
  }

  return html`
    <div class="master-detail">
      <div class="list-pane">
        <input
          class="field search"
          type="text"
          placeholder="Filter by name, assignee…"
          value=${filter}
          onInput=${(e) => setFilter(e.currentTarget.value)}
        />
        <div class="instance-list">
          ${filtered.map(
            (inst) => html`
              <div
                key=${inst.slug}
                class=${'list-item' + (inst.slug === effectiveSlug ? ' selected' : '')}
                role="button"
                tabindex="0"
                onClick=${() => setSelectedSlug(inst.slug)}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedSlug(inst.slug)
                }}
              >
                <span class=${'dot ' + statusStampClass(inst.status)}></span>
                <span class="meta">
                  <span class="name">${inst.slug}</span>
                  <span class="def">${inst.definition} · ${inst.assignee || 'unassigned'}</span>
                </span>
              </div>
            `
          )}
          ${filtered.length === 0 ? html`<p class="loading">No instances match "${filter}".</p>` : null}
        </div>
      </div>
      <div class="detail-pane">
        ${detailError
          ? html`<p class="load-error">Failed to load: ${detailError}</p>`
          : !detail || !selectedInstance
            ? html`<div class="placeholder">Select an instance to see its details.</div>`
            : html`
                <h2>${detail.slug}</h2>
                <div class="detail-ledger">
                  <div><span class="field-label">Stage</span><span class="stage">${detail.stage.title}</span></div>
                  <div><span class="field-label">Gate</span><span class="mono">${detail.stage.gate}</span></div>
                  <div><${StatusStamp} status=${selectedInstance.status} /></div>
                  <div style="text-align:right;">
                    <span class="field-label">Assignee</span>
                    <input
                      class="text-field mono assignee-input"
                      type="text"
                      placeholder="Unassigned"
                      value=${assigneeDraft}
                      onInput=${(e) => setAssigneeDraft(e.currentTarget.value)}
                      onBlur=${handleAssigneeSave}
                      onKeyDown=${(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                    />
                  </div>
                </div>
                <div class="save-status assignee-save-status">${assigneeStatus}</div>
                <div class="detail-actions">
                  <a class="btn primary" href="/instance/${detail.slug}">Open workspace</a>
                  <button type="button" class="btn" onClick=${handleCheck}>Check</button>
                  <button type="button" class="btn" onClick=${handleRender}>Render</button>
                </div>
                <div class="save-status">${actionStatus}</div>
              `}
      </div>
    </div>
  `
}

// ---------- Stage-swimlane view ----------
// One overflow menu open at a time, closed by clicking anywhere else in the
// lanes (the wrapping onClick resets it; the menu button itself stops
// propagation so opening/toggling it doesn't immediately re-close it).
function SwimlaneChip({ instance, menuOpen, onToggleMenu, onAction }) {
  return html`
    <div class=${'chip' + (menuOpen ? ' menu-open' : '')}>
      <div class="name">${instance.slug}</div>
      <div class="def">${instance.definition}</div>
      <div class="chip-foot">
        <span class="assignee">${instance.assignee || 'unassigned'}</span>
        <${StatusStamp} status=${instance.status} />
        <button
          type="button"
          class="btn small ghost menu-btn"
          aria-haspopup="true"
          aria-expanded=${menuOpen}
          aria-label="Actions for ${instance.slug}"
          onClick=${(e) => {
            e.stopPropagation()
            onToggleMenu(instance.slug)
          }}
        >
          ⋯
        </button>
      </div>
      ${menuOpen
        ? html`
            <div class="menu" onClick=${(e) => e.stopPropagation()}>
              <a href="/instance/${instance.slug}">Open</a>
              <button type="button" onClick=${() => onAction(instance.slug, 'check')}>Check</button>
              <button type="button" onClick=${() => onAction(instance.slug, 'render')}>Render</button>
            </div>
          `
        : null}
    </div>
  `
}

function SwimlaneGroup({ definitionId, stages, instances, showTitle }) {
  const [openSlug, setOpenSlug] = useState(null)
  const [status, setStatus] = useState('')

  async function handleAction(slug, action) {
    setOpenSlug(null)
    setStatus(action === 'check' ? 'Checking…' : 'Rendering…')
    setStatus(await (action === 'check' ? runCheck(slug) : runRender(slug)))
  }

  return html`
    <div class="swimlane-group" onClick=${() => setOpenSlug(null)}>
      ${showTitle ? html`<h2 class="swimlane-group-title">${definitionId}</h2>` : null}
      <div class="lanes">
        ${stages.map((stage) => {
          const items = instances.filter((inst) => inst.stage === stage.id)
          return html`
            <div class="lane" key=${stage.id}>
              <div class="lane-header">
                <span class="stage-name">${stage.title}</span>
                <span class="count">${items.length}</span>
              </div>
              ${items.length === 0
                ? html`<div class="empty-lane">No instances in ${stage.title}</div>`
                : items.map(
                    (inst) => html`
                      <${SwimlaneChip}
                        key=${inst.slug}
                        instance=${inst}
                        menuOpen=${openSlug === inst.slug}
                        onToggleMenu=${(slug) => setOpenSlug((prev) => (prev === slug ? null : slug))}
                        onAction=${handleAction}
                      />
                    `
                  )}
            </div>
          `
        })}
      </div>
      <div class="save-status">${status}</div>
    </div>
  `
}

function SwimlaneView({ instances }) {
  const [stagesByDefinition, setStagesByDefinition] = useState({})
  const [stagesError, setStagesError] = useState(null)
  const definitionIds = [...new Set(instances.map((inst) => inst.definition))].sort()

  useEffect(() => {
    definitionIds.forEach((definitionId) => {
      apiFetch(`/api/definitions/${encodeURIComponent(definitionId)}/stages`)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load stages for "${definitionId}" (${res.status})`)
          return res.json()
        })
        .then((stages) => setStagesByDefinition((prev) => ({ ...prev, [definitionId]: stages })))
        .catch((err) => setStagesError(err.message))
    })
    // eslint-disable-next-line
  }, [definitionIds.join(',')])

  if (stagesError) return html`<p class="load-error">Failed to load: ${stagesError}</p>`

  return html`
    <div class="swimlanes">
      ${definitionIds.map((definitionId) => {
        const stages = stagesByDefinition[definitionId]
        if (!stages) return html`<p class="loading" key=${definitionId}>Loading…</p>`
        return html`
          <${SwimlaneGroup}
            key=${definitionId}
            definitionId=${definitionId}
            stages=${stages}
            instances=${instances.filter((inst) => inst.definition === definitionId)}
            showTitle=${definitionIds.length > 1}
          />
        `
      })}
    </div>
  `
}

// ---------- Dashboard page ----------
function DashboardPage() {
  const [instances, setInstances] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadInstances()
      .then((data) => {
        setInstances(data)
        setError(null)
      })
      .catch((err) => setError(err.message))
  }, [])

  return html`
    <main class="dashboard">
      <div class="dashboard-topbar">
        <h1>Instances</h1>
        <div class="dashboard-controls">
          ${instances?.length ? html`<${ViewToggle} />` : null}
          <a class="btn small ghost" href="/setup">+ New instance</a>
          <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
            Theme: ${theme.value}
          </button>
        </div>
      </div>
      ${error
        ? html`<p class="load-error">Failed to load: ${error}</p>`
        : !instances
          ? html`<p class="loading">Loading…</p>`
          : instances.length === 0
            ? html`<${EmptyState} />`
            : dashboardViewMode.value === 'swimlanes'
              ? html`<${SwimlaneView} instances=${instances} />`
              : html`<${MasterDetailView} instances=${instances} onInstancesChange=${setInstances} />`}
    </main>
  `
}

// ---------- Azure DevOps PAT prompt (#87) ----------
// Rendered globally (see App() below) rather than scoped to any one screen —
// `apiFetch` (web/lib/apiFetch.js) opens it (via `requestPat()`) the moment
// *any* request against gantry's own API comes back with the structured
// "authentication required" response, regardless of which route triggered
// it. Local instances never produce that response, so this never opens for
// them — nothing here checks "is this instance local" itself.
function PatPromptModal() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') resolvePromptWith(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function handleSubmit() {
    if (!value.trim()) {
      setError('Paste a Personal Access Token to continue.')
      return
    }
    resolvePromptWith(value.trim())
  }

  return html`
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Azure DevOps sign-in required">
        <h3>Azure DevOps sign-in required</h3>
        <p class="guidance">
          This instance's data lives in Azure DevOps. Paste a Personal Access Token (PAT) to continue — it needs
          <strong>Code (Read & write)</strong> and <strong>Work Items (Read & write)</strong> scope.
          It's stored only in this browser and sent solely to your own gantry server.
        </p>
        <input
          class=${'text-field' + (error ? ' has-error' : '')}
          type="password"
          autocomplete="off"
          placeholder="Paste your Azure DevOps PAT"
          value=${value}
          onInput=${(e) => {
            setValue(e.currentTarget.value)
            if (error) setError('')
          }}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        ${error ? html`<div class="inline-error">${error}</div>` : null}
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${() => resolvePromptWith(null)}>Cancel</button>
          <button type="button" class="btn primary" onClick=${handleSubmit}>Continue</button>
        </div>
      </div>
    </div>
  `
}

// ---------- App shell: preact-iso routing ----------
// Five routes: the dashboard (#77, default/landing), the module editor per
// instance, the instance-setup wizard (#78), and the asset library (#80).
// `instanceData`/`loadError` above are populated regardless of which route
// is active (the `effect()` isn't scoped to a component), so the library
// screen never has to re-fetch instance data just to know which instance
// it's browsing.
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} path="/instance/:slug" component=${ModuleEditorPage} />
        <${Route} path="/setup" component=${SetupWizardPage} />
        <${Route} path="/assets" component=${AssetLibraryPage} />
        <${Route} default component=${DashboardPage} />
      <//>
    <//>
    ${promptOpen.value ? html`<${PatPromptModal} />` : null}
  `
}

render(html`<${App} />`, document.getElementById('app'))
