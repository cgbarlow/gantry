// #304 (parent #238, decided in #251; docs/adr/0066): the **Review response list**. Gantry never writes into a Reviewed copy and never replies to
// the people who commented. What it offers instead is a table built from the decisions log after a review round (one `review-answered` entry
// for each comment thread answered): the comment, who made it, what was decided and why. The architect downloads it as a Word document and sends it
// back themselves.
//
// It is generated on demand from the logs as they stand and is never committed or stored anywhere. Nothing here touches the Reviewed copy.
//
// The module has no DOM and no network, so the browser builds the download from the logs it already holds and the server (or an outside agent over MCP)
// can build the same list from the same logs:
//
//   reviewResponseRows(logs, { fieldTitle })   the rows, in the order the threads were answered, grouped by Reviewed copy
//   reviewResponseDocx(list, { ... })          the list as a .docx (bytes), a plain table anyone can open in Word
//   reviewResponseFilename(instanceName)       a name for it
import { crc32 } from './definitionLogo.js'

export const REVIEW_RESPONSE_TITLE = 'Review response list'

const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const REVIEW_RESPONSE_MIME = WORD_MIME

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '')

/** What each outcome says to the person who commented (the log's `outcome` words, in the architect's voice). */
export const RESPONSE_OUTCOMES = Object.freeze({
  accept: 'Edit accepted',
  'accept-other': "Another commenter's edit was accepted instead",
  revise: 'Wording revised',
  'revise-kept': 'Looked at; the wording stayed as it was',
  keep: 'Kept as it was',
  'cant-settle': 'Not settled yet (logged as an open question)',
  note: 'Noted',
  assign: 'Taken up',
})

const MISSING_REASON = '—'

function commenterOf(entry) {
  const thread = asList(entry.threads)[0]
  return thread?.author || asList(entry.changes)[0]?.author || ''
}

// The comment as the commenter would recognise it: the text it was on, the comment, its replies and any tracked change, word for word.
function commentLines(entry) {
  const lines = []
  const thread = asList(entry.threads)[0]
  if (thread) {
    lines.push(`${thread.anchor ? `On “${squash(thread.anchor)}”: ` : ''}${squash(thread.text)}`)
    for (const reply of asList(thread.replies)) lines.push(`Reply from ${reply.author || 'a commenter'}: ${squash(reply.text)}`)
  }
  for (const change of asList(entry.changes)) lines.push(`Tracked change: ${change.kind === 'insertion' ? 'inserted' : 'deleted'} “${squash(change.text)}”`)
  return lines
}

// A comment answered "revise" or "accept" through the AI is only changed if the architect then took the new wording. When the log says they kept what was
// saved, saying "wording revised" to the commenter would be untrue.
function keptWhatWasSaved(entries, at, field) {
  if (!field) return false
  for (let i = at + 1; i < entries.length; i++) {
    const later = entries[i]
    if (later?.kind !== 'saved-content' || later.handEdit || asList(later.fields)[0] !== field) continue
    return later.choice === 'keep'
  }
  return false
}

function outcomeOf(entry, { author, kept, fieldTitle }) {
  switch (entry.outcome) {
    case 'accept':
      if (entry.accepted && author && entry.accepted !== author) return RESPONSE_OUTCOMES['accept-other']
      return kept ? RESPONSE_OUTCOMES['revise-kept'] : RESPONSE_OUTCOMES.accept
    case 'revise':
      return kept ? RESPONSE_OUTCOMES['revise-kept'] : RESPONSE_OUTCOMES.revise
    case 'assign': {
      const where = asList(entry.fields)[0]
      return `${RESPONSE_OUTCOMES.assign}${where ? ` on ${fieldTitle(where)}` : ''}${kept ? ' (the wording stayed as it was)' : ''}`
    }
    default:
      return RESPONSE_OUTCOMES[entry.outcome] ?? squash(entry.outcome)
  }
}

/**
 * The Review response list's rows from the Stages' decisions logs.
 *
 * @param {Record<string, object|null>|object[]} logs  each Stage's decisions log (`{ [stageId]: log }` or a list)
 * @param {object} [options]
 * @param {(key: string) => string} [options.fieldTitle]  a Field key (`module.field`) as the reader knows it
 * @param {(stageId: string) => string} [options.stageTitle]
 * @returns {{ copies: { id: string, name: string, rows: object[] }[], rows: object[] }}
 *   a row is `{ key, review, stage, field, comment, commenter, date, outcome, reason }`; `copies` groups them by Reviewed copy in the order each copy was first answered
 */
export function reviewResponseRows(logs, { fieldTitle = (key) => key, stageTitle = (id) => id } = {}) {
  const lists = Array.isArray(logs) ? logs.map((log) => [log?.stage ?? '', log]) : Object.entries(logs ?? {})
  const rows = []
  for (const [stageId, log] of lists) {
    const entries = asList(log?.entries)
    entries.forEach((entry, at) => {
      if (entry?.kind !== 'review-answered' || entry.replacedBy) return
      const author = commenterOf(entry)
      const field = asList(entry.fields)[0] ?? ''
      const kept = ['accept', 'revise', 'assign'].includes(entry.outcome) && keptWhatWasSaved(entries, at, field)
      rows.push({
        key: asList(entry.keys)[0] ?? entry.id ?? '',
        review: entry.review ?? '',
        reviewName: entry.reviewName ?? '',
        stage: entry.stage ?? log?.stage ?? stageId,
        stageTitle: stageTitle(entry.stage ?? log?.stage ?? stageId),
        field: field ? fieldTitle(field) : entry.about || 'The document as a whole',
        comment: commentLines(entry),
        commenter: author || 'A commenter',
        date: day(asList(entry.threads)[0]?.date ?? asList(entry.changes)[0]?.date),
        outcome: outcomeOf(entry, { author, kept, fieldTitle }),
        reason: squash(entry.words) || MISSING_REASON,
      })
    })
  }
  // A thread answered twice (a later session, a different Stage's log) is one row: the latest answer stands.
  const latest = new Map()
  for (const row of rows) latest.set(`${row.review}\u0000${row.key}`, row)
  const unique = rows.filter((row) => latest.get(`${row.review}\u0000${row.key}`) === row)
  const copies = []
  for (const row of unique) {
    let copy = copies.find((c) => c.id === row.review)
    if (!copy) copies.push((copy = { id: row.review, name: row.reviewName || 'Reviewed copy', rows: [] }))
    copy.rows.push(row)
  }
  return { copies, rows: unique }
}

