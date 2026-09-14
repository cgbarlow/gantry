import { join } from 'node:path'
import { existsSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { listVersionNumbers, listDefinitions, buildDefinitionYamlObject } from './definition.js'
import { listServerWorkspaces } from './workspaceDirectory.js'
import { isValidSlug } from './slug.js'
import { listLibraryRepos } from './librarySettings.js'
import { libraryRepoDefinitionsDir, isLibraryRepoDefinitionsDir } from './libraryCache.js'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'

/**
 * WI #383 (Definition Editor phase 3, ADR-0036) — a **definition home** is either the server
 * library (the packaged `definitions/` directory) or a workspace's own `definitions/` folder, laid
 * out and lifecycle-managed identically (`lib/definition.js`'s functions already take a plain
 * `definitionsDir` string and don't care what it's a path *into*, which is what makes reusing them
 * for a workspace's own folder possible with no change to that module).
 *
 * This module answers the questions specific to there being more than one home: where is a server
 * workspace's `definitions/` folder, what does "every definition available right now" mean across
 * homes, which single home (if any) already holds a given id, and — the enforcement half of "ids
 * are unique across the server library and every workspace; no shadowing" (ADR-0036) — whether a
 * *new* id is actually free to take before anything is written.
 *
 * Deliberately local-filesystem only: a server workspace's `definitions/` folder is always readable
 * without credentials, exactly like the library. An Azure DevOps workspace's `definitions/` folder
 * lives in that workspace's own repo and needs a caller-supplied PAT and a network round trip to
 * read at all — resolving *those* is `lib/definitionAzureDevOps.js`'s job, not this module's; the
 * uniqueness guard below still takes their ids into account, but only when a caller that already has
 * them (because it just listed that one workspace itself) passes them in via `extraKnownIds`.
 */

/** A server workspace's `definitions/` folder, given the workspaces root and that workspace's own folder name. */
export function serverWorkspaceDefinitionsDir(instancesDir, workspaceFolder) {
  return join(instancesDir, workspaceFolder, 'definitions')
}

/**
 * Every server workspace gantry can see locally (no credentials needed), as `{ id, name,
 * description }` sorted by id — `id` is the workspace's own folder name under `instancesDir`
 * (`lib/instanceRegistry.js`'s directory scope id, once passed through
 * `scopeIdForDirectoryFolder`/`directoryFolderForScopeId` at the call site — this module doesn't
 * concern itself with that mapping, only with "here is a workspace folder and here is its
 * `definitions/` subfolder"). A workspace whose `workspace.json` fails to parse
 * (`listServerWorkspaces` reports it as `{ id, error }`) is skipped rather than thrown on, the same
 * "one bad entry doesn't take the whole listing down" contract `listServerWorkspaces` itself
 * documents.
 */
export function listServerWorkspaceHomes(instancesDir) {
  return listServerWorkspaces(instancesDir)
    .filter((entry) => !entry.error)
    .map((entry) => ({ id: entry.id, name: entry.record?.name ?? entry.id, description: entry.record?.description ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Whether `id` already exists (any version, draft or published, archived or not — "exists at all" is
// what matters for a uniqueness check) directly under `definitionsDir`, without paying for a full
// `loadDefinition` of it. Exported so a caller (lib/server.js's `POST /api/definitions`) can tell a
// collision in the home it's actually writing to — the pre-existing "already exists" 400, unchanged —
// apart from a collision somewhere else, which is what `assertDefinitionIdAvailable` below reports as
// the new 409 "no shadowing" conflict.
export function definitionIdExistsIn(definitionsDir, id) {
  if (!existsSync(definitionsDir)) return false
  if (listVersionNumbers(id, definitionsDir).length > 0) return true
  return existsSync(join(definitionsDir, id, 'definition.yaml'))
}

/**
 * Every definition available right now, across the server library and (when `includeWorkspaces`)
 * every locally-visible server workspace — the flat, `home`-tagged list the Definitions page's
 * switcher groups by home and the "+ New Workspace" wizard's definition picker unions with the
 * library (ADR-0036's "exactly one such list, because ids are unique by construction"). Each row is
 * exactly `listDefinitions`'s own row shape plus one added field:
 *
 * - `home: { kind: 'library' }` for a server-library row;
 * - `home: { kind: 'server-workspace', id, name }` for a row from server workspace `id`.
 *
 * Library rows come first (unchanged relative order/shape from a plain `listDefinitions` call, so
 * every existing caller of `GET /api/definitions` that ignores `includeWorkspaces` sees byte-for-byte
 * the same response it always has), then workspace rows grouped by workspace in `id` order.
 *
 * Azure DevOps workspaces are never included here — see this module's own doc comment on why.
 */
export function listDefinitionsAcrossHomes({ definitionsDir = 'definitions', instancesDir = 'instances', includeArchived = false, includeWorkspaces = false } = {}) {
  const rows = listDefinitions({ definitionsDir, includeArchived }).map((row) => ({ ...row, home: { kind: 'library' } }))
  if (includeWorkspaces) {
    for (const workspace of listServerWorkspaceHomes(instancesDir)) {
      const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, workspace.id)
      const workspaceRows = listDefinitions({ definitionsDir: workspaceDefinitionsDir, includeArchived }).map((row) => ({
        ...row,
        home: { kind: 'server-workspace', id: workspace.id, name: workspace.name },
      }))
      rows.push(...workspaceRows)
    }
  }
  // WI #386 (ADR-0036): every library-repo-sourced definition this call can see, unioned into "the
  // server library" — always, not gated behind `includeWorkspaces` (a library repo is a library
  // source, not a workspace one). With no library repos configured (the default, and every existing
  // caller's case until this ticket), `libraryRepoRowsWithProblems` finds nothing to add and this is
  // byte-for-byte the pre-existing return value — see this function's own tests.
  const { rows: libraryRepoRows } = libraryRepoRowsWithProblems(rows.map((r) => r.id), { instancesDir })
  rows.push(...libraryRepoRows)
  return rows
}

/**
 * The library-repo half of "the server library becomes the union of the packaged/configured
 * `definitions/` directory and every library repo's `definitions/` folder" (WI #386): every
 * currently-cached (`lib/libraryCache.js`'s mirrored `definitions/` directory) library-repo
 * definition whose id doesn't already clash with `existingIds` (every id `listDefinitionsAcrossHomes`
 * already knows about — the packaged directory and every server workspace) or with an id already
 * claimed by an *earlier* library repo in this same pass.
 *
 * "Ids must be unique across all sources; a clash is reported as a problem on the Definitions page
 * and the clashing repo copy is ignored" (WI #386) — enforced here by processing repos in
 * `listLibraryRepos`'s own insertion order (see that module's own doc comment on why that order is
 * stable and meaningful: first repo configured wins) and never overwriting an id already claimed.
 * This is also exactly `findDefinitionHomeDefinitionsDir` below's own tier order (library, then
 * workspaces, then library repos in this same order) — so a route resolving `definitionId` to a
 * physical directory always agrees with what this function reports as visible/ignored. A clash is
 * never a thrown error — every other repo, and every other definition in the *same* clashing repo,
 * still lists normally; only the one colliding id is dropped, reported once in `problems`.
 *
 * A repo with no mirror yet (never successfully refreshed — see lib/libraryCache.js) contributes no
 * rows and no problems: it simply isn't part of the library yet, exactly as if it hadn't been added
 * — "instances pinned to a library-repo definition keep working from the cache if the repo is
 * unreachable" only promises *existing* cached content keeps working, never that a never-yet-cached
 * repo appears anyway.
 *
 * Each returned row is `listDefinitions`'s own row shape (read straight off the mirror, exactly like
 * a library or workspace row) plus `home: { kind: 'library-repo', id, name }` and `readOnly: true` —
 * `lib/server.js`'s write routes gate on the *resolved definitionsDir* being under the library-cache
 * root (`lib/libraryCache.js`'s `isLibraryRepoDefinitionsDir`) to refuse a direct edit (WI #386:
 * "read-only in the editor ... no direct edit"), and the Definitions page groups/labels by `home`
 * the same way it already does for `'library'`/`'server-workspace'`.
 */
export function libraryRepoRowsWithProblems(existingIds, { instancesDir = 'instances' } = {}) {
  const seen = new Set(existingIds)
  const rows = []
  const problems = []
  for (const repo of listLibraryRepos({ instancesDir })) {
    const repoDefinitionsDir = libraryRepoDefinitionsDir(instancesDir, repo.id)
    if (!existsSync(repoDefinitionsDir)) continue // never successfully refreshed
    const repoName = `${repo.organization}/${repo.project}/${repo.repository}`
    for (const row of listDefinitions({ definitionsDir: repoDefinitionsDir })) {
      if (seen.has(row.id)) {
        problems.push({
          id: row.id,
          repoId: repo.id,
          repoName,
          message: `Definition "${row.id}" from library repo "${repoName}" was ignored — a definition with that id already exists.`,
        })
        continue
      }
      seen.add(row.id)
      rows.push({ ...row, home: { kind: 'library-repo', id: repo.id, name: repoName }, readOnly: true })
    }
  }
  return { rows, problems }
}

/** Every current library-repo clash — the Definitions page's problems banner (`GET /api/library-repos`) calls this against the ids `listDefinitionsAcrossHomes` itself already knows about, so it always agrees with what's actually listed. */
export function libraryRepoProblems({ definitionsDir = 'definitions', instancesDir = 'instances' } = {}) {
  const existingIds = listDefinitionsAcrossHomes({ definitionsDir, instancesDir, includeWorkspaces: true })
    .filter((r) => r.home?.kind !== 'library-repo')
    .map((r) => r.id)
  return libraryRepoRowsWithProblems(existingIds, { instancesDir }).problems
}

/**
 * Which physical `definitionsDir` actually holds `definitionId` right now: the library if it's there,
 * else the first server workspace (in `id` order) whose own `definitions/` folder has it, else the
 * first library repo (in configured order, WI #386) whose mirrored `definitions/` folder has it,
 * else `null` if it's in none of those — which, given the uniqueness guard below, means it either
 * doesn't exist at all or lives in an Azure DevOps workspace this local-only search can't see (a
 * caller that also wants to check those needs `lib/definitionAzureDevOps.js` with real credentials).
 *
 * This is what lets every existing `:id`-keyed definitions route (versions, templates, reference-docx,
 * changelog, archive/restore, publish, instance creation/status/rendering — every route already
 * parametrized on a plain `definitionsDir` string) serve a workspace *or a library-repo-cached*
 * definition with no change beyond calling this first: an id can only ever live in one place, so
 * there's nothing for the caller to disambiguate. A write route additionally needs to refuse a
 * library-repo-sourced id (WI #386: read-only) — see `lib/libraryCache.js`'s
 * `isLibraryRepoDefinitionsDir`, checked against the directory this function returns.
 */
export function findDefinitionHomeDefinitionsDir(definitionId, { definitionsDir = 'definitions', instancesDir = 'instances' } = {}) {
  if (definitionIdExistsIn(definitionsDir, definitionId)) return definitionsDir
  for (const workspace of listServerWorkspaceHomes(instancesDir)) {
    const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, workspace.id)
    if (definitionIdExistsIn(workspaceDefinitionsDir, definitionId)) return workspaceDefinitionsDir
  }
  for (const repo of listLibraryRepos({ instancesDir })) {
    const repoDefinitionsDir = libraryRepoDefinitionsDir(instancesDir, repo.id)
    if (definitionIdExistsIn(repoDefinitionsDir, definitionId)) return repoDefinitionsDir
  }
  return null
}

/** Whether `definitionId` currently resolves to a library-repo-sourced (cached, read-only) definition rather than the packaged library or a workspace — `lib/server.js`'s write routes gate on this to refuse a direct edit. */
export function isLibraryRepoSourcedId(definitionId, { definitionsDir = 'definitions', instancesDir = 'instances' } = {}) {
  const dir = findDefinitionHomeDefinitionsDir(definitionId, { definitionsDir, instancesDir })
  return dir !== null && isLibraryRepoDefinitionsDir(dir, instancesDir)
}

/**
 * Clones a library-repo-sourced definition's cached (mirrored) content into a real, writable
 * `targetDefinitionsDir` as a fresh draft v1 — the cross-directory counterpart of
 * `lib/definition.js`'s `cloneDefinition` (which only ever reads and writes within one
 * `definitionsDir`), since a library-repo definition's only home is `lib/libraryCache.js`'s mirror,
 * never `targetDefinitionsDir` itself. Otherwise identical to `cloneDefinition`'s own approach: copy
 * the source version directory wholesale (so every module file comes along unchanged), then rewrite
 * just `definition.yaml`'s own id/version/status. See lib/libraryCache.js's own doc comment for the
 * one known gap this inherits: artefact templates/reference-docx aren't mirrored yet, so a cloned
 * artefact's `template` field carries over as text with no backing file.
 */
export function cloneFromLibraryRepoMirror(sourceId, newId, targetDefinitionsDir, { instancesDir = 'instances' } = {}) {
  let sourceDefinitionsDir = null
  for (const repo of listLibraryRepos({ instancesDir })) {
    const dir = libraryRepoDefinitionsDir(instancesDir, repo.id)
    if (definitionIdExistsIn(dir, sourceId)) {
      sourceDefinitionsDir = dir
      break
    }
  }
  if (!sourceDefinitionsDir) {
    throw new Error(`Unknown definition "${sourceId}"`)
  }
  if (!isValidSlug(newId)) {
    throw new Error(`Invalid slug "${newId}"`)
  }
  const newDir = join(targetDefinitionsDir, newId)
  if (existsSync(newDir)) {
    throw new Error(`Definition "${newId}" already exists`)
  }
  const versions = listVersionNumbers(sourceId, sourceDefinitionsDir)
  const srcVersion = Math.max(...versions) // exactly one version is ever mirrored — the latest published.
  const srcDir = join(sourceDefinitionsDir, sourceId, String(srcVersion))
  const dstDir = join(newDir, '1')
  cpSync(srcDir, dstDir, { recursive: true })
  const raw = parseYAML(readFileSync(join(dstDir, 'definition.yaml'), 'utf8'))
  const newObj = buildDefinitionYamlObject(newId, 1, 'draft', raw, raw)
  newObj.id = newId
  writeFileSync(join(dstDir, 'definition.yaml'), stringifyYAML(newObj))
  writeFileSync(join(dstDir, 'CHANGELOG.md'), `## v1\n\nDraft. Cloned from a library repo's "${sourceId}".\n`)
  return { id: newId }
}

/** Thrown by `assertDefinitionIdAvailable` — carries `.conflict = true` so a caller (lib/server.js) can map it to 409 without string-matching the message, the same convention `err.problems`/`err.compileError` elsewhere in this codebase use for a typed-but-lightweight error signal. */
export class DefinitionIdConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DefinitionIdConflictError'
    this.conflict = true
  }
}

/**
 * The write-time half of ADR-0036's "ids are unique across the server library and every workspace; no
 * shadowing": throws `DefinitionIdConflictError` if `newId` already exists anywhere this call can see
 * — the library, every local server workspace, or `extraKnownIds` (a caller's own already-fetched set,
 * for a home this module can't scan itself: an Azure DevOps workspace's own existing ids, supplied by
 * `lib/definitionAzureDevOps.js`'s caller after it lists that one workspace with real credentials —
 * see this module's own doc comment on why Azure DevOps workspaces aren't scanned here directly).
 *
 * Also rejects a structurally invalid slug (matching `createBlankDefinition`/`cloneDefinition`'s own
 * guard) before doing any of that scanning, so a bad id is a plain validation error, never reported as
 * a false "conflict".
 */
export function assertDefinitionIdAvailable(newId, { definitionsDir = 'definitions', instancesDir = 'instances', extraKnownIds = [] } = {}) {
  if (!isValidSlug(newId)) {
    throw new Error(`Invalid slug "${newId}"`)
  }
  if (definitionIdExistsIn(definitionsDir, newId)) {
    throw new DefinitionIdConflictError(`Definition "${newId}" already exists in the server library`)
  }
  for (const workspace of listServerWorkspaceHomes(instancesDir)) {
    const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, workspace.id)
    if (definitionIdExistsIn(workspaceDefinitionsDir, newId)) {
      throw new DefinitionIdConflictError(`Definition "${newId}" already exists in workspace "${workspace.name}"`)
    }
  }
  // WI #386: a library repo's cached ids are part of "no shadowing" too — a newly created definition
  // must not silently shadow one already visible from a library repo.
  const clashingRepoRow = libraryRepoRowsWithProblems([], { instancesDir }).rows.find((r) => r.id === newId)
  if (clashingRepoRow) {
    throw new DefinitionIdConflictError(`Definition "${newId}" already exists in library repo "${clashingRepoRow.home.name}"`)
  }
  if (extraKnownIds.includes(newId)) {
    throw new DefinitionIdConflictError(`Definition "${newId}" already exists`)
  }
}

/**
 * Instance loading's own half of ADR-0036 ("instance loading resolves the pinned definition/
 * definitionVersion from the workspace first, then falls back to the library"): the `definitionsDir`
 * a directory-backed instance's own definition should load from. `scopeId` is the same opaque scope
 * token `lib/server.js`'s per-request routes already resolve for the instance itself (`undefined`/the
 * reserved local scope for an unscoped or default-workspace instance, an Azure DevOps workspace's uuid
 * for one of those — neither of which names a real folder under `instancesDir`, so the existence check
 * below naturally falls through to the library for both) and `toFolder` is
 * `lib/instanceRegistry.js`'s `directoryFolderForScopeId`, passed in rather than imported here to keep
 * this module's only dependency on instance/workspace *scoping* (as opposed to definition *homes*) at
 * the call site, where the rest of that mapping already lives.
 */
export function definitionsDirForInstanceScope(definitionId, { definitionsDir = 'definitions', instancesDir = 'instances', scopeId, toFolder } = {}) {
  if (!scopeId || !toFolder) return definitionsDir
  const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, toFolder(scopeId))
  return definitionIdExistsIn(workspaceDefinitionsDir, definitionId) ? workspaceDefinitionsDir : definitionsDir
}
