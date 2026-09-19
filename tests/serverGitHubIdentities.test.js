import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'

// GET /api/identities, GitHub path (#10, docs/adr/0040): the same "prove real access, and gate
// assignment on it" contract exercised over real HTTP against a real running gantry server and a real
// fake GitHub server — never a mock of `fetch`, per the spec's own Testing Decisions.

function withFakeAndGantryServer(fakeServerOptions, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, ...fakeServerOptions },
    (providerBaseUrl) =>
      withRunningServer({ instancesDir, allowGitHubBaseUrlOverride: true }, (gantryBase) => fn(gantryBase, providerBaseUrl))
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

function identitiesUrl(gantryBase, { q, baseUrl, owner = GITHUB_OWNER, repository = GITHUB_REPOSITORY } = {}) {
  const url = new URL(`${gantryBase}/api/identities`)
  url.searchParams.set('q', q ?? 'ana')
  url.searchParams.set('provider', 'github')
  url.searchParams.set('owner', owner)
  url.searchParams.set('repository', repository)
  if (baseUrl) url.searchParams.set('baseUrl', baseUrl)
  return url.toString()
}

test('GET /api/identities with provider=github+owner+repository hits that repo, without a slug or workspace', async () => {
  await withFakeAndGantryServer({ collaborators: [{ login: 'ana-collaborator', id: 1 }] }, async (gantryBase, providerBaseUrl) => {
    const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body))
    assert.ok(body.some((i) => i.uniqueName === 'ana-collaborator' && i.canAssign === true))
  })
})

test('GET /api/identities (github) with no PAT returns the structured "authentication required" response naming GitHub', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, providerBaseUrl) => {
    const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('GET /api/identities (github) with a PAT GitHub rejects returns 401 tagged for GitHub', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, providerBaseUrl) => {
    const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }), {
      headers: { Authorization: basicAuthHeader('not-the-right-pat') },
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.credentialRejected, true)
    assert.match(body.message, /GitHub/)
  })
})

test('GET /api/identities (github) missing owner or repository returns 400', async () => {
  await withFakeAndGantryServer({}, async (gantryBase, providerBaseUrl) => {
    const url = new URL(`${gantryBase}/api/identities`)
    url.searchParams.set('q', 'ana')
    url.searchParams.set('provider', 'github')
    url.searchParams.set('owner', GITHUB_OWNER)
    url.searchParams.set('baseUrl', providerBaseUrl)
    const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /repository/)
  })
})

test('GET /api/identities (github) rejects a baseUrl when the server has not opted into allowGitHubBaseUrlOverride', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (providerBaseUrl) => {
      await withRunningServer({ instancesDir }, async (gantryBase) => {
        const res = await fetch(identitiesUrl(gantryBase, { baseUrl: providerBaseUrl }), {
          headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
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

test('GET /api/identities (github) surfaces a person without repository access, blocked with guidance to retry', async () => {
  await withFakeAndGantryServer(
    { ownerType: 'Organization', collaborators: [], orgMembers: [{ login: 'no-access', id: 2 }] },
    async (gantryBase, providerBaseUrl) => {
      const res = await fetch(identitiesUrl(gantryBase, { q: 'no-access', baseUrl: providerBaseUrl }), {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.length, 1)
      assert.equal(body[0].canAssign, false)
      assert.match(body[0].blockedReason, /grant repository access/)
    }
  )
})

test('GET /api/identities (github) resolves access granted only through a team as assignable', async () => {
  await withFakeAndGantryServer(
    {
      ownerType: 'Organization',
      collaborators: [],
      orgMembers: [{ login: 'team-granted', id: 3 }],
      permissions: { 'team-granted': 'write' },
    },
    async (gantryBase, providerBaseUrl) => {
      const res = await fetch(identitiesUrl(gantryBase, { q: 'team-granted', baseUrl: providerBaseUrl }), {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.length, 1)
      assert.equal(body[0].canAssign, true)
    }
  )
})

test('GET /api/identities falls back to the first registered workspace when it is a GitHub one', async () => {
  await withFakeAndGantryServer({ collaborators: [{ login: 'ana-collaborator', id: 1 }] }, async (gantryBase, providerBaseUrl) => {
    const registerRes = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl } }),
    })
    assert.equal(registerRes.status, 201)

    const url = new URL(`${gantryBase}/api/identities`)
    url.searchParams.set('q', 'ana')
    const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.some((i) => i.uniqueName === 'ana-collaborator'))
  })
})

// ---------- Regression: Azure DevOps identity behaviour is unchanged ----------

test('GET /api/identities with no location context anywhere still returns [] (200), not an error', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (gantryBase) => {
      const url = new URL(`${gantryBase}/api/identities`)
      url.searchParams.set('q', 'anyone')
      const res = await fetch(url.toString())
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), [])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
