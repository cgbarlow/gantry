// Settings screens (#107): three separate, tab-free top-level routes — `/settings` (Global Settings), `/settings/workspace` (Workspace Settings, scoped to one instance's own workspace) and `/settings/instance` (Instance Settings, new) — replacing #101/#104's single tabbed `/settings` shell (Global Defaults tab + a Workspace overrides tab listing every registered workspace). That tabbed shell is gone entirely, not merely hidden: no Settings screen has tabs any more, and there is no longer any screen that lists every workspace at once — Workspace Settings shows only the one workspace behind whichever instance it was opened for.
//
// Every screen here takes an explicit `from` query param (the path Settings was actually opened from) and its back control returns there — never via browser history — falling back to Home (`/`) when `from` is absent (a direct/bookmarked URL). `preact-iso` hands a matched route's query string straight through as a `query` prop (see its own `exec`/`Router`), so every page component below reads `query.from`/`query.slug` directly rather than re-parsing `location.search` itself.
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { theme, cycleTheme } from '../lib/theme.js'
import {
  pat,
  clearPat,
  requestPat,
  hasWorkspacePatOverride,
  credentialStatusForWorkspace,
  setWorkspacePatOverride,
  clearWorkspacePatOverride,
} from '../lib/credential.js'
import { TICKETING_SYSTEMS, defaultTicketingSystem, setDefaultTicketingSystem } from '../lib/ticketingSystem.js'
import { advancedMode, setAdvancedMode } from '../lib/advancedMode.js'
import { apiFetch, apiFetchForInstance } from '../lib/apiFetch.js'
import { IdentityPicker } from '../lib/identityPicker.js'
// #303 — the local-workspace-aware branches of Workspace/Instance Settings
// below (ADR-0029, WI #293/A2's client-side registry). Aliased to `Local`
// names for the same reason web/app.js's own local-instance wiring does:
// keeps them visually distinct from this file's existing server-backed
// `fetch*`/`patch*` helpers below.
import {
  getWorkspaceHandle,
  ensurePermission,
  forgetWorkspace,
  readTextFile as readLocalTextFile,
  writeTextFile as writeLocalTextFile,
  parseWorkspaceJson,
} from '../lib/localWorkspace.js'
import { parseInstanceYaml, withInstanceAssignee } from '../lib/localInstanceFiles.js'

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
// The exact same PAT-management and default-ticketing-system content #101's old Global Defaults tab held — moved here wholesale, now the entire screen rather than one tab among others. Reached directly (no intermediate step) from Home, and via the instance screen's Settings dropdown.
//
// The default PAT this section manages is the exact same one web/lib/credential.js already held (and web/app.js's per-instance editor header used to expose) — moved here wholesale, not reimplemented. A third state this section adds beyond "replace"/"clear" (which assumed a PAT already existed): a first-time "Set" action, since this is now the *only* place a PAT can be entered ahead of any 401 ever prompting for one.
function GlobalPatSection() {
  const patStatus = credentialStatusForWorkspace()
  return html`
    <section class="settings-section">
      <h2>Azure DevOps Personal Access Token</h2>
      <p class="guidance">
        Used for every Azure-DevOps-backed instance this gantry server serves. Stored only in this browser and sent
        solely to your own gantry server — needs <strong>Code (Read &amp; write)</strong>,
        <strong>Work Items (Read &amp; write)</strong>, and <strong>Identity (Read)</strong> scope.
      </p>
      <div class="settings-pat-status">
        ${patStatus === 'rejected'
          ? html`<span class="stamp review">REJECTED</span>`
          : patStatus === 'set'
            ? html`<span class="stamp agreed">SET</span>`
            : html`<span class="stamp draft">NOT SET</span>`}
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

// #300 — a client-only, sticky toggle. Off by default: a local-only user never sees the Azure
// DevOps PAT section or the default-ticketing-system selector below it. On: this screen is
// exactly as it always was. Later tickets (#301/#302) read the same signal to hide ticketing UI
// on other surfaces; this screen is the only place the setting is changed.
function AdvancedModeSection() {
  return html`
    <section class="settings-section">
      <h2>Advanced mode</h2>
      <label class="settings-checkbox">
        <input
          type="checkbox"
          checked=${advancedMode.value}
          onChange=${(e) => setAdvancedMode(e.currentTarget.checked)}
        />
        Enable advanced mode
      </label>
      <p class="guidance">
        Shows Azure DevOps repositories, work-item ticketing, and sign-off. Leave off for local-only use.
      </p>
    </section>
  `
}

export function GlobalSettingsPage({ query }) {
  return html`
    <${SettingsHeader} title="Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      <${AdvancedModeSection} />
      ${advancedMode.value ? html`<${GlobalPatSection} />` : null}
      ${advancedMode.value ? html`<${TicketingSystemSection} />` : null}
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
  // `?archived=1` so an already-archived workspace is still found here — otherwise its own
  // Workspace Settings screen couldn't offer "Restore" (#223).
  const res = await apiFetch('/api/workspaces?archived=1')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to load workspaces (${res.status})`)
  }
  return body.find((w) => w.id === workspaceId) ?? null
}

// #223 — archive / restore. Both are plain registry-metadata writes: no PAT, no Azure DevOps
// round-trip, identical for a local and a Workspace-backed instance. The server is idempotent, so
// a double-click can't error; a 409 from the workspace-archive route means the workspace still has
// active instances (its message names them).
async function postArchiveAction(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(parsed.message ?? parsed.error ?? `Request failed (${res.status})`)
  }
  return parsed
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

// The standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape — the reverse of web/lib/validateRepo.js's `parseRepoUrl` — with `baseUrl` (an on-premises Azure DevOps Server location) substituted in place of `https://dev.azure.com` when a workspace carries one.
export function workspaceRepoUrl(workspace) {
  const base = workspace.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(workspace.organization)}/${encodeURIComponent(workspace.project)}/_git/${encodeURIComponent(workspace.repository)}`
}

// One workspace's editable fields: owner (server-persisted, identity-picker), a PAT override (client-only, never touches the server), and a ticketing-system override (server-persisted) — the same three fields #104's old Workspace overrides tab exposed per row, now rendered for exactly one workspace (the instance's own) rather than one row per registered workspace. The owner field is now an identity picker (#145 Part 2).
function WorkspaceEditor({ workspace, onUpdated, slug }) {
  const [ownerDraft, setOwnerDraft] = useState(workspace.owner ?? '')
  const [ownerStatus, setOwnerStatus] = useState('')
  const [patDraft, setPatDraft] = useState('')
  const [patStatus, setPatStatus] = useState('')
  const [ticketingStatus, setTicketingStatus] = useState('')
  // A ref tracking the latest owner value — used by handleSaveOwner to read
  // the value that was set via IdentityPicker's onChange (which may not have
  // committed to state yet when the Save button is clicked immediately after
  // a .fill() + blur).
  const latestOwnerRef = useRef(workspace.owner ?? '')

  // Keeps the owner draft in sync if this workspace's record is refreshed from elsewhere (e.g. a ticketing-system change on the same row calling `onUpdated` with the server's own merged record) — without this, a stale draft could silently overwrite a concurrent change on save.
  useEffect(() => {
    setOwnerDraft(workspace.owner ?? '')
    latestOwnerRef.current = workspace.owner ?? ''
  }, [workspace.owner])

  const hasPatOverride = hasWorkspacePatOverride(workspace.id)
  const effectivePatStatus = credentialStatusForWorkspace(workspace.id)
  // Known, low-risk gap (#104 review; re-assessed, not fixed here): this is a *heuristic* ("does this workspace's stored value currently differ from the global default"), not a stored "was this ever explicitly overridden" flag — the workspace registry (#96, unchanged by this ticket) always persists one concrete `ticketingSystem` value, with no distinct "unset, tracks the global default" state. In principle that means this label could drift out from under an untouched workspace if the global default ever changed to a different value later.
  //
  // In practice, today, it can't: `jira` is rejected by validation everywhere a ticketing system can be chosen (globally, per-workspace, and at workspace creation — see workspaceRegistry.js's `assertValidTicketingSystem` and this file's own `TICKETING_SYSTEMS` enum), so `defaultTicketingSystem.value` and every workspace's `ticketingSystem` can only ever be `'azure-devops'` — there is no reachable state where the two sides of this comparison differ. This only becomes a real, visible misreporting risk once genuine Jira support ships (explicitly out of scope for this ticket, per spec #95's own "Out of Scope" list) and a real fix (an explicit override flag on the workspace record, intersecting the already-closed #96 ticket's schema) is worth building then, against real second-system requirements, rather than speculatively now.
  const hasTicketingOverride = workspace.ticketingSystem !== defaultTicketingSystem.value

  async function handleSaveOwner() {
    const valueToSave = latestOwnerRef.current
    setOwnerStatus('Saving\u2026')
    try {
      const updated = await patchWorkspace(workspace.id, { owner: valueToSave })
      onUpdated(updated)
      setOwnerStatus('Saved.')
    } catch (err) {
      setOwnerStatus(err.message)
    }
  }

  function handleSetPatOverride() {
    setWorkspacePatOverride(workspace.id, patDraft)
    setPatDraft('')
    setPatStatus('Override saved \u2014 used for this workspace\u2019s instances from now on.')
  }

  function handleClearPatOverride() {
    clearWorkspacePatOverride(workspace.id)
    setPatStatus('Override cleared \u2014 falling back to the global default.')
  }

  async function handleTicketingChange(systemId) {
    setTicketingStatus('Saving\u2026')
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
          <${IdentityPicker}
            value=${ownerDraft}
            onChange=${(uniqueName) => {
              setOwnerDraft(uniqueName)
              latestOwnerRef.current = uniqueName
              // Auto-commit on selection
              handleSaveOwner()
            }}
            placeholder="Unset"
            slug=${slug}
          />
          <button type="button" class="btn small" onClick=${handleSaveOwner}>Save owner</button>
        </div>
        <div class="workspace-field-status">${ownerStatus}</div>
      </div>

      <div class="workspace-field workspace-pat">
        <label>Azure DevOps PAT override</label>
        <div class="workspace-pat-status">
          ${effectivePatStatus === 'rejected'
            ? html`<span class="stamp review">${hasPatOverride ? 'OVERRIDE REJECTED' : 'GLOBAL DEFAULT REJECTED'}</span>`
            : effectivePatStatus === 'missing'
              ? html`<span class="stamp draft">NO GLOBAL DEFAULT</span>`
              : hasPatOverride
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

// #223 — archive / restore this workspace. Archiving only removes it from the default dashboard;
// nothing is deleted and Restore brings it back to exactly its prior state. Archiving is blocked
// server-side while the workspace still has active (non-archived) instances — that 409's message
// (which names them) is surfaced here verbatim.
function WorkspaceArchiveSection({ workspace, onChanged }) {
  const [archived, setArchived] = useState(Boolean(workspace.archived))
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setArchived(Boolean(workspace.archived))
  }, [workspace.archived])

  async function run(action) {
    if (busy) return
    if (action === 'archive' && !window.confirm(`Archive this workspace? It will be hidden from the dashboard until restored. Nothing is deleted.`)) {
      return
    }
    setBusy(true)
    setStatus(action === 'archive' ? 'Archiving…' : 'Restoring…')
    try {
      await postArchiveAction(`/api/workspace/${action}`, { workspaceId: workspace.id })
      setArchived(action === 'archive')
      setStatus(action === 'archive' ? 'Archived.' : 'Restored.')
      onChanged?.(action === 'archive')
    } catch (err) {
      setStatus(err.message)
    } finally {
      setBusy(false)
    }
  }

  return html`
    <section class="settings-section">
      <h2>Archive</h2>
      <p class="guidance">
        Archiving removes this workspace from the dashboard and the default listing — its data on disk is
        retained, and Restore brings it back exactly as it was. A workspace with active (non-archived)
        instances can't be archived until those are archived or restored first.
      </p>
      <div class="settings-pat-status">
        ${archived ? html`<span class="stamp review">ARCHIVED</span>` : html`<span class="stamp agreed">ACTIVE</span>`}
      </div>
      <div class="settings-actions">
        ${archived
          ? html`<button type="button" class="btn primary" disabled=${busy} onClick=${() => run('restore')}>Restore workspace</button>`
          : html`<button type="button" class="btn" disabled=${busy} onClick=${() => run('archive')}>Archive workspace</button>`}
      </div>
      <div class="workspace-field-status">${status}</div>
    </section>
  `
}

// #303 — a local-workspace instance's "Workspace Settings" equivalent. There
// is no server-side workspace record to fetch (ADR-0029: the registry lives
// client-side in IndexedDB) — this branch never calls fetchInstanceWorkspaceId
// /fetchWorkspaceById at all, resolving the directory handle by its IndexedDB
// id (`local=`, threaded on by web/app.js's SettingsMenu) instead. What's
// genuinely configurable today: the `workspace.json` fields the wizard wrote
// at creation (name/owner/createdAt, read-only — nothing writes them back
// after creation) and the dashboard's own "Remove"/"Grant access" recovery
// affordances (web/app.js's LocalWorkspaceRow), reused here rather than
// reinvented — never a PAT or ticketing-system override, which don't apply
// to a workspace with no Azure DevOps repo behind it at all.
function LocalWorkspaceSettingsPage({ query, workspaceId }) {
  const [state, setState] = useState('loading') // 'loading' | 'missing' | 'grant-needed' | 'ready' | 'error'
  const [handle, setHandle] = useState(null)
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  const [forgotten, setForgotten] = useState(false)
  const [busy, setBusy] = useState(false)

  async function load() {
    setState('loading')
    try {
      const h = await getWorkspaceHandle(workspaceId)
      if (!h) {
        setState('missing')
        return
      }
      setHandle(h)
      const permission = await ensurePermission(h)
      if (permission !== 'granted') {
        setState('grant-needed')
        return
      }
      const text = await readLocalTextFile(h, 'gantry-workspace/workspace.json')
      setRecord(parseWorkspaceJson(text))
      setState('ready')
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line
  }, [workspaceId])

  async function handleGrantAccess() {
    if (!handle) return
    setBusy(true)
    try {
      const permission = await ensurePermission(handle)
      if (permission === 'granted') await load()
    } finally {
      setBusy(false)
    }
  }

  async function handleForget() {
    if (
      !window.confirm(
        "Remove this workspace from this browser's remembered list? The folder and its files on disk are untouched — this only forgets it here."
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await forgetWorkspace(workspaceId)
      setForgotten(true)
    } finally {
      setBusy(false)
    }
  }

  return html`
    <${SettingsHeader} title="Workspace Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      <section class="settings-section">
        <h2>Local workspace</h2>
        <p class="guidance">
          This instance's local workspace — a folder on this browser's own machine (ADR-0029), not a
          server-side workspace record. Its <code>workspace.json</code>, read straight from the folder, is
          shown below; there is no PAT or ticketing-system override here — a local workspace has no Azure
          DevOps repo behind it at all.
        </p>
        ${state === 'loading' ? html`<p class="loading">Loading…</p>` : null}
        ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
        ${state === 'missing'
          ? html`<p class="load-error">
              This local workspace is no longer remembered in this browser — reopen it from the "+ New
              Workspace" wizard.
            </p>`
          : null}
        ${state === 'grant-needed'
          ? html`
              <p class="inline-error">This local workspace needs permission again in this browser.</p>
              <button type="button" class="btn primary" disabled=${busy} onClick=${handleGrantAccess}>
                Grant access
              </button>
            `
          : null}
        ${state === 'ready' && !forgotten
          ? html`
              <div class="result-card">
                <div class="result-row"><span class="k">Name</span><span class="v">${record.name}</span></div>
                <div class="result-row"><span class="k">Owner</span><span class="v">${record.owner || '—'}</span></div>
                <div class="result-row"><span class="k">Created</span><span class="v">${record.createdAt}</span></div>
              </div>
            `
          : null}
      </section>
      ${state === 'ready'
        ? html`
            <section class="settings-section">
              <h2>Remove from this browser</h2>
              <p class="guidance">
                Removes this workspace from this browser's remembered list only — the folder and its files on
                disk are untouched. Reopen the same folder later from the "+ New Workspace" wizard's "Pick
                existing local workspace" option.
              </p>
              ${forgotten
                ? html`<p class="save-status">Removed from this browser.</p>`
                : html`<div class="settings-actions">
                    <button type="button" class="btn" disabled=${busy} onClick=${handleForget}>
                      Remove workspace
                    </button>
                  </div>`}
            </section>
          `
        : null}
    </main>
  `
}

// #303 — a local-workspace instance's link (web/app.js's SettingsMenu)
// carries `local=<IndexedDB id>`; this dispatches to the local-workspace-aware
// screen above before any of RemoteWorkspaceSettingsPage's server-side
// registry fetches would otherwise run. Deliberately hook-free itself — a
// component that returns early *between* its own hook calls breaks Preact's
// per-instance hook ordering the moment the branch it takes changes, so the
// branching lives here, one level up from either hook-using body.
export function WorkspaceSettingsPage({ query }) {
  if (query?.local) {
    return html`<${LocalWorkspaceSettingsPage} query=${query} workspaceId=${query.local} />`
  }
  return html`<${RemoteWorkspaceSettingsPage} query=${query} />`
}

function RemoteWorkspaceSettingsPage({ query }) {
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
        ${state === 'loading' ? html`<p class="loading">Loading\u2026</p>` : null}
        ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
        ${state === 'no-workspace'
          ? html`<p class="workspace-empty">This instance has no Azure DevOps workspace — its data is stored locally.</p>`
          : null}
        ${state === 'ready'
          ? html`
              <div class="workspace-list">
                <${WorkspaceEditor} workspace=${workspace} onUpdated=${setWorkspace} slug=${slug} />
              </div>
            `
          : null}
      </section>
      ${state === 'ready'
        ? html`<${WorkspaceArchiveSection}
            workspace=${workspace}
            onChanged=${(isArchived) => setWorkspace({ ...workspace, archived: isArchived || undefined })}
          />`
        : null}
    </main>
  `
}

