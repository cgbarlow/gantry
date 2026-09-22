// Settings screens (#107): three separate, tab-free top-level routes — `/settings` (Global Settings), `/settings/workspace` (Workspace Settings, scoped to one instance's own workspace) and `/settings/instance` (Instance Settings, new) — replacing #101/#104's single tabbed `/settings` shell (Global Defaults tab + a Workspace overrides tab listing every registered workspace). That tabbed shell is gone entirely, not merely hidden: no Settings screen has tabs any more, and there is no longer any screen that lists every workspace at once — Workspace Settings shows only the one workspace behind whichever instance it was opened for.
//
// Every screen here takes an explicit `from` query param (the path Settings was actually opened from) and its back control returns there — never via browser history — falling back to Home (`/`) when `from` is absent (a direct/bookmarked URL). `preact-iso` hands a matched route's query string straight through as a `query` prop (see its own `exec`/`Router`), so every page component below reads `query.from`/`query.slug` directly rather than re-parsing `location.search` itself.
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { theme, cycleTheme } from '../lib/theme.js'
import {
  hasPatForWorkspace,
  credentialStatusForWorkspace,
  setPatForWorkspace,
  clearPatForWorkspace,
} from '../lib/credential.js'
import { advancedMode, setAdvancedMode } from '../lib/advancedMode.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { renderEngine, setRenderEngine } from '../lib/renderEngine.js'
import { pandocWasmState } from '../lib/pandocWasm.js'
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
// #9 (ADR-0038): the old Global Defaults tab's PAT section is gone entirely, not merely hidden — there
// is no global-default PAT any more, and no screen-level control for one. Every workspace's own PAT is
// managed from that workspace's own Workspace Settings screen (`WorkspaceEditor` below) instead.

