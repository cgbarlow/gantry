// #279 (docs/adr/0061-0070 map #238, decided in #245 and #242): an Instance's **Source documents**, the evidence an architect
// uploads before (or without) connecting an AI Provider. They are kept in a flat `sources/` folder beside `modules/` and
// `assets/`, with one `sources/manifest.yaml`, and the text the browser read out of each one beside it in `sources/.text/`.
//
// This module is pure and dependency-free apart from `yaml`, so the server (`lib/sourceDocuments.js`, over the storage
// layer) and a Local Workspace (`web/lib/localSourceDocuments.js`, over a folder handle) share one description of the
// folder, the manifest, the limits and the lifecycle and cannot drift. The store below is written against a tiny file
// interface (`io`) that each of them supplies:
//
//   io.readText(path)                        -> { text, version } | null
//   io.readBytes(path)                       -> Uint8Array | null
//   io.writeText(path, text, { ifVersion })  -> resolves once stored; rejects with `code: 'STORAGE_CONFLICT'` when
//                                               `ifVersion` (a `version` from readText, or null for "must not exist") no longer holds
//   io.writeBytes(path, bytes)               -> resolves once stored
//   io.remove(path)                          -> resolves once gone (no error when it was never there)
//
// Paths are relative to the Instance's folder (`sources/manifest.yaml`).
//
// Source documents stay apart from Assets: an Asset is an image the content *displays*, a Source document is material the
// content is *drawn from*. They have separate folders, separate manifests and separate routes, and nothing here touches
// `assets/`.
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'

export const SOURCES_FOLDER = 'sources'
export const SOURCE_MANIFEST_PATH = 'sources/manifest.yaml'
export const SOURCE_TEXT_FOLDER = 'sources/.text'

/** The most a single Source document may weigh, checked in the browser and again on the server (#242). */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024

/** The upload route's request-body cap: a 25 MB document is about 33.4 MB once base64-encoded, plus its extracted text and the JSON around it. "About 35 MB" in #242. */
export const MAX_SOURCE_UPLOAD_BODY_BYTES = 36 * 1024 * 1024

/** An Instance whose live Source documents weigh more than this shows a warning (not a refusal), per #242. */
export const INSTANCE_SOURCES_WARN_BYTES = 100 * 1024 * 1024

/** The browser cuts an extracted text off here (with a note) and the server refuses more, so one document's text cannot swamp the AI's context or a request. */
export const EXTRACTED_TEXT_CUT_CHARS = 1_000_000
export const MAX_SOURCE_TEXT_CHARS = 1_500_000

