import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { apiFetch, apiFetchForInstance } from './apiFetch.js'

export function IdentityPicker({ value, onChange, placeholder, slug, organization, project, className, id }) {
  const [query, setQuery] = useState(value ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const debounceRef = useRef(null)
  const inputRef = useRef(null)
  const wrapperRef = useRef(null)

  useEffect(() => {
    setQuery(value ?? '')
  }, [value])

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function search(q) {
    if (!q.trim()) {
      setResults([])
      setOpen(false)
      return
    }
    setLoading(true)
    setSearchError('')
    try {
      const params = new URLSearchParams({ q })
      if (slug) params.set('slug', slug)
      else if (organization && project) {
        params.set('organization', organization)
        params.set('project', project)
      }
      const res = slug ? await apiFetchForInstance(slug, `/api/identities?${params}`) : await apiFetch(`/api/identities?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResults([])
        setSearchError(data.message ?? data.error ?? `Identity search failed (${res.status})`)
        setOpen(true)
        return
      }
      setResults(Array.isArray(data) ? data : [])
      setOpen(true)
    } catch (err) {
      setResults([])
      setSearchError(err.message)
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }

  function handleInput(e) {
    const val = e.currentTarget.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(val), 250)
  }

  function handleSelect(identity) {
    setQuery(identity.displayName)
    setOpen(false)
    onChange?.(identity.uniqueName, identity)
  }

  function handleClear() {
    setQuery('')
    setResults([])
    setOpen(false)
    onChange?.('', null)
    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = query.trim()
      setOpen(false)
      onChange?.(trimmed, trimmed ? { uniqueName: trimmed, displayName: trimmed } : null)
    }
  }

  const hasValue = Boolean(query.trim())

  return html`
    <div class=${'identity-picker' + (className ? ' ' + className : '')} ref=${wrapperRef}>
      <input
        ref=${inputRef}
        id=${id}
        type="text"
        value=${query}
        placeholder=${placeholder ?? 'Search by name\u2026'}
        onInput=${handleInput}
        onFocus=${() => { if (query.trim() && results.length) setOpen(true) }}
        onBlur=${() => {
          const trimmed = query.trim()
          if (trimmed !== (value ?? '').trim()) {
            onChange?.(trimmed, trimmed ? { uniqueName: trimmed, displayName: trimmed } : null)
          }
          setOpen(false)
        }}
        onKeyDown=${handleKeyDown}
      />
      ${hasValue
        ? html`<button type="button" class="clear-btn" onClick=${handleClear} aria-label="Clear">×</button>`
        : null}
      <div class=${'identity-dropdown' + (open ? ' open' : '')}>
        ${searchError ? html`<div class="no-results">${searchError}</div>` : null}
        ${!searchError && loading ? html`<div class="no-results">Searching…</div>` : null}
        ${!searchError && !loading && results.length === 0 && query.trim()
          ? html`<div class="no-results">No identities found for "${query}".</div>`
          : null}
        ${results.map(
          (identity) => html`
            <button
              type="button"
              class="identity-option"
              key=${identity.uniqueName}
              onClick=${() => handleSelect(identity)}
            >
              <span class="name">${identity.displayName}</span>
              ${identity.emailAddress
                ? html`<span class="email">${identity.emailAddress}</span>`
                : null}
            </button>
          `
        )}
      </div>
    </div>
  `
}
