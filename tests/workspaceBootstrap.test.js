import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBootstrapWorkspaces, applyBootstrapWorkspaces, parseBootstrapPats, discoverBootstrapPatInstances } from '../lib/workspaceBootstrap.js'
import { deriveWorkspaceId, listWorkspaces, findWorkspaceByLocation, registerWorkspace } from '../lib/workspaceRegistry.js'
import { listRegisteredInstances } from '../lib/instanceRegistry.js'
import { createServer } from '../lib/server.js'
import { withScratchInstances, withRunningServer, withRunningExamplesServer } from './helpers/lifecycle.js'
import { createFakeGitHubServer, withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

const GITHUB_LOCATION = { owner: 'cgbarlow', repository: 'gantry-workspace-testing' }
const GITHUB_DECLARATION = { provider: 'github', location: GITHUB_LOCATION, owner: 'c.barlow' }

// #113 (parent #109): seeds a fake GitHub repo's `gantry-workspace/` the same shape
// tests/providerInstanceDiscovery.test.js's own `SEED_FILES` uses for #112 — one real instance
// folder, plus one stray subfolder with no instance.yaml that discovery must skip.
const BOOT_PAT_SEED_FILES = {
  '/gantry-workspace/found-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/stray-folder/notes.md': '# not an instance\n',
}

/** Polls `fn` (expected to return a truthy value, or `undefined`/`null`/falsy while not ready) up to
 * 100 times, 20ms apart (~2s total) — the "no fixed sleep" convention
 * tests/serverLibraryReposAtlassian.test.js's own startup-refresh test already established for this
 * codebase's other fire-and-forget startup work. `fn` may be sync or async. */
async function pollUntil(fn) {
  let result
  for (let attempt = 0; attempt < 100 && !result; attempt++) {
    result = await fn()
    if (!result) await new Promise((r) => setTimeout(r, 20))
  }
  return result
}

/** `withFakeGitHubServer`, plus a counter of GET requests to the exact "list gantry-workspace/" URL a
 * discovery pass issues (`/repos/:owner/:repo/contents/gantry-workspace`) — copied from
 * tests/providerInstanceDiscovery.test.js's own identically-named local helper (not exported there,
 * so mirrored here by hand rather than imported across test files) since this suite needs the same
 * "prove discovery ran exactly once, not once per request" evidence for the boot-time path. */
function withFakeGitHubServerCountingListFolder(opts, fn) {
  const server = createFakeGitHubServer(opts)
  const repoBasePath = `/repos/${opts.owner}/${opts.repository}`
  let listFolderCalls = 0
  server.on('request', (req) => {
    if (req.method !== 'GET') return
    const pathname = new URL(req.url, 'http://fake-github.invalid').pathname
    if (pathname === `${repoBasePath}/contents/gantry-workspace`) listFolderCalls++
  })
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn({ baseUrl: `http://localhost:${port}`, listFolderCalls: () => listFolderCalls })
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

function withEnv(env, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const result = fn()
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  if (result && typeof result.then === 'function') {
    return result.finally(restore)
  }
  restore()
  return result
}

// ---------------------------------------------------------------------------
// parseBootstrapWorkspaces
// ---------------------------------------------------------------------------

test('parseBootstrapWorkspaces: unset/undefined is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapWorkspaces(undefined), [])
})

test('parseBootstrapWorkspaces: null is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapWorkspaces(null), [])
})

test('parseBootstrapWorkspaces: empty/whitespace-only string is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapWorkspaces(''), [])
  assert.deepEqual(parseBootstrapWorkspaces('   \n '), [])
})

test('parseBootstrapWorkspaces: a valid JSON array of declarations parses through unchanged', () => {
  const raw = JSON.stringify([GITHUB_DECLARATION])
  assert.deepEqual(parseBootstrapWorkspaces(raw), [GITHUB_DECLARATION])
})

