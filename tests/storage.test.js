import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLocalFilesystemStorage,
  localFilesystemStorage,
  StorageConflictError,
  StorageLeaseHeldError,
  StorageLeaseLostError,
  MAX_LEASE_MS,
} from '../lib/storage.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-storage-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the synchronous half is unchanged', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'a', 'x.txt')
    assert.equal(localFilesystemStorage.exists(file), false)
    localFilesystemStorage.ensureDir(join(dir, 'a'))
    localFilesystemStorage.writeText(file, 'hi')
    assert.equal(localFilesystemStorage.readText(file), 'hi')
    assert.deepEqual(localFilesystemStorage.listDir(join(dir, 'a')), ['x.txt'])
    assert.deepEqual(localFilesystemStorage.listDir(join(dir, 'nope')), [])
  } finally {
    done()
  }
})

test('text and bytes round-trip, creating parent folders', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const text = join(dir, 'deep', 'er', 'instance.yaml')
    const w = await s.putText(text, 'héllo')
    const r = await s.getText(text)
    assert.equal(r.text, 'héllo')
    assert.equal(r.version, w.version)

    const bin = join(dir, 'sources', 'doc.bin')
    const payload = Buffer.from([0, 255, 1, 254, 2])
    await s.putBytes(bin, payload)
    const b = await s.getBytes(bin)
    assert.deepEqual(b.bytes, payload)
    assert.ok(Buffer.isBuffer(b.bytes))
    // synchronous callers see the same file
    assert.equal(localFilesystemStorage.readText(text), 'héllo')
  } finally {
    done()
  }
})

test('a missing file rejects with ENOENT', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    await assert.rejects(s.getText(join(dir, 'missing')), { code: 'ENOENT' })
    await assert.rejects(s.getBytes(join(dir, 'missing')), { code: 'ENOENT' })
  } finally {
    done()
  }
})

test('the version changes with the content and not otherwise', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'f')
    const a = await s.putText(f, 'one')
    const same = await s.putText(f, 'one')
    const b = await s.putText(f, 'two')
    assert.equal(a.version, same.version)
    assert.notEqual(a.version, b.version)
  } finally {
    done()
  }
})

test('listing is by prefix, recursive and sorted, and leaves out half-written temp files', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    await s.putText(join(dir, 'ws', 'inst-b', 'instance.yaml'), 'b')
    await s.putText(join(dir, 'ws', 'inst-a', 'modules', 'm.md'), 'aaa')
    await s.putText(join(dir, 'ws', 'inst-a', 'instance.yaml'), 'a')
    await s.putText(join(dir, 'other', 'x'), 'x')
    writeFileSync(join(dir, 'ws', 'inst-a', '.instance.yaml.1.gantry-tmp'), 'partial')

    const all = await s.list(join(dir, 'ws') + '/')
    assert.deepEqual(all.map((e) => e.path.slice(dir.length + 1)), [
      'ws/inst-a/instance.yaml',
      'ws/inst-a/modules/m.md',
      'ws/inst-b/instance.yaml',
    ])
    assert.equal(all[1].size, 3)

    const one = await s.list(join(dir, 'ws', 'inst-a') + '/')
    assert.equal(one.length, 2)
    // a prefix need not end at a folder boundary
    const partial = await s.list(join(dir, 'ws', 'inst-'))
    assert.equal(partial.length, 3)
    assert.deepEqual(await s.list(join(dir, 'nothing') + '/'), [])
  } finally {
    done()
  }
})

test('delete removes a file and reports whether there was one', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'f')
    await s.putText(f, 'x')
    assert.equal(await s.remove(f), true)
    assert.equal(existsSync(f), false)
    assert.equal(await s.remove(f), false)
  } finally {
    done()
  }
})

test('a write conditional on the version read succeeds when unchanged', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'f')
    await s.putText(f, 'v1')
    const { version } = await s.getText(f)
    const next = await s.putText(f, 'v2', { ifVersion: version })
    assert.equal((await s.getText(f)).version, next.version)
    assert.equal(readFileSync(f, 'utf8'), 'v2')
  } finally {
    done()
  }
})

