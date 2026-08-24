import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setPat, clearPat, setWorkspacePatOverride, clearWorkspacePatOverride } from '../web/lib/credential.js'

// `apiFetchForInstance`'s workspace-id-for-slug cache (#104, web/lib/apiFetch.js) — a review pass on this ticket flagged the original version as caching *every* lookup outcome, including a failed one, permanently for the page's life. This exercises the fix directly: a stubbed global `fetch` simulates a transient failure on the first lookup, then a real answer on the second, proving the failure was not cached and a later call still applies the workspace's PAT override.
//
// `credential.js` is imported as a plain (non-cache-busted) static import here deliberately — it's the same singleton module instance `web/lib/apiFetch.js`'s own internal `import './credential.js'` resolves to, so calls to `setPat`/`setWorkspacePatOverride` here are visible to `apiFetch.js` without needing to reach into its internals. Only `apiFetch.js` itself is re-imported fresh per test (via a cache-busting query string), to reset its own private `workspaceIdBySlug` cache between tests.
async function freshApiFetchModule() {
  return import(`../web/lib/apiFetch.js?t=${Math.random()}`)
}

function basicAuthHeader(value) {
  return `Basic ${Buffer.from(`:${value}`, 'utf8').toString('base64')}`
}

test('a failed workspace-id lookup is not cached — a later successful lookup still applies that workspace\'s PAT override', async () => {
  const originalFetch = globalThis.fetch
  clearPat()
  clearWorkspacePatOverride('workspace-a')
  try {
    setPat('global-default-pat')
    setWorkspacePatOverride('workspace-a', 'override-pat')

    let workspaceLookupCallCount = 0
    let failLookup = true
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url)
      if (urlStr.startsWith('/api/instance/workspace')) {
        workspaceLookupCallCount++
        if (failLookup) throw new Error('simulated network failure')
        return new Response(JSON.stringify({ workspaceId: 'workspace-a' }), { status: 200 })
      }
      // The "real" instance-data request — reports back whatever Authorization header apiFetch actually attached, so the test can assert on which PAT was used without a real server.
      const headers = new Headers(options?.headers)
      return new Response(JSON.stringify({ authorization: headers.get('Authorization') }), { status: 200 })
    }

    const { apiFetchForInstance } = await freshApiFetchModule()

    // First call: the workspace lookup fails, so this falls back to the global default rather than the workspace's override.
    const res1 = await apiFetchForInstance('my-slug', '/api/instance?slug=my-slug')
    const body1 = await res1.json()
    assert.equal(body1.authorization, basicAuthHeader('global-default-pat'))
    assert.equal(workspaceLookupCallCount, 1)

    // Second call: the lookup now succeeds. If the earlier failure had been cached, this would still resolve to "no workspace" and reuse the global default — asserting on the override here is the whole point.
    failLookup = false
    const res2 = await apiFetchForInstance('my-slug', '/api/instance?slug=my-slug')
    const body2 = await res2.json()
    assert.equal(body2.authorization, basicAuthHeader('override-pat'))
    assert.equal(workspaceLookupCallCount, 2)

    // Third call: the now-successful resolution *is* cached — no further lookup request is made.
    const res3 = await apiFetchForInstance('my-slug', '/api/instance?slug=my-slug')
    const body3 = await res3.json()
    assert.equal(body3.authorization, basicAuthHeader('override-pat'))
    assert.equal(workspaceLookupCallCount, 2)
  } finally {
    globalThis.fetch = originalFetch
    clearPat()
    clearWorkspacePatOverride('workspace-a')
  }
})

test('a malformed workspace-lookup response body is not cached either', async () => {
  const originalFetch = globalThis.fetch
  clearPat()
  clearWorkspacePatOverride('workspace-a')
  try {
    setPat('global-default-pat')
    setWorkspacePatOverride('workspace-a', 'override-pat')

    let workspaceLookupCallCount = 0
    let returnMalformedBody = true
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url)
      if (urlStr.startsWith('/api/instance/workspace')) {
        workspaceLookupCallCount++
        if (returnMalformedBody) return new Response('not json', { status: 200 })
        return new Response(JSON.stringify({ workspaceId: 'workspace-a' }), { status: 200 })
      }
      const headers = new Headers(options?.headers)
      return new Response(JSON.stringify({ authorization: headers.get('Authorization') }), { status: 200 })
    }

    const { apiFetchForInstance } = await freshApiFetchModule()

    const res1 = await apiFetchForInstance('my-slug', '/api/instance?slug=my-slug')
    assert.equal((await res1.json()).authorization, basicAuthHeader('global-default-pat'))
    assert.equal(workspaceLookupCallCount, 1)

    returnMalformedBody = false
    const res2 = await apiFetchForInstance('my-slug', '/api/instance?slug=my-slug')
    assert.equal((await res2.json()).authorization, basicAuthHeader('override-pat'))
    assert.equal(workspaceLookupCallCount, 2)
  } finally {
    globalThis.fetch = originalFetch
    clearPat()
    clearWorkspacePatOverride('workspace-a')
  }
})

test('a genuinely local instance (a well-formed { workspaceId: null } response) is cached, and does not re-query on later calls', async () => {
  const originalFetch = globalThis.fetch
  clearPat()
  try {
    setPat('global-default-pat')

    let workspaceLookupCallCount = 0
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url)
      if (urlStr.startsWith('/api/instance/workspace')) {
        workspaceLookupCallCount++
        return new Response(JSON.stringify({ workspaceId: null }), { status: 200 })
      }
      const headers = new Headers(options?.headers)
      return new Response(JSON.stringify({ authorization: headers.get('Authorization') }), { status: 200 })
    }

    const { apiFetchForInstance } = await freshApiFetchModule()

    await apiFetchForInstance('local-slug', '/api/instance?slug=local-slug')
    await apiFetchForInstance('local-slug', '/api/instance?slug=local-slug')
    assert.equal(workspaceLookupCallCount, 1)
  } finally {
    globalThis.fetch = originalFetch
    clearPat()
  }
})
