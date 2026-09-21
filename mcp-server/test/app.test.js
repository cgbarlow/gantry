import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../src/index.js'

const ACCESS_TOKEN = 'test-access-token'

// A fake `gantry serve` at the HTTP-client seam (docs/adr/0043) — injected as `fetchImpl` so it never
// touches the real global `fetch` the MCP client transport itself needs to reach our own test server.
function fakeGantryFetch(handler) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    calls.push({ url, method: init.method ?? 'GET' })
    const result = handler({ url, method: init.method ?? 'GET' })
    if (!result) throw new Error(`No fake gantry route for ${init.method ?? 'GET'} ${url.pathname}`)
    return new Response(result.body !== undefined ? JSON.stringify(result.body) : '', {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

async function withRunningApp({ fetchImpl }, fn) {
  const handleRequest = createApp({
    baseUrl: 'https://gantry.example.test',
    accessToken: ACCESS_TOKEN,
    workspacePats: {},
    fetchImpl,
  })
  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500).end(String(err))
    })
  })
  httpServer.listen(0)
  await once(httpServer, 'listening')
  const { port } = httpServer.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    httpServer.close()
    await once(httpServer, 'close')
  }
}

test('a real MCP client can list and call list_workspaces end-to-end over streamable HTTP', async () => {
  const fetchImpl = fakeGantryFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'github' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })

  await withRunningApp({ fetchImpl }, async (base) => {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      assert.ok(tools.some((t) => t.name === 'list_workspaces'))

      const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
      assert.equal(result.isError, undefined)
      const payload = JSON.parse(result.content[0].text)
      assert.deepEqual(payload.workspaces, [{ id: 'ws-1', provider: 'github', kind: 'provider-backed' }])
    } finally {
      await client.close()
    }
  })
})

test('a request without a valid bearer token is rejected before any tool runs', async () => {
  const fetchImpl = fakeGantryFetch(() => {
    throw new Error('gantry serve must never be called for an unauthorized request')
  })

  await withRunningApp({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'invalid_or_missing_access_token')
    assert.equal(fetchImpl.calls.length, 0)
  })
})
