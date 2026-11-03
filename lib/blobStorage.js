import { createHash, randomUUID } from 'node:crypto'
import { MAX_LEASE_MS, DEFAULT_LEASE_MS, StorageConflictError, StorageLeaseHeldError, StorageLeaseLostError } from './storage.js'

/**
 * The asynchronous half of `lib/storage.js`'s seam over an Azure Blob container (#269, docs/adr/0070).
 * A path is a blob name: `risk/workspace.json`, `risk/my-initiative/instance.yaml`. There is no synchronous half on
 * purpose, as with the in-memory store the tests use: code that reaches for the disk through a blob-stored
 * workspace fails loudly instead of quietly writing the server's own folder.
 *
 * - A `version` is the blob's ETag. `ifVersion: '<etag>'` becomes `If-Match`, `ifVersion: null` becomes
 *   `If-None-Match: *`, and a condition that no longer holds rejects with a `StorageConflictError`.
 * - `list(prefix)` is Azure's own prefix listing, so a folder is addressed with a trailing slash. Each entry also
 *   carries `modifiedAt` (an ISO string) for callers that want "last updated".
 * - A create-only write (`ifVersion: null`) that finds the blob already there is a `StorageConflictError` whether the
 *   service answers 409 (`BlobAlreadyExists`, what Azure sends for `If-None-Match: *`) or 412 (`ConditionNotMet`, what
 *   a mismatched `If-Match` gets); #259 could not verify which, so both are handled the same way (#271).
 * - A lease is a blob lease on a small lock blob under `.gantry/locks/`, so it expires by itself on the service if the
 *   server dies mid-Save. Azure leases last 15 to 60 seconds, so a shorter request is rounded up to 15 seconds.
 *
 * An SDK error is never allowed to carry a signed URL out of this module: callers see a plain `Error` whose message
 * is a fixed phrase, with `code` set where the seam defines one (`ENOENT`).
 */

export const LOCK_PREFIX = '.gantry/locks/'
/** Where a Save's write-ahead record lives while it is in flight (lib/atomicSave.js); hidden from `list` like the locks. */
export const JOURNAL_PREFIX = '.gantry/journal/'
const MIN_AZURE_LEASE_S = 15

const statusOf = (err) => err?.statusCode ?? err?.status
const codeOf = (err) => (typeof err?.code === 'string' ? err.code : typeof err?.details?.errorCode === 'string' ? err.details.errorCode : '')

// A failure to hand on: a fixed message (never the SDK's, which can carry a signed URL), with the status and the service's error code kept so a caller can say why (`describeProbeFailure`).
function failure(message, err) {
  const status = statusOf(err)
  const code = codeOf(err)
  return Object.assign(new Error(`${message} (${status ?? (code || 'no answer')})`), {
    ...(status === undefined ? {} : { statusCode: status }),
    ...(code ? { code } : {}),
    ...(err?.name === 'AbortError' || err?.name === 'TimeoutError' ? { name: err.name } : {}),
  })
}

function missing(path) {
  return Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: 'ENOENT' })
}

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))

function conditionsFor(ifVersion) {
  if (ifVersion === undefined) return undefined
  return ifVersion === null ? { ifNoneMatch: '*' } : { ifMatch: ifVersion }
}

/**
 * Builds the storage over `containerClient` (an `@azure/storage-blob` `ContainerClient`). `now` is injectable for lease expiry.
 */
