import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBitbucketPullRequestsClient, interpretBitbucketPullRequest } from '../lib/bitbucketPullRequestsClient.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// Bitbucket's pull-requests capability (#49, docs/adr/0039/0042) — exercised over real `fetch`
// against a real in-process fake Bitbucket server, never a mock of `fetch` itself, mirroring
// tests/bitbucketIdentityClient.test.js's own conventions. Promote's own scope only
// (create/read/request-reviewer, plus the tri-state review interpretation) — merge is #46's job.

function withServer(options, fn) {
  return withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'README.md': '# repo' }, ...options }, fn)
}

function client(baseUrl, overrides = {}) {
  return createBitbucketPullRequestsClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl, ...overrides })
}

test('createPullRequest requires sourceBranch, targetBranch and title', async () => {
  const pr = createBitbucketPullRequestsClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl: 'http://localhost:1' })
  await assert.rejects(() => pr.createPullRequest({ targetBranch: 'main', title: 't' }), /"sourceBranch" is required/)
  await assert.rejects(() => pr.createPullRequest({ sourceBranch: 's', title: 't' }), /"targetBranch" is required/)
  await assert.rejects(() => pr.createPullRequest({ sourceBranch: 's', targetBranch: 'main' }), /"title" is required/)
})

test('createPullRequest opens a pull request and returns its id and active status', async () => {
  await withServer({}, async (baseUrl) => {
    const result = await client(baseUrl).createPullRequest({ sourceBranch: 'definition/widget-v1', targetBranch: 'main', title: 'Promote widget', description: 'body' })
    assert.equal(typeof result.pullRequestId, 'number')
    assert.equal(result.status, 'active')
  })
})

test('getPullRequest reads back status and an empty participants list for a freshly-opened pull request', async () => {
  await withServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const { pullRequestId } = await c.createPullRequest({ sourceBranch: 'definition/widget-v1', targetBranch: 'main', title: 'Promote widget' })
    const pr = await c.getPullRequest(pullRequestId)
    assert.equal(pr.pullRequestId, pullRequestId)
    assert.equal(pr.status, 'active')
    assert.deepEqual(pr.participants, [])
  })
})

test('getPullRequest on an unknown id throws a NotFoundError-shaped error tagged "atlassian"', async () => {
  await withServer({}, async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).getPullRequest(999), (err) => {
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('addReviewers attaches a reviewer by uuid, resolvable afterwards via getPullRequest', async () => {
  await withServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const { pullRequestId } = await c.createPullRequest({ sourceBranch: 'definition/widget-v1', targetBranch: 'main', title: 'Promote widget' })
    await c.addReviewers(pullRequestId, [{ id: '{reviewer-uuid}', login: 'octocat', required: true }])
    const pr = await c.getPullRequest(pullRequestId)
    assert.equal(pr.participants.length, 1)
    assert.equal(pr.participants[0].user.uuid, '{reviewer-uuid}')
    assert.equal(pr.participants[0].state, null)
  })
})

test('addReviewers with no resolvable ids is a no-op that makes no request', async () => {
  await withServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const { pullRequestId } = await c.createPullRequest({ sourceBranch: 'definition/widget-v1', targetBranch: 'main', title: 'Promote widget' })
    const result = await c.addReviewers(pullRequestId, [{ login: 'no-id-here' }])
    assert.equal(result, null)
    const pr = await c.getPullRequest(pullRequestId)
    assert.deepEqual(pr.participants, [])
  })
})

test('an invalid token is reported as an authentication failure, not a generic error', async () => {
  await withServer({}, async (baseUrl) => {
    const c = client(baseUrl, { pat: 'wrong-token' })
    await assert.rejects(() => c.createPullRequest({ sourceBranch: 's', targetBranch: 'main', title: 't' }), AuthenticationError)
  })
})

// ---------- interpretBitbucketPullRequest (ADR-0042's tri-state mapping) ----------
//
// Every real (and fake-server) participant that ever carries a state also carries `role: 'REVIEWER'`
// (tests/helpers/fakeBitbucketServer.js sets both together) — these pass `role` explicitly so the
// assertions exercise the same reviewer-only filter `interpretBitbucketPullRequest` actually applies
// (only `REVIEWER`s carry a real, review-shaped vote; a `PARTICIPANT`'s state, if it ever had one,
// never counts), rather than accidentally passing regardless of the filter's presence.

test('interpretBitbucketPullRequest reads "pending" for a pull request with no participant action yet', () => {
  assert.equal(interpretBitbucketPullRequest({ participants: [] }), 'pending')
  assert.equal(interpretBitbucketPullRequest({ participants: [{ role: 'REVIEWER', state: null }] }), 'pending')
  assert.equal(interpretBitbucketPullRequest({}), 'pending')
})

test('interpretBitbucketPullRequest reads "approved" once a reviewer\'s state is approved', () => {
  assert.equal(interpretBitbucketPullRequest({ participants: [{ role: 'REVIEWER', state: 'approved' }] }), 'approved')
})

test('interpretBitbucketPullRequest reads "changes-requested" once a reviewer requests changes, even alongside another approval', () => {
  assert.equal(
    interpretBitbucketPullRequest({ participants: [{ role: 'REVIEWER', state: 'approved' }, { role: 'REVIEWER', state: 'changes_requested' }] }),
    'changes-requested'
  )
})

test('interpretBitbucketPullRequest also accepts a bare participants array (lib/stageStatus.js\'s own call shape), and ignores a non-reviewer PARTICIPANT\'s state', () => {
  assert.equal(interpretBitbucketPullRequest([{ role: 'REVIEWER', state: 'approved' }]), 'approved')
  assert.equal(interpretBitbucketPullRequest([{ role: 'PARTICIPANT', state: 'changes_requested' }]), 'pending')
})