test('parseBootstrapWorkspaces: malformed JSON throws one line naming GANTRY_BOOTSTRAP_WORKSPACES', () => {
  assert.throws(
    () => parseBootstrapWorkspaces('{not json'),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES must be valid JSON:/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: a JSON object (not an array) throws, naming the env var', () => {
  assert.throws(
    () => parseBootstrapWorkspaces(JSON.stringify({ provider: 'github', location: GITHUB_LOCATION })),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES must be a JSON array/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: an entry with an unknown provider throws, naming the env var', () => {
  const raw = JSON.stringify([{ provider: 'trello', location: GITHUB_LOCATION }])
  assert.throws(
    () => parseBootstrapWorkspaces(raw),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES/)
      assert.match(err.message, /unknown provider "trello"/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: an entry missing location throws, naming the env var', () => {
  const raw = JSON.stringify([{ provider: 'github', owner: 'c.barlow' }])
  assert.throws(
    () => parseBootstrapWorkspaces(raw),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES/)
      assert.match(err.message, /missing required field "location"/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: defaults an entry with no provider to azure-devops (valid) rather than rejecting it', () => {
  const raw = JSON.stringify([{ location: { organization: 'org', project: 'proj', repository: 'repo' } }])
  const parsed = parseBootstrapWorkspaces(raw)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].provider, undefined)
})

// ---------------------------------------------------------------------------
// applyBootstrapWorkspaces
// ---------------------------------------------------------------------------

test('applyBootstrapWorkspaces registers a declared workspace with its derived id', async () => {
  await withScratchInstances((instancesDir) => {
    const [workspace] = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    assert.equal(workspace.id, deriveWorkspaceId('github', GITHUB_LOCATION))
    assert.deepEqual(workspace.location, GITHUB_LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
  })
})

test('applyBootstrapWorkspaces is idempotent across two applications — no duplicates, same ids both times', async () => {
  await withScratchInstances((instancesDir) => {
    const first = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    const second = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    assert.equal(first[0].id, second[0].id)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('applyBootstrapWorkspaces restores a declared workspace to the same id even after the registry file is wiped clean', async () => {
  await withScratchInstances((instancesDir1) => {
    const before = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir: instancesDir1 })

    // A fresh, empty registry — nothing on disk to find-by-location any more, the way a fully
    // ephemeral container filesystem restarts.
    return withScratchInstances((instancesDir2) => {
      const after = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir: instancesDir2 })
      assert.equal(after[0].id, before[0].id)
      assert.equal(after[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
    })
  })
})

test('an explicit id on a declaration is used instead of the derived one', async () => {
  await withScratchInstances((instancesDir) => {
    const explicitId = 'my-pinned-workspace-id'
    const [workspace] = applyBootstrapWorkspaces([{ ...GITHUB_DECLARATION, id: explicitId }], { instancesDir })
    assert.equal(workspace.id, explicitId)
    assert.notEqual(workspace.id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

test('applyBootstrapWorkspaces never re-keys a workspace that already exists at that location under a different (pre-existing) id', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(findWorkspaceByLocation({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir }), undefined)

    // Register it first under a random id, the way a pre-#111 caller (e.g. the wizard) might have.
    const randomlyRegistered = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })

    const [applied] = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    assert.equal(applied.id, randomlyRegistered.id)
    assert.notEqual(applied.id, deriveWorkspaceId('github', GITHUB_LOCATION))
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

// ---------------------------------------------------------------------------
// createServer wiring: GANTRY_BOOTSTRAP_WORKSPACES / options.bootstrapWorkspaces
// ---------------------------------------------------------------------------

test('createServer applies options.bootstrapWorkspaces at startup, registering the declared workspace', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir, bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]) }, async (base) => {
      const res = await fetch(`${base}/api/workspaces`)
      const listing = await res.json()
      assert.equal(listing.length, 1)
      assert.equal(listing[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
      assert.deepEqual(listing[0].location, GITHUB_LOCATION)
    })
  })
})

test('createServer bootstrap is idempotent across restarts — starting twice against the same instancesDir registers no duplicates and keeps the same id', async () => {
  await withScratchInstances((instancesDir) => {
    const options = { instancesDir, bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]), migrateWorkspacesOnStart: true }
    const first = createServer(options)
    first.close?.()
    const second = createServer(options)
    second.close?.()

    const listing = listWorkspaces({ instancesDir })
    assert.equal(listing.length, 1)
    assert.equal(listing[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

test('createServer falls back to process.env.GANTRY_BOOTSTRAP_WORKSPACES when options.bootstrapWorkspaces is not supplied', async () => {
  await withScratchInstances((instancesDir) => {
    withEnv({ GANTRY_BOOTSTRAP_WORKSPACES: JSON.stringify([GITHUB_DECLARATION]) }, () => {
      const server = createServer({ instancesDir, migrateWorkspacesOnStart: true })
      server.close?.()
    })
    const listing = listWorkspaces({ instancesDir })
    assert.equal(listing.length, 1)
    assert.equal(listing[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

test('createServer does not apply GANTRY_BOOTSTRAP_WORKSPACES unless migrateWorkspacesOnStart is set — same gate as the migrate/ensure-default-workspace block', async () => {
  await withScratchInstances((instancesDir) => {
    const server = createServer({ instancesDir, bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]) })
    server.close?.()
    assert.equal(listWorkspaces({ instancesDir }).length, 0)
  })
})

test('createServer throws (rather than starting) when GANTRY_BOOTSTRAP_WORKSPACES is malformed JSON', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: '{not json' }),
      (err) => {
        assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES must be valid JSON:/)
        return true
      }
    )
  })
})

test('createServer throws when GANTRY_BOOTSTRAP_WORKSPACES names an unknown provider', async () => {
  await withScratchInstances((instancesDir) => {
    const raw = JSON.stringify([{ provider: 'trello', location: GITHUB_LOCATION }])
    assert.throws(
      () => createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: raw }),
      /GANTRY_BOOTSTRAP_WORKSPACES.*unknown provider "trello"/
    )
  })
})

test('createServer throws when a GANTRY_BOOTSTRAP_WORKSPACES entry is missing location', async () => {
  await withScratchInstances((instancesDir) => {
    const raw = JSON.stringify([{ provider: 'github', owner: 'c.barlow' }])
    assert.throws(
      () => createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: raw }),
      /GANTRY_BOOTSTRAP_WORKSPACES.*missing required field "location"/
    )
  })
})

test('an unset GANTRY_BOOTSTRAP_WORKSPACES is a no-op — createServer boots cleanly with an empty workspace registry', async () => {
  await withScratchInstances((instancesDir) => {
    withEnv({ GANTRY_BOOTSTRAP_WORKSPACES: undefined }, () => {
      const server = createServer({ instancesDir, migrateWorkspacesOnStart: true })
      server.close?.()
    })
    assert.equal(listWorkspaces({ instancesDir }).length, 0)
  })
})

// ---------------------------------------------------------------------------
// The bundled Examples workspace stays visible — bootstrapping never touches GANTRY_WORKSPACES_DIR
// ---------------------------------------------------------------------------

test('bootstrapping a workspace does not hide the bundled Examples workspace/instances — GANTRY_WORKSPACES_DIR is never touched', async () => {
  await withRunningExamplesServer({ bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]) }, async (base) => {
    const instanceRes = await fetch(`${base}/api/instance`)
    assert.equal(instanceRes.status, 200)
    const instance = await instanceRes.json()
    assert.equal(instance.slug, 'examples')

    const workspacesRes = await fetch(`${base}/api/workspaces`)
    const workspaces = await workspacesRes.json()
    assert.equal(workspaces.length, 1)
    assert.equal(workspaces[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

// ---------------------------------------------------------------------------
// parseBootstrapPats (#113, parent #109, docs/adr/0046)
// ---------------------------------------------------------------------------

test('parseBootstrapPats: unset/undefined is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapPats(undefined), {})
})

test('parseBootstrapPats: null is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapPats(null), {})
})

test('parseBootstrapPats: empty/whitespace-only string is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapPats(''), {})
  assert.deepEqual(parseBootstrapPats('   \n '), {})
})

test('parseBootstrapPats: a valid {workspaceId: pat} JSON object parses through unchanged', () => {
  const raw = JSON.stringify({ 'workspace-a': 'pat-a', 'workspace-b': 'pat-b' })
  assert.deepEqual(parseBootstrapPats(raw), { 'workspace-a': 'pat-a', 'workspace-b': 'pat-b' })
})

test('parseBootstrapPats: malformed JSON fails loud, one line naming GANTRY_BOOTSTRAP_PATS', () => {
  assert.throws(
    () => parseBootstrapPats('{not json'),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_PATS must be valid JSON:/)
      assert.equal(err.message.split('\n').length, 1)
      return true
    }
  )
})

