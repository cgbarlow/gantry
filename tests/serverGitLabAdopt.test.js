import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'

// POST /api/instances/adopt (#35, ADR-0041) — the GitLab twin of tests/serverGitHubAdopt.test.js's own
// coverage: registers a GitLab-backed location the setup wizard's own repo-check
// (GET /api/gitlab/repo-check) already found instance data at, so the module editor's per-request
// registry lookup can resolve it afterward — without writing anything. Backed by the same in-process
// fake GitLab server every other GitLab route suite uses, never a real gitlab.com.

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
    'Seeded from the fake GitLab project.',
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

function withFakeGitLabAndGantryServer(files, serverOptions, fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, async (gitlabBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      await withRunningServer({ instancesDir, allowGitLabBaseUrlOverride: true, ...serverOptions }, async (gantryBase) =>
        fn(gantryBase, gitlabBaseUrl, instancesDir)
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

function adoptBody(gitlabBaseUrl) {
  return JSON.stringify({ gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: gitlabBaseUrl } })
}

// ---------- No / rejected PAT ----------

test('POST /api/instances/adopt with a gitlab location and no PAT returns the structured "authentication required" response naming gitlab', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, {}, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: adoptBody(gitlabBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitLab/)
  })
})

test('POST /api/instances/adopt with a gitlab location and a PAT GitLab itself rejects returns the same structured response', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, {}, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-real-pat') },
      body: adoptBody(gitlabBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

// ---------- Validation ----------

test('POST /api/instances/adopt with missing gitlab fields reports 400, not 500', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, {}, async (gantryBase) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitlab: { namespace: GITLAB_NAMESPACE } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: repository/)
  })
})

test('POST /api/instances/adopt with a gitlab.baseUrl reports 400 on a server that has not opted into allowGitLabBaseUrlOverride', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, { allowGitLabBaseUrlOverride: false }, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: adoptBody(gitlabBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /baseUrl/)
  })
})

// ---------- Nothing to adopt ----------

test('POST /api/instances/adopt against a gitlab project with no instance data yet reports 400, not a silent no-op', async () => {
  await withFakeGitLabAndGantryServer({}, {}, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: adoptBody(gitlabBaseUrl),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /No instance data/)
  })
})

// One GitLab project can hold more than one instance under gantry-workspace/<slug>/ — reported
// distinctly from "nothing to adopt" (data genuinely is there), and never guessed at, same as GitHub.
test('POST /api/instances/adopt against a gitlab project already holding more than one instance reports 400 naming them, and registers nothing', async () => {
  const filesWithTwoInstances = {
    '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
    '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
  }
  await withFakeGitLabAndGantryServer(filesWithTwoInstances, {}, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: adoptBody(gitlabBaseUrl),
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

test('POST /api/instances/adopt against a gitlab project with an existing instance registers it (without writing anything), and it becomes resolvable/listed', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, {}, async (gantryBase, gitlabBaseUrl, instancesDir) => {
    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: adoptBody(gitlabBaseUrl),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'my-initiative')
    assert.equal(body.definition, 'design')
    assert.equal(body.stage, 'shape')
    assert.equal(body.status, 'incomplete')
    assert.equal(body.assignee, 'c.barlow')
    // A GitLab-backed row carries its workspace (#26/#35).
    assert.equal(body.workspace.location.namespace, GITLAB_NAMESPACE)
    assert.equal(body.workspace.location.repository, GITLAB_REPOSITORY)

    // Genuinely registered — resolvable by the single-instance routes, not merely reported back here.
    const instanceRes = await fetch(`${gantryBase}/api/instance?slug=my-initiative`, {
      headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
    })
    assert.equal(instanceRes.status, 200)
    const instanceBody = await instanceRes.json()
    assert.equal(instanceBody.slug, 'my-initiative')

    // Listed alongside every other instance.
    const listing = await (await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })).json()
    assert.ok(listing.some((i) => i.slug === 'my-initiative'))

    // No local directory was created — this only registered a location, never wrote instance data anywhere.
    assert.equal(existsSync(join(instancesDir, 'my-initiative')), false)
  })
})

test('POST /api/instances/adopt against a gitlab project is idempotent for a slug already adopted to this exact location, and reuses the same workspace rather than creating a duplicate', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, {}, async (gantryBase, gitlabBaseUrl) => {
    const makeRequest = () =>
      fetch(`${gantryBase}/api/instances/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: adoptBody(gitlabBaseUrl),
      })

    const first = await makeRequest()
    assert.equal(first.status, 200)
    const firstBody = await first.json()

    // A second adopt of the exact same location (the "come back and open it again" case) must succeed
    // identically, not report a conflict, and must reuse the same workspace id rather than registering
    // a duplicate one for the same namespace/repository tuple.
    const second = await makeRequest()
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.slug, 'my-initiative')
    assert.equal(secondBody.workspace.id, firstBody.workspace.id)

    const workspaces = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(workspaces.filter((w) => w.provider === 'gitlab' && w.location.repository === GITLAB_REPOSITORY).length, 1)
  })
})

test('POST /api/instances/adopt against a gitlab project reports 409 when the found slug is already registered to a different location, and does not repoint the registry', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, {}, async (gantryBase, gitlabBaseUrl, instancesDir) => {
    // "my-initiative" already exists as a genuine *local* instance under this same slug before the
    // adopt is ever attempted.
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'default'), assignee: 'local-assignee' })

    const res = await fetch(`${gantryBase}/api/instances/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: adoptBody(gitlabBaseUrl),
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
