// #271 (parent #238, docs/adr/0070): a stage Save to a blob-stored Instance is all-or-nothing. These run the algorithm
// (lib/atomicSave.js) against the in-memory store with a clock the test moves, so a lease "expires" without waiting;
// tests/blobAtomicSave.test.js runs the same fault injection against Azurite. They pin: every file lands, or none
// does; a write that fails part-way is undone on the spot; a Save cut short by a dying server is settled by the next
// Save or read once the dead server's lease has run out, to entirely before or entirely after; and a file someone
// else changed since is never undone.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createInMemoryStorage } from './helpers/inMemoryStorage.js'
import { createDyingStorage } from './helpers/dyingStorage.js'
import { journalPathFor, recoverInterruptedSave, recoverIfInterrupted, writeFilesAllOrNothing } from '../lib/atomicSave.js'
import { withLease } from '../lib/blobStorage.js'
import { StorageConflictError, StorageLeaseHeldError, StorageLeaseLostError } from '../lib/storage.js'

const KEY = 'ws/cards'
const A = 'ws/cards/modules/a.md'
const B = 'ws/cards/modules/b.md'
const C = 'ws/cards/modules/c.md'

function clock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => (t += ms) }
}

async function seeded(time = clock()) {
  const storage = createInMemoryStorage({ now: time.now })
  await storage.putText(A, 'a-before')
  await storage.putText(B, 'b-before')
  return { storage, time }
}

const text = async (storage, path) => (await storage.getText(path).catch(() => ({ text: null }))).text
const state = async (storage) => [await text(storage, A), await text(storage, B), await text(storage, C)]
const FILES = [
  { path: A, text: 'a-after' },
  { path: B, text: 'b-after' },
  { path: C, text: 'c-after' },
]
const BEFORE = ['a-before', 'b-before', null]
const AFTER = ['a-after', 'b-after', 'c-after']

describe('writeFilesAllOrNothing', () => {
  test('writes every file, creating the ones that are not there, and leaves no write-ahead record behind', async () => {
    const { storage } = await seeded()
    const written = await withLease(storage, KEY, () => writeFilesAllOrNothing(storage, KEY, FILES))
    assert.deepEqual(written, [A, B, C])
    assert.deepEqual(await state(storage), AFTER)
    assert.equal(await text(storage, journalPathFor(KEY)), null)
  })

  test('does not rewrite a file whose text is already what is saved, and writes nothing at all when nothing changed', async () => {
    const { storage } = await seeded()
    const writesBefore = storage.writes.length
    assert.deepEqual(await writeFilesAllOrNothing(storage, KEY, [{ path: A, text: 'a-before' }, { path: B, text: 'b-before' }]), [])
    assert.equal(storage.writes.length, writesBefore, 'not even a write-ahead record')
    assert.deepEqual(await writeFilesAllOrNothing(storage, KEY, [{ path: A, text: 'a-before' }, { path: B, text: 'b-after' }]), [B])
  })

  test('a write that fails part-way is undone on the spot: the stage is exactly as before, and the error goes to the saver', async () => {
    const { storage } = await seeded()
    // Someone changes C behind the Save after it has read that C does not exist: its create-only write is refused.
    let calls = 0
    const racing = {
      ...storage,
      putText: async (path, body, options) => {
        if (path === C && calls++ === 0) await storage.putText(C, 'someone-elses')
        return storage.putText(path, body, options)
      },
    }
    await assert.rejects(writeFilesAllOrNothing(racing, KEY, FILES), StorageConflictError)
    assert.deepEqual(await state(storage), ['a-before', 'b-before', 'someone-elses'])
    assert.equal(await text(storage, journalPathFor(KEY)), null)
  })

  test('a file changed behind the Save since the Save read it is refused, not overwritten, and the files already written go back', async () => {
    const { storage } = await seeded()
    const racing = {
      ...storage,
      putText: async (path, body, options) => {
        if (path === B) await storage.putText(B, 'b-theirs')
        return storage.putText(path, body, options)
      },
    }
    await assert.rejects(writeFilesAllOrNothing(racing, KEY, FILES), (err) => err instanceof StorageConflictError && /b\.md/.test(err.message))
    assert.deepEqual(await state(storage), ['a-before', 'b-theirs', null])
  })

  test('a Save that has lost its lease stops writing and leaves the record for whoever took the lease', async () => {
    const { storage } = await seeded()
    let renewals = 0
    const beforeEachWrite = async () => {
      if (++renewals === 2) throw new StorageLeaseLostError(KEY)
    }
    await assert.rejects(writeFilesAllOrNothing(storage, KEY, FILES, { beforeEachWrite }), StorageLeaseLostError)
    assert.deepEqual(await state(storage), ['a-after', 'b-before', null], 'one file written, then it stopped')
    assert.notEqual(await text(storage, journalPathFor(KEY)), null)
    assert.equal(await recoverInterruptedSave(storage, KEY), 'rolled-back')
    assert.deepEqual(await state(storage), BEFORE)
  })
})