test('parseBootstrapPats: a JSON array (not an object) fails loud, naming the env var', () => {
  assert.throws(
    () => parseBootstrapPats(JSON.stringify(['workspace-a'])),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_PATS must be a JSON object mapping workspace id to PAT/)
      return true
    }
  )
})

test('parseBootstrapPats: an entry with a non-string value fails loud, naming the workspace id and the env var', () => {
  assert.throws(
    () => parseBootstrapPats(JSON.stringify({ 'workspace-a': 12345 })),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_PATS entry for workspace "workspace-a" must be a non-empty string/)
      return true
    }
  )
})

test('parseBootstrapPats: an entry with an empty-string value fails loud, naming the workspace id', () => {
  assert.throws(
    () => parseBootstrapPats(JSON.stringify({ 'workspace-a': '' })),
    (err) => {
      assert.match(err.message, /entry for workspace "workspace-a" must be a non-empty string/)
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// createServer wiring: GANTRY_BOOTSTRAP_PATS boot-time discovery (#113, parent #109, docs/adr/0046)
//
// A Provider-backed row still needs a per-request credential to actually *read* — `lib/registry.js`'s
// `buildGitHubRow`/`buildAzureDevOpsRow` return `null` with no `pat` at all, registered or not, so an
// unauthenticated `GET /api/instances` returns `[]` both with and without GANTRY_BOOTSTRAP_PATS. What
// boot-time discovery changes is the *instance registry* itself (`lib/instanceRegistry.js`'s own
// `found-one` entry): with it warm before any request arrives, the first authenticated request (the
// architect's first real dashboard load, or the MCP server's first call) gets its row back without
// itself paying #112's discovery round trip — these tests assert on the registry directly (via
// `listRegisteredInstances`, no HTTP, no credential) for "discovered with nobody present", and on the
// `gantry-workspace/` folder-listing call count for "the first real request doesn't re-discover".
// ---------------------------------------------------------------------------

test('a declared workspace with a matching GANTRY_BOOTSTRAP_PATS entry has its instances discovered at boot — registered with no request at all, and the first authenticated request never has to re-list the repo', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async ({ baseUrl, listFolderCalls }) => {
        const location = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }
        const workspaceId = deriveWorkspaceId('github', location)
        const declaration = { provider: 'github', location }

        await withRunningServer(
          {
            instancesDir,
            bootstrapWorkspaces: JSON.stringify([declaration]),
            bootstrapPats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }),
          },
          async (base) => {
            // No HTTP request made yet at all — poll the instance registry directly until boot-time
            // discovery has landed, proving it ran with nobody present rather than being triggered by
            // the request below.
            const registered = await pollUntil(() => listRegisteredInstances({ instancesDir }).some((r) => r.slug === 'found-one'))
            assert.ok(registered, 'found-one is registered before any request was ever made')
            assert.equal(listFolderCalls(), 1, 'exactly one boot-time listing of gantry-workspace/')

            // The stray subfolder with no instance.yaml was skipped, same as the request-credential path.
            assert.deepEqual(
              listRegisteredInstances({ instancesDir }).map((r) => r.slug),
              ['found-one']
            )

            // The architect's first-ever authenticated dashboard load gets the real row immediately —
            // #112's own discovery branch never runs because the registry is already warm, so this
            // request makes zero additional gantry-workspace/ listings.
            const res = await fetch(`${base}/api/instances`, {
              headers: { Authorization: `Basic ${Buffer.from(`:${GITHUB_VALID_PAT}`).toString('base64')}` },
            })
            const rows = await res.json()
            assert.deepEqual(rows.map((r) => r.slug), ['found-one'])
            assert.equal(rows[0].workspace.id, workspaceId)
            assert.equal(listFolderCalls(), 1, 'the first authenticated request does not re-list the repo — discovery already happened at boot')
          }
        )
      }
    )
  })
})

