import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAzureDevOpsWorkItemsClient,
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  DEFAULT_BASE_URL,
} from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const VALID_PAT = 'valid-test-pat'

// Mirrors tests/azureDevOpsClient.test.js's own wrapper: pins this file's
// fixed organization/project/PAT constants so call sites below only need
// to supply whatever varies (usually just `workItemTypeStates`). No
// `repository` is passed — Work Items endpoints aren't repository-scoped.
function withFakeAzureDevOpsServer({ workItemTypeStates } = {}, fn) {
  return withFakeServer({ organization: ORGANIZATION, project: PROJECT, validPat: VALID_PAT, workItemTypeStates }, fn)
}

function client(baseUrl, overrides = {}) {
  return createAzureDevOpsWorkItemsClient({
    organization: ORGANIZATION,
    project: PROJECT,
    pat: VALID_PAT,
    baseUrl,
    ...overrides,
  })
}

test('createWorkItem creates a work item of the given type with the given fields', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const workItem = await client(baseUrl).createWorkItem('Task', { 'System.Title': 'Render soap stage' })
    assert.equal(typeof workItem.id, 'number')
    assert.equal(workItem.rev, 1)
    assert.equal(workItem.fields['System.WorkItemType'], 'Task')
    assert.equal(workItem.fields['System.Title'], 'Render soap stage')
    assert.equal(workItem.fields['System.State'], 'New')
  })
})

test('createWorkItem creates work items with distinct, incrementing ids', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const first = await c.createWorkItem('Task', { 'System.Title': 'First' })
    const second = await c.createWorkItem('Task', { 'System.Title': 'Second' })
    assert.notEqual(first.id, second.id)
  })
})

test('createChildWorkItem creates a work item linked to its parent via a Hierarchy-Reverse relation', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createWorkItem('Feature', { 'System.Title': 'Parent instance' })
    const child = await c.createChildWorkItem(parent.id, 'Task', { 'System.Title': 'Draft stage' })

    assert.equal(child.fields['System.WorkItemType'], 'Task')
    assert.equal(child.relations.length, 1)
    assert.equal(child.relations[0].rel, 'System.LinkTypes.Hierarchy-Reverse')
    assert.ok(child.relations[0].url.endsWith(`/workItems/${parent.id}`))
  })
})

test('updateWorkItem updates an existing work item\'s fields without touching others', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createWorkItem('Task', { 'System.Title': 'Draft stage' })

    const updated = await c.updateWorkItem(created.id, { 'System.State': 'Active' })
    assert.equal(updated.fields['System.State'], 'Active')
    assert.equal(updated.fields['System.Title'], 'Draft stage')
    assert.equal(updated.rev, 2)
  })
})

test('updateWorkItem throws AzureDevOpsNotFoundError for a work item id that does not exist', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).updateWorkItem(999999, { 'System.State': 'Active' }), AzureDevOpsNotFoundError)
  })
})

test('getWorkItemTypeStates returns the configured valid states for a work item type', async () => {
  await withFakeAzureDevOpsServer(
    { workItemTypeStates: { Task: ['To Do', 'Doing', 'Done'] } },
    async (baseUrl) => {
      const states = await client(baseUrl).getWorkItemTypeStates('Task')
      assert.deepEqual(
        states.map((s) => s.name),
        ['To Do', 'Doing', 'Done']
      )
    }
  )
})

test('getWorkItemTypeStates falls back to a generic state list for a type with no explicit configuration', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const states = await client(baseUrl).getWorkItemTypeStates('Bug')
    assert.ok(states.length > 0)
    assert.ok(states.every((s) => typeof s.name === 'string' && typeof s.category === 'string'))
  })
})

test('a rejected PAT surfaces as AzureDevOpsAuthenticationError on createWorkItem', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.createWorkItem('Task', { 'System.Title': 'X' }), AzureDevOpsAuthenticationError)
  })
})

test('a rejected PAT surfaces as AzureDevOpsAuthenticationError on getWorkItemTypeStates', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.getWorkItemTypeStates('Task'), AzureDevOpsAuthenticationError)
  })
})

test('base URL defaults to the real Azure DevOps API but is configurable/overridable for tests', async () => {
  assert.equal(DEFAULT_BASE_URL, 'https://dev.azure.com')
  assert.equal(client(undefined).baseUrl, 'https://dev.azure.com')

  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    assert.equal(c.baseUrl, baseUrl)
    const workItem = await c.createWorkItem('Task', { 'System.Title': 'Proves override took effect' })
    assert.equal(workItem.fields['System.Title'], 'Proves override took effect')
  })
})

test('createAzureDevOpsWorkItemsClient requires organization, project and pat (no repository)', () => {
  assert.throws(() => createAzureDevOpsWorkItemsClient({ project: PROJECT, pat: VALID_PAT }), /organization/)
  assert.throws(() => createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, pat: VALID_PAT }), /project/)
  assert.throws(() => createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT }), /pat/)
})
