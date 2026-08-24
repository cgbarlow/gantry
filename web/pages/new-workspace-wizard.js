// "+ New Workspace" wizard (Azure DevOps #110, under #106's unified-wizard
// spec — see docs/adr/0013-unified-workspace-creation-wizard.md on the
// `gantry-stage-advancement-and-workspace-wizard-adrs` branch). Replaces
// the old URL-first "+ New instance" wizard (web/pages/setup-wizard.js,
// removed by this same ticket) entirely: the Workspaces landing page's
// standalone creation entry point is now a single wizard covering both
// workspace and instance creation, not two separate concepts.
//
// Two steps:
//   1. "workspace" — pick an already-registered workspace (`GET
//      /api/workspaces`) or register a brand-new one (`POST
//      /api/workspaces`), setting its Owner in this same step.
//   2. "instance" — the new instance's own Name, Directory (defaults to
//      Name, slugified, overridable), and initial Assignee, then `POST
//      /api/instances` against the chosen workspace's own
//      organization/project/repository.
//
// The Azure DevOps parent-work-item link step — conditional on the chosen
// workspace's own ticketing system — is a separate, later ticket (#126):
// this wizard's flow ends the moment the instance is created, which is
// already a complete, usable flow for a workspace with no ticketing system
// configured (#110's own acceptance criteria).
import { html } from 'htm/preact'
import { useEffect, useRef } from 'preact/hooks'
import { signal, effect } from '@preact/signals'
import { parseRepoUrl } from '../lib/validateRepo.js'
import { apiFetch } from '../lib/apiFetch.js'
import { TICKETING_SYSTEMS } from '../lib/ticketingSystem.js'

// ---------- Wizard state ----------
// `@preact/signals` at module scope, matching web/pages/setup-wizard.js's
// own established convention: an in-progress wizard survives an internal
// (client-side) route change and back, not just component-local state that
// would reset on remount.

const step = signal('workspace') // 'workspace' | 'instance'
const workspaceMode = signal('pick') // 'pick' | 'register' — which sub-form step 'workspace' shows

const workspaces = signal([]) // every already-registered workspace (GET /api/workspaces)
const workspacesStatus = signal('idle') // idle | loading | loaded | error
const workspacesError = signal('')

const selectedWorkspace = signal(null) // the workspace the new instance will be created in, once chosen

// "Register a new workspace" sub-form fields.
const newRepoUrl = signal('')
const newOwner = signal('')
const newTicketingSystem = signal(TICKETING_SYSTEMS.find((s) => !s.disabled)?.id ?? 'azure-devops')
const registerStatus = signal('idle') // idle | registering | failed
const registerError = signal('')

// Instance-level fields (step 'instance').
const instanceName = signal('')
const instanceDirectory = signal('')
// True once the user edits Directory directly, so it stops auto-following
// Name — mirrors the common "slug follows title until you touch the slug"
// pattern.
const directoryTouched = signal(false)
// True once the user has typed into Name at all, regardless of its current
// value — distinct from `instanceName.value !== ''`, which would go back to
// `false`-equivalent if the user typed something and then cleared it back
// to empty. Needed so `InstanceStep`'s "Directory can't be empty" message
// can tell "never touched this form yet" (nothing to explain) apart from
// "engaged with Name and ended up with an empty Directory anyway" (a real
// state worth explaining), since both leave `instanceName`/
// `instanceDirectory` looking identically blank otherwise.
const nameTouched = signal(false)
const assignee = signal('')

const availableDefinitions = signal([])
const selectedDefinitionId = signal('')

const createStatus = signal('idle') // idle | creating | done | failed
const createError = signal('')
const createdSlug = signal('')

// Bumped by any action that abandons whatever `registerNewWorkspace()`/
// `createNewInstance()` call is currently in flight — picking a different
// workspace, going back a step, switching the pick/register sub-tab, or a
// full `resetWizard()`. Each of those async functions captures this at the
// start of its own request and compares it once that request resolves, so
// a call the user has since abandoned can't apply its (stale) success or
// failure onto whatever the user has moved on to — the same
// stale-async-response guard web/pages/setup-wizard.js's own removed
// `sessionToken` used, for the same reason.
const sessionToken = signal(0)

