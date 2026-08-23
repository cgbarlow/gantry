import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// GET/POST /api/workspaces (#96): the HTTP-API-boundary half of the
// workspace registry's own acceptance criteria — exercised as real HTTP
// requests against a real running server, mirroring every other server
// test in this suite.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

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

test('POST /api/workspaces rejects ticketingSystem "jira" with 400 — modeled but not accepted yet, checked before any credential/network step', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postWorkspaceBody({ ticketingSystem: 'jira' }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet/)

    // Rejected globally, not just per-workspace — nothing was persisted.
    const listing = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
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
// Registering a workspace *establishes* an Azure DevOps location, exactly
// as POST /api/instances and POST /api/instances/adopt already do — so,
// like those routes, it must require the caller's own PAT and actually
// verify it against the real location, not merely accept any caller's
// say-so for an arbitrary organization/project/repository.

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

          // A caller who can't prove access to this org/project/repository
          // must not be able to plant a workspace record (with a
          // spoofed `owner`, for instance) for it.
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
          assert.equal(created.organization, ORGANIZATION)
          assert.equal(created.project, PROJECT)
          assert.equal(created.repository, REPOSITORY)
          assert.equal(created.baseUrl, adoBaseUrl)
          assert.equal(created.owner, 'c.barlow')
          assert.equal(created.ticketingSystem, 'azure-devops')
          assert.equal(typeof created.id, 'string')

          const listing = await (await fetch(`${base}/api/workspaces`)).json()
          assert.ok(listing.some((w) => w.id === created.id))
        }
      )
    }
  )
})

test('POST /api/workspaces defaults ticketingSystem to "azure-devops" when omitted', async () => {
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
          const body = await res.json()
          assert.equal(body.ticketingSystem, 'azure-devops')
        }
      )
    }
  )
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
          assert.equal(workspaces[0].organization, ORGANIZATION)
          assert.equal(workspaces[0].project, PROJECT)
          assert.equal(workspaces[0].repository, REPOSITORY)
          assert.equal(workspaces[0].baseUrl, adoBaseUrl)
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
      '## Business driver',
      '',
      'Seeded from the fake Azure DevOps repo.',
      '',
      '## Affected domains',
      '',
      '- Payments',
      '',
      '## Explicitly out of scope',
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

          // Adopting the same location twice (the "come back and re-open
          // it" case, already covered behaviorally by
          // tests/serverAzureDevOpsAdopt.test.js) must not fragment one
          // repo across two workspace ids.
          assert.equal((await adopt()).status, 200)
          assert.equal((await adopt()).status, 200)

          const workspaces = await (await fetch(`${base}/api/workspaces`)).json()
          assert.equal(workspaces.length, 1)
          assert.equal(workspaces[0].repository, REPOSITORY)
        }
      )
    }
  )
})
