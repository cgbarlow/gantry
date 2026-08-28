import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { listInstanceSlugs } from './instance.js'
import { getOrCreateWorkspace, resolveWorkspace } from './workspaceRegistry.js'

/**
 * The instance *registry* — not to be confused with `lib/registry.js`'s `listRegistry` (the dashboard-facing "every instance enriched with definition/stage/status/assignee" listing). This module answers a narrower, lower-level question: "where does this slug's data live" — locally on disk, or in a specific Azure DevOps organization/project/repository — not anything about that instance's content. `listRegistry` is a *consumer* of this module, not a synonym for it.
 *
 * Per docs describing #88/#89: this registry is the *sole* source of truth gantry consults to route a request for a given slug. A local instance's own `instance.yaml` never needs to say so (there is nothing to write — absence from an `azureDevOps` entry just means local); an Azure-DevOps-backed instance's `instance.yaml` does carry its own descriptive `azureDevOps` field (written by `createInstance`, #85), but that field is purely descriptive and is never read back by this module — there is no reconciliation between the two.
 *
 * The registry file lives inside `instancesDir` (one level down from what `docs/adr/0008` describes as "sibling to instancesDir/definitionsDir" — colocating it with the directory it indexes instead keeps every test's already-unique scratch `instancesDir` naturally isolated, with no risk of two unrelated test runs sharing one registry file the way a location derived from instancesDir's *parent* directory would for `os.tmpdir()`-based scratch dirs). It is application state, not source data — never committed to git (see .gitignore).
 *
 * Since #96: an Azure-DevOps-backed entry no longer duplicates its own organization/project/repository — it references a workspace id (`lib/workspaceRegistry.js`) instead. That's purely a *storage-shape* change, not a contract change for this module's own callers: `resolveInstanceLocation`/`listRegisteredInstances` still hand back the familiar `{ kind: 'azureDevOps', organization, project, repository, baseUrl? }` shape (denormalized from the referenced workspace on read), and `registerInstance` still accepts that same shape (looking up — or auto-creating — the matching workspace under the hood) alongside the new, more direct `{ kind: 'azureDevOps', workspaceId }` shape. A registry file written before #96 (raw entries still carrying organization/project/repository directly, with no `workspaceId`) is migrated in place the first time it's read — see `migrateLegacyAzureDevOpsEntries` — so an existing deployment's already-registered instances keep resolving correctly with no manual step, backed by one auto-created workspace per distinct organization/project/repository(/baseUrl) tuple found.
 */

const REGISTRY_FILENAME = 'instance-registry.json'

function registryPathFor(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  return options.registryPath ?? join(instancesDir, REGISTRY_FILENAME)
}

