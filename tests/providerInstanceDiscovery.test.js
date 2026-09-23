import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listRegistry } from '../lib/registry.js'
import { listRegisteredInstances, registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withScratchInstances } from './helpers/lifecycle.js'
import { createFakeGitHubServer, withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'

// #112 (parent #109): a registered Provider-backed workspace has no local directory for the
// pre-existing directory-only instance-registry backfill to scan — its instances are structurally
// undiscoverable until something lists `gantry-workspace/` in its own repo. These tests exercise that
// discovery end to end, through `listRegistry` (the `GET /api/instances` primitive), covering both
// GitHub and GitLab so this isn't proven against one provider's content store alone.

const SEED_FILES = {
  '/gantry-workspace/found-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  // A `gantry-workspace/` subfolder holding no `instance.yaml` of its own — not an instance, must be
  // skipped rather than registered.
  '/gantry-workspace/stray-folder/notes.md': '# not an instance\n',
}

/** Starts `createFakeGitHubServer(opts)` on an ephemeral port, runs `fn({ baseUrl, listFolderCalls })`
 * and closes it — like `withFakeGitHubServer`, but also hands back a counter of GET requests to the
 * exact "list gantry-workspace/" URL a discovery pass issues (`/repos/:owner/:repo/contents/gantry-workspace`,
 * no further path segment — distinct from the many other GET requests, a single instance.yaml, a
 * stage-branch check, a commit lookup, each per-row read also makes against the same repo). This is
 * what proves a second `listRegistry` call does not re-list the repo, not just that it returns the
 * same rows. */
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

test('listRegistry discovers a Provider-backed GitHub workspace\'s instances from its repo when it has none registered yet, skipping a subfolder with no instance.yaml', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
        { instancesDir }
      )

      // Nothing registered yet for this workspace.
      assert.deepEqual(listRegisteredInstances({ instancesDir }), [])

      const registry = await listRegistry({ instancesDir, pat: GITHUB_VALID_PAT })
      assert.deepEqual(registry.map((row) => row.slug), ['found-one'])
      assert.equal(registry[0].workspace.id, workspace.id)

      // Discovered instances are now ordinary registry entries — never 'stray-folder'.
      const registered = listRegisteredInstances({ instancesDir })
      assert.deepEqual(registered.map((r) => r.slug), ['found-one'])
      assert.equal(registered[0].location.kind, 'github')
    })
  })
})

test('listRegistry does not re-list a GitHub workspace\'s repo once its instances have been discovered', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES },
      async ({ baseUrl, listFolderCalls }) => {
        registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }, { instancesDir })

        const first = await listRegistry({ instancesDir, pat: GITHUB_VALID_PAT })
        assert.deepEqual(first.map((r) => r.slug), ['found-one'])
        assert.equal(listFolderCalls(), 1)

        const second = await listRegistry({ instancesDir, pat: GITHUB_VALID_PAT })
        assert.deepEqual(second.map((r) => r.slug), ['found-one'])
        // The repo's gantry-workspace/ folder was not listed again — only the discovery pass on the
        // first call ever calls it; the second call reads the already-registered instance directly.
        assert.equal(listFolderCalls(), 1)
      }
    )
  })
})

test('listRegistry leaves a Provider-backed workspace\'s rows out, without failing the request, when the caller supplies no credential', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }, { instancesDir })

      const registry = await listRegistry({ instancesDir })
      assert.deepEqual(registry, [])
      // Nothing was discovered/registered either — a future request carrying a real credential can
      // still discover it.
      assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
    })
  })
})

test('listRegistry leaves a Provider-backed workspace\'s rows out, without failing the request, when the credential is rejected', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }, { instancesDir })

      const registry = await listRegistry({ instancesDir, pat: 'not-the-real-pat' })
      assert.deepEqual(registry, [])
      assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
    })
  })
})

test('listRegistry discovers a Provider-backed GitLab workspace\'s instances from its repo the same way', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      const workspace = registerWorkspace(
        { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl } },
        { instancesDir }
      )

      const registry = await listRegistry({ instancesDir, pat: GITLAB_VALID_PAT })
      assert.deepEqual(registry.map((row) => row.slug), ['found-one'])
      assert.equal(registry[0].workspace.id, workspace.id)

      const registered = listRegisteredInstances({ instancesDir })
      assert.deepEqual(registered.map((r) => r.slug), ['found-one'])
      assert.equal(registered[0].location.kind, 'gitlab')
    })
  })
})

