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
 * Every function still accepts (and every returned record still carries) the pre-#3 flat
 * `organization`/`project`/`repository`/`baseUrl`/`ticketingSystem` fields for an Azure DevOps
 * workspace — no consumer is migrated by this ticket. A caller that wants a GitHub workspace, or
 * wants to address a record by its nested shape explicitly, passes `{ provider, location, owner }`
 * instead; `registerWorkspace`/`getOrCreateWorkspace`/`findWorkspaceByLocation`/`updateWorkspace` all
 * accept either shape, detected by the presence of a `location` key.
 */

const WORKSPACE_REGISTRY_FILENAME = 'workspace-registry.json'

// Modeled now so Jira support can be added later without a schema migration (spec #95's Implementation Decisions) — but only 'azure-devops' is actually accepted today. `TICKETING_SYSTEMS` is the full modeled enum, exported separately so a future UI can render 'jira' as a visible-but-disabled option without this module appearing to endorse it. Kept alongside the new `provider` field (ADR-0037: "ticketingSystem is absorbed into a single provider field") purely for backward compatibility — no consumer of this pre-existing enum is migrated by ticket #3.
export const TICKETING_SYSTEMS = ['azure-devops', 'jira']
const SUPPORTED_TICKETING_SYSTEMS = ['azure-devops']
export const DEFAULT_TICKETING_SYSTEM = 'azure-devops'

// docs/adr/0037: a **Provider** is the external suite supplying both a workspace's content store and
// its work-item tracker — 'azure-devops' and 'github' are built, 'atlassian' is modeled-but-unavailable
// (Bitbucket + Jira, shown in the wizard as a known-but-unselectable option). The enum itself, plus
// `assertValidProvider`/`normalizeProviderLocation`, live in `lib/provider.js` (ticket #3) so this
// module and `lib/librarySettings.js` share exactly one definition — `PROVIDERS` re-exported here
// purely so an existing importer of this module doesn't also need to reach into `lib/provider.js`.
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

/**
 * Throws unless `value` is a ticketing system gantry actually supports today. Exported so any other place a ticketing-system value gets set — a per-workspace override here, or a future global-default setting (not yet built — see #101) — runs the exact same check rather than each inventing its own, so 'jira' is rejected identically everywhere it could be selected, not just at workspace-registration time.
 */
export function assertValidTicketingSystem(value) {
  if (!TICKETING_SYSTEMS.includes(value)) {
    throw new Error(`Unknown ticketing system "${value}" — expected one of: ${TICKETING_SYSTEMS.join(', ')}`)
  }
  if (!SUPPORTED_TICKETING_SYSTEMS.includes(value)) {
    throw new Error(
      `Ticketing system "${value}" is not supported yet — only ${SUPPORTED_TICKETING_SYSTEMS.join(', ')} is available today`
    )
  }
}

// True when `input` already names its provider/location explicitly (the new #3 shape) rather than
// carrying flat organization/project/repository fields directly (the pre-#3 shape every existing
// caller still uses). Detected on the presence of a `location` key so a flat caller that happens to
// also pass `provider` — none do today, but nothing stops one — still isn't misread as nested.
function isNestedInput(input) {
  return Boolean(input) && typeof input === 'object' && input.location !== undefined && input.location !== null
}

