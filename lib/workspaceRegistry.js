import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { DEFAULT_PROVIDER, assertValidProvider, normalizeProviderLocation, providerLocationsMatch } from './provider.js'

/**
 * The workspace registry — a first-class entity representing a remote workspace's repo (docs: spec #95, this ticket #96; the Provider model, spec #1, ADR-0037). Parallel to, and independent of, `lib/instanceRegistry.js`'s instance registry: this module answers "what is this workspace" (its provider/location/owner), not "where does this instance's data live" — `lib/instanceRegistry.js` is the consumer that references a workspace by id rather than duplicating its location per instance.
 *
 * No PAT is stored here, and none ever will be by this module's own design — PAT storage remains client-only (`web/lib/credential.js`), unaffected by workspaces existing.
 *
 * Persisted the same way the instance registry is: a single JSON file, colocated inside `instancesDir` (not committed to git — see .gitignore), read fresh on every call rather than cached in memory, so concurrent callers (multiple requests against the same running server) always see the latest persisted state.
 *
 * **Provider and nested location (ticket #3, ADR-0037):** a record's canonical stored shape is
 * `{ provider, location, owner, archived? }`, `location` discriminated by `provider` — see
 * `lib/provider.js`. A pre-#3 flat record (`{ organization, project, repository, baseUrl?, owner,
 * ticketingSystem }`, no `provider`/`location` keys of its own) is read forward as
 * `provider: 'azure-devops'` with those fields lifted into `location`, the same auto-backfill-on-read
 * convention `lib/instanceRegistry.js`'s `migrateLegacyFlatShape` already established — see
 * `loadWithBackfill` below. No one-shot boot migration, so an interrupted upgrade leaves a tolerant
 * reader rather than a half-written file.
 *
 * **Flat location accessors removed (ticket #6):** every caller of this module now speaks the nested
 * `{ provider, location, owner }` shape — `registerWorkspace`/`getOrCreateWorkspace`/
 * `findWorkspaceByLocation`/`updateWorkspace` accept it and nothing else, and the records they return
 * carry `location` only, never `organization`/`project`/`repository`/`baseUrl` denormalized onto the
 * top level. The flat shape survives only on disk, for a pre-#3 record `loadWithBackfill` hasn't
 * rewritten yet — that read-forward path is unaffected by this ticket.
 */

const WORKSPACE_REGISTRY_FILENAME = 'workspace-registry.json'

// docs/adr/0037: a **Provider** is the external suite supplying both a workspace's content store and
// its work-item tracker — 'azure-devops', 'github', 'gitlab' and 'atlassian' are built (ADR-0041,
// ADR-0042). The enum itself, plus `assertValidProvider`/`normalizeProviderLocation`, live in
// `lib/provider.js` (ticket #3) so this module and `lib/librarySettings.js` share exactly one
// definition — `PROVIDERS` re-exported here purely so an existing importer of this module doesn't
// also need to reach into `lib/provider.js`.
export { PROVIDERS } from './provider.js'

function workspaceRegistryPathFor(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  return options.workspaceRegistryPath ?? join(instancesDir, WORKSPACE_REGISTRY_FILENAME)
}

