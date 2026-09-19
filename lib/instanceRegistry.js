import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { listInstanceSlugs } from './instance.js'
import { getOrCreateWorkspace, resolveWorkspace } from './workspaceRegistry.js'
import { describeProviderLocation } from './provider.js'
import { listServerWorkspaces } from './workspaceDirectory.js'
import { LOCAL_SCOPE } from './numberRegistry.js'

/**
 * The instance *registry* — not to be confused with `lib/registry.js`'s `listRegistry` (the dashboard-facing "every instance enriched with definition/stage/status/assignee" listing). This module answers a narrower, lower-level question: "where does this slug's data live" — under a named server workspace directory, or in a specific Azure DevOps organization/project/repository — not anything about that instance's content.
 *
 * WI #356 (Feature 2 of 4 under Epic #34's workspace-directories work, following #355's `workspace.json` primitive): the legacy `kind: 'local'` entry — a bare, workspace-less instance directory — is retired. Every instance now belongs to a *scope*: an Azure DevOps workspace (its uuid, `lib/workspaceRegistry.js`, unchanged) or a **server workspace** directory (its folder name under the workspaces root, `lib/workspaceDirectory.js`, #355). The on-disk shape changes from the pre-#356 flat `{ [slug]: location }` map to a scope-nested `{ [scopeId]: { [slug]: entry } }` map, so two different workspaces can each have their own instance called e.g. `"foo"` without collision. A pre-#356 flat-shaped registry file is migrated in place the first time it's read (see `migrateLegacyFlatShape`) — no manual step for an existing deployment.
 *
 * `options.instancesDir` is, despite the name (kept for minimal call-site churn across the many existing tests/callers of this module and `lib/workspaceRegistry.js`/`lib/numberRegistry.js`, which colocate their own registry files the same way), now the **workspaces root** — the directory `workspace-registry.json`/`instance-registry.json`/`number-registry.json` live inside, and the directory each server workspace is an immediate subdirectory of. It is never the concrete directory of any *one* instance's data any more — `lib/server.js`/`bin/gantry.js` compute that per request/command as `join(workspacesRoot, workspaceFolder)` and pass it to `lib/instance.js`/`lib/render.js`/etc. separately, which are otherwise completely unaware workspaces exist at all.
 *
 * A **directory-backed** slug's registry entry is `{ kind: 'directory' }`, keyed under its server workspace's scope id — which is its folder name under the workspaces root, *except* for one reserved case: the workspace a pre-#356 flat legacy directory is migrated into (`lib/workspaceMigration.js`) is always named `default` on disk, but keeps the scope id `lib/numberRegistry.js` already reserves for every pre-#356 local instance (`LOCAL_SCOPE`, `'local'`) rather than being handed a fresh sequential workspace number — see `scopeIdForDirectoryFolder`/`directoryFolderForScopeId` below. This one special case is what makes a pre-migration `w0i1`-style numbered reference resolve to the exact same instance afterward (WI #356 acceptance criterion 1): nothing in `lib/numberRegistry.js` itself has to change to make that true, since `default`'s instances keep numbering under the same scope key they always did.
 *
 * An Azure-DevOps-backed slug's entry is `{ kind: 'azureDevOps' }`, keyed under its workspace's own uuid (the scope id *is* the workspace id directly now — no separate `workspaceId` field on the entry, since the outer key already carries it). Azure DevOps workspace behavior itself (`lib/workspaceRegistry.js`) is unchanged by this ticket, and — deliberately — an Azure-DevOps-backed instance is never addressed as `<workspace>/<slug>` the way a directory-backed one now is; it keeps resolving by its own slug alone, exactly as before #356, since nothing about this epic asked for that surface to change.
 *
 * Since #223: any entry (either kind) may additionally carry `archived: true`.
 */

const REGISTRY_FILENAME = 'instance-registry.json'

// The on-disk folder name a pre-#356 flat legacy instances directory is always migrated into
// (`lib/workspaceMigration.js`, WI #356 decision: fixed name, not derived from the old directory's
// own name). Reserved: a server workspace folder with this exact name is always treated as the
// successor of the old shared local scope (see the module doc comment above), so its instances keep
// numbering under `LOCAL_SCOPE`/`LOCAL_WORKSPACE_NUMBER` (0) instead of a fresh sequential number.
export const MIGRATED_DEFAULT_WORKSPACE_FOLDER = 'default'

