// Client-side module for **local workspaces** (ADR-0029): an instance's data
// kept in a folder on the browser user's own machine, reached through the
// File System Access API and never seen by the gantry server.
//
// Layered like web/lib/credential.js / web/lib/advancedMode.js — a thin,
// framework-free module the rest of web/ imports. This is WI #293: schema +
// filesystem/IndexedDB layer + tests only. NOTHING under web/ (app.js,
// pages/, the wizard) wires this in yet — the wizard, dashboard and editor
// hooks land in later A-series tickets off Feature #290.
//
// Three concerns live here:
//   1. the portable `workspace.json` marker at the folder root
//      (`{ name, owner, kind: "local", createdAt }`) — parse / validate /
//      serialize;
//   2. acquiring and re-offering a `FileSystemDirectoryHandle` — the picker
//      wrapper, an `isSupported` gate, an IndexedDB-backed "recent local
//      workspaces" cache, and the permission (re-)grant flow;
//   3. reading and writing files under the `gantry-workspace/<slug>/…`
//      layout from the ADR, through a picked directory handle.

// ---------------------------------------------------------------------------
// 1. workspace.json schema
// ---------------------------------------------------------------------------

// `kind` in a local workspace's `workspace.json` is always exactly this —
// the marker that tells any Chromium browser picking the folder what it is.
// A server-hosted workspace's registry row has no `kind` at all, so a folder
// that is really a `git clone` of one will simply fail validation here.
export const LOCAL_WORKSPACE_KIND = 'local'

// Deliberately permissive ISO-8601: requires the date, the `T`, a wall time,
// and a zone designator (`Z` or `±HH:MM`) — which is exactly what
// `new Date().toISOString()` produces — but does not police leap seconds or
// calendar validity beyond what `Date.parse` already rejects.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isIsoDateString(value) {
  return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * Structural check for a parsed `workspace.json` object. Never throws —
 * returns `{ valid, errors }` so a caller (the wizard's "open existing
 * folder" step, later) can show every problem at once rather than the first.
 *
 * Rules (ADR-0029): `kind` must be exactly `"local"`; `name` is required and
 * must not be blank/whitespace-only; `description` is optional but must be a
 * string when present (WI #355 — a short human-facing subtitle, shown on the
 * dashboard in place of the generic "Server instance"/"Local workspace"
 * label once a caller sets one; never required, never defaulted); `owner` is
 * optional but must be a string when present; `createdAt` must be an ISO
 * date string.
 */
export function validateWorkspaceRecord(obj) {
  const errors = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['workspace.json must contain a JSON object'] }
  }
  if (obj.kind !== LOCAL_WORKSPACE_KIND) {
    errors.push(`kind must be exactly "${LOCAL_WORKSPACE_KIND}"`)
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    errors.push('name is required and must not be blank')
  }
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    errors.push('description, when present, must be a string')
  }
  if (obj.owner !== undefined && typeof obj.owner !== 'string') {
    errors.push('owner, when present, must be a string')
  }
  if (!isIsoDateString(obj.createdAt)) {
    errors.push('createdAt must be an ISO date string')
  }
  return { valid: errors.length === 0, errors }
}

/** Normalized record — stable key order, `description`/`owner` omitted when absent. */
function normalizeRecord(obj) {
  const record = { name: obj.name.trim(), kind: LOCAL_WORKSPACE_KIND, createdAt: obj.createdAt }
  if (obj.description !== undefined) record.description = obj.description
  if (obj.owner !== undefined) record.owner = obj.owner
  // Key order chosen for a readable on-disk file: name, description, owner, kind, createdAt.
  return {
    name: record.name,
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.owner !== undefined ? { owner: record.owner } : {}),
    kind: record.kind,
    createdAt: record.createdAt,
  }
}

/**
 * Parse the text of a `workspace.json` file into a validated, normalized
 * record. Throws `Error` for invalid JSON or a record that fails
 * `validateWorkspaceRecord` (message lists every problem).
 */
export function parseWorkspaceJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`workspace.json is not valid JSON: ${err.message}`)
  }
  const { valid, errors } = validateWorkspaceRecord(parsed)
  if (!valid) throw new Error(`invalid workspace.json: ${errors.join('; ')}`)
  return normalizeRecord(parsed)
}

/**
 * Serialize a record to the text to write at the folder root. Validates
 * first (throws on a bad record) so a malformed `workspace.json` can never
 * be written. Trailing newline, 2-space indent — matches how the rest of the
 * repo writes JSON.
 */
export function serializeWorkspaceJson(record) {
  const { valid, errors } = validateWorkspaceRecord(record)
  if (!valid) throw new Error(`cannot serialize invalid workspace record: ${errors.join('; ')}`)
  return `${JSON.stringify(normalizeRecord(record), null, 2)}\n`
}