// Reads the raw slug -> location map off disk, tolerating a registry file that doesn't exist yet (a brand new instancesDir, or the very first call against this repo) — that's not an error, just an empty registry.
function readRegistryFile(registryPath) {
  if (!storage.exists(registryPath)) return {}
  const text = storage.readText(registryPath)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function writeRegistryFile(registryPath, entries) {
  storage.writeText(registryPath, JSON.stringify(entries, null, 2) + '\n')
}

function assertValidLocation(location) {
  if (!location || typeof location !== 'object') {
    throw new Error('A registry location must be an object')
  }
  if (location.kind === 'local') {
    return
  }
  if (location.kind === 'azureDevOps') {
    // Either shape is accepted here — see normalizeAzureDevOpsLocation, which does the actual field-by-field validation appropriate to whichever one was given (a `workspaceId` that must resolve, or an organization/project/repository trio that doesn't yet).
    return
  }
  throw new Error(`Unknown registry location kind "${location?.kind}" — expected "local" or "azureDevOps"`)
}

// Normalizes any caller-supplied Azure DevOps location into the one shape this registry actually persists: `{ kind: 'azureDevOps', workspaceId }`. Accepts either an already-resolved `{ workspaceId }` (validated to reference a real, registered workspace — never persisted unchecked) or the legacy/convenience `{ organization, project, repository, baseUrl? }` shape (looked up — or, if this is the first instance ever registered against that repo, created — via `getOrCreateWorkspace`, so registering several instances against the same repo shares one workspace rather than fragmenting it across several).
function normalizeAzureDevOpsLocation(location, options) {
  if (location.workspaceId !== undefined) {
    if (!resolveWorkspace(location.workspaceId, options)) {
      throw new Error(`Unknown workspace "${location.workspaceId}"`)
    }
    return { kind: 'azureDevOps', workspaceId: location.workspaceId }
  }

  const missing = ['organization', 'project', 'repository'].filter((key) => !location[key])
  if (missing.length) {
    throw new Error(`An "azureDevOps" registry location is missing: ${missing.join(', ')}`)
  }

  const workspace = getOrCreateWorkspace(
    { organization: location.organization, project: location.project, repository: location.repository, baseUrl: location.baseUrl },
    options
  )
  return { kind: 'azureDevOps', workspaceId: workspace.id }
}

// The read-side inverse of normalizeAzureDevOpsLocation: expands a persisted `{ kind: 'azureDevOps', workspaceId }` entry back out to the `{ kind: 'azureDevOps', organization, project, repository, baseUrl? }` shape every existing caller (server.js's resolveAzureDevOpsLocation, lib/registry.js's buildAzureDevOpsRow, every pre-#96 test) already expects — the workspace reference is this module's own storage detail, not something every consumer needs to learn to dereference itself.
function denormalizeEntry(entry, options) {
  if (entry?.kind !== 'azureDevOps') return entry
  const workspace = resolveWorkspace(entry.workspaceId, options)
  if (!workspace) {
    throw new Error(`Registry entry references unknown workspace "${entry.workspaceId}"`)
  }
  return {
    kind: 'azureDevOps',
    organization: workspace.organization,
    project: workspace.project,
    repository: workspace.repository,
    ...(workspace.baseUrl ? { baseUrl: workspace.baseUrl } : {}),
  }
}

// Migrates any raw entry still in the pre-#96 shape (an `azureDevOps` kind carrying `organization`/`project`/`repository` directly, no `workspaceId` yet) to the current `{ kind: 'azureDevOps', workspaceId }` shape — auto-creating (or reusing, for a second such entry pointing at the same repo) the workspace that backs it via `getOrCreateWorkspace`. Returns whether anything changed, so `loadWithBackfill` only re-persists the file when a migration actually happened.
function migrateLegacyAzureDevOpsEntries(entries, options) {
  let changed = false
  for (const slug of Object.keys(entries)) {
    const entry = entries[slug]
    if (entry?.kind === 'azureDevOps' && entry.workspaceId === undefined && entry.organization) {
      const workspace = getOrCreateWorkspace(
        { organization: entry.organization, project: entry.project, repository: entry.repository, baseUrl: entry.baseUrl },
        options
      )
      entries[slug] = { kind: 'azureDevOps', workspaceId: workspace.id }
      changed = true
    }
  }
  return changed
}

// Any instance.yaml found on disk via directory-scan with no existing registry entry gets one auto-added here — so every pre-existing local instance (the examples/demo-cli/demo-web fixtures, anything made via `gantry new`, any test's temp instance) keeps working with zero migration step, exactly as #89's spec requires. Runs on every read (resolve/list), not just once, since a local instance can be created by any of several code paths (`createInstance`, a test writing instance.yaml directly, etc.) that don't necessarily go through `registerInstance` themselves.
//
// Also runs the pre-#96-shape migration above, for the same "every read, not just once" reason — a registry file from before workspaces existed must keep working with zero manual step, exactly as the local-instance backfill already does.
function loadWithBackfill(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  const registryPath = registryPathFor(options)
  const entries = readRegistryFile(registryPath)

  let changed = false
  for (const slug of listInstanceSlugs(instancesDir)) {
    if (!(slug in entries)) {
      entries[slug] = { kind: 'local' }
      changed = true
    }
  }

  if (migrateLegacyAzureDevOpsEntries(entries, options)) {
    changed = true
  }

  if (changed) {
    writeRegistryFile(registryPath, entries)
  }

  return { entries, registryPath }
}

/**
 * Resolves a slug's location: `{ kind: 'local' }` or `{ kind: 'azureDevOps', organization, project, repository, baseUrl? }`. `undefined` if the slug is neither already registered nor found on disk (an unknown instance).
 */
export function resolveInstanceLocation(slug, options = {}) {
  const { entries } = loadWithBackfill(options)
  if (!(slug in entries)) return undefined
  return denormalizeEntry(entries[slug], options)
}

/**
 * Registers (or overwrites) `slug`'s location. `location` must be `{ kind: 'local' }`, `{ kind: 'azureDevOps', organization, project, repository, baseUrl? }`, or `{ kind: 'azureDevOps', workspaceId }` — anything else throws rather than silently persisting a location no other part of the registry knows how to interpret. An `organization`/`project`/`repository` location is resolved to (or, the first time this exact repo is registered, creates) a workspace via `lib/workspaceRegistry.js` before being persisted — this registry only ever stores a workspace reference, never a duplicated organization/project/repository.
 */
export function registerInstance(slug, location, options = {}) {
  assertValidLocation(location)
  // Runs the same backfill a plain resolve/list would — registering one new instance shouldn't skip auto-backfilling every other instance already sitting on disk with no entry of its own yet.
  const { entries, registryPath } = loadWithBackfill(options)
  entries[slug] = location.kind === 'azureDevOps' ? normalizeAzureDevOpsLocation(location, options) : location
  writeRegistryFile(registryPath, entries)
}

/**
 * Every known entry, sorted by slug: `[{ slug, location }, ...]`. Includes both registered-directly entries and anything auto-backfilled from disk.
 */
export function listRegisteredInstances(options = {}) {
  const { entries } = loadWithBackfill(options)
  return Object.keys(entries)
    .sort()
    .map((slug) => ({ slug, location: denormalizeEntry(entries[slug], options) }))
}

/**
 * Every known slug in the registry file's own raw key order — never sorted, unlike `listRegisteredInstances` above (whose alphabetical-by-slug order every existing caller already depends on and must not change). A plain JS object (and the JSON `.stringify`/`.parse` round-trip backing this file) preserves non-numeric-string key insertion order, so a slug registered earlier still appears earlier here — this is what `lib/numberRegistry.js`'s one-time backfill (WI200, docs/adr/0024) uses as its best-effort creation-order proxy for an Azure-DevOps-backed instance-registry entry, which carries no timestamp of its own (a local instance's own directory timestamp is used instead — see that module).
 */
export function listRegisteredSlugsInStorageOrder(options = {}) {
  const { entries } = loadWithBackfill(options)
  return Object.keys(entries)
}

/**
 * The raw workspace id a slug's Azure-DevOps-backed entry references, or `null` for a local slug (or one the registry has never seen at all). Deliberately a separate, additive function rather than a new field on `resolveInstanceLocation`'s own return value (#104) — that function's `{ kind, organization, project, repository, baseUrl? }` shape is already relied on verbatim by existing callers/tests (e.g. `lib/registry.js`'s `buildAzureDevOpsRow`, `GET /api/instances`'s response body), so adding a key there would be a breaking shape change for no benefit to them. This is the one place a caller that specifically needs "which workspace does this slug belong to" (the client-side PAT/ticketing-system override resolution `GET /api/instance/workspace` route builds on) asks that question directly.
 */
export function resolveInstanceWorkspaceId(slug, options = {}) {
  const { entries } = loadWithBackfill(options)
  const entry = entries[slug]
  if (!entry || entry.kind !== 'azureDevOps') return null
  // `loadWithBackfill` has already run `migrateLegacyAzureDevOpsEntries` by this point, so every azureDevOps entry is guaranteed to carry a `workspaceId` — no legacy organization/project/repository shape can still be present here.
  return entry.workspaceId ?? null
}
