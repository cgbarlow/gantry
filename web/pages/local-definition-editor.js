// The local-workspace definition editor (WI #384, ADR-0029, parent Feature
// #380) — phase 3 (WI #381) gave a *library* definition a first-class editor
// at /definitions; this is the local-workspace counterpart at
// /definitions/local?ws=<workspaceId>[&id=<definitionId>&version=<n>]: create,
// edit and publish a definition that lives only in the folder a local
// workspace already has open, read and written straight through the File
// System Access API (`web/lib/localDefinitionFiles.js`) — never through the
// gantry server except for the stateless structural-validation round trip
// (`POST /api/local/definition/validate`, `lib/localWorkspace.js`).
//
// Deliberately smaller than `web/pages/definition-viewer.js`'s rich
// drag-and-drop/focus-pane editor: no reordering, no docked Library/Copy
// panel, module/stage membership and artefact requirements are edited as
// comma-separated id lists rather than pickers. Every *write* it performs —
// definition.yaml + modules/*.yaml, an artefact's template text, an
// artefact's reference .docx — is the real thing a local-workspace
// definition needs, covering this ticket's "create, edit, publish" scope; a
// richer editing UI is follow-on work, not a stateless-endpoint or file-format
// gap.
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { reorder } from '../lib/reorder.js'
import {
  getWorkspaceHandle,
  ensurePermission,
} from '../lib/localWorkspace.js'
import {
  isValidLocalDefinitionId,
  isValidDocxBuffer,
  blankLocalDefinitionStructure,
  readLocalDefinitionStructure,
  writeLocalDefinitionStructure,
  readLocalDefinitionTemplate,
  writeLocalDefinitionTemplate,
  writeLocalDefinitionReferenceDocx,
  listLocalDefinitions,
} from '../lib/localDefinitionFiles.js'

const GATES = ['business-case', 'design-review', 'implementation-ready']
// #86 (ADR-0044): select/text/date join the local-workspace editor's own field-type vocabulary,
// mirroring web/pages/definition-viewer.js's server-hosted editor — see that page's own Type
// <select> for the identical list.
const FIELD_TYPES = ['markdown', 'list', 'select', 'text', 'date']

function templateFileName(artefactId) {
  return `${artefactId}.md.tmpl`
}

// #89 (ADR-0045): verbatim port of web/pages/definition-viewer.js's own FILENAME_BUILTIN_TOKENS —
// see that file's comment for the source of truth (filenamePatternProblems, lib/definition.js).
const FILENAME_BUILTIN_TOKENS = [
  { token: 'instance.name', label: 'Instance name' },
  { token: 'instance.slug', label: 'Instance slug' },
  { token: 'today', label: "Today's date" },
]

// Verbatim port of web/pages/definition-viewer.js's own eligibleFilenameFields — see that
// file's comment for the acceptance rule this mirrors (filenamePatternProblems, lib/definition.js).
function eligibleFilenameFields(modules, artefact) {
  const results = []
  const seen = new Set()
  for (const requirement of artefact.requires ?? []) {
    const ref = requirement.endsWith('?') ? requirement.slice(0, -1) : requirement
    const dot = ref.indexOf('.')
    const moduleId = dot === -1 ? ref : ref.slice(0, dot)
    const fieldId = dot === -1 ? null : ref.slice(dot + 1)
    const mod = (modules ?? []).find((m) => m.id === moduleId)
    if (!mod) continue
    const fields = fieldId ? (mod.fields ?? []).filter((f) => f.id === fieldId) : (mod.fields ?? [])
    for (const f of fields) {
      if (!['select', 'text', 'date'].includes(f.type) || (f.type === 'select' && f.multiple === true)) continue
      const token = `${moduleId}.${f.id}`
      if (seen.has(token)) continue
      seen.add(token)
      results.push({ token, label: `${mod.title} · ${f.title}` })
    }
  }
  return results
}