test('a write conditional on the version read fails, naming the file, when it has changed since', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'instance.yaml')
    await s.putText(f, 'v1')
    const { version } = await s.getText(f)
    await s.putText(f, 'someone else')
    await assert.rejects(s.putText(f, 'mine', { ifVersion: version }), (err) => {
      assert.ok(err instanceof StorageConflictError)
      assert.equal(err.code, 'STORAGE_CONFLICT')
      assert.equal(err.path, f)
      assert.ok(err.message.includes(f))
      return true
    })
    assert.equal(readFileSync(f, 'utf8'), 'someone else')
    await assert.rejects(s.putBytes(f, Buffer.from('mine'), { ifVersion: version }), StorageConflictError)
  } finally {
    done()
  }
})

test('ifVersion null means create only, and a conditional write to a deleted file fails', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'f')
    await s.putText(f, 'first', { ifVersion: null })
    await assert.rejects(s.putText(f, 'second', { ifVersion: null }), StorageConflictError)
    const { version } = await s.getText(f)
    await s.remove(f)
    await assert.rejects(s.putText(f, 'third', { ifVersion: version }), /no longer exists/)
    assert.equal(existsSync(f), false)
  } finally {
    done()
  }
})

test('a conditional delete fails, naming the file, when the file has changed', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'f')
    await s.putText(f, 'v1')
    const { version } = await s.getText(f)
    await s.putText(f, 'v2')
    await assert.rejects(s.remove(f, { ifVersion: version }), (err) => err instanceof StorageConflictError && err.message.includes(f))
    assert.equal(existsSync(f), true)
    const current = (await s.getText(f)).version
    assert.equal(await s.remove(f, { ifVersion: current }), true)
  } finally {
    done()
  }
})

test('of several concurrent writers holding the same version, exactly one wins', async () => {
  const { dir, done } = scratch()
  try {
    const s = createLocalFilesystemStorage()
    const f = join(dir, 'f')
    await s.putText(f, 'base')
    const { version } = await s.getText(f)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => s.putText(f, `writer ${i}`, { ifVersion: version })),
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof StorageConflictError).length, 7)
    assert.deepEqual(readdirSync(dir), ['f'], 'no temp files left behind')
  } finally {
    done()
  }
})

test('a lease can be taken, renewed and released; a second taker is refused while it is held', async () => {
  let t = 1_000_000
  const s = createLocalFilesystemStorage({ now: () => t })
  const key = '/data/ws/instances/alpha'
  const lease = await s.acquireLease(key, { ttlMs: 10_000 })
  assert.equal(lease.expiresAt, t + 10_000)

  await assert.rejects(s.acquireLease(key), (err) => {
    assert.ok(err instanceof StorageLeaseHeldError)
    assert.equal(err.code, 'STORAGE_LEASE_HELD')
    assert.ok(err.message.includes(key))
    return true
  })
  // another key is unaffected
  await s.acquireLease('/data/ws/instances/beta')

  t += 8_000
  const renewed = await s.renewLease(lease, { ttlMs: 10_000 })
  assert.equal(renewed.expiresAt, t + 10_000)
  t += 8_000
  await assert.rejects(s.acquireLease(key), StorageLeaseHeldError, 'renewal kept it past the original expiry')

  await s.releaseLease(lease)
  const again = await s.acquireLease(key)
  assert.notEqual(again.id, lease.id)
})

test('an expired lease can be taken, and the old holder then cannot renew or release it', async () => {
  let t = 5_000
  const s = createLocalFilesystemStorage({ now: () => t })
  const key = 'inst'
  const old = await s.acquireLease(key, { ttlMs: 1_000 })
  t += 1_001
  const fresh = await s.acquireLease(key, { ttlMs: 1_000 })
  await assert.rejects(s.renewLease(old), StorageLeaseLostError)
  await assert.rejects(s.releaseLease(old), StorageLeaseLostError)
  // the new holder is unaffected by the old holder's attempts
  await assert.rejects(s.acquireLease(key), StorageLeaseHeldError)
  await s.releaseLease(fresh)
})

test('releasing a lease twice is harmless, and a lease is short', async () => {
  const s = createLocalFilesystemStorage()
  const lease = await s.acquireLease('k')
  await s.releaseLease(lease)
  await s.releaseLease(lease)
  await assert.rejects(s.acquireLease('k', { ttlMs: MAX_LEASE_MS + 1 }), RangeError)
  await assert.rejects(s.acquireLease('k', { ttlMs: 0 }), RangeError)
})