test('unset/empty GANTRY_BOOTSTRAP_PATS is a no-op — nothing is registered at boot, only via the request-credential path', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async (baseUrl) => {
        const location = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }
        const declaration = { provider: 'github', location }

        await withRunningServer(
          { instancesDir, bootstrapWorkspaces: JSON.stringify([declaration]) },
          async (base) => {
            // Give any (wrongly) fired-off boot discovery a moment to have run, then confirm nothing
            // was registered — checked against the registry directly, not an unauthenticated request
            // (which would read `[]` regardless, credential or not, since a row needs one to be built).
            await new Promise((r) => setTimeout(r, 400))
            assert.deepEqual(listRegisteredInstances({ instancesDir }), [])

            // The request-credential path (#112) still works on its own.
            const withPatRows = await (
              await fetch(`${base}/api/instances`, { headers: { Authorization: `Basic ${Buffer.from(`:${GITHUB_VALID_PAT}`).toString('base64')}` } })
            ).json()
            assert.deepEqual(withPatRows.map((r) => r.slug), ['found-one'])
          }
        )
      }
    )
  })
})

test('a rejected/invalid boot PAT degrades — server starts cleanly and the workspace simply is not discovered at boot', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async (baseUrl) => {
        const location = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }
        const workspaceId = deriveWorkspaceId('github', location)
        const declaration = { provider: 'github', location }

        await withRunningServer(
          {
            instancesDir,
            bootstrapWorkspaces: JSON.stringify([declaration]),
            bootstrapPats: JSON.stringify({ [workspaceId]: 'not-the-real-pat' }),
          },
          async (base) => {
            // Server started fine (withRunningServer would have rejected/hung otherwise) and the
            // workspace registration itself is unaffected by the rejected boot PAT.
            const workspacesRes = await fetch(`${base}/api/workspaces`)
            assert.equal(workspacesRes.status, 200)
            const workspaces = await workspacesRes.json()
            assert.equal(workspaces.length, 1)
            assert.equal(workspaces[0].id, workspaceId)

            // Give the rejected boot-time discovery attempt a moment to fail and be caught, then
            // confirm it left nothing behind in the registry — the request-credential path can still
            // discover it later with a real credential.
            await new Promise((r) => setTimeout(r, 400))
            assert.deepEqual(listRegisteredInstances({ instancesDir }), [])

            const withPatRows = await (
              await fetch(`${base}/api/instances`, { headers: { Authorization: `Basic ${Buffer.from(`:${GITHUB_VALID_PAT}`).toString('base64')}` } })
            ).json()
            assert.deepEqual(withPatRows.map((r) => r.slug), ['found-one'])
          }
        )
      }
    )
  })
})

