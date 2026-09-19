import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProviderCapabilities,
  registeredProviders,
  resolveContentStore,
  resolvePullRequests,
  resolveWorkItems,
  resolveIdentity,
} from '../lib/providerRegistry.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { runProviderContractTests } from './helpers/providerContractTests.js'

function withFakeAzureDevOpsServer(fn) {
  return withFakeServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, fn)
}

test('registeredProviders lists azure-devops', () => {
  assert.ok(registeredProviders().includes('azure-devops'))
})

test('getProviderCapabilities resolves azure-devops to its four capability factories', () => {
  const capabilities = getProviderCapabilities('azure-devops')
  assert.equal(typeof capabilities.contentStore, 'function')
  assert.equal(typeof capabilities.pullRequests, 'function')
  assert.equal(typeof capabilities.workItems, 'function')
  assert.equal(typeof capabilities.identity, 'function')
})

test('getProviderCapabilities throws a clear error naming the registered providers, for an unregistered provider id', () => {
  assert.throws(() => getProviderCapabilities('atlassian'), /no provider registered for "atlassian"/)
  assert.throws(() => getProviderCapabilities('atlassian'), /azure-devops/)
})

// #11/#10/#14: github joins the registry one capability per ticket as each lands (content store,
// then identity, then work items) — pullRequests is #13's job, registered here the same incremental
// way this file's own doc comment describes for Azure DevOps's own four clients.
test('registeredProviders lists github once its content store is registered', () => {
  assert.ok(registeredProviders().includes('github'))
})

test('getProviderCapabilities resolves github to its content-store, identity and work-items factories, so far', () => {
  const capabilities = getProviderCapabilities('github')
  assert.equal(typeof capabilities.contentStore, 'function')
  assert.equal(typeof capabilities.identity, 'function')
  assert.equal(typeof capabilities.workItems, 'function')
  assert.equal(capabilities.pullRequests, undefined)
})

// #14: resolveWorkItems instantiates GitHub's Issues-backed client through the registry, the same
// seam `lib/workItemLink.js` uses — not the Azure-DevOps-shaped field-map API
// `runProviderContractTests` below exercises (GitHub issues have no typed fields to map), so this is
// asserted directly here rather than folded into that shared suite.
test('resolveWorkItems instantiates github\'s work-items client', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT },
    async (baseUrl) => {
      const workItems = resolveWorkItems('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const created = await workItems.createIssue({ title: 'Registry smoke test', body: '' })
      assert.ok(created.number)
    }
  )
})

test('resolveIdentity instantiates github\'s identity client', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, collaborators: [{ login: 'ana', id: 1 }] },
    async (baseUrl) => {
      const identity = resolveIdentity('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const resolved = await identity.resolveIdentity('ana')
      assert.equal(resolved.uniqueName, 'ana')
      assert.equal(resolved.canAssign, true)
    }
  )
})

test('resolveContentStore/resolvePullRequests/resolveWorkItems/resolveIdentity instantiate azure-devops\'s existing clients', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const config = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }

    const contentStore = resolveContentStore('azure-devops', config)
    assert.equal(await contentStore.repoExists(), true)

    const workItems = resolveWorkItems('azure-devops', config)
    const workItem = await workItems.createWorkItem('Task', { 'System.Title': 'Registry smoke test' })
    assert.ok(workItem.id)

    const pullRequests = resolvePullRequests('azure-devops', config)
    assert.equal(typeof pullRequests.createPullRequest, 'function')

    const identity = resolveIdentity('azure-devops', config)
    const resolved = await identity.resolveIdentity('Test User')
    assert.ok(resolved)
  })
})

// The contract test suite (#2, docs/adr/0039): the same assertions any
// future provider's four capabilities must satisfy, run here against
// Azure DevOps's registered implementation.
runProviderContractTests('azure-devops', {
  providerId: 'azure-devops',
  withServer: withFakeAzureDevOpsServer,
  buildCapabilities: (baseUrl, overrides = {}) => {
    const config = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, ...overrides }
    return {
      contentStore: resolveContentStore('azure-devops', config),
      pullRequests: resolvePullRequests('azure-devops', config),
      workItems: resolveWorkItems('azure-devops', config),
      identity: resolveIdentity('azure-devops', config),
    }
  },
  badCredential: 'wrong-pat',
  knownIdentityQuery: 'Test User',
  unknownIdentityQuery: 'Nobody Matches This Query',
})
