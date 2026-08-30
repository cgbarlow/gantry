import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { renderMarkdown } from '../lib/markdown.js'

export function DefinitionViewerPage() {
  const [definitions, setDefinitions] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedVersion, setSelectedVersion] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

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

  function handleSelectDefinition(def) {
    setSelectedId(def.id)
    const v = def.latestPublished ?? Math.max(...def.versions.map((x) => x.version))
    setSelectedVersion(v)
  }

  const selectedDef = definitions?.find((d) => d.id === selectedId) ?? null

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
          ${detail && !detailLoading
            ? html`
                <div class="defn-viewer-content">
                  <header class="defn-viewer-header">
                    <h2>${detail.title} · <span class="defn-id">${detail.id}</span> · <span class="stamp small ${detail.status === 'published' ? 'agreed' : 'draft'}">v${detail.version} ${detail.status}</span></h2>
                    <p class="guidance">Read-only — editing arrives in a later release.</p>
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
        </section>
      </div>
    </main>
  `
}
