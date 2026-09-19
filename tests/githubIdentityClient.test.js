import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubIdentityClient } from '../lib/githubIdentityClient.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// GitHub's identity capability (#10, docs/adr/0040 "The person picker unions collaborators with org
// members, and gates assignment on access") — exercised over real `fetch` against a real in-process
// fake GitHub server, never a mock of `fetch` itself, per the spec's own Testing Decisions.

function withServer(options, fn) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, ...options }, fn)
}

function client(baseUrl, overrides = {}) {
  return createGitHubIdentityClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl, ...overrides })
}

test('searchIdentities returns [] for an empty or blank query without hitting the network', async () => {
  const identity = createGitHubIdentityClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: 'http://localhost:1' })
  assert.deepEqual(await identity.searchIdentities(''), [])
  assert.deepEqual(await identity.searchIdentities('   '), [])
})

test('searchIdentities returns a direct collaborator as assignable, matching by substring', async () => {
  await withServer({ collaborators: [{ login: 'ana-collaborator', id: 1 }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('ana')
    assert.equal(results.length, 1)
    assert.equal(results[0].uniqueName, 'ana-collaborator')
    assert.equal(results[0].displayName, 'ana-collaborator')
    assert.equal(results[0].canAssign, true)
    assert.equal(results[0].blockedReason, undefined)
  })
})

test('searchIdentities unions collaborators and org members, de-duplicated by login', async () => {
  await withServer(
    {
      ownerType: 'Organization',
      collaborators: [{ login: 'sam', id: 1 }],
      orgMembers: [
        { login: 'sam', id: 1 }, // also a collaborator — must not appear twice
        { login: 'sadie', id: 2 },
      ],
      permissions: { sadie: 'write' },
    },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('sa')
      const logins = results.map((r) => r.uniqueName).sort()
      assert.deepEqual(logins, ['sadie', 'sam'])
    }
  )
})

test('an organization member granted access only through a team resolves as assignable', async () => {
  await withServer(
    {
      ownerType: 'Organization',
      collaborators: [],
      orgMembers: [{ login: 'team-granted', id: 5 }],
      permissions: { 'team-granted': 'write' },
    },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('team-granted')
      assert.equal(results.length, 1)
      assert.equal(results[0].canAssign, true)
    }
  )
})

test('an organization member with no repository access is shown but blocked, with guidance', async () => {
  await withServer(
    {
      ownerType: 'Organization',
      collaborators: [],
      orgMembers: [{ login: 'no-access', id: 6 }],
      // No entry in `permissions` -> fake server reports 'none'.
    },
    async (baseUrl) => {
      const results = await client(baseUrl).searchIdentities('no-access')
      assert.equal(results.length, 1)
      assert.equal(results[0].canAssign, false)
      assert.match(results[0].blockedReason, /grant repository access/)
      assert.match(results[0].blockedReason, /no-access/)
    }
  )
})

test('a personal-account (non-organization) repo never searches org members', async () => {
  await withServer(
    { ownerType: 'User', collaborators: [{ login: 'solo-collaborator', id: 1 }] },
    async (baseUrl) => {
      // Org-members endpoint 404s for a personal account — searchIdentities must not even attempt it,
      // and a query matching nobody real must not throw.
      const results = await client(baseUrl).searchIdentities('nobody-matches-this')
      assert.deepEqual(results, [])
    }
  )
})

test('resolveIdentity finds an exact login match, and null for no match', async () => {
  await withServer({ collaborators: [{ login: 'exact-match', id: 1 }] }, async (baseUrl) => {
    const identity = client(baseUrl)
    const resolved = await identity.resolveIdentity('exact-match')
    assert.equal(resolved.uniqueName, 'exact-match')
    assert.equal(await identity.resolveIdentity('nobody-matches-this'), null)
    assert.equal(await identity.resolveIdentity(''), null)
  })
})

test('a rejected PAT surfaces as the neutral AuthenticationError, tagged "github"', async () => {
  await withServer({ collaborators: [{ login: 'ana', id: 1 }] }, async (baseUrl) => {
    const identity = client(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(() => identity.searchIdentities('ana'), (err) => {
      assert.ok(err instanceof AuthenticationError, `expected AuthenticationError, got ${err.name}`)
      assert.equal(err.provider, 'github')
      return true
    })
  })
})

test('createGitHubIdentityClient requires owner, repository and pat', () => {
  assert.throws(() => createGitHubIdentityClient({ repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT }), /"owner" is required/)
  assert.throws(() => createGitHubIdentityClient({ owner: GITHUB_OWNER, pat: GITHUB_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitHubIdentityClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY }), /"pat" is required/)
})
