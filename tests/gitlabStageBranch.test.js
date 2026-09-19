import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError } from '../lib/providerErrors.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { loadDefinition } from '../lib/definition.js'
import { stageBranchName, findGitLabStageBranch, resolveGitLabStageBranch } from '../lib/gitlabStageBranch.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'

// The GitLab twin of tests/githubStageBranch.test.js (#29, ADR-0037/0041 — GitLab is a Provider at
// full parity, stage branches included). `stageBranchName` itself is already covered in
// tests/stageBranch.test.js (it's the same pure function, re-exported unchanged) — this file exercises
// `findGitLabStageBranch`/`resolveGitLabStageBranch`'s own GitLab-specific behaviour against a real
// fake GitLab server.

const SLUG = 'my-initiative'

function locationFor(baseUrl, overrides = {}) {
  return { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl, ...overrides }
}

function withServer({ files = {}, branchFiles = {} } = {}, fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files, branchFiles }, fn)
}

const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages

test('findGitLabStageBranch reports undefined (never creates anything) when a stage has no branch yet', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await findGitLabStageBranch(gitlab, SLUG, SHAPE.id)
    assert.equal(branch, undefined)

    const client = createGitLabClient(gitlab)
    assert.equal(await client.branchExists(stageBranchName(SLUG, SHAPE.id)), false)
  })
})

test('findGitLabStageBranch reports the branch name once it already exists, without touching it again', async () => {
  const branch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' },
      branchFiles: { [branch]: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } },
    },
    async (baseUrl) => {
      const gitlab = locationFor(baseUrl)
      assert.equal(await findGitLabStageBranch(gitlab, SLUG, SHAPE.id), branch)
    }
  )
})

test('resolveGitLabStageBranch creates a fresh branch from "main" for the first stage', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)

    assert.equal(branch, stageBranchName(SLUG, SHAPE.id))
    const client = createGitLabClient(gitlab)
    assert.equal(await client.branchExists(branch), true)
    // Stacked from 'main' means it starts out carrying main's own content.
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch }),
      'slug: my-initiative\nstage: shape\n'
    )
  })
})

test('resolveGitLabStageBranch is idempotent: a second call for the same stage returns the same branch without creating it again', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const first = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    // A second createBranch call for a name that already exists would 400 ("Branch already exists")
    // (see tests/gitlabClient.test.js) — resolveGitLabStageBranch must detect that the branch already
    // exists and simply return it, never attempting to create it again.
    const second = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
    assert.equal(first, second)
  })
})

test('resolveGitLabStageBranch stacks a later stage\'s branch on the immediately preceding stage\'s branch when it is still open', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const shapeBranch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)

    const client = createGitLabClient(gitlab)
    // Real work happens on the shape branch before hld-define begins.
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', 'slug: my-initiative\nstage: hld-define\n', {
      branch: shapeBranch,
    })

    const hldBranch = await resolveGitLabStageBranch(gitlab, definition, SLUG, HLD_DEFINE.id)
    assert.equal(hldBranch, stageBranchName(SLUG, HLD_DEFINE.id))

    // Stacked, not forked fresh from main: it carries the shape branch's
    // own (not yet merged) content, not main's stale "stage: shape".
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
      'slug: my-initiative\nstage: hld-define\n'
    )
  })
})

test('resolveGitLabStageBranch forks fresh from "main" instead of stacking once the preceding stage\'s branch has already merged (and been deleted)', async () => {
  const shapeBranch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: hld-define\n' },
      // The shape branch is never seeded/created here — simulating a stage
      // whose MR already merged: main already reflects it.
    },
    async (baseUrl) => {
      const gitlab = locationFor(baseUrl)
      const hldBranch = await resolveGitLabStageBranch(gitlab, definition, SLUG, HLD_DEFINE.id)

      const client = createGitLabClient(gitlab)
      assert.equal(await client.branchExists(shapeBranch), false)
      assert.equal(
        await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
        'slug: my-initiative\nstage: hld-define\n'
      )
    }
  )
})

// ADR-0026: re-opening a signed-off stage recreates its branch from current `main` — the same
// "no predecessor branch left to stack on, so fork fresh from main" path exercised above for a
// merged-and-deleted predecessor. The re-open action itself (#33, mirroring GitHub's #13) calls
// `lib/gitlabClient.js`'s own `createBranch(name, { from: 'main' })` directly rather than through
// `resolveGitLabStageBranch` (it must 409 if the target branch still exists, a stricter contract than
// this idempotent resolver's), but the underlying GitLab primitive this test proves — a branch created
// `from: 'main'` genuinely carries main's current (approved) content, not some stale ancestor's — is
// exactly what that later re-open path depends on.
test('a branch created "from: main" (the re-open primitive, ADR-0026) carries main\'s current content, not a stale one', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\napproved: true\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    const client = createGitLabClient(gitlab)
    const branch = stageBranchName(SLUG, SHAPE.id)

    assert.equal(await client.branchExists(branch), false)
    await client.createBranch(branch, { from: 'main' })

    assert.equal(await client.branchExists(branch), true)
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch }),
      'slug: my-initiative\nstage: shape\napproved: true\n'
    )
  })
})

test('resolveGitLabStageBranch throws for a stage that is not part of the given definition', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    await assert.rejects(
      () => resolveGitLabStageBranch(gitlab, definition, SLUG, 'not-a-real-stage'),
      /has no stage "not-a-real-stage"/
    )
  })
})

test('resolveGitLabStageBranch propagates a rejected PAT as AuthenticationError, the same as createBranch itself', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const badGitlab = locationFor(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(async () => {
      try {
        await resolveGitLabStageBranch(badGitlab, definition, SLUG, SHAPE.id)
      } catch (err) {
        assert.equal(err.name, 'GitLabAuthenticationError')
        assert.ok(err instanceof AuthenticationError)
        throw err
      }
    })
  })
})

test('findGitLabStageBranch never creates a branch that does not yet exist, even after a sibling stage does', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const gitlab = locationFor(baseUrl)
    await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)

    // hld-define's own branch must still not exist — merely resolving shape's
    // branch (a write) must never speculatively create a later stage's.
    const found = await findGitLabStageBranch(gitlab, SLUG, HLD_DEFINE.id)
    assert.equal(found, undefined)
    const client = createGitLabClient(gitlab)
    assert.equal(await client.branchExists(stageBranchName(SLUG, HLD_DEFINE.id)), false)
  })
})
