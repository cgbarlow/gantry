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

// Builds the nested `{ provider, location: {...} }` wire shape (ticket #5, ADR-0037) — the only shape
// a `provider: 'github'` registration is reachable through (the pre-#3 flat shape always means
// azure-devops). `overrides.baseUrl` lands inside `location` (an SSRF-allow-flag override, like every
// other caller-supplied `baseUrl` in this file); every other override key stays top-level (e.g. the
// workspace's own Owner *person*, distinct from `location.owner`, GitHub's repo owner).
function postGitHubWorkspaceBody(providerBaseUrl, overrides = {}) {
  const { baseUrl: baseUrlOverride, ...topOverrides } = overrides
  const baseUrl = baseUrlOverride !== undefined ? baseUrlOverride : providerBaseUrl
  return JSON.stringify({
    provider: 'github',
    location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, ...(baseUrl !== undefined ? { baseUrl } : {}) },
    ...topOverrides,
  })
}

// ---------- Structural validation (no PAT/network needed) ----------

test('POST /api/workspaces (github) reports 400, not 500, for a location missing repository', async () => {
  await withScratchGitHubServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: repository/)
  })
})

test('POST /api/workspaces rejects an "atlassian" location missing its Jira fields — accepted as a provider, but the location schema is still enforced (#40)', async () => {
  await withScratchGitHubServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'atlassian', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: jiraSite, jiraProjectKey/)
  })
})

// #40/ADR-0042: atlassian is now a genuinely accepted provider and location shape (previous
// assertion), but no capability registration ships until a later ticket in #39's task list — a
// structurally-valid Atlassian registration attempt still can't complete, distinctly from a bad
// location.
test('POST /api/workspaces rejects a structurally-valid "atlassian" registration — known and location-valid, but not selectable yet (no capability registration)', async () => {
  await withScratchGitHubServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('some-pat') },
      body: JSON.stringify({
        provider: 'atlassian',
        location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, jiraSite: 'acme.atlassian.net', jiraProjectKey: 'PROJ' },
      }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet/)
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
      // #21: the same 404 also means "PAT lacks a required scope" (docs/adr/0040) — the message this
      // route forwards verbatim must say so, not just report a bare not-found.
      assert.match(body.error, /permission/i)

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
    assert.equal(created.location.owner, GITHUB_OWNER)
    assert.equal(created.location.repository, GITHUB_REPOSITORY)
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
