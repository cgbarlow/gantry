import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

// #206 (ADR-0052 amendment): the heading numbers a reference document gives a rendered document.
// The table of contents the compile step fills in has to show the numbers Word shows beside the
// headings, and those come from the reference document alone (ADR-0056): its `styles.xml` attaches
// Heading 1–3 (or none) to a list in its `numbering.xml`. Pandoc copies both parts into the .docx
// unchanged, on the native and the pandoc-wasm path alike, so reading them here — from the same
// reference document file both paths are handed — gives the same answer the document will.

// The bytes of one entry (`word/styles.xml`, say) of a zip archive, or null when it has none.
function zipEntry(buffer, name) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let i = buffer.readUInt16LE(eocd + 10); i > 0; i--) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null
    const method = buffer.readUInt16LE(offset + 10)
    const size = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const local = buffer.readUInt32LE(offset + 42)
    if (buffer.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      // The local header repeats the name and extra field, with lengths of its own.
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
      const data = buffer.subarray(start, start + size)
      return method === 0 ? data : method === 8 ? inflateRawSync(data) : null
    }
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  return null
}

const attribute = (xml, name) => new RegExp(`w:${name}="([^"]*)"`).exec(xml ?? '')?.[1]
const element = (xml, tag) => new RegExp(`<w:${tag}(?=[\\s/>])[^>]*?(?:/>|>[\\s\\S]*?</w:${tag}>)`).exec(xml ?? '')?.[0]

// Each Heading 1–9 style's list, as Word resolves it through `basedOn`: level → { numId, ilvl }.
// Styles are found by their built-in name ("heading 1"), which is how Pandoc finds them too.
function headingLists(stylesXml) {
  const styles = new Map()
  for (const [xml] of stylesXml.matchAll(/<w:style\s[^>]*>[\s\S]*?<\/w:style>/g)) {
    const open = xml.slice(0, xml.indexOf('>'))
    if (attribute(open, 'type') !== 'paragraph') continue
    const pPr = element(xml.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ''), 'pPr')
    styles.set(attribute(open, 'styleId'), { name: attribute(element(xml, 'name'), 'val'), basedOn: attribute(element(xml, 'basedOn'), 'val'), numPr: element(pPr, 'numPr') })
  }
  const lists = new Map()
  for (const [id, style] of styles) {
    const level = /^heading ([1-9])$/i.exec(style.name ?? '')?.[1]
    if (!level) continue
    let ilvl
    const seen = new Set()
    for (let s = style; s && !seen.has(s); s = styles.get(s.basedOn)) {
      seen.add(s)
      ilvl ??= attribute(element(s.numPr, 'ilvl'), 'val')
      const numId = attribute(element(s.numPr, 'numId'), 'val')
      if (numId !== undefined) {
        if (numId !== '0') lists.set(Number(level), { numId, ilvl: Number(ilvl ?? 0), styleId: id })
        break
      }
    }
  }
  return lists
}

// A list's levels: ilvl → { start, numFmt, lvlText, isLgl, suffix }, following `w:num` to its
// `abstractNum` and applying the num's own start overrides.
function listLevels(numberingXml, numId) {
  const num = new RegExp(`<w:num w:numId="${numId}"[^>]*>([\\s\\S]*?)</w:num>`).exec(numberingXml)?.[1]
  if (num === undefined) return null
  const abstractId = attribute(element(num, 'abstractNumId'), 'val')
  const abstract = new RegExp(`<w:abstractNum [^>]*w:abstractNumId="${abstractId}"[^>]*>([\\s\\S]*?)</w:abstractNum>`).exec(numberingXml)?.[1] ?? ''
  const overrides = new Map(
    [...num.matchAll(/<w:lvlOverride w:ilvl="(\d)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)].map(([, ilvl, xml]) => [Number(ilvl), attribute(element(xml, 'startOverride'), 'val')])
  )
  const levels = new Map()
  for (const [, ilvl, xml] of abstract.matchAll(/<w:lvl w:ilvl="(\d)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
    const isLgl = element(xml, 'isLgl')
    levels.set(Number(ilvl), {
      start: Number(overrides.get(Number(ilvl)) ?? attribute(element(xml, 'start'), 'val') ?? 0),
      numFmt: attribute(element(xml, 'numFmt'), 'val') ?? 'decimal',
      lvlText: attribute(element(xml, 'lvlText'), 'val') ?? '',
      isLgl: isLgl !== undefined && !/w:val="(0|false|off)"/.test(isLgl),
      suffix: { space: ' ', nothing: '' }[attribute(element(xml, 'suff'), 'val')] ?? '\t',
    })
  }
  return levels
}

const decodeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function roman(n) {
  const digits = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [value, text] of digits) for (; n >= value; n -= value) out += text
  return out
}

// One level's counter as its number format shows it. Formats Gantry doesn't know show as decimals.
function formatCounter(n, numFmt) {
  if (numFmt === 'none') return ''
  if (numFmt === 'decimalZero') return String(n).padStart(2, '0')
  if (numFmt === 'lowerRoman') return roman(n)
  if (numFmt === 'upperRoman') return roman(n).toUpperCase()
  if (/^(lower|upper)Letter$/.test(numFmt) && n > 0) {
    const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1)
    return numFmt === 'upperLetter' ? letter.toUpperCase() : letter
  }
  return String(n)
}

/**
 * Numbers a document's headings as Word will, from its reference document's styles and numbering.
 * Returns `number(level, { unnumbered })`, called once per heading in document order: the text Word
 * shows before that heading (`'1.2'`, say) and the separator after it, as `{ text, suffix }`, or null
 * for a heading it doesn't number. A heading whose numbering is switched off (`unnumbered`, numId 0,
 * ADR-0056) gets null and doesn't advance the count, as in Word. A level that hasn't been reached yet
 * shows 0, as Word does for a Heading 2 before the first Heading 1. With no reference document, or
 * one that numbers no heading style, every heading gets null.
 */
export function headingNumberer(referenceDocPath) {
  let lists = new Map()
  let numbering = ''
  if (referenceDocPath) {
    try {
      const docx = readFileSync(referenceDocPath)
      lists = headingLists(zipEntry(docx, 'word/styles.xml')?.toString('utf8') ?? '')
      numbering = zipEntry(docx, 'word/numbering.xml')?.toString('utf8') ?? ''
    } catch {
      // A reference document that can't be read numbers nothing here; Pandoc reports it itself.
      lists = new Map()
    }
  }
  const levelsByList = new Map()
  const counters = new Map()
  return (level, { unnumbered = false } = {}) => {
    const list = lists.get(level)
    if (unnumbered || !list) return null
    if (!levelsByList.has(list.numId)) levelsByList.set(list.numId, listLevels(numbering, list.numId))
    const levels = levelsByList.get(list.numId)
    const lvl = levels?.get(list.ilvl)
    if (!lvl) return null
    const count = counters.get(list.numId) ?? []
    count[list.ilvl] = count[list.ilvl] === undefined ? lvl.start : count[list.ilvl] + 1
    count.length = list.ilvl + 1
    counters.set(list.numId, count)
    if (lvl.numFmt === 'bullet') return { text: decodeXml(lvl.lvlText), suffix: lvl.suffix }
    const text = decodeXml(lvl.lvlText).replace(/%([1-9])/g, (_, n) => {
      const at = Number(n) - 1
      const format = lvl.isLgl ? 'decimal' : (levels.get(at)?.numFmt ?? 'decimal')
      return formatCounter(count[at] ?? 0, format)
    })
    return text ? { text, suffix: lvl.suffix } : null
  }
}
