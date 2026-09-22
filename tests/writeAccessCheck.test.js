import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setPatForWorkspace, clearPatForWorkspace, hasCheckedWriteAccess, hasConfirmedWriteAccess, credentialStatusForWorkspace } from '../web/lib/credential.js'
import { basicAuthHeader } from './helpers/lifecycle.js'

// #126: `web/lib/writeAccess.js`'s `ensureWriteAccessChecked` — the one place the web client actually
// calls `GET /api/workspaces/:id/write-access` and remembers the answer. `credential.js` is imported
// statically (not cache-busted) so calls here are visible to `writeAccess.js`'s own static
// `import './credential.js'` — mirrors tests/apiFetchInstanceWorkspace.test.js's own convention for
// the same reason. `writeAccess.js` itself is re-imported fresh per test (cache-busted) to reset its
// private in-flight-request guard between tests.
async function freshWriteAccessModule() {
  return import(`../web/lib/writeAccess.js?t=${Math.random()}`)
}

test('ensureWriteAccessChecked: no credential stored for the workspace -> no request is made, nothing recorded', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    let called = false
    globalThis.fetch = async () => {
      called = true
      throw new Error('should not have been called')
    }
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    await ensureWriteAccessChecked('workspace-a')
    assert.equal(called, false)
    assert.equal(hasCheckedWriteAccess('workspace-a'), false)
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})

test('ensureWriteAccessChecked: a credential that can write -> records canWrite: true, using this workspace\'s own stored PAT', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    setPatForWorkspace('workspace-a', 'a-pat')
    let requestedUrl = null
    let authHeader = null
    globalThis.fetch = async (url, options) => {
      requestedUrl = String(url)
      authHeader = new Headers(options?.headers).get('Authorization')
      return new Response(JSON.stringify({ canWrite: true }), { status: 200 })
    }
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    await ensureWriteAccessChecked('workspace-a')

    assert.equal(requestedUrl, '/api/workspaces/workspace-a/write-access')
    assert.equal(authHeader, basicAuthHeader('a-pat'))
    assert.equal(hasCheckedWriteAccess('workspace-a'), true)
    assert.equal(hasConfirmedWriteAccess('workspace-a'), true)
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})

test('ensureWriteAccessChecked: a credential that can only read -> records canWrite: false, never treated as a rejection', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    setPatForWorkspace('workspace-a', 'read-only-pat')
    globalThis.fetch = async () => new Response(JSON.stringify({ canWrite: false }), { status: 200 })
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    await ensureWriteAccessChecked('workspace-a')

    assert.equal(hasCheckedWriteAccess('workspace-a'), true)
    assert.equal(hasConfirmedWriteAccess('workspace-a'), false)
    assert.equal(credentialStatusForWorkspace('workspace-a'), 'set')
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})

test('ensureWriteAccessChecked: a rejected credential marks it rejected, records nothing, and never throws', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    setPatForWorkspace('workspace-a', 'bad-pat')
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'authentication_required', credentialStatus: 'rejected', message: 'GitHub rejected this PAT' }), { status: 401 })
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    await ensureWriteAccessChecked('workspace-a')

    assert.equal(credentialStatusForWorkspace('workspace-a'), 'rejected')
    assert.equal(hasCheckedWriteAccess('workspace-a'), false)
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})

test('ensureWriteAccessChecked: already checked -> no second request', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    setPatForWorkspace('workspace-a', 'a-pat')
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      return new Response(JSON.stringify({ canWrite: true }), { status: 200 })
    }
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    await ensureWriteAccessChecked('workspace-a')
    await ensureWriteAccessChecked('workspace-a')

    assert.equal(callCount, 1)
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})

test('ensureWriteAccessChecked: concurrent calls for the same workspace share one in-flight request', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    setPatForWorkspace('workspace-a', 'a-pat')
    let callCount = 0
    let resolveFetch
    globalThis.fetch = () => {
      callCount++
      return new Promise((resolve) => {
        resolveFetch = () => resolve(new Response(JSON.stringify({ canWrite: true }), { status: 200 }))
      })
    }
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    const first = ensureWriteAccessChecked('workspace-a')
    const second = ensureWriteAccessChecked('workspace-a')
    resolveFetch()
    await Promise.all([first, second])

    assert.equal(callCount, 1)
    assert.equal(hasConfirmedWriteAccess('workspace-a'), true)
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})

test('ensureWriteAccessChecked: a network failure leaves the workspace unchecked, retried on the next call', async () => {
  const originalFetch = globalThis.fetch
  clearPatForWorkspace('workspace-a')
  try {
    setPatForWorkspace('workspace-a', 'a-pat')
    let attempt = 0
    globalThis.fetch = async () => {
      attempt++
      if (attempt === 1) throw new Error('simulated network failure')
      return new Response(JSON.stringify({ canWrite: true }), { status: 200 })
    }
    const { ensureWriteAccessChecked } = await freshWriteAccessModule()
    await ensureWriteAccessChecked('workspace-a')
    assert.equal(hasCheckedWriteAccess('workspace-a'), false)

    await ensureWriteAccessChecked('workspace-a')
    assert.equal(hasConfirmedWriteAccess('workspace-a'), true)
    assert.equal(attempt, 2)
  } finally {
    globalThis.fetch = originalFetch
    clearPatForWorkspace('workspace-a')
  }
})
