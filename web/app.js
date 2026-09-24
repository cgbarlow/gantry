// gantry's production UI entry point — Preact, delivered via HTM tagged templates with no build step, per docs/adr/0006-preact-frontend-framework.md. `preact-iso` provides the routing shell — the instance dashboard (#77) at `/`, the module editor at `/instance/:slug`, the "+ New Workspace" wizard at `/new-workspace` (see web/pages/new-workspace-wizard.js, #110/#126, which replaced the old URL-first instance-setup wizard entirely) — and `@preact/signals` holds the instance-scoped state (the viewed slug and stage, the fetched instance data) that's shared across the module editor screen's header, nav, and module list, exactly as today's DOM version threaded a `stageId` through a single re-render function.
import { html, render } from 'htm/preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { signal, effect, batch } from '@preact/signals'
import { LocationProvider, Router, Route, useLocation } from 'preact-iso'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment, Annotation, Transaction } from '@codemirror/state'
// `keymap` lives in @codemirror/view (the same module 'codemirror' re-exports
// EditorView from); imported directly so the toolbar's shortcut layer sits in
// one obvious place next to the command transforms it drives.
import { keymap } from '@codemirror/view'
import { indentWithTab, undo, redo, undoDepth, redoDepth, isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import {
  promptContext,
  promptOpen,
  resolvePromptWith,
  migrateGlobalPatToWorkspaces,
  hasPatForWorkspace,
  hasConfirmedWriteAccess,
  hasCheckedWriteAccess,
  credentialStatusForWorkspace,
  requestPat,
} from './lib/credential.js'
import { apiFetch, apiFetchForInstance, apiFetchForInstanceRef, cachedScopeForSlug, cachedWorkspaceIdForSlug } from './lib/apiFetch.js'
import { ensureWriteAccessChecked } from './lib/writeAccess.js'
import { renderMarkdown } from './lib/markdown.js'
import { Dropdown } from './lib/dropdown.js'
import { apply as applyMarkdownCommand, HEADING_LEVELS, findTable, diffRange } from './lib/markdownCommands.js'
import { NewWorkspaceWizardPage } from './pages/new-workspace-wizard.js'
import { UserGuidePage } from './pages/user-guide.js'
import { DefinitionViewerPage } from './pages/definition-viewer.js'
import { LocalDefinitionEditorPage } from './pages/local-definition-editor.js'
import { GlobalSettingsPage, WorkspaceSettingsPage, InstanceSettingsPage, workspaceRepoUrl } from './pages/settings.js'
// Two distinct "view mode" concepts collide on the same export names — the dashboard's (#77) master-detail/swimlanes toggle and the module editor's (#79, #374) visual/split/markdown toggle are unrelated signals that happen to share a shape. The dashboard's is aliased here; the module editor's keeps the bare names since it's used throughout the rest of this file.
import { VIEW_MODES as DASHBOARD_VIEW_MODES, viewMode as dashboardViewMode } from './lib/dashboardView.js'
import { unrepresentedWorkspaceGroups, describeInstanceRowWorkspace, workspaceNewInstanceHref } from './lib/dashboardWorkspaces.js'
import { workItemParentRef, describeWorkItemLink } from './lib/provider.js'
import { loadWorkspaceScopedInstances, setWorkspaceDiscoveryRetryHandler } from './lib/workspaceDiscovery.js'
import { VIEW_MODES, viewMode, cycleViewMode } from './lib/viewMode.js'
import { visualMode, refreshVisual, clearActiveCell, restoreActiveCell, activeCellSelection, focusTableCellAt } from './lib/visualMode.js'
import { advancedMode } from './lib/advancedMode.js'
import { modulePayload, payloadKey, savedFields, saveStatusLine } from './lib/stageSave.js'
import { isMultiValuedField, emptyFieldValue } from './lib/fieldShape.js'
import { renderEngine } from './lib/renderEngine.js'
import { warmLoadPandocWasm, renderDocxWithWasm } from './lib/pandocWasm.js'
import { hydrateMermaidPreview, prepareMermaidForDocx } from './lib/mermaid.js'
// Two call sites want this module's file/permission helpers under different
// local names: A5's dashboard recovery UI (further down this file) calls
// them bare; A6's editor wiring (loadLocalInstance and friends, just below)
// aliases the read/write helpers to a `Local`-suffixed name to keep them
// visually distinct from the server-backed `readTextFile`-shaped helpers
// elsewhere in this file. One import statement, both local names, same
// underlying export — importing the same binding twice under different
// names in a single `import { ... }` is valid and avoids the
// "already been declared" SyntaxError two separate import statements for
// the same name would throw.
import {
  recentLocalWorkspaces,
  getWorkspaceHandle,
  ensurePermission,
  listDir,
  listDir as listLocalDir,
  readTextFile,
  readTextFile as readLocalTextFile,
  writeTextFile as writeLocalTextFile,
  readBinaryFile as readLocalBinaryFile,
  writeBinaryFile as writeLocalBinaryFile,
  forgetWorkspace,
  getFileLastModified,
} from './lib/localWorkspace.js'
import { wrap } from './lib/editorWrap.js'
import { assetReference, repoAssetReference, isLocalAssetSource, resolveAssetRefs, resolveRepoAssetRefs } from './lib/assetRefs.js'
import { IdentityPicker } from './lib/identityPicker.js'
import {
  artefactFieldIds,
  artefactsHaveDifferentRequirements,
  defaultArtefactId,
  persistArtefactSelection,
  readArtefactSelection,
  sortArtefacts,
} from './lib/artefactSelection.js'
import {
  parseInstanceYaml,
  withInstanceStage,
  parseLocalModuleFile,
  renderLocalModuleInstanceFile,
  buildLocalModuleEntry,
} from './lib/localInstanceFiles.js'
import { getLocalStatus, checkLocalGate } from './lib/localStatus.js'
import {
  resolveDefinitionStructure,
  localDefinitionExists,
  readLocalDefinitionStructure,
  readLocalDefinitionTemplate,
  readLocalDefinitionReferenceDocx,
} from './lib/localDefinitionFiles.js'

// ---------- Local workspace instances (WI #297, ADR-0029, A6) ----------
// A local-workspace instance's data lives in a folder on the browser user's
// own machine, opened via `/instance/<slug>?local=<id>` (the URL convention
// A4's wizard already writes, web/pages/new-workspace-wizard.js).
// `localWorkspaceParam` carries the `{ id, slug }` parsed off that query
// string for as long as ModuleEditorPage is mounted for a local instance;
// `localDirHandle` is the resolved, permission-checked directory handle
// (`web/lib/localWorkspace.js`'s `getWorkspaceHandle`/`ensurePermission`) the
// rest of this module reads/writes `gantry-workspace/<slug>/…` files
// through — never a server round-trip (offline degradation, ADR-0029's own
// "Offline" section). `localGrantNeeded` flips on when a remembered handle's
// permission has lapsed (the normal state after a reload — see
// `ensurePermission`'s own doc comment), driving the same "Grant access"
// affordance the wizard's own recent-workspaces list already uses.
const localWorkspaceParam = signal(null) // { id, slug } | null
const localDirHandle = signal(null) // FileSystemDirectoryHandle | null
const localGrantNeeded = signal(false)
const localRetryTick = signal(0) // bumped to re-run the instance-loading effect after a grant
// Resolved `asset:<id>` object URLs for a local instance's images, keyed by
// `${slug}/${assetId}` — populated asynchronously by `ensureLocalAssetUrl`
// (readBinaryFile is async; the first preview render of a freshly-inserted
// image has no URL yet, so `MarkdownField`'s own asset-source-sync effect
// re-renders once this signal picks the URL up, see its own comment above).
const localAssetUrls = signal({})
const localAssetUrlPending = new Set()

function localModuleFilesPath(slug, moduleId) {
  return `gantry-workspace/${slug}/modules/${moduleId}.md`
}

// WI #304 — whether `slug` is the local-workspace instance currently pinned.
// Deliberately reads `localWorkspaceParam` (set synchronously, in the same
// `batch()` as `currentSlug`, the instant a local-workspace route is pinned
// — see ModuleEditorPage's mount effect) rather than `instanceData` (only
// populated later, once the async `loadLocalInstance()` call resolves).
// `assetFileUrl`/`fetchAssets`/`uploadAsset` below used to branch on
// `instanceData.value?.isLocalWorkspace`, which raced the module-level
// `assetSources` effect: on the very first run — fired in the same tick
// `currentSlug` is pinned — `instanceData.value` was still `null`, so that
// check fell through to the server-side `/api/instance/assets` route for a
// slug the server has never heard of (a local-workspace instance has no
// server-side registry entry at all, ADR-0029) and got a 500 back.
function isLocalWorkspaceSlug(slug) {
  return localWorkspaceParam.value?.slug === slug
}

async function ensureLocalAssetUrl(slug, assetId, key) {
  if (localAssetUrlPending.has(key) || localAssetUrls.value[key]) return
  const handle = localDirHandle.value
  if (!handle) return
  localAssetUrlPending.add(key)
  try {
    const bytes = await readLocalBinaryFile(handle, `gantry-workspace/${slug}/assets/${assetId}`)
    const url = URL.createObjectURL(new Blob([bytes]))
    localAssetUrls.value = { ...localAssetUrls.value, [key]: url }
  } catch {
    // Asset missing or unreadable — the <img> stays broken; nothing else to do client-side.
  } finally {
    localAssetUrlPending.delete(key)
  }
}

function assetFileUrl(assetId, slug, stageId) {
  if (isLocalWorkspaceSlug(slug)) {
    const key = `${slug}/${assetId}`
    const cached = localAssetUrls.value[key]
    if (cached) return cached
    ensureLocalAssetUrl(slug, assetId, key)
    return ''
  }
  const params = new URLSearchParams()
  if (slug) params.set('slug', slug)
  if (stageId) params.set('stage', stageId)
  // WI #366: the browser fetches this URL itself (an <img src>, or the "Source:" citation link), so
  // it never passes through `apiFetchForInstance` and has to carry the workspace token on its own.
  const scope = slug ? cachedScopeForSlug(slug) : null
  if (scope) params.set('scope', scope)
  const qs = params.toString()
  const base = `/api/instance/assets/${encodeURIComponent(assetId)}/file`
  return qs ? `${base}?${qs}` : base
}

/**
 * Reads `gantry-workspace/<slug>/instance.yaml` and every
 * `gantry-workspace/<slug>/modules/*.md` through a local workspace's
 * directory handle, resolves the definition via the same
 * `/api/definitions/:id/versions/:n` route the wizard uses, and builds the
 * same shape `GET /api/instance` returns (see `lib/server.js`'s
 * `buildInstanceResponse`) — enough for `ModuleEditorPage` and its children
 * to render unchanged. Throws an `Error` with `.needsGrant = true` when the
 * remembered handle's permission is not (yet) granted; callers show the
 * "Grant access" affordance instead of a raw load error for that case.
 */
async function loadLocalInstance(workspaceId, slug, requestedStageId) {
  const handle = await getWorkspaceHandle(workspaceId)
  if (!handle) {
    throw new Error('This local workspace is no longer remembered in this browser — reopen it from the "+ New Workspace" wizard.')
  }
  const permission = await ensurePermission(handle)
  if (permission !== 'granted') {
    const err = new Error('This local workspace needs permission again in this browser.')
    err.needsGrant = true
    throw err
  }
  localDirHandle.value = handle

  const instanceYamlText = await readLocalTextFile(handle, `gantry-workspace/${slug}/instance.yaml`)
  const record = parseInstanceYaml(instanceYamlText)
  const definitionId = record.definition
  const definitionVersion = record.definitionVersion ?? 1
  // WI #384 — checks this workspace's own definitions/ folder before the
  // library, so a local instance pinned to a local-workspace-authored
  // definition loads it straight off disk instead of 404ing against the
  // server library it was never in.
  const structure = await resolveDefinitionStructure(handle, definitionId, definitionVersion)

  const stageId = requestedStageId ?? record.stage
  const stage = structure.stages.find((s) => s.id === stageId)
  if (!stage) throw new Error(`Definition "${definitionId}" has no stage "${stageId}"`)
  const modulesById = new Map(structure.modules.map((m) => [m.id, m]))

  const modules = []
  for (const moduleId of stage.modules) {
    const moduleSpec = modulesById.get(moduleId)
    if (!moduleSpec) continue
    let data = { status: 'draft', owner: '', fields: {} }
    try {
      const text = await readLocalTextFile(handle, localModuleFilesPath(slug, moduleId))
      data = parseLocalModuleFile(text, moduleSpec)
    } catch {
      // No saved data yet for this module — the blank draft above stands, matching GET /api/instance's own "no module file yet" default.
    }
    modules.push(buildLocalModuleEntry(moduleSpec, stage, data, null, structure.stages))
  }

  return {
    slug,
    // #145: the same optional display-name field GET /api/instance returns (`name:` in
    // instance.yaml, or `null` when unset) — read straight off the already-parsed local
    // instance.yaml instead of a server round trip.
    name: record.name ?? null,
    definition: definitionId,
    stage: { id: stage.id, title: stage.title, gate: stage.gate, number: structure.stages.findIndex((s) => s.id === stage.id) + 1 },
    currentStageId: record.stage,
    hasExample: false,
    stages: structure.stages.map((s, i) => ({ id: s.id, title: s.title, gate: s.gate, number: i + 1 })),
    workspaceNumber: 0,
    instanceNumber: 0,
    ref: '',
    // Scoped down vs. the server route: filtered only by gate, not also by
    // whether the artefact's template file exists (that check lives inside
    // `definitionsDir` on the server; a local instance has no equivalent
    // client-side signal for it) — a local instance's Render dialog can
    // list an artefact fractionally earlier than a server-hosted one would.
    artefacts: structure.artefacts.filter((a) => a.gate === stage.gate).map((a) => ({ id: a.id, title: a.title, requires: a.requires, ...(a.satisfiesGate === false ? { satisfiesGate: false } : {}) })),
    modules,
    workItem: null,
    pullRequests: {},
    approvalStates: {},
    reviewRequests: {},
    reviews: [],
    pullRequest: null,
    assignee: record.assignee ?? '',
    requiredReviewer: '',
    reopened: {},
    workspaceBacked: false,
    workspace: null,
    archived: false,
    stageSync: { behind: false, behindFiles: [], ahead: false },
    // Local-workspace-only extras — never present for a server-backed
    // instance — that the save/render/advance/gate-check code paths below
    // branch on.
    isLocalWorkspace: true,
    localWorkspaceId: workspaceId,
    localDefinitionVersion: definitionVersion,
    // WI #313 — the full definition version projection (already fetched
    // above), kept on the instance so `getLocalStatus`/`checkLocalGate` (both
    // `web/lib/localStatus.js`) can evaluate status/gate-check for ANY stage
    // (not just the one this load built `modules` for) entirely client-side —
    // no second `/api/definitions/...` fetch, and no `/api/local/status` or
    // `/api/local/check` round trip at all.
    localDefinitionStructure: structure,
  }
}

/**
 * Builds the `{ definitionId, definitionVersion, instanceYaml, moduleFiles }`
 * payload `/api/local/*` (A3, lib/localWorkspace.js's `runLocalWorkspaceCompute`)
 * expects, from the local instance's current on-disk files — always freshly
 * read, so a render always reflects the latest save.
 */
async function buildLocalComputePayload(instance) {
  const handle = localDirHandle.value
  if (!handle) throw new Error('Local workspace folder is not open.')
  const slug = instance.slug
  const instanceYaml = await readLocalTextFile(handle, `gantry-workspace/${slug}/instance.yaml`)
  const moduleFiles = {}
  const entries = await listLocalDir(handle, `gantry-workspace/${slug}/modules`).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const moduleId = entry.name.slice(0, -'.md'.length)
    moduleFiles[moduleId] = await readLocalTextFile(handle, `gantry-workspace/${slug}/modules/${entry.name}`)
  }
  const payload = { definitionId: instance.definition, definitionVersion: instance.localDefinitionVersion, instanceYaml, moduleFiles }
  // WI #384 — a local-workspace-authored definition never lives in this
  // server's bundled definitionsDir, so a render/compile of an instance
  // pinned to one has to ship the definition's own content alongside the
  // instance's — the inline `definition` payload `lib/localWorkspace.js`'s
  // `runLocalWorkspaceCompute` already knows how to materialize into a
  // throwaway sandbox next to the instance files (see
  // `buildInlineLocalDefinitionPayload` below). A library-pinned instance
  // (the common case) leaves `payload.definition` unset, unchanged from
  // before this ticket.
  if (await localDefinitionExists(handle, instance.definition, instance.localDefinitionVersion)) {
    payload.definition = await buildInlineLocalDefinitionPayload(handle, instance.definition, instance.localDefinitionVersion)
  }
  return payload
}

// The `{ structure, templates, referenceDocs }` shape
// `lib/localWorkspace.js`'s `validateInlineDefinition` expects on an
// `/api/local/*` request body, read straight off this workspace's own
// `definitions/<id>/<version>/` folder — the same files
// `web/pages/local-definition-editor.js` saves. `referenceDocs` values are
// base64 (the wire shape a JSON body can carry); `templates` stay plain
// text. Only an artefact's own template — named off `artefact.template`,
// e.g. `templates/soap.md.tmpl` — and reference docx (if any) are read;
// every other artefact's are skipped, same "read only what this render
// actually needs" restraint `runLocalWorkspaceCompute` itself is under no
// obligation to but this keeps the request body small regardless.
async function buildInlineLocalDefinitionPayload(handle, definitionId, version) {
  const structure = await readLocalDefinitionStructure(handle, definitionId, version)
  const templates = {}
  const referenceDocs = {}
  for (const artefact of structure.artefacts ?? []) {
    const name = String(artefact.template ?? '').split('/').pop()
    if (name) {
      const text = await readLocalDefinitionTemplate(handle, definitionId, version, name)
      if (text != null) templates[name] = text
    }
    const docxBytes = await readLocalDefinitionReferenceDocx(handle, definitionId, version, artefact.id)
    if (docxBytes) referenceDocs[artefact.id] = bytesToBase64(new Uint8Array(docxBytes))
  }
  return { structure, templates, referenceDocs }
}

// The message shown wherever a local-workspace action needs the gantry
// server and it can't be reached (a genuine network error, not a 4xx/5xx
// response) — ADR-0029's "Offline" section. As of WI #313, that's `render`
// only (needs native `pandoc`/`git`): status, gate check and editing/saving
// all run entirely client-side and never see this message.
const LOCAL_OFFLINE_MESSAGE = 'Connect to the gantry server to render.'

/**
 * POSTs one `/api/local/<operation>` request built from the local instance's
 * current on-disk files. As of WI #313 the only operation any call site still
 * uses is `render` (needs native `pandoc`/`git` — see `runLocalCheck`/
 * `getLocalStatus` below for `status`/`check`, ported to run client-side
 * instead). A network failure (server unreachable) throws an `Error` with
 * `.offline = true` carrying `LOCAL_OFFLINE_MESSAGE`, distinct from a real
 * 4xx/5xx response — callers show the offline message only for the former.
 */
