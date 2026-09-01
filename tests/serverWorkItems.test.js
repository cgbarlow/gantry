import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, VALID_PAT } from './helpers/lifecycle.js'

// HTTP-boundary tests for #95/#103's new routes: POST /api/instance/work-items/link, POST /api/instance/work-items/tag, POST /api/instance/work-items/sync, and the accompanying fix to GET /api/instance/check (previously local-only). Real HTTP requests against a real gantry server and a real (fake, in-process) Azure DevOps server throughout — nothing mocked.

const WI_ORGANIZATION = 'wi-org'
const WI_PROJECT = 'wi-project'



function withFakeWorkItemsServer(fn) {
  return withFakeAzureDevOpsServer({ organization: WI_ORGANIZATION, project: WI_PROJECT, validPat: VALID_PAT }, fn)
}

async function createParentWorkItem(baseUrl) {
  const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
  const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
  return parent.id
}

function withScratchGantryServer(fn) {
  return withFakeWorkItemsServer(async (wiBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      // `allowAzureDevOpsBaseUrlOverride` lets these tests point the real work-items-link route at the fake Azure DevOps server instead of the real dev.azure.com, the same opt-in every other Azure-DevOps-backed HTTP test in this repo already uses (see createServer's own doc comment) — never enabled on a real deployment.
      await withRunningServer(
        { instancesDir, allowedAzureDevOpsBaseUrls: [wiBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (gantryBase) => fn(gantryBase, wiBaseUrl, instancesDir)
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

function fillShapeStage(instancesDir, slug) {
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    cpSync(join('instances', 'examples', 'modules', `${moduleId}.md`), join(instancesDir, slug, 'modules', `${moduleId}.md`))
  }
}

// ---------- GET /api/instance reports workItem ----------

test('GET /api/instance reports workItem as null for an unlinked instance, then the recorded link once linked', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    const before = await (await fetch(`${gantryBase}/api/instance?slug=my-initiative`)).json()
    assert.equal(before.workItem, null)

    const parentId = await createParentWorkItem(wiBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
    })
    assert.equal(linkRes.status, 200)

    const after = await (await fetch(`${gantryBase}/api/instance?slug=my-initiative`)).json()
    assert.equal(after.workItem.parentId, parentId)
    assert.equal(typeof after.workItem.stages.shape, 'number')
  })
})

// ---------- POST /api/instance/work-items/link ----------

test('POST /api/instance/work-items/link with no PAT returns the structured "authentication required" response', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const parentId = await createParentWorkItem(wiBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/instance/work-items/link with a PAT Azure DevOps itself rejects returns the same structured response', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const parentId = await createParentWorkItem(wiBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-real-pat') },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/instance/work-items/link with missing fields reports 400, not 500', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: WI_ORGANIZATION }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Missing required field\(s\): project, parentId/)
  })
})

test('POST /api/instance/work-items/link succeeds, creating one child work item per stage and recording the link', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const parentId = await createParentWorkItem(wiBaseUrl)

    const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.parentId, parentId)
    assert.equal(body.workItemType, 'Task')
    assert.deepEqual(Object.keys(body.stages).sort(), ['detailed-design', 'handover', 'hld-define', 'shape'])

    const instance = readInstance('my-initiative', { instancesDir })
    assert.deepEqual(instance.workItem, body)
  })
})

test('POST /api/instance/work-items/link makes the link visible when browsing a not-yet-branched stage of a Workspace-backed instance', async () => {
  const organization = 'workspace-org'
  const project = 'workspace-project'
  const repository = 'workspace-repo'
  const slug = 'remote-initiative'

  await withFakeAzureDevOpsServer(
    {
      organization,
      project,
      repository,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          slug,
          { kind: 'azureDevOps', organization, project, repository, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        const workItems = createAzureDevOpsWorkItemsClient({ organization, project, pat: VALID_PAT, baseUrl: adoBaseUrl })
        const parentId = (await workItems.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })).id

        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (gantryBase) => {
            const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=${slug}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
              body: JSON.stringify({ organization, project, parentId, baseUrl: adoBaseUrl }),
            })
            assert.equal(linkRes.status, 200)
            const link = await linkRes.json()

            const git = createAzureDevOpsClient({ organization, project, repository, pat: VALID_PAT, baseUrl: adoBaseUrl })
            assert.equal(await git.branchExists(`gantry-workspace/${slug}/hld-define`), false)

            const switched = await fetch(`${gantryBase}/api/instance?slug=${slug}&stage=hld-define`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.equal(switched.status, 200)
            assert.deepEqual((await switched.json()).workItem, link)
          }
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('POST /api/instance/work-items/link reports 409 for an instance already linked', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const parentId = await createParentWorkItem(wiBaseUrl)
    const linkBody = JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl })

    const first = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: linkBody,
    })
    assert.equal(first.status, 200)

    const second = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: linkBody,
    })
    assert.equal(second.status, 409)
    const body = await second.json()
    assert.match(body.error, /already linked/)
  })
})

