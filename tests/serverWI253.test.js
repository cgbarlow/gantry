import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../lib/server.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'wi253-org'
const PROJECT = 'wi253-project'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

function withFakeAndGantryServer(options, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, validPat: VALID_PAT, ...options }, async (adoBaseUrl) => {
    await withRunningServer({ allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (gantryBase) => fn(gantryBase, adoBaseUrl))
  })
}

// ---------- POST /api/azure-devops/work-items ----------

test('POST /api/azure-devops/work-items with no PAT returns 401', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/azure-devops/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, workItemType: 'Task', title: 'New parent', baseUrl: adoBaseUrl }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/azure-devops/work-items missing fields returns 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/azure-devops/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: ORGANIZATION }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Missing required field/)
  })
})

test('POST /api/azure-devops/work-items creates a work item and returns id/title/type/state', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/azure-devops/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, workItemType: 'Task', title: 'My new parent', baseUrl: adoBaseUrl }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(typeof body.id, 'number')
    assert.equal(body.title, 'My new parent')
    assert.equal(body.workItemType, 'Task')
    assert.equal(body.state, 'New')
  })
})

test('POST /api/azure-devops/work-items rejects baseUrl not on allow-list', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, validPat: VALID_PAT }, async (adoBaseUrl) => {
    await withRunningServer({}, async (gantryBase) => {
      const res = await fetch(`${gantryBase}/api/azure-devops/work-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
        body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, workItemType: 'Task', title: 'x', baseUrl: adoBaseUrl }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
    })
  })
})

// ---------- GET /api/identities with organization/project ----------

test('GET /api/identities with explicit organization/project hits that project, without a slug', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const url = new URL(`${gantryBase}/api/identities`)
    url.searchParams.set('q', 'Test')
    url.searchParams.set('organization', ORGANIZATION)
    url.searchParams.set('project', PROJECT)
    url.searchParams.set('baseUrl', adoBaseUrl)
    const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body))
    // fake server returns Test User for query "Test"
    assert.ok(body.some((i) => i.displayName === 'Test User'))
  })
})

test('GET /api/identities with organization/project but no PAT returns 401', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const url = new URL(`${gantryBase}/api/identities`)
    url.searchParams.set('q', 'Test')
    url.searchParams.set('organization', ORGANIZATION)
    url.searchParams.set('project', PROJECT)
    url.searchParams.set('baseUrl', adoBaseUrl)
    const res = await fetch(url.toString())
    assert.equal(res.status, 401)
  })
})

test('POST /api/workspaces reusing same tuple returns reused:true', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'repo1', validPat: VALID_PAT, files: {} }, async (adoBaseUrl) => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-wi253-'))
    try {
      await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const body = { organization: ORGANIZATION, project: PROJECT, repository: 'repo1', baseUrl: adoBaseUrl, owner: 'a', ticketingSystem: 'azure-devops' }
        const first = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) }, body: JSON.stringify(body) })
        assert.equal(first.status, 201)
        const second = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) }, body: JSON.stringify(body) })
        assert.equal(second.status, 200)
        const secondBody = await second.json()
        assert.equal(secondBody.reused, true)
      })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
})
