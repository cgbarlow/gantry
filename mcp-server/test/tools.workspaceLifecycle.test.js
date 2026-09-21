import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/workspaceLifecycle.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

const checkRepoTool = tools.find((t) => t.name === 'check_repo')
const createWorkspaceTool = tools.find((t) => t.name === 'create_workspace')
const createInstanceTool = tools.find((t) => t.name === 'create_instance')
const archiveWorkspaceTool = tools.find((t) => t.name === 'archive_workspace')
const restoreWorkspaceTool = tools.find((t) => t.name === 'restore_workspace')

function client(workspacePats = {}) {
  return createGantryClient({ baseUrl: 'https://gantry.example.test', workspacePats })
}

function basicAuthFor(pat) {
  return 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64')
}

// ---- check_repo ----------------------------------------------------------

test('check_repo validates an azure-devops location with the supplied PAT, creating nothing', async () => {
  const fetch = stubFetch(({ url, headers }) => {
    if (url.pathname === '/api/azure-devops/repo-check') {
      assert.equal(url.searchParams.get('organization'), 'acme')
      assert.equal(url.searchParams.get('project'), 'widgets')
      assert.equal(url.searchParams.get('repository'), 'repo1')
      assert.equal(headers.authorization, basicAuthFor('my-pat'))
      return { status: 200, body: { result: 'empty' } }
    }
    return undefined
  })
  try {
    const result = await checkRepoTool.handler(
      { provider: 'azure-devops', pat: 'my-pat', organization: 'acme', project: 'widgets', repository: 'repo1' },
      { gantryClient: client() }
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { result: 'empty' })
  } finally {
    fetch.restore()
  }
})

test('check_repo reports missing required fields without ever calling gantry serve', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const result = await checkRepoTool.handler({ provider: 'github', pat: 'x', repository: 'repo1' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /repoOwner/)
  } finally {
    fetch.restore()
  }
})

test('check_repo surfaces an upstream rejection (bad PAT) rather than throwing', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/github/repo-check') return { status: 401, body: { error: 'authentication_required' } }
    return undefined
  })
  try {
    const result = await checkRepoTool.handler({ provider: 'github', pat: 'bad', repoOwner: 'acme', repository: 'repo1' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /401/)
  } finally {
    fetch.restore()
  }
})

// ---- create_workspace -----------------------------------------------------

test('create_workspace registers a Provider-backed workspace using the supplied PAT', async () => {
  const fetch = stubFetch(({ url, method, headers, body }) => {
    if (url.pathname === '/api/workspaces' && method === 'POST') {
      assert.equal(headers.authorization, basicAuthFor('the-pat'))
      const parsed = JSON.parse(body)
      assert.deepEqual(parsed, { provider: 'github', location: { owner: 'acme', repository: 'repo1' }, owner: 'Jane' })
      return { status: 201, body: { id: 'ws-1', provider: 'github', location: parsed.location, owner: 'Jane' } }
    }
    return undefined
  })
  try {
    const result = await createWorkspaceTool.handler(
      { provider: 'github', pat: 'the-pat', repoOwner: 'acme', repository: 'repo1', owner: 'Jane' },
      { gantryClient: client() }
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'ws-1', provider: 'github', location: { owner: 'acme', repository: 'repo1' }, owner: 'Jane' })
  } finally {
    fetch.restore()
  }
})

test('create_workspace requires a pat for a Provider-backed workspace, without calling gantry serve', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const result = await createWorkspaceTool.handler({ provider: 'azure-devops', organization: 'a', project: 'b', repository: 'c' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /pat is required/)
  } finally {
    fetch.restore()
  }
})

