import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'

/**
 * The workspace registry — a first-class entity representing an Azure DevOps repo (docs: spec #95, this ticket #96). Parallel to, and independent of, `lib/instanceRegistry.js`'s instance registry: this module answers "what is this workspace" (its organization/project/repository/owner/ticketingSystem), not "where does this instance's data live" — `lib/instanceRegistry.js` is the consumer that references a workspace by id rather than duplicating its organization/project/repository per instance.
 *
 * No PAT is stored here, and none ever will be by this module's own design — PAT storage remains client-only (`web/lib/credential.js`), unaffected by workspaces existing.
 *
 * Persisted the same way the instance registry is: a single JSON file, colocated inside `instancesDir` (not committed to git — see .gitignore), read fresh on every call rather than cached in memory, so concurrent callers (multiple requests against the same running server) always see the latest persisted state.
 */

const WORKSPACE_REGISTRY_FILENAME = 'workspace-registry.json'

// Modeled now so Jira support can be added later without a schema migration (spec #95's Implementation Decisions) — but only 'azure-devops' is actually accepted today. `SUPPORTED_TICKETING_SYSTEMS` is the enforcement list; `TICKETING_SYSTEMS` is the full modeled enum, exported separately so a future UI can render 'jira' as a visible-but-disabled option without this module appearing to endorse it.
export const TICKETING_SYSTEMS = ['azure-devops', 'jira']
const SUPPORTED_TICKETING_SYSTEMS = ['azure-devops']
export const DEFAULT_TICKETING_SYSTEM = 'azure-devops'

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

function assertValidWorkspaceFields({ organization, project, repository, ticketingSystem }) {
  const missing = ['organization', 'project', 'repository'].filter(
    (key) => !{ organization, project, repository }[key]
  )
  if (missing.length) {
    throw new Error(`A workspace is missing: ${missing.join(', ')}`)
  }
  assertValidTicketingSystem(ticketingSystem)
}

function toPublicWorkspace(id, record) {
  return { id, ...record }
}

/**
 * Registers a brand new workspace, always generating a fresh id — even if a workspace for the same organization/project/repository already exists. Callers that want "find the existing one, or create it" (the auto-backfill case, and any other caller that shouldn't create duplicates for the same repo) should use `getOrCreateWorkspace` instead.
 *
 * `ticketingSystem` defaults to `DEFAULT_TICKETING_SYSTEM` ('azure-devops') when omitted; `owner` defaults to `''` (unset), mirroring the instance registry's own "optional, blank until set" convention for owner-like fields.
 */
export function registerWorkspace(location, options = {}) {
  const {
    organization,
    project,
    repository,
    baseUrl,
    owner = '',
    ticketingSystem = DEFAULT_TICKETING_SYSTEM,
  } = location ?? {}
  assertValidWorkspaceFields({ organization, project, repository, ticketingSystem })

  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)

  const id = randomUUID()
  entries[id] = {
    organization,
    project,
    repository,
    ...(baseUrl ? { baseUrl } : {}),
    owner,
    ticketingSystem,
  }
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}

/**
 * Resolves a workspace by id. `undefined` if unknown.
 */
export function resolveWorkspace(id, options = {}) {
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  // `Object.hasOwn` (not the `in` operator) — `entries` is a plain object parsed straight off disk, so an `id` like `'__proto__'` would otherwise match an *inherited* property (Object.prototype's own `__proto__` accessor) rather than correctly reporting "unknown".
  if (!Object.hasOwn(entries, id)) return undefined
  return toPublicWorkspace(id, entries[id])
}

/**
 * Every known workspace id, in the registry file's own raw key order — never sorted, unlike `listWorkspaces` below (whose alphabetical-by-id order every existing caller already depends on and must not change). A plain JS object (and the JSON `.stringify`/`.parse` round-trip backing this file) preserves non-numeric-string key insertion order, so a workspace registered earlier still appears earlier here — this is what `lib/numberRegistry.js`'s one-time backfill (WI200, docs/adr/0024) uses as its best-effort creation-order proxy for a workspace registry entry, which carries no timestamp of its own.
 */
export function listWorkspaceIdsInStorageOrder(options = {}) {
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
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
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
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
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  return Boolean(Object.hasOwn(entries, id) && entries[id].archived)
}

