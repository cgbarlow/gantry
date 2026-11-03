// #302 (ADR-0066): Gantry's own reader for a **Reviewed copy** — a Word document Gantry rendered that has
// come back with someone's comments and tracked changes. It reads the Word XML directly, in the browser
// (and in Node, where the server checks an upload with the same code), because neither Pandoc nor
// officeparser gives back threads, resolved flags, or where a bookmark ends (docs/adr/0066, research on
// #250). Three jobs, each a plain function:
//
//   readReviewedCopy(bytes)             what the document says: its `gantry-*` Render properties, each comment
//                                       thread (with replies and resolved flag), each tracked change, and the
//                                       Field bookmarks every one of them overlaps
//   checkReviewedCopy(properties, ...)  whether it is one of this Instance's own renders, else why not
//   placeReview(read, ...)              which Field each thread and change sits on: from the Field bookmarks
//                                       when the document still has them, else by matching text against the
//                                       Fields' wording (Google Docs scrambles bookmark names)
//
// Nothing here writes: Gantry never edits a Reviewed copy or replies to its commenters (ADR-0066).
import { readPackageTexts } from './definitionLogo.js'
import { attribute, childElement, childElements, parseXml, textOf } from './ooxml.js'
import { baseFieldBookmark, fieldBookmarkName } from './fieldBookmark.js'

/** The most a Reviewed-copy upload may hold, in bytes (ADR-0066: 25 MB). */
export const REVIEWED_COPY_MAX_BYTES = 25 * 1024 * 1024

/** A file that cannot be read as a Word document. `code` is always `'not-word'`. */
export class ReviewedCopyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReviewedCopyError'
    this.code = 'not-word'
  }
}

const PARTS = new Set(['word/document.xml', 'word/comments.xml', 'word/commentsExtended.xml', 'docProps/custom.xml'])
const PROPERTY_PREFIX = 'gantry-'

// --- Reading the package -------------------------------------------------------------------------------------

function readProperties(customXml) {
  const properties = {}
  if (!customXml) return properties
  for (const property of childElements(parseXml(customXml), 'property')) {
    const name = attribute(property, 'name')
    if (!name?.startsWith(PROPERTY_PREFIX)) continue
    const value = textOf(property).trim()
    if (value !== '') properties[name.slice(PROPERTY_PREFIX.length)] = value
  }
  return properties
}

// The text of a comment: its paragraphs' `w:t` runs, one paragraph per line (a comment's own markup is
// otherwise irrelevant).
function commentTextOf(comment) {
  const runs = (node) => {
    if (typeof node === 'string') return ''
    if (node.name === 'w:t') return textOf(node)
    if (node.name === 'w:tab' || node.name === 'w:br') return ' '
    return node.children.map(runs).join('')
  }
  return childElements(comment, 'w:p').map(runs).join('\n').trim()
}

function readComments(commentsXml, extendedXml) {
  const comments = []
  if (!commentsXml) return comments
  for (const element of childElements(parseXml(commentsXml), 'w:comment')) {
    const paragraphs = childElements(element, 'w:p')
    comments.push({
      id: attribute(element, 'id'),
      author: attribute(element, 'author') ?? '',
      initials: attribute(element, 'initials') ?? '',
      date: attribute(element, 'date') ?? '',
      text: commentTextOf(element),
      // Word's comment-thread links key off the comment's last paragraph.
      paraId: paragraphs.length ? attribute(paragraphs[paragraphs.length - 1], 'paraId') : undefined,
    })
  }
  const extended = new Map()
  if (extendedXml) {
    for (const element of childElements(parseXml(extendedXml), 'w15:commentEx')) {
      const paraId = attribute(element, 'paraId')
      if (paraId) extended.set(paraId, { parent: attribute(element, 'paraIdParent'), done: attribute(element, 'done') })
    }
  }
  const byParaId = new Map(comments.filter((c) => c.paraId).map((c) => [c.paraId, c]))
  comments.forEach((comment, index) => {
    const link = comment.paraId ? extended.get(comment.paraId) : undefined
    comment.index = index
    comment.parent = link?.parent ? byParaId.get(link.parent) ?? null : null
    comment.done = link?.done === '1' || link?.done === 'true'
  })
  return comments
}

