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
import { findSourceCitations, sourceCitationFor } from './sourceCitations.js'
import { fingerprintText, formatBytes, sourceFileExtension, sourceFileKind } from './sourceDocuments.js'
import { isRepositorySource, shortCommit } from './sourceRepository.js'

export { fingerprintText }

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

/** #319: the same, for a code repository: list a folder, search, or read a file, each in a read block. */
export const REPOSITORY_TEXT_FALLBACK_INSTRUCTIONS =
  `To read a code repository, write a fenced code block tagged ${READ_FENCE} containing {"id":"repository-id","list":"folder/path"} to list a folder ` +
  '("" for the top), {"id":"repository-id","search":"text"} to search it, or {"id":"repository-id","path":"file/path"} to read a file. Gantry replies in its next message.'

// ---------- code repositories (#319, docs/adr/0072) ----------
// A code repository is read live with three read-only tools, never pasted into the brief. Each read records the commit it saw, which is what a
// citation of the file names. The Gantry server does the reading (lib/repositorySource.js), skipping vendored code, build output and binaries.

export const LIST_REPOSITORY_TOOL_NAME = 'list_repository_folder'
export const SEARCH_REPOSITORY_TOOL_NAME = 'search_repository'
export const READ_REPOSITORY_TOOL_NAME = 'read_repository_file'
export const REPOSITORY_TOOL_NAMES = Object.freeze([LIST_REPOSITORY_TOOL_NAME, SEARCH_REPOSITORY_TOOL_NAME, READ_REPOSITORY_TOOL_NAME])

/** What the brief says about reading a repository, the same for the in-app AI and an outside agent (whose MCP tools have the same names). */
export const REPOSITORY_TOOLS_TEXT =
  `Read it with \`${LIST_REPOSITORY_TOOL_NAME}\` (a folder's files), \`${SEARCH_REPOSITORY_TOOL_NAME}\` (file names and text) and \`${READ_REPOSITORY_TOOL_NAME}\` (one file). ` +
  'Vendored code, build output and binaries are always skipped. Every read names the commit it saw: cite a fact from a file as ' +
  '`[title, path](source:<id>?path=<path>&commit=<commit>)`, exactly as the read gives it, so the citation says which code it came from.'

const repositoryId = { type: 'string', description: 'The Source document id of the code repository.' }

/** The tools as the model is told about them. */
export const REPOSITORY_TOOLS = Object.freeze([
  {
    name: LIST_REPOSITORY_TOOL_NAME,
    description: "List the files and folders in a folder of a code repository Source document, at its branch's latest commit. Leave out the path for the top of the repository.",
    parameters: { type: 'object', properties: { id: repositoryId, path: { type: 'string', description: 'Optional: a folder path from the root, such as "services/orders".' } }, required: ['id'] },
  },
  {
    name: SEARCH_REPOSITORY_TOOL_NAME,
    description: 'Search a code repository Source document for text (case-insensitive) in its file names and contents. Returns matching files and lines; read a file before you rely on it.',
    parameters: { type: 'object', properties: { id: repositoryId, query: { type: 'string', description: 'The text to look for, at least two characters.' }, path: { type: 'string', description: 'Optional: search only under this folder.' } }, required: ['id', 'query'] },
  },
  {
    name: READ_REPOSITORY_TOOL_NAME,
    description: `Read one file of a code repository Source document at its branch's latest commit. One read returns at most ${MAX_READ_CHARS.toLocaleString('en-US')} characters; give a "start-end" range to read on. Gantry records the file and commit as an input of the Fields you then draft.`,
    parameters: { type: 'object', properties: { id: repositoryId, path: { type: 'string', description: 'The file path from the root of the repository.' }, range: { type: 'string', description: 'Optional: "start-end" character offsets, or "section: Heading" in a Markdown file.' } }, required: ['id', 'path'] },
  },
])

const repositoryTitle = (doc) => doc.title || doc.id

/**
 * Runs one repository tool call. `lookup(id)` returns the Source document as the session knows it; `reader(entry)` the reader the Gantry
 * server answers through (web/lib/sourceRepositoryClient.js): `{ list, search, read }`. Resolves `{ ok, content, read? }`, never rejects:
 * `content` goes back to the AI, and a file read is recorded as `read`, `{ source, title, range, path, commit, fingerprint, chars }`.
 */