/** A directory workspace's folder name -> the scope id its instances are keyed/numbered under. */
export function scopeIdForDirectoryFolder(folder) {
  return folder === MIGRATED_DEFAULT_WORKSPACE_FOLDER ? LOCAL_SCOPE : folder
}

/** The inverse of `scopeIdForDirectoryFolder` — a directory scope id -> the folder name it lives at on disk. */
export function directoryFolderForScopeId(scopeId) {
  return scopeId === LOCAL_SCOPE ? MIGRATED_DEFAULT_WORKSPACE_FOLDER : scopeId
}

function registryPathFor(options) {
  const workspacesDir = options.instancesDir ?? 'instances'
  return options.registryPath ?? join(workspacesDir, REGISTRY_FILENAME)
}

function readRegistryFile(registryPath) {
  if (!storage.exists(registryPath)) return {}
  const text = storage.readText(registryPath)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function writeRegistryFile(registryPath, entries) {
  storage.writeText(registryPath, JSON.stringify(entries, null, 2) + '\n')
}

function assertValidEntryKind(location) {
  if (!location || typeof location !== 'object') {
    throw new Error('A registry location must be an object')
  }
  if (location.kind === 'local') {
    throw new Error(
      '"local" is no longer a valid registry location kind (WI #356) — pass { kind: "directory", workspace: <folder> } instead'
    )
  }
  if (location.kind === 'directory') {
    if (!location.workspace) {
      throw new Error('A "directory" registry location must carry a workspace (folder name)')
    }
    return
  }
  if (location.kind === 'azureDevOps') {
    return
  }
  throw new Error(`Unknown registry location kind "${location?.kind}" — expected "directory" or "azureDevOps"`)
}

function normalizeAzureDevOpsLocation(location, options) {
  if (location.workspaceId !== undefined) {
    if (!resolveWorkspace(location.workspaceId, options)) {
      throw new Error(`Unknown workspace "${location.workspaceId}"`)
    }
    return { scopeId: location.workspaceId, entry: { kind: 'azureDevOps' } }
  }

  const missing = ['organization', 'project', 'repository'].filter((key) => !location[key])
  if (missing.length) {
    throw new Error(`An "azureDevOps" registry location is missing: ${missing.join(', ')}`)
  }

  const workspace = getOrCreateWorkspace(
    {
      provider: 'azure-devops',
      location: { organization: location.organization, project: location.project, repository: location.repository, baseUrl: location.baseUrl },
    },
    options
  )
  return { scopeId: workspace.id, entry: { kind: 'azureDevOps' } }
}

// The read-side inverse of the normalize helpers above: expands a persisted `{ scopeId, entry }`
// pair back to the public location shape every caller works with — `{ kind: 'directory', workspace }`
// or `{ kind: 'azureDevOps', organization, project, repository, baseUrl? }` (denormalized from the
// referenced workspace, matching every pre-#356 caller/test's existing expectation for that kind).
function denormalizeEntry(scopeId, entry, options) {
  if (entry?.kind === 'directory') {
    return { kind: 'directory', workspace: directoryFolderForScopeId(scopeId) }
  }
  if (entry?.kind !== 'azureDevOps') return entry
  const workspace = resolveWorkspace(scopeId, options)
  if (!workspace) {
    throw new Error(`Registry entry references unknown workspace "${scopeId}"`)
  }
  return {
    kind: 'azureDevOps',
    organization: workspace.location.organization,
    project: workspace.location.project,
    repository: workspace.location.repository,
    ...(workspace.location.baseUrl ? { baseUrl: workspace.location.baseUrl } : {}),
  }
}

// True when `value` looks like a pre-#356 flat-shape entry (a location object directly — `kind` is
// one of its own keys) rather than the current nested shape (a scope's map of `{ [slug]: entry }`,
// whose own values carry `kind`, not the map itself). A slug literally named "kind" would defeat
// this heuristic, but `lib/slug.js`'s validation already rules that out in practice.
function looksLikeFlatLegacyEntry(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.kind === 'string'
}

// Migrates a pre-#356 flat `{ [slug]: location }` registry (any shape from #89 through #223 — a
// `kind: 'local'` entry, a `kind: 'azureDevOps'` entry already carrying `workspaceId` from #96, or
// the pre-#96 shape carrying `organization`/`project`/`repository` directly with no `workspaceId` at
// all yet) into the current scope-nested shape, in place. Returns whether anything changed, so
// `loadWithBackfill` only re-persists the file when a migration actually happened. A file already in
// the nested shape (every entry created by this ticket onward) is left untouched.
function migrateLegacyFlatShape(entries, options) {
  const legacySlugs = Object.keys(entries).filter((key) => looksLikeFlatLegacyEntry(entries[key]))
  if (legacySlugs.length === 0) return false

  for (const slug of legacySlugs) {
    const legacy = entries[slug]
    delete entries[slug]

    let scopeId
    let entry
    if (legacy.kind === 'local') {
      scopeId = LOCAL_SCOPE
      entry = { kind: 'directory' }
    } else if (legacy.kind === 'azureDevOps') {
      if (legacy.workspaceId !== undefined) {
        scopeId = legacy.workspaceId
      } else {
        // Pre-#96 shape: organization/project/repository written directly on the entry, no
        // workspace registry entry yet — back-fill (or reuse) one, exactly as #96's own
        // migrateLegacyAzureDevOpsEntries did.
        const workspace = getOrCreateWorkspace(
          {
            provider: 'azure-devops',
            location: { organization: legacy.organization, project: legacy.project, repository: legacy.repository, baseUrl: legacy.baseUrl },
          },
          options
        )
        scopeId = workspace.id
      }
      entry = { kind: 'azureDevOps' }
    } else {
      // Unrecognized legacy kind — preserve rather than drop, so a corrupt/foreign entry doesn't
      // silently vanish; keyed under LOCAL_SCOPE as a last resort so it's at least still listed.
      scopeId = LOCAL_SCOPE
      entry = { kind: legacy.kind }
    }
    if (legacy.archived) entry.archived = true

    entries[scopeId] = entries[scopeId] ?? {}
    entries[scopeId][slug] = entry
  }

  return true
}

// Any `workspace.json`-marked server workspace folder found under the workspaces root with an
// `instance.yaml` inside one of its own immediate subdirectories, and no existing registry entry,
// gets one auto-added here — the scope-nested successor of #89's original "any instance.yaml found
// on disk with no registry entry gets one" backfill. A pre-#356 *legacy* flat directory (an
// `instance.yaml` directly under the workspaces root, no `workspace.json` one level up) is
// deliberately NOT picked up here — that's `lib/workspaceMigration.js`'s job, run once at server
// startup before this registry is ever read; by the time this function runs, every instance is
// expected to already live under some real workspace folder.
function scanDirectoryWorkspacesForInstances(workspacesDir) {
  const found = []
  for (const { id: folder, error } of listServerWorkspaces(workspacesDir)) {
    if (error) continue // a malformed workspace.json — nothing to scan under it; surfaced elsewhere.
    const scopeId = scopeIdForDirectoryFolder(folder)
    for (const slug of listInstanceSlugs(join(workspacesDir, folder))) {
      found.push({ scopeId, slug })
    }
  }
  return found
}

function loadWithBackfill(options) {
  const workspacesDir = options.instancesDir ?? 'instances'
  const registryPath = registryPathFor(options)
  const entries = readRegistryFile(registryPath)

  let changed = migrateLegacyFlatShape(entries, options)

  for (const { scopeId, slug } of scanDirectoryWorkspacesForInstances(workspacesDir)) {
    entries[scopeId] = entries[scopeId] ?? {}
    if (!(slug in entries[scopeId])) {
      entries[scopeId][slug] = { kind: 'directory' }
      changed = true
    }
  }

  if (changed) {
    writeRegistryFile(registryPath, entries)
  }

  return { entries, registryPath }
}

function findSlugAcrossScopes(entries, slug) {
  const matches = []
  for (const scopeId of Object.keys(entries)) {
    if (entries[scopeId] && Object.hasOwn(entries[scopeId], slug)) {
      matches.push(scopeId)
    }
  }
  return matches
}

function candidateLabel(scopeId, slug, entry, options) {
  if (entry.kind === 'directory') return `${directoryFolderForScopeId(scopeId)}/${slug}`
  const workspace = resolveWorkspace(scopeId, options)
  return workspace ? `${describeProviderLocation(workspace.provider, workspace.location)}:${slug}` : `${scopeId}:${slug}`
}

function ambiguousSlugError(entries, slug, matches, options) {
  const candidates = matches.map((scopeId) => candidateLabel(scopeId, slug, entries[scopeId][slug], options))
  return new Error(
    `Instance slug "${slug}" is ambiguous — it exists in more than one workspace: ${candidates.join(', ')}. ` +
      'Qualify it as "<workspace>/<slug>".'
  )
}

// Resolves `slug` to its scope id: `options.workspace` (a directory workspace's folder name) when
// given, resolved directly against that one scope with no ambiguity search — the fast, unambiguous
// path every caller that already knows the workspace (the addressing layer, having already parsed
// "<workspace>/<slug>") should use. Without it, searches every scope for `slug` (WI #356's bare-slug
// backward-compatibility rule): exactly one match resolves (with a console warning — the deprecated
// path); zero matches returns `undefined`; more than one throws `ambiguousSlugError` naming every
// candidate.
function resolveScope(entries, slug, options) {
  // WI #366: `scopeId` is the already-resolved scope key itself — what `resolveInstanceWorkspaceId`
  // hands out and what a numeric ref pins down (`resolveScopeAndSlugForRef`). It covers both scope
  // kinds in one option, where `workspace` below only names a *directory* workspace's folder, so the
  // addressing layer can pass one opaque token through without first knowing which kind it holds.
  if (options.scopeId) {
    // `hasOwn`, not `entries[scopeId]?.[slug]` — this one arrives from request input (the `?scope=`
    // token), so an inherited key like `__proto__` must miss rather than resolve to Object.prototype.
    if (!Object.hasOwn(entries, options.scopeId)) return undefined
    if (!Object.hasOwn(entries[options.scopeId], slug)) return undefined
    return options.scopeId
  }
  if (options.workspace) {
    const scopeId = scopeIdForDirectoryFolder(options.workspace)
    if (!entries[scopeId]?.[slug]) return undefined
    return scopeId
  }
  const matches = findSlugAcrossScopes(entries, slug)
  if (matches.length === 0) return undefined
  if (matches.length > 1) throw ambiguousSlugError(entries, slug, matches, options)
  if (!options.suppressBareSlugWarning) {
    console.warn(
      `lib/instanceRegistry.js: "${slug}" resolved via a bare, workspace-unqualified slug (deprecated, WI #356) — ` +
        `prefer "${directoryFolderForScopeId(matches[0]) === matches[0] || entries[matches[0]][slug].kind === 'directory' ? directoryFolderForScopeId(matches[0]) + '/' + slug : slug}".`
    )
  }
  return matches[0]
}

/**
 * Resolves a slug's location: `{ kind: 'directory', workspace }` or `{ kind: 'azureDevOps', organization, project, repository, baseUrl? }`. `undefined` if unknown. Pass `options.scopeId` (a raw scope id, either kind — WI #366) or `options.workspace` (a directory workspace's folder name) to resolve within that one scope directly; omit both to search every scope, per this module's bare-slug backward-compatibility rule (throws if ambiguous).
 */
export function resolveInstanceLocation(slug, options = {}) {
  const { entries } = loadWithBackfill(options)
  const scopeId = resolveScope(entries, slug, options)
  if (scopeId === undefined) return undefined
  return denormalizeEntry(scopeId, entries[scopeId][slug], options)
}

/**
 * Registers (or overwrites) `slug`'s location, within the scope `location` names: `location.workspace`
 * (a directory workspace's folder name) for `{ kind: 'directory' }`, or `location.workspaceId` /
 * `{ organization, project, repository, baseUrl? }` for `{ kind: 'azureDevOps' }` — same as before
 * #356, just no longer accepting the retired `{ kind: 'local' }` shape (throws, naming the
 * replacement).
 */
export function registerInstance(slug, location, options = {}) {
  assertValidEntryKind(location)
  const { entries, registryPath } = loadWithBackfill(options)

  let scopeId
  let entry
  if (location.kind === 'directory') {
    scopeId = scopeIdForDirectoryFolder(location.workspace)
    entry = { kind: 'directory' }
  } else {
    ;({ scopeId, entry } = normalizeAzureDevOpsLocation(location, options))
  }

  entries[scopeId] = entries[scopeId] ?? {}
  entries[scopeId][slug] = entry
  writeRegistryFile(registryPath, entries)
}

/**
 * Every known entry as `[{ slug, workspace, location }, ...]`, sorted by slug then workspace for a
 * stable order now that the same slug can legitimately appear more than once (in different
 * workspaces). `workspace` is the directory folder name for a `directory`-kind entry, `undefined`
 * for an `azureDevOps`-kind one (mirrors the pre-#356 "no workspace field for a local row" shape —
 * never `null`).
 *
 * Archived instances (#223) are left out by default; pass `options.includeArchived` for the "show
 * archived / restore" view — each row then additionally carries `archived` (a plain boolean).
 */
export function listRegisteredInstances(options = {}) {
  const { entries } = loadWithBackfill(options)
  const rows = []
  for (const scopeId of Object.keys(entries)) {
    for (const slug of Object.keys(entries[scopeId])) {
      const raw = entries[scopeId][slug]
      if (!options.includeArchived && raw.archived) continue
      const location = denormalizeEntry(scopeId, raw, options)
      // WI #366: `scopeId` is the raw key this entry is stored under — a directory workspace's scope
      // id or an Azure DevOps workspace's uuid. Carried on the row so a caller grouping instances by
      // workspace can read it straight off, instead of looking each slug up again (a re-lookup that
      // has no scope to go on, and so throws outright once two workspaces share a slug).
      const row = { slug, scopeId, workspace: location.kind === 'directory' ? location.workspace : undefined, location }
      if (options.includeArchived) row.archived = Boolean(raw.archived)
      rows.push(row)
    }
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug) || (a.workspace ?? '').localeCompare(b.workspace ?? ''))
  return rows
}

