import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listRegistry } from '../lib/registry.js'
import { listRegisteredInstances, registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
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
