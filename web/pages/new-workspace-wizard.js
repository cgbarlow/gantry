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
import { renderMarkdown } from '../lib/markdown.js'
import { TICKETING_SYSTEMS, defaultTicketingSystem } from '../lib/ticketingSystem.js'
import { IdentityPicker } from '../lib/identityPicker.js'
import { parseRepoUrl } from '../lib/validateRepo.js'
import { advancedMode } from '../lib/advancedMode.js'
import {
  isSupported as localWorkspaceSupported,
  pickWorkspaceDirectory,
  parseWorkspaceJson,
  serializeWorkspaceJson,
  rememberWorkspace,
  recentLocalWorkspaces,
  getWorkspaceHandle,
  ensurePermission,
  forgetWorkspace,
  readTextFile,
  readBinaryFile,
  writeTextFile,
  listDir,
} from '../lib/localWorkspace.js'
import { renderInstanceYaml, renderModuleFile as renderLocalModuleFile, parseInstanceYaml } from '../lib/localInstanceFiles.js'

// The work item type used when nothing more specific is looked up or
// chosen — mirrors lib/workItemLink.js's own `DEFAULT_WORK_ITEM_TYPE`
// ("Task", the one type every stock Azure DevOps process template ships as
// a valid child of a parent work item). Kept as a literal here rather than
// imported: that module is server-only (it shells real Azure DevOps client
// calls), with no browser-safe entry point of its own.
const DEFAULT_WORK_ITEM_TYPE = 'Task'

// ---------- Step 1: Workspace location (ADR-0029) ----------
// The axis rendered ABOVE "Pick existing | Register new": where an
// instance's data lives — on the gantry server / an Azure DevOps repo it
// can reach ('server'), or a folder on this browser user's own machine
// reached through the File System Access API ('local', Chromium-only).
const workspaceLocation = signal('server') // 'server' | 'local'

// B3 (#302): advanced mode off skips the "Workspace location" toggle entirely
// and the wizard behaves as if "Local" were already selected — no
// Server-hosted option, no Azure DevOps URL field, no work-item step. This
// effect is the single source of truth for that: whenever advanced mode is
// off, force `workspaceLocation` to 'local', both on initial load (an effect
// runs once immediately) and if advanced mode is switched off later (e.g. in
// another tab) while the wizard is still open. `WorkspaceLocationToggle`
// itself only renders when advanced mode is on, so there is no UI path back
// to 'server' while this holds.
effect(() => {
  if (!advancedMode.value) workspaceLocation.value = 'local'
})

// Server-hosted + Pick: adopt an existing Azure DevOps repo by URL. Runs
// the same GET /api/azure-devops/repo-check the final create step already
// uses (see createInstanceAndMaybeLink's C4 block) to report whether that
// location already holds instance data.
const adoptRepoUrl = signal('')
const adoptCheckStatus = signal('idle') // idle | checking | present | absent | error
const adoptCheckMessage = signal('')

// Local workspace — shared across both sub-modes.
const localError = signal('')
const localBusy = signal(false)
// The IndexedDB id of the remembered local workspace, threaded to the
// editor route as `?local=<id>` so A6's editor can pick the handle back up.
const localWorkspaceId = signal('')
// Routes the instance-fields step's "Create" to the local-filesystem
// writer (createLocalInstance) instead of POST /api/instances.
const isLocalWorkspace = signal(false)

// Local + Register.
const localRegHandle = signal(null) // FileSystemDirectoryHandle for the picked folder
const localRegStage = signal('pick') // 'pick' | 'details'
const localRegName = signal('')
const localRegOwner = signal('')

// Local + Pick.
const localPickInstances = signal(null) // [{ slug }] | null (null = nothing opened yet)
const localRecent = signal([]) // recentLocalWorkspaces()
const localGrantId = signal('') // a recent-workspace id whose permission needs a re-grant

// ---------- Server-hosted + Register: import from local workspace (#305) ----------
// A data-source toggle *inside* the Register panel (not a new top-level
// mode, per #305's design): "Start blank" is today's unchanged
// org/project/repository form; "Import from local workspace" reuses the
// Local+Pick building blocks above (recentLocalWorkspaces/ensurePermission/
// workspace.json+instance.yaml discovery) to pick a *source* local instance,
// then either the existing Register form or the existing Pick-workspace list
// to choose a *destination* Server-hosted workspace, before rejoining the
// normal Instance step — pre-filled from the source instance's own content
// instead of blank.
const registerDataSource = signal('blank') // 'blank' | 'import'
const importStage = signal('source') // 'source' | 'destination' — only meaningful while registerDataSource === 'import'
const importDestMode = signal('new') // 'new' | 'existing' — mirrors workspaceMode's own 'register'/'pick' distinction, scoped to the import destination step

// Import source picker — same shape as the Local+Pick signals above, kept
// separate so opening a source folder here never disturbs the top-level
// Local flow's own state (both can be mid-flow in the same wizard session
// across a Back navigation).
const importRecent = signal([]) // recentLocalWorkspaces()
const importGrantId = signal('') // a recent-workspace id whose permission needs a re-grant
const importBusy = signal(false)
const importError = signal('')
const importHandle = signal(null) // FileSystemDirectoryHandle of the opened source local workspace
const importSourceWorkspaceId = signal('') // IndexedDB id of the opened source local workspace, for the post-import forget prompt
const importWorkspaceName = signal('') // the source local workspace's own workspace.json name
const importInstances = signal(null) // [{ slug }] | null (null = nothing opened yet)

// The loaded import payload: `null` until a source instance has been read.
// `{ slug, instanceYaml, stage, modules: [{ id, text }], assets: [{ filename, base64 }] }`.
// Its presence is what routes the final Instance-step submit through
// POST /api/instances/import (real content) instead of POST /api/instances
// (blank template) — see createInstanceAndMaybeLink.
const importPayload = signal(null)

// The opt-in, post-success "forget this local workspace?" prompt (#305's
// last acceptance criterion) — shown once on the Done step for an import,
// resolved (either branch) exactly once.
const importForgetResolved = signal(false)
const importForgotten = signal(false)

// ---------- Step 1: pick or register a Workspace ----------
const workspaceMode = signal('pick') // 'pick' | 'register'
const workspaces = signal(null) // fetched GET /api/workspaces list, null while loading
const workspacesLoadError = signal('')
const pickedWorkspaceId = signal('')

const registerForm = signal({ organization: 'Contoso-Production', project: 'Default', repository: '', owner: '' })
const registerTicketingSystem = signal(defaultTicketingSystem.value)
const registerStatus = signal('idle') // idle | registering | failed
const registerError = signal('')
const registerNotice = signal('')

// The Workspace this wizard is now creating an instance in — set once step
// 1 completes, either from the picked entry or the newly registered one.
const selectedWorkspace = signal(null)

// ---------- Step 2: instance fields ----------
const step = signal('workspace') // 'workspace' | 'instance' | 'link' | 'done'
const definitions = signal([])
const selectedDefinitionId = signal('')
const selectedVersion = signal('latest')
const changelog = signal(null) // string|null — the selected version's CHANGELOG.md text (#234), fire-and-forget
const changelogLoading = signal(false)
const draftConfirmVisible = signal(false)
const draftConfirmPending = signal(false)
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
const createNotice = signal('')
const linkStatus = signal('idle') // idle | linking | failed
const linkError = signal('')
const createdSlug = signal('')
const linkMode = signal('create') // 'create' | 'existing'
const newWorkItemTitle = signal('')
const newWorkItemCreateStatus = signal('idle') // idle | creating | failed
const newWorkItemCreateError = signal('')

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