test('create_workspace surfaces an upstream error (e.g. a rejected PAT) rather than throwing', async () => {
  const fetch = stubFetch(({ url, method, headers }) => {
    if (url.pathname === '/api/workspaces' && method === 'POST') {
      assert.equal(headers.authorization, basicAuthFor('bad'))
      return { status: 401, body: { error: 'authentication_required' } }
    }
    return undefined
  })
  try {
    const result = await createWorkspaceTool.handler(
      { provider: 'azure-devops', pat: 'bad', organization: 'a', project: 'b', repository: 'c' },
      { gantryClient: client() }
    )
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /401/)
  } finally {
    fetch.restore()
  }
})

test('create_workspace looks up the existing server-directory workspace, no PAT required', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'default', name: 'default' }] }
    return undefined
  })
  try {
    const result = await createWorkspaceTool.handler({}, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'default', name: 'default', kind: 'server-directory' })
  } finally {
    fetch.restore()
  }
})

test('create_workspace reports clearly when the server-directory workspace does not exist yet', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const result = await createWorkspaceTool.handler({}, { gantryClient: client() })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'no_server_directory_workspace')
  } finally {
    fetch.restore()
  }
})

// ---- create_instance --------------------------------------------------------

function stubClassification({ providerWorkspaces = [], serverWorkspaces = [] } = {}) {
  return ({ url }) => {
    if (url.pathname === '/api/workspaces') {
      assert.equal(url.searchParams.get('archived'), '1')
      return { status: 200, body: providerWorkspaces }
    }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: serverWorkspaces }
    return undefined
  }
}

test('create_instance creates a first instance against a newly-created Provider-backed workspace', async () => {
  const ws = { id: 'ws-1', provider: 'azure-devops', location: { organization: 'acme', project: 'widgets', repository: 'repo1' } }
  const fetch = stubFetch((call) => {
    const base = stubClassification({ providerWorkspaces: [ws] })(call)
    if (base) return base
    const { url, method, headers, body } = call
    if (url.pathname === '/api/instances' && method === 'POST') {
      assert.equal(headers.authorization, basicAuthFor('pat-1'))
      const parsed = JSON.parse(body)
      assert.deepEqual(parsed, { definition: 'design', slug: 'my-instance', assignee: 'alice', azureDevOps: { organization: 'acme', project: 'widgets', repository: 'repo1' } })
      return { status: 201, body: { slug: 'my-instance', definition: 'design' } }
    }
    return undefined
  })
  try {
    const result = await createInstanceTool.handler(
      { workspaceId: 'ws-1', definition: 'design', slug: 'my-instance', assignee: 'alice' },
      { gantryClient: client({ 'ws-1': 'pat-1' }) }
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { slug: 'my-instance', definition: 'design' })
  } finally {
    fetch.restore()
  }
})

