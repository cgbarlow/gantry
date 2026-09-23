import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listRegisteredInstances, registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { createFakeGitHubServer, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withRunningServer, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #131 (parent #109, docs/adr/0047): `GET /api/workspaces/:workspaceId/instances` — one workspace's
// own instance listing, built with the credential THIS request carries for it.
//
// The bug it fixes, reproduced live at 0.8.0-beta: the dashboard's listing request (`GET
// /api/instances`) spans every workspace at once, so the browser has no single workspace whose
// credential it could attach and attaches none — and uncredentialed, the server can neither discover a
// Provider-backed workspace's instances (discovery needs a credential to attempt, #112) nor read them
// (each row needs one too). A credential entered in the browser could therefore never populate or show
// a Provider-backed workspace at all; only a deployment-held shared credential (#121) could. These
// tests pin both halves of the fix — discovery *and* the rows — plus the credential-scoping rule
// docs/adr/0038 exists to enforce.

const SEED_FILES = {
  '/gantry-workspace/found-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/stray-folder/notes.md': '# not an instance\n',
}

/**
 * Starts a `createFakeGitHubServer` on an ephemeral port and hands back its base URL alongside two
 * counters: every request it received at all (`requestCount`), and just the "list gantry-workspace/"
 * requests a discovery pass issues (`listFolderCalls`). The first is what proves a credential entered
 * for one workspace never even reaches another workspace's repo; the second is what proves an
 * already-discovered workspace is never re-listed.
 */
function startFakeGitHub(opts) {
  const server = createFakeGitHubServer(opts)
  const repoBasePath = `/repos/${opts.owner}/${opts.repository}`
  let requestCount = 0
  let listFolderCalls = 0
  const authHeadersSeen = []
  server.on('request', (req) => {
    requestCount++
    const auth = req.headers.authorization
    if (auth) authHeadersSeen.push(auth)
    if (req.method !== 'GET') return
    if (new URL(req.url, 'http://fake-github.invalid').pathname === `${repoBasePath}/contents/gantry-workspace`) {
      listFolderCalls++
    }
  })
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({
        baseUrl: `http://localhost:${server.address().port}`,
        requestCount: () => requestCount,
        listFolderCalls: () => listFolderCalls,
        authHeadersSeen: () => authHeadersSeen,
        close: () => server.close(),
      })
    })
  })
}

async function withFakeGitHub(opts, fn) {
  const fake = await startFakeGitHub(opts)
  try {
    return await fn(fake)
  } finally {
    fake.close()
  }
}

function githubWorkspace(instancesDir, { owner, repository, baseUrl }) {
  return registerWorkspace({ provider: 'github', location: { owner, repository, baseUrl } }, { instancesDir })
}

test('GET /api/workspaces/:id/instances: a workspace with a credential and nothing registered ends up with its designs discovered AND listed', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (fake) => {
      const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })

      // The live symptom: nothing registered, so `GET /api/workspaces` reports the workspace as
      // having nothing in it and the unscoped listing can show nothing for it.
      assert.deepEqual(listRegisteredInstances({ instancesDir }), [])

      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
        const unscoped = await fetch(`${gantryBase}/api/instances`)
        assert.deepEqual(await unscoped.json(), [])

        const res = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
          headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        })
        assert.equal(res.status, 200)
        const rows = await res.json()
        // Listed — real rows, not merely "discovery happened". 'stray-folder' has no instance.yaml
        // and is never an instance.
        assert.deepEqual(rows.map((row) => row.slug), ['found-one'])
        assert.equal(rows[0].workspace.id, workspace.id)
        assert.equal(rows[0].definition, 'design')
        assert.equal(rows[0].stage, 'shape')

        // Discovered — the registry now carries the slug, so `GET /api/workspaces` stops reporting
        // this workspace as having nothing registered in it (#122's own signal).
        assert.deepEqual(listRegisteredInstances({ instancesDir }).map((entry) => entry.slug), ['found-one'])
        const workspaces = await (await fetch(`${gantryBase}/api/workspaces`)).json()
        assert.equal(workspaces.find((w) => w.id === workspace.id).hasRegisteredInstances, true)
      })
    })
  })
})

