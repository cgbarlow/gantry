import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { DEFAULT_PROVIDER, assertValidProvider, normalizeProviderLocation, providerLocationsMatch } from './provider.js'

/**
 * WI #386 (Feature #380 phase 6, ADR-0036): Global Settings' list of **library repos** — repos an
 * author adds as additional read sources for the server library, alongside the packaged/configured
 * `definitions/` directory (`lib/libraryCache.js` does the actual reading and caching;
 * `lib/definitionHome.js`'s `libraryRepoRowsWithProblems` does the union + id-uniqueness enforcement
 * this list feeds).
 *
 * Persisted the same way `lib/workspaceRegistry.js` persists workspaces: a single JSON file,
 * colocated inside `instancesDir` (the workspaces root — not committed to git, see .gitignore),
 * read fresh on every call rather than cached in memory, so concurrent callers (multiple requests
 * against the same running server) always see the latest persisted state.
 *
 * No PAT is stored here, and none ever will be by this module's own design — a library repo is
 * read with **the server's own PAT**, one per provider (ADR-0039), resolved once at server startup
 * and threaded through `lib/libraryCache.js`, never a per-browser credential. That's a deliberate
 * departure from `lib/workspaceRegistry.js`'s "PAT storage remains client-only" note: a library repo
 * is read by the *server itself* — at startup, before any browser request exists at all — so there
 * is no request to carry a caller's PAT on in the first place.
 *
 * **Provider and nested location (ticket #3, ADR-0037):** a record's canonical stored shape is
 * `{ provider, location, codeOwner?, addedAt }`, `location` discriminated by `provider` — see
 * `lib/provider.js`, and `lib/workspaceRegistry.js`'s identical treatment. A pre-#3 flat record
 * (`{ organization, project, repository, baseUrl?, codeOwner?, addedAt }`, no `provider`/`location`
 * keys of its own) is read forward as `provider: 'azure-devops'` with those fields lifted into
 * `location`, the same auto-backfill-on-read convention every registry here already follows. No
 * one-shot boot migration — an interrupted upgrade leaves a tolerant reader, not a half-written file.
 *
 * Every function still accepts (and every returned record still carries) the pre-#3 flat
 * `organization`/`project`/`repository`/`baseUrl` fields for an Azure DevOps library repo — no
 * consumer is migrated by this ticket. A caller that wants a GitHub library repo, or wants to
 * address a record by its nested shape explicitly, passes `{ provider, location }` instead.
 *
 * Repos are kept in insertion order (never re-sorted) — `Object.keys`/`JSON.stringify`/`.parse`
 * preserve a plain object's non-numeric-string key insertion order, the same guarantee
 * `lib/workspaceRegistry.js`'s own `listWorkspaceIdsInStorageOrder` relies on. This is what makes
 * "first repo configured wins" a well-defined, stable clash-resolution rule for
 * `libraryRepoRowsWithProblems` (WI #386's "report it as a problem ... and ignore the clashing
 * repo's copy") rather than depending on filesystem/JSON key ordering that happened to fall out of
 * an unspecified iteration order.
 */

const LIBRARY_REPOS_FILENAME = 'library-repos.json'

function libraryReposPathFor(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  return options.libraryReposPath ?? join(instancesDir, LIBRARY_REPOS_FILENAME)
}