/** Whether a slug's instance is currently archived (#223). `false` for a slug the registry has never seen. Accepts `options.workspace` the same way `resolveInstanceLocation` does. */
export function isInstanceArchived(slug, options = {}) {
  const { entries } = loadWithBackfill(options)
  const scopeId = resolveScope(entries, slug, options)
  if (scopeId === undefined) return false
  return Boolean(entries[scopeId][slug]?.archived)
}

export function archiveInstance(slug, options = {}) {
  return setInstanceArchived(slug, true, options)
}

export function restoreInstance(slug, options = {}) {
  return setInstanceArchived(slug, false, options)
}

function setInstanceArchived(slug, archived, options) {
  const { entries, registryPath } = loadWithBackfill(options)
  const scopeId = resolveScope(entries, slug, { ...options, suppressBareSlugWarning: true })
  if (scopeId === undefined) {
    throw new Error(`Unknown instance "${slug}"`)
  }
  const entry = entries[scopeId][slug]
  const rebuilt = { kind: entry.kind }
  if (archived) rebuilt.archived = true
  entries[scopeId][slug] = rebuilt
  writeRegistryFile(registryPath, entries)
  return { slug, location: denormalizeEntry(scopeId, entries[scopeId][slug], options), archived: Boolean(archived) }
}