// Defaults the definition selection once definitions arrive — guards the
// same race web/pages/setup-wizard.js's own equivalent effect documents:
// the definitions fetch and this page's own mount are two independent
// in-flight requests with no ordering guarantee between them.
effect(() => {
  if (selectedDefinitionId.value === '' && availableDefinitions.value.length > 0) {
    selectedDefinitionId.value = availableDefinitions.value[0].id
  }
})

function defaultTicketingSystemId() {
  return TICKETING_SYSTEMS.find((s) => !s.disabled)?.id ?? 'azure-devops'
}

function resetWizard() {
  sessionToken.value++
  step.value = 'workspace'
  workspaceMode.value = 'pick'
  selectedWorkspace.value = null
  newRepoUrl.value = ''
  newOwner.value = ''
  newTicketingSystem.value = defaultTicketingSystemId()
  registerStatus.value = 'idle'
  registerError.value = ''
  instanceName.value = ''
  instanceDirectory.value = ''
  directoryTouched.value = false
  nameTouched.value = false
  assignee.value = ''
  selectedDefinitionId.value = availableDefinitions.value[0]?.id ?? ''
  createStatus.value = 'idle'
  createError.value = ''
  createdSlug.value = ''
}

// A path-safe default for Directory, derived from Name — mirrors
// lib/slug.js's own `isValidSlug` rule (also enforced server-side; this is
// just a friendlier starting point than forcing the user to invent a slug
// by hand).
function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isValidDirectory(value) {
  return value !== '' && value !== '.' && value !== '..' && !/[\\/]/.test(value)
}

function onNameInput(value) {
  nameTouched.value = true
  instanceName.value = value
  if (!directoryTouched.value) instanceDirectory.value = slugify(value)
}

function onDirectoryInput(value) {
  instanceDirectory.value = value
  directoryTouched.value = true
}

async function loadWorkspaces() {
  workspacesStatus.value = 'loading'
  try {
    const res = await apiFetch('/api/workspaces')
    const body = await res.json().catch(() => [])
    if (!res.ok) {
      throw new Error(body.message ?? body.error ?? `Failed to load workspaces (${res.status})`)
    }
    workspaces.value = body
    workspacesStatus.value = 'loaded'
  } catch (err) {
    workspacesError.value = err.message
    workspacesStatus.value = 'error'
  }
}

function pickWorkspace(workspace) {
  // Invalidates any in-flight `registerNewWorkspace()` call — the user is
  // committing to a specific, already-registered workspace now, so a
  // late-arriving registration response (from a "Register new workspace"
  // attempt they've since abandoned) must not silently replace this pick.
  sessionToken.value++
  selectedWorkspace.value = workspace
  step.value = 'instance'
}

// Switches which sub-form step 'workspace' shows. Bumps the session token
// exactly like `pickWorkspace` — switching away from "Register new
// workspace" mid-registration abandons that attempt just as surely as
// picking an existing workspace does.
function setWorkspaceMode(mode) {
  if (workspaceMode.value !== mode) sessionToken.value++
  workspaceMode.value = mode
}

async function registerNewWorkspace() {
  const location = parseRepoUrl(newRepoUrl.value)
  if (!location) {
    registerStatus.value = 'failed'
    registerError.value =
      "Couldn't parse this as an Azure DevOps repo URL — expected " +
      'https://dev.azure.com/{organization}/{project}/_git/{repository} ' +
      '(an on-premises Azure DevOps Server URL is not yet supported).'
    return
  }
  const token = sessionToken.value
  registerStatus.value = 'registering'
  registerError.value = ''
  try {
    const res = await apiFetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...location, owner: newOwner.value, ticketingSystem: newTicketingSystem.value }),
    })
    const body = await res.json().catch(() => ({}))
    // The user may have abandoned this registration (picked a different
    // workspace, switched sub-tabs, or gone back) while the request was in
    // flight — discard a stale response rather than superimposing it on
    // whatever the user has since moved on to.
    if (sessionToken.value !== token) return
    if (!res.ok) {
      registerStatus.value = 'failed'
      registerError.value = body.message ?? body.error ?? `Failed to register workspace (${res.status})`
      return
    }
    workspaces.value = [...workspaces.value, body]
    selectedWorkspace.value = body
    registerStatus.value = 'idle'
    step.value = 'instance'
  } catch (err) {
    if (sessionToken.value !== token) return
    registerStatus.value = 'failed'
    registerError.value = err.message
  }
}

