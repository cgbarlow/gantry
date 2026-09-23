import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NotFoundError } from '../lib/providerErrors.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { loadDefinition } from '../lib/definition.js'
import { stageBranchName, findStageBranch, resolveStageBranch, getStageSyncStatus } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

const SLUG = 'my-initiative'

function locationFor(baseUrl, overrides = {}) {
  return { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, ...overrides }
}

function withServer({ files = {}, branchFiles = {} } = {}, fn) {
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files, branchFiles },
    fn
  )
}

const definition = loadDefinition('design')
// design's own stage order (definitions/design/definition.yaml): shape -> hld-define -> detailed-design -> handover.
const [SHAPE, HLD_DEFINE] = definition.stages

test('stageBranchName is a pure, deterministic function of slug and stageId', () => {
  assert.equal(stageBranchName(SLUG, 'shape'), `gantry-workspace/${SLUG}/shape`)
  assert.equal(stageBranchName('other-initiative', 'shape'), 'gantry-workspace/other-initiative/shape')
  assert.equal(stageBranchName(SLUG, 'hld-define'), `gantry-workspace/${SLUG}/hld-define`)
})

test('findStageBranch reports undefined (never creates anything) when a stage has no branch yet', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await findStageBranch(azureDevOps, SLUG, SHAPE.id)
    assert.equal(branch, undefined)

    // Proven not just by the return value: the branch genuinely was never created.
    const client = createAzureDevOpsClient(azureDevOps)
    assert.equal(await client.branchExists(stageBranchName(SLUG, SHAPE.id)), false)
  })
})

test('findStageBranch reports the branch name once it already exists, without touching it again', async () => {
  const branch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' },
      branchFiles: { [branch]: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } },
    },
    async (baseUrl) => {
      const azureDevOps = locationFor(baseUrl)
      assert.equal(await findStageBranch(azureDevOps, SLUG, SHAPE.id), branch)
    }
  )
})

test('resolveStageBranch creates a fresh branch from "main" for the first stage', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)

    assert.equal(branch, stageBranchName(SLUG, SHAPE.id))
    const client = createAzureDevOpsClient(azureDevOps)
    assert.equal(await client.branchExists(branch), true)
    // Stacked from 'main' means it starts out carrying main's own content.
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch }),
      'slug: my-initiative\nstage: shape\n'
    )
  })
})

test('resolveStageBranch is idempotent: a second call for the same stage returns the same branch without creating it again', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const first = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    // A second createBranch call for a name that already exists would throw
    // (see tests/azureDevOpsClient.test.js) — resolveStageBranch must detect
    // that the branch already exists and simply return it, never attempting
    // to create it again.
    const second = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    assert.equal(first, second)
  })
})

test('resolveStageBranch stacks a later stage\'s branch on the immediately preceding stage\'s branch when it is still open', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const shapeBranch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)

    const client = createAzureDevOpsClient(azureDevOps)
    // Real work happens on the shape branch before hld-define begins.
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', 'slug: my-initiative\nstage: hld-define\n', {
      branch: shapeBranch,
    })

    const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)
    assert.equal(hldBranch, stageBranchName(SLUG, HLD_DEFINE.id))

    // Stacked, not forked fresh from main: it carries the shape branch's
    // own (not yet merged) content, not main's stale "stage: shape".
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
      'slug: my-initiative\nstage: hld-define\n'
    )
  })
})

test('resolveStageBranch forks fresh from "main" instead of stacking once the preceding stage\'s branch has already merged (and been deleted)', async () => {
  const shapeBranch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: hld-define\n' },
      // The shape branch is never seeded/created here — simulating a stage
      // whose PR already merged (and, per ADR-0014, whose source branch was
      // deleted on completion): main already reflects it.
    },
    async (baseUrl) => {
      const azureDevOps = locationFor(baseUrl)
      const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)

      const client = createAzureDevOpsClient(azureDevOps)
      assert.equal(await client.branchExists(shapeBranch), false)
      assert.equal(
        await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
        'slug: my-initiative\nstage: hld-define\n'
      )
    }
  )
})

test('resolveStageBranch throws for a stage that is not part of the given definition', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    await assert.rejects(
      () => resolveStageBranch(azureDevOps, definition, SLUG, 'not-a-real-stage'),
      /has no stage "not-a-real-stage"/
    )
  })
})

test('resolveStageBranch propagates a rejected PAT as AuthenticationError, the same as createBranch itself', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const badAzureDevOps = locationFor(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(async () => {
      try {
        await resolveStageBranch(badAzureDevOps, definition, SLUG, SHAPE.id)
      } catch (err) {
        assert.equal(err.name, 'AuthenticationError')
        throw err
      }
    })
  })
})

test('#140: getStageSyncStatus reports no advisory for a branch that is only ahead of main (its own edits, nothing new on main)', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    const client = createAzureDevOpsClient(azureDevOps)
    // The branch's own edit — main is never touched.
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', 'slug: my-initiative\nstage: shape\nedited: true\n', { branch })

    const status = await getStageSyncStatus(azureDevOps, SLUG, SHAPE.id)
    assert.deepEqual(status, { behind: false, behindFiles: [], ahead: true })
  })
})

test('#140: getStageSyncStatus lists only main\'s own changes as behindFiles, never the branch\'s own edits, once both have diverged', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    const client = createAzureDevOpsClient(azureDevOps)

    // The branch resolves its own review comments (its own edit)...
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', 'slug: my-initiative\nstage: shape\nresolved: true\n', { branch })
    // ...while main, independently, picks up a real new file the branch never saw.
    await client.writeFile('/gantry-workspace/my-initiative/extra.md', 'extra on main\n', { branch: 'main' })

    const status = await getStageSyncStatus(azureDevOps, SLUG, SHAPE.id)
    assert.equal(status.ahead, true)
    assert.equal(status.behind, true)
    assert.deepEqual(status.behindFiles, ['/gantry-workspace/my-initiative/extra.md'])
  })
})

test('findStageBranch never creates a branch that does not yet exist, even after a sibling stage does', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const azureDevOps = locationFor(baseUrl)
    await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)

    // hld-define's own branch must still not exist — merely resolving shape's
    // branch (a write) must never speculatively create a later stage's.
    const found = await findStageBranch(azureDevOps, SLUG, HLD_DEFINE.id)
    assert.equal(found, undefined)
    const client = createAzureDevOpsClient(azureDevOps)
    assert.equal(await client.branchExists(stageBranchName(SLUG, HLD_DEFINE.id)), false)
  })
})
