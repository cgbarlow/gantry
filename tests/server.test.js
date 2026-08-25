import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance, readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

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

test('GET /api/instance reports the examples fixture, fully populated', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/api/instance`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'examples')
    assert.equal(body.definition, 'design')
    assert.deepEqual(body.stage, { id: 'shape', title: 'Shape', gate: 'business-case' })
    assert.deepEqual(body.artefacts, [{ id: 'soap', title: 'Solution on a Page' }])

    const context = body.modules.find((m) => m.id === 'context')
    const driver = context.fields.find((f) => f.id === 'driver')
    assert.equal(driver.required, true)
    assert.match(driver.value, /\S/)

    const teamAndEstimates = body.modules.find((m) => m.id === 'team-and-estimates')
    const teams = teamAndEstimates.fields.find((f) => f.id === 'teams-and-contacts')
    assert.equal(teams.type, 'list')
    assert.ok(Array.isArray(teams.value))
    assert.ok(teams.value.length > 0)
  })
})

test('GET /api/instance?stage=<id> browses a different stage\'s modules without changing the instance\'s persisted stage', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/api/instance?stage=hld-define`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.stage, { id: 'hld-define', title: 'HLD Definition', gate: 'hld-tac-approved' })
    assert.equal(body.currentStageId, 'shape')
    assert.deepEqual(body.artefacts, [{ id: 'hld', title: 'High Level Design' }])
    assert.ok(body.modules.some((m) => m.id === 'hld-submission'))

    const instance = readInstance('examples')
    assert.equal(instance.stage, 'shape')
  })
})

test('GET /api/instance?stage=<id> includes each field\'s example text from the stage\'s declared example instance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    // stage.example resolves within the same instancesDir as the instance being browsed — mirroring how every instance lives side by side under the repo's real instances/ root.
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?stage=hld-define`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.hasExample, true)

      const hldSubmission = body.modules.find((m) => m.id === 'hld-submission')
      const purpose = hldSubmission.fields.find((f) => f.id === 'purpose-statement')
      // The new instance has no hld-define modules on disk yet — blank value, but a real example pulled from instances/examples/.
      assert.equal(purpose.value, '')
      assert.match(purpose.example, /\S/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance?stage=<unknown> throws', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/api/instance?stage=not-a-real-stage`)
    assert.equal(res.status, 500)
  })
})

