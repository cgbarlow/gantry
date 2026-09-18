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
  assert.throws(() => getProviderCapabilities('github'), /no provider registered for "github"/)
  assert.throws(() => getProviderCapabilities('github'), /azure-devops/)
  assert.throws(() => getProviderCapabilities('atlassian'), /no provider registered for "atlassian"/)
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