test('createServer throws (rather than starting) when GANTRY_BOOTSTRAP_PATS is malformed JSON', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () =>
        createServer({
          instancesDir,
          migrateWorkspacesOnStart: true,
          bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]),
          bootstrapPats: '{not json',
        }),
      (err) => {
        assert.match(err.message, /^GANTRY_BOOTSTRAP_PATS must be valid JSON:/)
        return true
      }
    )
  })
})

test('createServer falls back to process.env.GANTRY_BOOTSTRAP_PATS when options.bootstrapPats is not supplied', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async (baseUrl) => {
        const location = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }
        const workspaceId = deriveWorkspaceId('github', location)
        const declaration = { provider: 'github', location }

        const prev = process.env.GANTRY_BOOTSTRAP_PATS
        process.env.GANTRY_BOOTSTRAP_PATS = JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT })
        try {
          await withRunningServer({ instancesDir, bootstrapWorkspaces: JSON.stringify([declaration]) }, async () => {
            const registered = await pollUntil(() => listRegisteredInstances({ instancesDir }).some((r) => r.slug === 'found-one'))
            assert.ok(registered, 'found-one registered at boot via the env var fallback')
          })
        } finally {
          if (prev === undefined) delete process.env.GANTRY_BOOTSTRAP_PATS
          else process.env.GANTRY_BOOTSTRAP_PATS = prev
        }
      }
    )
  })
})

