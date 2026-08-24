// gantry's production UI entry point — Preact, delivered via HTM tagged templates with no build step, per docs/adr/0006-preact-frontend-framework.md. `preact-iso` provides the routing shell — the instance dashboard (#77) at `/`, the module editor at `/instance/:slug`, the "+ New Workspace" wizard at `/new-workspace` (#110, see web/pages/new-workspace-wizard.js — replaces the old URL-first "+ New instance" wizard entirely) — and `@preact/signals` holds the instance-scoped state (the viewed slug and stage, the fetched instance data) that's shared across the module editor screen's header, nav, and module list, exactly as today's DOM version threaded a `stageId` through a single re-render function.
import { html, render } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { signal, effect, batch } from '@preact/signals'
import { LocationProvider, Router, Route } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { promptOpen, resolvePromptWith } from './lib/credential.js'
import { apiFetch, apiFetchForInstance } from './lib/apiFetch.js'
import { NewWorkspaceWizardPage } from './pages/new-workspace-wizard.js'
import { GlobalSettingsPage, WorkspaceSettingsPage, InstanceSettingsPage } from './pages/settings.js'
// Two distinct "view mode" concepts collide on the same export names — the dashboard's (#77) master-detail/swimlanes toggle and the module editor's (#79) markdown/split/rendered toggle are unrelated signals that happen to share a shape. The dashboard's is aliased here; the module editor's keeps the bare names since it's used throughout the rest of this file.
import { VIEW_MODES as DASHBOARD_VIEW_MODES, viewMode as dashboardViewMode } from './lib/dashboardView.js'
import { VIEW_MODES, viewMode, cycleViewMode } from './lib/viewMode.js'
import { assetReference, resolveAssetRefs } from './lib/assetRefs.js'

const md = new MarkdownIt()

// The server always serves the real image bytes for an asset id, regardless of which `asset:<id>` reference resolved to it — matches the other single-instance routes' convention (defaulting to the server's startup slug rather than requiring a `?slug=` the client doesn't otherwise track). Known gap exposed by #77's multi-instance routing, not fixed by this merge: this (and fetchAssets/uploadAsset below) still resolve against the server's default startup instance regardless of which slug the module editor is actually viewing — pre-existing from #80's single-instance-era scope, worth its own follow-up ticket rather than silently expanding here.
function assetFileUrl(assetId) {
  return `/api/instance/assets/${encodeURIComponent(assetId)}/file`
}

// `image` tokens whose src resolves to gantry's own asset-file route get an `asset-thumb` class, so the Gate Ledger stylesheet can size/border an inserted asset as a real thumbnail rather than an arbitrary inline image (#80's "renders as an actual thumbnail" acceptance criterion).
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
  // `apiFetchForInstance` (not plain `apiFetch`) — this request may target a workspace with its own PAT override (#104), which must be resolved and attached before the first attempt, not just on a 401 retry.
  const res = await apiFetchForInstance(slug, qs ? `/api/instance?${qs}` : '/api/instance')
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

// `asset:<id>` references are resolved to the real, fetchable asset-file URL before markdown-it ever sees the text — the *stored* markdown source keeps the portable `asset:<id>` convention (see web/lib/assetRefs.js), only the live preview's rendered HTML points at a real URL.
function renderPreview(node, text) {
  if (!node) return
  node.innerHTML = DOMPurify.sanitize(md.render(resolveAssetRefs(text ?? '', assetFileUrl)))
}

// ---------- Instance-scoped state ----------
// `currentSlug` is the instance the module editor route (`/instance/:slug`) is currently mounted for. `viewedStage` mirrors the free-browse stage switcher: the stage the form is currently displaying, distinct from the instance's own persisted current stage until the user picks a different one. `viewedStage` of `null` means "let the server default to the instance's current stage" (the bootstrap case, on first load of a slug).
const currentSlug = signal(null)
const viewedStage = signal(null)
const instanceData = signal(null)
const loadError = signal(null)

// Fires only while a slug is actually pinned — i.e. while ModuleEditorPage is mounted (see its own useEffect below) — not on every page load regardless of route, so landing on a sibling route with no instance pinned (e.g. /new-workspace, the "+ New Workspace" wizard, #110, or the dashboard) never fires this fetch or surfaces a spurious "no instance slug given" failure.
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

// A Rendered-mode editor must be genuinely read-only (#79's acceptance criteria: "no edits possible, none saved"), not just visually hidden by CSS — `EditorState.readOnly` rejects direct-edit transactions and `EditorView.editable` drops `contenteditable`, so neither typing nor paste nor drag-drop can land a change while Rendered is active.
function editableExtension(mode) {
  const editable = mode !== 'rendered'
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]
}

