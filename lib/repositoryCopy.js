import vm from 'node:vm'
import { unzipSync } from 'fflate'
import { cleanRepositoryPath, looksBinary, skippedRepositoryPath } from '../web/lib/sourceRepository.js'

// #338 (docs/adr/0074): one **Repository copy**, the repository's files at one commit, unpacked from the single archive the Provider gives
// for that commit and held in the server's memory (lib/repositoryCopies.js keeps them). This file knows how to turn an archive into a copy
// and how to answer a list, a find by name, or a search of the text from one. It never talks to a Provider: lib/repositorySource.js
// downloads the archive and decides when a copy is used.
//
// A copy holds the text of every file Gantry would read, and only the names of what it leaves out: the paths always skipped are not in
// it at all (as when reading file by file), and binaries, files over 1 MB and Git LFS placeholders are named but have no text, so a find
// or a list still shows them and a search passes them by.

/** A file bigger than this is left out of a copy (the same 1 MB a single read is held to, lib/repositorySource.js). */
export const MAX_COPY_FILE_BYTES = 1024 * 1024
/** A page of a search holds this many matching lines; a page of a find, a list or a files-only search holds this many paths. */
export const SEARCH_PAGE_LINES = 50
export const PATH_PAGE_SIZE = 200
/** The most lines of context a search shows on each side of a match. */
export const MAX_CONTEXT_LINES = 5
/** A regular expression longer than this is refused, and one search by regular expression may run this long before it says so. */
export const MAX_PATTERN_LENGTH = 300
export const REGEX_TIME_BUDGET_MS = 2000
/** What a line of a match or of its context is cut to, as a search has always done. */
const LINE_TEXT_LIMIT = 200

/** A repository that won't fit: its kept text is over the per-repository limit, or its archive over what the server holds. */
export class CopyTooBigError extends Error {
  constructor(message = 'The repository is too big to copy.') {
    super(message)
    this.name = 'CopyTooBigError'
  }
}

// A Git LFS placeholder: the small text file Git keeps in place of a large file stored elsewhere. The archive gives the placeholder, not the file.
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\b/

/**
 * Reads an archive's answer to the end, at most `limitBytes` of it, calling `onProgress(bytesSoFar)` as it arrives. Throws
 * CopyTooBigError as soon as the answer says, or turns out, to be bigger than that, without reading the rest.
 */
export async function readArchiveBody(res, { limitBytes, onProgress = () => {}, receivedBefore = 0 } = {}) {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limitBytes) {
    await res.body?.cancel?.().catch(() => {})
    throw new CopyTooBigError()
  }
  const chunks = []
  let received = 0
  for await (const chunk of res.body ?? []) {
    received += chunk.byteLength
    if (received > limitBytes) throw new CopyTooBigError()
    chunks.push(chunk)
    onProgress(receivedBefore + received)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
}

/** An empty copy, which `unpackRepositoryArchive` fills; one copy may be filled from several archives (one per folder). */
export function emptyCopy() {
  return { files: new Map(), leftOut: new Map(), folders: new Set(), bytes: 0 }
}

function addFolders(copy, path) {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) copy.folders.add(parts.slice(0, i).join('/'))
}

/**
 * Unpacks a zip archive of the repository into `into` (a copy from `emptyCopy`). The archive's own top-level folder is stripped (every
 * Provider but Azure DevOps puts the repository under one). `folder`, when the archive holds only that folder of the repository, says so:
 * an archive whose paths start below it has them put back under it. `keep(path)` may narrow what is kept further. Throws CopyTooBigError
 * once the kept text passes `limitBytes`, before any more of it is unpacked.
 */
export function unpackRepositoryArchive(zipBytes, { provider, folder = null, limitBytes = Infinity, keep = () => true, into = emptyCopy() } = {}) {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes)
  // The names first, without unpacking anything, to see whether they all sit under one top-level folder.
  const names = []
  unzipSync(bytes, { filter: (file) => (names.push(file.name), false) })
  let strip = ''
  if (provider !== 'azure-devops' && names.length) {
    const first = names[0].split('/')[0]
    if (first && names.every((name) => name === first || name.startsWith(`${first}/`))) strip = `${first}/`
  }
  const relative = (name) => cleanRepositoryPath(name.startsWith(strip) ? name.slice(strip.length) : name)
  const cleanFolder = folder ? cleanRepositoryPath(folder) : null
  const underFolder = (path) => !cleanFolder || path === cleanFolder || path.startsWith(`${cleanFolder}/`)
  const putBack = cleanFolder && !names.map(relative).filter(Boolean).every(underFolder)
  const pathOf = (name) => {
    const path = relative(name)
    if (!path) return null
    return putBack ? `${cleanFolder}/${path}` : path
  }

  let kept = into.bytes
  const wanted = new Map()
  const unpacked = unzipSync(bytes, {
    filter: (file) => {
      const path = pathOf(file.name)
      if (!path || skippedRepositoryPath(path)) return false
      // A folder entry, which is also how a submodule appears: shown as a folder, never followed.
      if (file.name.endsWith('/')) {
        if (keep(path, { isFolder: true })) {
          into.folders.add(path)
          addFolders(into, path)
        }
        return false
      }
      if (!keep(path, { isFolder: false })) return false
      addFolders(into, path)
      if (file.originalSize > MAX_COPY_FILE_BYTES) {
        into.leftOut.set(path, { reason: 'too-large', size: file.originalSize })
        return false
      }
      kept += file.originalSize
      if (kept > limitBytes) throw new CopyTooBigError()
      wanted.set(file.name, path)
      return true
    },
  })
  for (const [name, content] of Object.entries(unpacked)) {
    const path = wanted.get(name)
    if (!path) continue
    const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    if (looksBinary(buffer)) {
      into.leftOut.set(path, { reason: 'binary', size: buffer.byteLength })
      continue
    }
    const text = buffer.toString('utf8')
    if (LFS_POINTER.test(text)) {
      into.leftOut.set(path, { reason: 'lfs', size: buffer.byteLength })
      continue
    }
    into.files.set(path, text)
    into.bytes += buffer.byteLength
  }
  delete into.index
  return into
}

