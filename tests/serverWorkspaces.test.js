import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// GET/POST /api/workspaces (#96): the HTTP-API-boundary half of the workspace registry's own acceptance criteria — exercised as real HTTP requests against a real running server, mirroring every other server test in this suite.




function withScratchServer(serverOptions, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir, ...serverOptions }, (base) => fn(base, instancesDir)).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

function postWorkspaceBody(overrides = {}) {
  return JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, ...overrides })
}

// ---------- GET /api/workspaces ----------

test('GET /api/workspaces returns an empty array when nothing is registered', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), [])
  })
})

test('GET /api/workspaces requires no PAT — no credential is stored or needed for the workspace registry itself', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`)
    assert.equal(res.status, 200)
  })
})

// ---------- POST /api/workspaces: structural validation (no PAT/network needed) ----------

test('POST /api/workspaces reports 400, not 500, for a location missing organization/project/repository — no PAT required to reach this check', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: ORGANIZATION }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: project, repository/)
  })
})

test('POST /api/workspaces with an azureDevOps.baseUrl reports 400 on a server that has not opted into allowAzureDevOpsBaseUrlOverride', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postWorkspaceBody({ baseUrl: 'https://attacker.example' }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /baseUrl/)

    // Rejected before any credential is even asked for.
    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

// ---------- POST /api/workspaces: requires proving real Azure DevOps access ----------
//
// Registering a workspace *establishes* an Azure DevOps location, exactly as POST /api/instances and POST /api/instances/adopt already do — so, like those routes, it must require the caller's own PAT and actually verify it against the real location, not merely accept any caller's say-so for an arbitrary organization/project/repository.

test('POST /api/workspaces with no PAT returns the structured "authentication required" response, and persists nothing', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const res = await fetch(`${base}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: postWorkspaceBody({ baseUrl: adoBaseUrl }),
          })
          assert.equal(res.status, 401)
          const body = await res.json()
          assert.equal(body.error, 'authentication_required')

          const listing = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(listing.length, 0)
        }
      )
    }
  )
})

test('POST /api/workspaces with a PAT Azure DevOps itself rejects returns the same structured response, and persists nothing', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const res = await fetch(`${base}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-real-pat') },
            body: postWorkspaceBody({ baseUrl: adoBaseUrl }),
          })
          assert.equal(res.status, 401)
          const body = await res.json()
          assert.equal(body.error, 'authentication_required')

          // A caller who can't prove access to this org/project/repository must not be able to plant a workspace record (with a spoofed `owner`, for instance) for it.
          const listing = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(listing.length, 0)
        }
      )
    }
  )
})

test('POST /api/workspaces with a valid PAT for the real location creates the workspace, and it is then listed by GET /api/workspaces', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const createRes = await fetch(`${base}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: postWorkspaceBody({ baseUrl: adoBaseUrl, owner: 'c.barlow' }),
          })
          assert.equal(createRes.status, 201)
          const created = await createRes.json()
          assert.equal(created.location.organization, ORGANIZATION)
          assert.equal(created.location.project, PROJECT)
          assert.equal(created.location.repository, REPOSITORY)
          assert.equal(created.location.baseUrl, adoBaseUrl)
          assert.equal(created.owner, 'c.barlow')
          assert.equal(typeof created.id, 'string')

          const listing = await (await fetch(`${base}/api/workspaces`)).json()
          assert.ok(listing.some((w) => w.id === created.id))
        }
      )
    }
  )
})

// ---------- #5: nested `{ provider, location }` wire shape ----------

test('GET /api/workspaces returns the nested provider/location shape', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    registerWorkspace({ location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY }, owner: 'c.barlow' }, { instancesDir })

    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
    assert.equal(listing[0].provider, 'azure-devops')
    assert.deepEqual(listing[0].location, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })
  })
})

