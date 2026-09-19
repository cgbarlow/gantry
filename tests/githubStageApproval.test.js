import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitHubPullRequestsClient } from '../lib/githubPullRequestsClient.js'
import { resolveGitHubStageBranch, findGitHubStageBranch } from '../lib/githubStageBranch.js'
import { readInstance, instanceDisplayName, renderedArtefactBasename } from '../lib/instance.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { checkStageApprovalStatus } from '../lib/stageStatus.js'
import { reopenStage } from '../lib/stageReopen.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #13, ADR-0037/0040: GitHub's PR-gated sign-off (and re-open) — the GitHub twin of
// tests/stageApproval.test.js / tests/stageStatus.test.js / tests/serverStageReopen.test.js, driven
// against the in-process fake GitHub server (Git Data + Pulls endpoints), never a mocked client.

const SLUG = 'my-github-initiative'
const definition = loadDefinition('design')
const INSTANCE_NAME = instanceDisplayName({ slug: SLUG })
const outDocxRepoPath = (artefactId) =>
  `gantry-workspace/${SLUG}/out/${renderedArtefactBasename(
    INSTANCE_NAME,
    definition.artefacts.find((a) => a.id === artefactId).title
  )}.docx`
const [SHAPE] = definition.stages

function locationFor(baseUrl, overrides = {}) {
  return { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl, ...overrides }
}

function withServer(overrides, fn) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, ...overrides }, fn)
}

async function fillShapeStage(github, branch) {
  const client = createGitHubClient(github)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    const text = exampleModuleText(moduleId)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(outDocxRepoPath('soap'), 'rendered soap', { branch })
}

function seedInstanceYaml(stage = SHAPE) {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${stage.id}\ndefinitionVersion: 2\n` }
}

test('requestStageApproval (GitHub) opens a Pull Request from the stage branch into "main" once the gate has passed, and records its id on instance.yaml', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)

    const result = await requestStageApproval(SLUG, { github })
    assert.equal(result.stage.id, SHAPE.id)
    assert.equal(result.branch, branch)
    assert.equal(typeof result.pullRequestId, 'number')
    assert.equal(result.status, 'active')
    assert.ok(result.webUrl.includes(`/pull/${result.pullRequestId}`))

    const instance = await readInstance(SLUG, { github: { ...github, branch } })
    assert.equal(instance.pullRequests[SHAPE.id], result.pullRequestId)
  })
})

test('requestStageApproval (GitHub) refuses to open a Pull Request when the gate has not passed', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)

    await assert.rejects(() => requestStageApproval(SLUG, { github }), /has not passed/)
  })
})

test('requestStageApproval (GitHub) refuses to request approval twice for the same stage', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)

    await requestStageApproval(SLUG, { github })
    await assert.rejects(() => requestStageApproval(SLUG, { github }), /already has a Pull Request/)
  })
})

test('checkStageApprovalStatus (GitHub) reports pending when no review has been submitted, and merges nothing', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)
    await requestStageApproval(SLUG, { github })

    const result = await checkStageApprovalStatus(SLUG, { github })
    assert.equal(result.merged, false)
    assert.equal(result.review.state, 'pending')
    assert.equal(result.advancedTo, null)
  })
})

test('checkStageApprovalStatus (GitHub) distinguishes an approval from a changes-requested review, and a comment-only review still reads as pending', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { github })

    const prClient = createGitHubPullRequestsClient(github)
    // Submit reviews directly against the fake server's reviews endpoint (the same "code owner
    // reviewed" simulation Promote's own tests use — see fakeGitHubServer.js's own doc comment).
    const submitReview = (event) =>
      fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event }),
      })

    await submitReview('COMMENT')
    const stillPending = await checkStageApprovalStatus(SLUG, { github })
    assert.equal(stillPending.review.state, 'pending')
    assert.equal(stillPending.merged, false)

    await submitReview('REQUEST_CHANGES')
    const changesRequested = await checkStageApprovalStatus(SLUG, { github })
    assert.equal(changesRequested.review.state, 'changes-requested')
    assert.equal(changesRequested.merged, false)
  })
})

test('checkStageApprovalStatus (GitHub) merges an approved Pull Request with a merge commit and advances the stage pointer', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { github })

    await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE' }),
    })

    const result = await checkStageApprovalStatus(SLUG, { github })
    assert.equal(result.merged, true)
    assert.equal(result.review.state, 'approved')
    assert.ok(result.advancedTo)
    assert.notEqual(result.advancedTo.id, SHAPE.id)

    const instance = await readInstance(SLUG, { github })
    assert.equal(instance.stage, result.advancedTo.id)

    // Idempotent re-click: no second merge attempt, no second advance. A re-click after the advance
    // now resolves the instance's current stage to the *next* one, so re-check via the completed
    // stage's own gate — exactly as the Azure DevOps equivalent test does.
    const again = await checkStageApprovalStatus(SLUG, { github, gate: SHAPE.gate })
    assert.equal(again.merged, true)
    assert.equal(again.advancedTo, null)
  })
})

test('checkStageApprovalStatus (GitHub) surfaces a branch-protection merge refusal verbatim as a blocked sign-off, never merging or advancing', async () => {
  await withServer(
    { files: seedInstanceYaml(), mergeRefusal: { status: 405, message: 'At least 1 approving review is required by reviewers with write access.' } },
    async (baseUrl) => {
      const github = locationFor(baseUrl)
      const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
      await fillShapeStage(github, branch)
      const { pullRequestId } = await requestStageApproval(SLUG, { github })

      await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'APPROVE' }),
      })

      await assert.rejects(() => checkStageApprovalStatus(SLUG, { github }), /approving review/)

      const instance = await readInstance(SLUG, { github })
      assert.equal(instance.stage, SHAPE.id)
      assert.equal(instance.pullRequestStatuses?.[SHAPE.id], undefined)
    }
  )
})

test('reopenStage (GitHub) recreates the stage branch from main, moves the stage pointer back, and records the reopened marker', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { github })
    await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE' }),
    })
    await checkStageApprovalStatus(SLUG, { github })

    // Our fake, like the Azure DevOps one, never auto-deletes a merged source branch — simulate the
    // "a stage branch was cleaned up after merge" precondition `reopenStage` assumes, the same way
    // tests/serverStageReopen.test.js deletes the Azure DevOps ref directly for the identical reason.
    await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
    })

    const result = await reopenStage(SLUG, SHAPE.id, { github })
    assert.equal(result.previousStage, definition.stages[1].id)
    assert.ok(result.reopened[SHAPE.id])
    assert.equal(await findGitHubStageBranch(github, SLUG, SHAPE.id), result.branch)

    const instance = await readInstance(SLUG, { github })
    assert.equal(instance.stage, SHAPE.id)
    assert.ok(instance.reopened?.[SHAPE.id])
  })
})

test('reopenStage (GitHub) refuses when the stage branch already exists', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    await fillShapeStage(github, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { github })
    await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'APPROVE' }),
    })
    await checkStageApprovalStatus(SLUG, { github })

    // Unlike the test above, the shape branch is deliberately left in place (never deleted) —
    // reopen must refuse rather than recreate over it.
    await assert.rejects(() => reopenStage(SLUG, SHAPE.id, { github }), (err) => {
      assert.equal(err.status, 409)
      return true
    })
  })
})
