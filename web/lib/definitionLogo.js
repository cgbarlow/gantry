// #222 (docs/adr/0059): a Definition's **logo** — the picture in its reference documents' page
// header (design v3's is the Contoso logo, in every one of its seven reference documents). The
// Definitions page's Logo control reads it from, and writes a new one into, every reference
// document of a draft in one go. The logo lives in the reference documents themselves, as ADR-0056
// keeps every other part of a document's look: nothing here is consulted at render time, so a
// reference document uploaded later under **Reference docx** simply carries whatever logo it has.
//
// The logo is found by where it is, not by what it is called: every picture drawing (an inline or
// anchored `pic:pic` with an embedded `a:blip`) in a header part is the logo. Replacing it points
// each such picture's image relationship at the new image and fits the new image, at its own
// proportions, inside the box the picture takes up in the header. Everything else in the package
// is copied byte for byte. `replaceHeaderLogo` takes one document's bytes and returns new ones, so
// it applies equally to a copy of a reference document that is never written back.
//
// Pure and dependency-free, and asynchronous only because it uses the platform's
// (De)CompressionStream, so it runs unchanged in Node (lib/definition.js, for the server's
// Definitions page) and in the browser (web/lib/localDefinitionFiles.js, for a Local Workspace's
// Definition editor), as web/lib/targetSize.js does.

/** The alt text a replaced logo carries: it names the organisation's logo, never the sample one. */
export const LOGO_ALT_TEXT = 'Organisation logo'

/** `reference.docx` and every `reference-<artefact>.docx`: the files a Definition's look lives in. */
export const REFERENCE_DOCX_NAME_RE = /^reference(-[^/\\]+)?\.docx$/

// The rendered box of a replaced logo is recorded beside it, so replacing it again fits the next
// logo into the header's original space rather than into the previous logo's proportions. An
// `a:extLst` extension is ignorable by definition (ISO/IEC 29500-1 §20.1.2.2.15): a reader that
// doesn't know the URI skips it. Uploading a reference document saved by Word starts again from
// whatever box that document's picture has.
const LOGO_BOX_EXTENSION_URI = '{6C2B4C2E-7D35-4E5B-9B8A-2D3F1C9E0A22}'
const LOGO_BOX_NS = 'urn:gantry:definition-logo'

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PICTURE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const HEADER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'
const HEADER_PART_RE = /^word\/header\d*\.xml$/

/** Reference documents in the order the Logo control reads them: the shared one first, then each Artefact's. */
export function sortReferenceDocxNames(names) {
  return [...names].filter((n) => REFERENCE_DOCX_NAME_RE.test(n)).sort((a, b) => (a === 'reference.docx' ? -1 : b === 'reference.docx' ? 1 : a.localeCompare(b)))
}

// ---------------------------------------------------------------------------------------- images

/**
 * What a logo upload is, read from its bytes (never its name or declared type): `{ contentType,
 * extension, width, height }` for a PNG or JPEG with a readable size, or `null` for anything else.
 */
export function logoImageInfo(bytes) {
  if (!bytes || bytes.length < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.every((b, i) => bytes[i] === b)) {
    // The IHDR chunk always comes first: its width and height follow the chunk's length and type.
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0 && height > 0 ? { contentType: 'image/png', extension: 'png', width, height } : null
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the marker segments to the first start-of-frame, which holds the image's size.
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]
      if (marker === 0xff) { offset += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const length = view.getUint16(offset + 2)
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        const height = view.getUint16(offset + 5)
        const width = view.getUint16(offset + 7)
        return width > 0 && height > 0 ? { contentType: 'image/jpeg', extension: 'jpeg', width, height } : null
      }
      if (marker === 0xd9 || marker === 0xda) return null
      offset += 2 + length
    }
    return null
  }
  return null
}

/** The message a logo upload that isn't a usable PNG or JPEG is refused with, or `null` when it is one. */
export function logoImageProblem(bytes) {
  return logoImageInfo(bytes) ? null : 'The logo must be a PNG or JPEG image.'
}

// ------------------------------------------------------------------------------------- zip parts

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer())
}