test('listRegistry never re-discovers a workspace that already has a registered instance, even an unrelated one', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES },
      async ({ baseUrl, listFolderCalls }) => {
        const workspace = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
          { instancesDir }
        )
        // Registers a slug directly (bypassing discovery) — the workspace now has one registered
        // instance, even though it does not correspond to the "found-one" data actually seeded in the
        // repo (registerInstance never reads/writes repo content itself). Discovery must treat "has at
        // least one registered instance" as done, not "matches what's in the repo" — so listFolder is
        // never called at all. Asserted against listRegisteredInstances (not listRegistry's rows),
        // since a row for "already-known" would itself need real instance.yaml content on the fake
        // repo that this test deliberately never seeds — the point here is discovery is skipped, not
        // what the row would look like.
        registerInstance('already-known', { kind: 'github', workspaceId: workspace.id }, { instancesDir })

        await listRegistry({ instancesDir, pat: GITHUB_VALID_PAT })
        assert.deepEqual(
          listRegisteredInstances({ instancesDir }).map((r) => r.slug),
          ['already-known']
        )
        assert.equal(listFolderCalls(), 0)
      }
    )
  })
})

// ---------- #131: a workspace-scoped listing ----------
// `listRegistry`'s own `options.workspaceId` — what `GET /api/workspaces/:id/instances` is built on.
// The credential a scoped listing carries belongs to exactly one workspace (docs/adr/0038), so the
// listing it drives must never reach beyond that workspace, for discovery or for rows.

test('listRegistry scoped to one workspace discovers and lists that workspace only — a second workspace\'s repo is never touched', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: 'pat-for-a', files: SEED_FILES },
      async ({ baseUrl: baseUrlA, listFolderCalls: listFolderCallsA }) => {
        await withFakeGitHubServerCountingListFolder(
          // B's repo only accepts its own credential — it must never get the chance to reject A's.
          { owner: 'other-owner', repository: 'other-repo', validPat: 'pat-for-b', files: SEED_FILES },
          async ({ baseUrl: baseUrlB, listFolderCalls: listFolderCallsB }) => {
            const workspaceA = registerWorkspace(
              { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: baseUrlA } },
              { instancesDir }
            )
            registerWorkspace(
              { provider: 'github', location: { owner: 'other-owner', repository: 'other-repo', baseUrl: baseUrlB } },
              { instancesDir }
            )

            const rows = await listRegistry({ instancesDir, pat: 'pat-for-a', workspaceId: workspaceA.id })
            assert.deepEqual(rows.map((row) => row.slug), ['found-one'])
            assert.equal(rows[0].workspace.id, workspaceA.id)

            assert.equal(listFolderCallsA(), 1)
            // B was never listed, so A's credential was never attempted against it.
            assert.equal(listFolderCallsB(), 0)
            assert.deepEqual(
              listRegisteredInstances({ instancesDir }).map((entry) => entry.scopeId),
              [workspaceA.id]
            )
          }
        )
      }
    )
  })
})

test('listRegistry scoped to one workspace leaves every other workspace\'s already-registered rows out of the result', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
        { instancesDir }
      )
      const other = registerWorkspace(
        { provider: 'github', location: { owner: 'other-owner', repository: 'other-repo', baseUrl } },
        { instancesDir }
      )
      registerInstance('someone-elses', { kind: 'github', workspaceId: other.id }, { instancesDir })

      const rows = await listRegistry({ instancesDir, pat: GITHUB_VALID_PAT, workspaceId: workspace.id })
      assert.deepEqual(rows.map((row) => row.slug), ['found-one'])
    })
  })
})

test('listRegistry unscoped is unchanged by #131 — it still spans every workspace and still swallows a rejected credential', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }, { instancesDir })
      // No `surfaceAuthenticationErrors`: a rejected credential must shorten the listing, never fail
      // the whole request — the pre-#131 contract every `GET /api/instances` caller relies on.
      assert.deepEqual(await listRegistry({ instancesDir, pat: 'not-the-real-pat' }), [])
    })
  })
})

test('listRegistry with surfaceAuthenticationErrors rethrows a rejected credential instead of reporting an empty workspace', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
        { instancesDir }
      )
      await assert.rejects(
        () => listRegistry({ instancesDir, pat: 'not-the-real-pat', workspaceId: workspace.id, surfaceAuthenticationErrors: true }),
        (err) => {
          assert.ok(err instanceof AuthenticationError)
          // The credential never appears in the error a caller would go on to log or render.
          assert.ok(!err.message.includes('not-the-real-pat'))
          return true
        }
      )
      // Nothing was registered on a failed attempt — a later request with a working credential still
      // discovers this workspace from scratch.
      assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
    })
  })
})

