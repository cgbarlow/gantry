import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { basicAuthHeader, withRunningServerForProvider, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/lifecycle.js'

// POST /api/workspaces, GitHub path (#8, docs/adr/0037/0039): the same "prove real access before
// persisting" contract tests/serverWorkspaces.test.js already proves for Azure DevOps, exercised
// against a real fake GitHub server via the shared provider-aware test lifecycle
// (withRunningServerForProvider) — real HTTP requests against a real running gantry server, never a
// mock of fetch.

function withScratchGitHubServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider('github', { options: { instancesDir }, fakeServerOptions }, fn).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

function postGitHubWorkspaceBody(providerBaseUrl, overrides = {}) {
  return JSON.stringify({ provider: 'github', repoOwner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl, ...overrides })
}

// ---------- Structural validation (no PAT/network needed) ----------

test('POST /api/workspaces (github) reports 400, not 500, for a location missing owner/repository — the wizard-facing field name, not the internal repoOwner key', async () => {
  await withScratchGitHubServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', repoOwner: GITHUB_OWNER }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: repository/)
  })
})

test('POST /api/workspaces rejects provider "atlassian" — known, but not selectable yet', async () => {
  await withScratchGitHubServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'atlassian', repoOwner: GITHUB_OWNER, repository: GITHUB_REPOSITORY }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not available yet/)
  })
})

test('POST /api/workspaces (github) with a baseUrl reports 400 on a server that has not opted into allowGitHubBaseUrlOverride', async () => {
  // A plain withRunningServer (not the provider-aware helper, which pre-opts every test into
  // allowGitHubBaseUrlOverride) — this test is specifically about the flag being off by default.
  const { withRunningServer } = await import('./helpers/lifecycle.js')
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (gantryBase) => {
      const res = await fetch(`${gantryBase}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postGitHubWorkspaceBody(undefined, { baseUrl: 'https://attacker.example' }),
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

// ---------- Requires proving real GitHub access ----------

test('POST /api/workspaces (github) with no PAT returns the structured "authentication required" response, and persists nothing', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postGitHubWorkspaceBody(providerBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (github) with a PAT GitHub itself rejects returns the same structured response, and persists nothing', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-the-right-pat') },
      body: postGitHubWorkspaceBody(providerBaseUrl),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (github) with a nonexistent repository returns 400 naming the missing repo, and persists nothing', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl }) => {
      const res = await fetch(`${gantryBase}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: postGitHubWorkspaceBody(providerBaseUrl),
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

test('POST /api/workspaces (github) with a valid PAT for a real repository creates the workspace, and it is then listed by GET /api/workspaces with provider "github"', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: postGitHubWorkspaceBody(providerBaseUrl, { owner: 'c.barlow' }),
    })
    assert.equal(res.status, 201)
    const created = await res.json()
    assert.equal(created.provider, 'github')
    assert.equal(created.repoOwner, GITHUB_OWNER)
    assert.equal(created.repository, GITHUB_REPOSITORY)
    assert.equal(created.owner, 'c.barlow')
    assert.equal(typeof created.number, 'number')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
    assert.equal(listing[0].provider, 'github')
    assert.equal(listing[0].id, created.id)
  })
})

test('POST /api/workspaces (github) reuses an already-registered workspace for the same owner/repository rather than duplicating it', async () => {
  await withScratchGitHubServer(async ({ gantryBase, providerBaseUrl }) => {
    const first = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: postGitHubWorkspaceBody(providerBaseUrl),
    })
    assert.equal(first.status, 201)
    const firstBody = await first.json()

    const second = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: postGitHubWorkspaceBody(providerBaseUrl),
    })
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.reused, true)
    assert.equal(secondBody.id, firstBody.id)

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
  })
})
