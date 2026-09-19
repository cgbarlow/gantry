import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from '../lib/server.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// GET /api/github/repo-check (#18) — the GitHub twin of tests/serverAzureDevOpsRepoCheck.test.js's own
// coverage of GET /api/azure-devops/repo-check: given a GitHub location (owner/repository, as query
// params — never a gantry slug) and the caller's own PAT, reports whether that location already holds
// instance data. Read-only; never touches instancesDir or lib/registry.js. Backed by the same
// in-process fake GitHub server every other GitHub route suite uses, never the real api.github.com.
//
// `baseUrl` is also accepted as a query param, gated behind the single `allowGitHubBaseUrlOverride`
// flag (docs/adr/0039) rather than an Azure-DevOps-style per-host allow-list — see createServer's own
// doc comment on that option.

function withFakeGitHubAndGantryServer(files, fn, { allowGitHubBaseUrlOverride = true } = {}) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, async (githubBaseUrl) => {
    await withRunningServer({ allowGitHubBaseUrlOverride }, async (gantryBase) => fn(gantryBase, githubBaseUrl))
  })
}

function repoCheckUrl(gantryBase, githubBaseUrl) {
  const url = new URL(`${gantryBase}/api/github/repo-check`)
  url.searchParams.set('owner', GITHUB_OWNER)
  url.searchParams.set('repository', GITHUB_REPOSITORY)
  if (githubBaseUrl) url.searchParams.set('baseUrl', githubBaseUrl)
  return url.toString()
}

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

// ---------- No / rejected PAT ----------

test('GET /api/github/repo-check with no PAT returns the structured "authentication required" response naming github', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, githubBaseUrl))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitHub/)
  })
})

test('GET /api/github/repo-check with a PAT GitHub itself rejects returns the exact same structured response as no PAT', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, async (gantryBase, githubBaseUrl) => {
    const noPatRes = await fetch(repoCheckUrl(gantryBase, githubBaseUrl))
    const noPatBody = await noPatRes.json()

    const badPatRes = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const badPatBody = await badPatRes.json()

    assert.equal(badPatRes.status, noPatRes.status)
    assert.deepEqual(badPatBody, noPatBody)
  })
})

// ---------- Valid PAT, an instance already exists ----------

test('GET /api/github/repo-check with a valid PAT against a repo that already holds an instance returns that instance\'s real definition/stage/status/assignee', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result, 'found')
    assert.equal(body.slug, 'my-initiative')
    assert.equal(body.definition, 'design')
    assert.equal(body.stage, 'shape')
    // Only "background" of the shape stage's three modules was seeded, so the stage isn't complete yet.
    assert.equal(body.status, 'incomplete')
    assert.equal(body.assignee, 'c.barlow')
  })
})

test('GET /api/github/repo-check reports "complete" once every module required at the current stage is present and filled in', async () => {
  const fullFiles = {
    ...SEED_FILES,
    '/gantry-workspace/my-initiative/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/my-initiative/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/gantry-workspace/my-initiative/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
  }
  await withFakeGitHubAndGantryServer(fullFiles, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result, 'found')
    assert.equal(body.status, 'complete')
  })
})

// ---------- Valid PAT, nothing adopted yet ----------

test('GET /api/github/repo-check with a valid PAT against a repo with no instance data yet returns a clear "no instance data here yet" result', async () => {
  await withFakeGitHubAndGantryServer({}, async (gantryBase, githubBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

// One GitHub repo can hold more than one instance under gantry-workspace/<slug>/, same as Azure
// DevOps — this route has no slug input to disambiguate with, so it reports "multiple" distinctly
// from "empty" rather than silently guessing one.
test('GET /api/github/repo-check with a valid PAT against a repo already holding more than one instance reports "multiple", not "empty"', async () => {
  await withFakeGitHubAndGantryServer(
    {
      '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
      '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
    },
    async (gantryBase, githubBaseUrl) => {
      const res = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.result, 'multiple')
      assert.deepEqual(body.slugs, ['alpha-initiative', 'beta-initiative'])
    }
  )
})

// ---------- Missing query parameters ----------

test('GET /api/github/repo-check with a missing required query parameter returns a 400 structured error, without requiring a PAT', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const url = new URL(`${gantryBase}/api/github/repo-check`)
    url.searchParams.set('owner', GITHUB_OWNER)
    // "repository" deliberately omitted.
    const res = await fetch(url.toString())
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /repository/)
  })
})

// ---------- baseUrl override is gated behind an explicit flag ----------

test('GET /api/github/repo-check rejects a caller-supplied baseUrl with a 400 when the server has not opted into allowGitHubBaseUrlOverride, without making any outbound request', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: SEED_FILES }, async (githubBaseUrl) => {
    await withRunningServer({}, async (gantryBase) => {
      const res = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
    })
  })
})

// ---------- Genuine GitHub failure ----------

test('GET /api/github/repo-check surfaces a genuine GitHub read failure (a 500, not a 404) as a structured error, instead of reporting "empty"', async () => {
  const basePath = `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`
  const fakeGitHub = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://fake-github.invalid')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const auth = req.headers['authorization'] ?? ''
    const [, providedPat] = auth.match(/^Bearer (.+)$/) ?? []
    if (providedPat !== GITHUB_VALID_PAT) return json(401, { message: 'fake: invalid or missing PAT' })

    if (req.method === 'GET' && url.pathname.startsWith(`${basePath}/contents`)) {
      // A genuine GitHub-side failure — an outage, not a missing file.
      return json(500, { message: 'simulated internal server error (fake, for this regression test)' })
    }
    return json(404, { message: `no fake route for ${req.method} ${url.pathname}` })
  })

  await new Promise((resolvePromise, rejectPromise) => {
    fakeGitHub.listen(0, async () => {
      const { port: githubPort } = fakeGitHub.address()
      const githubBaseUrl = `http://localhost:${githubPort}`
      const server = createServer({ allowGitHubBaseUrlOverride: true })
      server.listen(0, async () => {
        try {
          const { port } = server.address()
          const url = new URL(`http://localhost:${port}/api/github/repo-check`)
          url.searchParams.set('owner', GITHUB_OWNER)
          url.searchParams.set('repository', GITHUB_REPOSITORY)
          url.searchParams.set('baseUrl', githubBaseUrl)
          const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
          assert.equal(res.status, 500)
          const body = await res.json()
          assert.match(body.error, /HTTP 500/)
          resolvePromise()
        } catch (err) {
          rejectPromise(err)
        } finally {
          server.close()
          fakeGitHub.close()
        }
      })
    })
  })
})

// ---------- The credential itself is never echoed back ----------

test('the PAT never appears in the GitHub repo-check response body, whether rejected or accepted', async () => {
  await withFakeGitHubAndGantryServer(SEED_FILES, async (gantryBase, githubBaseUrl) => {
    const rejectedRes = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const rejectedText = await rejectedRes.text()
    assert.doesNotMatch(rejectedText, /a-pat-the-server-does-not-recognize/)

    const okRes = await fetch(repoCheckUrl(gantryBase, githubBaseUrl), { headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) } })
    const okText = await okRes.text()
    assert.doesNotMatch(okText, new RegExp(GITHUB_VALID_PAT))
  })
})
