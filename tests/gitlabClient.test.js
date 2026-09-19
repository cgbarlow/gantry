import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitLabClient, GitLabAuthenticationError, GitLabNotFoundError } from '../lib/gitlabClient.js'
import { AuthenticationError, NotFoundError } from '../lib/providerErrors.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'

// lib/gitlabClient.js's read-only scope (#27, ADR-0041): reading an existing file/folder over
// GitLab's Repository Files/Tree API — the primitive lib/definitionGitLab.js (and so
// lib/libraryCache.js's GitLab-backed refresh) builds on. Exercised over real `fetch` against
// tests/helpers/fakeGitLabServer.js, never a mocked `fetch`, per #1's own Testing Decisions.

test('createGitLabClient requires namespace, repository and pat', () => {
  assert.throws(() => createGitLabClient({ repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT }), /"namespace" is required/)
  assert.throws(() => createGitLabClient({ namespace: GITLAB_NAMESPACE, pat: GITLAB_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY }), /"pat" is required/)
  // Synchronously, not left to fail on the first request — an empty string is as absent as `undefined`.
  assert.throws(() => createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: '' }), /"pat" is required/)
})

// ---------- getFileContent / fileExists ----------

test('getFileContent reads an existing file\'s raw text content', async () => {
  await withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: { 'definitions/widget/1/definition.yaml': 'id: widget\n' } },
    async (baseUrl) => {
      const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
      const content = await client.getFileContent('definitions/widget/1/definition.yaml')
      assert.equal(content, 'id: widget\n')
    }
  )
})

test('getFileContent throws GitLabNotFoundError (a NotFoundError) for a missing file', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: {} }, async (baseUrl) => {
    const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
    await assert.rejects(() => client.getFileContent('nope.yaml'), GitLabNotFoundError)
    await assert.rejects(() => client.getFileContent('nope.yaml'), NotFoundError)
  })
})

test('getFileContent throws GitLabAuthenticationError (an AuthenticationError) when GitLab rejects the PAT', async () => {
  await withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: { 'a.yaml': 'x' } },
    async (baseUrl) => {
      const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: 'wrong-pat', baseUrl })
      await assert.rejects(() => client.getFileContent('a.yaml'), GitLabAuthenticationError)
      await assert.rejects(() => client.getFileContent('a.yaml'), AuthenticationError)
    }
  )
})

test('fileExists is true for a real file and false for a missing one', async () => {
  await withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: { 'a.yaml': 'x' } },
    async (baseUrl) => {
      const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
      assert.equal(await client.fileExists('a.yaml'), true)
      assert.equal(await client.fileExists('nope.yaml'), false)
    }
  )
})

// ---------- listFolder ----------

test('listFolder lists immediate children, sorted, distinguishing files from folders', async () => {
  await withFakeGitLabServer(
    {
      namespace: GITLAB_NAMESPACE,
      repository: GITLAB_REPOSITORY,
      validPat: GITLAB_VALID_PAT,
      files: {
        'definitions/widget/1/definition.yaml': 'a',
        'definitions/widget/1/modules/intro.yaml': 'b',
        'definitions/widget/2/definition.yaml': 'c',
      },
    },
    async (baseUrl) => {
      const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
      const entries = await client.listFolder('definitions/widget')
      assert.deepEqual(entries, [
        { path: 'definitions/widget/1', isFolder: true },
        { path: 'definitions/widget/2', isFolder: true },
      ])
    }
  )
})

test('listFolder returns [] (not an error) for a folder that does not exist', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: {} }, async (baseUrl) => {
    const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
    assert.deepEqual(await client.listFolder('definitions'), [])
  })
})

test('listFolder addresses the project by its full namespace/repository path, URL-encoded as a single :id segment', async () => {
  await withFakeGitLabServer(
    { namespace: 'engineering/platform/backend-services', repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: { 'definitions/x/1/definition.yaml': 'a' } },
    async (baseUrl) => {
      const client = createGitLabClient({ namespace: 'engineering/platform/backend-services', repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
      assert.deepEqual(await client.listFolder('definitions'), [{ path: 'definitions/x', isFolder: true }])
    }
  )
})
