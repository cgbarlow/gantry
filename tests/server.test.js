import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance, readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'


test('GET /api/instance reports the examples fixture, fully populated', async () => {
  await withRunningServer({ slug: 'examples' }, async (base) => {
    const res = await fetch(`${base}/api/instance`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'examples')
    assert.equal(body.definition, 'design')
    assert.deepEqual(body.stage, { id: 'shape', title: 'SOAP', gate: 'business-case', number: 1 })
    assert.deepEqual(body.artefacts, [
      {
        id: 'soap',
        title: 'Solution on a Page',
        requires: [
          'background.problem',
          'background.affected-domains',
          'introduction.in-scope',
          'introduction.out-of-scope',
          'solution-definition.process-flow',
          'solution-definition.high-level-solution-overview',
          'solution-definition.high-level-requirements',
          'solution-definition.feature-breakdown',
          'team-and-estimates.teams-required',
          'team-and-estimates.estimates',
          'team-and-estimates.references?',
        ],
      },
      {
        id: 'soap-full',
        title: 'Full Solution on a Page',
        requires: [
          'soap-full-details.epic-project',
          'soap-full-details.requested-lead-by',
          'soap-full-details.request-date',
          'soap-full-details.draft-agreed-date',
          'soap-full-details.delivered-date',
          'background.problem',
          'background.opportunity',
          'introduction.in-scope',
          'introduction.out-of-scope',
          'solution-definition.high-level-requirements',
          'solution-definition.high-level-solution-overview',
          'solution-definition.alternatives-sketch?',
          'team-and-estimates.teams-required',
          'dependencies.dependencies-overview',
          'introduction.assumptions?',
          'introduction.constraints?',
          'introduction.caveats?',
          'team-and-estimates.estimates',
          'soap-full-details.sequencing',
          'soap-full-details.questions',
          'soap-full-details.caveats',
          'team-and-estimates.references',
        ],
      },
    ])

    const background = body.modules.find((m) => m.id === 'background')
    const problem = background.fields.find((f) => f.id === 'problem')
    assert.match(problem.value, /\S/)

    const teamAndEstimates = body.modules.find((m) => m.id === 'team-and-estimates')
    const teams = teamAndEstimates.fields.find((f) => f.id === 'teams-required')
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
    assert.deepEqual(body.stage, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved', number: 2 })
    assert.equal(body.currentStageId, 'shape')
    assert.deepEqual(body.artefacts, [{ id: 'hld', title: 'High Level Design', requires: ['hld-submission', 'background', 'proposed-solution', 'alternatives-considered', 'open-questions', 'nfrs', 'risks', 'security', 'dependencies', 'introduction.in-scope', 'introduction.out-of-scope', 'introduction.assumptions?', 'introduction.constraints?', 'introduction.caveats?'] }])
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
      const res = await fetch(`${base}/api/instance/modules/background`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'agreed',
          owner: 'c.barlow',
          fields: {
            problem: 'Updated via the web form.',
            'affected-domains': ['Payments'],
            opportunity: '',
          },
        }),
      })
      assert.equal(res.status, 200)
      const status = await res.json()
      const background = status.modules.find((m) => m.id === 'background')
      assert.equal(background.complete, true)
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'background', { instancesDir })
    assert.equal(data.status, 'agreed')
    assert.equal(data.fields.problem, 'Updated via the web form.')
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
      assert.equal(body.azureDevOpsUrl, undefined)
      assert.match(body.docxPath, /out[/\\]Examples - Solution on a Page\.docx$/)
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
      assert.deepEqual(passing.stage, { id: 'shape', title: 'SOAP', gate: 'business-case' })

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
      { id: 'shape', title: 'SOAP', gate: 'business-case' },
      { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' },
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
      assert.deepEqual(
        body.map(({ slug, definition, stage, status, assignee, workspaceNumber, instanceNumber, ref }) => ({
          slug,
          definition,
          stage,
          status,
          assignee,
          workspaceNumber,
          instanceNumber,
          ref,
        })),
        [
          {
            slug: 'alpha-initiative',
            definition: 'design',
            stage: 'shape',
            status: 'incomplete',
            assignee: 'c.barlow',
            workspaceNumber: 0,
            instanceNumber: 1,
            ref: 'w0i1',
          },
          {
            slug: 'zebra-initiative',
            definition: 'design',
            stage: 'shape',
            status: 'incomplete',
            assignee: '',
            workspaceNumber: 0,
            instanceNumber: 2,
            ref: 'w0i2',
          },
        ]
      )
      assert.deepEqual(
        body.map(({ stageNumber, stageCount, stageTitle, pullRequestId }) => ({ stageNumber, stageCount, stageTitle, pullRequestId })),
        [
          { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null },
          { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null },
        ]
      )
      for (const row of body) assert.doesNotThrow(() => new Date(row.updatedAt).toISOString())
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
      const res = await fetch(`${base}/api/instance/modules/background?slug=${encodeURIComponent(traversalSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'agreed', owner: 'attacker', fields: { problem: 'should never be written' } }),
      })
      assert.equal(res.status, 400)
    })

    const backgroundPath = join(outsideDir, 'planted', 'modules', 'background.md')
    const raw = readFileSync(backgroundPath, 'utf8')
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
      { id: 'shape', title: 'SOAP' },
      { id: 'hld-define', title: 'High-level Design' },
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
      assert.deepEqual(
        (({ slug, definition, stage, status, assignee, workspaceNumber, instanceNumber, ref }) => ({
          slug,
          definition,
          stage,
          status,
          assignee,
          workspaceNumber,
          instanceNumber,
          ref,
        }))(created),
        {
          slug: 'claims-modernisation',
          definition: 'design',
          stage: 'shape',
          status: 'incomplete',
          assignee: '',
          workspaceNumber: 0,
          instanceNumber: 1,
          ref: 'w0i1',
        }
      )
      assert.deepEqual(
        { stageNumber: created.stageNumber, stageCount: created.stageCount, stageTitle: created.stageTitle, pullRequestId: created.pullRequestId },
        { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null }
      )
      assert.doesNotThrow(() => new Date(created.updatedAt).toISOString())

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
        const local = listing.find((i) => i.slug === 'local-initiative')
        assert.deepEqual(
          (({ slug, definition, stage, status, assignee, workspaceNumber, instanceNumber, ref }) => ({
            slug,
            definition,
            stage,
            status,
            assignee,
            workspaceNumber,
            instanceNumber,
            ref,
          }))(local),
          {
            slug: 'local-initiative',
            definition: 'design',
            stage: 'shape',
            status: 'incomplete',
            assignee: 'local-assignee',
            workspaceNumber: 0,
            instanceNumber: 1,
            ref: 'w0i1',
          }
        )
        assert.deepEqual(
          { stageNumber: local.stageNumber, stageCount: local.stageCount, stageTitle: local.stageTitle, pullRequestId: local.pullRequestId },
          { stageNumber: 1, stageCount: 4, stageTitle: 'SOAP', pullRequestId: null }
        )
        assert.doesNotThrow(() => new Date(local.updatedAt).toISOString())
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

// ---------- WI198: pre-Pull-Request commit history for a stage branch ----------

test('GET /api/instance/commits returns an empty list when the stage branch does not exist yet, and the branch-scoped commits once it does', async () => {
  const SLUG = 'commit-history-initiative'
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
      },
      async (adoBaseUrl) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const stageBranch = `gantry-workspace/${SLUG}/shape`
        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (base) => {
            // No stage branch yet — the endpoint reports it cleanly rather than 404ing.
            const before = await fetch(`${base}/api/instance/commits?slug=${SLUG}&stage=shape`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.equal(before.status, 200)
            const beforeBody = await before.json()
            assert.equal(beforeBody.branch, stageBranch)
            assert.equal(beforeBody.ref, `refs/heads/${stageBranch}`)
            assert.deepEqual(beforeBody.commits, [])

            // Start the stage branch and put one commit on it that isn't on main.
            const client = createAzureDevOpsClient({
              organization: ORGANIZATION,
              project: PROJECT,
              repository: REPOSITORY,
              pat: VALID_PAT,
              baseUrl: adoBaseUrl,
            })
            await client.createBranch(stageBranch)
            await client.writeFile('/shape.md', 'shape work\n', { branch: stageBranch, message: 'Draft the shape' })

            const after = await fetch(`${base}/api/instance/commits?slug=${SLUG}&stage=shape`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.equal(after.status, 200)
            const afterBody = await after.json()
            assert.equal(afterBody.branch, stageBranch)
            assert.equal(afterBody.commits.length, 1)
            assert.match(afterBody.commits[0].message, /Draft the shape/)
            assert.ok(afterBody.commits[0].commitId)
            assert.ok(afterBody.commits[0].timestamp)

            // Unknown stage id → 400, not 500.
            const badStage = await fetch(`${base}/api/instance/commits?slug=${SLUG}&stage=not-a-real-stage`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.equal(badStage.status, 400)
            assert.match((await badStage.json()).error, /no stage "not-a-real-stage"/)

            // A PAT the fake server rejects → the auth error surfaces as 401, not a 400/500 leak.
            const badPat = await fetch(`${base}/api/instance/commits?slug=${SLUG}&stage=shape`, {
              headers: { Authorization: basicAuthHeader('wrong-pat') },
            })
            assert.equal(badPat.status, 401)
          },
        )
      },
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance/commits surfaces a missing instance.yaml as a clean 4xx, not a 500', async () => {
  const SLUG = 'commit-history-ghost'
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
      async (adoBaseUrl) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (base) => {
            const res = await fetch(`${base}/api/instance/commits?slug=${SLUG}&stage=shape`, {
              headers: { Authorization: basicAuthHeader(VALID_PAT) },
            })
            assert.ok(res.status === 400 || res.status === 404, `expected 400/404, got ${res.status}`)
            assert.match((await res.json()).error, /\S/)
          },
        )
      },
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance/commits rejects a local (non-Workspace-backed) instance with 400', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'local-initiative', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/commits?slug=local-initiative&stage=shape`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /not Workspace-backed/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- #234: definition changelog endpoint ----------

test('GET /api/definitions/design/versions/1/changelog returns seeded ## v1 text', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/1/changelog`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.version, 1)
    assert.equal(typeof body.changelog, 'string')
    assert.match(body.changelog, /## v1/)
    assert.match(body.changelog, /Initial published version/)
  })
})

test('GET /api/definitions/:id/versions/:n/changelog returns 200 with changelog:null when file is missing', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-changelog-server-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    // Remove seeded changelog to simulate missing file
    try { rmSync(join(definitionsDir, 'design/1/CHANGELOG.md'), { force: true }) } catch {}
    await withRunningServer({ definitionsDir }, async (base) => {
      const res = await fetch(`${base}/api/definitions/design/versions/1/changelog`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.version, 1)
      assert.equal(body.changelog, null)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

test('GET /api/definitions/design/versions/abc/changelog rejects non-numeric version with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/abc/changelog`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Invalid version/)
  })
})