function backToWorkspaceStep() {
  // Invalidates any in-flight `createNewInstance()` call — see that
  // function's own stale-response guard.
  sessionToken.value++
  step.value = 'workspace'
  selectedWorkspace.value = null
  createStatus.value = 'idle'
  createError.value = ''
  createdSlug.value = ''
}

async function createNewInstance() {
  const workspace = selectedWorkspace.value
  if (!workspace) return
  const token = sessionToken.value
  createStatus.value = 'creating'
  createError.value = ''
  try {
    const res = await apiFetch(
      '/api/instances',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: selectedDefinitionId.value,
          slug: instanceDirectory.value,
          assignee: assignee.value,
          azureDevOps: {
            organization: workspace.organization,
            project: workspace.project,
            repository: workspace.repository,
            ...(workspace.baseUrl ? { baseUrl: workspace.baseUrl } : {}),
          },
        }),
      },
      { workspaceId: workspace.id }
    )
    const body = await res.json().catch(() => ({}))
    // The user may have abandoned this create (gone back to pick a
    // different workspace) while the POST was in flight — see
    // registerNewWorkspace's own identical guard above.
    if (sessionToken.value !== token) return
    if (!res.ok) {
      createStatus.value = 'failed'
      createError.value = body.message ?? body.error ?? `Failed to create instance (${res.status})`
      return
    }
    createStatus.value = 'done'
    createdSlug.value = body.slug
  } catch (err) {
    if (sessionToken.value !== token) return
    createStatus.value = 'failed'
    createError.value = err.message
  }
}

// A full navigation (not preact-iso client-side routing), matching every
// other "Open editor" link in the app — see web/pages/setup-wizard.js's own
// comment on why.
function openInstance(slug) {
  window.location.assign(`/instance/${encodeURIComponent(slug)}`)
}

// ---------- UI ----------

