import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// POST /api/instances/adopt (#94, under #88): registers an Azure-DevOps-backed location the setup wizard's own repo-check (#90) already found instance data at, so the module editor's per-request registry lookup (#92) can resolve it afterward — without writing anything, unlike POST /api/instances' create-and-register path (#93). Backed by the same in-process fake Azure DevOps server used throughout #84-#94 — never a real dev.azure.com.


const SEED_FILES = {
  '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\nassignee: c.barlow\n',
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



function withFakeAzureDevOpsAndGantryServer(files, serverOptions, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, async (adoBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      await withRunningServer(
        { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true, ...serverOptions },
        async (gantryBase) => fn(gantryBase, adoBaseUrl, instancesDir)
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

function adoptBody(adoBaseUrl) {
  return JSON.stringify({ azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl } })
}

// ---------- No / rejected PAT ----------

test('POST /api/instances/adopt with no PAT returns the structured "authentication required" response', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, {}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/instances/adopt with a PAT Azure DevOps itself rejects returns the same structured response', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, {}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-real-pat') },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

// ---------- Validation ----------

test('POST /api/instances/adopt with missing azureDevOps fields reports 400, not 500', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, {}, async (gantryBase) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ azureDevOps: { organization: ORGANIZATION } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: project, repository/)
  })
})

test('POST /api/instances/adopt with an azureDevOps.baseUrl reports 400 on a server that has not opted into allowAzureDevOpsBaseUrlOverride', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, { allowAzureDevOpsBaseUrlOverride: false }, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /baseUrl/)
  })
})

// ---------- Nothing to adopt ----------

test('POST /api/instances/adopt against a repo with no instance.yaml yet reports 400, not a silent no-op', async () => {
  await withFakeAzureDevOpsAndGantryServer({}, {}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /No instance data/)
  })
})

// #100: adopting a location that already holds more than one instance under gantry-workspace/<slug>/ is a distinct, honest 400 (this route has no slug input to say which one to adopt) — never silently treated as "nothing to adopt" (that would be misleading: data genuinely is there), and never guessed at.
test('POST /api/instances/adopt against a repo already holding more than one instance reports 400 naming them, and registers nothing', async () => {
  const filesWithTwoInstances = {
    '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
    '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
  }
  await withFakeAzureDevOpsAndGantryServer(filesWithTwoInstances, {}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /more than one instance/)
    assert.match(body.error, /alpha-initiative/)
    assert.match(body.error, /beta-initiative/)

    const listing = await (await fetch(`${gantryBase}/api/instances`)).json()
    assert.equal(listing.length, 0)
  })
})

// ---------- Successful adoption ----------

test('POST /api/instances/adopt against a repo with an existing instance registers it (without writing anything), and it becomes resolvable/listed', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, {}, async (gantryBase, adoBaseUrl, instancesDir) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'my-initiative')
    assert.equal(body.definition, 'design')
    assert.equal(body.stage, 'shape')
    assert.equal(body.status, 'incomplete')
    assert.equal(body.assignee, 'c.barlow')
    // An Azure-DevOps-backed row carries its workspace (#96/#102).
    assert.equal(body.workspace.organization, ORGANIZATION)
    assert.equal(body.workspace.repository, REPOSITORY)

    // Genuinely registered — resolvable by the single-instance routes (#92), not merely reported back in this one response.
    const instanceRes = await fetch(`${gantryBase}/api/instance?slug=my-initiative`, {
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(instanceRes.status, 200)
    const instanceBody = await instanceRes.json()
    assert.equal(instanceBody.slug, 'my-initiative')

    // Listed alongside every other instance.
    const listing = await (await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
    assert.ok(listing.some((i) => i.slug === 'my-initiative'))

    // No local directory was created — this only registered a location, never wrote instance data anywhere.
    assert.equal(existsSync(join(instancesDir, 'my-initiative')), false)
  })
})

test('POST /api/instances/adopt is idempotent for a slug already adopted to this exact location', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, {}, async (gantryBase, adoBaseUrl) => {
    const makeRequest = () =>
      fetch(`${gantryBase}/api/instances/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
        body: adoptBody(adoBaseUrl),
      })

    const first = await makeRequest()
    assert.equal(first.status, 200)

    // A second adopt of the exact same location (the "come back and open it again" case) must succeed identically, not report a conflict.
    const second = await makeRequest()
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.slug, 'my-initiative')
  })
})

test('POST /api/instances/adopt reports 409 when the found slug is already registered to a different location, and does not repoint the registry', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, {}, async (gantryBase, adoBaseUrl, instancesDir) => {
    // "my-initiative" already exists as a genuine *local* instance under this same slug before the adopt is ever attempted.
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'local-assignee' })

    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /already exists/)

    // The pre-existing local registry entry must be untouched.
    const listing = await (await fetch(`${gantryBase}/api/instances`)).json()
    const local = listing.find((i) => i.slug === 'my-initiative')
    assert.deepEqual(
      (({ slug, definition, stage, status, assignee, workspaceNumber, instanceNumber, ref }) => ({
        slug,
        definition,
        stage,
        status,
        assignee,
        workspaceNumber,
        instanceNumber,
        ref,
      }))(local),
      {
        slug: 'my-initiative',
        definition: 'design',
        stage: 'shape',
        status: 'incomplete',
        assignee: 'local-assignee',
        workspaceNumber: 0,
        instanceNumber: 1,
        ref: 'w0i1',
      }
    )
    assert.deepEqual(
      { stageNumber: local.stageNumber, stageCount: local.stageCount, stageTitle: local.stageTitle, pullRequestId: local.pullRequestId },
      { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null }
    )
    assert.doesNotThrow(() => new Date(local.updatedAt).toISOString())
  })
})

test('POST /api/instances/adopt reports 400 when the found instance.yaml has no slug set', async () => {
  const filesWithNoSlug = { ...SEED_FILES, '/instance.yaml': 'definition: design\nstage: shape\n' }
  await withFakeAzureDevOpsAndGantryServer(filesWithNoSlug, {}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /no slug/)
  })
})

// Regression test found in review: the found instance's slug comes from the *target repo's own* instance.yaml — unsanitized third-party content, unlike every other registration path's slug (always client-supplied and already validated, e.g. POST /api/instances' create path). A malformed value (containing a path separator, or exactly "." / "..") must be rejected here too, the same way isValidSlug already guards every client-supplied slug elsewhere — otherwise it would register successfully but become a permanent, unremovable (no unregister route exists) entry in the shared dashboard listing that can never actually be opened, since every single-instance route's own resolveSlugParam rejects such a slug the moment anyone tries to load it.
test('POST /api/instances/adopt reports 400 when the found instance.yaml has a malformed (path-like) slug, and does not register it', async () => {
  const filesWithBadSlug = { ...SEED_FILES, '/instance.yaml': 'definition: design\nslug: ../evil\nstage: shape\n' }
  await withFakeAzureDevOpsAndGantryServer(filesWithBadSlug, {}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: adoptBody(adoBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /invalid slug/)

    // Nothing was registered — the malformed entry never reaches the shared listing at all.
    const listing = await (await fetch(`${gantryBase}/api/instances`)).json()
    assert.equal(listing.length, 0)
  })
})
