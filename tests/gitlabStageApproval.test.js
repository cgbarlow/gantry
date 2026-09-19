import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { createGitLabPullRequestsClient } from '../lib/gitlabPullRequestsClient.js'
import { resolveGitLabStageBranch, findGitLabStageBranch } from '../lib/gitlabStageBranch.js'
import { readInstance, instanceDisplayName, renderedArtefactBasename } from '../lib/instance.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { checkStageApprovalStatus } from '../lib/stageStatus.js'
import { reopenStage } from '../lib/stageReopen.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #33, ADR-0037/0041: GitLab's MR-gated sign-off (and re-open) — the GitLab twin of
// tests/githubStageApproval.test.js / tests/stageApproval.test.js / tests/stageStatus.test.js /
// tests/serverStageReopen.test.js, driven against the in-process fake GitLab server (Merge Requests +
// Repository Files/Commits/Branches endpoints), never a mocked client.

const SLUG = 'my-gitlab-initiative'
const definition = loadDefinition('design')
const INSTANCE_NAME = instanceDisplayName({ slug: SLUG })
const outDocxRepoPath = (artefactId) =>
  `gantry-workspace/${SLUG}/out/${renderedArtefactBasename(
    INSTANCE_NAME,
    definition.artefacts.find((a) => a.id === artefactId).title
  )}.docx`
const [SHAPE] = definition.stages

function locationFor(baseUrl, overrides = {}) {
  return { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl, ...overrides }
}

function withServer(overrides, fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, ...overrides }, fn)
}

async function fillShapeStage(gitlab, branch) {
  const client = createGitLabClient(gitlab)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    const text = exampleModuleText(moduleId)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(outDocxRepoPath('soap'), 'rendered soap', { branch })
}

