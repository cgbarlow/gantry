import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAzureDevOpsPullRequestsClient,
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
  DEFAULT_BASE_URL,
} from '../lib/azureDevOpsPullRequestsClient.js'
import { basicAuthHeader } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

// Mirrors the equivalent wrapper in tests/azureDevOpsClient.test.js and
// tests/azureDevOpsWorkItemsClient.test.js: pins this file's fixed
// organization/project/repository/PAT constants so call sites below only
// need to supply whatever varies.
function withFakeAzureDevOpsServer(fn) {
  return withFakeServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, fn)
}

function client(baseUrl, overrides = {}) {
  return createAzureDevOpsPullRequestsClient({
    organization: ORGANIZATION,
    project: PROJECT,
    repository: REPOSITORY,
    pat: VALID_PAT,
    baseUrl,
    ...overrides,
  })
}

const pullRequestUrl = (baseUrl, pullRequestId = '') =>
  `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}`

// Simulates the Owner casting a vote directly in Azure DevOps (never
// something lib/azureDevOpsPullRequestsClient.js itself does, per
// ADR-0014) — a raw fetch PUT against the fake server's reviewers
// endpoint, the same shape a real "Check status" caller (#125) would rely
// on having actually happened before it reads the pull request back.
async function castVote(baseUrl, pullRequestId, reviewerId, vote) {
  const res = await fetch(`${pullRequestUrl(baseUrl, pullRequestId)}/reviewers/${reviewerId}?api-version=7.1`, {
    method: 'PUT',
    headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote }),
  })
  assert.equal(res.status, 200)
}

test('createPullRequest opens a pull request from a source branch into a target branch', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const pr = await client(baseUrl).createPullRequest({
      sourceBranch: 'hld-stage',
      targetBranch: 'main',
      title: 'Request approval: HLD stage',
      description: 'Renders the HLD artefact for review.',
    })
    assert.equal(typeof pr.pullRequestId, 'number')
    assert.equal(pr.status, 'active')
    assert.equal(pr.title, 'Request approval: HLD stage')
    assert.equal(pr.description, 'Renders the HLD artefact for review.')
    assert.equal(pr.sourceRefName, 'refs/heads/hld-stage')
    assert.equal(pr.targetRefName, 'refs/heads/main')
  })
})

test('createPullRequest accepts full refs/heads/ names without double-prefixing them', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const pr = await client(baseUrl).createPullRequest({
      sourceBranch: 'refs/heads/hld-stage',
      targetBranch: 'refs/heads/main',
      title: 'Already-full ref names',
    })
    assert.equal(pr.sourceRefName, 'refs/heads/hld-stage')
    assert.equal(pr.targetRefName, 'refs/heads/main')
  })
})

test('createPullRequest creates pull requests with distinct, incrementing ids', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const first = await c.createPullRequest({ sourceBranch: 'a', targetBranch: 'main', title: 'First' })
    const second = await c.createPullRequest({ sourceBranch: 'b', targetBranch: 'main', title: 'Second' })
    assert.notEqual(first.pullRequestId, second.pullRequestId)
  })
})

test('createPullRequest requires sourceBranch, targetBranch and title', async () => {
  const c = client(DEFAULT_BASE_URL)
  await assert.rejects(() => c.createPullRequest({ targetBranch: 'main', title: 'X' }), /sourceBranch/)
  await assert.rejects(() => c.createPullRequest({ sourceBranch: 'a', title: 'X' }), /targetBranch/)
  await assert.rejects(() => c.createPullRequest({ sourceBranch: 'a', targetBranch: 'main' }), /title/)
})

test('getPullRequest fetches a pull request\'s current state by id', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'HLD' })
    const fetched = await c.getPullRequest(created.pullRequestId)
    assert.equal(fetched.pullRequestId, created.pullRequestId)
    assert.equal(fetched.status, 'active')
    assert.equal(fetched.title, 'HLD')
  })
})

test('getPullRequest throws AzureDevOpsNotFoundError for a pull request id that does not exist', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).getPullRequest(999999), AzureDevOpsNotFoundError)
  })
})

test('getPullRequest reads back an approved reviewer vote', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'HLD' })
    await castVote(baseUrl, created.pullRequestId, 'owner-1', 10)

    const fetched = await c.getPullRequest(created.pullRequestId)
    assert.equal(fetched.reviewers.length, 1)
    assert.equal(fetched.reviewers[0].id, 'owner-1')
    assert.equal(fetched.reviewers[0].vote, 10)
  })
})

test('getPullRequest reads back a rejected reviewer vote, distinguishable from a merely-pending one', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'HLD' })

    const pending = await c.getPullRequest(created.pullRequestId)
    assert.equal(pending.reviewers.length, 0)

    await castVote(baseUrl, created.pullRequestId, 'owner-1', -10)
    const rejected = await c.getPullRequest(created.pullRequestId)
    assert.equal(rejected.reviewers[0].vote, -10)
  })
})