// ---------- Markdown field ----------
// EditorView.updateListener -> markdown-it -> DOMPurify -> sibling preview pane, per docs/adr/0004-markdown-editor-codemirror.md. The CodeMirror instance is the source of truth for the field's value, so getValue/setValue read and write it directly rather than duplicating it into component state.
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

    // Track the global view-mode signal for as long as this editor is mounted, so switching into/out of Rendered toggles read-only live — the ticket requires it enforced immediately, not just on next mount.
    const stopViewModeSync = effect(() => {
      view.dispatch({ effects: editableCompartment.reconfigure(editableExtension(viewMode.value)) })
    })

    // Reports focus up to ModuleCard so its single, per-module "+ Insert asset" affordance (#80) knows which field's cursor to insert the reference at — the module's fields aren't otherwise tracked anywhere once mounted.
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
      // Inserts an asset reference at the current cursor position (or over the current selection), on its own line — "clicking one inserts its reference at the trigger point" (#80). The preview updates via the same updateListener/docChanged path a normal edit takes.
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
    // One editor per mount — the enclosing stage screen remounts wholesale (keyed by stage id) on stage switch, matching the old full-rebuild behaviour, so this never needs to react to `field` changing in place.
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
  // Which field an inserted asset lands in: whichever markdown field the author last focused, defaulting to the module's first markdown field (a module may have none — all-list modules simply get no insert affordance at all, see hasMarkdownField below).
  const activeFieldIndexRef = useRef(mod.fields.findIndex((f) => f.type !== 'list'))

  async function handleSave() {
    const fields = {}
    mod.fields.forEach((field, i) => {
      fields[field.id] = controlsRef.current[i].getValue()
    })
    setStatus('Saving…')
    // `slug` is required here (not just `stage`) now that a server can host any number of instances at once with no fixed default (#88/#92) — without it, this PUT only ever resolved against whichever slug (if any) the server happened to be started with, silently 400ing for every other instance a multi-instance deployment serves. Surfaced by #94's own "Open instance ... allows editing end-to-end" acceptance criterion once a freshly adopted/created instance had no such server-pinned default to fall back on.
    const params = new URLSearchParams({ stage: stageId, slug: currentSlug.value })
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/modules/${mod.id}?${params}`, {
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
// Opened by a module's "+ Insert asset" affordance (hidden in Rendered-only view, since that view is read-only — see ModuleCard). Ported from Variant A of web/prototypes/asset-insertion.prototype.html (#73), the variant #74 locked in: a modal with two tabs, the "Upload new" tab blocked by an inline error until both the file and the mandatory source-location field are valid.
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
// A new instance-level screen (#80): every asset registered against this instance as a thumbnail-grid card, each flagged USED IN N / UNUSED so orphaned assets are visible without opening every module.
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

// ---------- Render dialog (#114) ----------
// A single "Render" button, in the view-toggle bar (see ViewModeToolbar),
// opens this dialog rather than the old one-button-per-artefact layout —
// same dialog whether the current stage produces one artefact (e.g. `soap`)
// or several sharing a gate (e.g. `sad`/`ssad`), per the ticket's "not a
// special case" acceptance criterion. Follows the same
// modal-backdrop/modal/modal-actions shape as AssetInsertModal and the
// work-item sync confirm modal above.
function RenderDialog({ instance, onClose }) {
  const [status, setStatus] = useState('')
  const [renderingId, setRenderingId] = useState(null)

  async function handleRender(artefact) {
    setRenderingId(artefact.id)
    setStatus('Rendering…')
    // See ModuleCard's handleSave for why `?slug=` is required here now — the same gap, for the module editor's own "Render" action.
    const slug = currentSlug.value
    const res = await apiFetchForInstance(slug, `/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}`, {
      method: 'POST',
    })
    const body = await res.json()
    // Azure-DevOps-backed instances report `azureDevOpsPath` (where the pandoc-rendered .docx was pushed back to, in the same repo the rest of the instance's data lives in); local instances report `docxPath` (a path on the machine running `gantry serve`).
    setStatus(
      res.ok
        ? `Rendered to ${body.azureDevOpsPath ?? body.docxPath}`
        : `Render failed: ${body.message ?? body.error}`
    )
    setRenderingId(null)
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Render an artefact">
        <h3>Render</h3>
        ${instance.artefacts.length
          ? html`
              <ul class="render-artefact-list">
                ${instance.artefacts.map(
                  (artefact) => html`
                    <li key=${artefact.id}>
                      <button
                        type="button"
                        class="btn"
                        disabled=${renderingId === artefact.id}
                        onClick=${() => handleRender(artefact)}
                      >
                        ${renderingId === artefact.id ? 'Rendering…' : artefact.title}
                      </button>
                    </li>
                  `
                )}
              </ul>
            `
          : html`<p class="guidance">This stage has no artefacts to render yet.</p>`}
        <div class="save-status">${status}</div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>
  `
}