// Pre-scoped workspace via ?workspace=<id> (from the Switch-instance menu's
// "+ New Instance" link, WI151) — once the workspace list loads, resolve
// the id and advance straight to the instance step so the architect never
// has to re-pick the workspace they were already viewing.
const preselectedWorkspaceId = signal(null)
effect(() => {
  const id = preselectedWorkspaceId.value
  const list = workspaces.value
  if (!id || !list || selectedWorkspace.value) return
  const found = list.find((w) => w.id === id)
  if (found) {
    pickedWorkspaceId.value = found.id
    selectedWorkspace.value = found
    step.value = 'instance'
  }
})

function resetWizard() {
  preselectedWorkspaceId.value = null
  workspaceLocation.value = advancedMode.value ? 'server' : 'local'
  adoptRepoUrl.value = ''
  adoptCheckStatus.value = 'idle'
  adoptCheckMessage.value = ''
  localError.value = ''
  localBusy.value = false
  localWorkspaceId.value = ''
  isLocalWorkspace.value = false
  localRegHandle.value = null
  localRegStage.value = 'pick'
  localRegName.value = ''
  localRegOwner.value = ''
  localPickInstances.value = null
  localRecent.value = []
  localGrantId.value = ''
  registerDataSource.value = 'blank'
  importStage.value = 'source'
  importDestMode.value = 'new'
  importRecent.value = []
  importGrantId.value = ''
  importBusy.value = false
  importError.value = ''
  importHandle.value = null
  importSourceWorkspaceId.value = ''
  importWorkspaceName.value = ''
  importInstances.value = null
  importPayload.value = null
  importForgetResolved.value = false
  importForgotten.value = false
  workspaceMode.value = 'pick'
  workspaces.value = null
  workspacesLoadError.value = ''
  pickedWorkspaceId.value = ''
  registerForm.value = { organization: 'Contoso-Production', project: 'Default', repository: '', owner: '' }
  registerTicketingSystem.value = defaultTicketingSystem.value
  registerStatus.value = 'idle'
  registerError.value = ''
  registerNotice.value = ''
  selectedWorkspace.value = null
  step.value = 'workspace'
  selectedDefinitionId.value = definitions.value[0]?.id ?? ''
  selectedVersion.value = 'latest'
  changelog.value = null
  changelogLoading.value = false
  draftConfirmVisible.value = false
  draftConfirmPending.value = false
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
  createNotice.value = ''
  linkStatus.value = 'idle'
  linkError.value = ''
  createdSlug.value = ''
  linkMode.value = 'create'
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
  registerNotice.value = ''
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
      const raw = body.message ?? body.error ?? `Failed to register workspace (${res.status})`
      if (/does not exist/i.test(raw) || /not visible/i.test(raw) || /not found/i.test(raw)) {
        registerError.value = 'Repository not found or not visible — Create the repository in Azure DevOps (or your Git host) first — gantry links to an existing repository, it does not create one.'
      } else {
        registerError.value = raw
      }
      return
    }
    registerStatus.value = 'idle'
    if (body.reused) {
      registerNotice.value = 'Using the workspace already registered for this repository'
    }
    selectedWorkspace.value = body
    workspaces.value = null
    step.value = 'instance'
  } catch (err) {
    registerStatus.value = 'failed'
    registerError.value = err.message
  }
}

// ---------- Server-hosted + Pick: adopt an existing repo by URL ----------

function onAdoptRepoUrlInput(value) {
  adoptRepoUrl.value = value
  if (adoptCheckStatus.value !== 'idle') {
    adoptCheckStatus.value = 'idle'
    adoptCheckMessage.value = ''
  }
}

