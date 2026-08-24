import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'

// A minimal real 1x1 red PNG, base64-encoded — small enough to inline, real enough to round-trip through the same file-write/serve path a genuine upload takes.
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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

test('GET /api/instance/assets is empty for a freshly-created instance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), [])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/assets without a source location is rejected with a clear error, nothing written', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'diagram.png', dataBase64: ONE_PX_PNG_BASE64, source: '' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /[Ss]ource location is required/)

      const listRes = await fetch(`${base}/api/instance/assets`)
      assert.deepEqual(await listRes.json(), [])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/assets with a non-URL source location is rejected', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'diagram.png', dataBase64: ONE_PX_PNG_BASE64, source: 'not-a-url' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /valid URL/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/assets without a file is rejected even when a source is given', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'https://draw.io/diagrams/eligibility-flow' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /image file is required/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/assets rejects an unsupported file type', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'diagram.svg',
          dataBase64: ONE_PX_PNG_BASE64,
          source: 'https://draw.io/diagrams/eligibility-flow',
        }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /Unsupported image file type/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/assets registers a real asset, stored under the instance\'s assets/ directory alongside modules/', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    let created
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'eligibility-flow.png',
          dataBase64: ONE_PX_PNG_BASE64,
          name: 'Eligibility flow',
          source: 'https://draw.io/diagrams/eligibility-flow',
          uploadedBy: 'c.barlow',
        }),
      })
      assert.equal(res.status, 201)
      created = await res.json()
      assert.equal(created.name, 'Eligibility flow')
      assert.equal(created.source, 'https://draw.io/diagrams/eligibility-flow')
      assert.equal(created.uploadedBy, 'c.barlow')
      assert.ok(created.id)

      const listRes = await fetch(`${base}/api/instance/assets`)
      const list = await listRes.json()
      assert.equal(list.length, 1)
      assert.equal(list[0].id, created.id)
      assert.deepEqual(list[0].usedIn, [])

      const fileRes = await fetch(`${base}/api/instance/assets/${created.id}/file`)
      assert.equal(fileRes.status, 200)
      assert.equal(fileRes.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await fileRes.arrayBuffer())
      assert.deepEqual(bytes, Buffer.from(ONE_PX_PNG_BASE64, 'base64'))
    })

    // Sits in assets/ alongside — not nested inside — modules/.
    const onDisk = readFileSync(join(instancesDir, 'my-initiative', 'assets', created.filename))
    assert.deepEqual(onDisk, Buffer.from(ONE_PX_PNG_BASE64, 'base64'))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance/assets/:id/file 404s for an unknown asset id', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets/does-not-exist/file`)
      assert.equal(res.status, 404)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('an asset referenced via the asset:<id> convention from a module\'s markdown is reported USED IN that module', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    let created
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const uploadRes = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'eligibility-flow.png',
          dataBase64: ONE_PX_PNG_BASE64,
          name: 'Eligibility flow',
          source: 'https://draw.io/diagrams/eligibility-flow',
        }),
      })
      created = await uploadRes.json()

      // Hand-typing the reference convention directly into a module's markdown (rather than going through the insert modal) must be picked up by the usage computation identically.
      const putRes = await fetch(`${base}/api/instance/modules/context`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'agreed',
          owner: 'c.barlow',
          fields: {
            driver: `Some narrative.\n\n![Eligibility flow](asset:${created.id})\n`,
            'affected-domains': ['Payments'],
            'out-of-scope': '',
          },
        }),
      })
      assert.equal(putRes.status, 200)

      const listRes = await fetch(`${base}/api/instance/assets`)
      const list = await listRes.json()
      const asset = list.find((a) => a.id === created.id)
      assert.deepEqual(asset.usedIn, ['Context'])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('an asset with no markdown referencing it anywhere is reported as unused (empty usedIn)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const uploadRes = await fetch(`${base}/api/instance/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'org-chart.png',
          dataBase64: ONE_PX_PNG_BASE64,
          source: 'https://draw.io/diagrams/org-chart',
        }),
      })
      const created = await uploadRes.json()

      const listRes = await fetch(`${base}/api/instance/assets`)
      const list = await listRes.json()
      const asset = list.find((a) => a.id === created.id)
      assert.deepEqual(asset.usedIn, [])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