// ---------- POST /api/instance/work-items/tag ----------

test('POST /api/instance/work-items/tag reports backfill counts and preserves unrelated parent work items', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const parentId = await createParentWorkItem(wiBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
    })
    const link = await linkRes.json()
    const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl: wiBaseUrl })
    for (const workItemId of Object.values(link.stages)) {
      await client.updateWorkItem(workItemId, { 'System.Tags': 'ready-for-agent; bug' })
    }

    const first = await fetch(`${gantryBase}/api/instance/work-items/tag?slug=my-initiative`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), {
      slug: 'my-initiative',
      workItemIds: Object.keys(link.stages).sort().map((k) => link.stages[k]),
      updated: 4,
      alreadyTagged: 0,
    })
    assert.equal((await client.getWorkItem(parentId)).fields['System.Tags'], undefined)

    const second = await fetch(`${gantryBase}/api/instance/work-items/tag?slug=my-initiative`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.updated, 0)
    assert.equal(secondBody.alreadyTagged, 4)
  })
})

test('POST /api/work-items/tag backfills every registered linked instance', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    const links = []
    for (const slug of ['first-initiative', 'second-initiative']) {
      createInstance('design', slug, { instancesDir })
      const parentId = await createParentWorkItem(wiBaseUrl)
      const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
        body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
      })
      links.push(await linkRes.json())
    }
    createInstance('design', 'unlinked-initiative', { instancesDir })

    const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl: wiBaseUrl })
    for (const link of links) {
      for (const workItemId of Object.values(link.stages)) {
        await client.updateWorkItem(workItemId, { 'System.Tags': 'ready-for-agent' })
      }
    }

    const res = await fetch(`${gantryBase}/api/work-items/tag`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.updated, 8)
    assert.equal(body.alreadyTagged, 0)
    assert.deepEqual(body.failed, [])
    assert.deepEqual(body.instances.map((instance) => instance.slug), ['first-initiative', 'second-initiative'])
  })
})

// ---------- POST /api/instance/work-items/sync ----------

test('POST /api/instance/work-items/sync with no PAT returns the structured "authentication required" response', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/instance/work-items/sync reports 400 when the gate has not passed yet', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const parentId = await createParentWorkItem(wiBaseUrl)
    await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
    })

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /has not passed/)
  })
})

test('POST /api/instance/work-items/sync reports 400 for an unlinked instance', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not linked/)
  })
})

test('POST /api/instance/work-items/sync pushes a real state to the stage\'s work item once the gate passes (the confirmed push)', async () => {
  await withScratchGantryServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')
    const parentId = await createParentWorkItem(wiBaseUrl)
    const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: WI_ORGANIZATION, project: WI_PROJECT, parentId, baseUrl: wiBaseUrl }),
    })
    const link = await linkRes.json()

    const res = await fetch(`${gantryBase}/api/instance/work-items/sync?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.workItemId, link.stages.shape)
    assert.equal(body.workItem.fields['System.State'], body.state)

    // A direct client call against the fake server confirms the state genuinely changed there — not merely echoed back in the response.
    const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl: wiBaseUrl })
    const updated = await client.updateWorkItem(link.stages.shape, {})
    assert.equal(updated.fields['System.State'], body.state)
  })
})

// ---------- GET /api/instance/check regression fix: Azure-DevOps-backed instances ----------

test('GET /api/instance/check now actually checks an Azure-DevOps-backed instance, instead of silently checking a local directory it never lived in', async () => {
  const ORGANIZATION = 'fake-org'
  const PROJECT = 'fake-project'
  const REPOSITORY = 'fake-repo'
  const GIT_PAT = 'valid-git-pat'

  const seedFiles = { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    seedFiles[`/gantry-workspace/my-initiative/modules/${moduleId}.md`] = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: GIT_PAT, files: seedFiles },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (gantryBase) => {
            registerInstance(
              'my-initiative',
              { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
              { instancesDir }
            )

            // No PAT — the structured "authentication required" response, proving this route now actually gates on Azure DevOps credentials for a registry-resolved Azure-DevOps-backed slug, rather than reading (or missing) a local directory.
            const unauthed = await fetch(`${gantryBase}/api/instance/check?slug=my-initiative`)
            assert.equal(unauthed.status, 401)
            const unauthedBody = await unauthed.json()
            assert.equal(unauthedBody.error, 'authentication_required')

            const res = await fetch(`${gantryBase}/api/instance/check?slug=my-initiative`, {
              headers: { Authorization: basicAuthHeader(GIT_PAT) },
            })
            assert.equal(res.status, 200)
            const body = await res.json()
            assert.equal(body.pass, true)
            assert.equal(body.gate, 'business-case')
          }
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})