function splitIds(text) {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function knownLibraryIds() {
  const res = await fetch('/api/definitions?includeWorkspaces=1')
  if (!res.ok) return new Set()
  const rows = await res.json().catch(() => [])
  return new Set((Array.isArray(rows) ? rows : []).map((row) => row.id))
}

async function validateStructure(structure) {
  const res = await fetch('/api/local/definition/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structure }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Validation request failed (${res.status})`)
  }
  return res.json()
}

function CreateDefinitionForm({ workspaceId, handle, onCreated }) {
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function create(e) {
    e.preventDefault()
    setError(null)
    if (!isValidLocalDefinitionId(id)) {
      setError('Enter a valid id — letters, digits, dot, dash, underscore only, no "/" or "..".')
      return
    }
    setBusy(true)
    try {
      // WI #384's own uniqueness rule: checked against the server library
      // (the server cannot see other local workspaces, so that half of the
      // check is client-side, against this workspace's own definitions/
      // folder) — "ids are unique across the library and every workspace" as
      // far as this workspace can actually verify.
      const [libraryIds, localDefs] = await Promise.all([knownLibraryIds(), listLocalDefinitions(handle)])
      if (libraryIds.has(id)) {
        setError(`"${id}" already exists in the server library.`)
        return
      }
      if (localDefs.some((d) => d.id === id)) {
        setError(`"${id}" already exists in this workspace.`)
        return
      }
      const structure = blankLocalDefinitionStructure(id, title)
      await writeLocalDefinitionStructure(handle, id, 1, structure)
      onCreated(id, 1)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return html`
    <form class="local-definition-create" onSubmit=${create}>
      <h2>New local definition</h2>
      <p class="workspace-subtitle">Saved straight into this workspace's own <code>definitions/</code> folder — never sent to the gantry server.</p>
      <label class="field-label" for="local-def-id">Id</label>
      <input id="local-def-id" class="wizard-input" type="text" value=${id} onInput=${(e) => setId(e.currentTarget.value)} placeholder="my-definition" />
      <label class="field-label" for="local-def-title">Title</label>
      <input id="local-def-title" class="wizard-input" type="text" value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} placeholder="My Definition" />
      ${error ? html`<p class="load-error">${error}</p>` : null}
      <div class="detail-actions">
        <button type="submit" class="btn primary" disabled=${busy}>${busy ? 'Creating…' : 'Create'}</button>
      </div>
    </form>
  `
}

function FieldRow({ field, readOnly, onChange, onRemove }) {
  // #86 (ADR-0044): switching a select field to any other type discards options:/multiple:/
  // default: — the same window.confirm-before-discard convention
  // web/pages/definition-viewer.js's own Type <select> uses.
  function setType(nextType) {
    if (field.type === 'select' && nextType !== 'select' && Array.isArray(field.options) && field.options.length > 0) {
      const confirmed = typeof window !== 'undefined' && window.confirm
        ? window.confirm(`Changing "${field.title || field.id}" from "select" to "${nextType}" discards its ${field.options.length} option${field.options.length === 1 ? '' : 's'}. Continue?`)
        : true
      if (!confirmed) return
    }
    const next = { ...field, type: nextType }
    if (nextType !== 'select') {
      delete next.options
      delete next.multiple
      delete next.default
    }
    onChange(next)
  }
  function updateOption(index, value) {
    const options = field.options.slice()
    options[index] = value
    onChange({ ...field, options })
  }
  function addOption() {
    onChange({ ...field, options: [...(field.options ?? []), ''] })
  }
  function removeOption(index) {
    const removed = field.options[index]
    const options = field.options.filter((_, i) => i !== index)
    const next = { ...field, options }
    if (next.default === removed) delete next.default
    onChange(next)
  }
  function moveOption(index, to) {
    onChange({ ...field, options: reorder(field.options, index, to) })
  }
  return html`
    <div class="local-def-field-block">
      <div class="local-def-field-row">
        <input class="wizard-input" type="text" value=${field.id} placeholder="field-id" readOnly=${readOnly} onInput=${(e) => onChange({ ...field, id: e.currentTarget.value })} />
        <input class="wizard-input" type="text" value=${field.title ?? ''} placeholder="Title" readOnly=${readOnly} onInput=${(e) => onChange({ ...field, title: e.currentTarget.value })} />
        <select class="wizard-input defn-field-type" value=${field.type ?? 'markdown'} disabled=${readOnly} onChange=${(e) => setType(e.currentTarget.value)}>
          ${FIELD_TYPES.map((t) => html`<option value=${t}>${t}</option>`)}
        </select>
        <label class="field-label">
          <input type="checkbox" checked=${field.required === true} disabled=${readOnly} onChange=${(e) => onChange({ ...field, required: e.currentTarget.checked ? true : undefined })} />
          required
        </label>
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${onRemove}>Remove field</button>`}
      </div>
      ${field.type === 'select' ? html`
        <div class="local-def-options">
          ${(field.options ?? []).map((opt, oi) => html`
            <div key=${oi} class="local-def-option-row">
              <input class="wizard-input defn-option-input" type="text" value=${opt} placeholder="Option value" readOnly=${readOnly} onInput=${(e) => updateOption(oi, e.currentTarget.value)} />
              ${readOnly ? null : html`
                <span class="defn-move-btns">
                  <button type="button" class="btn small ghost" aria-label=${`Move option "${opt}" up`} disabled=${oi === 0} onClick=${() => moveOption(oi, oi - 1)}>↑</button>
                  <button type="button" class="btn small ghost" aria-label=${`Move option "${opt}" down`} disabled=${oi === field.options.length - 1} onClick=${() => moveOption(oi, oi + 1)}>↓</button>
                </span>
                <button type="button" class="btn small ghost" aria-label=${`Remove option "${opt}"`} onClick=${() => removeOption(oi)}>✕</button>
              `}
            </div>
          `)}
          ${readOnly ? null : html`<button type="button" class="btn small ghost defn-add-option" onClick=${addOption}>+ Add option</button>`}
          <label class="field-label defn-field-multiple">
            <input type="checkbox" checked=${field.multiple === true} disabled=${readOnly} onChange=${(e) => {
              const next = { ...field }
              if (e.currentTarget.checked) next.multiple = true
              else delete next.multiple
              onChange(next)
            }} />
            multiple
          </label>
          <label class="field-label">
            Default
            <select class="wizard-input defn-field-default" value=${field.default ?? ''} disabled=${readOnly} onChange=${(e) => {
              const next = { ...field }
              if (e.currentTarget.value === '') delete next.default
              else next.default = e.currentTarget.value
              onChange(next)
            }}>
              <option value="">None</option>
              ${(field.options ?? []).filter((o) => o !== '').map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
            </select>
          </label>
        </div>
      ` : null}
    </div>
  `
}

function ModuleEditor({ mod, readOnly, onChange, onRemove }) {
  function updateField(index, next) {
    const fields = mod.fields.slice()
    fields[index] = next
    onChange({ ...mod, fields })
  }
  function removeField(index) {
    const fields = mod.fields.slice()
    fields.splice(index, 1)
    onChange({ ...mod, fields })
  }
  function addField() {
    onChange({ ...mod, fields: [...mod.fields, { id: '', title: '', type: 'markdown' }] })
  }
  return html`
    <div class="local-def-element">
      <div class="local-def-element-header">
        <input class="wizard-input" type="text" value=${mod.id} placeholder="module-id" readOnly=${readOnly} onInput=${(e) => onChange({ ...mod, id: e.currentTarget.value })} />
        <input class="wizard-input" type="text" value=${mod.title ?? ''} placeholder="Title" readOnly=${readOnly} onInput=${(e) => onChange({ ...mod, title: e.currentTarget.value })} />
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${onRemove}>Remove module</button>`}
      </div>
      <input class="wizard-input" type="text" value=${mod.purpose ?? ''} placeholder="Purpose" readOnly=${readOnly} onInput=${(e) => onChange({ ...mod, purpose: e.currentTarget.value })} />
      ${mod.fields.map((field, i) => html`<${FieldRow} key=${i} field=${field} readOnly=${readOnly} onChange=${(f) => updateField(i, f)} onRemove=${() => removeField(i)} />`)}
      ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${addField}>+ Add field</button>`}
    </div>
  `
}

function StageEditor({ stage, readOnly, onChange, onRemove }) {
  return html`
    <div class="local-def-element">
      <div class="local-def-element-header">
        <input class="wizard-input" type="text" value=${stage.id} placeholder="stage-id" readOnly=${readOnly} onInput=${(e) => onChange({ ...stage, id: e.currentTarget.value })} />
        <input class="wizard-input" type="text" value=${stage.title ?? ''} placeholder="Title" readOnly=${readOnly} onInput=${(e) => onChange({ ...stage, title: e.currentTarget.value })} />
        <select class="wizard-input" value=${stage.gate ?? ''} disabled=${readOnly} onChange=${(e) => onChange({ ...stage, gate: e.currentTarget.value })}>
          <option value="">gate…</option>
          ${GATES.map((g) => html`<option value=${g}>${g}</option>`)}
        </select>
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${onRemove}>Remove stage</button>`}
      </div>
      <input class="wizard-input" type="text" value=${stage.purpose ?? ''} placeholder="Purpose" readOnly=${readOnly} onInput=${(e) => onChange({ ...stage, purpose: e.currentTarget.value })} />
      <label class="field-label">Modules (comma-separated ids)</label>
      <input
        class="wizard-input"
        type="text"
        value=${(stage.modules ?? []).join(', ')}
        readOnly=${readOnly}
        onInput=${(e) => onChange({ ...stage, modules: splitIds(e.currentTarget.value) })}
      />
    </div>
  `
}

function ArtefactTemplateEditor({ handle, definitionId, version, artefact, readOnly }) {
  const [source, setSource] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [docxBusy, setDocxBusy] = useState(false)
  const [docxMessage, setDocxMessage] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    readLocalDefinitionTemplate(handle, definitionId, version, templateFileName(artefact.id))
      .then((text) => {
        if (!cancelled) setSource(text ?? '')
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [handle, definitionId, version, artefact.id])

  async function save() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await writeLocalDefinitionTemplate(handle, definitionId, version, templateFileName(artefact.id), source)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function uploadReferenceDocx(e) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    setDocxBusy(true)
    setDocxMessage(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!isValidDocxBuffer(bytes)) {
        setDocxMessage('That file does not look like a .docx (Word) document.')
        return
      }
      await writeLocalDefinitionReferenceDocx(handle, definitionId, version, artefact.id, bytes)
      setDocxMessage('Reference document saved.')
    } catch (err) {
      setDocxMessage(err.message)
    } finally {
      setDocxBusy(false)
    }
  }

  if (loading) return html`<p class="loading">Loading template…</p>`

  return html`
    <div class="local-def-template">
      <textarea
        class="wizard-input local-def-template-source"
        rows="8"
        readOnly=${readOnly}
        value=${source}
        onInput=${(e) => setSource(e.currentTarget.value)}
        placeholder=${`# <%= it.instance.definition %>\n\n<%= it.modules.${'<module-id>'}.${'<field-id>'} %>`}
      ></textarea>
      ${error ? html`<p class="load-error">${error}</p>` : null}
      <div class="detail-actions">
        ${readOnly ? null : html`<button type="button" class="btn small ghost" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save template'}</button>`}
        ${saved ? html`<span class="save-status">Saved.</span>` : null}
        ${readOnly
          ? null
          : html`
              <label class="btn small ghost">
                ${docxBusy ? 'Uploading…' : 'Upload reference .docx'}
                <input type="file" accept=".docx" style="display:none" disabled=${docxBusy} onChange=${uploadReferenceDocx} />
              </label>
            `}
        ${docxMessage ? html`<span class="save-status">${docxMessage}</span>` : null}
      </div>
    </div>
  `
}

function ArtefactEditor({ handle, definitionId, version, artefact, modules, readOnly, onChange, onRemove }) {
  const [expanded, setExpanded] = useState(false)
  const filenameTokens = [...FILENAME_BUILTIN_TOKENS, ...eligibleFilenameFields(modules, artefact)]
  return html`
    <div class="local-def-element">
      <div class="local-def-element-header">
        <input class="wizard-input" type="text" value=${artefact.id} placeholder="artefact-id" readOnly=${readOnly} onInput=${(e) => onChange({ ...artefact, id: e.currentTarget.value, template: `templates/${templateFileName(e.currentTarget.value)}` })} />
        <input class="wizard-input" type="text" value=${artefact.title ?? ''} placeholder="Title" readOnly=${readOnly} onInput=${(e) => onChange({ ...artefact, title: e.currentTarget.value })} />
        <select class="wizard-input" value=${artefact.gate ?? ''} disabled=${readOnly} onChange=${(e) => onChange({ ...artefact, gate: e.currentTarget.value })}>
          <option value="">gate…</option>
          ${GATES.map((g) => html`<option value=${g}>${g}</option>`)}
        </select>
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${onRemove}>Remove artefact</button>`}
      </div>
      <input class="wizard-input" type="text" value=${artefact.purpose ?? ''} placeholder="Purpose" readOnly=${readOnly} onInput=${(e) => onChange({ ...artefact, purpose: e.currentTarget.value })} />
      <label class="field-label">Requires (comma-separated, "module" or "module.field")</label>
      <input
        class="wizard-input"
        type="text"
        value=${(artefact.requires ?? []).join(', ')}
        readOnly=${readOnly}
        onInput=${(e) => onChange({ ...artefact, requires: splitIds(e.currentTarget.value) })}
      />
      <label class="field-label">Filename pattern</label>
      <input
        class="wizard-input mono defn-filename-input"
        type="text"
        placeholder="e.g. {candidate.name} - Offer Pack"
        value=${artefact.filename ?? ''}
        readOnly=${readOnly}
        onInput=${(e) => onChange({ ...artefact, filename: e.currentTarget.value })}
      />
      ${readOnly ? null : html`
        <div class="local-def-filename-tokens">
          ${filenameTokens.map((t) => html`<button key=${t.token} type="button" class="btn small ghost defn-filename-token" title=${t.label} onClick=${() => onChange({ ...artefact, filename: `${artefact.filename ?? ''}{${t.token}}` })}>{${t.token}}</button>`)}
        </div>
      `}
      <button type="button" class="btn small ghost" onClick=${() => setExpanded(!expanded)}>${expanded ? 'Hide template' : 'Edit template'}</button>
      ${expanded ? html`<${ArtefactTemplateEditor} handle=${handle} definitionId=${definitionId} version=${version} artefact=${artefact} readOnly=${readOnly} />` : null}
    </div>
  `
}

