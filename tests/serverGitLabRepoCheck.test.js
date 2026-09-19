import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from '../lib/server.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// GET /api/gitlab/repo-check (#35, ADR-0041) — the GitLab twin of tests/serverGitHubRepoCheck.test.js's
// own coverage of GET /api/github/repo-check: given a GitLab location (namespace/repository, as query
// params — never a gantry slug) and the caller's own PAT, reports whether that location already holds
// instance data. Read-only; never touches instancesDir or lib/registry.js. Backed by the same
// in-process fake GitLab server every other GitLab route suite uses, never the real gitlab.com.
//
// `baseUrl` is also accepted as a query param, gated behind the single `allowGitLabBaseUrlOverride`
// flag (docs/adr/0039) rather than an Azure-DevOps-style per-host allow-list — see createServer's own
// doc comment on that option.

function withFakeGitLabAndGantryServer(files, fn, { allowGitLabBaseUrlOverride = true } = {}) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, async (gitlabBaseUrl) => {
    await withRunningServer({ allowGitLabBaseUrlOverride }, async (gantryBase) => fn(gantryBase, gitlabBaseUrl))
  })
}

function repoCheckUrl(gantryBase, gitlabBaseUrl) {
  const url = new URL(`${gantryBase}/api/gitlab/repo-check`)
  url.searchParams.set('namespace', GITLAB_NAMESPACE)
  url.searchParams.set('repository', GITLAB_REPOSITORY)
  if (gitlabBaseUrl) url.searchParams.set('baseUrl', gitlabBaseUrl)
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

// ---------- No / rejected PAT ----------

test('GET /api/gitlab/repo-check with no PAT returns the structured "authentication required" response naming gitlab', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /GitLab/)
  })
})

test('GET /api/gitlab/repo-check with a PAT GitLab itself rejects returns the exact same structured response as no PAT', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, async (gantryBase, gitlabBaseUrl) => {
    const noPatRes = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl))
    const noPatBody = await noPatRes.json()

    const badPatRes = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const badPatBody = await badPatRes.json()

    assert.equal(badPatRes.status, noPatRes.status)
    assert.deepEqual(badPatBody, noPatBody)
  })
})

// ---------- Valid PAT, an instance already exists ----------

test('GET /api/gitlab/repo-check with a valid PAT against a project that already holds an instance returns that instance\'s real definition/stage/status/assignee', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
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

test('GET /api/gitlab/repo-check reports "complete" once every module required at the current stage is present and filled in', async () => {
  const fullFiles = {
    ...SEED_FILES,
    '/gantry-workspace/my-initiative/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/my-initiative/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/gantry-workspace/my-initiative/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
  }
  await withFakeGitLabAndGantryServer(fullFiles, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result, 'found')
    assert.equal(body.status, 'complete')
  })
})

// ---------- Valid PAT, nothing adopted yet ----------

test('GET /api/gitlab/repo-check with a valid PAT against a project with no instance data yet returns a clear "no instance data here yet" result', async () => {
  await withFakeGitLabAndGantryServer({}, async (gantryBase, gitlabBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

// One GitLab project can hold more than one instance under gantry-workspace/<slug>/, same as GitHub —
// this route has no slug input to disambiguate with, so it reports "multiple" distinctly from "empty"
// rather than silently guessing one.
test('GET /api/gitlab/repo-check with a valid PAT against a project already holding more than one instance reports "multiple", not "empty"', async () => {
  await withFakeGitLabAndGantryServer(
    {
      '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
      '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
    },
    async (gantryBase, gitlabBaseUrl) => {
      const res = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.result, 'multiple')
      assert.deepEqual(body.slugs, ['alpha-initiative', 'beta-initiative'])
    }
  )
})

// ---------- Missing query parameters ----------

test('GET /api/gitlab/repo-check with a missing required query parameter returns a 400 structured error, without requiring a PAT', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const url = new URL(`${gantryBase}/api/gitlab/repo-check`)
    url.searchParams.set('namespace', GITLAB_NAMESPACE)
    // "repository" deliberately omitted.
    const res = await fetch(url.toString())
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /repository/)
  })
})

// ---------- baseUrl override is gated behind an explicit flag ----------

test('GET /api/gitlab/repo-check rejects a caller-supplied baseUrl with a 400 when the server has not opted into allowGitLabBaseUrlOverride, without making any outbound request', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: SEED_FILES }, async (gitlabBaseUrl) => {
    await withRunningServer({}, async (gantryBase) => {
      const res = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /baseUrl/)
    })
  })
})

// ---------- Genuine GitLab failure ----------

test('GET /api/gitlab/repo-check surfaces a genuine GitLab read failure (a 500, not a 404) as a structured error, instead of reporting "empty"', async () => {
  const projectBasePath = `/api/v4/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}`
  const fakeGitLab = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://fake-gitlab.invalid')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers['private-token'] !== GITLAB_VALID_PAT) return json(401, { message: 'fake: invalid or missing PRIVATE-TOKEN' })

    if (req.method === 'GET' && url.pathname === `${projectBasePath}/repository/tree`) {
      // A genuine GitLab-side failure — an outage, not a missing folder.
      return json(500, { message: 'simulated internal server error (fake, for this regression test)' })
    }
    return json(404, { message: `no fake route for ${req.method} ${url.pathname}` })
  })

  await new Promise((resolvePromise, rejectPromise) => {
    fakeGitLab.listen(0, async () => {
      const { port: gitlabPort } = fakeGitLab.address()
      const gitlabBaseUrl = `http://localhost:${gitlabPort}/api/v4`
      const server = createServer({ allowGitLabBaseUrlOverride: true })
      server.listen(0, async () => {
        try {
          const { port } = server.address()
          const url = new URL(`http://localhost:${port}/api/gitlab/repo-check`)
          url.searchParams.set('namespace', GITLAB_NAMESPACE)
          url.searchParams.set('repository', GITLAB_REPOSITORY)
          url.searchParams.set('baseUrl', gitlabBaseUrl)
          const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
          assert.equal(res.status, 500)
          const body = await res.json()
          assert.match(body.error, /HTTP 500/)
          resolvePromise()
        } catch (err) {
          rejectPromise(err)
        } finally {
          server.close()
          fakeGitLab.close()
        }
      })
    })
  })
})

// ---------- The credential itself is never echoed back ----------

test('the PAT never appears in the GitLab repo-check response body, whether rejected or accepted', async () => {
  await withFakeGitLabAndGantryServer(SEED_FILES, async (gantryBase, gitlabBaseUrl) => {
    const rejectedRes = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const rejectedText = await rejectedRes.text()
    assert.doesNotMatch(rejectedText, /a-pat-the-server-does-not-recognize/)

    const okRes = await fetch(repoCheckUrl(gantryBase, gitlabBaseUrl), { headers: { Authorization: basicAuthHeader(GITLAB_VALID_PAT) } })
    const okText = await okRes.text()
    assert.doesNotMatch(okText, new RegExp(GITLAB_VALID_PAT))
  })
})
