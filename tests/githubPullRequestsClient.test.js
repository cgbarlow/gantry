import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubPullRequestsClient, interpretGitHubReviews } from '../lib/githubPullRequestsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { AuthenticationError, NotFoundError } from '../lib/providerErrors.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// lib/githubPullRequestsClient.js (#20): the subset of GitHub's Pulls API lib/definitionPromote.js
// needs — open, read back (status + reviews), request a reviewer. No merge call: Promote never
// merges a library repo's own Pull Request (ADR-0036). Exercised over real `fetch` against
// tests/helpers/fakeGitHubServer.js, per #1's own Testing Decisions.

async function openPullRequest(client, pat, baseUrl) {
  const content = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat, baseUrl })
  await content.writeFile('a.md', 'v1\n')
  await content.createBranch('feature')
  await content.writeFile('a.md', 'v2\n', { branch: 'feature' })
  return client.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Test PR' })
}

test('createGitHubPullRequestsClient requires owner, repository and pat', () => {
  assert.throws(() => createGitHubPullRequestsClient({ repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT }), /"owner" is required/)
  assert.throws(() => createGitHubPullRequestsClient({ owner: GITHUB_OWNER, pat: GITHUB_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY }), /"pat" is required/)
})

test('createPullRequest opens a PR and reports it as active', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const pr = await openPullRequest(client, GITHUB_VALID_PAT, baseUrl)
    assert.equal(typeof pr.pullRequestId, 'number')
    assert.equal(pr.status, 'active')
  })
})

test('createPullRequest requires sourceBranch, targetBranch and title', async () => {
  const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT })
  await assert.rejects(() => client.createPullRequest({ targetBranch: 'main', title: 't' }), /"sourceBranch" is required/)
  await assert.rejects(() => client.createPullRequest({ sourceBranch: 'feature', title: 't' }), /"targetBranch" is required/)
  await assert.rejects(() => client.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main' }), /"title" is required/)
})

test('getPullRequest reads back the same PR, with an empty review list before anyone has reviewed', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const created = await openPullRequest(client, GITHUB_VALID_PAT, baseUrl)
    const fetched = await client.getPullRequest(created.pullRequestId)
    assert.equal(fetched.pullRequestId, created.pullRequestId)
    assert.equal(fetched.status, 'active')
    assert.deepEqual(fetched.reviews, [])
  })
})

test('getPullRequest surfaces a submitted review', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const created = await openPullRequest(client, GITHUB_VALID_PAT, baseUrl)

    await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${created.pullRequestId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE' }),
    })

    const fetched = await client.getPullRequest(created.pullRequestId)
    assert.equal(fetched.reviews.length, 1)
    assert.equal(fetched.reviews[0].state, 'APPROVED')
    assert.equal(interpretGitHubReviews(fetched.reviews), 'approved')
  })
})

test('addReviewers requests review from the given logins, ignoring entries with no login', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const created = await openPullRequest(client, GITHUB_VALID_PAT, baseUrl)

    await client.addReviewers(created.pullRequestId, [{ id: 'ado-only-id', login: 'ana', required: true }, { id: 'no-login-id', required: true }])

    const res = await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${created.pullRequestId}`, {
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
    })
    const pr = await res.json()
    assert.deepEqual(pr.requested_reviewers, [{ login: 'ana' }])
  })
})

test('addReviewers with no reviewers is a no-op', async () => {
  const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT })
  assert.deepEqual(await client.addReviewers(1, []), [])
})

test('a rejected PAT surfaces as the neutral AuthenticationError, tagged github', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => client.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 't' }), (err) => {
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'github')
      return true
    })
  })
})

test('getPullRequest on an unknown pull request throws the neutral NotFoundError', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    await assert.rejects(() => client.getPullRequest(999), (err) => {
      assert.ok(err instanceof NotFoundError)
      return true
    })
  })
})

// ---------- interpretGitHubReviews (ADR-0040's mapping) ----------

test('interpretGitHubReviews: no reviews at all is pending', () => {
  assert.equal(interpretGitHubReviews([]), 'pending')
  assert.equal(interpretGitHubReviews(undefined), 'pending')
})

test('interpretGitHubReviews: a lone APPROVED review is approved', () => {
  assert.equal(interpretGitHubReviews([{ user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' }]), 'approved')
})

test('interpretGitHubReviews: a lone CHANGES_REQUESTED review is changes-requested', () => {
  assert.equal(interpretGitHubReviews([{ user: { login: 'ana' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:00:00Z' }]), 'changes-requested')
})

test('interpretGitHubReviews: CHANGES_REQUESTED from any reviewer outranks another reviewer\'s APPROVED', () => {
  const reviews = [
    { user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' },
    { user: { login: 'sam' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:00:00Z' },
  ]
  assert.equal(interpretGitHubReviews(reviews), 'changes-requested')
})

test('interpretGitHubReviews: COMMENTED and DISMISSED reviews read as pending, never overriding a real verdict', () => {
  assert.equal(interpretGitHubReviews([{ user: { login: 'ana' }, state: 'COMMENTED', submitted_at: '2026-01-01T00:00:00Z' }]), 'pending')
  assert.equal(interpretGitHubReviews([{ user: { login: 'ana' }, state: 'DISMISSED', submitted_at: '2026-01-01T00:00:00Z' }]), 'pending')
})

test('interpretGitHubReviews: only a reviewer\'s latest actionable review counts', () => {
  const reviews = [
    { user: { login: 'ana' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:00:00Z' },
    { user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2026-01-02T00:00:00Z' },
  ]
  assert.equal(interpretGitHubReviews(reviews), 'approved')
})

test('interpretGitHubReviews: a later COMMENTED review does not erase an earlier APPROVED', () => {
  const reviews = [
    { user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' },
    { user: { login: 'ana' }, state: 'COMMENTED', submitted_at: '2026-01-02T00:00:00Z' },
  ]
  assert.equal(interpretGitHubReviews(reviews), 'approved')
})