// Tolerates a registry file that doesn't exist yet — not an error, just no library repos configured
// (mirrors lib/workspaceRegistry.js's own readRegistryFile).
function readReposFile(path) {
  if (!storage.exists(path)) return {}
  const text = storage.readText(path)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function writeReposFile(path, entries) {
  storage.writeText(path, JSON.stringify(entries, null, 2) + '\n')
}

// True when `input` already names its provider/location explicitly (the new #3 shape) rather than
// carrying flat organization/project/repository fields directly (the pre-#3 shape every existing
// caller still uses) — mirrors `lib/workspaceRegistry.js`'s identical `isNestedInput`.
function isNestedInput(input) {
  return Boolean(input) && typeof input === 'object' && input.location !== undefined && input.location !== null
}

function normalizeRepoInput(input) {
  const source = input ?? {}
  const codeOwner = source.codeOwner
  if (isNestedInput(source)) {
    const provider = source.provider ?? DEFAULT_PROVIDER
    assertValidProvider(provider)
    const location = normalizeProviderLocation(provider, source.location, { entityLabel: 'A library repo location' })
    return { provider, location, codeOwner }
  }
  const location = normalizeProviderLocation(
    DEFAULT_PROVIDER,
    { organization: source.organization, project: source.project, repository: source.repository, baseUrl: source.baseUrl },
    { entityLabel: 'A library repo' }
  )
  return { provider: DEFAULT_PROVIDER, location, codeOwner }
}

// True when `value` looks like a pre-#3 flat-shape record (organization/project/repository directly
// on the record) rather than the current `{ provider, location }` shape.
function looksLikeFlatLegacyRecord(value) {
  return Boolean(value) && typeof value === 'object' && value.provider === undefined && typeof value.organization === 'string'
}

// Lifts every pre-#3 flat record in `entries` into the current `{ provider, location, codeOwner?,
// addedAt }` shape, in place. Returns whether anything changed — mirrors
// `lib/workspaceRegistry.js`'s identical `migrateLegacyFlatShape`.
function migrateLegacyFlatShape(entries) {
  let changed = false
  for (const id of Object.keys(entries)) {
    const legacy = entries[id]
    if (!looksLikeFlatLegacyRecord(legacy)) continue

    const { organization, project, repository, baseUrl, codeOwner, addedAt } = legacy
    entries[id] = {
      provider: DEFAULT_PROVIDER,
      location: { organization, project, repository, ...(baseUrl ? { baseUrl } : {}) },
      ...(codeOwner ? { codeOwner } : {}),
      addedAt,
    }
    changed = true
  }
  return changed
}

function loadWithBackfill(options) {
  const path = libraryReposPathFor(options)
  const entries = readReposFile(path)
  const changed = migrateLegacyFlatShape(entries)
  if (changed) {
    writeReposFile(path, entries)
  }
  return { entries, path }
}

// The public record: the nested `provider`/`location` shape, plus — for an Azure DevOps library repo
// only — the pre-#3 flat `organization`/`project`/`repository`/`baseUrl` fields denormalized back
// onto the top level, so `repo.organization` etc. keep working for every existing caller (ticket #3:
// "flat accessors still work; no consumer is migrated"). A GitHub library repo has no flat-shape
// precedent to be compatible with, so it carries only the nested shape.
function toPublicRepo(id, record) {
  const flatAliases = record.provider === 'azure-devops' ? { ...record.location } : {}
  return {
    id,
    provider: record.provider,
    location: { ...record.location },
    ...flatAliases,
    ...(record.codeOwner ? { codeOwner: record.codeOwner } : {}),
    addedAt: record.addedAt,
  }
}

/**
 * Every configured library repo, in the order they were added (see this module's own doc comment
 * on why that order matters).
 */
export function listLibraryRepos(options = {}) {
  const { entries } = loadWithBackfill(options)
  return Object.keys(entries).map((id) => toPublicRepo(id, entries[id]))
}

/** Resolves a library repo by id. `undefined` if unknown. */
export function resolveLibraryRepo(id, options = {}) {
  const { entries } = loadWithBackfill(options)
  // Object.hasOwn (not `in`) — see lib/workspaceRegistry.js's resolveWorkspace for why: `entries` is
  // a plain object parsed straight off disk, so an id like '__proto__' would otherwise match an
  // inherited property rather than correctly reporting "unknown".
  if (!Object.hasOwn(entries, id)) return undefined
  return toPublicRepo(id, entries[id])
}

/**
 * Registers a new library repo — always a fresh id, even for a provider/location already configured
 * (a caller that wants "don't add a duplicate" checks `listLibraryRepos` itself first; this module
 * doesn't guess at de-duplication the way `lib/workspaceRegistry.js`'s `getOrCreateWorkspace` does
 * for workspaces, since two library repos pointed at the same location would just read the same
 * content twice — harmless, if pointless — rather than the identity confusion a workspace's own
 * instance data would risk).
 *
 * Accepts either shape (see this module's doc comment): the pre-#3 flat
 * `{ organization, project, repository, baseUrl?, codeOwner? }` (always `provider: 'azure-devops'`),
 * or the #3 nested `{ provider, location, codeOwner? }`.
 *
 * `codeOwner` (WI #387, ADR-0036's Promote section) is optional, free-text-as-typed — a display
 * name, unique name, or email, resolved against the provider's own identity directory only at the
 * moment a Promote actually opens a Pull Request (`lib/definitionPromote.js`, mirroring how
 * `lib/stageApproval.js` resolves a workspace's `owner`), never validated here. Left unset, a
 * promotion to this repo opens its Pull Request with no required reviewer attached — the same
 * backwards-compatible "unconfigured means no required reviewer" posture #145 gave the sign-off
 * flow's own Owner field.
 */
export function addLibraryRepo(location, options = {}) {
  const { provider, location: normalizedLocation, codeOwner } = normalizeRepoInput(location)
  const { entries, path } = loadWithBackfill(options)
  const id = randomUUID()
  entries[id] = {
    provider,
    location: normalizedLocation,
    ...(codeOwner ? { codeOwner } : {}),
    addedAt: new Date().toISOString(),
  }
  writeReposFile(path, entries)
  return toPublicRepo(id, entries[id])
}

/**
 * Updates an existing library repo's `codeOwner` (WI #387) — the one field Settings lets an author
 * edit after adding a repo, mirroring `lib/workspaceRegistry.js`'s narrower `updateWorkspace`
 * surface (that module's own "changing organization/project/repository would re-point an already-
 * established location, out of scope" reasoning applies here too: a location that turns out wrong is
 * removed and re-added, not edited in place). Pass `''`/`null` to clear it. Throws if `id` is
 * unknown, the same "caller's job to pass a real id" contract `resolveLibraryRepo` already documents.
 */
export function updateLibraryRepoCodeOwner(id, codeOwner, options = {}) {
  const { entries, path } = loadWithBackfill(options)
  if (!Object.hasOwn(entries, id)) {
    throw new Error(`Unknown library repo "${id}"`)
  }
  const next = { ...entries[id] }
  if (codeOwner && codeOwner.trim()) {
    next.codeOwner = codeOwner.trim()
  } else {
    delete next.codeOwner
  }
  entries[id] = next
  writeReposFile(path, entries)
  return toPublicRepo(id, next)
}

/** Removes a library repo. Idempotent — removing an id already gone is a no-op success. Its on-disk cache (`lib/libraryCache.js`) is a separate concern for the caller to clean up, not this function's job. */
export function removeLibraryRepo(id, options = {}) {
  const { entries, path } = loadWithBackfill(options)
  delete entries[id]
  writeReposFile(path, entries)
}

/**
 * Finds an existing library repo with this exact provider + location tuple, or `undefined` if none
 * is registered yet. Accepts either input shape — flat input always means `provider: 'azure-devops'`.
 * Matching is scoped to that one provider (ADR-0037), mirroring `lib/workspaceRegistry.js`'s own
 * `findWorkspaceByLocation`. Not used by any existing caller (this ticket adds it only because the
 * acceptance criteria calls for provider-scoped find-by-location on both registries) — a future
 * caller wanting "don't add a duplicate" can use it instead of scanning `listLibraryRepos` itself.
 */
export function findLibraryRepoByLocation(location, options = {}) {
  const source = location ?? {}
  const provider = isNestedInput(source) ? (source.provider ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER
  const queryLocation = isNestedInput(source)
    ? (source.location ?? {})
    : { organization: source.organization, project: source.project, repository: source.repository, baseUrl: source.baseUrl }
  const { entries } = loadWithBackfill(options)
  const match = Object.entries(entries).find(
    ([, repo]) => repo.provider === provider && providerLocationsMatch(provider, repo.location, queryLocation)
  )
  return match ? toPublicRepo(match[0], match[1]) : undefined
}
