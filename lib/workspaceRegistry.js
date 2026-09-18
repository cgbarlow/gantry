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

// docs/adr/0037: a **Provider** is the external suite supplying both a workspace's content store and
// its work-item tracker — 'azure-devops' and 'github' are built, 'atlassian' is modeled-but-unavailable
// (Bitbucket + Jira, shown in the wizard as a known-but-unselectable option). `PROVIDERS` is the full
// enum (mirrors `TICKETING_SYSTEMS`'s own "modeled vs. supported" split above); `AVAILABLE_PROVIDERS` is
// what `assertValidProvider` actually accepts today.
//
// #8 is a narrower slice of ADR-0037 than the full nested `{ provider, location }` shape #3 will land
// (that ticket was still unmerged when this one shipped — see this ticket's own commit message) —
// `provider` is genuinely new and persisted, but only for a workspace that sets one explicitly. A
// workspace registered the pre-#8 way (no `provider` field at all, the shape every existing
// azure-devops-only test and caller already depends on byte-for-byte) is still read forward as
// `provider: 'azure-devops'` by `toPublicWorkspace` below, exactly per ADR-0037's read-forward
// convention — it is just never *rewritten* onto disk with an explicit `provider` key by this ticket's
// own code, so the on-disk shape for an azure-devops workspace is unchanged. A GitHub workspace's own
// repo-owner is stored as `repoOwner`, not `owner` — this module's existing `owner` field is the
// workspace's Owner *person* (docs/adr's own "+ New Workspace wizard" entry), a different thing GitHub's
// `{owner, repository}` location shape would otherwise collide with under the same key.
export const PROVIDERS = ['azure-devops', 'github', 'atlassian']
export const AVAILABLE_PROVIDERS = ['azure-devops', 'github']
export const DEFAULT_PROVIDER = 'azure-devops'

export function assertValidProvider(value) {
  if (!PROVIDERS.includes(value)) {
    throw new Error(`Unknown provider "${value}" — expected one of: ${PROVIDERS.join(', ')}`)
  }
  if (!AVAILABLE_PROVIDERS.includes(value)) {
    throw new Error(`Provider "${value}" is not available yet — only ${AVAILABLE_PROVIDERS.join(', ')} is available today`)
  }
}

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

function assertValidWorkspaceFields({ provider, organization, project, repository, repoOwner, ticketingSystem }) {
  if (provider === 'github') {
    const missing = ['repoOwner', 'repository'].filter((key) => !{ repoOwner, repository }[key])
    if (missing.length) {
      // Reported with the wizard's own field names (Owner/Repository), not the internal `repoOwner` key.
      throw new Error(`A workspace is missing: ${missing.map((key) => (key === 'repoOwner' ? 'owner' : key)).join(', ')}`)
    }
    // GitHub has no ticketing-system choice — the provider itself is the suite (docs/adr/0037).
    return
  }
  const missing = ['organization', 'project', 'repository'].filter(
    (key) => !{ organization, project, repository }[key]
  )
  if (missing.length) {
    throw new Error(`A workspace is missing: ${missing.join(', ')}`)
  }
  assertValidTicketingSystem(ticketingSystem)
}

// Enriches a raw stored record with a `provider` for any consumer that wants it, without changing
// what's actually persisted for a pre-#8 (or plain azure-devops) record — read-forward per
// ADR-0037, scoped to this one field rather than the full nested-location shape #3 introduces.
function toPublicWorkspace(id, record) {
  return { id, ...record, provider: record.provider ?? DEFAULT_PROVIDER }
}

// Builds the location part of the record to persist for `provider` — kept separate from
// registerWorkspace/updateWorkspace/setWorkspaceArchived so all three build the exact same shape,
// field order included: those three each append `owner` (and, for azure-devops, `ticketingSystem`,
// and — if set — `archived`) themselves, in that order, matching the field order the pre-#8 disk
// format already committed tests to (`organization, project, repository, baseUrl?, owner,
// ticketingSystem, archived?`). Deliberately omits `provider` itself from the returned object for
// 'azure-devops' — see the PROVIDERS doc comment above for why that still-tested-byte-for-byte disk
// shape must stay provider-less.
function buildLocationFields({ provider, organization, project, repository, repoOwner, baseUrl }) {
  if (provider === 'github') {
    return { provider, repoOwner, repository, ...(baseUrl ? { baseUrl } : {}) }
  }
  return { organization, project, repository, ...(baseUrl ? { baseUrl } : {}) }
}

