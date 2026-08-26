import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { getStageSyncedFields } from '../lib/syncedFields.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// HTTP-boundary tests for #111's synced-fields panel routes: GET and PUT
// /api/instance/synced-fields. Real HTTP requests against a real running
// gantry server (local scratch instances) and a real (fake, in-process)
// Azure DevOps server (the Workspace-backed cases), mirroring
// tests/serverStageStatus.test.js's own conventions.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SLUG = 'remote-initiative'

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

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return (async () => fn(instancesDir))().finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

test('GET synced-fields for an unlinked local instance reports the defaults and needs no PAT', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: '' })

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/synced-fields?slug=my-initiative`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.linked, false)
      // Type defaults to Task; title defaults to "{instance name} — {stage title}"; nothing is overridden yet.
      assert.equal(body.type, 'Task')
      assert.equal(body.title, 'my-initiative — Shape')
      assert.equal(body.titleOverridden, false)
      assert.equal(body.workItemId, null)
      assert.equal(body.workItemState, null)
      assert.equal(body.pullRequest, null)
      assert.equal(body.assignee, '')
      assert.equal(body.assigneeInherited, true)
    })
  })
})

test('PUT synced-fields overrides the title and assignee per stage, and clearing them restores the defaults', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'Ada Lovelace' })

    await withRunningServer({ instancesDir }, async (base) => {
      const put = (body) =>
        fetch(`${base}/api/instance/synced-fields?slug=my-initiative`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

      let res = await put({ title: 'Shape it', assignee: 'Grace Hopper' })
      assert.equal(res.status, 200)
      let body = await res.json()
      assert.equal(body.title, 'Shape it')
      assert.equal(body.titleOverridden, true)
      assert.equal(body.assignee, 'Grace Hopper')
      assert.equal(body.assigneeInherited, false)

      // Genuinely persisted on the instance record, not just echoed back.
      const stored = readInstance('my-initiative', { instancesDir })
      assert.deepEqual(stored.syncedFields.shape, { title: 'Shape it', assignee: 'Grace Hopper' })

      // Clearing an override with an empty string restores the default/inherited value.
      res = await put({ title: '', assignee: '' })
      assert.equal(res.status, 200)
      body = await res.json()
      assert.equal(body.title, 'my-initiative — Shape')
      assert.equal(body.titleOverridden, false)
      assert.equal(body.assignee, 'Ada Lovelace')
      assert.equal(body.assigneeInherited, true)

      // A PUT with nothing to save is rejected outright.
      res = await put({})
      assert.equal(res.status, 400)

      // So is a non-string value.
      res = await put({ title: 42 })
      assert.equal(res.status, 400)
    })
  })
})

test('GET synced-fields for a linked local instance without a PAT returns the structured "authentication required" response', async () => {
  await withFakeAzureDevOpsServer(
    { organization: 'wi-org', project: 'wi-project', repository: 'wi-repo', validPat: VALID_PAT },
    async (wiBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        createInstance('design', 'my-initiative', { instancesDir })
        const instancePath = join(instancesDir, 'my-initiative', 'instance.yaml')
        const current = readFileSync(instancePath, 'utf8')
        const wiClient = createAzureDevOpsWorkItemsClient({
          organization: 'wi-org',
          project: 'wi-project',
          pat: VALID_PAT,
          baseUrl: wiBaseUrl,
        })
        const parent = await wiClient.createWorkItem('Feature', { 'System.Title': 'Parent' })
        const child = await wiClient.createChildWorkItem(parent.id, 'Task', { 'System.Title': 'Shape — my-initiative' })
        // Minimal link block pointing at the fake Work Items server — the same purely-descriptive shape instance.yaml already uses.
        const workItem = `workItem:\n  organization: wi-org\n  project: wi-project\n  workItemType: Task\n  parentId: ${parent.id}\n  baseUrl: ${wiBaseUrl}\n  stages:\n    shape: ${child.id}\n`
        writeFileSync(instancePath, `${current}${workItem}`)

        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/synced-fields?slug=my-initiative`)
          assert.equal(res.status, 401)
          const body = await res.json()
          assert.equal(body.error, 'authentication_required')

          // With a PAT the panel reads the stage child work item's own state straight from Azure DevOps (#121).
          const authed = await fetch(`${base}/api/instance/synced-fields?slug=my-initiative`, {
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(authed.status, 200)
          const fields = await authed.json()
          assert.equal(fields.linked, true)
          assert.equal(fields.workItemId, child.id)
          assert.equal(fields.workItemState, 'New')
          assert.equal(fields.pullRequest, null)
        })
      })
    }
  )
})