// Normalizes either input shape into the canonical `{ provider, location, owner }` this module
// stores, validating along the way. Flat input's `ticketingSystem` is still validated (unchanged
// behavior for every existing caller) even though it no longer drives storage — provider is fixed to
// 'azure-devops' for a flat call, the only value flat input could ever mean.
function normalizeWorkspaceInput(input) {
  const source = input ?? {}
  const owner = source.owner ?? ''

  if (isNestedInput(source)) {
    const provider = source.provider ?? DEFAULT_PROVIDER
    assertValidProvider(provider)
    const location = normalizeProviderLocation(provider, source.location, { entityLabel: 'A workspace location' })
    return { provider, location, owner }
  }

  const ticketingSystem = source.ticketingSystem ?? DEFAULT_TICKETING_SYSTEM
  assertValidTicketingSystem(ticketingSystem)
  const location = normalizeProviderLocation(
    DEFAULT_PROVIDER,
    { organization: source.organization, project: source.project, repository: source.repository, baseUrl: source.baseUrl },
    { entityLabel: 'A workspace' }
  )
  return { provider: DEFAULT_PROVIDER, location, owner }
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

    // `ticketingSystem` is dropped, not carried forward — the only value it could ever have held
    // (`assertValidTicketingSystem` rejects everything else) is 'azure-devops', which is exactly
    // what `provider: DEFAULT_PROVIDER` already says.
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

// The public record: the nested `provider`/`location`/`owner` shape, plus — for an Azure DevOps
// workspace only — the pre-#3 flat `organization`/`project`/`repository`/`baseUrl`/`ticketingSystem`
// fields denormalized back onto the top level, so `workspace.organization` etc. keep working for
// every existing caller (ticket #3: "flat accessors still work; no consumer is migrated"). A GitHub
// workspace has no flat-shape precedent to be compatible with, so it carries only the nested shape.
function toPublicWorkspace(id, record) {
  const flatAliases =
    record.provider === 'azure-devops' ? { ...record.location, ticketingSystem: DEFAULT_TICKETING_SYSTEM } : {}
  return {
    id,
    provider: record.provider,
    location: { ...record.location },
    owner: record.owner ?? '',
    ...flatAliases,
    ...(record.archived ? { archived: true } : {}),
  }
}

/**
 * Registers a brand new workspace, always generating a fresh id — even if a workspace for the same provider/location already exists. Callers that want "find the existing one, or create it" (the auto-backfill case, and any other caller that shouldn't create duplicates for the same repo) should use `getOrCreateWorkspace` instead.
 *
 * Accepts either shape (see this module's doc comment): the pre-#3 flat `{ organization, project, repository, baseUrl?, owner?, ticketingSystem? }` (always `provider: 'azure-devops'`), or the #3 nested `{ provider, location, owner? }`. `owner` defaults to `''` (unset) either way, mirroring the instance registry's own "optional, blank until set" convention for owner-like fields.
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
 * Finds an existing workspace with this exact provider + location tuple, or `undefined` if none is registered yet. Accepts either input shape (see this module's doc comment) — flat input always means `provider: 'azure-devops'`. Matching is scoped to that one provider (ADR-0037: "two workspaces on different providers sharing a repository name are distinct") — `baseUrl` participates in the match, compared as "absent" whether it's `undefined` or omitted, so a caller that never mentions `baseUrl` still matches a workspace registered the same way.
 */
export function findWorkspaceByLocation(location, options = {}) {
  const source = location ?? {}
  // Deliberately not validated (unlike `registerWorkspace`'s `normalizeWorkspaceInput`) — a "find"
  // that's missing a required field should just fail to match, never throw, since a caller like
  // `lib/instanceRegistry.js`'s own legacy migration probes speculatively.
  const provider = isNestedInput(source) ? (source.provider ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER
  const queryLocation = isNestedInput(source)
    ? (source.location ?? {})
    : { organization: source.organization, project: source.project, repository: source.repository, baseUrl: source.baseUrl }
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
 * Accepts either shape: the pre-#3 flat `{ owner?, ticketingSystem?, organization?, project?, repository?, baseUrl? }` (`ticketingSystem` is still validated for backward compatibility — see this module's own `TICKETING_SYSTEMS` doc comment — but never changes `provider`, the only value a flat call could ever mean), or the #3 nested `{ owner?, provider?, location? }` (`location` is merged onto the existing one, so a partial correction doesn't have to repeat every field).
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
  if (isNestedInput(updates)) {
    provider = updates.provider ?? provider
    assertValidProvider(provider)
    mergedLocation = normalizeProviderLocation(
      provider,
      { ...existing.location, ...updates.location },
      { entityLabel: 'A workspace location' }
    )
  } else {
    if (updates.ticketingSystem !== undefined) assertValidTicketingSystem(updates.ticketingSystem)
    const flatCorrections = ['organization', 'project', 'repository', 'baseUrl'].reduce((acc, key) => {
      if (updates[key] !== undefined) acc[key] = updates[key]
      return acc
    }, {})
    if (Object.keys(flatCorrections).length) {
      mergedLocation = normalizeProviderLocation(provider, { ...existing.location, ...flatCorrections }, { entityLabel: 'A workspace' })
    }
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
