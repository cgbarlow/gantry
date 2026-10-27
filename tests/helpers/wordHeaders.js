import { docxPart, wordStyles } from './wordDocx.js'

// #207: reads a .docx's page headers the way Word picks them: the header parts its section
// properties reference (default, first-page and even-page), the fields in them, and the text a
// reader sees. Shared by tests/designV3HeaderClassification.test.js (the reference documents and
// the native render) and tests/designV3HeaderClassification.playwright.test.js (the browser's
// pandoc-wasm render), so both render paths are judged by the same rules.

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Every header a section of the document uses: `[{ type, part, xml }]`, one per
 * `<w:headerReference>` in the body's section properties, followed through
 * `word/_rels/document.xml.rels` to its part.
 */
export function sectionHeaders(docx) {
  const documentXml = docxPart(docx, 'word/document.xml')
  const rels = docxPart(docx, 'word/_rels/document.xml.rels')
  const targets = new Map()
  for (const [rel] of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /\sId="([^"]*)"/.exec(rel)?.[1]
    const target = /\sTarget="([^"]*)"/.exec(rel)?.[1]
    if (id && target) targets.set(id, target)
  }
  return [...documentXml.matchAll(/<w:headerReference\s[^>]*>/g)].map(([ref]) => {
    const type = /w:type="([^"]*)"/.exec(ref)?.[1]
    const part = `word/${targets.get(/r:id="([^"]*)"/.exec(ref)?.[1])}`
    return { type, part, xml: docxPart(docx, part) }
  })
}

// A header's own paragraphs: the drawings' text boxes (and their VML fallbacks, which repeat them)
// are taken out, so what is left is the header's top-level paragraphs.
function topLevelParagraphs(xml) {
  const flat = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '').replace(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g, '')
  return [...flat.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(([p]) => p)
}

/**
 * The fields in a header's top-level paragraphs: `[{ instruction, result, paragraphStyle, paragraphXml }]`.
 * `instruction` is the field code (`STYLEREF "Cover Classification"`, say) and `result` the text
 * stored as its last calculated value — what a viewer that doesn't update fields shows.
 */
export function headerFields(xml) {
  const fields = []
  for (const paragraphXml of topLevelParagraphs(xml)) {
    const paragraphStyle = /<w:pPr>[\s\S]*?<w:pStyle w:val="([^"]*)"/.exec(paragraphXml)?.[1] ?? null
    for (const [, instr, inner] of paragraphXml.matchAll(/<w:fldSimple\s[^>]*w:instr="([^"]*)"[^>]*>([\s\S]*?)<\/w:fldSimple>/g)) {
      fields.push({ instruction: decode(instr).trim(), result: textOf(inner), paragraphStyle, paragraphXml })
    }
    let field = null
    for (const [, type, instrText, text] of paragraphXml.matchAll(/<w:fldChar\s[^>]*w:fldCharType="(begin|separate|end)"[^>]*\/>|<w:instrText(?:\s[^>]*)?>([^<]*)<\/w:instrText>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
      if (type === 'begin') field = { instruction: '', result: '', paragraphStyle, paragraphXml, inResult: false }
      else if (type === 'separate' && field) field.inResult = true
      else if (type === 'end' && field) {
        const { inResult, ...done } = field
        fields.push({ ...done, instruction: done.instruction.trim() })
        field = null
      } else if (instrText !== undefined && field && !field.inResult) field.instruction += decode(instrText)
      else if (text !== undefined && field?.inResult) field.result += decode(text)
    }
  }
  return fields
}

function textOf(xml) {
  return decode([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
}

/** The text a reader sees in a header (field codes aside), drawings' text boxes included once. */
export function headerVisibleText(xml) {
  return textOf(xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, ''))
}

/** The STYLEREF field that prints the cover's classification, or undefined. */
export function classificationField(xml) {
  return headerFields(xml).find((f) => /^STYLEREF\s+"Cover Classification"(\s|$)/.test(f.instruction))
}

/**
 * A paragraph style's formatting as Word resolves it through `basedOn`: its alignment (`jc`), font
 * size in half-points (`sz`) and text colour (`color`).
 */
export function paragraphStyleFormat(stylesXml, id) {
  const styles = wordStyles(stylesXml)
  const chain = []
  for (let style = styles.get(id); style && !chain.includes(style); style = styles.get(style.basedOn)) chain.push(style)
  const first = (block, tag) => {
    for (const style of chain) {
      const properties = new RegExp(`<w:${block}>([\\s\\S]*?)</w:${block}>`).exec(style.xml)?.[1] ?? ''
      const value = new RegExp(`<w:${tag}\\s[^>]*w:val="([^"]*)"`).exec(properties)?.[1]
      if (value !== undefined) return value
    }
    return undefined
  }
  return { exists: chain.length > 0, name: chain[0]?.name, jc: first('pPr', 'jc'), size: Number(first('rPr', 'sz')) || undefined, color: first('rPr', 'color') }
}