// The copy's folders and files by their parent folder, built once, on first use.
function indexOf(copy) {
  if (copy.index) return copy.index
  const children = new Map()
  const add = (path, isFolder) => {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (!children.has(parent)) children.set(parent, new Map())
    children.get(parent).set(path, isFolder)
  }
  for (const folder of copy.folders) add(folder, true)
  for (const path of [...copy.files.keys(), ...copy.leftOut.keys()]) add(path, false)
  const allFiles = [...copy.files.keys(), ...copy.leftOut.keys()].sort((a, b) => a.localeCompare(b))
  copy.index = { children, allFiles }
  return copy.index
}

/** A folder's children in the copy, `[{ path, isFolder }]`, folders first, each group by name: the order a listing has always had. */
export function listCopyFolder(copy, path) {
  const entries = [...(indexOf(copy).children.get(path) ?? new Map())].map(([child, isFolder]) => ({ path: child, isFolder }))
  return entries.sort((a, b) => (a.isFolder === b.isFolder ? a.path.localeCompare(b.path) : a.isFolder ? -1 : 1))
}

/** Every file the copy names (text or left out), sorted by path. */
export function copyFilePaths(copy) {
  return indexOf(copy).allFiles
}

/**
 * A name pattern as a test of a path: `*` is any run of characters within one folder name, `**` any number of folders, `?` one character
 * and `{a,b}` either. Case is ignored, as a search ignores it. A pattern with no `/` is matched against a file's own name wherever it is
 * (`*.tf`), one with a `/` against its whole path (`src/** /order*`, without the space).
 */