/**
 * Finds an existing workspace with this exact organization/project/repository/baseUrl tuple, or `undefined` if none is registered yet. `baseUrl` participates in the match (an on-prem Azure DevOps Server repo with the same org/project/repository names as a cloud one is a distinct workspace), compared as "absent" whether it's `undefined` or omitted so a caller that never mentions `baseUrl` still matches a workspace registered the same way.
 */
export function findWorkspaceByLocation(location, options = {}) {
  const { organization, project, repository, baseUrl } = location ?? {}
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  const match = Object.entries(entries).find(
    ([, workspace]) =>
      workspace.organization === organization &&
      workspace.project === project &&
      workspace.repository === repository &&
      (workspace.baseUrl ?? undefined) === (baseUrl ?? undefined)
  )
  return match ? toPublicWorkspace(match[0], match[1]) : undefined
}

/**
 * Finds-or-creates the workspace for this organization/project/repository (+ optional baseUrl) tuple: reuses an existing entry rather than registering a duplicate for a repo already known, and only calls `registerWorkspace` (creating a fresh one, with a fresh id) when nothing already matches. This is what backs the "one workspace is auto-created/backfilled per existing distinct organization/project/repository tuple" guarantee (`lib/instanceRegistry.js`'s legacy-shape migration) as well as any future caller (instance creation, adoption) that shouldn't fragment one repo across several workspace ids just because it's referenced more than once.
 */
export function getOrCreateWorkspace(location, options = {}) {
  const existing = findWorkspaceByLocation(location, options)
  if (existing) return existing
  return registerWorkspace(location, options)
}

/**
 * Updates an existing workspace's mutable fields (`owner`, `ticketingSystem`, or a corrected `organization`/`project`/`repository`/`baseUrl`) — organization/project/repository/ticketingSystem are re-validated against the merged result, so an update can't leave the record in an invalid state (e.g. clearing `repository`, or setting `ticketingSystem` to `'jira'`) any more than `registerWorkspace` could create one that way. Throws if `id` is unknown.
 */
export function updateWorkspace(id, updates, options = {}) {
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  // Object.hasOwn — see resolveWorkspace's own comment on why the `in` operator would be wrong here (an id like `'__proto__'` would otherwise match an inherited property instead of correctly throwing "unknown").
  if (!Object.hasOwn(entries, id)) {
    throw new Error(`Unknown workspace "${id}"`)
  }
  const merged = { ...entries[id], ...updates }
  assertValidWorkspaceFields(merged)
  const { organization, project, repository, baseUrl, owner = '', ticketingSystem, archived } = merged
  entries[id] = {
    organization,
    project,
    repository,
    ...(baseUrl ? { baseUrl } : {}),
    owner,
    ticketingSystem,
    // Preserved through an unrelated metadata edit (#223) — this rebuild is the canonical write
    // path, so `archived` has to be re-appended here or a plain owner/ticketing-system change
    // would silently un-archive the workspace. Always last, so the key order stays stable.
    ...(archived ? { archived: true } : {}),
  }
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}

/**
 * Archives (`archived: true`) or restores (the key removed entirely) a workspace — the write half
 * of #223's archive/restore for a workspace. Nothing is deleted: the entry, its
 * organization/project/repository, `owner`, `ticketingSystem`, `baseUrl` and its assigned
 * workspace number (lib/numberRegistry.js) all stay exactly as they were, so `restoreWorkspace`
 * brings the workspace back to precisely the state it was archived from. The entry is rebuilt in
 * the same canonical key order `registerWorkspace`/`updateWorkspace` use, with `archived` (when
 * set) always last.
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
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  // Object.hasOwn — see resolveWorkspace's own comment on why the `in` operator would be wrong here.
  if (!Object.hasOwn(entries, id)) {
    throw new Error(`Unknown workspace "${id}"`)
  }
  const { organization, project, repository, baseUrl, owner = '', ticketingSystem } = entries[id]
  entries[id] = {
    organization,
    project,
    repository,
    ...(baseUrl ? { baseUrl } : {}),
    owner,
    ticketingSystem,
    ...(archived ? { archived: true } : {}),
  }
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}
