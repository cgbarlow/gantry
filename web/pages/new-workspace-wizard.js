// The "+ New Workspace" wizard (#110, under #106/docs/adr/0013-unified-
// workspace-creation-wizard.md): replaces the old URL-first instance-setup
// wizard (web/pages/setup-wizard.js, #78/#94) entirely. Rather than pasting
// a raw Azure DevOps repo URL and having gantry guess whether it already
// holds instance data, this wizard is explicit about what it's doing at
// every step:
//
//   1. Pick an existing Workspace (an already-registered Azure DevOps
//      organization/project/repository) or register a brand new one —
//      setting that new Workspace's Owner and ticketing system in the same
//      step, since nothing else asks for either ahead of an instance
//      existing in it.
//   2. Instance Name + Directory (defaulting to a slugified Name,
//      overridable) + initial Assignee.
//   3. Only when the chosen Workspace has a ticketing system configured
//      (today, every Workspace does — see workspaceRegistry.js's own
//      `ticketingSystem` doc comment — but this step is written to react to
//      that field rather than assume it, so a future "no ticketing system"
//      Workspace needs no wizard change of its own): the Azure DevOps
//      parent-work-item link (#126) — Organization and Project pinned
//      read-only from the Workspace, Parent work item id and Work item type
//      as real PAT-backed lookups against `GET
//      /api/azure-devops/work-items/:id`/`GET
//      /api/azure-devops/work-item-types` (#121's client capabilities),
//      never freetext.
//
// State is kept as module-scope `@preact/signals` (not component-local
// `useState`), matching the old wizard's own convention (ADR-0006 names
// "in-progress wizard answers" as exactly this state model's use case) — an
// in-progress registration or instance-fields draft survives an internal
// route change and back, not just component-local state that'd reset on
// remount.
import { html } from 'htm/preact'
import { useEffect } from 'preact/hooks'
import { signal, effect } from '@preact/signals'
import { apiFetch } from '../lib/apiFetch.js'
import { TICKETING_SYSTEMS, defaultTicketingSystem } from '../lib/ticketingSystem.js'

// The work item type used when nothing more specific is looked up or
// chosen — mirrors lib/workItemLink.js's own `DEFAULT_WORK_ITEM_TYPE`
// ("Task", the one type every stock Azure DevOps process template ships as
// a valid child of a parent work item). Kept as a literal here rather than
// imported: that module is server-only (it shells real Azure DevOps client
// calls), with no browser-safe entry point of its own.
const DEFAULT_WORK_ITEM_TYPE = 'Task'

// ---------- Step 1: pick or register a Workspace ----------
const workspaceMode = signal('pick') // 'pick' | 'register'
const workspaces = signal(null) // fetched GET /api/workspaces list, null while loading
const workspacesLoadError = signal('')
const pickedWorkspaceId = signal('')

const registerForm = signal({ organization: '', project: '', repository: '', owner: '' })
const registerTicketingSystem = signal(defaultTicketingSystem.value)
const registerStatus = signal('idle') // idle | registering | failed
const registerError = signal('')

// The Workspace this wizard is now creating an instance in — set once step
// 1 completes, either from the picked entry or the newly registered one.
const selectedWorkspace = signal(null)

// ---------- Step 2: instance fields ----------
const step = signal('workspace') // 'workspace' | 'instance' | 'link' | 'done'
const definitions = signal([])
const selectedDefinitionId = signal('')
const nameField = signal('')
const directoryField = signal('')
// Once the architect edits Directory directly, it stops auto-following
// Name — the same "auto-populated but overridable" contract #106's spec
// describes for the stage work-item title (#111), applied here to Name ->
// Directory instead.
const directoryTouched = signal(false)
const assigneeField = signal('')

// ---------- Step 3: parent-work-item link (#126) ----------
const workItemTypes = signal([])
const workItemTypesLoadError = signal('')
const parentIdField = signal('')
const workItemTypeField = signal(DEFAULT_WORK_ITEM_TYPE)
const lookupStatus = signal('idle') // idle | looking-up | found | not-found | error
const lookupError = signal('')
const lookupResult = signal(null) // { id, title, workItemType, state }

// ---------- Final create/link ----------
const createStatus = signal('idle') // idle | creating | failed
const createError = signal('')
const linkStatus = signal('idle') // idle | linking | failed
const linkError = signal('')
const createdSlug = signal('')

