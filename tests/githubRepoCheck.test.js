import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkGitHubRepo } from '../lib/repoCheck.js'
import { GitHubAuthenticationError, GitHubRepoNotFoundError } from '../lib/githubClient.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// checkGitHubRepo (#8): the "prove this PAT reaches this real repository" check POST
// /api/workspaces runs before registering a GitHub workspace — deliberately narrower than
// checkAzureDevOpsRepo (no gantry-workspace/<slug>/ content-store discovery yet, that's #11), so a
// successful check always reports 'empty' regardless of what the repo actually contains.

test('checkGitHubRepo resolves to { result: "empty" } for a real, reachable repository', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const result = await checkGitHubRepo({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl, pat: GITHUB_VALID_PAT })
    assert.deepEqual(result, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

test('checkGitHubRepo throws GitHubAuthenticationError for a rejected PAT', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    await assert.rejects(
      () => checkGitHubRepo({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl, pat: 'not-the-right-pat' }),
      GitHubAuthenticationError
    )
  })
})

test('checkGitHubRepo throws GitHubRepoNotFoundError for a nonexistent repository', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      await assert.rejects(
        () => checkGitHubRepo({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl, pat: GITHUB_VALID_PAT }),
        GitHubRepoNotFoundError
      )
    }
  )
})

test('checkGitHubRepo throws GitHubRepoNotFoundError for a bad owner, distinguishing it from a bad repository name', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    await assert.rejects(
      () => checkGitHubRepo({ owner: 'a-typo-owner', repository: GITHUB_REPOSITORY, baseUrl, pat: GITHUB_VALID_PAT }),
      GitHubRepoNotFoundError
    )
  })
})
