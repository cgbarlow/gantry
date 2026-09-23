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

// #137 amended this from "a failed request is not retried" to the distinction that was missing: a
// failure the server could recover from IS retried (bounded — see the budget test below), and what
// must never happen is a rejection reaching the caller. Latching every failure alike is precisely
// what made a redeploy look like a broken credential, so the original assertion encoded the bug.
test('loadWorkspaceScopedInstances: a failed request never rejects its caller, and is retried but bounded', async () => {
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
        // Retried rather than latched, but still bounded — never an unchecked loop.
        assert.ok(calls.length >= 2, 'a network failure says nothing about the workspace; try again')
        assert.ok(calls.length <= 4, `retries must stay bounded, saw ${calls.length}`)
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

// ---------------------------------------------------------------------------
// #137: a failure that says nothing about whether the workspace has designs — the server still coming
// up after a redeploy, above all — must not be latched the way a real answer is. Before this, every
// failure mode was treated identically to a successful empty listing, so one unlucky mount-time
// request left the workspace blank for the whole page session. The only escape was
// `resetWorkspaceDiscovery`, which fires only when a credential is entered, so re-typing a perfectly
// good PAT appeared to fix it — the credential was never the problem.
// ---------------------------------------------------------------------------

/** Fails the first `n` requests with `status`, then serves rows — a container finishing its boot. */
function failThenSucceed(n, status) {
  let seen = 0
  return async () => {
    seen += 1
    if (seen <= n) return new Response('', { status })
    return new Response(JSON.stringify(ROWS), { status: 200 })
  }
}

for (const status of [404, 500, 503]) {
  test(`loadWorkspaceScopedInstances: a ${status} is not latched — the workspace is re-armed and asks to be retried`, async () => {
    clearPatForWorkspace('ws-a')
    setPatForWorkspace('ws-a', 'pat-a')
    try {
      await withFetch(failThenSucceed(1, status), async (calls) => {
        const { loadWorkspaceScopedInstances, setWorkspaceDiscoveryRetryHandler } = await freshModule()
        let retryAsked = null
        setWorkspaceDiscoveryRetryHandler((id) => {
          retryAsked = id
        })

        const first = await loadWorkspaceScopedInstances([], [workspace('ws-a')])
        assert.deepEqual(first, [], `a ${status} contributes no rows on the failing attempt`)

        // The retry is scheduled on a timer; the load itself must be immediately re-armed, which is
        // what makes the next dashboard load (or the scheduled retry) genuinely re-request.
        const second = await loadWorkspaceScopedInstances([], [workspace('ws-a')])
        assert.deepEqual(second, ROWS, `a ${status} must be retried, not treated as "no designs"`)
        assert.equal(calls.length, 2)

        await new Promise((resolve) => setTimeout(resolve, 1200))
        assert.equal(retryAsked, 'ws-a', 'the dashboard is asked to re-run its own load')
        setWorkspaceDiscoveryRetryHandler(null)
      })
    } finally {
      clearPatForWorkspace('ws-a')
    }
  })
}

test('loadWorkspaceScopedInstances: a thrown fetch (offline) is transient too, not a verdict', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  let seen = 0
  const offlineThenUp = async () => {
    seen += 1
    if (seen === 1) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(ROWS), { status: 200 })
  }
  try {
    await withFetch(offlineThenUp, async () => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      assert.deepEqual(await loadWorkspaceScopedInstances([], [workspace('ws-a')]), [])
      assert.deepEqual(await loadWorkspaceScopedInstances([], [workspace('ws-a')]), ROWS)
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a rejected credential IS latched — retrying would re-send a refused credential', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  const rejected = async () =>
    new Response(JSON.stringify({ error: 'authentication_required', credentialStatus: 'rejected' }), { status: 401 })
  try {
    await withFetch(rejected, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      assert.equal(calls.length, 1, 'a refused credential must not be sent again')
      assert.equal(credentialStatusForWorkspace('ws-a'), 'rejected')
    })
  } finally {
    clearPatForWorkspace('ws-a')
    markCredentialRejected('ws-a')
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: a genuinely empty workspace IS latched — 200 with no rows is a real answer', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  const empty = async () => new Response('[]', { status: 200 })
  try {
    await withFetch(empty, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      assert.equal(calls.length, 1, 'an empty-but-successful listing is not a failure to retry')
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})

test('loadWorkspaceScopedInstances: transient retries are bounded — an unreachable server is not asked forever', async () => {
  clearPatForWorkspace('ws-a')
  setPatForWorkspace('ws-a', 'pat-a')
  const alwaysDown = async () => new Response('', { status: 503 })
  try {
    await withFetch(alwaysDown, async (calls) => {
      const { loadWorkspaceScopedInstances } = await freshModule()
      // Far more loads than the budget allows; the request count must stop climbing.
      for (let i = 0; i < 10; i += 1) await loadWorkspaceScopedInstances([], [workspace('ws-a')])
      assert.ok(calls.length <= 4, `expected the retry budget to cap requests, saw ${calls.length}`)
      assert.ok(calls.length > 1, 'but it must genuinely retry at least once')
    })
  } finally {
    clearPatForWorkspace('ws-a')
  }
})
