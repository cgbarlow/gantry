import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/workItemAssets.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

const BASE_URL = 'https://gantry.example.test'

const linkWorkItemTool = tools.find((t) => t.name === 'link_work_item')
const tagWorkItemTool = tools.find((t) => t.name === 'tag_work_item')
const syncWorkItemTool = tools.find((t) => t.name === 'sync_work_item')
const setAssigneeTool = tools.find((t) => t.name === 'set_assignee')
const listCommitsTool = tools.find((t) => t.name === 'list_commits')
const listAssetsTool = tools.find((t) => t.name === 'list_assets')
const uploadAssetTool = tools.find((t) => t.name === 'upload_asset')

// ---------------------------------------------------------------------------
// link_work_item
// ---------------------------------------------------------------------------

test('link_work_item rejects a call with neither slug nor ref, without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await linkWorkItemTool.handler({ organization: 'o', project: 'p', parentId: 1 }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /slug.*ref/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('link_work_item rejects a missing required field without touching the network', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await linkWorkItemTool.handler({ slug: 'my-instance', organization: 'o' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /Missing required field/)
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/work-items/link'), false)
  } finally {
    fetch.restore()
  }
})

test('link_work_item links an Azure DevOps instance to a parent work item', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance/work-items/link' && method === 'POST') {
      const parsed = JSON.parse(body)
      assert.deepEqual(parsed, { organization: 'org1', project: 'proj1', parentId: 42 })
      return { status: 200, body: { id: 101, url: 'https://dev.azure.com/org1/proj1/_workitems/edit/101' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await linkWorkItemTool.handler(
      { slug: 'ado-instance', organization: 'org1', project: 'proj1', parentId: 42 },
      { gantryClient }
    )
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.id, 101)
  } finally {
    fetch.restore()
  }
})

test('link_work_item links to a GitHub parent issue when provider is "github"', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/work-items/link' && method === 'POST') {
      const parsed = JSON.parse(body)
      assert.deepEqual(parsed, { provider: 'github', owner: 'acme', repository: 'repo1', parentNumber: 7 })
      return { status: 200, body: { number: 7, kind: 'child', url: 'https://github.com/acme/repo1/issues/8' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await linkWorkItemTool.handler(
      { slug: 'gh-instance', provider: 'github', owner: 'acme', repository: 'repo1', parentNumber: 7 },
      { gantryClient }
    )
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.number, 7)
  } finally {
    fetch.restore()
  }
})

test('link_work_item reports missing_workspace_pat and never calls the link route', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await linkWorkItemTool.handler(
      { slug: 'ado-instance', organization: 'org1', project: 'proj1', parentId: 42 },
      { gantryClient }
    )
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/work-items/link'), false)
  } finally {
    fetch.restore()
  }
})

