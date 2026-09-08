import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MarkdownIt from 'markdown-it'
import { createInstance } from '../lib/instance.js'
import { assetCitation, createAsset, resolveAssetFileRefs } from '../lib/assets.js'
import { isLocalAssetSource, resolveAssetRefs } from '../web/lib/assetRefs.js'
import { withRunningServer } from './helpers/lifecycle.js'

// A minimal real 1x1 red PNG, base64-encoded — small enough to inline, real enough to round-trip through the same file-write/serve path a genuine upload takes.
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const markdown = new MarkdownIt()

test('live asset citations render their source URL as a link while keeping the citation italic', () => {
  const source = 'https://draw.io/diagrams/eligibility-flow-(v2)?section=a]b'
  const resolved = resolveAssetRefs(
    '![Eligibility flow](asset:asset-1)',
    (id) => `/api/assets/${id}.png`,
    () => source
  )

  assert.equal(
    resolved,
    `![Eligibility flow](/api/assets/asset-1.png)\n\n*Source: [${source.replaceAll(']', '\\]')}](<${source}>)*`
  )
  assert.ok(
    markdown.render(resolved).includes(`<p><em>Source: <a href="${encodeURI(source)}">${source}</a></em></p>`)
  )
})

test('file asset citations render their source URL as a link while keeping the citation italic', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const asset = createAsset(
      'my-initiative',
      {
        filename: 'eligibility-flow.png',
        buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
        name: 'Eligibility flow',
        source: 'https://draw.io/diagrams/eligibility-flow-(v2)?section=a]b',
      },
      { instancesDir }
    )
    const resolved = resolveAssetFileRefs(
      `![Eligibility flow](asset:${asset.id})`,
      'my-initiative',
      { instancesDir }
    )

    assert.ok(
      resolved.endsWith(
        `\n\n*Source: [${asset.source.replaceAll(']', '\\]')}](<${asset.source}>)*`
      )
    )
    assert.ok(
      markdown.render(resolved).includes(
        `<p><em>Source: <a href="${encodeURI(asset.source)}">${asset.source}</a></em></p>`
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})


// WI #348: a manifest `source` that is a relative path is a *local* source — the image's own copy stored within the instance. Its citation links to that copy relative to the render output dir (`out/`), so a zip-release install opens the local file; the live preview labels it the same way but links to the served file.
test('live asset citations with a local source label the stored path and link to the resolved href', () => {
  const resolved = resolveAssetRefs(
    '![Layered viewpoint](asset:kcm-layered-viewpoint)',
    (id) => `/api/instance/assets/${id}/file`,
    (id) => ({ label: `assets/${id}.png`, href: `/api/instance/assets/${id}/file` })
  )
  assert.equal(
    resolved,
    '![Layered viewpoint](/api/instance/assets/kcm-layered-viewpoint/file)\n\n*Source: [assets/kcm-layered-viewpoint.png](</api/instance/assets/kcm-layered-viewpoint/file>)*'
  )
  assert.ok(isLocalAssetSource('assets/kcm-layered-viewpoint.png'))
  assert.ok(!isLocalAssetSource('https://draw.io/diagrams/x'))
  assert.ok(!isLocalAssetSource(''))
})

test('file asset citations with a local source link to the stored copy relative to the render output dir', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    // createAsset() refuses a non-http(s) source by design (UI uploads must cite an originating URL) — a local source is only ever a hand-written manifest entry, so write one directly, the way the bundled `examples` fixture does.
    const assetsDir = join(instancesDir, 'my-initiative', 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, 'kcm-layered-viewpoint.png'), Buffer.from(ONE_PX_PNG_BASE64, 'base64'))
    writeFileSync(
      join(assetsDir, 'manifest.yaml'),
      '- id: kcm-layered-viewpoint\n  filename: kcm-layered-viewpoint.png\n  name: Layered viewpoint\n  source: assets/kcm-layered-viewpoint.png\n'
    )
    const resolved = resolveAssetFileRefs('![Layered viewpoint](asset:kcm-layered-viewpoint)', 'my-initiative', { instancesDir })
    assert.ok(resolved.startsWith(`![Layered viewpoint](${join(assetsDir, 'kcm-layered-viewpoint.png')})`))
    assert.ok(resolved.endsWith('\n\n*Source: [assets/kcm-layered-viewpoint.png](<../assets/kcm-layered-viewpoint.png>)*'))
    assert.ok(markdown.render(resolved).includes('<p><em>Source: <a href="../assets/kcm-layered-viewpoint.png">assets/kcm-layered-viewpoint.png</a></em></p>'))
    assert.deepEqual(assetCitation({ filename: 'x.png', source: 'https://example.test/x' }), { label: 'https://example.test/x', href: 'https://example.test/x' })
    assert.equal(assetCitation({ filename: 'x.png', source: '' }), null)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the bundled examples fixture cites every diagram by its local copy', () => {
  const manifest = readFileSync('instances/examples/assets/manifest.yaml', 'utf8')
  const ids = [...manifest.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1])
  assert.equal(ids.length, 9, 'nine SAD-template diagrams are shipped with the examples instance')
  for (const id of ids) {
    assert.match(manifest, new RegExp(`  source: assets/${id}\\.(png|jpeg)\\n`), `${id} cites its stored copy`)
  }
  const modules = readdirSync('instances/examples/modules').map((f) => readFileSync(join('instances/examples/modules', f), 'utf8')).join('\n')
  for (const id of ids) assert.ok(modules.includes(`(asset:${id})`), `${id} is referenced from a module field`)
})

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

