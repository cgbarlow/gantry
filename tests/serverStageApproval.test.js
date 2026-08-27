import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// HTTP-boundary tests for #124's new route: POST /api/instance/request-approval
// (the Assignee's "Request approval" action for a Workspace-backed instance,
// ADR-0014), plus GET /api/instance's accompanying `pullRequests` field.
// Real HTTP requests against a real running gantry server and a real (fake,
// in-process) Azure DevOps server throughout, mirroring
// tests/serverStageAdvancement.test.js's/tests/serverWorkItems.test.js's own
// conventions.

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
  for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
    const text = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/soap.docx`, 'rendered soap', { branch })
}

test('POST /api/instance/request-approval rejects a local instance outright, never requiring a PAT', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/request-approval?slug=my-initiative`, { method: 'POST' })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /not Workspace-backed/)
    })
  })
})

test('POST /api/instance/request-approval with no PAT returns the structured "authentication required" response', async () => {
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
          const res = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST' })
          assert.equal(res.status, 401)
          const body = await res.json()
          assert.equal(body.error, 'authentication_required')
        })
      })
    }
  )
})

test('POST /api/instance/request-approval reports 400 (not 500) when the stage has no branch yet', async () => {
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
          const res = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 400)
          const body = await res.json()
          assert.match(body.error, /has no branch for stage "shape" yet/)
        })
      })
    }
  )
})

test('POST /api/instance/request-approval reports 400 when the gate has not passed yet', async () => {
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
        // Work has begun on the branch, but no module content was saved — the gate can't pass.
        await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)

        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 400)
          const body = await res.json()
          assert.match(body.error, /has not passed/)
        })
      })
    }
  )
})

test('POST /api/instance/request-approval opens a Pull Request once the gate has passed, and GET /api/instance reflects it afterward', async () => {
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
          const before = await (
            await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          ).json()
          assert.deepEqual(before.pullRequests, {})

          const res = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.stage.id, 'shape')
          assert.equal(body.branch, branch)
          assert.equal(typeof body.pullRequestId, 'number')
          assert.equal(body.status, 'active')

          const after = await (
            await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          ).json()
          assert.equal(after.pullRequests.shape, body.pullRequestId)
          assert.equal(after.pullRequest.id, body.pullRequestId)
          assert.equal(Array.isArray(after.pullRequest.commits), true)
          assert.equal(after.pullRequest.commits.length > 0, true)

          // A second request for the same stage is a genuine conflict, not a silent no-op.
          const second = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(second.status, 400)
          const secondBody = await second.json()
          assert.match(secondBody.error, /already has a Pull Request/)
        })
      })
    }
  )
})

test('POST /api/instance/request-approval identifies a rejected PAT during required-reviewer resolution', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      rejectIdentityRequests: true,
      files: {
        [`/gantry-workspace/${SLUG}/instance.yaml`]:
          `definition: design\nslug: ${SLUG}\nstage: shape\nrequiredReviewer: testuser@example.com\n`,
      },
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
          const res = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          const body = await res.json()
          assert.equal(res.status, 401, JSON.stringify(body))
          assert.equal(body.credentialRejected, true)
          assert.equal(body.credentialStatus, 'rejected')
          assert.equal(body.operation, 'resolving the required reviewer for Request Approval')
          assert.match(body.message, /required reviewer for Request Approval/)
          assert.match(body.message, /Identity \(Read\)/)
        })
      })
    }
  )
})
