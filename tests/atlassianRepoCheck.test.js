import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAtlassianRepo } from '../lib/repoCheck.js'
import { BitbucketAuthenticationError, BitbucketRepoNotFoundError } from '../lib/bitbucketClient.js'
import { JiraAuthenticationError, JiraProjectNotFoundError } from '../lib/jiraWorkItemsClient.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'
import { withFakeJiraServer, JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'

// checkAtlassianRepo (#48, ADR-0042): the split-suite twin of tests/gitlabRepoCheck.test.js's own
// checkGitLabRepo coverage — the "what's in this specific remote Atlassian location, given the
// caller's own two tokens" check `POST /api/workspaces` runs before registering a new workspace.
// Unlike every other provider's checker, this one proves access to *two* independent fake servers at
// once (Bitbucket Cloud content store, Jira Cloud work items), each started and torn down for the
// duration of one test.

function withScratchAtlassian(fn, { bitbucket = {}, jira = {} } = {}) {
  return withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, ...bitbucket },
    (baseUrl) =>
      withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT, ...jira }, (jiraBaseUrl) =>
        fn({ baseUrl, jiraBaseUrl })
      )
  )
}

function locationFor({ baseUrl, jiraBaseUrl }, overrides = {}) {
  return {
    owner: BITBUCKET_OWNER,
    repository: BITBUCKET_REPOSITORY,
    jiraSite: JIRA_SITE,
    jiraProjectKey: JIRA_PROJECT_KEY,
    pat: BITBUCKET_VALID_PAT,
    jiraPat: JIRA_VALID_PAT,
    baseUrl,
    jiraBaseUrl,
    ...overrides,
  }
}

test('checkAtlassianRepo resolves to { result: "empty" } for a real, reachable repository and project with no instance data', async () => {
  await withScratchAtlassian(async (servers) => {
    const result = await checkAtlassianRepo(locationFor(servers))
    assert.deepEqual(result, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

test('checkAtlassianRepo discovers an existing instance directly under gantry-workspace/<slug>/', async () => {
  const files = {
    '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\nassignee: c.barlow\n',
  }
  await withScratchAtlassian(
    async (servers) => {
      const result = await checkAtlassianRepo(locationFor(servers))
      assert.deepEqual(result, {
        result: 'found',
        slug: 'my-initiative',
        definition: 'design',
        stage: 'shape',
        status: 'incomplete',
        assignee: 'c.barlow',
      })
    },
    { bitbucket: { files } }
  )
})

test('checkAtlassianRepo reports "multiple" when more than one instance already exists under gantry-workspace/, without guessing which one', async () => {
  const files = {
    '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
    '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
  }
  await withScratchAtlassian(
    async (servers) => {
      const result = await checkAtlassianRepo(locationFor(servers))
      assert.equal(result.result, 'multiple')
      assert.deepEqual(result.slugs, ['alpha-initiative', 'beta-initiative'])
    },
    { bitbucket: { files } }
  )
})

test('checkAtlassianRepo throws JiraAuthenticationError for a rejected Jira token, checked before the Bitbucket side is even reached', async () => {
  await withScratchAtlassian(async (servers) => {
    await assert.rejects(
      () => checkAtlassianRepo(locationFor(servers, { jiraPat: 'not-the-right-jira-token' })),
      JiraAuthenticationError
    )
  })
})

test('checkAtlassianRepo throws JiraProjectNotFoundError for a nonexistent Jira project', async () => {
  await withScratchAtlassian(
    async (servers) => {
      await assert.rejects(() => checkAtlassianRepo(locationFor(servers)), JiraProjectNotFoundError)
    },
    { jira: { projectExists: false } }
  )
})

test('checkAtlassianRepo throws BitbucketAuthenticationError for a rejected Bitbucket token', async () => {
  await withScratchAtlassian(async (servers) => {
    await assert.rejects(
      () => checkAtlassianRepo(locationFor(servers, { pat: 'not-the-right-bitbucket-token' })),
      BitbucketAuthenticationError
    )
  })
})

test('checkAtlassianRepo throws BitbucketRepoNotFoundError for a nonexistent Bitbucket repository', async () => {
  await withScratchAtlassian(
    async (servers) => {
      await assert.rejects(() => checkAtlassianRepo(locationFor(servers)), BitbucketRepoNotFoundError)
    },
    { bitbucket: { repoExists: false } }
  )
})

test('checkAtlassianRepo is safe to call again on the same location, reporting the same result both times', async () => {
  const files = { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }
  await withScratchAtlassian(
    async (servers) => {
      const first = await checkAtlassianRepo(locationFor(servers))
      const second = await checkAtlassianRepo(locationFor(servers))
      assert.deepEqual(first, second)
    },
    { bitbucket: { files } }
  )
})