// ---------------------------------------------------------------------------
// A boot PAT is never returned in an API response, written to any registry file, or logged
// ---------------------------------------------------------------------------

test('the boot PAT never appears in any GET /api/* JSON response, nor in the raw contents of any registry file on disk', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async (baseUrl) => {
        const location = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }
        const workspaceId = deriveWorkspaceId('github', location)
        const declaration = { provider: 'github', location }
        const secretPat = GITHUB_VALID_PAT

        await withRunningServer(
          {
            instancesDir,
            bootstrapWorkspaces: JSON.stringify([declaration]),
            bootstrapPats: JSON.stringify({ [workspaceId]: secretPat }),
          },
          async (base) => {
            await pollUntil(() => listRegisteredInstances({ instancesDir }).some((r) => r.slug === 'found-one'))

            for (const path of ['/api/instances', '/api/workspaces']) {
              const text = await (await fetch(`${base}${path}`)).text()
              assert.ok(!text.includes(secretPat), `${path} response must never include the boot PAT`)
            }

            // Nor does the row-bearing, PAT-authenticated response — the credential authenticates the
            // request, it is never echoed back in the body.
            const authedText = await (
              await fetch(`${base}/api/instances`, { headers: { Authorization: `Basic ${Buffer.from(`:${secretPat}`).toString('base64')}` } })
            ).text()
            assert.ok(!authedText.includes(secretPat), 'the PAT-authenticated /api/instances response must never include the boot PAT')

            const registryText = readFileSync(join(instancesDir, 'instance-registry.json'), 'utf8')
            assert.ok(!registryText.includes(secretPat), 'instance-registry.json must never include the boot PAT')

            const workspaceRegistryText = readFileSync(join(instancesDir, 'workspace-registry.json'), 'utf8')
            assert.ok(!workspaceRegistryText.includes(secretPat), 'workspace-registry.json must never include the boot PAT')
          }
        )
      }
    )
  })
})

// ---------------------------------------------------------------------------
// discoverBootstrapPatInstances — the standalone function itself, without a running HTTP server
// ---------------------------------------------------------------------------

test('discoverBootstrapPatInstances only discovers a workspace with a matching pats entry, leaving an unmatched one alone', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async (baseUrl) => {
        const matched = registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }, { instancesDir })
        const unmatched = registerWorkspace({ provider: 'github', location: { owner: 'other-owner', repository: 'other-repo', baseUrl } }, { instancesDir })

        await discoverBootstrapPatInstances([matched, unmatched], { [matched.id]: GITHUB_VALID_PAT }, { instancesDir })

        assert.deepEqual(listWorkspaces({ instancesDir }).map((w) => w.id).sort(), [matched.id, unmatched.id].sort())
        const registryText = readFileSync(join(instancesDir, 'instance-registry.json'), 'utf8')
        assert.ok(registryText.includes('found-one'))
      }
    )
  })
})

test('discoverBootstrapPatInstances scopes a boot PAT to its own declared workspace only — it is never tried against a different undiscovered workspace', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: BOOT_PAT_SEED_FILES },
      async (baseUrl) => {
        let otherRepoRequests = 0
        const otherServer = createFakeGitHubServer({ owner: 'other-owner', repository: 'other-repo', validPat: 'other-pat', files: {} })
        otherServer.on('request', () => {
          otherRepoRequests++
        })
        await new Promise((resolve) => otherServer.listen(0, resolve))
        const otherPort = otherServer.address().port

        try {
          const matched = registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }, { instancesDir })
          const other = registerWorkspace(
            { provider: 'github', location: { owner: 'other-owner', repository: 'other-repo', baseUrl: `http://localhost:${otherPort}` } },
            { instancesDir }
          )

          await discoverBootstrapPatInstances([matched, other], { [matched.id]: GITHUB_VALID_PAT }, { instancesDir })

          // The matched workspace's own PAT was never sent to the other, unrelated workspace's repo.
          assert.equal(otherRepoRequests, 0)
        } finally {
          otherServer.close()
        }
      }
    )
  })
})
