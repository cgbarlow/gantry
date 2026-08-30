import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { renderMarkdown } from '../lib/markdown.js'
import { reorder } from '../lib/reorder.js'

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
  const [showArchived, setShowArchived] = useState(false)
  const [cloneId, setCloneId] = useState('')
  const [cloneError, setCloneError] = useState(null)
  const [cloning, setCloning] = useState(false)
  const [showCloneInput, setShowCloneInput] = useState(false)
  const [newDraftError, setNewDraftError] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const [publishProblems, setPublishProblems] = useState([])
  const [publishError, setPublishError] = useState(null)
  const [dragSource, setDragSource] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [templateEditors, setTemplateEditors] = useState({})
  const [viewTemplates, setViewTemplates] = useState({})

  function fetchDefinitions(showArchivedFlag) {
    const qs = showArchivedFlag ? '?archived=1' : ''
    return fetch(`/api/definitions${qs}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load definitions (${res.status})`)
        return res.json()
      })
  }

  useEffect(() => {
    fetchDefinitions(showArchived)
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
    fetchDefinitions(showArchived)
      .then((data) => {
        setDefinitions(data)
        setLoadError(null)
        // if selectedId not in new list and not archived, keep it? But archived rows hidden, keep selection.
        if (selectedId && !data.some((d) => d.id === selectedId)) {
          // if archived and showArchived false, keep detail but don't auto-switch
        }
      })
      .catch((err) => setLoadError(err.message))
  }, [showArchived])

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
        setPublishProblems([])
        setPublishError(null)
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
    setPublishProblems([])
    setPublishError(null)
    setTemplateEditors({})
    setViewTemplates({})
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

  async function handleNewDraft() {
    if (!selectedId) return
    setNewDraftError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNewDraftError(body.error ?? `Failed (${res.status})`)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      setSelectedVersion(body.version)
    } catch (err) {
      setNewDraftError(err.message)
    }
  }

  async function handleClone() {
    if (!selectedId) return
    if (!cloneId || !isValidSlugClient(cloneId)) {
      setCloneError('Invalid slug — single segment, no slashes or ".."')
      return
    }
    setCloning(true)
    setCloneError(null)
    try {
      const res = await fetch('/api/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: selectedId, newId: cloneId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setCloneError(body.error ?? `Failed (${res.status})`)
        setCloning(false)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      setSelectedId(body.id)
      setSelectedVersion(1)
      setShowCloneInput(false)
      setCloneId('')
      setCloneError(null)
    } catch (err) {
      setCloneError(err.message)
    } finally {
      setCloning(false)
    }
  }

  async function handleArchive(id) {
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(id)}/archive`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Archive failed (${res.status})`)
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      if (selectedId === id && !showArchived) {
        // if archived currently selected and not showing archived, keep detail but rail will hide
      }
    } catch (err) {
      setLoadError(err.message)
    }
  }

  async function handleRestore(id) {
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(id)}/restore`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Restore failed (${res.status})`)
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
    } catch (err) {
      setLoadError(err.message)
    }
  }

  async function handlePublish() {
    if (!detail || !selectedId || selectedVersion == null) return
    if (detail.status !== 'draft') return
    const confirmed = typeof window !== 'undefined' && window.confirm
      ? window.confirm(`Publish v${detail.version}? This makes it immutable.`)
      : true
    if (!confirmed) return
    setPublishing(true)
    setPublishProblems([])
    setPublishError(null)
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/publish`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.status === 422 && body.problems) {
        setPublishProblems(body.problems)
        setPublishing(false)
        return
      }
      if (!res.ok) {
        setPublishError(body.error ?? `Publish failed (${res.status})`)
        if (body.problems) setPublishProblems(body.problems)
        setPublishing(false)
        return
      }
      const defs = await fetchDefinitions(showArchived)
      setDefinitions(defs)
      const { ok, ...proj } = body
      setDetail(proj)
      setPublishProblems([])
      setPublishError(null)
    } catch (err) {
      setPublishError(err.message)
    } finally {
      setPublishing(false)
    }
  }

  function templateBasename(tmpl) {
    if (!tmpl) return ''
    const parts = String(tmpl).split('/')
    return parts[parts.length - 1] || ''
  }

  async function handleOpenTemplate(tmpl) {
    const name = templateBasename(tmpl)
    if (!name) return
    setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: true, loading: true, error: null, saved: null } }))
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/templates/${encodeURIComponent(name)}`)
      if (res.status === 404) {
        setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: true, loading: false, source: '', error: null } }))
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: true, loading: false, error: body.error ?? `Failed (${res.status})`, source: prev[name]?.source ?? '' } }))
        return
      }
      setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: true, loading: false, source: body.source ?? '', error: null } }))
    } catch (err) {
      setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: true, loading: false, error: err.message } }))
    }
  }
  function handleCloseTemplate(tmpl) {
    const name = templateBasename(tmpl)
    if (!name) return
    setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: false, error: null, saved: null } }))
  }
  async function handleSaveTemplate(tmpl) {
    const name = templateBasename(tmpl)
    if (!name) return
    const ed = templateEditors[name]
    const source = ed?.source ?? ''
    setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), saving: true, error: null, saved: null } }))
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/templates/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 422) {
        setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), saving: false, error: body.error ?? 'Template does not compile' } }))
        return
      }
      if (!res.ok) {
        setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), saving: false, error: body.error ?? `Save failed (${res.status})` } }))
        return
      }
      setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), saving: false, saved: 'Saved ✓', error: null } }))
      setTimeout(() => setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), saved: null } })), 2000)
    } catch (err) {
      setTemplateEditors((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), saving: false, error: err.message } }))
    }
  }
  async function handleToggleViewTemplate(tmpl) {
    const name = templateBasename(tmpl)
    if (!name) return
    const cur = viewTemplates[name]
    if (cur?.open) {
      setViewTemplates((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: false } }))
      return
    }
    setViewTemplates((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), open: true, loading: true, error: null } }))
    try {
      const res = await fetch(`/api/definitions/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(String(selectedVersion))}/templates/${encodeURIComponent(name)}`)
      if (res.status === 404) {
        setViewTemplates((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), loading: false, source: '', error: 'Not found' } }))
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setViewTemplates((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), loading: false, error: body.error ?? `Failed (${res.status})` } }))
        return
      }
      setViewTemplates((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), loading: false, source: body.source ?? '', error: null } }))
    } catch (err) {
      setViewTemplates((prev) => ({ ...prev, [name]: { ...(prev[name] ?? {}), loading: false, error: err.message } }))
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

  function handleDragStart(e, listPath, index) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', JSON.stringify({ listPath, index })) } catch {}
    setDragSource({ listPath, index })
  }
  function handleDragOver(e, listPath, index) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragSource && dragSource.listPath !== listPath) return
    setDragOver({ listPath, index })
  }
  function handleDrop(e, listPath, targetIndex) {
    e.preventDefault()
    let src = dragSource
    try {
      const raw = e.dataTransfer.getData('text/plain')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.listPath === 'string' && typeof parsed.index === 'number') src = parsed
      }
    } catch {}
    if (!src || src.listPath !== listPath) {
      setDragSource(null)
      setDragOver(null)
      return
    }
    const from = src.index
    const to = targetIndex
    if (from === to) {
      setDragSource(null)
      setDragOver(null)
      return
    }
    updateDraft((d) => {
      if (listPath === 'stages') d.stages = reorder(d.stages, from, to)
      else if (listPath === 'artefacts') d.artefacts = reorder(d.artefacts, from, to)
      else if (listPath === 'modules') d.modules = reorder(d.modules, from, to)
      else if (listPath.startsWith('stage:')) {
        const si = Number(listPath.split(':')[1])
        d.stages[si].modules = reorder(d.stages[si].modules, from, to)
      } else if (listPath.startsWith('artefact:')) {
        const ai = Number(listPath.split(':')[1])
        d.artefacts[ai].requires = reorder(d.artefacts[ai].requires, from, to)
      } else if (listPath.startsWith('module:')) {
        const mi = Number(listPath.split(':')[1])
        d.modules[mi].fields = reorder(d.modules[mi].fields, from, to)
      }
    })
    setDragSource(null)
    setDragOver(null)
  }
  function handleDragEnd() {
    setDragSource(null)
    setDragOver(null)
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
          <div class="defn-rail-controls">
            <label class="defn-show-archived">
              <input type="checkbox" checked=${showArchived} onChange=${(e) => setShowArchived(e.currentTarget.checked)} />
              Show archived
            </label>
            ${selectedId ? html`
              <div class="defn-clone-control">
                ${!showCloneInput ? html`<button class="btn small" onClick=${() => setShowCloneInput(true)}>Clone</button>` : html`
                  <div class="defn-clone-input">
                    <input class="wizard-input" placeholder="new id" value=${cloneId} onInput=${(e) => { setCloneId(e.currentTarget.value); setCloneError(null) }} />
                    ${cloneId && !isValidSlugClient(cloneId) ? html`<p class="inline-error">Invalid slug — single segment, no slashes or ".."</p>` : null}
                    ${cloneError ? html`<p class="inline-error">${cloneError}</p>` : null}
                    <div class="defn-clone-actions">
                      <button class="btn small primary" onClick=${handleClone} disabled=${cloning || !isValidSlugClient(cloneId)}>${cloning ? 'Cloning…' : 'Clone'}</button>
                      <button class="btn small ghost" onClick=${() => { setShowCloneInput(false); setCloneId(''); setCloneError(null) }}>Cancel</button>
                    </div>
                  </div>
                `}
              </div>
            ` : null}
          </div>
          ${loadError ? html`<p class="load-error">${loadError}</p>` : null}
          ${!definitions ? html`<p class="loading">Loading…</p>` : null}
          ${definitions?.length === 0 ? html`<p class="load-error">No definitions found.</p>` : null}
          ${definitions?.map(
            (def) => html`
              <div
                key=${def.id}
                class=${'defn-rail-row' + (def.id === selectedId ? ' selected' : '') + (def.archived ? ' archived' : '')}
                onClick=${() => handleSelectDefinition(def)}
                role="button"
                tabindex="0"
                onKeyDown=${(e) => { if (e.key === 'Enter') handleSelectDefinition(def) }}
              >
                <div class="defn-rail-title">${def.title} (${def.id})${def.archived ? html` <span class="stamp small error">archived</span>` : null}</div>
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
                <div class="defn-rail-actions">
                  ${def.archived
                    ? html`<button class="btn small ghost" onClick=${(e) => { e.stopPropagation(); handleRestore(def.id) }}>Restore</button>`
                    : html`<button class="btn small ghost" onClick=${(e) => { e.stopPropagation(); handleArchive(def.id) }}>Archive</button>`}
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
                  <button class="btn small" onClick=${handleNewDraft}>New draft version</button>
                  ${newDraftError ? html`<p class="inline-error">${newDraftError}</p>` : null}
                </div>
              `
            : null}
          ${detailLoading ? html`<p class="loading">Loading…</p>` : null}
          ${detailError ? html`<p class="load-error">${detailError}</p>` : null}
          ${publishProblems.length ? html`
            <div class="load-error">
              <p><strong>Publish failed:</strong></p>
              <ul>${publishProblems.map((p) => html`<li>${p.message}</li>`)}</ul>
            </div>
          ` : null}
          ${publishError ? html`<p class="load-error">${publishError}</p>` : null}
          ${detail && !detailLoading && !editing
            ? html`
                <div class="defn-viewer-content">
                  <header class="defn-viewer-header">
                    <h2>${detail.title} · <span class="defn-id">${detail.id}</span> · <span class="stamp small ${detail.status === 'published' ? 'agreed' : 'draft'}">v${detail.version} ${detail.status}</span></h2>
                    <div class="defn-header-actions">
                      ${isDraft
                        ? html`
                          <button class="btn small" onClick=${handleStartEdit}>Edit</button>
                          <button class="btn small primary" onClick=${handlePublish} disabled=${publishing}>${publishing ? 'Publishing…' : 'Publish'}</button>
                        `
                        : html`<p class="guidance">Read-only — editing arrives in a later release.</p>`}
                    </div>
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
                      (a) => {
                        const vt = viewTemplates[templateBasename(a.template)] ?? {}
                        return html`
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
                          ${a.template ? html`
                            <div class="defn-template-view-block">
                              <button class="btn small ghost defn-template-toggle" onClick=${() => handleToggleViewTemplate(a.template)}>${vt.open ? 'Hide template source' : 'View template source'}</button>
                              ${vt.open ? html`
                                ${vt.loading ? html`<p class="loading">Loading…</p>` : vt.error ? html`<p class="inline-error">${vt.error}</p>` : html`<pre class="defn-template-view" style="white-space:pre-wrap; font-family:var(--font-mono); font-size:13px; background:var(--bg-raised); border:var(--hairline) solid var(--line); padding:8px; max-height:400px; overflow:auto;">${vt.source}</pre>`}
                              ` : null}
                            </div>
                          ` : null}
                        </div>
                      `
                      }
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
                        <div class=${'defn-card' + (dragSource?.listPath === 'stages' && dragSource.index === si ? ' defn-dragging' : '') + (dragOver?.listPath === 'stages' && dragOver.index === si ? ' defn-drop-target' : '')} key=${si} onDragOver=${(e) => handleDragOver(e, 'stages', si)} onDragLeave=${() => { if (dragOver?.listPath === 'stages' && dragOver.index === si) setDragOver(null) }} onDrop=${(e) => handleDrop(e, 'stages', si)} onDragEnd=${handleDragEnd}>
                          <div class="defn-editor-row" style="display:flex;align-items:center;gap:8px">
                            <span class="defn-drag-handle" draggable="true" onDragStart=${(e) => handleDragStart(e, 'stages', si)} onDragEnd=${handleDragEnd} role="button" aria-label=${`Drag stage "${s.title}"`} title="Drag to reorder">⠿</span>
                            <label class="field-label">Stage id</label>
                            <code>${s.id}</code>
                            <span class="defn-move-btns">
                              <button class="btn small ghost" aria-label=${`Move stage "${s.title}" up`} disabled=${si === 0} onClick=${() => updateDraft((d) => { d.stages = reorder(d.stages, si, si - 1) })}>↑</button>
                              <button class="btn small ghost" aria-label=${`Move stage "${s.title}" down`} disabled=${si === draft.stages.length - 1} onClick=${() => updateDraft((d) => { d.stages = reorder(d.stages, si, si + 1) })}>↓</button>
                            </span>
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
                                (mid, mi) => {
                                  const mp = `stage:${si}:modules`
                                  return html`
                                  <li key=${mi} class=${(dragSource?.listPath === mp && dragSource.index === mi ? 'defn-dragging ' : '') + (dragOver?.listPath === mp && dragOver.index === mi ? 'defn-drop-target' : '')} onDragOver=${(e) => handleDragOver(e, mp, mi)} onDragLeave=${() => { if (dragOver?.listPath === mp && dragOver.index === mi) setDragOver(null) }} onDrop=${(e) => handleDrop(e, mp, mi)} onDragEnd=${handleDragEnd}>
                                    <span class="defn-drag-handle" draggable="true" onDragStart=${(e) => handleDragStart(e, mp, mi)} onDragEnd=${handleDragEnd} role="button" aria-label=${`Drag module ref "${mid}"`} title="Drag to reorder">⠿</span>
                                    <code>${mid}</code>
                                    <span class="defn-move-btns">
                                      <button class="btn small ghost" aria-label=${`Move module ref "${mid}" up`} disabled=${mi === 0} onClick=${() => updateDraft((d) => { d.stages[si].modules = reorder(d.stages[si].modules, mi, mi - 1) })}>↑</button>
                                      <button class="btn small ghost" aria-label=${`Move module ref "${mid}" down`} disabled=${mi === s.modules.length - 1} onClick=${() => updateDraft((d) => { d.stages[si].modules = reorder(d.stages[si].modules, mi, mi + 1) })}>↓</button>
                                    </span>
                                    <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.stages[si].modules.splice(mi, 1) })}>✕</button>
                                  </li>
                                `
                                }
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
                        <div class=${'defn-card' + (dragSource?.listPath === 'artefacts' && dragSource.index === ai ? ' defn-dragging' : '') + (dragOver?.listPath === 'artefacts' && dragOver.index === ai ? ' defn-drop-target' : '')} key=${ai} onDragOver=${(e) => handleDragOver(e, 'artefacts', ai)} onDragLeave=${() => { if (dragOver?.listPath === 'artefacts' && dragOver.index === ai) setDragOver(null) }} onDrop=${(e) => handleDrop(e, 'artefacts', ai)} onDragEnd=${handleDragEnd}>
                          <div class="defn-editor-row" style="display:flex;align-items:center;gap:8px">
                            <span class="defn-drag-handle" draggable="true" onDragStart=${(e) => handleDragStart(e, 'artefacts', ai)} onDragEnd=${handleDragEnd} role="button" aria-label=${`Drag artefact "${a.title}"`} title="Drag to reorder">⠿</span>
                            <label class="field-label">Artefact id</label>
                            <code>${a.id}</code>
                            <span class="defn-move-btns">
                              <button class="btn small ghost" aria-label=${`Move artefact "${a.title}" up`} disabled=${ai === 0} onClick=${() => updateDraft((d) => { d.artefacts = reorder(d.artefacts, ai, ai - 1) })}>↑</button>
                              <button class="btn small ghost" aria-label=${`Move artefact "${a.title}" down`} disabled=${ai === draft.artefacts.length - 1} onClick=${() => updateDraft((d) => { d.artefacts = reorder(d.artefacts, ai, ai + 1) })}>↓</button>
                            </span>
                          </div>
                          <label class="field-label">Title</label>
                          <input class="wizard-input" value=${a.title} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].title = e.currentTarget.value })} />
                          <label class="field-label">Purpose</label>
                          <input class="wizard-input" value=${a.purpose ?? ''} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].purpose = e.currentTarget.value })} />
                          <label class="field-label">Gate</label>
                          <input class="wizard-input" value=${a.gate ?? ''} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].gate = e.currentTarget.value })} />
                          <label class="field-label">Template</label>
                          <input class="wizard-input" value=${a.template ?? ''} onInput=${(e) => updateDraft((d) => { d.artefacts[ai].template = e.currentTarget.value })} />
                          ${(() => {
                            const tmplName = templateBasename(a.template)
                            if (!tmplName) return null
                            const ed = templateEditors[tmplName] ?? {}
                            return html`
                              <div class="defn-template-editor-block">
                                ${!ed.open ? html`<button class="btn small defn-template-toggle" onClick=${() => handleOpenTemplate(a.template)}>Edit template</button>` : html`
                                  <div class="defn-template-editor-wrap">
                                    <label class="field-label">Template source — ${tmplName}</label>
                                    ${ed.loading ? html`<p class="loading">Loading…</p>` : html`
                                      <textarea class="defn-template-editor wizard-input" rows="16" style="font-family:var(--font-mono); font-size:13px; white-space:pre; overflow:auto;" value=${ed.source ?? ''} onInput=${(e) => setTemplateEditors((prev) => ({ ...prev, [tmplName]: { ...(prev[tmplName] ?? {}), source: e.currentTarget.value, error: null, saved: null } }))}></textarea>
                                      ${ed.error ? html`<p class="inline-error defn-template-error">${ed.error}</p>` : null}
                                      ${ed.saved ? html`<p class="save-status defn-template-saved">${ed.saved}</p>` : null}
                                      <div class="defn-template-actions" style="display:flex; gap:8px; margin-top:8px;">
                                        <button class="btn small primary" onClick=${() => handleSaveTemplate(a.template)} disabled=${ed.saving}>${ed.saving ? 'Saving…' : 'Save template'}</button>
                                        <button class="btn small ghost" onClick=${() => handleCloseTemplate(a.template)}>Close</button>
                                      </div>
                                    `}
                                  </div>
                                `}
                              </div>
                            `
                          })()}
                          <div class="defn-requires-list">
                            <span class="field-label">Requires</span>
                            <ul>
                              ${a.requires.map(
                                (r, ri) => {
                                  const rp = `artefact:${ai}:requires`
                                  return html`
                                  <li key=${ri} class=${(dragSource?.listPath === rp && dragSource.index === ri ? 'defn-dragging ' : '') + (dragOver?.listPath === rp && dragOver.index === ri ? 'defn-drop-target' : '')} onDragOver=${(e) => handleDragOver(e, rp, ri)} onDragLeave=${() => { if (dragOver?.listPath === rp && dragOver.index === ri) setDragOver(null) }} onDrop=${(e) => handleDrop(e, rp, ri)} onDragEnd=${handleDragEnd}>
                                    <span class="defn-drag-handle" draggable="true" onDragStart=${(e) => handleDragStart(e, rp, ri)} onDragEnd=${handleDragEnd} role="button" aria-label=${`Drag requirement "${r}"`} title="Drag to reorder">⠿</span>
                                    <code>${r}</code>
                                    <span class="defn-move-btns">
                                      <button class="btn small ghost" aria-label=${`Move requirement "${r}" up`} disabled=${ri === 0} onClick=${() => updateDraft((d) => { d.artefacts[ai].requires = reorder(d.artefacts[ai].requires, ri, ri - 1) })}>↑</button>
                                      <button class="btn small ghost" aria-label=${`Move requirement "${r}" down`} disabled=${ri === a.requires.length - 1} onClick=${() => updateDraft((d) => { d.artefacts[ai].requires = reorder(d.artefacts[ai].requires, ri, ri + 1) })}>↓</button>
                                    </span>
                                    <button class="btn small ghost" onClick=${() => updateDraft((d) => { d.artefacts[ai].requires.splice(ri, 1) })}>✕</button>
                                  </li>
                                `
                                }
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
                        <div class=${'defn-card' + (dragSource?.listPath === 'modules' && dragSource.index === mi ? ' defn-dragging' : '') + (dragOver?.listPath === 'modules' && dragOver.index === mi ? ' defn-drop-target' : '')} key=${mi} onDragOver=${(e) => handleDragOver(e, 'modules', mi)} onDragLeave=${() => { if (dragOver?.listPath === 'modules' && dragOver.index === mi) setDragOver(null) }} onDrop=${(e) => handleDrop(e, 'modules', mi)} onDragEnd=${handleDragEnd}>
                          <div style="display:flex;align-items:center;gap:8px">
                            <span class="defn-drag-handle" draggable="true" onDragStart=${(e) => handleDragStart(e, 'modules', mi)} onDragEnd=${handleDragEnd} role="button" aria-label=${`Drag module "${m.title ?? m.id}"`} title="Drag to reorder">⠿</span>
                            <label class="field-label" style="margin-bottom:0">Module id</label>
                            <span class="defn-move-btns">
                              <button class="btn small ghost" aria-label=${`Move module "${m.title ?? m.id}" up`} disabled=${mi === 0} onClick=${() => updateDraft((d) => { d.modules = reorder(d.modules, mi, mi - 1) })}>↑</button>
                              <button class="btn small ghost" aria-label=${`Move module "${m.title ?? m.id}" down`} disabled=${mi === draft.modules.length - 1} onClick=${() => updateDraft((d) => { d.modules = reorder(d.modules, mi, mi + 1) })}>↓</button>
                            </span>
                          </div>
                          <input class="wizard-input" value=${m.id} onInput=${(e) => updateDraft((d) => { d.modules[mi].id = e.currentTarget.value })} />
                          ${!isValidSlugClient(m.id) ? html`<p class="inline-error">Invalid slug — single segment, no slashes or ".."</p>` : null}
                          <label class="field-label">Title</label>
                          <input class="wizard-input" value=${m.title ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].title = e.currentTarget.value })} />
                          <label class="field-label">Purpose</label>
                          <input class="wizard-input" value=${m.purpose ?? ''} onInput=${(e) => updateDraft((d) => { d.modules[mi].purpose = e.currentTarget.value })} />
                          <div class="defn-fields-list">
                            <span class="field-label">Fields</span>
                            ${m.fields.map(
                              (f, fi) => {
                                const fp = `module:${mi}:fields`
                                return html`
                                <div class=${'defn-card defn-editor-field' + (dragSource?.listPath === fp && dragSource.index === fi ? ' defn-dragging' : '') + (dragOver?.listPath === fp && dragOver.index === fi ? ' defn-drop-target' : '')} key=${fi} onDragOver=${(e) => handleDragOver(e, fp, fi)} onDragLeave=${() => { if (dragOver?.listPath === fp && dragOver.index === fi) setDragOver(null) }} onDrop=${(e) => handleDrop(e, fp, fi)} onDragEnd=${handleDragEnd}>
                                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                                    <span class="defn-drag-handle" draggable="true" onDragStart=${(e) => handleDragStart(e, fp, fi)} onDragEnd=${handleDragEnd} role="button" aria-label=${`Drag field "${f.title ?? f.id}"`} title="Drag to reorder">⠿</span>
                                    <span class="field-label" style="margin-bottom:0">Field</span>
                                    <span class="defn-move-btns">
                                      <button class="btn small ghost" aria-label=${`Move field "${f.title ?? f.id}" up`} disabled=${fi === 0} onClick=${() => updateDraft((d) => { d.modules[mi].fields = reorder(d.modules[mi].fields, fi, fi - 1) })}>↑</button>
                                      <button class="btn small ghost" aria-label=${`Move field "${f.title ?? f.id}" down`} disabled=${fi === m.fields.length - 1} onClick=${() => updateDraft((d) => { d.modules[mi].fields = reorder(d.modules[mi].fields, fi, fi + 1) })}>↓</button>
                                    </span>
                                  </div>
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
                              }
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