// ---------------------------------------------------------------------------
// 2a. Directory-handle acquisition
// ---------------------------------------------------------------------------

/**
 * Whether this browser can host a local workspace at all — i.e. exposes the
 * File System Access API's `showDirectoryPicker`. Chromium-only (Chrome,
 * Edge) per ADR-0029; the wizard uses this to offer the Local option as
 * enabled vs. disabled-with-a-message. Evaluated once at module load.
 */
export const isSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

/**
 * Prompt the user to pick a folder for a local workspace, in read-write
 * mode. Thin wrapper over `window.showDirectoryPicker` — rejects (from the
 * browser) if the user dismisses the picker; throws a plain `Error` if the
 * API is not present at all (callers should gate on `isSupported` first).
 */
export async function pickWorkspaceDirectory() {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    throw new Error('showDirectoryPicker is not available in this browser')
  }
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

// ---------------------------------------------------------------------------
// 2b. Permission (re-)grant flow
// ---------------------------------------------------------------------------

/**
 * Ensure `handle` is usable in `mode` (`'readwrite'` by default). Queries
 * the current permission; if it is not already `'granted'`, asks for it.
 * Returns the final state — `'granted'`, `'prompt'` or `'denied'` — and
 * **never throws for a denial**: the caller shows a re-grant affordance off
 * the returned state instead. A handle stored in IndexedDB across a reload
 * comes back as `'prompt'` until the user re-confirms, which is the normal
 * path through here.
 */
export async function ensurePermission(handle, mode = 'readwrite') {
  const opts = { mode }
  const current = await handle.queryPermission?.(opts)
  if (current === 'granted') return 'granted'
  try {
    const requested = await handle.requestPermission?.(opts)
    return requested ?? 'denied'
  } catch {
    // A rejected requestPermission (e.g. the user dismissed the prompt) is a
    // denial from our callers' point of view, not an error to propagate.
    return 'denied'
  }
}

// ---------------------------------------------------------------------------
// 2c. Handle persistence — IndexedDB "recent local workspaces" cache
// ---------------------------------------------------------------------------
//
// A per-browser convenience cache only (ADR-0029): it holds the opaque
// `FileSystemDirectoryHandle` objects (the browser knows how to structured-
// clone these into IndexedDB) plus a name and a `lastOpened` stamp, so the
// picker can re-offer folders opened before. Never sent to the server; a
// different browser or machine starts empty and re-picks.

const DB_NAME = 'gantry-local-workspaces'
const STORE_NAME = 'workspaces'
const DB_VERSION = 1

// Tie-breaker for two workspaces stamped in the same millisecond (re-opening
// one right after another). Session-local and monotonic — combined with
// `lastOpened` as the primary sort key it just disambiguates a tie.
let writeSeq = 0

function getIndexedDB() {
  if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB
  return null
}