// Reads the raw id -> workspace map off disk, tolerating a registry file that doesn't exist yet — that's not an error, just an empty registry (mirrors lib/instanceRegistry.js's own readRegistryFile).
function readRegistryFile(registryPath) {
  if (!storage.exists(registryPath)) return {}
  const text = storage.readText(registryPath)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function writeRegistryFile(registryPath, entries) {
  storage.writeText(registryPath, JSON.stringify(entries, null, 2) + '\n')
}

// Normalizes input into the canonical `{ provider, location, owner }` this module stores, validating
// along the way. Nested-only (ticket #6) — a caller passes `{ provider?, location, owner? }`; there is
// no flat `{ organization, project, repository, baseUrl?, owner? }` fallback left to detect.
function normalizeWorkspaceInput(input) {
  const source = input ?? {}
  const owner = source.owner ?? ''
  const provider = source.provider ?? DEFAULT_PROVIDER
  assertValidProvider(provider)
  const location = normalizeProviderLocation(provider, source.location, { entityLabel: 'A workspace location' })
  return { provider, location, owner }
}

// True when `value` looks like a pre-#3 flat-shape record (organization/project/repository directly
// on the record) rather than the current `{ provider, location }` shape.
function looksLikeFlatLegacyRecord(value) {
  return Boolean(value) && typeof value === 'object' && value.provider === undefined && typeof value.organization === 'string'
}

// Lifts every pre-#3 flat record in `entries` into the current `{ provider, location, owner,
// archived? }` shape, in place. Returns whether anything changed, so `loadWithBackfill` only
// re-persists the file when a migration actually happened — mirrors
// `lib/instanceRegistry.js`'s own `migrateLegacyFlatShape` exactly (ADR-0037: "the auto-backfill-on-
// read convention every registry here already uses").
function migrateLegacyFlatShape(entries) {
  let changed = false
  for (const id of Object.keys(entries)) {
    const legacy = entries[id]
    if (!looksLikeFlatLegacyRecord(legacy)) continue

    // A legacy record's `ticketingSystem` field is dropped, not carried forward — a flat pre-#3
    // record could only ever have been 'azure-devops' anyway, which is exactly what
    // `provider: DEFAULT_PROVIDER` already says.
    const { organization, project, repository, baseUrl, owner = '', archived } = legacy
    entries[id] = {
      provider: DEFAULT_PROVIDER,
      location: { organization, project, repository, ...(baseUrl ? { baseUrl } : {}) },
      owner,
      ...(archived ? { archived: true } : {}),
    }
    changed = true
  }
  return changed
}

function loadWithBackfill(options) {
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  const changed = migrateLegacyFlatShape(entries)
  if (changed) {
    writeRegistryFile(registryPath, entries)
  }
  return { entries, registryPath }
}

// The public record: the nested `provider`/`location`/`owner` shape. The pre-ADR-0037 `ticketingSystem`
// field (a global/per-workspace tracker override that only ever meant 'azure-devops' in practice, now
// that the Provider itself decides the tracker) is gone — no longer denormalized onto the top level.
function toPublicWorkspace(id, record) {
  return {
    id,
    provider: record.provider,
    location: { ...record.location },
    owner: record.owner ?? '',
    ...(record.archived ? { archived: true } : {}),
  }
}

/**
 * Registers a brand new workspace, always generating a fresh id — even if a workspace for the same provider/location already exists. Callers that want "find the existing one, or create it" (the auto-backfill case, and any other caller that shouldn't create duplicates for the same repo) should use `getOrCreateWorkspace` instead.
 *
 * Takes the nested `{ provider?, location, owner? }` shape (ticket #6 — no flat `{ organization, project, repository, baseUrl? }` fallback; `provider` defaults to `'azure-devops'` when omitted). `owner` defaults to `''` (unset), mirroring the instance registry's own "optional, blank until set" convention for owner-like fields.
 */
export function registerWorkspace(location, options = {}) {
  const { provider, location: normalizedLocation, owner } = normalizeWorkspaceInput(location)

  const { entries, registryPath } = loadWithBackfill(options)

  const id = randomUUID()
  entries[id] = { provider, location: normalizedLocation, owner }
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}

/**
 * Resolves a workspace by id. `undefined` if unknown.
 */
export function resolveWorkspace(id, options = {}) {
  const { entries } = loadWithBackfill(options)
  // `Object.hasOwn` (not the `in` operator) — `entries` is a plain object parsed straight off disk, so an `id` like `'__proto__'` would otherwise match an *inherited* property (Object.prototype's own `__proto__` accessor) rather than correctly reporting "unknown".
  if (!Object.hasOwn(entries, id)) return undefined
  return toPublicWorkspace(id, entries[id])
}

/**
 * Every known workspace id, in the registry file's own raw key order — never sorted, unlike `listWorkspaces` below (whose alphabetical-by-id order every existing caller already depends on and must not change). A plain JS object (and the JSON `.stringify`/`.parse` round-trip backing this file) preserves non-numeric-string key insertion order, so a workspace registered earlier still appears earlier here — this is what `lib/numberRegistry.js`'s one-time backfill (WI200, docs/adr/0024) uses as its best-effort creation-order proxy for a workspace registry entry, which carries no timestamp of its own.
 */
export function listWorkspaceIdsInStorageOrder(options = {}) {
  const { entries } = loadWithBackfill(options)
  return Object.keys(entries)
}

/**
 * Every known workspace, sorted by id.
 *
 * Archived workspaces (#223 — an entry carrying `archived: true`) are left out by default: the
 * dashboard's workspace grouping, and every other caller that just wants "the workspaces in play",
 * gets the active set with no code change. Pass `options.includeArchived` for the Settings screen's
 * "show archived / restore" view, which needs every workspace regardless — each archived one still
 * carries its own `archived: true` on the returned record so that view can tell them apart.
 */
export function listWorkspaces(options = {}) {
  const { entries } = loadWithBackfill(options)
  return Object.keys(entries)
    .sort()
    .map((id) => toPublicWorkspace(id, entries[id]))
    .filter((workspace) => options.includeArchived || !workspace.archived)
}

/**
 * Whether a workspace is currently archived (#223). `false` for an unknown id — a workspace that
 * doesn't exist isn't "archived", and callers that care about the difference check existence via
 * `resolveWorkspace` first anyway.
 */
export function isWorkspaceArchived(id, options = {}) {
  const { entries } = loadWithBackfill(options)
  return Boolean(Object.hasOwn(entries, id) && entries[id].archived)
}

/**
 * Finds an existing workspace with this exact provider + location tuple, or `undefined` if none is registered yet. Takes the nested `{ provider?, location }` shape (ticket #6 — no flat `{ organization, project, repository, baseUrl? }` fallback). Matching is scoped to that one provider (ADR-0037: "two workspaces on different providers sharing a repository name are distinct") — `baseUrl` participates in the match, compared as "absent" whether it's `undefined` or omitted, so a caller that never mentions `baseUrl` still matches a workspace registered the same way.
 */
export function findWorkspaceByLocation(location, options = {}) {
  const source = location ?? {}
  // Deliberately not validated (unlike `registerWorkspace`'s `normalizeWorkspaceInput`) — a "find"
  // that's missing a required field should just fail to match, never throw, since a caller like
  // `lib/instanceRegistry.js`'s own legacy migration probes speculatively.
  const provider = source.provider ?? DEFAULT_PROVIDER
  const queryLocation = source.location ?? {}
  const { entries } = loadWithBackfill(options)
  const match = Object.entries(entries).find(
    ([, workspace]) => workspace.provider === provider && providerLocationsMatch(provider, workspace.location, queryLocation)
  )
  return match ? toPublicWorkspace(match[0], match[1]) : undefined
}

/**
 * Finds-or-creates the workspace for this provider + location tuple: reuses an existing entry rather than registering a duplicate for a repo already known, and only calls `registerWorkspace` (creating a fresh one, with a fresh id) when nothing already matches. This is what backs the "one workspace is auto-created/backfilled per existing distinct location tuple" guarantee (`lib/instanceRegistry.js`'s legacy-shape migration) as well as any future caller (instance creation, adoption) that shouldn't fragment one repo across several workspace ids just because it's referenced more than once.
 */
export function getOrCreateWorkspace(location, options = {}) {
  const existing = findWorkspaceByLocation(location, options)
  if (existing) return existing
  return registerWorkspace(location, options)
}

/**
 * Updates an existing workspace's mutable fields (`owner`, or a corrected location) — re-validated against the merged result, so an update can't leave the record in an invalid state any more than `registerWorkspace` could create one that way. Throws if `id` is unknown.
 *
 * Takes the nested `{ owner?, provider?, location? }` shape (ticket #6 — no flat
 * `organization`/`project`/`repository`/`baseUrl` correction fields). `location` is merged onto the
 * existing one so a partial correction doesn't have to repeat every field.
 */
export function updateWorkspace(id, updates, options = {}) {
  const { entries, registryPath } = loadWithBackfill(options)
  // Object.hasOwn — see resolveWorkspace's own comment on why the `in` operator would be wrong here (an id like `'__proto__'` would otherwise match an inherited property instead of correctly throwing "unknown").
  if (!Object.hasOwn(entries, id)) {
    throw new Error(`Unknown workspace "${id}"`)
  }
  const existing = entries[id]

  let provider = existing.provider
  let mergedLocation = existing.location
  if (updates.provider !== undefined || updates.location !== undefined) {
    provider = updates.provider ?? provider
    assertValidProvider(provider)
    mergedLocation = normalizeProviderLocation(
      provider,
      { ...existing.location, ...updates.location },
      { entityLabel: 'A workspace location' }
    )
  }
  const owner = updates.owner !== undefined ? updates.owner : (existing.owner ?? '')
  entries[id] = {
    provider,
    location: mergedLocation,
    owner,
    // Preserved through an unrelated metadata edit (#223) — this rebuild is the canonical write
    // path, so `archived` has to be re-appended here or a plain owner/location change would
    // silently un-archive the workspace. Always last, so the key order stays stable.
    ...(existing.archived ? { archived: true } : {}),
  }
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}

/**
 * Archives (`archived: true`) or restores (the key removed entirely) a workspace — the write half
 * of #223's archive/restore for a workspace. Nothing is deleted: the entry, its provider, location,
 * `owner` and its assigned workspace number (lib/numberRegistry.js) all stay exactly as they were, so
 * `restoreWorkspace` brings the workspace back to precisely the state it was archived from. The entry
 * is rebuilt in the same canonical key order `registerWorkspace`/`updateWorkspace` use, with
 * `archived` (when set) always last.
 *
 * Both are idempotent: archiving an already-archived workspace, or restoring one that isn't
 * archived, is a no-op success — the caller only cares about the end state. Throws only if `id`
 * is unknown.
 *
 * This module deliberately does NOT cascade to the workspace's instances and does NOT itself
 * check whether any active instance still references this workspace. Archiving is a per-item
 * action (#223), and the "block archiving a workspace that still has active instances" rule needs
 * to see both this registry and the instance registry at once — so it lives in the one caller
 * positioned to do that (`POST /api/workspace/archive` in lib/server.js), keeping this a plain
 * registry primitive that does exactly what its name says.
 */
export function archiveWorkspace(id, options = {}) {
  return setWorkspaceArchived(id, true, options)
}

export function restoreWorkspace(id, options = {}) {
  return setWorkspaceArchived(id, false, options)
}

function setWorkspaceArchived(id, archived, options) {
  const { entries, registryPath } = loadWithBackfill(options)
  // Object.hasOwn — see resolveWorkspace's own comment on why the `in` operator would be wrong here.
  if (!Object.hasOwn(entries, id)) {
    throw new Error(`Unknown workspace "${id}"`)
  }
  const { provider, location, owner = '' } = entries[id]
  entries[id] = {
    provider,
    location,
    owner,
    ...(archived ? { archived: true } : {}),
  }
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}
