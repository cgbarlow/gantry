import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkGitLabRepo } from '../lib/repoCheck.js'
import { GitLabAuthenticationError, GitLabRepoNotFoundError } from '../lib/gitlabClient.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'

// checkGitLabRepo (#35, ADR-0041): the "what's in this specific remote GitLab location, given the
// caller's own PAT" check both POST /api/workspaces (proving access before registering a new
// workspace) and GET /api/gitlab/repo-check / POST /api/instances/adopt (#35, adopting an existing
// GitLab project) run against a real GitLab location. Mirrors tests/githubRepoCheck.test.js's own
// found/multiple/empty discovery, over GitLab's own `{namespace, repository}` location instead of
// GitHub's `{owner, repository}` — no legacy-migration story either, same as GitHub.

function locationFor(baseUrl) {
  return { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl }
}

test('checkGitLabRepo resolves to { result: "empty" } for a real, reachable project with no instance data', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (baseUrl) => {
    const result = await checkGitLabRepo({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl, pat: GITLAB_VALID_PAT })
    assert.deepEqual(result, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

test('checkGitLabRepo discovers an existing instance directly under gantry-workspace/<slug>/', async () => {
  const files = {
    '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\nassignee: c.barlow\n',
  }
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, async (baseUrl) => {
    const result = await checkGitLabRepo(locationFor(baseUrl))
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

test('checkGitLabRepo reports "multiple" when more than one instance already exists under gantry-workspace/, without guessing which one', async () => {
  const files = {
    '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
    '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
  }
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, async (baseUrl) => {
    const result = await checkGitLabRepo(locationFor(baseUrl))
    assert.equal(result.result, 'multiple')
    assert.deepEqual(result.slugs, ['alpha-initiative', 'beta-initiative'])
  })
})

test('checkGitLabRepo is safe to call again on the same project, reporting the same result both times', async () => {
  const files = { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, async (baseUrl) => {
    const first = await checkGitLabRepo(locationFor(baseUrl))
    const second = await checkGitLabRepo(locationFor(baseUrl))
    assert.deepEqual(first, second)
  })
})

test('checkGitLabRepo throws GitLabAuthenticationError for a rejected PAT', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (baseUrl) => {
    await assert.rejects(
      () => checkGitLabRepo({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl, pat: 'not-the-right-pat' }),
      GitLabAuthenticationError
    )
  })
})

test('checkGitLabRepo throws GitLabRepoNotFoundError for a nonexistent project', async () => {
  await withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      await assert.rejects(
        () => checkGitLabRepo({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl, pat: GITLAB_VALID_PAT }),
        GitLabRepoNotFoundError
      )
    }
  )
})

test('checkGitLabRepo throws GitLabRepoNotFoundError for a bad namespace, distinguishing it from a bad repository name', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (baseUrl) => {
    await assert.rejects(
      () => checkGitLabRepo({ namespace: 'a-typo-namespace', repository: GITLAB_REPOSITORY, baseUrl, pat: GITLAB_VALID_PAT }),
      GitLabRepoNotFoundError
    )
  })
})

// #21's GitHub equivalent — this is the message a wizard's repo-check/adopt route surfaces verbatim to
// the architect registering/checking a location, so it must explain the 404-vs-scope ambiguity itself
// rather than reading as a plain "no such project".
test('checkGitLabRepo\'s not-found error explains that an insufficient PAT scope looks identical to a missing project', async () => {
  await withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      try {
        await checkGitLabRepo({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl, pat: GITLAB_VALID_PAT })
        assert.fail('expected checkGitLabRepo to throw')
      } catch (err) {
        assert.ok(err instanceof GitLabRepoNotFoundError)
        assert.match(err.message, /scope/i)
      }
    }
  )
})
