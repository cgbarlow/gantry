import { createHash, randomUUID } from 'node:crypto'
import { MAX_LEASE_MS, DEFAULT_LEASE_MS, StorageConflictError, StorageLeaseHeldError, StorageLeaseLostError } from '../../lib/storage.js'

/**
 * An in-memory store with only the asynchronous half of `lib/storage.js`'s seam, standing in for a Blob container (ADR-0070). It has no synchronous methods on purpose: code that reaches for `exists` or `readText` instead of going through the async seam fails loudly with "is not a function", which is how the tests for #265 know a server workspace never touched the disk.
 *
 * `files` is the live map of path to bytes, for assertions; `writes` records every path written or removed, in order.
 */
export function createInMemoryStorage({ now = () => Date.now() } = {}) {
  const files = new Map()
  const leases = new Map()
  const writes = []

  const versionOf = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const missing = (path) => Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: 'ENOENT' })
  const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes))

  function check(path, ifVersion) {
    if (ifVersion === undefined) return
    const current = files.get(path)
    if (ifVersion === null) {
      if (current) throw new StorageConflictError(path, 'it already exists')
      return
    }
    if (!current) throw new StorageConflictError(path, 'it no longer exists')
    if (versionOf(current) !== ifVersion) throw new StorageConflictError(path, 'it has changed since it was read')
  }

  function leaseDuration(ttlMs) {
    const ms = ttlMs ?? DEFAULT_LEASE_MS
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_LEASE_MS) throw new RangeError(`A lease lasts between 1 ms and ${MAX_LEASE_MS} ms (got ${ttlMs})`)
    return ms
  }

  const storage = {
    files,
    writes,
    async getBytes(path) {
      const bytes = files.get(path)
      if (!bytes) throw missing(path)
      return { bytes: Buffer.from(bytes), version: versionOf(bytes) }
    },
    async getText(path) {
      const bytes = files.get(path)
      if (!bytes) throw missing(path)
      return { text: bytes.toString('utf8'), version: versionOf(bytes) }
    },
    async putBytes(path, bytes, { ifVersion } = {}) {
      check(path, ifVersion)
      const data = toBuffer(bytes)
      files.set(path, data)
      writes.push(path)
      return { version: versionOf(data) }
    },
    async putText(path, text, options) {
      return storage.putBytes(path, Buffer.from(text, 'utf8'), options)
    },
    async list(prefix) {
      return [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => ({ path, size: bytes.length }))
        .sort((a, b) => (a.path < b.path ? -1 : 1))
    },
    async remove(path, { ifVersion } = {}) {
      check(path, ifVersion)
      const existed = files.delete(path)
      if (existed) writes.push(path)
      return existed
    },
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
  return storage
}
