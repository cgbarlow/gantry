import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { fieldBookmarkName } from '../../web/lib/fieldBookmark.js'

// #302 (ADR-0066): Reviewed copies for tests, built as the two kinds of file that come back: one saved by
// Word (bookmarks named as Gantry wrote them, comment threads linked in `commentsExtended.xml`, a resolved
// flag) and one exported from Google Docs (every bookmark renamed to a random id and collapsed to a point,
// no `commentsExtended.xml`, a resolved thread dropped), after the research on #250. The document is
// shaped as a Gantry render is: a cover, Document Control, a table of contents, then headings with a Field
// printed under each.

export function xml(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? values[i] : ''), '')
}

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A .docx (any zip) from `{ 'path/in/zip': text | bytes }`, stored without compression unless `compress`. */
export function zip(parts, { compress = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(parts)) {
    const raw = Buffer.isBuffer(content) || content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(content, 'utf8')
    const data = compress ? deflateRawSync(raw) : raw
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(compress ? 8 : 0, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(compress ? 8 : 0, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(parts).length, 8)
  end.writeUInt16LE(Object.keys(parts).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** Every part of a zip as `{ name: Buffer }` (stored or deflated entries). */
export function unzip(bytes) {
  const buffer = Buffer.from(bytes)
  let eocd = buffer.length - 22
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const parts = {}
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10)
    const size = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const data = buffer.subarray(start, start + size)
    parts[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return parts
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

/** The `gantry-*` custom properties part, as Pandoc writes it. */
export function customProperties(properties) {
  const entries = Object.entries(properties).filter(([, v]) => v !== undefined)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${entries
    .map(([key, value], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="gantry-${esc(key)}"><vt:lpwstr>${esc(value)}</vt:lpwstr></property>`)
    .join('')}</Properties>`
}

export const RENDER_PROPERTIES = {
  instance: 'acme',
  artefact: 'hld',
  stage: 'shape',
  definition: 'design@3',
  commit: 'abc1234def5678abc1234def5678abc1234def5',
  'render-id': '6f1c2d3e-0000-4000-8000-000000000001',
}

// The Fields in the fixture, with the wording each prints.
export const FIELDS = [
  { moduleId: 'background', moduleTitle: 'Background and context', fieldId: 'problem', fieldTitle: 'Problem statement', text: 'We need a new payments platform.\n\nIt must support card schemes.' },
  { moduleId: 'background', moduleTitle: 'Background and context', fieldId: 'opportunity', fieldTitle: 'Opportunity', text: 'Reduce cost per transaction.' },
  { moduleId: 'background', moduleTitle: 'Background and context', fieldId: 'success-criteria', fieldTitle: 'Success criteria', text: 'Payments Engineering' },
]
export const bookmarkOf = (field) => fieldBookmarkName(field.moduleId, field.fieldId)
const [PROBLEM, OPPORTUNITY, SUCCESS] = FIELDS.map(bookmarkOf)
export { PROBLEM, OPPORTUNITY, SUCCESS }

const run = (text) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
const para = (inner, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`
const range = (id, inner) => `<w:commentRangeStart w:id="${id}"/>${inner}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`
const AUTHOR = { ana: 'Ana Reviewer', ben: 'Ben Commenter' }
const date = (d) => `2026-11-0${d}T10:00:00Z`

function commentsXml(comments) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NS}>${comments
    .map(
      ({ id, author, day, text, paraId }) =>
        `<w:comment w:id="${id}" w:author="${esc(author)}" w:date="${date(day)}" w:initials="${author.split(' ').map((w) => w[0]).join('')}"><w:p w14:paraId="${paraId}"><w:r><w:annotationRef/></w:r><w:r><w:t>${esc(text)}</w:t></w:r></w:p></w:comment>`
    )
    .join('')}</w:comments>`
}

/**
 * A Reviewed copy. `kind` is `'word'` (as Word saves it) or `'google'` (as Google Docs exports it).
 * `properties` are the `gantry-*` properties (default: this Instance's HLD render); `bookmarks: false`
 * leaves the Field bookmarks out entirely.
 *
 * The threads in it (by `text`): "Which card schemes?" on part of Problem with Ben's reply, resolved in
 * Word; "Say who signs this off" spanning from the end of Problem into Opportunity; a point comment with no
 * range on Opportunity; "Rename to Purpose" on the Background heading; "Put the date on the cover" on the cover
 * title; "Is this the right version?" in Document Control; "Why is this here?" on the table of contents;
 * and "Add the team" on Success criteria. Tracked changes: "must" deleted and "should" inserted in Problem (Ana), and
 * a paragraph Ben inserted at the end of Opportunity.
 */
export function reviewedCopy({ kind = 'word', properties = RENDER_PROPERTIES, bookmarks = true } = {}) {
  const word = kind === 'word'
  let nextBookmark = 10
  let scrambled = 0
  // A Word bookmark keeps its name and range; Google Docs gives it a random name and collapses it to a point.
  const bookmarkStart = (name) => {
    if (!bookmarks) return { open: '', close: '' }
    const id = nextBookmark++
    if (word) return { open: `<w:bookmarkStart w:id="${id}" w:name="${name}"/>`, close: `<w:bookmarkEnd w:id="${id}"/>` }
    return { open: `<w:bookmarkStart w:id="${id}" w:name="al${(++scrambled).toString(36).padStart(2, '0')}x${id}q9z"/><w:bookmarkEnd w:id="${id}"/>`, close: '' }
  }
  const problem = bookmarkStart(PROBLEM)
  const opportunity = bookmarkStart(OPPORTUNITY)
  const success = bookmarkStart(SUCCESS)

  const body = [
    // The cover: Title and Subtitle styles, which Gantry supplies.
    para(range(5, run('Acme Payments')), 'Title'),
    para(run('High Level Design'), 'Subtitle'),
    para(run('Document Control'), 'Heading2'),
    `<w:tbl><w:tr><w:tc>${para(run('Version'))}</w:tc><w:tc>${para(range(6, run('1.0')))}</w:tc></w:tr></w:tbl>`,
    para(run('Table of Contents'), 'TOCHeading'),
    para(range(7, run('Background ........ 1')), 'TOC1'),
    // The template's own heading, then the Field printed under it.
    para(range(8, run('Background')), 'Heading1'),
    problem.open,
    para(run('We need a ') + range(0, run('new payments platform')) + run('.')),
    para(
      run('It ') +
        `<w:del w:id="101" w:author="${AUTHOR.ana}" w:date="${date(3)}"><w:r><w:delText>must</w:delText></w:r></w:del>` +
        `<w:ins w:id="102" w:author="${AUTHOR.ana}" w:date="${date(3)}"><w:r><w:t>should</w:t></w:r></w:ins>` +
        run(' support ') +
        `<w:commentRangeStart w:id="2"/>` +
        run('card schemes.')
    ),
    problem.close,
    para(run('Opportunity'), 'Heading2'),
    opportunity.open,
    para(`<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r>` + run('Reduce cost per transaction.') + `<w:r><w:commentReference w:id="3"/></w:r>`),
    para(`<w:ins w:id="103" w:author="${AUTHOR.ben}" w:date="${date(4)}"><w:r><w:t>Improve settlement speed.</w:t></w:r></w:ins>`),
    opportunity.close,
    para(run('Success criteria'), 'Heading2'),
    success.open,
    para(range(4, run('Payments Engineering'))),
    success.close,
    '<w:sectPr/>',
  ].join('')

  // Word: threads linked through commentsExtended (a reply's parent, a resolved flag).
  const comments = [
    { id: 0, author: AUTHOR.ana, day: 3, text: 'Which card schemes?', paraId: '10000001' },
    { id: 1, author: AUTHOR.ben, day: 4, text: 'Visa and Mastercard.', paraId: '10000002' },
    { id: 2, author: AUTHOR.ben, day: 4, text: 'Say who signs this off', paraId: '10000003' },
    { id: 3, author: AUTHOR.ana, day: 3, text: 'Point comment with no range', paraId: '10000004' },
    { id: 4, author: AUTHOR.ben, day: 4, text: 'Add the team', paraId: '10000005' },
    { id: 5, author: AUTHOR.ana, day: 3, text: 'Put the date on the cover', paraId: '10000006' },
    { id: 6, author: AUTHOR.ana, day: 3, text: 'Is this the right version?', paraId: '10000007' },
    { id: 7, author: AUTHOR.ben, day: 4, text: 'Why is this here?', paraId: '10000008' },
    { id: 8, author: AUTHOR.ana, day: 3, text: 'Rename to Purpose', paraId: '10000009' },
  ]
  // The reply (id 1) shares its parent's range, as Word writes it.
  const withReplyRange = body.replace(
    range(0, run('new payments platform')),
    `<w:commentRangeStart w:id="1"/>${range(0, run('new payments platform'))}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>`
  )

  const parts = {
    '[Content_Types].xml': CONTENT_TYPES,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${withReplyRange}</w:body></w:document>`,
    'docProps/custom.xml': customProperties(properties),
  }
  if (word) {
    parts['word/comments.xml'] = commentsXml(comments)
    parts['word/commentsExtended.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx ${NS}><w15:commentEx w15:paraId="10000001" w15:done="1"/><w15:commentEx w15:paraId="10000002" w15:paraIdParent="10000001" w15:done="1"/><w15:commentEx w15:paraId="10000003" w15:done="0"/><w15:commentEx w15:paraId="10000004" w15:done="0"/><w15:commentEx w15:paraId="10000005" w15:done="0"/><w15:commentEx w15:paraId="10000006" w15:done="0"/><w15:commentEx w15:paraId="10000007" w15:done="0"/><w15:commentEx w15:paraId="10000008" w15:done="0"/><w15:commentEx w15:paraId="10000009" w15:done="0"/></w15:commentsEx>`
  } else {
    // Google Docs dropped the resolved thread (the parent and its reply), kept the rest, and wrote no links.
    parts['word/comments.xml'] = commentsXml(comments.filter((c) => c.id !== 0 && c.id !== 1))
    parts['word/document.xml'] = parts['word/document.xml']
      .replace(/<w:commentRangeStart w:id="[01]"\/>/g, '')
      .replace(/<w:commentRangeEnd w:id="[01]"\/>/g, '')
      .replace(/<w:r><w:commentReference w:id="[01]"\/><\/w:r>/g, '')
  }
  return zip(parts)
}