test('create_instance creates a first instance against a server-directory workspace with no credential', async () => {
  const ws = { id: 'default', name: 'default' }
  const fetch = stubFetch((call) => {
    const base = stubClassification({ serverWorkspaces: [ws] })(call)
    if (base) return base
    const { url, method, headers, body } = call
    if (url.pathname === '/api/instances' && method === 'POST') {
      assert.equal(headers.authorization, undefined)
      const parsed = JSON.parse(body)
      assert.deepEqual(parsed, { definition: 'design', slug: 'my-instance' })
      return { status: 201, body: { slug: 'my-instance', definition: 'design' } }
    }
    return undefined
  })
  try {
    const result = await createInstanceTool.handler({ workspaceId: 'default', definition: 'design', slug: 'my-instance' }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
  } finally {
    fetch.restore()
  }
})

test('create_instance reports missing_workspace_pat rather than calling POST /api/instances', async () => {
  const ws = { id: 'ws-1', provider: 'azure-devops', location: { organization: 'acme', project: 'widgets', repository: 'repo1' } }
  const fetch = stubFetch((call) => {
    const base = stubClassification({ providerWorkspaces: [ws] })(call)
    if (base) return base
    if (call.url.pathname === '/api/instances') throw new Error('should not be called without a PAT')
    return undefined
  })
  try {
    const result = await createInstanceTool.handler({ workspaceId: 'ws-1', definition: 'design', slug: 'my-instance' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(payload.workspace, 'ws-1')
  } finally {
    fetch.restore()
  }
})

test('create_instance reports an unknown workspace id without calling POST /api/instances', async () => {
  const fetch = stubFetch((call) => {
    const base = stubClassification()(call)
    if (base) return base
    if (call.url.pathname === '/api/instances') throw new Error('should not be called for an unknown workspace')
    return undefined
  })
  try {
    const result = await createInstanceTool.handler({ workspaceId: 'ghost', definition: 'design', slug: 'my-instance' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).error, 'workspace_not_found')
  } finally {
    fetch.restore()
  }
})

test('create_instance reports gitlab workspaces as not-yet-supported rather than creating a local instance', async () => {
  const ws = { id: 'ws-2', provider: 'gitlab', location: { namespace: 'acme', repository: 'repo1' } }
  const fetch = stubFetch((call) => {
    const base = stubClassification({ providerWorkspaces: [ws] })(call)
    if (base) return base
    if (call.url.pathname === '/api/instances') throw new Error('should not be called for an unsupported provider')
    return undefined
  })
  try {
    const result = await createInstanceTool.handler({ workspaceId: 'ws-2', definition: 'design', slug: 'my-instance' }, { gantryClient: client({ 'ws-2': 'pat' }) })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /gitlab/)
  } finally {
    fetch.restore()
  }
})

// ---- archive_workspace / restore_workspace ---------------------------------

test('archive_workspace archives without ever resolving a credential', async () => {
  const fetch = stubFetch(({ url, method, headers, body }) => {
    if (url.pathname === '/api/workspace/archive' && method === 'POST') {
      assert.equal(headers.authorization, undefined)
      assert.deepEqual(JSON.parse(body), { workspaceId: 'ws-1' })
      return { status: 200, body: { id: 'ws-1', archived: true } }
    }
    return undefined
  })
  try {
    const result = await archiveWorkspaceTool.handler({ workspaceId: 'ws-1' }, { gantryClient: client({ 'ws-1': 'unused-pat' }) })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'ws-1', archived: true })
    assert.equal(fetch.calls.length, 1, 'archive_workspace must not make any classification/credential calls')
  } finally {
    fetch.restore()
  }
})

test('archive_workspace surfaces the 409 "active instance" block as an error', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspace/archive') {
      return { status: 409, body: { error: 'Cannot archive workspace "ws-1" — it still has 1 active instance (foo). Archive or restore those first.' } }
    }
    return undefined
  })
  try {
    const result = await archiveWorkspaceTool.handler({ workspaceId: 'ws-1' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).detail.error, /active instance/)
  } finally {
    fetch.restore()
  }
})

test('restore_workspace round-trips a workspace back from archived, without resolving a credential', async () => {
  const fetch = stubFetch(({ url, method, headers, body }) => {
    if (url.pathname === '/api/workspace/restore' && method === 'POST') {
      assert.equal(headers.authorization, undefined)
      assert.deepEqual(JSON.parse(body), { workspaceId: 'ws-1' })
      return { status: 200, body: { id: 'ws-1', archived: false } }
    }
    return undefined
  })
  try {
    const result = await restoreWorkspaceTool.handler({ workspaceId: 'ws-1' }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'ws-1', archived: false })
    assert.equal(fetch.calls.length, 1, 'restore_workspace must not make any classification/credential calls')
  } finally {
    fetch.restore()
  }
})

test('restore_workspace surfaces an unknown workspace 404 as an error', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspace/restore') return { status: 404, body: { error: 'Unknown workspace "ghost"' } }
    return undefined
  })
  try {
    const result = await restoreWorkspaceTool.handler({ workspaceId: 'ghost' }, { gantryClient: client() })
    assert.equal(result.isError, true)
  } finally {
    fetch.restore()
  }
})
