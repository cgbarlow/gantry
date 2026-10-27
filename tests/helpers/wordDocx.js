import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #197 (spec #192): reads what Word itself would read out of a .docx — its styles, its numbering
// and its body — so a test can assert on a rendered document's Word formatting rather than on how
// the engine built it. Shared by the native-render unit tests (tests/designV3.test.js) and the
// browser's pandoc-wasm render (tests/designV3WordStyles.playwright.test.js), so both render paths
// are judged by exactly the same rules.

/** One part of a .docx (`word/styles.xml`, say), from a path or from the document's bytes. */
export function docxPart(docx, part) {
  if (typeof docx === 'string') return execFileSync('unzip', ['-p', docx, part], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const dir = mkdtempSync(join(tmpdir(), 'gantry-docx-'))
  try {
    const path = join(dir, 'document.docx')
    writeFileSync(path, docx)
    return docxPart(path, part)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The text of an element's first child `<w:tag …>` / `<w:tag …/>` or `<w:tag>…</w:tag>`, or undefined. */
function childElement(xml, tag) {
  const open = new RegExp(`<w:${tag}(?=[\\s/>])[^>]*?(/>|>)`).exec(xml)
  if (!open) return undefined
  if (open[1] === '/>') return open[0]
  const close = xml.indexOf(`</w:${tag}>`, open.index)
  return close < 0 ? open[0] : xml.slice(open.index, close + `</w:${tag}>`.length)
}

function attribute(xml, name) {
  return xml ? new RegExp(`w:${name}="([^"]*)"`).exec(xml)?.[1] : undefined
}

// An on/off property such as `<w:keepNext/>`: present and not switched off with a false value.
function isOn(element) {
  return element !== undefined && !/w:val="(0|false|off)"/.test(element)
}

/** Every style in a styles.xml, by styleId: `{ id, name, type, basedOn, xml }`. */
export function wordStyles(stylesXml) {
  const styles = new Map()
  for (const [xml] of stylesXml.matchAll(/<w:style\s[^>]*>[\s\S]*?<\/w:style>/g)) {
    const id = attribute(xml.slice(0, xml.indexOf('>')), 'styleId')
    styles.set(id, {
      id,
      name: attribute(childElement(xml, 'name'), 'val'),
      type: attribute(xml.slice(0, xml.indexOf('>')), 'type'),
      basedOn: attribute(childElement(xml, 'basedOn'), 'val'),
      xml,
    })
  }
  return styles
}

/** The style and every style it is based on, nearest first. */
function styleChain(styles, id) {
  const chain = []
  for (let style = styles.get(id); style && !chain.includes(style); style = styles.get(style.basedOn)) chain.push(style)
  return chain
}

// The xml of one properties block (`pPr`, `rPr`, `trPr`, `tblPr`, `tcPr`) of a style, leaving out
// the conditional formatting (`tblStylePr`) a table style carries for its header row and the like.
function ownProperties(style, block) {
  return childElement(style.xml.replace(/<w:tblStylePr[\s\S]*?<\/w:tblStylePr>/g, ''), block) ?? ''
}

/** Whether a paragraph style keeps with the next paragraph, as Word resolves it through `basedOn`. */
export function keepsWithNext(styles, id) {
  for (const style of styleChain(styles, id)) {
    const keepNext = childElement(ownProperties(style, 'pPr'), 'keepNext')
    if (keepNext !== undefined) return isOn(keepNext)
  }
  return false
}

/** A paragraph style's list numbering as Word resolves it through `basedOn`: `{ numId, ilvl }`, or null. */
export function styleNumbering(styles, id) {
  let ilvl
  for (const style of styleChain(styles, id)) {
    const numPr = childElement(ownProperties(style, 'pPr'), 'numPr')
    if (numPr === undefined) continue
    ilvl ??= attribute(childElement(numPr, 'ilvl'), 'val')
    const numId = attribute(childElement(numPr, 'numId'), 'val')
    if (numId !== undefined) return numId === '0' ? null : { numId, ilvl: Number(ilvl ?? 0) }
  }
  return null
}

/** A style's font size in half-points (`w:sz`), as Word resolves it through `basedOn`, or undefined. */
export function styleFontSize(styles, id) {
  for (const style of styleChain(styles, id)) {
    const size = attribute(childElement(ownProperties(style, 'rPr'), 'sz'), 'val')
    if (size !== undefined) return Number(size)
  }
  return undefined
}

/** Whether a table style keeps every row of its tables on one page (`trPr/cantSplit`), through `basedOn`. */
export function rowsCantSplit(styles, id) {
  for (const style of styleChain(styles, id)) {
    const cantSplit = childElement(ownProperties(style, 'trPr'), 'cantSplit')
    if (cantSplit !== undefined) return isOn(cantSplit)
  }
  return false
}

/** A table style's header-row formatting (its `firstRow` conditional): fill, text colour, bold and size. */
export function headerRowFormat(styles, id) {
  const style = styles.get(id)
  const firstRow = /<w:tblStylePr w:type="firstRow">([\s\S]*?)<\/w:tblStylePr>/.exec(style?.xml ?? '')?.[1] ?? ''
  const rPr = childElement(firstRow, 'rPr') ?? ''
  return {
    fill: attribute(childElement(childElement(firstRow, 'tcPr') ?? '', 'shd'), 'fill'),
    color: attribute(childElement(rPr, 'color'), 'val'),
    bold: isOn(childElement(rPr, 'b')),
    size: Number(attribute(childElement(rPr, 'sz'), 'val')) || undefined,
  }
}

/** A numbering instance's level definitions: `[{ ilvl, numFmt, lvlText, pStyle }]`, following `w:num` to its `abstractNum`. */
export function numberingLevels(numberingXml, numId) {
  const num = new RegExp(`<w:num w:numId="${numId}"[^>]*>([\\s\\S]*?)</w:num>`).exec(numberingXml)?.[1]
  const abstractId = attribute(childElement(num ?? '', 'abstractNumId'), 'val')
  const abstract = new RegExp(`<w:abstractNum [^>]*w:abstractNumId="${abstractId}"[^>]*>([\\s\\S]*?)</w:abstractNum>`).exec(numberingXml)?.[1] ?? ''
  return [...abstract.matchAll(/<w:lvl w:ilvl="(\d)"[^>]*>([\s\S]*?)<\/w:lvl>/g)].map(([, ilvl, xml]) => ({
    ilvl: Number(ilvl),
    numFmt: attribute(childElement(xml, 'numFmt'), 'val'),
    lvlText: attribute(childElement(xml, 'lvlText'), 'val'),
    pStyle: attribute(childElement(xml, 'pStyle'), 'val'),
  }))
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function paragraph(xml) {
  const pPr = childElement(xml, 'pPr') ?? ''
  const numPr = childElement(pPr, 'numPr')
  return {
    style: attribute(childElement(pPr, 'pStyle'), 'val') ?? null,
    // The paragraph's own numbering, overriding its style's: undefined when it sets none.
    numId: numPr === undefined ? undefined : attribute(childElement(numPr, 'numId'), 'val'),
    text: decode([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')),
    runSizes: [...xml.matchAll(/<w:rPr>[\s\S]*?<\/w:rPr>/g)].flatMap(([rPr]) => attribute(childElement(rPr, 'sz'), 'val') ?? []),
    xml,
  }
}

/** The body's paragraphs outside tables, in order: `{ style, numId, text, runSizes }`. */
export function bodyParagraphs(documentXml) {
  const body = documentXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, '')
  return [...body.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(([xml]) => paragraph(xml))
}

/** The body's tables: `{ style, rows: [{ header, cantSplit, paragraphs }] }`. */
export function bodyTables(documentXml) {
  return [...documentXml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map(([, xml]) => ({
    style: attribute(childElement(childElement(xml, 'tblPr') ?? '', 'tblStyle'), 'val'),
    rows: [...xml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map(([, row]) => {
      const trPr = childElement(row.replace(/<w:tc>[\s\S]*/, ''), 'trPr') ?? ''
      return {
        header: isOn(childElement(trPr, 'tblHeader')),
        cantSplit: childElement(trPr, 'cantSplit') === undefined ? undefined : isOn(childElement(trPr, 'cantSplit')),
        paragraphs: [...row.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(([p]) => paragraph(p)),
      }
    }),
  }))
}

/**
 * Word's heading numbers for a document's body paragraphs, worked out the way Word does for a
 * multilevel list attached to heading styles: each numbered paragraph advances its own level and
 * restarts the levels below it. Returns `[{ text, style, number }]` for every paragraph whose style
 * is a heading, `number` null when the paragraph (or its style) has its numbering switched off.
 */
export function headingNumbers(documentXml, styles, numberingXml) {
  const counters = new Map()
  const levels = new Map()
  const out = []
  for (const p of bodyParagraphs(documentXml)) {
    if (!/^Heading\d$/.test(p.style ?? '') && p.style !== 'TOCHeading' && p.style !== 'Title') continue
    const fromStyle = styleNumbering(styles, p.style)
    const numbering = p.numId === undefined ? fromStyle : p.numId === '0' ? null : { numId: p.numId, ilvl: fromStyle?.ilvl ?? 0 }
    if (!numbering) {
      out.push({ text: p.text, style: p.style, number: null })
      continue
    }
    if (!levels.has(numbering.numId)) levels.set(numbering.numId, numberingLevels(numberingXml, numbering.numId))
    const count = counters.get(numbering.numId) ?? []
    count[numbering.ilvl] = (count[numbering.ilvl] ?? 0) + 1
    count.length = numbering.ilvl + 1
    counters.set(numbering.numId, count)
    const lvlText = levels.get(numbering.numId).find((l) => l.ilvl === numbering.ilvl)?.lvlText ?? ''
    out.push({ text: p.text, style: p.style, number: lvlText.replace(/%(\d)/g, (_, n) => String(count[n - 1] ?? 0)) })
  }
  return out
}

// A paragraph's text as Word lays it out: its `<w:t>` runs and its tabs (`\t`), in order.
function paragraphText(xml) {
  return decode([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => m[1] ?? '\t').join(''))
}

/**
 * #206: the document's TOC field, as Word and any other viewer read it before the field is updated:
 * `{ instruction, dirty, entries: [{ style, text, anchor }] }`, or null when there is none.
 * `entries` are the paragraphs of the field's result, between its `separate` and `end`: each one's
 * paragraph style, its text (tabs as `\t`), and the bookmark its internal link points at (null
 * when it isn't a link). A field result that isn't a list of entries (a placeholder sentence) is
 * one entry with no style.
 */
export function tableOfContents(documentXml) {
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(([xml]) => xml)
  const first = paragraphs.findIndex((p) => /<w:instrText[^>]*>\s*TOC\s/.test(p))
  if (first < 0) return null
  let depth = 0
  const field = []
  for (const p of paragraphs.slice(first)) {
    field.push(p)
    depth += (p.match(/w:fldCharType="begin"/g) ?? []).length - (p.match(/w:fldCharType="end"/g) ?? []).length
    if (depth <= 0) break
  }
  const begin = /<w:fldChar w:fldCharType="begin"([^>]*)\/>/.exec(field[0])
  // The result: everything after the field's `separate` and before its `end`, paragraph by paragraph.
  const result = field.map((p, i) => {
    let xml = p
    if (i === 0) xml = xml.slice(xml.indexOf('w:fldCharType="separate"'))
    if (i === field.length - 1) xml = xml.slice(0, xml.lastIndexOf('w:fldCharType="end"'))
    return { xml, style: attribute(childElement(childElement(p, 'pPr') ?? '', 'pStyle'), 'val') ?? null }
  })
  return {
    instruction: decode(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/.exec(field[0])[1]),
    dirty: /w:dirty="(true|1|on)"/.test(begin?.[1] ?? ''),
    entries: result
      .map(({ xml, style }) => ({ style, text: paragraphText(xml), anchor: decode(/<w:hyperlink [^>]*w:anchor="([^"]*)"/.exec(xml)?.[1] ?? '') || null }))
      .filter((entry) => entry.text !== ''),
  }
}

/**
 * Every bookmark that marks a heading: bookmark name → `{ heading, text, style }` of the heading
 * paragraph it starts in, or starts just before (Pandoc 3.1 opens a heading's bookmark ahead of its
 * paragraph; later Pandocs and Gantry's own unnumbered headings open it inside). `heading` counts the
 * document's heading paragraphs from 0, in order, so two headings with the same text can be told apart.
 */
export function headingBookmarks(documentXml) {
  const bookmarks = new Map()
  let pending = []
  let heading = 0
  for (const [token] of documentXml.matchAll(/<w:bookmarkStart [^>]*\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:tbl>/g)) {
    if (token.startsWith('<w:bookmarkStart')) {
      pending.push(decode(attribute(token, 'name')))
      continue
    }
    if (token === '<w:tbl>') {
      pending = []
      continue
    }
    const p = paragraph(token)
    const inside = [...token.matchAll(/<w:bookmarkStart [^>]*\/>/g)].map(([b]) => decode(attribute(b, 'name')))
    if (/^Heading\d$/.test(p.style ?? '')) {
      for (const name of [...pending, ...inside]) if (!bookmarks.has(name)) bookmarks.set(name, { heading, text: p.text, style: p.style })
      heading++
    }
    pending = []
  }
  return bookmarks
}

/**
 * #206: the entries Word lists when it updates a `TOC \o "1-3"` field, less page numbers: one per
 * Heading 1–3 paragraph, in order, `{ style: 'TOC<level>', text, heading }`, where `text` is the
 * heading's number (as headingNumbers works it out), a tab, and its text, or just its text when it
 * isn't numbered, and `heading` the heading's place among all heading paragraphs (headingBookmarks).
 */
export function expectedTableOfContents(documentXml, styles, numberingXml) {
  return headingNumbers(documentXml, styles, numberingXml)
    .filter((h) => /^Heading\d$/.test(h.style))
    .map((h, heading) => ({ ...h, heading, level: Number(h.style.slice('Heading'.length)) }))
    .filter((h) => h.level <= 3)
    .map(({ text, number, heading, level }) => ({ style: `TOC${level}`, text: number ? `${number}\t${text}` : text, heading }))
}