/** The document types an architect can upload, by extension, and what Gantry does with each (see web/lib/sourceExtract.js). */
export const SOURCE_FILE_KINDS = Object.freeze({
  word: ['.docx'],
  powerpoint: ['.pptx'],
  spreadsheet: ['.xlsx', '.csv', '.tsv'],
  pdf: ['.pdf'],
  text: ['.md', '.markdown', '.txt'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
})

export const SOURCE_FILE_EXTENSIONS = Object.freeze(Object.values(SOURCE_FILE_KINDS).flat())

/** The `accept` value for the upload's file picker. */
export const SOURCE_FILE_ACCEPT = SOURCE_FILE_EXTENSIONS.join(',')

/** The extension of `filename`, lower-cased, with its dot ('' when there is none). */
export function sourceFileExtension(filename) {
  const name = String(filename ?? '')
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** The kind a filename's extension names (a key of SOURCE_FILE_KINDS), or null when Gantry does not take that type. */
export function sourceFileKind(filename) {
  const ext = sourceFileExtension(filename)
  for (const [kind, extensions] of Object.entries(SOURCE_FILE_KINDS)) {
    if (extensions.includes(ext)) return kind
  }
  return null
}

/** The sentence shown when a file of a type Gantry cannot read is picked, or null when it can. */
export function sourceFileTypeProblem(filename) {
  if (sourceFileKind(filename)) return null
  const ext = sourceFileExtension(filename)
  const legacy = { '.doc': '.docx', '.ppt': '.pptx', '.xls': '.xlsx' }[ext]
  const hint = legacy ? ` Save it as ${legacy} and upload that.` : ''
  return `Gantry can't take ${ext ? `${ext} files` : 'that file'}.${hint} It takes Word (.docx), PowerPoint (.pptx), spreadsheets (.xlsx, .csv, .tsv), PDFs, Markdown and text files, and images (.png, .jpg, .gif, .webp).`
}

/** A problem with this Source document's weight, as a sentence naming the limit, or null when it is fine to upload. */
export function sourceSizeProblem(size, filename) {
  const label = filename ? `"${filename}"` : 'This document'
  if (!Number.isFinite(size) || size <= 0) return `${label} is empty.`
  if (size > MAX_SOURCE_BYTES) return `${label} is ${formatBytes(size)}, over the ${formatBytes(MAX_SOURCE_BYTES)} limit for a Source document.`
  return null
}

/** The warning for an Instance whose live Source documents have grown past the soft limit, or null. */
export function instanceSourcesWarning(totalBytes) {
  if (!(totalBytes > INSTANCE_SOURCES_WARN_BYTES)) return null
  return `This Instance's Source documents now weigh ${formatBytes(totalBytes)}, past about ${formatBytes(INSTANCE_SOURCES_WARN_BYTES)}. Remove ones you no longer need to keep it quick to open and save.`
}

/** 1536 -> "1.5 KB". Binary megabytes, as the limits are. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

// --- names ----------------------------------------------------------------------------------------------------------

const MAX_STORED_NAME_CHARS = 150
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i
// Not allowed in a file name on at least one of the systems an Instance's folder can sit on (Windows' list, plus control characters).
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\/]+/g

/**
 * The stored form of an uploaded file's name: the original, cleaned up so it is safe as a path. Any folder part goes, as do characters a file name may not hold on some systems, leading dots (so it can never be `.text` or a hidden file), and trailing dots and spaces. It is never empty and never `manifest.yaml`.
 */
export function cleanSourceFilename(name) {
  let base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  base = base.normalize('NFC').replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
  base = base.replace(/^\.+/, '').replace(/[. ]+$/, '').trim()
  if (base.length > MAX_STORED_NAME_CHARS) {
    const ext = sourceFileExtension(base)
    const keep = MAX_STORED_NAME_CHARS - ext.length
    base = `${base.slice(0, Math.max(1, keep)).trim()}${ext}`
  }
  if (!base) base = 'document'
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  if (RESERVED_DEVICE_NAMES.test(stem)) base = `_${base}`
  if (base.toLowerCase() === 'manifest.yaml') base = 'manifest-document.yaml'
  return base
}

/** `brief.docx` with `-2` added when it is taken (case-insensitively, since an Instance's folder may sit on a system that does not tell `A.docx` from `a.docx`): `brief-2.docx`, `brief-3.docx`. */
export function uniqueSourceFilename(cleaned, takenFilenames) {
  const taken = new Set([...takenFilenames].map((n) => n.toLowerCase()))
  taken.add('manifest.yaml')
  if (!taken.has(cleaned.toLowerCase())) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot > 0 ? cleaned.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** The id for a new document, made from its filename without the extension (`Client brief v3.docx` -> `client-brief-v3`), with `-2` added when taken. Fixed for good once chosen. */
export function sourceIdFor(filename, takenIds) {
  const name = String(filename ?? '')
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  let base = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base) base = 'document'
  const taken = new Set(takenIds)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
}

// --- Use as image (#281) ------------------------------------------------------------------------------------------------

/** The image types an Asset can be (lib/assets.js's ALLOWED_EXTENSIONS), so the only Source documents **Use as image** applies to. */
export const ASSET_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg'])

/** Whether a Source document of this stored filename can be copied into Assets as an image. */
export function canUseSourceAsImage(filename) {
  return ASSET_IMAGE_EXTENSIONS.includes(sourceFileExtension(filename))
}

export const USE_AS_IMAGE_REFUSAL = 'Only a PNG or JPEG can be used as an image.'

/**
 * The filename a Source document gets as an Asset in a Local Workspace, whose assets are plain files referenced as `![alt](assets/<name>)`: the stored name made safe to type into that reference (no spaces, brackets or quotes), lower-case extension, and `-2` and so on added when taken. The copy is a new file of its own: nothing links it back to the document.
 */
export function assetFilenameForSource(storedFilename, takenFilenames) {
  const ext = sourceFileExtension(storedFilename)
  const name = String(storedFilename ?? '')
  const stem = (ext ? name.slice(0, -ext.length) : name).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return uniqueSourceFilename(`${stem || 'image'}${ext}`, takenFilenames)
}

/** The title a document starts with: its original name without the extension. Only the title is ever editable. */
export function defaultSourceTitle(originalFilename) {
  const name = String(originalFilename ?? '').split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim()
  return stem || 'Untitled document'
}

/** Where a document's extracted text lives, from its stored filename. */
export function sourceTextPath(storedFilename) {
  return `${SOURCE_TEXT_FOLDER}/${storedFilename}.md`
}

/** The same path as the manifest records it: relative to the `sources/` folder. */
export function sourceTextRef(storedFilename) {
  return sourceTextPath(storedFilename).slice(`${SOURCES_FOLDER}/`.length)
}

export function sourceFilePath(storedFilename) {
  return `${SOURCES_FOLDER}/${storedFilename}`
}

// --- reading a document's text by page (#305) -------------------------------------------------------------------------

/** About how much extracted text one "page" holds when a document has no pages of its own (Word, slides, spreadsheets, text): small enough for an outside agent to read in one go. */
export const SOURCE_READ_PAGE_CHARS = 20_000

/**
 * Splits a document's extracted text into the pages an outside agent reads it by (ADR-0067). A PDF's text already has a `## Page N`
 * heading per page (web/lib/sourceExtract.js), so its pages are the PDF's own and "page 4" is page 4. Anything else is cut into runs of
 * about SOURCE_READ_PAGE_CHARS at paragraph breaks. Returns `{ by: 'pdf-page' | 'section', pages: string[] }` with at least one page.
 */
export function paginateSourceText(text, filename) {
  const source = String(text ?? '')
  if (sourceFileKind(filename) === 'pdf') {
    const parts = source.split(/^## Page (\d+)[ \t]*$/m)
    if (parts.length >= 3) {
      const pages = []
      for (let i = 1; i < parts.length; i += 2) pages[Number(parts[i]) - 1] = (parts[i + 1] ?? '').trim()
      return { by: 'pdf-page', pages: Array.from(pages, (page) => page ?? '') }
    }
  }
  const pages = []
  let current = ''
  const push = () => {
    if (current !== '') pages.push(current)
    current = ''
  }
  for (const paragraph of source.split(/\n{2,}/)) {
    if (paragraph.length > SOURCE_READ_PAGE_CHARS) {
      push()
      for (let i = 0; i < paragraph.length; i += SOURCE_READ_PAGE_CHARS) pages.push(paragraph.slice(i, i + SOURCE_READ_PAGE_CHARS))
      continue
    }
    if (current !== '' && current.length + paragraph.length + 2 > SOURCE_READ_PAGE_CHARS) push()
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`
  }
  push()
  return { by: 'section', pages: pages.length ? pages : [''] }
}

// --- the manifest ---------------------------------------------------------------------------------------------------

// #297: `replaces` (on the NEW document) is the id of the older one it supersedes, and `textChangedAt` the time the text read from the document last became different from what it was. Both are kept only when set, so a manifest that never used them is unchanged byte for byte.
const ENTRY_KEYS = ['id', 'filename', 'title', 'uploadedBy', 'uploadedAt', 'size', 'text', 'readVisually', 'replaces', 'textChangedAt', 'removedBy', 'removedAt']

/** One manifest entry with its keys in a fixed order and only the ones that have a value, so two writers produce the same bytes. */
export function normalizeSourceEntry(entry) {
  const out = {}
  for (const key of ENTRY_KEYS) {
    const value = key === 'uploadedBy' ? (entry?.uploadedBy ?? '') : entry?.[key]
    if (value === undefined || value === null) continue
    if (value === '' && key !== 'uploadedBy') continue
    // #292: `readVisually` is kept only while it is on, so a manifest that never used it is unchanged byte for byte.
    if (key === 'readVisually' && value !== true) continue
    out[key] = value
  }
  return out
}

/** Parses `sources/manifest.yaml`. A missing, empty or malformed manifest is an empty list. */
export function parseSourceManifest(text) {
  let parsed
  try {
    parsed = parseYAML(text ?? '')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((e) => e && typeof e.id === 'string' && typeof e.filename === 'string').map(normalizeSourceEntry)
}

export function stringifySourceManifest(entries) {
  return stringifyYAML(entries.map(normalizeSourceEntry))
}

// --- fingerprints and replacing (#297) ----------------------------------------------------------------------------------

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

/**
 * Which document replaced which: a Map of an older document's id to the newest entry whose `replaces` names it. The older document stays in the list (still citable, marked "replaced by <new>"); only the newer one holds the link.
 */
export function replacedByMap(entries) {
  const map = new Map()
  for (const entry of entries ?? []) {
    if (!entry?.replaces) continue
    const there = map.get(entry.replaces)
    if (!there || String(entry.uploadedAt ?? '') >= String(there.uploadedAt ?? '')) map.set(entry.replaces, entry)
  }
  return map
}

/** The entry that replaced document `id`, or null. */
export function replacedBy(entries, id) {
  return replacedByMap(entries).get(id) ?? null
}

/** Whether a document has been removed (its file and text are gone, its entry stays). */
export function isRemovedSource(entry) {
  return Boolean(entry?.removedAt)
}

/** The weight of the documents still kept, in bytes. */
export function liveSourceBytes(entries) {
  return entries.filter((e) => !isRemovedSource(e)).reduce((sum, e) => sum + (Number(e.size) || 0), 0)
}

// --- errors ---------------------------------------------------------------------------------------------------------

/** A refusal with an HTTP-ish `status`, so the server maps it to a response and the browser shows its message. */
export class SourceDocumentError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message)
    this.name = 'SourceDocumentError'
    this.code = code
    this.status = status
  }
}

// --- the store ------------------------------------------------------------------------------------------------------

const MAX_MANIFEST_ATTEMPTS = 6

const isConflict = (err) => err?.code === 'STORAGE_CONFLICT'

/**
 * The lifecycle of an Instance's Source documents over `io` (see the top of this file). Every method that changes the manifest reads it, changes the list and writes it back conditional on the version it read, trying again if another saver got in first, so two uploads at once each keep their entry.
 *
 * `options.now()` returns the ISO time stamped on uploads and removals (a test passes a fixed one).
 */
export function createSourceStore(io, options = {}) {
  const now = options.now ?? (() => new Date().toISOString())

  async function readManifest() {
    const stored = await io.readText(SOURCE_MANIFEST_PATH)
    return { entries: stored ? parseSourceManifest(stored.text) : [], version: stored ? stored.version : null }
  }

  // Applies `change(entries)` (returns the new list, or throws) and writes it, retrying a write that lost a race.
  async function mutateManifest(change) {
    for (let attempt = 0; ; attempt++) {
      const { entries, version } = await readManifest()
      const result = await change(entries)
      try {
        await io.writeText(SOURCE_MANIFEST_PATH, stringifySourceManifest(result.entries), { ifVersion: version })
        return result
      } catch (err) {
        if (!isConflict(err) || attempt >= MAX_MANIFEST_ATTEMPTS) throw err
      }
    }
  }

  const summary = (entries) => {
    const totalBytes = liveSourceBytes(entries)
    return { entries, totalBytes, warning: instanceSourcesWarning(totalBytes) }
  }

  function findLive(entries, id) {
    const entry = entries.find((e) => e.id === id)
    if (!entry) throw new SourceDocumentError(`No Source document "${id}" in this Instance.`, { code: 'not-found', status: 404 })
    return entry
  }

  function liveEntry(entries, id) {
    const entry = findLive(entries, id)
    if (isRemovedSource(entry)) throw new SourceDocumentError(`"${entry.title}" has been removed.`, { code: 'removed', status: 409 })
    return entry
  }

  async function writeTextFor(entry, text) {
    const path = sourceTextPath(entry.filename)
    if (text === null || text === undefined || text === '') {
      await io.remove(path)
      return false
    }
    await io.writeText(path, text)
    return true
  }

  return {
    /** `{ entries, totalBytes, warning }`: every entry, removed ones included (they show their title where a citation still names them). */
    async list() {
      return summary((await readManifest()).entries)
    },

    /**
     * Adds a document: always a new one with its own id and stored name, even when it is named like an existing one. `data` is `{ filename, bytes, text?, title?, uploadedBy?, replaces? }`; `replaces` (#297) is the id of an older document this one supersedes, recorded on the new entry (the older one stays as it is and shows "replaced by"). Refused when it is empty or over MAX_SOURCE_BYTES (the server's half of the browser's own check), or when `text` is past MAX_SOURCE_TEXT_CHARS. Returns `{ entry, totalBytes, warning }`.
     */
    async upload(data) {
      const bytes = data.bytes
      const size = bytes?.byteLength ?? 0
      const sizeProblem = sourceSizeProblem(size, data.filename ? cleanSourceFilename(data.filename) : undefined)
      if (sizeProblem) throw new SourceDocumentError(sizeProblem, { code: size > MAX_SOURCE_BYTES ? 'too-large' : 'empty', status: size > MAX_SOURCE_BYTES ? 413 : 400 })
      const text = typeof data.text === 'string' && data.text !== '' ? data.text : null
      if (text !== null && text.length > MAX_SOURCE_TEXT_CHARS) {
        throw new SourceDocumentError(`The text read from this document is ${text.length.toLocaleString('en-US')} characters, over the ${MAX_SOURCE_TEXT_CHARS.toLocaleString('en-US')} limit.`, { code: 'text-too-large', status: 413 })
      }
      const title = (typeof data.title === 'string' && data.title.trim()) || defaultSourceTitle(data.filename)
      const cleaned = cleanSourceFilename(data.filename)

      // The manifest entry goes in first: it is what reserves the name and id against another upload, so the files below can never be written over by one.
      let created
      const replaces = typeof data.replaces === 'string' && data.replaces.trim() ? data.replaces.trim() : undefined
      const result = await mutateManifest((entries) => {
        if (replaces !== undefined) liveEntry(entries, replaces)
        const filename = uniqueSourceFilename(cleaned, entries.map((e) => e.filename))
        const id = sourceIdFor(cleaned, entries.map((e) => e.id))
        created = normalizeSourceEntry({
          id,
          filename,
          title,
          uploadedBy: (data.uploadedBy ?? '').trim(),
          uploadedAt: now(),
          size,
          text: text === null ? undefined : sourceTextRef(filename),
          replaces,
        })
        return { entries: [...entries, created] }
      })

      try {
        await io.writeBytes(sourceFilePath(created.filename), bytes)
        if (text !== null) await io.writeText(sourceTextPath(created.filename), text)
      } catch (err) {
        // The files did not land: take the entry back out rather than list a document that is not there.
        await io.remove(sourceFilePath(created.filename)).catch(() => {})
        await io.remove(sourceTextPath(created.filename)).catch(() => {})
        await mutateManifest((entries) => ({ entries: entries.filter((e) => e.id !== created.id) })).catch(() => {})
        throw err
      }
      return { entry: created, ...summary(result.entries) }
    },

    /** Changes only a document's title. Its id and stored filename never change, and citations already written keep the title they were written with. */
    async rename(id, title) {
      const next = typeof title === 'string' ? title.trim() : ''
      if (!next) throw new SourceDocumentError('A Source document needs a title.', { code: 'bad-title', status: 400 })
      let renamed
      await mutateManifest((entries) => {
        const entry = liveEntry(entries, id)
        renamed = normalizeSourceEntry({ ...entry, title: next })
        return { entries: entries.map((e) => (e.id === id ? renamed : e)) }
      })
      return renamed
    },

    /** Deletes the file and its text and keeps the entry, marked removed with who and when, so a citation and the decisions log still show the title. */
    async remove(id, { removedBy = '' } = {}) {
      let removed
      let filename
      await mutateManifest((entries) => {
        const entry = liveEntry(entries, id)
        filename = entry.filename
        const { text: _text, ...rest } = entry
        removed = normalizeSourceEntry({ ...rest, removedBy: String(removedBy ?? '').trim(), removedAt: now() })
        return { entries: entries.map((e) => (e.id === id ? removed : e)) }
      })
      await io.remove(sourceFilePath(filename))
      await io.remove(sourceTextPath(filename))
      return removed
    },

    /** Replaces (or, with null or '', clears) the extracted text kept for a document. Used by **Extract text again**. */
    async setText(id, text) {
      if (typeof text === 'string' && text.length > MAX_SOURCE_TEXT_CHARS) {
        throw new SourceDocumentError(`The text read from this document is ${text.length.toLocaleString('en-US')} characters, over the ${MAX_SOURCE_TEXT_CHARS.toLocaleString('en-US')} limit.`, { code: 'text-too-large', status: 413 })
      }
      const { entries } = await readManifest()
      const entry = liveEntry(entries, id)
      // #297: what the text was before, so a re-read that gives the very same text changes nothing downstream.
      const before = entry.text ? ((await io.readText(sourceTextPath(entry.filename)))?.text ?? '') : ''
      const has = await writeTextFor(entry, text)
      const textRef = has ? sourceTextRef(entry.filename) : undefined
      const changed = fingerprintText(before) !== fingerprintText(has ? text : '')
      let updated
      await mutateManifest((current) => {
        const live = liveEntry(current, id)
        const { text: _text, ...rest } = live
        updated = normalizeSourceEntry({ ...rest, text: textRef, ...(changed ? { textChangedAt: now() } : {}) })
        return { entries: current.map((e) => (e.id === id ? updated : e)) }
      })
      return updated
    },

    /**
     * #292: marks (or, with false, unmarks) a document **Read visually**: the AI is sent the PDF itself instead of its text, where its AI Provider takes PDFs. Only a PDF can be marked. Returns the entry.
     */
    async setReadVisually(id, on) {
      let updated
      await mutateManifest((entries) => {
        const entry = liveEntry(entries, id)
        if (sourceFileKind(entry.filename) !== 'pdf') {
          throw new SourceDocumentError('Only a PDF can be read visually.', { code: 'not-a-pdf', status: 400 })
        }
        updated = normalizeSourceEntry({ ...entry, readVisually: on === true })
        return { entries: entries.map((e) => (e.id === id ? updated : e)) }
      })
      return updated
    },

    /** `{ entry, bytes }`, with `bytes` null when the folder no longer holds the file. */
    async readOriginal(id) {
      const { entries } = await readManifest()
      const entry = liveEntry(entries, id)
      return { entry, bytes: await io.readBytes(sourceFilePath(entry.filename)) }
    },

    /** The text kept for a document, or null when it has none. */
    async readText(id) {
      const { entries } = await readManifest()
      const entry = liveEntry(entries, id)
      if (!entry.text) return null
      const stored = await io.readText(sourceTextPath(entry.filename))
      return stored ? stored.text : null
    },
  }
}
