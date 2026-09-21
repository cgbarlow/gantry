import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient, resolveInstanceWorkspace } from '../src/gantryClient.js'
import { stubFetch } from './helpers/fakeFetch.js'

const BASE_URL = 'https://gantry.example.test'

function stubWorkspaceClassification({ providerBacked = [], serverHosted = [] } = {}) {
  return stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: providerBacked }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: serverHosted }
    return undefined
  })
}

test('request() attaches the mapped PAT as HTTP Basic auth for a Provider-backed workspace', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'github' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/instance') return { status: 200, body: { slug: 'ok' } }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const res = await client.request({ workspaceId: 'ws-1', path: '/api/instance' })

    assert.equal(res.ok, true)
    assert.deepEqual(res.body, { slug: 'ok' })

    const actionCall = fetch.calls.find((c) => c.url.pathname === '/api/instance')
    assert.equal(actionCall.headers.authorization, 'Basic ' + Buffer.from(':secret-pat').toString('base64'))
  } finally {
    fetch.restore()
  }
})

test('request() sends no Authorization header for a server-directory workspace', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    if (url.pathname === '/api/instance') return { status: 200, body: { slug: 'ok' } }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await client.request({ workspaceId: 'srv-1', path: '/api/instance' })

    assert.equal(res.ok, true)
    const actionCall = fetch.calls.find((c) => c.url.pathname === '/api/instance')
    assert.equal(actionCall.headers.authorization, undefined)
  } finally {
    fetch.restore()
  }
})

test('request() returns a structured error and never calls the target route when a Provider-backed workspace has no mapped PAT', async () => {
  const fetch = stubWorkspaceClassification({ providerBacked: [{ id: 'ws-2', provider: 'azure-devops' }] })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await client.request({ workspaceId: 'ws-2', path: '/api/instance/advance-stage', method: 'POST' })

    assert.equal(res.ok, false)
    assert.equal(res.credentialError.error, 'missing_workspace_pat')
    assert.equal(res.credentialError.workspace, 'ws-2')
    assert.equal(res.credentialError.envVar, 'GANTRY_WORKSPACE_PATS')
    assert.equal(
      fetch.calls.some((c) => c.url.pathname === '/api/instance/advance-stage'),
      false,
      'the mutating action must never be requested once the credential is known to be missing'
    )
  } finally {
    fetch.restore()
  }
})

test('request() returns a structured error for an unknown workspace id', async () => {
  const fetch = stubWorkspaceClassification()
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await client.request({ workspaceId: 'does-not-exist', path: '/api/instance' })

    assert.equal(res.ok, false)
    assert.equal(res.credentialError.error, 'workspace_not_found')
    assert.equal(res.credentialError.workspace, 'does-not-exist')
  } finally {
    fetch.restore()
  }
})

test('request() with no workspaceId performs no credential resolution at all', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await client.request({ path: '/api/workspaces' })

    assert.equal(res.ok, true)
    assert.equal(fetch.calls.length, 1)
    assert.equal(fetch.calls[0].headers.authorization, undefined)
  } finally {
    fetch.restore()
  }
})

test('request() with patOverride attaches it directly, bypassing the workspace-PAT map', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/azure-devops/repo-check') return { status: 200, body: { found: true } }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await client.request({ path: '/api/azure-devops/repo-check', patOverride: 'wizard-pat' })

    assert.equal(res.ok, true)
    assert.equal(fetch.calls[0].headers.authorization, 'Basic ' + Buffer.from(':wizard-pat').toString('base64'))
    // No classification calls at all — patOverride skips resolveCredential entirely.
    assert.equal(fetch.calls.length, 1)
  } finally {
    fetch.restore()
  }
})

test('request() caches workspace classification across calls within the TTL', async () => {
  const fetch = stubWorkspaceClassification({ providerBacked: [{ id: 'ws-1' }] })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'p' } })
    await client.request({ workspaceId: 'ws-1', path: '/api/a' }).catch(() => {})
    await client.request({ workspaceId: 'ws-1', path: '/api/a' }).catch(() => {})

    const classificationCalls = fetch.calls.filter((c) => c.url.pathname === '/api/workspaces' || c.url.pathname === '/api/server-workspaces')
    assert.equal(classificationCalls.length, 2, 'one GET /api/workspaces + one GET /api/server-workspaces, only once')
  } finally {
    fetch.restore()
  }
})

test('resolveInstanceWorkspace forwards slug/scope/ref to GET /api/instance/workspace and returns its body', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') {
      assert.equal(url.searchParams.get('slug'), 'my-instance')
      assert.equal(url.searchParams.get('scope'), 'ws-scope')
      assert.equal(url.searchParams.get('ref'), 'w1i2')
      return { status: 200, body: { workspaceId: 'ws-1', scope: 'ws-scope' } }
    }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await resolveInstanceWorkspace({ gantryClient: client, slug: 'my-instance', scope: 'ws-scope', ref: 'w1i2' })

    assert.equal(res.ok, true)
    assert.deepEqual(res.body, { workspaceId: 'ws-1', scope: 'ws-scope' })
    // Unscoped lookup — no PAT resolution, no classification calls at all.
    assert.equal(fetch.calls.length, 1)
  } finally {
    fetch.restore()
  }
})

test('resolveInstanceWorkspace returns { workspaceId: null } for a local/unknown instance', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: null, scope: null } }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await resolveInstanceWorkspace({ gantryClient: client, slug: 'local-instance' })

    assert.equal(res.ok, true)
    assert.deepEqual(res.body, { workspaceId: null, scope: null })
  } finally {
    fetch.restore()
  }
})

test('resolveInstanceWorkspace surfaces an upstream error rather than throwing', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 400, body: { error: 'No instance slug given' } }
    return undefined
  })
  try {
    const client = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const res = await resolveInstanceWorkspace({ gantryClient: client })

    assert.equal(res.ok, false)
    assert.equal(res.status, 400)
  } finally {
    fetch.restore()
  }
})
