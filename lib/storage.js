import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * The raw read/write seam for instance data (`instance.yaml`, module `.md` files) that `lib/instance.js`'s parsing/rendering functions go through, instead of calling `node:fs` directly. `localFilesystemStorage` is the only implementation today — everything still lives on the local filesystem, addressed by the same paths as before. The seam exists so a later Azure-DevOps-backed implementation (see docs/adr/0005-instance-data-in-external-ado-repo.md) can be swapped in to read/write that same raw text over the Azure DevOps REST API, reusing `lib/instance.js`'s frontmatter/field parsing unchanged.
 *
 * Errors from `readText` propagate as-is (e.g. a Node `ENOENT` with its `code` property intact) so callers can keep distinguishing "missing" from other failures the same way they do for a plain `readFileSync` call.
 *
 * The seam has two halves. The synchronous half (`exists`, `readText`, `stat`, `writeText`, `ensureDir`, `listDir`) is what every existing caller uses and is untouched. The asynchronous half is what ADR-0070 needs to put a server workspace in an object store: it offers only what Azure Blob, S3 and GCS share, so nothing in its shape is cloud-specific.
 *
 *   getText(path) / getBytes(path)           -> { text | bytes, version }; a missing file rejects with `code: 'ENOENT'`
 *   putText(path, text, opts) / putBytes()   -> { version }; `opts.ifVersion` makes the write conditional on what was read
 *   list(prefix)                              -> [{ path, size }] for every file whose path starts with `prefix`, sorted
 *   remove(path, opts)                        -> boolean (whether a file was deleted); `opts.ifVersion` as for a write
 *   acquireLease(key, opts) / renewLease(lease, opts) / releaseLease(lease)
 *
 * A `version` is an opaque string that changes whenever a file's content does (the disk implementation uses a content hash; an object store would use its ETag). Callers only ever hand it back as `ifVersion`: a string means "only if the file still has this version", `null` means "only if the file does not exist yet", and leaving it out means unconditional. A condition that no longer holds rejects with a `StorageConflictError` naming the file, and nothing is written.
 *
 * A lease is a short exclusive claim on a key (in practice an Instance), so a multi-file Save is all-or-nothing against another saver. It expires on its own, so a server that dies mid-Save cannot hold an Instance forever. The disk implementation keeps leases in memory: a disk-stored workspace belongs to one server (ADR-0031), while an object store would use the store's own lease.
 */

/** A conditional write or delete found the file changed (or missing, or already present) since it was read. */
export class StorageConflictError extends Error {
  constructor(path, detail) {
    super(`Cannot write ${path}: ${detail}`)
    this.name = 'StorageConflictError'
    this.code = 'STORAGE_CONFLICT'
    this.path = path
  }
}

/** Another holder has an unexpired lease on the key. */
export class StorageLeaseHeldError extends Error {
  constructor(key, expiresAt) {
    super(`${key} is locked by another save until ${new Date(expiresAt).toISOString()}`)
    this.name = 'StorageLeaseHeldError'
    this.code = 'STORAGE_LEASE_HELD'
    this.key = key
    this.expiresAt = expiresAt
  }
}

/** The lease being renewed or released is no longer the key's current lease (it expired and someone else took it). */
export class StorageLeaseLostError extends Error {
  constructor(key) {
    super(`The lock on ${key} was lost; another save has taken it`)
    this.name = 'StorageLeaseLostError'
    this.code = 'STORAGE_LEASE_LOST'
    this.key = key
  }
}

/** A lease is short by design; object stores cap it at about a minute. */
export const MAX_LEASE_MS = 60_000
export const DEFAULT_LEASE_MS = 30_000

const TEMP_SUFFIX = '.gantry-tmp'

function versionOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function leaseDuration(ttlMs) {
  const ms = ttlMs ?? DEFAULT_LEASE_MS
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_LEASE_MS) {
    throw new RangeError(`A lease lasts between 1 ms and ${MAX_LEASE_MS} ms (got ${ttlMs})`)
  }
  return ms
}

function toBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

/**
 * Builds a disk-backed storage. `now` is injectable so lease expiry can be tested without waiting.
 */