export function createBlobStorage(containerClient, { now = () => Date.now() } = {}) {
  const blob = (path) => containerClient.getBlockBlobClient(path)
  // A lease's blob client, by lease key, so renew and release address the same lock blob the acquire did.
  const held = new Map()

  async function putBytes(path, bytes, { ifVersion } = {}) {
    const data = toBuffer(bytes)
    try {
      const result = await blob(path).uploadData(data, { conditions: conditionsFor(ifVersion) })
      return { version: result.etag }
    } catch (err) {
      const status = statusOf(err)
      const code = codeOf(err)
      if (ifVersion !== undefined && (status === 412 || status === 409 || (status === 404 && ifVersion !== null) || code === 'BlobAlreadyExists')) {
        const detail = ifVersion === null ? 'it already exists' : status === 404 ? 'it no longer exists' : 'it has changed since it was read'
        throw new StorageConflictError(path, detail)
      }
      throw failure(`Could not write ${path}`, err)
    }
  }

  async function getBytes(path) {
    try {
      const response = await blob(path).download()
      const bytes = await readAll(response.readableStreamBody)
      return { bytes, version: response.etag }
    } catch (err) {
      if (statusOf(err) === 404 || codeOf(err) === 'BlobNotFound') throw missing(path)
      throw failure(`Could not read ${path}`, err)
    }
  }

  async function lockBlobFor(key) {
    const name = `${LOCK_PREFIX}${createHash('sha256').update(key).digest('hex')}`
    const client = blob(name)
    try {
      // Create-only: the lock blob is empty and permanent, only its lease comes and goes.
      await client.uploadData(Buffer.alloc(0), { conditions: { ifNoneMatch: '*' } })
    } catch (err) {
      if (statusOf(err) !== 409 && statusOf(err) !== 412 && codeOf(err) !== 'BlobAlreadyExists') {
        throw failure(`Could not lock ${key}`, err)
      }
    }
    return client
  }

  function leaseSeconds(ttlMs) {
    const ms = ttlMs ?? DEFAULT_LEASE_MS
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_LEASE_MS) {
      throw new RangeError(`A lease lasts between 1 ms and ${MAX_LEASE_MS} ms (got ${ttlMs})`)
    }
    return Math.max(MIN_AZURE_LEASE_S, Math.ceil(ms / 1000))
  }

  return {
    containerClient,
    getBytes,
    async getText(path) {
      const { bytes, version } = await getBytes(path)
      return { text: bytes.toString('utf8'), version }
    },
    putBytes,
    putText: (path, text, options) => putBytes(path, Buffer.from(text, 'utf8'), options),
    async list(prefix) {
      const found = []
      try {
        for await (const item of containerClient.listBlobsFlat({ prefix })) {
          if (item.name.startsWith(LOCK_PREFIX) || item.name.startsWith(JOURNAL_PREFIX)) continue
          found.push({ path: item.name, size: item.properties?.contentLength ?? 0, modifiedAt: item.properties?.lastModified?.toISOString?.() })
        }
      } catch (err) {
        throw failure(`Could not list ${prefix || "the container"}`, err)
      }
      return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    /** The top-level folders of the container: names without the trailing slash. Uses Azure's delimiter listing, so it does not walk every blob. */
    async listFolders(prefix = '') {
      const folders = []
      try {
        for await (const item of containerClient.listBlobsByHierarchy('/', { prefix })) {
          if (item.kind === 'prefix') folders.push(item.name.slice(prefix.length).replace(/\/$/, ''))
        }
      } catch (err) {
        throw failure(`Could not list ${prefix || "the container"}`, err)
      }
      return folders.sort()
    },
    async remove(path, { ifVersion } = {}) {
      try {
        await blob(path).delete({ conditions: ifVersion === undefined || ifVersion === null ? undefined : { ifMatch: ifVersion } })
        return true
      } catch (err) {
        const status = statusOf(err)
        if (status === 404 || codeOf(err) === 'BlobNotFound') {
          if (ifVersion) throw new StorageConflictError(path, 'it no longer exists')
          return false
        }
        if (status === 412) throw new StorageConflictError(path, 'it has changed since it was read')
        throw failure(`Could not delete ${path}`, err)
      }
    },

    // --- leases ---
    async acquireLease(key, { ttlMs } = {}) {
      const seconds = leaseSeconds(ttlMs)
      const client = await lockBlobFor(key)
      const leaseClient = client.getBlobLeaseClient(randomUUID())
      try {
        await leaseClient.acquireLease(seconds)
      } catch (err) {
        if (statusOf(err) === 409 || codeOf(err) === 'LeaseAlreadyPresent') throw new StorageLeaseHeldError(key, now() + seconds * 1000)
        throw failure(`Could not lock ${key}`, err)
      }
      const lease = { key, id: leaseClient.leaseId, expiresAt: now() + seconds * 1000 }
      held.set(lease.id, leaseClient)
      return { ...lease }
    },
    async renewLease(lease, { ttlMs } = {}) {
      const seconds = leaseSeconds(ttlMs)
      const leaseClient = held.get(lease.id)
      if (!leaseClient) throw new StorageLeaseLostError(lease.key)
      try {
        // An Azure renewal restarts the duration the lease was acquired with.
        await leaseClient.renewLease()
      } catch {
        held.delete(lease.id)
        throw new StorageLeaseLostError(lease.key)
      }
      return { ...lease, expiresAt: now() + seconds * 1000 }
    },
    async releaseLease(lease) {
      const leaseClient = held.get(lease.id)
      if (!leaseClient) return
      held.delete(lease.id)
      try {
        await leaseClient.releaseLease()
      } catch (err) {
        // Already expired on the service: nothing left to release.
        if (statusOf(err) === 409 || statusOf(err) === 412) throw new StorageLeaseLostError(lease.key)
        throw err
      }
    },
  }
}

/**
 * Runs `fn(lease)` holding a lease on `key`, then releases it. A held lease is retried for up to `waitMs` (a Save is
 * short, so waiting a moment beats failing the second saver outright); after that the `StorageLeaseHeldError` goes to the caller.
 */
export async function withLease(storage, key, fn, { ttlMs = DEFAULT_LEASE_MS, waitMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + waitMs
  let lease
  for (;;) {
    try {
      lease = await storage.acquireLease(key, { ttlMs })
      break
    } catch (err) {
      if (!(err instanceof StorageLeaseHeldError) || Date.now() >= deadline) throw err
      await sleep(250)
    }
  }
  try {
    return await fn(lease)
  } finally {
    try {
      await storage.releaseLease(lease)
    } catch {
      // The Save is done (or failed) either way; a lease that expired under us has nothing left to release.
    }
  }
}
