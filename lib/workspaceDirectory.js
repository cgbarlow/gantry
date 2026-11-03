import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { validateWorkspaceRecord, parseWorkspaceJson, serializeWorkspaceJson } from '../web/lib/localWorkspace.js'

/**
 * The server-side counterpart to `web/lib/localWorkspace.js`'s `workspace.json` handling (WI #355,
 * Feature 1 of 4 under Epic #34's "workspace directories" work — see docs/agents for the others).
 * A **server workspace** is the same shape a local workspace already is (ADR-0029): a folder holding
 * `workspace.json` at its root plus instance subdirectories — except this module reads and writes it
 * through `lib/storage.js` (the server's own filesystem access), not the browser's File System Access
 * API, so it works unattended on the box running `gantry serve`.
 *
 * This module deliberately reuses `validateWorkspaceRecord`/`parseWorkspaceJson`/`serializeWorkspaceJson`
 * from `web/lib/localWorkspace.js` rather than re-implementing the schema: that file's schema section has
 * no browser dependency (the browser-only pieces are the directory-handle/IndexedDB sections further
 * down, untouched here), so importing it directly is what makes "a folder opened as a local workspace and
 * a server workspace directory are byte-for-byte the same format" a fact the code enforces, not just a
 * design intention that could quietly drift. `tests/workspaceDirectory.test.js` proves the two are
 * interchangeable by writing with one side and reading with the other.
 *
 * **Additive only, as of WI #355**: nothing in this module is wired into real instance resolution yet —
 * no route, no CLI command, no registry consults it. That cutover (removing the legacy `kind: 'local'`
 * instance-registry entry, moving `instance-registry.json`/`workspace-registry.json`/`number-registry.json`
 * onto the workspaces root, and workspace-qualified addressing) is the next Feature, #356. Until then this
 * is a self-contained primitive with its own tests, safe to land without touching how `gantry serve`
 * actually resolves an instance today.
 */

const WORKSPACE_JSON_FILENAME = 'workspace.json'

/**
 * Resolves the workspaces root directory: `options.workspacesDir` > `GANTRY_WORKSPACES_DIR` env > the
 * literal `'workspaces'` — the exact same precedence `bin/gantry.js`'s `resolveInstancesDir` already uses
 * for `instancesDir`/`GANTRY_INSTANCES_DIR`/`'instances'`. Nothing yet defaults to this when `instancesDir`
 * is already configured (#356's job) — a caller that wants a workspaces root has to ask for one explicitly.
 */
export function resolveWorkspacesDir(options = {}) {
  return options.workspacesDir ?? process.env.GANTRY_WORKSPACES_DIR ?? 'workspaces'
}

function workspaceJsonPath(workspacesDir, workspaceId) {
  return join(workspacesDir, workspaceId, WORKSPACE_JSON_FILENAME)
}

/**
 * Reads and parses `<workspacesDir>/<workspaceId>/workspace.json`. Throws the same descriptive errors
 * `parseWorkspaceJson` does for invalid JSON or a structurally invalid record; throws with the raw
 * filesystem error (e.g. `ENOENT`, `code` intact) when the file itself is missing — callers that want to
 * check existence first should use `storage.exists` themselves, mirroring how `lib/instance.js`'s
 * `readInstance` leaves that distinction to its own callers rather than swallowing it.
 */
export function readWorkspaceJson(workspacesDir, workspaceId) {
  const text = storage.readText(workspaceJsonPath(workspacesDir, workspaceId))
  return parseWorkspaceJson(text)
}

/**
 * Validates and writes `record` to `<workspacesDir>/<workspaceId>/workspace.json`, creating the workspace
 * directory (and `workspacesDir` itself) if needed. Throws — and writes nothing — for a structurally
 * invalid record, exactly like `serializeWorkspaceJson` does; this never persists a `workspace.json` a
 * local workspace's own reader would reject.
 */
export function writeWorkspaceJson(workspacesDir, workspaceId, record) {
  const text = serializeWorkspaceJson(record)
  storage.ensureDir(join(workspacesDir, workspaceId))
  storage.writeText(workspaceJsonPath(workspacesDir, workspaceId), text)
}

/**
 * Every server workspace found directly under `workspacesDir`, as `[{ id, record }]` sorted by `id` — an
 * immediate subdirectory counts as a server workspace exactly when it has a `workspace.json` at its own
 * root, the same "presence of the marker file" test `lib/instance.js`'s `listInstanceSlugs` uses for
 * `instance.yaml`. A subdirectory with no `workspace.json` (someone's unrelated folder, or an instance
 * that hasn't been placed under a workspace) is silently skipped, not reported as an error.
 *
 * `workspacesDir` not existing yet — the common case before any server workspace has ever been created —
 * returns `[]` rather than throwing, matching every other registry in this codebase (`lib/instanceRegistry.js`,
 * `lib/workspaceRegistry.js`) treating "no file/directory yet" as an empty result, not a failure.
 *
 * A `workspace.json` that fails to parse is skipped with its error attached (`{ id, error }` instead of
 * `{ id, record }`) rather than throwing and losing every other, valid workspace in the same scan — the
 * caller can decide whether a malformed entry is worth surfacing.
 */