// ---------- Azure DevOps work-item link + confirmed gate-pass sync (#103) ----------
// One instance-level panel, shown once per stage screen (below the modules — see StageScreen; Render itself moved to the view-toggle bar, #114) rather than in AppHeader, since "which stage's work item" is stage-scoped even though the *link* itself is instance-level. Unlinked: a small inline form (organization/project/parent work item id/type) posts to POST /api/instance/work-items/link. Linked: shows the parent id and this stage's own child work item id, plus a "Check gate & sync" action that runs the existing check first and only opens the confirm-before-push modal (mirroring PatPromptModal's shape) if the gate genuinely passes — declining it (or the gate failing) never calls POST /api/instance/work-items/sync at all, so the work item's state is left exactly as it was (#103's "declining leaves the work item's state unchanged" acceptance criterion).
function WorkItemPanel({ instance }) {
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [linkForm, setLinkForm] = useState({ organization: '', project: '', parentId: '', workItemType: '' })
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState('')

  const stageId = instance.stage.id
  const workItem = instance.workItem
  const stageWorkItemId = workItem?.stages?.[stageId]

  async function reloadInstance() {
    instanceData.value = await loadInstance(currentSlug.value, viewedStage.value)
  }

  async function handleLink() {
    setLinkError('')
    if (!linkForm.organization.trim() || !linkForm.project.trim() || !linkForm.parentId.trim()) {
      setLinkError('Organization, project, and parent work item id are required.')
      return
    }
    setLinking(true)
    try {
      const res = await apiFetch(`/api/instance/work-items/link?slug=${encodeURIComponent(currentSlug.value)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization: linkForm.organization.trim(),
          project: linkForm.project.trim(),
          parentId: Number(linkForm.parentId.trim()),
          ...(linkForm.workItemType.trim() ? { workItemType: linkForm.workItemType.trim() } : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.message ?? body.error ?? `Link failed (${res.status})`)
      await reloadInstance()
    } catch (err) {
      setLinkError(err.message)
    } finally {
      setLinking(false)
    }
  }

  // "Check gate & sync": runs the same check the dashboard's own Check action does — only once it genuinely PASSes does this open the confirm modal; a FAIL (or a check-request failure) reports status and stops there, exactly as if no linked work item existed at all.
  async function handleCheckAndMaybeConfirm() {
    setStatus('Checking gate…')
    const res = await apiFetch(`/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
      setStatus(`FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`)
      return
    }
    setStatus('Gate passed.')
    setConfirming(true)
  }

  async function handleConfirmSync() {
    setConfirming(false)
    setStatus('Pushing state to work item…')
    const res = await apiFetch(`/api/instance/work-items/sync?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json().catch(() => ({}))
    setStatus(
      res.ok
        ? `Pushed state "${body.state}" to work item #${body.workItemId}.`
        : `Sync failed: ${body.message ?? body.error}`
    )
  }

  function handleDecline() {
    setConfirming(false)
    setStatus('Declined — work item state left unchanged.')
  }

  return html`
    <section class="work-item-panel">
      <h2>Azure DevOps work item</h2>
      ${!workItem
        ? html`
            <div class="link-form">
              <input
                class="text-field"
                type="text"
                placeholder="Organization"
                value=${linkForm.organization}
                onInput=${(e) => setLinkForm({ ...linkForm, organization: e.currentTarget.value })}
              />
              <input
                class="text-field"
                type="text"
                placeholder="Project"
                value=${linkForm.project}
                onInput=${(e) => setLinkForm({ ...linkForm, project: e.currentTarget.value })}
              />
              <input
                class="text-field"
                type="text"
                placeholder="Parent work item id"
                value=${linkForm.parentId}
                onInput=${(e) => setLinkForm({ ...linkForm, parentId: e.currentTarget.value })}
              />
              <input
                class="text-field"
                type="text"
                placeholder="Work item type (default: Task)"
                value=${linkForm.workItemType}
                onInput=${(e) => setLinkForm({ ...linkForm, workItemType: e.currentTarget.value })}
              />
              <button type="button" class="btn primary" disabled=${linking} onClick=${handleLink}>
                ${linking ? 'Linking…' : 'Link instance'}
              </button>
              ${linkError ? html`<div class="inline-error">${linkError}</div>` : null}
            </div>
          `
        : html`
            <p>
              Linked to parent work item #${workItem.parentId} (${workItem.organization}/${workItem.project}, type "${workItem.workItemType}").
            </p>
            <p>This stage's work item: ${stageWorkItemId ? html`#${stageWorkItemId}` : '—'}</p>
            <button type="button" class="btn" onClick=${handleCheckAndMaybeConfirm}>Check gate & sync work item</button>
          `}
      <div class="save-status">${status}</div>
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm work item state update">
                <h3>Push a state update?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to push a new state — drawn from
                  work item #${stageWorkItemId}'s own configured type — to Azure DevOps. Declining leaves that work
                  item's state unchanged.
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDecline}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmSync}>Confirm & push</button>
                </div>
              </div>
            </div>
          `
        : null}
    </section>
  `
}

// ---------- Stage advancement (local instances only; #115, ADR-0012) ----------
// The self-serve "Advance to next stage" action: never rendered at all for
// a Workspace-backed instance (`instance.workspaceBacked` — that one always
// advances via its own Pull Request flow instead, ADR-0014/#122-#125), and
// only while viewing the instance's own *current* stage (`instance.stage.id
// === instance.currentStageId`) — advancing moves this instance's own
// persisted stage pointer forward from wherever it currently sits, so it
// never makes sense to offer it while browsing an earlier or later stage
// via the stage switcher. Mirrors WorkItemPanel's own check-then-confirm
// shape: "Advance to next stage" runs the same gate check every other
// gated action in this app runs, and only a genuine PASS opens the confirm
// dialog — declining it (or a FAIL) leaves the instance's stage genuinely
// unchanged.
function AdvanceStagePanel({ instance }) {
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)

  const isFinalStage = instance.stages[instance.stages.length - 1]?.id === instance.stage.id
  if (instance.workspaceBacked || instance.stage.id !== instance.currentStageId || isFinalStage) return null

  async function handleCheckAndMaybeConfirm() {
    setStatus('Checking gate…')
    const res = await apiFetch(`/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
      setStatus(`FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`)
      return
    }
    setStatus('Gate passed.')
    setConfirming(true)
  }

  async function handleConfirmAdvance() {
    setConfirming(false)
    setStatus('Advancing…')
    const res = await apiFetch(`/api/instance/advance-stage?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Advance failed: ${body.message ?? body.error}`)
      return
    }
    setStatus(`Advanced to "${body.toStage.title}".`)
    // Reset to no explicit stage so the form now shows the instance's new
    // current stage — otherwise `viewedStage` would still hold this
    // (now-completed) stage's id and the screen would appear unchanged.
    //
    // Assigning `viewedStage.value` here already re-triggers the shared
    // instance-loading effect (near the top of this file) *whenever it's
    // a genuine change* — e.g. the user had at some point explicitly
    // clicked this (the current) stage's own nav button, leaving
    // `viewedStage.value` set to its id rather than `null`. Also calling
    // `loadInstance` directly below in that case would race that effect's
    // own fetch (mirrors the exact hazard `ModuleEditorPage`'s own
    // `batch()` comment describes) — so this only fetches directly when
    // `viewedStage.value` was already `null`, the one case where setting
    // it to `null` again is a no-op the effect will never react to.
    const effectWillReload = viewedStage.value !== null
    viewedStage.value = null
    if (!effectWillReload) {
      instanceData.value = await loadInstance(currentSlug.value, null)
    }
  }

  function handleDecline() {
    setConfirming(false)
    setStatus('Declined — stage left unchanged.')
  }

  return html`
    <section class="advance-stage-panel">
      <h2>Stage advancement</h2>
      <button type="button" class="btn" onClick=${handleCheckAndMaybeConfirm}>Advance to next stage</button>
      <div class="save-status">${status}</div>
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm stage advancement">
                <h3>Advance to the next stage?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to move this instance on to its
                  next stage. Declining leaves it at "${instance.stage.title}".
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDecline}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmAdvance}>Confirm & advance</button>
                </div>
              </div>
            </div>
          `
        : null}
    </section>
  `
}

