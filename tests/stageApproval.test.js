import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { readInstance, instanceDisplayName, renderedArtefactBasename } from '../lib/instance.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #124, ADR-0014: the Assignee's "Request approval" action for a
// Workspace-backed instance — opens a Pull Request from a stage's own
// branch into "main", but only once that stage's gate has genuinely
// passed. Talks to the in-process fake Azure DevOps server throughout
// (Git + Pull Requests endpoints), never a mocked client, the same
// convention every other Azure DevOps client test in this repo follows.

const ORGANIZATION = 'stage-approval-org'
const PROJECT = 'stage-approval-project'
const REPOSITORY = 'stage-approval-repo'
const SLUG = 'my-initiative'

const definition = loadDefinition('design')
// WI226: rendered artefacts are pushed as "<Instance name> - <Full artefact title>.docx".
const INSTANCE_NAME = instanceDisplayName({ slug: SLUG })
const outDocxRepoPath = (artefactId) =>
  `gantry-workspace/${SLUG}/out/${renderedArtefactBasename(
    INSTANCE_NAME,
    definition.artefacts.find((a) => a.id === artefactId).title
  )}.docx`
const [SHAPE] = definition.stages
const DETAILED_DESIGN = definition.stages.find((stage) => stage.id === 'detailed-design')

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
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    const text = exampleModuleText(moduleId)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(outDocxRepoPath('soap'), 'rendered soap', { branch })
}

async function fillDetailedDesignStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of DETAILED_DESIGN.modules) {
    const text = exampleModuleText(moduleId)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  for (const artefactId of ['sad', 'ssad']) {
    await client.writeFile(outDocxRepoPath(artefactId), `rendered ${artefactId}`, { branch })
  }
}

function seedInstanceYaml(stage = SHAPE) {
  // Pinned to design v2 — the fixture module text seeded above is v2-shaped (WI #348).
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${stage.id}\ndefinitionVersion: 2\n` }
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
    assert.match(pr.description, /Requests approval for the "SOAP" stage of gantry instance "my-initiative" \(gate "business-case"\)\./)
    assert.match(pr.description, /\[Solution on a Page\]\(http:\/\/localhost:\d+\/stage-approval-org\/stage-approval-project\/_git\/stage-approval-repo\?path=%2Fgantry-workspace%2Fmy-initiative%2Fout%2FMY\+Initiative\+-\+Solution\+on\+a\+Page\.docx&version=GBgantry-workspace%2Fmy-initiative%2Fshape&_a=contents\)/)

    // Recorded on instance.yaml, on the stage's own branch (not "main" —
    // the stage hasn't merged yet).
    const instance = await readInstance(SLUG, { azureDevOps: { ...azureDevOps, branch } })
    assert.equal(instance.pullRequests.shape, result.pullRequestId)
    // Every other pre-existing field on instance.yaml preserved.
    assert.equal(instance.definition, 'design')
    assert.equal(instance.stage, 'shape')
  })
})

test('requestStageApproval verifies and links every rendered artefact for a multi-artefact gate', async () => {
  await withServer({ files: seedInstanceYaml(DETAILED_DESIGN) }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, DETAILED_DESIGN.id)
    await fillDetailedDesignStage(azureDevOps, branch)

    const result = await requestStageApproval(SLUG, { azureDevOps })
    const pr = await createAzureDevOpsPullRequestsClient(azureDevOps).getPullRequest(result.pullRequestId)

    assert.match(pr.description, /\[Solution Architecture Document\]\([^)]*path=%2Fgantry-workspace%2Fmy-initiative%2Fout%2FMY\+Initiative\+-\+Solution\+Architecture\+Document\.docx[^)]*version=GBgantry-workspace%2Fmy-initiative%2Fdetailed-design[^)]*\)/)
    assert.match(pr.description, /\[Solution Support Architecture Document\]\([^)]*path=%2Fgantry-workspace%2Fmy-initiative%2Fout%2FMY\+Initiative\+-\+Solution\+Support\+Architecture\+Document\.docx[^)]*version=GBgantry-workspace%2Fmy-initiative%2Fdetailed-design[^)]*\)/)
  })
})

test('requestStageApproval auto-renders missing required artefacts and opens PR (WI257)', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    const client = createAzureDevOpsClient(azureDevOps)
    for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
      const text = exampleModuleText(moduleId)
      await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
    }

    // No rendered artefact on branch yet — WI257 auto-renders before opening PR
    assert.equal(await client.fileExists(outDocxRepoPath('soap'), branch), false)

    const result = await requestStageApproval(SLUG, { azureDevOps })
    assert.equal(typeof result.pullRequestId, 'number')
    assert.equal(result.stage.id, 'shape')

    // The rendered .docx was committed to the stage branch before the PR opened
    const content = await client.getFileContent(outDocxRepoPath('soap'), { branch })
    const bytes = Buffer.from(content, 'base64')
    assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'auto-rendered artefact should be a real docx')

    const pr = await createAzureDevOpsPullRequestsClient(azureDevOps).getPullRequest(result.pullRequestId)
    assert.equal(pr.sourceRefName, `refs/heads/${branch}`)
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

test('requestStageApproval propagates a rejected PAT as AuthenticationError', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    const badAzureDevOps = locationFor(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(async () => {
      try {
        await requestStageApproval(SLUG, { azureDevOps: badAzureDevOps })
      } catch (err) {
        assert.equal(err.name, 'AuthenticationError')
        throw err
      }
    })
  })
})

test('requestStageApproval still aborts with render error when artefact rendering genuinely fails (WI257)', async () => {
  // Seed the branch with module content via branchFiles so pushesMade starts at 0,
  // then fail every subsequent push — the module writes are already present, so gate passes,
  // but auto-render's pushes will fail and must propagate as a render error, not a missing-artefact error.
  const branch = `gantry-workspace/${SLUG}/shape`
  const shapeModules = {
    [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${SHAPE.id}\n`,
  }
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    shapeModules[`/gantry-workspace/${SLUG}/modules/${moduleId}.md`] = readFileSync(
      join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`),
      'utf8'
    )
  }
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: seedInstanceYaml(),
      branchFiles: { [branch]: shapeModules },
      failAfterPushes: 0,
    },
    async (baseUrl) => {
      const azureDevOps = locationFor(baseUrl)
      // Branch already exists via seed; ensure it resolves
      const resolved = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
      assert.equal(resolved, branch)

      await assert.rejects(() => requestStageApproval(SLUG, { azureDevOps }), /Azure DevOps|render/i)

      await assert.rejects(() => createAzureDevOpsPullRequestsClient(azureDevOps).getPullRequest(1), /Azure DevOps found no item/)
    }
  )
})

test('requestStageApproval does not block when required artefacts are already rendered (WI257)', async () => {
  await withServer({ files: seedInstanceYaml() }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    // Pre-rendered artefact already on branch — request should still open PR (re-render or skip both fine)
    const client = createAzureDevOpsClient(azureDevOps)
    assert.equal(await client.fileExists(outDocxRepoPath('soap'), branch), true)

    const result = await requestStageApproval(SLUG, { azureDevOps })
    assert.equal(typeof result.pullRequestId, 'number')

    // Committed file still exists and PR carries it
    assert.equal(await client.fileExists(outDocxRepoPath('soap'), branch), true)
    const pr = await createAzureDevOpsPullRequestsClient(azureDevOps).getPullRequest(result.pullRequestId)
    assert.match(pr.description, /Solution on a Page/)
  })
})