function EditDefinition({ handle, workspaceId, definitionId, version, initial }) {
  const [structure, setStructure] = useState(initial)
  const [problems, setProblems] = useState([])
  const [validating, setValidating] = useState(false)
  const [validateError, setValidateError] = useState(null)
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [saveError, setSaveError] = useState(null)
  const [publishBusy, setPublishBusy] = useState(false)
  const [publishError, setPublishError] = useState(null)

  const readOnly = structure.status === 'published'

  useEffect(() => {
    let cancelled = false
    setValidating(true)
    validateStructure(structure)
      .then((result) => {
        if (!cancelled) {
          setProblems(result.problems ?? [])
          setValidateError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setValidateError(err.message)
      })
      .finally(() => {
        if (!cancelled) setValidating(false)
      })
    return () => {
      cancelled = true
    }
  }, [structure])

  function update(patch) {
    setStructure((prev) => ({ ...prev, ...patch }))
    setSaveStatus('idle')
  }

  async function save() {
    setSaveStatus('saving')
    setSaveError(null)
    try {
      await writeLocalDefinitionStructure(handle, definitionId, version, structure)
      setSaveStatus('saved')
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err.message)
    }
  }

  async function publish() {
    setPublishBusy(true)
    setPublishError(null)
    try {
      const result = await validateStructure(structure)
      if ((result.problems ?? []).length > 0) {
        setProblems(result.problems)
        setPublishError('This definition still has unresolved problems — fix them before publishing.')
        return
      }
      const published = { ...structure, status: 'published' }
      await writeLocalDefinitionStructure(handle, definitionId, version, published)
      setStructure(published)
    } catch (err) {
      setPublishError(err.message)
    } finally {
      setPublishBusy(false)
    }
  }

  function addStage() {
    update({ stages: [...structure.stages, { id: '', title: '', purpose: '', gate: GATES[0], modules: [] }] })
  }
  function addModule() {
    update({ modules: [...structure.modules, { id: '', title: '', purpose: '', fields: [] }] })
  }
  function addArtefact() {
    const id = ''
    update({ artefacts: [...structure.artefacts, { id, title: '', purpose: '', template: `templates/${templateFileName(id)}`, gate: GATES[0], requires: [] }] })
  }

  return html`
    <div class="local-definition-editor">
      <div class="dashboard-topbar">
        <div class="dashboard-heading">
          <h1>${structure.title || structure.id}</h1>
          <span class=${'dot ' + (structure.status === 'published' ? 'agreed' : 'draft')}></span>
          <span class="save-status">${structure.status}</span>
        </div>
        <div class="dashboard-controls">
          <a class="btn small ghost" href=${`/?`}>← Back</a>
        </div>
      </div>

      <p class="workspace-subtitle">
        ${structure.id} · v${structure.version} · saved to this workspace's own <code>definitions/${structure.id}/${structure.version}/</code> folder
      </p>

      <label class="field-label" for="local-def-title-input">Title</label>
      <input id="local-def-title-input" class="wizard-input" type="text" value=${structure.title} readOnly=${readOnly} onInput=${(e) => update({ title: e.currentTarget.value })} />
      <label class="field-label" for="local-def-description-input">Description</label>
      <textarea id="local-def-description-input" class="wizard-input" rows="2" readOnly=${readOnly} value=${structure.description} onInput=${(e) => update({ description: e.currentTarget.value })}></textarea>

      <section>
        <h2>Stages</h2>
        ${structure.stages.map(
          (stage, i) => html`
            <${StageEditor}
              key=${i}
              stage=${stage}
              readOnly=${readOnly}
              onChange=${(next) => {
                const stages = structure.stages.slice()
                stages[i] = next
                update({ stages })
              }}
              onRemove=${() => {
                const stages = structure.stages.slice()
                stages.splice(i, 1)
                update({ stages })
              }}
            />
          `
        )}
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${addStage}>+ Add stage</button>`}
      </section>

      <section>
        <h2>Modules</h2>
        ${structure.modules.map(
          (mod, i) => html`
            <${ModuleEditor}
              key=${i}
              mod=${mod}
              readOnly=${readOnly}
              onChange=${(next) => {
                const modules = structure.modules.slice()
                modules[i] = next
                update({ modules })
              }}
              onRemove=${() => {
                const modules = structure.modules.slice()
                modules.splice(i, 1)
                update({ modules })
              }}
            />
          `
        )}
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${addModule}>+ Add module</button>`}
      </section>

      <section>
        <h2>Artefacts</h2>
        ${structure.artefacts.map(
          (artefact, i) => html`
            <${ArtefactEditor}
              key=${i}
              handle=${handle}
              definitionId=${definitionId}
              version=${version}
              artefact=${artefact}
              modules=${structure.modules}
              readOnly=${readOnly}
              onChange=${(next) => {
                const artefacts = structure.artefacts.slice()
                artefacts[i] = next
                update({ artefacts })
              }}
              onRemove=${() => {
                const artefacts = structure.artefacts.slice()
                artefacts.splice(i, 1)
                update({ artefacts })
              }}
            />
          `
        )}
        ${readOnly ? null : html`<button type="button" class="btn small ghost" onClick=${addArtefact}>+ Add artefact</button>`}
      </section>

      <section class="local-def-validation">
        <h2>Validation</h2>
        ${validating ? html`<p class="loading">Checking…</p>` : null}
        ${validateError ? html`<p class="load-error">${validateError}</p>` : null}
        ${!validating && problems.length === 0 ? html`<p class="save-status">No problems found.</p>` : null}
        ${problems.length > 0
          ? html`<ul class="local-def-problems">
              ${problems.map((p) => html`<li key=${p.message}>${p.message}</li>`)}
            </ul>`
          : null}
      </section>

      <div class="detail-actions">
        ${readOnly
          ? null
          : html`<button type="button" class="btn primary" disabled=${saveStatus === 'saving'} onClick=${save}>${saveStatus === 'saving' ? 'Saving…' : 'Save'}</button>`}
        ${saveStatus === 'saved' ? html`<span class="save-status">Saved.</span>` : null}
        ${saveStatus === 'error' ? html`<p class="load-error">${saveError}</p>` : null}
        ${readOnly
          ? html`<span class="save-status">Published — read-only.</span>`
          : html`<button type="button" class="btn ghost" disabled=${publishBusy || problems.length > 0} onClick=${publish}>${publishBusy ? 'Publishing…' : 'Publish'}</button>`}
        ${publishError ? html`<p class="load-error">${publishError}</p>` : null}
      </div>
    </div>
  `
}