// ---------- The viewed stage's whole screen: modules + work-item panel ----------
// Keyed by stage id from the parent (see ModuleEditorPage) so switching stages remounts this wholesale — fresh CodeMirror instances, matching the old full-DOM-rebuild behaviour. "Clear all fields" and "Render" now live in the view-toggle bar (see ViewModeToolbar, ModuleEditorPage) rather than here, so the field registry they depend on is owned by ModuleEditorPage instead — `onFieldRegistered` is threaded straight through.
function StageScreen({ instance, onFieldRegistered }) {
  return html`
    <main id="modules" data-view-mode=${viewMode.value}>
      ${instance.modules.map(
        (mod) => html`
          <${ModuleCard}
            key=${mod.id}
            mod=${mod}
            stageId=${instance.stage.id}
            onFieldRegistered=${onFieldRegistered}
          />
        `
      )}
      <${AdvanceStagePanel} instance=${instance} />
      <${WorkItemPanel} instance=${instance} />
    </main>
  `
}

// ---------- View-mode toolbar: Markdown/Split/Rendered segmented control ----------
// One toolbar for the whole editor screen (see web/lib/viewMode.js) — sits below AppHeader, above the viewed stage's screen, and (like AppHeader) is never remounted by a stage switch, so `viewMode` reads back the same value the author left it in after navigating fields/modules/stages.
const VIEW_MODE_LABELS = { markdown: 'Markdown', split: 'Split', rendered: 'Rendered' }
const VIEW_MODE_HOTKEY = { ctrlKey: true, shiftKey: true, key: 'v' }

