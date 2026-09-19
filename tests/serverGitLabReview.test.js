import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { createGitLabWorkItemsClient } from '../lib/gitlabWorkItemsClient.js'
import { GITLAB_REVIEW_LABEL_PREFIX } from '../lib/reviewStatus.js'
import {
  withRunningServerForProvider,
  withScratchInstances,
  basicAuthHeader,
  GITLAB_NAMESPACE,
  GITLAB_REPOSITORY,
  GITLAB_VALID_PAT,
} from './helpers/lifecycle.js'

// #34 — GitLab Request Review and review labels. The GitLab twin of tests/serverGitHubReview.test.js
// (#15's own GitHub coverage), parameterizing the same two routes — POST /api/instance/request-review,
// POST /api/instance/review-status — against a real fake GitLab server
// (tests/helpers/fakeGitLabServer.js). Where behaviour genuinely diverges from GitHub (assignment by
// numeric `assignee_ids` rather than a login, GitLab's own Issues API already returning `labels` as
// plain name strings, GitLab's Reporter-or-above assignability gate rather than GitHub's
// has-access-or-not one), that's its own explicit assertion rather than a silently absent one.
//
// GitLab workspace *registration* (#25) and the write side of the GitLab content store haven't landed
// yet, so a genuinely GitLab-backed instance's own instance.yaml is seeded directly onto the fake
// server's `main` branch here — the same fixture-seeding approach
// tests/serverGitLabAssetsAndRender.test.js already uses for the same reason — rather than created via
// a (not yet existing) POST /api/instances `gitlab` branch. The child issue this seeded instance links
// to for the "shape" stage is a real GitLab issue, created directly against the fake server the same
// way tests/serverGitLabWorkItems.test.js's own `createParentIssue` does, so Request Review's own
// "Related to #<n>" cross-reference and hierarchy assertions are against real fake-server state, not
// merely echoed-back fixture text.

const SLUG = 'my-initiative'

function withScratchGitLabServer(fn, { fakeServerOptions } = {}) {
  return withScratchInstances((instancesDir) =>
    withRunningServerForProvider('gitlab', { options: { instancesDir }, fakeServerOptions }, (ctx) => fn({ ...ctx, instancesDir }))
  )
}

function registerGitLabInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(slug, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
  registerWorkspace({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, owner: '' }, { instancesDir })
}

function instanceYamlText(slug, { parentIid, shapeIid, providerBaseUrl }) {
  return (
    `definition: design\n` +
    `slug: ${slug}\n` +
    `stage: shape\n` +
    `workItem:\n` +
    `  provider: gitlab\n` +
    `  namespace: ${GITLAB_NAMESPACE}\n` +
    `  repository: ${GITLAB_REPOSITORY}\n` +
    `  parentIid: ${parentIid}\n` +
    `  baseUrl: ${providerBaseUrl}\n` +
    `  stages:\n` +
    `    shape: ${shapeIid}\n`
  )
}

// Creates a genuinely GitLab-backed, already-linked instance the same way setUpLinkedInstance does in
// tests/serverGitHubReview.test.js: registered against the fake GitLab server (Request Review, like
// Sign-off, is scoped to a Workspace-backed instance's own storage location — CONTEXT.md's "Request
// Review" entry — not merely to one whose linked work item happens to be on GitLab), with a real parent
// issue and a real "shape"-stage child issue already created on the fake server and referenced from the
// seeded instance.yaml's own `workItem` block.
async function setUpLinkedInstance(providerBaseUrl, instancesDir) {
  const client = createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl })
  const parent = await client.createIssue({ title: 'Parent initiative', body: '' })
  const { issue: shapeIssue } = await client.createChildIssue(parent.iid, 'Shape — my-initiative', 'Tracks the Shape stage.')

  registerGitLabInstance(SLUG, { instancesDir, providerBaseUrl })

  return { parentIid: parent.iid, shapeIid: shapeIssue.iid }
}

