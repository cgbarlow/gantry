// #279 (map #238, decided in #240 and #245): reads the text out of an uploaded Source document, in the browser, so the server (and a Local Workspace's folder) only ever stores plain Markdown beside the original. Word and PowerPoint (speaker notes included) become Markdown, a spreadsheet one table per sheet with a row cap, a PDF its text page by page. A picture, and a scanned PDF with no text layer, get no text at all: there is nothing to read until a model looks at the original.
//
// The reading is done by `officeparser` (pinned to an exact version in package.json; one maintainer, moves fast). Its browser build is served from `/node_modules/` like pandoc-wasm (web/lib/pandocWasm.js) and loaded only when a document is actually read. It is told `allowRemoteAssets: false` and given Gantry's own copy of pdf.js's worker, CMaps and decoders (the pinned `pdfjs-dist` that comes with it), so reading a document never fetches anything from a CDN: with the default, a PDF's worker would come from jsDelivr, and an unreadable PDF would fail with REMOTE_ASSET_BLOCKED rather than quietly reach out.
import { EXTRACTED_TEXT_CUT_CHARS, sourceFileExtension, sourceFileKind } from './sourceDocuments.js'

export const OFFICEPARSER_BROWSER_URL = '/node_modules/officeparser/dist/officeparser.browser.slim.mjs'

/** Gantry's own copies of the files pdf.js loads at run time, all under the same `/node_modules/` route. */
export const PDFJS_ASSET_URLS = Object.freeze({
  pdfWorkerSrc: '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  pdfCMapUrl: '/node_modules/pdfjs-dist/cmaps/',
  pdfDecoderUrl: '/node_modules/pdfjs-dist/wasm/',
})

/** The most data rows kept from any one sheet. OpenAI's own spreadsheet reader stops at 1,000 as well. */
export const SPREADSHEET_ROW_CAP = 1000

/** A PDF with fewer readable characters per page than this is taken for a scan and gets no text file. A scanned page measured 2 to 181 characters in all (#240). */
export const SCANNED_PDF_CHARS_PER_PAGE = 25

/** The parse options every read uses. */
export function officeParserConfig(extra = {}) {
  return { allowRemoteAssets: false, ...PDFJS_ASSET_URLS, ...extra }
}

let parserPromise = null

/** Loads the browser build of officeparser once. A failed load is not remembered, so a later try can succeed. */
function loadBrowserParser() {
  if (!parserPromise) {
    parserPromise = import(OFFICEPARSER_BROWSER_URL).catch((err) => {
      parserPromise = null
      throw err
    })
  }
  return parserPromise
}

const cutText = (text) => {
  if (text.length <= EXTRACTED_TEXT_CUT_CHARS) return text
  const head = text.slice(0, EXTRACTED_TEXT_CUT_CHARS)
  const lastBreak = head.lastIndexOf('\n')
  const kept = lastBreak > EXTRACTED_TEXT_CUT_CHARS / 2 ? head.slice(0, lastBreak) : head
  return `${kept}\n\n_The text stops here: this document is longer than ${EXTRACTED_TEXT_CUT_CHARS.toLocaleString('en-US')} characters. The original has the rest._\n`
}

