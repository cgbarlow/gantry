import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubClient, GitHubAuthenticationError, GitHubNotFoundError } from '../lib/gitHubClient.js'
import { AuthenticationError, NotFoundError } from '../lib/providerErrors.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'

// #19 (ADR-0037, ADR-0039): lib/gitHubClient.js's read-only content-store subset — the primitive
// lib/definitionGitHub.js (and so lib/libraryCache.js's GitHub-backed refresh) builds on. Exercised
// over real `fetch` against tests/helpers/fakeGitHubServer.js, never a mocked `fetch`, per #1's own
// Testing Decisions.

const OWNER = 'fake-owner'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'github-test-pat'

test('getFileContent reads an existing file back unchanged', async () => {
  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT, files: { 'definitions/design/1/definition.yaml': 'id: design\n' } }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    const content = await client.getFileContent('definitions/design/1/definition.yaml')
    assert.equal(content, 'id: design\n')
  })
})

test('getFileContent on a missing path throws the neutral NotFoundError, tagged github', async () => {
  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    await assert.rejects(() => client.getFileContent('does/not/exist.yaml'), (err) => {
      assert.ok(err instanceof GitHubNotFoundError)
      assert.ok(err instanceof NotFoundError, 'also catchable as the neutral NotFoundError')
      assert.equal(err.provider, 'github')
      return true
    })
  })
})

test('getFileContent on a directory path throws NotFoundError (a directory is not a file)', async () => {
  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT, files: { 'definitions/design/1/definition.yaml': 'id: design\n' } }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    await assert.rejects(() => client.getFileContent('definitions/design'), GitHubNotFoundError)
  })
})

test('fileExists is true after a file is present, false for an unwritten path', async () => {
  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT, files: { 'exists.md': 'x\n' } }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    assert.equal(await client.fileExists('exists.md'), true)
    assert.equal(await client.fileExists('does-not-exist.md'), false)
  })
})

test('listFolder lists immediate children only, sorted by path, and [] for a folder that does not exist', async () => {
  await withFakeGitHubServer(
    {
      owner: OWNER,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        'definitions/design/1/definition.yaml': 'id: design\n',
        'definitions/design/2/definition.yaml': 'id: design\n',
        'definitions/widget/1/definition.yaml': 'id: widget\n',
      },
    },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
      const top = await client.listFolder('definitions')
      assert.deepEqual(top.map((e) => e.path).sort(), ['definitions/design', 'definitions/widget'])
      assert.ok(top.every((e) => e.isFolder))

      const designVersions = await client.listFolder('definitions/design')
      assert.deepEqual(designVersions.map((e) => e.path), ['definitions/design/1', 'definitions/design/2'])

      assert.deepEqual(await client.listFolder('definitions/nope'), [])
    }
  )
})

test('repoExists is true for a real repo and false when the fake reports it missing', async () => {
  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    assert.equal(await client.repoExists(), true)
  })

  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT, repoExists: false }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    assert.equal(await client.repoExists(), false)
  })
})

test('a rejected PAT surfaces as the neutral AuthenticationError, tagged github', async () => {
  await withFakeGitHubServer({ owner: OWNER, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: OWNER, repository: REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => client.getFileContent('anything.md'), (err) => {
      assert.ok(err instanceof GitHubAuthenticationError)
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'github')
      return true
    })
  })
})

test('createGitHubClient requires owner, repository and pat', () => {
  assert.throws(() => createGitHubClient({ repository: REPOSITORY, pat: VALID_PAT }), /"owner" is required/)
  assert.throws(() => createGitHubClient({ owner: OWNER, pat: VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitHubClient({ owner: OWNER, repository: REPOSITORY }), /"pat" is required/)
})
