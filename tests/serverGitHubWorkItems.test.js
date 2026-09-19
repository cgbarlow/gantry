import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readInstance } from '../lib/instance.js'
import { createGitHubWorkItemsClient } from '../lib/githubWorkItemsClient.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import {
  withRunningServerForProvider,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #14 — GitHub work items: link, hierarchy and gate sync. The GitHub twin of tests/serverWorkItems.test.js
// (#95/#103's Azure DevOps coverage), parameterizing the same routes — POST /api/instance/work-items/link,
// POST /api/instance/work-items/sync, GET /api/instance/check — against a real fake GitHub server
// (tests/helpers/fakeGitHubServer.js) instead, per #1's Testing Decisions ("parameterize the existing
// server route suites over both providers"). Where behaviour genuinely diverges (no work-item type,
// sub-issue vs. task-list hierarchy, closed-as-completed instead of a configurable state), that's its own
// explicit test rather than a silently absent one.

function withScratchGitHubServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider(
    'github',
    { options: { instancesDir }, fakeServerOptions },
    (ctx) => fn({ ...ctx, instancesDir })
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

async function createParentIssue(providerBaseUrl) {
  const client = createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
  const parent = await client.createIssue({ title: 'Parent initiative', body: '' })
  return parent.number
}

function localInstancesDir(instancesDir) {
  return join(instancesDir, 'default')
}

function linkBody(parentNumber, providerBaseUrl) {
  return JSON.stringify({ provider: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, parentNumber, baseUrl: providerBaseUrl })
}

function fillShapeStage(instancesDir, slug) {
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    cpSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), join(localInstancesDir(instancesDir), slug, 'modules', `${moduleId}.md`))
  }
}

// ---------- GET /api/instance reports workItem ----------

test('GET /api/instance reports workItem as null for an unlinked instance, then the recorded GitHub link once linked', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })

    const before = await (await fetch(`${gantryBase}/api/instance?slug=my-initiative`)).json()
    assert.equal(before.workItem, null)

    const parentNumber = await createParentIssue(providerBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: linkBody(parentNumber, providerBaseUrl),
    })
    assert.equal(linkRes.status, 200)

    const after = await (await fetch(`${gantryBase}/api/instance?slug=my-initiative`)).json()
    assert.equal(after.workItem.provider, 'github')
    assert.equal(after.workItem.parentNumber, parentNumber)
    assert.equal(typeof after.workItem.stages.shape, 'number')
  })
})

// ---------- POST /api/instance/work-items/link ----------

test('POST /api/instance/work-items/link (github) with no PAT returns the structured "authentication required" response naming github', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentNumber = await createParentIssue(providerBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: linkBody(parentNumber, providerBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('POST /api/instance/work-items/link (github) with missing fields reports 400, not 500', async () => {
  await withScratchGitHubServer(async ({ gantryBase, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ provider: 'github', owner: GITHUB_OWNER }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Missing required field\(s\): repository, parentNumber/)
  })
})

test('POST /api/instance/work-items/link (github) succeeds, creating one child issue per stage as native sub-issues, with no workItemType field', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentNumber = await createParentIssue(providerBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: linkBody(parentNumber, providerBaseUrl),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.provider, 'github')
    assert.equal(body.parentNumber, parentNumber)
    assert.equal(body.workItemType, undefined)
    assert.deepEqual(Object.keys(body.stages).sort(), ['detailed-design', 'handover', 'hld-define', 'shape'])

    const instance = readInstance('my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    assert.deepEqual(instance.workItem, body)

    // Genuinely attached as native sub-issues against the fake server.
    const subRes = await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/issues/${parentNumber}/sub_issues`, {
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
    })
    const subIssues = await subRes.json()
    assert.deepEqual(subIssues.map((i) => i.number).sort((a, b) => a - b), Object.values(body.stages).sort((a, b) => a - b))
  })
})

test('POST /api/instance/work-items/link (github) falls back to a task-list-plus-"Part of" hierarchy when sub-issues are unavailable', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
      const parentNumber = await createParentIssue(providerBaseUrl)

      const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: linkBody(parentNumber, providerBaseUrl),
      })
      assert.equal(res.status, 200)
      const body = await res.json()

      const client = createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
      const parent = await client.getIssue(parentNumber)
      assert.match(parent.body, /## Stages/)
      assert.equal((parent.body.match(/- \[ \] #/g) ?? []).length, 4)

      const shapeChild = await client.getIssue(body.stages.shape)
      assert.match(shapeChild.body, new RegExp(`Part of #${parentNumber}`))
    },
    { fakeServerOptions: { subIssuesEnabled: false } }
  )
})