test('PUT /api/instance/modules/:id writes the same file format the CLI reads, and returns updated status', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    // out/ isn't part of the module-file contract this endpoint touches, but drop it so the scratch copy mirrors a fresh instance rather than a previously-rendered one.
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/modules/context`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'agreed',
          owner: 'c.barlow',
          fields: {
            driver: 'Updated via the web form.',
            'affected-domains': ['Payments'],
            'out-of-scope': '',
          },
        }),
      })
      assert.equal(res.status, 200)
      const status = await res.json()
      const context = status.modules.find((m) => m.id === 'context')
      assert.equal(context.complete, true)
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    assert.equal(data.status, 'agreed')
    assert.equal(data.fields.driver, 'Updated via the web form.')
    assert.deepEqual(data.fields['affected-domains'], ['Payments'])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT /api/instance/modules/:id?stage=<id> reports status against the browsed stage, not the instance\'s current one', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    // A freshly-created instance, not the fully-populated examples fixture — hld-submission genuinely doesn't exist on disk yet, so this proves the PUT can write a module belonging to a stage other than the current one.
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/modules/hld-submission?stage=hld-define`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'draft',
          owner: '',
          fields: { 'purpose-statement': 'Filled in while browsing HLD Definition.' },
        }),
      })
      assert.equal(res.status, 200)
      const status = await res.json()
      assert.equal(status.stage.id, 'hld-define')
      const hldSubmission = status.modules.find((m) => m.id === 'hld-submission')
      assert.ok(hldSubmission, 'expected hld-submission in the browsed stage\'s status')
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT /api/instance/assignee sets the instance record\'s stored assignee, leaving module frontmatter owner untouched, and GET /api/instances reflects it', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assignee`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee: 'c.barlow' }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, { slug: 'my-initiative', assignee: 'c.barlow' })

      const instance = readInstance('my-initiative', { instancesDir })
      assert.equal(instance.assignee, 'c.barlow')
      assert.equal(instance.stage, 'shape')

      const listing = await (await fetch(`${base}/api/instances`)).json()
      assert.equal(listing.find((i) => i.slug === 'my-initiative').assignee, 'c.barlow')
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT /api/instance/assignee?slug=<traversal> is rejected with 400, never writing outside instancesDir', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'gantry-outside-'))
  try {
    createInstance('design', 'planted', { instancesDir: outsideDir })
    const traversalSlug = relative(instancesDir, join(outsideDir, 'planted'))
    assert.ok(traversalSlug.includes('/'), 'test setup sanity check: traversal slug must span directories')

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assignee?slug=${encodeURIComponent(traversalSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee: 'attacker' }),
      })
      assert.equal(res.status, 400)
    })

    const instance = readInstance('planted', { instancesDir: outsideDir })
    assert.equal(instance.assignee, '')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/render/:artefact renders a real docx via the web form path', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/render/soap`, { method: 'POST' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.artefact, 'soap')
      assert.match(body.docxPath, /out[/\\]soap\.docx$/)
      // Absolute, not relative to wherever `gantry serve` happened to be launched from — the browser has no way to resolve a relative path.
      assert.equal(isAbsolute(body.docxPath), true)
      assert.ok(existsSync(body.docxPath))
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance/check reports pass/fail for the instance\'s current gate, mirroring `gantry check`', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ instancesDir }, async (base) => {
      const passing = await (await fetch(`${base}/api/instance/check?slug=examples`)).json()
      assert.equal(passing.pass, true)
      assert.deepEqual(passing.stage, { id: 'shape', title: 'Shape', gate: 'business-case' })

      const failing = await (await fetch(`${base}/api/instance/check?slug=my-initiative`)).json()
      assert.equal(failing.pass, false)
      assert.ok(failing.modules.some((m) => m.outstanding.length > 0))
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance/check with no slug given reports a 400, not a crash', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/check`)
      assert.equal(res.status, 400)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/definitions/:id/stages reports the definition\'s stages in order, for dashboard swimlane lanes', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/stages`)
    assert.equal(res.status, 200)
    const stages = await res.json()
    assert.deepEqual(stages, [
      { id: 'shape', title: 'Shape', gate: 'business-case' },
      { id: 'hld-define', title: 'HLD Definition', gate: 'hld-tac-approved' },
      { id: 'detailed-design', title: 'Detailed Design', gate: 'build-ready-checklist' },
      { id: 'handover', title: 'Operational Handover', gate: 'operational-handover' },
    ])
  })
})

test('GET /api/definitions/:id/stages for an unknown definition reports a 500, not a crash', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/not-a-real-definition/stages`)
    assert.equal(res.status, 500)
  })
})

test('GET / serves index.html with the import map resolved (no leftover placeholder)', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.doesNotMatch(html, /__IMPORT_MAP__/)
    assert.match(html, /"codemirror":\s*"\/node_modules\/codemirror\/dist\/index\.js"/)
  })
})

test('GET /new-workspace (a client-side route with no matching static file) falls back to index.html, not a 404', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/new-workspace`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.doesNotMatch(html, /__IMPORT_MAP__/)
    assert.match(html, /<div id="app">/)
  })
})

test('GET /does-not-exist.js (a missing file with an extension) still 404s rather than falling back to index.html', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/does-not-exist.js`)
    assert.equal(res.status, 404)
  })
})

test('GET /node_modules/... serves real dependency files for the browser to import', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/node_modules/codemirror/dist/index.js`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /basicSetup/)
  })
})

test('GET /instance/<slug> (a client-side preact-iso route, not a real file) serves the app shell, not a 404', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/instance/examples`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.doesNotMatch(html, /__IMPORT_MAP__/)
    assert.match(html, /<div id="app">/)
  })
})

test('GET /app.js serves the web form script from web/', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/app.js`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /from 'codemirror'/)
  })
})

test('GET /api/instances lists every registered instance, without the server being pinned to one slug', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'zebra-initiative', { instancesDir })
    createInstance('design', 'alpha-initiative', { instancesDir, assignee: 'c.barlow' })

    // No `slug` option at all — the server still starts and serves instance data via the listing endpoint, proving it no longer requires a single fixed slug at startup.
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, [
        { slug: 'alpha-initiative', definition: 'design', stage: 'shape', status: 'incomplete', assignee: 'c.barlow' },
        { slug: 'zebra-initiative', definition: 'design', stage: 'shape', status: 'incomplete', assignee: '' },
      ])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instances reflects instances registered after server startup', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const before = await (await fetch(`${base}/api/instances`)).json()
      assert.deepEqual(before, [])

      createInstance('design', 'my-initiative', { instancesDir })

      const after = await (await fetch(`${base}/api/instances`)).json()
      assert.deepEqual(after.map((i) => i.slug), ['my-initiative'])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance?slug=<slug> serves instance data per-request even when the server has no default slug', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?slug=examples`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.slug, 'examples')
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance with no slug given (no default, no query param) reports a 400, not a crash', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance`)
      assert.equal(res.status, 400)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// `slug` arrives from request input now (`?slug=<slug>`), not only a trusted CLI argument at startup — these lock in that a path-traversal slug is rejected before it ever reaches the filesystem, for every route that resolves a slug per-request, rather than escaping `instancesDir`.