describe('a Save cut short by a server that died', () => {
  // The dying server writes `dieAfterPuts` files, then every call it makes fails: no rollback, and the lease it holds is never released.
  async function dieMidSave(dieAfterPuts) {
    const { storage, time } = await seeded()
    const dying = createDyingStorage(storage, { dieAfterPuts })
    await assert.rejects(
      withLease(dying, KEY, () => writeFilesAllOrNothing(dying, KEY, FILES), { ttlMs: 15_000, waitMs: 0 }),
      (err) => err.code === 'SERVER_DIED'
    )
    assert.equal(dying.dead, true)
    return { storage, time }
  }

  for (const [dieAfterPuts, mixed] of [
    [0, BEFORE],
    [1, ['a-after', 'b-before', null]],
    [2, ['a-after', 'b-after', null]],
  ]) {
    test(`after ${dieAfterPuts} of 3 files written, the stage is a mix until the dead server's lease runs out, then the next Save finds it entirely as before`, async () => {
      const { storage, time } = await dieMidSave(dieAfterPuts)
      assert.deepEqual(await state(storage), mixed)

      // Until the lease expires the next Save is turned away, and touches nothing.
      await assert.rejects(withLease(storage, KEY, async () => {}, { waitMs: 0 }), StorageLeaseHeldError)
      assert.deepEqual(await state(storage), mixed)

      time.advance(16_000)
      const next = await withLease(storage, KEY, async () => {
        const settled = await recoverInterruptedSave(storage, KEY)
        return { settled, seen: await state(storage) }
      })
      assert.equal(next.settled, 'rolled-back')
      assert.deepEqual(next.seen, BEFORE)
      assert.equal(await text(storage, journalPathFor(KEY)), null)
    })
  }

  test('the next Save after the lease runs out goes ahead, on top of the settled stage', async () => {
    const { storage, time } = await dieMidSave(2)
    time.advance(16_000)
    await withLease(storage, KEY, async () => {
      await recoverInterruptedSave(storage, KEY)
      await writeFilesAllOrNothing(storage, KEY, [{ path: A, text: 'a-next' }])
    })
    assert.deepEqual(await state(storage), ['a-next', 'b-before', null])
  })

  test('a read settles it too, but only once the lease has run out', async () => {
    const { storage, time } = await dieMidSave(1)
    assert.equal(await recoverIfInterrupted(storage, KEY), 'none', 'the dead server still holds the lease')
    assert.deepEqual(await state(storage), ['a-after', 'b-before', null])
    time.advance(16_000)
    assert.equal(await recoverIfInterrupted(storage, KEY), 'rolled-back')
    assert.deepEqual(await state(storage), BEFORE)
    assert.equal(await recoverIfInterrupted(storage, KEY), 'none', 'nothing left to settle')
  })

  test('a server that died after the last file but before it removed the record left the stage entirely after, and recovery keeps it', async () => {
    const { storage, time } = await seeded()
    const dying = {
      ...storage,
      remove: async (path, options) => {
        if (path === journalPathFor(KEY)) throw Object.assign(new Error('the server died'), { code: 'SERVER_DIED' })
        return storage.remove(path, options)
      },
    }
    // The Save itself reports success (the record is harmless), the lease is simply never released.
    await storage.acquireLease(KEY, { ttlMs: 15_000 })
    await writeFilesAllOrNothing(dying, KEY, FILES)
    assert.notEqual(await text(storage, journalPathFor(KEY)), null)
    assert.deepEqual(await state(storage), AFTER)
    time.advance(16_000)
    assert.equal(await recoverIfInterrupted(storage, KEY), 'completed')
    assert.deepEqual(await state(storage), AFTER)
    assert.equal(await text(storage, journalPathFor(KEY)), null)
  })

  test('recovery does not undo a file somebody else has changed since', async () => {
    const { storage, time } = await dieMidSave(2)
    await storage.putText(A, 'a-by-someone-else')
    time.advance(16_000)
    assert.equal(await recoverIfInterrupted(storage, KEY), 'rolled-back')
    assert.deepEqual(await state(storage), ['a-by-someone-else', 'b-before', null])
  })

  test('a record that does not parse is cleared rather than blocking every later Save', async () => {
    const { storage } = await seeded()
    await storage.putText(journalPathFor(KEY), '{"writes": [')
    assert.equal(await withLease(storage, KEY, () => recoverInterruptedSave(storage, KEY)), 'rolled-back')
    assert.equal(await text(storage, journalPathFor(KEY)), null)
    assert.deepEqual(await state(storage), ['a-before', 'b-before', null])
  })
})

describe('two servers saving the same stage at once', () => {
  test('their writes are serialised by the lease: the files end up wholly one Save or wholly the other, never a mix', async () => {
    const storage = createInMemoryStorage()
    await storage.putText(A, 'a-0')
    await storage.putText(B, 'b-0')
    const save = (label) =>
      withLease(storage, KEY, async () => {
        await recoverInterruptedSave(storage, KEY)
        await writeFilesAllOrNothing(storage, KEY, [{ path: A, text: `a-${label}` }, { path: B, text: `b-${label}` }])
        return label
      }, { waitMs: 2000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    const results = await Promise.all(['one', 'two'].map(save))
    assert.deepEqual(results.sort(), ['one', 'two'])
    const [a, b] = await state(storage)
    assert.equal(a.slice(2), b.slice(2), 'both files from the same Save')
  })
})