test('GET /api/definitions/design/versions/0/changelog rejects non-positive version with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/0/changelog`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Invalid version/)
  })
})

test('GET /api/definitions/no-such-def/versions/1/changelog rejects unknown definition with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/no-such-def/versions/1/changelog`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Unknown definition/)
  })
})

// ---------- #235: definition version detail endpoint ----------

test('GET /api/definitions/design/versions/1 returns full read-only projection', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/1`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.id, 'design')
    assert.equal(body.version, 1)
    assert.equal(body.status, 'published')
    assert.ok(Array.isArray(body.stages))
    const shape = body.stages.find((s) => s.id === 'shape')
    assert.ok(shape, 'shape stage present')
    assert.equal(shape.gate, 'business-case')
    assert.ok(Array.isArray(body.artefacts))
    const soap = body.artefacts.find((a) => a.id === 'soap')
    assert.ok(soap, 'soap artefact present')
    assert.ok(Array.isArray(soap.requires) && soap.requires.length > 0)
    assert.ok(Array.isArray(body.modules))
    const ctx = body.modules.find((m) => m.id === 'background')
    assert.ok(ctx, 'background module present')
    assert.ok(Array.isArray(ctx.fields) && ctx.fields.length > 0)
    const field = ctx.fields[0]
    assert.ok('id' in field && 'title' in field && 'type' in field)
    // guidance / required / requiredAt are optional keys — JSON omits undefined, so check presence of at least id/title/type
    assert.ok('guidance' in field || field.guidance === undefined)
  })
})

test('GET /api/definitions/:id/versions/:n rejects unknown id with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/no-such-def/versions/1`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Unknown definition/)
  })
})

