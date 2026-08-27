import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { apiFetch } from '../lib/apiFetch.js'
import { renderMarkdown } from '../lib/markdown.js'

const GUIDE_SECTIONS = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'workspaces-instances', label: 'Workspaces & Instances' },
  { id: 'stages-gates', label: 'Stages & Gates', pending: true },
  { id: 'modules-fields', label: 'Modules & Fields' },
  { id: 'artefacts-rendering', label: 'Artefacts & Rendering', pending: true },
  { id: 'approval-workflow', label: 'Approval workflow' },
  { id: 'settings', label: 'Settings' },
]

function GantryBrandIcon() {
  return html`
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
    </svg>
  `
}

function GuideNavigation() {
  return html`
    <nav class="guide-navigation" aria-label="User Guide sections">
      <h2>In this guide</h2>
      <ol>
        ${GUIDE_SECTIONS.map(
          (section) => html`
            <li key=${section.id} class=${section.pending ? 'pending' : ''}>
              <a href=${`#${section.id}`}>${section.label}</a>
              ${section.pending ? html`<span>Pending</span>` : null}
            </li>
          `
        )}
      </ol>
    </nav>
  `
}

export function UserGuidePage() {
  const [guide, setGuide] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    apiFetch('/api/user-guide')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.message ?? body.error ?? `Failed to load the User Guide (${res.status})`)
        return body.markdown
      })
      .then((markdown) => {
        if (active) setGuide(renderMarkdown(markdown))
      })
      .catch((err) => {
        if (active) setError(err.message)
      })
    return () => {
      active = false
    }
  }, [])

  return html`
    <header class="guide-header">
      <div class="brand">
        <${GantryBrandIcon} />
        <h1>User Guide</h1>
      </div>
      <a class="btn small ghost" href="/">← Workspaces</a>
    </header>
    <main class="guide-page">
      <${GuideNavigation} />
      <article class="guide-content">
        ${error
          ? html`<p class="load-error">Failed to load: ${error}</p>`
          : guide === null
            ? html`<p class="loading">Loading User Guide…</p>`
            : html`<div dangerouslySetInnerHTML=${{ __html: guide }} />`}
      </article>
    </main>
  `
}