export function LocalDefinitionEditorPage() {
  const { route } = useLocation()
  const params = new URLSearchParams(window.location.search)
  const workspaceId = params.get('ws')
  const definitionId = params.get('id')
  const version = Number(params.get('version') ?? '1')

  const [handle, setHandle] = useState(null)
  const [permissionState, setPermissionState] = useState('loading') // loading | granted | prompt | denied | missing
  const [reconnectBusy, setReconnectBusy] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [structure, setStructure] = useState(null)

  // Mirrors the dashboard's own local-workspace row (LocalGroupResolver in
  // web/app.js): 'prompt' (a handle restored from IndexedDB across a reload,
  // permission not yet re-confirmed) and 'denied' (the user said no, or this
  // browser's storage lost the grant) are distinct states with the same
  // fix — a user-gesture-backed re-request via ensurePermission, wired to
  // the "Reconnect" button below — not one dead-end message.
  async function resolvePermission() {
    if (!workspaceId) {
      setLoadError('No workspace specified — open this page from a local workspace on the dashboard.')
      setPermissionState('missing')
      return
    }
    setPermissionState('loading')
    let h
    try {
      h = await getWorkspaceHandle(workspaceId)
    } catch (err) {
      setLoadError(err.message)
      setPermissionState('missing')
      return
    }
    if (!h) {
      setPermissionState('missing')
      return
    }
    const granted = await ensurePermission(h)
    if (granted === 'granted') {
      setHandle(h)
      setPermissionState('granted')
      return
    }
    setPermissionState(granted === 'prompt' ? 'prompt' : 'denied')
  }

  useEffect(() => {
    resolvePermission()
    // eslint-disable-next-line
  }, [workspaceId])

  async function reconnect() {
    setReconnectBusy(true)
    try {
      await resolvePermission()
    } finally {
      setReconnectBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    if (!handle || !definitionId) return
    readLocalDefinitionStructure(handle, definitionId, version)
      .then((s) => {
        if (!cancelled) setStructure(s)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [handle, definitionId, version])

  if (permissionState === 'loading') return html`<main class="dashboard"><p class="loading">Opening workspace…</p></main>`
  if (permissionState === 'prompt') {
    return html`<main class="dashboard">
      <div class="local-workspace-recovery">
        <p>This local workspace needs permission again in this browser.</p>
        <div class="detail-actions">
          <button type="button" class="btn primary" disabled=${reconnectBusy} onClick=${reconnect}>${reconnectBusy ? 'Reconnecting…' : 'Reconnect'}</button>
        </div>
      </div>
    </main>`
  }
  if (permissionState === 'denied' || permissionState === 'missing') {
    return html`<main class="dashboard">
      <div class="local-workspace-recovery">
        <p>${loadError ?? "Can't use this local workspace in this browser — reconnect, or open it from the dashboard first."}</p>
        ${workspaceId
          ? html`<div class="detail-actions">
              <button type="button" class="btn primary" disabled=${reconnectBusy} onClick=${reconnect}>${reconnectBusy ? 'Reconnecting…' : 'Reconnect'}</button>
            </div>`
          : null}
      </div>
    </main>`
  }

  if (!definitionId) {
    return html`<main class="dashboard">
      <${CreateDefinitionForm}
        workspaceId=${workspaceId}
        handle=${handle}
        onCreated=${(id, v) => route(`/definitions/local?ws=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(id)}&version=${v}`)}
      />
    </main>`
  }

  if (loadError) return html`<main class="dashboard"><p class="load-error">${loadError}</p></main>`
  if (!structure) return html`<main class="dashboard"><p class="loading">Loading definition…</p></main>`

  return html`<main class="dashboard"><${EditDefinition} handle=${handle} workspaceId=${workspaceId} definitionId=${definitionId} version=${version} initial=${structure} /></main>`
}