// A .docx's entries, from its central directory: each with its raw (still compressed) data, so an
// entry this module doesn't change is written back exactly as it was. Throws on anything that
// isn't a readable zip, and on ZIP64, which a reference document never needs.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a zip archive')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  const decoder = new TextDecoder()
  const entries = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Malformed zip central directory')
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const local = view.getUint32(offset + 42, true)
    if (compressedSize === 0xffffffff || local === 0xffffffff) throw new Error('ZIP64 archives are not supported')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      nameBytes: bytes.subarray(offset + 46, offset + 46 + nameLength),
      versionMadeBy: view.getUint16(offset + 4, true),
      flags: view.getUint16(offset + 8, true) & ~0x0008,
      method: view.getUint16(offset + 10, true),
      time: view.getUint16(offset + 12, true),
      date: view.getUint16(offset + 14, true),
      crc: view.getUint32(offset + 16, true),
      size: view.getUint32(offset + 24, true),
      internalAttributes: view.getUint16(offset + 36, true),
      externalAttributes: view.getUint32(offset + 38, true),
      data: bytes.subarray(start, start + compressedSize),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function entryBytes(entry) {
  if (entry.method === 0) return entry.data
  if (entry.method === 8) return transform(entry.data, new DecompressionStream('deflate-raw'))
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`)
}

async function entryText(entry) {
  return new TextDecoder().decode(await entryBytes(entry))
}

// A new entry for `name` holding `content` (text or bytes), deflated, keeping `like`'s metadata
// when it replaces an existing entry.
async function newEntry(name, content, like) {
  const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content
  const nameBytes = new TextEncoder().encode(name)
  return {
    name,
    nameBytes,
    versionMadeBy: like?.versionMadeBy ?? 20,
    flags: (like?.flags ?? 0) | 0x0800,
    method: 8,
    time: like?.time ?? 0,
    date: like?.date ?? 0x21,
    crc: crc32(raw),
    size: raw.length,
    internalAttributes: like?.internalAttributes ?? 0,
    externalAttributes: like?.externalAttributes ?? 0,
    data: await transform(raw, new CompressionStream('deflate-raw')),
  }
}

function writeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const local = new Uint8Array(30 + e.nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, e.flags, true)
    lv.setUint16(8, e.method, true)
    lv.setUint16(10, e.time, true)
    lv.setUint16(12, e.date, true)
    lv.setUint32(14, e.crc, true)
    lv.setUint32(18, e.data.length, true)
    lv.setUint32(22, e.size, true)
    lv.setUint16(26, e.nameBytes.length, true)
    local.set(e.nameBytes, 30)
    const central = new Uint8Array(46 + e.nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, e.versionMadeBy, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, e.flags, true)
    cv.setUint16(10, e.method, true)
    cv.setUint16(12, e.time, true)
    cv.setUint16(14, e.date, true)
    cv.setUint32(16, e.crc, true)
    cv.setUint32(20, e.data.length, true)
    cv.setUint32(24, e.size, true)
    cv.setUint16(28, e.nameBytes.length, true)
    cv.setUint16(36, e.internalAttributes, true)
    cv.setUint32(38, e.externalAttributes, true)
    cv.setUint32(42, offset, true)
    central.set(e.nameBytes, 46)
    locals.push(local, e.data)
    centrals.push(central)
    offset += local.length + e.data.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, end]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ---------------------------------------------------------------------------- header pictures

const attr = (xml, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1]
const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function relsPathFor(partName) {
  const slash = partName.lastIndexOf('/')
  return `${partName.slice(0, slash)}/_rels/${partName.slice(slash + 1)}.rels`
}

// A relationship target resolved against the part that owns it: `media/image1.png` from
// `word/header2.xml` is `word/media/image1.png`.
function resolveTarget(partName, target) {
  if (target.startsWith('/')) return target.slice(1)
  const segments = partName.split('/').slice(0, -1)
  for (const s of target.split('/')) {
    if (s === '..') segments.pop()
    else if (s !== '.') segments.push(s)
  }
  return segments.join('/')
}

function relationships(relsXml) {
  return [...relsXml.matchAll(/<Relationship\s[^>]*?\/?>/g)].map(([xml]) => ({ xml, id: attr(xml, 'Id'), type: attr(xml, 'Type'), target: attr(xml, 'Target'), mode: attr(xml, 'TargetMode') }))
}

// Every picture drawing in a header part: `{ xml, start, rId }`, the drawing's own markup and where
// it sits. Only a drawing that is itself a picture counts: a group or shape that happens to hold one
// isn't the logo's box, so it is left alone.
function headerPictures(headerXml) {
  const pictures = []
  for (const match of headerXml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)) {
    const xml = match[0]
    if (attr(/<a:graphicData\s[^>]*>/.exec(xml)?.[0] ?? '', 'uri') !== PICTURE_URI) continue
    const rId = /<a:blip\s[^>]*?r:embed="([^"]+)"/.exec(xml)?.[1]
    if (rId) pictures.push({ xml, start: match.index, rId })
  }
  return pictures
}

// The package's header parts: those [Content_Types].xml declares as headers, and any part named
// like one (`word/header2.xml`), which is how Word and Pandoc name them.
async function headerPartNames(entries) {
  const names = new Set(entries.filter((e) => HEADER_PART_RE.test(e.name)).map((e) => e.name))
  const contentTypes = entries.find((e) => e.name === '[Content_Types].xml')
  if (contentTypes) {
    for (const [tag] of (await entryText(contentTypes)).matchAll(/<Override\s[^>]*>/g)) {
      if (attr(tag, 'ContentType') === HEADER_CONTENT_TYPE) names.add(attr(tag, 'PartName')?.replace(/^\//, ''))
    }
  }
  return names
}

// Each header's pictures, resolved to the image part they show: `[{ part, headerXml, relsPath,
// relsXml, pictures: [{ xml, start, rId, media }] }]`, only the headers that have one.
async function findHeaderLogos(entries) {
  const byName = new Map(entries.map((e) => [e.name, e]))
  const headers = await headerPartNames(entries)
  const found = []
  for (const entry of entries) {
    if (!headers.has(entry.name)) continue
    const headerXml = await entryText(entry)
    const pictures = headerPictures(headerXml)
    if (pictures.length === 0) continue
    const relsPath = relsPathFor(entry.name)
    const relsEntry = byName.get(relsPath)
    if (!relsEntry) continue
    const relsXml = await entryText(relsEntry)
    const rels = relationships(relsXml)
    const resolved = []
    for (const picture of pictures) {
      const rel = rels.find((r) => r.id === picture.rId && r.type === IMAGE_REL_TYPE && r.mode !== 'External')
      if (!rel?.target) continue
      const media = resolveTarget(entry.name, rel.target)
      if (byName.has(media)) resolved.push({ ...picture, media })
    }
    if (resolved.length) found.push({ part: entry.name, headerXml, relsPath, relsXml, pictures: resolved })
  }
  return found
}

function contentTypeFor(contentTypesXml, partName) {
  const override = new RegExp(`<Override\\s[^>]*PartName="/${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(contentTypesXml)?.[0]
  if (override) return attr(override, 'ContentType')
  const extension = partName.split('.').pop().toLowerCase()
  for (const [xml] of contentTypesXml.matchAll(/<Default\s[^>]*>/g)) {
    if (attr(xml, 'Extension')?.toLowerCase() === extension) return attr(xml, 'ContentType')
  }
  return 'application/octet-stream'
}

/**
 * The logo a reference document's page header shows: `{ bytes, contentType, extension }` for the
 * first header picture, or `null` when no header has one (or `docx` isn't a readable package).
 */
export async function readHeaderLogo(docx) {
  let entries
  try {
    entries = readZip(docx)
  } catch {
    return null
  }
  const logos = await findHeaderLogos(entries)
  const media = logos[0]?.pictures[0]?.media
  if (!media) return null
  const mediaEntry = entries.find((e) => e.name === media)
  const contentTypesEntry = entries.find((e) => e.name === '[Content_Types].xml')
  const bytes = await entryBytes(mediaEntry)
  return {
    bytes,
    contentType: logoImageInfo(bytes)?.contentType ?? (contentTypesEntry ? contentTypeFor(await entryText(contentTypesEntry), media) : 'application/octet-stream'),
    extension: media.split('.').pop().toLowerCase(),
  }
}

// The box the logo may fill: the one recorded when Gantry last replaced it, else the picture's own extent.
function logoBox(drawingXml) {
  const recorded = new RegExp(`<a:ext uri="${LOGO_BOX_EXTENSION_URI.replace(/[{}]/g, '\\$&')}"[^>]*>\\s*<[^>]*logoBox\\s[^>]*>`).exec(drawingXml)?.[0]
  const fromRecord = recorded && { cx: Number(attr(recorded, 'cx')), cy: Number(attr(recorded, 'cy')) }
  if (fromRecord && fromRecord.cx > 0 && fromRecord.cy > 0) return fromRecord
  const extent = /<wp:extent\s[^>]*>/.exec(drawingXml)?.[0]
  return { cx: Number(attr(extent ?? '', 'cx')), cy: Number(attr(extent ?? '', 'cy')) }
}

function setAttr(tag, name, value) {
  const re = new RegExp(`(\\s${name}=")[^"]*(")`)
  if (re.test(tag)) return tag.replace(re, `$1${escapeAttr(value)}$2`)
  return tag.replace(/(\s*\/?>)$/, ` ${name}="${escapeAttr(value)}"$1`)
}

function withoutAttr(tag, name) {
  return tag.replace(new RegExp(`\\s${name}="[^"]*"`), '')
}

// One header picture rewritten for the new logo: the new image's proportions inside `box`, the alt
// text naming the organisation's logo, no crop, and the box recorded for the next replacement.
function refitPicture(drawingXml, image, mediaName) {
  const box = logoBox(drawingXml)
  if (!(box.cx > 0 && box.cy > 0)) return drawingXml
  const scale = Math.min(box.cx / image.width, box.cy / image.height)
  const cx = Math.max(1, Math.round(image.width * scale))
  const cy = Math.max(1, Math.round(image.height * scale))
  let xml = drawingXml
  xml = xml.replace(/<wp:extent\s[^>]*>/, (tag) => setAttr(setAttr(tag, 'cx', cx), 'cy', cy))
  xml = xml.replace(/(<pic:spPr[^>]*>[\s\S]*?<a:xfrm[^>]*>[\s\S]*?)(<a:ext\s[^>]*>)/, (_, before, tag) => before + setAttr(setAttr(tag, 'cx', cx), 'cy', cy))
  xml = xml.replace(/<pic:cNvPr\s[^>]*>/, (tag) => withoutAttr(setAttr(setAttr(tag, 'name', mediaName), 'descr', LOGO_ALT_TEXT), 'title'))
  xml = xml.replace(/<a:srcRect[^>]*?(\/>|>[\s\S]*?<\/a:srcRect>)/, '<a:srcRect/>')
  const record = `<a:ext uri="${LOGO_BOX_EXTENSION_URI}"><g:logoBox xmlns:g="${LOGO_BOX_NS}" cx="${box.cx}" cy="${box.cy}"/></a:ext>`
  xml = xml.replace(/<wp:docPr\s[^>]*?(\/>|>[\s\S]*?<\/wp:docPr>)/, (docPr) => {
    const selfClosing = /^<wp:docPr\s[^>]*?\/>$/.test(docPr)
    let open = /^<wp:docPr\s[^>]*?\/?>/.exec(docPr)[0].replace(/\s*\/>$/, '>')
    open = withoutAttr(setAttr(open, 'descr', LOGO_ALT_TEXT), 'title')
    let inner = selfClosing ? '' : docPr.slice(docPr.indexOf('>') + 1, -'</wp:docPr>'.length)
    inner = inner.replace(new RegExp(`<a:ext uri="${LOGO_BOX_EXTENSION_URI.replace(/[{}]/g, '\\$&')}"[^>]*>[\\s\\S]*?</a:ext>`), '')
    if (/<a:extLst[\s>]/.test(inner)) inner = inner.replace(/<\/a:extLst>/, `${record}</a:extLst>`)
    else inner += `<a:extLst xmlns:a="${DRAWINGML_NS}">${record}</a:extLst>`
    return `${open}${inner}</wp:docPr>`
  })
  return xml
}

/**
 * `docx` with its header logo replaced by `image` (a PNG or JPEG's bytes): `{ docx, replaced }`,
 * where `replaced` counts the header pictures changed. A document with no header picture comes
 * back unchanged (the same bytes) with `replaced: 0`. Throws when `image` isn't a PNG or JPEG
 * (`err.invalidImage`) or `docx` isn't a readable package.
 */
export async function replaceHeaderLogo(docx, image) {
  const info = logoImageInfo(image)
  if (!info) {
    const err = new Error(logoImageProblem(image))
    err.invalidImage = true
    throw err
  }
  const entries = readZip(docx)
  const logos = await findHeaderLogos(entries)
  if (logos.length === 0) return { docx, replaced: 0 }

  // The image parts only the logo showed are dropped; one anything else still shows is kept.
  const oldMedia = new Set(logos.flatMap((l) => l.pictures.map((p) => p.media)))
  const logoRels = new Set(logos.flatMap((l) => l.pictures.map((p) => `${l.relsPath}#${p.rId}`)))
  for (const entry of entries) {
    if (!entry.name.endsWith('.rels')) continue
    const owner = entry.name.replace(/(^|\/)_rels\/([^/]*)\.rels$/, '$1$2')
    for (const rel of relationships(await entryText(entry))) {
      if (!rel.target || rel.mode === 'External' || logoRels.has(`${entry.name}#${rel.id}`)) continue
      oldMedia.delete(resolveTarget(owner, rel.target))
    }
  }
  const kept = entries.filter((e) => !oldMedia.has(e.name))
  let mediaPart = `word/media/logo.${info.extension}`
  for (let n = 2; kept.some((e) => e.name === mediaPart); n++) mediaPart = `word/media/logo${n}.${info.extension}`
  const mediaName = mediaPart.split('/').pop()

  const replacements = new Map()
  let replaced = 0
  for (const logo of logos) {
    let headerXml = logo.headerXml
    for (const picture of [...logo.pictures].sort((a, b) => b.start - a.start)) {
      headerXml = headerXml.slice(0, picture.start) + refitPicture(picture.xml, info, mediaName) + headerXml.slice(picture.start + picture.xml.length)
      replaced++
    }
    replacements.set(logo.part, headerXml)
    const rIds = new Set(logo.pictures.map((p) => p.rId))
    replacements.set(logo.relsPath, logo.relsXml.replace(/<Relationship\s[^>]*?\/?>/g, (tag) => (rIds.has(attr(tag, 'Id')) ? setAttr(tag, 'Target', resolveRelative(logo.part, mediaPart)) : tag)))
  }
  // The package declares the new image's type, and no longer declares a dropped image part: an
  // Override naming a part the package doesn't hold is one a strict reader may refuse.
  const contentTypes = kept.find((e) => e.name === '[Content_Types].xml')
  if (contentTypes) {
    const original = await entryText(contentTypes)
    let xml = original.replace(/<Override\s[^>]*>/g, (tag) => (oldMedia.has(attr(tag, 'PartName')?.replace(/^\//, '')) ? '' : tag))
    const hasDefault = [...xml.matchAll(/<Default\s[^>]*>/g)].some(([tag]) => attr(tag, 'Extension')?.toLowerCase() === info.extension)
    if (!hasDefault) xml = xml.replace(/(<Types\b[^>]*>)/, `$1<Default Extension="${info.extension}" ContentType="${info.contentType}"/>`)
    if (xml !== original) replacements.set(contentTypes.name, xml)
  }

  const out = []
  for (const entry of kept) out.push(replacements.has(entry.name) ? await newEntry(entry.name, replacements.get(entry.name), entry) : entry)
  out.push(await newEntry(mediaPart, image, null))
  return { docx: writeZip(out), replaced }
}

// `target` written relative to the folder `partName` sits in, as Word writes image targets.
function resolveRelative(partName, target) {
  const base = partName.split('/').slice(0, -1)
  const parts = target.split('/')
  let common = 0
  while (common < base.length && base[common] === parts[common]) common++
  return [...base.slice(common).map(() => '..'), ...parts.slice(common)].join('/')
}

// ------------------------------------------------------------------------ a Definition's documents

/**
 * What the Logo control shows for a Definition's reference documents (`[{ name, bytes }]`): the
 * current `logo` (`{ bytes, contentType, extension, document }` from the first document, shared one
 * first, whose header has one, or `null`) and each document's `{ name, hasLogo }`.
 */
export async function summariseDefinitionLogo(documents) {
  const ordered = sortReferenceDocxNames(documents.map((d) => d.name)).map((name) => documents.find((d) => d.name === name))
  let logo = null
  const rows = []
  for (const doc of ordered) {
    const found = await readHeaderLogo(doc.bytes)
    if (found && !logo) logo = { ...found, document: doc.name }
    rows.push({ name: doc.name, hasLogo: Boolean(found) })
  }
  return { logo, documents: rows }
}

/**
 * The new logo written into every reference document (`[{ name, bytes }]`) whose header has one:
 * `{ updated: [{ name, bytes }], withoutLogo: [name] }`. A document without a header picture, or
 * one that isn't a readable package, is left out of `updated` and named in `withoutLogo`. Throws
 * (`err.invalidImage`) before touching anything when `image` isn't a PNG or JPEG.
 */
export async function applyDefinitionLogo(documents, image) {
  const problem = logoImageProblem(image)
  if (problem) {
    const err = new Error(problem)
    err.invalidImage = true
    throw err
  }
  const updated = []
  const withoutLogo = []
  for (const name of sortReferenceDocxNames(documents.map((d) => d.name))) {
    const doc = documents.find((d) => d.name === name)
    let result
    try {
      result = await replaceHeaderLogo(doc.bytes, image)
    } catch {
      result = { replaced: 0 }
    }
    if (result.replaced > 0) updated.push({ name, bytes: result.docx })
    else withoutLogo.push(name)
  }
  return { updated, withoutLogo }
}
