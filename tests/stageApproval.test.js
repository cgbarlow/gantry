import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { readInstance } from '../lib/instance.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// #124, ADR-0014: the Assignee's "Request approval" action for a
// Workspace-backed instance — opens a Pull Request from a stage's own
// branch into "main", but only once that stage's gate has genuinely
// passed. Talks to the in-process fake Azure DevOps server throughout
// (Git + Pull Requests endpoints), never a mocked client, the same
// convention every other Azure DevOps client test in this repo follows.

const ORGANIZATION = 'stage-approval-org'
const PROJECT = 'stage-approval-project'
const REPOSITORY = 'stage-approval-repo'
const VALID_PAT = 'valid-test-pat'
const SLUG = 'my-initiative'

const definition = loadDefinition('design')
const [SHAPE] = definition.stages

function locationFor(baseUrl, overrides = {}) {
  return { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, ...overrides }
}

function withServer(overrides, fn) {
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, ...overrides },
    fn
  )
}

// Writes the Shape stage's three modules (the same fixture content
// tests/workItemLink.test.js's own fillShapeStage copies) onto `branch`, so
// checkGate's "business-case" gate genuinely passes there.
async function fillShapeStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
    const text = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
}

function seedInstanceYaml() {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` }
}

test('requestStageApproval opens a Pull Request from the stage branch into "main" once the gate has passed, and records its id on instance.yaml', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    const result = await requestStageApproval(SLUG, { azureDevOps })
    assert.equal(result.stage.id, 'shape')
    assert.equal(result.stage.gate, 'business-case')
    assert.equal(result.branch, branch)
    assert.equal(typeof result.pullRequestId, 'number')
    assert.equal(result.status, 'active')
    assert.match(result.webUrl, new RegExp(`/pullrequest/${result.pullRequestId}$`))

    const prClient = createAzureDevOpsPullRequestsClient(azureDevOps)
    const pr = await prClient.getPullRequest(result.pullRequestId)
    assert.equal(pr.sourceRefName, `refs/heads/${branch}`)
    assert.equal(pr.targetRefName, 'refs/heads/main')
    assert.equal(pr.title, `Request approval: ${SHAPE.title} — ${SLUG}`)

    // Recorded on instance.yaml, on the stage's own branch (not "main" —
    // the stage hasn't merged yet).
    const instance = await readInstance(SLUG, { azureDevOps: { ...azureDevOps, branch } })
    assert.equal(instance.pullRequests.shape, result.pullRequestId)
    // Every other pre-existing field on instance.yaml preserved.
    assert.equal(instance.definition, 'design')
    assert.equal(instance.stage, 'shape')
  })
})

test('requestStageApproval refuses to open a Pull Request when the gate has not passed, and opens nothing', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    // The branch exists (work has begun), but no module content was ever saved to it — the gate can't pass.
    await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)

    await assert.rejects(() => requestStageApproval(SLUG, { azureDevOps }), /has not passed/)

    const prClient = createAzureDevOpsPullRequestsClient(azureDevOps)
    await assert.rejects(() => prClient.getPullRequest(1), /Azure DevOps found no item/)
  })
})

test('requestStageApproval refuses when the stage has no branch yet — never creates one, and never opens a Pull Request', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)

    await assert.rejects(() => requestStageApproval(SLUG, { azureDevOps }), /has no branch for stage "shape" yet/)

    const client = createAzureDevOpsClient(azureDevOps)
    assert.equal(await client.branchExists(stageBranchName(SLUG, SHAPE.id)), false)
  })
})

test('requestStageApproval refuses to request approval twice for the same stage', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    const first = await requestStageApproval(SLUG, { azureDevOps })
    await assert.rejects(
      () => requestStageApproval(SLUG, { azureDevOps }),
      new RegExp(`already has a Pull Request \\(#${first.pullRequestId}\\)`)
    )
  })
})

test('requestStageApproval requires options.azureDevOps — a local instance has no Pull Request to open', async () => {
  await assert.rejects(() => requestStageApproval(SLUG, {}), /Workspace-backed instances only/)
})

test('requestStageApproval propagates a rejected PAT as AzureDevOpsAuthenticationError', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    const badAzureDevOps = locationFor(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(async () => {
      try {
        await requestStageApproval(SLUG, { azureDevOps: badAzureDevOps })
      } catch (err) {
        assert.equal(err.name, 'AzureDevOpsAuthenticationError')
        throw err
      }
    })
  })
})
