import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerInstance } from '../lib/instanceRegistry.js'
import { findWorkspaceByLocation } from '../lib/workspaceRegistry.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, withScratchInstances, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// #125 (parent #109, docs/adr/0047): a shared workspace's designs — stage/module content and its
// assets/images — read with no credential, extending the same GANTRY_SHARED_WORKSPACE_PATS resolver
// #121 built for the dashboard listing to every other instance-content read path. See that ADR's
// load-bearing rule: "a read may resolve either the viewer's credential or the workspace's shared
// one; a write may resolve only the viewer's."
//
// Registers directly against the on-disk registry (no running gantry server needed for this step) so
// the real workspace id — `registerInstance`'s own `getOrCreateWorkspace` assigns one internally, not
// necessarily `deriveWorkspaceId`'s deterministic form — is known *before* the gantry server starts,
// since `sharedWorkspacePats`/`GANTRY_SHARED_WORKSPACE_PATS` is parsed once at server startup and has
// to be keyed by that same id.

const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function githubDesignFiles(slug) {
  return {
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n`,
    [`/gantry-workspace/${slug}/modules/background.md`]: exampleModuleText('background'),
    [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
    [`/gantry-workspace/${slug}/assets/foo.png`]: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
  }
}

function azureDevOpsDesignFiles(slug) {
  return {
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n`,
    [`/gantry-workspace/${slug}/modules/background.md`]: exampleModuleText('background'),
    [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
  }
}

function registerGitHubInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(slug, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
  return findWorkspaceByLocation(
    { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl } },
    { instancesDir }
  ).id
}

function registerAzureDevOpsInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(
    slug,
    { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: providerBaseUrl },
    { instancesDir }
  )
  return findWorkspaceByLocation(
    { provider: 'azure-devops', location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: providerBaseUrl } },
    { instancesDir }
  ).id
}

// ---------- GET /api/instance (stage/module content) — GitHub ----------

test('GET /api/instance: a credential-less request against a shared GitHub workspace reads the design; the same workspace UNshared still 401s; a request with its own credential still uses its own', async () => {
  const slug = 'shared-github-design'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          {
            instancesDir,
            allowGitHubBaseUrlOverride: true,
            sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }),
          },
          async (gantryBase) => {
            // `?scope=<workspaceId>` — the token `GET /api/instance/workspace` hands an anonymous
            // visitor's browser with no credential at all (see that route's own doc comment: "the web
            // client echoes back ?scope= on every subsequent request"), and the same one
            // `sharedReadCredential`/`GANTRY_SHARED_WORKSPACE_PATS` are keyed by — the realistic shape
            // of an anonymous visitor's actual request, rather than the deprecated bare-slug form.
            //
            // No credential at all — resolves against the workspace's shared credential.
            const noCredRes = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
            assert.equal(noCredRes.status, 200)
            const body = await noCredRes.json()
            assert.equal(body.slug, slug)
            assert.ok(body.modules.some((m) => m.id === 'background'), 'expected the design\'s own module content back')

            // A request that carries its own (valid) credential still works — its own credential is used, never blocked by the shared one existing.
            const ownCredRes = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`, {
              headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
            })
            assert.equal(ownCredRes.status, 200)
          }
        )
      }
    )
  })

  // The identical workspace, this time genuinely unshared (no GANTRY_SHARED_WORKSPACE_PATS entry at
  // all) — must 401 exactly as it did before this ticket, unaffected by the feature existing elsewhere.
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
          assert.equal(res.status, 401)
          assert.match((await res.json()).message ?? '', /GitHub/)
        })
      }
    )
  })
})

// ---------- GET /api/instance/assets/:filename/file (an image) — GitHub ----------

test('GET /api/instance/assets/:filename/file: a credential-less request against a shared GitHub workspace streams the image; a WRONG shared credential is never preferred over a request\'s own valid one', async () => {
  const slug = 'shared-github-asset'
  const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          {
            instancesDir,
            allowGitHubBaseUrlOverride: true,
            sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }),
          },
          async (gantryBase) => {
            const noCredRes = await fetch(`${gantryBase}/api/instance/assets/foo.png/file?slug=${slug}&scope=${workspaceId}`)
            assert.equal(noCredRes.status, 200)
            assert.equal(noCredRes.headers.get('content-type'), 'image/png')
            assert.deepEqual(Buffer.from(await noCredRes.arrayBuffer()), pngBytes)
          }
        )
      }
    )
  })

  // A request WITH its own valid credential uses its own even when this workspace's shared entry is
  // deliberately a PAT the fake server rejects — proof the request's own credential is what was
  // actually used, not the shared one silently taking priority.
  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          {
            instancesDir,
            allowGitHubBaseUrlOverride: true,
            sharedWorkspacePats: JSON.stringify({ [workspaceId]: 'not-a-real-pat-and-never-tried' }),
          },
          async (gantryBase) => {
            const res = await fetch(`${gantryBase}/api/instance/assets/foo.png/file?slug=${slug}&scope=${workspaceId}`, {
              headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
            })
            assert.equal(res.status, 200)
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), pngBytes)
          }
        )
      }
    )
  })
})

// ---------- GET /api/instance (stage/module content) — Azure DevOps, for cross-provider coverage ----------

test('GET /api/instance: a credential-less request against a shared Azure-DevOps-backed workspace reads the design', async () => {
  const slug = 'shared-ado-design'

  await withScratchInstances(async (instancesDir) => {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: azureDevOpsDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerAzureDevOpsInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          {
            instancesDir,
            allowedAzureDevOpsBaseUrls: [providerBaseUrl],
            sharedWorkspacePats: JSON.stringify({ [workspaceId]: VALID_PAT }),
          },
          async (gantryBase) => {
            const res = await fetch(`${gantryBase}/api/instance?slug=${slug}&scope=${workspaceId}`)
            assert.equal(res.status, 200)
            const body = await res.json()
            assert.equal(body.slug, slug)
            assert.ok(body.modules.some((m) => m.id === 'background'))
          }
        )
      }
    )
  })
})

// ---------- Regression guard: a WRITE route must never see the shared credential ----------

test('PUT /api/instance/assignee (a write): a credential-less request against a SHARED workspace still 401s — the shared credential is never reachable from a mutation', async () => {
  const slug = 'shared-github-write-guard'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: githubDesignFiles(slug) },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer(
          {
            instancesDir,
            allowGitHubBaseUrlOverride: true,
            // The same workspace IS shared — proving the 401 below is the write-path invariant holding,
            // not simply an absence of sharing.
            sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }),
          },
          async (gantryBase) => {
            const res = await fetch(`${gantryBase}/api/instance/assignee?slug=${slug}&scope=${workspaceId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ assignee: 'a.person' }),
            })
            assert.equal(res.status, 401)

            // Confirms the write genuinely succeeds with the viewer's own credential — this isn't a
            // route that's simply broken for every request.
            const withOwnPat = await fetch(`${gantryBase}/api/instance/assignee?slug=${slug}&scope=${workspaceId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
              body: JSON.stringify({ assignee: 'a.person' }),
            })
            assert.equal(withOwnPat.status, 200)
          }
        )
      }
    )
  })
})
