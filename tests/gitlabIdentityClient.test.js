import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitLabIdentityClient } from '../lib/gitlabIdentityClient.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'

// GitLab's identity capability (#28, docs/adr/0041 mirroring docs/adr/0040's GitHub person-picker
// design) — exercised over real `fetch` against a real in-process fake GitLab server, never a mock of
// `fetch` itself, per the spec's own Testing Decisions.

function withServer(options, fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, ...options }, fn)
}

function client(baseUrl, overrides = {}) {
  return createGitLabIdentityClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl, ...overrides })
}

test('searchIdentities returns [] for an empty or blank query without hitting the network', async () => {
  const identity = createGitLabIdentityClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: 'http://localhost:1' })
  assert.deepEqual(await identity.searchIdentities(''), [])
  assert.deepEqual(await identity.searchIdentities('   '), [])
})

test('searchIdentities returns a Reporter-or-above member as assignable, matching by substring', async () => {
  await withServer({ members: [{ id: 1, username: 'ana-reporter', name: 'Ana', access_level: 20 }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('ana')
    assert.equal(results.length, 1)
    assert.equal(results[0].uniqueName, 'ana-reporter')
    assert.equal(results[0].displayName, 'Ana')
    assert.equal(results[0].canAssign, true)
    assert.equal(results[0].blockedReason, undefined)
  })
})

test('searchIdentities includes members inherited through a group, indistinguishably from direct members', async () => {
  // The fake models GitLab's own /members/all as one flat list regardless of origin — this simply
  // proves the client doesn't try to filter or re-derive that distinction itself.
  await withServer(
    {
      members: [
        { id: 1, username: 'direct-member', name: 'Direct', access_level: 30 },
        { id: 2, username: 'inherited-member', name: 'Inherited', access_level: 30 },
      ],
    },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('member')
      const logins = results.map((r) => r.uniqueName).sort()
      assert.deepEqual(logins, ['direct-member', 'inherited-member'])
    }
  )
})

test('a Guest member (access_level 10) is shown but blocked, with guidance to grant Reporter access', async () => {
  await withServer({ members: [{ id: 3, username: 'guest-only', name: 'Guest', access_level: 10 }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('guest-only')
    assert.equal(results.length, 1)
    assert.equal(results[0].canAssign, false)
    assert.match(results[0].blockedReason, /Reporter access/)
    assert.match(results[0].blockedReason, /guest-only/)
  })
})

test('a Reporter (access_level 20) is exactly the assignability boundary — assignable', async () => {
  await withServer({ members: [{ id: 4, username: 'exactly-reporter', name: 'R', access_level: 20 }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('exactly-reporter')
    assert.equal(results[0].canAssign, true)
  })
})

test('resolveIdentity finds an exact username match, and null for no match', async () => {
  await withServer({ members: [{ id: 1, username: 'exact-match', name: 'Exact', access_level: 30 }] }, async (baseUrl) => {
    const identity = client(baseUrl)
    const resolved = await identity.resolveIdentity('exact-match')
    assert.equal(resolved.uniqueName, 'exact-match')
    assert.equal(await identity.resolveIdentity('nobody-matches-this'), null)
    assert.equal(await identity.resolveIdentity(''), null)
  })
})

test('a rejected PAT surfaces as the neutral AuthenticationError, tagged "gitlab"', async () => {
  await withServer({ members: [{ id: 1, username: 'ana', name: 'Ana', access_level: 30 }] }, async (baseUrl) => {
    const identity = client(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(() => identity.searchIdentities('ana'), (err) => {
      assert.ok(err instanceof AuthenticationError, `expected AuthenticationError, got ${err.name}`)
      assert.equal(err.provider, 'gitlab')
      return true
    })
  })
})

test('createGitLabIdentityClient requires namespace, repository and pat', () => {
  assert.throws(() => createGitLabIdentityClient({ repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT }), /"namespace" is required/)
  assert.throws(() => createGitLabIdentityClient({ namespace: GITLAB_NAMESPACE, pat: GITLAB_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitLabIdentityClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY }), /"pat" is required/)
})
