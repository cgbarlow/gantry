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
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { theme, cycleTheme } from './lib/theme.js'

const md = new MarkdownIt()

async function loadInstance(stageId) {
  const url = stageId ? `/api/instance?stage=${encodeURIComponent(stageId)}` : '/api/instance'
  const res = await fetch(url)
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
    <${StageScreen} key=${instance.stage.id} instance=${instance} />
  `
}

// ---------- App shell: preact-iso routing, one route today ----------
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} default component=${ModuleEditorPage} />
      <//>
    <//>
  `
}

render(html`<${App} />`, document.getElementById('app'))