function slugify(name) {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Keeps Directory auto-populated from Name until the architect edits it
// directly (directoryTouched) — the same "reveal/default, but overridable"
// pattern the rest of this wizard's fields follow.
effect(() => {
  if (!directoryTouched.value) {
    directoryField.value = slugify(nameField.value)
  }
})

function resetWizard() {
  workspaceMode.value = 'pick'
  workspaces.value = null
  workspacesLoadError.value = ''
  pickedWorkspaceId.value = ''
  registerForm.value = { organization: '', project: '', repository: '', owner: '' }
  registerTicketingSystem.value = defaultTicketingSystem.value
  registerStatus.value = 'idle'
  registerError.value = ''
  selectedWorkspace.value = null
  step.value = 'workspace'
  selectedDefinitionId.value = definitions.value[0]?.id ?? ''
  nameField.value = ''
  directoryField.value = ''
  directoryTouched.value = false
  assigneeField.value = ''
  workItemTypes.value = []
  workItemTypesLoadError.value = ''
  parentIdField.value = ''
  workItemTypeField.value = DEFAULT_WORK_ITEM_TYPE
  lookupStatus.value = 'idle'
  lookupError.value = ''
  lookupResult.value = null
  createStatus.value = 'idle'
  createError.value = ''
  linkStatus.value = 'idle'
  linkError.value = ''
  createdSlug.value = ''
}

async function loadWorkspaces() {
  workspacesLoadError.value = ''
  try {
    const res = await apiFetch('/api/workspaces')
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.message ?? body.error ?? `Failed to load workspaces (${res.status})`)
    }
    workspaces.value = await res.json()
  } catch (err) {
    workspacesLoadError.value = err.message
    workspaces.value = []
  }
}

function pickWorkspace() {
  const found = (workspaces.value ?? []).find((w) => w.id === pickedWorkspaceId.value)
  if (!found) return
  selectedWorkspace.value = found
  step.value = 'instance'
}

async function registerWorkspace() {
  registerStatus.value = 'registering'
  registerError.value = ''
  const { organization, project, repository, owner } = registerForm.value
  try {
    // A brand-new Workspace registration has no workspaceId yet — this
    // always uses the global default PAT, exactly like
    // web/lib/validateRepo.js's own repo-check (there's nothing more
    // specific to resolve a PAT override against until the Workspace
    // itself exists).
    const res = await apiFetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization: organization.trim(),
        project: project.trim(),
        repository: repository.trim(),
        owner: owner.trim(),
        ticketingSystem: registerTicketingSystem.value,
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      registerStatus.value = 'failed'
      registerError.value = body.message ?? body.error ?? `Failed to register workspace (${res.status})`
      return
    }
    registerStatus.value = 'idle'
    selectedWorkspace.value = body
    workspaces.value = null
    step.value = 'instance'
  } catch (err) {
    registerStatus.value = 'failed'
    registerError.value = err.message
  }
}

function continueFromInstanceStep() {
  if (!nameField.value.trim() || !directoryField.value.trim() || !selectedDefinitionId.value) return
  if (selectedWorkspace.value?.ticketingSystem) {
    step.value = 'link'
    return
  }
  createInstanceAndMaybeLink()
}

// Resets the lookup outcome whenever the id field changes after a previous
// look-up — the same "editing invalidates the prior check" rule
// web/pages/setup-wizard.js's own resetCheck()-on-edit already establishes
// for its repo-URL field, applied here so a stale "found" result can never
// be submitted for an id the architect has since changed.
function onParentIdInput(value) {
  parentIdField.value = value
  if (lookupStatus.value !== 'idle') {
    lookupStatus.value = 'idle'
    lookupError.value = ''
    lookupResult.value = null
  }
}

async function loadWorkItemTypes() {
  const ws = selectedWorkspace.value
  if (!ws) return
  workItemTypesLoadError.value = ''
  try {
    const qs = new URLSearchParams({ organization: ws.organization, project: ws.project })
    const res = await apiFetch(`/api/azure-devops/work-item-types?${qs}`, {}, { workspaceId: ws.id })
    const body = await res.json().catch(() => ([]))
    if (!res.ok) {
      throw new Error(body.message ?? body.error ?? `Failed to load work item types (${res.status})`)
    }
    workItemTypes.value = body
    if (body.length && !body.some((t) => t.name === workItemTypeField.value)) {
      workItemTypeField.value = body.some((t) => t.name === DEFAULT_WORK_ITEM_TYPE) ? DEFAULT_WORK_ITEM_TYPE : body[0].name
    }
  } catch (err) {
    workItemTypesLoadError.value = err.message
  }
}