test('GET synced-fields on a Workspace-backed instance reads the work-item state, PR state and overrides', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const ado = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }

      const wiClient = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
      const parent = await wiClient.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
      const shape = await wiClient.createChildWorkItem(parent.id, 'Task', {
        'System.Title': 'Shape — remote-initiative',
        'System.State': 'Active',
      })

      const prClient = createAzureDevOpsPullRequestsClient(ado)
      const pr = await prClient.createPullRequest({
        sourceBranch: 'gantry-workspace/remote-initiative/shape',
        targetBranch: 'main',
        title: 'Stage approval: Shape',
      })
      // One reviewer at no-vote: a still-pending review.
      await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pr.pullRequestId}/reviewers/owner-1`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'The Owner', vote: 0 }),
      })

      // Seed the full instance record — link, pull request id and a title override — onto main.
      const yaml = [
        `definition: design`,
        `slug: ${SLUG}`,
        `stage: shape`,
        `assignee: Ada Lovelace`,
        `syncedFields:`,
        `  shape:`,
        `    title: Custom shape title`,
        `workItem:`,
        `  organization: ${ORGANIZATION}`,
        `  project: ${PROJECT}`,
        `  workItemType: Task`,
        `  parentId: ${parent.id}`,
        `  baseUrl: ${adoBaseUrl}`,
        `  stages:`,
        `    shape: ${shape.id}`,
        `pullRequests:`,
        `  shape: ${pr.pullRequestId}`,
        '',
      ].join('\n')
      const git = createAzureDevOpsClient(ado)
      await git.writeFile(`gantry-workspace/${SLUG}/instance.yaml`, yaml, {})

      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/synced-fields?slug=${SLUG}`, {
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.linked, true)
          assert.equal(body.type, 'Task')
          assert.equal(body.title, 'Custom shape title')
          assert.equal(body.titleOverridden, true)
          assert.equal(body.workItemId, shape.id)
          assert.equal(body.workItemState, 'Active')
          assert.equal(body.pullRequest.id, pr.pullRequestId)
          assert.equal(body.pullRequest.status, 'active')
          assert.equal(body.pullRequest.reviewState, 'pending')
          assert.equal(body.assignee, 'Ada Lovelace')
          assert.equal(body.assigneeInherited, true)

          // The Owner approves in Azure DevOps itself — one reload of the panel reflects it.
          await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pr.pullRequestId}/reviewers/owner-1`, {
            method: 'PUT',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
          })
          const after = await (
            await fetch(`${base}/api/instance/synced-fields?slug=${SLUG}`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
          ).json()
          assert.equal(after.pullRequest.reviewState, 'approved')

          // Saving an override goes through the stage's own branch lifecycle (#122)…
          const putRes = await fetch(`${base}/api/instance/synced-fields?slug=${SLUG}`, {
            method: 'PUT',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignee: 'Grace Hopper' }),
          })
          assert.equal(putRes.status, 200)
          const saved = await putRes.json()
          assert.equal(saved.assignee, 'Grace Hopper')
          assert.equal(saved.assigneeInherited, false)

          // …and the panel then reads back from that branch copy, so the override survives.
          const reread = await (
            await fetch(`${base}/api/instance/synced-fields?slug=${SLUG}`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
          ).json()
          assert.equal(reread.assignee, 'Grace Hopper')
          assert.equal(reread.title, 'Custom shape title')
        })
      })
    }
  )
})

test('getStageSyncedFields recovers a Workspace work-item link from another stage branch and writes it back to main', async () => {
  const workItem = {
    organization: ORGANIZATION,
    project: PROJECT,
    workItemType: 'Task',
    parentId: 41,
    stages: { shape: 42, 'hld-define': 43 },
  }
  const mainYaml = `definition: design\nslug: ${SLUG}\nstage: shape\n`

  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: mainYaml },
    },
    async (adoBaseUrl) => {
      const azureDevOps = {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        pat: VALID_PAT,
        baseUrl: adoBaseUrl,
      }
      const shapeBranch = `gantry-workspace/${SLUG}/shape`
      const shapeYaml = `${mainYaml}workItem:\n  organization: ${ORGANIZATION}\n  project: ${PROJECT}\n  workItemType: Task\n  parentId: 41\n  baseUrl: ${adoBaseUrl}\n  stages:\n    shape: 42\n    hld-define: 43\n`
      const git = createAzureDevOpsClient(azureDevOps)
      await git.createBranch(shapeBranch, { from: 'main' })
      await git.writeFile(`gantry-workspace/${SLUG}/instance.yaml`, shapeYaml, { branch: shapeBranch })
      workItem.baseUrl = adoBaseUrl

      const fields = await getStageSyncedFields(SLUG, { azureDevOps, stageId: 'hld-define' })
      assert.equal(fields.linked, true)
      assert.equal(fields.workItemId, 43)
      assert.deepEqual((await readInstance(SLUG, { azureDevOps })).workItem, workItem)
    }
  )
})
