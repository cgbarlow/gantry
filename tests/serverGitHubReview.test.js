import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubWorkItemsClient } from '../lib/githubWorkItemsClient.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { GITHUB_REVIEW_LABEL_PREFIX } from '../lib/reviewStatus.js'
import {
  withRunningServerForProvider,
  withRunningServer,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #15 — GitHub Request Review and review labels. The GitHub twin of tests/serverStageReview.test.js
// (the Azure DevOps "Request Review"/"Check status" coverage), parameterizing the same two routes —
// POST /api/instance/request-review, POST /api/instance/review-status — against a real fake GitHub
// server (tests/helpers/fakeGitHubServer.js), per #1's Testing Decisions ("parameterize the existing
// server route suites over both providers"). Where behaviour genuinely diverges (one issue per
// reviewer carrying a `gantry:review/*` status label instead of a custom Azure DevOps field, a
// "Related to #<n>" body reference instead of a native work-item relation, an access-gated reviewer),
// that's its own explicit test rather than a silently absent one.

const SLUG = 'my-initiative'

function withScratchGitHubServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider(
    'github',
    { options: { instancesDir }, fakeServerOptions },
    (ctx) => fn({ ...ctx, instancesDir })
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

// Creates a genuinely GitHub-backed instance (`instance.yaml` lives in the fake repo, registered as
// `kind: 'github'`) via the real HTTP creation route — Request Review, like Sign-off, is scoped to a
// Workspace-backed instance's own *storage* location (CONTEXT.md's "Request Review" entry), not
// merely to one whose linked work item happens to be on GitHub (`tests/serverGitHubWorkItems.test.js`
// exercises that separate, local-instance-plus-GitHub-work-item combination instead).
async function createGitHubBackedInstance(gantryBase, providerBaseUrl, instancesDir) {
  writeWorkspaceJson(instancesDir, 'default', { name: 'default', kind: 'local', createdAt: new Date().toISOString() })
  const res = await fetch(`${gantryBase}/api/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    body: JSON.stringify({
      definition: 'design',
      slug: SLUG,
      github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl },
    }),
  })
  assert.equal(res.status, 201)
}

async function createParentIssue(providerBaseUrl) {
  const client = createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
  return client.createIssue({ title: 'Parent initiative', body: '' })
}

function linkBody(parentNumber, providerBaseUrl) {
  return JSON.stringify({ provider: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, parentNumber, baseUrl: providerBaseUrl })
}

async function linkInstance(gantryBase, providerBaseUrl, parentNumber) {
  const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=${SLUG}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    body: linkBody(parentNumber, providerBaseUrl),
  })
  assert.equal(res.status, 200)
  return res.json()
}

async function setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir) {
  await createGitHubBackedInstance(gantryBase, providerBaseUrl, instancesDir)
  const parent = await createParentIssue(providerBaseUrl)
  return linkInstance(gantryBase, providerBaseUrl, parent.number)
}

test('Request Review (github) creates one assigned, requested-labelled issue per reviewer, related-linked to the stage issue', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      const link = await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
      })
      assert.equal(res.status, 200)
      const requested = await res.json()
      assert.equal(requested.review.status, 'Requested')
      assert.equal(requested.review.reviewer, 'reviewer1')
      assert.match(requested.webUrl, new RegExp(`/issues/${requested.review.workItemId}$`))

      const client = createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
      const issue = await client.getIssue(requested.review.workItemId)
      assert.deepEqual(issue.assignees.map((a) => a.login), ['reviewer1'])
      assert.deepEqual(issue.labels.map((l) => l.name), [`${GITHUB_REVIEW_LABEL_PREFIX}requested`])
      assert.match(issue.body, new RegExp(`Related to #${link.stages.shape}`))

      // The full five-value lifecycle exists on the repo now, not only the one status this request used.
      const labels = await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/labels`, {
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
      }).then((r) => r.json())
      assert.deepEqual(
        labels.map((l) => l.name).sort(),
        ['approved', 'changes-requested', 'in-review', 'rejected', 'requested'].map((slug) => `${GITHUB_REVIEW_LABEL_PREFIX}${slug}`).sort()
      )

      const instance = await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } }).then((r) => r.json())
      assert.equal(instance.reviews.length, 1)
      assert.equal(instance.reviews[0].status, 'Requested')
      assert.equal(instance.reviewRequests.shape[0].workItemId, requested.review.workItemId)
    },
    { fakeServerOptions: { collaborators: [{ login: 'reviewer1', id: 501 }] } }
  )
})

test('Request Review (github) with no PAT returns the structured "authentication required" response naming github', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

    const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('Request Review and Review status (github) reject local instances without requiring a PAT', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-local-'))
  try {
    const { createInstance } = await import('../lib/instance.js')
    createInstance('design', 'local-review', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const requestReview = await fetch(`${base}/api/instance/request-review?slug=local-review`, { method: 'POST' })
      assert.equal(requestReview.status, 400)
      assert.match((await requestReview.json()).error, /not Workspace-backed/)

      const reviewStatus = await fetch(`${base}/api/instance/review-status?slug=local-review`, { method: 'POST' })
      assert.equal(reviewStatus.status, 400)
      assert.match((await reviewStatus.json()).error, /not Workspace-backed/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Request Review (github) requires a reviewer, and rejects a stage with no linked work item', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    await createGitHubBackedInstance(gantryBase, providerBaseUrl, instancesDir)

    const missingReviewer = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewer: '   ' }),
    })
    assert.equal(missingReviewer.status, 400)
    assert.match((await missingReviewer.json()).error, /A reviewer is required/)

    const noLinkedWorkItem = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
    })
    assert.equal(noLinkedWorkItem.status, 400)
    assert.match((await noLinkedWorkItem.json()).error, /has no linked work item for stage "shape"/)
  })
})

test('Request Review (github) rejects a reviewer that does not resolve to any known identity, without creating an issue', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

    const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewer: 'nobody-matches-this-query' }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /could not be resolved to a known GitHub identity/)

    const instance = await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } }).then((r) => r.json())
    assert.equal(instance.reviews.length, 0)
  })
})

test('Request Review (github) rejects a reviewer who resolves but lacks repo access, without creating an issue (docs/adr/0040)', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'no-access-member' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /does not have access to/)
      assert.match(body.error, /grant repository access directly or through a team/)

      const instance = await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } }).then((r) => r.json())
      assert.equal(instance.reviews.length, 0)
    },
    {
      fakeServerOptions: {
        ownerType: 'Organization',
        orgMembers: [{ login: 'no-access-member', id: 900 }],
        permissions: { 'no-access-member': 'none' },
      },
    }
  )
})

test('Request Review (github) rejects a stage other than the instance\'s current stage', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ stage: 'hld-define', reviewer: 'reviewer1' }),
      })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /Review requests are only available for the instance's current stage \("shape"\)/)
    },
    { fakeServerOptions: { collaborators: [{ login: 'reviewer1', id: 501 }] } }
  )
})

test('Review status (github) is read only on explicit Check status, from the issue\'s current gantry:review/* label — never polling', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

      const requested = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
      }).then((r) => r.json())

      // A reviewer's real decision in GitHub's own UI — modelled here as a direct label change against
      // the fake server, bypassing gantry entirely, exactly like the Azure DevOps suite's own
      // `client.updateWorkItem` simulates a reviewer's decision.
      await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/issues/${requested.review.workItemId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [`${GITHUB_REVIEW_LABEL_PREFIX}changes-requested`] }),
      })

      // Not reflected until the explicit Check action re-reads it.
      const beforeCheck = await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } }).then((r) => r.json())
      assert.equal(beforeCheck.reviews[0].status, 'Requested')

      const statusRes = await fetch(`${gantryBase}/api/instance/review-status?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewId: requested.review.workItemId }),
      })
      assert.equal(statusRes.status, 200)
      assert.equal((await statusRes.json()).review.status, 'Changes requested')

      const afterCheck = await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } }).then((r) => r.json())
      assert.equal(afterCheck.reviews[0].status, 'Changes requested')
    },
    { fakeServerOptions: { collaborators: [{ login: 'reviewer1', id: 501 }] } }
  )
})