export function createLocalFilesystemStorage({ now = () => Date.now() } = {}) {
  const writeChains = new Map()
  const leases = new Map()

  // Serialises conditional writes to one path within this process, so "check the version, then write" cannot interleave with another write to the same file.
  function withPathLock(path, fn) {
    const prior = writeChains.get(path) ?? Promise.resolve()
    const run = prior.then(fn, fn)
    const tail = run.catch(() => {})
    writeChains.set(path, tail)
    tail.then(() => {
      if (writeChains.get(path) === tail) writeChains.delete(path)
    })
    return run
  }

  async function readBytesOrNull(path) {
    try {
      return await readFile(path)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
  }

  async function checkCondition(path, ifVersion) {
    if (ifVersion === undefined) return
    const current = await readBytesOrNull(path)
    if (ifVersion === null) {
      if (current !== null) throw new StorageConflictError(path, 'it already exists')
      return
    }
    if (current === null) throw new StorageConflictError(path, 'it no longer exists')
    if (versionOf(current) !== ifVersion) throw new StorageConflictError(path, 'it has changed since it was read')
  }

  async function putBytes(path, bytes, { ifVersion } = {}) {
    const data = toBuffer(bytes)
    return withPathLock(path, async () => {
      await checkCondition(path, ifVersion)
      await mkdir(dirname(path), { recursive: true })
      // Write beside the target then rename, so a reader never sees a half-written file.
      const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}${TEMP_SUFFIX}`)
      try {
        await writeFile(temp, data)
        await rename(temp, path)
      } catch (err) {
        await rm(temp, { force: true })
        throw err
      }
      return { version: versionOf(data) }
    })
  }

  async function walk(dir, out) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return
      throw err
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, out)
      else if (entry.isFile() && !entry.name.endsWith(TEMP_SUFFIX)) out.push(full)
    }
  }

  return {
    // --- synchronous half: unchanged ---
    exists(path) {
      return existsSync(path)
    },
    readText(path) {
      return readFileSync(path, 'utf8')
    },
    stat(path) {
      return statSync(path)
    },
    writeText(path, text) {
      writeFileSync(path, text)
    },
    ensureDir(path) {
      mkdirSync(path, { recursive: true })
    },
    listDir(path) {
      return existsSync(path) ? readdirSync(path) : []
    },

    // --- asynchronous half ---
    async getBytes(path) {
      const bytes = await readFile(path)
      return { bytes, version: versionOf(bytes) }
    },
    async getText(path) {
      const bytes = await readFile(path)
      return { text: bytes.toString('utf8'), version: versionOf(bytes) }
    },
    putBytes,
    putText(path, text, options) {
      return putBytes(path, Buffer.from(text, 'utf8'), options)
    },
    async list(prefix) {
      // An object store lists by string prefix, not by directory, so walk the deepest directory the prefix names and filter.
      const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
      const root = slash >= 0 ? prefix.slice(0, slash + 1) : '.'
      const found = []
      await walk(root, found)
      const matching = found.filter((p) => p.startsWith(prefix)).sort()
      return Promise.all(matching.map(async (path) => ({ path, size: (await stat(path)).size })))
    },
    async remove(path, { ifVersion } = {}) {
      return withPathLock(path, async () => {
        await checkCondition(path, ifVersion)
        const existed = (await readBytesOrNull(path)) !== null
        if (existed) await rm(path, { force: true })
        return existed
      })
    },

    // --- leases ---
    async acquireLease(key, { ttlMs } = {}) {
      const ms = leaseDuration(ttlMs)
      const held = leases.get(key)
      if (held && held.expiresAt > now()) throw new StorageLeaseHeldError(key, held.expiresAt)
      const lease = { key, id: randomUUID(), expiresAt: now() + ms }
      leases.set(key, lease)
      return { ...lease }
    },
    async renewLease(lease, { ttlMs } = {}) {
      const ms = leaseDuration(ttlMs)
      const held = leases.get(lease.key)
      if (!held || held.id !== lease.id) throw new StorageLeaseLostError(lease.key)
      held.expiresAt = now() + ms
      return { ...held }
    },
    async releaseLease(lease) {
      const held = leases.get(lease.key)
      if (!held) return
      if (held.id !== lease.id) throw new StorageLeaseLostError(lease.key)
      leases.delete(lease.key)
    },
  }
}

export const localFilesystemStorage = createLocalFilesystemStorage()