async function runLocalCompute(operation, instance, extra = {}) {
  const payload = { ...(await buildLocalComputePayload(instance)), ...extra }
  let res
  try {
    res = await fetch(`/api/local/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    const err = new Error(LOCAL_OFFLINE_MESSAGE)
    err.offline = true
    throw err
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? body.message ?? `Local ${operation} failed (${res.status})`)
  return body
}

/**
 * Runs a local workspace's gate check entirely client-side (WI #313) —
 * `checkLocalGate` (`web/lib/localStatus.js`), reading module files straight
 * through the open directory handle instead of POSTing to `/api/local/check`.
 * `options.gate` is forwarded unchanged, matching `checkGate`'s own contract
 * (resolve any stage owning that gate rather than the instance's current
 * one) — no call site currently passes it, but this keeps parity with the
 * server-side function's full signature.
 */
async function runLocalCheck(instance, options = {}) {
  const handle = localDirHandle.value
  if (!handle) throw new Error('Local workspace folder is not open.')
  return checkLocalGate(handle, instance.slug, instance.localDefinitionStructure, instance.currentStageId, options)
}

// Uint8Array -> base64, chunked so `String.fromCharCode` never gets a multi-megabyte spread of
// individual bytes in one call (some engines cap the argument count `apply`/spread can pass).
// The mirror-image decode (`atob` + `Uint8Array.from(...,(c) => c.charCodeAt(0))`) is already
// used inline below and needs no such chunking — `atob`'s own output isn't call-stack-bound.
function bytesToBase64(bytes) {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// WI #360 — a server-hosted (directory-backed) instance's render never lands on the server's
// own filesystem; the bytes come back over the wire and are handed straight to the browser as
// a download instead. Standard Blob + object URL + synthetic `<a download>` click; the object
// URL is revoked right after the click since nothing else in this codebase needs to keep it
// alive (contrast `ensureLocalAssetUrl` above, whose object URLs back a live `<img>` and must
// persist for as long as that element is on screen).
function triggerBrowserDownload(bytes, filename, mimeType) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

// WI314 — the local-workspace half of the engine-aware Render action (RenderDialog's
// handleRenderBatch, below). `'wasm'`: compiles the artefact server-side (dry run — no
// `pandoc` subprocess, see /api/local/compile) and converts it to `.docx` in the browser via
// pandoc-wasm, with no further server round-trip for the conversion itself — the acceptance
// criterion this ticket is built around. Any failure in that attempt (the module never
// finished loading, a mid-conversion error) is swallowed here and falls through to the exact
// same native path `'native'` uses unconditionally: an explicit WASM selection never
// hard-fails a render. Throws (never swallows) on a failure in that final, native leg — the
// caller's own try/catch (handleRenderBatch) reports that exactly as it always has.
// `format` (WI #359, default `'docx'`): `'md'` skips pandoc/WASM conversion entirely — a dry-run
// compile is all a markdown-only render ever needs — and writes only the `.md` into the picked
// folder. `'docx'` (the default, and every caller that predates this option) keeps its previous
// behaviour except for one change: the compiled markdown is no longer also written to the
// folder — a docx-only render must not persist a `.md` a caller never asked to keep.
async function renderLocalArtefactViaEngine(instance, artefact, slug, format = 'docx') {
  const handle = localDirHandle.value
  if (!handle) throw new Error('Local workspace folder is not open.')

  if (format === 'md') {
    const compiled = await runLocalCompute('compile', instance, { artefact: artefact.id })
    const mdPath = `gantry-workspace/${slug}/out/${compiled.basename}.md`
    await writeLocalTextFile(handle, mdPath, compiled.markdown)
    return { title: artefact.title, path: mdPath }
  }

  if (renderEngine.value === 'wasm') {
    try {
      const compiled = await runLocalCompute('compile', instance, { artefact: artefact.id })
      const referenceDocBytes = compiled.referenceDocBase64 ? base64ToBytes(compiled.referenceDocBase64) : null
      // WI #353: Mermaid blocks become PNGs for the docx.
      const docxInput = await prepareMermaidForDocx(compiled.markdown)
      const docxBytes = await renderDocxWithWasm({ markdown: docxInput.markdown, referenceDocBytes, files: docxInput.files })
      const docxPath = `gantry-workspace/${slug}/out/${compiled.basename}.docx`
      await writeLocalBinaryFile(handle, docxPath, docxBytes)
      return { title: artefact.title, path: docxPath }
    } catch {
      // Falls through to the native leg below.
    }
  }

  const body = await runLocalCompute('render', instance, { artefact: artefact.id })
  const docxPath = `gantry-workspace/${slug}/out/${body.basename}.docx`
  await writeLocalBinaryFile(handle, docxPath, base64ToBytes(body.docxBase64))
  return { title: artefact.title, path: docxPath }
}

// WI314 — the Azure-DevOps-hosted half of the engine-aware Render action. `'wasm'`: a
// two-step round trip either side of the browser's own conversion (mirrors lib/render.js's
// prepareAzureDevOpsWasmRender/finishAzureDevOpsWasmRender doc comment for the full two-push
// rationale) — "prepare" returns the compiled markdown + reference-doc bytes and pushes a
// footer-less draft (still native Pandoc — never seen by a user, immediately overwritten) to
// learn the commit Azure DevOps assigns; this module then converts the *real*, Document-
// Control-complete markdown to `.docx` in the browser; "finish" pushes those bytes as the
// final commit — exactly where the fully-server-side path's own second push would land them.
// Never throws: like the pre-existing native-only code this replaces, a failure — from either
// step of the WASM attempt, or from the native leg itself — resolves to an error-shaped
// status line rather than rejecting, so `handleRenderBatch` doesn't need its own try/catch
// here (it never had one for this branch).
//
// WI #367 — the images the prepare route shipped alongside the markdown, decoded into the byte
// arrays `renderDocxWithWasm` puts in Pandoc's virtual filesystem. Keyed by the same virtual
// filenames the markdown now references (see lib/render.js's externaliseImagesForWasm). Absent or
// empty for a render with no images, in which case this contributes nothing.
function decodeWasmImageFiles(imageFilesBase64) {
  const files = {}
  for (const [name, base64] of Object.entries(imageFilesBase64 ?? {})) {
    files[name] = base64ToBytes(base64)
  }
  return files
}

// `workspaceBacked` (WI #317 fix): the WASM leg only exists server-side for an
// Azure-DevOps-hosted instance (`render-wasm-prepare`/`-finish`, gated on
// `resolveAzureDevOpsLocation`) — this function's own callers previously assumed "not an
// ADR-0029 local workspace" meant "Azure-DevOps-hosted", which misses a third, pre-existing
// case: a legacy server-side local instance (`instance.workspaceBacked === false`, plain
// `instancesDir` on the box running `gantry serve`, no Azure DevOps and no client-side
// File System Access workspace either). For that case the WASM prepare call always 400s —
// harmless in that the native fallback below still renders correctly, but it fires a doomed
// request and a logged console error on every single render, real regression surface WI #317
// caught. `false` (or omitted) skips the WASM attempt entirely and goes straight to the native
// leg, exactly as this instance kind rendered before this ticket ever existed.
// `format` (WI #359, default `'docx'`): `'md'` never reaches either WASM leg below — there is
// no browser-side conversion step to offload for a markdown-only render, so it goes straight to
// the plain native route (which, since #359, is itself format-aware) with `?format=md`.
async function renderAzureArtefactViaEngine(artefact, slug, workspaceBacked = false, format = 'docx') {
  // WI #349 — a plain server-hosted (directory-backed) instance (e.g. the bundled `examples`)
  // gets the same WASM flow: the server compiles (no pandoc subprocess), the browser converts.
  // WI #360 — the resulting bytes are never written to the instance's own `out/` directory;
  // `render-wasm-finish` just echoes the bytes the browser already produced back in its
  // response (a round trip kept for symmetry with the workspace-backed leg below, not because
  // the server needs to do anything with them), and this leg triggers a real download from
  // them instead of reporting a server-side path.
  if (format === 'docx' && !workspaceBacked && renderEngine.value === 'wasm') {
    try {
      const prepRes = await apiFetchForInstance(
        slug,
        `/api/instance/render-wasm-prepare/${artefact.id}?slug=${encodeURIComponent(slug)}`,
        { method: 'POST' }
      )
      const prep = await prepRes.json()
      if (!prepRes.ok) throw new Error(prep.message ?? prep.error ?? `Prepare failed (${prepRes.status})`)
      const referenceDocBytes = prep.referenceDocBase64 ? base64ToBytes(prep.referenceDocBase64) : null
      const docxInput = await prepareMermaidForDocx(prep.markdown)
      // WI #367: the author's own images ride along from the prepare route as bytes; mermaid's
      // browser-rendered PNGs keep their existing names and win any collision.
      const files = { ...decodeWasmImageFiles(prep.imageFilesBase64), ...docxInput.files }
      const docxBytes = await renderDocxWithWasm({ markdown: docxInput.markdown, referenceDocBytes, files })
      const finishRes = await apiFetchForInstance(
        slug,
        `/api/instance/render-wasm-finish/${artefact.id}?slug=${encodeURIComponent(slug)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docxBase64: bytesToBase64(docxBytes) }) }
      )
      const finish = await finishRes.json()
      if (!finishRes.ok) throw new Error(finish.message ?? finish.error ?? `Finish failed (${finishRes.status})`)
      const filename = `${finish.basename}.docx`
      triggerBrowserDownload(docxBytes, filename, DOCX_MIME)
      return { title: artefact.title, path: filename, url: null }
    } catch {
      // Falls through to the native leg below.
    }
  }
  if (format === 'docx' && workspaceBacked && renderEngine.value === 'wasm') {
    try {
      const prepRes = await apiFetchForInstance(
        slug,
        `/api/instance/render-wasm-prepare/${artefact.id}?slug=${encodeURIComponent(slug)}`,
        { method: 'POST' }
      )
      const prep = await prepRes.json()
      if (!prepRes.ok) throw new Error(prep.message ?? prep.error ?? `Prepare failed (${prepRes.status})`)

      const referenceDocBytes = prep.referenceDocBase64 ? base64ToBytes(prep.referenceDocBase64) : null
      const docxInput = await prepareMermaidForDocx(prep.markdown)
      // WI #367: the author's own images ride along from the prepare route as bytes; mermaid's
      // browser-rendered PNGs keep their existing names and win any collision.
      const files = { ...decodeWasmImageFiles(prep.imageFilesBase64), ...docxInput.files }
      const docxBytes = await renderDocxWithWasm({ markdown: docxInput.markdown, referenceDocBytes, files })

      const finishRes = await apiFetchForInstance(
        slug,
        `/api/instance/render-wasm-finish/${artefact.id}?slug=${encodeURIComponent(slug)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docxBase64: bytesToBase64(docxBytes),
            // #16: `prep` carries whichever provider's own out-path field the prepare route just
            // used (`azureDevOpsPath` or `githubPath`) — sending both, one always undefined, lets
            // this one request body work for either without branching on provider here.
            azureDevOpsPath: prep.azureDevOpsPath,
            githubPath: prep.githubPath,
            branch: prep.branch,
            commit: prep.commit,
          }),
        }
      )
      const finish = await finishRes.json()
      if (!finishRes.ok) throw new Error(finish.message ?? finish.error ?? `Finish failed (${finishRes.status})`)
      return {
        title: artefact.title,
        path: finish.azureDevOpsPath ?? finish.githubPath,
        url: finish.azureDevOpsUrl ?? finish.githubUrl,
      }
    } catch {
      // Falls through to the native leg below.
    }
  }

  const res = await apiFetchForInstance(
    slug,
    `/api/instance/render/${artefact.id}?slug=${encodeURIComponent(slug)}&format=${format}`,
    { method: 'POST' }
  )
  const body = await res.json()
  if (!res.ok) {
    return { text: `${artefact.title}: render failed — ${body.message ?? body.error}` }
  }
  // Azure-DevOps-backed instances report `azureDevOpsPath` (where the render was pushed back
  // to, in the same repo the rest of the instance's data lives in, `.md` or `.docx` per
  // `format`) — unchanged by WI #360. GitHub-backed instances report the #16 twin, `githubPath`.
  if (body.azureDevOpsPath || body.githubPath) {
    return { title: artefact.title, path: body.azureDevOpsPath ?? body.githubPath, url: body.azureDevOpsUrl ?? body.githubUrl }
  }
  // WI #360 — a server-hosted (directory-backed) instance's render carries its bytes straight
  // in the response (`markdown` for `format: 'md'`, `docxBase64` for `format: 'docx'`) instead
  // of a server-side path; nothing is written to the instance's own `out/` directory, so the
  // only place the artefact lands is a real browser download.
  const filename = `${body.basename}.${format}`
  if (format === 'md') {
    triggerBrowserDownload(new TextEncoder().encode(body.markdown), filename, 'text/markdown')
  } else {
    triggerBrowserDownload(base64ToBytes(body.docxBase64), filename, DOCX_MIME)
  }
  return { title: artefact.title, path: filename, url: null }
}

// ---------- Navigation heading helpers (WI232) ----------
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

export function headingId(moduleId, headingText) {
  return `${moduleId}--${slugify(headingText)}`
}

export function buildStageHeadings(modules, visibleFieldIds) {
  const headings = []
  // Defensive: never throw from here — StageNavigation now lives in
  // ViewModeToolbar to the right of the artefact selector, so a throw would
  // blank that toolbar too (no error boundary). A transient render where
  // `modules` or `mod.fields` isn't yet populated must degrade to an empty
  // nav, not a broken screen.
  for (const mod of modules ?? []) {
    if (!mod) continue
    headings.push({ id: headingId(mod.id, mod.title), label: mod.title, level: 2, moduleId: mod.id })
    for (const field of mod.fields ?? []) {
      if (visibleFieldIds && !visibleFieldIds.has(`${mod.id}.${field.id}`)) continue
      const label = field.title + (field.required ? ' *' : '')
      headings.push({ id: headingId(mod.id, field.title), label, level: 3, moduleId: mod.id })
    }
  }
  return headings
}

// WI200/docs/adr/0024's numeric references: `/instance/:ref` accepts a numeric reference
// (`w<workspaceNumber>`, `w<workspaceNumber>i<instanceNumber>`, or `w<workspaceNumber>i<instanceNumber>s<stageNumber>`)
// as well as the pre-existing plain slug — this is the same grammar `lib/numberRegistry.js`'s
// `parseInstanceRef` accepts server-side, kept in sync by hand since the web form has no shared
// module with lib/ (no bundler, ADR-0006). Used purely to decide *how* to resolve the route's own
// `:ref` segment (via `?ref=` against the server) — never to parse it further client-side; the
// server remains the sole source of truth for what a reference resolves to.
const NUMERIC_REF_RE = /^w\d+(i\d+)?(s\d+)?$/i

async function resolveInstanceRef(ref) {
  // #9 (ADR-0038): resolves which workspace this ref belongs to first, the same
  // uncredentialed-lookup-then-scoped-request shape `apiFetchForInstance` already uses for a slug —
  // there is no global-default PAT left for this to silently fall back to.
  const res = await apiFetchForInstanceRef(ref, `/api/instance?ref=${encodeURIComponent(ref)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to resolve reference "${ref}" (${res.status})`)
  }
  return res.json()
}

async function loadInstance(slug, stageId) {
  const params = new URLSearchParams()
  if (slug) params.set('slug', slug)
  if (stageId) params.set('stage', stageId)
  const qs = params.toString()
  // `apiFetchForInstance` (not plain `apiFetch`) — this request may target a workspace with its own PAT override (#104), which must be resolved and attached before the first attempt, not just on a 401 retry.
  const res = await apiFetchForInstance(slug, qs ? `/api/instance?${qs}` : '/api/instance')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instance (${res.status})`)
  }
  return res.json()
}

async function fetchAssets(slug, stageId) {
  if (isLocalWorkspaceSlug(slug)) {
    const handle = localDirHandle.value
    if (!handle) return []
    const entries = await listLocalDir(handle, `gantry-workspace/${slug}/assets`).catch(() => [])
    return entries
      .filter((e) => e.kind === 'file')
      .map((e) => ({ id: e.name, filename: e.name, name: e.name, source: '', uploadedBy: '', usedIn: [] }))
  }
  const params = new URLSearchParams()
  if (slug) params.set('slug', slug)
  if (stageId) params.set('stage', stageId)
  const qs = params.toString()
  const path = qs ? `/api/instance/assets?${qs}` : '/api/instance/assets'
  const res = await apiFetchForInstance(slug, path)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load images (${res.status})`)
  }
  return res.json()
}

// Local-workspace asset ids are just their filename (mirrors the
// workspace-backed/repo-as-asset-store convention already used for
// Azure-DevOps-backed instances, `lib/server.js`'s GET /api/instance/assets)
// — scoped down from the server-local path's generated ids, since a local
// workspace has no server-side registry to hand one out from.
async function uploadAsset({ slug, filename, dataBase64, name, source, uploadedBy }) {
  if (isLocalWorkspaceSlug(slug)) {
    const handle = localDirHandle.value
    if (!handle) throw new Error('Local workspace folder is not open.')
    const bytes = Uint8Array.from(atob(dataBase64 ?? ''), (c) => c.charCodeAt(0))
    await writeLocalBinaryFile(handle, `gantry-workspace/${slug}/assets/${filename}`, bytes)
    return { id: filename, filename, name: name || filename, source: source ?? '', uploadedBy: uploadedBy ?? '' }
  }
  const qs = slug ? `?slug=${encodeURIComponent(slug)}` : ''
  const res = await apiFetchForInstance(slug, `/api/instance/assets${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, dataBase64, name, source, uploadedBy }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Failed to upload image (${res.status})`)
  }
  return body
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

// AB#343: instance kinds that store assets as repo-relative files in an on-disk `assets/`
// directory (WI260's `assets/<name>` / `../assets/<name>` convention) — Azure-DevOps-backed
// instances (`workspaceBacked`) and ADR-0029 local-workspace instances (`isLocalWorkspace`,
// set by loadLocalInstance() above) both do; a legacy server-side local instance (ADR-0012 —
// `workspaceBacked: false`, no client-side File System Access workspace either) does not: its
// `/api/instance/assets/:id/file` route only resolves manifest asset IDs, never raw filenames
// (see lib/server.js's assetFileMatch handler, which only branches to filename-based lookup for
// a resolved Azure DevOps location). `assetFileUrl` itself already resolves correctly for both
// true cases — `isLocalWorkspaceSlug` reads straight off the picked directory handle, and the
// Azure DevOps route above reads the repo file by name — so this only needs to gate whether the
// rewrite runs at all.
function usesRepoAssetConvention(instance) {
  return Boolean(instance?.workspaceBacked || instance?.isLocalWorkspace)
}

// #16 — distinguishes a GitHub-backed instance from an Azure-DevOps-backed one without a `provider`
// field on `buildInstanceResponse`'s `workspace` shape: a GitHub location is `{owner, repository,
// baseUrl?}`, an Azure DevOps one is `{organization, project, repository, baseUrl?}` — `owner` only
// ever appears on the former. Used to offer real asset upload (unlike Azure DevOps, which has none —
// WI260 scoped that out) and an automatic, un-authored citation to the committed file's own GitHub
// address, rather than the hand-typed `source` the `asset:<id>` manifest convention requires.
function isGitHubBackedInstance(instance) {
  return Boolean(instance?.workspace?.owner)
}

// #16 — client-side mirror of lib/githubFileUrl.js's own web-URL derivation (kept in sync by hand,
// the same "server-side code can't import a browser-facing module, and vice versa" duplication
// web/lib/theme.js vs. web/index.html's bootstrap script already uses): a GitHub location's `baseUrl`
// is the API root (`https://api.github.com`, or `<host>/api/v3` for GitHub Enterprise Server), never
// the web root a citation link needs.
function githubWebBaseUrl(github) {
  const raw = (github.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  if (raw === 'https://api.github.com') return 'https://github.com'
  return raw.replace(/\/api\/v3$/i, '')
}

function githubRepoAssetCitationUrl(workspace, slug, filename) {
  if (!workspace?.owner || !workspace?.repository) return null
  const base = githubWebBaseUrl(workspace)
  const path = `gantry-workspace/${slug}/assets/${filename}`.split('/').map(encodeURIComponent).join('/')
  return `${base}/${encodeURIComponent(workspace.owner)}/${encodeURIComponent(workspace.repository)}/blob/main/${path}`
}

// `asset:<id>` references are resolved to the real, fetchable asset-file URL before markdown-it ever sees the text — the *stored* markdown source keeps the portable `asset:<id>` convention (see web/lib/assetRefs.js), only the live preview's rendered HTML points at a real URL.
// WI260 also resolves `../assets/<name>` / `assets/<name>` for instances using the repo-as-asset-store convention so a bare relative path shows in the preview.
// WI264: stage-aware — when free-browsing a completed stage, the preview's asset URLs pin to that stage's ref so the server reads both modules and assets from the same ref (main for a completed stage, the stage branch for the current stage).
function renderPreview(node, text) {
  if (!node) return
  const slug = currentSlug.value
  const stageId = viewedStage.value ?? instanceData.value?.stage?.id ?? null
  const sources = assetSources.value
  let withSources = resolveAssetRefs(
    text ?? '',
    (id) => assetFileUrl(id, slug, stageId),
    // WI #348: a local source (the image's own copy within the instance) is labelled by its stored path but linked to the served file, so the citation opens in the browser the same way it opens the local file from a rendered .docx.
    (id) => {
      const source = sources[id]
      if (!source) return null
      return isLocalAssetSource(source) ? { label: source, href: assetFileUrl(id, slug, stageId) } : source
    }
  )
  // WI260 repo-as-asset-store: for instances that use the convention, also rewrite relative repo-asset refs to the fetchable file endpoint, the same way `asset:<id>` is rewritten. AB#343: this used to be gated on `workspaceBacked` alone, which missed local-workspace instances (ADR-0029) that use the identical on-disk convention.
  if (usesRepoAssetConvention(instanceData.value)) {
    // #16 — a GitHub-backed instance's repo-asset cites its own committed file's GitHub address, the
    // same automatic citation the render pipeline emits into the rendered .docx (lib/render.js).
    const instance = instanceData.value
    withSources = resolveRepoAssetRefs(
      withSources,
      (filename) => assetFileUrl(filename, slug, stageId),
      isGitHubBackedInstance(instance) ? (filename) => githubRepoAssetCitationUrl(instance.workspace, slug, filename) : undefined
    )
  }
  node.innerHTML = renderMarkdown(withSources)
  // WI #353: ```mermaid fences render as diagrams in place. Async and fire-and-forget — a
  // re-render before a diagram finishes just leaves the swap with nothing to replace.
  hydrateMermaidPreview(node).catch(() => {})
  // Caption-styling hook: the citation renders as <p><em>Source: …</em></p>; mark that paragraph so the stylesheet can make it visually subordinate (caption) rather than body text.
  node.querySelectorAll('p').forEach((p) => {
    const em = p.querySelector('em')
    if (em && em.textContent.startsWith('Source:')) p.classList.add('asset-source')
  })
}

// ---------- Instance-scoped state ----------
// `currentSlug` is the instance the module editor route (`/instance/:slug`) is currently mounted for. `viewedStage` mirrors the free-browse stage switcher: the stage the form is currently displaying, distinct from the instance's own persisted current stage until the user picks a different one. `viewedStage` of `null` means "let the server default to the instance's current stage" (the bootstrap case, on first load of a slug).
const currentSlug = signal(null)
const viewedStage = signal(null)
const instanceData = signal(null)
const loadError = signal(null)

// Fires only while a slug is actually pinned — i.e. while ModuleEditorPage is mounted (see its own useEffect below) — not on every page load regardless of route, so landing on a sibling route with no instance pinned (e.g. /new-workspace, the "+ New Workspace" wizard, #110, or the dashboard) never fires this fetch or surfaces a spurious "no instance slug given" failure.
effect(() => {
  const slug = currentSlug.value
  if (!slug) return
  const stageId = viewedStage.value
  const local = localWorkspaceParam.value
  void localRetryTick.value // re-subscribe so a "Grant access" retry re-runs this effect
  if (local) {
    localGrantNeeded.value = false
    loadLocalInstance(local.id, slug, stageId)
      .then((data) => {
        instanceData.value = data
        loadError.value = null
      })
      .catch((err) => {
        if (err.needsGrant) {
          localGrantNeeded.value = true
          return
        }
        loadError.value = err.message
      })
    return
  }
  loadInstance(slug, stageId)
    .then((data) => {
      instanceData.value = data
      loadError.value = null
    })
    .catch((err) => {
      loadError.value = err.message
    })
})

// Asset source map for citation rendering (#147) — populated on slug change via fetchAssets, used by renderPreview to emit `*Source: …*` below each image. Empty until fetch completes, so preview renders without citation then re-renders once sources arrive (see MarkdownField's stopAssetSourceSync).
const assetSources = signal({})

effect(() => {
  const slug = currentSlug.value
  const stageId = viewedStage.value ?? null
  if (!slug) {
    assetSources.value = {}
    return
  }
  // WI #308 — mirrors the synced-fields-loading effect's `cancelled` guard
  // (the Work Item Details card's own useEffect, further below in this file):
  // without it, a `fetchAssets()` call still in flight
  // when this effect re-runs (e.g. Back-navigating off a local-workspace
  // instance, then into a different one) resolves after the fact and
  // overwrites `assetSources` with data for a slug that's no longer current
  // — or, worse, was mid-flight against the local branch when the instance
  // it belonged to went away, so acting on it at all is meaningless.
  let cancelled = false
  fetchAssets(slug, stageId)
    .then((list) => {
      if (cancelled) return
      const map = {}
      for (const a of list) if (a.source) map[a.id] = a.source
      assetSources.value = map
    })
    .catch(() => {
      if (cancelled) return
      assetSources.value = {}
    })
  return () => {
    cancelled = true
  }
})

// An archived instance is read-only in every view (#374 — this replaced the retired read-only Rendered view). Genuinely read-only, not just visually hidden: `EditorState.readOnly` rejects direct-edit transactions and `EditorView.editable` drops `contenteditable` (and with it every Visual grid cell and table handle), so neither typing nor paste nor drag-drop can land a change.
const isArchived = () => !!instanceData.value?.archived

// #126 (parent #109, docs/adr/0047): the currently-viewed instance's own workspace id, or `null` for a
// local instance — `web/lib/apiFetch.js`'s `cachedWorkspaceIdForSlug` reading off the same cache entry
// `apiFetchForInstance` already warmed loading this instance's data, so this never triggers a request
// of its own.
const currentWorkspaceId = () => cachedWorkspaceIdForSlug(currentSlug.value)

// #126: "shared" (`instanceData.value.shared`, set by lib/server.js's own `GET /api/instance` — this
// workspace has a `GANTRY_SHARED_WORKSPACE_PATS` entry, i.e. it can be browsed with no credential at
// all) is what tells an unshared workspace apart from the case this ticket exists for. An unshared
// workspace's reads already 401-and-prompt (`apiFetch`'s existing `requestPat` flow) before any
// instance data — and with it any editing affordance — ever renders, so by the time this function
// could even be asked, an unshared instance always already holds a credential; gating on
// `isSharedInstance()` (rather than gating unconditionally on write-access confirmation) is what keeps
// that pre-existing flow's behaviour genuinely untouched, per #126's own explicit "unshared is
// unaffected" requirement.
const isSharedInstance = () => !!instanceData.value?.shared

// #126: the single answer every editing affordance below gates on. `false` (never blocked) for a
// local instance or an unshared one — see `isSharedInstance` above for why. For a shared instance,
// blocked whenever this workspace's stored credential (if any) has not been *confirmed* to write here
// — no credential at all and "checked, and it's read-only" collapse to the same UI state on purpose
// (both get `writeAccessBlockedReason`'s "Add credential" action below); only a rejected credential
// gets its own distinct wording, from the pre-existing `credentialStatusForWorkspace`.
function isWriteAccessBlocked() {
  if (!isSharedInstance()) return false
  return !hasConfirmedWriteAccess(currentWorkspaceId())
}

// #142: whether the screen is browsing a completed Stage — one the instance has already advanced
// past, whose editor now shows main's approved content rather than a live editable branch. Set by
// `GET /api/instance`'s `stageCompleted` (lib/server.js), only for a Workspace-backed instance — a
// local instance has no main/branch split to complete against, so this is always `false` there.
// Re-open (see ReopenStagePanel) is the only path back to editing it — the server's own module-write
// routes refuse a save aimed here the same way (web/lib/stageCompletion.js's `completedStageRefusal`),
// so gating the fields here too is belt-and-braces, not the only thing standing in the way.
const isViewingCompletedStage = () => Boolean(instanceData.value?.workspaceBacked && instanceData.value?.stageCompleted)

// The union this file's editing affordances actually gate on: archived (unconditional, every
// workspace), a shared workspace's write access not yet confirmed for whatever credential (if any) is
// currently stored, or (#142) a completed Stage being browsed. `isArchived()` itself is untouched and
// keeps meaning exactly "this instance is archived" wherever this file still reads it directly (the
// archived banner's own text).
const isEditingBlocked = () => isArchived() || isWriteAccessBlocked() || isViewingCompletedStage()

// #126: the stated reason + action pairing every gated control's "why is this off, and what do I do
// about it" reads from — `null` while editing isn't blocked at all (including "blocked because
// archived", which already has its own banner and needs no second explanation here).
function writeAccessBlockedReason() {
  if (isArchived() || !isWriteAccessBlocked()) return null
  const workspaceId = currentWorkspaceId()
  if (credentialStatusForWorkspace(workspaceId) === 'rejected') {
    return { reason: 'rejected', message: 'This credential was rejected — add a working one to edit.' }
  }
  if (hasPatForWorkspace(workspaceId)) {
    return { reason: 'read-only', message: "This credential can read but can't write here — add one with write access to edit." }
  }
  return { reason: 'no-credential', message: 'Browsing without a credential — add one with write access to edit.' }
}

// #126: runs once per credential (web/lib/writeAccess.js's own in-flight/already-checked guards make
// this cheap to call from every render of a shared instance's editor) — the "when a credential is
// entered for a shared workspace, run this check ONCE" trigger, covering both a credential entered
// just now via `<${AddCredentialAction}>` below and one this browser already held for this workspace
// from an earlier visit that was simply never asked about yet.
effect(() => {
  const shared = instanceData.value?.shared
  const slug = currentSlug.value
  if (!shared || !slug) return
  const workspaceId = cachedWorkspaceIdForSlug(slug)
  if (!workspaceId) return
  // Explicit, synchronous signal reads (rather than leaving this effect's dependency tracking to
  // whatever `ensureWriteAccessChecked` itself happens to read before its first `await`) — this is
  // what makes the effect re-run, and so re-trigger the check, the moment a credential is entered or
  // changed for this workspace (`setPatForWorkspace`'s own `patsByWorkspace` signal write) rather than
  // only when `instanceData`/`currentSlug` themselves change.
  if (!hasPatForWorkspace(workspaceId)) return
  if (hasCheckedWriteAccess(workspaceId)) return
  ensureWriteAccessChecked(workspaceId)
})

// The "Add credential" action every gated control's reason pairs with (#126's own acceptance
// criterion) — opens the same shared PAT-prompt modal `apiFetch`'s own 401 handling uses
// (`requestPat`), so submitting here goes through the identical storage path as entering one in
// response to a failed request. A granted submission's write-access check follows from the effect
// above (`instanceData.value.shared` + the now-stored credential), not from anything this button does
// directly — it only has to get a credential stored.
function AddCredentialAction() {
  return html`<button type="button" class="btn small" onClick=${() => requestPat(currentWorkspaceId())}>Add credential</button>`
}

function editableExtension(readOnly) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

// ---------- Formatting toolbar (#133) ----------
//
// One slim toolbar per markdown field, mounted only while that field has
// focus and never on an archived instance. In Split it is the one row for
// both panes and acts on whichever pane the author is working in (#374). Every button (and every shortcut) funnels
// through `runMarkdownCommand`, which reads doc/selection/lezer-tree off the
// live EditorView, hands them to web/lib/markdownCommands.js's deterministic
// transforms (docs/adr/0017), and dispatches the returned (text, selection)
// back as a single CodeMirror transaction — so buttons and shortcuts are the
// same code path by construction, and each command is exactly one undo step.
const markdownToolbarKeymap = keymap.of([
  { key: 'Mod-b', run: (view) => runMarkdownCommand(view, 'bold') },
  { key: 'Mod-i', run: (view) => runMarkdownCommand(view, 'italic') },
  { key: 'Mod-Shift-x', run: (view) => runMarkdownCommand(view, 'strikethrough') },
  { key: 'Mod-e', run: (view) => runMarkdownCommand(view, 'inlineCode') },
  { key: 'Mod-k', run: (view) => runMarkdownCommand(view, 'link') },
  { key: 'Mod-Shift-8', run: (view) => runMarkdownCommand(view, 'bulletList') },
  { key: 'Mod-Shift-7', run: (view) => runMarkdownCommand(view, 'numberedList') },
  { key: 'Mod-Shift-9', run: (view) => runMarkdownCommand(view, 'taskList') },
  // Inside a table Tab walks the cells and Enter appends a row from the last
  // one (#134); this layer sits before basicSetup so it wins over the default
  // indent/newline bindings wherever it chooses to consume the keystroke.
  { key: 'Tab', run: (view) => runTableKey(view, 'tableNextCell') },
  { key: 'Shift-Tab', run: (view) => runTableKey(view, 'tablePrevCell') },
  { key: 'Enter', run: (view) => runTableEnter(view) },
  // Tab indents inside a markdown field; Shift-Tab outdents. The table
  // bindings above consume Tab/Shift-Tab when the caret sits inside a
  // table — they return false otherwise, at which point these bindings
  // pick up the keystroke.  Escape (built into CodeMirror) drops into
  // tab-focus mode so Tab/Shift-Tab then move focus out as before.
  indentWithTab,
])

// While a Visual grid cell has focus only inline formatting applies — a
// heading, list, quote or table dropped into a cell would break its row apart.
const CELL_COMMANDS = new Set(['bold', 'italic', 'strikethrough', 'inlineCode', 'link'])

function runMarkdownCommand(view, name, extra = {}) {
  // Belt-and-braces against read-only: the keymap can't fire there (no
  // contenteditable), but a toolbar click racing an archive still could.
  if (!view || !view.state.facet(EditorView.editable)) return false
  // Focus in a Visual grid cell is invisible to CodeMirror's selection; the
  // cell's own selection stands in for it (#374).
  const cell = activeCellSelection(view)
  if (cell && !CELL_COMMANDS.has(name)) return false
  const range = cell ?? view.state.selection.main
  const text = view.state.doc.toString()
  const result = applyMarkdownCommand(name, {
    tree: syntaxTree(view.state),
    text,
    from: range.from,
    to: range.to,
    ...extra,
  })
  // A null result is the transform's way of saying "not my table" — swallow
  // the keystroke's claim on it and let whatever's underneath have a go.
  if (!result) return false
  // The transform hands back a whole document; only the part that differs is
  // dispatched, so everything around it (and its Visual drawing) stays put.
  view.dispatch({
    changes: diffRange(text, result.text),
    selection: { anchor: result.from, head: result.to },
    // Each command is exactly one undo step, never merged into typing either side of it.
    annotations: isolateHistory.of('full'),
    scrollIntoView: !cell,
  })
  if (cell) requestAnimationFrame(() => restoreActiveCell(view))
  return true
}

// Table keys are contextual (#134): they consume the keystroke only while the
// cursor sits inside a well-formed table. Everywhere else they report false,
// so Tab still indents and Enter still splits lines — graceful degradation,
// not a modal trap.
function runTableKey(view, command) {
  if (!view.state.facet(EditorView.editable)) return false
  const head = view.state.selection.main.head
  if (!findTable(view.state.doc.toString(), head)) return false
  return runMarkdownCommand(view, command)
}

// Enter only hijacks the caret when there is no "next cell" to hand it to:
// from the last cell of the last row it appends a fresh row instead.
function runTableEnter(view) {
  if (!view.state.facet(EditorView.editable)) return false
  const t = findTable(view.state.doc.toString(), view.state.selection.main.head)
  if (!t || t.rowIndex !== t.lines.length - 1 || t.colIndex !== t.colCount - 1) return false
  return runMarkdownCommand(view, 'tableAddRowBelow')
}

// Stroke icons inherit `currentColor`, so one path set works across light,
// dark and high-contrast themes without per-theme assets. The B/I/S letters
// stay plain text on purpose — they're the design language's signature
// self-demonstrating buttons, styled by CSS to show their own effect.
const ToolbarIcon = ({ children }) => html`
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${children}
  </svg>
`
const ICONS = {
  link: html`
    <${ToolbarIcon}>
      <path d="M6.9 8.6a3 3 0 0 0 4.5.3l1.9-1.9a3 3 0 0 0-4.2-4.2L7.9 4" />
      <path d="M9.1 7.4a3 3 0 0 0-4.5-.3l-1.9 1.9a3 3 0 0 0 4.2 4.2l1.2-1.2" />
    <//>
  `,
  image: html`
    <${ToolbarIcon}>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <circle cx="5.5" cy="6" r="1" />
      <path d="M3.2 12l3.2-3 2.2 2 1.7-1.5 2.5 2.5" />
    <//>
  `,
  table: html`
    <${ToolbarIcon}>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2 6.2h12M2 9.8h12M6 2.5v11M10 2.5v11" />
    <//>
  `,
  bulletList: html`
    <${ToolbarIcon}>
      <circle cx="2.9" cy="3.8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="12.2" r="0.5" fill="currentColor" stroke="none" />
      <path d="M6.3 3.8h7.2M6.3 8h7.2M6.3 12.2h7.2" />
    <//>
  `,
  numberedList: html`
    <${ToolbarIcon}>
      <text x="1.1" y="5.8" font-size="5.4" fill="currentColor" stroke="none" font-family="inherit">1</text>
      <text x="1.1" y="10.6" font-size="5.4" fill="currentColor" stroke="none" font-family="inherit">2</text>
      <text x="1.1" y="15.2" font-size="5.4" fill="currentColor" stroke="none" font-family="inherit">3</text>
      <path d="M6.3 3.8h7.2M6.3 8h7.2M6.3 12.2h7.2" />
    <//>
  `,
  taskList: html`
    <${ToolbarIcon}>
      <rect x="1.6" y="2.2" width="3.1" height="3.1" rx="0.6" />
      <rect x="1.6" y="6.4" width="3.1" height="3.1" rx="0.6" />
      <path d="M2.4 12.7l1 1 1.6-1.8" />
      <path d="M6.3 3.8h7.2M6.3 8h7.2M6.3 12.2h7.2" />
    <//>
  `,
  horizontalRule: html`
    <${ToolbarIcon}>
      <path d="M2 8h12" />
    <//>
  `,
  codeBlock: html`
    <${ToolbarIcon}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" />
      <path d="M5.8 6.3L4.1 8l1.7 1.7M10.2 6.3L11.9 8l-1.7 1.7" />
    <//>
  `,
  // The full-screen pair (#135) — arrows out to the corners to expand, back
  // in towards the centre to exit, so the same slot demonstrates its own
  // current action the way the B/I/S letters do.
  expand: html`
    <${ToolbarIcon}>
      <path d="M10 2h4v4M14 2L9.33 6.67M6 14H2v-4M2 14l4.67-4.67" />
    <//>
  `,
  collapse: html`
    <${ToolbarIcon}>
      <path d="M13.33 6.67h-4v-4M9.33 6.67L14 2M2.67 9.33h4v4M6.67 9.33L2 14" />
    <//>
  `,
  // Undo / Redo (#374): one history per field, shared by all three views.
  undo: html`
    <${ToolbarIcon}>
      <path d="M5.5 3.5L2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" />
    <//>
  `,
  redo: html`
    <${ToolbarIcon}>
      <path d="M10.5 3.5l3 3-3 3" />
      <path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9" />
    <//>
  `,
}

function MarkdownToolbar({
  run,
  refocus,
  headingsOpen,
  setHeadingsOpen,
  listsOpen,
  setListsOpen,
  pickerOpen,
  setPickerOpen,
  pickTable,
  expanded,
  onToggleFullscreen,
  onImage,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}) {
  const keepEditorFocus = (e) => e.preventDefault()
  // Formatting buttons with keyboard shortcuts are shortcut-only by design
  // (tabindex="-1" below). Direct insertion actions stay in the tab order.
  const button = (name, label, shortcut, content, onClick, tabIndex = -1, menuOpen, popupRole = 'menu', disabled) =>
    html`
      <button
        type="button"
        class="md-btn"
        disabled=${disabled}
        data-command=${name}
        aria-label=${label}
        title=${shortcut ? `${label} (${shortcut})` : label}
        onMouseDown=${keepEditorFocus}
        onClick=${onClick ?? (() => run(name))}
        tabindex=${tabIndex}
        data-dropdown-trigger=${menuOpen === undefined ? undefined : 'true'}
        aria-haspopup=${menuOpen === undefined ? undefined : popupRole}
        aria-expanded=${menuOpen}
      >
        ${content}
      </button>
    `

  // role="group", not "toolbar": the ARIA toolbar pattern promises arrow-key
  // traversal between controls, which these shortcut-only buttons deliberately
  // don't implement — a labelled group makes no such contract.
  return html`
    <div class="md-toolbar" role="group" aria-label="Formatting">
      <div class="md-headings">
        <${Dropdown}
          triggerLabel=${html`<span class="md-glyph">Headings ▾</span>`}
          triggerClass="md-btn"
          triggerAriaLabel="Headings"
          triggerOnMouseDown=${keepEditorFocus}
          open=${headingsOpen}
          onOpenChange=${(open) => {
            setHeadingsOpen(open)
            // Only a keyboard-driven close (Escape with the trigger or menu
            // holding focus) hands focus back to the editor. An outside click
            // close means the user aimed somewhere else on purpose — refocusing
            // there would yank them back mid-action.
            if (!open && document.activeElement?.closest?.('.md-headings')) refocus()
          }}
        >
          ${HEADING_LEVELS.map(
            (level) => html`
              <button
                type="button"
                class="md-menu-item"
                onMouseDown=${keepEditorFocus}
                onClick=${() => {
                  setHeadingsOpen(false)
                  run(`heading${level}`)
                }}
              >
                Heading ${level}
              </button>
            `
          )}
        <//>
      </div>
      <span class="md-sep" />
      ${button('bold', 'Bold', 'Ctrl/Cmd+B', html`<span class="md-letter md-letter-bold">B</span>`)}
      ${button('italic', 'Italic', 'Ctrl/Cmd+I', html`<span class="md-letter md-letter-italic">I</span>`)}
      ${button(
        'strikethrough',
        'Strikethrough',
        'Ctrl/Cmd+Shift+X',
        html`<span class="md-letter md-letter-strike">S</span>`
      )}
      <span class="md-sep" />
      ${button(
        'inlineCode',
        'Inline code',
        'Ctrl/Cmd+E',
        html`<span class="md-glyph">${'</>'}</span>`
      )}
      ${button('link', 'Link', 'Ctrl/Cmd+K', ICONS.link)}
      <span class="md-sep" />
      <div class="md-lists">
        <${Dropdown}
          triggerLabel=${ICONS.bulletList}
          triggerClass="md-btn"
          triggerAriaLabel="Lists"
          triggerOnMouseDown=${keepEditorFocus}
          open=${listsOpen}
          onOpenChange=${(open) => {
            setListsOpen(open)
            if (!open && document.activeElement?.closest?.('.md-lists')) refocus()
          }}
        >
          ${[
            ['bulletList', 'Bullet list'],
            ['numberedList', 'Numbered list'],
            ['taskList', 'Task list'],
          ].map(
            ([command, label]) => html`
              <button
                type="button"
                class="md-menu-item"
                onMouseDown=${keepEditorFocus}
                onClick=${() => {
                  setListsOpen(false)
                  run(command)
                }}
              >
                ${label}
              </button>
            `
          )}
        <//>
      </div>
      <span class="md-sep" />
      ${button(
        'blockquote',
        'Blockquote',
        null,
        html`<span class="md-glyph md-quote-glyph">${'\u201C'}</span>`
      )}
      ${button('horizontalRule', 'Horizontal rule', null, ICONS.horizontalRule)}
      ${button('codeBlock', 'Code block', null, ICONS.codeBlock)}
      ${button('image', 'Image', null, ICONS.image, onImage, 0)}
      <${TableGridPicker}
        open=${pickerOpen}
        onOpenChange=${setPickerOpen}
        onPick=${pickTable}
        flipOnOverflow=${expanded}
        trigger=${button('insertTable', 'Table', null, ICONS.table, () => setPickerOpen(!pickerOpen), 0, pickerOpen, 'grid')}
      />
      <span class="md-sep" />
      ${button('undo', 'Undo', 'Ctrl/Cmd+Z', ICONS.undo, onUndo, -1, undefined, undefined, !canUndo)}
      ${button('redo', 'Redo', 'Ctrl/Cmd+Y', ICONS.redo, onRedo, -1, undefined, undefined, !canRedo)}
      ${button(
        'fullscreen',
        expanded ? 'Exit full screen' : 'Full screen',
        'Esc',
        expanded ? ICONS.collapse : ICONS.expand,
        onToggleFullscreen
      )}
    </div>
  `
}

// ---------- Markdown field ----------
// One CodeMirror editor per field is the source of truth for its value (docs/adr/0004), so getValue/setValue read and write it directly rather than duplicating it into component state. Visual view (#374, docs/adr/0033) is a decoration layer swapped onto that same editor through a compartment — never a remount, which would lose undo history — and Split adds a second editor beside it carrying the Visual layer, kept in step change by change. Images and diagrams inside Visual are drawn through the same markdown-it -> DOMPurify -> Mermaid path (renderPreview) the old preview pane used.
//
// Every markdown field carries its own generic **Insert ▾** dropdown (#132) — Section (a new custom field appended below this one) and List (a new custom list field) — replacing the single per-module "+ Insert asset" button that preceded it. Image and Table live on the formatting toolbar (#180). Hidden on an archived instance along with every other editing affordance, since that is read-only.

// The remaining two-item menu behind every field's Insert ▾ (#132, #144, #180). Openness is controlled (the shared Dropdown's contract); each item closes the menu before acting, matching how SwimlaneChip's items dismiss through their parent.
function InsertDropdown({ onSection, onList, flipOnOverflow }) {
  const [open, setOpen] = useState(false)

  function pick(action) {
    setOpen(false)
    action()
  }

  return html`
    <${Dropdown}
      className="insert-dropdown"
      triggerLabel="Insert ▾"
      triggerClass="insert-trigger"
      menuRole="menu"
      flipOnOverflow=${flipOnOverflow}
      open=${open}
      onOpenChange=${setOpen}
    >
      <button type="button" role="menuitem" onClick=${() => pick(onSection)}>Section</button>
      <button type="button" role="menuitem" onClick=${() => pick(onList)}>List</button>
    <//>
  `
}

// The Loop-style size grid behind the toolbar's Table action (#134, #180):
// hovering or focusing a cell lights up the R×C rectangle it corners, the
// caption reads out the current size, and clicking inserts. Eight is a
// deliberate ceiling — bigger tables are one Tab-away from growing once they
// exist. The picker accepts its toolbar trigger through the body-function seam.
const TABLE_GRID_SIZE = 8

function TableGridPicker({ open, onOpenChange, onPick, flipOnOverflow, trigger }) {
  const [hover, setHover] = useState(null)

  // A fresh open starts with no preview lit; without this the grid would
  // resurrect whatever corner the mouse last crossed.
  useEffect(() => {
    if (!open) setHover(null)
  }, [open])

  const cells = []
  for (let r = 1; r <= TABLE_GRID_SIZE; r++) {
    for (let c = 1; c <= TABLE_GRID_SIZE; c++) {
      cells.push(html`
        <button
          type="button"
          class="table-picker-cell${hover && r <= hover.r && c <= hover.c ? ' lit' : ''}"
          data-row=${r}
          data-col=${c}
          role="gridcell"
          aria-rowindex=${r}
          aria-colindex=${c}
          aria-label="${c} by ${r} table"
          onMouseEnter=${() => setHover({ r, c })}
          onFocus=${() => setHover({ r, c })}
          onClick=${() => {
            onOpenChange(false)
            onPick(r, c)
          }}
        />
      `)
    }
  }

  return html`
    <${Dropdown}
      className="table-picker"
      open=${open}
      onOpenChange=${onOpenChange}
      flipOnOverflow=${flipOnOverflow}
      menuRole="grid"
      body=${({ menu }) => html`${trigger ?? null}${menu}`}
    >
      <div class="table-picker-grid" onMouseLeave=${() => setHover(null)}>${cells}</div>
      <div class="table-picker-caption" aria-live="polite">
        ${hover ? `${hover.c} × ${hover.r}` : 'Rows × Columns'}
      </div>
    <//>
  `
}

// Contextual table controls (#134): a strip above the formatting toolbar,
// present only while the caret sits inside a well-formed table. Every button
// funnels through the same run() seam as the toolbar — pure transform in,
// one transaction back — so each click is exactly one undo step, and on a
// malformed table every button is a silent no-op by construction.
function TableControlStrip({ run }) {
  const keepEditorFocus = (e) => e.preventDefault()
  const btn = (name, label, glyph) =>
    html`
      <button
        type="button"
        class="md-btn"
        data-command=${name}
        aria-label=${label}
        title=${label}
        tabindex="-1"
        onMouseDown=${keepEditorFocus}
        onClick=${() => run(name)}
      >
        <span class="md-glyph">${glyph}</span>
      </button>
    `
  return html`
    <div class="md-toolbar table-toolbar" role="group" aria-label="Table">
      ${btn('tableAddRowAbove', 'Add row above', '+↑')}
      ${btn('tableAddRowBelow', 'Add row below', '+↓')}
      ${btn('tableDeleteRow', 'Delete row', '−↓')}
      <span class="md-sep" />
      ${btn('tableAddColumnLeft', 'Add column left', '+←')}
      ${btn('tableAddColumnRight', 'Add column right', '+→')}
      ${btn('tableDeleteColumn', 'Delete column', '−→')}
      <span class="md-sep" />
      ${btn('tableCycleAlignment', 'Cycle column alignment', '⇄')}
    </div>
  `
}

// Split's two panes are two editors over one document: a change made in one is
// replayed into the other, tagged so it is not bounced straight back, and
// carrying its user event so the source editor's history groups it as typing.
const paneSync = Annotation.define()

// ---------- Centralised Save (WI #376) ----------
// One Save for the whole stage. ModuleEditorPage owns the behaviour and
// installs it in `stageSaveActions`; the toolbar button, the stage buttons,
// Render, Advance and sign-off all go through it.

// Bumped at most once per task whenever a field's text changes, so the stage's
// unsaved state is re-checked without re-rendering the page on every key.
const contentEdits = signal(0)
let contentEditQueued = false
function noteContentEdit() {
  if (contentEditQueued) return
  contentEditQueued = true
  queueMicrotask(() => {
    contentEditQueued = false
    contentEdits.value += 1
  })
}

// `dirtyModuleIds`: the stage's modules whose content differs from what's saved.
// `phase`: 'idle' | 'saving' | 'saved' | 'error' (with `message`).
const IDLE_STAGE_SAVE = { dirtyModuleIds: [], phase: 'idle', message: '' }
const stageSave = signal(IDLE_STAGE_SAVE)
// Each module card's "Saved — …" line, by module id.
const moduleSaveStatus = signal({})
const NO_STAGE_SAVE = { save: async () => true, confirmLeave: async () => true }
let stageSaveActions = NO_STAGE_SAVE
// Browser back/forward fires popstate on the window itself, where listeners run
// in the order they were added — so this one is added now, before the router
// mounts its own, letting the editor's guard stop the router seeing the event.
let popStateGuard = null
window.addEventListener('popstate', (e) => popStateGuard?.(e))

// For actions that must not run over unsaved edits (Render, Advance, sign-off):
// asks Save / Discard / Cancel first, and runs the action unless the author
// cancelled or their save failed.
function afterUnsavedCheck(action) {
  return async (...args) => {
    if (await stageSaveActions.confirmLeave()) return action(...args)
  }
}

function DiskIcon() {
  return html`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M7 3v5h8V3" />
      <rect x="7" y="13" width="10" height="8" />
    </svg>
  `
}

// The disk button at the top left of the editor toolbar: blue only while
// something differs from what's saved.
function StageSaveButton() {
  const { dirtyModuleIds, phase, message } = stageSave.value
  const count = dirtyModuleIds.length
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S'
  const title = count
    ? `Save (${shortcut}) — ${count} module${count === 1 ? '' : 's'} with changes`
    : `Save (${shortcut}) — nothing to save`
  const state = { saving: 'Saving…', saved: 'Saved', error: message }[phase] ?? ''
  return html`
    <span class="stage-save">
      <button
        type="button"
        class=${'btn small stage-save-btn' + (count ? ' primary' : ' ghost')}
        aria-label="Save"
        title=${title}
        disabled=${!count || phase === 'saving'}
        onClick=${() => stageSaveActions.save()}
      >
        <${DiskIcon} />
      </button>
      <span class=${'stage-save-state' + (phase === 'error' ? ' error' : '')} role="status">${state}</span>
    </span>
  `
}

function UnsavedChangesDialog({ count, onAnswer }) {
  const saveRef = useRef(null)
  useEffect(() => saveRef.current?.focus(), [])
  return html`
    <${Modal} ariaLabel="Unsaved changes" onClose=${() => onAnswer('cancel')}>
      <h3>Save your changes?</h3>
      <p class="guidance">
        ${count === 1 ? 'One module on this stage has' : `${count} modules on this stage have`} unsaved changes.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" onClick=${() => onAnswer('cancel')}>Cancel</button>
        <button type="button" class="btn" onClick=${() => onAnswer('discard')}>Discard</button>
        <button type="button" class="btn primary" ref=${saveRef} onClick=${() => onAnswer('save')}>Save</button>
      </div>
    <//>
  `
}

function forwardChanges(transactions, target) {
  if (!target) return
  for (const tr of transactions) {
    if (tr.changes.empty || tr.annotation(paneSync)) continue
    const userEvent = tr.annotation(Transaction.userEvent)
    target.dispatch({
      changes: tr.changes,
      annotations: userEvent ? [paneSync.of(true), Transaction.userEvent.of(userEvent)] : [paneSync.of(true)],
    })
  }
}

function MarkdownField({ field, moduleId, onRegister, onRequestImage, onRequestSection, onRequestList }) {
  const hostRef = useRef(null)
  // Split view's Visual pane (#374) mounts its own editor here.
  const visualHostRef = useRef(null)
  // The editor-control methods registered up to ModuleCard (getValue/setValue/insertAtCursor) are captured here too, so this field's own Insert ▾ items act on its own cursor without round-tripping through the module.
  const controlRef = useRef(null)
  // The toolbar lives inside this wrapper, so focus never actually leaves the
  // field when a button is pressed — see the focusin/focusout pair below.
  const wrapperRef = useRef(null)
  // The field's main editor: always mounted, and the keeper of its one undo
  // history. Split's Visual pane undoes through it.
  const viewRef = useRef(null)
  const splitViewRef = useRef(null)
  // Whichever pane the author last worked in — the toolbar acts on that one.
  const activeViewRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const [headingsOpen, setHeadingsOpen] = useState(false)
  const [listsOpen, setListsOpen] = useState(false)
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  // True while THIS field's wrapper is the document's full-screen element (#135). State follows the native `fullscreenchange` event — not the toggling click alone — so a browser-driven exit (Esc, F11-ish browser chrome, or the element leaving the DOM) un-expands us exactly when the platform does.
  const [expanded, setExpanded] = useState(false)

  // Full-screen expansion (#135): the wrapper (label + guidance + split panes)
  // is what requests full-screen, so everything the field owns travels into it
  // together and CSS re-flows it to fill the viewport. While
  // any field is expanded we also stamp `data-field-fullscreen` on <html> —
  // the view-mode bar reads that to unstick itself for the duration.
  useEffect(() => {
    // Captured once: Preact detaches refs synchronously during unmount, but
    // runs this cleanup in a deferred flush afterwards — by then
    // wrapperRef.current is null, so the captured node is the only way the
    // cleanup can still recognise our own wrapper.
    const el = wrapperRef.current
    function handleFullscreenChange() {
      setExpanded(document.fullscreenElement === el)
      // Keyed to *whether anything* holds full-screen, not to this field's
      // own match: every mounted field's listener fires for the same
      // transition, so a bystander field must not erase the stamp the
      // expanded field just wrote. (Only one element can be full-screen at a
      // time, so all handlers converge on the same answer.)
      if (document.fullscreenElement) document.documentElement.setAttribute('data-field-fullscreen', '')
      else document.documentElement.removeAttribute('data-field-fullscreen')
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      // Unmounted while holding full-screen (e.g. a future interaction tears
      // down the screen mid-expansion): leave full-screen AND clear the stamp
      // here — our change listener is already gone by the time the exit
      // fires, so nobody else would remove it.
      if (el && document.fullscreenElement === el) {
        document.documentElement.removeAttribute('data-field-fullscreen')
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [])

  function toggleFullscreen() {
    if (!wrapperRef.current) return
    if (document.fullscreenElement === wrapperRef.current) {
      document.exitFullscreen().catch(() => {})
    } else {
      wrapperRef.current.requestFullscreen().catch(() => {})
    }
  }
  // Table awareness (#134): the Markdown view's control strip rides on this
  // flag, refreshed from every selection/doc update below.
  const [inTable, setInTable] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const readOnly = isEditingBlocked()

  useEffect(() => {
    const editableCompartment = new Compartment()
    const splitEditableCompartment = new Compartment()
    const wrapCompartment = new Compartment()
    const visualCompartment = new Compartment()
    const visualLayer = () => visualMode({ renderMarkdown: renderPreview, historyView: () => view })
    let hideToolbarTimer = null
    const state = EditorState.create({
      doc: field.value ?? '',
      extensions: [
        // The shortcut layer goes before basicSetup so Mod-b/Mod-i and friends
        // win over anything the default keymaps would claim first.
        markdownToolbarKeymap,
        basicSetup,
        markdown(),
        editableCompartment.of(editableExtension(isEditingBlocked())),
        wrapCompartment.of(wrap.value ? EditorView.lineWrapping : []),
        visualCompartment.of(viewMode.value === 'visual' ? visualLayer() : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) noteContentEdit()
          // Selection moves count too — Tab-walking cells must flip the strip
          // on/off as the caret crosses the table's edge.
          if (update.docChanged || update.selectionSet) {
            setInTable(!!findTable(update.state.doc.toString(), update.state.selection.main.head))
          }
          const undoCount = undoDepth(update.state)
          const redoCount = redoDepth(update.state)
          setHistory((h) => (h.undo === undoCount && h.redo === redoCount ? h : { undo: undoCount, redo: redoCount }))
        }),
      ],
    })
    const view = new EditorView({
      state,
      parent: hostRef.current,
      dispatchTransactions: (transactions, target) => {
        target.update(transactions)
        forwardChanges(transactions, splitViewRef.current)
      },
    })
    viewRef.current = view
    activeViewRef.current = view

    function createSplitView() {
      const split = new EditorView({
        state: EditorState.create({
          doc: view.state.doc.toString(),
          extensions: [
            // One timeline per field: undo in either pane walks the main editor's history.
            keymap.of([
              { key: 'Mod-z', run: () => undo(view), preventDefault: true },
              { key: 'Mod-y', run: () => redo(view), preventDefault: true },
              { key: 'Mod-Shift-z', run: () => redo(view), preventDefault: true },
            ]),
            markdownToolbarKeymap,
            basicSetup,
            markdown(),
            splitEditableCompartment.of(editableExtension(isEditingBlocked())),
            visualLayer(),
          ],
        }),
        parent: visualHostRef.current,
        dispatchTransactions: (transactions, target) => {
          target.update(transactions)
          forwardChanges(transactions, view)
        },
      })
      split.dom.addEventListener('focusin', handleFocusIn)
      split.dom.addEventListener('focusout', handleFocusOut)
      splitViewRef.current = split
    }

    function destroySplitView() {
      const split = splitViewRef.current
      if (!split) return
      splitViewRef.current = null
      if (activeViewRef.current === split) activeViewRef.current = view
      split.dom.removeEventListener('focusin', handleFocusIn)
      split.dom.removeEventListener('focusout', handleFocusOut)
      split.destroy()
    }

    // Track the global view-mode signal for as long as this editor is mounted. Visual swaps the decoration layer onto this same editor; Split adds the Visual pane beside it; Markdown is the bare text. The editor itself is never torn down, so history survives every switch.
    const stopViewModeSync = effect(() => {
      const mode = viewMode.value
      clearActiveCell(view)
      // A view switch also closes the current undo step, so an edit either side of it undoes on its own.
      view.dispatch({
        effects: visualCompartment.reconfigure(mode === 'visual' ? visualLayer() : []),
        annotations: isolateHistory.of('full'),
      })
      if (mode === 'split') {
        if (!splitViewRef.current) createSplitView()
      } else {
        destroySplitView()
      }
    })

    // Archiving (or restoring) an instance while it is open flips read-only live — and so, per #126,
    // does a write-access check resolving (in either direction) for a shared instance's stored
    // credential: `isEditingBlocked()` reads `instanceData`/credential/write-access signals, so this
    // effect re-runs and reconfigures the editor the moment any of them changes, with no reload.
    const stopEditableSync = effect(() => {
      const blocked = isEditingBlocked()
      view.dispatch({ effects: editableCompartment.reconfigure(editableExtension(blocked)) })
      splitViewRef.current?.dispatch({ effects: splitEditableCompartment.reconfigure(editableExtension(blocked)) })
    })

    const stopWrapSync = effect(() => {
      view.dispatch({ effects: wrapCompartment.reconfigure(wrap.value ? EditorView.lineWrapping : []) })
    })

    // Redraw Visual images when the asset source map becomes available (initial async load) — citations depend on it, but the field was already drawn once without them (#147). Also redraws once a local-workspace asset's object URL resolves (WI #297) — the first render of an `asset:<id>` reference in a local instance has no URL yet (readBinaryFile is async), so this fires again once localAssetUrls picks it up.
    const stopAssetSourceSync = effect(() => {
      const _sources = assetSources.value
      const _localUrls = localAssetUrls.value
      view.dispatch({ effects: refreshVisual.of(null) })
      splitViewRef.current?.dispatch({ effects: refreshVisual.of(null) })
    })

    // Inserts a snippet at the current cursor position (or over the current selection) of the pane the author is working in, on its own line — "clicking one inserts its reference at the trigger point" (#80).
    function insertAtCursor(snippet) {
      const target = activeViewRef.current ?? view
      const { from, to } = target.state.selection.main
      const needsLeadingNewline = from > 0 && target.state.doc.sliceString(from - 1, from) !== '\n'
      const insertText = `${needsLeadingNewline ? '\n' : ''}${snippet}\n`
      target.dispatch({
        changes: { from, to, insert: insertText },
        selection: { anchor: from + insertText.length },
      })
      target.focus()
    }
    controlRef.current = { insertAtCursor }

    function handleFocusIn(e) {
      clearTimeout(hideToolbarTimer)
      activeViewRef.current = splitViewRef.current?.dom.contains(e.target) ? splitViewRef.current : view
      setFocused(true)
    }
    // Toolbar visibility follows real focus, but moving focus *within* the
    // field (to a toolbar button, the headings menu, or the other Split pane)
    // must not flash the bar away — hence checking where focus is headed
    // rather than hiding unconditionally.
    //
    // The hide itself must also wait out the mouse sequence that caused the
    // blur: focus moves during *mousedown*, and unmounting the bar right then
    // shifts layout before *mouseup* lands, so the click that blurred us never
    // dispatches at all (observed as a silently swallowed "Save Context"
    // press). Deferring the unmount a tick lets that first click complete —
    // the same grace period every dismiss-on-outside-click popover needs.
    function handleFocusOut(e) {
      if (wrapperRef.current?.contains(e.relatedTarget)) return
      clearTimeout(hideToolbarTimer)
      hideToolbarTimer = setTimeout(() => setFocused(false), 150)
    }
    view.dom.addEventListener('focusin', handleFocusIn)
    view.dom.addEventListener('focusout', handleFocusOut)

    onRegister({
      getValue: () => view.state.doc.toString(),
      setValue: (text) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } })
      },
      insertAtCursor,
    })

    return () => {
      view.dom.removeEventListener('focusin', handleFocusIn)
      view.dom.removeEventListener('focusout', handleFocusOut)
      clearTimeout(hideToolbarTimer)
      stopViewModeSync()
      stopEditableSync()
      stopWrapSync()
      stopAssetSourceSync()
      destroySplitView()
      viewRef.current = null
      activeViewRef.current = null
      view.destroy()
    }
    // One editor per mount — the enclosing stage screen remounts wholesale (keyed by stage id) on stage switch, matching the old full-rebuild behaviour, so this never needs to react to `field` changing in place.
    // eslint-disable-next-line
  }, [])

  const targetView = () => activeViewRef.current ?? viewRef.current
  const runCommand = useCallback((name, extra) => runMarkdownCommand(targetView(), name, extra), [])
  // Back to where the author was: their grid cell if they were in one, else the editor.
  const refocusEditor = useCallback(() => {
    const target = targetView()
    if (!restoreActiveCell(target)) target?.focus()
  }, [])
  const runHistory = useCallback(
    (command) => {
      if (!viewRef.current) return
      command(viewRef.current)
      requestAnimationFrame(refocusEditor)
    },
    [refocusEditor]
  )
  const handlePickerOpenChange = useCallback(
    (open) => {
      setPickerOpen(open)
      if (!open && document.activeElement?.closest?.('.table-picker')) refocusEditor()
    },
    [refocusEditor]
  )
  // Visible while the field holds focus, and stays up while the headings or
  // lists menu is open (a menu click moves focus to its trigger button). While
  // the field is full-screen the bar is unconditional (#135): the expanded
  // panel must keep its toolbar even if focus wanders.
  const showToolbar = focused || headingsOpen || listsOpen || expanded
  // The contextual strip is Markdown view's table cue; Visual and Split use
  // the grid's own handles instead (#374).
  const showTableStrip = showToolbar && inTable && viewMode.value === 'markdown'
  // The grid picker inserts straight through the command dispatcher, so the
  // new table arrives with blank-line hygiene and a parked caret for free.
  // The grid's rectangle counts the header row, the engine's `rows` counts
  // body rows — hence the -1 (and a floor of one body row, since a header
  // alone can't take the caret). In Visual the author lands in the new grid's
  // first body cell.
  const pickTable = useCallback(
    (rows, cols) => {
      const target = targetView()
      if (!runMarkdownCommand(target, 'insertTable', { rows: Math.max(rows - 1, 1), cols })) {
        refocusEditor()
        return
      }
      if (!focusTableCellAt(target, target.state.selection.main.head)) target.focus()
    },
    [refocusEditor]
  )

  const headingIdForField = moduleId ? headingId(moduleId, field.title) : null
  return html`
    <div class="field field-markdown" ref=${wrapperRef}>
      ${headingIdForField
        ? html`<h3 id=${headingIdForField} class="field-heading">${field.title}${field.required ? ' *' : ''}</h3><label class="visually-hidden" style="display:none">${field.title}${field.required ? ' *' : ''}</label>`
        : html`<label>${field.title}${field.required ? ' *' : ''}</label>`}
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      ${!readOnly && showToolbar
        ? html`
            ${showTableStrip ? html`<${TableControlStrip} run=${runCommand} />` : null}
            <${MarkdownToolbar}
              run=${runCommand}
              refocus=${refocusEditor}
              headingsOpen=${headingsOpen}
              setHeadingsOpen=${setHeadingsOpen}
              listsOpen=${listsOpen}
              setListsOpen=${setListsOpen}
              pickerOpen=${pickerOpen}
              setPickerOpen=${handlePickerOpenChange}
              pickTable=${pickTable}
              expanded=${expanded}
              onToggleFullscreen=${toggleFullscreen}
              onImage=${() => onRequestImage?.()}
              onUndo=${() => runHistory(undo)}
              onRedo=${() => runHistory(redo)}
              canUndo=${history.undo > 0}
              canRedo=${history.redo > 0}
            />
          `
        : null}
      <div class="split">
        <div class="editor-pane">
          <div class="editor-host" ref=${hostRef}></div>
        </div>
        <div class="visual-pane">
          <div class="editor-host" ref=${visualHostRef}></div>
        </div>
      </div>
      ${!readOnly && !expanded
        ? html`
            <div class="insert-bar">
              <${InsertDropdown}
                onSection=${() => onRequestSection?.()}
                onList=${() => onRequestList?.()}
                flipOnOverflow=${expanded}
              />
            </div>
          `
        : null}
    </div>
  `
}

// ---------- List field ----------
// List rows are textareas, not single-line inputs, so an entry longer than the
// column wraps and grows to show every line instead of scrolling out of view.
function autosizeTextarea(el) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// type: select (#81/#82, ADR-0044): a single-choice dropdown over `field.options`, a plain
// string list. Opens unselected on a field with no stored value — a required select is never
// satisfied by a browser default, only by an author's own choice. A stored value outside
// `options` (hand-edited content, or a draft definition whose options changed) is preserved:
// it gets a synthetic extra <option>, marked both in its own label and with a warning line
// below the control, so a subsequent Save can't quietly overwrite it with a blank or the
// first option — `check` reports the same condition (lib/status.js's selectOffListWarnings).
function SelectField({ field, moduleId, onRegister }) {
  return field.multiple
    ? html`<${MultiSelectField} field=${field} moduleId=${moduleId} onRegister=${onRegister} />`
    : html`<${SingleSelectField} field=${field} moduleId=${moduleId} onRegister=${onRegister} />`
}

function SingleSelectField({ field, moduleId, onRegister }) {
  // default: (#84, ADR-0044) pre-selects in the editor but is never written at Instance creation —
  // an untouched Field has no stored value, so the control's own initial value falls back to the
  // default here. Saving writes whatever the control holds, which is why this alone is enough to
  // make "the first save writes the default": there is nothing further to special-case.
  const valueRef = useRef(field.value || field.default || '')
  const [, bump] = useState(0)
  const rerender = () => {
    bump((n) => n + 1)
    noteContentEdit()
  }

  useEffect(() => {
    onRegister({
      getValue: () => valueRef.current,
      setValue: (value) => {
        valueRef.current = value ?? ''
        rerender()
      },
    })
    // A default applied at mount, with no keystroke or change event to notify the stage's dirty
    // tracking, would otherwise leave Save disabled until the author touched the field — even
    // though what would be saved (the default) already differs from what's on disk (empty).
    if (!field.value && field.default) noteContentEdit()
    // eslint-disable-next-line
  }, [])

  const options = field.options ?? []
  const offList = valueRef.current !== '' && !options.includes(valueRef.current)
  const headingIdForField = moduleId ? headingId(moduleId, field.title) : null

  return html`
    <div class="field field-select">
      ${headingIdForField
        ? html`<h3 id=${headingIdForField} class="field-heading">${field.title}${field.required ? ' *' : ''}</h3><label class="visually-hidden" style="display:none">${field.title}${field.required ? ' *' : ''}</label>`
        : html`<label>${field.title}${field.required ? ' *' : ''}</label>`}
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <select
        disabled=${isEditingBlocked()}
        value=${valueRef.current}
        onChange=${(e) => {
          valueRef.current = e.currentTarget.value
          rerender()
        }}
      >
        <option value="">— Select —</option>
        ${offList ? html`<option value=${valueRef.current} class="field-select-offlist">${valueRef.current} (not in option list)</option>` : null}
        ${options.map((option) => html`<option value=${option} key=${option}>${option}</option>`)}
      </select>
      ${offList ? html`<p class="field-select-warning">This value isn't in the current option list. It's kept as-is — pick a listed option to replace it, or leave it and fix the Definition's options.</p>` : null}
    </div>
  `
}

// select multiple: true (#83, ADR-0044): a variation within select, not a second field type —
// several options ticked instead of one chosen. Checkboxes rather than a native multi-select
// (which needs ctrl/cmd-click to pick more than one, an affordance most authors never discover):
// four required vetting checks should be four clicks, not four modifier-held clicks. An off-list
// stored value (from `multiple: false` -> `true` authoring, or hand edits) gets its own checked,
// marked row so it survives a save exactly like the single-select's synthetic extra <option>.
function MultiSelectField({ field, moduleId, onRegister }) {
  const valuesRef = useRef(Array.isArray(field.value) ? [...field.value] : [])
  const [, bump] = useState(0)
  const rerender = () => {
    bump((n) => n + 1)
    noteContentEdit()
  }

  useEffect(() => {
    onRegister({
      getValue: () => valuesRef.current,
      setValue: (values) => {
        valuesRef.current = Array.isArray(values) ? [...values] : []
        rerender()
      },
    })
    // eslint-disable-next-line
  }, [])

  function toggle(option, checked) {
    valuesRef.current = checked
      ? [...valuesRef.current, option]
      : valuesRef.current.filter((v) => v !== option)
    rerender()
  }

  const options = field.options ?? []
  const offListValues = valuesRef.current.filter((v) => !options.includes(v))
  const headingIdForField = moduleId ? headingId(moduleId, field.title) : null
  const allOptions = [...options, ...offListValues]

  return html`
    <div class="field field-select field-select-multiple">
      ${headingIdForField
        ? html`<h3 id=${headingIdForField} class="field-heading">${field.title}${field.required ? ' *' : ''}</h3><label class="visually-hidden" style="display:none">${field.title}${field.required ? ' *' : ''}</label>`
        : html`<label>${field.title}${field.required ? ' *' : ''}</label>`}
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <div class="select-checkboxes">
        ${allOptions.map((option) => {
          const isOffList = !options.includes(option)
          return html`
            <label class="select-checkbox-row ${isOffList ? 'field-select-offlist' : ''}" key=${option}>
              <input
                type="checkbox"
                disabled=${isEditingBlocked()}
                checked=${valuesRef.current.includes(option)}
                onChange=${(e) => toggle(option, e.currentTarget.checked)}
              />
              <span>${option}${isOffList ? ' (not in option list)' : ''}</span>
            </label>
          `
        })}
      </div>
      ${offListValues.length ? html`<p class="field-select-warning">${offListValues.length === 1 ? 'A checked value isn’t' : 'Some checked values aren’t'} in the current option list. Kept as-is — untick to remove, or fix the Definition's options.</p>` : null}
    </div>
  `
}

// type: text (#85, ADR-0044): a single-line string — a person's name, a reference number —
// where a markdown field's multi-line editor and toolbar would be the wrong tool. Same
// getValue/setValue/onRegister control contract as every other field type.
function TextField({ field, moduleId, onRegister }) {
  const valueRef = useRef(field.value || '')
  const [, bump] = useState(0)
  const rerender = () => {
    bump((n) => n + 1)
    noteContentEdit()
  }

  useEffect(() => {
    onRegister({
      getValue: () => valueRef.current,
      setValue: (value) => {
        valueRef.current = value ?? ''
        rerender()
      },
    })
    // eslint-disable-next-line
  }, [])

  const headingIdForField = moduleId ? headingId(moduleId, field.title) : null

  return html`
    <div class="field field-text">
      ${headingIdForField
        ? html`<h3 id=${headingIdForField} class="field-heading">${field.title}${field.required ? ' *' : ''}</h3><label class="visually-hidden" style="display:none">${field.title}${field.required ? ' *' : ''}</label>`
        : html`<label>${field.title}${field.required ? ' *' : ''}</label>`}
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <input
        type="text"
        disabled=${isEditingBlocked()}
        value=${valueRef.current}
        onInput=${(e) => {
          valueRef.current = e.currentTarget.value
          rerender()
        }}
      />
    </div>
  `
}

// type: date (#85, ADR-0044): a calendar date, authored through the browser's native date
// picker (no custom widget) and stored as the YYYY-MM-DD string the input already produces —
// no time-of-day, no timezone, nothing this control has to convert either way.
function DateField({ field, moduleId, onRegister }) {
  const valueRef = useRef(field.value || '')
  const [, bump] = useState(0)
  const rerender = () => {
    bump((n) => n + 1)
    noteContentEdit()
  }

  useEffect(() => {
    onRegister({
      getValue: () => valueRef.current,
      setValue: (value) => {
        valueRef.current = value ?? ''
        rerender()
      },
    })
    // eslint-disable-next-line
  }, [])

  const headingIdForField = moduleId ? headingId(moduleId, field.title) : null

  return html`
    <div class="field field-date">
      ${headingIdForField
        ? html`<h3 id=${headingIdForField} class="field-heading">${field.title}${field.required ? ' *' : ''}</h3><label class="visually-hidden" style="display:none">${field.title}${field.required ? ' *' : ''}</label>`
        : html`<label>${field.title}${field.required ? ' *' : ''}</label>`}
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <input
        type="date"
        disabled=${isEditingBlocked()}
        value=${valueRef.current}
        onInput=${(e) => {
          valueRef.current = e.currentTarget.value
          rerender()
        }}
      />
    </div>
  `
}

function ListField({ field, moduleId, onRegister, onRemove, onRequestSection, onRequestList }) {
  const rowsRef = useRef(field.value?.length ? [...field.value] : [''])
  const [, bump] = useState(0)
  const rerender = () => {
    bump((n) => n + 1)
    noteContentEdit()
  }

  useEffect(() => {
    onRegister({
      getValue: () => rowsRef.current.filter((v) => v.trim() !== ''),
      setValue: (values) => {
        rowsRef.current = values?.length ? [...values] : ['']
        rerender()
      },
    })
    // eslint-disable-next-line
  }, [])

  function updateRow(i, value) {
    rowsRef.current = rowsRef.current.map((v, idx) => (idx === i ? value : v))
    rerender()
  }
  function removeRow(i) {
    const next = rowsRef.current.filter((_, idx) => idx !== i)
    const nonEmpty = next.filter((v) => v.trim() !== '').length
    // WI 149: removing the last remaining item from a custom-inserted list removes the whole segment including its heading. Scope is strictly custom lists — schema-defined type:list fields keep preserve-when-empty behaviour.
    if (field.custom && nonEmpty === 0 && typeof onRemove === 'function') {
      onRemove(field.id)
      return
    }
    rowsRef.current = next
    rerender()
  }
  function addRow() {
    rowsRef.current = [...rowsRef.current, '']
    rerender()
  }

  const headingIdForField = moduleId ? headingId(moduleId, field.title) : null
  return html`
    <div class="field field-list">
      ${headingIdForField
        ? html`<h3 id=${headingIdForField} class="field-heading">${field.title}${field.required ? ' *' : ''}</h3><label class="visually-hidden" style="display:none">${field.title}${field.required ? ' *' : ''}</label>`
        : html`<label>${field.title}${field.required ? ' *' : ''}</label>`}
      ${field.guidance ? html`<p class="guidance">${field.guidance}</p>` : null}
      <div class="list-rows">
        ${rowsRef.current.map(
          (value, i) => html`
            <div class="list-row" key=${i}>
              <textarea
                rows="1"
                value=${value}
                readOnly=${isEditingBlocked()}
                ref=${autosizeTextarea}
                onInput=${(e) => {
                  autosizeTextarea(e.currentTarget)
                  updateRow(i, e.currentTarget.value)
                }}
              ></textarea>
              ${!isEditingBlocked()
                ? html`<button type="button" class="btn small" onClick=${() => removeRow(i)}>Remove</button>`
                : null}
            </div>
          `
        )}
      </div>
      ${!isEditingBlocked() ? html`<button type="button" class="btn small" onClick=${addRow}>Add</button>` : null}
      ${!isEditingBlocked()
        ? html`
            <div class="insert-bar">
              <${InsertDropdown}
                onSection=${() => onRequestSection?.()}
                onList=${() => onRequestList?.()}
                flipOnOverflow=${false}
              />
            </div>
          `
        : null}
    </div>
  `
}

// ---------- Read-only carried-forward module (#152, docs/adr/0050) ----------
// A module the viewed stage lists in `read-only-modules`: mounted so the stage's documents render and
// its gate can be evaluated, but owned — and edited — at an earlier stage. Shown as its saved content
// with no editors, no required markers and no Insert ▾, plus a note naming the home stage. Its fields
// never register an editor control, so the centralised Save never sees it as changed and never sends
// it (the server would refuse it anyway). Headings keep their usual ids so Navigation still jumps here.
function ReadOnlyFieldValue({ field }) {
  const ref = useRef(null)
  const value = field.value
  const isEmpty = Array.isArray(value) ? value.length === 0 : !String(value ?? '').trim()
  // Lists and markdown go through the same preview renderer the editors' Visual view uses; select,
  // text and date values are plain strings (a multi-select is a list of them).
  const markdown = isEmpty
    ? ''
    : field.type === 'list'
      ? value.map((item) => `- ${item}`).join('\n')
      : field.type === 'markdown' || field.custom
        ? String(value)
        : null
  useEffect(() => {
    if (markdown !== null) renderPreview(ref.current, markdown)
  }, [markdown, assetSources.value])
  if (isEmpty) return html`<p class="read-only-value muted">Not filled in.</p>`
  if (markdown !== null) return html`<div class="read-only-value" ref=${ref}></div>`
  return html`<p class="read-only-value">${Array.isArray(value) ? value.join(', ') : value}</p>`
}

function ReadOnlyModuleCard({ mod, visibleFieldIds }) {
  const home = mod.readOnly.homeStage
  return html`
    <section class="module module-read-only" data-read-only="true">
      <h2 id=${headingId(mod.id, mod.title)}>${mod.title}</h2>
      <p class="read-only-note">
        ${home
          ? html`Read-only at this stage — carried forward from <strong>${home.title}</strong>, where it is edited.`
          : 'Read-only at this stage.'}
      </p>
      ${mod.purpose ? html`<p class="purpose">${mod.purpose}</p>` : null}
      ${mod.fields.filter((field) => !visibleFieldIds || visibleFieldIds.has(`${mod.id}.${field.id}`)).map(
        (field) => html`
          <div key=${field.id} class="field field-read-only">
            <h3 id=${headingId(mod.id, field.title)} class="field-heading">${field.title}</h3>
            <label class="visually-hidden" style="display:none">${field.title}</label>
            <${ReadOnlyFieldValue} field=${field} />
          </div>
        `
      )}
    </section>
  `
}

// ---------- One module's card: fields + its save status line ----------
// Saving is stage-wide (WI #376, the toolbar's Save); the card keeps only the
// "Saved — complete / outstanding" line for its own module.
function ModuleCard({ mod, onFieldRegistered, visibleFieldIds }) {
  // Which markdown field the image-insert modal targets: the one whose own
  // toolbar Image action was clicked (#180 — no more module-level affordance
  // guessing from focus). Null = closed.
  const [imageFieldId, setImageFieldId] = useState(null)
  // Which field the new Section goes below: the one whose Insert ▾ → Section was clicked. Null = dialog closed.
  const [sectionAfterId, setSectionAfterId] = useState(null)
  // Which field the new List goes below: the one whose Insert ▾ → List was clicked. Null = dialog closed.
  const [listAfterId, setListAfterId] = useState(null)
  // Editor controls keyed by FIELD ID (not array index): inserting a Section shifts every later field's display index without remounting it (components are keyed by field id), so index-keyed lookups would go stale mid-session. Ids never shift.
  const controlsRef = useRef({})

  function handleInsertImage(asset) {
    // Prime the source map so the just-inserted image's citation renders immediately, without waiting for the next async fetchAssets round-trip.
    if (asset?.id && asset?.source) assetSources.value = { ...assetSources.value, [asset.id]: asset.source }
    // #16 — a GitHub-backed instance's asset is a real repo-committed file (WI260 convention), not a
    // manifest entry, so it's referenced and cited the same way; its citation comes from the file's
    // own GitHub address instead, computed by renderPreview/the render pipeline, not authored here.
    const ref = isGitHubBackedInstance(instanceData.value) ? repoAssetReference(asset) : assetReference(asset)
    controlsRef.current[imageFieldId]?.insertAtCursor?.(ref)
    setImageFieldId(null)
  }

  // Insert ▾ → Section (#132): appends a new custom markdown field immediately below the requesting field. Client-side only until the next Save — the custom field joins the module's field list (and hence the save payload's layout), and the parser preserves its `## <title>` block from then on.
  function handleInsertSection(title) {
    const afterIndex = mod.fields.findIndex((f) => f.id === sectionAfterId)
    const newField = {
      id: uniqueCustomFieldClientId(),
      title: title.trim() ? title.trim() : 'Untitled section',
      type: 'markdown',
      required: false,
      guidance: null,
      value: '',
      example: null,
      custom: true,
    }
    const fields = [...mod.fields]
    fields.splice(afterIndex + 1, 0, newField)
    instanceData.value = {
      ...instanceData.value,
      modules: instanceData.value.modules.map((m) => (m.id === mod.id ? { ...m, fields } : m)),
    }
    setSectionAfterId(null)
  }

  // Insert ▾ → List (#144): appends a new custom list field immediately below the requesting field. Client-side only until the next Save — the custom field joins the module's field list (and hence the save payload's layout), and the parser preserves its ## Title section as a list-typed field from then on.
  function handleInsertList(title) {
    const afterIndex = mod.fields.findIndex((f) => f.id === listAfterId)
    const newField = {
      id: uniqueCustomFieldClientId(),
      title: title.trim() ? title.trim() : 'Untitled list',
      type: 'list',
      required: false,
      guidance: null,
      value: [],
      example: null,
      custom: true,
    }
    const fields = [...mod.fields]
    fields.splice(afterIndex + 1, 0, newField)
    instanceData.value = {
      ...instanceData.value,
      modules: instanceData.value.modules.map((m) => (m.id === mod.id ? { ...m, fields } : m)),
    }
    setListAfterId(null)
  }

  // WI 149: removing the last remaining item from a custom-inserted list removes the whole segment including its heading.
  function handleRemoveCustomField(fieldId) {
    const fields = mod.fields.filter((f) => f.id !== fieldId)
    delete controlsRef.current[fieldId]
    instanceData.value = {
      ...instanceData.value,
      modules: instanceData.value.modules.map((m) => (m.id === mod.id ? { ...m, fields } : m)),
    }
  }

  return html`
    <section class="module">
      <h2 id=${headingId(mod.id, mod.title)}>${mod.title}</h2>
      ${mod.purpose ? html`<p class="purpose">${mod.purpose}</p>` : null}
      ${mod.fields.filter((field) => !visibleFieldIds || visibleFieldIds.has(`${mod.id}.${field.id}`)).map((field) => {
        const onRegister = (control) => {
          controlsRef.current[field.id] = control
          onFieldRegistered(field, control, mod.id)
        }
        if (field.type === 'select') {
          return html`<${SelectField} key=${field.id} field=${field} moduleId=${mod.id} onRegister=${onRegister} />`
        }
        if (field.type === 'text') {
          return html`<${TextField} key=${field.id} field=${field} moduleId=${mod.id} onRegister=${onRegister} />`
        }
        if (field.type === 'date') {
          return html`<${DateField} key=${field.id} field=${field} moduleId=${mod.id} onRegister=${onRegister} />`
        }
        const isList = isMultiValuedField(field)
        return isList
          ? html`<${ListField}
              key=${field.id}
              field=${field}
              moduleId=${mod.id}
              onRegister=${onRegister}
              onRemove=${field.custom ? handleRemoveCustomField : undefined}
              onRequestSection=${() => setSectionAfterId(field.id)}
              onRequestList=${() => setListAfterId(field.id)}
            />`
          : html`<${MarkdownField}
              key=${field.id}
              field=${field}
              moduleId=${mod.id}
              onRegister=${onRegister}
              onRequestImage=${() => setImageFieldId(field.id)}
              onRequestSection=${() => setSectionAfterId(field.id)}
              onRequestList=${() => setListAfterId(field.id)}
            />`
      })}
      <div class="save-status">${moduleSaveStatus.value[mod.id] ?? ''}</div>
      ${imageFieldId !== null
        ? html`<${AssetInsertModal} onInsert=${handleInsertImage} onClose=${() => setImageFieldId(null)} />`
        : null}
      ${sectionAfterId !== null
        ? html`<${SectionDialog} onConfirm=${handleInsertSection} onClose=${() => setSectionAfterId(null)} />`
        : null}
      ${listAfterId !== null
        ? html`<${ListDialog} onConfirm=${handleInsertList} onClose=${() => setListAfterId(null)} />`
        : null}
    </section>
  `
}

// A client-side-unique id for a just-inserted custom field (#132) — only ever a handle for component keys and the in-flight save payload; the server re-derives deterministic ids from the stored headings on every read.
function uniqueCustomFieldClientId() {
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Shared modal shell for dialogs that need the standard Escape and backdrop-click dismissal behavior. Existing dialogs retain their local shells for now; new dialogs should use this component instead of repeating that boilerplate.
function Modal({ ariaLabel, onClose, children }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label=${ariaLabel}>
        ${children}
      </div>
    </div>
  `
}

// The Insert ▾ → Section prompt (#132): asks for the optional one-line title (rendered as the block's ## heading; blank becomes "Untitled section") and inserts the new block below the requesting field on confirm. Same modal shape as AssetInsertModal and the confirm dialogs above.
function SectionDialog({ onConfirm, onClose }) {
  const [title, setTitle] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="New section">
        <h3>New section</h3>
        <div class="upload-field">
          <label class="field-label">Title (optional)</label>
          <input
            ref=${inputRef}
            class="text-field"
            type="text"
            placeholder="e.g. Risks we're carrying forward"
            value=${title}
            onInput=${(e) => setTitle(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Enter' && onConfirm(title)}
          />
        </div>
        <p class="guidance">Adds an editable block below this field. Its title renders as a "##" heading and is preserved across saves.</p>
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
          <button type="button" class="btn primary" onClick=${() => onConfirm(title)}>Insert section</button>
        </div>
      </div>
    </div>
  `
}

// The Insert ▾ → List prompt (#144): asks for the one-line title (rendered as the block's ## heading; blank becomes "Untitled list") and inserts a new list-typed field below the requesting field on confirm. Same modal shape as SectionDialog; the new field uses the existing ListField component for its rows UI.
function ListDialog({ onConfirm, onClose }) {
  const [title, setTitle] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="New list">
        <h3>New list</h3>
        <div class="upload-field">
          <label class="field-label">Title (optional)</label>
          <input
            ref=${inputRef}
            class="text-field"
            type="text"
            placeholder="e.g. Teams and contact persons"
            value=${title}
            onInput=${(e) => setTitle(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Enter' && onConfirm(title)}
          />
        </div>
        <p class="guidance">Adds a structured rows editor below this field. Items are preserved as a bulleted list in the file.</p>
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
          <button type="button" class="btn primary" onClick=${() => onConfirm(title)}>Insert list</button>
        </div>
      </div>
    </div>
  `
}

function CommitHistoryDialog({ commits, onClose, stageTitle, refName, status, loading = false }) {
  const list = commits ?? []
  const hasCommits = list.length > 0
  const heading = stageTitle ? `Commit history - ${stageTitle}` : 'Commit history'

  return html`
    <${Modal} ariaLabel="Commit history" onClose=${onClose}>
      <h3>${heading}</h3>
      ${refName ? html`<p class="commit-history-ref"><code>${refName}</code></p>` : null}
      ${loading ? html`<p class="save-status">Loading...</p>` : null}
      ${!loading && status ? html`<p class="save-status">${status}</p>` : null}
      ${!loading && !hasCommits && !status ? html`<p class="save-status">No commits yet</p>` : null}
      ${hasCommits
        ? html`
            <ul class="request-approval-commits">
              ${list.map(
                (commit) => html`
                  <li key=${commit.commitId}>
                    <span>${commit.message || '(no message)'}</span>
                    <time dateTime=${commit.timestamp ?? undefined}>${commit.timestamp ? new Date(commit.timestamp).toLocaleString() : 'Unknown time'}</time>
                  </li>
                `,
              )}
            </ul>
          `
        : null}
      <div class="modal-actions">
        <button type="button" class="btn ghost" onClick=${onClose}>Close</button>
      </div>
    <//>
  `
}

// ---------- Insert-image modal: Upload new / Choose existing ----------
// Opened by any markdown field's toolbar Image action (#180; #132 renamed the
// wording Asset → Image throughout the UI while leaving `asset:<id>` storage
// and the /api routes untouched). Hidden in Rendered view along with every
// other editing affordance (see MarkdownField/ModuleCard). Ported from Variant
// A of web/prototypes/asset-insertion.prototype.html (#73), the variant #74
// locked in: a modal with two tabs, the "Upload new" tab blocked by an inline
// error until both the file and the mandatory source-location field are valid.
function AssetInsertModal({ onInsert, onClose }) {
  const [tab, setTab] = useState('upload')
  const [file, setFile] = useState(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [existing, setExisting] = useState(null)
  const [existingError, setExistingError] = useState('')

  useEffect(() => {
    if (tab !== 'existing' || existing !== null) return
    fetchAssets(currentSlug.value)
      .then(setExisting)
      .catch((err) => setExistingError(err.message))
  }, [tab, existing])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // #16: a GitHub-backed instance's upload lands as a real committed file (WI260 convention) whose
  // citation is the file's own GitHub address, computed automatically — unlike the `asset:<id>`
  // manifest convention (every other instance kind), it has no separate `source` to hand-type.
  const isGitHubBacked = isGitHubBackedInstance(instanceData.value)

  async function handleSubmitUpload() {
    if (!isGitHubBacked && !source.trim()) {
      setSourceError('Source location is required — link to the originating file (e.g. a Draw.io diagram).')
      return
    }
    if (!file) {
      setSourceError('An image file is required.')
      return
    }
    setSourceError('')
    setSubmitting(true)
    try {
      const dataBase64 = await readFileAsBase64(file)
      const asset = await uploadAsset({ slug: currentSlug.value, filename: file.name, dataBase64, name, source })
      onInsert(asset)
    } catch (err) {
      setSourceError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Insert image">
        <h3>Insert image</h3>
        <div class="modal-tabs">
          <button
            type="button"
            class=${tab === 'upload' ? 'active' : ''}
            aria-pressed=${tab === 'upload'}
            onClick=${() => setTab('upload')}
          >
            Upload new
          </button>
          <button
            type="button"
            class=${tab === 'existing' ? 'active' : ''}
            aria-pressed=${tab === 'existing'}
            onClick=${() => setTab('existing')}
          >
            Choose existing
          </button>
        </div>

        ${tab === 'upload'
          ? html`
              <div class="upload-field">
                <label class="field-label">Image file</label>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange=${(e) => setFile(e.currentTarget.files?.[0] ?? null)}
                />
              </div>
              <div class="upload-field">
                <label class="field-label">Name (optional)</label>
                <input
                  class="text-field"
                  type="text"
                  value=${name}
                  placeholder=${file?.name ?? 'Defaults to the file name'}
                  onInput=${(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div class="upload-field">
                <label class="field-label">Source location ${isGitHubBacked ? '(optional)' : '(required)'}</label>
                <input
                  class=${'text-field' + (sourceError ? ' has-error' : '')}
                  type="text"
                  value=${source}
                  placeholder="https://draw.io/diagrams/…"
                  onInput=${(e) => {
                    setSource(e.currentTarget.value)
                    if (sourceError) setSourceError('')
                  }}
                />
                ${sourceError ? html`<div class="inline-error">${sourceError}</div>` : null}
                ${isGitHubBacked
                  ? html`<p class="wizard-field-hint">This image is committed to your GitHub repo — its citation links there automatically.</p>`
                  : null}
              </div>
              <div class="modal-actions">
                <button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
                <button type="button" class="btn primary" disabled=${submitting} onClick=${handleSubmitUpload}>
                  ${submitting ? 'Inserting…' : 'Insert'}
                </button>
              </div>
            `
          : html`
              ${existingError ? html`<p class="load-error">${existingError}</p>` : null}
              ${existing === null && !existingError ? html`<p class="loading">Loading…</p>` : null}
              ${existing !== null
                ? html`
                    <div class="grid-library">
                      ${existing.length === 0
                        ? html`<p class="empty">No images yet — switch to "Upload new" to add the first one.</p>`
                        : existing.map(
                            (asset) => html`
                              <button type="button" class="card" key=${asset.id} onClick=${() => onInsert(asset)}>
                                <img src=${assetFileUrl(asset.id, currentSlug.value)} alt=${asset.name} />
                                <div class="name">${asset.name}</div>
                              </button>
                            `
                          )}
                    </div>
                  `
                : null}
            `}
      </div>
    </div>
  `
}

// ---------- Image library screen ----------
// The instance-level screen (#80, wording renamed Asset → Image by #132): every asset registered against this instance as a thumbnail-grid card, each flagged USED IN N / UNUSED so orphaned images are visible without opening every module. The route stays /assets and the storage/API naming stays "asset" (#132's own constraint) — only the visible words changed.
function AssetLibraryPage() {
  const [assets, setAssets] = useState(null)
  const [error, setError] = useState('')
  const routeSlug = new URLSearchParams(window.location.search).get('slug')
  const librarySlug = routeSlug || currentSlug.value

  useEffect(() => {
    const slug = routeSlug || currentSlug.value
    if (!slug) return
    fetchAssets(slug)
      .then(setAssets)
      .catch((err) => setError(err.message))
  }, [routeSlug])

  return html`
    <main class="asset-library">
      <a class="back-link" href="/">← Back to module editor</a>
      <h1>Image library</h1>
      ${error ? html`<p class="load-error">${error}</p>` : null}
      ${assets === null && !error ? html`<p class="loading">Loading…</p>` : null}
      ${assets !== null
        ? html`
            <div class="lib-grid">
              ${assets.length === 0
                ? html`<p class="empty">No images registered yet.</p>`
                : assets.map(
                    (asset) => html`
                      <div class="card" key=${asset.id}>
                        <img src=${assetFileUrl(asset.id, librarySlug)} alt=${asset.name} />
                        <div class="name">${asset.name}</div>
                        <div class="meta">
                          ${asset.uploadedBy ? html`${asset.uploadedBy} · ` : null}
                          <a href=${isLocalAssetSource(asset.source) ? assetFileUrl(asset.id, librarySlug) : asset.source} target="_blank" rel="noreferrer">${asset.source}</a>
                        </div>
                        <span class=${'stamp used-badge ' + (asset.usedIn.length ? 'agreed' : 'review')}>
                          ${asset.usedIn.length ? `USED IN ${asset.usedIn.length}` : 'UNUSED'}
                        </span>
                      </div>
                    `
                  )}
            </div>
          `
        : null}
    </main>
  `
}

// ---------- Render dialog (#114) ----------
// A single "Render" button, in the view-toggle bar (see ViewModeToolbar),
// opens this dialog rather than the old one-button-per-artefact layout —
// same dialog whether the current stage produces one artefact (e.g. `soap`)
// or several sharing a gate (e.g. `sad`/`ssad`), per the ticket's "not a
// special case" acceptance criterion. Follows the same
// modal-backdrop/modal/modal-actions shape as the other editor confirmation
// modals.
function RenderDialog({ instance, onClose }) {
  const [status, setStatus] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [rendering, setRendering] = useState(false)
  // WI #359 — dialog-scoped (not a persisted global setting like the WASM/native engine
  // choice in Settings, web/lib/renderEngine.js): resets to the default every time the dialog
  // is opened fresh, since `RenderDialog` itself unmounts on close (`${renderOpen ? html`...` :
  // null}` in the editor toolbar) and remounts with fresh `useState` the next time it opens.
  const [format, setFormat] = useState('docx')

  // #143 — Render always commits to the instance's *current* stage, regardless of which
  // stage tab is browsed (see handleRenderBatch's `renderAzureArtefactViaEngine`/
  // `renderLocalArtefactViaEngine` calls, which never take the browsed stage into account).
  // That's the right behaviour but was silent, so name it here: a real branch only exists
  // for a workspace-backed instance (`instance.workspaceBacked`) — everything else (a plain
  // local instance, or an ADR-0029 File System Access one) just has a stage, no branch — and
  // when the browsed stage isn't the current one, say so explicitly rather than let the user
  // assume the artefact list they're looking at is what gets committed.
  const isCurrentStage = instance.stage.id === instance.currentStageId
  const currentStage = isCurrentStage ? instance.stage : instance.stages.find((s) => s.id === instance.currentStageId)
  const sourceUnit = instance.workspaceBacked ? 'branch' : 'stage'
  const renderSourceLine = isCurrentStage
    ? `Renders from the ${instance.stage.title} ${sourceUnit}.`
    : `Renders from the ${currentStage?.title ?? instance.currentStageId} ${sourceUnit} — the current stage.`

  function toggleArtefact(artefactId) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(artefactId)) next.delete(artefactId)
      else next.add(artefactId)
      return next
    })
  }

  // Renders every toggled artefact as one batch, sequentially (not
  // Promise.all) so `status` reports a stable, readable line per artefact
  // as each finishes rather than a jumble of interleaved updates.
  async function handleRenderBatch() {
    const artefacts = instance.artefacts.filter((a) => selectedIds.has(a.id))
    if (!artefacts.length) return
    setRendering(true)
    const lines = []
    // See the stage save (ModuleEditorPage's saveStage) for why `?slug=` is required here now — the same gap, for the module editor's own "Render" action.
    const slug = currentSlug.value
    for (const artefact of artefacts) {
      setStatus([...lines, { text: `Rendering ${artefact.title}…` }])
      if (instance.isLocalWorkspace) {
        try {
          // No download link — the file is already in the user's own folder (ADR-0029), so this reports the local relative path instead of a URL.
          lines.push(await renderLocalArtefactViaEngine(instance, artefact, slug, format))
        } catch (err) {
          lines.push({ text: `${artefact.title}: render failed — ${err.offline ? LOCAL_OFFLINE_MESSAGE : err.message}` })
        }
        setStatus([...lines])
        continue
      }
      lines.push(await renderAzureArtefactViaEngine(artefact, slug, instance.workspaceBacked, format))
      setStatus([...lines])
    }
    setRendering(false)
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return html`
    <div class="modal-backdrop" role="presentation" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Render an artefact">
        <h3>Render</h3>
        <p class="guidance render-source">${renderSourceLine}</p>
        ${instance.artefacts.length
          ? html`
              <ul class="render-artefact-list">
                ${instance.artefacts.map(
                  (artefact) => html`
                    <li key=${artefact.id}>
                      <button
                        type="button"
                        class="btn ${selectedIds.has(artefact.id) ? 'toggled' : ''}"
                        aria-pressed=${selectedIds.has(artefact.id)}
                        disabled=${rendering}
                        onClick=${() => toggleArtefact(artefact.id)}
                      >
                        ${artefact.title}
                      </button>
                    </li>
                  `
                )}
              </ul>
            `
          : html`<p class="guidance">This stage has no artefacts to render yet.</p>`}
        <div class="save-status">
          ${status.map(
            (line, index) => html`
              <div key=${index}>
                ${line.url
                  ? html`${line.title}: rendered to <a href=${line.url} target="_blank" rel="noreferrer">${line.path}</a>`
                  : line.text ?? `${line.title}: rendered to ${line.path}`}
              </div>
            `
          )}
        </div>
        <div class="modal-actions">
          <fieldset class="render-format-toggle" disabled=${rendering}>
            <legend class="sr-only">Render format</legend>
            <label>
              <input
                type="radio"
                name="render-format"
                value="docx"
                checked=${format === 'docx'}
                onChange=${() => setFormat('docx')}
              />
              docx
            </label>
            <label>
              <input
                type="radio"
                name="render-format"
                value="md"
                checked=${format === 'md'}
                onChange=${() => setFormat('md')}
              />
              md
            </label>
          </fieldset>
          <button
            type="button"
            class="btn primary"
            disabled=${rendering || selectedIds.size === 0}
            onClick=${handleRenderBatch}
          >
            ${rendering ? 'Rendering…' : 'Render'}
          </button>
        </div>
      </div>
    </div>
  `
}

// ---------- Synced-fields panel (#111) ----------
// Helpers for persistent hyperlinks (WI155) — built from the persisted instance record (org/project/repo + PR id, correct org) so links survive reload.
// Deep link into a Workspace repo's Azure DevOps browser, scoped to one
// instance's folder. A workspace-backed instance's data lives under
// `gantry-workspace/<slug>/` in the repo (lib/instance.js's
// AZURE_DEVOPS_WORKSPACE_ROOT), not `instances/<slug>` — that's this
// engine's own repo layout, not a Workspace repo's. Shared by the
// Work-item-details card's "Show files" button and the dashboard
// manage-card's "Show files" link so the two can't drift (WI226).
// `workspaceRepoUrl` already encodeURIComponent's its own segments.
function instanceFilesUrl(workspace, slug) {
  return `${workspaceRepoUrl(workspace)}?path=/gantry-workspace/${encodeURIComponent(slug)}`
}

function prWebUrlFor(instance, prId) {
  const ws = instance.workspace
  if (!ws || !prId) return null
  const base = ws.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(ws.organization)}/${encodeURIComponent(ws.project)}/_git/${encodeURIComponent(ws.repository)}/pullrequest/${prId}`
}

function workItemWebUrlFor(workItem, wiId) {
  if (!wiId) return null
  // #15: a GitHub-linked instance's `workItem` carries `provider: 'github'` (`lib/workItemLink.js`) —
  // `wiId` is an issue number (the parent, or a per-stage/per-review one), reached through
  // `githubWebBaseUrl`'s own API-root-to-web-root derivation, never Azure DevOps' `_workitems/edit`
  // convention.
  if (workItem?.provider === 'github') {
    if (!workItem.owner || !workItem.repository) return null
    const base = githubWebBaseUrl(workItem)
    return `${base}/${encodeURIComponent(workItem.owner)}/${encodeURIComponent(workItem.repository)}/issues/${wiId}`
  }
  if (!workItem?.organization || !workItem.project) return null
  const base = workItem.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(workItem.organization)}/${encodeURIComponent(workItem.project)}/_workitems/edit/${wiId}`
}

// ---- Review grouping by outcome (#215) ----
// Once a stage accumulates more than a couple of review requests, the flat
// list gets hard to scan for "does anything need my attention" — so the
// Reviews section buckets them into pending / changes-requested / approved.
// Today the only status a review record ever carries is whatever native
// Azure DevOps work-item state its Task landed on (`lib/stageReview.js`
// defaults to "New", then re-reads `System.State` on every "Check status");
// #214's richer `Custom.GantryReviewStatus` vocabulary (Requested/In
// review/Changes requested/Approved/Rejected, on a separate not-yet-merged
// branch) isn't here yet. This classifier deliberately keys off lowercased
// *substrings* of whatever status string is already on the record rather
// than an exact/native-state allowlist, so it buckets both today's ADO
// states (New/Active/Closed/Removed, or a differently-configured process
// template's own vocabulary) and #214's future values correctly without
// any changes once that field lands — "changes requested"/"rejected" (or
// any status containing "reject"/"block") reads as needing another look,
// "approved"/"closed"/"done"/"resolved"/"completed" reads as settled, and
// everything else (new/active/requested/in review/unknown) defaults to
// pending, the safe default for a status this code doesn't recognise yet.
const REVIEW_OUTCOME_GROUPS = [
  { key: 'pending', label: 'Pending' },
  { key: 'changesRequested', label: 'Changes requested' },
  { key: 'approved', label: 'Approved' },
]
const CHANGES_REQUESTED_STATUS_PATTERN = /reject|changes requested|change requested|block/
const APPROVED_STATUS_PATTERN = /approved|closed|done|resolved|completed/

function classifyReviewOutcome(status) {
  const normalized = (status ?? '').toString().trim().toLowerCase()
  if (CHANGES_REQUESTED_STATUS_PATTERN.test(normalized)) return 'changesRequested'
  if (APPROVED_STATUS_PATTERN.test(normalized)) return 'approved'
  return 'pending'
}

function groupReviewsByOutcome(reviews) {
  const groups = { pending: [], changesRequested: [], approved: [] }
  for (const review of reviews) {
    groups[classifyReviewOutcome(review.status)].push(review)
  }
  return groups
}

// Single rendering of one review row — shared by both the flat list (a
// couple of reviews or fewer) and each outcome group's own list, so the
// two paths can never drift into showing different information per review.
function ReviewListItem({ review, instance }) {
  const wiUrl = workItemWebUrlFor(instance.workItem, review.workItemId)
  return html`
    <li key=${review.workItemId}>
      <span class="review-reviewer">${review.reviewerDisplayName ?? review.reviewer}</span>
      <span class="review-meta">
        ${wiUrl ? html`<a href=${wiUrl} target="_blank" rel="noreferrer">#${review.workItemId}</a>` : html`#${review.workItemId}`}
        <span class="review-status">${review.status ?? 'Unknown'}</span>
      </span>
    </li>
  `
}

// A new panel at the top of the instance screen (above the modules — see
// StageScreen) showing the current stage's synced fields, each its own
// distinct field rather than collapsed together: the work item type
// (defaulting to "Task"), a title auto-populated as "{instance name} —
// {stage title}" but overridable per stage, the linked work item's own
// current Status (read straight from Azure DevOps via #121's getWorkItem),
// and the Assignee — inherited from the instance's own stored assignee but
// overridable per stage, and a link to the parent work item. The Pull
// Request itself is *not* one of these fields (#215) — it's shown exactly
// once, in the Sign-off section below, which already carries the richer
// picture (reviewer, approval state, commit history); duplicating it here
// too was #213's own leftover overlap. Backed by GET/PUT
// /api/instance/synced-fields; title/assignee
// edits save on blur or Enter (the same affordance the dashboard's own
// assignee field uses), and an emptied field clears that override so the
// default/inherited value comes back. An instance with no parent work item
// linked at all shows a "Link to a work item" prompt in this panel's place
// instead of any fields.
function SyncedFieldsPanel({ instance }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  // Null means "not editing" — the input then shows the server's current value. Mirrors the dashboard assignee drafts' pattern without clobbering the loaded value on every unrelated rerender.
  const [titleDraft, setTitleDraft] = useState(null)
  const [assigneeDraft, setAssigneeDraft] = useState(null)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncConfirming, setSyncConfirming] = useState(false)
  // A ref (not state): save() reads it synchronously to debounce itself, and no render ever depends on it — the status line already reports the in-flight save.
  const savingRef = useRef(false)

  // Reviews & sign-off (#213): everything the old standalone Request-Review
  // and Review/Sign-off panels owned now lives on this card. Every existing
  // review is shown exactly once, in the card's own rich "Reviews" list
  // (below) — the "Request Review" dialog is purely an add-new-reviewer(s)
  // form, so it starts blank rather than pre-populated with reviews already
  // sent (the old standalone panel duplicated the whole list this way,
  // rendering it once compactly in the details card and again richly in
  // its own dialog; #213 collapses that to the one list). The dialog's own
  // per-row "Check status" is gone too — reviews refresh from the one
  // "Check status" button at the top of the card instead (mirrors
  // ADR-0014's own "single Check status action" shape, just widened to
  // cover reviews and sign-off together).
  const [reviewRows, setReviewRows] = useState(() => [{ id: 'new-1', reviewer: '', review: null, error: '' }])
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [nextRowId, setNextRowId] = useState(2)

  // Sign-off (#124/#125, ADR-0014/ADR-0018) — same state RequestApprovalPanel used to own.
  const [signoffStatus, setSignoffStatus] = useState('')
  const [signoffConfirming, setSignoffConfirming] = useState(false)
  const [commitHistoryOpen, setCommitHistoryOpen] = useState(false)
  const [commitHistory, setCommitHistory] = useState([])
  const [commitHistoryStatus, setCommitHistoryStatus] = useState('')
  const [commitHistoryLoading, setCommitHistoryLoading] = useState(false)
  const [commitHistoryRef, setCommitHistoryRef] = useState(null)
  const [justOpened, setJustOpened] = useState(null)

  // The card's single "Check status" action (#213): refreshes this stage's
  // linked/parent work item + Pull Request fields, every review work item,
  // and (while viewing the instance's own current stage) the sign-off Pull
  // Request together, in one click.
  const [checking, setChecking] = useState(false)
  const [checkStatusMessage, setCheckStatusMessage] = useState('')

  const stageId = instance.stage.id
  const isCurrentStage = instance.stage.id === instance.currentStageId
  const isFinalStage = instance.stages[instance.stages.length - 1]?.id === stageId

  useEffect(() => {
    let cancelled = false
    async function load() {
      const params = new URLSearchParams({ slug: currentSlug.value, stage: stageId })
      try {
        // `apiFetchForInstance` (not plain `apiFetch`) — same reason loadInstance uses it: this request may target a workspace with its own PAT override (#104).
        const res = await apiFetchForInstance(currentSlug.value, `/api/instance/synced-fields?${params}`)
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.message ?? body.error ?? `Failed to load synced fields (${res.status})`)
        if (cancelled) return
        setData(body)
        setTitleDraft(null)
        setAssigneeDraft(null)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // StageScreen remounts this panel wholesale on stage switch (keyed by stage id), so this only ever fires once per mount.
    // eslint-disable-next-line
  }, [])

  // Opening the dialog always starts from one blank row — any rows left
  // over from a previous visit (sent-and-closed, or abandoned mid-fill)
  // aren't what "Request Review" means the next time it's clicked.
  function openReviewDialog() {
    setReviewRows([{ id: 'new-1', reviewer: '', review: null, error: '' }])
    setNextRowId(2)
    setReviewDialogOpen(true)
  }

  async function save(updates) {
    // One save in flight at a time — a rapid double-Enter (or blur-then-Enter) must not fire two PUTs.
    if (savingRef.current) return
    savingRef.current = true
    setStatus('Saving…')
    try {
      const params = new URLSearchParams({ slug: currentSlug.value, stage: stageId })
      const res = await apiFetchForInstance(currentSlug.value, `/api/instance/synced-fields?${params}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.message ?? body.error ?? `Save failed (${res.status})`)
      setData(body)
      setTitleDraft(null)
      setAssigneeDraft(null)
      setStatus('Saved.')
    } catch (err) {
      setStatus(`Save failed: ${err.message}`)
    } finally {
      savingRef.current = false
    }
  }

  function commitTitle() {
    if (!data || titleDraft === null || titleDraft === data.title) return
    // An emptied (or whitespace-only) field clears the override — the auto-populated default comes back. Saved trimmed, matching the assignee field below.
    const trimmed = titleDraft.trim()
    save({ title: trimmed ? trimmed : '' })
  }

  function commitAssignee() {
    if (!data || assigneeDraft === null || assigneeDraft === data.assignee) return
    // Same rule: emptying the field reverts to the inherited instance assignee.
    save({ assignee: assigneeDraft.trim() ? assigneeDraft.trim() : '' })
  }

  // The manual work-item sync action lives in this details card now that the
  // redundant standalone panel has gone. Both requests are instance-scoped:
  // resolve the workspace PAT before the first request, not only after a 401.
  async function handleCheckAndMaybeSync() {
    setSyncStatus('Checking gate…')
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setSyncStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      setSyncStatus(formatGateFailure(body))
      return
    }
    setSyncStatus('Gate passed.')
    setSyncConfirming(true)
  }

  async function handleConfirmSync() {
    setSyncConfirming(false)
    setSyncStatus('Pushing state to work item…')
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/work-items/sync?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json().catch(() => ({}))
    setSyncStatus(
      res.ok
        ? `Pushed state "${body.state}" to work item #${body.workItemId}.`
        : `Sync failed: ${body.message ?? body.error}`
    )
  }

  function handleDeclineSync() {
    setSyncConfirming(false)
    setSyncStatus('Declined — work item state left unchanged.')
  }

  // ---- Request Review (#197): create a new advisory review request. Ported
  // from the old standalone RequestReviewPanel — reviewer picker rows, one
  // "Send request" per unsent row. The per-row "Check status" that used to
  // sit here is gone; the card's one "Check status" button refreshes every
  // review together instead.
  function updateReviewRow(rowId, updates) {
    setReviewRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...updates } : row)))
  }

  function addReviewer() {
    setReviewRows((current) => [...current, { id: `new-${nextRowId}`, reviewer: '', review: null, error: '' }])
    setNextRowId((value) => value + 1)
  }

  function syncInstanceReviews(review) {
    const current = instanceData.value
    if (!current || current.stage.id !== stageId) return
    const reviews = [...(current.reviews ?? []).filter((item) => item.workItemId !== review.workItemId), review]
    instanceData.value = { ...current, reviews }
  }

  async function sendReviewRequest(row) {
    if (!row.reviewer.trim() || row.review) return
    updateReviewRow(row.id, { sending: true, error: '' })
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/request-review?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer: row.reviewer, stage: stageId }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      updateReviewRow(row.id, { sending: false, error: body.message ?? body.error ?? `Request failed (${res.status})` })
      return
    }
    updateReviewRow(row.id, { sending: false, review: body.review })
    syncInstanceReviews(body.review)
  }

  // ---- Sign-off (#124/#125, ADR-0014/ADR-0018): the Pull-Request-backed
  // approval gate. Ported from the old standalone RequestApprovalPanel —
  // "Request Sign-off" only opens a Pull Request once the gate has passed
  // (check-then-confirm, same shape every other gated action in this file
  // uses), and only while viewing the instance's own current stage (a past
  // stage's sign-off is shown read-only below instead).
  const openPullRequestId = justOpened?.pullRequestId ?? instance.pullRequests?.[stageId]
  const pullRequest = justOpened?.pullRequest ?? instance.pullRequest
  const prStatus = pullRequest?.status
  const pullRequestIsActive = pullRequest !== null && (prStatus === undefined || prStatus === 'active')
  const approvalState = justOpened?.approvalState ?? instance.approvalStates?.[stageId]
  const approvalInvalidated = approvalState?.state === 'invalidated' || pullRequest?.review?.state === 'approved-then-invalidated'

  useEffect(() => {
    setCommitHistory([])
    setCommitHistoryStatus('')
    setCommitHistoryLoading(false)
    if (currentSlug.value) {
      setCommitHistoryRef(`refs/heads/gantry-workspace/${currentSlug.value}/${stageId}`)
    }
  }, [stageId])

  async function handleCheckAndMaybeRequestSignoff() {
    setSignoffStatus('Checking gate…')
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setSignoffStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      setSignoffStatus(formatGateFailure(body))
      return
    }
    setSignoffStatus('Gate passed.')
    setSignoffConfirming(true)
  }

  async function handleConfirmSignoffRequest() {
    setSignoffConfirming(false)
    setSignoffStatus(approvalInvalidated ? 'Resetting stale approval…' : 'Opening Pull Request…')
    const res = await apiFetchForInstance(
      currentSlug.value,
      `/api/instance/request-approval?slug=${encodeURIComponent(currentSlug.value)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
    )
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setSignoffStatus(`Request sign-off failed: ${body.message ?? body.error}`)
      return
    }
    setJustOpened(body)
    if (body.pullRequest) {
      const current = instanceData.value
      if (current?.stage.id === stageId) instanceData.value = { ...current, pullRequest: body.pullRequest }
    }
    if (body.reapproval?.method === 'comment') {
      setSignoffStatus(`Approval reset was not permitted, so a note was posted to Pull Request #${body.pullRequestId}. The Owner must review and vote again.`)
    } else if (body.reapproval) {
      setSignoffStatus(`Approval withdrawn from Pull Request #${body.pullRequestId} — awaiting the Owner's review again.`)
    } else {
      setSignoffStatus(`Pull Request #${body.pullRequestId} opened — awaiting the Owner's review.`)
    }
  }

  function handleDeclineSignoff() {
    setSignoffConfirming(false)
    setSignoffStatus('Declined — no Pull Request opened.')
  }

  async function handleOpenCommitHistory() {
    const branchRef = `refs/heads/gantry-workspace/${currentSlug.value}/${stageId}`
    setCommitHistoryRef(branchRef)
    setCommitHistoryStatus('')
    setCommitHistoryOpen(true)
    setCommitHistoryLoading(true)
    try {
      const params = new URLSearchParams({ slug: currentSlug.value, stage: stageId })
      const res = await apiFetchForInstance(currentSlug.value, `/api/instance/commits?${params}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setCommitHistoryStatus(body.message ?? body.error ?? `Failed to load commits (${res.status})`)
        setCommitHistory(Array.isArray(body.commits) ? body.commits : [])
        if (body.ref || body.branch) setCommitHistoryRef(body.ref ?? `refs/heads/${body.branch}`)
        return
      }
      const commits = Array.isArray(body.commits) ? body.commits : []
      setCommitHistory(commits)
      setCommitHistoryRef(body.ref ?? (body.branch ? `refs/heads/${body.branch}` : branchRef))
      setCommitHistoryStatus(commits.length ? '' : 'No commits yet')
    } catch (err) {
      setCommitHistoryStatus(err.message)
    } finally {
      setCommitHistoryLoading(false)
    }
  }

  // ---- Check status (#213, consolidated by #217): the card's single
  // refresh action, replacing every per-section/per-row "Check status" the
  // old panels each had of their own. Refreshes, in one click: this stage's
  // linked/parent work item + Pull Request fields (re-reads synced fields),
  // every review work item for this stage, and — while viewing the
  // instance's own current stage, the only stage a sign-off check is ever
  // valid for (checkStatus gate resolution always targets the instance's
  // persisted current stage, never whichever stage happens to be viewed) —
  // the sign-off Pull Request. On approval, sign-off's own merge/advance
  // behaviour (ADR-0014) is unchanged. For a Workspace-backed instance,
  // once that sequence finishes *without* having just advanced, a second
  // gate-check-and-confirm-sync step runs in the same click (WI217):
  // checks the current stage's content gate and, only if it passes and a
  // work item is linked, opens the existing confirm-and-push dialog
  // (reused verbatim from Check gate & sync work item). If nothing is
  // linked that step runs silently; if the gate fails its detail is shown
  // in the same status-message area. Local instances keep their own
  // separate Check gate & sync button unchanged.
  async function handleCheckStatus() {
    setChecking(true)
    setCheckStatusMessage('Checking status…')
    const messages = []
    try {
      const params = new URLSearchParams({ slug: currentSlug.value, stage: stageId })
      const fieldsRes = await apiFetchForInstance(currentSlug.value, `/api/instance/synced-fields?${params}`)
      const fieldsBody = await fieldsRes.json().catch(() => ({}))
      if (fieldsRes.ok) {
        setData(fieldsBody)
      } else {
        messages.push(`Work item refresh failed: ${fieldsBody.message ?? fieldsBody.error}`)
      }

      const reviews = instance.reviews ?? []
      if (reviews.length) {
        const outcomes = await Promise.all(
          reviews.map((review) =>
            apiFetchForInstance(currentSlug.value, `/api/instance/review-status?slug=${encodeURIComponent(currentSlug.value)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reviewId: review.workItemId, stage: stageId }),
            }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
          )
        )
        const updated = []
        for (const outcome of outcomes) {
          if (outcome.ok) updated.push(outcome.body.review)
          else messages.push(`Review status check failed: ${outcome.body.message ?? outcome.body.error}`)
        }
        if (updated.length) {
          const current = instanceData.value
          if (current?.stage.id === stageId) {
            instanceData.value = {
              ...current,
              reviews: (current.reviews ?? []).map((item) => updated.find((u) => u.workItemId === item.workItemId) ?? item),
            }
          }
        }
      }

      if (isCurrentStage && openPullRequestId) {
        const res = await apiFetchForInstance(
          currentSlug.value,
          `/api/instance/check-status?slug=${encodeURIComponent(currentSlug.value)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
        )
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          messages.push(`Sign-off check failed: ${body.message ?? body.error}`)
        } else if (!body.merged) {
          setJustOpened(body)
          if (body.pullRequest) {
            const current = instanceData.value
            if (current?.stage.id === stageId) instanceData.value = { ...current, pullRequest: body.pullRequest }
          }
          if (body.review?.state === 'approved-then-invalidated') {
            messages.push(
              `Approval invalidated — commit(s) landed after ${body.review.approver?.displayName ?? 'the Owner'} approved Pull Request #${body.pullRequestId}. Request Sign-off again for a fresh review.`
            )
          } else if (body.review?.state === 'rejected') {
            messages.push(`Rejected — the Owner voted to reject Pull Request #${body.pullRequestId}. Address the feedback, then re-request sign-off.`)
          } else if (body.review?.state === 'changes-requested') {
            messages.push(`Changes requested — the Owner sent Pull Request #${body.pullRequestId} back for more work before approving.`)
          } else {
            messages.push(`Still pending — the Owner hasn't reviewed Pull Request #${body.pullRequestId} yet.`)
          }
        } else {
          if (body.advancedTo) {
            messages.push(`Approved — Pull Request #${body.pullRequestId} merged; stage advanced to "${body.advancedTo.title}".`)
          } else if (isFinalStage) {
            messages.push(`Approved — Pull Request #${body.pullRequestId} merged. This was the final stage; the instance is complete.`)
          } else {
            messages.push(`Approved — Pull Request #${body.pullRequestId} is already merged; the instance is already past this stage.`)
          }
          // Flush the message *before* triggering the stage-changing reload
          // below — that reload remounts this whole card (StageScreen keys
          // on stage id), so any state set after it starts lands on a
          // component that's already gone. Mirrors the old
          // RequestApprovalPanel's own ordering exactly, for the same
          // reason.
          setCheckStatusMessage(messages.join(' '))
          const effectWillReload = viewedStage.value !== null
          viewedStage.value = null
          if (!effectWillReload) {
            instanceData.value = await loadInstance(currentSlug.value, null)
          }
          return
        }
      }

      // WI217: Workspace-backed second step — gate-check-and-confirm-sync,
      // sequenced after the refresh/merge detection above and skipped when
      // that detection already advanced the stage (the return above).
      if (instance.workspaceBacked) {
        const isLinked = Boolean(data?.linked)
        // Re-read linked from the just-refreshed synced-fields if available,
        // falling back to the pre-click snapshot — avoids missing a link
        // created between clicks.
        const linkedNow = fieldsBody?.linked !== undefined ? Boolean(fieldsBody.linked) : isLinked
        if (linkedNow) {
          const res = await apiFetchForInstance(currentSlug.value, `/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            messages.push(`Check failed: ${body.message ?? body.error}`)
          } else if (!body.pass) {
            messages.push(formatGateFailure(body))
          } else {
            // Gate passed and linked — open the existing confirm-and-push
            // dialog verbatim (same copy, same server re-check on confirm).
            // Flush any pending status messages first so the dialog doesn't
            // clobber them.
            setCheckStatusMessage(messages.length ? messages.join(' ') : 'Up to date.')
            setSyncConfirming(true)
            return
          }
        }
        // Not linked — explicitly silent: no gate check, no message, no dialog.
      }

      setCheckStatusMessage(messages.length ? messages.join(' ') : 'Up to date.')
    } finally {
      setChecking(false)
    }
  }

  // Whether a work item is linked at all is a distinct question from
  // whether this is a Workspace-backed instance (ADR-0014): the sign-off
  // Pull Request flow gates on a real Azure DevOps *repo*, not on a linked
  // *work item* — a ticketing system's work item, where configured, keeps
  // its board-visible tracking role but plays no part in the gate. So the
  // reviews/sign-off sub-card (and its "Check status") render for any
  // workspace-backed instance below, independently of whether this synced-
  // fields section itself has anything linked to show yet.
  const linked = Boolean(data?.linked)
  // Persistent hyperlink built from the persisted PR record (org/project/repo + PR id) — survives reload with the correct org (WI155). `justOpened.webUrl` is the transient server-built URL right after creation; fallback builds from `instance.workspace` so reloads still link.
  const signoffPrUrl = justOpened?.webUrl ?? prWebUrlFor(instance, openPullRequestId)
  const groupedReviews = groupReviewsByOutcome(instance.reviews ?? [])
  // Sign-off shown the same way a review row is (name · ticket · status): the "ticket" is this stage's own sign-off work item, when the instance is work-item-linked.
  const signoffWorkItemId = instance.workItem?.stages?.[instance.stage.id] ?? null
  const signoffWiUrl = workItemWebUrlFor(instance.workItem, signoffWorkItemId)

  return html`
    <section class="synced-fields-panel" id="work-item-detail-card">
      <div class="panel-header">
        <h2>Work item details</h2>
        ${instance.workspaceBacked
          ? html`
              <div class="panel-header-actions">
                ${instance.workspace?.organization && instance.workspace?.project && instance.workspace?.repository
                  ? html`
                      <a
                        class="btn"
                        href=${instanceFilesUrl(instance.workspace, instance.slug)}
                        target="_blank"
                        rel="noreferrer"
                        >Show files</a
                      >
                    `
                  : null}
                <button type="button" class="btn" onClick=${handleOpenCommitHistory}>Show commit history</button>
                <button type="button" class="btn" disabled=${checking} onClick=${handleCheckStatus}>
                  ${checking ? 'Checking…' : 'Check status'}
                </button>
              </div>
            `
          : null}
      </div>
      ${error
        ? html`<p class="load-error">${error}</p>`
        : !data
          ? html`<p class="loading">Loading…</p>`
          : !linked
            ? html`
                <p class="guidance">
                  <strong>Link to a work item</strong> to see this stage's synced fields (type, title, status, Pull
                  Request state and assignee). Linking happens when the instance is created, via the "+ New
                  Workspace" wizard's work-item step.
                </p>
              `
            : html`
                <div class="synced-fields-grid">
                  <div class="synced-field">
                    <span class="field-label">Type</span>
                    <span class="synced-value">${data.type}</span>
                  </div>
                  <div class="synced-field synced-field-wide">
                    <label class="field-label" for="synced-title">Title${data.titleOverridden ? ' · overridden' : ''}</label>
                    <input
                      id="synced-title"
                      class="text-field"
                      type="text"
                      placeholder=${`${instance.slug} — ${instance.stage.title}`}
                      value=${titleDraft ?? data.title}
                      disabled=${isEditingBlocked()}
                      onInput=${(e) => setTitleDraft(e.currentTarget.value)}
                      onBlur=${commitTitle}
                      onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    />
                  </div>
                  <div class="synced-field">
                    <span class="field-label">Status</span>
                    <span class="synced-value"
                      >${data.workItemId
                        ? (() => {
                            const wiUrl = workItemWebUrlFor(instance.workItem, data.workItemId)
                            return wiUrl
                              ? html`<a href=${wiUrl} target="_blank" rel="noreferrer">#${data.workItemId}</a> · ${data.workItemState ?? '—'}`
                              : html`#${data.workItemId} · ${data.workItemState ?? '—'}`
                          })()
                        : '—'}</span
                    >
                  </div>
                  <div class="synced-field">
                    <label class="field-label" for="synced-assignee">Assignee${data.assigneeInherited ? '' : ' · overridden'}</label>
                    <${IdentityPicker}
                      value=${assigneeDraft ?? data.assignee}
                      disabled=${isEditingBlocked()}
                      onChange=${(uniqueName) => {
                        setAssigneeDraft(uniqueName)
                        // Commit immediately on select (no blur-based commit needed — the picker's selection is already definitive)
                        if (!data || uniqueName === data.assignee) return
                        save({ assignee: uniqueName.trim() ? uniqueName.trim() : '' })
                      }}
                      placeholder=${instance.assignee ? `${instance.assignee} (inherited)` : 'Inherited from the instance'}
                      slug=${currentSlug.value}
                    />
                  </div>
                  <div class="synced-field">
                    <span class="field-label">${describeWorkItemLink(instance.workItem)?.parentLabel ?? 'Parent work item'}</span>
                    ${(() => {
                      // #136: GitHub records the parent as `parentNumber`, Azure DevOps as `parentId`.
                      // Reading only the latter rendered a bare "#" for every GitHub-linked instance.
                      const parentRef = workItemParentRef(instance.workItem)
                      if (parentRef == null) return html`<span class="synced-value">—</span>`
                      const wiUrl = workItemWebUrlFor(instance.workItem, parentRef)
                      return wiUrl
                        ? html`<a class="synced-value" href=${wiUrl} target="_blank" rel="noreferrer">#${parentRef}</a>`
                        : html`<span class="synced-value">#${parentRef}</span>`
                    })()}
                  </div>
                </div>
              `}
      ${instance.workspaceBacked
        ? html`
            <div class="review-signoff-card">
              ${!isCurrentStage
                ? html`<p class="guidance stage-advance-hint">
                    This isn't the current stage — Request Review and Request Sign-off act on the current stage only.
                  </p>`
                : null}
              <div class="review-signoff-section reviews-section">
                <div class="review-signoff-header">
                  <span class="field-label">Reviews</span>
                  ${isCurrentStage
                    ? html`<button type="button" class="btn small" disabled=${isEditingBlocked()} onClick=${openReviewDialog}>Request Review</button>`
                    : null}
                </div>
                ${!instance.reviews?.length
                  ? html`<p class="synced-value">No review requests</p>`
                  : instance.reviews.length > 2
                    ? html`
                        ${REVIEW_OUTCOME_GROUPS.map(({ key, label }) => {
                          const group = groupedReviews[key]
                          if (!group.length) return null
                          return html`
                            <div class="review-group" key=${key}>
                              <div class="review-group-label">
                                <span>${label}</span>
                              </div>
                              <ul class="review-list">
                                ${group.map((review) => html`<${ReviewListItem} key=${review.workItemId} review=${review} instance=${instance} />`)}
                              </ul>
                            </div>
                          `
                        })}
                      `
                    : html`
                        <ul class="review-list">
                          ${instance.reviews.map((review) => html`<${ReviewListItem} key=${review.workItemId} review=${review} instance=${instance} />`)}
                        </ul>
                      `}
              </div>
              <div class="review-signoff-section signoff-section">
                <div class="review-signoff-header">
                  <span class="field-label">Sign-off</span>
                  ${!openPullRequestId && isCurrentStage
                    ? html`<button type="button" class="btn small" disabled=${isEditingBlocked()} onClick=${afterUnsavedCheck(handleCheckAndMaybeRequestSignoff)}>Request Sign-off</button>`
                    : null}
                </div>
                ${openPullRequestId
                  ? html`
                      <ul class="review-list">
                        <li>
                          <span class="review-reviewer">${pullRequest?.review?.approver?.displayName ?? 'Not assigned'}</span>
                          <span class="review-meta">
                            ${signoffWiUrl
                              ? html`<a href=${signoffWiUrl} target="_blank" rel="noreferrer">#${signoffWorkItemId}</a>`
                              : signoffWorkItemId
                                ? html`#${signoffWorkItemId}`
                                : null}
                            <span class="review-status">${pullRequest?.review?.reviewStatus ?? pullRequest?.review?.state ?? 'pending'}</span>
                          </span>
                        </li>
                      </ul>
                      <p class="signoff-pr-ref">
                        ${signoffPrUrl
                          ? html`<a href=${signoffPrUrl} target="_blank" rel="noreferrer">Pull Request #${openPullRequestId}</a>`
                          : html`Pull Request #${openPullRequestId}`}
                        ${pullRequestIsActive
                          ? ` is open, requesting approval for stage "${instance.stage.title}".`
                          : prStatus === 'completed'
                            ? ` was merged for stage "${instance.stage.title}".`
                            : prStatus === 'abandoned'
                              ? ` was abandoned (closed without merging) for stage "${instance.stage.title}".`
                              : ` is no longer available for stage "${instance.stage.title}".`}
                      </p>
                      ${pullRequestIsActive && isCurrentStage && approvalInvalidated
                        ? html`
                            <div class="signoff-actions">
                              <button type="button" class="btn small" onClick=${afterUnsavedCheck(handleConfirmSignoffRequest)}>Request Sign-off again</button>
                            </div>
                          `
                        : null}
                    `
                  : isCurrentStage
                    ? null
                    : html`<p class="synced-value">Not requested</p>`}
                ${signoffStatus ? html`<p class="save-status">${signoffStatus}</p>` : null}
              </div>
            </div>
          `
        : null}
      ${instance.workspaceBacked ? html`<div class="save-status">${checkStatusMessage}</div>` : null}
      ${linked
        ? html`
            <div class="save-status">${status}</div>
            ${!instance.workspaceBacked
              ? html`
                  <button type="button" class="btn" onClick=${handleCheckAndMaybeSync}>Check gate & sync work item</button>
                  <div class="save-status">${syncStatus}</div>
                `
              : syncStatus
                ? html`<div class="save-status">${syncStatus}</div>`
                : null}
          `
        : null}
      ${linked && syncConfirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm work item state update">
                <h3>Push a state update?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to push a new state to this stage's work item in Azure DevOps. Declining leaves that work item's state unchanged.
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDeclineSync}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmSync}>Confirm & push</button>
                </div>
              </div>
            </div>
          `
        : null}
      ${reviewDialogOpen
        ? html`
            <${Modal} ariaLabel="Request Review" onClose=${() => setReviewDialogOpen(false)}>
              <h3>Request Review</h3>
              <p class="guidance">Ask one or more people to review this stage. Each request is tracked separately.</p>
              <div class="review-request-list">
                ${reviewRows.map((row) => html`
                  <div class="review-request-row" key=${row.id}>
                    <div class="reviewer-field">
                      <span class="field-label">Reviewer</span>
                      <${IdentityPicker}
                        value=${row.reviewer}
                        onChange=${(uniqueName) => updateReviewRow(row.id, { reviewer: uniqueName })}
                        placeholder="Search for a reviewer"
                        slug=${currentSlug.value}
                      />
                    </div>
                    ${row.review
                      ? html`
                          <div class="review-request-result">
                            <span>
                              ${workItemWebUrlFor(instance.workItem, row.review.workItemId)
                                ? html`<a href=${workItemWebUrlFor(instance.workItem, row.review.workItemId)} target="_blank" rel="noreferrer">Work item #${row.review.workItemId}</a>`
                                : `Work item #${row.review.workItemId}`}
                              · ${row.review.status ?? 'Unknown'}
                            </span>
                          </div>
                        `
                      : html`
                          <button type="button" class="btn small" disabled=${row.sending || !row.reviewer.trim()} onClick=${() => sendReviewRequest(row)}>
                            ${row.sending ? 'Sending…' : 'Send request'}
                          </button>
                        `}
                    ${row.error ? html`<p class="save-status">${row.error}</p>` : null}
                  </div>
                `)}
              </div>
              <div class="modal-actions">
                <button type="button" class="btn" onClick=${addReviewer}>Add reviewer</button>
                <button type="button" class="btn ghost" onClick=${() => setReviewDialogOpen(false)}>Close</button>
              </div>
            <//>
          `
        : null}
      ${signoffConfirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm request sign-off">
                <h3>Open a Pull Request for sign-off?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to open a Pull Request from this
                  stage's own branch into "main", requesting the Owner's sign-off. Declining opens nothing.
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDeclineSignoff}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmSignoffRequest}>
                    Confirm & request sign-off
                  </button>
                </div>
              </div>
            </div>
          `
        : null}
      ${commitHistoryOpen
        ? html`
            <${CommitHistoryDialog}
              commits=${commitHistory}
              stageTitle=${instance.stage.title}
              refName=${commitHistoryRef}
              status=${commitHistoryStatus}
              loading=${commitHistoryLoading}
              onClose=${() => setCommitHistoryOpen(false)}
            />
          `
        : null}
    </section>
  `
}

// ---------- Stage advancement (local instances only; #115, ADR-0012) ----------
// The self-serve "Advance to next stage" action: never rendered at all for
// a Workspace-backed instance (`instance.workspaceBacked` — that one always
// advances via its own Pull Request flow instead, ADR-0014/#122-#125), and
// only while viewing the instance's own *current* stage (`instance.stage.id
// === instance.currentStageId`) — advancing moves this instance's own
// persisted stage pointer forward from wherever it currently sits, so it
// never makes sense to offer it while browsing an earlier or later stage
// via the stage switcher. Mirrors this file's other gated actions' own
// check-then-confirm shape: "Advance to next stage" runs the same gate check every other
// gated action in this app runs, and only a genuine PASS opens the confirm
// dialog — declining it (or a FAIL) leaves the instance's stage genuinely
// unchanged.
function AdvanceStagePanel({ instance }) {
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState(false)

  const isFinalStage = instance.stages[instance.stages.length - 1]?.id === instance.stage.id
  if (instance.workspaceBacked || instance.stage.id !== instance.currentStageId || isFinalStage) return null

  async function handleCheckAndMaybeConfirm() {
    setStatus('Checking gate…')
    if (instance.isLocalWorkspace) {
      try {
        const body = await runLocalCheck(instance)
        if (!body.pass) {
          setStatus(formatGateFailure(body))
          return
        }
        setStatus('Gate passed.')
        setConfirming(true)
      } catch (err) {
        setStatus(err.offline ? LOCAL_OFFLINE_MESSAGE : `Check failed: ${err.message}`)
      }
      return
    }
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/check?slug=${encodeURIComponent(currentSlug.value)}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Check failed: ${body.message ?? body.error}`)
      return
    }
    if (!body.pass) {
      setStatus(formatGateFailure(body))
      return
    }
    setStatus('Gate passed.')
    setConfirming(true)
  }

  // Re-checks the gate (client-side, `runLocalCheck`, WI #313) before writing
  // the new stage (the same defense-in-depth the server-backed `advanceStage`
  // path gets for free by re-evaluating the gate server-side) — a local
  // instance has no server-side call of its own to fall back on for that, so
  // this repeats the check done above rather than trusting the earlier PASS
  // is still current.
  async function handleConfirmAdvanceLocal() {
    setConfirming(false)
    setStatus('Advancing…')
    try {
      const checkBody = await runLocalCheck(instance)
      if (!checkBody.pass) {
        setStatus(formatGateFailure(checkBody))
        return
      }
      const handle = localDirHandle.value
      if (!handle) throw new Error('Local workspace folder is not open.')
      const slug = instance.slug
      const idx = instance.stages.findIndex((s) => s.id === instance.stage.id)
      const nextStage = instance.stages[idx + 1]
      if (!nextStage) {
        setStatus('Already at the final stage.')
        return
      }
      const instanceYamlText = await readLocalTextFile(handle, `gantry-workspace/${slug}/instance.yaml`)
      const record = parseInstanceYaml(instanceYamlText)
      await writeLocalTextFile(handle, `gantry-workspace/${slug}/instance.yaml`, withInstanceStage(record, nextStage.id))
      setStatus(`Advanced to "${nextStage.title}".`)
      const effectWillReload = viewedStage.value !== null
      viewedStage.value = null
      if (!effectWillReload) {
        instanceData.value = await loadLocalInstance(instance.localWorkspaceId, slug, null)
      }
    } catch (err) {
      setStatus(err.offline ? LOCAL_OFFLINE_MESSAGE : `Advance failed: ${err.message}`)
    }
  }

  async function handleConfirmAdvance() {
    if (instance.isLocalWorkspace) {
      await handleConfirmAdvanceLocal()
      return
    }
    setConfirming(false)
    setStatus('Advancing…')
    const res = await apiFetchForInstance(currentSlug.value, `/api/instance/advance-stage?slug=${encodeURIComponent(currentSlug.value)}`, {
      method: 'POST',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(`Advance failed: ${body.message ?? body.error}`)
      return
    }
    setStatus(`Advanced to "${body.toStage.title}".`)
    // Reset to no explicit stage so the form now shows the instance's new
    // current stage — otherwise `viewedStage` would still hold this
    // (now-completed) stage's id and the screen would appear unchanged.
    //
    // Assigning `viewedStage.value` here already re-triggers the shared
    // instance-loading effect (near the top of this file) *whenever it's
    // a genuine change* — e.g. the user had at some point explicitly
    // clicked this (the current) stage's own nav button, leaving
    // `viewedStage.value` set to its id rather than `null`. Also calling
    // `loadInstance` directly below in that case would race that effect's
    // own fetch (mirrors the exact hazard `ModuleEditorPage`'s own
    // `batch()` comment describes) — so this only fetches directly when
    // `viewedStage.value` was already `null`, the one case where setting
    // it to `null` again is a no-op the effect will never react to.
    const effectWillReload = viewedStage.value !== null
    viewedStage.value = null
    if (!effectWillReload) {
      instanceData.value = await loadInstance(currentSlug.value, null)
    }
  }

  function handleDecline() {
    setConfirming(false)
    setStatus('Declined — stage left unchanged.')
  }

  return html`
    <section class="advance-stage-panel">
      <h2>Stage advancement</h2>
      <button type="button" class="btn" onClick=${afterUnsavedCheck(handleCheckAndMaybeConfirm)}>Advance to next stage</button>
      <div class="save-status">${status}</div>
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm stage advancement">
                <h3>Advance to the next stage?</h3>
                <p class="guidance">
                  The gate for stage "${instance.stage.title}" has passed. Confirm to move this instance on to its
                  next stage. Declining leaves it at "${instance.stage.title}".
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${handleDecline}>Decline</button>
                  <button type="button" class="btn primary" onClick=${handleConfirmAdvance}>Confirm & advance</button>
                </div>
              </div>
            </div>
          `
        : null}
    </section>
  `
}

// ---------- Stage navigation dropdown (WI232) ----------
// Uses the shared Dropdown component, lists every module <h2> and every <h3>
// subsection heading (field title, including custom sections) in document
// order. Now rendered inside ViewModeToolbar to the right of the artefact
// selector. Selecting an entry smooth-scrolls the heading and closes the menu.
// Hidden when the stage has no headings (edge case).
function StageNavigation({ modules, visibleFieldIds }) {
  const [open, setOpen] = useState(false)
  const headings = buildStageHeadings(modules, visibleFieldIds)
  if (!headings.length) return null
  function handleSelect(id) {
    setOpen(false)
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return html`
    <div class="stage-navigation">
      <${Dropdown}
        className="stage-navigation-dropdown"
        triggerLabel="Navigation ▾"
        triggerClass="btn small"
        triggerAriaLabel="Navigation"
        menuRole="menu"
        open=${open}
        onOpenChange=${setOpen}
      >
        ${headings.map(
          (h) => html`
            <button
              type="button"
              role="menuitem"
              class=${h.level === 3 ? 'nav-item nav-item-h3' : 'nav-item'}
              onClick=${() => handleSelect(h.id)}
            >
              ${h.label}
            </button>
          `
        )}
      <//>
    </div>
  `
}

// ---------- Re-open a signed-off stage (WI265, docs/adr/0026) ----------
function ReopenStagePanel({ instance }) {
  // #142: `instance.stageCompleted` (not `isEditingBlocked()`) — that union now includes this very
  // completed-Stage state (so the fields themselves go read-only), and gating this panel's own
  // visibility on it too would mean it could never show at all: Re-open must appear *because* the
  // Stage is completed, not only once something else has already blocked editing.
  const show = instance.workspaceBacked && instance.stageCompleted && !isArchived() && !isWriteAccessBlocked()
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)

  if (!show) return null

  async function handleConfirm() {
    setLoading(true)
    setStatus('Re-opening…')
    try {
      const params = new URLSearchParams({ slug: instance.slug, stage: instance.stage.id })
      const res = await apiFetchForInstance(instance.slug, `/api/instance/stage/reopen?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: instance.stage.id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.message ?? body.error ?? `Re-open failed (${res.status})`)
      setStatus('Re-opened — refreshing…')
      setConfirming(false)
      setStatus('')
      // Transition into the re-opened editing session: the instance's stage
      // pointer is now back to this stage, so resetting viewedStage to null
      // lets the default (current-stage) resolution show it as the current
      // stage. The shared instance-loading effect will reload once.
      const effectWillReload = viewedStage.value !== null
      viewedStage.value = null
      if (!effectWillReload) {
        instanceData.value = await loadInstance(instance.slug, null)
      }
    } catch (err) {
      setStatus(`Re-open failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return html`
    <div class="reopen-stage-panel" data-testid="reopen-stage-panel">
      <p class="guidance">This stage is complete. Re-open it to make late edits — a new branch will be created from main.</p>
      <button type="button" class="btn" onClick=${() => setConfirming(true)} data-testid="reopen-stage-button">Re-open stage</button>
      ${status ? html`<span class="save-status">${status}</span>` : null}
      ${confirming
        ? html`
            <div class="modal-backdrop" role="presentation">
              <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm re-open stage">
                <h3>Re-open stage "${instance.stage.title}"?</h3>
                <p class="guidance">
                  This will recreate the stage branch from main and move the instance back to this stage for further editing.
                </p>
                <div class="modal-actions">
                  <button type="button" class="btn ghost" onClick=${() => setConfirming(false)}>Cancel</button>
                  <button type="button" class="btn primary" disabled=${loading} onClick=${handleConfirm}>Confirm & re-open</button>
                </div>
              </div>
            </div>
          `
        : null}
    </div>
  `
}

// ---------- The viewed stage's whole screen: modules + work-item panel ----------
// Keyed by stage id from the parent (see ModuleEditorPage) so switching stages remounts this wholesale — fresh CodeMirror instances, matching the old full-DOM-rebuild behaviour. "Clear all fields" and "Render" now live in the view-toggle bar (see ViewModeToolbar, ModuleEditorPage) rather than here, so the field registry they depend on is owned by ModuleEditorPage instead — `onFieldRegistered` is threaded straight through. StageNavigation now lives in ViewModeToolbar to the right of the artefact selector, not as a standalone block here.
function StageScreen({ instance, onFieldRegistered, visibleFieldIds }) {
  const [topSectionOpen, setTopSectionOpen] = useState(false)
  const [topListOpen, setTopListOpen] = useState(false)
  const modules = visibleFieldIds
    ? instance.modules.filter((mod) => mod.fields.some((field) => visibleFieldIds.has(`${mod.id}.${field.id}`)))
    : instance.modules
  // The top Insert ▾ adds to the first module this stage can edit — never a read-only one (#152).
  const editableModules = modules.filter((mod) => !mod.readOnly)

  function handleTopInsertSection(title) {
    const targetModuleId = editableModules[0]?.id ?? instance.modules.find((mod) => !mod.readOnly)?.id
    if (!targetModuleId) return
    const newField = {
      id: uniqueCustomFieldClientId(),
      title: title.trim() ? title.trim() : 'Untitled section',
      type: 'markdown',
      required: false,
      guidance: null,
      value: '',
      example: null,
      custom: true,
    }
    const current = instanceData.value
    if (!current) return
    const updatedModules = current.modules.map((m) => {
      if (m.id !== targetModuleId) return m
      const fields = [...m.fields]
      // Prepend as first field — `fields.splice(0, 0, newField)` — mirrors ModuleCard's handleInsertSection/List where findIndex returns -1 when the after-id is unset.
      fields.splice(0, 0, newField)
      return { ...m, fields }
    })
    instanceData.value = { ...current, modules: updatedModules }
    setTopSectionOpen(false)
  }

  function handleTopInsertList(title) {
    const targetModuleId = editableModules[0]?.id ?? instance.modules.find((mod) => !mod.readOnly)?.id
    if (!targetModuleId) return
    const newField = {
      id: uniqueCustomFieldClientId(),
      title: title.trim() ? title.trim() : 'Untitled list',
      type: 'list',
      required: false,
      guidance: null,
      value: [],
      example: null,
      custom: true,
    }
    const current = instanceData.value
    if (!current) return
    const updatedModules = current.modules.map((m) => {
      if (m.id !== targetModuleId) return m
      const fields = [...m.fields]
      fields.splice(0, 0, newField)
      return { ...m, fields }
    })
    instanceData.value = { ...current, modules: updatedModules }
    setTopListOpen(false)
  }

  return html`
    <main id="modules" data-view-mode=${viewMode.value}>
      <${ReopenStagePanel} instance=${instance} />
      ${advancedMode.value
        ? html`<${SyncedFieldsPanel} key=${instance.workItem ? 'linked' : 'unlinked'} instance=${instance} />`
        : null}
      ${editableModules.length > 0
        ? html`<div class="insert-bar top-insert-bar" data-testid="top-insert" hidden=${isEditingBlocked()}>
            <${InsertDropdown} onSection=${() => setTopSectionOpen(true)} onList=${() => setTopListOpen(true)} />
          </div>`
        : null}
      ${modules.map((mod) =>
        mod.readOnly
          ? html`<${ReadOnlyModuleCard} key=${mod.id} mod=${mod} visibleFieldIds=${visibleFieldIds} />`
          : html`
          <${ModuleCard}
            key=${mod.id}
            mod=${mod}
            stageId=${instance.stage.id}
            visibleFieldIds=${visibleFieldIds}
            onFieldRegistered=${onFieldRegistered}
          />
        `
      )}
      <${AdvanceStagePanel} instance=${instance} />
      ${topSectionOpen ? html`<${SectionDialog} onConfirm=${handleTopInsertSection} onClose=${() => setTopSectionOpen(false)} />` : null}
      ${topListOpen ? html`<${ListDialog} onConfirm=${handleTopInsertList} onClose=${() => setTopListOpen(false)} />` : null}
    </main>
  `
}

// ---------- View-mode toolbar: the Mode dropdown (Visual / Split / Markdown) ----------
// One toolbar for the whole editor screen (see web/lib/viewMode.js) — sits below AppHeader, above the viewed stage's screen, and (like AppHeader) is never remounted by a stage switch, so `viewMode` reads back the same value the author left it in after navigating fields/modules/stages.
const VIEW_MODE_LABELS = { visual: 'Visual', split: 'Split', markdown: 'Markdown' }
const VIEW_MODE_HOTKEY = { ctrlKey: true, shiftKey: true, key: 'v' }

// `instance` and `onClearAllFields` back the "Clear all fields" + "Render"
// pair moved here from the stage screen (#114) — both now sit on the right
// of this same bar, "Clear all fields" immediately left of "Render".
// `requestApprovalSlug` signals a "Review / Sign-off" shortcut button —
// (#145 Part 1) clicking it scrolls to the Work Item Detail card (#213
// folded the old standalone Review/Sign-off panel's review and sign-off
// functionality into that card, so this shortcut now targets it directly)
// and briefly highlights it so the author's eye is drawn down.
function ViewModeToolbar({
  instance,
  visibleFieldIds,
  onClearAllFields,
  requestApprovalSlug,
  selectedArtefactId,
  selectedArtefact,
  onArtefactChange,
}) {
  const [renderOpen, setRenderOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [artefactOpen, setArtefactOpen] = useState(false)
  const artefacts = sortArtefacts(instance.artefacts)
  const showArtefactSelector = artefactsHaveDifferentRequirements(instance.modules, artefacts)
  // #151 (ADR-0051): an audience document (`satisfies-gate: false`) stays selectable and editable
  // like any other, with a hint that completing it alone won't pass the gate.
  const selectedExcludedFromGate = selectedArtefact?.satisfiesGate === false
  const navModules = visibleFieldIds
    ? instance.modules.filter((mod) => mod.fields.some((field) => visibleFieldIds.has(`${mod.id}.${field.id}`)))
    : instance.modules

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key.toLowerCase() !== VIEW_MODE_HOTKEY.key) return
      if (e.ctrlKey !== VIEW_MODE_HOTKEY.ctrlKey || e.shiftKey !== VIEW_MODE_HOTKEY.shiftKey) return
      // Fires even while a CodeMirror editor or other field has focus — it's a distinctive combo unlikely to collide with normal editing, and the ticket asks for a hotkey that cycles the whole screen's view regardless of what the author was just doing.
      e.preventDefault()
      cycleViewMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function scrollToApprovalPanel() {
    const panel =
      document.getElementById('work-item-detail-card') ?? document.querySelector('.synced-fields-panel')
    if (!panel) return

    function triggerFlash() {
      panel.classList.remove('flash')
      // Force a reflow so removing then adding the class triggers a fresh animation
      void panel.offsetHeight
      panel.classList.add('flash')
      // Remove the class after the animation completes so re-clicking re-triggers and it is not persistent
      const onEnd = () => {
        panel.classList.remove('flash')
        panel.removeEventListener('animationend', onEnd)
      }
      panel.addEventListener('animationend', onEnd)
    }

    // Sequence flash after scroll settles: prefer the `scrollend` event, fall back to a timeout
    // (~300 ms, the typical smooth-scroll duration). Must also flash when already in view
    // (where no scroll occurs and `scrollend` may never fire), so the timeout is always armed
    // as a fallback and the flash is one-shot.
    let didFlash = false
    function doFlashOnce() {
      if (didFlash) return
      didFlash = true
      triggerFlash()
    }

    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })

    let fallbackTimer = null
    const onScrollEnd = () => {
      window.removeEventListener('scrollend', onScrollEnd)
      document.removeEventListener('scrollend', onScrollEnd)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      doFlashOnce()
    }

    if ('onscrollend' in window) {
      window.addEventListener('scrollend', onScrollEnd, { once: true })
      document.addEventListener('scrollend', onScrollEnd, { once: true })
      // Fallback if scrollend never fires (e.g. already in view or no scroll distance)
      fallbackTimer = setTimeout(onScrollEnd, 400)
    } else {
      fallbackTimer = setTimeout(doFlashOnce, 300)
    }
  }

  return html`
    <div class="toolbar">
      <div class="toolbar-left">
        ${!isEditingBlocked() ? html`<${StageSaveButton} />` : null}
        <div class="toolbar-field">
          <span>Mode</span>
          <${Dropdown}
          className="view-mode-dropdown"
          triggerLabel=${`${VIEW_MODE_LABELS[viewMode.value]} ▾`}
          triggerAriaLabel=${`Mode: ${VIEW_MODE_LABELS[viewMode.value]}`}
          triggerClass="btn small"
          menuRole="menu"
          open=${modeOpen}
          onOpenChange=${setModeOpen}
        >
          ${VIEW_MODES.map(
            (mode) => html`
              <button
                type="button"
                key=${mode}
                role="menuitemradio"
                class="nav-item"
                aria-checked=${viewMode.value === mode}
                onClick=${() => {
                  setModeOpen(false)
                  viewMode.value = mode
                }}
              >
                ${VIEW_MODE_LABELS[mode]}
              </button>
            `
          )}
        <//>
        </div>
        ${artefacts.length > 0
          ? html`
              <div class="toolbar-field artefact-selector">
                <span>Artefact</span>
                ${showArtefactSelector
                  ? html`
                      <${Dropdown}
                        className="artefact-dropdown"
                        triggerLabel=${`${selectedArtefact?.title ?? ''} ▾`}
                        triggerAriaLabel=${`Artefact: ${selectedArtefact?.title ?? ''}`}
                        triggerClass="btn small"
                        menuRole="menu"
                        open=${artefactOpen}
                        onOpenChange=${setArtefactOpen}
                      >
                        ${artefacts.map(
                          (artefact) => html`
                            <button
                              type="button"
                              key=${artefact.id}
                              role="menuitemradio"
                              class="nav-item"
                              aria-checked=${artefact.id === selectedArtefactId}
                              onClick=${() => {
                                setArtefactOpen(false)
                                onArtefactChange(artefact.id)
                              }}
                            >
                              ${artefact.title}
                              ${artefact.satisfiesGate === false ? html` <span class="artefact-gate-hint">— doesn't count toward the gate</span>` : null}
                            </button>
                          `
                        )}
                      <//>
                    `
                  : html`<span class="artefact-value" aria-label="Artefact">${selectedArtefact?.title ?? ''}</span>`}
                ${selectedExcludedFromGate ? html`<span class="artefact-gate-hint" title="Completing this artefact alone won't pass the gate — another artefact at this gate has to be complete">Doesn't count toward the gate</span>` : null}
              </div>
            `
          : null}
        <${StageNavigation} modules=${navModules} visibleFieldIds=${visibleFieldIds} />
      </div>
      <div class="toolbar-actions">
        <button type="button" class=${'btn small' + (wrap.value ? ' active' : '')} aria-pressed=${wrap.value} onClick=${() => (wrap.value = !wrap.value)}>Wrap</button>
        <button type="button" class="btn" onClick=${onClearAllFields}>Clear all fields</button>
        <button type="button" class="btn primary" onClick=${afterUnsavedCheck(() => setRenderOpen(true))}>Render</button>
        ${requestApprovalSlug
          ? html`<button type="button" class="btn request-approval-btn" onClick=${scrollToApprovalPanel}>Review / Sign-off</button>`
          : null}
      </div>
    </div>
    ${renderOpen ? html`<${RenderDialog} instance=${instance} onClose=${() => setRenderOpen(false)} />` : null}
  `
}

// ---------- Settings dropdown (#107) ----------
// From an instance screen, "Settings" is no longer a single link straight
// to the (now tab-free) Global Settings screen — it opens a small dropdown
// offering Global Settings, Workspace Settings (scoped to this instance's
// own workspace — never a picker across every registered workspace), and
// Instance Settings (assignee, read-only instance info, read-only
// work-item link details). Every link carries an explicit `from` back to
// this exact instance screen (`/instance/<slug>`) — not browser history —
// so each Settings screen's own back control returns here. Its open/close
// behaviour is the shared Dropdown's (web/lib/dropdown.js) — closed by any click outside it or by Escape. AppHeader owns which header menu is open so Settings and Instance Switcher cannot be open at the same time.
// #303 — a local-workspace instance (`instance.isLocalWorkspace`, WI #297/A6's
// naming) carries its own IndexedDB registry id (`localWorkspaceId`) rather
// than a server-side workspace id, and the two Settings screens below need
// that id to resolve the right directory handle client-side — so it's
// threaded onto both links as `local=`, the same query-param convention the
// wizard already writes onto `/instance/<slug>?local=<id>` URLs.
// Without it, both screens would otherwise try (and fail) the old
// server-side registry fetch, which is the bug this ticket fixes.
//
// `from` needs the same treatment: a local-workspace instance's editor route
// only loads at all with `?local=` present (ModuleEditorPage's own
// loadLocalInstance path) — a bare `/instance/<slug>` 404s against the
// server-side registry it was never entered into. Without carrying those
// params through `from` too, every Settings screen's "← Back" control would
// dead-end back at a broken editor load, trading the ticket's broken
// forward link for an equally broken back one.
function SettingsMenu({ instance, open, onOpenChange }) {
  const localParam = instance.isLocalWorkspace ? `&local=${encodeURIComponent(instance.localWorkspaceId)}` : ''
  const localQuery = instance.isLocalWorkspace
    ? `?local=${encodeURIComponent(instance.localWorkspaceId)}`
    : ''
  const from = encodeURIComponent(`/instance/${instance.slug}${localQuery}`)
  const slug = encodeURIComponent(instance.slug)

  return html`
    <${Dropdown}
      className="settings-menu"
      triggerLabel="Settings"
      menuRole="menu"
      open=${open}
      onOpenChange=${onOpenChange}
    >
      <a role="menuitem" href=${`/settings?from=${from}`}>Global Settings</a>
      <a role="menuitem" href=${`/settings/workspace?slug=${slug}&from=${from}${localParam}`}>Workspace Settings</a>
      <a role="menuitem" href=${`/settings/instance?slug=${slug}&from=${from}${localParam}`}>Instance Settings</a>
    <//>
  `
}

// ---------- Instance switcher (#112) ----------
// A workspace-scoped switcher living in AppHeader: defaults to the viewed
// instance's own workspace's *other* instances (so jumping to a sibling
// instance never requires returning to the Workspaces landing page — #112's
// own acceptance criteria), with an explicit escape hatch to cross into a
// different workspace's instances instead. Reuses the same unified
// `GET /api/instances` listing and `groupInstancesByWorkspace` grouping the
// dashboard (#102) already relies on, rather than adding a second
// server-side listing route — the client already has everything this
// needs, since every row already carries its own `workspace` (or none, for
// a local instance).
//
// The escape hatch's own UI copy deliberately avoids the word "workspace"
// ("Browse other instances" / "← Back", not "Switch workspace" / "← This
// workspace") — `groupInstancesByWorkspace` groups a local instance onto
// its own single-instance "group" exactly like a real Azure-DevOps-backed
// one (#102's own convention), so the escape hatch's *other groups* can
// just as easily be another unrelated local instance as a genuine
// Workspace. Workspace is a specific, reserved entity in this codebase (an
// Azure DevOps organization/project/repository, docs/adr/0009) — this file
// already renamed "Open workspace" to "Open editor" once (#96 vs #102) to
// avoid exactly this kind of collision, so new copy here must not
// re-introduce it by implying every escape-hatch destination is a
// Workspace when it may just be another local instance.
//
// Navigating a sibling instance is a plain `<a href="/instance/:slug">` —
// exactly the link ModuleEditorPage's own doc comment already documents as
// re-pinning every instance-scoped signal on slug change, so this needs no
// extra plumbing of its own.
function isWorkspaceGroup(group) {
  return Boolean(group?.instances[0]?.workspace)
}

function InstanceSwitcher({ slug, instance, open, onOpenChange }) {
  const [instances, setInstances] = useState(null)
  const [error, setError] = useState('')
  // Resets to the default (own-workspace) view every time the menu is
  // freshly opened — a stale "cross-workspace" view left open from a
  // previous visit would otherwise greet the user with the wrong list.
  const [crossWorkspace, setCrossWorkspace] = useState(false)

  useEffect(() => {
    if (!open || instances !== null || error) return
    // Passes `slug` so this attaches *this* instance's own workspace PAT
    // override (#104), not just the global default — see loadInstances's
    // own doc comment for why that matters here specifically.
    loadInstances(slug)
      .then(setInstances)
      .catch((err) => setError(err.message))
  }, [open, instances, error, slug])

  // Its dismissal is the shared Dropdown's (web/lib/dropdown.js) — Escape or
  // any click outside the switcher closes it, same as the hand-rolled
  // window-listener version this replaced (there's no natural ancestor to
  // hang a click-outside-to-close on — the header isn't otherwise a click
  // target — so the Dropdown listens on the window directly).
  function handleOpenChange(next) {
    if (next) setCrossWorkspace(false)
    onOpenChange(next)
  }

  const groups = instances ? groupInstancesByWorkspace(instances) : []
  const currentGroup = groups.find((group) => group.instances.some((inst) => inst.slug === slug)) ?? null
  const siblings = currentGroup ? currentGroup.instances.filter((inst) => inst.slug !== slug) : []
  const otherGroups = groups.filter((group) => group.key !== currentGroup?.key)
  const workspaceId = isWorkspaceGroup(currentGroup)
    ? (currentGroup.instances[0]?.workspace?.id ?? currentGroup.key.replace(/^workspace:/, ''))
    : null
  // WI #316 fix #1 — a local-workspace instance (ADR-0029) never shows up in
  // `instances` at all (it has no server-side registry entry, see
  // isLocalWorkspaceSlug's own doc comment above), so it can never resolve
  // through `currentGroup`/`isWorkspaceGroup` above the way a genuine
  // Azure-DevOps-hosted workspace does — that's exactly why this fell back
  // to a bare, context-free `/new-instance` before. `instance` (passed down
  // from AppHeader, unlike `slug` alone) already carries `isLocalWorkspace`/
  // `localWorkspaceId` for every local instance regardless of how it was
  // opened (loadLocalInstance sets both unconditionally), so that's used
  // here instead — `?local=<id>` for the wizard to match against its own
  // already-held handle (new-workspace-wizard.js's
  // `preselectedLocalWorkspaceId` effect).
  const localWorkspaceIdForSwitch = !workspaceId && instance?.isLocalWorkspace ? instance.localWorkspaceId : null
  const newInstanceHref = workspaceId
    ? `/new-instance?workspace=${encodeURIComponent(workspaceId)}`
    : localWorkspaceIdForSwitch
      ? `/new-instance?local=${encodeURIComponent(localWorkspaceIdForSwitch)}`
      : '/new-instance'

  // #145: the instance's display name (falling back to its slug, exactly as before, when it has no
  // `name:` set) — not the slug itself, which used to be all this menu ever showed.
  function renderInstanceLink(inst) {
    return html`
      <a key=${inst.slug} class="switcher-item" href=${instanceHref(inst)} onClick=${() => onOpenChange(false)}>
        <span class="name">${inst.name || inst.slug}</span>
        <span class="def">${inst.definition}</span>
      </a>
    `
  }

  return html`
    <${Dropdown}
      className="instance-switcher"
      triggerLabel="Switch instance ▾"
      open=${open}
      onOpenChange=${handleOpenChange}
    >
      ${error ? html`<p class="load-error">${error}</p>` : null}
      ${!error && instances === null ? html`<p class="loading">Loading…</p>` : null}
      ${instances !== null && !crossWorkspace
        ? html`
            <div class="switcher-section">
              <div class="switcher-heading">${isWorkspaceGroup(currentGroup) ? currentGroup.title : 'Server instance'}</div>
              ${siblings.length > 0
                ? siblings.map(renderInstanceLink)
                : isWorkspaceGroup(currentGroup)
                  ? html`<p class="switcher-empty">No other instances in this workspace.</p>`
                  : html`<p class="switcher-empty">No other instances — not part of a workspace.</p>`}
              <a class="switcher-escape" href=${newInstanceHref} onClick=${() => onOpenChange(false)}>+ New Instance</a>
              ${otherGroups.length > 0
                ? html`
                    <button
                      type="button"
                      class="switcher-escape"
                      onClick=${() => setCrossWorkspace(true)}
                    >
                      Browse other instances →
                    </button>
                  `
                : null}
            </div>
          `
        : null}
      ${instances !== null && crossWorkspace
        ? html`
            <div class="switcher-section">
              <button type="button" class="switcher-back" onClick=${() => setCrossWorkspace(false)}>
                ← Back
              </button>
              ${otherGroups.map(
                (group) => html`
                  <div class="switcher-group" key=${group.key}>
                    <div class="switcher-heading">${group.title}</div>
                    ${group.instances.map(renderInstanceLink)}
                  </div>
                `
              )}
            </div>
          `
        : null}
    <//>
  `
}

// ---------- Header: title, stage line, free-browse stage nav ----------
// The theme toggle used to live here too, duplicated across this header,
// the Workspaces landing header, the setup wizard header, and Settings'
// header (#113) — now lives solely in Settings (web/pages/settings.js's
// SettingsHeader).
function GantryBrandIcon() {
  return html`
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M3 20h18M6 20V8l6-4 6 4v12M6 8h12" />
    </svg>
  `
}

// #145: the title shows the instance's display name (`instance.name`, its optional `name:` in
// instance.yaml) rather than only the slug — falling back to the slug, unchanged, when no name is
// set. Once a name is shown, the slug moves to its own small badge beside `.instance-ref` so it's
// still visible, just no longer the primary label.
function AppHeader({ instance }) {
  const [openMenu, setOpenMenu] = useState(null)

  return html`
    <header class="app-header">
      <div class="brand">
        <${GantryBrandIcon} />
        <a class="btn small ghost" href="/">← Workspaces</a>
        <h1>${instance.name || instance.slug} — ${instance.definition}</h1>
        ${instance.name
          ? html`<span class="instance-slug" title="Instance slug">${instance.slug}</span>`
          : null}
        <span class="instance-ref" title="Numeric reference (WI200) — the canonical short URL for this instance">${instance.ref}</span>
        <${InstanceSwitcher}
          slug=${instance.slug}
          instance=${instance}
          open=${openMenu === 'instance-switcher'}
          onOpenChange=${(next) => setOpenMenu(next ? 'instance-switcher' : null)}
        />
        <a class="btn small ghost" href="/user-guide">User Guide</a>
        <${SettingsMenu}
          instance=${instance}
          open=${openMenu === 'settings'}
          onOpenChange=${(next) => setOpenMenu(next ? 'settings' : null)}
        />
      </div>
      <p id="stage-line">${instance.stage.title} (gate: ${instance.stage.gate})</p>
      <nav id="stage-nav">
        ${instance.stages.map((stage) => {
          const isCurrent = stage.id === instance.currentStageId
          const isViewed = stage.id === instance.stage.id
          return html`
            <button
              type="button"
              key=${stage.id}
              class=${'btn small' + (isViewed ? ' active' : '') + (isCurrent ? ' stage-current' : '')}
              onClick=${isViewed ? undefined : afterUnsavedCheck(() => (viewedStage.value = stage.id))}
            >
              ${stage.title}${isCurrent ? ' (current)' : ''}
            </button>
          `
        })}
      </nav>
    </header>
  `
}

// ---------- Page: composes header + the viewed stage's screen ----------
// `slug` arrives as a route param from `/instance/:slug` (preact-iso passes matched params as top-level props). Re-pins the shared instance-scoped signals to this slug on mount and whenever the route's slug changes — e.g. following an "Open editor" link (#102 — this screen used to call that link "Open workspace", renamed to avoid colliding with the Workspace entity, #96) from one instance straight to another without an intervening full page load — clearing the previous instance's stale data first so it's never shown against the new slug. `batch()` matters here: without it, `currentSlug.value = slug` alone fires the instance-loading effect below (it's already subscribed to `currentSlug`) using whatever `viewedStage` was still left over from the instance just navigated away from — a stage that may not even be this new instance's current one — before the very next line resets it. That fires a real, wasted request for the wrong stage, whose response can race the correct one. Batching applies all four writes as one update, so the effect runs exactly once, with the new slug and `viewedStage: null` together.
function ModuleEditorPage({ slug: routeRef }) {
  useEffect(() => {
    batch(() => {
      instanceData.value = null
      loadError.value = null
      localGrantNeeded.value = false
      localDirHandle.value = null
    })

    // A local-workspace instance (ADR-0029) is opened at
    // `/instance/<slug>?local=<id>` — the convention A4's wizard
    // already writes (web/pages/new-workspace-wizard.js's openLocalInstance).
    // Detected here, off the route's own query string, the same convention
    // every other route in this app already uses for its query params.
    const searchParams = new URLSearchParams(window.location.search)
    const localId = searchParams.get('local')
    if (localId) {
      batch(() => {
        localWorkspaceParam.value = { id: localId, slug: routeRef }
        currentSlug.value = routeRef
        viewedStage.value = null
      })
      return
    }
    // WI #308 — this used to be a standalone `localWorkspaceParam.value = null`
    // write here, ahead of both branches below. That's the exact hazard the
    // `batch()` calls elsewhere in this effect already guard against (see this
    // function's own doc comment): a lone write fires every subscriber synchronously,
    // on the spot — including the module-level `assetSources`/instance-loading
    // effects, which read `localWorkspaceParam` (the assetSources one only
    // transitively, via `fetchAssets`'s own `isLocalWorkspaceSlug` check) — before
    // `currentSlug` itself catches up to the new (non-local) route on the next
    // line. A Back-navigation off a local-workspace instance straight onto another
    // one hits exactly this: `currentSlug` is still the just-left local slug when
    // that lone write lands, so the local check now reads `false` for it and a
    // stale local slug falls through to the server-side routes (a slug the server
    // has no record of, ADR-0029). Folding the clear into the same batch as the
    // slug it accompanies — same pattern as the local branch above — keeps the two
    // signals in lockstep so no subscriber ever observes one without the other.

    // A numeric reference (WI200, docs/adr/0024) resolves through the server first — the one
    // source of truth for what it means — then pins `currentSlug`/`viewedStage` to the *real*
    // slug/stage id it resolved to, exactly as a plain legacy slug route always has: every other
    // fetch in this file (module saves, asset uploads, render, etc.) is keyed off those two
    // signals holding real values, never a numeric ref. The bootstrap response is reused as this
    // page's first render (no second round-trip) — the instance-loading effect below still fires
    // once more when `currentSlug`/`viewedStage` change, a harmless redundant fetch of the exact
    // same data.
    if (NUMERIC_REF_RE.test(routeRef)) {
      resolveInstanceRef(routeRef)
        .then((data) => {
          batch(() => {
            localWorkspaceParam.value = null
            currentSlug.value = data.slug
            viewedStage.value = data.stage.id
            instanceData.value = data
            loadError.value = null
          })
        })
        .catch((err) => {
          loadError.value = err.message
        })
      return
    }

    batch(() => {
      localWorkspaceParam.value = null
      currentSlug.value = routeRef
      viewedStage.value = null
    })
  }, [routeRef])

  const instance = instanceData.value
  const error = loadError.value
  const [selectedArtefactId, setSelectedArtefactId] = useState(null)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncing, setSyncing] = useState(false)

  // The field registry backing "Clear all fields" (#114 moved this button,
  // and hence this registry, up from StageScreen into this parent — the
  // toolbar it now lives in sits above StageScreen and outlives any single
  // stage's mount, so it's no longer freed-and-refreshed just by
  // StageScreen's own key-driven remount). Rather than resetting it in a
  // separate effect keyed on the stage id — which would race the freshly
  // mounted stage's own ModuleCard/MarkdownField registration effects
  // (child effects commit before an ancestor's, so a parent-level reset
  // effect could fire *after* the new stage's fields already registered,
  // wiping them out) — registerField itself detects a stage change and
  // resets synchronously before recording the new field, so there's no
  // window where a genuinely-current registration can be discarded.
  const registryRef = useRef({ stageKey: null, entries: [] })
  const selectionContextRef = useRef({ slug: null, stageId: null })

  // ---- Centralised Save (WI #376) ----
  // A module is unsaved while its fields and layout differ from what was
  // loaded or last saved — a comparison, not an edit flag, so undoing back to
  // the saved text makes it clean again. Everything here reads signals and
  // refs, never this render's `instance`, because the listeners below are
  // installed once.
  const savedRef = useRef({ key: null, payloads: new Map(), keys: new Map() })
  const [leavePrompt, setLeavePrompt] = useState(null)
  const locationRef = useRef(null)
  locationRef.current = useLocation()
  const editorUrlRef = useRef(null)
  const stageKey = (inst) => `${inst.slug}|${inst.stage.id}`

  // Live field values for one module, from the editors mounted for this stage.
  function liveValues(inst, moduleId) {
    if (registryRef.current.stageKey !== stageKey(inst)) return () => undefined
    const controls = new Map()
    for (const entry of registryRef.current.entries) {
      if (entry.moduleId === moduleId) controls.set(entry.field.id, entry.control)
    }
    return (field) => controls.get(field.id)?.getValue()
  }

  function currentPayload(inst, mod) {
    return modulePayload(mod, liveValues(inst, mod.id))
  }

  // The saved baseline comes from the loaded data itself, so it never depends
  // on when the editors mount.
  function captureSaved(inst) {
    if (savedRef.current.key === stageKey(inst)) return
    const payloads = new Map(inst.modules.map((mod) => [mod.id, modulePayload(mod)]))
    savedRef.current = {
      key: stageKey(inst),
      payloads,
      keys: new Map([...payloads].map(([id, payload]) => [id, payloadKey(payload)])),
    }
    batch(() => {
      moduleSaveStatus.value = {}
      stageSave.value = IDLE_STAGE_SAVE
    })
  }

  function refreshDirty() {
    const inst = instanceData.value
    if (!inst?.stage || inst.slug !== currentSlug.peek()) return
    captureSaved(inst)
    const ids = inst.modules
      .filter((mod) => payloadKey(currentPayload(inst, mod)) !== savedRef.current.keys.get(mod.id))
      .map((mod) => mod.id)
    const current = stageSave.peek()
    if (ids.join('\n') !== current.dirtyModuleIds.join('\n')) stageSave.value = { ...current, dirtyModuleIds: ids }
  }

  // Writes only the changed modules: through the folder handle for a local
  // workspace (works offline, ADR-0029), otherwise one request — one commit on
  // an Azure-DevOps-backed stage branch. Resolves true when the save worked.
  async function saveStage() {
    refreshDirty()
    const inst = instanceData.peek()
    const { dirtyModuleIds, phase } = stageSave.peek()
    if (!inst?.stage || isEditingBlocked() || phase === 'saving') return false
    if (dirtyModuleIds.length === 0) return true
    const key = stageKey(inst)
    const payloads = Object.fromEntries(
      dirtyModuleIds.map((id) => [id, currentPayload(inst, inst.modules.find((mod) => mod.id === id))])
    )
    stageSave.value = { ...stageSave.peek(), phase: 'saving', message: '' }
    try {
      let statusModules
      if (inst.isLocalWorkspace) {
        const handle = localDirHandle.peek()
        if (!handle) throw new Error('Local workspace folder is not open.')
        for (const id of dirtyModuleIds) {
          const mod = inst.modules.find((m) => m.id === id)
          const moduleSpec = {
            id: mod.id,
            title: mod.title,
            fields: mod.fields.filter((f) => !f.custom).map((f) => ({ id: f.id, title: f.title, type: f.type })),
          }
          await writeLocalTextFile(handle, localModuleFilesPath(inst.slug, id), renderLocalModuleInstanceFile(id, moduleSpec, payloads[id]))
        }
        statusModules = (await getLocalStatus(handle, inst.slug, inst.localDefinitionStructure, inst.stage.id)).modules
      } else {
        const params = new URLSearchParams({ stage: inst.stage.id, slug: inst.slug })
        const res = await apiFetchForInstance(inst.slug, `/api/instance/modules?${params}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modules: payloads }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.message ?? body.error ?? `the server answered ${res.status}`)
        statusModules = body.modules ?? []
      }
      if (savedRef.current.key === key) {
        for (const id of dirtyModuleIds) {
          savedRef.current.payloads.set(id, payloads[id])
          savedRef.current.keys.set(id, payloadKey(payloads[id]))
        }
      }
      batch(() => {
        moduleSaveStatus.value = {
          ...moduleSaveStatus.peek(),
          ...Object.fromEntries(dirtyModuleIds.map((id) => [id, saveStatusLine(statusModules.find((m) => m.id === id))])),
        }
        stageSave.value = { ...stageSave.peek(), phase: 'saved', message: '' }
      })
      refreshDirty()
      setTimeout(() => {
        if (stageSave.peek().phase === 'saved') stageSave.value = { ...stageSave.peek(), phase: 'idle' }
      }, 2500)
      return true
    } catch (err) {
      stageSave.value = { ...stageSave.peek(), phase: 'error', message: `Save failed: ${err.message}` }
      return false
    }
  }

  // Puts every unsaved module back to what's saved: editor text, list rows,
  // and any sections or lists inserted or removed since.
  function discardDrafts() {
    const inst = instanceData.peek()
    const { dirtyModuleIds } = stageSave.peek()
    if (!inst?.stage || savedRef.current.key !== stageKey(inst) || dirtyModuleIds.length === 0) return
    if (registryRef.current.stageKey === stageKey(inst)) {
      const latest = new Map(registryRef.current.entries.map((entry) => [`${entry.moduleId}.${entry.field.id}`, entry]))
      for (const { field, control, moduleId } of latest.values()) {
        const saved = dirtyModuleIds.includes(moduleId) ? savedRef.current.payloads.get(moduleId) : null
        if (!saved || !(field.id in saved.fields)) continue
        if (JSON.stringify(control.getValue()) !== JSON.stringify(saved.fields[field.id])) control.setValue(saved.fields[field.id])
      }
    }
    instanceData.value = {
      ...inst,
      modules: inst.modules.map((mod) =>
        dirtyModuleIds.includes(mod.id) ? { ...mod, fields: savedFields(mod, savedRef.current.payloads.get(mod.id)) } : mod
      ),
    }
  }

  // Save / Discard / Cancel when there's unsaved work; resolves true to go ahead.
  function confirmLeave() {
    refreshDirty()
    if (stageSave.peek().dirtyModuleIds.length === 0) return Promise.resolve(true)
    return new Promise((resolve) =>
      setLeavePrompt((previous) => {
        previous?.resolve(false)
        return { resolve }
      })
    )
  }

  async function answerLeavePrompt(choice) {
    const prompt = leavePrompt
    setLeavePrompt(null)
    if (!prompt) return
    if (choice === 'save') {
      prompt.resolve(await saveStage())
    } else if (choice === 'discard') {
      discardDrafts()
      prompt.resolve(true)
    } else {
      prompt.resolve(false)
    }
  }

  stageSaveActions = { save: saveStage, confirmLeave }

  useEffect(() => {
    editorUrlRef.current = window.location.pathname + window.location.search
  })

  useEffect(() => {
    const stopDirtyTracking = effect(() => {
      void contentEdits.value
      refreshDirty()
    })
    const hasUnsaved = () => stageSave.peek().dirtyModuleIds.length > 0
    let returningFromPrompt = false

    // In-app links (← Workspaces, Switch instance, User Guide, Settings…) are
    // caught before the router sees them.
    function onClick(e) {
      if (!hasUnsaved() || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const link = e.composedPath().find((node) => node.nodeName === 'A' && node.href)
      if (!link || link.origin !== window.location.origin || link.download) return
      if (link.target && !/^_?self$/i.test(link.target)) return
      if (/^#/.test(link.getAttribute('href') ?? '')) return
      if (link.pathname === window.location.pathname && link.search === window.location.search) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const url = link.href.replace(window.location.origin, '')
      stageSaveActions.confirmLeave().then((ok) => ok && locationRef.current.route(url))
    }

    // Browser back/forward has already moved by the time popstate fires: put
    // the editor's entry back, ask, and only then really go.
    function onPopState(e) {
      if (returningFromPrompt) {
        returningFromPrompt = false
        return
      }
      const here = window.location.pathname + window.location.search
      if (!hasUnsaved() || here === editorUrlRef.current) return
      e.stopImmediatePropagation()
      history.pushState(null, '', editorUrlRef.current)
      stageSaveActions.confirmLeave().then((ok) => {
        if (!ok) return
        returningFromPrompt = true
        history.back()
      })
    }

    function onBeforeUnload(e) {
      if (!hasUnsaved()) return
      e.preventDefault()
      e.returnValue = ''
    }

    // Captured at the window so it also works inside editors and table cells.
    function onKeyDown(e) {
      if (e.key?.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      if (hasUnsaved()) stageSaveActions.save()
    }

    window.addEventListener('click', onClick, true)
    popStateGuard = onPopState
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      stopDirtyTracking()
      window.removeEventListener('click', onClick, true)
      popStateGuard = null
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('keydown', onKeyDown, true)
      stageSaveActions = NO_STAGE_SAVE
      stageSave.value = IDLE_STAGE_SAVE
    }
  }, [])

  useEffect(() => {
    if (!instance) return
    const previous = selectionContextRef.current
    const stageChanged = previous.slug === instance.slug && previous.stageId !== null && previous.stageId !== instance.stage.id
    const next = stageChanged ? defaultArtefactId(instance.artefacts) : readArtefactSelection(instance.slug, instance.stage.id, instance.artefacts)
    if (stageChanged && next) persistArtefactSelection(instance.slug, instance.stage.id, next)
    setSelectedArtefactId(next)
    selectionContextRef.current = { slug: instance.slug, stageId: instance.stage.id }
  }, [instance?.slug, instance?.stage?.id])

  function registerField(field, control, moduleId) {
    if (registryRef.current.stageKey !== stageKey(instance)) {
      registryRef.current = { stageKey: stageKey(instance), entries: [] }
    }
    registryRef.current.entries.push({ field, control, moduleId })
  }

  function clearAllFields() {
    registryRef.current.entries.forEach(({ field, control }) => control.setValue(emptyFieldValue(field)))
  }

  function changeArtefact(artefactId) {
    // Selection changes hide some editors. Capture their live drafts first so
    // switching back to the artefact does not discard text typed this visit.
    const drafts = new Map(
      registryRef.current.entries.map(({ field, control, moduleId }) => [`${moduleId}.${field.id}`, control.getValue()])
    )
    if (drafts.size) {
      instanceData.value = {
        ...instanceData.value,
        modules: instanceData.value.modules.map((mod) => ({
          ...mod,
          fields: mod.fields.map((field) => {
            const key = `${mod.id}.${field.id}`
            return drafts.has(key) ? { ...field, value: drafts.get(key) } : field
          }),
        })),
      }
    }
    const nextArtefact = instance.artefacts.find((artefact) => artefact.id === artefactId)
    const nextVisibleFieldIds = artefactFieldIds(instance.modules, nextArtefact)
    registryRef.current.entries = registryRef.current.entries.filter(({ field, moduleId }) =>
      nextVisibleFieldIds.has(`${moduleId}.${field.id}`)
    )
    persistArtefactSelection(instance.slug, instance.stage.id, artefactId)
    setSelectedArtefactId(artefactId)
  }

  async function handleSyncFromMain() {
    if (!instance || syncing) return
    setSyncing(true)
    setSyncStatus('Syncing…')
    try {
      const params = new URLSearchParams({ slug: instance.slug, stage: instance.stage.id })
      const res = await apiFetchForInstance(instance.slug, `/api/instance/stage-branch/sync?${params}`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 409) {
          const conflicts = body.conflicts?.join(', ') || 'files'
          setSyncStatus(`Sync failed: conflict on ${conflicts}`)
        } else {
          setSyncStatus(`Sync failed: ${body.error ?? body.message ?? res.status}`)
        }
        return
      }
      setSyncStatus('Synced — refreshing…')
      const data = await loadInstance(instance.slug, instance.stage.id)
      // What's saved just changed underneath the editors.
      savedRef.current = { key: null, payloads: new Map(), keys: new Map() }
      instanceData.value = data
      setSyncStatus('')
    } catch (err) {
      setSyncStatus(`Sync failed: ${err.message}`)
    } finally {
      setSyncing(false)
    }
  }

  // A remembered local-workspace handle's permission has lapsed (the normal
  // state after a reload, `web/lib/localWorkspace.js`'s `ensurePermission`
  // doc comment) — same "Grant access" affordance the wizard's own
  // recent-workspaces list uses, rather than a raw load error.
  if (localGrantNeeded.value) {
    return html`
      <div class="wizard-field" id="local-editor-grant-needed">
        <p class="inline-error">This local workspace needs permission again in this browser.</p>
        <button
          type="button"
          class="btn primary"
          id="local-editor-grant"
          onClick=${() => (localRetryTick.value += 1)}
        >
          Grant access
        </button>
      </div>
    `
  }
  if (error) return html`<p class="load-error">Failed to load: ${error}</p>`
  // Compared against `currentSlug` (the real slug the route's own ref/slug already resolved to),
  // not the raw `routeRef` prop — a numeric reference (WI200) never equals `instance.slug` itself.
  if (!instance || instance.slug !== currentSlug.value) return html`<p class="loading">Loading…</p>`

  const selectedArtefact = instance.artefacts.find((artefact) => artefact.id === selectedArtefactId) ??
    instance.artefacts.find((artefact) => artefact.id === defaultArtefactId(instance.artefacts)) ?? null
  const visibleFieldIds = selectedArtefact ? artefactFieldIds(instance.modules, selectedArtefact) : null
  const stageSync = instance.stageSync
  const showStageSyncBanner = Boolean(stageSync?.behind) && (stageSync?.behindFiles?.length ?? 0) > 0
  return html`
    <${AppHeader} instance=${instance} />
    ${instance.archived
      ? html`<div class="archived-banner">
          This instance is <strong>archived</strong> and hidden from the dashboard. Restore it from
          <a href=${`/settings/instance?slug=${encodeURIComponent(instance.slug)}&from=${encodeURIComponent('/instance/' + instance.slug)}`}>Instance Settings</a>
          to make changes.
        </div>`
      : null}
    ${!instance.archived && instance.workspaceBacked && instance.stageCompleted
      ? html`<div class="archived-banner completed-stage-banner" role="status" data-testid="completed-stage-banner">
          This stage is <strong>complete</strong> — it shows the approved version on main.
          ${instance.crossStageEdit
            ? html` <strong>${instance.crossStageEdit.title}</strong> has changes to modules shown here that haven't reached main yet — check there for the latest.`
            : null}
        </div>`
      : null}
    ${!instance.archived && writeAccessBlockedReason()
      ? html`<div class="archived-banner write-access-banner" data-testid="write-access-banner">
          ${writeAccessBlockedReason().message}
          <${AddCredentialAction} />
        </div>`
      : null}
    ${showStageSyncBanner
      ? html`<div class="archived-banner stage-sync-banner" role="status" data-testid="stage-sync-banner">
          This stage's working branch is behind main on ${stageSync.behindFiles.length} file(s). Sync to pull the latest.
          <button type="button" class="btn small" disabled=${syncing || isEditingBlocked()} onClick=${handleSyncFromMain} data-testid="sync-from-main">
            ${syncing ? 'Syncing…' : 'Sync from main'}
          </button>
          ${syncStatus ? html`<span class="save-status">${syncStatus}</span>` : null}
        </div>`
      : null}
    <${ViewModeToolbar}
      instance=${instance}
      visibleFieldIds=${visibleFieldIds}
      selectedArtefactId=${selectedArtefact?.id ?? null}
      selectedArtefact=${selectedArtefact}
      onArtefactChange=${changeArtefact}
      onClearAllFields=${clearAllFields}
      requestApprovalSlug=${advancedMode.value && instance.workspaceBacked ? instance.slug : null}
    />
    <${StageScreen}
      key=${instance.stage.id}
      instance=${instance}
      visibleFieldIds=${visibleFieldIds}
      onFieldRegistered=${registerField}
    />
    ${leavePrompt
      ? html`<${UnsavedChangesDialog} count=${stageSave.value.dirtyModuleIds.length} onAnswer=${answerLeavePrompt} />`
      : null}
  `
}

// ============================================================ Workspaces landing page (#77, restructured by #102) — the landing screen at `/`, titled "Workspaces". Two togglable views over the multi-instance registry (`GET /api/instances`, #76): master-detail (default, grouping instances by workspace — see groupInstancesByWorkspace above) and stage swimlanes (still one chip per instance, ungrouped — the ticket's own acceptance criteria describe the *list*, i.e. master-detail's list pane, not this alternate view). The view choice is a persisted signal (web/lib/dashboardView.js), not local state, so it survives remounting this page and reloading the app. ============================================================

// `slug` is optional: the Workspaces landing page (DashboardPage) calls this with none, since it has
// no single "current" workspace in mind. #9 (ADR-0038): with the global-default PAT gone, that
// unscoped call now carries no Authorization header at all, so every Provider-backed row this
// listing can't authenticate to is left out (lib/registry.js's `buildAzureDevOpsRow`'s own
// long-standing "an entry it can't read is left out, not a fatal error" contract) — in practice,
// every Provider-backed row, until a design exists for a listing that spans more than one workspace's
// own credential. A caller that *does* already know which instance it's asking on behalf of
// (InstanceSwitcher, below) should pass its slug, so this resolves and attaches that instance's own
// workspace PAT via `apiFetchForInstance` instead — its own rows keep enriching correctly regardless
// of the dashboard-wide gap above.
async function loadInstances(slug) {
  const res = slug ? await apiFetchForInstance(slug, '/api/instances') : await apiFetch('/api/instances')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load instances (${res.status})`)
  }
  return res.json()
}

// #122 (parent #109, docs/adr/0047): every workspace `GET /api/workspaces` knows about — needs no
// credential itself (same uncredentialed route the legacy-PAT migration at the bottom of this file
// already calls) — is what DashboardPage joins against `loadInstances`'s own result
// (web/lib/dashboardWorkspaces.js's `unrepresentedWorkspaceGroups`) so a registered workspace
// contributing zero rows to the instances listing still gets a row of its own.
async function loadWorkspaces() {
  const res = await apiFetch('/api/workspaces')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Failed to load workspaces (${res.status})`)
  }
  return res.json()
}

// Registry `status` is only ever 'complete'/'incomplete' (the current stage's requirements) — a different, coarser vocabulary than a module's own draft/review/agreed frontmatter status. Reuses the same `.stamp` tokens (agreed = done, draft = still in progress) rather than inventing a third visual language, since the Gate Ledger only defines those three.
function statusStampClass(status) {
  return status === 'complete' ? 'agreed' : 'draft'
}

function StatusStamp({ status }) {
  return html`<span class="stamp ${statusStampClass(status)}">${status.toUpperCase()}</span>`
}

function pullRequestBadge(inst) {
  if (!inst.workspace || inst.pullRequestId == null) return null
  const status = inst.pullRequestStatus
  if (status === null || status === undefined) return html`<span class="pr-badge">PR OPEN</span>`
  if (status === 'active' || status === 'notSet') return html`<span class="pr-badge">PR OPEN</span>`
  return null
}

function relativeUpdatedAt(updatedAt) {
  const timestamp = Date.parse(updatedAt)
  if (!Number.isFinite(timestamp)) return 'unknown'

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function UpdatedAt({ value }) {
  if (!value) return null
  return html`<span class="updated-at" title=${value}>Updated ${relativeUpdatedAt(value)}</span>`
}

function ViewToggle() {
  const [open, setOpen] = useState(false)

  function selectViewMode(mode) {
    dashboardViewMode.value = mode
    setOpen(false)
  }

  return html`
    <${Dropdown}
      className="view-toggle"
      triggerLabel="View mode"
      menuRole="menu"
      open=${open}
      onOpenChange=${setOpen}
    >
      ${DASHBOARD_VIEW_MODES.map(
        (mode) => html`
          <button
            type="button"
            key=${mode}
            role="menuitem"
            class=${'view-mode-option' + (dashboardViewMode.value === mode ? ' selected' : '')}
            aria-current=${dashboardViewMode.value === mode ? 'true' : undefined}
            onClick=${() => selectViewMode(mode)}
          >
            ${mode === 'master-detail' ? 'Default' : 'Swimlanes'}
          </button>
        `
      )}
    <//>
  `
}

function EmptyState() {
  return html`
    <div class="dashboard-empty">
      <p>No instances registered yet.</p>
      <a class="btn primary" href="/new-workspace">+ New Workspace</a>
    </div>
  `
}

// Runs an instance's Check or Render action against the registry-listing API's slug (not the module editor's shared signals, which only track whichever single instance is currently open) — the dashboard can trigger either action for any listed instance without navigating away from it.
// Names the closest incomplete artefact that can pass the gate — never a `satisfies-gate: false` one
// (#151, ADR-0051), the same rule as lib/check.js's formatGateOutstanding.
function formatGateFailure(body) {
  const artefacts = body.artefacts ?? []
  const satisfying = artefacts.filter((artefact) => artefact.satisfiesGate !== false)
  const incomplete = satisfying.filter((artefact) => !artefact.complete)
  if (artefacts.length && !satisfying.length) return 'FAIL — no artefact counts toward this gate'
  if (incomplete.length) {
    const closest = incomplete.reduce((best, artefact) =>
      artefact.outstanding.length < best.outstanding.length ? artefact : best
    )
    return `FAIL — ${closest.title}: ${closest.outstanding.join(', ') || 'see required modules'}`
  }

  const outstanding = (body.modules ?? []).filter((module) => !module.complete).map((module) => module.title)
  return `FAIL — outstanding: ${outstanding.join(', ') || 'see modules'}`
}

async function runCheck(slug) {
  const res = await apiFetchForInstance(slug, `/api/instance/check?slug=${encodeURIComponent(slug)}`)
  const body = await res.json()
  if (!res.ok) return `Check failed: ${body.message ?? body.error}`
  if (body.pass) return 'PASS — gate requirements met.'
  return formatGateFailure(body)
}

async function runRender(slug) {
  const detailRes = await apiFetchForInstance(slug, `/api/instance?slug=${encodeURIComponent(slug)}`)
  const detail = await detailRes.json()
  if (!detailRes.ok) return `Render failed: ${detail.message ?? detail.error}`
  if (!detail.artefacts.length) return 'No artefact available to render for this stage yet.'
  const results = []
  for (const artefact of detail.artefacts) {
    // WI314 — the dashboard swimlane's own quick-action "Render" (distinct from the module
    // editor's RenderDialog above, same engine-aware helper): this view only ever lists
    // registered (Azure-DevOps-hosted or plain-local) instances, never an ADR-0029
    // local-workspace one. `detail.workspaceBacked` (WI #317 fix) tells the two apart so the
    // helper picks the matching WASM leg — the Azure DevOps two-push flow, or (WI #349) the
    // local out/ flow — before falling through to the native path.
    const line = await renderAzureArtefactViaEngine(artefact, slug, detail.workspaceBacked)
    results.push(line.text ?? `Rendered ${artefact.title}`)
  }
  return results.join(' · ')
}

// The canonical link to an instance's module editor (WI200, docs/adr/0024): a numeric reference
// (`/instance/w<workspaceNumber>i<instanceNumber>`) when the row carries one — every `GET /api/instances`
// row does, since `lib/registry.js` assigns one lazily on read — falling back to the legacy
// `/instance/<slug>` form only for a row shape that somehow lacks it (defensive; not expected in
// practice). `ModuleEditorPage` accepts either form interchangeably (see NUMERIC_REF_RE above).
function instanceHref(inst) {
  if (inst.workspaceNumber !== undefined && inst.instanceNumber !== undefined) {
    return `/instance/w${inst.workspaceNumber}i${inst.instanceNumber}`
  }
  return `/instance/${inst.slug}`
}

// ---------- Advanced-mode listing filter (#301) ----------
// A dashboard row is "Azure-DevOps-backed" when its location resolves to a
// real Azure DevOps workspace — `lib/registry.js` now attaches a `workspace`
// to every row (WI #357), tagged `kind: 'azureDevOps'` or `kind: 'directory'`
// (a server workspace, WI #356) — so this checks the kind explicitly rather
// than mere presence. Browser local workspaces (ADR-0029, `useLocalGroups`
// below) never appear in this `instances` list at all — their own groups are
// blended in separately by `MasterDetailView`, unaffected by this filter.
// When advanced mode is off (#301) the dashboard listing drops
// Azure-DevOps-backed rows and shows only server-workspace-backed ones.
function isAzureDevOpsBacked(inst) {
  return inst.workspace?.kind === 'azureDevOps'
}

// A workspace's short display label for contexts that just need one line, not the full title/subtitle
// pair `groupInstancesByWorkspace` builds below (the archived-instances panel, e.g.) — same per-kind
// rule as that function's own title, factored out so the two can't drift.
function workspaceLabel(workspace) {
  if (!workspace) return null
  // #135: `subtitle` is the "where" line for every kind — an Azure DevOps workspace's
  // `organization/project`, a GitHub one's owner, a GitLab one's namespace — and `title` is the
  // server-directory name this used to return directly. See `describeInstanceRowWorkspace`'s own
  // comment for why reading `.name` for every non-Azure-DevOps kind was wrong.
  const { title, subtitle } = describeInstanceRowWorkspace(workspace)
  return workspace.kind === 'azureDevOps' ? subtitle : title
}

// ---------- Grouping instances by workspace (#102, WI #357) ----------
// The Workspaces landing page's core grouping rule: every row now carries a `workspace` (lib/registry.js,
// WI #357) — an Azure-DevOps-backed one (`kind: 'azureDevOps'`, #102) or a server-workspace one
// (`kind: 'directory'`, WI #356) — and every instance sharing that workspace's `id` groups into one row,
// one entry per workspace, regardless of kind. The `local:<slug>` fallback below is defensive only: every
// row `GET /api/instances` can produce as of WI #356 belongs to some real workspace, so it should never
// actually trigger, but grouping by the instance's own slug rather than silently dropping a row that
// somehow lacks one is the same "fail into a visible, singleton group" choice #102 always made here.
function groupInstancesByWorkspace(instances) {
  const groups = new Map()
  for (const inst of instances) {
    const key = inst.workspace ? `workspace:${inst.workspace.id}` : `local:${inst.slug}`
    if (!groups.has(key)) {
      // #135: one branch per row-workspace shape, in web/lib/dashboardWorkspaces.js so it is unit
      // testable (this file is the bundle entry and imports preact, so it isn't) and so it sits beside
      // `describeRegisteredWorkspace`, its placeholder-row twin — the two describe the same workspace
      // from two different payloads and drifted apart, which is what produced the crash.
      const { title, subtitle } = describeInstanceRowWorkspace(inst.workspace)
      groups.set(key, {
        key,
        title: inst.workspace ? title : inst.slug,
        subtitle: inst.workspace ? subtitle : 'Server instance',
        instances: [],
      })
    }
    groups.get(key).instances.push(inst)
  }
  // #135: a group whose title is somehow still absent must not take the whole dashboard down — the
  // original failure here was an uncaught `undefined.localeCompare` inside this sort, which killed
  // every row rather than mislabelling one. `describeInstanceRowWorkspace` now always returns
  // something for a known shape; this is the belt-and-braces for a shape nobody has invented yet.
  return [...groups.values()].sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))
}

// The list-pane row's secondary line — deliberately the same shape whether the group holds one instance or several (count · distinct definitions), rather than branching into a one-off "single instance" format, so a single-instance workspace is never visually singled out from a multi-instance one (the ticket's own "no special-casing visible to the user" acceptance criterion). A local-workspace group (see useLocalGroups below) has its own recovery states (not yet resolved / permission needed), so those still get their own, simpler text — but once its instances *are* resolved, each one's `instance.yaml` carries a `definition` just like a server-hosted instance's own record does, so the "· <definitions>" suffix applies here too rather than silently omitting it.
// The selected workspace's title and subtitle in the dashboard's detail pane, with a "+ New Instance"
// button beside them wherever the New Instance step can create straight into that workspace (see
// `workspaceNewInstanceHref`) — so adding one to the workspace you're looking at doesn't mean going
// through "+ New Workspace" and picking it again.
function WorkspaceDetailHead({ group }) {
  const newInstanceHref = workspaceNewInstanceHref(group)
  return html`
    <div class="workspace-detail-head">
      <div>
        <h2>${group.title}</h2>
        <p class="workspace-subtitle">${group.subtitle}</p>
      </div>
      ${newInstanceHref ? html`<a class="btn small" href=${newInstanceHref}>+ New Instance</a>` : null}
    </div>
  `
}

function groupSummaryText(group) {
  if (group.kind === 'local') {
    if (group.state === 'loading') return 'Opening…'
    if (group.state !== 'granted') return 'Needs permission'
  }
  // #122: a registered-but-unrepresented workspace (web/lib/dashboardWorkspaces.js) has no instances
  // of its own to summarize — its own two states get their own short list-pane text instead, distinct
  // from each other the same way their detail-pane copy is (MasterDetailView, above).
  if (group.kind === 'placeholder') {
    // #187: 'blank' — every instance here is archived; it reads like any other empty workspace.
    if (group.state === 'blank') return 'No instances'
    return group.state === 'unreadable' ? "Can't read this workspace" : 'Nothing registered yet'
  }
  const definitions = [...new Set(group.instances.map((inst) => inst.definition))]
  const count = group.instances.length
  return `${count} instance${count === 1 ? '' : 's'} · ${definitions.join(', ')}`
}

// A group's dot in the list pane reflects every one of its instances being complete, not just the first — a multi-instance workspace with even one outstanding instance is "in progress" as a whole. A local-workspace group has no per-instance `status` at all (ADR-0029) — its dot instead reflects whether its folder permission is currently granted. #122: a placeholder group's dot reflects its own `state` instead — `unreadable` gets the same red the Gate Ledger's `.stamp.error` already uses (`.dot.unreadable`, web/style.css), visually distinct from the neutral `draft` amber `empty` shares with "in progress" — deliberately, since "can't read this" and "still in progress" are different situations, but "nothing registered yet" and "in progress" are close enough in urgency to share a color.
function groupStatusClass(group) {
  if (group.kind === 'local') return group.state === 'granted' ? 'agreed' : 'draft'
  if (group.kind === 'placeholder') return group.state === 'unreadable' ? 'unreadable' : 'draft'
  return group.instances.every((inst) => inst.status === 'complete') ? 'agreed' : 'draft'
}

// ---------- Local workspaces, blended into the master-detail list (#296/A5, reworked by #306) ----------
// WI #306: the dashboard used to render remembered local workspaces
// (web/lib/localWorkspace.js, IndexedDB) as their own "Local workspaces"
// card, entirely separate from groupInstancesByWorkspace's per-workspace
// grouping. The maintainer asked for these blended into the *same* list
// instead — local groups sorted to the top, no separate section/heading, no
// per-row "Local" badge (the top-of-list position plus the subtitle text
// below is enough). A local workspace is never in `GET /api/instances` at
// all (ADR-0029), so it can't just be another row `groupInstancesByWorkspace`
// produces from that response — each one needs its own client-side folder
// read (handle + permission + `gantry-workspace/` listing), exactly the read
// `LocalWorkspaceRow` used to perform for its own standalone section.
//
// `useLocalGroups` owns that: it loads `recentLocalWorkspaces()` once, then
// mounts one invisible `LocalGroupResolver` per remembered workspace, each
// running its own resolve() independently and reporting its result back up.
// That keeps every local workspace's (potentially slow) folder read from
// blocking any other row — including the server-hosted ones, which render
// immediately from the one already-loaded `instances` list — matching the
// "pop in asynchronously, don't block the page" requirement.
// Fetches (and caches, per resolve() call) a definition version's projection — the same
// `resolveDefinitionStructure` (web/lib/localDefinitionFiles.js) `loadLocalInstance` already
// uses (WI #384: this workspace's own definitions/ folder first, else the library) — so a local
// workspace holding several instances of the same definition/version reads it once, not once
// per instance.
async function fetchLocalDefinitionStructure(handle, cache, definitionId, definitionVersion) {
  const cacheKey = `${definitionId}:${definitionVersion}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)
  const structure = await resolveDefinitionStructure(handle, definitionId, definitionVersion)
  cache.set(cacheKey, structure)
  return structure
}

// WI #357: builds the full dashboard-card row for one local-workspace instance — status, stage
// position, assignee and last-updated, computed entirely client-side via `getLocalStatus`
// (`web/lib/localStatus.js`, WI #313's port of `lib/status.js`'s gate-evaluation core) — the same
// parity helper this ticket asked for, so a local workspace's card carries exactly the same
// information a server-hosted one's does, with no server round trip beyond the one-time,
// cacheable definition-structure fetch above (unaffected by this ticket's own "no new server API
// call" requirement, which is about *instance* data, not static definition content).
async function buildLocalInstanceRow(handle, slug, structureCache) {
  const instanceYamlText = await readTextFile(handle, `gantry-workspace/${slug}/instance.yaml`)
  const record = parseInstanceYaml(instanceYamlText)
  const definitionId = record.definition
  const definitionVersion = record.definitionVersion ?? 1
  const structure = await fetchLocalDefinitionStructure(handle, structureCache, definitionId, definitionVersion)
  const localStatus = await getLocalStatus(handle, slug, structure, record.stage)
  const stageIndex = structure.stages.findIndex((s) => s.id === localStatus.stage.id)

  const mtimes = [await getFileLastModified(handle, `gantry-workspace/${slug}/instance.yaml`)]
  const moduleFiles = await listLocalDir(handle, `gantry-workspace/${slug}/modules`).catch(() => [])
  for (const file of moduleFiles) {
    if (file.kind !== 'file') continue
    mtimes.push(await getFileLastModified(handle, `gantry-workspace/${slug}/modules/${file.name}`))
  }

  return {
    slug,
    definition: definitionId,
    definitionVersion,
    stage: localStatus.stage.id,
    status: localStatus.complete ? 'complete' : 'incomplete',
    assignee: record.assignee ?? '',
    // #145: the instance's optional display name (`name:` in instance.yaml) verbatim, or `null` —
    // same field, same fallback-to-slug contract, as a server-hosted row's.
    name: record.name ?? null,
    stageNumber: stageIndex + 1,
    stageCount: structure.stages.length,
    stageTitle: localStatus.stage.title,
    updatedAt: new Date(Math.max(...mtimes)).toISOString(),
    ref: '',
    workItem: record.workItem ?? null,
    workspace: null,
    // Kept on the row so a later Check re-evaluates without refetching the definition structure —
    // the same "already fetched, reuse it" convention `loadLocalInstance`'s own
    // `localDefinitionStructure` field follows for the module editor.
    structure,
  }
}

function LocalGroupResolver({ entry, onChange, onRemoved }) {
  const [state, setState] = useState('loading') // 'loading' | 'granted' | 'prompt' | 'denied' | 'missing'
  const [instances, setInstances] = useState([])
  const [busy, setBusy] = useState(false)
  // The last successfully-permissioned handle, kept outside resolve()'s own scope so `checkOne`
  // (called later, from a Check button click — not during a resolve) can re-read this workspace's
  // files without re-running the permission flow every time.
  const handleRef = useRef(null)

  // Mirrors the old LocalWorkspaceRow's own resolve() exactly: same states,
  // same recovery rules — only the destination (onChange, not this
  // component's own render) changed.
  async function resolve() {
    setState('loading')
    let handle
    try {
      handle = await getWorkspaceHandle(entry.id)
    } catch {
      setState('missing')
      return
    }
    if (!handle) {
      setState('missing')
      return
    }
    let permission
    try {
      permission = await ensurePermission(handle)
    } catch {
      setState('missing')
      return
    }
    if (permission === 'prompt') {
      setState('prompt')
      return
    }
    if (permission !== 'granted') {
      setState('denied')
      return
    }
    handleRef.current = handle
    try {
      const subdirs = await listDir(handle, 'gantry-workspace')
      const structureCache = new Map()
      const found = []
      for (const child of subdirs) {
        if (child.kind !== 'directory') continue
        try {
          found.push(await buildLocalInstanceRow(handle, child.name, structureCache))
        } catch {
          // A subdirectory with no instance.yaml, or whose definition/stage can't be resolved, is not a usable instance row — skip it.
        }
      }
      setInstances(found)
      setState('granted')
    } catch {
      // The folder was picked before but its gantry-workspace/ is gone now.
      setState('missing')
    }
  }

  // The dashboard card's Check action for a local-workspace instance (WI #357) — strict gate
  // evaluation via `checkLocalGate`, same pass/fail wording `runCheck`'s server-hosted counterpart
  // uses (`formatGateFailure` — identical result shape, `{ modules, artefacts, complete }`, from
  // either engine). `inst.structure` is the definition projection already fetched for this row, so
  // this never re-fetches it.
  async function checkOne(inst) {
    const handle = handleRef.current
    if (!handle) return 'Check failed: local workspace folder is not open.'
    try {
      const result = await checkLocalGate(handle, inst.slug, inst.structure, inst.stage)
      return result.pass ? 'PASS — gate requirements met.' : formatGateFailure(result)
    } catch (err) {
      return `Check failed: ${err.message}`
    }
  }

  useEffect(() => {
    resolve()
    // eslint-disable-next-line
  }, [entry.id])

  // The "Reconnect" affordance (WI #306 — renamed from the recovery state's
  // prior "Click to open"/"Reopen" wording, which read as a first-time grant
  // rather than the repeat confirmation it actually is): re-runs the same
  // user-gesture-backed permission prompt `ensurePermission` needs to
  // (re-)grant a handle restored from IndexedDB, then re-resolves.
  async function reconnect() {
    setBusy(true)
    try {
      const h = await getWorkspaceHandle(entry.id)
      if (!h) {
        setState('missing')
        return
      }
      await ensurePermission(h)
      await resolve()
    } catch {
      setState('missing')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await forgetWorkspace(entry.id)
      onRemoved(entry.id)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    onChange(entry.id, {
      // Distinct prefix from groupInstancesByWorkspace's own `local:<slug>`
      // key (the unrelated legacy server-side "local instance" concept,
      // ADR-0029/#306 item 4) — these two group shapes are concatenated
      // into one array below, so their keys must never collide.
      key: `local-workspace:${entry.id}`,
      kind: 'local',
      title: entry.name,
      subtitle: 'Local workspace',
      entry,
      state,
      instances,
      busy,
      reconnect,
      remove,
      checkOne,
    })
    // eslint-disable-next-line
  }, [state, instances, busy])

  return null
}

// Owns the list of remembered local workspaces plus every entry's resolved
// group data, keyed by IndexedDB id. `groups` is built by mapping over
// `entries` (already sorted most-recently-opened-first by
// `recentLocalWorkspaces()`) rather than iterating `dataByKey` directly, so
// local groups keep a stable, recency-based relative order as each one pops
// in — never reordering once two have both resolved.
function useLocalGroups() {
  const [entries, setEntries] = useState(null)
  const [dataByKey, setDataByKey] = useState({})

  useEffect(() => {
    let alive = true
    recentLocalWorkspaces()
      .then((list) => {
        if (alive) setEntries(list)
      })
      .catch(() => {
        if (alive) setEntries([])
      })
    return () => {
      alive = false
    }
  }, [])

  function handleChange(id, data) {
    setDataByKey((prev) => ({ ...prev, [id]: data }))
  }

  function handleRemoved(id) {
    setEntries((prev) => (prev ?? []).filter((e) => e.id !== id))
    setDataByKey((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const groups = (entries ?? []).map((entry) => dataByKey[entry.id]).filter(Boolean)

  return { entries: entries ?? [], groups, handleChange, handleRemoved }
}

function localInstanceHref(workspaceId, slug) {
  return `/instance/${encodeURIComponent(slug)}?local=${encodeURIComponent(workspaceId)}`
}

// ---------- Master-detail view ----------
// The Workspaces landing page's default view (#102, superseding #77's flat per-instance listing): the list pane shows one row per workspace (groupInstancesByWorkspace above); selecting one shows every instance it holds in the detail pane, each its own card with definition/assignee/status, Check, Edit, and conditional management links. Assignee is displayed here but edited only from Instance Settings. WI #306 blends remembered local workspaces (useLocalGroups above) into this same list, sorted ahead of every server-hosted group — not a separate section — since their own folder reads resolve on their own schedule.
// `localGroups` is owned by DashboardPage (useLocalGroups, above) rather than
// fetched again in here — DashboardPage also needs to know how many local
// workspaces exist (and as they resolve) to decide whether to show the empty
// state or this view at all, before MasterDetailView itself ever mounts (a
// dashboard with zero server-hosted instances but one remembered local
// workspace must still reach this view, not the empty state) — see
// DashboardPage's own doc comment.
// WI #357: the one instance card every workspace kind renders through — Azure DevOps, server
// (directory-backed, WI #356), and now a browser local workspace's (ADR-0029) too. Previously this
// markup lived only in MasterDetailView's server-hosted branch; a local workspace's instances
// rendered as plain name-only rows instead (no stage, badge, assignee, Edit/Check, Manage) since
// `useLocalGroups`/`LocalGroupResolver` never had that data to show. Now that
// `buildLocalInstanceRow` (above) computes it client-side via `getLocalStatus`, every group's
// instances share this exact same card — the caller decides `editHref` and `onCheck` (a
// numbered-ref/`instanceHref` server edit + `runCheck` for a server-hosted row, a
// `localInstanceHref` + the resolver's own `checkOne` for a local-workspace row), so the card
// itself never needs to branch on kind.
function InstanceCard({ inst, editHref, checkStatus, onCheck }) {
  // Neither Manage link applies to most server/directory-backed or local-workspace instances
  // (Show files is Azure-DevOps-only; Track Work Item needs a linked work item) — an empty
  // "Manage" panel with no links is a useless UI element, so the whole card is hidden rather
  // than shown blank.
  // #136: `workItemParentRef` so a GitHub-linked instance isn't gated out of its own Manage links.
  const hasManageLinks = workItemParentRef(inst.workItem) != null || inst.workspace?.kind === 'azureDevOps'
  return html`
    <div class="instance-card" key=${inst.slug}>
      <div class="instance-card-content">
        <div class="instance-card-header">
          <!-- #145: the instance's display name, falling back to its slug exactly as before when it has no display name set. -->
          <span class="name">${inst.name || inst.slug}</span>
          <span class="ref" title="Numeric reference (WI200)">${inst.ref}</span>
          <span class="def">${inst.definition}</span>
          <span class="instance-card-status">
            <${StatusStamp} status=${inst.status} />
            ${pullRequestBadge(inst)}
          </span>
        </div>
        <div class="instance-card-context">
          <span class="stage-position">Stage ${inst.stageNumber} of ${inst.stageCount}: ${inst.stageTitle}</span>
          <${UpdatedAt} value=${inst.updatedAt} />
        </div>
        <div class="instance-card-row">
          <span class="field-label">Assignee</span>
          <span class="assignee">${inst.assignee || 'Unassigned'}</span>
        </div>
        <div class="detail-actions">
          <a class="btn primary" href=${editHref}>Edit</a>
          <button type="button" class="btn" onClick=${onCheck}>Check</button>
        </div>
        ${checkStatus ? html`<div class="save-status">${checkStatus}</div>` : null}
      </div>
      ${advancedMode.value && hasManageLinks
        ? html`<div class="manage-card">
        <h3>Manage</h3>
        ${workItemParentRef(inst.workItem) != null
          ? html`
              <a
                class="manage-link"
                href=${workItemWebUrlFor(inst.workItem, workItemParentRef(inst.workItem))}
                target="_blank"
                rel="noreferrer"
              >
                Track Work Item
              </a>
            `
          : null}
        ${inst.workspace?.kind === 'azureDevOps'
          ? html`
              <a
                class="manage-link"
                href=${instanceFilesUrl(inst.workspace, inst.slug)}
                target="_blank"
                rel="noreferrer"
              >
                Show files
              </a>
            `
          : null}
      </div>`
        : null}
    </div>
  `
}

function MasterDetailView({ instances, localGroups, workspaceGroups = [] }) {
  const [filter, setFilter] = useState('')
  const [selectedKey, setSelectedKey] = useState(null)
  // Keyed by instance slug (not the single shared string the old flat list used) — several instances can be in flight for the *same* selected workspace at once (one Check or one Render), and each must report its own status independently.
  const [actionStatus, setActionStatus] = useState({})

  // Local groups lead the list (WI #306's resolved design: position, not a
  // badge, is what marks them as local) — never interleaved alphabetically
  // with the server-hosted groups that follow. #122: a registered-but-unrepresented workspace's
  // placeholder group (web/lib/dashboardWorkspaces.js) sorts in among the populated server-hosted
  // groups by the same title rule, rather than trailing them all in registration order — a workspace
  // with no readable rows is still a workspace, not a lesser citizen of this list.
  const groups = [
    ...localGroups,
    ...[...groupInstancesByWorkspace(instances), ...workspaceGroups].sort((a, b) => a.title.localeCompare(b.title)),
  ]

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? groups.filter(
        (group) =>
          group.title.toLowerCase().includes(needle) ||
          group.subtitle.toLowerCase().includes(needle) ||
          group.instances.some(
            (inst) => inst.slug.toLowerCase().includes(needle) || (inst.assignee ?? '').toLowerCase().includes(needle)
          )
      )
    : groups

  const effectiveKey = filtered.some((group) => group.key === selectedKey) ? selectedKey : (filtered[0]?.key ?? null)
  const selectedGroup = groups.find((group) => group.key === effectiveKey) ?? null

  // Reset instance-scoped action state whenever the selected workspace changes — never while it's still the same workspace, which would clobber an in-progress Check/Render status on every unrelated `instances` refresh.
  useEffect(() => {
    setActionStatus({})
    // eslint-disable-next-line
  }, [effectiveKey])

  async function handleCheck(slug) {
    setActionStatus((prev) => ({ ...prev, [slug]: 'Checking…' }))
    const result = await runCheck(slug)
    setActionStatus((prev) => ({ ...prev, [slug]: result }))
  }

  // The local-workspace counterpart of handleCheck (WI #357) — routes through the selected
  // group's own `checkOne` (LocalGroupResolver, above) instead of the server-hosted `/api/instance/check`
  // route `runCheck` calls, since a local workspace's instance data never leaves the browser.
  async function handleLocalCheck(inst) {
    setActionStatus((prev) => ({ ...prev, [inst.slug]: 'Checking…' }))
    const result = await selectedGroup.checkOne(inst)
    setActionStatus((prev) => ({ ...prev, [inst.slug]: result }))
  }

  return html`
    <div class="master-detail">
      <div class="list-pane">
        <input
          class="field search"
          type="text"
          placeholder="Filter by workspace, instance, assignee…"
          value=${filter}
          onInput=${(e) => setFilter(e.currentTarget.value)}
        />
        <div class="instance-list">
          ${filtered.map(
            (group) => html`
              <div
                key=${group.key}
                class=${'list-item' + (group.key === effectiveKey ? ' selected' : '')}
                role="button"
                tabindex="0"
                onClick=${() => setSelectedKey(group.key)}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedKey(group.key)
                }}
              >
                <span class=${'dot ' + groupStatusClass(group)}></span>
                <span class="meta">
                  <span class="name">${group.title}</span>
                  <span class="def">${groupSummaryText(group)}</span>
                </span>
              </div>
            `
          )}
          ${filtered.length === 0 ? html`<p class="loading">No workspaces match "${filter}".</p>` : null}
        </div>
      </div>
      <div class="detail-pane">
        ${!selectedGroup
          ? html`<div class="placeholder">Select a workspace to see its instances.</div>`
          : selectedGroup.kind === 'local'
            ? html`
                <${WorkspaceDetailHead} group=${selectedGroup} />
                ${selectedGroup.state === 'loading' ? html`<p class="loading">Opening…</p>` : null}
                ${selectedGroup.state === 'prompt'
                  ? html`
                      <div class="local-workspace-recovery">
                        <p>This local workspace needs permission again in this browser.</p>
                        <div class="detail-actions">
                          <button type="button" class="btn primary" disabled=${selectedGroup.busy} onClick=${selectedGroup.reconnect}>
                            Reconnect
                          </button>
                        </div>
                      </div>
                    `
                  : null}
                ${selectedGroup.state === 'denied' || selectedGroup.state === 'missing'
                  ? html`
                      <div class="local-workspace-recovery">
                        <p>Can't find this folder — reconnect or remove.</p>
                        <div class="detail-actions">
                          <button type="button" class="btn primary" disabled=${selectedGroup.busy} onClick=${selectedGroup.reconnect}>
                            Reconnect
                          </button>
                          <button type="button" class="btn ghost" disabled=${selectedGroup.busy} onClick=${selectedGroup.remove}>
                            Remove
                          </button>
                        </div>
                      </div>
                    `
                  : null}
                ${selectedGroup.state === 'granted'
                  ? html`
                      <p class="workspace-settings-link">
                        <a href=${`/definitions/local?ws=${encodeURIComponent(selectedGroup.entry.id)}`}>Local definitions →</a>
                      </p>
                      <div class="workspace-instances">
                        ${selectedGroup.instances.length === 0
                          ? html`<p class="loading">No instances in this workspace yet.</p>`
                          : selectedGroup.instances.map(
                              (inst) => html`
                                <${InstanceCard}
                                  inst=${inst}
                                  editHref=${localInstanceHref(selectedGroup.entry.id, inst.slug)}
                                  checkStatus=${actionStatus[inst.slug]}
                                  onCheck=${() => handleLocalCheck(inst)}
                                />
                              `
                            )}
                      </div>
                    `
                  : null}
              `
            : selectedGroup.kind === 'placeholder' && selectedGroup.state === 'blank'
              ? html`
                  <${WorkspaceDetailHead} group=${selectedGroup} />
                  <div class="workspace-instances">
                    <p class="loading">No instances in this workspace yet.</p>
                  </div>
                `
            : selectedGroup.kind === 'placeholder'
              ? html`
                  <${WorkspaceDetailHead} group=${selectedGroup} />
                  <div class=${'local-workspace-recovery workspace-placeholder-' + selectedGroup.state}>
                    <p>
                      ${selectedGroup.state === 'unreadable'
                        ? "Can't read this workspace — no credential (yours or the deployment's) could reach it, even though it has instances registered."
                        : 'Nothing has been registered in this workspace yet — it may be genuinely empty, or it may just never have been checked with a credential.'}
                    </p>
                    <div class="detail-actions">
                      <a
                        class="btn primary"
                        href=${`/settings/workspace?id=${encodeURIComponent(selectedGroup.workspaceId)}&from=${encodeURIComponent('/')}`}
                      >
                        Add a credential →
                      </a>
                    </div>
                  </div>
                `
              : html`
              <${WorkspaceDetailHead} group=${selectedGroup} />
              ${(() => {
                // A path to Workspace Settings (where archive / owner / ticketing-system live) from
                // the dashboard — Azure DevOps workspaces only (a server workspace, WI #356, has no
                // such settings screen) — otherwise it's only reachable by first opening one of the
                // workspace's instances. Scoped via any one of its instances, like the SettingsMenu.
                const wsInstance = selectedGroup.instances.find((inst) => inst.workspace?.kind === 'azureDevOps')
                return wsInstance
                  ? html`<p class="workspace-settings-link">
                      <a href=${`/settings/workspace?slug=${encodeURIComponent(wsInstance.slug)}&from=${encodeURIComponent('/')}`}>Workspace settings →</a>
                    </p>`
                  : null
              })()}
              <div class="workspace-instances">
                ${selectedGroup.instances.map(
                  (inst) => html`
                    <${InstanceCard}
                      inst=${inst}
                      editHref=${instanceHref(inst)}
                      checkStatus=${actionStatus[inst.slug]}
                      onCheck=${() => handleCheck(inst.slug)}
                    />
                  `
                )}
              </div>
            `}
      </div>
    </div>
  `
}

// ---------- Stage-swimlane view ----------
// One overflow menu open at a time, closed by clicking anywhere else in the
// lanes (SwimlaneGroup owns that single `openSlug`; the chip's own menu is
// the shared Dropdown, web/lib/dropdown.js, whose outside-click/Escape close
// covers the rest). The chip forwards the Dropdown's *requested* next state
// (`onOpenMenu(slug-or-null)`, an explicit set — not a toggle): a blind
// toggle would race the group's own close-on-click wrapper, re-opening a
// menu an outside click just closed.
function SwimlaneChip({ instance, menuOpen, onOpenMenu, onAction }) {
  return html`
    <${Dropdown}
      className="chip"
      triggerClass="btn small ghost menu-btn"
      triggerLabel="⋯"
      triggerAriaLabel=${`Actions for ${instance.slug}`}
      open=${menuOpen}
      onOpenChange=${(next) => onOpenMenu(next ? instance.slug : null)}
      body=${({ trigger, menu }) => html`
        <div class="name">${instance.slug}</div>
        <div class="def">${instance.definition}</div>
        <div class="chip-foot">
          <span class="assignee">${instance.assignee || 'unassigned'}</span>
          <${StatusStamp} status=${instance.status} />
          ${trigger}
        </div>
        ${menu}
      `}
    >
      <a href=${instanceHref(instance)}>Open</a>
      <button type="button" onClick=${() => onAction(instance.slug, 'check')}>Check</button>
      <button type="button" onClick=${() => onAction(instance.slug, 'render')}>Render</button>
    <//>
  `
}

function SwimlaneGroup({ definitionId, stages, instances, showTitle }) {
  const [openSlug, setOpenSlug] = useState(null)
  const [status, setStatus] = useState('')

  async function handleAction(slug, action) {
    setOpenSlug(null)
    setStatus(action === 'check' ? 'Checking…' : 'Rendering…')
    setStatus(await (action === 'check' ? runCheck(slug) : runRender(slug)))
  }

  return html`
    <div class="swimlane-group" onClick=${() => setOpenSlug(null)}>
      ${showTitle ? html`<h2 class="swimlane-group-title">${definitionId}</h2>` : null}
      <div class="lanes">
        ${stages.map((stage) => {
          const items = instances.filter((inst) => inst.stage === stage.id)
          return html`
            <div class="lane" key=${stage.id}>
              <div class="lane-header">
                <span class="stage-name">${stage.title}</span>
                <span class="count">${items.length}</span>
              </div>
              ${items.length === 0
                ? html`<div class="empty-lane">No instances in ${stage.title}</div>`
                : items.map(
                    (inst) => html`
                      <${SwimlaneChip}
                        key=${inst.slug}
                        instance=${inst}
                        menuOpen=${openSlug === inst.slug}
                        onOpenMenu=${setOpenSlug}
                        onAction=${handleAction}
                      />
                    `
                  )}
            </div>
          `
        })}
      </div>
      <div class="save-status">${status}</div>
    </div>
  `
}

function SwimlaneView({ instances }) {
  const [stagesByDefinition, setStagesByDefinition] = useState({})
  const [stagesError, setStagesError] = useState(null)
  const definitionIds = [...new Set(instances.map((inst) => inst.definition))].sort()

  useEffect(() => {
    definitionIds.forEach((definitionId) => {
      apiFetch(`/api/definitions/${encodeURIComponent(definitionId)}/stages`)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load stages for "${definitionId}" (${res.status})`)
          return res.json()
        })
        .then((stages) => setStagesByDefinition((prev) => ({ ...prev, [definitionId]: stages })))
        .catch((err) => setStagesError(err.message))
    })
    // eslint-disable-next-line
  }, [definitionIds.join(',')])

  if (stagesError) return html`<p class="load-error">Failed to load: ${stagesError}</p>`

  return html`
    <div class="swimlanes">
      ${definitionIds.map((definitionId) => {
        const stages = stagesByDefinition[definitionId]
        if (!stages) return html`<p class="loading" key=${definitionId}>Loading…</p>`
        return html`
          <${SwimlaneGroup}
            key=${definitionId}
            definitionId=${definitionId}
            stages=${stages}
            instances=${instances.filter((inst) => inst.definition === definitionId)}
            showTitle=${definitionIds.length > 1}
          />
        `
      })}
    </div>
  `
}

