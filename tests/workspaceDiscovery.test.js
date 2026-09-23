import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setPatForWorkspace,
  clearPatForWorkspace,
  markCredentialRejected,
  credentialStatusForWorkspace,
} from '../web/lib/credential.js'
import { basicAuthHeader } from './helpers/lifecycle.js'

// #131 (parent #109, docs/adr/0047): `web/lib/workspaceDiscovery.js` — the one place the web client
// issues a credentialed, workspace-scoped listing request (`GET /api/workspaces/:id/instances`), and
// therefore the one place the bounds on how often it may do so live.
//
// `credential.js` is imported statically (not cache-busted) so calls here are visible to
// `workspaceDiscovery.js`'s own static import of it — the same convention tests/writeAccessCheck.test.js
// follows, for the same reason. `workspaceDiscovery.js` itself is re-imported fresh per test so its
// private per-page-session attempt/row caches reset between them.
async function freshModule() {
  return import(`../web/lib/workspaceDiscovery.js?t=${Math.random()}`)
}

function workspace(id, provider = 'github') {
  return { id, provider, location: { owner: 'octocat', repository: 'r' } }
}

/** Installs a fetch stub recording every request, restoring the real one afterwards. */
async function withFetch(handler, fn) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), auth: new Headers(options?.headers).get('Authorization') })
    return handler(String(url), options)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const ROWS = [{ slug: 'found-one', workspace: { id: 'ws-a' } }]
const okRows = async () => new Response(JSON.stringify(ROWS), { status: 200 })

test('loadWorkspaceScopedInstances: a workspace with a stored credential and nothing shown for it gets its own listing, with its own PAT', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    await withFetch(okRows, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      const rows = await loadWorkspaceScopedInstances([], [workspace('ws-a')])

      assert.deepEqual(rows, ROWS)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, '/api/workspaces/ws-a/instances')
      assert.equal(calls[0].auth, basicAuthHeader('pat-a'))
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a workspace the browser holds no credential for is left entirely alone — no request at all', async () => {
  clearPatForWorkspace('ws-a')
  clearPatForWorkspace('ws-b')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    await withFetch(okRows, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      await loadWorkspaceScopedInstances([], [workspace('ws-a'), workspace('ws-b')])

      // Only ws-a's own URL was ever requested — ws-b's is never built, so ws-a's credential can
      // never travel to it either.
      assert.deepEqual(calls.map((c) => c.url), ['/api/workspaces/ws-a/instances'])
      assert.deepEqual(calls.map((c) => c.auth), [basicAuthHeader('pat-a')])
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a credential is only ever sent to the URL naming its own workspace', async () => {
  clearPatForWorkspace('ws-a')
  clearPatForWorkspace('ws-b')
  setPatForWorkspace('ws-a', 'pat-a')
  setPatForWorkspace('ws-b', 'pat-b')
  try {
    await withFetch(okRows, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      await loadWorkspaceScopedInstances([], [workspace('ws-a'), workspace('ws-b')])

      assert.equal(calls.length, 2)
      const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.auth]))
      assert.equal(byUrl['/api/workspaces/ws-a/instances'], basicAuthHeader('pat-a'))
      assert.equal(byUrl['/api/workspaces/ws-b/instances'], basicAuthHeader('pat-b'))
    })
  } finally {
    clearPatForWorkspace('ws-a')
    clearPatForWorkspace('ws-b')
  }
})

test('loadWorkspaceScopedInstances: a workspace the unscoped listing already has rows for is never asked for again', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    await withFetch(okRows, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      const rows = await loadWorkspaceScopedInstances([{ slug: 'x', workspace: { id: 'ws-a' } }], [workspace('ws-a')])
      assert.deepEqual(rows, [])
      assert.equal(calls.length, 0)
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a second load reuses the rows already fetched — one request per workspace per page-session', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    await withFetch(okRows, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      const first = await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      const second = await loadWorkspaceScopedInstances([], [workspace('ws-a')])

      assert.equal(calls.length, 1)
      // The rows survive a reload of the dashboard listing rather than vanishing from it.
      assert.deepEqual(second, first)
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: concurrent calls share one in-flight request rather than issuing two', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    await withFetch(
      async () => {
        await gate
        return new Response(JSON.stringify(ROWS), { status: 200 })
      },
      async (calls) => {
        const { loadWorkspaceScopedInstances } = await freshModule()
        const both = Promise.all([
          loadWorkspaceScopedInstances([], [workspace('ws-a')]),
          loadWorkspaceScopedInstances([], [workspace('ws-a')]),
        ])
        release()
        const [first, second] = await both
        assert.equal(calls.length, 1)
        assert.deepEqual(first, ROWS)
        assert.deepEqual(second, ROWS)
      }
    )
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a rejected credential marks the existing rejected state and is not retried', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    const rejected = async () =>
      new Response(JSON.stringify({ error: 'authentication_required', credentialRejected: true, credentialStatus: 'rejected' }), {
        status: 401,
      })
    await withFetch(rejected, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      const rows = await loadWorkspaceScopedInstances([], [workspace('ws-a')])

      assert.deepEqual(rows, [])
      assert.equal(calls.length, 1)
      // The EXISTING rejected-credential state, not a bespoke error path — Settings reports
      // "rejected" from exactly this.
      assert.equal(credentialStatusForWorkspace('ws-a'), 'rejected')

      // ...and no retry loop: a second load issues nothing further, both because this workspace was
      // already attempted and because its credential is now known-rejected.
      await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      assert.equal(calls.length, 1)
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a credential already known to be rejected is never sent again, even on a fresh page-session', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  markCredentialRejected('ws-a')
  try {
    await withFetch(okRows, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      const rows = await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      assert.deepEqual(rows, [])
      assert.equal(calls.length, 0)
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a failed request is not retried, and never rejects its caller', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  try {
    await withFetch(
      async () => {
        throw new Error('network down')
      },
      async (calls) => {
        const { loadWorkspaceScopedInstances } = await freshModule()
        assert.deepEqual(await loadWorkspaceScopedInstances([], [workspace('ws-a')]), [])
        assert.deepEqual(await loadWorkspaceScopedInstances([], [workspace('ws-a')]), [])
        assert.equal(calls.length, 1)
      }
    )
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('resetWorkspaceDiscovery re-arms a workspace whose credential has just been replaced', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'bad-pat')
  try {
    let status = 401
    const handler = async () =>
      status === 401
        ? new Response(JSON.stringify({ error: 'authentication_required', credentialStatus: 'rejected' }), { status: 401 })
        : new Response(JSON.stringify(ROWS), { status: 200 })

    await withFetch(handler, async (calls) => {
      const { loadWorkspaceScopedInstances, resetWorkspaceDiscovery } = await freshModule()
      assert.deepEqual(await loadWorkspaceScopedInstances([], [workspace('ws-a')]), [])
      assert.equal(calls.length, 1)

      // A new credential, entered from Settings, is genuinely something new to try.
      status = 200
      setPatForWorkspace('ws-a', 'good-pat')
      resetWorkspaceDiscovery('ws-a')

      assert.deepEqual(await loadWorkspaceScopedInstances([], [workspace('ws-a')]), ROWS)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].auth, basicAuthHeader('good-pat'))
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: nothing to do issues no request at all — an all-local dashboard costs nothing', async () => {
  await withFetch(okRows, async (calls) => {
    const { loadWorkspaceScopedInstances } = await freshModule()
    assert.deepEqual(await loadWorkspaceScopedInstances([{ slug: 'local-one', workspace: null }], []), [])
    assert.equal(calls.length, 0)
  })
})