test('GET /api/instance?slug=<traversal> is rejected with 400, never reading outside instancesDir', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'gantry-outside-'))
  try {
    // A real instance sitting just outside instancesDir — `traversalSlug` is the exact relative path from instancesDir to it (not merely a `../` prefix), so if the check below were absent, this is genuinely the directory `join(instancesDir, traversalSlug)` would resolve to and expose, not an arbitrary escape into an unrelated/nonexistent path.
    cpSync('instances/examples', join(outsideDir, 'examples'), { recursive: true })
    rmSync(join(outsideDir, 'examples', 'out'), { recursive: true, force: true })
    const traversalSlug = relative(instancesDir, join(outsideDir, 'examples'))
    assert.ok(traversalSlug.includes('/'), 'test setup sanity check: traversal slug must span directories')

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance?slug=${encodeURIComponent(traversalSlug)}`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /Invalid instance slug/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('PUT /api/instance/modules/:id?slug=<traversal> is rejected with 400, never writing outside instancesDir', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'gantry-outside-'))
  try {
    createInstance('design', 'planted', { instancesDir: outsideDir })
    // The exact relative path from instancesDir to the planted instance — if the check below were absent, this is genuinely where the write would land, not an arbitrary escape into an unrelated/nonexistent path.
    const traversalSlug = relative(instancesDir, join(outsideDir, 'planted'))
    assert.ok(traversalSlug.includes('/'), 'test setup sanity check: traversal slug must span directories')

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/modules/context?slug=${encodeURIComponent(traversalSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'agreed', owner: 'attacker', fields: { driver: 'should never be written' } }),
      })
      assert.equal(res.status, 400)
    })

    const contextPath = join(outsideDir, 'planted', 'modules', 'context.md')
    const raw = readFileSync(contextPath, 'utf8')
    assert.doesNotMatch(raw, /should never be written/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('slugs containing ".." or a path separator are rejected outright, even without traversing to a real target', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      for (const badSlug of ['..', '.', 'foo/bar', 'foo\\bar', '../../etc']) {
        const res = await fetch(`${base}/api/instance?slug=${encodeURIComponent(badSlug)}`)
        assert.equal(res.status, 400, `expected 400 for slug ${JSON.stringify(badSlug)}`)
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- /api/definitions and POST /api/instances (instance-setup wizard, #78) ----------

test('GET /api/definitions lists every definition with its stages, for the setup wizard\'s definition picker', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions`)
    assert.equal(res.status, 200)
    const body = await res.json()
    const design = body.find((d) => d.id === 'design')
    assert.equal(design.title, 'Solution Design')
    assert.deepEqual(design.stages, [
      { id: 'shape', title: 'Shape' },
      { id: 'hld-define', title: 'HLD Definition' },
      { id: 'detailed-design', title: 'Detailed Design' },
      { id: 'handover', title: 'Operational Handover' },
    ])
  })
})

test('POST /api/instances registers a new instance, which then appears in GET /api/instances', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'design', slug: 'claims-modernisation' }),
      })
      assert.equal(res.status, 201)
      const created = await res.json()
      assert.deepEqual(created, {
        slug: 'claims-modernisation',
        definition: 'design',
        stage: 'shape',
        status: 'incomplete',
        assignee: '',
      })

      const listing = await (await fetch(`${base}/api/instances`)).json()
      assert.ok(listing.some((i) => i.slug === 'claims-modernisation'))
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with a slug that already exists reports 409, not 500', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'claims-modernisation', { instancesDir })

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'design', slug: 'claims-modernisation' }),
      })
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.match(body.error, /already exists/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with an unknown definition reports 400, not 500', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'not-a-real-definition', slug: 'claims-modernisation' }),
      })
      assert.equal(res.status, 400)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Regression test for a path-traversal hole found in review: `definition` used to flow straight into `loadDefinition` (`join(definitionsDir, definitionId)`) with no equivalent of `slug`'s isValidSlug guard, so a `definition` value escaping `definitionsDir` (paired with a planted `definition.yaml` whose own `id` field echoed the traversal string back) could read, and fully register an instance against, an arbitrary directory outside definitionsDir. `definition` must now exactly match one of `listDefinitions()`'s real ids, so a traversal payload is rejected as simply "unknown" before it ever reaches the filesystem.