test('GET /api/workspaces/:id/instances: workspace A\'s credential is never sent to, or attempted against, workspace B\'s repo', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: 'pat-for-a', files: SEED_FILES }, async (fakeA) => {
      // B's repo would REJECT A's credential — it only accepts its own. Nothing below may ever give
      // it the chance to say so.
      await withFakeGitHub({ owner: 'owner-b', repository: 'repo-b', validPat: 'pat-for-b', files: SEED_FILES }, async (fakeB) => {
        const workspaceA = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fakeA.baseUrl })
        const workspaceB = githubWorkspace(instancesDir, { owner: 'owner-b', repository: 'repo-b', baseUrl: fakeB.baseUrl })

        await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/workspaces/${workspaceA.id}/instances`, {
            headers: { Authorization: basicAuthHeader('pat-for-a') },
          })
          assert.equal(res.status, 200)
          assert.deepEqual((await res.json()).map((row) => row.slug), ['found-one'])

          // B's repo was never touched at all — not listed, not read, not even reached.
          assert.equal(fakeB.requestCount(), 0)
          assert.deepEqual(fakeB.authHeadersSeen(), [])
          // And B stayed undiscovered: only A's slug was registered, under A's workspace.
          const registered = listRegisteredInstances({ instancesDir })
          assert.deepEqual(registered.map((entry) => entry.scopeId), [workspaceA.id])
          assert.notEqual(registered[0].scopeId, workspaceB.id)
        })
      })
    })
  })
})

test('GET /api/workspaces/:id/instances: a workspace that already has designs registered is not re-discovered', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (fake) => {
      const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })

      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
        const first = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
          headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        })
        assert.equal(first.status, 200)
        assert.equal(fake.listFolderCalls(), 1)

        const second = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
          headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        })
        assert.equal(second.status, 200)
        assert.deepEqual((await second.json()).map((row) => row.slug), ['found-one'])
        // The repo's gantry-workspace/ folder was not listed a second time — the rows on the second
        // call came from the registry entries the first call created.
        assert.equal(fake.listFolderCalls(), 1)
      })
    })
  })
})

test('GET /api/workspaces/:id/instances: a workspace with a slug already registered never lists its repo at all', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (fake) => {
      const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })
      // Registered directly, bypassing discovery — "has at least one registered instance" is what
      // marks a workspace done, exactly as #112 established.
      registerInstance('already-known', { kind: 'github', workspaceId: workspace.id }, { instancesDir })

      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
        const res = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
          headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        })
        assert.equal(res.status, 200)
        assert.equal(fake.listFolderCalls(), 0)
        assert.deepEqual(listRegisteredInstances({ instancesDir }).map((entry) => entry.slug), ['already-known'])
      })
    })
  })
})

test('GET /api/workspaces/:id/instances: no credential -> the structured authentication_required response, and nothing is discovered', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (fake) => {
      const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })

      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
        const res = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`)
        assert.equal(res.status, 401)
        assert.equal((await res.json()).error, 'authentication_required')
        assert.equal(fake.requestCount(), 0)
        assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
      })
    })
  })
})

test('GET /api/workspaces/:id/instances: a credential the Provider rejects surfaces the existing rejected-credential response, never an empty listing', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (fake) => {
      const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })

      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
        const res = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
          headers: { Authorization: basicAuthHeader('not-the-real-pat') },
        })
        assert.equal(res.status, 401)
        const body = await res.json()
        assert.equal(body.error, 'authentication_required')
        // `credentialStatus: 'rejected'` is what web/lib/credential.js's `markCredentialRejected` is
        // driven off — a rejected credential must be distinguishable from an absent one, and from an
        // empty workspace.
        assert.equal(body.credentialStatus, 'rejected')
        assert.equal(body.credentialRejected, true)
        // The credential itself appears nowhere in the response.
        assert.ok(!JSON.stringify(body).includes('not-the-real-pat'))
        assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
      })
    })
  })
})

