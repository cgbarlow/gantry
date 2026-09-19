import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError } from '../lib/providerErrors.js'
import { createBitbucketClient } from '../lib/bitbucketClient.js'
import { loadDefinition } from '../lib/definition.js'
import { stageBranchName, findBitbucketStageBranch, resolveBitbucketStageBranch } from '../lib/bitbucketStageBranch.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// The Bitbucket twin of tests/gitlabStageBranch.test.js (#43, ADR-0037/0042 — Atlassian is a Provider
// at full parity, stage branches included). `stageBranchName` itself is already covered in
// tests/stageBranch.test.js (it's the same pure function, re-exported unchanged) — this file exercises
// `findBitbucketStageBranch`/`resolveBitbucketStageBranch`'s own Bitbucket-specific behaviour against a
// real fake Bitbucket Cloud server.

const SLUG = 'my-initiative'

function locationFor(baseUrl, overrides = {}) {
  return { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl, ...overrides }
}

function withServer({ files = {}, branchFiles = {} } = {}, fn) {
  return withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files, branchFiles }, fn)
}

const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages

test('findBitbucketStageBranch reports undefined (never creates anything) when a stage has no branch yet', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    const branch = await findBitbucketStageBranch(bitbucket, SLUG, SHAPE.id)
    assert.equal(branch, undefined)

    const client = createBitbucketClient(bitbucket)
    assert.equal(await client.branchExists(stageBranchName(SLUG, SHAPE.id)), false)
  })
})

test('findBitbucketStageBranch reports the branch name once it already exists, without touching it again', async () => {
  const branch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' },
      branchFiles: { [branch]: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } },
    },
    async (baseUrl) => {
      const bitbucket = locationFor(baseUrl)
      assert.equal(await findBitbucketStageBranch(bitbucket, SLUG, SHAPE.id), branch)
    }
  )
})

test('resolveBitbucketStageBranch creates a fresh branch from "main" for the first stage', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    const branch = await resolveBitbucketStageBranch(bitbucket, definition, SLUG, SHAPE.id)

    assert.equal(branch, stageBranchName(SLUG, SHAPE.id))
    const client = createBitbucketClient(bitbucket)
    assert.equal(await client.branchExists(branch), true)
    // Stacked from 'main' means it starts out carrying main's own content.
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch }),
      'slug: my-initiative\nstage: shape\n'
    )
  })
})

test('resolveBitbucketStageBranch is idempotent: a second call for the same stage returns the same branch without creating it again', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    const first = await resolveBitbucketStageBranch(bitbucket, definition, SLUG, SHAPE.id)
    // A second createBranch call for a name that already exists would 400 ("Branch already exists")
    // (see tests/bitbucketClient.test.js) — resolveBitbucketStageBranch must detect that the branch
    // already exists and simply return it, never attempting to create it again.
    const second = await resolveBitbucketStageBranch(bitbucket, definition, SLUG, SHAPE.id)
    assert.equal(first, second)
  })
})

test('resolveBitbucketStageBranch stacks a later stage\'s branch on the immediately preceding stage\'s branch when it is still open', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    const shapeBranch = await resolveBitbucketStageBranch(bitbucket, definition, SLUG, SHAPE.id)

    const client = createBitbucketClient(bitbucket)
    // Real work happens on the shape branch before hld-define begins.
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', 'slug: my-initiative\nstage: hld-define\n', {
      branch: shapeBranch,
    })

    const hldBranch = await resolveBitbucketStageBranch(bitbucket, definition, SLUG, HLD_DEFINE.id)
    assert.equal(hldBranch, stageBranchName(SLUG, HLD_DEFINE.id))

    // Stacked, not forked fresh from main: it carries the shape branch's
    // own (not yet merged) content, not main's stale "stage: shape".
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
      'slug: my-initiative\nstage: hld-define\n'
    )
  })
})

test('resolveBitbucketStageBranch forks fresh from "main" instead of stacking once the preceding stage\'s branch has already merged (and been deleted)', async () => {
  const shapeBranch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: hld-define\n' },
      // The shape branch is never seeded/created here — simulating a stage
      // whose PR already merged: main already reflects it.
    },
    async (baseUrl) => {
      const bitbucket = locationFor(baseUrl)
      const hldBranch = await resolveBitbucketStageBranch(bitbucket, definition, SLUG, HLD_DEFINE.id)

      const client = createBitbucketClient(bitbucket)
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
// merged-and-deleted predecessor. The re-open action itself (a later ticket, mirroring GitHub's #13
// and GitLab's #33) calls `lib/bitbucketClient.js`'s own `createBranch(name, { from: 'main' })`
// directly rather than through `resolveBitbucketStageBranch` (it must reject if the target branch
// still exists, a stricter contract than this idempotent resolver's), but the underlying Bitbucket
// primitive this test proves — a branch created `from: 'main'` genuinely carries main's current
// (approved) content, not some stale ancestor's — is exactly what that later re-open path depends on.
test('a branch created "from: main" (the re-open primitive, ADR-0026) carries main\'s current content, not a stale one', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\napproved: true\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    const client = createBitbucketClient(bitbucket)
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

test('resolveBitbucketStageBranch throws for a stage that is not part of the given definition', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    await assert.rejects(
      () => resolveBitbucketStageBranch(bitbucket, definition, SLUG, 'not-a-real-stage'),
      /has no stage "not-a-real-stage"/
    )
  })
})

test('resolveBitbucketStageBranch propagates a rejected PAT as AuthenticationError, the same as createBranch itself', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const badBitbucket = locationFor(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(async () => {
      try {
        await resolveBitbucketStageBranch(badBitbucket, definition, SLUG, SHAPE.id)
      } catch (err) {
        assert.equal(err.name, 'BitbucketAuthenticationError')
        assert.ok(err instanceof AuthenticationError)
        throw err
      }
    })
  })
})

test('findBitbucketStageBranch never creates a branch that does not yet exist, even after a sibling stage does', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const bitbucket = locationFor(baseUrl)
    await resolveBitbucketStageBranch(bitbucket, definition, SLUG, SHAPE.id)

    // hld-define's own branch must still not exist — merely resolving shape's
    // branch (a write) must never speculatively create a later stage's.
    const found = await findBitbucketStageBranch(bitbucket, SLUG, HLD_DEFINE.id)
    assert.equal(found, undefined)
    const client = createBitbucketClient(bitbucket)
    assert.equal(await client.branchExists(stageBranchName(SLUG, HLD_DEFINE.id)), false)
  })
})
