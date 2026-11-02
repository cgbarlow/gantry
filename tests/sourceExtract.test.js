import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as officeparser from 'officeparser'
import {
  extractSourceText,
  officeParserConfig,
  OFFICEPARSER_BROWSER_URL,
  PDFJS_ASSET_URLS,
  pdfPagesToMarkdown,
  sheetsToMarkdown,
  SPREADSHEET_ROW_CAP,
  tidyMarkdown,
} from '../web/lib/sourceExtract.js'
import { EXTRACTED_TEXT_CUT_CHARS } from '../web/lib/sourceDocuments.js'
import { pngImage, powerPointWithNotes, scannedPdf, spreadsheet, textPdf, wordDocument } from './helpers/sourceFixtures.js'

// #279: text is read out of a Source document in the browser. These run the same code with officeparser's Node build standing in for the browser one (the app loads the browser build from /node_modules/, which tests/source-documents.playwright.test.js exercises for real).
// Node finds pdf.js in node_modules itself, so the browser-only URLs (served by the app under /node_modules/) are left out of the options here.
const nodeParser = async () => ({
  parseOffice: (bytes, { pdfWorkerSrc: _w, pdfCMapUrl: _c, pdfDecoderUrl: _d, ...config }) => officeparser.parseOffice(bytes, config),
})
const extract = (filename, bytes) => extractSourceText(filename, bytes, { loadParser: nodeParser })