// ---------- Archived instances (#223) ----------
// A collapsed-by-default list of every archived instance, each with a Restore action, sitting
// under the dashboard's active views. Archiving/restoring happens from Instance Settings; this is
// the "explicit show-archived affordance" the acceptance criteria call for, plus a quick restore.
// Fetches on its own (`?archived=1` — a superset listing carrying an `archived` flag per row) so
// the main dashboard's request and shape are untouched.
function ArchivedInstancesPanel({ onRestored }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})

  function reload() {
    apiFetch('/api/instances?archived=1')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Failed to load (${res.status})`))))
      .then((data) => {
        setRows(data.filter((inst) => inst.archived))
        setError(null)
      })
      .catch((err) => setError(err.message))
  }

  useEffect(reload, [])

  async function restore(slug) {
    setBusy((prev) => ({ ...prev, [slug]: true }))
    try {
      const res = await apiFetchForInstance(slug, '/api/instance/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message ?? body.error ?? `Restore failed (${res.status})`)
      }
      reload()
      onRestored?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy((prev) => ({ ...prev, [slug]: false }))
    }
  }

  if (error) return html`<p class="load-error">Archived instances: ${error}</p>`
  if (!rows || rows.length === 0) return null

  return html`
    <details class="archived-panel">
      <summary>Archived instances (${rows.length})</summary>
      <div class="archived-list">
        ${rows.map(
          (inst) => html`
            <div class="archived-row" key=${inst.slug}>
              <span class="name">${inst.slug}</span>
              <span class="def">${inst.definition}</span>
              ${inst.workspace ? html`<span class="def">${workspaceLabel(inst.workspace)}</span>` : null}
              <button
                type="button"
                class="btn small"
                disabled=${busy[inst.slug]}
                onClick=${() => restore(inst.slug)}
              >
                Restore
              </button>
            </div>
          `
        )}
      </div>
    </details>
  `
}

// ---------- Archived workspaces (#223) ----------
// The workspace-level counterpart to ArchivedInstancesPanel above: archived workspaces never appear
// in the dashboard's workspace grouping (it's built from the active-instance listing), so without
// this there is no way to see or restore one from the dashboard. Restore is a plain
// registry-metadata write — no PAT, no Azure DevOps call.
function ArchivedWorkspacesPanel({ onRestored }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})

  function reload() {
    apiFetch('/api/workspaces?archived=1')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Failed to load (${res.status})`))))
      .then((data) => {
        setRows(data.filter((ws) => ws.archived))
        setError(null)
      })
      .catch((err) => setError(err.message))
  }

  useEffect(reload, [])

  async function restore(id) {
    setBusy((prev) => ({ ...prev, [id]: true }))
    try {
      const res = await apiFetch('/api/workspace/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: id }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message ?? body.error ?? `Restore failed (${res.status})`)
      }
      reload()
      onRestored?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy((prev) => ({ ...prev, [id]: false }))
    }
  }

  if (error) return html`<p class="load-error">Archived workspaces: ${error}</p>`
  if (!rows || rows.length === 0) return null

  return html`
    <details class="archived-panel">
      <summary>Archived workspaces (${rows.length})</summary>
      <div class="archived-list">
        ${rows.map(
          (ws) => html`
            <div class="archived-row" key=${ws.id}>
              <span class="name">${ws.location.repository}</span>
              <span class="def">${ws.location.organization}/${ws.location.project}</span>
              <button type="button" class="btn small" disabled=${busy[ws.id]} onClick=${() => restore(ws.id)}>
                Restore
              </button>
            </div>
          `
        )}
      </div>
    </details>
  `
}