test('Request Review (gitlab) creates one assigned, requested-labelled issue per reviewer, related-linked to the stage issue', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      const { parentIid, shapeIid } = await setUpLinkedInstance(providerBaseUrl, instancesDir)
      await writeInstanceYaml(providerBaseUrl, instanceYamlText(SLUG, { parentIid, shapeIid, providerBaseUrl }))

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
      })
      assert.equal(res.status, 200)
      const requested = await res.json()
      assert.equal(requested.review.status, 'Requested')
      assert.equal(requested.review.reviewer, 'reviewer1')
      assert.match(requested.webUrl, new RegExp(`/issues/${requested.review.workItemId}$`))

      const client = createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl })
      const issue = await client.getIssue(requested.review.workItemId)
      assert.deepEqual(issue.assignee_ids, [501])
      assert.deepEqual(issue.labels, [`${GITLAB_REVIEW_LABEL_PREFIX}requested`])
      assert.match(issue.description, new RegExp(`Related to #${shapeIid}`))

      // The full five-value lifecycle exists on the project now, not only the one status this request used.
      const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)
      const labels = await fetch(`${providerBaseUrl}/projects/${projectId}/labels`, {
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
      }).then((r) => r.json())
      assert.deepEqual(
        labels.map((l) => l.name).sort(),
        ['approved', 'changes-requested', 'in-review', 'rejected', 'requested'].map((slug) => `${GITLAB_REVIEW_LABEL_PREFIX}${slug}`).sort()
      )

      const instance = await readInstance(SLUG, { gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT } })
      assert.equal(instance.reviewRequests.shape.length, 1)
      assert.equal(instance.reviewRequests.shape[0].status, 'Requested')
      assert.equal(instance.reviewRequests.shape[0].workItemId, requested.review.workItemId)
    },
    { fakeServerOptions: { members: [{ id: 501, username: 'reviewer1', name: 'Reviewer One', access_level: 30 }] } }
  )
})

test('Request Review (gitlab) with no PAT returns the structured "authentication required" response naming gitlab', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    const { parentIid, shapeIid } = await setUpLinkedInstance(providerBaseUrl, instancesDir)
    await writeInstanceYaml(providerBaseUrl, instanceYamlText(SLUG, { parentIid, shapeIid, providerBaseUrl }))

    const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitLab/)
  })
})

test('Request Review (gitlab) requires a reviewer, and rejects a stage with no linked work item', async () => {
  await withScratchGitLabServer(async ({ providerBaseUrl, instancesDir, gantryBase }) => {
    registerGitLabInstance(SLUG, { instancesDir, providerBaseUrl })
    await writeInstanceYaml(providerBaseUrl, `definition: design\nslug: ${SLUG}\nstage: shape\n`)

    const missingReviewer = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewer: '   ' }),
    })
    assert.equal(missingReviewer.status, 400)
    assert.match((await missingReviewer.json()).error, /A reviewer is required/)

    const noLinkedWorkItem = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
    })
    assert.equal(noLinkedWorkItem.status, 400)
    assert.match((await noLinkedWorkItem.json()).error, /has no linked work item for stage "shape"/)
  })
})

test('Request Review (gitlab) rejects a reviewer that does not resolve to any known identity, without creating an issue', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    const { parentIid, shapeIid } = await setUpLinkedInstance(providerBaseUrl, instancesDir)
    await writeInstanceYaml(providerBaseUrl, instanceYamlText(SLUG, { parentIid, shapeIid, providerBaseUrl }))

    const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewer: 'nobody-matches-this-query' }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /could not be resolved to a known GitLab identity/)

    const instance = await readInstance(SLUG, { gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT } })
    assert.equal(instance.reviewRequests, undefined)
  })
})

test('Request Review (gitlab) rejects a reviewer who resolves but lacks Reporter-or-above access, without creating an issue (docs/adr/0041)', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      const { parentIid, shapeIid } = await setUpLinkedInstance(providerBaseUrl, instancesDir)
      await writeInstanceYaml(providerBaseUrl, instanceYamlText(SLUG, { parentIid, shapeIid, providerBaseUrl }))

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'guest-member' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /does not have sufficient access/)
      assert.match(body.error, /at least Reporter access/)

      const instance = await readInstance(SLUG, { gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT } })
      assert.equal(instance.reviewRequests, undefined)
    },
    { fakeServerOptions: { members: [{ id: 900, username: 'guest-member', name: 'Guest Member', access_level: 10 }] } }
  )
})

test('Request Review (gitlab) rejects a stage other than the instance\'s current stage', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      const client = createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl })
      const parent = await client.createIssue({ title: 'Parent initiative', body: '' })
      const { issue: shapeIssue } = await client.createChildIssue(parent.iid, 'Shape — my-initiative', '')
      const { issue: hldIssue } = await client.createChildIssue(parent.iid, 'HLD — my-initiative', '')
      registerGitLabInstance(SLUG, { instancesDir, providerBaseUrl })
      await writeInstanceYaml(
        providerBaseUrl,
        `definition: design\nslug: ${SLUG}\nstage: shape\nworkItem:\n  provider: gitlab\n  namespace: ${GITLAB_NAMESPACE}\n  repository: ${GITLAB_REPOSITORY}\n  parentIid: ${parent.iid}\n  baseUrl: ${providerBaseUrl}\n  stages:\n    shape: ${shapeIssue.iid}\n    hld-define: ${hldIssue.iid}\n`
      )

      const res = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: JSON.stringify({ stage: 'hld-define', reviewer: 'reviewer1' }),
      })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /Review requests are only available for the instance's current stage \("shape"\)/)
    },
    { fakeServerOptions: { members: [{ id: 501, username: 'reviewer1', name: 'Reviewer One', access_level: 30 }] } }
  )
})