function WizardHeader() {
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
  `
}

function WorkspaceModeToggle() {
  return html`
    <div class="view-toggle" role="group" aria-label="Pick or register a workspace">
      <button
        type="button"
        class=${'btn small' + (workspaceMode.value === 'pick' ? ' active' : '')}
        onClick=${() => setWorkspaceMode('pick')}
      >
        Pick existing workspace
      </button>
      <button
        type="button"
        class=${'btn small' + (workspaceMode.value === 'register' ? ' active' : '')}
        onClick=${() => setWorkspaceMode('register')}
      >
        Register new workspace
      </button>
    </div>
  `
}

function PickWorkspacePanel() {
  if (workspacesStatus.value === 'loading') return html`<p class="loading">Loading workspaces…</p>`
  if (workspacesStatus.value === 'error') {
    return html`<p class="load-error">Failed to load workspaces: ${workspacesError.value}</p>`
  }
  if (workspaces.value.length === 0) {
    return html`
      <p class="wizard-field-hint">No workspaces registered yet — switch to "Register new workspace" to create the first one.</p>
    `
  }
  return html`
    <div id="workspace-picker">
      ${workspaces.value.map(
        (w) => html`
          <div key=${w.id} class="definition-card" data-workspace-id=${w.id} onClick=${() => pickWorkspace(w)}>
            <div class="name">${w.organization}/${w.project}/${w.repository}</div>
            <div class="stages">${w.owner ? `Owner: ${w.owner}` : 'No owner set'} · ${w.ticketingSystem}</div>
          </div>
        `
      )}
    </div>
  `
}

function RegisterWorkspacePanel() {
  return html`
    <div class="wizard-field">
      <label for="new-workspace-repo-url">Azure DevOps repo URL</label>
      <input
        class="wizard-input"
        id="new-workspace-repo-url"
        type="text"
        placeholder="https://dev.azure.com/org/project/_git/repo"
        value=${newRepoUrl.value}
        onInput=${(e) => (newRepoUrl.value = e.currentTarget.value)}
      />
    </div>
    <div class="wizard-field">
      <label for="new-workspace-owner">Owner</label>
      <input
        class="wizard-input"
        id="new-workspace-owner"
        type="text"
        placeholder="Who owns this workspace"
        value=${newOwner.value}
        onInput=${(e) => (newOwner.value = e.currentTarget.value)}
      />
    </div>
    <div class="wizard-field">
      <label>Ticketing system</label>
      <div class="settings-radio-group" role="radiogroup" aria-label="Ticketing system for the new workspace">
        ${TICKETING_SYSTEMS.map(
          (system) => html`
            <label key=${system.id} class=${'settings-radio' + (system.disabled ? ' disabled' : '')}>
              <input
                type="radio"
                name="new-workspace-ticketing-system"
                value=${system.id}
                checked=${newTicketingSystem.value === system.id}
                disabled=${system.disabled}
                onChange=${() => (newTicketingSystem.value = system.id)}
              />
              ${system.label}
              ${system.disabled ? html`<span class="stamp review">${system.disabledReason}</span>` : null}
            </label>
          `
        )}
      </div>
    </div>
    <div class="wizard-field">
      <button
        type="button"
        class="btn primary"
        disabled=${registerStatus.value === 'registering' || newRepoUrl.value.trim() === ''}
        onClick=${registerNewWorkspace}
      >
        ${registerStatus.value === 'registering' ? 'Registering…' : 'Register workspace'}
      </button>
      ${registerStatus.value === 'failed' ? html`<div class="inline-error">${registerError.value}</div>` : null}
    </div>
  `
}

function WorkspaceStep() {
  return html`
    <${WorkspaceModeToggle} />
    <div class="wizard-field"></div>
    ${workspaceMode.value === 'pick' ? html`<${PickWorkspacePanel} />` : html`<${RegisterWorkspacePanel} />`}
  `
}

function DefinitionField() {
  // Only worth showing a picker once more than one definition genuinely
  // exists — with exactly one (the common case today, per README.md) the
  // effect above already defaults the selection, so there is nothing for
  // the architect to actually choose.
  if (availableDefinitions.value.length <= 1) return null
  return html`
    <div class="wizard-field">
      <label for="definition-picker">Definition</label>
      <div id="definition-picker">
        ${availableDefinitions.value.map(
          (d) => html`
            <div
              key=${d.id}
              class=${'definition-card' + (selectedDefinitionId.value === d.id ? ' selected' : '')}
              onClick=${() => (selectedDefinitionId.value = d.id)}
            >
              <div class="name">${d.title} (${d.id})</div>
              <div class="stages">${d.stages.map((s) => s.title).join(' → ')}</div>
            </div>
          `
        )}
      </div>
    </div>
  `
}

function InstanceStep() {
  const workspace = selectedWorkspace.value

  if (createStatus.value === 'done') {
    return html`
      <div class="result-card">
        <h3><span class="stamp agreed">Instance created</span></h3>
        <p class="result-note">"${createdSlug.value}" is registered and appears in gantry's instance listing.</p>
        <button type="button" class="btn primary" onClick=${() => openInstance(createdSlug.value)}>Open instance</button>
      </div>
    `
  }

  const directoryValid = isValidDirectory(instanceDirectory.value)
  // A blank Directory before the user has engaged with this form at all
  // (neither Name nor Directory ever touched) is just the pristine
  // starting state, not an error to flag yet. Deliberately keyed on the
  // *touched* flags rather than the fields' current values — a value-based
  // check (`instanceName.value === '' && instanceDirectory.value === ''`)
  // would also match "typed a Name, then cleared it back to empty",
  // silently hiding the exact same explanation this is meant to show for
  // that case.
  const directoryPristine = !nameTouched.value && !directoryTouched.value
  const noDefinitionSelected = selectedDefinitionId.value === ''

  return html`
    <div class="result-card">
      <h3>Workspace</h3>
      <div class="result-row">
        <span class="k">Repo</span><span class="v">${workspace.organization}/${workspace.project}/${workspace.repository}</span>
      </div>
      <div class="result-row"><span class="k">Owner</span><span class="v">${workspace.owner || '—'}</span></div>
      <button type="button" class="btn small ghost" onClick=${backToWorkspaceStep}>← Choose a different workspace</button>
    </div>

    <div class="wizard-field">
      <label for="instance-name">Name</label>
      <input
        class="wizard-input"
        id="instance-name"
        type="text"
        placeholder="My Initiative"
        value=${instanceName.value}
        onInput=${(e) => onNameInput(e.currentTarget.value)}
      />
    </div>

    <div class="wizard-field">
      <label for="instance-directory">Directory</label>
      <input
        class="wizard-input"
        id="instance-directory"
        type="text"
        placeholder="my-initiative"
        value=${instanceDirectory.value}
        onInput=${(e) => onDirectoryInput(e.currentTarget.value)}
      />
      <p class="wizard-field-hint">Defaults to Name, slugified — override it to use a different folder name.</p>
      ${!directoryValid && !directoryPristine
        ? html`<div class="inline-error">
            ${instanceDirectory.value === ''
              ? "Directory can't be empty — type one directly, or give the instance a Name to derive one from."
              : 'Not a valid directory name — no "/", "\\", or a bare "." / "..".'}
          </div>`
        : null}
    </div>

    <div class="wizard-field">
      <label for="instance-assignee">Assignee</label>
      <input
        class="wizard-input"
        id="instance-assignee"
        type="text"
        placeholder="Who owns this instance"
        value=${assignee.value}
        onInput=${(e) => (assignee.value = e.currentTarget.value)}
      />
    </div>

    <${DefinitionField} />

    <div class="wizard-field">
      <button
        type="button"
        class="btn primary"
        disabled=${createStatus.value === 'creating' || !directoryValid || noDefinitionSelected}
        onClick=${createNewInstance}
      >
        ${createStatus.value === 'creating' ? 'Creating…' : 'Create instance'}
      </button>
      ${noDefinitionSelected ? html`<p class="wizard-field-hint">Loading definitions…</p>` : null}
      ${createStatus.value === 'failed' ? html`<div class="inline-error">${createError.value}</div>` : null}
    </div>
  `
}

export function NewWorkspaceWizardPage() {
  // This page's state lives in module-scope signals (see the header
  // comment) precisely so an in-progress wizard survives a client-side
  // route change and back — `preact-iso`'s router intercepts same-origin
  // anchor clicks rather than doing a full page reload, so nothing else
  // would otherwise reset it. That's the right behavior while the wizard
  // is still in progress, but not once it has already run to completion:
  // without this, re-opening "+ New Workspace" after finishing a previous
  // creation (without clicking that result's own "Open instance", which
  // navigates away with a real page load and so re-initializes everything
  // for free) would re-show the *previous* "Instance created" card instead
  // of a blank wizard. Checked synchronously on this very first render
  // (guarded by a ref so it only ever runs once per mount, not on every
  // re-render) rather than in an effect, so there's no flash of the stale
  // completed state before it resets.
  const hasCheckedForStaleCompletion = useRef(false)
  if (!hasCheckedForStaleCompletion.current) {
    hasCheckedForStaleCompletion.current = true
    if (createStatus.value === 'done') resetWizard()
  }

  useEffect(() => {
    loadWorkspaces()
    fetch('/api/definitions')
      .then((res) => res.json())
      .then((body) => (availableDefinitions.value = body))
      .catch(() => (availableDefinitions.value = []))
  }, [])

  return html`
    <${WizardHeader} />
    <main class="wizard-page">
      <h2>New Workspace</h2>
      <p class="lede">
        Pick a workspace already registered with gantry, or register a new Azure DevOps repo as one — then give the
        new instance its own Name, Directory, and initial Assignee.
      </p>

      ${step.value === 'workspace' ? html`<${WorkspaceStep} />` : html`<${InstanceStep} />`}
    </main>
  `
}