// #300 — a client-only, sticky toggle. Off by default: a local-only user never sees any Provider's
// PAT section, library repos, or other remote-workspace UI. On: this screen is exactly as it always
// was. Later tickets (#301/#302) read the same signal to hide this UI on other surfaces; this screen
// is the only place the setting is changed.
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
        Shows Provider repositories (Azure DevOps, GitHub, GitLab, Atlassian), work-item ticketing, and
        sign-off. Leave off for local-only use.
      </p>
    </section>
  `
}

// WI314 — WASM Pandoc (default) vs. native server-side Pandoc, for every Render action, both
// local-workspace and Azure-DevOps-hosted. Not gated behind `advancedMode` (unlike the
// PAT/ticketing sections above): rendering is a base gantry feature every user has, whether
// or not they ever touch Azure DevOps ticketing.
//
// The status line is sourced from pandocWasm.js's own live `pandocWasmState` signal — never a
// static "WASM enabled" claim — so it always reflects what a render right now would actually
// do. The one state this section is careful to spell out rather than just label "unavailable":
// WASM selected but not ready yet means renders are *currently* falling through to native,
// not that they're broken — the render itself always succeeds either way (renderEngine.js's
// own doc comment; web/app.js's Render action).
function RenderEngineSection() {
  const engine = renderEngine.value
  const wasmState = pandocWasmState.value

  let statusText
  let statusStamp
  if (wasmState === 'ready') {
    statusText = 'Pandoc WASM: ready.'
    statusStamp = 'agreed'
  } else if (wasmState === 'loading') {
    statusText =
      engine === 'wasm'
        ? 'Pandoc WASM: loading… renders will use native Pandoc until this finishes.'
        : 'Pandoc WASM: loading…'
    statusStamp = 'draft'
  } else {
    statusText =
      engine === 'wasm'
        ? 'Pandoc WASM: unavailable — renders are currently using native Pandoc instead.'
        : 'Pandoc WASM: unavailable.'
    statusStamp = 'review'
  }

  return html`
    <section class="settings-section">
      <h2>Render engine</h2>
      <p class="guidance">
        Which Pandoc converts a Render action's Markdown into a <code>.docx</code> — WASM Pandoc
        runs entirely in this browser (no server round-trip for the conversion itself); native Pandoc
        runs server-side, exactly as gantry always has. Both produce the same reference-doc styling.
      </p>
      <div class="settings-radio-group" role="radiogroup" aria-label="Render engine">
        <label class="settings-radio">
          <input
            type="radio"
            name="render-engine"
            value="wasm"
            checked=${engine === 'wasm'}
            onChange=${() => setRenderEngine('wasm')}
          />
          WASM Pandoc (default)
        </label>
        <label class="settings-radio">
          <input
            type="radio"
            name="render-engine"
            value="native"
            checked=${engine === 'native'}
            onChange=${() => setRenderEngine('native')}
          />
          Native Pandoc
        </label>
      </div>
      <div class="settings-render-engine-status">
        <span class=${'stamp ' + statusStamp}>${statusText}</span>
      </div>
    </section>
  `
}

// WI #386 (Feature #380 phase 6, ADR-0036) — the server library's list of library repos: any
// number of Azure DevOps repos, read (with the server's own PAT — `GANTRY_LIBRARY_PAT`, never this
// browser's own) and cached, unioned into the server library the Definitions page shows. Adding one
// here triggers an immediate best-effort read (ADR-0036: "re-read ... when a repo is added"); the
// Definitions page's own Refresh button re-reads every configured repo on demand thereafter. Gated
// behind advancedMode alongside the other Azure-DevOps-specific sections above — a local-only user
// never sees this.
// #19/#27/#49 (ADR-0037, ADR-0041, ADR-0042): the location fields collected change with the Provider
// picked, the same "Provider drives which fields appear" convention the "+ New Workspace" wizard uses
// — Azure DevOps needs Organization/Project/Repository, GitHub only Owner/Repository, GitLab only
// Namespace/Project (stored as `location.repository`, ADR-0041's own "wizard labels it Project;
// only the internal key is neutral"), Atlassian (Bitbucket Cloud) needs Bitbucket Account + Repository
// plus Jira Site + Jira Project (ADR-0042's own full four-field location — a library repo's location
// is unchanged from a workspace's; only its *credential* is Bitbucket-only, see this file's own
// `handleAdd`). "Bitbucket Account", never "Bitbucket Workspace" — ADR-0042's own resolved
// terminology collision with gantry's own Workspace concept.
const LIBRARY_REPO_PROVIDERS = [
  { id: 'azure-devops', label: 'Azure DevOps' },
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'atlassian', label: 'Atlassian (Bitbucket)' },
]

function LibraryReposSection() {
  const [repos, setRepos] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [provider, setProvider] = useState('azure-devops')
  const [organization, setOrganization] = useState('')
  const [project, setProject] = useState('')
  const [owner, setOwner] = useState('')
  const [namespace, setNamespace] = useState('')
  const [repository, setRepository] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [jiraSite, setJiraSite] = useState('')
  const [jiraProjectKey, setJiraProjectKey] = useState('')
  const [codeOwner, setCodeOwner] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState(null)
  const [addStatus, setAddStatus] = useState('')
  const [ownerEdits, setOwnerEdits] = useState({}) // { [repoId]: string } — in-progress edits, keyed by repo
  const [savingOwner, setSavingOwner] = useState(null) // repoId currently saving, or null

  function load() {
    fetch('/api/library-repos')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error ?? `Failed to load library repos (${res.status})`)
        return body
      })
      .then((body) => {
        setRepos(body.repos ?? [])
        setLoadError(null)
      })
      .catch((err) => setLoadError(err.message))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleAdd() {
    if (provider === 'github') {
      if (!owner.trim() || !repository.trim()) {
        setAddError('Owner and repository are both required.')
        return
      }
    } else if (provider === 'gitlab') {
      if (!namespace.trim() || !repository.trim()) {
        setAddError('Namespace and project are both required.')
        return
      }
    } else if (provider === 'atlassian') {
      if (!owner.trim() || !repository.trim() || !jiraSite.trim() || !jiraProjectKey.trim()) {
        setAddError('Bitbucket account, repository, Jira site and Jira project are all required.')
        return
      }
    } else if (!organization.trim() || !project.trim() || !repository.trim()) {
      setAddError('Organization, project and repository are all required.')
      return
    }
    setAdding(true)
    setAddError(null)
    setAddStatus('')
    try {
      const location =
        provider === 'github'
          ? { owner: owner.trim(), repository: repository.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }
          : provider === 'gitlab'
            ? { namespace: namespace.trim(), repository: repository.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }
            : provider === 'atlassian'
              ? { owner: owner.trim(), repository: repository.trim(), jiraSite: jiraSite.trim(), jiraProjectKey: jiraProjectKey.trim() }
              : { organization: organization.trim(), project: project.trim(), repository: repository.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }
      const res = await fetch('/api/library-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, location, ...(codeOwner.trim() ? { codeOwner: codeOwner.trim() } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAddError(body.error ?? `Failed to add library repo (${res.status})`)
        return
      }
      setOrganization('')
      setProject('')
      setOwner('')
      setNamespace('')
      setRepository('')
      setBaseUrl('')
      setJiraSite('')
      setJiraProjectKey('')
      setCodeOwner('')
      setAddStatus(body.refresh?.ok ? `Added — ${body.refresh.definitionCount} definition${body.refresh.definitionCount === 1 ? '' : 's'} found.` : `Added — ${body.refresh?.error ?? 'could not be read yet; try Refresh on the Definitions page.'}`)
      load()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  // WI #387 (Feature #380 phase 7, ADR-0036's Promote section): a repo's code owner is the identity
  // Promote attaches as a required reviewer on every Pull Request it opens against this repo —
  // editable in place after the repo is added (unlike organization/project/repository/baseUrl, see
  // `lib/librarySettings.js`'s `updateLibraryRepoCodeOwner` doc comment).
  async function handleSaveOwner(repoId) {
    setSavingOwner(repoId)
    try {
      const res = await fetch(`/api/library-repos/${encodeURIComponent(repoId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeOwner: ownerEdits[repoId] ?? '' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Failed to save code owner (${res.status})`)
      }
      setOwnerEdits((prev) => {
        const next = { ...prev }
        delete next[repoId]
        return next
      })
      load()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setSavingOwner(null)
    }
  }

  return html`
    <section class="settings-section">
      <h2>Library repos</h2>
      <p class="guidance">
        Azure DevOps, GitHub, GitLab or Atlassian (Bitbucket) repos read as additional sources for the
        server library, alongside the packaged <code>definitions/</code> directory — read-only in the
        editor (viewable, copyable-from, clonable into a workspace), read with this server's own PAT —
        one per Provider (<code>GANTRY_LIBRARY_PAT_AZURE_DEVOPS</code> /
        <code>GANTRY_LIBRARY_PAT_GITHUB</code> / <code>GANTRY_LIBRARY_PAT_GITLAB</code> /
        <code>GANTRY_LIBRARY_PAT_ATLASSIAN</code>, the first also honouring the deprecated
        <code>GANTRY_LIBRARY_PAT</code>) — cached on disk. An Atlassian library repo's one PAT is its
        Bitbucket token only; it never touches Jira, and no Jira credential is ever requested for it
        (ADR-0042 — Promote and reading <code>definitions/</code> are both content-store-only
        operations). Re-read at server startup, when a repo is added below, and on the Definitions
        page's Refresh button — never polled.
      </p>
      ${loadError ? html`<p class="load-error">${loadError}</p>` : null}
      ${repos === null && !loadError ? html`<p class="loading">Loading…</p>` : null}
      ${repos?.length
        ? html`
            <div class="result-card">
              ${repos.map(
                (repo) => html`
                  <div class="result-row" key=${repo.id}>
                    <span class="k"
                      >${repo.provider === 'github'
                        ? 'GitHub'
                        : repo.provider === 'gitlab'
                          ? 'GitLab'
                          : repo.provider === 'atlassian'
                            ? 'Atlassian (Bitbucket)'
                            : 'Azure DevOps'}:
                      ${repo.provider === 'github'
                        ? `${repo.location.owner}/${repo.location.repository}`
                        : repo.provider === 'gitlab'
                          ? `${repo.location.namespace}/${repo.location.repository}`
                          : repo.provider === 'atlassian'
                            ? `${repo.location.owner}/${repo.location.repository}`
                            : `${repo.location.organization}/${repo.location.project}/${repo.location.repository}`}</span
                    >
                    <span class="v">
                      ${repo.definitionCount == null
                        ? 'Not read yet'
                        : `${repo.definitionCount} definition${repo.definitionCount === 1 ? '' : 's'} · as of ${repo.fetchedAt}`}
                    </span>
                  </div>
                  <div class="result-row" key=${`${repo.id}-owner`}>
                    <label class="k" for=${`library-repo-owner-${repo.id}`}>Code owner (Promote's required reviewer)</label>
                    <span class="v">
                      <input
                        id=${`library-repo-owner-${repo.id}`}
                        class="wizard-input"
                        placeholder="Name, unique name, or email"
                        value=${ownerEdits[repo.id] ?? repo.codeOwner ?? ''}
                        onInput=${(e) => setOwnerEdits((prev) => ({ ...prev, [repo.id]: e.currentTarget.value }))}
                      />
                      <button
                        type="button"
                        class="btn small"
                        disabled=${savingOwner === repo.id || (ownerEdits[repo.id] ?? repo.codeOwner ?? '') === (repo.codeOwner ?? '')}
                        onClick=${() => handleSaveOwner(repo.id)}
                      >
                        ${savingOwner === repo.id ? 'Saving…' : 'Save'}
                      </button>
                    </span>
                  </div>
                `
              )}
            </div>
          `
        : repos?.length === 0
          ? html`<p class="guidance">No library repos configured.</p>`
          : null}
      <div class="wizard-field">
        <label class="field-label" for="library-repo-provider">Provider</label>
        <select id="library-repo-provider" class="wizard-input" value=${provider} onChange=${(e) => setProvider(e.currentTarget.value)}>
          ${LIBRARY_REPO_PROVIDERS.map((p) => html`<option value=${p.id}>${p.label}</option>`)}
        </select>
        ${provider === 'github'
          ? html`
              <label class="field-label" for="library-repo-owner">Owner</label>
              <input id="library-repo-owner" class="wizard-input" value=${owner} onInput=${(e) => setOwner(e.currentTarget.value)} />
              <label class="field-label" for="library-repo-repository">Repository</label>
              <input id="library-repo-repository" class="wizard-input" value=${repository} onInput=${(e) => setRepository(e.currentTarget.value)} />
              <label class="field-label" for="library-repo-baseurl">Base URL (optional — GitHub Enterprise Server only)</label>
              <input id="library-repo-baseurl" class="wizard-input" value=${baseUrl} onInput=${(e) => setBaseUrl(e.currentTarget.value)} />
            `
          : provider === 'gitlab'
            ? html`
                <label class="field-label" for="library-repo-namespace">Namespace</label>
                <input id="library-repo-namespace" class="wizard-input" value=${namespace} onInput=${(e) => setNamespace(e.currentTarget.value)} />
                <label class="field-label" for="library-repo-repository">Project</label>
                <input id="library-repo-repository" class="wizard-input" value=${repository} onInput=${(e) => setRepository(e.currentTarget.value)} />
                <label class="field-label" for="library-repo-baseurl">Base URL (optional — self-hosted GitLab CE/EE only)</label>
                <input id="library-repo-baseurl" class="wizard-input" value=${baseUrl} onInput=${(e) => setBaseUrl(e.currentTarget.value)} />
              `
            : provider === 'atlassian'
              ? html`
                  <label class="field-label" for="library-repo-owner">Bitbucket account</label>
                  <input id="library-repo-owner" class="wizard-input" value=${owner} onInput=${(e) => setOwner(e.currentTarget.value)} />
                  <label class="field-label" for="library-repo-repository">Repository</label>
                  <input id="library-repo-repository" class="wizard-input" value=${repository} onInput=${(e) => setRepository(e.currentTarget.value)} />
                  <label class="field-label" for="library-repo-jirasite">Jira site</label>
                  <input id="library-repo-jirasite" class="wizard-input" placeholder="yoursite.atlassian.net" value=${jiraSite} onInput=${(e) => setJiraSite(e.currentTarget.value)} />
                  <label class="field-label" for="library-repo-jiraprojectkey">Jira project key</label>
                  <input id="library-repo-jiraprojectkey" class="wizard-input" value=${jiraProjectKey} onInput=${(e) => setJiraProjectKey(e.currentTarget.value)} />
                  <p class="workspace-field-hint">
                    Only this server's Bitbucket credential (<code>GANTRY_LIBRARY_PAT_ATLASSIAN</code>) is ever used for this repo — no
                    Jira credential is requested or stored here (ADR-0042: a library repo never touches work items).
                  </p>
                `
              : html`
                <label class="field-label" for="library-repo-organization">Organization</label>
                <input id="library-repo-organization" class="wizard-input" value=${organization} onInput=${(e) => setOrganization(e.currentTarget.value)} />
                <label class="field-label" for="library-repo-project">Project</label>
                <input id="library-repo-project" class="wizard-input" value=${project} onInput=${(e) => setProject(e.currentTarget.value)} />
                <label class="field-label" for="library-repo-repository">Repository</label>
                <input id="library-repo-repository" class="wizard-input" value=${repository} onInput=${(e) => setRepository(e.currentTarget.value)} />
                <label class="field-label" for="library-repo-baseurl">Base URL (optional — on-premises Azure DevOps Server only)</label>
                <input id="library-repo-baseurl" class="wizard-input" value=${baseUrl} onInput=${(e) => setBaseUrl(e.currentTarget.value)} />
              `}
        <label class="field-label" for="library-repo-codeowner">Code owner (optional — Promote's required reviewer)</label>
        <input id="library-repo-codeowner" class="wizard-input" placeholder="Name, unique name, or email" value=${codeOwner} onInput=${(e) => setCodeOwner(e.currentTarget.value)} />
      </div>
      ${addError ? html`<p class="inline-error">${addError}</p>` : null}
      <div class="settings-actions">
        <button type="button" class="btn primary" disabled=${adding} onClick=${handleAdd}>${adding ? 'Adding…' : 'Add library repo'}</button>
      </div>
      ${addStatus ? html`<p class="save-status">${addStatus}</p>` : null}
    </section>
  `
}

// #117 — the version of gantry the *server* is running, so "what version are you on?" is answerable
// from the UI (and so a redeploy can be confirmed as actually live). Fetched from `GET /api/version`
// on every visit rather than compiled into this bundle: a browser holding a cached copy of this very
// file from before a redeploy would otherwise confidently report the pre-deploy version.
//
// Plain `fetch`, not `apiFetch` — the route takes no credential, and an anonymous visitor is exactly
// who needs the answer. Quiet by design: a muted footer line under the last section, not a section
// of its own, since this is a fact you go looking for rather than something to announce.
//
// Three states, and nothing in between: still loading (render nothing at all — a version that
// flickers from wrong to right is worse than one that appears a beat late), known, or genuinely
// unknown. The unknown case says so in words instead of showing a placeholder number, per this
// ticket's own "no misleading placeholder version"; either way the rest of Settings is untouched,
// because a failed fetch here resolves this component's own state and never throws.
function ServerVersionFooter() {
  const [version, setVersion] = useState(undefined) // undefined = loading · string = known · null = unavailable

  useEffect(() => {
    let cancelled = false
    fetch('/api/version')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load version (${res.status})`)
        return res.json()
      })
      .then((body) => {
        if (!cancelled) setVersion(typeof body?.version === 'string' && body.version ? body.version : null)
      })
      .catch(() => {
        if (!cancelled) setVersion(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (version === undefined) return null

  return html`
    <footer class="settings-version">
      ${version
        ? html`Gantry <span class="settings-version-number">${version}</span>`
        : 'Gantry version unavailable — this server could not read its own package version.'}
    </footer>
  `
}

export function GlobalSettingsPage({ query }) {
  return html`
    <${SettingsHeader} title="Settings" backHref=${backHrefFrom(query)} />
    <main class="settings-page">
      <${AdvancedModeSection} />
      <${RenderEngineSection} />
      ${advancedMode.value ? html`<${LibraryReposSection} />` : null}
      <${ServerVersionFooter} />
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

// The standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape — the reverse of web/lib/validateRepo.js's `parseRepoUrl` — with `baseUrl` (an on-premises Azure DevOps Server location) substituted in place of `https://dev.azure.com` when a workspace carries one. For a github workspace (#8), the same `baseUrl` override plays the GitHub Enterprise Server host's own role, substituted in place of `https://github.com`. For a gitlab workspace (#41), it plays the self-hosted GitLab CE/EE host's own role, substituted in place of `https://gitlab.com`.
//
// Shared by two different "workspace" shapes (ticket #5): a workspace-registry record's own nested
// `{ provider, location: { organization, project, repository, baseUrl? } }` (this file's own callers
// below), and `lib/instanceRegistry.js`'s unrelated, still-flat, azure-devops-only per-instance
// `instance.workspace` (`{ kind: 'azureDevOps', organization, project, repository, baseUrl? }`,
// passed in from web/app.js's `instanceFilesUrl`) — the two registries are independent and only the
// workspace registry was nested by ADR-0037. Reading `workspace.location` when present, and falling
// back to `workspace` itself otherwise, serves both without either caller needing to know which shape
// it holds; the flat `instance.workspace` shape never carries a `provider`, so it always falls
// through to the azure-devops branch below, exactly as it always has.
export function workspaceRepoUrl(workspace) {
  const location = workspace.location ?? workspace
  if (workspace.provider === 'github') {
    const base = location.baseUrl ?? 'https://github.com'
    return `${base}/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}`
  }
  if (workspace.provider === 'gitlab') {
    const base = location.baseUrl ?? 'https://gitlab.com'
    // `namespace` is GitLab's full group/subgroup path as one opaque string, however many segments
    // deep (ADR-0041) — e.g. `engineering/platform`. Each segment is split and encoded on its own,
    // mirroring lib/gitlabFileUrl.js's own `repositoryUrl`, so a literal `/` inside it becomes a real
    // path separator here rather than a percent-encoded `%2F` that would 404 against GitLab's web UI.
    const namespaceSegments = String(location.namespace).split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return `${base}/${namespaceSegments}/${encodeURIComponent(location.repository)}`
  }
  const base = location.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(location.organization)}/${encodeURIComponent(location.project)}/_git/${encodeURIComponent(location.repository)}`
}

// The workspace's own location, rendered per its Provider (#8, docs/adr/0037; gitlab added #41,
// ADR-0041) — azure-devops keeps organization/project/repository; github has no project of its own,
// so owner/repository instead; gitlab has no separate owner, so namespace/repository (its own
// group/subgroup path plus the project, ADR-0041's own "namespace holds the full path as one opaque
// string"). Reads the nested `location` (ticket #3) — only ever called with a workspace-registry
// record below, which always carries one, unlike `workspaceRepoUrl` above which also serves the flat
// instance shape.
function workspaceLocationLabel(workspace) {
  if (workspace.provider === 'github') return `${workspace.location.owner}/${workspace.location.repository}`
  if (workspace.provider === 'gitlab') return `${workspace.location.namespace}/${workspace.location.repository}`
  return `${workspace.location.organization}/${workspace.location.project}/${workspace.location.repository}`
}

// #41 (ADR-0041): the wizard's own PAT-scope guidance (new-workspace-wizard.js), mirrored here so a
// workspace's own Settings screen — the only place a GitLab or GitHub PAT can be replaced or cleared
// after registration — carries the same at-the-point-of-entry help the wizard gives at creation time.
// Keyed by provider rather than a github/else binary so a third (or later fourth) provider's own
// scopes never silently fall back to Azure DevOps's.
const PROVIDER_LABELS = {
  'azure-devops': 'Azure DevOps',
  github: 'GitHub',
  gitlab: 'GitLab',
  atlassian: 'Atlassian',
}

// Atlassian (ADR-0042) is a split-suite provider needing two tokens (Bitbucket + Jira) — the single
// password field below only ever sets/reads one (`credential.js`'s default, unspecified `product`),
// so this scope text is Bitbucket's own for now. A real per-product PAT UI for Atlassian workspaces
// is a known follow-up gap, not yet built here.
const PAT_SCOPE_HELP = {
  'azure-devops': html`Needs <strong>Code (Read &amp; write)</strong>, <strong>Work Items (Read &amp; write)</strong> and <strong>Identity (Read)</strong> scope.`,
  github: html`A fine-grained token needs <strong>Contents</strong>, <strong>Issues</strong> and <strong>Pull requests</strong> permissions set to Read &amp; write, plus <strong>Metadata</strong> set to Read-only.`,
  gitlab: html`A Personal, Project or Group Access Token needs the <strong>api</strong> scope (or, narrower, <strong>read_repository</strong> and <strong>write_repository</strong> together with API access to Issues and Merge Requests).`,
  atlassian: html`A Bitbucket API token needs <strong>Repositories (Read &amp; write)</strong>, <strong>Pull requests (Read &amp; write)</strong> scope. This workspace's separate Jira token isn't editable here yet.`,
}

// #116 (parent #109) — the id to show, or `null` for a workspace that genuinely has none.
//
// The id only means anything for a **remote workspace** (CONTEXT.md's "Workspace location"): a
// registry record (`lib/workspaceRegistry.js`) keyed by the id that `GANTRY_BOOTSTRAP_PATS` (#113,
// ADR-0046) and the MCP server's `GANTRY_WORKSPACE_PATS` (ADR-0043) are themselves keyed by. A Local
// or server-directory workspace has no registry entry at all and needs no credential-map entry, so
// there is nothing here to show and a blank or invented field would actively mislead the one person
// who reads it — whoever is pasting a credential map into a hosting dashboard.
//
// In practice that case never reaches this function: `RemoteWorkspaceSettingsPage` only renders a row
// once `fetchWorkspaceById` found a registry record, a local workspace is served by
// `LocalWorkspaceSettingsPage` instead (no server record to look up), and a server-directory
// workspace's scope id isn't in the registry so that page shows "no remote workspace". The provider/
// location test below keeps that a property of the data rather than of the call site — the flat
// `instance.workspace` shape (`{ kind: 'azureDevOps', organization, ... }`, see `workspaceRepoUrl`)
// carries no `provider` and no id of its own, and must never be rendered as if it did.
export function workspaceCredentialMapId(workspace) {
  if (!workspace || typeof workspace !== 'object') return null
  if (!workspace.provider || !workspace.location) return null
  const id = workspace.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

// #116 — the id as readable, selectable text plus a one-click copy, for the operator configuring a
// hosted deployment from a browser and a platform dashboard, who has no shell to run `gantry
// workspace-id` (#115) in. Before this the id was in this very component's hands (the row's own
// `data-workspace-id`, the PAT storage key, the archive/restore calls) but reachable only through
// devtools.
//
// Deliberately quiet: a muted monospace line directly under the workspace's location, using the same
// `--font-mono`/`--text-muted` metadata convention every other incidental identifier on these screens
// uses — an id is configuration detail, not what you opened this row to look at. Labelled and
// adjacent to the location rather than tucked at the bottom, so it's still findable by the person who
// came looking for it.
//
// Copy state is advisory only and never hides the id: `copyTextToClipboard` reports honestly whether
// the write happened (`navigator.clipboard` is undefined outside a secure context — a plain-http
// `gantry serve` is exactly that), and the failure message points at the text, which is always on
// screen and selectable, rather than claiming a copy that didn't happen.
function WorkspaceIdField({ workspaceId }) {
  const [status, setStatus] = useState('')
  const timerRef = useRef(null)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  async function handleCopy() {
    const copied = await copyTextToClipboard(workspaceId)
    setStatus(copied ? 'Copied.' : 'Couldn’t copy — select the id above and copy it by hand.')
    clearTimeout(timerRef.current)
    // Only the success message clears itself; a failure is an instruction to follow, not a flash.
    if (copied) timerRef.current = setTimeout(() => setStatus(''), 3000)
  }

  return html`
    <div class="workspace-id">
      <span class="workspace-id-label">Workspace ID</span>
      <code class="workspace-id-value">${workspaceId}</code>
      <button type="button" class="btn small ghost" onClick=${handleCopy}>Copy</button>
      <span class="workspace-id-status" role="status">${status}</span>
      <p class="workspace-id-hint">
        This workspace's key in the server's <code>GANTRY_BOOTSTRAP_PATS</code> and the MCP server's
        <code>GANTRY_WORKSPACE_PATS</code> maps. It identifies the workspace; it isn't a credential.
      </p>
    </div>
  `
}

// One workspace's editable fields: owner (server-persisted, identity-picker) and its own Workspace
// PAT (client-only, never touches the server — #9, ADR-0038: this is now the *only* place this
// workspace's credential lives, there is no global default it could otherwise fall back to). The
// owner field is an identity picker (#145 Part 2).
function WorkspaceEditor({ workspace, onUpdated, slug }) {
  const [ownerDraft, setOwnerDraft] = useState(workspace.owner ?? '')
  const [ownerStatus, setOwnerStatus] = useState('')
  const [patDraft, setPatDraft] = useState('')
  const [patStatus, setPatStatus] = useState('')
  // A ref tracking the latest owner value — used by handleSaveOwner to read
  // the value that was set via IdentityPicker's onChange (which may not have
  // committed to state yet when the Save button is clicked immediately after
  // a .fill() + blur).
  const latestOwnerRef = useRef(workspace.owner ?? '')

  // Keeps the owner draft in sync if this workspace's record is refreshed from elsewhere — without
  // this, a stale draft could silently overwrite a concurrent change on save.
  useEffect(() => {
    setOwnerDraft(workspace.owner ?? '')
    latestOwnerRef.current = workspace.owner ?? ''
  }, [workspace.owner])

  const credentialMapId = workspaceCredentialMapId(workspace)
  const hasOwnPat = hasPatForWorkspace(workspace.id)
  const patStatusForDisplay = credentialStatusForWorkspace(workspace.id)
  // Keyed by provider rather than a github/else binary so a new provider's own label and PAT-scope
  // help never silently fall back to Azure DevOps's.
  const providerLabel = PROVIDER_LABELS[workspace.provider] ?? PROVIDER_LABELS['azure-devops']

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

  function handleSetPat() {
    setPatForWorkspace(workspace.id, patDraft)
    setPatDraft('')
    setPatStatus('PAT saved \u2014 used for this workspace\u2019s instances from now on.')
  }

  function handleClearPat() {
    clearPatForWorkspace(workspace.id)
    setPatStatus('PAT cleared \u2014 the next request for this workspace will prompt for one.')
  }

  return html`
    <div class="workspace-row" data-workspace-id=${workspace.id}>
      <span class="stamp draft" title="Provider">${providerLabel}</span>
      <a class="workspace-repo-url" href=${workspaceRepoUrl(workspace)} target="_blank" rel="noreferrer">
        ${workspaceLocationLabel(workspace)}
      </a>
      ${credentialMapId ? html`<${WorkspaceIdField} workspaceId=${credentialMapId} />` : null}

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
        <label>${providerLabel} Workspace PAT</label>
        <div class="workspace-pat-status">
          ${patStatusForDisplay === 'rejected'
            ? html`<span class="stamp review">REJECTED</span>`
            : patStatusForDisplay === 'missing'
              ? html`<span class="stamp draft">MISSING</span>`
              : html`<span class="stamp agreed">SET</span>`}
        </div>
        <div class="workspace-field-row">
          <input
            type="password"
            class="wizard-input"
            value=${patDraft}
            placeholder="Paste this workspace's Personal Access Token"
            onInput=${(e) => setPatDraft(e.currentTarget.value)}
          />
          <button type="button" class="btn small" disabled=${!patDraft.trim()} onClick=${handleSetPat}>
            ${hasOwnPat ? 'Replace PAT' : 'Set PAT'}
          </button>
          ${hasOwnPat
            ? html`<button type="button" class="btn small ghost" onClick=${handleClearPat}>Clear PAT</button>`
            : null}
        </div>
        <p class="workspace-field-hint">${PAT_SCOPE_HELP[workspace.provider] ?? PAT_SCOPE_HELP['azure-devops']}</p>
        <div class="workspace-field-status">${patStatus}</div>
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
// after creation) and the dashboard's own "Remove"/"Reconnect" recovery
// affordances (web/app.js's LocalGroupResolver, reworked by #306 — still the
// same resolve/reconnect/remove lifecycle #296/A5 first wrote), reused here
// rather than reinvented — never a PAT, which doesn't apply to a workspace with no Provider-backed
// repo behind it at all.
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
          shown below; there is no PAT here — a local workspace has no Provider-backed repo behind it
          at all.
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
          This instance's own workspace — its owner, repo URL and its own Workspace PAT. Not a picker
          across every registered workspace: just the one this instance belongs to.
        </p>
        ${state === 'no-slug' ? html`<p class="load-error">No instance was specified for these Workspace Settings.</p>` : null}
        ${state === 'loading' ? html`<p class="loading">Loading\u2026</p>` : null}
        ${state === 'error' ? html`<p class="load-error">Failed to load: ${error}</p>` : null}
        ${state === 'no-workspace'
          ? html`<p class="workspace-empty">This instance has no remote workspace — its data is stored locally.</p>`
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
        <div class="result-row"><span class="k">Version</span><span class="v">v${instance.definitionVersion}</span></div>
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
                <div class="result-row"><span class="k">Version</span><span class="v">v${record.definitionVersion ?? 1}</span></div>
                <div class="result-row"><span class="k">Current stage</span><span class="v">${record.stage}</span></div>
              </div>
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
