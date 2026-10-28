import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDefinitionLogo, writeDefinitionLogo } from '../lib/definition.js'
import { renderArtefact } from '../lib/render.js'
import { LOGO_ALT_TEXT, logoImageInfo, readHeaderLogo, replaceHeaderLogo } from '../web/lib/definitionLogo.js'
import { docxPart } from './helpers/wordDocx.js'
import { jpegImage, pngImage } from './helpers/logoImages.js'

// #222 (docs/adr/0059): a Definition's logo is the picture in its reference documents' page header.
// The Logo control on the Definitions page replaces it in every reference document of a draft at
// once, fitting the new image at its own proportions into the space the old one took up, and
// naming it as the organisation's logo in its alt text. These cover the shared module
// (web/lib/definitionLogo.js), lib/definition.js's read/write over a Definition's templates/, and a
// native render afterwards; tests/serverDefinitionLogo.test.js covers the API and
// tests/definitionLogo.playwright.test.js the control itself and the browser's pandoc-wasm render.

const V3_TEMPLATES = join('definitions', 'design', '3', 'templates')
const V3_REFERENCE_DOCS = readdirSync(V3_TEMPLATES).filter((f) => /^reference(-[\w-]+)?\.docx$/.test(f)).sort()
const SHARED = readFileSync(join(V3_TEMPLATES, 'reference.docx'))
// The Contoso logo's box in design v3's header (word/header2.xml), in EMUs.
const CONTOSO_BOX = { cx: 1084569, cy: 418011 }

function zipEntryBytes(docx, part) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-logo-part-'))
  try {
    const path = join(dir, 'doc.docx')
    writeFileSync(path, docx)
    return execFileSync('unzip', ['-p', path, part], { maxBuffer: 1 << 26 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The page header's picture as a reader of the .docx sees it, read with `unzip` rather than the
// module under test: its alt text, its rendered size and the image it shows. A rendered document's
// header parts may be named differently from the reference document's, so every header is looked at.
function pictureOf(docx) {
  for (const part of zipEntryNames(docx).filter((name) => /^word\/header\d*\.xml$/.test(name)).sort()) {
    const headerXml = docxPart(docx, part)
    const drawing = [...headerXml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)].map(([xml]) => xml).find((xml) => xml.includes('<pic:pic'))
    if (drawing) return describePicture(docx, part, headerXml, drawing)
  }
  return null
}

function describePicture(docx, part, headerXml, drawing) {
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(drawing)
  const xfrmExt = /<pic:spPr>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(drawing)
  const rId = /r:embed="([^"]+)"/.exec(drawing)[1]
  const relsPart = part.replace(/^word\//, 'word/_rels/') + '.rels'
  const rel = [...docxPart(docx, relsPart).matchAll(/<Relationship [^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`Id="${rId}"`))
  const media = `word/${/Target="([^"]+)"/.exec(rel)[1]}`
  return {
    headerXml,
    descr: /<wp:docPr [^>]*descr="([^"]*)"/.exec(drawing)?.[1],
    picDescr: /<pic:cNvPr [^>]*descr="([^"]*)"/.exec(drawing)?.[1],
    extent: { cx: Number(extent[1]), cy: Number(extent[2]) },
    xfrm: { cx: Number(xfrmExt[1]), cy: Number(xfrmExt[2]) },
    media,
    image: zipEntryBytes(docx, media),
  }
}