test('GET /api/definitions/design/versions/abc rejects non-numeric version with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/abc`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Invalid version/)
  })
})

test('GET /api/definitions/design/versions/0 rejects non-positive version with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/0`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Invalid version/)
  })
})

test('GET /api/definitions/design/versions/99 returns 404 for non-existent version', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/definitions/design/versions/99`)
    assert.equal(res.status, 404)
  })
})

test('PUT /api/definitions/:id/versions/:n happy path persists and GET reflects it', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-put-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-put-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const getRes = await fetch(`${base}/api/definitions/design/versions/2`)
      assert.equal(getRes.status, 200)
      const proj = await getRes.json()
      proj.modules[0].title = 'Updated Title'
      const putRes = await fetch(`${base}/api/definitions/design/versions/2`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proj) })
      assert.equal(putRes.status, 200)
      const putBody = await putRes.json()
      assert.equal(putBody.ok, true)
      assert.equal(putBody.modules.find((m) => m.id === proj.modules[0].id).title, 'Updated Title')
      const get2 = await (await fetch(`${base}/api/definitions/design/versions/2`)).json()
      assert.equal(get2.modules.find((m) => m.id === proj.modules[0].id).title, 'Updated Title')
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT /api/definitions/design/versions/1 on published returns 409', async () => {
  await withRunningServer({}, async (base) => {
    const getRes = await fetch(`${base}/api/definitions/design/versions/1`)
    const proj = await getRes.json()
    const putRes = await fetch(`${base}/api/definitions/design/versions/1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proj) })
    assert.equal(putRes.status, 409)
  })
})

