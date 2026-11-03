import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitHubPullRequestsClient } from '../lib/githubPullRequestsClient.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { readInstance, recordInstancePullRequest } from '../lib/instance.js'
import {
  withRunningServerForProvider,
  basicAuthHeader,
  ORGANIZATION,
  PROJECT,
  REPOSITORY,
  VALID_PAT,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #266, ADR-0063: the HTTP face of "approvals go in stage order". The lib rule is covered in
// tests/stageApprovalOrder.test.js; this drives the same rule through the real routes
// (POST /api/instance/request-approval and POST /api/instance/check-status) that the web UI and the MCP
// request_approval / check_status tools both call, so the status codes and bodies those two clients rely on
// are pinned down: a 400 with the refusal message, and a 200 with merged=false and waitingForStage.

const SLUG = 'ordered-initiative'
const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']

function seedFiles() {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${SHAPE.id}\ndefinitionVersion: 2\n` }
}

function post(url, headers, body) {
  return fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function withScratchServer(provider, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(provider, { options: { instancesDir }, fakeServerOptions: { files: seedFiles() } }, (ctx) =>
      fn({ ...ctx, instancesDir })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// ---- GitHub -----------------------------------------------------------------------------

const githubAuth = { Authorization: basicAuthHeader(GITHUB_VALID_PAT) }

function githubLocation(providerBaseUrl) {
  return { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl }
}

function registerGitHub(instancesDir, providerBaseUrl) {
  registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
}

test('POST /api/instance/request-approval (GitHub) answers 400 naming the current stage for a gate that is not current, and opens nothing', async () => {
  await withScratchServer('github', async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    registerGitHub(instancesDir, providerBaseUrl)
    const github = githubLocation(providerBaseUrl)
    await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    const hldBranch = await resolveGitHubStageBranch(github, definition, SLUG, HLD_DEFINE.id)

    const res = await post(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, githubAuth, { gate: HLD_DEFINE.gate })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, new RegExp(`current stage is "${SHAPE.title}" \\(stage "${SHAPE.id}"\\)`))
    assert.match(body.error, /approved in order/)

    const instance = await readInstance(SLUG, { github: { ...github, branch: hldBranch } })
    assert.equal(instance.pullRequests?.[HLD_DEFINE.id], undefined)
  })
})

test('POST /api/instance/check-status (GitHub) answers 200 with merged=false and waitingForStage for an approved Pull Request on a stage that is not current', async () => {
  await withScratchServer('github', async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    registerGitHub(instancesDir, providerBaseUrl)
    const github = githubLocation(providerBaseUrl)
    const client = createGitHubClient(github)
    const shapeBranch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    for (const moduleId of SHAPE_MODULES) {
      await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch: shapeBranch })
    }
    const hldBranch = await resolveGitHubStageBranch(github, definition, SLUG, HLD_DEFINE.id)
    const prClient = createGitHubPullRequestsClient(github)
    const pr = await prClient.createPullRequest({ sourceBranch: hldBranch, targetBranch: 'main', title: 'hld', description: '' })
    const pullRequestId = pr.pullRequestId ?? pr.number
    await recordInstancePullRequest(SLUG, HLD_DEFINE.id, pullRequestId, {
      github: { ...github, branch: hldBranch },
      pullRequestStatus: pr.status,
    })
    await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE' }),
    })

    const res = await post(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, githubAuth, { gate: HLD_DEFINE.gate })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.merged, false)
    assert.equal(body.advancedTo, null)
    assert.equal(body.review.state, 'approved')
    assert.deepEqual(body.waitingForStage, { id: SHAPE.id, title: SHAPE.title, gate: SHAPE.gate })
    assert.match(body.message, /waits for the earlier stage "shape"/)

    // Nothing was merged or advanced behind the response's back.
    assert.equal((await readInstance(SLUG, { github })).stage, SHAPE.id)
    assert.equal(await client.fileExists(`gantry-workspace/${SLUG}/modules/background.md`), false)
  })
})

// ---- Azure DevOps -----------------------------------------------------------------------

const adoAuth = { Authorization: basicAuthHeader(VALID_PAT) }

test('POST /api/instance/request-approval (Azure DevOps) answers 400 naming the current stage for a gate that is not current, and opens nothing', async () => {
  await withScratchServer('azure-devops', async ({ gantryBase, providerBaseUrl, instancesDir }) => {
    registerInstance(
      SLUG,
      { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: providerBaseUrl },
      { instancesDir }
    )
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: providerBaseUrl }
    await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)

    const res = await post(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, adoAuth, { gate: HLD_DEFINE.gate })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, new RegExp(`current stage is "${SHAPE.title}" \\(stage "${SHAPE.id}"\\)`))

    const instance = await readInstance(SLUG, { azureDevOps: { ...azureDevOps, branch: hldBranch } })
    assert.equal(instance.pullRequests?.[HLD_DEFINE.id], undefined)
  })
})