function zipEntryNames(docx) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-logo-list-'))
  try {
    const path = join(dir, 'doc.docx')
    writeFileSync(path, docx)
    return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-logo-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withScratchDesign(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-logo-defs-'))
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    return await fn(definitionsDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

// `docx` unpacked, changed by `edit(dir)` and packed again with `zip`: for a reference document
// shaped in a way design v3's aren't.
function repackDocx(docx, edit) {
  return withScratchDir((dir) => {
    const parts = join(dir, 'parts')
    writeFileSync(join(dir, 'in.docx'), docx)
    execFileSync('unzip', ['-q', join(dir, 'in.docx'), '-d', parts])
    edit(parts)
    execFileSync('zip', ['-q', '-X', '-r', join(dir, 'out.docx'), '.'], { cwd: parts })
    return readFileSync(join(dir, 'out.docx'))
  })
}

const editFile = (path, change) => writeFileSync(path, change(readFileSync(path, 'utf8')))

// A reference document with no picture in its header: Pandoc's own default.
const PLAIN_REFERENCE_DOCX = execFileSync('pandoc', ['--print-default-data-file', 'reference.docx'], { maxBuffer: 1 << 26 })

describe('design v3 ships the Contoso logo (#222)', () => {
  test('every v3 reference document shows the Contoso logo in its page header', async () => {
    assert.equal(V3_REFERENCE_DOCS.length, 7)
    for (const file of V3_REFERENCE_DOCS) {
      const docx = readFileSync(join(V3_TEMPLATES, file))
      const picture = pictureOf(docx)
      assert.equal(picture.descr, 'Contoso logo', file)
      assert.deepEqual(picture.extent, CONTOSO_BOX, file)
      const logo = await readHeaderLogo(docx)
      assert.equal(logo.contentType, 'image/png', file)
      assert.deepEqual(Buffer.from(logo.bytes), picture.image, `${file}: the logo read is the header's picture`)
    }
  })
})

describe('the logo an upload is (#222)', () => {
  test('a PNG or JPEG is read by its bytes, with its size', () => {
    assert.deepEqual(logoImageInfo(pngImage(30, 10)), { contentType: 'image/png', extension: 'png', width: 30, height: 10 })
    assert.deepEqual(logoImageInfo(jpegImage(640, 480)), { contentType: 'image/jpeg', extension: 'jpeg', width: 640, height: 480 })
  })

  test('anything else is not a logo, whatever it is called', () => {
    assert.equal(logoImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
    assert.equal(logoImageInfo(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;')), null)
    assert.equal(logoImageInfo(SHARED), null, 'a .docx is not an image')
    assert.equal(logoImageInfo(Buffer.alloc(0)), null)
  })
})

describe('replacing the header logo in one reference document (#222)', () => {
  test('a square logo keeps its proportions inside the Contoso logo\'s space, and its alt text names the organisation\'s logo', async () => {
    const square = pngImage(100, 100)
    const { docx, replaced } = await replaceHeaderLogo(SHARED, square)
    assert.equal(replaced, 1)
    const picture = pictureOf(Buffer.from(docx))
    assert.deepEqual(picture.image, square, 'the header shows the new image')
    assert.deepEqual(picture.extent, { cx: CONTOSO_BOX.cy, cy: CONTOSO_BOX.cy }, 'as tall as the old one, and as wide as it is tall')
    assert.deepEqual(picture.xfrm, picture.extent, 'the picture\'s own size matches its frame')
    assert.equal(picture.descr, LOGO_ALT_TEXT)
    assert.equal(picture.picDescr, LOGO_ALT_TEXT)
    assert.doesNotMatch(picture.headerXml, /Contoso/i, 'nothing in the header names Contoso any more')
    assert.ok(!zipEntryNames(Buffer.from(docx)).includes('word/media/image1.png'), 'the Contoso image is gone from the package')
  })

  test('a wide logo fills the width and is shorter; replacing it again fits the next one to the original space', async () => {
    const square = (await replaceHeaderLogo(SHARED, pngImage(100, 100))).docx
    const wide = pngImage(400, 100)
    const { docx } = await replaceHeaderLogo(square, wide)
    const picture = pictureOf(Buffer.from(docx))
    assert.deepEqual(picture.image, wide)
    assert.deepEqual(picture.extent, { cx: CONTOSO_BOX.cx, cy: Math.round((100 * CONTOSO_BOX.cx) / 400) }, 'the whole width of the original space, not the square one\'s')
    assert.ok(picture.extent.cy <= CONTOSO_BOX.cy)
  })

  test('a JPEG logo is stored as a JPEG the package declares', async () => {
    const jpeg = jpegImage(200, 200)
    const { docx } = await replaceHeaderLogo(SHARED, jpeg)
    const picture = pictureOf(Buffer.from(docx))
    assert.match(picture.media, /\.jpeg$/)
    assert.deepEqual(picture.image, jpeg)
    assert.match(docxPart(Buffer.from(docx), '\\[Content_Types\\].xml'), /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/)
  })

  test('the old logo\'s image part is dropped, and so is any content type the package declared for it alone', async () => {
    const declared = repackDocx(SHARED, (dir) => {
      editFile(join(dir, '[Content_Types].xml'), (xml) => xml.replace('</Types>', '<Override PartName="/word/media/image1.png" ContentType="image/png"/></Types>'))
    })
    const out = Buffer.from((await replaceHeaderLogo(declared, pngImage(100, 100))).docx)
    assert.ok(!zipEntryNames(out).includes('word/media/image1.png'), 'the Contoso image is gone')
    const contentTypes = docxPart(out, '\\[Content_Types\\].xml')
    assert.doesNotMatch(contentTypes, /\/word\/media\/image1\.png/)
    assert.match(contentTypes, /<Override PartName="\/word\/header2\.xml"/, 'every other declaration is kept')
  })

  test('every other part of the reference document is unchanged', async () => {
    const { docx } = await replaceHeaderLogo(SHARED, pngImage(100, 100))
    const out = Buffer.from(docx)
    for (const part of ['word/styles.xml', 'word/numbering.xml', 'word/document.xml', 'word/header1.xml', 'word/header3.xml', 'word/footer1.xml', 'word/settings.xml']) {
      assert.equal(docxPart(out, part), docxPart(SHARED, part), part)
    }
    // The header keeps its classification field and its decorative shapes.
    assert.match(docxPart(out, 'word/header2.xml'), /STYLEREF "Cover Classification"/)
    assert.match(docxPart(out, 'word/header2.xml'), /name="Group 51"/)
  })

  test('a reference document with no picture in its header is left exactly as it is', async () => {
    const { docx, replaced } = await replaceHeaderLogo(PLAIN_REFERENCE_DOCX, pngImage(100, 100))
    assert.equal(replaced, 0)
    assert.deepEqual(Buffer.from(docx), PLAIN_REFERENCE_DOCX)
    assert.equal(await readHeaderLogo(PLAIN_REFERENCE_DOCX), null)
  })

  test('a header part named otherwise is still found, by the content type the package declares for it', async () => {
    const renamed = repackDocx(SHARED, (dir) => {
      renameSync(join(dir, 'word', 'header2.xml'), join(dir, 'word', 'page-top.xml'))
      renameSync(join(dir, 'word', '_rels', 'header2.xml.rels'), join(dir, 'word', '_rels', 'page-top.xml.rels'))
      editFile(join(dir, '[Content_Types].xml'), (xml) => xml.replace('PartName="/word/header2.xml"', 'PartName="/word/page-top.xml"'))
      editFile(join(dir, 'word', '_rels', 'document.xml.rels'), (xml) => xml.replace('Target="header2.xml"', 'Target="page-top.xml"'))
    })
    assert.ok((await readHeaderLogo(renamed)), 'the logo is read')
    const { docx, replaced } = await replaceHeaderLogo(renamed, pngImage(100, 100))
    assert.equal(replaced, 1)
    assert.match(docxPart(Buffer.from(docx), 'word/page-top.xml'), new RegExp(`descr="${LOGO_ALT_TEXT}"`))
  })

  test('a picture held inside a group shape is not the logo, and is left as it is', async () => {
    const grouped = repackDocx(SHARED, (dir) => {
      editFile(join(dir, 'word', 'header2.xml'), (xml) => xml.replace(
        /<a:graphicData uri="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/picture">(<pic:pic[\s\S]*?<\/pic:pic>)<\/a:graphicData>/,
        '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr/>$1</wpg:wgp></a:graphicData>',
      ))
    })
    assert.equal(await readHeaderLogo(grouped), null)
    const { docx, replaced } = await replaceHeaderLogo(grouped, pngImage(100, 100))
    assert.equal(replaced, 0)
    assert.deepEqual(Buffer.from(docx), grouped)
  })

  test('a file that isn\'t a PNG or JPEG is refused', async () => {
    await assert.rejects(replaceHeaderLogo(SHARED, Buffer.from('not an image')), (err) => err.invalidImage === true && /PNG or JPEG/.test(err.message))
  })
})

describe('a Definition\'s logo across its reference documents (#222)', () => {
  test('reading a version gives the current logo and whether each reference document has one', async () => {
    await withScratchDesign(async (definitionsDir) => {
      const { logo, documents } = await readDefinitionLogo('design', 3, { definitionsDir })
      assert.equal(logo.document, 'reference.docx', 'the shared reference document is read first')
      assert.equal(logo.contentType, 'image/png')
      assert.deepEqual(documents.map((d) => d.name), ['reference.docx', ...V3_REFERENCE_DOCS.filter((f) => f !== 'reference.docx')])
      assert.ok(documents.every((d) => d.hasLogo))
    })
  })

  test('replacing it on a draft writes the new logo into every reference document, the shared one and each Artefact\'s', async () => {
    await withScratchDesign(async (definitionsDir) => {
      const logo = pngImage(120, 60)
      const result = await writeDefinitionLogo('design', 3, logo, { definitionsDir })
      assert.equal(result.updated.length, 7)
      assert.deepEqual(result.withoutLogo, [])
      for (const file of V3_REFERENCE_DOCS) {
        const picture = pictureOf(readFileSync(join(definitionsDir, 'design', '3', 'templates', file)))
        assert.deepEqual(picture.image, logo, file)
        assert.equal(picture.descr, LOGO_ALT_TEXT, file)
      }
      const read = await readDefinitionLogo('design', 3, { definitionsDir })
      assert.deepEqual(Buffer.from(read.logo.bytes), logo)
    })
  })

  test('a reference document without a logo is reported and left unchanged', async () => {
    await withScratchDesign(async (definitionsDir) => {
      const plainPath = join(definitionsDir, 'design', '3', 'templates', 'reference-plain.docx')
      writeFileSync(plainPath, PLAIN_REFERENCE_DOCX)
      assert.deepEqual((await readDefinitionLogo('design', 3, { definitionsDir })).documents.find((d) => d.name === 'reference-plain.docx'), { name: 'reference-plain.docx', hasLogo: false })
      const result = await writeDefinitionLogo('design', 3, pngImage(100, 100), { definitionsDir })
      assert.deepEqual(result.withoutLogo, ['reference-plain.docx'])
      assert.equal(result.updated.length, 7)
      assert.deepEqual(readFileSync(plainPath), PLAIN_REFERENCE_DOCX)
    })
  })

  test('a published version is refused, and so is an upload that isn\'t an image, with nothing written', async () => {
    await withScratchDesign(async (definitionsDir) => {
      await assert.rejects(writeDefinitionLogo('design', 2, pngImage(100, 100), { definitionsDir }), /not a draft/)
      await assert.rejects(writeDefinitionLogo('design', 3, Buffer.from('%PDF-1.4'), { definitionsDir }), (err) => err.invalidImage === true)
      for (const version of [2, 3]) {
        for (const file of V3_REFERENCE_DOCS) {
          assert.deepEqual(readFileSync(join(definitionsDir, 'design', String(version), 'templates', file)), readFileSync(join('definitions', 'design', String(version), 'templates', file)), `v${version} ${file}`)
        }
      }
    })
  })
})

describe('a render after the logo is replaced (#222)', () => {
  test('every v3 Artefact\'s rendered document shows the new logo in its page header', async () => {
    await withScratchDesign(async (definitionsDir) => {
      const logo = pngImage(100, 100)
      await writeDefinitionLogo('design', 3, logo, { definitionsDir })
      withScratchDir((instancesDir) => {
        // The bundled design v3 example has every Module filled in, so every Artefact renders.
        cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'kiwi-cover-mutual'), { recursive: true })
        rmSync(join(instancesDir, 'kiwi-cover-mutual', 'out'), { recursive: true, force: true })
        for (const artefact of ['soap', 'soap-full', 'hld', 'sad', 'ssad', 'as-built']) {
          const { docxBytes } = renderArtefact('kiwi-cover-mutual', artefact, { instancesDir, definitionsDir, deliverToClient: true })
          const picture = pictureOf(docxBytes)
          assert.deepEqual(picture.image, logo, `${artefact}: the header shows the new logo`)
          assert.equal(picture.descr, LOGO_ALT_TEXT, artefact)
          assert.doesNotMatch(picture.headerXml, /Contoso/i, artefact)
        }
      })
    })
  })
})