test('Review status (gitlab) is read only on explicit Check status, from the issue\'s current gantry:review/* label — never polling', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      const { parentIid, shapeIid } = await setUpLinkedInstance(providerBaseUrl, instancesDir)
      await writeInstanceYaml(providerBaseUrl, instanceYamlText(SLUG, { parentIid, shapeIid, providerBaseUrl }))

      const requested = await fetch(`${gantryBase}/api/instance/request-review?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewer: 'reviewer1' }),
      }).then((r) => r.json())

      // A reviewer's real decision in GitLab's own UI — modelled here as a direct label change against
      // the fake server, bypassing gantry entirely, exactly like the GitHub suite's own PATCH against
      // the fake GitHub server simulates a reviewer's decision.
      const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)
      await fetch(`${providerBaseUrl}/projects/${projectId}/issues/${requested.review.workItemId}`, {
        method: 'PUT',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [`${GITLAB_REVIEW_LABEL_PREFIX}changes-requested`] }),
      })

      // Not reflected until the explicit Check action re-reads it.
      const beforeCheck = await readInstance(SLUG, { gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT } })
      assert.equal(beforeCheck.reviewRequests.shape[0].status, 'Requested')

      const statusRes = await fetch(`${gantryBase}/api/instance/review-status?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: JSON.stringify({ stage: 'shape', reviewId: requested.review.workItemId }),
      })
      assert.equal(statusRes.status, 200)
      assert.equal((await statusRes.json()).review.status, 'Changes requested')

      const afterCheck = await readInstance(SLUG, { gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT } })
      assert.equal(afterCheck.reviewRequests.shape[0].status, 'Changes requested')
    },
    { fakeServerOptions: { members: [{ id: 501, username: 'reviewer1', name: 'Reviewer One', access_level: 30 }] } }
  )
})

test('Review status (gitlab) rejects an invalid review id and a review id with no matching request', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    const { parentIid, shapeIid } = await setUpLinkedInstance(providerBaseUrl, instancesDir)
    await writeInstanceYaml(providerBaseUrl, instanceYamlText(SLUG, { parentIid, shapeIid, providerBaseUrl }))

    const notANumber = await fetch(`${gantryBase}/api/instance/review-status?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewId: 'not-a-number' }),
    })
    assert.equal(notANumber.status, 400)
    assert.match((await notANumber.json()).error, /A valid review work item id is required/)

    const noSuchReview = await fetch(`${gantryBase}/api/instance/review-status?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({ stage: 'shape', reviewId: 999999 }),
    })
    assert.equal(noSuchReview.status, 400)
    assert.match((await noSuchReview.json()).error, /has no review request for work item #999999 on stage "shape"/)
  })
})

test('requestStageReview and checkStageReviewStatus require options.azureDevOps, options.github or options.gitlab', async () => {
  const { requestStageReview, checkStageReviewStatus } = await import('../lib/stageReview.js')
  await assert.rejects(
    () => requestStageReview('some-slug', { reviewer: 'a@example.com' }, {}),
    /Stage review actions are for Workspace-backed instances only — pass options.azureDevOps or options.github, or options.gitlab/
  )
  await assert.rejects(
    () => checkStageReviewStatus('some-slug', { reviewId: '1' }, {}),
    /Stage review actions are for Workspace-backed instances only — pass options.azureDevOps or options.github, or options.gitlab/
  )
})

// Writes/overwrites instance.yaml directly on the fake GitLab server's `main` branch via its own
// Commits API — used instead of the fake server's own `files` seeding option (which only seeds a
// server that hasn't started yet) since setUpLinkedInstance needs the parent/child issues created
// against an already-running fake server first, to get their real iids into the fixture text.
async function writeInstanceYaml(providerBaseUrl, text) {
  const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)
  const res = await fetch(`${providerBaseUrl}/projects/${projectId}/repository/commits`, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main',
      commit_message: 'Seed instance.yaml',
      actions: [{ action: 'create', file_path: `gantry-workspace/${SLUG}/instance.yaml`, content: text }],
    }),
  })
  if (!res.ok) {
    throw new Error(`Failed to seed instance.yaml on the fake GitLab server: HTTP ${res.status} ${await res.text()}`)
  }
}
