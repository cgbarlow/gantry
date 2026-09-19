import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  basicAuthHeader,
  withRunningServerForProvider,
  BITBUCKET_OWNER,
  BITBUCKET_REPOSITORY,
  BITBUCKET_VALID_PAT,
  JIRA_SITE,
  JIRA_PROJECT_KEY,
  JIRA_VALID_PAT,
} from './helpers/lifecycle.js'

// POST /api/workspaces, Atlassian path (#48, ADR-0042): the same "prove real access before
// persisting" contract tests/serverGitLabWorkspaces.test.js already proves for GitLab, exercised
// against two real fake servers (Bitbucket Cloud + Jira Cloud) via the shared provider-aware test
// lifecycle (withRunningServerForProvider) — real HTTP requests against a real running gantry server,
// never a mock of fetch. This is the split-suite twin: every other provider's own suite proves one
// token against one fake server; this one proves two tokens (Bitbucket's on the primary Authorization
// header, Jira's on the secondary X-Gantry-Secondary-Authorization header — lib/credential.js's own
// `getSecondaryCredential` doc comment) against two.

function withScratchAtlassianServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider('atlassian', { options: { instancesDir }, fakeServerOptions }, fn).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

function postAtlassianWorkspaceBody(overrides = {}) {
  return JSON.stringify({
    provider: 'atlassian',
    location: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, jiraSite: JIRA_SITE, jiraProjectKey: JIRA_PROJECT_KEY },
    ...overrides,
  })
}

function bothAuthHeaders(bitbucketPat, jiraPat) {
  const headers = { 'Content-Type': 'application/json' }
  if (bitbucketPat !== undefined) headers.Authorization = basicAuthHeader(bitbucketPat)
  if (jiraPat !== undefined) headers['X-Gantry-Secondary-Authorization'] = basicAuthHeader(jiraPat)
  return headers
}

// ---------- Structural validation (no PAT/network needed) ----------

test('POST /api/workspaces (atlassian) reports 400, not 500, for a location missing jiraSite/jiraProjectKey', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'atlassian', location: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /missing: jiraSite, jiraProjectKey/)
  })
})

test('POST /api/workspaces (atlassian) with a location baseUrl reports 400 — Atlassian has no public baseUrl override at all', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postAtlassianWorkspaceBody({ location: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, jiraSite: JIRA_SITE, jiraProjectKey: JIRA_PROJECT_KEY, baseUrl: 'https://attacker.example' } }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /baseUrl/)
  })
})

// ---------- Requires proving real Bitbucket + Jira access ----------

test('POST /api/workspaces (atlassian) with no credentials at all returns the structured "authentication required" response, and persists nothing', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postAtlassianWorkspaceBody(),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (atlassian) with a Bitbucket token but no Jira token returns the same structured response, and persists nothing', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: bothAuthHeaders(BITBUCKET_VALID_PAT, undefined),
      body: postAtlassianWorkspaceBody(),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (atlassian) with a Jira token Jira itself rejects returns the structured response, and persists nothing', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: bothAuthHeaders(BITBUCKET_VALID_PAT, 'not-the-right-jira-pat'),
      body: postAtlassianWorkspaceBody(),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (atlassian) with a Bitbucket token Bitbucket itself rejects returns the structured response, and persists nothing', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: bothAuthHeaders('not-the-right-bitbucket-pat', JIRA_VALID_PAT),
      body: postAtlassianWorkspaceBody(),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 0)
  })
})

test('POST /api/workspaces (atlassian) with a nonexistent Bitbucket repository returns 400 naming it, and persists nothing', async () => {
  await withScratchAtlassianServer(
    async ({ gantryBase }) => {
      const res = await fetch(`${gantryBase}/api/workspaces`, {
        method: 'POST',
        headers: bothAuthHeaders(BITBUCKET_VALID_PAT, JIRA_VALID_PAT),
        body: postAtlassianWorkspaceBody(),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /not found/)

      const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(listing.length, 0)
    },
    { fakeServerOptions: { bitbucketFakeServerOptions: { repoExists: false } } }
  )
})

test('POST /api/workspaces (atlassian) with a nonexistent Jira project returns 400 naming it, and persists nothing', async () => {
  await withScratchAtlassianServer(
    async ({ gantryBase }) => {
      const res = await fetch(`${gantryBase}/api/workspaces`, {
        method: 'POST',
        headers: bothAuthHeaders(BITBUCKET_VALID_PAT, JIRA_VALID_PAT),
        body: postAtlassianWorkspaceBody(),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /not found/)

      const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(listing.length, 0)
    },
    { fakeServerOptions: { jiraFakeServerOptions: { projectExists: false } } }
  )
})

test('POST /api/workspaces (atlassian) with valid tokens for a real repository and project creates the workspace, and it is then listed by GET /api/workspaces with provider "atlassian"', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const res = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: bothAuthHeaders(BITBUCKET_VALID_PAT, JIRA_VALID_PAT),
      body: postAtlassianWorkspaceBody({ owner: 'c.barlow' }),
    })
    assert.equal(res.status, 201)
    const created = await res.json()
    assert.equal(created.provider, 'atlassian')
    assert.equal(created.location.owner, BITBUCKET_OWNER)
    assert.equal(created.location.repository, BITBUCKET_REPOSITORY)
    assert.equal(created.location.jiraSite, JIRA_SITE)
    assert.equal(created.location.jiraProjectKey, JIRA_PROJECT_KEY)
    assert.equal(created.owner, 'c.barlow')
    assert.equal(typeof created.number, 'number')

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
    assert.equal(listing[0].provider, 'atlassian')
    assert.equal(listing[0].id, created.id)
  })
})

test('POST /api/workspaces (atlassian) reuses an already-registered workspace for the same location rather than duplicating it', async () => {
  await withScratchAtlassianServer(async ({ gantryBase }) => {
    const first = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: bothAuthHeaders(BITBUCKET_VALID_PAT, JIRA_VALID_PAT),
      body: postAtlassianWorkspaceBody(),
    })
    assert.equal(first.status, 201)
    const firstBody = await first.json()

    const second = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: bothAuthHeaders(BITBUCKET_VALID_PAT, JIRA_VALID_PAT),
      body: postAtlassianWorkspaceBody(),
    })
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(secondBody.reused, true)
    assert.equal(secondBody.id, firstBody.id)

    const listing = await (await fetch(`${gantryBase}/api/workspaces`)).json()
    assert.equal(listing.length, 1)
  })
})