test('POST /api/workspaces accepts the nested { provider, location } body and returns the nested shape', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const res = await fetch(`${base}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: JSON.stringify({
              provider: 'azure-devops',
              location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
              owner: 'c.barlow',
            }),
          })
          assert.equal(res.status, 201)
          const created = await res.json()
          assert.equal(created.provider, 'azure-devops')
          assert.deepEqual(created.location, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl })
          assert.equal(created.owner, 'c.barlow')
        }
      )
    }
  )
})

test('POST /api/workspaces reports a nested location missing a required field as 400, matching the flat-body message shape', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'azure-devops', location: { organization: ORGANIZATION } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: project, repository/)
  })
})

// A nested { provider: "github", ... } body is structurally accepted (#8, docs/adr/0037) — it is no
// longer rejected outright the way it was before #8 landed. With no PAT supplied, it fails the same
// way every other provider's registration does (the caller's own PAT is required before this route
// will even attempt to prove access) rather than a provider-specific 400 — the full github-specific
// contract (real access proof via checkGitHubRepo, actual registration, dedup) is exercised end to
// end in tests/serverGitHubWorkspaces.test.js.
test('POST /api/workspaces with a nested { provider: "github", ... } body and no PAT returns the structured "authentication required" response, and persists nothing', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', location: { owner: 'octocat', repository: 'hello-world' } }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    // #9 (ADR-0038): `provider` is already known from the request body at this point — even with no
    // workspace yet to resolve it from, the message names GitHub, not the azure-devops default this
    // route falls back to when no provider is known at all.
    assert.match(body.message, /GitHub/)

    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

// #24 laid the groundwork (`provider` validates via lib/provider.js's own SUPPORTED_PROVIDERS,
// ADR-0041) for gitlab as a third provider; this route's own repo-check dispatch used to be
// `provider === 'github' ? checkGitHubRepo(...) : checkAzureDevOpsRepo(...)`, which would have
// silently run Azure DevOps's own repo check (and reused its own baseUrl-override flag) against a
// GitLab-shaped `{ namespace, repository }` location — exactly the anti-pattern ADR-0039 rejected.
// #25 finishes the job: gitlab now has a real, registered `checkGitLabRepo`/`allowGitLabBaseUrlOverride`
// entry in this route's own dispatch tables (proven end-to-end, with a real fake GitLab server, by
// tests/serverGitLabWorkspaces.test.js) — a gitlab registration reaches the same "prove real access
// before persisting" flow azure-devops/github already have, rather than being reported unsupported.
// This test only proves the *dispatch* — no real network call — by checking the missing-PAT case,
// which short-circuits before `checkGitLabRepo` is ever invoked (that PAT-proving path is what
// serverGitLabWorkspaces.test.js exercises against a real fake GitLab server).
test('POST /api/workspaces with a nested { provider: "gitlab", ... } body and no PAT reports the structured "authentication required" response naming GitLab, not "not supported yet"', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gitlab', location: { namespace: 'group/subgroup', repository: 'repo' } }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitLab/)

    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces rejects a gitlab.baseUrl override even when allowAzureDevOpsBaseUrlOverride is set — the two flags are not interchangeable', async () => {
  await withScratchServer({ allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ provider: 'gitlab', location: { namespace: 'group', repository: 'repo', baseUrl: 'https://gitlab.example.internal' } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /gitlab.baseUrl overrides are not permitted/)
  })
})

test('a workspace registered before #3/#5 via the flat wire shape still loads through GET /api/workspaces with a nested location', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    // Simulates a pre-#3 record: written directly in the old flat shape, bypassing registerWorkspace's own current (already-nested) normalization.
    const registryPath = join(instancesDir, 'workspace-registry.json')
    const legacyId = 'legacy-workspace-id'
    writeFileSync(
      registryPath,
      JSON.stringify({ [legacyId]: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, owner: 'c.barlow', ticketingSystem: 'azure-devops' } }, null, 2)
    )

    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    const found = listing.find((w) => w.id === legacyId)
    assert.ok(found, 'the legacy-shaped workspace is still listed')
    assert.equal(found.provider, 'azure-devops')
    assert.deepEqual(found.location, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })
    assert.equal(found.owner, 'c.barlow')
  })
})

// ---------- Backfill via the instance-creation flow ----------

test('registering a new Azure-DevOps-backed instance via POST /api/instances auto-creates its workspace, visible via GET /api/workspaces', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const res = await fetch(`${base}/api/instances`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: JSON.stringify({
              definition: 'design',
              slug: 'my-initiative',
              azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
            }),
          })
          assert.equal(res.status, 201)

          const workspaces = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(workspaces.length, 1)
          assert.equal(workspaces[0].location.organization, ORGANIZATION)
          assert.equal(workspaces[0].location.project, PROJECT)
          assert.equal(workspaces[0].location.repository, REPOSITORY)
          assert.equal(workspaces[0].location.baseUrl, adoBaseUrl)
        }
      )
    }
  )
})

test('adopting an instance at an Azure DevOps location already backing a registered workspace reuses that workspace, not a second one', async () => {
  const seedFiles = {
    '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
    '/modules/context.md': [
      '---',
      'module: context',
      'status: draft',
      'owner: c.barlow',
      '---',
      '',
      '## Problem statement',
      '',
      'Seeded from the fake Azure DevOps repo.',
      '',
      '## Affected domains',
      '',
      '- Payments',
      '',
      '## Out of scope',
      '',
      'Nothing yet.',
      '',
    ].join('\n'),
  }
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedFiles },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const adopt = () =>
            fetch(`${base}/api/instances/adopt`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
              body: JSON.stringify({ azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl } }),
            })

          // Adopting the same location twice (the "come back and re-open it" case, already covered behaviorally by tests/serverAzureDevOpsAdopt.test.js) must not fragment one repo across two workspace ids.
          assert.equal((await adopt()).status, 200)
          assert.equal((await adopt()).status, 200)

          const workspaces = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(workspaces.length, 1)
          assert.equal(workspaces[0].location.repository, REPOSITORY)
        }
      )
    }
  )
})

// ---------- PATCH /api/workspaces/:id (#104: owner viewed/edited, ticketing-system override, from the Settings Workspace tab) ----------

function patchWorkspace(base, id, body) {
  return fetch(`${base}/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('PATCH /api/workspaces/:id updates owner, with no PAT required', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY } }, { instancesDir })

    const res = await patchWorkspace(base, workspace.id, { owner: 'c.barlow' })
    assert.equal(res.status, 200)
    const updated = await res.json()
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(updated.location.organization, ORGANIZATION)

    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.find((w) => w.id === workspace.id).owner, 'c.barlow')
  })
})

