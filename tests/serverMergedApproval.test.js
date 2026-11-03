import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import {
  withRunningServer,
  withScratchInstances,
  basicAuthHeader,
  ORGANIZATION,
  PROJECT,
  REPOSITORY,
  VALID_PAT,
  withRunningServerForProvider,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #144 (docs/adr/0014, docs/adr/0026): a current stage whose approval Pull Request has been merged on the Provider
// but not recorded by Gantry. Opening the page only *reads* that (a notice in GET /api/instance); recording it, and
// optionally re-opening the stage, happen only on an explicit POST /api/instance/stage/record-approval.

const SLUG = 'remote-initiative'
const definition = loadDefinition('design')
const [SHAPE] = definition.stages
const auth = { Authorization: basicAuthHeader(VALID_PAT) }

async function fillShapeStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
}

async function deleteBranch(adoBaseUrl, client, branchName) {
  const repoUrl = `${adoBaseUrl.replace(/\/+$/, '')}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}`
  const oid = await client.getBranchObjectId(branchName)
  await fetch(`${repoUrl}/refs?api-version=7.1`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: `refs/heads/${branchName}`, oldObjectId: oid, newObjectId: '0'.repeat(40) }]),
  })
}

// Request approval for Shape, then have "someone on the Provider" complete the Pull Request: Gantry is not asked to.
async function setUpMergedShape(adoBaseUrl, base, { deleteShapeBranch = true } = {}) {
  const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
  const client = createAzureDevOpsClient(azureDevOps)
  const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
  await fillShapeStage(azureDevOps, branch)
  const opened = await (await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: auth })).json()
  await createAzureDevOpsPullRequestsClient(azureDevOps).completePullRequest(opened.pullRequestId, {})
  if (deleteShapeBranch) await deleteBranch(adoBaseUrl, client, branch)
  return { azureDevOps, client, branch, pullRequestId: opened.pullRequestId }
}

const getInstance = async (base) => (await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: auth })).json()
const recordApproval = (base, body) =>
  fetch(`${base}/api/instance/stage/record-approval?slug=${SLUG}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

function withAzure(fn) {
  return withFakeAzureDevOpsServer(
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
        await withRunningServer({ instancesDir }, (base) => fn({ adoBaseUrl, base }))
      })
    }
  )
}

test('GET /api/instance shows no notice while the approval Pull Request is still open', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)
    await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: auth })
    const instance = await getInstance(base)
    assert.equal(instance.mergedApproval, null)
  })
})

test('GET /api/instance names a merged-but-unrecorded approval and records nothing (prompt only, ADR-0014)', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    const { pullRequestId } = await setUpMergedShape(adoBaseUrl, base)
    const first = await getInstance(base)
    assert.equal(first.currentStageId, 'shape', 'page load did not advance the instance')
    assert.deepEqual(first.mergedApproval, {
      stageId: 'shape',
      title: SHAPE.title,
      pullRequestId,
      next: { id: 'hld-define', title: definition.stages[1].title },
      reopen: { allowed: true },
    })
    // Loading again changes nothing either: still current, still flagged.
    const second = await getInstance(base)
    assert.equal(second.currentStageId, 'shape')
    assert.equal(second.mergedApproval.pullRequestId, pullRequestId)
  })
})

test('Record approval and move on: the instance advances and the notice goes away', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    const { pullRequestId } = await setUpMergedShape(adoBaseUrl, base)
    const res = await recordApproval(base, { reopen: false })
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.equal(body.merged, true)
    assert.equal(body.advancedTo.id, 'hld-define')
    assert.equal(body.reopened, null)
    const after = await getInstance(base)
    assert.equal(after.currentStageId, 'hld-define')
    assert.equal(after.mergedApproval, null)
    assert.equal(after.pullRequests.shape, pullRequestId)
  })
})

test('Record approval and re-open: back on the stage with a fresh branch from main, approval history kept (ADR-0026)', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    const { client, branch, pullRequestId } = await setUpMergedShape(adoBaseUrl, base)
    const res = await recordApproval(base, { reopen: true })
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.equal(body.advancedTo.id, 'hld-define')
    assert.equal(body.reopened.branch, branch)
    assert.equal(body.reopened.previousStage, 'hld-define')

    const after = await getInstance(base)
    assert.equal(after.currentStageId, 'shape')
    assert.equal(after.stage.id, 'shape')
    assert.ok(after.reopened.shape)
    assert.equal(after.pullRequests.shape, pullRequestId, 'the approval history is kept')
    assert.equal(await client.branchExists(branch), true, 'a fresh branch exists')
    assert.equal(after.mergedApproval, null, 'the old, recorded Pull Request is history, not a new notice')
  })
})

test('a later stage that already has a branch blocks re-open: the notice says so, and record-and-re-open records nothing', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    const { client } = await setUpMergedShape(adoBaseUrl, base)
    await client.createBranch(`gantry-workspace/${SLUG}/hld-define`)

    const notice = (await getInstance(base)).mergedApproval
    assert.equal(notice.reopen.allowed, false)
    assert.match(notice.reopen.reason, /Stage 'hld-define' is already in progress — complete or abandon it before re-opening 'shape'/)

    const refused = await recordApproval(base, { reopen: true })
    assert.equal(refused.status, 409)
    assert.match((await refused.json()).error, /already in progress/)
    assert.equal((await getInstance(base)).currentStageId, 'shape', 'nothing was recorded by the refused request')

    // Moving on is still available.
    const moved = await recordApproval(base, { reopen: false })
    assert.equal(moved.status, 200)
    assert.equal((await getInstance(base)).currentStageId, 'hld-define')
  })
})

test('a stage branch left on the Provider after the merge blocks re-open (it is only recreated by a re-open)', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    await setUpMergedShape(adoBaseUrl, base, { deleteShapeBranch: false })
    const notice = (await getInstance(base)).mergedApproval
    assert.equal(notice.reopen.allowed, false)
    assert.match(notice.reopen.reason, /still on the Provider/)
    const refused = await recordApproval(base, { reopen: true })
    assert.equal(refused.status, 409)
    assert.equal((await getInstance(base)).currentStageId, 'shape')
  })
})

test('record-approval refuses a Pull Request that has not merged: it cannot be used to skip a review', async () => {
  await withAzure(async ({ adoBaseUrl, base }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)
    await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: auth })
    const res = await recordApproval(base, { reopen: false })
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /has not been merged/)
    assert.equal((await getInstance(base)).currentStageId, 'shape')
  })
})

test('record-approval with no credential asks for one, and rejects a local instance', async () => {
  await withAzure(async ({ base }) => {
    const res = await fetch(`${base}/api/instance/stage/record-approval?slug=${SLUG}`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/stage/record-approval?slug=some-local-instance`, { method: 'POST' })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /not Workspace-backed/)
    })
  })
})