// `instance` and `onClearAllFields` back the "Clear all fields" + "Render"
// pair moved here from the stage screen (#114) — both now sit on the right
// of this same bar, "Clear all fields" immediately left of "Render".
function ViewModeToolbar({ instance, onClearAllFields }) {
  const [renderOpen, setRenderOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key.toLowerCase() !== VIEW_MODE_HOTKEY.key) return
      if (e.ctrlKey !== VIEW_MODE_HOTKEY.ctrlKey || e.shiftKey !== VIEW_MODE_HOTKEY.shiftKey) return
      // Fires even while a CodeMirror editor or other field has focus — it's a distinctive combo unlikely to collide with normal editing, and the ticket asks for a hotkey that cycles the whole screen's view regardless of what the author was just doing.
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
      <div class="toolbar-actions">
        <button type="button" class="btn" onClick=${onClearAllFields}>Clear all fields</button>
        <button type="button" class="btn primary" onClick=${() => setRenderOpen(true)}>Render</button>
      </div>
    </div>
    ${renderOpen ? html`<${RenderDialog} instance=${instance} onClose=${() => setRenderOpen(false)} />` : null}
  `
}

// ---------- Settings dropdown (#107) ----------
// From an instance screen, "Settings" is no longer a single link straight
// to the (now tab-free) Global Settings screen — it opens a small dropdown
// offering Global Settings, Workspace Settings (scoped to this instance's
// own workspace — never a picker across every registered workspace), and
// Instance Settings (assignee, read-only instance info, read-only
// work-item link details). Every link carries an explicit `from` back to
// this exact instance screen (`/instance/<slug>`) — not browser history —
// so each Settings screen's own back control returns here. Mirrors
// SwimlaneChip's own open/close-on-outside-click menu pattern (one open at
// a time, closed by any click outside it).
function SettingsMenu({ instance }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onDocumentClick() {
      setOpen(false)
    }
    window.addEventListener('click', onDocumentClick)
    return () => window.removeEventListener('click', onDocumentClick)
  }, [open])

  const from = encodeURIComponent(`/instance/${instance.slug}`)
  const slug = encodeURIComponent(instance.slug)

  return html`
    <div class=${'settings-menu' + (open ? ' menu-open' : '')}>
      <button
        type="button"
        class="btn small ghost"
        aria-haspopup="true"
        aria-expanded=${open}
        onClick=${(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        Settings
      </button>
      ${open
        ? html`
            <div class="menu" role="menu" onClick=${(e) => e.stopPropagation()}>
              <a role="menuitem" href=${`/settings?from=${from}`}>Global Settings</a>
              <a role="menuitem" href=${`/settings/workspace?slug=${slug}&from=${from}`}>Workspace Settings</a>
              <a role="menuitem" href=${`/settings/instance?slug=${slug}&from=${from}`}>Instance Settings</a>
            </div>
          `
        : null}
    </div>
  `
}

// ---------- Instance switcher (#112) ----------
// A workspace-scoped switcher living in AppHeader: defaults to the viewed
// instance's own workspace's *other* instances (so jumping to a sibling
// instance never requires returning to the Workspaces landing page — #112's
// own acceptance criteria), with an explicit escape hatch to cross into a
// different workspace's instances instead. Reuses the same unified
// `GET /api/instances` listing and `groupInstancesByWorkspace` grouping the
// dashboard (#102) already relies on, rather than adding a second
// server-side listing route — the client already has everything this
// needs, since every row already carries its own `workspace` (or none, for
// a local instance).
//
// The escape hatch's own UI copy deliberately avoids the word "workspace"
// ("Browse other instances" / "← Back", not "Switch workspace" / "← This
// workspace") — `groupInstancesByWorkspace` groups a local instance onto
// its own single-instance "group" exactly like a real Azure-DevOps-backed
// one (#102's own convention), so the escape hatch's *other groups* can
// just as easily be another unrelated local instance as a genuine
// Workspace. Workspace is a specific, reserved entity in this codebase (an
// Azure DevOps organization/project/repository, docs/adr/0009) — this file
// already renamed "Open workspace" to "Open editor" once (#96 vs #102) to
// avoid exactly this kind of collision, so new copy here must not
// re-introduce it by implying every escape-hatch destination is a
// Workspace when it may just be another local instance.
//
// Navigating a sibling instance is a plain `<a href="/instance/:slug">` —
// exactly the link ModuleEditorPage's own doc comment already documents as
// re-pinning every instance-scoped signal on slug change, so this needs no
// extra plumbing of its own.
function isWorkspaceGroup(group) {
  return Boolean(group?.instances[0]?.workspace)
}

function InstanceSwitcher({ slug }) {
  const [open, setOpen] = useState(false)
  const [instances, setInstances] = useState(null)
  const [error, setError] = useState('')
  // Resets to the default (own-workspace) view every time the menu is
  // freshly opened — a stale "cross-workspace" view left open from a
  // previous visit would otherwise greet the user with the wrong list.
  const [crossWorkspace, setCrossWorkspace] = useState(false)

  useEffect(() => {
    if (!open || instances !== null || error) return
    // Passes `slug` so this attaches *this* instance's own workspace PAT
    // override (#104), not just the global default — see loadInstances's
    // own doc comment for why that matters here specifically.
    loadInstances(slug)
      .then(setInstances)
      .catch((err) => setError(err.message))
  }, [open, instances, error, slug])

  // Closes on Escape (matches every other dismissible panel in this file —
  // AssetInsertModal, PatPromptModal) and on any click outside the
  // switcher itself. There's no natural ancestor element to hang a
  // click-outside-to-close on the way SwimlaneChip's own menu does (a
  // whole swimlane-group wrapper) — the header isn't otherwise a click
  // target — so this listens on the window directly instead, same as the
  // Escape handling right alongside it.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onWindowClick() {
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('click', onWindowClick)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('click', onWindowClick)
    }
  }, [open])

  function toggle(e) {
    e.stopPropagation()
    setCrossWorkspace(false)
    setOpen((prev) => !prev)
  }

  const groups = instances ? groupInstancesByWorkspace(instances) : []
  const currentGroup = groups.find((group) => group.instances.some((inst) => inst.slug === slug)) ?? null
  const siblings = currentGroup ? currentGroup.instances.filter((inst) => inst.slug !== slug) : []
  const otherGroups = groups.filter((group) => group.key !== currentGroup?.key)

  function renderInstanceLink(inst) {
    return html`
      <a key=${inst.slug} class="switcher-item" href="/instance/${inst.slug}" onClick=${() => setOpen(false)}>
        <span class="name">${inst.slug}</span>
        <span class="def">${inst.definition}</span>
      </a>
    `
  }

  return html`
    <div class="instance-switcher" onClick=${(e) => e.stopPropagation()}>
      <button
        type="button"
        class="btn small ghost"
        aria-haspopup="true"
        aria-expanded=${open}
        onClick=${toggle}
      >
        Switch instance ▾
      </button>
      ${open
        ? html`
            <div class="menu">
              ${error ? html`<p class="load-error">${error}</p>` : null}
              ${!error && instances === null ? html`<p class="loading">Loading…</p>` : null}
              ${instances !== null && !crossWorkspace
                ? html`
                    <div class="switcher-section">
                      <div class="switcher-heading">${isWorkspaceGroup(currentGroup) ? currentGroup.title : 'Local instance'}</div>
                      ${siblings.length > 0
                        ? siblings.map(renderInstanceLink)
                        : isWorkspaceGroup(currentGroup)
                          ? html`<p class="switcher-empty">No other instances in this workspace.</p>`
                          : html`<p class="switcher-empty">No other instances — not part of a workspace.</p>`}
                      ${otherGroups.length > 0
                        ? html`
                            <button
                              type="button"
                              class="switcher-escape"
                              onClick=${() => setCrossWorkspace(true)}
                            >
                              Browse other instances →
                            </button>
                          `
                        : null}
                    </div>
                  `
                : null}
              ${instances !== null && crossWorkspace
                ? html`
                    <div class="switcher-section">
                      <button type="button" class="switcher-back" onClick=${() => setCrossWorkspace(false)}>
                        ← Back
                      </button>
                      ${otherGroups.map(
                        (group) => html`
                          <div class="switcher-group" key=${group.key}>
                            <div class="switcher-heading">${group.title}</div>
                            ${group.instances.map(renderInstanceLink)}
                          </div>
                        `
                      )}
                    </div>
                  `
                : null}
            </div>
          `
        : null}
    </div>
  `
}

// ---------- Header: title, stage line, free-browse stage nav ----------
// The theme toggle used to live here too, duplicated across this header,
// the Workspaces landing header, the setup wizard header, and Settings'
// header (#113) — now lives solely in Settings (web/pages/settings.js's
// SettingsHeader).
function AppHeader({ instance }) {
  return html`
    <header>
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <a class="btn small ghost" href="/">← Workspaces</a>
        <h1>${instance.slug} — ${instance.definition}</h1>
        <${InstanceSwitcher} slug=${instance.slug} />
        <a class="btn small ghost" href="/new-workspace">+ New Workspace</a>
        <${SettingsMenu} instance=${instance} />
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
// `slug` arrives as a route param from `/instance/:slug` (preact-iso passes matched params as top-level props). Re-pins the shared instance-scoped signals to this slug on mount and whenever the route's slug changes — e.g. following an "Open editor" link (#102 — this screen used to call that link "Open workspace", renamed to avoid colliding with the Workspace entity, #96) from one instance straight to another without an intervening full page load — clearing the previous instance's stale data first so it's never shown against the new slug. `batch()` matters here: without it, `currentSlug.value = slug` alone fires the instance-loading effect below (it's already subscribed to `currentSlug`) using whatever `viewedStage` was still left over from the instance just navigated away from — a stage that may not even be this new instance's current one — before the very next line resets it. That fires a real, wasted request for the wrong stage, whose response can race the correct one. Batching applies all four writes as one update, so the effect runs exactly once, with the new slug and `viewedStage: null` together.
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

  // The field registry backing "Clear all fields" (#114 moved this button,
  // and hence this registry, up from StageScreen into this parent — the
  // toolbar it now lives in sits above StageScreen and outlives any single
  // stage's mount, so it's no longer freed-and-refreshed just by
  // StageScreen's own key-driven remount). Rather than resetting it in a
  // separate effect keyed on the stage id — which would race the freshly
  // mounted stage's own ModuleCard/MarkdownField registration effects
  // (child effects commit before an ancestor's, so a parent-level reset
  // effect could fire *after* the new stage's fields already registered,
  // wiping them out) — registerField itself detects a stage change and
  // resets synchronously before recording the new field, so there's no
  // window where a genuinely-current registration can be discarded.
  const registryRef = useRef({ stageId: null, entries: [] })

  function registerField(field, control) {
    if (registryRef.current.stageId !== instance.stage.id) {
      registryRef.current = { stageId: instance.stage.id, entries: [] }
    }
    registryRef.current.entries.push({ field, control })
  }

  function clearAllFields() {
    registryRef.current.entries.forEach(({ field, control }) => control.setValue(field.type === 'list' ? [] : ''))
  }

  if (error) return html`<p class="load-error">Failed to load: ${error}</p>`
  if (!instance || instance.slug !== slug) return html`<p class="loading">Loading…</p>`

  return html`
    <${AppHeader} instance=${instance} />
    <${ViewModeToolbar} instance=${instance} onClearAllFields=${clearAllFields} />
    <${StageScreen} key=${instance.stage.id} instance=${instance} onFieldRegistered=${registerField} />
  `
}

// ============================================================ Workspaces landing page (#77, restructured by #102) — the landing screen at `/`, titled "Workspaces". Two togglable views over the multi-instance registry (`GET /api/instances`, #76): master-detail (default, grouping instances by workspace — see groupInstancesByWorkspace above) and stage swimlanes (still one chip per instance, ungrouped — the ticket's own acceptance criteria describe the *list*, i.e. master-detail's list pane, not this alternate view). The view choice is a persisted signal (web/lib/dashboardView.js), not local state, so it survives remounting this page and reloading the app. ============================================================

// `slug` is optional: the Workspaces landing page (DashboardPage) calls
// this with none, since it has no single "current" workspace in mind and
// only ever wants the global-default PAT's best-effort view (see
// lib/registry.js's buildAzureDevOpsRow — an entry this PAT can't
// authenticate to is simply left out, not treated as a fatal error). A
// caller that *does* already know which instance it's asking on behalf of
// (InstanceSwitcher, below) should pass its slug, so this resolves and
// attaches that instance's own workspace PAT override (#104) via
// `apiFetchForInstance` instead of only ever trying the global default —
// otherwise a workspace whose override PAT differs from the global default
// would silently drop out of the response entirely (every one of its rows
// failing to authenticate), even for the one instance whose own page is
// making this exact request and already knows the right credential.
async function loadInstances(slug) {
  const res = slug ? await apiFetchForInstance(slug, '/api/instances') : await apiFetch('/api/instances')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instances (${res.status})`)
  }
  return res.json()
}

// Registry `status` is only ever 'complete'/'incomplete' (the current stage's requirements) — a different, coarser vocabulary than a module's own draft/review/agreed frontmatter status. Reuses the same `.stamp` tokens (agreed = done, draft = still in progress) rather than inventing a third visual language, since the Gate Ledger only defines those three.
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
      <a class="btn primary" href="/new-workspace">+ New Workspace</a>
    </div>
  `
}

// Runs an instance's Check or Render action against the registry-listing API's slug (not the module editor's shared signals, which only track whichever single instance is currently open) — the dashboard can trigger either action for any listed instance without navigating away from it.
async function runCheck(slug) {
  const res = await apiFetchForInstance(slug, `/api/instance/check?slug=${encodeURIComponent(slug)}`)
  const body = await res.json()
  if (!res.ok) return `Check failed: ${body.message ?? body.error}`
  if (body.pass) return 'PASS — gate requirements met.'
  const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
  return `FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`
}

async function runRender(slug) {
  const detailRes = await apiFetchForInstance(slug, `/api/instance?slug=${encodeURIComponent(slug)}`)
  const detail = await detailRes.json()
  if (!detailRes.ok) return `Render failed: ${detail.message ?? detail.error}`
  if (!detail.artefacts.length) return 'No artefact available to render for this stage yet.'
  const results = []
  for (const artefact of detail.artefacts) {
    const res = await apiFetchForInstance(slug, `/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}`, { method: 'POST' })
    const body = await res.json()
    results.push(res.ok ? `Rendered ${artefact.title}` : `${artefact.title} failed: ${body.message ?? body.error}`)
  }
  return results.join(' · ')
}

// Persists the instance record's own stored `assignee` (#97) — the instance detail pane's edit affordance for it, distinct from `PUT /api/instance/modules/:id`'s module-level `owner` (the untouched Design Authority sign-off convention). Not routed through ModuleCard's per-module save flow: this is instance-scoped, not module-scoped.
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

// ---------- Grouping instances by workspace (#102) ----------
// The Workspaces landing page's core grouping rule: an Azure-DevOps-backed row carries a `workspace` (lib/registry.js, #102) — every instance sharing that workspace's `id` groups into one row, one entry per workspace, per the ticket's acceptance criteria. A local instance has no `workspace` at all (Workspace is an Azure-DevOps-repo concept only, #96) — it groups on its own, keyed by its own slug, so a repo (or local instance) holding just one instance still renders through the exact same group shape as one holding several — nothing here special-cases a single-instance group.
function groupInstancesByWorkspace(instances) {
  const groups = new Map()
  for (const inst of instances) {
    const key = inst.workspace ? `workspace:${inst.workspace.id}` : `local:${inst.slug}`
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: inst.workspace ? inst.workspace.repository : inst.slug,
        subtitle: inst.workspace ? `${inst.workspace.organization}/${inst.workspace.project}` : 'Local instance',
        instances: [],
      })
    }
    groups.get(key).instances.push(inst)
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))
}