// ---------- #133 (parent #109): request-time discovery reaches a shared credential too ----------
//
// #131's own request-time discovery only ever tried `options.pat` (the request's own credential).
// A workspace with a `GANTRY_SHARED_WORKSPACE_PATS` entry but not also declared in
// `GANTRY_BOOTSTRAP_WORKSPACES` — registered instead through the New Workspace wizard, or already
// present in the registry some other way — was never discovered at all: boot-time discovery only
// iterates the workspaces bootstrap just registered, and request-time discovery never consulted
// `sharedPats`. These tests exercise `listRegistry`'s discovery branch with `sharedPats` and no
// request `pat`, the shape a credential-less browser request actually carries.

test('listRegistry discovers a workspace registered outside GANTRY_BOOTSTRAP_WORKSPACES from its own GANTRY_SHARED_WORKSPACE_PATS entry, with no request credential at all', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      // registerWorkspace, not a bootstrap declaration — the "registered some other way" case #133
      // names explicitly (New Workspace wizard, or already present in the registry).
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
        { instancesDir }
      )
      assert.deepEqual(listRegisteredInstances({ instancesDir }), [])

      const registry = await listRegistry({ instancesDir, sharedPats: { [workspace.id]: GITHUB_VALID_PAT } })
      assert.deepEqual(registry.map((row) => row.slug), ['found-one'])

      const registered = listRegisteredInstances({ instancesDir })
      assert.deepEqual(registered.map((r) => r.slug), ['found-one'])
    })
  })
})

test('listRegistry lists a genuinely empty shared workspace once, then never re-lists its repo on later requests', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: {} },
      async ({ baseUrl, listFolderCalls }) => {
        const workspace = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
          { instancesDir }
        )
        const sharedPats = { [workspace.id]: GITHUB_VALID_PAT }

        const first = await listRegistry({ instancesDir, sharedPats })
        assert.deepEqual(first, [])
        assert.equal(listFolderCalls(), 1)

        const second = await listRegistry({ instancesDir, sharedPats })
        assert.deepEqual(second, [])
        // The empty repo was not re-listed — the discovered-and-empty marker stopped it.
        assert.equal(listFolderCalls(), 1)

        const third = await listRegistry({ instancesDir, sharedPats })
        assert.deepEqual(third, [])
        assert.equal(listFolderCalls(), 1)
      }
    )
  })
})

test('listRegistry never re-discovers a shared workspace that already has a registered instance', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES },
      async ({ baseUrl, listFolderCalls }) => {
        const workspace = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
          { instancesDir }
        )
        registerInstance('already-known', { kind: 'github', workspaceId: workspace.id }, { instancesDir })

        await listRegistry({ instancesDir, sharedPats: { [workspace.id]: GITHUB_VALID_PAT } })
        assert.deepEqual(
          listRegisteredInstances({ instancesDir }).map((r) => r.slug),
          ['already-known']
        )
        assert.equal(listFolderCalls(), 0)
      }
    )
  })
})

test('listRegistry: a shared credential declared for workspace A is never tried against an undiscovered workspace B', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServerCountingListFolder(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: 'pat-for-a', files: SEED_FILES },
      async ({ baseUrl: baseUrlA, listFolderCalls: listFolderCallsA }) => {
        await withFakeGitHubServerCountingListFolder(
          // B's repo only accepts its own credential — it must never get the chance to reject A's.
          { owner: 'other-owner', repository: 'other-repo', validPat: 'pat-for-b', files: SEED_FILES },
          async ({ baseUrl: baseUrlB, listFolderCalls: listFolderCallsB }) => {
            const workspaceA = registerWorkspace(
              { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: baseUrlA } },
              { instancesDir }
            )
            const workspaceB = registerWorkspace(
              { provider: 'github', location: { owner: 'other-owner', repository: 'other-repo', baseUrl: baseUrlB } },
              { instancesDir }
            )

            const registry = await listRegistry({ instancesDir, sharedPats: { [workspaceA.id]: 'pat-for-a' } })
            assert.deepEqual(registry.map((row) => row.slug), ['found-one'])
            assert.equal(registry[0].workspace.id, workspaceA.id)

            assert.equal(listFolderCallsA(), 1)
            // B has no shared entry of its own — A's credential must never be tried against it.
            assert.equal(listFolderCallsB(), 0)
            assert.deepEqual(
              listRegisteredInstances({ instancesDir }).map((entry) => entry.scopeId),
              [workspaceA.id]
            )
            void workspaceB
          }
        )
      }
    )
  })
})

test('listRegistry: no shared credential appears anywhere in the built rows when it was used only for discovery', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (baseUrl) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } },
        { instancesDir }
      )

      const registry = await listRegistry({ instancesDir, sharedPats: { [workspace.id]: GITHUB_VALID_PAT } })
      assert.ok(!JSON.stringify(registry).includes(GITHUB_VALID_PAT))
    })
  })
})
