import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { archiveInstance } from '../lib/instanceRegistry.js'
import {
  withRunningServerForProvider,
  withScratchInstances,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #11 — GitHub content store: save and load stage content. Mirrors the equivalent Azure DevOps
// coverage in tests/server.test.js (creation, load, single/bulk save, byte-identical round-trip),
// exercised against a real fake GitHub server (tests/helpers/fakeGitHubServer.js) via real HTTP
// requests to a real running gantry server — the primary seam per #1's Testing Decisions.

function withScratchGitHubServer(fn, { fakeServerOptions } = {}) {
  return withScratchInstances((instancesDir) =>
    withRunningServerForProvider('github', { options: { instancesDir }, fakeServerOptions }, (ctx) => fn({ ...ctx, instancesDir }))
  )
}

async function createGitHubInstance({ gantryBase, providerBaseUrl }, slug, overrides = {}) {
  return fetch(`${gantryBase}/api/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    body: JSON.stringify({
      definition: 'design',
      slug,
      owner: 'a-module-owner',
      assignee: 'c.barlow',
      github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl },
      ...overrides,
    }),
  })
}

test('POST /api/instances with a valid GitHub location and PAT creates instance.yaml + first-stage module files in that repo, registers it, and the instance then appears in GET /api/instances', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const { gantryBase, providerBaseUrl, instancesDir } = ctx
    const res = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(res.status, 201)
    const created = await res.json()
    assert.equal(created.slug, 'remote-initiative')
    assert.equal(created.definition, 'design')
    assert.equal(created.stage, 'shape')
    assert.equal(created.status, 'incomplete')
    assert.equal(created.assignee, 'c.barlow')
    assert.equal(created.workspace.location.owner, GITHUB_OWNER)
    assert.equal(created.workspace.location.repository, GITHUB_REPOSITORY)
    assert.equal(typeof created.workspace.id, 'string')

    // Verified directly against the fake GitHub repo, not just gantry's own idea of what it wrote.
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
    const instanceYaml = await client.getFileContent('gantry-workspace/remote-initiative/instance.yaml')
    assert.match(instanceYaml, /definition: design/)
    assert.match(instanceYaml, /slug: remote-initiative/)
    assert.match(instanceYaml, /stage: shape/)
    assert.match(instanceYaml, /assignee: c\.barlow/)
    const definition = loadDefinition('design')
    for (const moduleId of definition.stages[0].modules) {
      const moduleText = await client.getFileContent(`gantry-workspace/remote-initiative/modules/${moduleId}.md`)
      assert.match(moduleText, /owner: a-module-owner/)
    }

    // Not just written to the fake repo — no instancesDir directory ever created for it locally.
    assert.equal(existsSync(join(instancesDir, 'remote-initiative')), false)

    const listingRes = await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(listingRes.status, 200)
    const listing = await listingRes.json()
    const listedRow = listing.find((i) => i.slug === 'remote-initiative')
    assert.equal(listedRow.definition, 'design')
    assert.equal(listedRow.stage, 'shape')
    assert.equal(listedRow.status, 'incomplete')
    assert.equal(listedRow.assignee, 'c.barlow')
    assert.equal(listedRow.workspace.location.repository, GITHUB_REPOSITORY)
  })
})

test('POST /api/instances with a GitHub location and no PAT returns the structured "authentication required" response naming github, and writes nothing', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const res = await fetch(`${ctx.gantryBase}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: 'design', slug: 'remote-initiative', github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl } }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('POST /api/instances with a GitHub location and a PAT the fake server rejects returns the same structured response', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const res = await fetch(`${ctx.gantryBase}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('wrong-pat') },
      body: JSON.stringify({ definition: 'design', slug: 'remote-initiative', github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl } }),
    })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'authentication_required')
  })
})

test('POST /api/instances with a GitHub location whose repository does not exist returns 400 with a human-readable message', async () => {
  await withScratchGitHubServer(
    async (ctx) => {
      const res = await createGitHubInstance(ctx, 'remote-initiative')
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /does not exist/)
    },
    { fakeServerOptions: { repoExists: false } }
  )
})

test('POST /api/instances with a GitHub location that already has an instance at that slug reports 409, not 500', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const first = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(first.status, 201)
    const second = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(second.status, 409)
  })
})

test('GET /api/instance loads a GitHub-backed instance\'s stage content, matching what was written at creation', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const created = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(created.status, 201)

    const res = await fetch(`${ctx.gantryBase}/api/instance?slug=remote-initiative`, {
      headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'remote-initiative')
    assert.equal(body.definition, 'design')
    assert.equal(body.stage.id, 'shape')
    assert.equal(body.workspaceBacked, true)
    assert.equal(body.archived, false)
    const background = body.modules.find((m) => m.id === 'background')
    assert.ok(background, 'expected the "background" module in the first stage\'s content')
    assert.equal(background.owner, 'a-module-owner')
  })
})

test('PUT /api/instance/modules/:id writes one module to the GitHub repo, and an unedited field round-trips byte-identical', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const created = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(created.status, 201)
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
    const untouchedBefore = await client.getFileContent('gantry-workspace/remote-initiative/modules/introduction.md')

    const res = await fetch(`${ctx.gantryBase}/api/instance/modules/background?slug=remote-initiative`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({
        status: 'agreed',
        owner: 'c.barlow',
        fields: { problem: 'Updated via GitHub.', 'affected-domains': ['Payments'], opportunity: '' },
      }),
    })
    assert.equal(res.status, 200)
    const status = await res.json()
    assert.equal(status.modules.find((m) => m.id === 'background').complete, true)

    const backgroundText = await client.getFileContent('gantry-workspace/remote-initiative/modules/background.md')
    assert.match(backgroundText, /Updated via GitHub\./)
    assert.match(backgroundText, /owner: c\.barlow/)

    // Untouched module content is byte-identical after the save.
    const untouchedAfter = await client.getFileContent('gantry-workspace/remote-initiative/modules/introduction.md')
    assert.equal(untouchedAfter, untouchedBefore)
  })
})

test('PUT /api/instance/modules saves several modules as one GitHub commit, and reports each one\'s completeness', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const created = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(created.status, 201)
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
    const untouchedBefore = await client.getFileContent('gantry-workspace/remote-initiative/modules/introduction.md')

    const res = await fetch(`${ctx.gantryBase}/api/instance/modules?slug=remote-initiative&stage=shape`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({
        modules: {
          background: { status: 'agreed', owner: 'c.barlow', fields: { problem: 'Saved together.', 'affected-domains': ['Payments'], opportunity: '' } },
          'solution-definition': { status: 'draft', owner: '', fields: { 'high-level-requirements': 'Also saved.' } },
        },
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.saved, ['background', 'solution-definition'])
    assert.ok(body.commit, 'expected a single commit id covering both modules')
    assert.equal(body.modules.find((m) => m.id === 'background').complete, true)

    const background = await client.getFileContent('gantry-workspace/remote-initiative/modules/background.md')
    assert.match(background, /Saved together\./)
    const solutionDefinition = await client.getFileContent('gantry-workspace/remote-initiative/modules/solution-definition.md')
    assert.match(solutionDefinition, /Also saved\./)
    const untouchedAfter = await client.getFileContent('gantry-workspace/remote-initiative/modules/introduction.md')
    assert.equal(untouchedAfter, untouchedBefore)
  })
})

test('An archived GitHub-backed instance still resolves read-only at GET /api/instance, carrying archived: true', async () => {
  await withScratchGitHubServer(async (ctx) => {
    const created = await createGitHubInstance(ctx, 'remote-initiative')
    assert.equal(created.status, 201)
    archiveInstance('remote-initiative', { instancesDir: ctx.instancesDir })

    const res = await fetch(`${ctx.gantryBase}/api/instance?slug=remote-initiative`, {
      headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.archived, true)
    // Nothing on the GitHub side is deleted or changed by archiving — the same "archive is registry
    // metadata only" contract Azure DevOps already has (CONTEXT.md's Archive/restore entry).
    assert.ok(body.modules.length > 0)
  })
})
