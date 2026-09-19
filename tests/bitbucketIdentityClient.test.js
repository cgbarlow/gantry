import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBitbucketIdentityClient } from '../lib/bitbucketIdentityClient.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// Bitbucket's identity capability (#44, docs/adr/0042 mirroring docs/adr/0040/0041's GitHub/GitLab
// person-picker design) — exercised over real `fetch` against a real in-process fake Bitbucket server,
// never a mock of `fetch` itself, per the spec's own Testing Decisions.

function withServer(options, fn) {
  return withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, ...options }, fn)
}

function client(baseUrl, overrides = {}) {
  return createBitbucketIdentityClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl, ...overrides })
}

test('searchIdentities returns [] for an empty or blank query without hitting the network', async () => {
  const identity = createBitbucketIdentityClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl: 'http://localhost:1' })
  assert.deepEqual(await identity.searchIdentities(''), [])
  assert.deepEqual(await identity.searchIdentities('   '), [])
})

test('searchIdentities returns a write-access member as assignable, matching by substring against nickname', async () => {
  await withServer(
    { permissions: [{ uuid: '{uuid-1}', accountId: 'acct-1', displayName: 'Ana', nickname: 'ana-writer', permission: 'write' }] },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('ana')
      assert.equal(results.length, 1)
      assert.equal(results[0].uniqueName, 'ana-writer')
      assert.equal(results[0].displayName, 'Ana')
      assert.equal(results[0].id, '{uuid-1}')
      assert.equal(results[0].canAssign, true)
      assert.equal(results[0].blockedReason, undefined)
    }
  )
})

test('searchIdentities matches by substring against display name too, not only nickname', async () => {
  await withServer(
    { permissions: [{ uuid: '{uuid-2}', accountId: 'acct-2', displayName: 'Bob Builder', nickname: 'bb', permission: 'admin' }] },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('builder')
      assert.equal(results.length, 1)
      assert.equal(results[0].uniqueName, 'bb')
    }
  )
})

test('an admin permission is assignable, same as write', async () => {
  await withServer(
    { permissions: [{ uuid: '{uuid-3}', accountId: 'acct-3', displayName: 'Carol', nickname: 'carol-admin', permission: 'admin' }] },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('carol')
      assert.equal(results[0].canAssign, true)
    }
  )
})

test('a read-only member (below the write threshold) is shown but blocked, with guidance to grant write access', async () => {
  await withServer(
    { permissions: [{ uuid: '{uuid-4}', accountId: 'acct-4', displayName: 'Dana', nickname: 'dana-reader', permission: 'read' }] },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('dana-reader')
      assert.equal(results.length, 1)
      assert.equal(results[0].canAssign, false)
      assert.match(results[0].blockedReason, /write.*access/i)
      assert.match(results[0].blockedReason, /dana-reader/)
    }
  )
})

test('resolveIdentity finds an exact nickname match, and null for no match', async () => {
  await withServer(
    { permissions: [{ uuid: '{uuid-5}', accountId: 'acct-5', displayName: 'Exact', nickname: 'exact-match', permission: 'write' }] },
    async (baseUrl) => {
      const identity = client(baseUrl)
      const resolved = await identity.resolveIdentity('exact-match')
      assert.equal(resolved.uniqueName, 'exact-match')
      assert.equal(await identity.resolveIdentity('nobody-matches-this'), null)
      assert.equal(await identity.resolveIdentity(''), null)
    }
  )
})

test('a rejected token surfaces as the neutral AuthenticationError, tagged "atlassian"', async () => {
  await withServer(
    { permissions: [{ uuid: '{uuid-6}', accountId: 'acct-6', displayName: 'Ana', nickname: 'ana', permission: 'write' }] },
    async (baseUrl) => {
      const identity = client(baseUrl, { pat: 'wrong-token' })
      await assert.rejects(() => identity.searchIdentities('ana'), (err) => {
        assert.ok(err instanceof AuthenticationError, `expected AuthenticationError, got ${err.name}`)
        assert.equal(err.provider, 'atlassian')
        return true
      })
    }
  )
})

test('createBitbucketIdentityClient requires owner, repository and pat', () => {
  assert.throws(() => createBitbucketIdentityClient({ repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT }), /"owner" is required/)
  assert.throws(() => createBitbucketIdentityClient({ owner: BITBUCKET_OWNER, pat: BITBUCKET_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createBitbucketIdentityClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY }), /"pat" is required/)
})
