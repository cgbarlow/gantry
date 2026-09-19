import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readInstance } from '../lib/instance.js'
import { createGitLabWorkItemsClient } from '../lib/gitlabWorkItemsClient.js'
import {
  withRunningServerForProvider,
  basicAuthHeader,
  GITLAB_NAMESPACE,
  GITLAB_REPOSITORY,
  GITLAB_VALID_PAT,
} from './helpers/lifecycle.js'

// #30 — GitLab work items: link, hierarchy and gate sync. The GitLab twin of
// tests/serverGitHubWorkItems.test.js (#14's own GitHub coverage), parameterizing the same routes —
// POST /api/instance/work-items/link, POST /api/instance/work-items/sync — against a real fake GitLab
// server (tests/helpers/fakeGitLabServer.js) instead. Where behaviour genuinely diverges from GitHub
// (no work-item type, task-list-only hierarchy since GitLab's REST v4 API has no native parent/child
// relation to attempt first, `state_event: 'close'` instead of a bare `state` field), that's its own
// explicit assertion rather than a silently absent one.

function withScratchGitLabServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider(
    'gitlab',
    { options: { instancesDir }, fakeServerOptions },
    (ctx) => fn({ ...ctx, instancesDir })
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

async function createParentIssue(providerBaseUrl) {
  const client = createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl })
  const parent = await client.createIssue({ title: 'Parent initiative', body: '' })
  return parent.iid
}

function localInstancesDir(instancesDir) {
  return join(instancesDir, 'default')
}

function linkBody(parentIid, providerBaseUrl) {
  return JSON.stringify({ provider: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, parentIid, baseUrl: providerBaseUrl })
}

function fillShapeStage(instancesDir, slug) {
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    cpSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), join(localInstancesDir(instancesDir), slug, 'modules', `${moduleId}.md`))
  }
}

// ---------- GET /api/instance reports workItem ----------

test('GET /api/instance reports workItem as null for an unlinked instance, then the recorded GitLab link once linked', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })

    const before = await (await fetch(`${gantryBase}/api/instance?slug=my-initiative`)).json()
    assert.equal(before.workItem, null)

    const parentIid = await createParentIssue(providerBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: linkBody(parentIid, providerBaseUrl),
    })
    assert.equal(linkRes.status, 200)

    const after = await (await fetch(`${gantryBase}/api/instance?slug=my-initiative`)).json()
    assert.equal(after.workItem.provider, 'gitlab')
    assert.equal(after.workItem.parentIid, parentIid)
    assert.equal(typeof after.workItem.stages.shape, 'number')
  })
})

// ---------- POST /api/instance/work-items/link ----------

test('POST /api/instance/work-items/link (gitlab) with no PAT returns the structured "authentication required" response naming gitlab', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentIid = await createParentIssue(providerBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: linkBody(parentIid, providerBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitLab/)
  })
})

test('POST /api/instance/work-items/link (gitlab) with missing fields reports 400, not 500', async () => {
  await withScratchGitLabServer(async ({ gantryBase, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({ provider: 'gitlab', namespace: GITLAB_NAMESPACE }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Missing required field\(s\): repository, parentIid/)
  })
})

test('POST /api/instance/work-items/link (gitlab) succeeds, creating one child issue per stage via the task-list hierarchy, with no workItemType field', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentIid = await createParentIssue(providerBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: linkBody(parentIid, providerBaseUrl),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.provider, 'gitlab')
    assert.equal(body.parentIid, parentIid)
    assert.equal(body.workItemType, undefined)
    assert.deepEqual(Object.keys(body.stages).sort(), ['detailed-design', 'handover', 'hld-define', 'shape'])

    const instance = readInstance('my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    assert.deepEqual(instance.workItem, body)

    // Genuinely attached via the task-list-plus-"Part of" convention against the fake server itself.
    const client = createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl })
    const parent = await client.getIssue(parentIid)
    assert.match(parent.description, /## Stages/)
    assert.equal((parent.description.match(/- \[ \] #/g) ?? []).length, 4)

    const shapeChild = await client.getIssue(body.stages.shape)
    assert.match(shapeChild.description, new RegExp(`Part of #${parentIid}`))
  })
})

test('POST /api/instance/work-items/link (gitlab) reports 409 for an instance already linked', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentIid = await createParentIssue(providerBaseUrl)
    const body = linkBody(parentIid, providerBaseUrl)

    const first = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body,
    })
    assert.equal(first.status, 200)

    const second = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body,
    })
    assert.equal(second.status, 409)
    const secondBody = await second.json()
    assert.match(secondBody.error, /already linked/)
  })
})

// ---------- POST /api/instance/work-items/sync ----------

test('POST /api/instance/work-items/sync (gitlab) with no PAT returns the structured "authentication required" response', async () => {
  await withScratchGitLabServer(async ({ gantryBase, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/instance/work-items/sync (gitlab) reports 400 when the gate has not passed yet', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentIid = await createParentIssue(providerBaseUrl)
    await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: linkBody(parentIid, providerBaseUrl),
    })

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /has not passed/)
  })
})

test('POST /api/instance/work-items/sync (gitlab) reports 400 for an unlinked instance', async () => {
  await withScratchGitLabServer(async ({ gantryBase, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    fillShapeStage(instancesDir, 'my-initiative')

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not linked/)
  })
})

test('POST /api/instance/work-items/sync (gitlab) closes the stage\'s issue once the gate passes (the confirmed push), independent of any Merge Request, and never gates advancement', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    fillShapeStage(instancesDir, 'my-initiative')
    const parentIid = await createParentIssue(providerBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: linkBody(parentIid, providerBaseUrl),
    })
    const link = await linkRes.json()

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.workItemId, link.stages.shape)
    assert.equal(body.state, 'closed')
    assert.equal(body.workItem.state, 'closed')

    // Confirmed against the fake server directly, not merely echoed back.
    const client = createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl })
    const shapeIssue = await client.getIssue(link.stages.shape)
    assert.equal(shapeIssue.state, 'closed')

    // The instance itself never advanced — a linked issue is a tracking surface only; the sync route
    // performs no stage-pointer write, unlike a Merge Request merge (docs/adr/0041).
    const instance = readInstance('my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    assert.equal(instance.stage, 'shape')
  })
})
