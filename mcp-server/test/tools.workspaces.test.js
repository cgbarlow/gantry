import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/workspaces.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

const listWorkspacesTool = tools.find((t) => t.name === 'list_workspaces')

test('list_workspaces merges Provider-backed and server-directory workspaces, tagged by kind', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') {
      assert.equal(url.searchParams.get('archived'), null)
      return { status: 200, body: [{ id: 'ws-1', provider: 'github', location: { owner: 'a', repository: 'b' } }] }
    }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local', description: null }] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: 'https://gantry.example.test', workspacePats: {} })
    const result = await listWorkspacesTool.handler({}, { gantryClient })

    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.deepEqual(payload.workspaces, [
      { id: 'ws-1', provider: 'github', location: { owner: 'a', repository: 'b' }, kind: 'provider-backed' },
      { id: 'srv-1', name: 'Local', description: null, kind: 'server-directory' },
    ])
  } finally {
    fetch.restore()
  }
})

test('list_workspaces passes includeArchived through to GET /api/workspaces', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') {
      assert.equal(url.searchParams.get('archived'), '1')
      return { status: 200, body: [] }
    }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: 'https://gantry.example.test', workspacePats: {} })
    await listWorkspacesTool.handler({ includeArchived: true }, { gantryClient })
  } finally {
    fetch.restore()
  }
})

test('list_workspaces surfaces an upstream error rather than throwing', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 500, body: { error: 'boom' } }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: 'https://gantry.example.test', workspacePats: {} })
    const result = await listWorkspacesTool.handler({}, { gantryClient })

    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /500/)
  } finally {
    fetch.restore()
  }
})