// WI #304: `GET /api/instance/assets` for a slug the server has no
// server-side record of at all — a local-workspace instance's shape
// (ADR-0029: no `instancesDir` entry, no Azure DevOps registry entry) — must
// return a clean 400, not a 500. A local-workspace instance's assets are
// served entirely client-side (web/app.js's fetchAssets); this route should
// never be reached for one, but this guard is defense-in-depth for whatever
// path still reaches it.
test('GET /api/instance/assets returns a clean 400 (not a 500) for a slug the server has no record of', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/assets?slug=some-local-workspace-slug`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /has no server-side record/)
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
      const putRes = await fetch(`${base}/api/instance/modules/background`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'agreed',
          owner: 'c.barlow',
          fields: {
            problem: `Some narrative.\n\n![Eligibility flow](asset:${created.id})\n`,
            'affected-domains': ['Payments'],
            opportunity: '',
          },
        }),
      })
      assert.equal(putRes.status, 200)

      const listRes = await fetch(`${base}/api/instance/assets`)
      const list = await listRes.json()
      const asset = list.find((a) => a.id === created.id)
      assert.deepEqual(asset.usedIn, ['Background and context'])
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('assets routes work with ?slug= on a server started without a default slug (#143)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'no-default-slug', { instancesDir })
    // Server started with NO default slug — every request must carry ?slug=.
    await withRunningServer({ instancesDir }, async (base) => {
      const slug = encodeURIComponent('no-default-slug')

      // Without ?slug= the server must reject the request with a clear error.
      const noSlugRes = await fetch(`${base}/api/instance/assets`)
      assert.equal(noSlugRes.status, 400)
      const noSlugBody = await noSlugRes.json()
      assert.match(noSlugBody.error, /No instance slug given/)

      // GET /api/instance/assets?slug=... must list (empty) successfully.
      const listRes = await fetch(`${base}/api/instance/assets?slug=${slug}`)
      assert.equal(listRes.status, 200)
      assert.deepEqual(await listRes.json(), [])

      // POST /api/instance/assets?slug=... must upload successfully.
      const uploadRes = await fetch(`${base}/api/instance/assets?slug=${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'flow.png',
          dataBase64: ONE_PX_PNG_BASE64,
          name: 'Flow diagram',
          source: 'https://draw.io/diagrams/flow',
        }),
      })
      assert.equal(uploadRes.status, 201)
      const created = await uploadRes.json()
      assert.ok(created.id)

      // GET /api/instance/assets?slug=... must now return the uploaded asset.
      const listAfter = await fetch(`${base}/api/instance/assets?slug=${slug}`)
      const list = await listAfter.json()
      assert.equal(list.length, 1)
      assert.equal(list[0].id, created.id)

      // GET /api/instance/assets/:id/file?slug=... must serve the file bytes.
      const fileRes = await fetch(`${base}/api/instance/assets/${created.id}/file?slug=${slug}`)
      assert.equal(fileRes.status, 200)
      assert.equal(fileRes.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await fileRes.arrayBuffer())
      assert.deepEqual(bytes, Buffer.from(ONE_PX_PNG_BASE64, 'base64'))

      // Without ?slug=, the file route must also reject.
      const noSlugFile = await fetch(`${base}/api/instance/assets/${created.id}/file`)
      assert.equal(noSlugFile.status, 400)
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