// ---------- Instance Settings (`/settings/instance?slug=<instance-slug>`) ----------
// New (#107): hosts the instance's Assignee (editable, identity picker), per-instance
// required-reviewer override (#145 Part 2), read-only instance info, and the instance's
// own Azure DevOps work-item link details (read-only — re-linking isn't supported here at
// all; linking only ever happens at instance creation, via the "+ New Workspace" wizard's
// work-item step, and the parent work item itself is linked from the module editor's own
// "Work item details" card, see web/app.js's SyncedFieldsPanel, #171).

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

async function saveRequiredReviewer(slug, requiredReviewer) {
  const res = await apiFetchForInstance(slug, `/api/instance/required-reviewer?slug=${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requiredReviewer }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to save required reviewer (${res.status})`)
  }
  return body
}

// The instance's own stored Assignee — editable here, distinct from a
// module's own frontmatter `owner` (the Design Authority sign-off
// convention, untouched by this screen).
function AssigneeSection({ slug, assignee }) {
  const [draft, setDraft] = useState(assignee ?? '')
  const [status, setStatus] = useState('')
  const savingRef = useRef(false)
  const latestDraftRef = useRef(assignee ?? '')

  useEffect(() => {
    setDraft(assignee ?? '')
    latestDraftRef.current = assignee ?? ''
  }, [assignee])

  async function handleSave() {
    const valueToSave = latestDraftRef.current
    if (valueToSave === (assignee ?? '')) return
    if (savingRef.current) return
    savingRef.current = true
    setStatus('Saving\u2026')
    try {
      await saveAssignee(slug, valueToSave)
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
        <${IdentityPicker}
          value=${draft}
          onChange=${(uniqueName) => {
            setDraft(uniqueName)
            latestDraftRef.current = uniqueName
            // Auto-commit on selection
            handleSave()
          }}
          placeholder="Unassigned"
          slug=${slug}
        />
        <button type="button" class="btn small" onClick=${handleSave}>Save</button>
      </div>
      <div class="workspace-field-status">${status}</div>
    </section>
  `
}

// (#145 Part 2) Per-instance required-reviewer override — when set, this
// person must approve the Pull Request opened by "Request Approval". Falls
// back to the workspace Owner when blank (displayed as guidance). Cleared
// by emptying the field. The effective reviewer is resolved at PR-open time
// in lib/stageApproval.js, so a stale or blank value here is caught then
// with a clear error message, not silently ignored.
function RequiredReviewerSection({ slug, requiredReviewer }) {
  const [draft, setDraft] = useState(requiredReviewer ?? '')
  const [status, setStatus] = useState('')
  const savingRef = useRef(false)
  const latestDraftRef = useRef(requiredReviewer ?? '')

  useEffect(() => {
    setDraft(requiredReviewer ?? '')
    latestDraftRef.current = requiredReviewer ?? ''
  }, [requiredReviewer])

  async function handleSave() {
    const valueToSave = latestDraftRef.current
    if (valueToSave === (requiredReviewer ?? '')) return
    if (savingRef.current) return
    savingRef.current = true
    setStatus('Saving\u2026')
    try {
      await saveRequiredReviewer(slug, valueToSave)
      setStatus('Saved.')
    } catch (err) {
      setStatus(err.message)
    } finally {
      savingRef.current = false
    }
  }

  return html`
    <section class="settings-section">
      <h2>Required reviewer</h2>
      <p class="guidance">
        When set, this person must approve the Pull Request opened by "Request Approval". Leave blank to
        fall back to the workspace Owner. The reviewer is resolved when the Pull Request is opened — if
        the person has left the organization, approval will be blocked with a clear error message.
      </p>
      <div class="workspace-field-row">
        <${IdentityPicker}
          value=${draft}
          onChange=${(uniqueName) => {
            setDraft(uniqueName)
            latestDraftRef.current = uniqueName
            // Auto-commit on selection — empty string clears the override
            handleSave()
          }}
          placeholder=${'Falls back to workspace Owner'}
          slug=${slug}
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
                    <span class="v">${workItem.stages?.[stage.id] ? `#${workItem.stages[stage.id]}` : '\u2014'}</span>
                  </div>
                `
              )}
            </div>
            <p class="guidance">Re-linking isn't supported here — this is a read-only view of the existing link.</p>
          `}
    </section>
  `
}

// #223 — archive / restore this instance. Same contract as the workspace section: archiving only
// hides it from the dashboard, its data (local files or its Azure DevOps repo) is retained, and
// Restore brings it back to exactly its prior state. Works identically for a local and a
// Workspace-backed instance. An archived instance still opens (read-only) at its direct URL.
function InstanceArchiveSection({ slug, archived: initialArchived }) {
  const [archived, setArchived] = useState(Boolean(initialArchived))
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action) {
    if (busy) return
    if (action === 'archive' && !window.confirm(`Archive "${slug}"? It will be hidden from the dashboard until restored. Nothing is deleted.`)) {
      return
    }
    setBusy(true)
    setStatus(action === 'archive' ? 'Archiving…' : 'Restoring…')
    try {
      await postArchiveAction(`/api/instance/${action}`, { slug })
      setArchived(action === 'archive')
      setStatus(action === 'archive' ? 'Archived.' : 'Restored.')
    } catch (err) {
      setStatus(err.message)
    } finally {
      setBusy(false)
    }
  }

  return html`
    <section class="settings-section">
      <h2>Archive</h2>
      <p class="guidance">
        Archiving removes this instance from the dashboard and the default listing — its data is retained,
        and Restore brings it back exactly as it was. The instance still opens read-only at its direct link
        while archived.
      </p>
      <div class="settings-pat-status">
        ${archived ? html`<span class="stamp review">ARCHIVED</span>` : html`<span class="stamp agreed">ACTIVE</span>`}
      </div>
      <div class="settings-actions">
        ${archived
          ? html`<button type="button" class="btn primary" disabled=${busy} onClick=${() => run('restore')}>Restore instance</button>`
          : html`<button type="button" class="btn" disabled=${busy} onClick=${() => run('archive')}>Archive instance</button>`}
      </div>
      <div class="workspace-field-status">${status}</div>
    </section>
  `
}

// #303 — a local-workspace instance's "Instance Settings" equivalent. There
// is no `GET /api/instance` to call (that route resolves the instance
// through the server-side registry, per-request — lib/server.js's own doc
// comment — which a local-workspace instance was never entered into,
// ADR-0029). What's genuinely stored and editable today, per
// `web/lib/localInstanceFiles.js`'s `instance.yaml` schema: `assignee`. No
// required-reviewer override (no PR/review ceremony for a local workspace
// at all, ADR-0029's own "Ticketing" section), no work-item link section
// (same reason), no archive action (nothing server-side to flip a flag on).
// The Assignee field here is a plain text input, not the Azure-DevOps-backed
// `IdentityPicker` the server-backed screen below uses — a local workspace
// has no Azure DevOps organization/project to search identities against, so
// an autocomplete would either search the wrong org (whichever workspace
// happens to be registered first server-side) or nothing at all; a plain
// field matches exactly what's stored (a free-text name) and is honest
// about there being no such lookup available for it.
function LocalInstanceSettingsPage({ query, workspaceId, slug }) {
  const [state, setState] = useState('loading') // 'loading' | 'missing' | 'grant-needed' | 'ready' | 'error'
  const [handle, setHandle] = useState(null)
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  const [assigneeDraft, setAssigneeDraft] = useState('')
  const [assigneeStatus, setAssigneeStatus] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setState('loading')
    try {
      const h = await getWorkspaceHandle(workspaceId)
      if (!h) {
        setState('missing')
        return
      }
      setHandle(h)
      const permission = await ensurePermission(h)
      if (permission !== 'granted') {
        setState('grant-needed')
        return
      }
      const text = await readLocalTextFile(h, `gantry-workspace/${slug}/instance.yaml`)
      const rec = parseInstanceYaml(text)
      setRecord(rec)
      setAssigneeDraft(rec.assignee ?? '')
      setState('ready')
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }

  useEffect(() => {
    if (!slug) {
      setState('error')
      setError('No instance was specified for these Instance Settings.')
      return
    }
    load()
    // eslint-disable-next-line
  }, [workspaceId, slug])

  async function handleGrantAccess() {
    if (!handle) return
    setBusy(true)
    try {
      const permission = await ensurePermission(handle)
      if (permission === 'granted') await load()
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveAssignee() {
    if (!handle || !record) return
    setAssigneeStatus('Saving…')
    try {
      await writeLocalTextFile(
        handle,
        `gantry-workspace/${slug}/instance.yaml`,
        withInstanceAssignee(record, assigneeDraft)
      )
      setRecord({ ...record, assignee: assigneeDraft })
      setAssigneeStatus('Saved.')
    } catch (err) {
      setAssigneeStatus(err.message)
    }
  }

  return html`
    <${SettingsHeader} title="Instance Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      ${state === 'loading' ? html`<p class="loading">Loading…</p>` : null}
      ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
      ${state === 'missing'
        ? html`<p class="load-error">
            This local workspace is no longer remembered in this browser — reopen it from the "+ New
            Workspace" wizard.
          </p>`
        : null}
      ${state === 'grant-needed'
        ? html`
            <div class="wizard-field">
              <p class="inline-error">This local workspace needs permission again in this browser.</p>
              <button type="button" class="btn primary" disabled=${busy} onClick=${handleGrantAccess}>
                Grant access
              </button>
            </div>
          `
        : null}
      ${state === 'ready'
        ? html`
            <section class="settings-section">
              <h2>Assignee</h2>
              <p class="guidance">
                The single named person responsible for this instance, stored in this workspace's own
                <code>instance.yaml</code>.
              </p>
              <div class="workspace-field-row">
                <input
                  class="wizard-input"
                  type="text"
                  value=${assigneeDraft}
                  placeholder="Unassigned"
                  onInput=${(e) => setAssigneeDraft(e.currentTarget.value)}
                />
                <button type="button" class="btn small" onClick=${handleSaveAssignee}>Save</button>
              </div>
              <div class="workspace-field-status">${assigneeStatus}</div>
            </section>
            <section class="settings-section">
              <h2>Instance info</h2>
              <div class="result-card">
                <div class="result-row"><span class="k">Slug</span><span class="v">${slug}</span></div>
                <div class="result-row"><span class="k">Definition</span><span class="v">${record.definition}</span></div>
                <div class="result-row"><span class="k">Current stage</span><span class="v">${record.stage}</span></div>
              </div>
            </section>
            <section class="settings-section">
              <h2>Azure DevOps work item</h2>
              <p class="guidance">
                Local workspaces don't support Azure DevOps ticketing (ADR-0029) — no work-item link, no
                sign-off, no Pull Request ceremony. This instance advances self-serve once its current
                stage's gate passes.
              </p>
            </section>
          `
        : null}
    </main>
  `
}

// #303 — dispatches to the local-workspace-aware screen above when this
// instance's link (web/app.js's SettingsMenu) carries `local=<IndexedDB
// id>`, before RemoteInstanceSettingsPage's `GET /api/instance` call would
// otherwise run. Deliberately hook-free itself — see WorkspaceSettingsPage's
// own comment for why the branch has to live one level up from either
// hook-using body.
export function InstanceSettingsPage({ query }) {
  if (query?.local && query?.slug) {
    return html`<${LocalInstanceSettingsPage} query=${query} workspaceId=${query.local} slug=${query.slug} />`
  }
  return html`<${RemoteInstanceSettingsPage} query=${query} />`
}

function RemoteInstanceSettingsPage({ query }) {
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
      ${state === 'loading' ? html`<p class="loading">Loading\u2026</p>` : null}
      ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
      ${state === 'ready'
        ? html`
            <${AssigneeSection} slug=${slug} assignee=${instance.assignee} />
            <${RequiredReviewerSection} slug=${slug} requiredReviewer=${instance.requiredReviewer} />
            <${InstanceInfoSection} instance=${instance} />
            <${WorkItemLinkSection} instance=${instance} />
            <${InstanceArchiveSection} slug=${slug} archived=${instance.archived} />
          `
        : null}
    </main>
  `
}
