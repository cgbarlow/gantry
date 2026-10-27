import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { bodyTables, docxPart, expectedTableOfContents, headerRowFormat, headingBookmarks, headingNumbers, rowsCantSplit, tableOfContents, wordStyles } from './helpers/wordDocx.js'

// #197 (spec #192) — the browser half of design v3's Word styles. The default Render converts in the
// browser with pandoc-wasm (Pandoc 3.10), not the server's native Pandoc that tests/designV3.test.js
// renders with, so this checks the .docx that path produces by the same rules
// (tests/helpers/wordDocx.js): numbered sections with unnumbered front matter, and every table in
// the one table style, its header row repeating and its rows kept together. #206: and its table of
// contents filled in, as tests/tableOfContentsPrefill.test.js checks for the native render.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'

// One browser render serves every test in this file.
let sadInBrowser
function renderSadInBrowser() {
  sadInBrowser ??= renderSadInBrowserOnce()
  return sadInBrowser
}

async function renderSadInBrowserOnce() {
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

test('the browser\'s pandoc-wasm render of the v3 SAD has its table of contents filled in: every level 1–3 heading, numbered as shown, linked to its heading (#206)', async () => {
  const docx = await renderSadInBrowser()
  const documentXml = docxPart(docx, 'word/document.xml')
  const toc = tableOfContents(documentXml)
  assert.equal(toc.instruction, ' TOC \\o "1-3" \\h \\z \\u ')
  assert.equal(toc.dirty, true, 'Word still rebuilds it, with page numbers, on open')
  assert.ok(!documentXml.includes('Open this document in Word'), 'no placeholder')
  const expected = expectedTableOfContents(documentXml, wordStyles(docxPart(docx, 'word/styles.xml')), docxPart(docx, 'word/numbering.xml'))
  assert.deepEqual(toc.entries.map(({ style, text }) => ({ style, text })), expected.map(({ style, text }) => ({ style, text })))
  assert.deepEqual(toc.entries.slice(0, 4).map(({ text }) => text), ['Document Control', 'Review & sign-off', '1\tOverview', '1.1\tExecutive summary'])
  const bookmarks = headingBookmarks(documentXml)
  for (const [i, entry] of toc.entries.entries()) assert.equal(bookmarks.get(entry.anchor)?.heading, expected[i].heading, `${entry.text} links to its heading (#${entry.anchor})`)
})
