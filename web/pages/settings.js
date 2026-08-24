// Settings screens (#107): three separate, tab-free top-level routes —
// `/settings` (Global Settings), `/settings/workspace` (Workspace Settings,
// scoped to one instance's own workspace) and `/settings/instance`
// (Instance Settings, new) — replacing #101/#104's single tabbed `/settings`
// shell (Global Defaults tab + a Workspace overrides tab listing every
// registered workspace). That tabbed shell is gone entirely, not merely
// hidden: no Settings screen has tabs any more, and there is no longer any
// screen that lists every workspace at once — Workspace Settings shows only
// the one workspace behind whichever instance it was opened for.
//
// Every screen here takes an explicit `from` query param (the path Settings
// was actually opened from) and its back control returns there — never via
// browser history — falling back to Home (`/`) when `from` is absent (a
// direct/bookmarked URL). `preact-iso` hands a matched route's query string
// straight through as a `query` prop (see its own `exec`/`Router`), so every
// page component below reads `query.from`/`query.slug` directly rather than
// re-parsing `location.search` itself.
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { theme, cycleTheme } from '../lib/theme.js'
import {
  pat,
  clearPat,
  requestPat,
  hasWorkspacePatOverride,
  setWorkspacePatOverride,
  clearWorkspacePatOverride,
} from '../lib/credential.js'
import { TICKETING_SYSTEMS, defaultTicketingSystem, setDefaultTicketingSystem } from '../lib/ticketingSystem.js'
import { apiFetch, apiFetchForInstance } from '../lib/apiFetch.js'

// ---------- Shared header ----------
// One header shape for all three Settings screens: a title (distinct per
// screen, since there's no shared tab strip to convey which screen this
// is any more) and a back control that honors `from` — the instance
// screen's own `/instance/<slug>` when opened from there, or Home when
// opened from the dashboard (or omitted entirely, e.g. a bookmarked URL).
function SettingsHeader({ title, backHref }) {
  return html`
    <header class="settings-header">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>${title}</h1>
        <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
          Theme: ${theme.value}
        </button>
      </div>
      <a class="btn small ghost" href=${backHref}>← Back</a>
    </header>
  `
}

// The path a Settings screen was opened from, `?from=`-encoded by whoever
// linked here (the dashboard, or the instance screen's Settings dropdown —
// see web/app.js's SettingsMenu) — falling back to Home when absent, per
// this ticket's own "falls back to Home when there's no such origin"
// acceptance criterion. Never read from browser history.
function backHrefFrom(query) {
  return query?.from || '/'
}

// ---------- Global Settings (`/settings`) ----------
// The exact same PAT-management and default-ticketing-system content
// #101's old Global Defaults tab held — moved here wholesale, now the
// entire screen rather than one tab among others. Reached directly (no
// intermediate step) from Home, and via the instance screen's Settings
// dropdown.
function GlobalPatSection() {
  return html`
    <section class="settings-section">
      <h2>Azure DevOps Personal Access Token</h2>
      <p class="guidance">
        Used for every Azure-DevOps-backed instance this gantry server serves. Stored only in this browser and sent
        solely to your own gantry server — needs <strong>Code (Read &amp; write)</strong> and
        <strong>Work Items (Read &amp; write)</strong> scope.
      </p>
      <div class="settings-pat-status">
        ${pat.value ? html`<span class="stamp agreed">SET</span>` : html`<span class="stamp draft">NOT SET</span>`}
      </div>
      <div class="settings-actions">
        ${pat.value
          ? html`
              <button type="button" class="btn" onClick=${() => requestPat()}>Replace Azure DevOps PAT</button>
              <button type="button" class="btn ghost" onClick=${clearPat}>Clear Azure DevOps PAT</button>
            `
          : html`<button type="button" class="btn primary" onClick=${() => requestPat()}>Set Azure DevOps PAT</button>`}
      </div>
    </section>
  `
}

function TicketingSystemSection() {
  return html`
    <section class="settings-section">
      <h2>Default ticketing system</h2>
      <p class="guidance">
        Which ticketing system new workspaces default to, until a workspace's own override (its Workspace Settings
        screen) says otherwise.
      </p>
      <div class="settings-radio-group" role="radiogroup" aria-label="Default ticketing system">
        ${TICKETING_SYSTEMS.map(
          (system) => html`
            <label key=${system.id} class=${'settings-radio' + (system.disabled ? ' disabled' : '')}>
              <input
                type="radio"
                name="default-ticketing-system"
                value=${system.id}
                checked=${defaultTicketingSystem.value === system.id}
                disabled=${system.disabled}
                onChange=${() => setDefaultTicketingSystem(system.id)}
              />
              ${system.label}
              ${system.disabled ? html`<span class="stamp review">${system.disabledReason}</span>` : null}
            </label>
          `
        )}
      </div>
    </section>
  `
}

