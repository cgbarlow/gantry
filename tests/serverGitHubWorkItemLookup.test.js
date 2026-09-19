import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubWorkItemsClient } from '../lib/githubWorkItemsClient.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withRunningServer, basicAuthHeader, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/lifecycle.js'

// HTTP-boundary tests for the GitHub twin (#14) of tests/serverAzureDevOpsWorkItemLookup.test.js's two
// routes: `GET /api/github/work-items/:number` (the "+ New Workspace" wizard's parent-issue look-up) —
// there is no `work-item-types` twin, since docs/adr/0040 drops the concept for GitHub rather than
// emulating it — plus `POST /api/github/work-items`, the wizard's "create a new parent work item" mode.

function withFakeAndGantryServer(options, fn) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, ...options }, (baseUrl) =>
    withRunningServer({ allowGitHubBaseUrlOverride: true }, (gantryBase) => fn(gantryBase, baseUrl))
  )
}

function lookupUrl(gantryBase, baseUrl, number) {
  const url = new URL(`${gantryBase}/api/github/work-items/${number}`)
  url.searchParams.set('owner', GITHUB_OWNER)
  url.searchParams.set('repository', GITHUB_REPOSITORY)
  url.searchParams.set('baseUrl', baseUrl)
  return url.toString()
}

// ---------- GET /api/github/work-items/:number ----------

test('GET /api/github/work-items/:number with no PAT returns the structured "authentication required" response naming github', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, baseUrl) => {
    const res = await fetch(lookupUrl(gantryBase, baseUrl, 1))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('GET /api/github/work-items/:number with a missing required query parameter returns 400, without requiring a PAT', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const url = new URL(`${gantryBase}/api/github/work-items/1`)
    url.searchParams.set('owner', GITHUB_OWNER)
    // "repository" deliberately omitted.
    const res = await fetch(url.toString())
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /repository/)
  })
})

test('GET /api/github/work-items/:number with a valid PAT reports the real issue\'s title/state, with no workItemType field', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, baseUrl) => {
    const client = createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const created = await client.createIssue({ title: 'Parent initiative', body: '' })

    const res = await fetch(lookupUrl(gantryBase, baseUrl, created.number), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.number, created.number)
    assert.equal(body.title, 'Parent initiative')
    assert.equal(body.state, 'open')
    assert.equal(body.workItemType, undefined)
  })
})

test('GET /api/github/work-items/:number reports 404 for an issue number that does not exist, not a 500', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, baseUrl) => {
    const res = await fetch(lookupUrl(gantryBase, baseUrl, 999999), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 404)
  })
})

test('GET /api/github/work-items/:number rejects a baseUrl override when the server has not opted in', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    await withRunningServer({}, async (gantryBase) => {
      const res = await fetch(lookupUrl(gantryBase, baseUrl, 1), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
    })
  })
})

// ---------- POST /api/github/work-items ----------

test('POST /api/github/work-items creates a plain issue with no workItemType', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, baseUrl) => {
    const res = await fetch(`${gantryBase}/api/github/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, title: 'A brand new parent', baseUrl }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.title, 'A brand new parent')
    assert.equal(body.state, 'open')
    assert.equal(body.workItemType, undefined)

    const lookup = await fetch(lookupUrl(gantryBase, baseUrl, body.number), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(lookup.status, 200)
  })
})

test('POST /api/github/work-items with missing fields reports 400, not 500', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const res = await fetch(`${gantryBase}/api/github/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ owner: GITHUB_OWNER }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Missing required field\(s\): repository, title/)
  })
})
