import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError, providerDisplayName } from '../lib/providerErrors.js'
import * as azureDevOpsClient from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'
import { ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// #7, docs/adr/0039: the contract half of #2's expand-contract. Azure DevOps throws these four
// neutral classes directly (no more AzureDevOps*Error vendor subclasses — every catch site across
// the codebase now catches the neutral type), each tagged `provider: 'azure-devops'` at the point of
// construction. This file is the one place that exercises the taxonomy itself; per-client behaviour
// (which HTTP status maps to which class) stays covered by tests/azureDevOpsClient.test.js and its
// three siblings.

test('the four neutral error classes are Errors, distinct from each other, and correctly named', () => {
  const classes = [AuthenticationError, NotFoundError, RepoNotFoundError, RequestError]
  for (const Cls of classes) {
    const err = new Cls('x', { provider: 'azure-devops' })
    assert.ok(err instanceof Error)
    assert.equal(err.name, Cls.name)
  }
  assert.notEqual(AuthenticationError, NotFoundError)
  assert.notEqual(NotFoundError, RepoNotFoundError)
  assert.notEqual(RepoNotFoundError, RequestError)
  assert.ok(!(new AuthenticationError('x', { provider: 'azure-devops' }) instanceof NotFoundError))
})

test('RequestError keeps its status/body alongside the provider tag', () => {
  const err = new RequestError('failed', { status: 500, body: 'raw response text', provider: 'azure-devops' })
  assert.equal(err.provider, 'azure-devops')
  assert.equal(err.status, 500)
  assert.equal(err.body, 'raw response text')
})

test('providerDisplayName maps known provider ids to a human-readable name and falls back to the raw id otherwise', () => {
  assert.equal(providerDisplayName('azure-devops'), 'Azure DevOps')
  assert.equal(providerDisplayName('github'), 'GitHub')
  assert.equal(providerDisplayName('gitlab'), 'GitLab')
  assert.equal(providerDisplayName('atlassian'), 'Atlassian')
  assert.equal(providerDisplayName('some-future-provider'), 'some-future-provider')
})

test('lib/azureDevOpsClient.js no longer exports any Azure-DevOps-named error class', () => {
  for (const name of ['AzureDevOpsAuthenticationError', 'AzureDevOpsNotFoundError', 'AzureDevOpsRepoNotFoundError', 'AzureDevOpsRequestError']) {
    assert.equal(name in azureDevOpsClient, false, `${name} should have been deleted (#7)`)
  }
})

test('a real Azure DevOps failure (over the fake server) throws the neutral class tagged "azure-devops"', async () => {
  await withFakeServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} }, async (baseUrl) => {
    const badClient = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => badClient.getFileContent('/instance.yaml'), (err) => {
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'azure-devops')
      return true
    })

    const goodClient = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    await assert.rejects(() => goodClient.getFileContent('/does-not-exist.md'), (err) => {
      assert.ok(err instanceof NotFoundError)
      assert.equal(err.provider, 'azure-devops')
      return true
    })
  })
})