export function GlobalSettingsPage({ query }) {
  return html`
    <${SettingsHeader} title="Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      <${GlobalPatSection} />
      <${TicketingSystemSection} />
    </main>
  `
}

// ---------- Workspace Settings (`/settings/workspace?slug=<instance-slug>`) ----------
// Scoped to one instance's own workspace only — never a picker or listing
// across every registered workspace (that whole-registry view is gone,
// along with the tabbed shell it used to live in). `slug` names the
// instance whose workspace this is; the workspace itself (found via `GET
// /api/instance/workspace`, then looked up by id in `GET /api/workspaces` —
// both pre-existing, uncredentialed registry reads, see their own route
// comments in lib/server.js) is what's actually shown/edited.

async function fetchInstanceWorkspaceId(slug) {
  const res = await apiFetch(`/api/instance/workspace?slug=${encodeURIComponent(slug)}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to resolve this instance's workspace (${res.status})`)
  }
  return body.workspaceId ?? null
}

async function fetchWorkspaceById(workspaceId) {
  const res = await apiFetch('/api/workspaces')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to load workspaces (${res.status})`)
  }
  return body.find((w) => w.id === workspaceId) ?? null
}

async function patchWorkspace(id, updates) {
  const res = await apiFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to update workspace (${res.status})`)
  }
  return body
}

