import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// HTTP-boundary tests for #125's new route: POST /api/instance/check-status
// (the explicitly-triggered "Check status" action for a Workspace-backed
// instance, ADR-0014). Real HTTP requests against a real running gantry
// server and a real (fake, in-process) Azure DevOps server throughout,
// mirroring tests/serverStageApproval.test.js's own conventions.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SLUG = 'remote-initiative'

const definition = loadDefinition('design')
const [SHAPE] = definition.stages

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

async function fillShapeStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    const text = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
}

async function castVote(adoBaseUrl, pullRequestId, vote) {
  const res = await fetch(
    `${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`,
    {
      method: 'PUT',
      headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'The Owner', vote }),
    }
  )
  assert.equal(res.status, 200)
}

test('POST /api/instance/check-status rejects a local instance outright, never requiring a PAT', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/check-status?slug=some-local-instance`, { method: 'POST' })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /not Workspace-backed/)
    })
  })
})

test('POST /api/instance/check-status with no PAT returns the structured "authentication required" response', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST' })
          assert.equal(res.status, 401)
          const body = await res.json()
          assert.equal(body.error, 'authentication_required')
        })
      })
    }
  )
})

test('POST /api/instance/check-status reports 400 when approval has never been requested for the stage', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 400)
          const body = await res.json()
          assert.match(body.error, /has no Pull Request open requesting approval for stage "shape"/)
        })
      })
    }
  )
})

test('POST /api/instance/check-status detects the Owner approval, merges the Pull Request and advances the stage', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
        await fillShapeStage(azureDevOps, branch)

        await withRunningServer({ instancesDir }, async (base) => {
          const opened = await (
            await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, {
              method: 'POST',
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
          ).json()
          assert.equal(opened.status, 'active')

          // Still pending before the Owner does anything.
          await castVote(adoBaseUrl, opened.pullRequestId, 0)
          const pending = await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(pending.status, 200)
          const pendingBody = await pending.json()
          assert.equal(pendingBody.review.state, 'pending')
          assert.equal(pendingBody.merged, false)

          // The Owner approves in Azure DevOps itself…
          await castVote(adoBaseUrl, opened.pullRequestId, 10)

          // …and one explicit Check status resolves everything.
          const res = await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.review.state, 'approved')
          assert.equal(body.merged, true)
          assert.equal(body.prStatus, 'completed')
          assert.equal(body.advancedTo.id, 'hld-define')

          // The instance screen now shows the advanced stage without any further write.
          const instance = await (
            await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          ).json()
          assert.equal(instance.currentStageId, 'hld-define')
          assert.equal(instance.stage.id, 'hld-define')
        })
      })
    }
  )
})
