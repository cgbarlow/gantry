import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'

/**
 * WI #386 (Feature #380 phase 6, ADR-0036): Global Settings' list of **library repos** — Azure
 * DevOps repos an author adds as additional read sources for the server library, alongside the
 * packaged/configured `definitions/` directory (`lib/libraryCache.js` does the actual reading and
 * caching; `lib/definitionHome.js`'s `libraryRepoRowsWithProblems` does the union + id-uniqueness
 * enforcement this list feeds).
 *
 * Persisted the same way `lib/workspaceRegistry.js` persists workspaces: a single JSON file,
 * colocated inside `instancesDir` (the workspaces root — not committed to git, see .gitignore),
 * read fresh on every call rather than cached in memory, so concurrent callers (multiple requests
 * against the same running server) always see the latest persisted state.
 *
 * No PAT is stored here, and none ever will be by this module's own design — a library repo is
 * read with **the server's own PAT** (`GANTRY_LIBRARY_PAT`, resolved once at server startup by
 * `lib/server.js` and threaded through `lib/libraryCache.js`), never a per-browser credential.
 * That's a deliberate departure from `lib/workspaceRegistry.js`'s "PAT storage remains
 * client-only" note: a library repo is read by the *server itself* — at startup, before any
 * browser request exists at all — so there is no request to carry a caller's PAT on in the first
 * place.
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

function assertValidRepoLocation({ organization, project, repository }) {
  const missing = ['organization', 'project', 'repository'].filter((key) => !{ organization, project, repository }[key])
  if (missing.length) {
    throw new Error(`A library repo is missing: ${missing.join(', ')}`)
  }
}

function toPublicRepo(id, record) {
  return { id, ...record }
}

/**
 * Every configured library repo, in the order they were added (see this module's own doc comment
 * on why that order matters).
 */
export function listLibraryRepos(options = {}) {
  const path = libraryReposPathFor(options)
  const entries = readReposFile(path)
  return Object.keys(entries).map((id) => toPublicRepo(id, entries[id]))
}

/** Resolves a library repo by id. `undefined` if unknown. */
export function resolveLibraryRepo(id, options = {}) {
  const path = libraryReposPathFor(options)
  const entries = readReposFile(path)
  // Object.hasOwn (not `in`) — see lib/workspaceRegistry.js's resolveWorkspace for why: `entries` is
  // a plain object parsed straight off disk, so an id like '__proto__' would otherwise match an
  // inherited property rather than correctly reporting "unknown".
  if (!Object.hasOwn(entries, id)) return undefined
  return toPublicRepo(id, entries[id])
}

/**
 * Registers a new library repo — always a fresh id, even for an organization/project/repository
 * already configured (a caller that wants "don't add a duplicate" checks `listLibraryRepos` itself
 * first; this module doesn't guess at de-duplication the way `lib/workspaceRegistry.js`'s
 * `getOrCreateWorkspace` does for workspaces, since two library repos pointed at the same location
 * would just read the same content twice — harmless, if pointless — rather than the identity
 * confusion a workspace's own instance data would risk).
 *
 * `codeOwner` (WI #387, ADR-0036's Promote section) is optional, free-text-as-typed — a display
 * name, unique name, or email, resolved against Azure DevOps's own identity directory only at the
 * moment a Promote actually opens a Pull Request (`lib/definitionPromote.js`, mirroring how
 * `lib/stageApproval.js` resolves a workspace's `owner`), never validated here. Left unset, a
 * promotion to this repo opens its Pull Request with no required reviewer attached — the same
 * backwards-compatible "unconfigured means no required reviewer" posture #145 gave the sign-off
 * flow's own Owner field.
 */
export function addLibraryRepo(location, options = {}) {
  assertValidRepoLocation(location ?? {})
  const { organization, project, repository, baseUrl, codeOwner } = location
  const path = libraryReposPathFor(options)
  const entries = readReposFile(path)
  const id = randomUUID()
  entries[id] = {
    organization,
    project,
    repository,
    ...(baseUrl ? { baseUrl } : {}),
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
  const path = libraryReposPathFor(options)
  const entries = readReposFile(path)
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
  const path = libraryReposPathFor(options)
  const entries = readReposFile(path)
  delete entries[id]
  writeReposFile(path, entries)
}
