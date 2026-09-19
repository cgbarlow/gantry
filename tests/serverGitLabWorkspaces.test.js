import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { basicAuthHeader, withRunningServerForProvider, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/lifecycle.js'

// POST /api/workspaces, GitLab path (#25, docs/adr/0037/0041): the same "prove real access before
// persisting" contract tests/serverGitHubWorkspaces.test.js already proves for GitHub, exercised
// against a real fake GitLab server via the shared provider-aware test lifecycle
// (withRunningServerForProvider) — real HTTP requests against a real running gantry server, never a
// mock of fetch.

function withScratchGitLabServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider('gitlab', { options: { instancesDir }, fakeServerOptions }, fn).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

// Builds the nested `{ provider, location: {...} }` wire shape (ticket #5, ADR-0037) — the only shape
// a `provider: 'gitlab'` registration is reachable through (the pre-#3 flat shape always means
// azure-devops). `overrides.baseUrl` lands inside `location` (an SSRF-allow-flag override, like every
// other caller-supplied `baseUrl` in this file); every other override key stays top-level (e.g. the
// workspace's own Owner *person*, distinct from `location.namespace`, GitLab's own group/subgroup path).
function postGitLabWorkspaceBody(providerBaseUrl, overrides = {}) {
  const { baseUrl: baseUrlOverride, ...topOverrides } = overrides
  const baseUrl = baseUrlOverride !== undefined ? baseUrlOverride : providerBaseUrl
  return JSON.stringify({
    provider: 'gitlab',
    location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, ...(baseUrl !== undefined ? { baseUrl } : {}) },
    ...topOverrides,
  })
}

// ---------- Structural validation (no PAT/network needed) ----------

test('POST /api/workspaces (gitlab) reports 400, not 500, for a location missing repository', async () => {
  await withScratchGitLabServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: repository/)
  })
})

test('POST /api/workspaces (gitlab) with a baseUrl reports 400 on a server that has not opted into allowGitLabBaseUrlOverride', async () => {
  // A plain withRunningServer (not the provider-aware helper, which pre-opts every test into
  // allowGitLabBaseUrlOverride) — this test is specifically about the flag being off by default.
  const { withRunningServer } = await import('./helpers/lifecycle.js')
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (gantryBase) => {
      const res = await fetch(`${gantryBase}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postGitLabWorkspaceBody(undefined, { baseUrl: 'https://attacker.example' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
      const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(listing.length, 0)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- Requires proving real GitLab access ----------

test('POST /api/workspaces (gitlab) with no PAT returns the structured "authentication required" response, and persists nothing', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postGitLabWorkspaceBody(providerBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (gitlab) with a PAT GitLab itself rejects returns the same structured response, and persists nothing', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-the-right-pat') },
      body: postGitLabWorkspaceBody(providerBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (gitlab) with a nonexistent project returns 400 naming the missing project, and persists nothing', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl }) => {
      const res = await fetch(`${gantryBase}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        body: postGitLabWorkspaceBody(providerBaseUrl),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /does not exist/)

      const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(listing.length, 0)
    },
    { fakeServerOptions: { repoExists: false } }
  )
})

test('POST /api/workspaces (gitlab) with a valid PAT for a real project creates the workspace, and it is then listed by GET /api/workspaces with provider "gitlab"', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: postGitLabWorkspaceBody(providerBaseUrl, { owner: 'c.barlow' }),
    })
    assert.equal(res.status, 201)
    const created = await res.json()
    assert.equal(created.provider, 'gitlab')
    assert.equal(created.location.namespace, GITLAB_NAMESPACE)
    assert.equal(created.location.repository, GITLAB_REPOSITORY)
    assert.equal(created.owner, 'c.barlow')
    assert.equal(typeof created.number, 'number')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
    assert.equal(listing[0].provider, 'gitlab')
    assert.equal(listing[0].id, created.id)
  })
})

test('POST /api/workspaces (gitlab) reuses an already-registered workspace for the same namespace/repository rather than duplicating it', async () => {
  await withScratchGitLabServer(async ({ gantryBase, providerBaseUrl }) => {
    const first = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: postGitLabWorkspaceBody(providerBaseUrl),
    })
    assert.equal(first.status, 201)
    const firstBody = await first.json()

    const second = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      body: postGitLabWorkspaceBody(providerBaseUrl),
    })
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.reused, true)
    assert.equal(secondBody.id, firstBody.id)

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
  })
})