export async function runRepositoryCall(name, input, { lookup, reader }) {
  const id = String(input?.id ?? '')
  const doc = lookup(id)
  if (!doc) return { ok: false, content: `There is no Source document "${id}". Use the id of a code repository from the brief.` }
  if (!isRepositorySource(doc)) return { ok: false, content: `"${repositoryTitle(doc)}" (${doc.id}) is not a code repository. Read it with \`${READ_TOOL_NAME}\` or from the brief.` }
  const title = repositoryTitle(doc)
  try {
    const repo = reader(doc)
    if (name === LIST_REPOSITORY_TOOL_NAME) {
      const { commit, path, entries } = await repo.list({ path: input?.path })
      const lines = entries.map((e) => `- ${e.path}${e.isFolder ? '/' : ''}`)
      return { ok: true, content: `[${title} · ${path || 'top of the repository'} · commit ${commit}]\n\n${lines.length ? lines.join('\n') : '(nothing here that Gantry reads)'}` }
    }
    if (name === SEARCH_REPOSITORY_TOOL_NAME) {
      const { commit, query, matches, filesSearched, truncated } = await repo.search({ query: input?.query, path: input?.path })
      const lines = matches.map((m) => (m.line ? `- ${m.path}:${m.line}: ${m.text}` : `- ${m.path} (its name matches)`))
      const tail = truncated ? `\n\n[Stopped after ${filesSearched} files. Search under a folder, or for something more exact, to see the rest.]` : ''
      return { ok: true, content: `[${title} · search "${query}" · commit ${commit} · ${filesSearched} files searched]\n\n${lines.length ? lines.join('\n') : 'No matches.'}${tail}` }
    }
    if (name === READ_REPOSITORY_TOOL_NAME) {
      const { commit, path, text } = await repo.read({ path: input?.path })
      const result = readSourceText(text, input?.range)
      if (!result.ok) return { ok: false, content: `${title}, ${path}: ${result.error}` }
      const cite = sourceCitationFor(doc, { path, commit })
      const footer = result.truncated ? `\n\n[Stopped at ${trimEnd(result.to)} of ${trimEnd(result.total)} characters. Carry on with range "${result.to}-${Math.min(result.total, result.to + MAX_READ_CHARS)}".]` : ''
      return {
        ok: true,
        content: `[${title} · ${path} · commit ${commit} · ${result.label}]\nCite it as ${cite}\n\n${result.text}${footer}`,
        read: { source: doc.id, title, range: path, path, commit, fingerprint: fingerprintText(result.text), chars: result.text.length },
      }
    }
    return { ok: false, content: `There is no tool called ${name}.` }
  } catch (err) {
    const message = err?.message ?? 'it could not be read'
    // #319: a refusal the architect has to act on (no access, no server, a branch that has gone) is also theirs to see, not only the AI's.
    const blocked = REPOSITORY_BLOCKED_CODES.includes(err?.code) ? { blocked: { source: doc.id, title, code: err.code, message } } : {}
    return { ok: false, content: `${title}: ${message}`, ...blocked }
  }
}

/**
 * #319: the refusals of a repository read that come from where the architect stands, not from what the AI asked: they can't read it (or
 * can't with the token this browser holds), the Gantry server or the Provider can't be reached, or the branch is gone. The interview tells
 * the architect these, as well as the AI; a bad path or a skipped file is the AI's to sort out.
 */
export const REPOSITORY_BLOCKED_CODES = Object.freeze(['no-access', 'server-unreachable', 'unreachable', 'no-branch', 'base-url-not-allowed'])

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
        // #319: a read of a code repository names a `path` to read, or asks to `list` a folder or `search` for text.
        if (item && typeof item.id === 'string') {
          reads.push({
            id: item.id,
            range: typeof item.range === 'string' ? item.range : undefined,
            ...(typeof item.path === 'string' ? { path: item.path } : {}),
            ...(typeof item.list === 'string' ? { list: item.list } : {}),
            ...(typeof item.search === 'string' ? { search: item.search } : {}),
          })
        }
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
    // #319: a code repository is read with its own tools, never in the brief or attached.
    if (isRepositorySource(source)) {
      plan.set(source.id, { how: 'repository', kind: 'repository' })
      continue
    }
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

const sameInput = (a, b) => a.source === b.source && (a.range ?? null) === (b.range ?? null) && (a.commit ?? null) === (b.commit ?? null)

/**
 * The inputs of a draft: every read made since the last drafts, then each Source document the draft cites that was not already
 * read (a citation alone is an input of the whole document, fingerprinted by its whole text). `sources` is the session's list.
 */
export function inputsForDraft({ reads, value, sources }) {
  const inputs = []
  for (const read of reads) {
    const input = { source: read.source, title: read.title, range: read.range ?? null, ...(read.path ? { path: read.path, commit: read.commit } : {}), fingerprint: read.fingerprint }
    if (!inputs.some((i) => sameInput(i, input))) inputs.push(input)
  }
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
  // #319: a citation of a file of a code repository is an input of that file at the commit it names.
  for (const cite of findSourceCitations(text)) {
    if (!cite.path || !cite.commit) continue
    const doc = (sources ?? []).find((s) => s.id === cite.id)
    if (!doc || !isRepositorySource(doc)) continue
    const input = { source: cite.id, title: doc.title || cite.id, range: cite.path, path: cite.path, commit: cite.commit, fingerprint: null }
    if (!inputs.some((i) => sameInput(i, input))) inputs.push(input)
  }
  for (const id of [...new Set(citedSourceIds(text))]) {
    if (inputs.some((i) => i.source === id)) continue
    const doc = (sources ?? []).find((s) => s.id === id)
    if (!doc) continue
    inputs.push({ source: id, title: doc.title || doc.filename || id, range: null, fingerprint: hasText(doc) ? fingerprintText(doc.text) : null })
  }
  return inputs
}

/** One input as a short phrase: `Client brief (pages 3–5)`, or for a code repository `Billing API (src/orders.ts at 3f2a9c1)`. */
export function describeInput(input) {
  return `${input.title || input.source}${input.range ? ` (${input.range}${input.commit ? ` at ${shortCommit(input.commit)}` : ''})` : ''}`
}
