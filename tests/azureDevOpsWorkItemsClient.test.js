import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAzureDevOpsWorkItemsClient,
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
  DEFAULT_BASE_URL,
  GANTRY_WORK_ITEM_TAG,
} from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const VALID_PAT = 'valid-test-pat'

// Mirrors tests/azureDevOpsClient.test.js's own wrapper: pins this file's fixed organization/project/PAT constants so call sites below only need to supply whatever varies (usually just `workItemTypeStates`). No `repository` is passed — Work Items endpoints aren't repository-scoped.
function withFakeAzureDevOpsServer({ workItemTypeStates, workItemTypes } = {}, fn) {
  return withFakeServer(
    { organization: ORGANIZATION, project: PROJECT, validPat: VALID_PAT, workItemTypeStates, workItemTypes },
    fn
  )
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

test('ensureWorkItemTag preserves existing tags and is idempotent', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createWorkItem('Task', {
      'System.Title': 'Stage work',
      'System.Tags': 'ready-for-agent; enhancement',
    })

    const first = await c.ensureWorkItemTag(created.id)
    assert.equal(first.updated, true)
    assert.equal(first.workItem.fields['System.Tags'], `ready-for-agent; enhancement; ${GANTRY_WORK_ITEM_TAG}`)
    assert.equal(first.workItem.rev, 2)

    const second = await c.ensureWorkItemTag(created.id)
    assert.equal(second.updated, false)
    assert.equal(second.workItem.fields['System.Tags'], first.workItem.fields['System.Tags'])
    assert.equal(second.workItem.rev, 2)
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

test('getWorkItem fetches a work item\'s current field values by id', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createWorkItem('Task', { 'System.Title': 'Render soap stage' })

    const fetched = await c.getWorkItem(created.id)
    assert.equal(fetched.id, created.id)
    assert.equal(fetched.rev, created.rev)
    assert.equal(fetched.fields['System.Title'], 'Render soap stage')
    assert.equal(fetched.fields['System.WorkItemType'], 'Task')
  })
})

test('getWorkItem reflects a prior update\'s fields, not a stale snapshot', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createWorkItem('Task', { 'System.Title': 'Draft stage' })
    await c.updateWorkItem(created.id, { 'System.State': 'Active', 'System.AssignedTo': 'a@example.com' })

    const fetched = await c.getWorkItem(created.id)
    assert.equal(fetched.rev, 2)
    assert.equal(fetched.fields['System.State'], 'Active')
    assert.equal(fetched.fields['System.AssignedTo'], 'a@example.com')
  })
})

test('getWorkItem narrows the response to the requested fields when given a `fields` list', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createWorkItem('Task', { 'System.Title': 'Draft stage', 'System.AssignedTo': 'a@example.com' })

    const fetched = await c.getWorkItem(created.id, { fields: ['System.Title'] })
    assert.deepEqual(Object.keys(fetched.fields), ['System.Title'])
    assert.equal(fetched.fields['System.Title'], 'Draft stage')
  })
})

test('getWorkItem omits `relations` by default, matching the real Azure DevOps API\'s default $expand=None behavior', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
    const child = await c.createChildWorkItem(parent.id, 'Task', { 'System.Title': 'Draft stage' })
    assert.ok(child.relations.length > 0) // sanity: the work item genuinely has a relation to omit

    const fetched = await c.getWorkItem(child.id)
    assert.equal('relations' in fetched, false)
  })
})

test('getWorkItem includes `relations` when explicitly requested via `expand: \'relations\'` (or `\'all\'`)', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
    const child = await c.createChildWorkItem(parent.id, 'Task', { 'System.Title': 'Draft stage' })

    const withRelations = await c.getWorkItem(child.id, { expand: 'relations' })
    assert.equal(withRelations.relations.length, 1)
    assert.equal(withRelations.relations[0].rel, 'System.LinkTypes.Hierarchy-Reverse')

    const withAll = await c.getWorkItem(child.id, { expand: 'all' })
    assert.equal(withAll.relations.length, 1)
  })
})

test('getWorkItem throws AzureDevOpsNotFoundError for a work item id that does not exist', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).getWorkItem(999999), AzureDevOpsNotFoundError)
  })
})

test('a rejected PAT surfaces as AzureDevOpsAuthenticationError on getWorkItem', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createWorkItem('Task', { 'System.Title': 'X' })
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.getWorkItem(created.id), AzureDevOpsAuthenticationError)
  })
})

test('listWorkItemTypes returns the configured work item types available in the project', async () => {
  await withFakeAzureDevOpsServer(
    { workItemTypes: ['Task', 'Bug', 'User Story'] },
    async (baseUrl) => {
      const types = await client(baseUrl).listWorkItemTypes()
      assert.deepEqual(
        types.map((t) => t.name),
        ['Task', 'Bug', 'User Story']
      )
    }
  )
})

test('listWorkItemTypes falls back to a generic type list when the project has no explicit configuration', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const types = await client(baseUrl).listWorkItemTypes()
    assert.ok(types.length > 0)
    assert.ok(types.every((t) => typeof t.name === 'string' && typeof t.referenceName === 'string'))
  })
})

test('listWorkItemTypes does not confuse the project-wide list with a single type\'s states', async () => {
  await withFakeAzureDevOpsServer(
    { workItemTypes: ['Task'], workItemTypeStates: { Task: ['To Do', 'Doing', 'Done'] } },
    async (baseUrl) => {
      const c = client(baseUrl)
      const types = await c.listWorkItemTypes()
      assert.deepEqual(types.map((t) => t.name), ['Task'])

      const states = await c.getWorkItemTypeStates('Task')
      assert.deepEqual(states.map((s) => s.name), ['To Do', 'Doing', 'Done'])
    }
  )
})

test('a rejected PAT surfaces as AzureDevOpsAuthenticationError on listWorkItemTypes', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.listWorkItemTypes(), AzureDevOpsAuthenticationError)
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

test('a network failure reaching the Azure DevOps API surfaces as AzureDevOpsRequestError, not the auth or not-found errors', async () => {
  // Nothing listens on this port — a real connection failure, not a mock of fetch — exercising the client's network-error branch, distinct from the HTTP-level auth/not-found branches covered above. Mirrors the equivalent test in tests/azureDevOpsClient.test.js.
  const unreachableBaseUrl = 'http://127.0.0.1:1'
  const c = client(unreachableBaseUrl)
  await assert.rejects(() => c.createWorkItem('Task', { 'System.Title': 'X' }), AzureDevOpsRequestError)
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