// ---------- Dashboard page ----------
// WI #306: `useLocalGroups` (and mounting its `LocalGroupResolver`s) lives up
// here, not inside MasterDetailView, so this page knows how many local
// workspaces are remembered — and can react as each one's folder read pops
// in — independently of which server-hosted view is (or isn't) mounted. A
// dashboard with zero server-hosted instances but one remembered local
// workspace must still reach MasterDetailView rather than the empty state,
// which requires that count to be available before MasterDetailView itself
// ever renders.
function DashboardPage() {
  const [instances, setInstances] = useState(null)
  const [workspaces, setWorkspaces] = useState(null)
  // #131: rows from the per-workspace credentialed listings, kept separate from `instances` (the
  // unscoped listing) so a reload of one never discards the other.
  const [workspaceScopedInstances, setWorkspaceScopedInstances] = useState([])
  const [error, setError] = useState(null)
  const { entries: localEntries, groups: localGroups, handleChange: onLocalChange, handleRemoved: onLocalRemoved } = useLocalGroups()
  const localCount = localEntries.length

  // #122 (parent #109, docs/adr/0047): `instances` and `workspaces` load together, from the same
  // reload trigger — a registered-but-unrepresented workspace row (see `workspaceGroups` below) has to
  // stay in sync with the instances listing it's a complement of, not lag a click behind it.
  //
  // #131: `loadInstances()` is the *unscoped* listing, which carries no credential for any workspace
  // (there is no global default to attach — docs/adr/0038) and so can show nothing for a
  // Provider-backed workspace unless the deployment holds a shared credential for it (#121).
  // `loadWorkspaceScopedInstances` fills exactly that hole, and only that hole: one credentialed,
  // workspace-scoped listing per workspace the browser holds a credential for and this listing showed
  // nothing for, merged in below. It issues no request at all when nothing qualifies, and at most one
  // per qualifying workspace per page-session — see web/lib/workspaceDiscovery.js for those bounds.
  function reloadInstances() {
    Promise.all([loadInstances(), loadWorkspaces()])
      .then(([instancesData, workspacesData]) => {
        setInstances(instancesData)
        setWorkspaces(workspacesData)
        setError(null)
        return loadWorkspaceScopedInstances(instancesData, workspacesData)
      })
      .then((scopedRows) => setWorkspaceScopedInstances(scopedRows))
      // Only the unscoped listing above can land here: `loadWorkspaceScopedInstances` never rejects —
      // a workspace whose own listing fails simply contributes no rows and keeps the placeholder row
      // #122 gives it, rather than failing a dashboard that has already rendered.
      .catch((err) => setError(err.message))
  }

  useEffect(reloadInstances, [])

  // #137: a workspace whose scoped listing couldn't be answered — the server still coming up after a
  // redeploy being the case that forced this — asks to be tried again shortly. Re-running the same
  // load the mount-time effect runs is all that's needed; web/lib/workspaceDiscovery.js owns the
  // bounds (a handful of attempts per workspace, backed off, and only for failures that say nothing
  // about whether the workspace has designs). Before this, one unlucky mount-time request left the
  // workspace blank until a full reload — or until a perfectly good credential was re-entered, which
  // is the only other thing that cleared the latch and so looked like the credential's fault.
  useEffect(() => {
    setWorkspaceDiscoveryRetryHandler(() => reloadInstances())
    return () => setWorkspaceDiscoveryRetryHandler(null)
  }, [])

  // #131: the two listings joined — the unscoped one plus each credentialed, workspace-scoped one.
  // They can never overlap by construction (a scoped listing is only ever fetched for a workspace the
  // unscoped one contributed no row for), so this is a plain concatenation rather than a merge with
  // its own identity rule to keep correct.
  const allInstances = instances ? [...instances, ...workspaceScopedInstances] : instances

  // #301: with advanced mode off the dashboard listing shows only local
  // instances — Azure-DevOps-backed rows are hidden until it's turned on.
  // Filtering here (rather than inside each view) covers both the
  // master-detail and swimlane views from one place, and leaves the
  // untouched `instances` for the archived panels below.
  const visibleInstances =
    allInstances && !advancedMode.value ? allInstances.filter((inst) => !isAzureDevOpsBacked(inst)) : allInstances

  // #122: every registered workspace contributing zero rows to `instances` gets a placeholder group
  // of its own (web/lib/dashboardWorkspaces.js) — computed from the *raw*, unfiltered `instances`,
  // never `visibleInstances`, so an Azure-DevOps-backed workspace #301 is hiding populated rows for
  // isn't miscounted as "unrepresented" merely because its own rows were filtered out above; its
  // placeholder is filtered by the exact same #301 rule instead, right below.
  //
  // #131: computed from `allInstances`, so a workspace whose own credentialed listing just supplied
  // its rows stops being "unrepresented" and loses its placeholder — which is the whole point of
  // fetching them.
  const workspaceGroups =
    allInstances && workspaces
      ? unrepresentedWorkspaceGroups(allInstances, workspaces).filter((group) => advancedMode.value || !group.isAzureDevOps)
      : []

  return html`
    <main class="dashboard">
      ${localEntries.map(
        (entry) => html`
          <${LocalGroupResolver} key=${entry.id} entry=${entry} onChange=${onLocalChange} onRemoved=${onLocalRemoved} />
        `
      )}
      <div class="dashboard-topbar">
        <div class="dashboard-heading">
          <${GantryBrandIcon} />
          <h1>Workspaces</h1>
        </div>
        <div class="dashboard-controls">
          ${visibleInstances?.length ? html`<${ViewToggle} />` : null}
          <a class="btn small ghost" href="/new-workspace">+ New Workspace</a>
          <a class="btn small ghost" href="/definitions">Definitions</a>
          <a class="btn small ghost" href="/user-guide">User Guide</a>
          <a class="btn small ghost" href=${`/settings?from=${encodeURIComponent('/')}`}>Settings</a>
        </div>
      </div>
      ${error
        ? html`<p class="load-error">Failed to load: ${error}</p>`
        : !instances || !workspaces
          ? html`<p class="loading">Loading…</p>`
          : // #122: an entirely empty deployment (no instances, no local workspaces, and no
            // registered workspace left unrepresented either) still reaches EmptyState — a
            // registered-but-empty-or-unreadable workspace counting toward "there's something to
            // show" is exactly what keeps this from regressing to a blank screen once #122 makes such
            // a workspace visible at all.
            visibleInstances.length === 0 && localCount === 0 && workspaceGroups.length === 0
            ? html`<${EmptyState} />`
            : // WI #306: remembered local workspaces are blended into
              // MasterDetailView's own list now (no separate section) — swimlane
              // view still groups only server-hosted instances by definition/stage
              // (groupInstancesByWorkspace never drove that view), so it's only
              // chosen once there's at least one server-hosted instance to show;
              // master-detail is what renders local-only (and #122's placeholder-only) dashboards.
              dashboardViewMode.value === 'swimlanes' && visibleInstances.length > 0
              ? html`<${SwimlaneView} instances=${visibleInstances} />`
              : html`<${MasterDetailView} instances=${visibleInstances} localGroups=${localGroups} workspaceGroups=${workspaceGroups} />`}
      ${instances ? html`<${ArchivedInstancesPanel} onRestored=${reloadInstances} />` : null}
      ${instances ? html`<${ArchivedWorkspacesPanel} onRestored=${reloadInstances} />` : null}
    </main>
  `
}