test('POST /api/instance/work-items/link (github) reports 409 for an instance already linked', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentNumber = await createParentIssue(providerBaseUrl)
    const body = linkBody(parentNumber, providerBaseUrl)

    const first = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body,
    })
    assert.equal(first.status, 200)

    const second = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body,
    })
    assert.equal(second.status, 409)
    const secondBody = await second.json()
    assert.match(secondBody.error, /already linked/)
  })
})

// ---------- POST /api/instance/work-items/sync ----------

test('POST /api/instance/work-items/sync (github) with no PAT returns the structured "authentication required" response', async () => {
  await withScratchGitHubServer(async ({ gantryBase, instancesDir }) => {
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

test('POST /api/instance/work-items/sync (github) reports 400 when the gate has not passed yet', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    const parentNumber = await createParentIssue(providerBaseUrl)
    await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: linkBody(parentNumber, providerBaseUrl),
    })

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /has not passed/)
  })
})

test('POST /api/instance/work-items/sync (github) reports 400 for an unlinked instance', async () => {
  await withScratchGitHubServer(async ({ gantryBase, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    fillShapeStage(instancesDir, 'my-initiative')

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not linked/)
  })
})

test('POST /api/instance/work-items/sync (github) closes the stage\'s issue as completed once the gate passes (the confirmed push), and never gates advancement', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    createInstance('design', 'my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    fillShapeStage(instancesDir, 'my-initiative')
    const parentNumber = await createParentIssue(providerBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: linkBody(parentNumber, providerBaseUrl),
    })
    const link = await linkRes.json()

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.workItemId, link.stages.shape)
    assert.equal(body.state, 'closed')
    assert.equal(body.workItem.state, 'closed')
    assert.equal(body.workItem.state_reason, 'completed')

    // Confirmed against the fake server directly, not merely echoed back.
    const client = createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
    const shapeIssue = await client.getIssue(link.stages.shape)
    assert.equal(shapeIssue.state, 'closed')

    // The instance itself never advanced — a linked issue is a tracking surface only; the sync route
    // performs no stage-pointer write, unlike a Pull Request merge (docs/adr/0040).
    const instance = readInstance('my-initiative', { instancesDir: localInstancesDir(instancesDir) })
    assert.equal(instance.stage, 'shape')
  })
})

// ---------- GET /api/instance/check: GitHub-backed instances ----------

test('GET /api/instance/check checks a GitHub-backed instance for real, not a local directory it never lived in', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    writeWorkspaceJson(instancesDir, 'default', { name: 'default', kind: 'local', createdAt: new Date().toISOString() })

    const createRes = await fetch(`${gantryBase}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({
        definition: 'design',
        slug: 'my-initiative',
        github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl },
      }),
    })
    assert.equal(createRes.status, 201)

    const unauthed = await fetch(`${gantryBase}/api/instance/check?slug=my-initiative`)
    assert.equal(unauthed.status, 401)
    const unauthedBody = await unauthed.json()
    assert.equal(unauthedBody.error, 'authentication_required')

    const res = await fetch(`${gantryBase}/api/instance/check?slug=my-initiative`, {
      headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.pass, false)
    assert.equal(body.gate, 'business-case')
  })
})