// The standard `https://dev.azure.com/{organization}/{project}/_git/{repository}`
// shape — the reverse of web/lib/validateRepo.js's `parseRepoUrl` — with
// `baseUrl` (an on-premises Azure DevOps Server location) substituted in
// place of `https://dev.azure.com` when a workspace carries one.
function workspaceRepoUrl(workspace) {
  const base = workspace.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(workspace.organization)}/${encodeURIComponent(workspace.project)}/_git/${encodeURIComponent(workspace.repository)}`
}

// One workspace's editable fields: owner (server-persisted), a PAT
// override (client-only, never touches the server), and a
// ticketing-system override (server-persisted) — the same three fields
// #104's old Workspace overrides tab exposed per row, now rendered for
// exactly one workspace (the instance's own) rather than one row per
// registered workspace.
function WorkspaceEditor({ workspace, onUpdated }) {
  const [ownerDraft, setOwnerDraft] = useState(workspace.owner ?? '')
  const [ownerStatus, setOwnerStatus] = useState('')
  const [patDraft, setPatDraft] = useState('')
  const [patStatus, setPatStatus] = useState('')
  const [ticketingStatus, setTicketingStatus] = useState('')

  useEffect(() => {
    setOwnerDraft(workspace.owner ?? '')
  }, [workspace.owner])

  const hasPatOverride = hasWorkspacePatOverride(workspace.id)
  const hasTicketingOverride = workspace.ticketingSystem !== defaultTicketingSystem.value

  async function handleSaveOwner() {
    setOwnerStatus('Saving…')
    try {
      const updated = await patchWorkspace(workspace.id, { owner: ownerDraft })
      onUpdated(updated)
      setOwnerStatus('Saved.')
    } catch (err) {
      setOwnerStatus(err.message)
    }
  }

  function handleSetPatOverride() {
    setWorkspacePatOverride(workspace.id, patDraft)
    setPatDraft('')
    setPatStatus('Override saved — used for this workspace\u2019s instances from now on.')
  }

  function handleClearPatOverride() {
    clearWorkspacePatOverride(workspace.id)
    setPatStatus('Override cleared — falling back to the global default.')
  }

  async function handleTicketingChange(systemId) {
    setTicketingStatus('Saving…')
    try {
      const updated = await patchWorkspace(workspace.id, { ticketingSystem: systemId })
      onUpdated(updated)
      setTicketingStatus('')
    } catch (err) {
      setTicketingStatus(err.message)
    }
  }

  return html`
    <div class="workspace-row" data-workspace-id=${workspace.id}>
      <a class="workspace-repo-url" href=${workspaceRepoUrl(workspace)} target="_blank" rel="noreferrer">
        ${workspace.organization}/${workspace.project}/${workspace.repository}
      </a>

      <div class="workspace-field workspace-owner">
        <label>Owner</label>
        <div class="workspace-field-row">
          <input
            type="text"
            class="wizard-input"
            value=${ownerDraft}
            placeholder="Unset"
            onInput=${(e) => setOwnerDraft(e.currentTarget.value)}
          />
          <button type="button" class="btn small" onClick=${handleSaveOwner}>Save owner</button>
        </div>
        <div class="workspace-field-status">${ownerStatus}</div>
      </div>

      <div class="workspace-field workspace-pat">
        <label>Azure DevOps PAT override</label>
        <div class="workspace-pat-status">
          ${hasPatOverride
            ? html`<span class="stamp agreed">OVERRIDE SET</span>`
            : html`<span class="stamp draft">USING GLOBAL DEFAULT</span>`}
        </div>
        <div class="workspace-field-row">
          <input
            type="password"
            class="wizard-input"
            value=${patDraft}
            placeholder="Paste a PAT to override the global default for this workspace"
            onInput=${(e) => setPatDraft(e.currentTarget.value)}
          />
          <button type="button" class="btn small" disabled=${!patDraft.trim()} onClick=${handleSetPatOverride}>
            ${hasPatOverride ? 'Replace override' : 'Set override'}
          </button>
          ${hasPatOverride
            ? html`<button type="button" class="btn small ghost" onClick=${handleClearPatOverride}>Clear override</button>`
            : null}
        </div>
        <div class="workspace-field-status">${patStatus}</div>
      </div>

      <div class="workspace-field workspace-ticketing">
        <label>Ticketing system</label>
        <div
          class="settings-radio-group"
          role="radiogroup"
          aria-label=${`Ticketing system for ${workspace.organization}/${workspace.project}/${workspace.repository}`}
        >
          ${TICKETING_SYSTEMS.map(
            (system) => html`
              <label key=${system.id} class=${'settings-radio' + (system.disabled ? ' disabled' : '')}>
                <input
                  type="radio"
                  name=${`workspace-ticketing-${workspace.id}`}
                  value=${system.id}
                  checked=${workspace.ticketingSystem === system.id}
                  disabled=${system.disabled}
                  onChange=${() => handleTicketingChange(system.id)}
                />
                ${system.label}
                ${system.disabled ? html`<span class="stamp review">${system.disabledReason}</span>` : null}
              </label>
            `
          )}
        </div>
        <div class="workspace-ticketing-state">
          ${hasTicketingOverride
            ? html`<span class="stamp agreed">OVERRIDE</span>`
            : html`<span class="stamp draft">USING GLOBAL DEFAULT</span>`}
        </div>
        <div class="workspace-field-status">${ticketingStatus}</div>
      </div>
    </div>
  `
}

export function WorkspaceSettingsPage({ query }) {
  const slug = query?.slug
  const [state, setState] = useState('loading') // 'loading' | 'no-slug' | 'no-workspace' | 'ready' | 'error'
  const [error, setError] = useState('')
  const [workspace, setWorkspace] = useState(null)

  useEffect(() => {
    if (!slug) {
      setState('no-slug')
      return
    }
    let cancelled = false
    setState('loading')
    ;(async () => {
      try {
        const workspaceId = await fetchInstanceWorkspaceId(slug)
        if (!workspaceId) {
          if (!cancelled) setState('no-workspace')
          return
        }
        const ws = await fetchWorkspaceById(workspaceId)
        if (cancelled) return
        if (!ws) {
          setState('no-workspace')
          return
        }
        setWorkspace(ws)
        setState('ready')
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
          setState('error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  return html`
    <${SettingsHeader} title="Workspace Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      <section class="settings-section">
        <h2>Workspace</h2>
        <p class="guidance">
          This instance's own workspace (an Azure DevOps repo) — its owner, repo URL, and any PAT or
          ticketing-system override away from the Global Settings screen's values. Not a picker across every
          registered workspace: just the one this instance belongs to.
        </p>
        ${state === 'no-slug' ? html`<p class="load-error">No instance was specified for these Workspace Settings.</p>` : null}
        ${state === 'loading' ? html`<p class="loading">Loading…</p>` : null}
        ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
        ${state === 'no-workspace'
          ? html`<p class="workspace-empty">This instance has no Azure DevOps workspace — its data is stored locally.</p>`
          : null}
        ${state === 'ready'
          ? html`
              <div class="workspace-list">
                <${WorkspaceEditor} workspace=${workspace} onUpdated=${setWorkspace} />
              </div>
            `
          : null}
      </section>
    </main>
  `
}

// ---------- Instance Settings (`/settings/instance?slug=<instance-slug>`) ----------
// New (#107): hosts the instance's Assignee (editable), read-only instance
// info, and the instance's own Azure DevOps work-item link details
// (read-only — re-linking isn't supported here; that's still done from the
// module editor's own work-item panel, see web/app.js's WorkItemPanel).

async function fetchInstanceDetail(slug) {
  const res = await apiFetchForInstance(slug, `/api/instance?slug=${encodeURIComponent(slug)}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to load instance (${res.status})`)
  }
  return body
}

async function saveAssignee(slug, assignee) {
  const res = await apiFetchForInstance(slug, `/api/instance/assignee?slug=${encodeURIComponent(slug)}`, {
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

// The instance's own stored Assignee — editable here, distinct from a
// module's own frontmatter `owner` (the Design Authority sign-off
// convention, untouched by this screen). Mirrors the dashboard's own
// assignee editor (web/app.js's MasterDetailView), just as a single
// labelled field rather than one per instance card.
function AssigneeSection({ slug, assignee }) {
  const [draft, setDraft] = useState(assignee ?? '')
  const [status, setStatus] = useState('')
  // Guards against a duplicate save firing for the same edit: clicking the
  // "Save" button below moves focus away from the input first, so the
  // input's own `onBlur` calls `handleSave` a moment before the button's
  // `onClick` does too — both synchronously, before either's `await`
  // resolves. Without this ref, that pair fires two identical `PUT
  // /api/instance/assignee` requests per click (for an Azure-DevOps-backed
  // instance, two separate commits pushed for the same content). Set
  // synchronously before the first `await`, so the second, redundant call
  // sees it and returns immediately rather than racing the first.
  const savingRef = useRef(false)

  useEffect(() => {
    setDraft(assignee ?? '')
  }, [assignee])

  async function handleSave() {
    if (draft === (assignee ?? '')) return
    if (savingRef.current) return
    savingRef.current = true
    setStatus('Saving…')
    try {
      await saveAssignee(slug, draft)
      setStatus('Saved.')
    } catch (err) {
      setStatus(err.message)
    } finally {
      savingRef.current = false
    }
  }

  return html`
    <section class="settings-section">
      <h2>Assignee</h2>
      <p class="guidance">The single named person responsible for this instance.</p>
      <div class="workspace-field-row">
        <input
          type="text"
          class="wizard-input"
          value=${draft}
          placeholder="Unassigned"
          onInput=${(e) => setDraft(e.currentTarget.value)}
          onBlur=${handleSave}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button type="button" class="btn small" onClick=${handleSave}>Save</button>
      </div>
      <div class="workspace-field-status">${status}</div>
    </section>
  `
}

