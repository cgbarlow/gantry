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
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SLUG = 'remote-initiative'

const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE, DETAILED_DESIGN] = definition.stages

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
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

async function withRunningServer(options, fn) {
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

test('POST /api/instance/stage/reopen re-opens a completed stage: branch recreated from main, stage moved back, reopened marker, prior PR intact', async () => {
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
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const client = createAzureDevOpsClient(azureDevOps)
        const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
        await fillShapeStage(azureDevOps, branch)

        await withRunningServer({ instancesDir }, async (base) => {
          // Request approval and complete it to advance to hld-define
          const reqRes = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(reqRes.status, 200)
          const reqBody = await reqRes.json()
          const prId = reqBody.pullRequestId
          // Owner approves
          const voteRes = await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${prId}/reviewers/owner-1`, {
            method: 'PUT',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ vote: 10 }),
          })
          assert.equal(voteRes.status, 200)
          const checkRes = await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(checkRes.status, 200)
          const checkBody = await checkRes.json()
          assert.equal(checkBody.merged, true)
          assert.equal(checkBody.advancedTo.id, 'hld-define')

          // Verify instance now at hld-define and shape branch still exists? After PR, branch still exists in fake server but instance advanced
          const beforeReopen = await (await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(beforeReopen.currentStageId, 'hld-define')
          assert.equal(beforeReopen.pullRequests.shape, prId)

          // Delete shape branch to simulate completed stage has no branch (as after merge cleanup would)
          // Our fake server doesn't auto-delete, so we simulate by deleting via refs API manually? Instead we can just check that reopen will 409 if branch exists — so we need to delete it first to allow reopen.
          // Use refs delete: we need to find a way — the fake server's POST /refs with zero newObjectId deletes.
          // Easiest: use createAzureDevOpsClient's internal fetch to delete? We'll call the refs endpoint directly.
          const branchName = `gantry-workspace/${SLUG}/shape`
          const existsBefore = await client.branchExists(branchName)
          // If branch still exists, reopen should 409 — delete it to test success path
          if (existsBefore) {
            const baseUrl = adoBaseUrl.replace(/\/+$/, '')
            const repoUrl = `${baseUrl}/${encodeURIComponent(ORGANIZATION)}/${encodeURIComponent(PROJECT)}/_apis/git/repositories/${encodeURIComponent(REPOSITORY)}`
            const url = new URL(`${repoUrl}/refs`)
            url.searchParams.set('api-version', '7.1')
            const oid = await client.getBranchObjectId(branchName)
            await fetch(url.toString(), {
              method: 'POST',
              headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
              body: JSON.stringify([{ name: `refs/heads/${branchName}`, oldObjectId: oid, newObjectId: '0'.repeat(40) }]),
            })
            assert.equal(await client.branchExists(branchName), false)
          }

          // Re-open shape
          const reopenRes = await fetch(`${base}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape' }),
          })
          const reopenText = await reopenRes.text()
          assert.equal(reopenRes.status, 200, reopenText)
          const reopenBody = JSON.parse(reopenText)
          assert.equal(reopenBody.branch, 'gantry-workspace/remote-initiative/shape')
          assert.equal(reopenBody.previousStage, 'hld-define')
          assert.ok(reopenBody.reopened)

          // Verify instance.yaml now has stage = shape and reopened marker
          const after = await (await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(after.currentStageId, 'shape')
          assert.equal(after.stage.id, 'shape')
          assert.ok(after.reopened.shape)
          assert.equal(after.reopened.shape.previousStage, 'hld-define')
          assert.equal(after.pullRequests.shape, prId, 'prior approval records intact')
          // Branch recreated from main
          assert.equal(await client.branchExists('gantry-workspace/remote-initiative/shape'), true)
          const commits = await client.listBranchCommits('gantry-workspace/remote-initiative/shape', { compareTo: 'main' })
          // The re-open commit should be on stage branch
          const hasReopenCommit = commits.some((c) => c.comment && c.comment.includes("Re-open stage 'shape'"))
          assert.equal(hasReopenCommit, true)

          // Edit + requestStageApproval should open fresh PR
          const edited = readFileSync(join('instances', 'examples', 'modules', 'background.md'), 'utf8') + '\nLate edit after reopen.\n'
          await client.writeFile('gantry-workspace/remote-initiative/modules/background.md', edited, { branch: 'gantry-workspace/remote-initiative/shape' })
          const secondReq = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          const secondText = await secondReq.text()
          assert.equal(secondReq.status, 200, secondText)
          const secondBody = JSON.parse(secondText)
          assert.notEqual(secondBody.pullRequestId, prId)
        })
      })
    }
  )
})