// ---------- Provider PAT prompt (#87, #9) ----------
// Rendered globally (see App() below) rather than scoped to any one screen — `apiFetch` (web/lib/apiFetch.js) opens it (via `requestPat()`) the moment *any* request against gantry's own API comes back with the structured "authentication required" response, regardless of which route triggered it. Local instances never produce that response, so this never opens for them — nothing here checks "is this instance local" itself.
//
// #9 (ADR-0038): every prompt now targets one specific, already-registered workspace — there is no
// global default any more, so this never fires for the "+ New Workspace" wizard's own registration
// step (that flow has its own PAT field; see web/pages/new-workspace-wizard.js). Deliberately
// provider-neutral copy: the server's own `sendAuthenticationRequired` message (docs/adr/0039) names
// the Provider for a rejected credential (`context.message` below), but a plain missing-credential
// prompt has no structured provider tag to read, so this doesn't guess at one.
function PatPromptModal() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const context = promptContext.value
  const rejected = context?.credentialStatus === 'rejected'

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') resolvePromptWith(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function handleSubmit() {
    if (!value.trim()) {
      setError('Paste a Personal Access Token to continue.')
      return
    }
    resolvePromptWith(value.trim())
  }

  return html`
    <div class="modal-backdrop" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Sign-in required">
        <h3>${rejected ? 'Personal Access Token rejected' : 'Sign-in required'}</h3>
        <p class="guidance">
          ${rejected ? context.message : "This workspace's data lives with an external Provider. Paste this workspace's own Personal Access Token (PAT) to continue."}
          It's stored only in this browser, scoped to this one workspace, and sent solely to your own gantry server.
        </p>
        <input
          class=${'text-field' + (error ? ' has-error' : '')}
          type="password"
          autocomplete="off"
          placeholder="Paste this workspace's Personal Access Token"
          value=${value}
          onInput=${(e) => {
            setValue(e.currentTarget.value)
            if (error) setError('')
          }}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        ${error ? html`<div class="inline-error">${error}</div>` : null}
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick=${() => resolvePromptWith(null)}>Cancel</button>
          <button type="button" class="btn primary" onClick=${handleSubmit}>Continue</button>
        </div>
      </div>
    </div>
  `
}

