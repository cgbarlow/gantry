// #271 (docs/adr/0070): a create-only write (`ifVersion: null`, sent as `If-None-Match: *`) that finds the blob already
// there is a conflict whether the service answers 409 or 412. #259 could not verify which Azure sends, so lib/blobStorage.js
// must not depend on it. Azurite answers one of them (the Azurite test in tests/blobStorage.test.js covers that); this
// drives both with a stand-in container client, along with the service's own error code arriving without a status.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createBlobStorage } from '../lib/blobStorage.js'
import { StorageConflictError, StorageLeaseHeldError } from '../lib/storage.js'

const restError = (statusCode, errorCode) => Object.assign(new Error(`signed https://x.blob.core.windows.net/c/f?sig=SECRET answered ${statusCode}`), { statusCode, details: { errorCode } })

function containerAnswering(error) {
  const calls = []
  return {
    calls,
    getBlockBlobClient: (name) => ({
      uploadData: async (data, options) => {
        calls.push({ name, options })
        throw error
      },
      getBlobLeaseClient: () => ({ leaseId: 'lease-1', acquireLease: async () => { throw restError(409, 'LeaseAlreadyPresent') } }),
    }),
  }
}

describe('a create-only write to a blob that already exists', () => {
  for (const [label, error] of [
    ['409 BlobAlreadyExists', restError(409, 'BlobAlreadyExists')],
    ['412 ConditionNotMet', restError(412, 'ConditionNotMet')],
    ['409 with no error code', restError(409)],
    ['no status, only the BlobAlreadyExists code', Object.assign(new Error('exists'), { code: 'BlobAlreadyExists' })],
  ]) {
    test(`is a conflict when Azure answers ${label}`, async () => {
      const container = containerAnswering(error)
      const storage = createBlobStorage(container)
      await assert.rejects(storage.putText('ws/workspace.json', '{}', { ifVersion: null }), (err) => {
        assert.ok(err instanceof StorageConflictError)
        assert.match(err.message, /ws\/workspace\.json/)
        assert.match(err.message, /already exists/)
        assert.doesNotMatch(err.message, /SECRET|sig=/, 'the SDK message, which can carry a signed URL, never leaves the module')
        return true
      })
      assert.deepEqual(container.calls[0].options.conditions, { ifNoneMatch: '*' })
    })
  }

  test('a write conditional on a version is a conflict on 412, and a failure that is neither is not mistaken for one', async () => {
    await assert.rejects(createBlobStorage(containerAnswering(restError(412, 'ConditionNotMet'))).putText('f', 'x', { ifVersion: '"etag"' }), StorageConflictError)
    await assert.rejects(createBlobStorage(containerAnswering(restError(500, 'InternalError'))).putText('f', 'x', { ifVersion: null }), (err) => !(err instanceof StorageConflictError) && err.statusCode === 500 && !/SECRET/.test(err.message))
    await assert.rejects(createBlobStorage(containerAnswering(restError(409, 'BlobAlreadyExists'))).putText('f', 'x'), (err) => !(err instanceof StorageConflictError), 'an unconditional write never claims a conflict')
  })

  test('the lock blob a lease sits on is created create-only too: finding it already there (409 or 412) is the normal case, not a failure', async () => {
    for (const error of [restError(409, 'BlobAlreadyExists'), restError(412, 'ConditionNotMet')]) {
      const storage = createBlobStorage(containerAnswering(error))
      // The lock blob exists, so the next step is the lease itself, which the stand-in reports as held.
      await assert.rejects(storage.acquireLease('ws/cards'), StorageLeaseHeldError)
    }
  })
})