// The list-pane row's secondary line — deliberately the same shape whether the group holds one instance or several (count · distinct definitions), rather than branching into a one-off "single instance" format, so a single-instance workspace is never visually singled out from a multi-instance one (the ticket's own "no special-casing visible to the user" acceptance criterion).
function groupSummaryText(group) {
  const definitions = [...new Set(group.instances.map((inst) => inst.definition))]
  const count = group.instances.length
  return `${count} instance${count === 1 ? '' : 's'} · ${definitions.join(', ')}`
}

// A group's dot in the list pane reflects every one of its instances being complete, not just the first — a multi-instance workspace with even one outstanding instance is "in progress" as a whole.
function groupStatusClass(group) {
  return group.instances.every((inst) => inst.status === 'complete') ? 'agreed' : 'draft'
}

// ---------- Master-detail view ----------
// The Workspaces landing page's default view (#102, superseding #77's flat per-instance listing): the list pane shows one row per workspace (groupInstancesByWorkspace above); selecting one shows every instance it holds in the detail pane, each its own card with definition/assignee/status and the same Check/Render/Open-editor actions the old flat list offered per instance.
function MasterDetailView({ instances, onInstancesChange }) {
  const [filter, setFilter] = useState('')
  const [selectedKey, setSelectedKey] = useState(null)
  // Keyed by instance slug (not the single shared string the old flat list used) — several instances can be in flight for the *same* selected workspace at once (one Check, one Render, one assignee save), and each must report its own status independently.
  const [actionStatus, setActionStatus] = useState({})
  const [assigneeDrafts, setAssigneeDrafts] = useState({})
  const [assigneeStatus, setAssigneeStatus] = useState({})

  const groups = groupInstancesByWorkspace(instances)

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? groups.filter(
        (group) =>
          group.title.toLowerCase().includes(needle) ||
          group.subtitle.toLowerCase().includes(needle) ||
          group.instances.some(
            (inst) => inst.slug.toLowerCase().includes(needle) || inst.assignee.toLowerCase().includes(needle)
          )
      )
    : groups

  const effectiveKey = filtered.some((group) => group.key === selectedKey) ? selectedKey : (filtered[0]?.key ?? null)
  const selectedGroup = groups.find((group) => group.key === effectiveKey) ?? null

  // Resets every instance-scoped edit/action state whenever the selected workspace changes — never while it's still the same workspace (that would clobber an in-progress edit or Check/Render status on every unrelated `instances` refresh), and seeds the assignee drafts from the newly-selected workspace's own instances.
  useEffect(() => {
    setActionStatus({})
    setAssigneeStatus({})
    setAssigneeDrafts(Object.fromEntries((selectedGroup?.instances ?? []).map((inst) => [inst.slug, inst.assignee ?? ''])))
    // eslint-disable-next-line
  }, [effectiveKey])

  async function handleCheck(slug) {
    setActionStatus((prev) => ({ ...prev, [slug]: 'Checking…' }))
    const result = await runCheck(slug)
    setActionStatus((prev) => ({ ...prev, [slug]: result }))
  }

  async function handleRender(slug) {
    setActionStatus((prev) => ({ ...prev, [slug]: 'Rendering…' }))
    const result = await runRender(slug)
    setActionStatus((prev) => ({ ...prev, [slug]: result }))
  }

  async function handleAssigneeSave(slug) {
    const inst = selectedGroup?.instances.find((i) => i.slug === slug)
    const draft = assigneeDrafts[slug] ?? ''
    if (!inst || draft === (inst.assignee ?? '')) return
    setAssigneeStatus((prev) => ({ ...prev, [slug]: 'Saving…' }))
    try {
      const saved = await saveAssignee(slug, draft)
      setAssigneeStatus((prev) => ({ ...prev, [slug]: 'Saved.' }))
      onInstancesChange?.((prev) => prev.map((i) => (i.slug === slug ? { ...i, assignee: saved.assignee } : i)))
    } catch (err) {
      setAssigneeStatus((prev) => ({ ...prev, [slug]: `Failed to save: ${err.message}` }))
    }
  }

  return html`
    <div class="master-detail">
      <div class="list-pane">
        <input
          class="field search"
          type="text"
          placeholder="Filter by workspace, instance, assignee…"
          value=${filter}
          onInput=${(e) => setFilter(e.currentTarget.value)}
        />
        <div class="instance-list">
          ${filtered.map(
            (group) => html`
              <div
                key=${group.key}
                class=${'list-item' + (group.key === effectiveKey ? ' selected' : '')}
                role="button"
                tabindex="0"
                onClick=${() => setSelectedKey(group.key)}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedKey(group.key)
                }}
              >
                <span class=${'dot ' + groupStatusClass(group)}></span>
                <span class="meta">
                  <span class="name">${group.title}</span>
                  <span class="def">${groupSummaryText(group)}</span>
                </span>
              </div>
            `
          )}
          ${filtered.length === 0 ? html`<p class="loading">No workspaces match "${filter}".</p>` : null}
        </div>
      </div>
      <div class="detail-pane">
        ${!selectedGroup
          ? html`<div class="placeholder">Select a workspace to see its instances.</div>`
          : html`
              <h2>${selectedGroup.title}</h2>
              <p class="workspace-subtitle">${selectedGroup.subtitle}</p>
              <div class="workspace-instances">
                ${selectedGroup.instances.map(
                  (inst) => html`
                    <div class="instance-card" key=${inst.slug}>
                      <div class="instance-card-header">
                        <span class="name">${inst.slug}</span>
                        <span class="def">${inst.definition}</span>
                        <${StatusStamp} status=${inst.status} />
                      </div>
                      <div class="instance-card-row">
                        <span class="field-label">Assignee</span>
                        <input
                          class="text-field mono assignee-input"
                          type="text"
                          placeholder="Unassigned"
                          value=${assigneeDrafts[inst.slug] ?? ''}
                          onInput=${(e) => {
                            const value = e.currentTarget.value
                            setAssigneeDrafts((prev) => ({ ...prev, [inst.slug]: value }))
                          }}
                          onBlur=${() => handleAssigneeSave(inst.slug)}
                          onKeyDown=${(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                          }}
                        />
                      </div>
                      <div class="save-status assignee-save-status">${assigneeStatus[inst.slug] ?? ''}</div>
                      <div class="detail-actions">
                        <a class="btn primary" href="/instance/${inst.slug}">Open editor</a>
                        <button type="button" class="btn" onClick=${() => handleCheck(inst.slug)}>Check</button>
                        <button type="button" class="btn" onClick=${() => handleRender(inst.slug)}>Render</button>
                      </div>
                      <div class="save-status">${actionStatus[inst.slug] ?? ''}</div>
                    </div>
                  `
                )}
              </div>
            `}
      </div>
    </div>
  `
}