// ---------- App shell: preact-iso routing ----------
// Nine routes: the dashboard (#77, default/landing), the module editor per instance, the "+ New Workspace" wizard (#110/#126, replacing the old #78 instance-setup wizard), the asset library (#80), the User Guide (#193), and three tab-free Settings screens (#107, superseding #101/#104's single tabbed `/settings`) — Global Settings, Workspace Settings (scoped to one instance's own workspace), and Instance Settings (assignee, read-only instance info, read-only work-item link details). `instanceData`/`loadError` above are populated regardless of which route is active (the `effect()` isn't scoped to a component), so the library screen never has to re-fetch instance data just to know which instance it's browsing.
function App() {
  return html`
    <${LocationProvider}>
      <${Router}>
        <${Route} path="/instance/:slug" component=${ModuleEditorPage} />
        <${Route} path="/new-workspace" component=${NewWorkspaceWizardPage} />
        <${Route} path="/new-instance" component=${NewWorkspaceWizardPage} />
        <${Route} path="/assets" component=${AssetLibraryPage} />
        <${Route} path="/user-guide" component=${UserGuidePage} />
        <${Route} path="/definitions" component=${DefinitionViewerPage} />
        <${Route} path="/definitions/local" component=${LocalDefinitionEditorPage} />
        <${Route} path="/settings" component=${GlobalSettingsPage} />
        <${Route} path="/settings/workspace" component=${WorkspaceSettingsPage} />
        <${Route} path="/settings/instance" component=${InstanceSettingsPage} />
        <${Route} default component=${DashboardPage} />
      <//>
    <//>
    ${promptOpen.value ? html`<${PatPromptModal} />` : null}
  `
}