test('link_work_item surfaces a 409 when the instance is already linked', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/work-items/link' && method === 'POST') {
      return { status: 409, body: { error: 'Instance "my-instance" is already linked to work item 101' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await linkWorkItemTool.handler(
      { slug: 'my-instance', organization: 'org1', project: 'proj1', parentId: 42 },
      { gantryClient }
    )
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /409/)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// tag_work_item
// ---------------------------------------------------------------------------

test('tag_work_item repairs tags on the instance\'s linked work items', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance/work-items/tag' && method === 'POST') {
      return { status: 200, body: { tagged: [101, 102] } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await tagWorkItemTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.deepEqual(payload.tagged, [101, 102])
  } finally {
    fetch.restore()
  }
})

test('tag_work_item reports missing_workspace_pat and never calls the tag route', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await tagWorkItemTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/work-items/tag'), false)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// sync_work_item
// ---------------------------------------------------------------------------

test('sync_work_item pushes the current gate state to the linked work item', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance/work-items/sync' && method === 'POST') {
      assert.deepEqual(JSON.parse(body), { gate: 'discovery' })
      return { status: 200, body: { synced: true, workItemId: 101 } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await syncWorkItemTool.handler({ slug: 'ado-instance', gate: 'discovery' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.synced, true)
  } finally {
    fetch.restore()
  }
})

test('sync_work_item surfaces a validation 400 when the gate has not passed', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/work-items/sync' && method === 'POST') {
      return { status: 400, body: { error: 'Gate has not passed' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await syncWorkItemTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /400/)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// set_assignee
// ---------------------------------------------------------------------------

test('set_assignee requires an "assignee" string without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await setAssigneeTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /assignee/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('set_assignee updates the instance assignee, reflected on the next get_instance-shaped read', async () => {
  let stored = ''
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/assignee' && method === 'PUT') {
      const parsed = JSON.parse(body)
      stored = parsed.assignee
      return { status: 200, body: { slug: 'my-instance', assignee: stored } }
    }
    if (url.pathname === '/api/instance' && method === 'GET') {
      return { status: 200, body: { slug: 'my-instance', assignee: stored } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const setResult = await setAssigneeTool.handler({ slug: 'my-instance', assignee: 'alice' }, { gantryClient })
    assert.equal(setResult.isError, undefined)
    const setPayload = JSON.parse(setResult.content[0].text)
    assert.equal(setPayload.assignee, 'alice')

    // Simulate the "next get_instance" read against the same fake server state.
    const getRes = await gantryClient.request({ workspaceId: 'srv-1', path: '/api/instance', query: { slug: 'my-instance' } })
    assert.equal(getRes.body.assignee, 'alice')
  } finally {
    fetch.restore()
  }
})

test('set_assignee allows clearing the assignee with an empty string', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/assignee' && method === 'PUT') {
      assert.deepEqual(JSON.parse(body), { assignee: '' })
      return { status: 200, body: { slug: 'my-instance', assignee: '' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await setAssigneeTool.handler({ slug: 'my-instance', assignee: '' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.assignee, '')
  } finally {
    fetch.restore()
  }
})

test('set_assignee reports missing_workspace_pat and never calls PUT /api/instance/assignee', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await setAssigneeTool.handler({ slug: 'ado-instance', assignee: 'bob' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/assignee'), false)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// list_commits
// ---------------------------------------------------------------------------

test('list_commits returns an instance\'s commit history', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance/commits' && method === 'GET') {
      return {
        status: 200,
        body: { branch: 'gantry/my-instance/discovery', ref: 'refs/heads/gantry/my-instance/discovery', commits: [{ commitId: 'abc123', message: 'Update discovery', timestamp: '2026-01-01T00:00:00Z' }] },
      }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await listCommitsTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.commits.length, 1)
    assert.equal(payload.commits[0].commitId, 'abc123')
  } finally {
    fetch.restore()
  }
})

test('list_commits surfaces a 400 for a non-Workspace-backed instance', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: null, scope: null } }
    if (url.pathname === '/api/instance/commits' && method === 'GET') {
      return { status: 400, body: { error: 'Instance "my-instance" is not Workspace-backed — there is no stage branch to read commits from.' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await listCommitsTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /400/)
  } finally {
    fetch.restore()
  }
})

test('list_commits reports missing_workspace_pat and never calls the commits route', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await listCommitsTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/commits'), false)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// upload_asset / list_assets
// ---------------------------------------------------------------------------

test('upload_asset requires filename and contentBase64 without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await uploadAssetTool.handler({ slug: 'my-instance', filename: 'diagram.png' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /contentBase64/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('upload_asset correctly translates base64 tool input into the expected upload request; list_assets reflects the upload', async () => {
  const originalBytes = Buffer.from('fake png bytes')
  const contentBase64 = originalBytes.toString('base64')
  let uploaded = null

  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/assets' && method === 'POST') {
      const parsed = JSON.parse(body)
      // The tool must send JSON with a base64 "dataBase64" field whose decoded bytes match the
      // caller's original input exactly — gantry serve itself does `Buffer.from(body.dataBase64, 'base64')`.
      assert.equal(Buffer.from(parsed.dataBase64, 'base64').toString(), 'fake png bytes')
      assert.equal(parsed.filename, 'diagram.png')
      assert.equal(parsed.name, 'Diagram')
      uploaded = { id: parsed.filename, filename: parsed.filename, name: parsed.name, source: '', uploadedBy: '' }
      return { status: 201, body: uploaded }
    }
    if (url.pathname === '/api/instance/assets' && method === 'GET') {
      return { status: 200, body: uploaded ? [uploaded] : [] }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const uploadResult = await uploadAssetTool.handler(
      { slug: 'my-instance', filename: 'diagram.png', contentBase64, name: 'Diagram' },
      { gantryClient }
    )
    assert.equal(uploadResult.isError, undefined)
    const uploadPayload = JSON.parse(uploadResult.content[0].text)
    assert.equal(uploadPayload.filename, 'diagram.png')

    const listResult = await listAssetsTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(listResult.isError, undefined)
    const listPayload = JSON.parse(listResult.content[0].text)
    assert.equal(listPayload.assets.length, 1)
    assert.equal(listPayload.assets[0].filename, 'diagram.png')
  } finally {
    fetch.restore()
  }
})

test('upload_asset strips a data: URL prefix before sending', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/assets' && method === 'POST') {
      const parsed = JSON.parse(body)
      assert.equal(Buffer.from(parsed.dataBase64, 'base64').toString(), 'hi')
      return { status: 201, body: { id: parsed.filename, filename: parsed.filename } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const contentBase64 = 'data:image/png;base64,' + Buffer.from('hi').toString('base64')
    const result = await uploadAssetTool.handler({ slug: 'my-instance', filename: 'x.png', contentBase64 }, { gantryClient })
    assert.equal(result.isError, undefined)
  } finally {
    fetch.restore()
  }
})

test('upload_asset surfaces a 400 for an Azure-DevOps-backed (Workspace-backed) instance', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance/assets' && method === 'POST') {
      return { status: 400, body: { error: 'Asset uploads are not supported for Workspace-backed instances — commit files to gantry-workspace/<slug>/assets/ in the Azure DevOps repo instead.' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const contentBase64 = Buffer.from('bytes').toString('base64')
    const result = await uploadAssetTool.handler({ slug: 'ado-instance', filename: 'x.png', contentBase64 }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /400/)
    assert.match(payload.detail.error, /not supported for Workspace-backed/)
  } finally {
    fetch.restore()
  }
})

test('upload_asset reports missing_workspace_pat and never calls the assets route', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const contentBase64 = Buffer.from('bytes').toString('base64')
    const result = await uploadAssetTool.handler({ slug: 'ado-instance', filename: 'x.png', contentBase64 }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/assets' && c.method === 'POST'), false)
  } finally {
    fetch.restore()
  }
})

test('list_assets surfaces an upstream error rather than throwing', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: null, scope: null } }
    if (url.pathname === '/api/instance/assets' && method === 'GET') return { status: 500, body: { error: 'boom' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await listAssetsTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /500/)
  } finally {
    fetch.restore()
  }
})
