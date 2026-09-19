import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { createBitbucketClient } from '../lib/bitbucketClient.js'
import { resolveBitbucketStageBranch } from '../lib/bitbucketStageBranch.js'
import { readInstance, instanceDisplayName, renderedArtefactBasename } from '../lib/instance.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { checkStageApprovalStatus } from '../lib/stageStatus.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #46, ADR-0042: Bitbucket's pull-requests client and its sign-off gating — the Atlassian twin of
// tests/githubStageApproval.test.js / tests/gitlabStageApproval.test.js, driven against the in-process
// fake Bitbucket server (Pull Requests + Source/Branches endpoints), never a mocked client.
//
// Deliberately no re-open coverage here, unlike tests/gitlabStageApproval.test.js's own reopenStage
// tests: unlike GitHub's #13 ("PR-gated sign-off, including re-open") and GitLab's #33 ("MR-gated
// sign-off, including re-open"), this ticket's own title and acceptance criteria don't bundle re-open
// in — no ticket in the current Atlassian batch (#40-#49) adds one yet, so `lib/stageReopen.js` has no
// Atlassian arm to exercise.

const SLUG = 'my-atlassian-initiative'
const definition = loadDefinition('design')
const INSTANCE_NAME = instanceDisplayName({ slug: SLUG })
const outDocxRepoPath = (artefactId) =>
  `gantry-workspace/${SLUG}/out/${renderedArtefactBasename(
    INSTANCE_NAME,
    definition.artefacts.find((a) => a.id === artefactId).title
  )}.docx`
const [SHAPE] = definition.stages

function locationFor(baseUrl, overrides = {}) {
  return { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl, ...overrides }
}

function withServer(overrides, fn) {
  return withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, ...overrides }, fn)
}

async function fillShapeStage(atlassian, branch) {
  const client = createBitbucketClient(atlassian)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    const text = exampleModuleText(moduleId)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(outDocxRepoPath('soap'), 'rendered soap', { branch })
}

function seedInstanceYaml(stage = SHAPE) {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${stage.id}\ndefinitionVersion: 2\n` }
}

async function approvePullRequest(baseUrl, pullRequestId) {
  return fetch(`${baseUrl}/repositories/${encodeURIComponent(BITBUCKET_OWNER)}/${encodeURIComponent(BITBUCKET_REPOSITORY)}/pullrequests/${pullRequestId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BITBUCKET_VALID_PAT}` },
  })
}

async function requestChangesOnPullRequest(baseUrl, pullRequestId) {
  return fetch(
    `${baseUrl}/repositories/${encodeURIComponent(BITBUCKET_OWNER)}/${encodeURIComponent(BITBUCKET_REPOSITORY)}/pullrequests/${pullRequestId}/request-changes`,
    { method: 'POST', headers: { Authorization: `Bearer ${BITBUCKET_VALID_PAT}` } }
  )
}

test('requestStageApproval (Atlassian) opens a Bitbucket pull request from the stage branch into "main" once the gate has passed, and records its id on instance.yaml', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const atlassian = locationFor(baseUrl)
    const branch = await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)
    await fillShapeStage(atlassian, branch)

    const result = await requestStageApproval(SLUG, { atlassian })
    assert.equal(result.stage.id, SHAPE.id)
    assert.equal(result.branch, branch)
    assert.equal(typeof result.pullRequestId, 'number')
    assert.equal(result.status, 'active')
    assert.ok(result.webUrl.includes(`/pull-requests/${result.pullRequestId}`))

    const instance = await readInstance(SLUG, { atlassian: { ...atlassian, branch } })
    assert.equal(instance.pullRequests[SHAPE.id], result.pullRequestId)
  })
})

test('requestStageApproval (Atlassian) refuses to open a pull request when the gate has not passed', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const atlassian = locationFor(baseUrl)
    await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)

    await assert.rejects(() => requestStageApproval(SLUG, { atlassian }), /has not passed/)
  })
})

test('requestStageApproval (Atlassian) refuses to request approval twice for the same stage', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const atlassian = locationFor(baseUrl)
    const branch = await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)
    await fillShapeStage(atlassian, branch)

    await requestStageApproval(SLUG, { atlassian })
    await assert.rejects(() => requestStageApproval(SLUG, { atlassian }), /already has a Pull Request/)
  })
})

test('checkStageApprovalStatus (Atlassian) reports pending when nobody has reviewed yet, and merges nothing', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const atlassian = locationFor(baseUrl)
    const branch = await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)
    await fillShapeStage(atlassian, branch)
    await requestStageApproval(SLUG, { atlassian })

    const result = await checkStageApprovalStatus(SLUG, { atlassian })
    assert.equal(result.merged, false)
    assert.equal(result.review.state, 'pending')
    assert.equal(result.advancedTo, null)
  })
})

test('checkStageApprovalStatus (Atlassian) reads a reviewer\'s changes_requested tri-state as the changes-requested equivalent, distinct from approved', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const atlassian = locationFor(baseUrl)
    const branch = await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)
    await fillShapeStage(atlassian, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { atlassian })

    await requestChangesOnPullRequest(baseUrl, pullRequestId)
    const changesRequested = await checkStageApprovalStatus(SLUG, { atlassian })
    assert.equal(changesRequested.review.state, 'changes-requested')
    assert.equal(changesRequested.merged, false)
  })
})

test('checkStageApprovalStatus (Atlassian) merges an approved pull request with a merge commit and advances the stage pointer', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const atlassian = locationFor(baseUrl)
    const branch = await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)
    await fillShapeStage(atlassian, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { atlassian })

    await approvePullRequest(baseUrl, pullRequestId)

    const result = await checkStageApprovalStatus(SLUG, { atlassian })
    assert.equal(result.merged, true)
    assert.equal(result.review.state, 'approved')
    assert.ok(result.advancedTo)
    assert.notEqual(result.advancedTo.id, SHAPE.id)

    const instance = await readInstance(SLUG, { atlassian })
    assert.equal(instance.stage, result.advancedTo.id)

    // Idempotent re-click: no second merge attempt, no second advance.
    const again = await checkStageApprovalStatus(SLUG, { atlassian, gate: SHAPE.gate })
    assert.equal(again.merged, true)
    assert.equal(again.advancedTo, null)
  })
})

test('checkStageApprovalStatus (Atlassian) surfaces a Bitbucket merge refusal verbatim as a blocked sign-off, never merging or advancing', async () => {
  await withServer(
    { files: seedInstanceYaml(), mergeRefusal: { status: 409, message: 'Branch has a restriction that prevents this merge' } },
    async (baseUrl) => {
      const atlassian = locationFor(baseUrl)
      const branch = await resolveBitbucketStageBranch(atlassian, definition, SLUG, SHAPE.id)
      await fillShapeStage(atlassian, branch)
      const { pullRequestId } = await requestStageApproval(SLUG, { atlassian })

      await approvePullRequest(baseUrl, pullRequestId)

      await assert.rejects(() => checkStageApprovalStatus(SLUG, { atlassian }), /restriction/)

      const instance = await readInstance(SLUG, { atlassian })
      assert.equal(instance.stage, SHAPE.id)
      assert.equal(instance.pullRequestStatuses?.[SHAPE.id], undefined)
    }
  )
})