// ---------- Stage-swimlane view ----------
// One overflow menu open at a time, closed by clicking anywhere else in the lanes (the wrapping onClick resets it; the menu button itself stops propagation so opening/toggling it doesn't immediately re-close it).
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
        <h1>Workspaces</h1>
        <div class="dashboard-controls">
          ${instances?.length ? html`<${ViewToggle} />` : null}
          <a class="btn small ghost" href="/new-workspace">+ New Workspace</a>
          <a class="btn small ghost" href=${`/settings?from=${encodeURIComponent('/')}`}>Settings</a>
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
// Rendered globally (see App() below) rather than scoped to any one screen — `apiFetch` (web/lib/apiFetch.js) opens it (via `requestPat()`) the moment *any* request against gantry's own API comes back with the structured "authentication required" response, regardless of which route triggered it. Local instances never produce that response, so this never opens for them — nothing here checks "is this instance local" itself.
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
// Eight routes: the dashboard (#77, default/landing), the module editor per instance, the "+ New Workspace" wizard (#110, replacing the old #78 instance-setup wizard), the asset library (#80), and three tab-free Settings screens (#107, superseding #101/#104's single tabbed `/settings`) — Global Settings, Workspace Settings (scoped to one instance's own workspace), and Instance Settings (assignee, read-only instance info, read-only work-item link details). `instanceData`/`loadError` above are populated regardless of which route is active (the `effect()` isn't scoped to a component), so the library screen never has to re-fetch instance data just to know which instance it's browsing.
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} path="/instance/:slug" component=${ModuleEditorPage} />
        <${Route} path="/new-workspace" component=${NewWorkspaceWizardPage} />
        <${Route} path="/assets" component=${AssetLibraryPage} />
        <${Route} path="/settings" component=${GlobalSettingsPage} />
        <${Route} path="/settings/workspace" component=${WorkspaceSettingsPage} />
        <${Route} path="/settings/instance" component=${InstanceSettingsPage} />
        <${Route} default component=${DashboardPage} />
      <//>
    <//>
    ${promptOpen.value ? html`<${PatPromptModal} />` : null}
  `
}

render(html`<${App} />`, document.getElementById('app'))