test('Review status (github) rejects an invalid review id and a review id with no matching request', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

    const notANumber = await fetch(`${gantryBase}/api/instance/review-status?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewId: 'not-a-number' }),
    })
    assert.equal(notANumber.status, 400)
    assert.match((await notANumber.json()).error, /A valid review work item id is required/)

    const noSuchReview = await fetch(`${gantryBase}/api/instance/review-status?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewId: 999999 }),
    })
    assert.equal(noSuchReview.status, 400)
    assert.match((await noSuchReview.json()).error, /has no review request for work item #999999 on stage "shape"/)
  })
})

test('Request Review (github) is available before the gate has passed — the Shape stage starts empty', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      await setUpLinkedInstance(gantryBase, providerBaseUrl, instancesDir)

      const checkRes = await fetch(`${gantryBase}/api/instance/check?slug=${SLUG}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal((await checkRes.json()).pass, false)

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
      })
      assert.equal(res.status, 200)
    },
    { fakeServerOptions: { collaborators: [{ login: 'reviewer1', id: 501 }] } }
  )
})

test('requestStageReview and checkStageReviewStatus require options.azureDevOps or options.github', async () => {
  const { requestStageReview, checkStageReviewStatus } = await import('../lib/stageReview.js')
  await assert.rejects(
    () => requestStageReview('some-slug', { reviewer: 'a@example.com' }, {}),
    /Stage review actions are for Workspace-backed instances only — pass options.azureDevOps or options.github/
  )
  await assert.rejects(
    () => checkStageReviewStatus('some-slug', { reviewId: '1' }, {}),
    /Stage review actions are for Workspace-backed instances only — pass options.azureDevOps or options.github/
  )
})
