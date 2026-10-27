import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { bodyParagraphs, docxPart } from './helpers/wordDocx.js'
import { classificationField, headerVisibleText, sectionHeaders } from './helpers/wordHeaders.js'

// #207 — the browser half of design v3's header classification. The default Render converts in the
// browser with pandoc-wasm (Pandoc 3.10), not the native Pandoc tests/designV3HeaderClassification.test.js
// renders with. pandoc-wasm also copies the reference document's headers as they are, so the
// .docx it produces has the STYLEREF "Cover Classification" field in every page type's header,
// and the cover's Cover Classification paragraph for it to read — an empty-looking one when the
// classification is blank.

const PAGE_TYPES = ['default', 'even', 'first']

// Renders `artefactTitle` of the instance at `instanceDir` (copied into a scratch instances folder
// as `examples`) through the Render dialog, and returns the downloaded .docx.
async function renderInBrowser(prepare, artefactTitle) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-v3-header-e2e-'))
  const instancesDir = join(root, 'instances')
  try {
    prepare(instancesDir)
    let docx
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const context = await browser.newContext({ acceptDownloads: true })
        const page = await context.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const requested = []
        page.on('request', (req) => requested.push(new URL(req.url()).pathname))
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        await page.getByRole('button', { name: 'Render', exact: true }).click()
        const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
        await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await renderDialog.getByRole('button', { name: artefactTitle, exact: true }).click()
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 90_000 }),
          renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click(),
        ])
        // The conversion happened in the browser: only the WASM leg hands its document back through
        // render-wasm-finish (a failed WASM conversion falls back to the native render silently).
        assert.ok(requested.some((p) => p.startsWith('/api/instance/render-wasm-finish/')), `pandoc-wasm did the conversion: ${requested.filter((p) => p.startsWith('/api/')).join(', ')}`)
        docx = readFileSync(await download.path())
      } finally {
        await browser.close()
      }
    })
    return docx
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the browser\'s pandoc-wasm render of the v3 SAD has the classification field in every page type\'s header, and the cover\'s classification for it to read (#207)', async () => {
  const docx = await renderInBrowser((instancesDir) => {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    // The SAD renders at Detailed Design, which the bundled example has passed; open it there.
    const instanceYaml = join(instancesDir, 'examples', 'instance.yaml')
    const atDetailedDesign = readFileSync(instanceYaml, 'utf8').replace(/^stage: .*$/m, 'stage: detailed-design')
    assert.match(atDetailedDesign, /^definitionVersion: 3$/m)
    writeFileSync(instanceYaml, atDetailedDesign)
  }, 'Solution Architecture Document')

  const headers = sectionHeaders(docx)
  assert.deepEqual(headers.map((h) => h.type).sort(), PAGE_TYPES)
  for (const { type, xml } of headers) {
    const field = classificationField(xml)
    assert.ok(field, `the ${type} header has the STYLEREF "Cover Classification" field`)
    assert.equal(field.paragraphStyle, 'HeaderClassification', type)
    assert.equal(field.result, '', type)
    assert.equal(headerVisibleText(xml).trim(), '', type)
  }
  const [first] = bodyParagraphs(docxPart(docx, 'word/document.xml'))
  assert.deepEqual([first.style, first.text], ['CoverClassification', 'IN-CONFIDENCE'])
})

test('with no classification, the browser\'s render opens the cover with an empty-looking Cover Classification paragraph and shows nothing in the header (#207)', async () => {
  const docx = await renderInBrowser((instancesDir) => {
    createInstance('design', 'examples', { instancesDir, version: 3 })
  }, 'Solution on a Page')

  const [first, second] = bodyParagraphs(docxPart(docx, 'word/document.xml'))
  assert.deepEqual([first.style, first.text], ['CoverClassification', ' '])
  assert.equal(second.style, 'Title')
  for (const { type, xml } of sectionHeaders(docx)) {
    assert.ok(classificationField(xml), type)
    assert.equal(headerVisibleText(xml).trim(), '', type)
  }
})
