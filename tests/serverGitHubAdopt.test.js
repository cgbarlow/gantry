import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'

// POST /api/instances/adopt (#18) — the GitHub twin of tests/serverAzureDevOpsAdopt.test.js's own
// coverage: registers a GitHub-backed location the setup wizard's own repo-check
// (GET /api/github/repo-check) already found instance data at, so the module editor's per-request
// registry lookup can resolve it afterward — without writing anything. Backed by the same in-process
// fake GitHub server every other GitHub route suite uses, never a real api.github.com.

const SEED_FILES = {
  '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/my-initiative/modules/background.md': [
    '---',
    'module: background',
    'status: draft',
    'owner: c.barlow',
    '---',
    '',
    '## Problem statement',
    '',
    'Seeded from the fake GitHub repo.',
    '',
    '## Affected domains',
    '',
    '- Payments',
    '',
    '## Success criteria',
    '',
    'Nothing yet.',
    '',
  ].join('\n'),
}

function withFakeGitHubAndGantryServer(files, serverOptions, fn) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, async (githubBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      await withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true, ...serverOptions }, async (gantryBase) =>
        fn(gantryBase, githubBaseUrl, instancesDir)
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

function adoptBody(githubBaseUrl) {
  return JSON.stringify({ github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: githubBaseUrl } })
}

// ---------- No / rejected PAT ----------

test('POST /api/instances/adopt with a github location and no PAT returns the structured "authentication required" response naming github', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, {}, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('POST /api/instances/adopt with a github location and a PAT GitHub itself rejects returns the same structured response', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, {}, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-real-pat') },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

// ---------- Validation ----------

test('POST /api/instances/adopt with missing github fields reports 400, not 500', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, {}, async (gantryBase) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github: { owner: GITHUB_OWNER } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: repository/)
  })
})

test('POST /api/instances/adopt with a github.baseUrl reports 400 on a server that has not opted into allowGitHubBaseUrlOverride', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, { allowGitHubBaseUrlOverride: false }, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /baseUrl/)
  })
})

// ---------- Nothing to adopt ----------

test('POST /api/instances/adopt against a github repo with no instance data yet reports 400, not a silent no-op', async () => {
  await withFakeGitHubAndGantryServer({}, {}, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /No instance data/)
  })
})

// One GitHub repo can hold more than one instance under gantry-workspace/<slug>/ — reported distinctly
// from "nothing to adopt" (data genuinely is there), and never guessed at, same as Azure DevOps.
test('POST /api/instances/adopt against a github repo already holding more than one instance reports 400 naming them, and registers nothing', async () => {
  const filesWithTwoInstances = {
    '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
    '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
  }
  await withFakeGitHubAndGantryServer(filesWithTwoInstances, {}, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /more than one instance/)
    assert.match(body.error, /alpha-initiative/)
    assert.match(body.error, /beta-initiative/)

    const listing = await (await fetch(`${gantryBase}/api/instances`)).json()
    assert.equal(listing.length, 0)
  })
})

// ---------- Successful adoption ----------

test('POST /api/instances/adopt against a github repo with an existing instance registers it (without writing anything), and it becomes resolvable/listed', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, {}, async (gantryBase, githubBaseUrl, instancesDir) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'my-initiative')
    assert.equal(body.definition, 'design')
    assert.equal(body.stage, 'shape')
    assert.equal(body.status, 'incomplete')
    assert.equal(body.assignee, 'c.barlow')
    // A GitHub-backed row carries its workspace (#8/#11).
    assert.equal(body.workspace.location.owner, GITHUB_OWNER)
    assert.equal(body.workspace.location.repository, GITHUB_REPOSITORY)

    // Genuinely registered — resolvable by the single-instance routes, not merely reported back here.
    const instanceRes = await fetch(`${gantryBase}/api/instance?slug=my-initiative`, {
      headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    })
    assert.equal(instanceRes.status, 200)
    const instanceBody = await instanceRes.json()
    assert.equal(instanceBody.slug, 'my-initiative')

    // Listed alongside every other instance.
    const listing = await (await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })).json()
    assert.ok(listing.some((i) => i.slug === 'my-initiative'))

    // No local directory was created — this only registered a location, never wrote instance data anywhere.
    assert.equal(existsSync(join(instancesDir, 'my-initiative')), false)
  })
})

test('POST /api/instances/adopt against a github repo is idempotent for a slug already adopted to this exact location, and reuses the same workspace rather than creating a duplicate', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, {}, async (gantryBase, githubBaseUrl) => {
    const makeRequest = () =>
      fetch(`${gantryBase}/api/instances/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: adoptBody(githubBaseUrl),
      })

    const first = await makeRequest()
    assert.equal(first.status, 200)
    const firstBody = await first.json()

    // A second adopt of the exact same location (the "come back and open it again" case) must succeed
    // identically, not report a conflict, and must reuse the same workspace id rather than registering
    // a duplicate one for the same owner/repository tuple.
    const second = await makeRequest()
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.slug, 'my-initiative')
    assert.equal(secondBody.workspace.id, firstBody.workspace.id)

    const workspaces = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(workspaces.filter((w) => w.provider === 'github' && w.location.repository === GITHUB_REPOSITORY).length, 1)
  })
})

test('POST /api/instances/adopt against a github repo reports 409 when the found slug is already registered to a different location, and does not repoint the registry', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, {}, async (gantryBase, githubBaseUrl, instancesDir) => {
    // "my-initiative" already exists as a genuine *local* instance under this same slug before the
    // adopt is ever attempted.
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'default'), assignee: 'local-assignee' })

    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: adoptBody(githubBaseUrl),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /already exists/)

    // The pre-existing local registry entry must be untouched.
    const listing = await (await fetch(`${gantryBase}/api/instances`)).json()
    const local = listing.find((i) => i.slug === 'my-initiative')
    assert.equal(local.assignee, 'local-assignee')
  })
})
