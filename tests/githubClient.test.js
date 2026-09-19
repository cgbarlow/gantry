import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubClient, GitHubAuthenticationError, GitHubRepoNotFoundError } from '../lib/githubClient.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

test('createGitHubClient requires owner/repository/pat', () => {
  assert.throws(() => createGitHubClient({ repository: 'r', pat: 'p' }), /"owner" is required/)
  assert.throws(() => createGitHubClient({ owner: 'o', pat: 'p' }), /"repository" is required/)
  assert.throws(() => createGitHubClient({ owner: 'o', repository: 'r' }), /"pat" is required/)
})

test('getRepo resolves the repository metadata when the PAT is accepted and the repo exists', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const repo = await client.getRepo()
    assert.equal(repo.name, GITHUB_REPOSITORY)
    assert.equal(repo.owner.login, GITHUB_OWNER)
  })
})

test('repoExists is true when the repo exists and the PAT is accepted', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    assert.equal(await client.repoExists(), true)
  })
})

test('getRepo throws GitHubAuthenticationError when GitHub rejects the PAT', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => client.getRepo(), GitHubAuthenticationError)
  })
})

test('createGitHubClient throws synchronously (not left to fail on first request) when pat is empty', () => {
  assert.throws(() => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: '' }), /"pat" is required/)
})

test('getRepo throws GitHubRepoNotFoundError when the repository does not exist', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getRepo(), GitHubRepoNotFoundError)
    }
  )
})

test('repoExists is false, not thrown, when the repository does not exist', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      assert.equal(await client.repoExists(), false)
    }
  )
})

test('every thrown error is tagged with provider: "github"', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      try {
        await client.getRepo()
        assert.fail('expected getRepo to throw')
      } catch (err) {
        assert.equal(err.provider, 'github')
      }
    }
  )
})

test('a GitHub Enterprise Server-shaped baseUrl (a host + /api/v3 path) is honoured as-is', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    // The fake server has no real /api/v3 prefix of its own — this only proves the client sends
    // requests to exactly the baseUrl it was given, the same convention a real GHES host would need.
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    assert.equal(client.baseUrl, baseUrl)
    await client.getRepo()
  })
})
