// Settings screen (#101/#104): a new top-level `/settings` route with a
// tabbed shell. Global Defaults holds the Azure DevOps PAT management moved
// off the per-instance editor header (see web/app.js's AppHeader — its
// "Replace Azure DevOps PAT"/"Clear Azure DevOps PAT" buttons are removed
// entirely, not just hidden) and a global ticketing-system default
// selector. Workspace overrides (#104) lists every registered workspace
// with its owner, repo URL, and a PAT/ticketing-system override away from
// those global defaults — `TABS` is a real array (not a single hard-coded
// panel) precisely so a second tab could be added without restructuring
// the shell, which is exactly what #104 does.
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
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
import { apiFetch } from '../lib/apiFetch.js'

const TABS = [
  { id: 'global-defaults', label: 'Global Defaults' },
  { id: 'workspaces', label: 'Workspace overrides' },
]

function SettingsHeader() {
  return html`
    <header class="settings-header">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
        </svg>
        <h1>Settings</h1>
        <button type="button" class="btn small ghost theme-toggle" onClick=${cycleTheme} title="Cycle theme">
          Theme: ${theme.value}
        </button>
      </div>
      <a class="btn small ghost" href="/">← Instances</a>
    </header>
  `
}

function SettingsTabs({ activeTab, onSelect }) {
  return html`
    <div class="settings-tabs" role="tablist" aria-label="Settings">
      ${TABS.map(
        (tab) => html`
          <button
            type="button"
            key=${tab.id}
            role="tab"
            aria-selected=${activeTab === tab.id}
            class=${activeTab === tab.id ? 'active' : ''}
            onClick=${() => onSelect(tab.id)}
          >
            ${tab.label}
          </button>
        `
      )}
    </div>
  `
}

// The default PAT this section manages is the exact same one
// web/lib/credential.js already held (and web/app.js's per-instance editor
// header used to expose) — moved here wholesale, not reimplemented. A
// third state this section adds beyond "replace"/"clear" (which assumed a
// PAT already existed): a first-time "Set" action, since this is now the
// *only* place a PAT can be entered ahead of any 401 ever prompting for
// one.
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
        Which ticketing system new workspaces default to, until a workspace-level override (the "Workspace
        overrides" tab) says otherwise.
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

function GlobalDefaultsTab() {
  return html`
    <${GlobalPatSection} />
    <${TicketingSystemSection} />
  `
}

// ---------- Workspace overrides tab (#104) ----------

async function loadWorkspaces() {
  const res = await apiFetch('/api/workspaces')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load workspaces (${res.status})`)
  }
  return res.json()
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

// One workspace's row: owner (viewed/edited here), repo URL, a PAT-override
// control (client-only — web/lib/credential.js — never touches the
// server), and a ticketing-system-override control (server-persisted —
// `PATCH /api/workspaces/:id` — since the workspace registry already
// stores this per-workspace, per #96). `onUpdated` reports a fresh
// workspace record back up to `WorkspacesTab` after any server-side PATCH
// succeeds, so the list reflects it without a full re-fetch.
function WorkspaceRow({ workspace, onUpdated }) {
  const [ownerDraft, setOwnerDraft] = useState(workspace.owner ?? '')
  const [ownerStatus, setOwnerStatus] = useState('')
  const [patDraft, setPatDraft] = useState('')
  const [patStatus, setPatStatus] = useState('')
  const [ticketingStatus, setTicketingStatus] = useState('')

  // Keeps the owner draft in sync if this workspace's record is refreshed
  // from elsewhere (e.g. a ticketing-system change on the same row calling
  // `onUpdated` with the server's own merged record) — without this, a
  // stale draft could silently overwrite a concurrent change on save.
  useEffect(() => {
    setOwnerDraft(workspace.owner ?? '')
  }, [workspace.owner])

  const hasPatOverride = hasWorkspacePatOverride(workspace.id)
  // Known, low-risk gap (#104 review; re-assessed, not fixed here): this is
  // a *heuristic* ("does this workspace's stored value currently differ
  // from the global default"), not a stored "was this ever explicitly
  // overridden" flag — the workspace registry (#96, unchanged by this
  // ticket) always persists one concrete `ticketingSystem` value, with no
  // distinct "unset, tracks the global default" state. In principle that
  // means this label could drift out from under an untouched workspace if
  // the global default ever changed to a different value later.
  //
  // In practice, today, it can't: `jira` is rejected by validation
  // everywhere a ticketing system can be chosen (globally, per-workspace,
  // and at workspace creation — see workspaceRegistry.js's
  // `assertValidTicketingSystem` and this file's own `TICKETING_SYSTEMS`
  // enum), so `defaultTicketingSystem.value` and every workspace's
  // `ticketingSystem` can only ever be `'azure-devops'` — there is no
  // reachable state where the two sides of this comparison differ. This
  // only becomes a real, visible misreporting risk once genuine Jira
  // support ships (explicitly out of scope for this ticket, per spec #95's
  // own "Out of Scope" list) and a real fix (an explicit override flag on
  // the workspace record, intersecting the already-closed #96 ticket's
  // schema) is worth building then, against real second-system
  // requirements, rather than speculatively now.
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

function WorkspacesTab() {
  const [workspaces, setWorkspaces] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadWorkspaces()
      .then((list) => {
        if (!cancelled) setWorkspaces(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function handleUpdated(updated) {
    setWorkspaces((current) => (current ?? []).map((w) => (w.id === updated.id ? updated : w)))
  }

  return html`
    <section class="settings-section">
      <h2>Workspaces</h2>
      <p class="guidance">
        Every registered workspace (an Azure DevOps repo) — its owner, repo URL, and any PAT or ticketing-system
        override away from the Global Defaults tab's values.
      </p>
      ${error ? html`<p class="load-error">Failed to load workspaces: ${error}</p>` : null}
      ${!error && workspaces === null ? html`<p class="loading">Loading…</p>` : null}
      ${!error && workspaces !== null && workspaces.length === 0
        ? html`<p class="workspace-empty">No workspaces registered yet.</p>`
        : null}
      ${!error && workspaces !== null && workspaces.length > 0
        ? html`
            <div class="workspace-list">
              ${workspaces.map((w) => html`<${WorkspaceRow} key=${w.id} workspace=${w} onUpdated=${handleUpdated} />`)}
            </div>
          `
        : null}
    </section>
  `
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState(TABS[0].id)

  return html`
    <${SettingsHeader} />
    <main class="settings-page">
      <${SettingsTabs} activeTab=${activeTab} onSelect=${setActiveTab} />
      ${activeTab === 'global-defaults' ? html`<${GlobalDefaultsTab} />` : null}
      ${activeTab === 'workspaces' ? html`<${WorkspacesTab} />` : null}
    </main>
  `
}