test('getPullRequestCommits returns the source branch history, and reviewer vote reset plus comments use their PR endpoints', async () => {
  await withFakeServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: { '/initial.md': 'initial\n' } },
    async (baseUrl) => {
    const c = client(baseUrl)
    await c.createPullRequest({ sourceBranch: 'main', targetBranch: 'main', title: 'History' })
    const commits = await c.getPullRequestCommits(1)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].comment, 'Initial repository content')

    await castVote(baseUrl, 1, 'owner-1', 10)
    const reset = await c.updateReviewerVote(1, 'owner-1', 0)
    assert.equal(reset.vote, 0)
    assert.equal(reset.voteUpdatedDate !== undefined, true)

    const comment = await c.commentOnPullRequest(1, 'Please review the new commit.')
    assert.equal(comment.comments[0].content, 'Please review the new commit.')
    },
  )
})

test('completePullRequest merges an approved pull request, threading through the current lastMergeSourceCommit', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'HLD' })
    await castVote(baseUrl, created.pullRequestId, 'owner-1', 10)

    const completed = await c.completePullRequest(created.pullRequestId, {
      mergeStrategy: 'squash',
      deleteSourceBranch: true,
    })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.completionOptions.mergeStrategy, 'squash')
    assert.equal(completed.completionOptions.deleteSourceBranch, true)
    assert.ok(completed.closedDate)
    // Proves completePullRequest actually echoes back the pull request's
    // *current* lastMergeSourceCommit (Azure DevOps's own optimistic-
    // concurrency check for completion, mirroring writeFile's oldObjectId
    // for pushes) rather than omitting it or sending some other value —
    // the fake server now rejects a mismatched one with 409 (see the
    // dedicated test below), so completion only succeeds at all because
    // the client threaded through the right commit id.
    assert.equal(completed.lastMergeSourceCommit.commitId, created.lastMergeSourceCommit.commitId)

    const refetched = await c.getPullRequest(created.pullRequestId)
    assert.equal(refetched.status, 'completed')
  })
})

test('completePullRequest throws AzureDevOpsNotFoundError for a pull request id that does not exist', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).completePullRequest(999999, { mergeStrategy: 'squash' }), AzureDevOpsNotFoundError)
  })
})

test('the fake server rejects completing a pull request with a stale lastMergeSourceCommit, proving the concurrency check completePullRequest relies on is real', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'HLD' })

    // A raw fetch, not through the client — lib/azureDevOpsPullRequestsClient.js's
    // completePullRequest always fetches the current lastMergeSourceCommit
    // itself, so it can never be tricked into sending a stale one through
    // its own public API; this exercises the fake server's enforcement of
    // that contract directly, the same way a real Azure DevOps org would
    // reject a completion whose source branch moved since it was last read.
    const res = await fetch(`${pullRequestUrl(baseUrl, created.pullRequestId)}?api-version=7.1`, {
      method: 'PATCH',
      headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        lastMergeSourceCommit: { commitId: 'stale-commit-id-that-does-not-match' },
        completionOptions: {},
      }),
    })
    assert.equal(res.status, 409)

    // A rejected completion must leave the pull request untouched.
    const stillActive = await c.getPullRequest(created.pullRequestId)
    assert.equal(stillActive.status, 'active')
  })
})

test('a rejected PAT surfaces as AzureDevOpsAuthenticationError on createPullRequest', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(
      () => badClient.createPullRequest({ sourceBranch: 'a', targetBranch: 'main', title: 'X' }),
      AzureDevOpsAuthenticationError
    )
  })
})

test('a rejected PAT surfaces as AzureDevOpsAuthenticationError on getPullRequest', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createPullRequest({ sourceBranch: 'a', targetBranch: 'main', title: 'X' })

    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.getPullRequest(created.pullRequestId), AzureDevOpsAuthenticationError)
  })
})

test('a network failure reaching the Azure DevOps API surfaces as AzureDevOpsRequestError, not the auth or not-found errors', async () => {
  // Nothing listens on this port — a real connection failure, not a mock
  // of fetch — exercising the client's network-error branch, distinct
  // from the HTTP-level auth/not-found branches covered above. Mirrors the
  // equivalent tests in tests/azureDevOpsClient.test.js /
  // tests/azureDevOpsWorkItemsClient.test.js.
  const unreachableBaseUrl = 'http://127.0.0.1:1'
  const c = client(unreachableBaseUrl)
  await assert.rejects(
    () => c.createPullRequest({ sourceBranch: 'a', targetBranch: 'main', title: 'X' }),
    AzureDevOpsRequestError
  )
})

test('base URL defaults to the real Azure DevOps API but is configurable/overridable for tests', async () => {
  assert.equal(DEFAULT_BASE_URL, 'https://dev.azure.com')
  assert.equal(client(undefined).baseUrl, 'https://dev.azure.com')

  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const c = client(baseUrl)
    assert.equal(c.baseUrl, baseUrl)
    const pr = await c.createPullRequest({ sourceBranch: 'a', targetBranch: 'main', title: 'Proves override took effect' })
    assert.equal(pr.title, 'Proves override took effect')
  })
})

test('createAzureDevOpsPullRequestsClient requires organization, project, repository and pat', () => {
  assert.throws(
    () => createAzureDevOpsPullRequestsClient({ project: PROJECT, repository: REPOSITORY, pat: VALID_PAT }),
    /organization/
  )
  assert.throws(
    () => createAzureDevOpsPullRequestsClient({ organization: ORGANIZATION, repository: REPOSITORY, pat: VALID_PAT }),
    /project/
  )
  assert.throws(
    () => createAzureDevOpsPullRequestsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT }),
    /repository/
  )
  assert.throws(
    () => createAzureDevOpsPullRequestsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY }),
    /pat/
  )
})