// WI314 — warm-load pandoc-wasm as soon as gantry opens (not gated behind opening Preview or
// clicking Render): fire-and-forget, never awaited here, so a slow/failed load never delays
// this module's own first paint below. web/lib/pandocWasm.js's own `pandocWasmState` signal
// (read by Global Settings and the Render action) is how the rest of the app observes how
// this turns out.
warmLoadPandocWasm().catch(() => {})

// #9 (ADR-0038): the one-shot fan-out of a previously-stored global-default PAT into every
// currently-registered workspace's own slot, then deletion of the legacy global key. `GET
// /api/workspaces` needs no credential itself (lib/server.js's own doc comment on that route), so
// this never itself triggers a PAT prompt. A user with nothing stored under the legacy key
// (everyone who's already migrated, or never had a global PAT at all) pays for one harmless,
// uncredentialed fetch.
//
// Awaited (top-level await — this module is loaded as `type="module"`, web/index.html) before the
// app renders at all, deliberately not fire-and-forget: the very first render can immediately issue
// a Provider-backed request for an already-registered workspace (e.g. the module editor's own
// instance-loading effect), and that request's `patForWorkspace` lookup is a synchronous read of
// already-resolved state — there is no later point for a race with this fetch to resolve at. A
// failure here (offline, a slow/broken server) falls through to rendering anyway rather than hanging
// the whole app on one best-effort migration step.
try {
  const workspacesRes = await fetch('/api/workspaces')
  const workspaces = workspacesRes.ok ? await workspacesRes.json() : []
  migrateGlobalPatToWorkspaces((workspaces ?? []).map((w) => w.id))
} catch {
  // Best-effort — see this block's own comment above.
}

render(html`<${App} />`, document.getElementById('app'))