test('a Word document becomes Markdown, without front matter or heading anchors', async () => {
  const { text, problem } = await extract('Client brief.docx', wordDocument())
  assert.equal(problem, null)
  assert.match(text, /^# Client brief$/m)
  assert.match(text, /^## Retention$/m)
  assert.match(text, /The platform must support \*\*5000\*\* users\./)
  assert.match(text, /- Seven years/)
  assert.match(text, /\| System \| Owner \|/)
  assert.match(text, /\| CRM \| Sales \|/)
  assert.doesNotMatch(text, /^---$/m)
  assert.doesNotMatch(text, /\{#/)
  assert.doesNotMatch(text, /<table|<tr|<td/)
})

test('a PowerPoint deck becomes Markdown with its speaker notes', async () => {
  const { text, problem } = await extract('Kick-off.pptx', powerPointWithNotes())
  assert.equal(problem, null)
  assert.match(text, /# Kick-off/)
  assert.match(text, /Scope agreed/)
  assert.match(text, /The sponsor wants go-live before March\./)
  assert.match(text, /# Risks/)
  assert.match(text, /Vendor lock-in\./)
})

test('a spreadsheet becomes one table per sheet', async () => {
  const bytes = await spreadsheet([
    { name: 'Costs', rows: [['item', 'cost'], ['Licence', 1000], ['Support', 250]] },
    { name: 'People', rows: [['name', 'role'], ['Ana', 'Architect']] },
  ])
  const { text, problem } = await extract('Budget.xlsx', bytes)
  assert.equal(problem, null)
  assert.match(text, /^## Costs$/m)
  assert.match(text, /\| item \| cost \|\n\| --- \| --- \|\n\| Licence \| 1000 \|\n\| Support \| 250 \|/)
  assert.match(text, /^## People$/m)
  assert.match(text, /\| Ana \| Architect \|/)
  assert.ok(text.indexOf('## Costs') < text.indexOf('## People'))
})

test('a long sheet stops at the row cap and says so', async () => {
  const rows = [['n', 'square'], ...Array.from({ length: SPREADSHEET_ROW_CAP + 50 }, (_, i) => [i + 1, (i + 1) ** 2])]
  const { text } = await extract('Big.xlsx', await spreadsheet([{ name: 'Big', rows }]))
  const dataRows = text.split('\n').filter((l) => /^\| \d+ \| \d+ \|$/.test(l))
  assert.equal(dataRows.length, SPREADSHEET_ROW_CAP)
  assert.match(text, /Showing the first 1,000 of 1,050 rows/)
})

test('a CSV file becomes a table, and a TSV file too', async () => {
  const csv = await extract('costs.csv', new TextEncoder().encode('item,cost\nLicence,1000\n'))
  assert.match(csv.text, /\| item \| cost \|\n\| --- \| --- \|\n\| Licence \| 1000 \|/)
  assert.doesNotMatch(csv.text, /^## /m)
  const tsv = await extract('costs.tsv', new TextEncoder().encode('item\tcost\nLicence\t1000\n'))
  assert.match(tsv.text, /\| item \| cost \|/)
  assert.match(tsv.text, /\| Licence \| 1000 \|/)
})

test('a PDF with a text layer becomes text with a heading per page', async () => {
  const bytes = textPdf([['Client brief, page one.', 'The platform must support 5000 users.'], ['Retention is seven years.']])
  const { text, problem } = await extract('Brief.pdf', bytes)
  assert.equal(problem, null)
  assert.match(text, /## Page 1\n\nClient brief, page one\.\nThe platform must support 5000 users\./)
  assert.match(text, /## Page 2\n\nRetention is seven years\./)
})

test('a scanned PDF and an image get no text and are not a problem', async () => {
  const scanned = await extract('Scan.pdf', scannedPdf())
  assert.equal(scanned.text, null)
  assert.equal(scanned.problem, null)
  assert.equal(scanned.reason, 'scanned')
  const image = await extract('Whiteboard.png', pngImage())
  assert.equal(image.text, null)
  assert.equal(image.problem, null)
  assert.equal(image.reason, 'image')
})

test('Markdown and text files are kept as they are', async () => {
  const md = await extract('notes.md', new TextEncoder().encode('﻿# Notes\n\nA line.\n'))
  assert.equal(md.text, '# Notes\n\nA line.\n')
  const txt = await extract('notes.txt', new TextEncoder().encode('Plain words'))
  assert.equal(txt.text, 'Plain words')
})

test('text past the cut-off is cut with a note pointing at the original', async () => {
  const line = 'x'.repeat(99) + '\n'
  const { text } = await extract('Huge.txt', new TextEncoder().encode(line.repeat(11_000)))
  assert.ok(text.length < EXTRACTED_TEXT_CUT_CHARS + 400)
  assert.match(text, /The text stops here/)
})

test('a document that cannot be read gives a problem, never a throw', async () => {
  const broken = await extract('Broken.docx', new TextEncoder().encode('this is not a Word file'))
  assert.equal(broken.text, null)
  assert.match(broken.problem, /could not read its text/)
  const unknown = await extract('Drawing.vsdx', new Uint8Array([1, 2, 3]))
  assert.equal(unknown.text, null)
  assert.match(unknown.problem, /does not read this type/)
  const failing = await extractSourceText('Any.docx', new Uint8Array([1]), { loadParser: async () => { throw new Error('offline') } })
  assert.equal(failing.text, null)
  assert.match(failing.problem, /offline/)
})

test('a password protected document says so', async () => {
  const locked = async () => ({ parseOffice: async () => { throw Object.assign(new Error('needs a password'), { code: 'PASSWORD_REQUIRED' }) } })
  const result = await extractSourceText('Locked.docx', new Uint8Array([1]), { loadParser: locked })
  assert.match(result.problem, /password protected/)
})

test('nothing is fetched from a CDN: remote assets are off and pdf.js is served from this server', () => {
  const config = officeParserConfig()
  assert.equal(config.allowRemoteAssets, false)
  assert.equal(OFFICEPARSER_BROWSER_URL.startsWith('/node_modules/'), true)
  for (const url of Object.values(PDFJS_ASSET_URLS)) assert.match(url, /^\/node_modules\/pdfjs-dist\//)
  assert.deepEqual({ pdfWorkerSrc: config.pdfWorkerSrc, pdfCMapUrl: config.pdfCMapUrl, pdfDecoderUrl: config.pdfDecoderUrl }, PDFJS_ASSET_URLS)
})

test('the page and table helpers behave on their own', () => {
  assert.equal(pdfPagesToMarkdown('\f', 2), null)
  assert.equal(pdfPagesToMarkdown('A page with plenty of real words on it, and then many more words besides\f\fThird page also has plenty of words', 3), '## Page 1\n\nA page with plenty of real words on it, and then many more words besides\n\n## Page 3\n\nThird page also has plenty of words')
  assert.equal(sheetsToMarkdown([{ children: [] }]), '')
  assert.equal(
    sheetsToMarkdown([{ metadata: { sheetName: 'S' }, children: [{ type: 'row', children: [{ text: 'a|b' }, { text: 'c\nd' }] }, { type: 'row', children: [{ text: '1' }] }] }]),
    '## S\n\n| a\\|b | c d |\n| --- | --- |\n| 1 |  |'
  )
  assert.equal(tidyMarkdown('---\ncreated: x\n---\n\n# Title {#title}\n\n\n\nBody'), '# Title\n\nBody')
})