test('PATCH /api/workspaces/:id for an unknown id reports 404, not 500', async () => {
  await withScratchServer({}, async (base) => {
    const res = await patchWorkspace(base, 'nonexistent-id', { owner: 'someone' })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /Unknown workspace/)
  })
})

test('PATCH /api/workspaces/:id leaves organization/project/repository untouched — those fields are not accepted by this route', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY } }, { instancesDir })

    const res = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspace.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: 'attacker-org', owner: 'c.barlow' }),
    })
    assert.equal(res.status, 200)
    const updated = await res.json()
    assert.equal(updated.location.organization, ORGANIZATION)
    assert.equal(updated.owner, 'c.barlow')
  })
})

test('PATCH /api/workspaces/:id rejects a non-string owner (e.g. null) with 400, rather than persisting it verbatim', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY }, owner: 'c.barlow' }, { instancesDir })

    const res = await patchWorkspace(base, workspace.id, { owner: null })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /owner must be a string/)

    // Rejected before anything was persisted — the existing owner is untouched.
    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.find((w) => w.id === workspace.id).owner, 'c.barlow')
  })
})

// ---------- #139: nonexistent repository rejection ----------

test('POST /api/workspaces with a nonexistent Azure DevOps repository returns 400 naming the missing repo, and persists nothing', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {}, repoExists: false },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const res = await fetch(`${base}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: postWorkspaceBody({ baseUrl: adoBaseUrl }),
          })
          assert.equal(res.status, 400)
          const body = await res.json()
          assert.match(body.error, /does not exist/)
          assert.match(body.error, /create it in Azure DevOps first/)
          assert.match(body.error, new RegExp(REPOSITORY))

          const listing = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(listing.length, 0)
        }
      )
    }
  )
})

test('POST /api/workspaces with an empty-but-existing Azure DevOps repository still succeeds (empty semantics preserved)', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    async (adoBaseUrl) => {
      await withScratchServer(
        { allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (base) => {
          const res = await fetch(`${base}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: postWorkspaceBody({ baseUrl: adoBaseUrl }),
          })
          assert.equal(res.status, 201)

          const listing = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(listing.length, 1)
          assert.equal(listing[0].location.repository, REPOSITORY)
        }
      )
    }
  )
})
