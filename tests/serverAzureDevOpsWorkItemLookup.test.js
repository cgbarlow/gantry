import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'

// HTTP-boundary tests for the two new routes #126's "+ New Workspace"
// wizard step needs: `GET /api/azure-devops/work-item-types` and `GET
// /api/azure-devops/work-items/:id` — both real PAT-backed lookups against
// #121's `listWorkItemTypes`/`getWorkItem` client capabilities, gated and
// SSRF-guarded the same way `GET /api/azure-devops/repo-check`
// (tests/serverAzureDevOpsRepoCheck.test.js) already is: a caller-supplied
// organization/project (never a gantry slug, never an established
// registry entry) and the credential-provider seam (#86), with `baseUrl`
// honoured only against the server's own `allowedAzureDevOpsBaseUrls`
// allow-list.

const ORGANIZATION = 'wi-lookup-org'
const PROJECT = 'wi-lookup-project'
const VALID_PAT = 'valid-test-pat'



function withFakeWorkItemsServer(options, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, validPat: VALID_PAT, ...options }, fn)
}

function withFakeAndGantryServer(options, fn) {
  return withFakeWorkItemsServer(options, async (adoBaseUrl) => {
    await withRunningServer({ allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (gantryBase) => fn(gantryBase, adoBaseUrl))
  })
}

function typesUrl(gantryBase, adoBaseUrl) {
  const url = new URL(`${gantryBase}/api/azure-devops/work-item-types`)
  url.searchParams.set('organization', ORGANIZATION)
  url.searchParams.set('project', PROJECT)
  url.searchParams.set('baseUrl', adoBaseUrl)
  return url.toString()
}

function workItemUrl(gantryBase, adoBaseUrl, id) {
  const url = new URL(`${gantryBase}/api/azure-devops/work-items/${id}`)
  url.searchParams.set('organization', ORGANIZATION)
  url.searchParams.set('project', PROJECT)
  url.searchParams.set('baseUrl', adoBaseUrl)
  return url.toString()
}

// ---------- GET /api/azure-devops/work-item-types ----------

test('GET /api/azure-devops/work-item-types with no PAT returns the structured "authentication required" response', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(typesUrl(gantryBase, adoBaseUrl))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('GET /api/azure-devops/work-item-types with a missing required query parameter returns 400, without requiring a PAT', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const url = new URL(`${gantryBase}/api/azure-devops/work-item-types`)
    url.searchParams.set('organization', ORGANIZATION)
    // "project" deliberately omitted.
    const res = await fetch(url.toString())
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /project/)
  })
})

test('GET /api/azure-devops/work-item-types with a valid PAT lists this project\'s own work item types, filtering out disabled ones', async () => {
  await withFakeAndGantryServer(
    {
      workItemTypes: [
        { name: 'Task', referenceName: 'Microsoft.VSTS.WorkItemTypes.Task', description: '', color: '', icon: { id: '', url: '' }, isDisabled: false },
        { name: 'Bug', referenceName: 'Microsoft.VSTS.WorkItemTypes.Bug', description: '', color: '', icon: { id: '', url: '' }, isDisabled: false },
        { name: 'Retired Type', referenceName: 'Custom.WorkItemTypes.Retired', description: '', color: '', icon: { id: '', url: '' }, isDisabled: true },
      ],
    },
    async (gantryBase, adoBaseUrl) => {
      const res = await fetch(typesUrl(gantryBase, adoBaseUrl), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, [{ name: 'Task' }, { name: 'Bug' }])
    }
  )
})

test('GET /api/azure-devops/work-item-types rejects a baseUrl not on the server\'s allow-list', async () => {
  await withFakeWorkItemsServer({}, async (adoBaseUrl) => {
    await withRunningServer({}, async (gantryBase) => {
      const res = await fetch(typesUrl(gantryBase, adoBaseUrl), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
    })
  })
})

// ---------- GET /api/azure-devops/work-items/:id ----------

test('GET /api/azure-devops/work-items/:id with no PAT returns the structured "authentication required" response', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(workItemUrl(gantryBase, adoBaseUrl, 1))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('GET /api/azure-devops/work-items/:id with a missing required query parameter returns 400, without requiring a PAT', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const url = new URL(`${gantryBase}/api/azure-devops/work-items/1`)
    url.searchParams.set('organization', ORGANIZATION)
    // "project" deliberately omitted.
    const res = await fetch(url.toString())
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /project/)
  })
})

test('GET /api/azure-devops/work-items/:id with a valid PAT reports the real work item\'s title/type/state', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
    const created = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

    const res = await fetch(workItemUrl(gantryBase, adoBaseUrl, created.id), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.id, created.id)
    assert.equal(body.title, 'Parent initiative')
    assert.equal(body.workItemType, 'Feature')
    assert.equal(body.state, 'New')
  })
})

test('GET /api/azure-devops/work-items/:id reports 404 for a work item id that does not exist, not a 500', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(workItemUrl(gantryBase, adoBaseUrl, 999999), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    assert.equal(res.status, 404)
  })
})

test('GET /api/azure-devops/work-items/:id rejects a baseUrl not on the server\'s allow-list', async () => {
  await withFakeWorkItemsServer({}, async (adoBaseUrl) => {
    await withRunningServer({}, async (gantryBase) => {
      const res = await fetch(workItemUrl(gantryBase, adoBaseUrl, 1), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
    })
  })
})
