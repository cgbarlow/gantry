import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from '../lib/server.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Server-level credential gating (#86), now driven by per-request resolution against the instance registry (#89/#92) rather than a fixed `createServer({ azureDevOps })` location: a slug the registry says is Azure-DevOps-backed marks that one request's single-instance routes (GET /api/instance, PUT /api/instance/modules/:id, POST /api/instance/render/:artefact) as such. These tests exercise that gating with real HTTP requests against a running gantry server (mirroring tests/server.test.js's existing `withRunningServer` pattern), backed by the same fake in-process Azure DevOps server tests/instance.test.js and tests/azureDevOpsClient.test.js use — never the real dev.azure.com.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

// Seeds a fake Azure DevOps repo with a real "my-initiative" design instance at the "shape" stage — the same shape createInstance's own Azure DevOps path (#85) writes — registers that slug in the instance registry (#89) as Azure-DevOps-backed (the only thing that now marks a slug as such, per #92), then runs `fn(baseUrl)` with a gantry server started against a scratch `instancesDir` with no fixed location of its own at all.
function withAzureDevOpsBackedServer(files, serverOptions, fn) {
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          'my-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        await withRunningServer(
          {
            slug: 'my-initiative',
            instancesDir,
            ...serverOptions,
          },
          (base) => fn(base, adoBaseUrl)
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
}

const SEED_FILES = {
  '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
  '/gantry-workspace/my-initiative/modules/context.md': [
    '---',
    'module: context',
    'status: draft',
    'owner: c.barlow',
    '---',
    '',
    '## Business driver',
    '',
    'Seeded from the fake Azure DevOps repo.',
    '',
    '## Affected domains',
    '',
    '- Payments',
    '',
    '## Explicitly out of scope',
    '',
    'Nothing yet.',
    '',
  ].join('\n'),
}

// ---------- GET /api/instance ----------

test('GET /api/instance against an Azure-DevOps-backed instance with no PAT returns the structured "authentication required" response', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance`)
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
    assert.match(body.message, /Personal Access Token/)
  })
})

test('GET /api/instance against an Azure-DevOps-backed instance with a PAT the fake server rejects returns the exact same structured response as no PAT', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const noPatRes = await fetch(`${base}/api/instance`)
    const noPatBody = await noPatRes.json()

    const badPatRes = await fetch(`${base}/api/instance`, {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const badPatBody = await badPatRes.json()

    assert.equal(badPatRes.status, noPatRes.status)
    assert.deepEqual(badPatBody, noPatBody)
  })
})

test('GET /api/instance against an Azure-DevOps-backed instance with a valid PAT is proxied through correctly', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'my-initiative')
    assert.equal(body.definition, 'design')
    assert.deepEqual(body.stage, { id: 'shape', title: 'SOAP', gate: 'business-case' })

    const context = body.modules.find((m) => m.id === 'context')
    const driver = context.fields.find((f) => f.id === 'driver')
    assert.equal(driver.value, 'Seeded from the fake Azure DevOps repo.')
    const domains = context.fields.find((f) => f.id === 'affected-domains')
    assert.deepEqual(domains.value, ['Payments'])

    // A module with no data yet at all in the fake repo (a later stage's module) still reports its blank draft default, not an error.
    const solutionDefinition = body.modules.find((m) => m.id === 'solution-definition')
    assert.equal(solutionDefinition.status, 'draft')
  })
})

// A genuine Azure DevOps-side failure (not a 404 "no saved data yet" miss, not a 401/403 rejected-PAT) reading one module's file must surface as a real error, not be silently swallowed into "this module is just blank" — regression test for a review finding where the GET /api/instance handler caught *every* readModule failure other than AzureDevOpsAuthenticationError and treated it as "no data yet". Uses a minimal ad hoc fake server (rather than tests/helpers/fakeAzureDevOpsServer.js, which has no way to inject a GET failure) so one specific module's read can be made to fail with a 500 while the rest of the repo behaves normally.
test('GET /api/instance surfaces a genuine Azure DevOps read failure (a 500, not a 404) as an error, instead of reporting the module as blank', async () => {
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

    // GET /api/instance's own bootstrap read (#122's read-only findStageBranch) asks whether this stage already has its own branch before reading anything else — reporting none here (the same "nothing but main exists" shape the shared fakeAzureDevOpsServer.js gives an unseeded stage branch) keeps this ad hoc fake's module-read-failure simulation below the one and only thing this regression test actually exercises.
    if (req.method === 'GET' && url.pathname === `${basePath}/refs`) {
      return json(200, { count: 0, value: [] })
    }

    if (req.method === 'GET' && url.pathname === `${basePath}/items`) {
      const path = url.searchParams.get('path')
      if (path === '/gantry-workspace/my-initiative/instance.yaml') {
        return json(200, {
          path,
          content: SEED_FILES['/gantry-workspace/my-initiative/instance.yaml'],
          objectId: '1'.padStart(40, '0'),
        })
      }
      if (path === '/gantry-workspace/my-initiative/modules/context.md') {
        // A genuine Azure DevOps-side failure — an outage, not a missing file.
        return json(500, { message: 'TF999999: simulated internal server error (fake, for this regression test)' })
      }
      return json(404, { message: `no fake item at ${path}` })
    }
    return json(404, { message: `no fake route for ${req.method} ${url.pathname}` })
  })

  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      fakeAdo.listen(0, async () => {
        const { port: adoPort } = fakeAdo.address()
        registerInstance(
          'my-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: `http://localhost:${adoPort}` },
          { instancesDir }
        )
        const server = createServer({ slug: 'my-initiative', instancesDir })
        server.listen(0, async () => {
          try {
            const { port } = server.address()
            const res = await fetch(`http://localhost:${port}/api/instance`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            // A real failure, not a 200 with the module quietly reported as an empty draft.
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
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- PUT /api/instance/modules/:id ----------

test('PUT /api/instance/modules/:id against an Azure-DevOps-backed instance with no PAT returns the structured "authentication required" response, and writes nothing', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance/modules/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'agreed', owner: 'attacker', fields: { driver: 'should never be written' } }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('PUT /api/instance/modules/:id against an Azure-DevOps-backed instance with a PAT the fake server rejects returns the same structured response', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance/modules/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-valid-pat') },
      body: JSON.stringify({ status: 'agreed', owner: 'attacker', fields: { driver: 'should never be written' } }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('PUT /api/instance/modules/:id against an Azure-DevOps-backed instance with a valid PAT writes through and reports updated status', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance/modules/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({
        status: 'agreed',
        owner: 'c.barlow',
        fields: {
          driver: 'Updated via Azure DevOps.',
          'affected-domains': ['Payments', 'Client Record'],
          'out-of-scope': '',
        },
      }),
    })
    assert.equal(res.status, 200)
    const status = await res.json()
    const context = status.modules.find((m) => m.id === 'context')
    assert.equal(context.complete, true)

    // Reading it back (also with a valid PAT) proves the write actually landed in the fake Azure DevOps repo, not just in the response.
    const readRes = await fetch(`${base}/api/instance`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    const readBody = await readRes.json()
    const readContext = readBody.modules.find((m) => m.id === 'context')
    const driver = readContext.fields.find((f) => f.id === 'driver')
    assert.equal(driver.value, 'Updated via Azure DevOps.')
  })
})

test('PUT /api/instance/modules/:id against an Azure-DevOps-backed instance also renders and commits the stage\'s own artefact(s) to the same stage branch (#123, ADR-0014)', async () => {
  const fullFiles = {
    ...SEED_FILES,
    '/gantry-workspace/my-initiative/modules/solution-definition.md': readFileSync('instances/examples/modules/solution-definition.md', 'utf8'),
    '/gantry-workspace/my-initiative/modules/team-and-estimates.md': readFileSync('instances/examples/modules/team-and-estimates.md', 'utf8'),
  }
  await withAzureDevOpsBackedServer(fullFiles, {}, async (base, adoBaseUrl) => {
    const res = await fetch(`${base}/api/instance/modules/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({
        status: 'agreed',
        owner: 'c.barlow',
        fields: { driver: 'Updated via Azure DevOps.', 'affected-domains': ['Payments'], 'out-of-scope': '' },
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(
      body.rendered.map((r) => r.artefactId),
      ['soap', 'soap-full']
    )
    assert.equal(body.rendered[0].rendered, true)
    assert.equal(body.rendered[0].azureDevOpsPath, 'gantry-workspace/my-initiative/out/soap.docx')

    // The rendered artefact actually landed on the "shape" stage's own branch, not 'main' — the same write path (#122) the module save itself used.
    const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
    const stageBranch = stageBranchName('my-initiative', 'shape')
    const pushedContent = await client.getFileContent('gantry-workspace/my-initiative/out/soap.docx', { branch: stageBranch })
    const pushedBytes = Buffer.from(pushedContent, 'base64')
    assert.equal(pushedBytes.subarray(0, 2).toString(), 'PK')
  })
})

test('PUT /api/instance/modules/:id against an Azure-DevOps-backed instance still saves and reports success even when the stage\'s artefact(s) can\'t be rendered yet', async () => {
  // SEED_FILES seeds only "context" — "soap" also requires solution-definition and team-and-estimates, so this save's own follow-up render has nothing complete enough to render.
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance/modules/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ status: 'agreed', owner: 'c.barlow', fields: { driver: 'Still just getting started.' } }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // The save itself still succeeded and is reported as such (this is not a save-failure test) — only the follow-up render is what's incomplete.
    assert.ok(body.modules.find((m) => m.id === 'context'))
    assert.deepEqual(
      body.rendered.map((r) => r.artefactId),
      ['soap', 'soap-full']
    )
    assert.equal(body.rendered[0].rendered, false)
    assert.equal(body.rendered[0].skipped, true)
  })
})

// ---------- PUT /api/instance/assignee (#97) ----------

test('PUT /api/instance/assignee against an Azure-DevOps-backed instance with no PAT returns the structured "authentication required" response, and writes nothing', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base, adoBaseUrl) => {
    const res = await fetch(`${base}/api/instance/assignee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee: 'should-never-be-written' }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')

    const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
    const instanceYaml = await client.getFileContent('gantry-workspace/my-initiative/instance.yaml')
    assert.doesNotMatch(instanceYaml, /should-never-be-written/)
  })
})

test('PUT /api/instance/assignee against an Azure-DevOps-backed instance with a PAT the fake server rejects returns the same structured response', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance/assignee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('not-a-valid-pat') },
      body: JSON.stringify({ assignee: 'c.barlow' }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('PUT /api/instance/assignee against an Azure-DevOps-backed instance with a valid PAT writes through to instance.yaml, leaving module frontmatter untouched', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base, adoBaseUrl) => {
    const res = await fetch(`${base}/api/instance/assignee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ assignee: 'j.smith' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { slug: 'my-initiative', assignee: 'j.smith' })

    // Reading it back proves the write actually landed in the fake Azure DevOps repo's instance.yaml, not just in the response, and that the instance's other fields (stage) survived the update untouched. The write is a genuine write (#122) — it lands on the "shape" stage's own branch (created the moment this request touched it), not 'main', which only ever reflects a stage once its own Pull Request has actually merged.
    const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
    const stageBranch = stageBranchName('my-initiative', 'shape')
    const instanceYaml = await client.getFileContent('gantry-workspace/my-initiative/instance.yaml', { branch: stageBranch })
    assert.match(instanceYaml, /assignee: j\.smith/)
    assert.match(instanceYaml, /stage: shape/)

    const readRes = await fetch(`${base}/api/instance`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    const readBody = await readRes.json()
    const context = readBody.modules.find((m) => m.id === 'context')
    // The module's own frontmatter owner ("c.barlow", seeded by SEED_FILES) is a separate, untouched field — not overwritten by the assignee update.
    assert.equal(context.owner, 'c.barlow')

    const listingRes = await fetch(`${base}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    const listing = await listingRes.json()
    assert.equal(listing.find((i) => i.slug === 'my-initiative').assignee, 'j.smith')
  })
})

// ---------- POST /api/instance/render/:artefact ----------

test('POST /api/instance/render/:artefact against an Azure-DevOps-backed instance with no PAT returns the structured "authentication required" response', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const res = await fetch(`${base}/api/instance/render/soap`, { method: 'POST' })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('POST /api/instance/render/:artefact against an Azure-DevOps-backed instance with a valid PAT renders a real docx, reading module data from Azure DevOps, and pushes it back to that same repo', async () => {
  const fullFiles = {
    ...SEED_FILES,
    '/gantry-workspace/my-initiative/modules/solution-definition.md': readFileSync('instances/examples/modules/solution-definition.md', 'utf8'),
    '/gantry-workspace/my-initiative/modules/team-and-estimates.md': readFileSync('instances/examples/modules/team-and-estimates.md', 'utf8'),
  }
  await withAzureDevOpsBackedServer(fullFiles, {}, async (base, adoBaseUrl) => {
    const res = await fetch(`${base}/api/instance/render/soap`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.artefact, 'soap')
    // No local docxPath reported — the rendered artefact's real location is now the Azure DevOps repo it was rendered from, not a scratch path on whichever machine `gantry serve` happens to run on.
    assert.equal(body.docxPath, undefined)
    assert.equal(body.azureDevOpsPath, 'gantry-workspace/my-initiative/out/soap.docx')

    const client = createAzureDevOpsClient({
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      pat: VALID_PAT,
      baseUrl: adoBaseUrl,
    })
    // The render pipeline is a genuine write (#122) — it pushes onto the "shape" stage's own branch, not 'main'.
    const stageBranch = stageBranchName('my-initiative', 'shape')
    const pushedContent = await client.getFileContent('gantry-workspace/my-initiative/out/soap.docx', { branch: stageBranch })
    const pushedBytes = Buffer.from(pushedContent, 'base64')
    // A real .docx is a zip archive — starts with the "PK" magic bytes.
    assert.equal(pushedBytes.subarray(0, 2).toString(), 'PK')
  })
})

test('rendering the same artefact against an Azure-DevOps-backed instance twice overwrites the previous render rather than accumulating files', async () => {
  const fullFiles = {
    ...SEED_FILES,
    '/gantry-workspace/my-initiative/modules/solution-definition.md': readFileSync('instances/examples/modules/solution-definition.md', 'utf8'),
    '/gantry-workspace/my-initiative/modules/team-and-estimates.md': readFileSync('instances/examples/modules/team-and-estimates.md', 'utf8'),
  }
  await withAzureDevOpsBackedServer(fullFiles, {}, async (base) => {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/api/instance/render/soap`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.azureDevOpsPath, 'gantry-workspace/my-initiative/out/soap.docx')
    }
  })
})

// ---------- Local instances are unaffected ----------

test('local instances (a slug the registry has never seen, or resolves as local) never require a credential, even against the examples fixture', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/api/instance`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'examples')
  })
})

// ---------- The credential itself is never echoed back ----------

test('the PAT never appears in the "authentication required" response body, nor in a proxied read response', async () => {
  await withAzureDevOpsBackedServer(SEED_FILES, {}, async (base) => {
    const rejectedRes = await fetch(`${base}/api/instance`, {
      headers: { Authorization: basicAuthHeader('a-pat-the-server-does-not-recognize') },
    })
    const rejectedText = await rejectedRes.text()
    assert.doesNotMatch(rejectedText, /a-pat-the-server-does-not-recognize/)

    const okRes = await fetch(`${base}/api/instance`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
    const okText = await okRes.text()
    assert.doesNotMatch(okText, new RegExp(VALID_PAT))
  })
})