// ---- GitHub: the same notice and the same two actions ----

const GH_SLUG = 'remote-github-initiative'
const ghAuth = { Authorization: `Basic ${Buffer.from(`:${GITHUB_VALID_PAT}`, 'utf8').toString('base64')}` }

test('GitHub workspace: the merged-but-unrecorded notice, then record-and-re-open', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(
      'github',
      {
        options: { instancesDir },
        fakeServerOptions: { files: { [`/gantry-workspace/${GH_SLUG}/instance.yaml`]: `definition: design\nslug: ${GH_SLUG}\nstage: shape\ndefinitionVersion: 2\n` } },
      },
      async ({ gantryBase, providerBaseUrl }) => {
        registerInstance(GH_SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
        const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl }
        const branch = await resolveGitHubStageBranch(github, definition, GH_SLUG, SHAPE.id)
        const client = createGitHubClient(github)
        for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
          await client.writeFile(`gantry-workspace/${GH_SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
        }
        await client.writeFile(`gantry-workspace/${GH_SLUG}/out/Remote Github Initiative - Solution on a Page.docx`, 'rendered soap', { branch })

        const opened = await (await fetch(`${gantryBase}/api/instance/request-approval?slug=${GH_SLUG}`, { method: 'POST', headers: ghAuth })).json()
        const pending = await (await fetch(`${gantryBase}/api/instance?slug=${GH_SLUG}`, { headers: ghAuth })).json()
        assert.equal(pending.mergedApproval, null)

        // Merged on GitHub itself (not by Gantry), and the branch cleaned up there.
        const merged = await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${opened.pullRequestId}/merge`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ merge_method: 'merge' }),
        })
        assert.equal(merged.status, 200)
        await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
        })

        const notice = await (await fetch(`${gantryBase}/api/instance?slug=${GH_SLUG}`, { headers: ghAuth })).json()
        assert.equal(notice.currentStageId, 'shape')
        assert.equal(notice.mergedApproval.pullRequestId, opened.pullRequestId)
        assert.equal(notice.mergedApproval.reopen.allowed, true)

        const res = await fetch(`${gantryBase}/api/instance/stage/record-approval?slug=${GH_SLUG}`, {
          method: 'POST',
          headers: { ...ghAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reopen: true }),
        })
        assert.equal(res.status, 200, await res.clone().text())
        const after = await (await fetch(`${gantryBase}/api/instance?slug=${GH_SLUG}`, { headers: ghAuth })).json()
        assert.equal(after.currentStageId, 'shape')
        assert.ok(after.reopened.shape)
        assert.equal(after.mergedApproval, null)
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