export function namePatternTest(pattern) {
  const source = String(pattern ?? '').trim().replace(/^\/+/, '')
  let re = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '*' && source[i + 1] === '*') {
      i++
      if (source[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = source.indexOf('}', i)
      if (end === -1) re += '\\{'
      else {
        re += `(?:${source.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')).join('|')})`
        i = end
      }
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const test = new RegExp(`^${re}$`, 'i')
  const byName = !source.includes('/')
  return (path) => test.test(byName ? path.slice(path.lastIndexOf('/') + 1) : path)
}

/**
 * A file-type filter as a test of a path: each entry an extension (`ts`, `.ts`) or a name pattern (`*.test.js`). No filter takes every file.
 */
export function fileTypeTest(fileTypes) {
  const list = (Array.isArray(fileTypes) ? fileTypes : typeof fileTypes === 'string' ? fileTypes.split(',') : [])
    .map((type) => String(type ?? '').trim())
    .filter(Boolean)
  if (!list.length) return () => true
  const tests = list.map((type) => (/[*?{]/.test(type) ? namePatternTest(type) : ((ext) => (path) => path.toLowerCase().endsWith(ext))(`.${type.replace(/^\.+/, '').toLowerCase()}`)))
  return (path) => tests.some((test) => test(path))
}

/** Items `page` of `items`, `size` a page: `{ items, page, pageSize, total, pages, nextPage? }`. A page past the end is empty. */
export function pageOf(items, page, size) {
  const at = wholePage(page)
  const pages = Math.ceil(items.length / size)
  return { items: items.slice((at - 1) * size, at * size), page: at, pageSize: size, total: items.length, pages, ...(at < pages ? { nextPage: at + 1 } : {}) }
}

/** A page number as asked, or 1. */
export const wholePage = (page) => (Number.isInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1)

// The scan a search runs over its files, as source, so that a search by regular expression runs it inside a `vm` context with a time limit:
// that limit is the one thing that stops a regular expression that backtracks without end, since nothing interrupts a regular expression
// from the outside. It counts every matching line and file, and keeps only the page asked for. Kept self-contained: it sees only `input`
// and writes only to `out`.
const SCAN = new vm.Script(`(() => {
  const { files, source, regex, context, filesOnly, skip, take, limit } = input
  const pattern = regex ? new RegExp(source, 'i') : null
  const needle = regex ? '' : source.toLowerCase()
  const cut = (text) => text.replace(/\\s+$/, '').slice(0, limit)
  for (let f = 0; f < files.length; f++) {
    const path = files[f][0]
    const text = files[f][1]
    if (!regex && !text.toLowerCase().includes(needle)) {
      out.searched = f + 1
      continue
    }
    const lines = text.split('\\n')
    let count = 0
    for (let i = 0; i < lines.length; i++) {
      if (!(regex ? pattern.test(lines[i]) : lines[i].toLowerCase().includes(needle))) continue
      count++
      if (filesOnly) continue
      const n = out.totalMatches++
      if (n < skip || n >= skip + take) continue
      const match = { path, line: i + 1, text: lines[i].trim().slice(0, limit) }
      if (context > 0) {
        match.before = []
        match.after = []
        for (let j = Math.max(0, i - context); j < i; j++) match.before.push({ line: j + 1, text: cut(lines[j]) })
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++) match.after.push({ line: j + 1, text: cut(lines[j]) })
      }
      out.matches.push(match)
    }
    if (count) {
      const n = out.totalFiles++
      if (filesOnly && n >= skip && n < skip + take) out.matches.push({ path, count })
    }
    out.searched = f + 1
  }
})()`)

let scanContext = null

/**
 * A pattern for `scanTexts`, or a refusal sentence: `{ source, regex }` or `{ refusal }`. Plain text needs two characters; a regular
 * expression one, at most MAX_PATTERN_LENGTH, and it must be valid.
 */
export function searchPattern(query, { regex = false } = {}) {
  const source = String(query ?? '').trim()
  if (!regex) return source.length < 2 ? { refusal: 'Search for at least two characters.' } : { source, regex: false }
  if (!source) return { refusal: 'Give a regular expression to search for.' }
  if (source.length > MAX_PATTERN_LENGTH) return { refusal: `A regular expression can be at most ${MAX_PATTERN_LENGTH} characters; this one is ${source.length}. Make it shorter, or search for plain text.` }
  try {
    new RegExp(source, 'i')
  } catch (err) {
    return { refusal: `"${source}" isn't a regular expression Gantry can use (${err.message.replace(/^Invalid regular expression: /, '')}).` }
  }
  return { source, regex: true }
}

/**
 * Searches `files` (`[[path, text]]`, in the order to search them) for `pattern` (from `searchPattern`), counting every match and keeping
 * the page from `skip`, `take` long: `{ matches, totalMatches, totalFiles, searched, timedOut }`. Each match is `{ path, line, text }`
 * with `before` and `after` (`[{ line, text }]`) when `context` lines are asked for, or `{ path, count }` in files-only mode, where the
 * page is of files. A regular expression gives up at `budgetMs` with what it has (`timedOut: true`); plain text always finishes.
 */
export function scanTexts(files, { pattern, context = 0, filesOnly = false, skip = 0, take = SEARCH_PAGE_LINES, budgetMs = REGEX_TIME_BUDGET_MS }) {
  const out = { matches: [], totalMatches: 0, totalFiles: 0, searched: 0 }
  // One context serves every scan (each runs to its end before the next starts); one cut off at its time limit is replaced.
  scanContext ??= vm.createContext({})
  scanContext.input = { files, source: pattern.source, regex: pattern.regex, context: Math.max(0, Math.min(MAX_CONTEXT_LINES, Math.trunc(Number(context) || 0))), filesOnly: Boolean(filesOnly), skip, take, limit: LINE_TEXT_LIMIT }
  scanContext.out = out
  let timedOut = false
  try {
    SCAN.runInContext(scanContext, pattern.regex ? { timeout: Math.max(1, Math.floor(budgetMs)) } : {})
  } catch (err) {
    if (err?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err
    timedOut = true
    scanContext = null
  } finally {
    if (scanContext) scanContext.input = scanContext.out = null
  }
  // Out of the sandbox's own objects into plain ones, so an answer is ordinary JSON wherever it goes.
  return { ...JSON.parse(JSON.stringify({ matches: out.matches })), totalMatches: out.totalMatches, totalFiles: out.totalFiles, searched: out.searched, timedOut }
}

/**
 * A line range for a read, `{ from, to }` (1-based, both included), from what a caller sends: `{ from, to }`, `[from, to]` or `"from-to"`
 * (`to` may be left out to read to the end). Null when no range was asked for; `{ refusal }` for one that makes no sense.
 */
export function lineRange(lines) {
  if (lines === undefined || lines === null || lines === '') return null
  let from
  let to
  if (Array.isArray(lines)) [from, to] = lines
  else if (typeof lines === 'object') ({ from, to } = lines)
  else {
    const match = String(lines).trim().match(/^(\d+)\s*(?:-\s*(\d*))?$/)
    if (!match) return { refusal: `Give a line range as from-to, such as 10-40; "${lines}" isn't one.` }
    from = match[1]
    to = match[2] === undefined ? match[1] : match[2] || undefined
  }
  from = Number(from ?? 1)
  to = to === undefined || to === null || to === '' ? Infinity : Number(to)
  if (!Number.isInteger(from) || from < 1 || !(Number.isInteger(to) || to === Infinity) || to < from) {
    return { refusal: 'A line range starts at line 1 or later and ends at or after where it starts.' }
  }
  return { from, to }
}
