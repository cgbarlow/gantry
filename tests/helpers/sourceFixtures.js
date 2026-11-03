import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as officeparser from 'officeparser'

// Small, real Source documents for the tests of #279, built at run time so nothing binary is checked in: Word and PowerPoint from native Pandoc (which the render tests already need), a spreadsheet from officeparser's own generator, and PDFs written by hand.

function viaPandoc(markdown, format) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-source-fixture-'))
  try {
    const input = join(dir, 'in.md')
    const output = join(dir, `out.${format}`)
    writeFileSync(input, markdown)
    execFileSync('pandoc', [input, '-o', output], { stdio: ['ignore', 'ignore', 'ignore'] })
    return new Uint8Array(readFileSync(output))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Pandoc stamps the time into what it writes, so each is built once: two calls must give the same bytes.
const once = (build) => {
  let value
  return () => (value ??= build())
}

/** A Word document with a title, a section, a list and a table. */
export const wordDocument = once(() =>
  viaPandoc('# Client brief\n\nThe platform must support **5000** users.\n\n## Retention\n\n- Seven years\n- Audited yearly\n\n| System | Owner |\n|---|---|\n| CRM | Sales |\n', 'docx'))

/** A two-slide deck with speaker notes on the first. */
export const powerPointWithNotes = once(() =>
  viaPandoc('# Kick-off\n\n- Scope agreed\n\n::: notes\nThe sponsor wants go-live before March.\n:::\n\n# Risks\n\nVendor lock-in.\n', 'pptx'))

/** A workbook of `sheets`, each `{ name, rows: [[cell, ...], ...] }` (the first row is the header). */
export async function spreadsheet(sheets) {
  const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n'
  const ast = await officeparser.parseOffice(Buffer.from(csv(sheets[0].rows)), { fileType: 'csv' })
  const template = ast.content[0]
  ast.content = sheets.map((sheet) => {
    const parsed = structuredClone(template)
    parsed.metadata.sheetName = sheet.name
    return parsed
  })
  // Each sheet starts as the first one's cells; swap in its own rows.
  for (let i = 1; i < sheets.length; i++) {
    const other = await officeparser.parseOffice(Buffer.from(csv(sheets[i].rows)), { fileType: 'csv' })
    ast.content[i].children = other.content[0].children
  }
  const out = await officeparser.generate(ast, 'xlsx')
  return new Uint8Array(out.value ?? out)
}

/** A PDF with a text layer, one page per entry of `pages` (each an array of lines). */
export function textPdf(pages) {
  const objects = []
  const add = (body) => objects.push(body)
  add('') // 1 catalog
  add('') // 2 pages
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') // 3 font
  const kids = []
  for (const lines of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ')} ET`
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    kids.push(`${objects.length} 0 R`)
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

/** A PDF whose pages draw no text at all, as a scan does (the page is a picture in a real one). */
export function scannedPdf(pageCount = 2) {
  return textPdf(Array.from({ length: pageCount }, () => ['']))
}

/** A one-pixel PNG. */
export function pngImage() {
  return new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
}