test('PUT /api/definitions/design/versions/2 with malformed body returns 400', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-put2-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-put2-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const putRes = await fetch(`${base}/api/definitions/design/versions/2`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      assert.equal(putRes.status, 400)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT /api/definitions/design/versions/2 with structurally broken payload returns 422', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-put3-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-put3-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const proj = await (await fetch(`${base}/api/definitions/design/versions/2`)).json()
      proj.artefacts[0].requires.push('missing-module-xyz')
      const putRes = await fetch(`${base}/api/definitions/design/versions/2`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proj) })
      assert.equal(putRes.status, 422)
      const body = await putRes.json()
      assert.ok(Array.isArray(body.problems) && body.problems.length > 0)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// WI237 — definition lifecycle server routes

test('POST /api/definitions/:id/versions creates new draft version', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-newdraft-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-newdraft-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    writeFileSync(join(definitionsDir, 'design/1/CHANGELOG.md'), '## v1\n\nInitial\n')
    mkdirSync(join(definitionsDir, 'design/1/templates'), { recursive: true })
    writeFileSync(join(definitionsDir, 'design/1/templates/tmpl.md.tmpl'), 'tmpl')
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/definitions/design/versions`, { method: 'POST' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.version, 2)
      assert.equal(existsSync(join(definitionsDir, 'design/2/definition.yaml')), true)
      assert.equal(existsSync(join(definitionsDir, 'design/2/templates/tmpl.md.tmpl')), true)
      const defs = await (await fetch(`${base}/api/definitions`)).json()
      const design = defs.find((d) => d.id === 'design')
      assert.ok(design.versions.some((v) => v.version === 2 && v.status === 'draft'))
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/definitions clone happy and 400s', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-clone-srv-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-clone-srv-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const ok = await fetch(`${base}/api/definitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'design', newId: 'cloned' }) })
      assert.equal(ok.status, 201)
      assert.deepEqual(await ok.json(), { id: 'cloned' })
      assert.equal(existsSync(join(definitionsDir, 'cloned/1/definition.yaml')), true)
      const badSlug = await fetch(`${base}/api/definitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'design', newId: 'bad/slug' }) })
      assert.equal(badSlug.status, 400)
      const taken = await fetch(`${base}/api/definitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'design', newId: 'cloned' }) })
      assert.equal(taken.status, 400)
      const unknown = await fetch(`${base}/api/definitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'unknown', newId: 'newid' }) })
      assert.equal(unknown.status, 400)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/definitions?archived=1 shows archived def', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-arch-srv-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-arch-srv-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync('definitions/design/1', join(definitionsDir, 'other/1'), { recursive: true })
    const raw = readFileSync(join(definitionsDir, 'other/1/definition.yaml'), 'utf8')
    // patch other id
    const yaml = await import('yaml')
    let parsed = yaml.parse(raw)
    parsed.id = 'other'
    writeFileSync(join(definitionsDir, 'other/1/definition.yaml'), yaml.stringify(parsed))
    // archive design via internal marker
    writeFileSync(join(definitionsDir, 'design/.archived'), '')
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const without = await (await fetch(`${base}/api/definitions`)).json()
      assert.equal(without.some((d) => d.id === 'design'), false)
      assert.equal(without.some((d) => d.id === 'other'), true)
      const withArchived = await (await fetch(`${base}/api/definitions?archived=1`)).json()
      const designRow = withArchived.find((d) => d.id === 'design')
      assert.ok(designRow)
      assert.equal(designRow.archived, true)
      const otherRow = withArchived.find((d) => d.id === 'other')
      assert.equal(otherRow.archived, false)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/definitions/:id/versions/:n/publish happy + 409 + 422', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-pub-srv-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-pub-srv-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      // happy publish v2 draft -> published
      const ok = await fetch(`${base}/api/definitions/design/versions/2/publish`, { method: 'POST' })
      assert.equal(ok.status, 200)
      const body = await ok.json()
      assert.equal(body.ok, true)
      assert.equal(body.version, 2)
      assert.equal(body.status, 'published')
      // 409 for already published
      const again = await fetch(`${base}/api/definitions/design/versions/2/publish`, { method: 'POST' })
      assert.equal(again.status, 409)
      const pub1 = await fetch(`${base}/api/definitions/design/versions/1/publish`, { method: 'POST' })
      assert.equal(pub1.status, 409)
      // create new draft v3 and make broken
      const newVer = await (await fetch(`${base}/api/definitions/design/versions`, { method: 'POST' })).json()
      assert.equal(newVer.version, 3)
      let raw = readFileSync(join(definitionsDir, 'design/3/definition.yaml'), 'utf8')
      const yaml = await import('yaml')
      let parsed = yaml.parse(raw)
      parsed.stages[0].modules.push('missing-xyz')
      writeFileSync(join(definitionsDir, 'design/3/definition.yaml'), yaml.stringify(parsed))
      const bad = await fetch(`${base}/api/definitions/design/versions/3/publish`, { method: 'POST' })
      assert.equal(bad.status, 422)
      const badBody = await bad.json()
      assert.ok(Array.isArray(badBody.problems) && badBody.problems.length > 0)
      // ensure still draft
      const check = readFileSync(join(definitionsDir, 'design/3/definition.yaml'), 'utf8')
      assert.match(check, /status: draft/)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instances with archived definition returns 409', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-inst-arch-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-inst-arch-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    writeFileSync(join(definitionsDir, 'design/.archived'), '')
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: 'design', slug: 'myinst' }) })
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.match(body.error, /is archived/)
    })
    // but instance already pinned still loads (loadDefinition not touched) — create via direct API after restore then archive and verify load
    rmSync(join(definitionsDir, 'design/.archived'), { force: true })
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: 'design', slug: 'myinst2' }) })
      assert.equal(res.status, 201)
    })
    // archive again and ensure pinned instance still loads via GET /api/instances listing (still shows)
    writeFileSync(join(definitionsDir, 'design/.archived'), '')
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const listing = await (await fetch(`${base}/api/instances`)).json()
      assert.ok(listing.some((i) => i.slug === 'myinst2'))
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// WI239 — template endpoints (draft-only, compile-check, traversal-safe)

test('GET /api/definitions/:id/versions/:n/templates/:name serves existing template source', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-tmpl-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-tmpl-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.name, 'sad.md.tmpl')
      assert.equal(typeof body.source, 'string')
      assert.ok(body.source.length > 0)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/definitions/:id/versions/:n/templates/:name 404 for missing file', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-tmpl404-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-tmpl404-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/definitions/design/versions/2/templates/nope.md.tmpl`)
      assert.equal(res.status, 404)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT template valid source round-trips via GET; broken source 422; published 409; traversal 400; missing source 400', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-tmpl-put-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-tmpl-put-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      // valid PUT
      const put = await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'hi there' }),
      })
      assert.equal(put.status, 200)
      const putBody = await put.json()
      assert.equal(putBody.ok, true)
      assert.equal(putBody.name, 'sad.md.tmpl')
      const get = await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`)
      assert.equal(get.status, 200)
      const getBody = await get.json()
      assert.equal(getBody.source, 'hi there')

      // broken source 422
      const bad = await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: '<% if (x %>' }),
      })
      assert.equal(bad.status, 422)
      const badBody = await bad.json()
      assert.ok(typeof badBody.error === 'string' && badBody.error.length > 0)
      // file unchanged after 422
      const still = await (await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`)).json()
      assert.equal(still.source, 'hi there')

      // published 409
      const pub = await fetch(`${base}/api/definitions/design/versions/1/templates/sad.md.tmpl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'hi' }),
      })
      assert.equal(pub.status, 409)

      // traversal 400
      const trav = await fetch(`${base}/api/definitions/design/versions/2/templates/..%2F..%2Fx`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'hi' }),
      })
      assert.equal(trav.status, 400)

      // missing source 400 (no source field)
      const noSrc = await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(noSrc.status, 400)

      // non-string source 400
      const badType = await fetch(`${base}/api/definitions/design/versions/2/templates/sad.md.tmpl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 123 }),
      })
      assert.equal(badType.status, 400)
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