// --- Walking the document ------------------------------------------------------------------------------------

const SKIPPED = new Set(['w:pPr', 'w:rPr', 'w:trPr', 'w:tblPr', 'w:tcPr', 'w:sectPr', 'w:tblGrid', 'mc:Fallback'])
const normalStyle = (id) => String(id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const isHeadingStyle = (id) => /^heading\d?$/.test(normalStyle(id))
const DOCUMENT_CONTROL_HEADINGS = new Set(['document control', 'review & sign-off', 'review and sign-off', 'review sign-off'])

function addAll(list, names) {
  for (const name of names) if (!list.includes(name)) list.push(name)
}

function walkDocument(root) {
  const paragraphs = []
  const openBookmarks = new Map() // w:id -> field bookmark base name (only Gantry's own)
  const bookmarkCount = { all: 0, field: 0 }
  const openComments = new Map() // w:id -> range record
  const ranges = new Map() // w:id -> range record, every comment that has a place in the body
  const changeStack = []
  const changes = []
  const fieldStack = [] // complex fields: { toc }
  let tocSdt = 0
  let tableDepth = 0
  let sequence = 0
  let paragraph = null
  let sectionAbout = null

  const openFieldNames = () => [...openBookmarks.values()]
  const newRange = (id) => {
    const range = { id, order: sequence++, original: '', current: '', fields: [], paragraph: paragraph?.index ?? null, endParagraph: null }
    ranges.set(id, range)
    return range
  }
  const touch = () => {
    const names = openFieldNames()
    if (paragraph) addAll(paragraph.fields, names)
    for (const range of openComments.values()) addAll(range.fields, names)
    for (const change of changeStack) addAll(change.fields, names)
  }

  function emit(text, deleted) {
    if (text === '') return
    const inserted = changeStack.some((change) => change.kind === 'insertion')
    const isDeleted = deleted || changeStack.some((change) => change.kind === 'deletion')
    touch()
    if (paragraph) {
      if (!isDeleted) paragraph.current += text
      if (!inserted) paragraph.original += text
    }
    for (const range of openComments.values()) {
      if (!isDeleted) range.current += text
      if (!inserted) range.original += text
    }
    for (const change of changeStack) change.text += text
  }

  function startParagraph(node) {
    const properties = childElement(node, 'w:pPr')
    const style = attribute(childElement(properties ?? { children: [] }, 'w:pStyle'), 'val') ?? ''
    paragraph = {
      index: paragraphs.length,
      style,
      heading: isHeadingStyle(style),
      table: tableDepth > 0,
      original: '',
      current: '',
      fields: [],
      about: null,
      tocBefore: tocSdt > 0 || fieldStack.some((f) => f.toc),
    }
    paragraphs.push(paragraph)
    touch()
  }

  function endParagraph() {
    const p = paragraph
    const style = normalStyle(p.style)
    const text = p.original.trim().toLowerCase().replace(/\s+/g, ' ')
    if (p.heading) sectionAbout = DOCUMENT_CONTROL_HEADINGS.has(text) ? 'document-control' : null
    if (p.fields.length === 0) {
      if (style === 'title' || style === 'subtitle' || style.startsWith('cover')) p.about = 'cover'
      else if (style.startsWith('toc') || p.tocBefore || tocSdt > 0 || fieldStack.some((f) => f.toc)) p.about = 'table-of-contents'
      else if (sectionAbout === 'document-control') p.about = 'document-control'
    }
    for (const range of openComments.values()) {
      range.original += '\n'
      range.current += '\n'
    }
    paragraph = null
  }

  function visit(node) {
    if (typeof node === 'string') return
    const name = node.name
    if (SKIPPED.has(name)) return
    switch (name) {
      case 'w:p': {
        // A paragraph can hold another (a text box's), so the outer one is put back afterwards.
        const outer = paragraph
        startParagraph(node)
        node.children.forEach(visit)
        endParagraph()
        paragraph = outer
        return
      }
      case 'w:t':
        emit(textOf(node), false)
        return
      case 'w:delText':
        emit(textOf(node), true)
        return
      case 'w:tab':
      case 'w:br':
      case 'w:cr':
        emit(' ', false)
        return
      case 'w:instrText': {
        const top = fieldStack[fieldStack.length - 1]
        if (top && /^\s*TOC\b/.test(textOf(node))) top.toc = true
        return
      }
      case 'w:fldChar': {
        const type = attribute(node, 'fldCharType')
        if (type === 'begin') fieldStack.push({ toc: false })
        else if (type === 'end') fieldStack.pop()
        return
      }
      case 'w:fldSimple':
        fieldStack.push({ toc: /^\s*TOC\b/.test(attribute(node, 'instr') ?? '') })
        node.children.forEach(visit)
        fieldStack.pop()
        return
      case 'w:bookmarkStart': {
        bookmarkCount.all++
        const base = baseFieldBookmark(attribute(node, 'name'))
        if (base) {
          bookmarkCount.field++
          openBookmarks.set(attribute(node, 'id'), base)
          touch()
        }
        return
      }
      case 'w:bookmarkEnd':
        openBookmarks.delete(attribute(node, 'id'))
        return
      case 'w:commentRangeStart': {
        const id = attribute(node, 'id')
        const range = newRange(id)
        openComments.set(id, range)
        addAll(range.fields, openFieldNames())
        return
      }
      case 'w:commentRangeEnd': {
        const id = attribute(node, 'id')
        const range = openComments.get(id)
        if (range) {
          addAll(range.fields, openFieldNames())
          range.endParagraph = paragraph?.index ?? range.paragraph
          openComments.delete(id)
        }
        return
      }
      case 'w:commentReference': {
        const id = attribute(node, 'id')
        // A comment with no range (only a reference) is a point: it sits where the reference does.
        const range = ranges.get(id) ?? newRange(id)
        if (!range.endParagraph) range.endParagraph = paragraph?.index ?? range.paragraph
        addAll(range.fields, openFieldNames())
        return
      }
      case 'w:ins':
      case 'w:del':
      case 'w:moveTo':
      case 'w:moveFrom': {
        const change = {
          id: attribute(node, 'id'),
          kind: name === 'w:ins' || name === 'w:moveTo' ? 'insertion' : 'deletion',
          moved: name.startsWith('w:move'),
          author: attribute(node, 'author') ?? '',
          date: attribute(node, 'date') ?? '',
          text: '',
          fields: [],
          paragraph: paragraph?.index ?? null,
          order: sequence++,
        }
        addAll(change.fields, openFieldNames())
        changeStack.push(change)
        node.children.forEach(visit)
        changeStack.pop()
        if (change.text.trim() !== '') changes.push(change)
        return
      }
      case 'w:tbl':
        tableDepth++
        node.children.forEach(visit)
        tableDepth--
        return
      case 'w:sdt': {
        const gallery = attribute(childElement(childElement(childElement(node, 'w:sdtPr') ?? { children: [] }, 'w:docPartObj') ?? { children: [] }, 'w:docPartGallery') ?? {}, 'val')
        const toc = /table of contents/i.test(gallery ?? '')
        if (toc) tocSdt++
        node.children.forEach(visit)
        if (toc) tocSdt--
        return
      }
      case 'mc:AlternateContent': {
        const choice = childElement(node, 'mc:Choice')
        if (choice) visit(choice)
        else node.children.forEach(visit)
        return
      }
      default:
        node.children.forEach(visit)
    }
  }

  const body = childElement(root, 'w:body') ?? root
  visit(body)
  return { paragraphs, ranges, changes, bookmarkCount }
}

// --- Putting it together -------------------------------------------------------------------------------------

function trimAnchor(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function hostRegion(paragraphs, from, to) {
  if (from === null || from === undefined) return null
  const last = to ?? from
  for (let i = from; i <= last && i < paragraphs.length; i++) if (!paragraphs[i].about) return null
  return paragraphs[from]?.about ?? null
}

// A comment or change on a template heading belongs to the Field under it: the first Field bookmark after
// the heading, before the next heading (research #250, "Template heading").
function fieldUnderHeading(paragraphs, index) {
  if (index === null || index === undefined || !paragraphs[index]?.heading) return null
  for (let i = index + 1; i < paragraphs.length; i++) {
    if (paragraphs[i].heading) return null
    if (paragraphs[i].fields.length) return paragraphs[i].fields[0]
  }
  return null
}

/**
 * Reads a Reviewed copy. `bytes` is the .docx. Returns
 *
 *   {
 *     properties,           the `gantry-*` Render properties, keyed without the prefix ({ instance, artefact, stage, definition, commit, 'render-id' })
 *     fieldBookmarks,       how many Gantry Field bookmarks the document still has (0 when Google Docs renamed them)
 *     threads, changes, paragraphs, commenters, commentCount
 *   }
 *
 * A thread is `{ id, author, date, text, resolved, replies: [{ id, author, date, text }], anchor: { text,
 * original }, fields, about, paragraph, onHeading, order }`: `fields` are the Field bookmarks (by base name)
 * its range overlaps, in document order, and `about` is `'cover'`, `'document-control'` or
 * `'table-of-contents'` for a comment on a part of the document Gantry supplies. A change is `{ kind:
 * 'insertion' | 'deletion', author, date, text, fields, about, paragraph }`.
 *
 * Throws `ReviewedCopyError` for a file that is not a Word document.
 */
export async function readReviewedCopy(bytes) {
  let parts
  try {
    parts = await readPackageTexts(new Uint8Array(bytes), (name) => PARTS.has(name))
  } catch {
    throw new ReviewedCopyError('This file is not a Word (.docx) document.')
  }
  if (!parts.has('word/document.xml')) throw new ReviewedCopyError('This file is not a Word (.docx) document.')
  let walked
  let comments
  let properties
  try {
    properties = readProperties(parts.get('docProps/custom.xml'))
    comments = readComments(parts.get('word/comments.xml'), parts.get('word/commentsExtended.xml'))
    walked = walkDocument(parseXml(parts.get('word/document.xml')))
  } catch {
    throw new ReviewedCopyError('This file is not a readable Word (.docx) document.')
  }
  const { paragraphs, ranges, bookmarkCount } = walked

  const rangeOf = (comment) => ranges.get(comment.id)
  const isRoot = (comment) => !comment.parent
  const rootOf = (comment) => {
    let current = comment
    const seen = new Set()
    while (current.parent && !seen.has(current)) {
      seen.add(current)
      current = current.parent
    }
    return current
  }

  const threads = []
  for (const root of comments.filter(isRoot)) {
    const members = comments.filter((c) => c === root || rootOf(c) === root)
    const replies = members.filter((c) => c !== root)
    // The thread sits where its root does; a root with no place in the body borrows its first reply's.
    const range = rangeOf(root) ?? replies.map(rangeOf).find(Boolean)
    if (!range) continue
    const about = range.fields.length ? null : hostRegion(paragraphs, range.paragraph, range.endParagraph)
    const heading = !range.fields.length && !about && range.paragraph !== null && paragraphs[range.paragraph]?.heading
    const underHeading = heading ? fieldUnderHeading(paragraphs, range.paragraph) : null
    threads.push({
      id: root.id,
      author: root.author,
      initials: root.initials,
      date: root.date,
      text: root.text,
      resolved: members.some((c) => c.done),
      replies: replies.map((c) => ({ id: c.id, author: c.author, date: c.date, text: c.text })),
      anchor: { text: trimAnchor(range.current), original: trimAnchor(range.original) },
      fields: range.fields.length ? range.fields : underHeading ? [underHeading] : [],
      onHeading: Boolean(heading) && !range.fields.length,
      about,
      paragraph: range.paragraph,
      order: range.order,
    })
  }
  threads.sort((a, b) => a.order - b.order)

  const changes = walked.changes
    .map((change) => {
      const about = change.fields.length ? null : hostRegion(paragraphs, change.paragraph, change.paragraph)
      return { ...change, text: trimAnchor(change.text), about }
    })
    .sort((a, b) => a.order - b.order)

  const commenters = [...new Set([...comments.map((c) => c.author), ...changes.map((c) => c.author)].map((name) => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return { properties, fieldBookmarks: bookmarkCount.field, threads, changes, paragraphs, commenters, commentCount: comments.length }
}

// --- Is it one of ours? --------------------------------------------------------------------------------------

function whereFrom(properties) {
  const parts = [`Instance "${properties.instance}"`]
  if (properties.artefact) parts.push(`Artefact "${properties.artefact}"`)
  if (properties.stage) parts.push(`Stage "${properties.stage}"`)
  return parts.join(', ')
}

/**
 * Whether a document with these Render `properties` (what `readReviewedCopy` returns) is one of this
 * Instance's own renders. `expected` is `{ slug, definition, artefactIds, stageIds }`. Returns `{ ok: true }`
 * or `{ ok: false, code, message }` with `code` `'untagged'`, `'other-instance'` or `'other-artefact'`.
 */
export function checkReviewedCopy(properties, expected) {
  if (!properties?.instance || !properties['render-id']) {
    return {
      ok: false,
      code: 'untagged',
      message:
        "This document wasn't rendered by Gantry: it has none of the gantry-* properties a Gantry render carries. Upload it as a Source document instead.",
    }
  }
  const definitionId = String(properties.definition ?? '').split('@')[0]
  if (properties.instance !== expected.slug || (definitionId && expected.definition && definitionId !== expected.definition)) {
    return {
      ok: false,
      code: 'other-instance',
      message: `This document was rendered from ${whereFrom(properties)}${definitionId ? ` (Definition "${definitionId}")` : ''}, not from "${expected.slug}". Bring it in to that Instance instead.`,
    }
  }
  // `artefactIds` left out means the caller can't list every Artefact (the editor knows only the stage in view); the server checks.
  if (properties.artefact && expected.artefactIds && !expected.artefactIds.includes(properties.artefact)) {
    return {
      ok: false,
      code: 'other-artefact',
      message: `This document was rendered from ${whereFrom(properties)}, but "${expected.slug}" has no Artefact "${properties.artefact}".`,
    }
  }
  return { ok: true }
}

// --- Which Field is each comment on? -------------------------------------------------------------------------

/**
 * The index `placeReview` looks Fields up in: `fields` is `[{ moduleId, moduleTitle, fieldId, fieldTitle }]` in
 * Definition order. Returns a Map of Field bookmark base name to that entry plus its `order`.
 */
export function buildFieldIndex(fields) {
  const index = new Map()
  fields.forEach((field, order) => index.set(fieldBookmarkName(field.moduleId, field.fieldId), { ...field, order }))
  return index
}

/** The wording of Markdown as a reader sees it: no emphasis marks, link targets, bullets or table pipes. */
export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[^\n]*\n?/g, '\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*_`~|]/g, ' ')
}

function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const TEXT_MATCH_MIN = 3

function createTextMatcher(basisFields) {
  const fields = basisFields.map((field) => {
    const text = normalise(plainText(Array.isArray(field.text) ? field.text.join('\n') : field.text))
    return { field, text: ` ${text} `, words: new Set(text.split(' ').filter((w) => w.length >= 4)) }
  })
  const containing = (needle) => {
    const n = normalise(needle)
    if (n.length < TEXT_MATCH_MIN) return []
    return fields.filter((entry) => entry.text.includes(` ${n} `))
  }
  return (item, paragraphs) => {
    const pieces = String(item.original ?? '')
      .split('\n')
      .map((piece) => piece.trim())
      .filter((piece) => normalise(piece).length >= TEXT_MATCH_MIN)
      .sort((a, b) => b.length - a.length)
    const paragraph = item.paragraph !== null && item.paragraph !== undefined ? paragraphs[item.paragraph] : null
    const candidates = [...pieces]
    const paragraphText = paragraph ? trimAnchor(paragraph.original) : ''
    if (paragraphText && !candidates.includes(paragraphText)) candidates.push(paragraphText)
    for (const candidate of candidates) {
      const found = containing(candidate)
      if (found.length === 1) return { field: found[0].field, confidence: 'high' }
      if (found.length > 1) return { field: found[0].field, confidence: 'low', alsoFields: found.slice(1).map((entry) => entry.field) }
    }
    // Reworded text (an untracked edit, or a Field changed since the render): most of the paragraph's words.
    const words = paragraphText ? [...new Set(normalise(paragraphText).split(' ').filter((w) => w.length >= 4))] : []
    if (words.length >= 3) {
      let best = null
      let bestScore = 0
      let second = 0
      for (const entry of fields) {
        const score = words.filter((w) => entry.words.has(w)).length / words.length
        if (score > bestScore) {
          second = bestScore
          bestScore = score
          best = entry
        } else if (score > second) {
          second = score
        }
      }
      if (best && bestScore >= 0.7 && bestScore - second >= 0.2) return { field: best.field, confidence: 'low' }
    }
    // Text a commenter added whole (an inserted paragraph) is in none of the Fields: it goes with the
    // paragraph above it, if that one is a Field's.
    if (item.neighbours && item.paragraph !== null && item.paragraph !== undefined) {
      for (let i = item.paragraph - 1; i >= Math.max(0, item.paragraph - 3); i--) {
        const above = trimAnchor(paragraphs[i]?.original ?? '')
        if (!above) continue
        const found = containing(above)
        if (found.length) return { field: found[0].field, confidence: 'low' }
        break
      }
    }
    return null
  }
}

const ABOUT_TITLES = {
  cover: 'the cover page',
  'document-control': 'Document Control',
  'table-of-contents': 'the table of contents',
}

function refOf(field) {
  return { moduleId: field.moduleId, moduleTitle: field.moduleTitle, fieldId: field.fieldId, fieldTitle: field.fieldTitle }
}

/**
 * Places every thread and tracked change of `read` on a Field, in a document of their own ("about the
 * document", for the cover, Document Control and table of contents Gantry supplies) or, failing that, in
 * "couldn't be placed". `options.fieldIndex` is `buildFieldIndex(...)`; `options.basis` is `{ basis:
 * 'commit' | 'today', commit, fields: [{ moduleId, fieldId, moduleTitle, fieldTitle, text }] }` — the wording
 * the document was rendered from, for placing by text when the bookmarks are gone.
 *
 * Returns `{ mode, notice, groups, placedByText }`. `mode` is `'bookmarks'`, `'text'` (the document has no
 * Gantry Field bookmarks left), `'mixed'` or `'none'` (nothing to place). `groups` is a list in Definition
 * order of `{ kind: 'field', field, threads, changes }`, followed by `{ kind: 'document', threads, changes }`
 * and `{ kind: 'unplaced', threads, changes }` when they have anything. Each thread and change carries a
 * `placement`: `{ method: 'bookmark' | 'heading' | 'text', confidence, alsoFields }`.
 */
export function placeReview(read, { fieldIndex, basis } = {}) {
  const index = fieldIndex ?? new Map()
  const matcher = basis?.fields?.length ? createTextMatcher(basis.fields) : null
  const textBasis = basis?.basis === 'commit' ? `the content as it was at commit ${String(basis.commit ?? '').slice(0, 7)}` : "today's content"
  const byField = new Map()
  const document = { kind: 'document', threads: [], changes: [] }
  const unplaced = { kind: 'unplaced', threads: [], changes: [] }
  let byBookmark = 0
  let byText = 0

  const slotFor = (field) => {
    const key = `${field.moduleId}/${field.fieldId}`
    if (!byField.has(key)) byField.set(key, { kind: 'field', field: refOf(field), order: field.order ?? Number.MAX_SAFE_INTEGER, threads: [], changes: [] })
    return byField.get(key)
  }

  const add = (item, key) => {
    const isThread = key === 'thread'
    const list = (group) => (isThread ? group.threads : group.changes)
    // Resolve the Field.
    const bookmarkField = item.fields.map((name) => index.get(name)).find(Boolean)
    if (bookmarkField) {
      const others = item.fields.map((name) => index.get(name)).filter((f) => f && f !== bookmarkField)
      const placed = { ...item, placement: { method: item.onHeading ? 'heading' : 'bookmark', confidence: 'high', alsoFields: others.map(refOf) } }
      byBookmark++
      list(slotFor(bookmarkField)).push(placed)
      return
    }
    if (item.about) {
      list(document).push({ ...item, placement: { method: 'region', confidence: 'high', alsoFields: [], about: item.about, aboutTitle: ABOUT_TITLES[item.about] } })
      return
    }
    // Bookmarks missing (Google Docs), or a bookmark for a Field this Definition no longer has: by text.
    const textItem = isThread ? { original: item.anchor.original, paragraph: item.paragraph } : { original: item.text, paragraph: item.paragraph, neighbours: item.kind === 'insertion' }
    const match = matcher ? matcher(textItem, read.paragraphs) : null
    if (match) {
      const field = index.get(fieldBookmarkName(match.field.moduleId, match.field.fieldId)) ?? { ...match.field, order: Number.MAX_SAFE_INTEGER }
      byText++
      const placed = { ...item, placement: { method: 'text', confidence: match.confidence, alsoFields: (match.alsoFields ?? []).map(refOf) } }
      list(slotFor(field)).push(placed)
      return
    }
    list(unplaced).push({ ...item, placement: { method: 'none', confidence: 'none', alsoFields: [] } })
  }

  for (const thread of read.threads) add(thread, 'thread')
  for (const change of read.changes) add(change, 'change')

  const groups = [...byField.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...group }) => group)
  if (document.threads.length || document.changes.length) groups.push(document)
  if (unplaced.threads.length || unplaced.changes.length) groups.push(unplaced)

  let notice = null
  const nothing = read.threads.length === 0 && read.changes.length === 0
  if (byText > 0) {
    notice = `The Field bookmarks were lost in this copy (Google Docs, for one, renames them), so Gantry placed ${byText} ${byText === 1 ? 'item' : 'items'} by matching their text against ${textBasis}. Items marked "best guess" matched more than one Field or only loosely.`
  } else if (unplaced.threads.length + unplaced.changes.length > 0 && read.fieldBookmarks === 0 && !matcher) {
    notice = "The Field bookmarks were lost in this copy and Gantry couldn't read the content to match its text against, so these couldn't be placed."
  }
  return {
    mode: nothing ? 'none' : byText === 0 ? 'bookmarks' : byBookmark === 0 ? 'text' : 'mixed',
    notice,
    groups,
    placedByText: byText,
  }
}

/** A one-line summary of a Reviewed copy for a list: "3 threads and 2 tracked changes from Ana and Ben". */
export function summariseReview(read) {
  const threads = read.threads.length
  const changes = read.changes.length
  const parts = []
  parts.push(`${threads} ${threads === 1 ? 'comment thread' : 'comment threads'}`)
  if (changes) parts.push(`${changes} tracked ${changes === 1 ? 'change' : 'changes'}`)
  const who = read.commenters.length ? ` from ${read.commenters.join(', ')}` : ''
  return parts.join(' and ') + who
}
