import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from '../lib/server.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// GET /api/azure-devops/repo-check (#90, under #88): given an Azure DevOps location (organization/project/repository, as query params — never a gantry slug) and the caller's own PAT, reports whether that location already holds instance data. Read-only; never touches instancesDir or lib/registry.js. Backed by the same fake in-process Azure DevOps server tests/serverAzureDevOpsAuth.test.js and tests/instance.test.js use — never the real dev.azure.com.
//
// `baseUrl` is also accepted as a query param, but only honoured when it exactly matches an entry in the server's own `allowedAzureDevOpsBaseUrls` allow-list — empty by default (what `gantry serve` uses), so a real deployment can't be directed to make an outbound request to an arbitrary caller-chosen host. Every test below that needs to point at the fake Azure DevOps server allow-lists that fake server's own baseUrl explicitly; the "baseUrl override is allow-listed, not a blanket switch" section covers the default-off and scoped-allow-list behaviour itself.




// Unlike tests/serverAzureDevOpsAuth.test.js's `withAzureDevOpsBackedServer`, this route takes its Azure DevOps location as per-request query params rather than from server-startup options — so the gantry server here is started with no `options.azureDevOps` at all, only pointed (via the query string each test builds) at the fake Azure DevOps server's baseUrl. `allowedAzureDevOpsBaseUrls: [adoBaseUrl]` is what makes that possible: real `gantry serve` never sets it, so a real deployment can never be directed to an arbitrary caller-chosen host this way (see the dedicated tests below covering that default-empty, exact-match-only behaviour) — it's only ever populated here, with this one fake server's own baseUrl, to let this suite point at the fake in-process server instead of the real dev.azure.com.
function withFakeAzureDevOpsAndGantryServer(files, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, async (adoBaseUrl) => {
    await withRunningServer({ allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (gantryBase) => fn(gantryBase, adoBaseUrl))
  })
}

function repoCheckUrl(gantryBase, adoBaseUrl) {
  const url = new URL(`${gantryBase}/api/azure-devops/repo-check`)
  url.searchParams.set('organization', ORGANIZATION)
  url.searchParams.set('project', PROJECT)
  url.searchParams.set('repository', REPOSITORY)
  url.searchParams.set('baseUrl', adoBaseUrl)
  return url.toString()
}

const SEED_FILES = {
  '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\nassignee: c.barlow\n',
  '/modules/background.md': [
    '---',
    'module: background',
    'status: draft',
    'owner: c.barlow',
    '---',
    '',
    '## Problem statement',
    '',
    'Seeded from the fake Azure DevOps repo.',
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

test('GET /api/azure-devops/repo-check with no PAT returns the structured "authentication required" response', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, adoBaseUrl))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /Personal Access Token/)
  })
})

test('GET /api/azure-devops/repo-check with a PAT Azure DevOps itself rejects returns the exact same structured response as no PAT', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, async (gantryBase, adoBaseUrl) => {
    const noPatRes = await fetch(repoCheckUrl(gantryBase, adoBaseUrl))
    const noPatBody = await noPatRes.json()

    const badPatRes = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const badPatBody = await badPatRes.json()

    assert.equal(badPatRes.status, noPatRes.status)
    assert.deepEqual(badPatBody, noPatBody)
  })
})

// ---------- Valid PAT, instance.yaml already present ----------

test('GET /api/azure-devops/repo-check with a valid PAT against a repo that already has an instance.yaml returns that instance\'s real definition/stage/status/assignee', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result, 'found')
    assert.equal(body.slug, 'my-initiative')
    assert.equal(body.definition, 'design')
    assert.equal(body.stage, 'shape')
    // Only "context" of the shape stage's three modules (context, solution-definition, team-and-estimates) was seeded, so the stage is not complete yet.
    assert.equal(body.status, 'incomplete')
    // The instance record's own stored assignee (#97) — not derived from "context"'s own module frontmatter owner (also 'c.barlow' above, coincidentally the same value, but read from a different field).
    assert.equal(body.assignee, 'c.barlow')
  })
})