async function checkAdoptRepo() {
  const loc = parseRepoUrl(adoptRepoUrl.value)
  if (!loc) {
    adoptCheckStatus.value = 'error'
    adoptCheckMessage.value =
      'Enter a URL like https://dev.azure.com/{organization}/{project}/_git/{repository}'
    return
  }
  adoptCheckStatus.value = 'checking'
  adoptCheckMessage.value = ''
  try {
    const qs = new URLSearchParams({ organization: loc.organization, project: loc.project, repository: loc.repository })
    const res = await apiFetch(`/api/azure-devops/repo-check?${qs}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      adoptCheckStatus.value = 'error'
      adoptCheckMessage.value = body.message ?? body.error ?? `Repo check failed (${res.status})`
      return
    }
    if (body.result === 'found') {
      adoptCheckStatus.value = 'present'
      adoptCheckMessage.value = `Instance data found: "${body.slug}"${body.definition ? ` (${body.definition})` : ''}.`
    } else if (body.result === 'multiple') {
      adoptCheckStatus.value = 'present'
      adoptCheckMessage.value = `This repository already holds multiple instances: ${(body.slugs ?? []).join(', ')}.`
    } else {
      adoptCheckStatus.value = 'absent'
      adoptCheckMessage.value = body.message ?? 'No instance data found at this repository yet.'
    }
  } catch (err) {
    adoptCheckStatus.value = 'error'
    adoptCheckMessage.value = err.message
  }
}

// On a positive repo-check, register/adopt that location as a workspace
// (POST /api/workspaces proves repo access and reuses an already-registered
// workspace for the same repo) and continue to the instance step. The final
// create step's own C4 block then detects the existing instance data and
// routes through POST /api/instances/adopt automatically.
async function adoptCheckedRepo() {
  const loc = parseRepoUrl(adoptRepoUrl.value)
  if (!loc) return
  registerStatus.value = 'registering'
  registerError.value = ''
  registerNotice.value = ''
  try {
    const res = await apiFetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization: loc.organization,
        project: loc.project,
        repository: loc.repository,
        owner: '',
        ticketingSystem: registerTicketingSystem.value,
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      registerStatus.value = 'failed'
      registerError.value = body.message ?? body.error ?? `Failed to adopt repository (${res.status})`
      return
    }
    registerStatus.value = 'idle'
    registerNotice.value = body.reused
      ? 'Using the workspace already registered for this repository'
      : 'Adopted the existing repository as a workspace'
    selectedWorkspace.value = body
    workspaces.value = null
    step.value = 'instance'
  } catch (err) {
    registerStatus.value = 'failed'
    registerError.value = err.message
  }
}

// ---------- Local + Register ----------

async function pickLocalRegisterDir() {
  localError.value = ''
  localBusy.value = true
  try {
    const handle = await pickWorkspaceDirectory()
    const top = await listDir(handle, '.')
    if (top.some((entry) => entry.name === 'gantry-workspace')) {
      localError.value =
        'That folder already contains a gantry-workspace/ — a new local workspace needs an empty or new folder. Use "Pick existing local workspace" to open it instead.'
      return
    }
    localRegHandle.value = handle
    localRegName.value = handle.name ?? ''
    localRegOwner.value = ''
    localRegStage.value = 'details'
  } catch (err) {
    // The user dismissing the picker rejects with AbortError — not an error to show.
    if (err && err.name !== 'AbortError') localError.value = err.message
  } finally {
    localBusy.value = false
  }
}

async function confirmLocalRegister() {
  localError.value = ''
  const name = localRegName.value.trim()
  const owner = localRegOwner.value.trim()
  if (!name) {
    localError.value = 'Name is required.'
    return
  }
  const handle = localRegHandle.value
  if (!handle) {
    localError.value = 'Pick a folder first.'
    return
  }
  localBusy.value = true
  try {
    const record = { name, kind: 'local', createdAt: new Date().toISOString() }
    if (owner) record.owner = owner
    await writeTextFile(handle, 'gantry-workspace/workspace.json', serializeWorkspaceJson(record))
    const id = await rememberWorkspace({ handle, name })
    localWorkspaceId.value = id
    isLocalWorkspace.value = true
    selectedWorkspace.value = { isLocal: true, name }
    step.value = 'instance'
  } catch (err) {
    localError.value = err.message
  } finally {
    localBusy.value = false
  }
}

// Writes a brand-new instance's files straight through the directory handle
// — the browser-side equivalent of createInstance's local path — then
// navigates to the editor route with `?local=<id>` so A6 can reattach the
// handle. No work-item link step for a local workspace (ADR-0029: local
// instances have no ticketing).
async function createLocalInstance() {
  createStatus.value = 'creating'
  createError.value = ''
  createNotice.value = ''
  const slug = directoryField.value.trim()
  const defId = selectedDefinitionId.value
  const version = resolvedVersion() ?? 1
  const handle = localRegHandle.value
  try {
    if (!handle) throw new Error('No local workspace folder is open.')
    const res = await fetch(
      `/api/definitions/${encodeURIComponent(defId)}/versions/${encodeURIComponent(String(version))}`
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? body.message ?? `Failed to load definition structure (${res.status})`)
    }
    const structure = await res.json()
    const firstStage = structure.stages?.[0]
    if (!firstStage) throw new Error(`Definition "${defId}" has no stages`)
    const modulesById = new Map((structure.modules ?? []).map((m) => [m.id, m]))

    const existing = await listDir(handle, 'gantry-workspace').catch(() => [])
    if (existing.some((entry) => entry.name === slug && entry.kind === 'directory')) {
      throw new Error(`"${slug}" already exists in this workspace folder — choose a different Directory.`)
    }

    await writeTextFile(
      handle,
      `gantry-workspace/${slug}/instance.yaml`,
      renderInstanceYaml({
        definition: defId,
        slug,
        stage: firstStage.id,
        assignee: assigneeField.value.trim(),
        definitionVersion: version,
      })
    )
    for (const moduleId of firstStage.modules ?? []) {
      const moduleSpec = modulesById.get(moduleId)
      if (!moduleSpec) continue
      await writeTextFile(
        handle,
        `gantry-workspace/${slug}/modules/${moduleId}.md`,
        renderLocalModuleFile(moduleSpec, {})
      )
    }
    createdSlug.value = slug
    createStatus.value = 'idle'
    window.location.assign(
      `/instance/${encodeURIComponent(slug)}?local=${encodeURIComponent(localWorkspaceId.value)}`
    )
  } catch (err) {
    createStatus.value = 'failed'
    createError.value = err.message
  }
}

// ---------- Local + Pick ----------

async function refreshLocalRecent() {
  try {
    localRecent.value = await recentLocalWorkspaces()
  } catch {
    localRecent.value = []
  }
}

async function openLocalWorkspace(handle, existingId) {
  let text
  try {
    text = await readTextFile(handle, 'gantry-workspace/workspace.json')
  } catch {
    localError.value = 'No gantry-workspace/workspace.json in that folder — it is not a local workspace.'
    return
  }
  let record
  try {
    record = parseWorkspaceJson(text)
  } catch (err) {
    localError.value = err.message
    return
  }
  const id = await rememberWorkspace({ id: existingId, handle, name: record.name })
  localWorkspaceId.value = id
  selectedWorkspace.value = { isLocal: true, name: record.name }

  const entries = await listDir(handle, 'gantry-workspace').catch(() => [])
  const found = []
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue
    try {
      await readTextFile(handle, `gantry-workspace/${entry.name}/instance.yaml`)
      found.push({ slug: entry.name })
    } catch {
      // A subdirectory with no instance.yaml is not an instance — skip it.
    }
  }
  localPickInstances.value = found
  await refreshLocalRecent()
}

async function pickLocalExistingDir() {
  localError.value = ''
  localPickInstances.value = null
  localGrantId.value = ''
  localBusy.value = true
  try {
    const handle = await pickWorkspaceDirectory()
    await openLocalWorkspace(handle)
  } catch (err) {
    if (err && err.name !== 'AbortError') localError.value = err.message
  } finally {
    localBusy.value = false
  }
}

async function useRecentLocalWorkspace(id) {
  localError.value = ''
  localGrantId.value = ''
  localPickInstances.value = null
  localBusy.value = true
  try {
    const handle = await getWorkspaceHandle(id)
    if (!handle) {
      localError.value = 'That workspace is no longer cached in this browser.'
      await refreshLocalRecent()
      return
    }
    const permission = await ensurePermission(handle)
    if (permission !== 'granted') {
      localGrantId.value = id
      return
    }
    await openLocalWorkspace(handle, id)
  } catch (err) {
    localError.value = err.message
  } finally {
    localBusy.value = false
  }
}

function openLocalInstance(slug) {
  window.location.assign(
    `/instance/${encodeURIComponent(slug)}?local=${encodeURIComponent(localWorkspaceId.value)}&slug=${encodeURIComponent(slug)}`
  )
}

// ---------- Server-hosted + Register + Import: source picker (#305) ----------
// Mirrors the Local+Pick functions above (refreshLocalRecent/
// pickLocalExistingDir/useRecentLocalWorkspace/openLocalWorkspace) exactly —
// same building blocks, kept as separate functions/signals so opening an
// import source never disturbs the top-level Local flow's own state.

async function refreshImportRecent() {
  try {
    importRecent.value = await recentLocalWorkspaces()
  } catch {
    importRecent.value = []
  }
}

async function openImportSourceWorkspace(handle, existingId) {
  let text
  try {
    text = await readTextFile(handle, 'gantry-workspace/workspace.json')
  } catch {
    importError.value = 'No gantry-workspace/workspace.json in that folder — it is not a local workspace.'
    return
  }
  let record
  try {
    record = parseWorkspaceJson(text)
  } catch (err) {
    importError.value = err.message
    return
  }
  const id = await rememberWorkspace({ id: existingId, handle, name: record.name })
  importSourceWorkspaceId.value = id
  importHandle.value = handle
  importWorkspaceName.value = record.name

  const entries = await listDir(handle, 'gantry-workspace').catch(() => [])
  const found = []
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue
    try {
      await readTextFile(handle, `gantry-workspace/${entry.name}/instance.yaml`)
      found.push({ slug: entry.name })
    } catch {
      // A subdirectory with no instance.yaml is not an instance — skip it.
    }
  }
  importInstances.value = found
  await refreshImportRecent()
}

async function pickImportSourceDir() {
  importError.value = ''
  importInstances.value = null
  importGrantId.value = ''
  importBusy.value = true
  try {
    const handle = await pickWorkspaceDirectory()
    await openImportSourceWorkspace(handle)
  } catch (err) {
    if (err && err.name !== 'AbortError') importError.value = err.message
  } finally {
    importBusy.value = false
  }
}

async function useRecentImportWorkspace(id) {
  importError.value = ''
  importGrantId.value = ''
  importInstances.value = null
  importBusy.value = true
  try {
    const handle = await getWorkspaceHandle(id)
    if (!handle) {
      importError.value = 'That workspace is no longer cached in this browser.'
      await refreshImportRecent()
      return
    }
    const permission = await ensurePermission(handle)
    if (permission !== 'granted') {
      importGrantId.value = id
      return
    }
    await openImportSourceWorkspace(handle, id)
  } catch (err) {
    importError.value = err.message
  } finally {
    importBusy.value = false
  }
}

// btoa over a Uint8Array, chunked so a large asset never blows the call
// stack on String.fromCharCode's own argument-spreading.
function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

// Reads the full content of one local instance — instance.yaml, every
// modules/*.md file's raw text, every assets/* file's raw bytes — into
// `importPayload`. Deliberately never reads anything under out/ (#305:
// "explicitly NOT out/" — previously rendered artefacts are regenerable and
// would just be dead weight in the destination repo), and never re-parses
// or re-renders a module file: the text read here is pushed to the
// destination byte-for-byte (see importInstanceToAzureDevOps), since it is
// already valid gantry module-file text.
async function loadImportSource(slug) {
  importError.value = ''
  importBusy.value = true
  try {
    const handle = importHandle.value
    const yamlText = await readTextFile(handle, `gantry-workspace/${slug}/instance.yaml`)
    const instanceYaml = parseInstanceYaml(yamlText)

    const moduleEntries = await listDir(handle, `gantry-workspace/${slug}/modules`).catch(() => [])
    const modules = []
    for (const entry of moduleEntries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
      const text = await readTextFile(handle, `gantry-workspace/${slug}/modules/${entry.name}`)
      modules.push({ id: entry.name.slice(0, -'.md'.length), text })
    }

    const assetEntries = await listDir(handle, `gantry-workspace/${slug}/assets`).catch(() => [])
    const assets = []
    for (const entry of assetEntries) {
      if (entry.kind !== 'file') continue
      const bytes = await readBinaryFile(handle, `gantry-workspace/${slug}/assets/${entry.name}`)
      assets.push({ filename: entry.name, base64: bytesToBase64(bytes) })
    }

    importPayload.value = { slug, instanceYaml, stage: instanceYaml.stage, modules, assets }
    importStage.value = 'destination'
  } catch (err) {
    importError.value = err.message
  } finally {
    importBusy.value = false
  }
}

// Pre-fills the Instance step from the loaded import payload's own
// instance.yaml, once a destination workspace has been chosen — "land on a
// populated Instance step (not blank)" (#305's own acceptance criterion).
// The wizard's Name field has no server-side counterpart (POST /api/instances
// and POST /api/instances/import both ignore it — it only ever seeds
// Directory's own slugify default), so it's simply pre-filled with the
// source slug; Directory follows it via the existing auto-slugify effect.
function applyImportPrefill() {
  const payload = importPayload.value
  if (!payload) return
  const y = payload.instanceYaml ?? {}
  if (y.definition) selectedDefinitionId.value = y.definition
  selectedVersion.value = y.definitionVersion != null ? String(y.definitionVersion) : 'latest'
  directoryTouched.value = false
  nameField.value = payload.slug
  assigneeField.value = y.assignee ?? ''
}

// Wrap the existing registerWorkspace()/pickWorkspace() destination actions
// (used unchanged by "Start blank") so the Import path applies the source
// instance's own content to the Instance step the moment a destination
// workspace is actually chosen, rather than leaving it blank.
async function continueImportToNewWorkspace() {
  await registerWorkspace()
  if (selectedWorkspace.value) applyImportPrefill()
}

function continueImportToExistingWorkspace() {
  pickWorkspace()
  if (selectedWorkspace.value) applyImportPrefill()
}

// The opt-in, post-success "Remove from this browser's local workspaces?"
// prompt's accept branch (#305) — forgetWorkspace only ever clears this
// browser's own IndexedDB "remembered workspace" entry; nothing on disk is
// touched either way, which is why both this and declining are safe no-ops
// against the folder itself.
async function confirmForgetImportSource() {
  try {
    await forgetWorkspace(importSourceWorkspaceId.value)
    importForgotten.value = true
  } catch {
    // Best-effort — the source folder and its files are untouched regardless.
  } finally {
    importForgetResolved.value = true
  }
}

function declineForgetImportSource() {
  importForgetResolved.value = true
}

function selectedDefinition() {
  return definitions.value.find((d) => d.id === selectedDefinitionId.value) ?? null
}

function resolvedVersion() {
  const def = selectedDefinition()
  if (!def) return null
  if (selectedVersion.value === 'latest') return def.latestPublished
  return Number(selectedVersion.value)
}

function resolvedVersionStatus() {
  const def = selectedDefinition()
  if (!def) return null
  const v = resolvedVersion()
  const entry = def.versions.find((x) => x.version === v)
  return entry?.status ?? null
}

// Fire-and-forget fetch of the selected version's changelog (#234) — never blocks instance creation, independent state.
effect(() => {
  const def = selectedDefinition()
  const v = resolvedVersion()
  if (!def || v == null) {
    changelog.value = null
    changelogLoading.value = false
    return
  }
  const id = def.id
  changelogLoading.value = true
  changelog.value = null
  fetch(`/api/definitions/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(v))}/changelog`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`changelog fetch failed (${res.status})`)
      const body = await res.json()
      return body.changelog
    })
    .then((text) => {
      changelog.value = text
    })
    .catch(() => {
      changelog.value = null
    })
    .finally(() => {
      changelogLoading.value = false
    })
})

function continueFromInstanceStep() {
  if (!nameField.value.trim() || !directoryField.value.trim() || !selectedDefinitionId.value) return
  if (resolvedVersionStatus() === 'draft' && !draftConfirmPending.value) {
    draftConfirmVisible.value = true
    return
  }
  draftConfirmPending.value = false
  draftConfirmVisible.value = false
  if (isLocalWorkspace.value) {
    createLocalInstance()
    return
  }
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
  // If draft selected without prior confirmation, show confirm dialog from link step too
  if (resolvedVersionStatus() === 'draft' && !draftConfirmPending.value) {
    draftConfirmVisible.value = true
    return
  }
  draftConfirmVisible.value = false
  createStatus.value = 'creating'
  createError.value = ''
  createNotice.value = ''
  linkError.value = ''
  newWorkItemCreateError.value = ''
  const ws = selectedWorkspace.value
  const slug = directoryField.value.trim()
  const versionToSend = resolvedVersion()

  let actualSlug = slug
  if (importPayload.value) {
    // #305 — import: write the source local instance's real content (not a
    // blank template) via POST /api/instances/import. No C4 adopt-check
    // here — an import always creates a brand-new destination instance at
    // this slug; a slug already in use there is rejected with the same
    // 409/message the blank-create path already gives (reused server-side
    // by the same resolveInstanceLocation() guard), never silently adopted.
    try {
      const res = await apiFetch('/api/instances/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: selectedDefinitionId.value,
          slug,
          assignee: assigneeField.value.trim(),
          definitionVersion: versionToSend,
          azureDevOps: { organization: ws.organization, project: ws.project, repository: ws.repository, ...(ws.baseUrl ? { baseUrl: ws.baseUrl } : {}) },
          stage: importPayload.value.stage,
          modules: importPayload.value.modules,
          assets: importPayload.value.assets,
        }),
      }, { workspaceId: ws.id })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        createStatus.value = 'failed'
        createError.value = body.message ?? body.error ?? `Failed to import instance (${res.status})`
        return
      }
      createdSlug.value = slug
      actualSlug = slug
    } catch (err) {
      createStatus.value = 'failed'
      createError.value = err.message
      return
    }
  } else {
    // C4 — check whether this repo already holds instance data for this slug
    let shouldAdopt = false
    try {
      const qs = new URLSearchParams({ organization: ws.organization, project: ws.project, repository: ws.repository })
      if (ws.baseUrl) qs.set('baseUrl', ws.baseUrl)
      const checkRes = await apiFetch(`/api/azure-devops/repo-check?${qs}`, {}, { workspaceId: ws.id })
      const checkBody = await checkRes.json().catch(() => ({}))
      if (checkRes.ok) {
        if (checkBody.result === 'found' && checkBody.slug === slug) shouldAdopt = true
        else if (checkBody.result === 'multiple' && Array.isArray(checkBody.slugs) && checkBody.slugs.includes(slug)) shouldAdopt = true
      }
    } catch (_) {
      // ignore — fall through to create path
    }

    if (shouldAdopt) {
      try {
        const res = await apiFetch('/api/instances/adopt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            azureDevOps: { organization: ws.organization, project: ws.project, repository: ws.repository, ...(ws.baseUrl ? { baseUrl: ws.baseUrl } : {}) },
          }),
        }, { workspaceId: ws.id })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          createStatus.value = 'failed'
          createError.value = body.message ?? body.error ?? `Failed to adopt instance (${res.status})`
          return
        }
        createNotice.value = 'An instance already exists in this repository — linking to it'
        actualSlug = body.slug ?? slug
        createdSlug.value = actualSlug
      } catch (err) {
        createStatus.value = 'failed'
        createError.value = err.message
        return
      }
    } else {
      try {
        const res = await apiFetch('/api/instances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            definition: selectedDefinitionId.value,
            slug,
            assignee: assigneeField.value.trim(),
            definitionVersion: versionToSend,
            azureDevOps: { organization: ws.organization, project: ws.project, repository: ws.repository, ...(ws.baseUrl ? { baseUrl: ws.baseUrl } : {}) },
          }),
        }, { workspaceId: ws.id })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          createStatus.value = 'failed'
          createError.value = body.message ?? body.error ?? `Failed to create instance (${res.status})`
          return
        }
        createdSlug.value = slug
        actualSlug = slug
      } catch (err) {
        createStatus.value = 'failed'
        createError.value = err.message
        return
      }
    }
  }

  // The parent-work-item link is mandatory for a ticketing-enabled
  // Workspace (#126's own acceptance criterion — every instance in such a
  // Workspace is trackable on the board from day one), so this always
  // fires immediately after a successful create when step 'link' was
  // actually reached — never a separate, skippable action.
  if (step.value === 'link') {
    let parentIdToLink = null
    if (linkMode.value === 'create') {
      newWorkItemCreateStatus.value = 'creating'
      newWorkItemCreateError.value = ''
      try {
        const res = await apiFetch('/api/azure-devops/work-items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            organization: ws.organization,
            project: ws.project,
            workItemType: workItemTypeField.value,
            title: newWorkItemTitle.value.trim(),
            ...(ws.baseUrl ? { baseUrl: ws.baseUrl } : {}),
          }),
        }, { workspaceId: ws.id })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          newWorkItemCreateStatus.value = 'failed'
          newWorkItemCreateError.value = body.message ?? body.error ?? `Failed to create work item (${res.status})`
          createStatus.value = 'failed'
          return
        }
        newWorkItemCreateStatus.value = 'idle'
        parentIdToLink = body.id
      } catch (err) {
        newWorkItemCreateStatus.value = 'failed'
        newWorkItemCreateError.value = err.message
        createStatus.value = 'failed'
        return
      }
    } else {
      parentIdToLink = Number(parentIdField.value.trim())
    }
    linkStatus.value = 'linking'
    linkError.value = ''
    try {
      const res = await apiFetch(`/api/instance/work-items/link?slug=${encodeURIComponent(actualSlug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization: ws.organization,
          project: ws.project,
          parentId: parentIdToLink,
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

function WorkspaceLocationToggle() {
  return html`
    <div class="wizard-field">
      <label>Workspace location</label>
      <div class="wizard-mode-toggle" role="group" aria-label="Workspace location">
        <button
          type="button"
          class=${'btn small' + (workspaceLocation.value === 'server' ? ' active' : '')}
          onClick=${() => (workspaceLocation.value = 'server')}
        >
          Server-hosted
        </button>
        <button
          type="button"
          class=${'btn small' + (workspaceLocation.value === 'local' ? ' active' : '')}
          onClick=${() => (workspaceLocation.value = 'local')}
        >
          Local
        </button>
      </div>
      ${workspaceLocation.value === 'local'
        ? html`<p class="wizard-field-hint">A local workspace keeps this instance's data in a folder on your own machine — never sent to the gantry server.</p>`
        : null}
    </div>
  `
}

function LocalWorkspacePanel() {
  useEffect(() => {
    refreshLocalRecent()
  }, [])

  if (!localWorkspaceSupported) {
    return html`
      <div class="wizard-field">
        <p class="inline-error" id="local-unsupported">Local workspaces need Chrome or Edge.</p>
        <p class="wizard-field-hint">
          This browser does not support the File System Access API.
          ${advancedMode.value
            ? ' Switch to "Server-hosted" above to continue, or reopen gantry in Chrome or Edge.'
            : ' Reopen gantry in Chrome or Edge to continue.'}
        </p>
        ${!advancedMode.value
          ? html`<p class="wizard-field-hint" id="local-unsupported-advanced-hint">
              Enable advanced mode in Settings to use a server-hosted workspace instead.
            </p>`
          : null}
        <button type="button" class="btn primary" disabled>
          ${workspaceMode.value === 'register' ? 'Create local workspace' : 'Open local workspace'}
        </button>
      </div>
    `
  }

  return html`
    <div class="wizard-field">
      ${workspaceMode.value === 'register'
        ? html`
            ${localRegStage.value === 'pick'
              ? html`
                  <p class="wizard-field-hint">
                    Pick a new or empty folder — gantry writes <code>gantry-workspace/</code> inside it.
                  </p>
                  <button
                    type="button"
                    class="btn primary"
                    id="local-register-pick"
                    disabled=${localBusy.value}
                    onClick=${pickLocalRegisterDir}
                  >
                    ${localBusy.value ? 'Waiting for folder…' : 'Choose folder'}
                  </button>
                `
              : html`
                  <div class="wizard-field">
                    <label for="local-ws-name">Name</label>
                    <input
                      class="wizard-input"
                      id="local-ws-name"
                      type="text"
                      value=${localRegName.value}
                      onInput=${(e) => (localRegName.value = e.currentTarget.value)}
                    />
                  </div>
                  <div class="wizard-field">
                    <label for="local-ws-owner">Owner</label>
                    <input
                      class="wizard-input"
                      id="local-ws-owner"
                      type="text"
                      value=${localRegOwner.value}
                      placeholder="Optional"
                      onInput=${(e) => (localRegOwner.value = e.currentTarget.value)}
                    />
                  </div>
                  <div class="wizard-field" style="display:flex;gap:8px">
                    <button
                      type="button"
                      class="btn ghost"
                      onClick=${() => {
                        localRegStage.value = 'pick'
                        localRegHandle.value = null
                      }}
                    >
                      ← Choose a different folder
                    </button>
                    <button
                      type="button"
                      class="btn primary"
                      id="local-register-create"
                      disabled=${localBusy.value || !localRegName.value.trim()}
                      onClick=${confirmLocalRegister}
                    >
                      ${localBusy.value ? 'Creating…' : 'Create local workspace'}
                    </button>
                  </div>
                `}
          `
        : html`
            <p class="wizard-field-hint">
              Open a folder that already contains a <code>gantry-workspace/workspace.json</code>.
            </p>
            <button
              type="button"
              class="btn primary"
              id="local-pick-open"
              disabled=${localBusy.value}
              onClick=${pickLocalExistingDir}
            >
              ${localBusy.value ? 'Waiting for folder…' : 'Open folder'}
            </button>

            ${localRecent.value.length
              ? html`
                  <div class="wizard-field" style="margin-top:16px">
                    <label>Recent local workspaces</label>
                    <div id="local-recent">
                      ${localRecent.value.map(
                        (entry) => html`
                          <div key=${entry.id} class="definition-card">
                            <div class="name">${entry.name}</div>
                            <div class="stages">last opened ${entry.lastOpened}</div>
                            ${localGrantId.value === entry.id
                              ? html`
                                  <button
                                    type="button"
                                    class="btn small"
                                    onClick=${() => useRecentLocalWorkspace(entry.id)}
                                  >
                                    Grant access
                                  </button>
                                `
                              : html`
                                  <button
                                    type="button"
                                    class="btn small"
                                    disabled=${localBusy.value}
                                    onClick=${() => useRecentLocalWorkspace(entry.id)}
                                  >
                                    Open
                                  </button>
                                `}
                          </div>
                        `
                      )}
                    </div>
                  </div>
                `
              : null}

            ${localPickInstances.value !== null
              ? html`
                  <div class="wizard-field" style="margin-top:16px">
                    <label>Instances in ${selectedWorkspace.value?.name ?? 'this workspace'}</label>
                    ${localPickInstances.value.length === 0
                      ? html`<p class="wizard-field-hint">This workspace has no instances yet.</p>`
                      : html`
                          <div id="local-instance-picker">
                            ${localPickInstances.value.map(
                              (inst) => html`
                                <div
                                  key=${inst.slug}
                                  class="definition-card"
                                  onClick=${() => openLocalInstance(inst.slug)}
                                >
                                  <div class="name">${inst.slug}</div>
                                </div>
                              `
                            )}
                          </div>
                        `}
                  </div>
                `
              : null}
          `}
      ${localError.value ? html`<div class="inline-error" id="local-error">${localError.value}</div>` : null}
    </div>
  `
}

// ---------- Server-hosted + Register + Import: source picker (#305) ----------
// Same shape as LocalWorkspacePanel's own "Pick existing" branch — a "recent
// local workspaces" list (with a "Grant access" affordance for a lapsed
// handle) plus "Open folder", then the source workspace's own instance list.
function ImportSourcePanel() {
  useEffect(() => {
    refreshImportRecent()
  }, [])

  if (!localWorkspaceSupported) {
    return html`
      <div class="wizard-field">
        <p class="inline-error" id="import-unsupported">Importing from a local workspace needs Chrome or Edge.</p>
        <p class="wizard-field-hint">This browser does not support the File System Access API — use "Start blank" above instead.</p>
      </div>
    `
  }

  return html`
    <div class="wizard-field">
      <p class="wizard-field-hint">Open the local workspace that holds the instance you want to import.</p>
      <button
        type="button"
        class="btn primary"
        id="import-pick-open"
        disabled=${importBusy.value}
        onClick=${pickImportSourceDir}
      >
        ${importBusy.value ? 'Waiting for folder…' : 'Open folder'}
      </button>

      ${importRecent.value.length
        ? html`
            <div class="wizard-field" style="margin-top:16px">
              <label>Recent local workspaces</label>
              <div id="import-recent">
                ${importRecent.value.map(
                  (entry) => html`
                    <div key=${entry.id} class="definition-card">
                      <div class="name">${entry.name}</div>
                      <div class="stages">last opened ${entry.lastOpened}</div>
                      ${importGrantId.value === entry.id
                        ? html`
                            <button type="button" class="btn small" onClick=${() => useRecentImportWorkspace(entry.id)}>
                              Grant access
                            </button>
                          `
                        : html`
                            <button
                              type="button"
                              class="btn small"
                              disabled=${importBusy.value}
                              onClick=${() => useRecentImportWorkspace(entry.id)}
                            >
                              Open
                            </button>
                          `}
                    </div>
                  `
                )}
              </div>
            </div>
          `
        : null}

      ${importInstances.value !== null
        ? html`
            <div class="wizard-field" style="margin-top:16px">
              <label>Instances in ${importWorkspaceName.value || 'this workspace'}</label>
              ${importInstances.value.length === 0
                ? html`<p class="wizard-field-hint">This workspace has no instances yet.</p>`
                : html`
                    <div id="import-instance-picker">
                      ${importInstances.value.map(
                        (inst) => html`
                          <div key=${inst.slug} class="definition-card" onClick=${() => loadImportSource(inst.slug)}>
                            <div class="name">${inst.slug}</div>
                          </div>
                        `
                      )}
                    </div>
                  `}
            </div>
          `
        : null}
      ${importError.value ? html`<div class="inline-error" id="import-error">${importError.value}</div>` : null}
    </div>
  `
}

// ---------- Server-hosted + Register + Import: destination picker (#305) ----------
// "New server workspace" reuses the exact same org/project/repository/owner/
// ticketing form as the "Start blank" Register panel (registerForm/
// registerTicketingSystem/registerWorkspace); "An already-registered server
// workspace" reuses the exact same list as the top-level "Pick existing
// workspace" mode (workspaces/pickedWorkspaceId/pickWorkspace) — #305 calls
// for the same picker, not a new one.
function ImportDestinationPanel() {
  useEffect(() => {
    if (importDestMode.value === 'existing' && workspaces.value === null) loadWorkspaces()
  }, [importDestMode.value])

  return html`
    <div class="wizard-field">
      <p class="wizard-field-hint">
        Importing "${importPayload.value?.slug}" from "${importWorkspaceName.value}" — choose where it goes.
      </p>
      <div class="wizard-mode-toggle" role="group" aria-label="Import destination">
        <button
          type="button"
          class=${'btn small' + (importDestMode.value === 'new' ? ' active' : '')}
          onClick=${() => (importDestMode.value = 'new')}
        >
          New server workspace
        </button>
        <button
          type="button"
          class=${'btn small' + (importDestMode.value === 'existing' ? ' active' : '')}
          onClick=${() => (importDestMode.value = 'existing')}
        >
          An already-registered server workspace
        </button>
      </div>
    </div>

    ${importDestMode.value === 'new'
      ? html`
          <div class="wizard-field">
            <label for="import-ws-organization">Organization</label>
            <input
              class="wizard-input"
              id="import-ws-organization"
              type="text"
              value=${registerForm.value.organization}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, organization: e.currentTarget.value })}
            />
          </div>
          <div class="wizard-field">
            <label for="import-ws-project">Project</label>
            <input
              class="wizard-input"
              id="import-ws-project"
              type="text"
              value=${registerForm.value.project}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, project: e.currentTarget.value })}
            />
          </div>
          <div class="wizard-field">
            <label for="import-ws-repository">Repository</label>
            <input
              class="wizard-input"
              id="import-ws-repository"
              type="text"
              value=${registerForm.value.repository}
              onInput=${(e) => (registerForm.value = { ...registerForm.value, repository: e.currentTarget.value })}
            />
            <p class="wizard-field-hint">Create the repository in Azure DevOps (or your Git host) first — gantry links to an existing repository, it does not create one.</p>
          </div>
          <div class="wizard-field">
            <label for="import-ws-owner">Owner</label>
            <${IdentityPicker}
              id="import-ws-owner"
              value=${registerForm.value.owner}
              onChange=${(uniqueName) => (registerForm.value = { ...registerForm.value, owner: uniqueName })}
              placeholder="Search by name…"
              organization=${registerForm.value.organization}
              project=${registerForm.value.project}
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
                      name="import-ws-ticketing-system"
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
              id="import-register-workspace"
              disabled=${registerStatus.value === 'registering' ||
              !registerForm.value.organization.trim() ||
              !registerForm.value.project.trim() ||
              !registerForm.value.repository.trim()}
              onClick=${continueImportToNewWorkspace}
            >
              ${registerStatus.value === 'registering' ? 'Registering…' : 'Register & continue'}
            </button>
            ${registerNotice.value ? html`<div class="wizard-field-hint">${registerNotice.value}</div>` : null}
            ${registerStatus.value === 'failed' ? html`<div class="inline-error">${registerError.value}</div>` : null}
          </div>
        `
      : html`
          <div class="wizard-field">
            ${workspacesLoadError.value ? html`<p class="load-error">${workspacesLoadError.value}</p>` : null}
            ${workspaces.value === null && !workspacesLoadError.value ? html`<p class="loading">Loading…</p>` : null}
            ${workspaces.value?.length === 0 ? html`<p class="wizard-field-hint">No workspaces registered yet — use "New server workspace" instead.</p>` : null}
            ${workspaces.value?.length
              ? html`
                  <div id="import-workspace-picker">
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
                    <button
                      type="button"
                      class="btn primary"
                      id="import-pick-workspace-continue"
                      disabled=${!pickedWorkspaceId.value}
                      onClick=${continueImportToExistingWorkspace}
                    >
                      Continue
                    </button>
                  </div>
                `
              : null}
          </div>
        `}

    <div class="wizard-field">
      <button
        type="button"
        class="btn ghost"
        onClick=${() => {
          importStage.value = 'source'
          importPayload.value = null
        }}
      >
        ← Choose a different instance
      </button>
    </div>
  `
}

function WorkspaceStep() {
  useEffect(() => {
    if (
      workspaceLocation.value === 'server' &&
      workspaceMode.value === 'pick' &&
      workspaces.value === null
    )
      loadWorkspaces()
  }, [workspaceMode.value, workspaceLocation.value])

  return html`
    ${advancedMode.value ? html`<${WorkspaceLocationToggle} />` : null}

    <div class="wizard-field">
      <div class="wizard-mode-toggle" role="group" aria-label="Workspace source">
        <button
          type="button"
          class=${'btn small' + (workspaceMode.value === 'pick' ? ' active' : '')}
          onClick=${() => (workspaceMode.value = 'pick')}
        >
          ${workspaceLocation.value === 'local' ? 'Pick existing local workspace' : 'Pick existing workspace'}
        </button>
        <button
          type="button"
          class=${'btn small' + (workspaceMode.value === 'register' ? ' active' : '')}
          onClick=${() => (workspaceMode.value = 'register')}
        >
          ${workspaceLocation.value === 'local' ? 'Register new local workspace' : 'Register new workspace'}
        </button>
      </div>
    </div>

    ${workspaceLocation.value === 'local' ? html`<${LocalWorkspacePanel} />` : null}

    ${workspaceLocation.value === 'server' && workspaceMode.value === 'pick'
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

            <div class="wizard-field" style="margin-top:16px">
              <label for="adopt-repo-url">Azure DevOps repo URL</label>
              <div class="workspace-field-row">
                <input
                  class="wizard-input"
                  id="adopt-repo-url"
                  type="text"
                  placeholder="https://dev.azure.com/{organization}/{project}/_git/{repository}"
                  value=${adoptRepoUrl.value}
                  onInput=${(e) => onAdoptRepoUrlInput(e.currentTarget.value)}
                />
                <button
                  type="button"
                  class="btn small"
                  disabled=${!adoptRepoUrl.value.trim() || adoptCheckStatus.value === 'checking'}
                  onClick=${checkAdoptRepo}
                >
                  ${adoptCheckStatus.value === 'checking' ? 'Checking…' : 'Check repo'}
                </button>
              </div>
              <p class="wizard-field-hint">
                Point at a repo that already holds a gantry workspace — gantry checks it and adopts the
                existing instance data.
              </p>
              ${adoptCheckStatus.value === 'present'
                ? html`<p class="wizard-field-hint" id="adopt-check-result">${adoptCheckMessage.value}</p>`
                : null}
              ${adoptCheckStatus.value === 'absent'
                ? html`<div class="inline-error" id="adopt-check-result">${adoptCheckMessage.value}</div>`
                : null}
              ${adoptCheckStatus.value === 'error'
                ? html`<div class="inline-error" id="adopt-check-result">${adoptCheckMessage.value}</div>`
                : null}
              ${adoptCheckStatus.value === 'present'
                ? html`
                    <div style="margin-top:8px">
                      <button
                        type="button"
                        class="btn primary"
                        disabled=${registerStatus.value === 'registering'}
                        onClick=${adoptCheckedRepo}
                      >
                        ${registerStatus.value === 'registering' ? 'Adopting…' : 'Use this repository'}
                      </button>
                      ${registerStatus.value === 'failed' ? html`<div class="inline-error">${registerError.value}</div>` : null}
                    </div>
                  `
                : null}
            </div>
          </div>
        `
      : null}

    ${workspaceLocation.value === 'server' && workspaceMode.value === 'register'
      ? html`
          <div class="wizard-field">
            <div class="wizard-mode-toggle" role="group" aria-label="Register data source">
              <button
                type="button"
                class=${'btn small' + (registerDataSource.value === 'blank' ? ' active' : '')}
                onClick=${() => (registerDataSource.value = 'blank')}
              >
                Start blank
              </button>
              <button
                type="button"
                class=${'btn small' + (registerDataSource.value === 'import' ? ' active' : '')}
                onClick=${() => (registerDataSource.value = 'import')}
              >
                Import from local workspace
              </button>
            </div>
          </div>
        `
      : null}

    ${workspaceLocation.value === 'server' && workspaceMode.value === 'register' && registerDataSource.value === 'import'
      ? importStage.value === 'source'
        ? html`<${ImportSourcePanel} />`
        : html`<${ImportDestinationPanel} />`
      : null}

    ${workspaceLocation.value === 'server' && workspaceMode.value === 'register' && registerDataSource.value === 'blank'
      ? html`
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
            <p class="wizard-field-hint">Create the repository in Azure DevOps (or your Git host) first — gantry links to an existing repository, it does not create one.</p>
          </div>
          <div class="wizard-field">
            <label for="ws-owner">Owner</label>
            <${IdentityPicker}
              id="ws-owner"
              value=${registerForm.value.owner}
              onChange=${(uniqueName) => (registerForm.value = { ...registerForm.value, owner: uniqueName })}
              placeholder="Search by name…"
              organization=${registerForm.value.organization}
              project=${registerForm.value.project}
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
            ${registerNotice.value ? html`<div class="wizard-field-hint">${registerNotice.value}</div>` : null}
            ${registerStatus.value === 'failed' ? html`<div class="inline-error">${registerError.value}</div>` : null}
          </div>
        `
      : null}
  `
}

function InstanceStep() {
  const ws = selectedWorkspace.value
  const ticketingEnabled = Boolean(ws?.ticketingSystem)

  return html`
    <div class="result-card">
      <h3><span class="stamp agreed">Workspace</span></h3>
      ${ws.isLocal
        ? html`<div class="result-row"><span class="k">Local workspace</span><span class="v">${ws.name}</span></div>`
        : html`<div class="result-row"><span class="k">Organization/Project/Repository</span><span class="v">${ws.organization}/${ws.project}/${ws.repository}</span></div>`}
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
              onClick=${() => {
                selectedDefinitionId.value = d.id
                selectedVersion.value = 'latest'
                draftConfirmPending.value = false
              }}
            >
              <div class="name">${d.title} (${d.id})</div>
              <div class="stages">${d.stages.map((s) => s.title).join(' → ')}</div>
              ${d.description ? html`<div class="wizard-field-hint">${d.description}</div>` : null}
            </div>
          `
        )}
      </div>
    </div>

    ${(() => {
      const def = selectedDefinition()
      if (!def || !def.versions) return null
      return html`
        <div class="wizard-field">
          <label for="definition-version">Version</label>
          <select
            id="definition-version"
            class="wizard-input"
            value=${selectedVersion.value}
            onChange=${(e) => {
              selectedVersion.value = e.currentTarget.value
              draftConfirmPending.value = false
            }}
          >
            <option value="latest">Latest (v${def.latestPublished ?? '—'}) — published</option>
            ${def.versions.map((v) => html`<option value=${String(v.version)}>v${v.version} — ${v.status}</option>`)}
          </select>
          <p class="wizard-field-hint">Draft versions require confirmation before creating an instance.</p>
          ${(() => {
            if (changelogLoading.value) return html`<p class="wizard-field-hint">Loading changelog…</p>`
            if (changelog.value == null) return html`<p class="wizard-field-hint">No changelog for this version.</p>`
            return html`<div class="wizard-changelog" dangerouslySetInnerHTML=${{ __html: renderMarkdown(changelog.value) }} />`
          })()}
        </div>
      `
    })()}

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
      <${IdentityPicker}
        id="instance-assignee"
        value=${assigneeField.value}
        onChange=${(uniqueName) => (assigneeField.value = uniqueName)}
        placeholder="Unassigned"
        organization=${ws?.organization}
        project=${ws?.project}
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
    ${draftConfirmVisible.value
      ? html`
          <div class="wizard-confirm" role="dialog" aria-label="Draft version confirmation">
            <p>You're creating an instance from an unpublished draft version.</p>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button type="button" class="btn primary" onClick=${() => {
                draftConfirmPending.value = true
                draftConfirmVisible.value = false
                continueFromInstanceStep()
              }}>Confirm</button>
              <button type="button" class="btn ghost" onClick=${() => (draftConfirmVisible.value = false)}>Cancel</button>
            </div>
          </div>
        `
      : null}
    ${createNotice.value ? html`<div class="wizard-field-hint">${createNotice.value}</div>` : null}
    ${createStatus.value === 'failed' ? html`<div class="inline-error">${createError.value}</div>` : null}
  `
}

function LinkStep() {
  const ws = selectedWorkspace.value

  useEffect(() => {
    loadWorkItemTypes()
    // eslint-disable-next-line
  }, [])

  const canSubmitCreate =
    Boolean(newWorkItemTitle.value.trim()) &&
    Boolean(workItemTypeField.value) &&
    createStatus.value !== 'creating' &&
    linkStatus.value !== 'linking' &&
    newWorkItemCreateStatus.value !== 'creating'
  const canSubmitExisting =
    lookupStatus.value === 'found' &&
    Boolean(workItemTypeField.value) &&
    createStatus.value !== 'creating' &&
    linkStatus.value !== 'linking'
  const canSubmit = linkMode.value === 'create' ? canSubmitCreate : canSubmitExisting

  return html`
    <div class="wizard-field" role="group" aria-label="Link mode">
      <button type="button" class=${'btn small' + (linkMode.value === 'create' ? ' active' : '')} onClick=${() => (linkMode.value = 'create')}>Create a new parent work item</button>
      <button type="button" class=${'btn small' + (linkMode.value === 'existing' ? ' active' : '')} onClick=${() => (linkMode.value = 'existing')}>Link an existing parent work item</button>
    </div>

    <div class="wizard-field">
      <label for="link-organization">Organization</label>
      <input class="wizard-input" id="link-organization" type="text" value=${ws.organization} disabled />
    </div>
    <div class="wizard-field">
      <label for="link-project">Project</label>
      <input class="wizard-input" id="link-project" type="text" value=${ws.project} disabled />
    </div>

    ${linkMode.value === 'create'
      ? html`
          <div class="wizard-field">
            <label for="new-work-item-title">Title</label>
            <input
              class="wizard-input"
              id="new-work-item-title"
              type="text"
              value=${newWorkItemTitle.value}
              onInput=${(e) => (newWorkItemTitle.value = e.currentTarget.value)}
            />
          </div>
        `
      : html`
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
        `}

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
        ${createStatus.value === 'creating' ? 'Creating…' : linkStatus.value === 'linking' ? 'Linking…' : newWorkItemCreateStatus.value === 'creating' ? 'Creating work item…' : 'Create instance & link'}
      </button>
    </div>
    ${draftConfirmVisible.value
      ? html`
          <div class="wizard-confirm" role="dialog" aria-label="Draft version confirmation">
            <p>You're creating an instance from an unpublished draft version.</p>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button type="button" class="btn primary" onClick=${() => {
                draftConfirmPending.value = true
                draftConfirmVisible.value = false
                createInstanceAndMaybeLink()
              }}>Confirm</button>
              <button type="button" class="btn ghost" onClick=${() => (draftConfirmVisible.value = false)}>Cancel</button>
            </div>
          </div>
        `
      : null}
    ${createNotice.value ? html`<div class="wizard-field-hint">${createNotice.value}</div>` : null}
    ${createStatus.value === 'failed' ? html`<div class="inline-error">${createError.value}</div>` : null}
    ${linkStatus.value === 'failed' ? html`<div class="inline-error">${linkError.value}</div>` : null}
    ${newWorkItemCreateStatus.value === 'failed' ? html`<div class="inline-error">${newWorkItemCreateError.value}</div>` : null}
  `
}

function DoneStep() {
  return html`
    <div class="result-card">
      <h3><span class="stamp agreed">Instance created</span></h3>
      <p class="result-note">"${createdSlug.value}" is registered and appears in gantry's instance listing.</p>
      <button type="button" class="btn primary" onClick=${() => openInstance(createdSlug.value)}>Open instance</button>
      <button type="button" class="btn ghost" onClick=${resetWizard}>Create another</button>
      ${importPayload.value ? html`<${ImportForgetPrompt} />` : null}
    </div>
  `
}

// The opt-in "Remove from this browser's local workspaces?" prompt (#305) —
// shown once, on a successful import, resolved either branch exactly once.
// forgetWorkspace only ever clears this browser's own IndexedDB
// "remembered workspace" entry; nothing on disk is touched either way, which
// this states plainly so declining is a genuinely safe default.
function ImportForgetPrompt() {
  if (importForgetResolved.value) {
    return importForgotten.value
      ? html`<p class="wizard-field-hint" id="import-forgotten-notice">Removed "${importWorkspaceName.value}" from this browser's local workspaces. The folder on disk — and every file in it — is untouched.</p>`
      : null
  }
  return html`
    <div class="wizard-field" id="import-forget-prompt" style="margin-top:16px">
      <p class="wizard-field-hint">
        Remove "${importWorkspaceName.value}" from this browser's local workspaces? Nothing on disk is deleted
        either way — this only clears this browser's own remembered-workspace entry; the folder and every file in
        it stay exactly as they are.
      </p>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn" id="import-forget-yes" onClick=${confirmForgetImportSource}>
          Remove from this browser
        </button>
        <button type="button" class="btn ghost" id="import-forget-no" onClick=${declineForgetImportSource}>
          Keep it remembered
        </button>
      </div>
    </div>
  `
}

export function NewWorkspaceWizardPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ws = params.get('workspace')
    if (ws) {
      preselectedWorkspaceId.value = ws
      if (workspaces.value === null) loadWorkspaces()
    }
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