// Read-only — slug, definition, and the instance's own current stage. Not
// a form: nothing here is editable from this screen.
function InstanceInfoSection({ instance }) {
  return html`
    <section class="settings-section">
      <h2>Instance info</h2>
      <div class="result-card">
        <div class="result-row"><span class="k">Slug</span><span class="v">${instance.slug}</span></div>
        <div class="result-row"><span class="k">Definition</span><span class="v">${instance.definition}</span></div>
        <div class="result-row">
          <span class="k">Current stage</span>
          <span class="v">${instance.stage.title} (gate: ${instance.stage.gate})</span>
        </div>
      </div>
    </section>
  `
}

// Read-only — re-linking isn't supported here (or anywhere but the module
// editor's own work-item panel, which this screen deliberately doesn't
// duplicate). Shows the parent work item and, per stage, this instance's
// own child work item id.
function WorkItemLinkSection({ instance }) {
  const workItem = instance.workItem

  return html`
    <section class="settings-section">
      <h2>Azure DevOps work item</h2>
      ${!workItem
        ? html`<p class="guidance">This instance isn't linked to an Azure DevOps work item.</p>`
        : html`
            <div class="result-card">
              <div class="result-row"><span class="k">Organization</span><span class="v">${workItem.organization}</span></div>
              <div class="result-row"><span class="k">Project</span><span class="v">${workItem.project}</span></div>
              <div class="result-row"><span class="k">Work item type</span><span class="v">${workItem.workItemType}</span></div>
              <div class="result-row"><span class="k">Parent work item</span><span class="v">#${workItem.parentId}</span></div>
              ${instance.stages.map(
                (stage) => html`
                  <div class="result-row" key=${stage.id}>
                    <span class="k">${stage.title}</span>
                    <span class="v">${workItem.stages?.[stage.id] ? `#${workItem.stages[stage.id]}` : '—'}</span>
                  </div>
                `
              )}
            </div>
            <p class="guidance">Re-linking isn't supported here — this is a read-only view of the existing link.</p>
          `}
    </section>
  `
}

export function InstanceSettingsPage({ query }) {
  const slug = query?.slug
  const [state, setState] = useState('loading') // 'loading' | 'no-slug' | 'ready' | 'error'
  const [error, setError] = useState('')
  const [instance, setInstance] = useState(null)

  useEffect(() => {
    if (!slug) {
      setState('no-slug')
      return
    }
    let cancelled = false
    setState('loading')
    fetchInstanceDetail(slug)
      .then((data) => {
        if (cancelled) return
        setInstance(data)
        setState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  return html`
    <${SettingsHeader} title="Instance Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      ${state === 'no-slug' ? html`<p class="load-error">No instance was specified for these Instance Settings.</p>` : null}
      ${state === 'loading' ? html`<p class="loading">Loading…</p>` : null}
      ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
      ${state === 'ready'
        ? html`
            <${AssigneeSection} slug=${slug} assignee=${instance.assignee} />
            <${InstanceInfoSection} instance=${instance} />
            <${WorkItemLinkSection} instance=${instance} />
          `
        : null}
    </main>
  `
}
