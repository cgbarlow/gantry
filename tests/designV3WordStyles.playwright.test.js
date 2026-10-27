import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { bodyTables, docxPart, headerRowFormat, headingNumbers, rowsCantSplit, wordStyles } from './helpers/wordDocx.js'

// #197 (spec #192) — the browser half of design v3's Word styles. The default Render converts in the
// browser with pandoc-wasm (Pandoc 3.10), not the server's native Pandoc that tests/designV3.test.js
// renders with, so this checks the .docx that path produces by the same rules
// (tests/helpers/wordDocx.js): numbered sections with unnumbered front matter, and every table in
// the one table style, its header row repeating and its rows kept together.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'

async function renderSadInBrowser() {
  const root = mkdtempSync(join(tmpdir(), 'gantry-v3-word-styles-e2e-'))
  const instancesDir = join(root, 'instances')
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    // The SAD renders at Detailed Design, which the bundled example has passed; open it there.
    const instanceYaml = join(instancesDir, 'examples', 'instance.yaml')
    const atDetailedDesign = readFileSync(instanceYaml, 'utf8').replace(/^stage: .*$/m, 'stage: detailed-design')
    assert.match(atDetailedDesign, /^definitionVersion: 3$/m)
    writeFileSync(instanceYaml, atDetailedDesign)
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
        await renderDialog.getByRole('button', { name: 'Solution Architecture Document', exact: true }).click()
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 90_000 }),
          renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click(),
        ])
        // The conversion happened in the browser: a failed WASM conversion falls back to the native
        // render silently, and only the WASM leg hands its document back through render-wasm-finish.
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

test('the browser\'s pandoc-wasm render of the v3 SAD numbers its sections, leaves the front matter unnumbered, and keeps every table row whole under a repeating header (#197)', async () => {
  const docx = await renderSadInBrowser()
  const documentXml = docxPart(docx, 'word/document.xml')
  const styles = wordStyles(docxPart(docx, 'word/styles.xml'))
  const numberingXml = docxPart(docx, 'word/numbering.xml')

  const headings = headingNumbers(documentXml, styles, numberingXml)
  const first = headings.findIndex((h) => h.style === 'Heading1')
  assert.deepEqual(
    headings.slice(0, first).map(({ text, number }) => [text, number]),
    [['Kiwi Cover Mutual', null], ['Document Control', null], ['Review & sign-off', null], ['Table of Contents', null]]
  )
  assert.deepEqual(headings.slice(first, first + 3).map(({ text, number }) => [text, number]), [['Overview', '1'], ['Executive summary', '1.1'], ['Overview', '1.2']])

  const tables = bodyTables(documentXml)
  assert.ok(tables.length > 0)
  for (const [i, table] of tables.entries()) {
    assert.equal(table.style, 'Table', `table ${i + 1}`)
    assert.equal(table.rows[0].header, true, `table ${i + 1}'s header row repeats on every page`)
    for (const row of table.rows) assert.notEqual(row.cantSplit, false, `table ${i + 1}: no row is allowed to split`)
  }
  assert.equal(rowsCantSplit(styles, 'Table'), true, 'the document\'s table style keeps every row on one page')
  assert.deepEqual(headerRowFormat(styles, 'Table'), headerRowFormat(wordStyles(docxPart('definitions/design/3/templates/reference-sad.docx', 'word/styles.xml')), 'Table'), 'the header row is the reference document\'s')
})
