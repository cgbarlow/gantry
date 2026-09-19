import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError } from '../lib/providerErrors.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { loadDefinition } from '../lib/definition.js'
import { stageBranchName, findGitHubStageBranch, resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// The GitHub twin of tests/stageBranch.test.js (#12, ADR-0037/0040 — GitHub is a Provider at full
// parity, stage branches included). `stageBranchName` itself is already covered there (it's the same
// pure function, re-exported unchanged) — this file exercises `findGitHubStageBranch`/
// `resolveGitHubStageBranch`'s own GitHub-specific behaviour against a real fake GitHub server.

const SLUG = 'my-initiative'

function locationFor(baseUrl, overrides = {}) {
  return { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl, ...overrides }
}

function withServer({ files = {}, branchFiles = {} } = {}, fn) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files, branchFiles }, fn)
}

const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages

test('findGitHubStageBranch reports undefined (never creates anything) when a stage has no branch yet', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await findGitHubStageBranch(github, SLUG, SHAPE.id)
    assert.equal(branch, undefined)

    const client = createGitHubClient(github)
    assert.equal(await client.branchExists(stageBranchName(SLUG, SHAPE.id)), false)
  })
})

test('findGitHubStageBranch reports the branch name once it already exists, without touching it again', async () => {
  const branch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' },
      branchFiles: { [branch]: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } },
    },
    async (baseUrl) => {
      const github = locationFor(baseUrl)
      assert.equal(await findGitHubStageBranch(github, SLUG, SHAPE.id), branch)
    }
  )
})

test('resolveGitHubStageBranch creates a fresh branch from "main" for the first stage', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)

    assert.equal(branch, stageBranchName(SLUG, SHAPE.id))
    const client = createGitHubClient(github)
    assert.equal(await client.branchExists(branch), true)
    // Stacked from 'main' means it starts out carrying main's own content.
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch }),
      'slug: my-initiative\nstage: shape\n'
    )
  })
})

test('resolveGitHubStageBranch is idempotent: a second call for the same stage returns the same branch without creating it again', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const first = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    // A second createBranch call for a name that already exists would throw
    // (see tests/githubClient.test.js) — resolveGitHubStageBranch must detect
    // that the branch already exists and simply return it, never attempting
    // to create it again.
    const second = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
    assert.equal(first, second)
  })
})

test('resolveGitHubStageBranch stacks a later stage\'s branch on the immediately preceding stage\'s branch when it is still open', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    const shapeBranch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)

    const client = createGitHubClient(github)
    // Real work happens on the shape branch before hld-define begins.
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', 'slug: my-initiative\nstage: hld-define\n', {
      branch: shapeBranch,
    })

    const hldBranch = await resolveGitHubStageBranch(github, definition, SLUG, HLD_DEFINE.id)
    assert.equal(hldBranch, stageBranchName(SLUG, HLD_DEFINE.id))

    // Stacked, not forked fresh from main: it carries the shape branch's
    // own (not yet merged) content, not main's stale "stage: shape".
    assert.equal(
      await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
      'slug: my-initiative\nstage: hld-define\n'
    )
  })
})

test('resolveGitHubStageBranch forks fresh from "main" instead of stacking once the preceding stage\'s branch has already merged (and been deleted)', async () => {
  const shapeBranch = stageBranchName(SLUG, SHAPE.id)
  await withServer(
    {
      files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: hld-define\n' },
      // The shape branch is never seeded/created here — simulating a stage
      // whose PR already merged: main already reflects it.
    },
    async (baseUrl) => {
      const github = locationFor(baseUrl)
      const hldBranch = await resolveGitHubStageBranch(github, definition, SLUG, HLD_DEFINE.id)

      const client = createGitHubClient(github)
      assert.equal(await client.branchExists(shapeBranch), false)
      assert.equal(
        await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', { branch: hldBranch }),
        'slug: my-initiative\nstage: hld-define\n'
      )
    }
  )
})

test('resolveGitHubStageBranch throws for a stage that is not part of the given definition', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    await assert.rejects(
      () => resolveGitHubStageBranch(github, definition, SLUG, 'not-a-real-stage'),
      /has no stage "not-a-real-stage"/
    )
  })
})

test('resolveGitHubStageBranch propagates a rejected PAT as AuthenticationError, the same as createBranch itself', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' } }, async (baseUrl) => {
    const badGithub = locationFor(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(async () => {
      try {
        await resolveGitHubStageBranch(badGithub, definition, SLUG, SHAPE.id)
      } catch (err) {
        assert.equal(err.name, 'GitHubAuthenticationError')
        assert.ok(err instanceof AuthenticationError)
        throw err
      }
    })
  })
})

test('findGitHubStageBranch never creates a branch that does not yet exist, even after a sibling stage does', async () => {
  await withServer({ files: { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\nstage: shape\n' } }, async (baseUrl) => {
    const github = locationFor(baseUrl)
    await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)

    // hld-define's own branch must still not exist — merely resolving shape's
    // branch (a write) must never speculatively create a later stage's.
    const found = await findGitHubStageBranch(github, SLUG, HLD_DEFINE.id)
    assert.equal(found, undefined)
    const client = createGitHubClient(github)
    assert.equal(await client.branchExists(stageBranchName(SLUG, HLD_DEFINE.id)), false)
  })
})
