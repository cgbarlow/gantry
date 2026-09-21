import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/instanceContent.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

const BASE_URL = 'https://gantry.example.test'

const listInstancesTool = tools.find((t) => t.name === 'list_instances')
const getInstanceTool = tools.find((t) => t.name === 'get_instance')
const updateInstanceModulesTool = tools.find((t) => t.name === 'update_instance_modules')
const renderArtefactTool = tools.find((t) => t.name === 'render_artefact')

// ---------------------------------------------------------------------------
// list_instances
// ---------------------------------------------------------------------------

test('list_instances returns the unified local + Provider-backed list', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instances') {
      assert.equal(url.searchParams.get('archived'), null)
      return {
        status: 200,
        body: [
          { slug: 'local-one', workspace: { kind: 'directory', id: 'default' } },
          { slug: 'ado-one', workspace: { kind: 'azureDevOps', id: 'ws-1' } },
        ],
      }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await listInstancesTool.handler({}, { gantryClient })

    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.instances.length, 2)
    assert.equal(payload.instances[1].workspace.kind, 'azureDevOps')
  } finally {
    fetch.restore()
  }
})

test('list_instances passes includeArchived through as ?archived=1', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instances') {
      assert.equal(url.searchParams.get('archived'), '1')
      return { status: 200, body: [{ slug: 'archived-one', archived: true }] }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await listInstancesTool.handler({ includeArchived: true }, { gantryClient })
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.instances[0].archived, true)
  } finally {
    fetch.restore()
  }
})

test('list_instances surfaces an upstream error rather than throwing', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instances') return { status: 500, body: { error: 'boom' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await listInstancesTool.handler({}, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /500/)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// get_instance
// ---------------------------------------------------------------------------

test('get_instance rejects a call with neither slug nor ref, without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await getInstanceTool.handler({}, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /slug.*ref/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('get_instance reads a local (server-directory) instance\'s current-stage module content', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance') {
      assert.equal(url.searchParams.get('slug'), 'my-instance')
      return { status: 200, body: { slug: 'my-instance', stage: { id: 'discovery' }, modules: [{ id: 'm1', fields: [] }] } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await getInstanceTool.handler({ slug: 'my-instance' }, { gantryClient })

    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.slug, 'my-instance')
    assert.equal(payload.modules[0].id, 'm1')

    const actionCall = fetch.calls.find((c) => c.url.pathname === '/api/instance')
    assert.equal(actionCall.headers.authorization, undefined)
  } finally {
    fetch.restore()
  }
})

test('get_instance attaches the mapped PAT for a Provider-backed instance', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance') return { status: 200, body: { slug: 'ado-instance' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await getInstanceTool.handler({ slug: 'ado-instance' }, { gantryClient })

    assert.equal(result.isError, undefined)
    const actionCall = fetch.calls.find((c) => c.url.pathname === '/api/instance')
    assert.equal(actionCall.headers.authorization, 'Basic ' + Buffer.from(':secret-pat').toString('base64'))
  } finally {
    fetch.restore()
  }
})

test('get_instance reports missing_workspace_pat and never calls GET /api/instance', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await getInstanceTool.handler({ slug: 'ado-instance' }, { gantryClient })

    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(payload.workspace, 'ws-2')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance'), false)
  } finally {
    fetch.restore()
  }
})

test('get_instance surfaces a 404 for an unknown instance', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: null, scope: null } }
    if (url.pathname === '/api/instance') return { status: 404, body: { error: 'Unknown instance "nope"' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await getInstanceTool.handler({ slug: 'nope' }, { gantryClient })

    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /404/)
  } finally {
    fetch.restore()
  }
})

test('get_instance surfaces gantry serve\'s own authentication_required 401 (a rejected, already-supplied PAT)', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-3', scope: 'ws-3' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-3', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance') return { status: 401, body: { error: 'authentication_required', message: 'The Azure DevOps PAT already provided was rejected.' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-3': 'stale-pat' } })
    const result = await getInstanceTool.handler({ slug: 'ado-instance' }, { gantryClient })

    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /401/)
    assert.equal(payload.detail.error, 'authentication_required')
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// update_instance_modules
// ---------------------------------------------------------------------------

test('update_instance_modules rejects an empty modules object without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await updateInstanceModulesTool.handler({ slug: 'my-instance', modules: {} }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /modules/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('update_instance_modules writes module content and returns the save status', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/modules' && method === 'PUT') {
      const parsed = JSON.parse(body)
      assert.deepEqual(parsed, { modules: { discovery: { fields: { summary: 'Updated' } } } })
      return { status: 200, body: { saved: ['discovery'], commit: null } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await updateInstanceModulesTool.handler(
      { slug: 'my-instance', modules: { discovery: { fields: { summary: 'Updated' } } } },
      { gantryClient }
    )

    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.deepEqual(payload.saved, ['discovery'])
  } finally {
    fetch.restore()
  }
})

test('update_instance_modules reports missing_workspace_pat and never calls PUT /api/instance/modules', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await updateInstanceModulesTool.handler(
      { slug: 'ado-instance', modules: { discovery: { fields: {} } } },
      { gantryClient }
    )
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/modules'), false)
  } finally {
    fetch.restore()
  }
})

test('update_instance_modules surfaces a validation 400 for an unknown module id', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: null, scope: null } }
    if (url.pathname === '/api/instance/modules' && method === 'PUT') {
      return { status: 400, body: { error: 'Definition "d1" has no module(s): bogus' } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await updateInstanceModulesTool.handler({ slug: 'my-instance', modules: { bogus: {} } }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /400/)
    assert.match(payload.detail.error, /bogus/)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// render_artefact
// ---------------------------------------------------------------------------

test('render_artefact rejects a call with no artefactId without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await renderArtefactTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /artefactId/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('render_artefact renders a local instance\'s artefact and returns the delivered document', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance/render/hld' && method === 'POST') {
      assert.equal(url.searchParams.get('format'), 'md')
      return { status: 200, body: { artefact: 'hld', format: 'md', basename: 'hld.md', markdown: '# HLD', docxBase64: null } }
    }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await renderArtefactTool.handler({ slug: 'my-instance', artefactId: 'hld', format: 'md' }, { gantryClient })

    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.markdown, '# HLD')
  } finally {
    fetch.restore()
  }
})

test('render_artefact reports missing_workspace_pat and never calls the render route', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-2', scope: 'ws-2' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await renderArtefactTool.handler({ slug: 'ado-instance', artefactId: 'hld' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname.startsWith('/api/instance/render')), false)
  } finally {
    fetch.restore()
  }
})

test('render_artefact surfaces gantry serve\'s authentication_required 401', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'ws-3', scope: 'ws-3' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-3', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance/render/hld') return { status: 401, body: { error: 'authentication_required', message: 'rejected' } }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-3': 'stale-pat' } })
    const result = await renderArtefactTool.handler({ slug: 'ado-instance', artefactId: 'hld' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /401/)
    assert.equal(payload.detail.error, 'authentication_required')
  } finally {
    fetch.restore()
  }
})