function seedInstanceYaml(stage = SHAPE) {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${stage.id}\ndefinitionVersion: 2\n` }
}

test('requestStageApproval (GitLab) opens a Merge Request from the stage branch into "main" once the gate has passed, and records its id on instance.yaml', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)

    const result = await requestStageApproval(SLUG, { gitlab })
    assert.equal(result.stage.id, SHAPE.id)
    assert.equal(result.branch, branch)
    assert.equal(typeof result.pullRequestId, 'number')
    assert.equal(result.status, 'active')
    assert.ok(result.webUrl.includes(`/merge_requests/${result.pullRequestId}`))

    const instance = await readInstance(SLUG, { gitlab: { ...gitlab, branch } })
    assert.equal(instance.pullRequests[SHAPE.id], result.pullRequestId)
  })
})

test('requestStageApproval (GitLab) refuses to open a Merge Request when the gate has not passed', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)

    await assert.rejects(() => requestStageApproval(SLUG, { gitlab }), /has not passed/)
  })
})

test('requestStageApproval (GitLab) refuses to request approval twice for the same stage', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)

    await requestStageApproval(SLUG, { gitlab })
    await assert.rejects(() => requestStageApproval(SLUG, { gitlab }), /already has a Pull Request/)
  })
})

test('checkStageApprovalStatus (GitLab) reports pending when nobody has approved and no discussion thread exists, and merges nothing', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)
    await requestStageApproval(SLUG, { gitlab })

    const result = await checkStageApprovalStatus(SLUG, { gitlab })
    assert.equal(result.merged, false)
    assert.equal(result.review.state, 'pending')
    assert.equal(result.advancedTo, null)
  })
})

test('checkStageApprovalStatus (GitLab) reads not-approved-plus-unresolved-thread as the changes-requested equivalent, and resolving the thread returns it to pending', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { gitlab })

    // Simulate a reviewer leaving feedback without approving (the fake server's own test-facing
    // discussions endpoint — see fakeGitLabServer.js's own doc comment).
    const discussionRes = await fetch(`${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/merge_requests/${pullRequestId}/discussions`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Please reconsider this section.' }),
    })
    const discussion = await discussionRes.json()

    const changesRequested = await checkStageApprovalStatus(SLUG, { gitlab })
    assert.equal(changesRequested.review.state, 'changes-requested')
    assert.equal(changesRequested.merged, false)

    // Resolving the thread (still not approved) returns to pending, not approved.
    await fetch(
      `${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/merge_requests/${pullRequestId}/discussions/${discussion.id}`,
      {
        method: 'PUT',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      }
    )
    const pendingAgain = await checkStageApprovalStatus(SLUG, { gitlab })
    assert.equal(pendingAgain.review.state, 'pending')
    assert.equal(pendingAgain.merged, false)
  })
})

test('checkStageApprovalStatus (GitLab) merges an approved Merge Request with a merge commit and advances the stage pointer', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { gitlab })

    await fetch(`${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/merge_requests/${pullRequestId}/approve`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
    })

    const result = await checkStageApprovalStatus(SLUG, { gitlab })
    assert.equal(result.merged, true)
    assert.equal(result.review.state, 'approved')
    assert.ok(result.advancedTo)
    assert.notEqual(result.advancedTo.id, SHAPE.id)

    const instance = await readInstance(SLUG, { gitlab })
    assert.equal(instance.stage, result.advancedTo.id)

    // Idempotent re-click: no second merge attempt, no second advance.
    const again = await checkStageApprovalStatus(SLUG, { gitlab, gate: SHAPE.gate })
    assert.equal(again.merged, true)
    assert.equal(again.advancedTo, null)
  })
})

test('checkStageApprovalStatus (GitLab) surfaces a protected-branch merge refusal verbatim as a blocked sign-off, never merging or advancing', async () => {
  await withServer(
    { files: seedInstanceYaml(), mergeRefusal: { status: 405, message: 'Branch is protected from force push' } },
    async (baseUrl) => {
      const gitlab = locationFor(baseUrl)
      const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
      await fillShapeStage(gitlab, branch)
      const { pullRequestId } = await requestStageApproval(SLUG, { gitlab })

      await fetch(`${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/merge_requests/${pullRequestId}/approve`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
      })

      await assert.rejects(() => checkStageApprovalStatus(SLUG, { gitlab }), /protected/)

      const instance = await readInstance(SLUG, { gitlab })
      assert.equal(instance.stage, SHAPE.id)
      assert.equal(instance.pullRequestStatuses?.[SHAPE.id], undefined)
    }
  )
})

test('reopenStage (GitLab) recreates the stage branch from main, moves the stage pointer back, and records the reopened marker', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { gitlab })
    await fetch(`${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/merge_requests/${pullRequestId}/approve`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
    })
    await checkStageApprovalStatus(SLUG, { gitlab })

    // Our fake, like the Azure DevOps/GitHub ones, never auto-deletes a merged source branch —
    // simulate the "a stage branch was cleaned up after merge" precondition `reopenStage` assumes, the
    // same way tests/githubStageApproval.test.js deletes the GitHub ref directly for the identical
    // reason.
    await fetch(`${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/repository/branches/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
      headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
    })

    const result = await reopenStage(SLUG, SHAPE.id, { gitlab })
    assert.equal(result.previousStage, definition.stages[1].id)
    assert.ok(result.reopened[SHAPE.id])
    assert.equal(await findGitLabStageBranch(gitlab, SLUG, SHAPE.id), result.branch)

    const instance = await readInstance(SLUG, { gitlab })
    assert.equal(instance.stage, SHAPE.id)
    assert.ok(instance.reopened?.[SHAPE.id])
  })
})

test('reopenStage (GitLab) refuses when the stage branch already exists', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    await fillShapeStage(gitlab, branch)
    const { pullRequestId } = await requestStageApproval(SLUG, { gitlab })
    await fetch(`${baseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}/merge_requests/${pullRequestId}/approve`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
    })
    await checkStageApprovalStatus(SLUG, { gitlab })

    // Unlike the test above, the shape branch is deliberately left in place (never deleted) —
    // reopen must refuse rather than recreate over it.
    await assert.rejects(() => reopenStage(SLUG, SHAPE.id, { gitlab }), (err) => {
      assert.equal(err.status, 409)
      return true
    })
  })
})