async function lookUpParentWorkItem() {
  const ws = selectedWorkspace.value
  const id = parentIdField.value.trim()
  if (!ws || !id) return
  lookupStatus.value = 'looking-up'
  lookupError.value = ''
  try {
    const qs = new URLSearchParams({ organization: ws.organization, project: ws.project })
    const res = await apiFetch(`/api/azure-devops/work-items/${encodeURIComponent(id)}?${qs}`, {}, { workspaceId: ws.id })
    if (res.status === 404) {
      lookupStatus.value = 'not-found'
      return
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body.message ?? body.error ?? `Look-up failed (${res.status})`)
    }
    lookupResult.value = body
    lookupStatus.value = 'found'
    // A found work item's own type is a helpful default — still fully
    // overridable via the Work item type select below — but only when
    // it's one of this project's own known types (a custom/renamed type
    // this project's own `GET .../workitemtypes` doesn't report would
    // otherwise silently select nothing in that dropdown).
    if (workItemTypes.value.some((t) => t.name === body.workItemType)) {
      workItemTypeField.value = body.workItemType
    }
  } catch (err) {
    lookupStatus.value = 'error'
    lookupError.value = err.message
  }
}

async function createInstanceAndMaybeLink() {
  createStatus.value = 'creating'
  createError.value = ''
  const ws = selectedWorkspace.value
  const slug = directoryField.value.trim()
  try {
    const res = await apiFetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: selectedDefinitionId.value,
        slug,
        assignee: assigneeField.value.trim(),
        azureDevOps: { organization: ws.organization, project: ws.project, repository: ws.repository },
      }),
    }, { workspaceId: ws.id })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      createStatus.value = 'failed'
      createError.value = body.message ?? body.error ?? `Failed to create instance (${res.status})`
      return
    }
    createdSlug.value = slug
  } catch (err) {
    createStatus.value = 'failed'
    createError.value = err.message
    return
  }

  // The parent-work-item link is mandatory for a ticketing-enabled
  // Workspace (#126's own acceptance criterion — every instance in such a
  // Workspace is trackable on the board from day one), so this always
  // fires immediately after a successful create when step 'link' was
  // actually reached — never a separate, skippable action.
  if (step.value === 'link') {
    linkStatus.value = 'linking'
    linkError.value = ''
    try {
      const res = await apiFetch(`/api/instance/work-items/link?slug=${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization: ws.organization,
          project: ws.project,
          parentId: Number(parentIdField.value.trim()),
          workItemType: workItemTypeField.value,
        }),
      }, { workspaceId: ws.id })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        linkStatus.value = 'failed'
        linkError.value = body.message ?? body.error ?? `Failed to link work item (${res.status})`
        return
      }
    } catch (err) {
      linkStatus.value = 'failed'
      linkError.value = err.message
      return
    }
  }

  createStatus.value = 'idle'
  step.value = 'done'
}

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

function WorkspaceStep() {
  useEffect(() => {
    if (workspaceMode.value === 'pick' && workspaces.value === null) loadWorkspaces()
  }, [workspaceMode.value])

  return html`
    <div class="wizard-field">
      <div class="wizard-mode-toggle" role="group" aria-label="Workspace source">
        <button
          type="button"
          class=${'btn small' + (workspaceMode.value === 'pick' ? ' active' : '')}
          onClick=${() => (workspaceMode.value = 'pick')}
        >
          Pick existing workspace
        </button>
        <button
          type="button"
          class=${'btn small' + (workspaceMode.value === 'register' ? ' active' : '')}
          onClick=${() => (workspaceMode.value = 'register')}
        >
          Register new workspace
        </button>
      </div>
    </div>

    ${workspaceMode.value === 'pick'
      ? html`
          <div class="wizard-field">
            ${workspacesLoadError.value ? html`<p class="load-error">${workspacesLoadError.value}</p>` : null}
            ${workspaces.value === null && !workspacesLoadError.value ? html`<p class="loading">Loading…</p>` : null}
            ${workspaces.value?.length === 0
              ? html`<p class="wizard-field-hint">No workspaces registered yet — <button type="button" class="btn-link" onClick=${() => (workspaceMode.value = 'register')}>switch to "Register new workspace"</button>.</p>`
              : null}
            ${workspaces.value?.length
              ? html`
                  <div id="workspace-picker">
                    ${workspaces.value.map(
                      (w) => html`
                        <div
                          key=${w.id}
                          class=${'definition-card' + (pickedWorkspaceId.value === w.id ? ' selected' : '')}
                          onClick=${() => (pickedWorkspaceId.value = w.id)}
                        >
                          <div class="name">${w.organization}/${w.project}/${w.repository}</div>
                          <div class="stages">owner: ${w.owner || '—'} · ticketing: ${w.ticketingSystem || 'none'}</div>
                        </div>
                      `
                    )}
                  </div>
                  <div class="wizard-field" style="margin-top:16px">
                    <button type="button" class="btn primary" disabled=${!pickedWorkspaceId.value} onClick=${pickWorkspace}>
                      Continue
                    </button>
                  </div>
                `
              : null}
          </div>
        `
      : html`
          <div class="wizard-field">
            <label for="ws-organization">Organization</label>
            <input
              class="wizard-input"
              id="ws-organization"
              type="text"
              value=${registerForm.value.organization}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, organization: e.currentTarget.value })}
            />
          </div>
          <div class="wizard-field">
            <label for="ws-project">Project</label>
            <input
              class="wizard-input"
              id="ws-project"
              type="text"
              value=${registerForm.value.project}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, project: e.currentTarget.value })}
            />
          </div>
          <div class="wizard-field">
            <label for="ws-repository">Repository</label>
            <input
              class="wizard-input"
              id="ws-repository"
              type="text"
              value=${registerForm.value.repository}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, repository: e.currentTarget.value })}
            />
          </div>
          <div class="wizard-field">
            <label for="ws-owner">Owner</label>
            <input
              class="wizard-input"
              id="ws-owner"
              type="text"
              value=${registerForm.value.owner}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, owner: e.currentTarget.value })}
            />
          </div>
          <div class="wizard-field">
            <label>Ticketing system</label>
            <div class="settings-radio-group" role="radiogroup" aria-label="Ticketing system">
              ${TICKETING_SYSTEMS.map(
                (system) => html`
                  <label key=${system.id} class=${'settings-radio' + (system.disabled ? ' disabled' : '')}>
                    <input
                      type="radio"
                      name="ws-ticketing-system"
                      value=${system.id}
                      checked=${registerTicketingSystem.value === system.id}
                      disabled=${system.disabled}
                      onChange=${() => (registerTicketingSystem.value = system.id)}
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
              disabled=${registerStatus.value === 'registering' ||
              !registerForm.value.organization.trim() ||
              !registerForm.value.project.trim() ||
              !registerForm.value.repository.trim()}
              onClick=${registerWorkspace}
            >
              ${registerStatus.value === 'registering' ? 'Registering…' : 'Register workspace'}
            </button>
            ${registerStatus.value === 'failed' ? html`<div class="inline-error">${registerError.value}</div>` : null}
          </div>
        `}
  `
}

function InstanceStep() {
  const ws = selectedWorkspace.value
  const ticketingEnabled = Boolean(ws?.ticketingSystem)

  return html`
    <div class="result-card">
      <h3><span class="stamp agreed">Workspace</span></h3>
      <div class="result-row"><span class="k">Organization/Project/Repository</span><span class="v">${ws.organization}/${ws.project}/${ws.repository}</span></div>
    </div>

    <h3>New Instance</h3>

    <div class="wizard-field">
      <label for="definition-picker">Definition</label>
      <div id="definition-picker">
        ${definitions.value.map(
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

    <div class="wizard-field">
      <label for="instance-name">Name</label>
      <input
        class="wizard-input"
        id="instance-name"
        type="text"
        value=${nameField.value}
        onInput=${(e) => (nameField.value = e.currentTarget.value)}
      />
    </div>

    <div class="wizard-field">
      <label for="instance-directory">Directory</label>
      <input
        class="wizard-input"
        id="instance-directory"
        type="text"
        value=${directoryField.value}
        onInput=${(e) => {
          directoryTouched.value = true
          directoryField.value = e.currentTarget.value
        }}
      />
      <p class="wizard-field-hint">Defaults to a slugified Name — edit to override.</p>
    </div>

    <div class="wizard-field">
      <label for="instance-assignee">Assignee</label>
      <input
        class="wizard-input"
        id="instance-assignee"
        type="text"
        placeholder="Unassigned"
        value=${assigneeField.value}
        onInput=${(e) => (assigneeField.value = e.currentTarget.value)}
      />
    </div>

    <div class="wizard-field" style="display:flex;gap:8px">
      <button type="button" class="btn ghost" onClick=${() => (step.value = 'workspace')}>← Back</button>
      <button
        type="button"
        class="btn primary"
        disabled=${!nameField.value.trim() || !directoryField.value.trim() || !selectedDefinitionId.value || createStatus.value === 'creating'}
        onClick=${continueFromInstanceStep}
      >
        ${ticketingEnabled
          ? 'Next: link a work item'
          : createStatus.value === 'creating'
            ? 'Creating…'
            : 'Create instance'}
      </button>
    </div>
    ${!ticketingEnabled && createStatus.value === 'failed' ? html`<div class="inline-error">${createError.value}</div>` : null}
  `
}

function LinkStep() {
  const ws = selectedWorkspace.value

  useEffect(() => {
    loadWorkItemTypes()
    // eslint-disable-next-line
  }, [])

  const canSubmit =
    lookupStatus.value === 'found' &&
    Boolean(workItemTypeField.value) &&
    createStatus.value !== 'creating' &&
    linkStatus.value !== 'linking'

  return html`
    <div class="wizard-field">
      <label for="link-organization">Organization</label>
      <input class="wizard-input" id="link-organization" type="text" value=${ws.organization} disabled />
    </div>
    <div class="wizard-field">
      <label for="link-project">Project</label>
      <input class="wizard-input" id="link-project" type="text" value=${ws.project} disabled />
    </div>

    <div class="wizard-field">
      <label for="parent-work-item-id">Parent work item id</label>
      <div class="workspace-field-row">
        <input
          class="wizard-input"
          id="parent-work-item-id"
          type="text"
          value=${parentIdField.value}
          onInput=${(e) => onParentIdInput(e.currentTarget.value)}
        />
        <button
          type="button"
          class="btn small"
          disabled=${!parentIdField.value.trim() || lookupStatus.value === 'looking-up'}
          onClick=${lookUpParentWorkItem}
        >
          ${lookupStatus.value === 'looking-up' ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      ${lookupStatus.value === 'found'
        ? html`<p class="wizard-field-hint">Found: #${lookupResult.value.id} "${lookupResult.value.title}" (${lookupResult.value.workItemType}, ${lookupResult.value.state})</p>`
        : null}
      ${lookupStatus.value === 'not-found' ? html`<div class="inline-error">No work item #${parentIdField.value} found in ${ws.organization}/${ws.project}.</div>` : null}
      ${lookupStatus.value === 'error' ? html`<div class="inline-error">${lookupError.value}</div>` : null}
    </div>

    <div class="wizard-field">
      <label for="work-item-type">Work item type</label>
      ${workItemTypesLoadError.value ? html`<div class="inline-error">${workItemTypesLoadError.value}</div>` : null}
      <select
        class="wizard-input"
        id="work-item-type"
        value=${workItemTypeField.value}
        onChange=${(e) => (workItemTypeField.value = e.currentTarget.value)}
      >
        ${workItemTypes.value.map((t) => html`<option key=${t.name} value=${t.name}>${t.name}</option>`)}
      </select>
    </div>

    <div class="wizard-field" style="display:flex;gap:8px">
      <button type="button" class="btn ghost" onClick=${() => (step.value = 'instance')}>← Back</button>
      <button type="button" class="btn primary" disabled=${!canSubmit} onClick=${createInstanceAndMaybeLink}>
        ${createStatus.value === 'creating' ? 'Creating…' : linkStatus.value === 'linking' ? 'Linking…' : 'Create instance & link'}
      </button>
    </div>
    ${createStatus.value === 'failed' ? html`<div class="inline-error">${createError.value}</div>` : null}
    ${linkStatus.value === 'failed' ? html`<div class="inline-error">${linkError.value}</div>` : null}
  `
}

function DoneStep() {
  return html`
    <div class="result-card">
      <h3><span class="stamp agreed">Instance created</span></h3>
      <p class="result-note">"${createdSlug.value}" is registered and appears in gantry's instance listing.</p>
      <button type="button" class="btn primary" onClick=${() => openInstance(createdSlug.value)}>Open instance</button>
      <button type="button" class="btn ghost" onClick=${resetWizard}>Create another</button>
    </div>
  `
}

export function NewWorkspaceWizardPage() {
  useEffect(() => {
    fetch('/api/definitions')
      .then((res) => res.json())
      .then((body) => {
        definitions.value = body
        if (!selectedDefinitionId.value) selectedDefinitionId.value = body[0]?.id ?? ''
      })
      .catch(() => (definitions.value = []))
  }, [])

  return html`
    <${WizardHeader} />
    <main class="wizard-page">
      <h2>New Workspace</h2>
      <p class="lede">
        Pick an existing workspace or register a new one, then create an instance in it — with a real
        parent-work-item link when that workspace has a ticketing system configured.
      </p>

      ${step.value === 'workspace' ? html`<${WorkspaceStep} />` : null}
      ${step.value === 'instance' ? html`<${InstanceStep} />` : null}
      ${step.value === 'link' ? html`<${LinkStep} />` : null}
      ${step.value === 'done' ? html`<${DoneStep} />` : null}
    </main>
  `
}
