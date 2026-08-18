import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createServer } from '../lib/server.js'
import { readInstance, readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

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

test('GET /api/instance reports the example-soap fixture, fully populated', async () => {
  await withRunningServer({ slug: 'example-soap' }, async (base) => {
    const res = await fetch(`${base}/api/instance`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.slug, 'example-soap')
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

test('PUT /api/instance/modules/:id writes the same file format the CLI reads, and returns updated status', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/example-soap', join(instancesDir, 'example-soap'), { recursive: true })
    // out/ isn't part of the module-file contract this endpoint touches, but drop it
    // so the scratch copy mirrors a fresh instance rather than a previously-rendered one.
    rmSync(join(instancesDir, 'example-soap', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'example-soap', instancesDir }, async (base) => {
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
    const data = readModule(definition, 'example-soap', 'context', { instancesDir })
    assert.equal(data.status, 'agreed')
    assert.equal(data.fields.driver, 'Updated via the web form.')
    assert.deepEqual(data.fields['affected-domains'], ['Payments'])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/render/:artefact renders a real docx via the web form path', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/example-soap', join(instancesDir, 'example-soap'), { recursive: true })
    rmSync(join(instancesDir, 'example-soap', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'example-soap', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/render/soap`, { method: 'POST' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.artefact, 'soap')
      assert.match(body.docxPath, /out[/\\]soap\.docx$/)
      // Absolute, not relative to wherever `gantry serve` happened to be
      // launched from — the browser has no way to resolve a relative path.
      assert.equal(isAbsolute(body.docxPath), true)
      assert.ok(existsSync(body.docxPath))
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET / serves index.html with the import map resolved (no leftover placeholder)', async () => {
  await withRunningServer({ slug: 'example-soap' }, async (base) => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.doesNotMatch(html, /__IMPORT_MAP__/)
    assert.match(html, /"codemirror":\s*"\/node_modules\/codemirror\/dist\/index\.js"/)
  })
})

test('GET /node_modules/... serves real dependency files for the browser to import', async () => {
  await withRunningServer({ slug: 'example-soap' }, async (base) => {
    const res = await fetch(`${base}/node_modules/codemirror/dist/index.js`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /basicSetup/)
  })
})

test('GET /app.js serves the web form script from web/', async () => {
  await withRunningServer({ slug: 'example-soap' }, async (base) => {
    const res = await fetch(`${base}/app.js`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /from 'codemirror'/)
  })
})
