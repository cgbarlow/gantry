import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitHubPullRequestsClient } from '../lib/githubPullRequestsClient.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { readInstance, recordInstancePullRequest } from '../lib/instance.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { checkStageApprovalStatus } from '../lib/stageStatus.js'
import { assertStageIsCurrentForApproval, waitingForEarlierStageResult } from '../lib/stageOrder.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #266, ADR-0063: approvals go in stage order. Request approval and Check status act only on the
// instance's current stage on `main`, and a new stage branch stacks on the nearest earlier stage
// branch that exists. Driven against the in-process fake Azure DevOps and GitHub servers, never a
// mocked client.

const SLUG = 'ordered-initiative'
const definition = loadDefinition('design')
// design's stage order: shape -> hld-define -> detailed-design -> handover.
const [SHAPE, HLD_DEFINE, DETAILED_DESIGN] = definition.stages
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']

function instanceYaml(stage) {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${stage.id}\ndefinitionVersion: 2\n` }
}

// ---- unit: the shared rule --------------------------------------------------------------

test('assertStageIsCurrentForApproval passes for the current stage and names the current stage otherwise', () => {
  const instance = { stage: SHAPE.id }
  assert.doesNotThrow(() => assertStageIsCurrentForApproval(SLUG, definition, instance, SHAPE))
  assert.throws(
    () => assertStageIsCurrentForApproval(SLUG, definition, instance, HLD_DEFINE),
    (err) => err.message.includes(`current stage is "${SHAPE.title}" (stage "${SHAPE.id}")`) && err.message.includes('in order')
  )
  // A stage already behind the current one is refused too, with its own wording.
  assert.throws(
    () => assertStageIsCurrentForApproval(SLUG, definition, { stage: HLD_DEFINE.id }, SHAPE),
    /already behind the instance's current stage, "[^"]+" \(stage "hld-define"\)/
  )
})

test('waitingForEarlierStageResult reports nothing merged or advanced and names the stage it waits for', () => {
  const result = waitingForEarlierStageResult({
    slug: SLUG,
    definition,
    instance: { stage: SHAPE.id },
    stage: HLD_DEFINE,
    pullRequestId: 7,
    prStatus: 'active',
    review: { state: 'approved' },
    pullRequest: { id: 7 },
  })
  assert.equal(result.merged, false)
  assert.equal(result.advancedTo, null)
  assert.equal(result.workItemSync, null)
  assert.deepEqual(result.waitingForStage, { id: SHAPE.id, title: SHAPE.title, gate: SHAPE.gate })
  assert.match(result.message, /waits for the earlier stage "shape"/)
})

// ---- Azure DevOps -----------------------------------------------------------------------

function adoLocation(baseUrl) {
  return { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
}

function withAdo(stage, fn) {
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: instanceYaml(stage) },
    fn
  )
}

async function adoCastVote(baseUrl, pullRequestId, vote) {
  const res = await fetch(
    `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`,
    {
      method: 'PUT',
      headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'The Owner', vote }),
    }
  )
  assert.equal(res.status, 200)
}

test('requestStageApproval (Azure DevOps) refuses a stage that is not current, naming the current stage, and opens nothing', async () => {
  await withAdo(SHAPE, async (baseUrl) => {
    const azureDevOps = adoLocation(baseUrl)
    const shapeBranch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)
    assert.ok(hldBranch)

    await assert.rejects(
      () => requestStageApproval(SLUG, { azureDevOps, gate: HLD_DEFINE.gate }),
      new RegExp(`current stage is "${SHAPE.title}" \\(stage "shape"\\)`)
    )
    const instance = await readInstance(SLUG, { azureDevOps: { ...azureDevOps, branch: hldBranch } })
    assert.equal(instance.pullRequests?.[HLD_DEFINE.id], undefined)
    assert.ok(shapeBranch)
  })
})

test('checkStageApprovalStatus (Azure DevOps) does not merge or advance an approved Pull Request for a stage that is not current', async () => {
  await withAdo(SHAPE, async (baseUrl) => {
    const azureDevOps = adoLocation(baseUrl)
    const client = createAzureDevOpsClient(azureDevOps)
    const shapeBranch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    for (const moduleId of SHAPE_MODULES) {
      await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch: shapeBranch })
    }
    // hld-define stacks on shape, so it carries shape's unapproved modules.
    const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)
    const prClient = createAzureDevOpsPullRequestsClient(azureDevOps)
    const pr = await prClient.createPullRequest({ sourceBranch: hldBranch, targetBranch: 'main', title: 'hld', description: '' })
    await recordInstancePullRequest(SLUG, HLD_DEFINE.id, pr.pullRequestId, {
      azureDevOps: { ...azureDevOps, branch: hldBranch },
      pullRequestStatus: pr.status,
    })
    await adoCastVote(baseUrl, pr.pullRequestId, 10)

    const result = await checkStageApprovalStatus(SLUG, { azureDevOps, gate: HLD_DEFINE.gate })
    assert.equal(result.review.state, 'approved')
    assert.equal(result.merged, false)
    assert.equal(result.advancedTo, null)
    assert.equal(result.prStatus, 'active')
    assert.equal(result.waitingForStage.id, SHAPE.id)
    assert.match(result.message, /waits for the earlier stage "shape"/)

    assert.equal((await prClient.getPullRequest(pr.pullRequestId)).status, 'active')
    assert.equal((await readInstance(SLUG, { azureDevOps })).stage, SHAPE.id)
    assert.equal(await client.fileExists(`gantry-workspace/${SLUG}/modules/background.md`), false, 'shape content must not have reached main')
  })
})

test('resolveStageBranch (Azure DevOps) stacks on the nearest earlier stage branch that exists, skipping a stage with no branch', async () => {
  await withAdo(SHAPE, async (baseUrl) => {
    const azureDevOps = adoLocation(baseUrl)
    const client = createAzureDevOpsClient(azureDevOps)
    const shapeBranch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/background.md`, 'unapproved shape draft', { branch: shapeBranch })

    // hld-define has no branch; detailed-design must stack on shape, not fork from main.
    assert.equal(await client.branchExists(stageBranchName(SLUG, HLD_DEFINE.id)), false)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, DETAILED_DESIGN.id)
    assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/modules/background.md`, { branch }), 'unapproved shape draft')
  })
})

test('resolveStageBranch (Azure DevOps) prefers the nearer earlier stage branch over a farther one', async () => {
  await withAdo(SHAPE, async (baseUrl) => {
    const azureDevOps = adoLocation(baseUrl)
    const client = createAzureDevOpsClient(azureDevOps)
    const shapeBranch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/background.md`, 'shape draft', { branch: shapeBranch })
    const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/only-on-hld.md`, 'hld draft', { branch: hldBranch })

    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, DETAILED_DESIGN.id)
    assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/modules/only-on-hld.md`, { branch }), 'hld draft')
    assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/modules/background.md`, { branch }), 'shape draft')
  })
})

// ---- GitHub -----------------------------------------------------------------------------

function githubLocation(baseUrl) {
  return { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl }
}

function withGitHub(stage, fn) {
  return withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: instanceYaml(stage) },
    fn
  )
}

test('requestStageApproval (GitHub) refuses a stage that is not current, naming the current stage, and opens nothing', async () => {
  await withGitHub(SHAPE, async (baseUrl) => {
    const github = githubLocation(baseUrl)
    await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    const hldBranch = await resolveGitHubStageBranch(github, definition, SLUG, HLD_DEFINE.id)

    await assert.rejects(
      () => requestStageApproval(SLUG, { github, gate: HLD_DEFINE.gate }),
      new RegExp(`current stage is "${SHAPE.title}" \\(stage "shape"\\)`)
    )
    const instance = await readInstance(SLUG, { github: { ...github, branch: hldBranch } })
    assert.equal(instance.pullRequests?.[HLD_DEFINE.id], undefined)
  })
})

test('checkStageApprovalStatus (GitHub) does not merge or advance an approved Pull Request for a stage that is not current', async () => {
  await withGitHub(SHAPE, async (baseUrl) => {
    const github = githubLocation(baseUrl)
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
    await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE' }),
    })

    const result = await checkStageApprovalStatus(SLUG, { github, gate: HLD_DEFINE.gate })
    assert.equal(result.review.state, 'approved')
    assert.equal(result.merged, false)
    assert.equal(result.advancedTo, null)
    assert.equal(result.prStatus, 'active')
    assert.equal(result.waitingForStage.id, SHAPE.id)

    assert.equal((await prClient.getPullRequest(pullRequestId)).status, 'active')
    assert.equal((await readInstance(SLUG, { github })).stage, SHAPE.id)
    assert.equal(await client.fileExists(`gantry-workspace/${SLUG}/modules/background.md`), false, 'shape content must not have reached main')
  })
})

test('resolveGitHubStageBranch stacks on the nearest earlier stage branch that exists, skipping a stage with no branch', async () => {
  await withGitHub(SHAPE, async (baseUrl) => {
    const github = githubLocation(baseUrl)
    const client = createGitHubClient(github)
    const shapeBranch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/background.md`, 'unapproved shape draft', { branch: shapeBranch })

    assert.equal(await client.branchExists(stageBranchName(SLUG, HLD_DEFINE.id)), false)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, DETAILED_DESIGN.id)
    assert.equal(await client.getFileContent(`gantry-workspace/${SLUG}/modules/background.md`, { branch }), 'unapproved shape draft')
  })
})