test('POST /api/instance/stage/reopen guard: later stage in progress (branch exists) rejects with 4xx', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: hld-define\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const client = createAzureDevOpsClient(azureDevOps)
        // shape was completed, instance at hld-define, create branch for detailed-design to simulate later in progress
        await client.createBranch('gantry-workspace/remote-initiative/shape')
        await client.createBranch('gantry-workspace/remote-initiative/hld-define')
        await client.createBranch('gantry-workspace/remote-initiative/detailed-design')
        // Delete shape branch so reopen would technically be possible if not for later branch
        // But we want shape reopen to be blocked because detailed-design branch exists (later stage)
        // To allow test to hit guard, we need shape branch deleted so first check passes to later guard; else it would 409 for already exists.
        // Delete shape branch
        const oid = await client.getBranchObjectId('gantry-workspace/remote-initiative/shape')
        const baseUrl = adoBaseUrl.replace(/\/+$/, '')
        const repoUrl = `${baseUrl}/${encodeURIComponent(ORGANIZATION)}/${encodeURIComponent(PROJECT)}/_apis/git/repositories/${encodeURIComponent(REPOSITORY)}`
        const refsUrl = new URL(`${repoUrl}/refs`)
        refsUrl.searchParams.set('api-version', '7.1')
        await fetch(refsUrl.toString(), {
          method: 'POST',
          headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
          body: JSON.stringify([{ name: 'refs/heads/gantry-workspace/remote-initiative/shape', oldObjectId: oid, newObjectId: '0'.repeat(40) }]),
        })
        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape' }),
          })
          assert.equal(res.status, 409)
          const body = await res.json()
          assert.match(body.error, /already in progress/)
          assert.match(body.error, /hld-define/)
        })
      })
    }
  )
})

test('POST /api/instance/stage/reopen guard: advanced more than one stage past rejects', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: detailed-design\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape' }),
          })
          assert.equal(res.status, 409)
          const body = await res.json()
          assert.match(body.error, /already in progress/)
          assert.match(body.error, /hld-define/)
        })
      })
    }
  )
})

test('completing re-opened stage clears marker and re-advances', async () => {
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
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const client = createAzureDevOpsClient(azureDevOps)
        // Initial approval to advance to hld-define
        let branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
        await fillShapeStage(azureDevOps, branch)
        await withRunningServer({ instancesDir }, async (base) => {
          const reqRes = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          const prId = (await reqRes.json()).pullRequestId
          await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${prId}/reviewers/owner-1`, {
            method: 'PUT',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ vote: 10 }),
          })
          await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })

          // Delete shape branch to allow reopen
          const oid = await client.getBranchObjectId('gantry-workspace/remote-initiative/shape')
          if (oid !== '0'.repeat(40)) {
            const baseUrl = adoBaseUrl.replace(/\/+$/, '')
            const repoUrl = `${baseUrl}/${encodeURIComponent(ORGANIZATION)}/${encodeURIComponent(PROJECT)}/_apis/git/repositories/${encodeURIComponent(REPOSITORY)}`
            const refsUrl = new URL(`${repoUrl}/refs`)
            refsUrl.searchParams.set('api-version', '7.1')
            await fetch(refsUrl.toString(), {
              method: 'POST',
              headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
              body: JSON.stringify([{ name: 'refs/heads/gantry-workspace/remote-initiative/shape', oldObjectId: oid, newObjectId: '0'.repeat(40) }]),
            })
          }

          // Reopen
          const reopenRes = await fetch(`${base}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape' }),
          })
          assert.equal(reopenRes.status, 200)

          // Edit and request again
          const edited = readFileSync(join('instances', 'examples', 'modules', 'background.md'), 'utf8') + '\nSecond edit after reopen.\n'
          await client.writeFile('gantry-workspace/remote-initiative/modules/background.md', edited, { branch: 'gantry-workspace/remote-initiative/shape' })
          const secondReq = await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          const secondReqBody = await secondReq.json()
          assert.equal(secondReq.status, 200, JSON.stringify(secondReqBody))
          const secondPrId = secondReqBody.pullRequestId
          await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${secondPrId}/reviewers/owner-1`, {
            method: 'PUT',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ vote: 10 }),
          })
          const check2 = await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          const checkBody = await check2.json()
          assert.equal(check2.status, 200, JSON.stringify(checkBody))
          assert.equal(checkBody.merged, true)
          // Should have re-advanced to hld-define and cleared marker
          const after = await (await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(after.currentStageId, 'hld-define')
          assert.deepEqual(after.reopened, {})
        })
      })
    }
  )
})

test('POST /api/instance/stage/reopen rejects local instance and requires PAT', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-local', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/stage/reopen?slug=my-local&stage=shape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'shape' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /not Workspace-backed/)
    })
  })

  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: hld-define\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape' }),
          })
          assert.equal(res.status, 401)
        })
      })
    }
  )
})

test('POST /api/instance/stage/reopen 409 if branch already exists', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: hld-define\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const client = createAzureDevOpsClient(azureDevOps)
        await client.createBranch('gantry-workspace/remote-initiative/shape')
        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
            method: 'POST',
            headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape' }),
          })
          assert.equal(res.status, 409)
        })
      })
    }
  )
})
