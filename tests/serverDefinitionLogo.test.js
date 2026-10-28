import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHeaderLogo } from '../web/lib/definitionLogo.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { pngImage } from './helpers/logoImages.js'

// #222 (docs/adr/0059): the Definitions page's Logo control over HTTP —
// GET /api/definitions/:id/versions/:n/logo (the current logo and which reference documents have
// one), GET …/logo/image (its bytes, for the preview and Download) and PUT …/logo (Replace, a
// PNG or JPEG as `imageBase64`, draft only). Over a scratch copy of the bundled `design`
// Definition, whose v3 is a draft and v1/v2 are published.

const CONTOSO = Buffer.from((await readHeaderLogo(readFileSync('definitions/design/3/templates/reference.docx'))).bytes)
const PLAIN_REFERENCE_DOCX = execFileSync('pandoc', ['--print-default-data-file', 'reference.docx'], { maxBuffer: 1 << 26 })

async function withDesign(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-logo-api-defs-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-logo-api-instances-'))
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, definitionsDir))
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const templatesOf = (definitionsDir, version) => join(definitionsDir, 'design', String(version), 'templates')
const referenceDocs = (dir) => readdirSync(dir).filter((f) => f.endsWith('.docx')).sort()
const putLogo = (base, version, bytes) =>
  fetch(`${base}/api/definitions/design/versions/${version}/logo`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageBase64: Buffer.from(bytes).toString('base64') }) })

test('GET …/logo names the current logo and every reference document; GET …/logo/image downloads it', async () => {
  await withDesign(async (base) => {
    for (const version of [2, 3]) {
      const res = await fetch(`${base}/api/definitions/design/versions/${version}/logo`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body.logo, { contentType: 'image/png', document: 'reference.docx' })
      assert.equal(body.documents.length, 7)
      assert.ok(body.documents.every((d) => d.hasLogo))

      const image = await fetch(`${base}/api/definitions/design/versions/${version}/logo/image`)
      assert.equal(image.status, 200)
      assert.equal(image.headers.get('content-type'), 'image/png')
      assert.match(image.headers.get('content-disposition'), /attachment; filename="logo\.png"/)
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), CONTOSO, `v${version} shows the Contoso logo`)
    }
  })
})

test('PUT …/logo on a draft replaces the logo in every reference document, and the next GET shows it', async () => {
  await withDesign(async (base, definitionsDir) => {
    const logo = pngImage(80, 40)
    const res = await putLogo(base, 3, logo)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.updated.sort(), referenceDocs(templatesOf(definitionsDir, 3)))
    assert.deepEqual(body.withoutLogo, [])
    for (const file of referenceDocs(templatesOf(definitionsDir, 3))) {
      const found = await readHeaderLogo(readFileSync(join(templatesOf(definitionsDir, 3), file)))
      assert.deepEqual(Buffer.from(found.bytes), logo, file)
    }
    const image = await fetch(`${base}/api/definitions/design/versions/3/logo/image`)
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), logo)
  })
})

test('PUT …/logo refuses a published version (409) and an upload that isn\'t a PNG or JPEG (422), changing nothing', async () => {
  await withDesign(async (base, definitionsDir) => {
    const before = (version) => referenceDocs(templatesOf(definitionsDir, version)).map((f) => readFileSync(join(templatesOf(definitionsDir, version), f)))
    const v2 = before(2)
    const v3 = before(3)

    const published = await putLogo(base, 2, pngImage(10, 10))
    assert.equal(published.status, 409)
    assert.match((await published.json()).error, /not a draft/)

    const notImage = await putLogo(base, 3, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    assert.equal(notImage.status, 422)
    assert.equal((await notImage.json()).error, 'The logo must be a PNG or JPEG image.')

    const noBody = await fetch(`${base}/api/definitions/design/versions/3/logo`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(noBody.status, 400)

    assert.deepEqual(before(2), v2)
    assert.deepEqual(before(3), v3)
  })
})

test('a reference document with no logo in its header is reported and left as it is', async () => {
  await withDesign(async (base, definitionsDir) => {
    const plainPath = join(templatesOf(definitionsDir, 3), 'reference-plain.docx')
    writeFileSync(plainPath, PLAIN_REFERENCE_DOCX)
    const summary = await (await fetch(`${base}/api/definitions/design/versions/3/logo`)).json()
    assert.deepEqual(summary.documents.find((d) => d.name === 'reference-plain.docx'), { name: 'reference-plain.docx', hasLogo: false })

    const body = await (await putLogo(base, 3, pngImage(10, 10))).json()
    assert.deepEqual(body.withoutLogo, ['reference-plain.docx'])
    assert.equal(body.updated.length, 7)
    assert.deepEqual(readFileSync(plainPath), PLAIN_REFERENCE_DOCX)
  })
})

test('a reference document uploaded under Reference docx afterwards keeps its own logo', async () => {
  await withDesign(async (base, definitionsDir) => {
    const logo = pngImage(10, 10)
    await putLogo(base, 3, logo)
    const original = readFileSync('definitions/design/3/templates/reference-sad.docx')
    const uploaded = await fetch(`${base}/api/definitions/design/versions/3/artefacts/sad/reference-docx`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docxBase64: original.toString('base64') }),
    })
    assert.equal(uploaded.status, 200)
    assert.deepEqual(Buffer.from((await readHeaderLogo(readFileSync(join(templatesOf(definitionsDir, 3), 'reference-sad.docx')))).bytes), CONTOSO, 'the uploaded document wins')
    assert.deepEqual(Buffer.from((await readHeaderLogo(readFileSync(join(templatesOf(definitionsDir, 3), 'reference-hld.docx')))).bytes), logo, 'the others keep the replaced logo')
  })
})

test('an unknown definition or a bad version is refused', async () => {
  await withDesign(async (base) => {
    assert.equal((await fetch(`${base}/api/definitions/no-such/versions/1/logo`)).status, 400)
    assert.equal((await fetch(`${base}/api/definitions/design/versions/zero/logo`)).status, 400)
    assert.equal((await fetch(`${base}/api/definitions/design/versions/9/logo`)).status, 404)
  })
})
