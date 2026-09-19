import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkGitHubRepo } from '../lib/repoCheck.js'
import { GitHubAuthenticationError, GitHubRepoNotFoundError } from '../lib/githubClient.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// checkGitHubRepo (#8, extended #18): the "what's in this specific remote repo, given the caller's
// own PAT" check both POST /api/workspaces (proving access before registering a new workspace) and
// GET /api/github/repo-check / POST /api/instances/adopt (#18, adopting an existing repo) run against
// a real GitHub location. Mirrors checkAzureDevOpsRepo's own found/multiple/empty discovery
// (tests/repoCheck.test.js) minus the legacy-migration story — GitHub never had a pre-#100 repo-root
// layout, so there is nothing to migrate.

function locationFor(baseUrl) {
  return { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl }
}

test('checkGitHubRepo resolves to { result: "empty" } for a real, reachable repository with no instance data', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const result = await checkGitHubRepo({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl, pat: GITHUB_VALID_PAT })
    assert.deepEqual(result, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

test('checkGitHubRepo discovers an existing instance directly under gantry-workspace/<slug>/', async () => {
  const files = {
    '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\nassignee: c.barlow\n',
  }
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, async (baseUrl) => {
    const result = await checkGitHubRepo(locationFor(baseUrl))
    assert.deepEqual(result, {
      result: 'found',
      slug: 'my-initiative',
      definition: 'design',
      stage: 'shape',
      status: 'incomplete',
      assignee: 'c.barlow',
    })
  })
})

test('checkGitHubRepo reports "multiple" when more than one instance already exists under gantry-workspace/, without guessing which one', async () => {
  const files = {
    '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
    '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
  }
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, async (baseUrl) => {
    const result = await checkGitHubRepo(locationFor(baseUrl))
    assert.equal(result.result, 'multiple')
    assert.deepEqual(result.slugs, ['alpha-initiative', 'beta-initiative'])
  })
})

test('checkGitHubRepo is safe to call again on the same repo, reporting the same result both times', async () => {
  const files = { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, async (baseUrl) => {
    const first = await checkGitHubRepo(locationFor(baseUrl))
    const second = await checkGitHubRepo(locationFor(baseUrl))
    assert.deepEqual(first, second)
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