test('GET /api/workspaces/:id/instances: the deployment\'s own SHARED credential is never consulted — only the request\'s own', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (fake) => {
      const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })
      // Already discovered, as a shared deployment's own boot-time pass leaves it
      // (`lib/workspaceBootstrap.js`'s `discoverBootstrapPatInstances`) — this test is about the
      // *listing* half of the shared path, which is what #121 gave it.
      registerInstance('found-one', { kind: 'github', workspaceId: workspace.id }, { instancesDir })

      // The workspace IS shared with a real, working credential — proving the 401 below comes from
      // this route deliberately never falling back to it (#125's rule, carried forward), not from the
      // workspace being unshared. The unscoped `GET /api/instances` still uses it, unchanged.
      await withRunningServer(
        {
          instancesDir,
          allowGitHubBaseUrlOverride: true,
          sharedWorkspacePats: JSON.stringify({ [workspace.id]: GITHUB_VALID_PAT }),
        },
        async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`)
          assert.equal(res.status, 401)

          // ...and the shared path itself is untouched: the unscoped listing still shows this
          // workspace's rows with no viewer credential at all.
          const unscoped = await fetch(`${gantryBase}/api/instances`)
          assert.deepEqual((await unscoped.json()).map((row) => row.slug), ['found-one'])
        }
      )
    })
  })
})

test('GET /api/workspaces/:id/instances (gitlab): cross-provider coverage', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitLabServer(
      { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: SEED_FILES },
      async (baseUrl) => {
        const workspace = registerWorkspace(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl } },
          { instancesDir }
        )

        await withRunningServer({ instancesDir, allowGitLabBaseUrlOverride: true }, async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
            headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
          })
          assert.equal(res.status, 200)
          assert.deepEqual((await res.json()).map((row) => row.slug), ['found-one'])
          assert.deepEqual(listRegisteredInstances({ instancesDir }).map((entry) => entry.slug), ['found-one'])
        })
      }
    )
  })
})

test('GET /api/workspaces/:id/instances: an unknown workspace id 404s, and a provider with no discovery support 400s', async () => {
  await withScratchInstances(async (instancesDir) => {
    const atlassian = registerWorkspace(
      { provider: 'atlassian', location: { owner: 'acme', repository: 'acme-repo', jiraSite: 'acme', jiraProjectKey: 'ACME' } },
      { instancesDir }
    )

    await withRunningServer({ instancesDir }, async (gantryBase) => {
      const unknown = await fetch(`${gantryBase}/api/workspaces/no-such-workspace/instances`)
      assert.equal(unknown.status, 404)

      const unsupported = await fetch(`${gantryBase}/api/workspaces/${atlassian.id}/instances`, {
        headers: { Authorization: basicAuthHeader('whatever') },
      })
      assert.equal(unsupported.status, 400)
      assert.ok(!(await unsupported.text()).includes('whatever'))
    })
  })
})

test('GET /api/workspaces/:id/instances: the credential never reaches a response body or a log line', async () => {
  const secret = 'super-secret-discovery-pat'
  const logged = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args) => logged.push(args.join(' '))
  console.warn = (...args) => logged.push(args.join(' '))
  try {
    await withScratchInstances(async (instancesDir) => {
      await withFakeGitHub({ owner: 'owner-a', repository: 'repo-a', validPat: secret, files: SEED_FILES }, async (fake) => {
        const workspace = githubWorkspace(instancesDir, { owner: 'owner-a', repository: 'repo-a', baseUrl: fake.baseUrl })

        await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
          const ok = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
            headers: { Authorization: basicAuthHeader(secret) },
          })
          assert.ok(!(await ok.text()).includes(secret))

          // ...and the same for a failing one, whose path through the server logs the most.
          const rejected = await fetch(`${gantryBase}/api/workspaces/${workspace.id}/instances`, {
            headers: { Authorization: basicAuthHeader('another-secret-pat') },
          })
          assert.ok(!(await rejected.text()).includes('another-secret-pat'))
        })
      })
    })
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
  assert.ok(!logged.join('\n').includes(secret))
  assert.ok(!logged.join('\n').includes('another-secret-pat'))
})
