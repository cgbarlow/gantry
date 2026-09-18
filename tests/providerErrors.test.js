import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from '../lib/providerErrors.js'
import {
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRepoNotFoundError,
  AzureDevOpsRequestError,
} from '../lib/azureDevOpsClient.js'

// #2, docs/adr/0039: the vendor-named Azure DevOps error classes must extend
// the provider-neutral ones (the expand half of an expand-contract) while
// keeping every existing `instanceof AzureDevOps*Error` catch site working
// unchanged, and every instance must carry a 'azure-devops' provider tag.

test('AzureDevOpsAuthenticationError extends the neutral AuthenticationError and is tagged "azure-devops"', () => {
  const err = new AzureDevOpsAuthenticationError('rejected', { status: 401 })
  assert.ok(err instanceof AuthenticationError)
  assert.ok(err instanceof AzureDevOpsAuthenticationError)
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'AzureDevOpsAuthenticationError')
  assert.equal(err.provider, 'azure-devops')
  assert.equal(err.status, 401)
})

test('AzureDevOpsNotFoundError extends the neutral NotFoundError and is tagged "azure-devops"', () => {
  const err = new AzureDevOpsNotFoundError('missing', { status: 404 })
  assert.ok(err instanceof NotFoundError)
  assert.ok(err instanceof AzureDevOpsNotFoundError)
  assert.equal(err.provider, 'azure-devops')
})

test('AzureDevOpsRepoNotFoundError extends the neutral RepoNotFoundError and is tagged "azure-devops"', () => {
  const err = new AzureDevOpsRepoNotFoundError('no such repo', { status: 404 })
  assert.ok(err instanceof RepoNotFoundError)
  assert.ok(err instanceof AzureDevOpsRepoNotFoundError)
  assert.equal(err.provider, 'azure-devops')
})

test('AzureDevOpsRequestError extends the neutral RequestError, is tagged "azure-devops", and keeps its body', () => {
  const err = new AzureDevOpsRequestError('failed', { status: 500, body: 'raw response text' })
  assert.ok(err instanceof RequestError)
  assert.ok(err instanceof AzureDevOpsRequestError)
  assert.equal(err.provider, 'azure-devops')
  assert.equal(err.body, 'raw response text')
})

test('a neutral error catch site catches the vendor-named subclass without naming a provider', () => {
  const thrown = new AzureDevOpsNotFoundError('missing')
  let caught
  try {
    throw thrown
  } catch (err) {
    if (err instanceof NotFoundError) caught = err
  }
  assert.equal(caught, thrown)
})

test('the four neutral error classes are distinct from each other', () => {
  assert.notEqual(AuthenticationError, NotFoundError)
  assert.notEqual(NotFoundError, RepoNotFoundError)
  assert.notEqual(RepoNotFoundError, RequestError)
  assert.ok(!(new AzureDevOpsAuthenticationError('x') instanceof NotFoundError))
})