/** True when the logs hold at least one answered comment, so there is a list to download. */
export const hasReviewResponses = (logs) => reviewResponseRows(logs).rows.length > 0

/** The file name: `<Instance name> - Review response list.docx`, with anything a file system dislikes tidied away. */
export function reviewResponseFilename(instanceName = '') {
  const base = String(instanceName ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${base ? `${base} - ` : ''}${REVIEW_RESPONSE_TITLE}.docx`
}

// ---------------------------------------------------------------------------------------------------- the Word document

const xml = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`
const paragraph = (text, { style = '', props = '' } = {}) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${text === '' ? '' : run(text, props)}</w:p>`

// Column widths in twentieths of a point, filling a landscape A4/Letter page between 0.7 inch margins.
const COLUMNS = [
  { title: 'Comment', width: 4300 },
  { title: 'Commenter', width: 1500 },
  { title: 'Where', width: 1900 },
  { title: 'Outcome', width: 2200 },
  { title: 'Reason', width: 3200 },
]

const BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`).join('')

function cell(lines, width, { header = false } = {}) {
  const content = (lines.length ? lines : ['']).map((line) => paragraph(line, { style: 'TableText', props: header ? '<w:b/>' : '' })).join('')
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="E7EEF7"/>' : ''}</w:tcPr>${content}</w:tc>`
}

function table(rows) {
  const head = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${COLUMNS.map((c) => cell([c.title], c.width, { header: true })).join('')}</w:tr>`
  const body = rows
    .map((row) => {
      const values = [row.comment, [row.commenter + (row.date ? ` (${row.date})` : '')], [row.field], [row.outcome], [row.reason]]
      return `<w:tr>${values.map((lines, i) => cell(lines, COLUMNS[i].width)).join('')}</w:tr>`
    })
    .join('')
  const widths = COLUMNS.reduce((n, c) => n + c.width, 0)
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths}" w:type="dxa"/><w:tblBorders>${BORDERS}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${COLUMNS.map((c) => `<w:gridCol w:w="${c.width}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
</w:styles>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

// A zip of stored (uncompressed) parts: a few kilobytes of XML, so deflating buys nothing and this needs no compression stream.
function storedZip(parts) {
  const encoder = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of parts) {
    const nameBytes = encoder.encode(name)
    const raw = encoder.encode(content)
    const crc = crc32(raw)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(12, 0x21, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, raw.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, raw.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local, raw)
    centrals.push(central)
    offset += local.length + raw.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, parts.length, true)
  ev.setUint16(10, parts.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...centrals, end]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const piece of all) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}

/**
 * The Review response list as a Word document: a title, who and when, and one table of comments for each Reviewed copy. Plain Word tables and styles, so
 * the architect can edit the wording before sending it. Returns the .docx bytes. Nothing about the Reviewed copy is changed or needed.
 *
 * @param {{ copies: { id: string, name: string, rows: object[] }[] }} list  `reviewResponseRows`' result
 * @param {object} [options]
 * @param {string} [options.instanceName]
 * @param {Date|string} [options.date]  when the list was made (shown as a day)
 */
export function reviewResponseDocx(list, { instanceName = '', date = new Date() } = {}) {
  const made = typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10)
  const total = list.copies.reduce((n, c) => n + c.rows.length, 0)
  const body = [
    paragraph(REVIEW_RESPONSE_TITLE, { style: 'Title' }),
    paragraph(`${instanceName ? `${instanceName}. ` : ''}${total} comment${total === 1 ? '' : 's'} answered. Made ${made}.`),
    ...list.copies.flatMap((copy) => [paragraph(copy.name, { style: 'Heading1' }), table(copy.rows)]),
    paragraph(''),
  ].join('')
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(REVIEW_RESPONSE_TITLE)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${made}T00:00:00Z</dcterms:created></cp:coreProperties>`
  return storedZip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', DOCUMENT_RELS],
    ['word/styles.xml', STYLES],
    ['docProps/core.xml', core],
  ])
}

/**
 * Hands `bytes` to the browser as a download (a Blob, an object URL and a synthetic click). Browser only; generating the list needs no network, and nothing
 * is kept anywhere afterwards.
 */
export function downloadBytes(bytes, filename, mimeType = REVIEW_RESPONSE_MIME) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Builds the list from the logs and downloads it. Returns the number of comments in it (0 when there was nothing to list, and no file is made). */
export function downloadReviewResponseList(logs, { instanceName = '', fieldTitle, stageTitle, download = downloadBytes, date } = {}) {
  const list = reviewResponseRows(logs, { fieldTitle, stageTitle })
  if (list.rows.length === 0) return 0
  download(reviewResponseDocx(list, { instanceName, ...(date ? { date } : {}) }), reviewResponseFilename(instanceName))
  return list.rows.length
}