test('GET /api/azure-devops/repo-check reports "complete" once every module required at the current stage is present and filled in', async () => {
  const fullFiles = {
    ...SEED_FILES,
    '/modules/introduction.md': exampleModuleText('introduction'),
    '/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
  }
  await withFakeAzureDevOpsAndGantryServer(fullFiles, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result, 'found')
    assert.equal(body.status, 'complete')
  })
})

// ---------- Valid PAT, no instance.yaml yet ----------

test('GET /api/azure-devops/repo-check with a valid PAT against a repo with no instance.yaml yet returns a clear "no instance data here yet" result', async () => {
  await withFakeAzureDevOpsAndGantryServer({}, async (gantryBase, adoBaseUrl) => {
    const res = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { result: 'empty', message: 'No instance data found at this location yet.' })
  })
})

// #100: one Azure DevOps repo can now hold more than one instance under gantry-workspace/<slug>/ — this route has no slug input to disambiguate with, so a location holding several is reported distinctly from "empty" rather than silently guessing one.
test('GET /api/azure-devops/repo-check with a valid PAT against a repo already holding more than one instance reports "multiple", not "empty"', async () => {
  await withFakeAzureDevOpsAndGantryServer(
    {
      '/gantry-workspace/alpha-initiative/instance.yaml': 'definition: design\nslug: alpha-initiative\nstage: shape\n',
      '/gantry-workspace/beta-initiative/instance.yaml': 'definition: design\nslug: beta-initiative\nstage: shape\n',
    },
    async (gantryBase, adoBaseUrl) => {
      const res = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
        headers: { Authorization: basicAuthHeader(VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.result, 'multiple')
      assert.deepEqual(body.slugs, ['alpha-initiative', 'beta-initiative'])
    }
  )
})

// ---------- Missing query parameters ----------

test('GET /api/azure-devops/repo-check with a missing required query parameter returns a 400 structured error, without requiring a PAT', async () => {
  await withRunningServer({}, async (gantryBase) => {
    const url = new URL(`${gantryBase}/api/azure-devops/repo-check`)
    url.searchParams.set('organization', ORGANIZATION)
    url.searchParams.set('project', PROJECT)
    // "repository" deliberately omitted.
    const res = await fetch(url.toString())
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /repository/)
  })
})

// ---------- baseUrl override is allow-listed, not a blanket switch ----------

test('GET /api/azure-devops/repo-check rejects a caller-supplied baseUrl with a 400 when the server has no allow-list at all, without making any outbound request', async () => {
  // No `allowedAzureDevOpsBaseUrls` here — the same default (empty) `gantry serve` uses. Points `baseUrl` at the fake Azure DevOps server anyway: if this were honoured, the request would succeed exactly like the tests above; the assertion below is only meaningful because the fake server is real and reachable, not because the URL is bogus.
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      await withRunningServer({}, async (gantryBase) => {
        const res = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
          headers: { Authorization: basicAuthHeader(VALID_PAT) },
        })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /baseUrl/)
      })
    }
  )
})

