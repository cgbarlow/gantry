// #292 (parent #238, decided in #240; docs/adr/0065): how the AI reads the Source documents of an Instance when they do not
// all fit, are scans, or are pictures. Three things live here, all pure (no DOM, no network) so the unit tests drive them:
//
//   1. WHAT GOES HOW. `planSourceAccess` decides, per document and for the AI Provider in use, whether the AI is given
//      the document's text (in the brief, whole or in a catalogue), the original file attached to its first message
//      (a picture, or a PDF), or nothing because the AI Provider cannot read it (listed as unreadable, with the reason).
//        * Text is the default for everything that has any (a PDF too: it is far cheaper than sending the PDF).
//        * A PDF goes as the PDF itself only when its text layer is near-empty (a scan, which Gantry stored with no text) or
//          the architect marked it **Read visually**, *and* the AI Provider takes PDFs: Anthropic, OpenAI, and OpenRouter
//          (whose PDF engine Gantry then sets explicitly to `native`, so a surprise OCR charge cannot happen; that needs a
//          model that reads images). Marked visual but not takeable: its text is used instead, and a scan is unreadable.
//        * A picture goes as the picture only to a model whose Test found it reads images. Otherwise it is unreadable.
//        * Nothing is attached past MAX_ATTACHMENT_BYTES in all, or MAX_IMAGE_BYTES for one picture; those are listed as
//          unreadable with the limit named.
//
//   2. THE READER. When the pack's text is more than about half the model's window the brief carries a catalogue, and the AI
//      calls `read_source_document(id, range)` to pull a part of a document. `readSourceText` does the reading: a range is
//      `pages 3-5`, `section: Heading`, or `start-end` character offsets; no range reads from the start. A read is capped at
//      MAX_READ_CHARS and says where to carry on. A model that does not use tools asks in a fenced `gantry-read` block.
//
//   3. INPUTS. Every read is recorded as `{ source, title, range, fingerprint }`; `inputsForDraft` joins the reads made since
//      the last drafts with the Source documents the draft cites, and the session keeps them as the Field's inputs (the
//      `fields` part of the decisions log, ADR-0064; #288 commits it). The fingerprint is of the text the AI saw, so a
//      document that changes later can be told apart (#297).
import { citedSourceIds } from './interviewDraft.js'
import { formatBytes, sourceFileExtension, sourceFileKind } from './sourceDocuments.js'

export const READ_TOOL_NAME = 'read_source_document'
export const READ_FENCE = 'gantry-read'

/** One read returns at most this much text (about 7,500 tokens), and says where to continue. */
export const MAX_READ_CHARS = 30000

/** The most a single picture may weigh to be sent (Anthropic's own limit for one image). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** The most the originals sent with the first message may weigh in all. Base64 makes them a third bigger, and the whole request must stay under Gantry's relay limit (25 MB, lib/aiRelay.js) and the AI Providers' own (Anthropic's is 32 MB). */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

const IMAGE_MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** The tool as the model is told about it. */
export const READ_TOOL = {
  name: READ_TOOL_NAME,
  description:
    'Read a Source document, or part of one, that the catalogue lists. Give the document id and, to read part of it, a range: ' +
    '"pages 3-5" (a PDF), "section: Heading text" (a heading from its outline), or "start-end" character offsets such as "0-20000". ' +
    `With no range you read from the start. One read returns at most ${MAX_READ_CHARS.toLocaleString('en-US')} characters and says where to carry on. ` +
    'Read a document before you rely on or cite it. Gantry records what you read as the inputs of the Fields you then draft.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Source document id, as listed in the catalogue.' },
      range: { type: 'string', description: 'Optional: "pages 3-5", "section: Heading text", or "start-end" character offsets.' },
    },
    required: ['id'],
  },
}