/** Markdown from officeparser tidied for reading: no front matter block, no `{#heading-id}` anchors, no runs of blank lines. */
export function tidyMarkdown(markdown) {
  return String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .replace(/^(#{1,6} .*?)[ \t]+\{#[^}\n]*\}[ \t]*$/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(?:---\n\n?)+/, '')
    .trim()
}

const escapeCell = (value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()

/**
 * One GFM table per sheet node of a spreadsheet's parsed form (`sheet` > `row` > `cell`), the sheet's name as a heading when there is more than one sheet or it is named. At most `rowCap` data rows per sheet; a sheet cut short says so.
 */
export function sheetsToMarkdown(sheets, { rowCap = SPREADSHEET_ROW_CAP, headings = true } = {}) {
  const blocks = []
  for (const sheet of sheets) {
    const rows = (sheet.children ?? []).filter((r) => r.type === 'row').map((r) => (r.children ?? []).map((c) => escapeCell(c.text)))
    const nonEmpty = rows.filter((cells) => cells.some((c) => c !== ''))
    if (nonEmpty.length === 0) continue
    const width = Math.max(...nonEmpty.map((r) => r.length))
    const pad = (cells) => [...cells, ...Array(width - cells.length).fill('')]
    const [header, ...body] = nonEmpty
    const kept = body.slice(0, rowCap)
    const lines = [
      `| ${pad(header).join(' | ')} |`,
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...kept.map((cells) => `| ${pad(cells).join(' | ')} |`),
    ]
    const name = sheet.metadata?.sheetName
    const parts = []
    if (headings && name) parts.push(`## ${name}`)
    parts.push(lines.join('\n'))
    if (body.length > kept.length) parts.push(`_Showing the first ${kept.length.toLocaleString('en-US')} of ${body.length.toLocaleString('en-US')} rows. The original has the rest._`)
    blocks.push(parts.join('\n\n'))
  }
  return blocks.join('\n\n')
}

/** A PDF's text with a heading per page (so "p. 4" can be found again), or null when the pages hold next to no text (a scan). */
export function pdfPagesToMarkdown(pagesText, pageCount) {
  const pages = pagesText.split('\f')
  const readable = pages.join('').replace(/\s/g, '').length
  const count = Math.max(1, pageCount || pages.length)
  if (readable / count < SCANNED_PDF_CHARS_PER_PAGE) return null
  return pages
    .map((text, i) => ({ n: i + 1, text: text.trim() }))
    .filter((p) => p.text !== '')
    .map((p) => `## Page ${p.n}\n\n${p.text}`)
    .join('\n\n')
}

const decodeUtf8 = (bytes) => new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')

function friendlyProblem(err) {
  const code = err?.code ?? err?.type ?? ''
  const message = String(err?.message ?? err ?? '')
  if (/PASSWORD/i.test(code) || /password/i.test(message)) return 'It is password protected, so Gantry could not read its text.'
  if (/REMOTE_ASSET_BLOCKED/i.test(code) || /REMOTE_ASSET_BLOCKED/.test(message)) return 'Reading it needed a file Gantry does not fetch from the internet.'
  return `Gantry could not read its text (${message.replace(/^\[OfficeParser\]:\s*/, '').slice(0, 160) || 'unknown error'}).`
}

/**
 * Reads `bytes` (a `Uint8Array`) of the document called `filename` and returns `{ text, problem }`: the Markdown to store beside the original, or `text: null` when there is none to give. `problem` is a sentence for the architect when a document that should have had text could not be read; a picture or a scanned PDF is not a problem, only without text. Never throws.
 *
 * `options.loadParser()` returns officeparser's module; tests pass the Node build, the app the browser one.
 */
export async function extractSourceText(filename, bytes, options = {}) {
  const kind = sourceFileKind(filename)
  if (kind === null) return { text: null, problem: 'Gantry does not read this type of file.' }
  if (kind === 'image') return { text: null, problem: null, reason: 'image' }
  try {
    if (kind === 'text') return { text: cutText(decodeUtf8(bytes)), problem: null }

    const parser = await (options.loadParser ?? loadBrowserParser)()
    const parseOffice = parser.parseOffice ?? parser.default?.parseOffice
    const ext = sourceFileExtension(filename)

    if (kind === 'spreadsheet') {
      const fileType = ext === '.xlsx' ? undefined : 'csv'
      const config = officeParserConfig({ ...(fileType ? { fileType } : {}), ...(ext === '.tsv' ? { csvDelimiter: '\t' } : {}) })
      const ast = await parseOffice(bytes, config)
      const sheets = ast.content.filter((n) => n.type === 'sheet')
      const markdown = sheetsToMarkdown(sheets, { headings: ext === '.xlsx' })
      return markdown ? { text: cutText(markdown), problem: null } : { text: null, problem: null, reason: 'empty' }
    }

    if (kind === 'pdf') {
      const ast = await parseOffice(bytes, officeParserConfig())
      const converted = await ast.to('text', { textConfig: { pageSeparator: '\f' } })
      const markdown = pdfPagesToMarkdown(converted.value, ast.metadata?.pages)
      return markdown ? { text: cutText(markdown), problem: null } : { text: null, problem: null, reason: 'scanned' }
    }

    // Word and PowerPoint. Plain Markdown tables and no HTML, so the text reads the same wherever it is shown.
    const ast = await parseOffice(bytes, officeParserConfig())
    const converted = await ast.to('md', { mdConfig: { dialect: 'github', fallbackToHtml: false } })
    const markdown = tidyMarkdown(converted.value)
    return markdown ? { text: cutText(markdown), problem: null } : { text: null, problem: null, reason: 'empty' }
  } catch (err) {
    return { text: null, problem: friendlyProblem(err) }
  }
}
