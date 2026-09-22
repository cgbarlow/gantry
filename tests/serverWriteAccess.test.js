import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerInstance } from '../lib/instanceRegistry.js'
import { findWorkspaceByLocation } from '../lib/workspaceRegistry.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, withScratchInstances, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// #126 (parent #109, docs/adr/0047): `GET /api/workspaces/:workspaceId/write-access` — "whether
// someone can write is established by an explicit check ... not inferred from the mere presence of a
// token". Covers the route's own three-way split (no credential -> 401 authentication_required; a
// credential the Provider itself rejects -> the same 401, indistinguishable from "no credential" at
// this layer, exactly like every other provider-backed route; a credential the Provider accepts but
// that only reads -> 200 { canWrite: false }, never treated as a rejection) and the "never the shared
// credential" guard #125's own write-path invariant already established for mutations.

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

test('GET /api/workspaces/:id/write-access (github): no credential -> 401; a push-capable credential -> canWrite true; a read-only one -> canWrite false', async () => {
  const slug = 'write-access-github'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      {
        owner: GITHUB_OWNER,
        repository: GITHUB_REPOSITORY,
        validPat: [GITHUB_VALID_PAT, 'read-only-pat'],
        viewerPermissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
      },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
          const noCredRes = await fetch(`${gantryBase}/api/workspaces/${workspaceId}/write-access`)
          assert.equal(noCredRes.status, 401)
          assert.equal((await noCredRes.json()).error, 'authentication_required')

          const writeRes = await fetch(`${gantryBase}/api/workspaces/${workspaceId}/write-access`, {
            headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
          })
          assert.equal(writeRes.status, 200)
          assert.deepEqual(await writeRes.json(), { canWrite: true })
        })
      }
    )
  })

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer(
      {
        owner: GITHUB_OWNER,
        repository: GITHUB_REPOSITORY,
        validPat: 'read-only-pat',
        viewerPermissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
      },
      async (providerBaseUrl) => {
        const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/workspaces/${workspaceId}/write-access`, {
            headers: { Authorization: basicAuthHeader('read-only-pat') },
          })
          assert.equal(res.status, 200)
          assert.deepEqual(await res.json(), { canWrite: false })
        })
      }
    )
  })
})

test('GET /api/workspaces/:id/write-access: a credential the Provider itself rejects gets the same structured 401 every other provider-backed route gives it', async () => {
  const slug = 'write-access-github-rejected'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (providerBaseUrl) => {
      const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, async (gantryBase) => {
        const res = await fetch(`${gantryBase}/api/workspaces/${workspaceId}/write-access`, {
          headers: { Authorization: basicAuthHeader('not-a-real-pat') },
        })
        assert.equal(res.status, 401)
        assert.equal((await res.json()).error, 'authentication_required')
      })
    })
  })
})

test('GET /api/workspaces/:id/write-access: the workspace\'s own SHARED credential is never consulted — only the request\'s own', async () => {
  const slug = 'write-access-github-shared-guard'

  await withScratchInstances(async (instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (providerBaseUrl) => {
      const workspaceId = registerGitHubInstance(slug, { instancesDir, providerBaseUrl })

      // The workspace IS shared (a real, working credential) — proving the 401 below comes from this
      // route deliberately never falling back to it, not from the workspace being unshared.
      await withRunningServer(
        { instancesDir, allowGitHubBaseUrlOverride: true, sharedWorkspacePats: JSON.stringify({ [workspaceId]: GITHUB_VALID_PAT }) },
        async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/workspaces/${workspaceId}/write-access`)
          assert.equal(res.status, 401)
        }
      )
    })
  })
})

test('GET /api/workspaces/:id/write-access (azure-devops): cross-provider coverage', async () => {
  const slug = 'write-access-ado'

  await withScratchInstances(async (instancesDir) => {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, canWrite: false },
      async (providerBaseUrl) => {
        const workspaceId = registerAzureDevOpsInstance(slug, { instancesDir, providerBaseUrl })

        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [providerBaseUrl] }, async (gantryBase) => {
          const res = await fetch(`${gantryBase}/api/workspaces/${workspaceId}/write-access`, {
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 200)
          assert.deepEqual(await res.json(), { canWrite: false })
        })
      }
    )
  })
})

test('GET /api/workspaces/:id/write-access: an unknown workspace id 404s', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir }, async (gantryBase) => {
      const res = await fetch(`${gantryBase}/api/workspaces/no-such-workspace/write-access`)
      assert.equal(res.status, 404)
    })
  })
})