/** What a model without tool calling is told, in place of the tool, so it can still read a catalogued document. */
export const READ_TEXT_FALLBACK_INSTRUCTIONS =
  `To read a catalogued Source document, write one fenced code block tagged ${READ_FENCE} containing JSON of the form ` +
  '{"id":"document-id","range":"pages 3-5"} (range is optional; "section: Heading text" and "start-end" character offsets also work). ' +
  'Gantry replies with the text in its next message. Read what you need before you draft from it.'

// ---------- the text fallback ----------

const FENCE = new RegExp('```[ \\t]*' + READ_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')

/** Removes read-request blocks from text meant for the screen, including one still being written. */
export function stripReadBlocks(text) {
  const closed = String(text ?? '').replace(FENCE, '')
  const open = closed.search(new RegExp('```[ \\t]*' + READ_FENCE))
  return (open === -1 ? closed : closed.slice(0, open)).trim()
}

/** The reads a model asked for as fenced blocks: `{ reads: [{ id, range }], errors: [string] }`. */
export function extractReadBlocks(text) {
  const reads = []
  const errors = []
  for (const match of String(text ?? '').matchAll(FENCE)) {
    try {
      const parsed = JSON.parse(match[1])
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item.id === 'string') reads.push({ id: item.id, range: typeof item.range === 'string' ? item.range : undefined })
        else errors.push('A read block needs {"id": "document-id"}.')
      }
    } catch (err) {
      errors.push(`A read block is not valid JSON (${err.message}).`)
    }
  }
  return { reads, errors }
}

// ---------- what goes how ----------

/** Whether an AI Provider takes a PDF itself. OpenRouter does through a model that reads images, with its PDF engine set explicitly. */
export function providerTakesPdfs(provider) {
  if (!provider) return false
  if (provider.type === 'anthropic' || provider.type === 'openai') return true
  if (provider.type === 'openrouter') return provider.test?.readsImages === true
  return false
}

/** Whether Test found the model reads pictures. An untested or unsure one does not get them. */
export function providerReadsImages(provider) {
  return provider?.test?.readsImages === true
}

const hasText = (source) => typeof source?.text === 'string' && source.text.trim() !== ''

/**
 * Decides, for every live Source document, how the AI gets it with `provider`. Returns a Map of id to
 * `{ how, kind, mediaType?, reason?, note? }` where `how` is:
 *   'text'        the document's text is in the brief (whole, or in the catalogue read with the tool)
 *   'attach'      the original is sent with the first message (`kind` is 'image' or 'pdf', `mediaType` its type)
 *   'unreadable'  the AI cannot read it; `reason` says why, in a sentence for both the AI and the architect
 * `note` (optional) is something the architect asked for that could not be done and what happened instead.
 */
export function planSourceAccess({ sources, provider }) {
  const plan = new Map()
  const takesPdfs = providerTakesPdfs(provider)
  const readsImages = providerReadsImages(provider)
  let attachedBytes = 0
  const fits = (size, limit) => Number.isFinite(size) && size <= limit && attachedBytes + size <= MAX_ATTACHMENT_BYTES

  const attach = (source, kind, mediaType) => {
    const size = Number(source.size) || 0
    if (kind === 'image' && size > MAX_IMAGE_BYTES) {
      plan.set(source.id, { how: 'unreadable', kind, reason: `the picture is ${formatBytes(size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} one picture may weigh to be sent` })
      return false
    }
    if (!fits(size, MAX_ATTACHMENT_BYTES)) {
      plan.set(source.id, { how: 'unreadable', kind, reason: `sending it (${formatBytes(size)}) would take the originals past the ${formatBytes(MAX_ATTACHMENT_BYTES)} sent with the first message` })
      return false
    }
    attachedBytes += size
    plan.set(source.id, { how: 'attach', kind, mediaType })
    return true
  }

  for (const source of sources ?? []) {
    if (!source || typeof source.id !== 'string' || source.removedAt) continue
    const kind = sourceFileKind(source.filename)
    if (kind === 'image') {
      if (readsImages) attach(source, 'image', IMAGE_MEDIA_TYPES[sourceFileExtension(source.filename)] ?? 'image/png')
      else plan.set(source.id, { how: 'unreadable', kind, reason: "it is a picture and this model can't read images" })
    } else if (kind === 'pdf') {
      const visual = source.readVisually === true
      if (visual && takesPdfs) {
        attach(source, 'pdf', 'application/pdf')
      } else if (visual && hasText(source)) {
        plan.set(source.id, { how: 'text', kind, note: "marked Read visually, but this AI Provider doesn't take PDFs, so its text is used" })
      } else if (hasText(source)) {
        plan.set(source.id, { how: 'text', kind })
      } else if (takesPdfs) {
        attach(source, 'pdf', 'application/pdf')
      } else {
        plan.set(source.id, { how: 'unreadable', kind, reason: "it is a scanned PDF with no text layer and this AI Provider doesn't take PDFs" })
      }
    } else if (hasText(source)) {
      plan.set(source.id, { how: 'text', kind })
    } else {
      plan.set(source.id, { how: 'unreadable', kind, reason: 'no text could be read from it' })
    }
  }
  return plan
}