// Assembles a full entry (location + owner + provider-specific tail + archived) in the canonical
// field order every write path shares. `archived` is only ever appended when true, and always last,
// so re-registering/updating never accidentally un-archives (or reorders) an existing entry.
function buildWorkspaceEntry({ provider, organization, project, repository, repoOwner, baseUrl, owner, ticketingSystem, archived }) {
  const location = buildLocationFields({ provider, organization, project, repository, repoOwner, baseUrl })
  const tail = provider === 'github' ? { owner } : { owner, ticketingSystem }
  return { ...location, ...tail, ...(archived ? { archived: true } : {}) }
}

/**
 * Registers a brand new workspace, always generating a fresh id — even if a workspace for the same location already exists. Callers that want "find the existing one, or create it" (the auto-backfill case, and any other caller that shouldn't create duplicates for the same repo) should use `getOrCreateWorkspace` instead.
 *
 * `provider` defaults to `DEFAULT_PROVIDER` ('azure-devops') when omitted (docs/adr/0037, #8) — an azure-devops workspace takes `organization`/`project`/`repository`(+`baseUrl`); a github workspace takes `repoOwner`/`repository`(+`baseUrl`) instead, and has no ticketing-system choice of its own. `ticketingSystem` (azure-devops only) defaults to `DEFAULT_TICKETING_SYSTEM` when omitted; `owner` — the workspace's own Owner *person*, not to be confused with a GitHub location's repo owner (`repoOwner`) — defaults to `''` (unset), mirroring the instance registry's own "optional, blank until set" convention for owner-like fields.
 */
export function registerWorkspace(location, options = {}) {
  const {
    provider = DEFAULT_PROVIDER,
    organization,
    project,
    repository,
    repoOwner,
    baseUrl,
    owner = '',
    ticketingSystem = DEFAULT_TICKETING_SYSTEM,
  } = location ?? {}
  assertValidProvider(provider)
  assertValidWorkspaceFields({ provider, organization, project, repository, repoOwner, ticketingSystem })

  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)

  const id = randomUUID()
  entries[id] = buildWorkspaceEntry({ provider, organization, project, repository, repoOwner, baseUrl, owner, ticketingSystem })
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
 * Finds an existing workspace with this exact location tuple, or `undefined` if none is registered yet — organization/project/repository for azure-devops (the default `provider`), repoOwner/repository for github. `baseUrl` participates in the match either way (an on-prem/self-hosted repo with the same org-or-owner/project/repository names as a cloud one is a distinct workspace), compared as "absent" whether it's `undefined` or omitted so a caller that never mentions `baseUrl` still matches a workspace registered the same way. `provider` itself is always part of the match (docs/adr/0037's own "two workspaces on different providers that happen to share a repository name are recognised as distinct" acceptance criterion, #8) — a workspace with no stored `provider` at all is treated as `'azure-devops'`, the same read-forward `toPublicWorkspace` applies elsewhere.
 */
export function findWorkspaceByLocation(location, options = {}) {
  const { provider = DEFAULT_PROVIDER, organization, project, repository, repoOwner, baseUrl } = location ?? {}
  const registryPath = workspaceRegistryPathFor(options)
  const entries = readRegistryFile(registryPath)
  const match = Object.entries(entries).find(([, workspace]) => {
    if ((workspace.provider ?? DEFAULT_PROVIDER) !== provider) return false
    if ((workspace.baseUrl ?? undefined) !== (baseUrl ?? undefined)) return false
    if (provider === 'github') return workspace.repoOwner === repoOwner && workspace.repository === repository
    return workspace.organization === organization && workspace.project === project && workspace.repository === repository
  })
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
  const merged = { provider: DEFAULT_PROVIDER, ...entries[id], ...updates }
  assertValidProvider(merged.provider)
  assertValidWorkspaceFields(merged)
  const { provider, organization, project, repository, repoOwner, baseUrl, owner = '', ticketingSystem, archived } = merged
  // Preserved through an unrelated metadata edit (#223) — this rebuild is the canonical write path,
  // so `archived` has to be re-appended here or a plain owner/ticketing-system change would silently
  // un-archive the workspace. `buildWorkspaceEntry` always puts it last, keeping key order stable.
  entries[id] = buildWorkspaceEntry({ provider, organization, project, repository, repoOwner, baseUrl, owner, ticketingSystem, archived })
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
  const { provider = DEFAULT_PROVIDER, organization, project, repository, repoOwner, baseUrl, owner = '', ticketingSystem } = entries[id]
  entries[id] = buildWorkspaceEntry({ provider, organization, project, repository, repoOwner, baseUrl, owner, ticketingSystem, archived })
  writeRegistryFile(registryPath, entries)
  return toPublicWorkspace(id, entries[id])
}