function openDb() {
  return new Promise((resolve, reject) => {
    const idb = getIndexedDB()
    if (!idb) {
      reject(new Error('IndexedDB is not available in this environment'))
      return
    }
    const request = idb.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function runTx(db, mode, work) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    let result
    Promise.resolve()
      .then(() => work(store))
      .then((value) => {
        result = value
      })
      .catch(reject)
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function withDb(fn) {
  const db = await openDb()
  try {
    return await fn(db)
  } finally {
    db.close()
  }
}

/**
 * Upsert a directory handle into the recent-workspaces cache and stamp it
 * `lastOpened = now`. Pass `id` to update an existing entry (its name is
 * kept unless a new one is given); omit `id` to add a new entry with a
 * generated `crypto.randomUUID()`. Returns the id.
 */
export async function rememberWorkspace({ id, handle, name } = {}) {
  if (!handle) throw new Error('rememberWorkspace requires a directory handle')
  return withDb(async (db) => {
    const existing = id ? await runTx(db, 'readonly', (store) => promisifyRequest(store.get(id))) : null
    const recordId = id ?? existing?.id ?? crypto.randomUUID()
    const record = {
      id: recordId,
      handle,
      name: name ?? existing?.name ?? handle.name ?? recordId,
      lastOpened: new Date().toISOString(),
      seq: (writeSeq += 1),
    }
    await runTx(db, 'readwrite', (store) => promisifyRequest(store.put(record)))
    return recordId
  })
}

/**
 * The recent local workspaces, most-recently-opened first, as
 * `[{ id, name, lastOpened }]`. The stored `FileSystemDirectoryHandle` is
 * deliberately not included — fetch it with `getWorkspaceHandle(id)` when a
 * folder is actually being opened. Returns `[]` when IndexedDB is
 * unavailable rather than throwing.
 */
export async function recentLocalWorkspaces() {
  if (!getIndexedDB()) return []
  return withDb(async (db) => {
    const all = await runTx(db, 'readonly', (store) => promisifyRequest(store.getAll()))
    return all
      .slice()
      .sort((a, b) => {
        const byTime = String(b.lastOpened ?? '').localeCompare(String(a.lastOpened ?? ''))
        return byTime !== 0 ? byTime : (b.seq ?? 0) - (a.seq ?? 0)
      })
      .map(({ id, name, lastOpened }) => ({ id, name, lastOpened }))
  })
}

/**
 * The stored `FileSystemDirectoryHandle` for a remembered workspace, or
 * `null` if there is no such entry. Callers still run `ensurePermission`
 * on it before use.
 */
export async function getWorkspaceHandle(id) {
  return withDb(async (db) => {
    const record = await runTx(db, 'readonly', (store) => promisifyRequest(store.get(id)))
    return record?.handle ?? null
  })
}

/** Drop a workspace from the recent cache. No-op if the id is unknown. */
export async function forgetWorkspace(id) {
  return withDb((db) => runTx(db, 'readwrite', (store) => promisifyRequest(store.delete(id))))
}

// ---------------------------------------------------------------------------
// 3. File ops over the gantry-workspace/<slug>/… layout
// ---------------------------------------------------------------------------
//
// `path` is always a `/`-joined path relative to the picked root directory
// handle. Absolute paths and any `..` segment are rejected before a single
// handle is resolved — a hosted gantry must never be able to walk a local
// workspace folder outside the folder the user picked.

function splitPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('path must be a non-empty relative path')
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`path must be relative, got: ${path}`)
  }
  if (/^[A-Za-z]:/.test(path)) {
    throw new Error(`path must be relative, got a drive-letter path: ${path}`)
  }
  const segments = path.split(/[/\\]/).filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`path must not contain ".." segments: ${path}`)
  }
  return segments
}

async function resolveDirectory(rootHandle, segments, { create }) {
  let dir = rootHandle
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create })
  }
  return dir
}

async function resolveFile(rootHandle, path, { create }) {
  const segments = splitPath(path)
  const fileName = segments.pop()
  if (fileName === undefined) throw new Error(`path does not name a file: ${path}`)
  const dir = await resolveDirectory(rootHandle, segments, { create })
  return dir.getFileHandle(fileName, { create })
}

/** Read a UTF-8 text file at `path` under `rootHandle`. */
export async function readTextFile(rootHandle, path) {
  const fileHandle = await resolveFile(rootHandle, path, { create: false })
  const file = await fileHandle.getFile()
  return file.text()
}

/**
 * The browser-side counterpart of `lib/registry.js`'s `localUpdatedAt` (WI #357): the last-modified
 * timestamp (epoch ms, `File.lastModified`) of the file at `path` under `rootHandle` — used by the
 * dashboard to show a local workspace instance's own "updated" time without a full text read.
 */
export async function getFileLastModified(rootHandle, path) {
  const fileHandle = await resolveFile(rootHandle, path, { create: false })
  const file = await fileHandle.getFile()
  return file.lastModified
}

/**
 * Write `text` to `path` under `rootHandle`, creating any intermediate
 * directories. Overwrites an existing file.
 */
export async function writeTextFile(rootHandle, path, text) {
  const fileHandle = await resolveFile(rootHandle, path, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(text ?? '')
  await writable.close()
}

/** Read a binary file at `path` as a `Uint8Array`. */
export async function readBinaryFile(rootHandle, path) {
  const fileHandle = await resolveFile(rootHandle, path, { create: false })
  const file = await fileHandle.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

/**
 * Write binary `data` (a `Blob`, `ArrayBuffer`, or typed array) to `path`
 * under `rootHandle`, creating any intermediate directories.
 */
export async function writeBinaryFile(rootHandle, path, data) {
  const fileHandle = await resolveFile(rootHandle, path, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(data ?? new Uint8Array())
  await writable.close()
}

/**
 * List the entries of the directory at `path` (the root when `path` is
 * omitted, `'.'` or `''`), as `[{ name, kind }]` sorted by name. `kind` is
 * `'file'` or `'directory'`.
 */
export async function listDir(rootHandle, path = '.') {
  const segments = path == null || path === '.' || path === '' ? [] : splitPath(path)
  const dir = await resolveDirectory(rootHandle, segments, { create: false })
  const entries = []
  for await (const [name, handle] of dir.entries()) {
    entries.push({ name, kind: handle.kind })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}
