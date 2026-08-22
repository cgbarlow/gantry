// gantry's production UI entry point — Preact, delivered via HTM tagged
// templates with no build step, per docs/adr/0006-preact-frontend-framework.md.
// `preact-iso` provides the routing shell — the instance dashboard (#77) at
// `/`, the module editor at `/instance/:slug` — and `@preact/signals` holds
// the instance-scoped state (the viewed slug and stage, the fetched
// instance data) that's shared across the module editor screen's header,
// nav, and module list, exactly as today's DOM version threaded a `stageId`
// through a single re-render function.
import { html, render } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { signal, effect } from '@preact/signals'
import { LocationProvider, Router, Route } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { theme, cycleTheme } from './lib/theme.js'
import { VIEW_MODES, viewMode } from './lib/dashboardView.js'

const md = new MarkdownIt()

async function loadInstance(slug, stageId) {
  const params = new URLSearchParams()
  if (slug) params.set('slug', slug)
  if (stageId) params.set('stage', stageId)
  const qs = params.toString()
  const res = await fetch(qs ? `/api/instance?${qs}` : '/api/instance')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to load instance (${res.status})`)
  }
  return res.json()
}

function renderPreview(node, text) {
  if (!node) return
  node.innerHTML = DOMPurify.sanitize(md.render(text ?? ''))
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

// ---------- Markdown field ----------
// EditorView.updateListener -> markdown-it -> DOMPurify -> sibling preview
// pane, per docs/adr/0004-markdown-editor-codemirror.md. The CodeMirror
// instance is the source of truth for the field's value, so getValue/setValue
// read and write it directly rather than duplicating it into component state.
function MarkdownField({ field, onRegister }) {
  const hostRef = useRef(null)
  const previewRef = useRef(null)

  useEffect(() => {
    const state = EditorState.create({
      doc: field.value ?? '',
      extensions: [
        basicSetup,
        markdown(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) renderPreview(previewRef.current, update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    renderPreview(previewRef.current, field.value ?? '')

    onRegister({
      getValue: () => view.state.doc.toString(),
      setValue: (text) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
        renderPreview(previewRef.current, text ?? '')
      },
    })

    return () => view.destroy()
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
  const controlsRef = useRef([])

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
          : html`<${MarkdownField} key=${field.id} field=${field} onRegister=${onRegister} />`
      })}
      <div class="save-status">${status}</div>
      <button type="button" class="btn primary" onClick=${handleSave}>Save ${mod.title}</button>
    </section>
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
    <main id="modules">
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
// `slug` arrives as a route param from `/instance/:slug` (preact-iso passes
// matched params as top-level props). Re-pins the shared instance-scoped
// signals to this slug on mount and whenever the route's slug changes —
// e.g. following an "Open workspace" link from one instance straight to
// another without an intervening full page load — clearing the previous
// instance's stale data first so it's never shown against the new slug.
function ModuleEditorPage({ slug }) {
  useEffect(() => {
    currentSlug.value = slug
    viewedStage.value = null
    instanceData.value = null
    loadError.value = null
  }, [slug])

  const instance = instanceData.value
  const error = loadError.value

  if (error) return html`<p class="load-error">Failed to load: ${error}</p>`
  if (!instance || instance.slug !== slug) return html`<p class="loading">Loading…</p>`

  return html`
    <${AppHeader} instance=${instance} />
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
  const res = await fetch('/api/instances')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to load instances (${res.status})`)
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
      ${VIEW_MODES.map(
        (mode) => html`
          <button
            type="button"
            key=${mode}
            class=${'btn small' + (viewMode.value === mode ? ' active' : '')}
            aria-pressed=${viewMode.value === mode}
            onClick=${() => (viewMode.value = mode)}
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
      <a class="btn primary" href="/instances/new">+ New instance</a>
    </div>
  `
}

// Runs an instance's Check or Render action against the registry-listing
// API's slug (not the module editor's shared signals, which only track
// whichever single instance is currently open) — the dashboard can trigger
// either action for any listed instance without navigating away from it.
async function runCheck(slug) {
  const res = await fetch(`/api/instance/check?slug=${encodeURIComponent(slug)}`)
  const body = await res.json()
  if (!res.ok) return `Check failed: ${body.error}`
  if (body.pass) return 'PASS — gate requirements met.'
  const outstanding = body.modules.filter((m) => !m.complete).map((m) => m.title)
  return `FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`
}

async function runRender(slug) {
  const detailRes = await fetch(`/api/instance?slug=${encodeURIComponent(slug)}`)
  const detail = await detailRes.json()
  if (!detailRes.ok) return `Render failed: ${detail.error}`
  if (!detail.artefacts.length) return 'No artefact available to render for this stage yet.'
  const results = []
  for (const artefact of detail.artefacts) {
    const res = await fetch(`/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}`, { method: 'POST' })
    const body = await res.json()
    results.push(res.ok ? `Rendered ${artefact.title}` : `${artefact.title} failed: ${body.error}`)
  }
  return results.join(' · ')
}

// ---------- Master-detail view ----------
function MasterDetailView({ instances }) {
  const [filter, setFilter] = useState('')
  const [selectedSlug, setSelectedSlug] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [actionStatus, setActionStatus] = useState('')

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? instances.filter((inst) => inst.slug.toLowerCase().includes(needle) || inst.owner.toLowerCase().includes(needle))
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
    fetch(`/api/instance?slug=${encodeURIComponent(effectiveSlug)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load "${effectiveSlug}" (${res.status})`)
        return res.json()
      })
      .then(setDetail)
      .catch((err) => setDetailError(err.message))
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

  return html`
    <div class="master-detail">
      <div class="list-pane">
        <input
          class="field search"
          type="text"
          placeholder="Filter by name, owner…"
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
                  <span class="def">${inst.definition} · ${inst.owner || 'unowned'}</span>
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
                    <span class="field-label">Owner</span><span class="mono">${selectedInstance.owner || '—'}</span>
                  </div>
                </div>
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
        <span class="owner">${instance.owner || 'unowned'}</span>
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
      fetch(`/api/definitions/${encodeURIComponent(definitionId)}/stages`)
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
        ${instances?.length ? html`<${ViewToggle} />` : null}
      </div>
      ${error
        ? html`<p class="load-error">Failed to load: ${error}</p>`
        : !instances
          ? html`<p class="loading">Loading…</p>`
          : instances.length === 0
            ? html`<${EmptyState} />`
            : viewMode.value === 'swimlanes'
              ? html`<${SwimlaneView} instances=${instances} />`
              : html`<${MasterDetailView} instances=${instances} />`}
    </main>
  `
}

// A minimal stand-in for the "+ New instance" call to action until the
// instance-setup wizard (#78, blocked by the same predecessors as this
// ticket but not yet built) lands — keeps the CTA a real, working
// navigation target rather than a dead link or a JS alert().
function InstanceSetupPlaceholderPage() {
  return html`
    <main class="dashboard">
      <h1>New instance</h1>
      <p class="lede">
        The instance-setup wizard (#78) isn't built yet. Once it lands, this is where you'll register a new
        repo-backed instance so it appears on the dashboard.
      </p>
      <a class="btn" href="/">← Back to instances</a>
    </main>
  `
}

// ---------- App shell: preact-iso routing ----------
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} path="/instance/:slug" component=${ModuleEditorPage} />
        <${Route} path="/instances/new" component=${InstanceSetupPlaceholderPage} />
        <${Route} default component=${DashboardPage} />
      <//>
    <//>
  `
}

render(html`<${App} />`, document.getElementById('app'))
