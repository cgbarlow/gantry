import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { listVersionNumbers, listDefinitions } from './definition.js'
import { listServerWorkspaces } from './workspaceDirectory.js'
import { isValidSlug } from './slug.js'

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
  if (!includeWorkspaces) return rows
  for (const workspace of listServerWorkspaceHomes(instancesDir)) {
    const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, workspace.id)
    const workspaceRows = listDefinitions({ definitionsDir: workspaceDefinitionsDir, includeArchived }).map((row) => ({
      ...row,
      home: { kind: 'server-workspace', id: workspace.id, name: workspace.name },
    }))
    rows.push(...workspaceRows)
  }
  return rows
}

/**
 * Which physical `definitionsDir` actually holds `definitionId` right now: the library if it's there,
 * else the first server workspace (in `id` order) whose own `definitions/` folder has it, else `null`
 * if it's in neither — which, given the uniqueness guard below, means it either doesn't exist at all
 * or lives in an Azure DevOps workspace this local-only search can't see (a caller that also wants to
 * check those needs `lib/definitionAzureDevOps.js` with real credentials).
 *
 * This is what lets every existing `:id`-keyed definitions route (versions, templates, reference-docx,
 * changelog, archive/restore, publish — all already parametrized on a plain `definitionsDir` string)
 * serve a workspace definition with no change beyond calling this first: an id can only ever live in
 * one place, so there's nothing for the caller to disambiguate.
 */
export function findDefinitionHomeDefinitionsDir(definitionId, { definitionsDir = 'definitions', instancesDir = 'instances' } = {}) {
  if (definitionIdExistsIn(definitionsDir, definitionId)) return definitionsDir
  for (const workspace of listServerWorkspaceHomes(instancesDir)) {
    const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, workspace.id)
    if (definitionIdExistsIn(workspaceDefinitionsDir, definitionId)) return workspaceDefinitionsDir
  }
  return null
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
