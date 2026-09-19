import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJiraIdentityClient } from '../lib/jiraIdentityClient.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withFakeJiraServer, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'

// Jira's identity capability (#45, docs/adr/0042 mirroring docs/adr/0040/0041's GitHub/GitLab
// person-picker design, applied to Jira's own "Assignable User" permission and `accountId`
// identifiers) — exercised over real `fetch` against a real in-process fake Jira server, never a mock
// of `fetch` itself, mirroring `tests/gitlabIdentityClient.test.js`'s own structure.

function withServer(options, fn) {
  return withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT, ...options }, fn)
}

function client(baseUrl, overrides = {}) {
  return createJiraIdentityClient({ jiraSite: 'unused.atlassian.net', jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT, baseUrl, ...overrides })
}

test('searchIdentities returns [] for an empty or blank query without hitting the network', async () => {
  const identity = createJiraIdentityClient({ jiraSite: 'unused.atlassian.net', jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT, baseUrl: 'http://localhost:1' })
  assert.deepEqual(await identity.searchIdentities(''), [])
  assert.deepEqual(await identity.searchIdentities('   '), [])
})

test('searchIdentities returns an Assignable-User as assignable, matching by substring', async () => {
  await withServer({ users: [{ accountId: 'acc-1', displayName: 'Ana Assignable', emailAddress: 'ana@example.com', assignable: true }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('ana')
    assert.equal(results.length, 1)
    assert.equal(results[0].uniqueName, 'acc-1')
    assert.equal(results[0].displayName, 'Ana Assignable')
    assert.equal(results[0].emailAddress, 'ana@example.com')
    assert.equal(results[0].canAssign, true)
    assert.equal(results[0].blockedReason, undefined)
  })
})

test('a site user without the Assignable User permission is shown but blocked, with guidance to grant it and retry', async () => {
  await withServer({ users: [{ accountId: 'acc-2', displayName: 'Bea Blocked', assignable: false }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('bea')
    assert.equal(results.length, 1)
    assert.equal(results[0].canAssign, false)
    assert.match(results[0].blockedReason, /Assignable User/)
    assert.match(results[0].blockedReason, /Bea Blocked/)
  })
})

test('identifies candidates by accountId, never username or email', async () => {
  await withServer({ users: [{ accountId: 'acc-3', displayName: 'Cid Carter', emailAddress: 'cid@example.com', assignable: true }] }, async (baseUrl) => {
    const results = await client(baseUrl).searchIdentities('cid')
    assert.equal(results[0].uniqueName, 'acc-3')
    assert.equal(results[0].id, 'acc-3')
  })
})

test('resolveIdentity finds an exact accountId match, and null for no match', async () => {
  await withServer({ users: [{ accountId: 'acc-4', displayName: 'Dee Direct', assignable: true }] }, async (baseUrl) => {
    const identity = client(baseUrl)
    const resolved = await identity.resolveIdentity('acc-4')
    assert.equal(resolved.uniqueName, 'acc-4')
    assert.equal(resolved.displayName, 'Dee Direct')
    assert.equal(await identity.resolveIdentity('nobody-matches-this'), null)
    assert.equal(await identity.resolveIdentity(''), null)
  })
})

test('resolveIdentity also matches by display name, for a caller with no accountId in hand yet', async () => {
  await withServer({ users: [{ accountId: 'acc-5', displayName: 'Eve Example', assignable: true }] }, async (baseUrl) => {
    const identity = client(baseUrl)
    const resolved = await identity.resolveIdentity('Eve Example')
    assert.equal(resolved.uniqueName, 'acc-5')
  })
})

test('a rejected token surfaces as the neutral AuthenticationError, tagged "atlassian"', async () => {
  await withServer({ users: [{ accountId: 'acc-6', displayName: 'Fay', assignable: true }] }, async (baseUrl) => {
    const identity = client(baseUrl, { pat: 'wrong-token' })
    await assert.rejects(() => identity.searchIdentities('fay'), (err) => {
      assert.ok(err instanceof AuthenticationError, `expected AuthenticationError, got ${err.name}`)
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('createJiraIdentityClient requires jiraSite, jiraProjectKey and pat', () => {
  assert.throws(() => createJiraIdentityClient({ jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT }), /"jiraSite" is required/)
  assert.throws(() => createJiraIdentityClient({ jiraSite: 'x.atlassian.net', pat: JIRA_VALID_PAT }), /"jiraProjectKey" is required/)
  assert.throws(() => createJiraIdentityClient({ jiraSite: 'x.atlassian.net', jiraProjectKey: JIRA_PROJECT_KEY }), /"pat" is required/)
})