export function listServerWorkspaces(workspacesDir) {
  return storage
    .listDir(workspacesDir)
    .filter((name) => storage.exists(join(workspacesDir, name, WORKSPACE_JSON_FILENAME)))
    .sort()
    .map((id) => {
      try {
        return { id, record: readWorkspaceJson(workspacesDir, id) }
      } catch (err) {
        return { id, error: err.message }
      }
    })
}

// Folders gantry owns: the migrated `default` workspace (its own workspace number) and the bundled `examples`.
const RESERVED_WORKSPACE_FOLDERS = ['default', 'examples']
const MAX_WORKSPACE_NAME_LENGTH = 100
const MAX_WORKSPACE_DESCRIPTION_LENGTH = 500

/** Thrown by `createServerWorkspace` for a name or description it won't accept (the route answers 400). */
export class InvalidServerWorkspaceError extends Error {}

/** Thrown by `createServerWorkspace` when a server workspace already carries that name (the route answers 409). */
export class DuplicateServerWorkspaceError extends Error {}

/**
 * Checks the name and description a new server workspace was given and returns the trimmed name. Shared by the disk and the
 * Blob container ways of creating one (#269), so both refuse exactly the same input. Throws `InvalidServerWorkspaceError`.
 */
export function validateWorkspaceInput({ name, description } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new InvalidServerWorkspaceError('A workspace needs a name')
  }
  const trimmedName = name.trim()
  if (trimmedName.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new InvalidServerWorkspaceError(`A workspace name can be at most ${MAX_WORKSPACE_NAME_LENGTH} characters`)
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') throw new InvalidServerWorkspaceError('description must be a string')
    if (description.length > MAX_WORKSPACE_DESCRIPTION_LENGTH) {
      throw new InvalidServerWorkspaceError(`A workspace description can be at most ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters`)
    }
  }
  return { trimmedName }
}

// A workspace name -> the folder it lives in: lowercase letters, digits and single hyphens, which is safe on
// every filesystem and as a URL segment. A name with nothing usable in it ("!!!", or only non-Latin letters)
// falls back to "workspace" rather than an empty folder name. Mirrors the wizard's own `slugify`.
export function workspaceFolderFor(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'workspace'
}

/**
 * Creates a new server workspace on the server's disk (#268, docs/adr/0070): a folder under
 * `workspacesDir` holding a `workspace.json`, the same format a local workspace uses. Returns
 * `{ id, record }` where `id` is the new folder's name.
 *
 * The folder is derived from `name` and made unique by a numeric suffix (`risk-2`) when the obvious
 * one is taken. `default` and `examples` are never handed out: the first is the reserved workspace every
 * pre-workspace instance migrated into (its own workspace number, `MIGRATED_DEFAULT_WORKSPACE_FOLDER`), the
 * second is the bundled Examples. Two workspaces may not share a *name* though (compared without case) -
 * they would be indistinguishable on the dashboard - and that is refused instead of being quietly suffixed.
 *
 * Throws `InvalidServerWorkspaceError` for a missing, blank or over-long name, or a non-string/over-long
 * description, and `DuplicateServerWorkspaceError` for a name already in use. Nothing is written in
 * either case.
 */
export function createServerWorkspace(workspacesDir, { name, description } = {}) {
  const { trimmedName } = validateWorkspaceInput({ name, description })

  const existing = listServerWorkspaces(workspacesDir)
  const taken = existing.find((entry) => entry.record?.name.trim().toLowerCase() === trimmedName.toLowerCase())
  if (taken) throw new DuplicateServerWorkspaceError(`A workspace named "${taken.record.name}" already exists`)

  const base = workspaceFolderFor(trimmedName)
  let id = base
  for (let n = 2; RESERVED_WORKSPACE_FOLDERS.includes(id) || storage.exists(join(workspacesDir, id)); n++) id = `${base}-${n}`

  const record = {
    name: trimmedName,
    ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
    kind: 'local',
    createdAt: new Date().toISOString(),
  }
  writeWorkspaceJson(workspacesDir, id, record)
  return { id, record: readWorkspaceJson(workspacesDir, id) }
}

// Re-exported so a caller that only has `lib/workspaceDirectory.js` imported (the server side) can still
// validate a record shape without reaching into `web/lib/localWorkspace.js` directly — e.g. before calling
// `writeWorkspaceJson`, to report every problem at once instead of catching its thrown error.
export { validateWorkspaceRecord }