/** The sources as the brief should see them: a document that is attached has its text left out, so it is not sent twice. */
export function sourcesForBrief(sources, plan) {
  return (sources ?? []).map((s) => (plan.get(s?.id)?.how === 'attach' && s.text !== undefined ? { ...s, text: undefined } : s))
}

/** The plan as the brief describes it: `{ [id]: { how, kind, reason?, note? } }`. */
export function accessForBrief(plan) {
  return Object.fromEntries([...plan.entries()].map(([id, a]) => [id, { how: a.how, kind: a.kind, ...(a.reason ? { reason: a.reason } : {}), ...(a.note ? { note: a.note } : {}) }]))
}

// ---------- attaching the originals ----------

function toBase64(bytes) {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

/**
 * Loads the originals the plan attaches. `loadBytes(id)` resolves the file's bytes (or null); `cache` is a Map the caller keeps
 * so a file is read and encoded once per session. Returns `{ images, documents, problems }`: `images`
 * `[{ sourceId, title, mediaType, data }]`, `documents` `[{ sourceId, title, filename, mediaType, data }]` (`data` base64), and
 * `problems` `{ [id]: reason }` for a file that could not be read, which the caller turns into an unreadable entry.
 */
export async function loadAttachments({ sources, plan, loadBytes, cache = new Map() }) {
  const images = []
  const documents = []
  const problems = {}
  for (const source of sources ?? []) {
    const access = plan.get(source?.id)
    if (access?.how !== 'attach') continue
    const key = `${source.id}|${source.filename}|${source.size}`
    let data = cache.get(key)
    if (data === undefined) {
      try {
        const bytes = loadBytes ? await loadBytes(source.id) : null
        data = bytes ? toBase64(bytes) : null
      } catch {
        data = null
      }
      cache.set(key, data)
    }
    if (!data) {
      problems[source.id] = 'its file could not be read from the Instance'
      continue
    }
    const title = source.title || source.filename || source.id
    if (access.kind === 'image') images.push({ sourceId: source.id, title, mediaType: access.mediaType, data })
    else documents.push({ sourceId: source.id, title, filename: source.filename, mediaType: access.mediaType, data })
  }
  return { images, documents, problems }
}

/** The sentence added to the first message saying which attachment is which document. */
export function attachmentNote({ images, documents }) {
  if (!images.length && !documents.length) return ''
  const lines = ['', '', 'Attached to this message, so you can read them (cite each by its Source document id):']
  images.forEach((i, n) => lines.push(`- image ${n + 1} is Source document \`${i.sourceId}\` ("${i.title}")`))
  documents.forEach((d, n) => lines.push(`- PDF ${n + 1} is Source document \`${d.sourceId}\` ("${d.title}")`))
  return lines.join('\n')
}

// ---------- reading ----------

/** `cyrb53`: a small, fast, well-spread hash. A fingerprint only has to tell one text from another, not resist an attack. */
export function fingerprintText(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  const input = String(text ?? '')
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** The headings of a text with where each starts: `[{ level, title, start }]` (a fenced block's lines are not headings). */
function headingsOf(text) {
  const out = []
  let fenced = false
  let at = 0
  for (const line of String(text).split('\n')) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced
    const match = !fenced && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (match) out.push({ level: match[1].length, title: match[2], start: at })
    at += line.length + 1
  }
  return out
}

/** The pages a PDF's text carries as `## Page N` headings: `[{ n, start, end }]`. */
export function pageSpans(text) {
  const source = String(text ?? '')
  const marks = [...source.matchAll(/^## Page (\d+)\s*$/gm)].map((m) => ({ n: Number(m[1]), start: m.index }))
  return marks.map((mark, i) => ({ ...mark, end: i + 1 < marks.length ? marks[i + 1].start : source.length }))
}

/** "pages 1–42" when the text is a PDF's, else ''. */
export function pagesSummary(text) {
  const pages = pageSpans(text)
  if (pages.length === 0) return ''
  return pages.length === 1 ? 'page ' + pages[0].n : `pages ${pages[0].n}–${pages[pages.length - 1].n}`
}

const trimEnd = (n) => n.toLocaleString('en-US')

/**
 * Reads part of a document's `text`. `range` is undefined/empty (from the start), `pages 3-5` / `page 4`, `section: Heading`,
 * or `start-end` character offsets. Returns `{ ok: true, text, from, to, total, label, truncated }` or `{ ok: false, error }`.
 * `label` names what was read (`pages 3–5`, `section "Scope"`, `characters 0–30,000`).
 */
export function readSourceText(text, range, { maxChars = MAX_READ_CHARS } = {}) {
  const source = String(text ?? '')
  const total = source.length
  const wanted = String(range ?? '').trim()
  let from = 0
  let to = total
  let label = ''

  const pages = wanted.match(/^pages?\s*[:.]?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?$/i)
  const chars = wanted.match(/^(?:chars?(?:acters)?\s*[:.]?\s*)?(\d+)\s*(?:-|–|:)\s*(\d+)$/i)
  if (wanted === '') {
    label = ''
  } else if (pages) {
    const first = Number(pages[1])
    const last = Number(pages[2] ?? pages[1])
    const spans = pageSpans(source)
    if (spans.length === 0) return { ok: false, error: 'This document has no pages to pick from. Read it by section or by character offsets ("0-20000").' }
    const inRange = spans.filter((p) => p.n >= Math.min(first, last) && p.n <= Math.max(first, last))
    if (inRange.length === 0) return { ok: false, error: `This document has ${pagesSummary(source)} with text; there is nothing on ${first === last ? `page ${first}` : `pages ${first}–${last}`}.` }
    from = inRange[0].start
    to = inRange[inRange.length - 1].end
    label = inRange.length === 1 ? `page ${inRange[0].n}` : `pages ${inRange[0].n}–${inRange[inRange.length - 1].n}`
  } else if (chars) {
    from = Math.min(Number(chars[1]), total)
    to = Math.min(Number(chars[2]), total)
    if (to <= from) return { ok: false, error: `The range ${chars[1]}-${chars[2]} is empty. The document is ${trimEnd(total)} characters long.` }
    label = `characters ${trimEnd(from)}–${trimEnd(to)}`
  } else {
    const shownTitle = wanted.replace(/^sections?\s*[:.]?\s*/i, '').replace(/^["'“”]|["'“”]$/g, '').trim()
    const wantedTitle = shownTitle.toLowerCase()
    const headings = headingsOf(source)
    const found = headings.find((h) => h.title.toLowerCase() === wantedTitle) ?? headings.find((h) => h.title.toLowerCase().includes(wantedTitle))
    if (!wantedTitle || !found) {
      const outline = headings.slice(0, 15).map((h) => h.title)
      return { ok: false, error: `No section called "${shownTitle}". ${outline.length ? `Its headings include: ${outline.join(' / ')}.` : 'It has no headings; read it by character offsets ("0-20000").'}` }
    }
    const next = headings.find((h) => h.start > found.start && h.level <= found.level)
    from = found.start
    to = next ? next.start : total
    label = `section "${found.title}"`
  }

  let truncated = false
  if (to - from > maxChars) {
    to = from + maxChars
    truncated = true
  }
  if (!label) label = `characters ${trimEnd(from)}–${trimEnd(to)}`
  else if (truncated) label = `${label} (the first ${trimEnd(maxChars)} characters)`
  return { ok: true, text: source.slice(from, to).trim(), from, to, total, label, truncated }
}

/**
 * Runs one `read_source_document` call. `lookup(id)` returns the document as the session knows it (`{ id, title, text, ... }`)
 * or undefined; `access` is that document's plan entry. Returns `{ ok, content, read? }`: `content` goes back to the AI; on
 * success `read` is the record of an input, `{ source, title, range, fingerprint, chars }`.
 */
export function runReadCall({ id, range }, { lookup, access }) {
  const doc = lookup(String(id ?? ''))
  if (!doc) return { ok: false, content: `There is no Source document "${id}". Use an id from the catalogue.` }
  const title = doc.title || doc.filename || doc.id
  if (access?.how === 'attach') {
    return { ok: false, content: `"${title}" (${doc.id}) is attached to the first message as ${access.kind === 'pdf' ? 'a PDF' : 'a picture'}; it has no text to read here. Look at the attachment.` }
  }
  if (access?.how === 'unreadable' || !hasText(doc)) {
    return { ok: false, content: `"${title}" (${doc.id}) can't be read: ${access?.reason ?? 'no text could be read from it'}. Don't rely on or cite it; if it matters, ask the architect what it says.` }
  }
  const result = readSourceText(doc.text, range)
  if (!result.ok) return { ok: false, content: `${title} (${doc.id}): ${result.error}` }
  const header = `[${title} · ${result.label} · characters ${trimEnd(result.from)}–${trimEnd(result.to)} of ${trimEnd(result.total)}]`
  const footer = result.truncated ? `\n\n[Stopped at ${trimEnd(result.to)} of ${trimEnd(result.total)} characters. Carry on with range "${result.to}-${Math.min(result.total, result.to + MAX_READ_CHARS)}".]` : ''
  return {
    ok: true,
    content: `${header}\n\n${result.text}${footer}`,
    read: { source: doc.id, title, range: range && String(range).trim() ? result.label.replace(/ \(the first.*$/, '') : result.from === 0 && result.to === result.total ? null : result.label, fingerprint: fingerprintText(result.text), chars: result.text.length },
  }
}

// ---------- inputs ----------

const sameInput = (a, b) => a.source === b.source && (a.range ?? null) === (b.range ?? null)

/**
 * The inputs of a draft: every read made since the last drafts, then each Source document the draft cites that was not already
 * read (a citation alone is an input of the whole document, fingerprinted by its whole text). `sources` is the session's list.
 */
export function inputsForDraft({ reads, value, sources }) {
  const inputs = []
  for (const read of reads) {
    const input = { source: read.source, title: read.title, range: read.range ?? null, fingerprint: read.fingerprint }
    if (!inputs.some((i) => sameInput(i, input))) inputs.push(input)
  }
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
  for (const id of [...new Set(citedSourceIds(text))]) {
    if (inputs.some((i) => i.source === id)) continue
    const doc = (sources ?? []).find((s) => s.id === id)
    if (!doc) continue
    inputs.push({ source: id, title: doc.title || doc.filename || id, range: null, fingerprint: hasText(doc) ? fingerprintText(doc.text) : null })
  }
  return inputs
}

/** One input as a short phrase: `Client brief (pages 3–5)`. */
export function describeInput(input) {
  return `${input.title || input.source}${input.range ? ` (${input.range})` : ''}`
}