test('GET /api/azure-devops/repo-check rejects a caller-supplied baseUrl not on the server\'s allow-list, even though it names a different real, reachable Azure DevOps-shaped server', async () => {
  // Regression coverage for the allow-list actually being scoped per-host: a server configured to trust one specific on-premises-style location (`allowedServer`) must not thereby trust *any* location a caller names — only that exact one. `otherServer` is a second, equally real fake Azure DevOps server (not a bogus URL) to prove this isn't merely "unreachable hosts get rejected".
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (allowedServerBaseUrl) => {
      await withFakeAzureDevOpsServer(
        { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
        async (otherServerBaseUrl) => {
          await withRunningServer({ allowedAzureDevOpsBaseUrls: [allowedServerBaseUrl] }, async (gantryBase) => {
            // The allow-listed server is honoured...
            const allowedRes = await fetch(repoCheckUrl(gantryBase, allowedServerBaseUrl), {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.equal(allowedRes.status, 200)

            // ...but a different, equally real server is not, even though it isn't on this server's allow-list.
            const otherRes = await fetch(repoCheckUrl(gantryBase, otherServerBaseUrl), {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.equal(otherRes.status, 400)
            const otherBody = await otherRes.json()
            assert.match(otherBody.error, /baseUrl/)
          })
        }
      )
    }
  )
})

test('GET /api/azure-devops/repo-check treats a misconfigured (non-array) allowedAzureDevOpsBaseUrls as an empty allow-list, not a substring-match allow-list', async () => {
  // `allowedAzureDevOpsBaseUrls` given as a bare string, not wrapped in an array — a plausible operator slip. Were this passed straight to `.includes()` unchecked, `String.prototype.includes` would accept any caller-supplied *substring* of that string as a match (weaker than the exact-match allow-list this option is documented to be) instead of rejecting it the same way an absent/empty allow-list would.
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      await withRunningServer({ allowedAzureDevOpsBaseUrls: adoBaseUrl }, async (gantryBase) => {
        // A substring of the misconfigured string that a real allow-list entry would never itself be — proves this isn't just "the full string still happens to work", but that substring-matching isn't happening at all.
        const substringOfConfiguredUrl = adoBaseUrl.slice(0, -1)
        const url = new URL(`${gantryBase}/api/azure-devops/repo-check`)
        url.searchParams.set('organization', ORGANIZATION)
        url.searchParams.set('project', PROJECT)
        url.searchParams.set('repository', REPOSITORY)
        url.searchParams.set('baseUrl', substringOfConfiguredUrl)
        const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /baseUrl/)
      })
    }
  )
})

// ---------- Genuine Azure DevOps failure ----------

test('GET /api/azure-devops/repo-check surfaces a genuine Azure DevOps read failure (a 500, not a 404) as a structured error, instead of reporting "empty"', async () => {
  const basePath = `/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}`
  const fakeAdo = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://fake-azure-devops.invalid')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const [, encoded] = (req.headers['authorization'] ?? '').split(' ')
    const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : ''
    if (decoded !== `:${VALID_PAT}`) return json(401, { message: 'fake: invalid or missing PAT' })

    if (req.method === 'GET' && url.pathname === `${basePath}/items`) {
      // A genuine Azure DevOps-side failure — an outage, not a missing file.
      return json(500, { message: 'TF999999: simulated internal server error (fake, for this regression test)' })
    }
    return json(404, { message: `no fake route for ${req.method} ${url.pathname}` })
  })

  await new Promise((resolvePromise, rejectPromise) => {
    fakeAdo.listen(0, async () => {
      const { port: adoPort } = fakeAdo.address()
      const adoBaseUrl = `http://localhost:${adoPort}`
      const server = createServer({ allowedAzureDevOpsBaseUrls: [adoBaseUrl] })
      server.listen(0, async () => {
        try {
          const { port } = server.address()
          const url = new URL(`http://localhost:${port}/api/azure-devops/repo-check`)
          url.searchParams.set('organization', ORGANIZATION)
          url.searchParams.set('project', PROJECT)
          url.searchParams.set('repository', REPOSITORY)
          url.searchParams.set('baseUrl', adoBaseUrl)
          const res = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(res.status, 500)
          const body = await res.json()
          assert.match(body.error, /HTTP 500/)
          resolvePromise()
        } catch (err) {
          rejectPromise(err)
        } finally {
          server.close()
          fakeAdo.close()
        }
      })
    })
  })
})

// ---------- The credential itself is never echoed back ----------

test('the PAT never appears in the repo-check response body, whether rejected or accepted', async () => {
  await withFakeAzureDevOpsAndGantryServer(SEED_FILES, async (gantryBase, adoBaseUrl) => {
    const rejectedRes = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const rejectedText = await rejectedRes.text()
    assert.doesNotMatch(rejectedText, /a-pat-the-server-does-not-recognize/)

    const okRes = await fetch(repoCheckUrl(gantryBase, adoBaseUrl), { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    const okText = await okRes.text()
    assert.doesNotMatch(okText, new RegExp(VALID_PAT))
  })
})
