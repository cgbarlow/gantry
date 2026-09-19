import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'
import { getOrCreateWorkspace } from '../lib/workspaceRegistry.js'

// GET /api/identities, GitLab path (#28, docs/adr/0041): the same "prove real access, and gate
// assignment on it" contract GitHub's own #10 exercises, over real HTTP against a real running gantry
// server and a real fake GitLab server — never a mock of `fetch`, per the spec's own Testing Decisions.

function withFakeAndGantryServer(fakeServerOptions, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, ...fakeServerOptions },
    (providerBaseUrl) =>
      withRunningServer({ instancesDir, allowGitLabBaseUrlOverride: true }, (gantryBase) => fn(gantryBase, providerBaseUrl))
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

function identitiesUrl(gantryBase, { q, baseUrl, namespace = GITLAB_NAMESPACE, repository = GITLAB_REPOSITORY } = {}) {
  const url = new URL(`${gantryBase}/api/identities`)
  url.searchParams.set('q', q ?? 'ana')
  url.searchParams.set('provider', 'gitlab')
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('repository', repository)
  if (baseUrl) url.searchParams.set('baseUrl', baseUrl)
  return url.toString()
}

test('GET /api/identities with provider=gitlab+namespace+repository hits that project, without a slug or workspace', async () => {
  await withFakeAndGantryServer({ members: [{ id: 1, username: 'ana-reporter', name: 'Ana', access_level: 20 }] }, async (gantryBase, providerBaseUrl) => {
    const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body))
    assert.ok(body.some((i) => i.uniqueName === 'ana-reporter' && i.canAssign === true))
  })
})

test('GET /api/identities (gitlab) with no PAT returns the structured "authentication required" response naming GitLab', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, providerBaseUrl) => {
    const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitLab/)
  })
})

test('GET /api/identities (gitlab) with a PAT GitLab rejects returns 401 tagged for GitLab', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, providerBaseUrl) => {
    const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }), {
      headers: { Authorization: basicAuthHeader('not-the-right-pat') },
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.credentialRejected, true)
    assert.match(body.message, /GitLab/)
  })
})

test('GET /api/identities (gitlab) missing namespace or repository returns 400', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, providerBaseUrl) => {
    const url = new URL(`${gantryBase}/api/identities`)
    url.searchParams.set('q', 'ana')
    url.searchParams.set('provider', 'gitlab')
    url.searchParams.set('namespace', GITLAB_NAMESPACE)
    url.searchParams.set('baseUrl', providerBaseUrl)
    const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /repository/)
  })
})

test('GET /api/identities (gitlab) rejects a baseUrl when the server has not opted into allowGitLabBaseUrlOverride', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (providerBaseUrl) => {
      await withRunningServer({ instancesDir }, async (gantryBase) => {
        const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }), {
          headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
        })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /baseUrl/)
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/identities (gitlab) surfaces a Guest member, blocked with guidance to retry', async () => {
  await withFakeAndGantryServer(
    { members: [{ id: 2, username: 'guest-only', name: 'Guest', access_level: 10 }] },
    async (gantryBase, providerBaseUrl) => {
      const res = await fetch(identitiesUrl(gantryBase, { q: 'guest-only', baseUrl: providerBaseUrl }), {
        headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.length, 1)
      assert.equal(body[0].canAssign, false)
      assert.match(body[0].blockedReason, /Reporter access/)
    }
  )
})

test('GET /api/identities (gitlab) resolves a Reporter-access member as assignable', async () => {
  await withFakeAndGantryServer(
    { members: [{ id: 3, username: 'reporter-member', name: 'Reporter', access_level: 20 }] },
    async (gantryBase, providerBaseUrl) => {
      const res = await fetch(identitiesUrl(gantryBase, { q: 'reporter-member', baseUrl: providerBaseUrl }), {
        headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.length, 1)
      assert.equal(body[0].canAssign, true)
    }
  )
})

test('GET /api/identities falls back to the first registered workspace when it is a GitLab one', async () => {
  // #25 (workspace registration for GitLab) has not landed the `POST /api/workspaces` repo-check
  // wiring yet, so this seeds the registry directly through the same low-level primitive that route
  // will eventually call, rather than going through an HTTP registration call gitlab can't yet serve —
  // proving the identities route's own "first registered workspace, whichever provider" fallback
  // (already provider-generic since #24) picks up a GitLab workspace correctly regardless.
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeGitLabServer(
      { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, members: [{ id: 1, username: 'ana-reporter', name: 'Ana', access_level: 20 }] },
      async (providerBaseUrl) => {
        getOrCreateWorkspace(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl } },
          { instancesDir }
        )
        await withRunningServer({ instancesDir, allowGitLabBaseUrlOverride: true }, async (gantryBase) => {
          const url = new URL(`${gantryBase}/api/identities`)
          url.searchParams.set('q', 'ana')
          const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.ok(body.some((i) => i.uniqueName === 'ana-reporter'))
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