/**
 * Every `{ workspace, slug }` pair known to the registry, in each scope's own raw key-insertion
 * order (never sorted) — the numbering-scope-aware successor of the pre-#356 flat
 * `listRegisteredSlugsInStorageOrder` (which returned bare slugs only, ambiguous once two scopes can
 * share a slug). `workspace` here is the *scope id* (a directory workspace's scope id, or an Azure
 * DevOps workspace's uuid) — exactly what `lib/numberRegistry.js`'s `getOrAssignInstanceNumber`
 * already expects as its own `scopeKey` argument, so `backfillNumberRegistry`'s per-workspace loop
 * can consume this directly with no further lookup.
 */
export function listRegisteredScopedSlugsInStorageOrder(options = {}) {
  const { entries } = loadWithBackfill(options)
  const pairs = []
  for (const scopeId of Object.keys(entries)) {
    for (const slug of Object.keys(entries[scopeId])) {
      pairs.push({ workspace: scopeId, slug })
    }
  }
  return pairs
}

/**
 * The raw scope id (a directory workspace's scope id, or an Azure DevOps workspace's uuid) a slug's
 * entry is keyed under, or `null` if the registry has never seen it. Accepts `options.workspace` the
 * same way `resolveInstanceLocation` does (direct lookup within that one scope); without it, searches
 * every scope and throws `ambiguousSlugError` if more than one matches — the same bare-slug rule
 * every other lookup in this module follows. This is what `lib/numberRegistry.js`'s `scopeKeyForSlug`
 * calls to decide which numbering scope a slug belongs to.
 */
export function resolveInstanceWorkspaceId(slug, options = {}) {
  const { entries } = loadWithBackfill(options)
  const scopeId = resolveScope(entries, slug, { ...options, suppressBareSlugWarning: true })
  return scopeId ?? null
}
