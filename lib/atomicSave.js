import { createHash } from 'node:crypto'
import { JOURNAL_PREFIX, withLease } from './blobStorage.js'
import { getTextVersionedOrNull } from './storageFiles.js'
import { StorageLeaseHeldError, StorageLeaseLostError } from './storage.js'

/**
 * A multi-file Save that is all-or-nothing in an object store (#271, docs/adr/0070).
 *
 * An object store has no transaction across blobs, so a server that dies half-way through writing a stage's Module
 * files would leave a mix. Instead the Save writes a small write-ahead record first (one blob, so it lands whole or not
 * at all), then the files, then deletes the record. The record holds, for every file the Save will change, the text it
 * held before and a fingerprint of the text the Save writes.
 *
 *   - A write that fails part-way is rolled back on the spot, from the record.
 *   - A server that dies leaves the record behind. The next Save, and the next read, of that Instance finds it (once the
 *     dead server's lease has expired) and settles it: every file already holding the Save's text means the Save had
 *     finished, so the record is just removed; otherwise the files the Save changed go back to what they held before.
 *     Either way the stage ends up entirely as before or entirely as after.
 *
 * Everything here runs while the caller holds the Instance's lease (`withLease`), except `recoverIfInterrupted`, which
 * takes it briefly itself. The record is keyed by the same key as the lease, so a Save and its recovery cannot overlap.
 */

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The blob that holds the write-ahead record of the Save in flight on `key`. */
export const journalPathFor = (key) => `${JOURNAL_PREFIX}${createHash('sha256').update(key).digest('hex')}.json`

async function readJournal(storage, key) {
  const stored = await getTextVersionedOrNull(storage, journalPathFor(key))
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored.text)
    if (Array.isArray(parsed?.writes)) return parsed.writes
  } catch {
    // A record that does not parse was never a whole one (a blob is written whole), so it describes no Save to settle.
  }
  return []
}

// Puts a file back to what it held before the Save, but only if it still holds what the Save wrote: a file someone
// else has changed since is not ours to undo.
async function restore(storage, { path, before, after }) {
  const current = await getTextVersionedOrNull(storage, path)
  if (!current || sha(current.text) !== after || before === after) return
  if (before === null) await storage.remove(path, { ifVersion: current.version })
  else await storage.putText(path, before, { ifVersion: current.version })
}

async function removeJournal(storage, key) {
  await storage.remove(journalPathFor(key))
}

/**
 * Settles a Save that was cut short on `key`, if there is one. Call it holding the lease, before reading the stage.
 * Resolves to `'none'` (nothing was in flight), `'completed'` (every file already held the Save's text) or
 * `'rolled-back'`.
 */
export async function recoverInterruptedSave(storage, key) {
  const writes = await readJournal(storage, key)
  if (writes === null) return 'none'
  let finished = writes.length > 0
  for (const { path, after } of writes) {
    const current = await getTextVersionedOrNull(storage, path)
    if (!current || sha(current.text) !== after) finished = false
  }
  if (finished) {
    await removeJournal(storage, key)
    return 'completed'
  }
  for (const entry of writes) await restore(storage, entry)
  await removeJournal(storage, key)
  return 'rolled-back'
}

/**
 * Settles a cut-short Save on `key` for a reader, without waiting: the common case (nothing in flight) is one read of a
 * blob that is not there. While the dead server's lease is still running there is nothing to do yet, and the reader
 * carries on. Resolves to what `recoverInterruptedSave` does, or `'none'`.
 */
export async function recoverIfInterrupted(storage, key, { ttlMs } = {}) {
  if ((await readJournal(storage, key)) === null) return 'none'
  try {
    return await withLease(storage, key, () => recoverInterruptedSave(storage, key), { ttlMs, waitMs: 0 })
  } catch (err) {
    if (err instanceof StorageLeaseHeldError) return 'none'
    throw err
  }
}

/**
 * Writes `files` (`[{ path, text }]`) so that they all land or none do. Call it holding the lease on `key`, after
 * `recoverInterruptedSave`. Each file's write is conditional on the version read here, so a file changed behind the Save
 * (a lease that ran out under a slow server) is refused rather than overwritten, and the Save is rolled back.
 *
 * `beforeEachWrite` runs before every file: the caller renews its lease there, so a Save that has lost the lease stops
 * (`StorageLeaseLostError`, left for whoever took the lease to settle) instead of writing on.
 *
 * Resolves to the paths written, in order. A file whose text is already what is saved is not rewritten.
 */
export async function writeFilesAllOrNothing(storage, key, files, { beforeEachWrite } = {}) {
  const plan = []
  for (const { path, text } of files) {
    const current = await getTextVersionedOrNull(storage, path)
    if (current && current.text === text) continue
    plan.push({ path, text, before: current ? current.text : null, version: current ? current.version : null })
  }
  if (plan.length === 0) return []

  const entries = plan.map(({ path, text, before }) => ({ path, before, after: sha(text) }))
  await storage.putText(journalPathFor(key), `${JSON.stringify({ version: 1, key, createdAt: new Date().toISOString(), writes: entries })}\n`)
  const written = []
  try {
    for (const { path, text, version } of plan) {
      if (beforeEachWrite) await beforeEachWrite()
      await storage.putText(path, text, { ifVersion: version })
      written.push(path)
    }
  } catch (err) {
    if (err instanceof StorageLeaseLostError) throw err
    // Roll back from the record, not from what was counted written: a write whose answer was lost may have landed.
    for (const entry of entries) await restore(storage, entry)
    await removeJournal(storage, key)
    throw err
  }
  try {
    await removeJournal(storage, key)
  } catch {
    // Every file holds the Save's text, which is exactly what recovery reads as "finished": the record is harmless.
  }
  return written
}