test('POST /api/instances rejects a path-traversal "definition" outright, never reaching loadDefinition', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'gantry-outside-'))
  try {
    // A real, well-formed definition planted just outside `definitionsDir` — if the traversal were still possible, this is genuinely what it would resolve to and successfully load, not an arbitrary/nonexistent escape.
    writeFileSync(
      join(outsideDir, 'definition.yaml'),
      'id: planted\ntitle: Planted outside definitionsDir\nstages: []\nartefacts: []\n'
    )
    const traversalDefinitionId = relative('definitions', outsideDir)
    assert.ok(traversalDefinitionId.includes('/'), 'test setup sanity check: traversal payload must span directories')

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: traversalDefinitionId, slug: 'traversal-test' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /Unknown definition/)

      const listing = await (await fetch(`${base}/api/instances`)).json()
      assert.deepEqual(listing, [])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with an invalid slug reports 400, never reaching createInstance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      for (const badSlug of ['..', '.', 'foo/bar', '../../etc']) {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: 'design', slug: badSlug }),
        })
        assert.equal(res.status, 400, `expected 400 for slug ${JSON.stringify(badSlug)}`)
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- POST /api/instances with an Azure DevOps location (#93) ----------
//
// Unlike tests/serverAzureDevOpsAuth.test.js (a server *started* already pinned to one Azure DevOps location via `options.azureDevOps`), these exercise the per-request location this ticket adds: a plain `withRunningServer({ instancesDir })` server — no `options.azureDevOps` at all — accepting an `azureDevOps` field in the POST body itself.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

test('POST /api/instances with an Azure DevOps location and no PAT returns the structured "authentication required" response, and writes nothing', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 401)
        const body = await res.json()
        assert.equal(body.error, 'authentication_required')

        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await assert.rejects(() => client.getFileContent('instance.yaml'))
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with an Azure DevOps location and a PAT the fake server rejects returns the same structured response', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader('wrong-pat') },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 401)
        const body = await res.json()
        assert.equal(body.error, 'authentication_required')
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with an Azure DevOps location missing required fields reports 400, not 500', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'design', slug: 'remote-initiative', azureDevOps: { organization: ORGANIZATION } }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /missing: project, repository/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Security regression test: without an explicit server-level opt-in, a caller-supplied `baseUrl` must never be honored — see createServer's own doc comment on `allowAzureDevOpsBaseUrlOverride`. Before this guard existed, any HTTP caller could register an Azure-DevOps-backed instance pointing at a server *they* control; since `GET /api/instances` forwards whatever PAT the *current* caller presents to every registered Azure-DevOps-backed entry (to build the unified listing), that let one caller register a location that silently exfiltrated every other caller's real Azure DevOps PAT the next time anyone loaded the dashboard.
test('POST /api/instances with an azureDevOps.baseUrl reports 400 on a server that has not opted into allowAzureDevOpsBaseUrlOverride, and writes nothing', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
      // Note: no `allowAzureDevOpsBaseUrlOverride` here — the default, and what any real deployment would run with.
      await withRunningServer({ instancesDir }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /baseUrl/)

        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await assert.rejects(() => client.getFileContent('instance.yaml'))
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with a valid Azure DevOps location and PAT creates instance.yaml + first-stage module files in that repo, registers it, and the instance then appears in GET /api/instances', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
      // No `options.azureDevOps` at server startup — #93's whole point is that one running gantry server can register any number of Azure-DevOps-backed instances at once, chosen per request. `allowAzureDevOpsBaseUrlOverride` is a test-only opt-in (see createServer's doc comment) so this can point at the fake server.
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            owner: 'a-module-owner',
            assignee: 'c.barlow',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 201)
        const created = await res.json()
        assert.equal(created.slug, 'remote-initiative')
        assert.equal(created.definition, 'design')
        assert.equal(created.stage, 'shape')
        assert.equal(created.status, 'incomplete')
        assert.equal(created.assignee, 'c.barlow')
        // An Azure-DevOps-backed row carries its workspace (#96/#102) — auto-created for this organization/project/repository the moment the instance was registered against it.
        assert.equal(created.workspace.organization, ORGANIZATION)
        assert.equal(created.workspace.project, PROJECT)
        assert.equal(created.workspace.repository, REPOSITORY)
        assert.equal(typeof created.workspace.id, 'string')

        // Verified directly against the fake Azure DevOps repo — exactly as createInstance's own Azure DevOps path already does when called directly (#85) — not just gantry's own idea of what it wrote.
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        const instanceYaml = await client.getFileContent('gantry-workspace/remote-initiative/instance.yaml')
        assert.match(instanceYaml, /definition: design/)
        assert.match(instanceYaml, /slug: remote-initiative/)
        assert.match(instanceYaml, /stage: shape/)
        assert.match(instanceYaml, /assignee: c\.barlow/)
        const definition = loadDefinition('design')
        for (const moduleId of definition.stages[0].modules) {
          const moduleText = await client.getFileContent(`gantry-workspace/remote-initiative/modules/${moduleId}.md`)
          assert.match(moduleText, /owner: a-module-owner/)
        }

        // Not just written to the fake repo — immediately resolvable and visible in the same server's own instance listing, with no instancesDir directory ever created for it locally.
        assert.equal(existsSync(join(instancesDir, 'remote-initiative')), false)

        const listingRes = await fetch(`${base}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
        assert.equal(listingRes.status, 200)
        const listing = await listingRes.json()
        const listedRow = listing.find((i) => i.slug === 'remote-initiative')
        assert.equal(listedRow.definition, 'design')
        assert.equal(listedRow.stage, 'shape')
        assert.equal(listedRow.status, 'incomplete')
        assert.equal(listedRow.assignee, 'c.barlow')
        assert.equal(listedRow.workspace.repository, REPOSITORY)
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with an Azure DevOps location that already has an instance reports 409, not 500', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    const seedFiles = {
      '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nslug: remote-initiative\nstage: shape\n',
    }
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: seedFiles }, async (adoBaseUrl) => {
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 409)
        const body = await res.json()
        assert.match(body.error, /already exists/)
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Regression test for a cross-backend slug-collision hole found in review: createInstance's own "already exists" check only ever looks at the *one* backend the current request is writing to, so registering a *new* azureDevOps location under a slug some pre-existing *local* instance already uses used to succeed (201) and silently overwrite that slug's registry entry — orphaning the local instance's data (still on disk, but no longer resolvable/listed).
test('POST /api/instances with an Azure DevOps location reusing a slug that already exists locally reports 409, and does not overwrite the registry entry', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'local-initiative', { instancesDir, assignee: 'local-assignee' })

    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
          body: JSON.stringify({
            definition: 'design',
            slug: 'local-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 409)
        const body = await res.json()
        assert.match(body.error, /already exists/)

        // Still routed locally — never overwritten — and still listed.
        const listing = await (await fetch(`${base}/api/instances`)).json()
        assert.deepEqual(
          listing.find((i) => i.slug === 'local-initiative'),
          { slug: 'local-initiative', definition: 'design', stage: 'shape', status: 'incomplete', assignee: 'local-assignee' }
        )
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instances without a PAT still lists local instances, simply omitting an Azure-DevOps-backed one it cannot yet read', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'local-initiative', { instancesDir })
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })

        const res = await fetch(`${base}/api/instances`)
        assert.equal(res.status, 200)
        const listing = await res.json()
        assert.ok(listing.some((i) => i.slug === 'local-initiative'))
        assert.ok(!listing.some((i) => i.slug === 'remote-initiative'))
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Regression test for an availability hole found in review: one unreachable/erroring Azure-DevOps-backed registry entry (a network error, an outage, a renamed host) used to make `buildAzureDevOpsRow` rethrow, which crashed the *entire* `GET /api/instances` response (a 500) — hiding every other, including purely local, instance in the same unified listing.
test('GET /api/instances still lists local instances even when a registered Azure-DevOps-backed entry is completely unreachable', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'healthy-local', { instancesDir })
    registerInstance(
      'unreachable-remote',
      {
        kind: 'azureDevOps',
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        // Nothing listens here — simulates a network error / outage talking to this one registered org, distinct from an authentication rejection.
        baseUrl: 'http://127.0.0.1:1',
      },
      { instancesDir }
    )

    await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
      const res = await fetch(`${base}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      assert.equal(res.status, 200)
      const listing = await res.json()
      assert.ok(listing.some((i) => i.slug === 'healthy-local'))
      assert.ok(!listing.some((i) => i.slug === 'unreachable-remote'))
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- #139: nonexistent repository rejection at instance creation ----------

test('POST /api/instances with an Azure DevOps location whose repository does not exist returns 400 with a human-readable message, not a raw REST error', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {}, repoExists: false }, async (adoBaseUrl) => {
      await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const res = await fetch(`${base}/api/instances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
          body: JSON.stringify({
            definition: 'design',
            slug: 'remote-initiative',
            azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          }),
        })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /does not exist/)
        assert.match(body.error, /create it in Azure DevOps first/)
        assert.match(body.error, new RegExp(REPOSITORY))

        const listing = await (await fetch(`${base}/api/instances`)).json()
        assert.equal(listing.length, 0)
      })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
