import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { apiFetch } from '../lib/apiFetch.js'
import { renderMarkdown } from '../lib/markdown.js'

const GUIDE_SECTIONS = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'workspaces-instances', label: 'Workspaces & Instances' },
  { id: 'stages-gates', label: 'Stages & Gates' },
  { id: 'modules-fields', label: 'Modules & Fields' },
  { id: 'artefacts-rendering', label: 'Artefacts & Rendering' },
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
  // The screenshot the reader clicked, shown full-size in an overlay. `null` when closed.
  const [zoomed, setZoomed] = useState(null)
  const contentRef = useRef(null)

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

  // The guide body is injected as raw HTML, so its <img> elements can't carry
  // preact props — decorate them for keyboard/AT once the markup is in the DOM.
  useEffect(() => {
    if (guide === null || !contentRef.current) return
    for (const img of contentRef.current.querySelectorAll('img')) {
      img.setAttribute('role', 'button')
      img.setAttribute('tabindex', '0')
      if (!img.getAttribute('title')) img.setAttribute('title', 'Click to enlarge')
    }
  }, [guide])

  useEffect(() => {
    if (!zoomed) return
    function onKey(e) {
      if (e.key === 'Escape') setZoomed(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

  function activateImage(e) {
    const img = e.target?.closest?.('img')
    if (!img || !contentRef.current?.contains(img)) return
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return
    if (e.type === 'keydown') e.preventDefault()
    setZoomed({ src: img.currentSrc || img.src, alt: img.alt || '' })
  }

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
            : html`<div
                ref=${contentRef}
                onClick=${activateImage}
                onKeyDown=${activateImage}
                dangerouslySetInnerHTML=${{ __html: guide }}
              />`}
      </article>
    </main>
    ${zoomed
      ? html`<div
          class="guide-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label=${zoomed.alt || 'Expanded screenshot'}
          onClick=${() => setZoomed(null)}
        >
          <img src=${zoomed.src} alt=${zoomed.alt} />
          <button type="button" class="guide-lightbox-close" aria-label="Close" onClick=${() => setZoomed(null)}>×</button>
        </div>`
      : null}
  `
}
