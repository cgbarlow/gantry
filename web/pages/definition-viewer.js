import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { renderMarkdown } from '../lib/markdown.js'

function isValidSlugClient(slug) {
  return typeof slug === 'string' && slug !== '' && slug !== '.' && slug !== '..' && /^[^\\/]+$/.test(slug)
}

export function DefinitionViewerPage() {
  const [definitions, setDefinitions] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedVersion, setSelectedVersion] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saveProblems, setSaveProblems] = useState([])
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)
  // per-stage new module ref input
  const [newModuleRefs, setNewModuleRefs] = useState({})
  const [newRequires, setNewRequires] = useState({})

  useEffect(() => {
    fetch('/api/definitions')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load definitions (${res.status})`)
        return res.json()
      })
      .then((data) => {
        setDefinitions(data)
        setLoadError(null)
        if (data.length && !selectedId) {
          const first = data.find((d) => d.id === 'design') ?? data[0]
          const defaultVersion = first.latestPublished ?? Math.max(...first.versions.map((v) => v.version))
          setSelectedId(first.id)
          setSelectedVersion(defaultVersion)
        }
      })
      .catch((err) => setLoadError(err.message))
  }, [])

  useEffect(() => {
    if (!selectedId || selectedVersion == null) return
    setDetailLoading(true)
    setDetailError(null)
    fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `Failed to load definition (${res.status})`)
        }
        return res.json()
      })
      .then((data) => {
        setDetail(data)
        setDetailError(null)
      })
      .catch((err) => {
        setDetail(null)
        setDetailError(err.message)
      })
      .finally(() => setDetailLoading(false))
  }, [selectedId, selectedVersion])

  // reset edit mode when version switches
  useEffect(() => {
    setEditing(false)
    setDraft(null)
    setSaveProblems([])
    setSaveError(null)
    setNewModuleRefs({})
    setNewRequires({})
  }, [selectedId, selectedVersion])

  function handleSelectDefinition(def) {
    setSelectedId(def.id)
    const v = def.latestPublished ?? Math.max(...def.versions.map((x) => x.version))
    setSelectedVersion(v)
  }

  function handleStartEdit() {
    setDraft(JSON.parse(JSON.stringify(detail)))
    setSaveProblems([])
    setSaveError(null)
    setEditing(true)
  }
  function handleCancel() {
    setEditing(false)
    setDraft(null)
    setSaveProblems([])
    setSaveError(null)
  }
  async function handleSave() {
    if (!draft || !selectedId || selectedVersion == null) return
    setSaving(true)
    setSaveProblems([])
    setSaveError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 422 && body.problems) {
        setSaveProblems(body.problems)
        setSaving(false)
        return
      }
      if (!res.ok) {
        setSaveError(body.error ?? `Save failed (${res.status})`)
        if (body.problems) setSaveProblems(body.problems)
        setSaving(false)
        return
      }
      const { ok, ...proj } = body
      setDetail(proj)
      setEditing(false)
      setDraft(null)
      setSaveProblems([])
      setSaveError(null)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const selectedDef = definitions?.find((d) => d.id === selectedId) ?? null
  const isDraft = detail?.status === 'draft'

  function updateDraft(updater) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev))
      updater(next)
      return next
    })
  }

  return html`
    <header class="wizard-header">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>gantry</h1>
      </div>
      <a class="btn small ghost" href="/">← Workspaces</a>
    </header>
    <main class="defn-viewer">
      <div class="defn-viewer-layout">
        <aside class="defn-viewer-rail">
          <h2>Definitions</h2>
          ${loadError ? html`<p class="load-error">${loadError}</p>` : null}
          ${!definitions ? html`<p class="loading">Loading…</p>` : null}
          ${definitions?.length === 0 ? html`<p class="load-error">No definitions found.</p>` : null}
          ${definitions?.map(
            (def) => html`
              <div
                key=${def.id}
                class=${'defn-rail-row' + (def.id === selectedId ? ' selected' : '')}
                onClick=${() => handleSelectDefinition(def)}
                role="button"
                tabindex="0"
                onKeyDown=${(e) => { if (e.key === 'Enter') handleSelectDefinition(def) }}
              >
                <div class="defn-rail-title">${def.title} (${def.id})</div>
                ${def.description ? html`<div class="defn-rail-desc">${def.description}</div>` : null}
                <div class="defn-rail-badges">
                  ${def.versions.map(
                    (v) => html`
                      <span class=${'stamp small' + (v.status === 'published' ? ' agreed' : ' draft')} key=${v.version}>
                        v${v.version} · ${v.status}${def.latestPublished === v.version ? html` <span class="defn-latest-tag">latest</span>` : null}
                      </span>
                    `
                  )}
                </div>
              </div>
            `
          )}
        </aside>
        <section class="defn-viewer-detail">
          ${!selectedId ? html`<p class="loading">Select a definition.</p>` : null}
          ${selectedDef
            ? html`
                <div class="defn-version-switcher">
                  <label for="defn-version-select">Version</label>
                  <select
                    id="defn-version-select"
                    class="wizard-input"
                    value=${String(selectedVersion)}
                    onChange=${(e) => setSelectedVersion(Number(e.currentTarget.value))}
                  >
                    ${selectedDef.versions.map((v) => html`<option value=${String(v.version)}>v${v.version} — ${v.status}</option>`)}
                  </select>
                </div>
              `
            : null}
          ${detailLoading ? html`<p class="loading">Loading…</p>` : null}
          ${detailError ? html`<p class="load-error">${detailError}</p>` : null}
          ${detail && !detailLoading && !editing
            ? html`
                <div class="defn-viewer-content">
                  <header class="defn-viewer-header">
                    <h2>${detail.title} · <span class="defn-id">${detail.id}</span> · <span class="stamp small ${detail.status === 'published' ? 'agreed' : 'draft'}">v${detail.version} ${detail.status}</span></h2>
                    ${isDraft
                      ? html`<button class="btn small" onClick=${handleStartEdit}>Edit</button>`
                      : html`<p class="guidance">Read-only — editing arrives in a later release.</p>`}
                    ${detail.description ? html`<p class="lede">${detail.description}</p>` : null}
                  </header>

                  <section class="defn-section">
                    <h3>Stages</h3>
                    ${detail.stages.map(
                      (s) => html`
                        <div class="defn-card" key=${s.id}>
                          <h4>${s.title} <span class="defn-meta">${s.id} · gate: ${s.gate}</span></h4>
                          ${s.purpose ? html`<p class="guidance">${s.purpose}</p>` : null}
                          <div class="defn-modules-list">
                            <span class="field-label">Modules</span>
                            <ul>
                              ${s.modules.map((mid) => html`<li key=${mid}><code>${mid}</code></li>`)}
                            </ul>
                          </div>
                        </div>
                      `
                    )}
                  </section>

                  <section class="defn-section">
                    <h3>Artefacts</h3>
                    ${detail.artefacts.map(
                      (a) => html`
                        <div class="defn-card" key=${a.id}>
                          <h4>${a.title} <span class="defn-meta">${a.id} · gate: ${a.gate}</span></h4>
                          ${a.purpose ? html`<p class="guidance">${a.purpose}</p>` : null}
                          <p><span class="field-label">Template</span> <code>${a.template}</code></p>
                          <div class="defn-requires-list">
                            <span class="field-label">Requires</span>
                            <ul>
                              ${a.requires.map((r) => html`<li key=${r}><code>${r}</code></li>`)}
                            </ul>
                          </div>
                        </div>
                      `
                    )}
                  </section>

                  <section class="defn-section">
                    <h3>Modules</h3>
                    ${detail.modules.map(
                      (m) => html`
                        <div class="defn-card" key=${m.id}>
                          <h4>${m.title} <span class="defn-meta">${m.id}</span></h4>
                          ${m.purpose ? html`<p class="guidance">${m.purpose}</p>` : null}
                          <ul class="defn-fields-list">
                            ${m.fields.map(
                              (f) => html`
                                <li class="defn-field" key=${f.id}>
                                  <div class="defn-field-heading">
                                    <strong>${f.title}</strong> <code>${f.id}</code> <span class="stamp small">${f.type}</span>
                                    <span class="defn-required">
                                      ${f.required === true ? 'required' : f.requiredAt ? `required-at: ${f.requiredAt}` : 'optional'}
                                    </span>
                                  </div>
                                  ${f.guidance ? html`<div class="guidance" dangerouslySetInnerHTML=${{ __html: renderMarkdown(f.guidance) }} />` : null}
                                </li>
                              `
                            )}
                          </ul>
                        </div>
                      `
                    )}
                  </section>
                </div>
              `
            : null}
          ${detail && !detailLoading && editing && draft
            ? html`
                <div class="defn-viewer-content defn-editor">
                  <header class="defn-viewer-header">
                    <h2>${draft.title} · <span class="defn-id">${draft.id}</span> · <span class="stamp small draft">v${draft.version} ${draft.status}</span></h2>
                    <p class="guidance">Editing draft — changes are local until Saved.</p>
                    ${draft.description ? html`<p class="lede">${draft.description}</p>` : null}
                  </header>

                  ${saveProblems.length
                    ? html`
                        <div class="load-error">
                          <p><strong>Validation failed:</strong></p>
                          <ul>
                            ${saveProblems.map((p) => html`<li>${p.message}</li>`)}
                          </ul>
                        </div>
                      `
                    : null}
                  ${saveError ? html`<p class="load-error">${saveError}</p>` : null}

                  <div class="defn-editor-actions">
                    <button class="btn primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving…' : 'Save'}</button>
                    <button class="btn small ghost" onClick=${handleCancel} disabled=${saving}>Cancel</button>
                  </div>

                  <section class="defn-section defn-editor-stages">
                    <h3>Stages</h3>
                    ${draft.stages.map(
                      (s, si) => html`
                        <div class="defn-card" key=${si}>
                          <div class="defn-editor-row">
                            <label class="field-label">Stage id</label>
                            <code>${s.id}</code>
                          </div>
                          <label class="field-label">Title</label>
                          <input class="wizard-input" value=${s.title} onInput=${(e) => updateDraft((d) => { d.stages[si].title = e.currentTarget.value })} />
                          <label class="field-label">Purpose</label>
                          <input class="wizard-input" value=${s.purpose ?? ''} onInput=${(e) => updateDraft((d) => { d.stages[si].purpose = e.currentTarget.value })} />
                          <label class="field-label">Gate</label>
                          <input class="wizard-input" value=${s.gate ?? ''} onInput=${(e) => updateDraft((d) => { d.stages[si].gate = e.currentTarget.value })} />
                          <div class="defn-modules-list">
                            <span class="field-label">Modules</span>
                            <ul>
                              ${s.modules.map(
                                (mid, mi) => html`
                                  <li key=${mi}><code>${mid}</code> <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.stages[si].modules.splice(mi, 1) })}>✕</button></li>
                                `
                              )}
                            </ul>
                            <div class="defn-editor-inline">
                              <select class="wizard-input" value=${newModuleRefs[si] ?? ''} onChange=${(e) => setNewModuleRefs((prev) => ({ ...prev, [si]: e.currentTarget.value }))}>
                                <option value="">— choose module —</option>
                                ${draft.modules.map((m) => html`<option value=${m.id}>${m.id}</option>`)}
                              </select>
                              <input class="wizard-input" placeholder="or type module id" value=${newModuleRefs[si] ?? ''} onInput=${(e) => setNewModuleRefs((prev) => ({ ...prev, [si]: e.currentTarget.value }))} />
                              <button class="btn small" onClick=${() => {
                                const val = (newModuleRefs[si] ?? '').trim()
                                if (!val) return
                                updateDraft((d) => { d.stages[si].modules.push(val) })
                                setNewModuleRefs((prev) => ({ ...prev, [si]: '' }))
                              }}>Add module ref</button>
                            </div>
                          </div>
                          <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.stages.splice(si, 1) })}>Remove stage ✕</button>
                        </div>
                      `
                    )}
                    <button class="btn small" onClick=${() => updateDraft((d) => { d.stages.push({ id: `new-stage-${d.stages.length + 1}`, title: 'New Stage', purpose: '', gate: '', modules: [] }) })}>Add stage</button>
                  </section>

                  <section class="defn-section defn-editor-artefacts">
                    <h3>Artefacts</h3>
                    ${draft.artefacts.map(
                      (a, ai) => html`
                        <div class="defn-card" key=${ai}>
                          <div class="defn-editor-row">
                            <label class="field-label">Artefact id</label>
                            <code>${a.id}</code>
                          </div>
                          <label class="field-label">Title</label>
                          <input class="wizard-input" value=${a.title} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].title = e.currentTarget.value })} />
                          <label class="field-label">Purpose</label>
                          <input class="wizard-input" value=${a.purpose ?? ''} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].purpose = e.currentTarget.value })} />
                          <label class="field-label">Gate</label>
                          <input class="wizard-input" value=${a.gate ?? ''} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].gate = e.currentTarget.value })} />
                          <label class="field-label">Template</label>
                          <input class="wizard-input" value=${a.template ?? ''} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].template = e.currentTarget.value })} />
                          <div class="defn-requires-list">
                            <span class="field-label">Requires</span>
                            <ul>
                              ${a.requires.map(
                                (r, ri) => html`
                                  <li key=${ri}><code>${r}</code> <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.artefacts[ai].requires.splice(ri, 1) })}>✕</button></li>
                                `
                              )}
                            </ul>
                            <div class="defn-editor-inline">
                              <input class="wizard-input" placeholder="module or module.field" value=${newRequires[ai] ?? ''} onInput=${(e) => setNewRequires((prev) => ({ ...prev, [ai]: e.currentTarget.value }))} />
                              <button class="btn small" onClick=${() => {
                                const val = (newRequires[ai] ?? '').trim()
                                if (!val) return
                                updateDraft((d) => { d.artefacts[ai].requires.push(val) })
                                setNewRequires((prev) => ({ ...prev, [ai]: '' }))
                              }}>Add requirement</button>
                            </div>
                          </div>
                          <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.artefacts.splice(ai, 1) })}>Remove artefact ✕</button>
                        </div>
                      `
                    )}
                    <button class="btn small" onClick=${() => updateDraft((d) => { d.artefacts.push({ id: `new-artefact-${d.artefacts.length + 1}`, title: 'New Artefact', purpose: '', template: '', gate: '', requires: [] }) })}>Add artefact</button>
                  </section>

                  <section class="defn-section defn-editor-modules">
                    <h3>Modules</h3>
                    ${draft.modules.map(
                      (m, mi) => html`
                        <div class="defn-card" key=${mi}>
                          <label class="field-label">Module id</label>
                          <input class="wizard-input" value=${m.id} onInput=${(e) => updateDraft((d) => { d.modules[mi].id = e.currentTarget.value })} />
                          ${!isValidSlugClient(m.id) ? html`<p class="inline-error">Invalid slug — single segment, no slashes or ".."</p>` : null}
                          <label class="field-label">Title</label>
                          <input class="wizard-input" value=${m.title ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].title = e.currentTarget.value })} />
                          <label class="field-label">Purpose</label>
                          <input class="wizard-input" value=${m.purpose ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].purpose = e.currentTarget.value })} />
                          <div class="defn-fields-list">
                            <span class="field-label">Fields</span>
                            ${m.fields.map(
                              (f, fi) => html`
                                <div class="defn-card defn-editor-field" key=${fi}>
                                  <label class="field-label">Field title</label>
                                  <input class="wizard-input" value=${f.title ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].fields[fi].title = e.currentTarget.value })} />
                                  <label class="field-label">Field id</label>
                                  <input class="wizard-input" value=${f.id ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].fields[fi].id = e.currentTarget.value })} />
                                  ${!isValidSlugClient(f.id) ? html`<p class="inline-error">Invalid slug</p>` : null}
                                  <label class="field-label">Type</label>
                                  <select class="wizard-input" value=${f.type} onChange=${(e) => updateDraft((d) => { d.modules[mi].fields[fi].type = e.currentTarget.value })}>
                                    <option value="markdown">markdown</option>
                                    <option value="list">list</option>
                                  </select>
                                  <label class="field-label">Required</label>
                                  <select class="wizard-input" value=${f.required === true ? 'required' : f.requiredAt ? 'required-at' : 'optional'} onChange=${(e) => {
                                    const v = e.currentTarget.value
                                    updateDraft((d) => {
                                      const field = d.modules[mi].fields[fi]
                                      if (v === 'optional') { delete field.required; delete field.requiredAt }
                                      else if (v === 'required') { field.required = true; delete field.requiredAt }
                                      else if (v === 'required-at') { delete field.required; field.requiredAt = field.requiredAt ?? (d.stages[0]?.id ?? '') }
                                    })
                                  }}>
                                    <option value="optional">optional</option>
                                    <option value="required">required</option>
                                    <option value="required-at">required-at</option>
                                  </select>
                                  ${f.requiredAt !== undefined
                                    ? html`
                                        <label class="field-label">Required-at stage</label>
                                        <select class="wizard-input" value=${f.requiredAt} onChange=${(e) => updateDraft((d) => { d.modules[mi].fields[fi].requiredAt = e.currentTarget.value })}>
                                          ${draft.stages.map((st) => html`<option value=${st.id}>${st.id}</option>`)}
                                        </select>
                                      `
                                    : null}
                                  <label class="field-label">Guidance</label>
                                  <textarea class="wizard-input" rows="3" value=${f.guidance ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].fields[fi].guidance = e.currentTarget.value })}></textarea>
                                  <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.modules[mi].fields.splice(fi, 1) })}>Remove field ✕</button>
                                </div>
                              `
                            )}
                            <button class="btn small" onClick=${() => updateDraft((d) => { d.modules[mi].fields.push({ id: `new-field-${d.modules[mi].fields.length + 1}`, title: 'New Field', type: 'markdown', guidance: '' }) })}>Add field</button>
                          </div>
                          <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.modules.splice(mi, 1) })}>Remove module ✕</button>
                        </div>
                      `
                    )}
                    <button class="btn small" onClick=${() => updateDraft((d) => { d.modules.push({ id: `new-module-${d.modules.length + 1}`, title: 'New Module', purpose: '', fields: [] }) })}>Add module</button>
                  </section>

                  <div class="defn-editor-actions">
                    <button class="btn primary" onClick=${handleSave} disabled=${saving}>${saving ? 'Saving…' : 'Save'}</button>
                    <button class="btn small ghost" onClick=${handleCancel} disabled=${saving}>Cancel</button>
                  </div>
                </div>
              `
            : null}
        </section>
      </div>
    </main>
  `
}
