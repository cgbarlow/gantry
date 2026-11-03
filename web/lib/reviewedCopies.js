// #302 (ADR-0066): the browser's side of bringing a **Reviewed copy** in and listing what came back.
//
//   analyseReviewFiles   read the chosen files with Gantry's own reader and say, before anything is kept,
//                        which are one of this Instance's renders and which are refused (and why)
//   uploadReviewedCopies a server workspace or a Provider-hosted Instance: POST the accepted ones
//   addReviewedCopiesLocally a Local workspace: the same files and manifest, written into its folder
//   loadReviewedCopies   every kept copy, read and placed on its Fields, for the editor to list
//
// What is kept and where is web/lib/reviewManifest.js; the reading and placing is web/lib/reviewedCopy.js.
// Reads and writes go through an `io` object so the Local workspace (a folder handle) and the others (HTTP)
// share everything else: `remoteReviewIo` and `localReviewIo` build one.
import {
  REVIEWED_COPY_MAX_BYTES,
  ReviewedCopyError,
  buildFieldIndex,
  checkReviewedCopy,
  placeReview,
  readReviewedCopy,
  summariseReview,
} from './reviewedCopy.js'
import { REVIEWS_MANIFEST_PATH, isReviewId, parseReviewManifest, reviewFilePath, reviewManifestEntry, stringifyReviewManifest, withAnsweredCounts } from './reviewManifest.js'

const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const REVIEW_FILE_ACCEPT = `.docx,${WORD_MIME}`

/** A new id for a Reviewed copy; fixed for its life. */
export function newReviewId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** What an Instance expects of a document brought in to it, from the editor's `instance` (`checkReviewedCopy`'s second argument). */
export function expectedFromInstance(instance) {
  return {
    slug: instance.slug,
    definition: instance.definition,
    // The editor only knows the Artefacts of the stage in view, so the server (or a Local workspace's own full list) checks them.
    artefactIds: instance.localDefinitionStructure ? instance.localDefinitionStructure.artefacts.map((artefact) => artefact.id) : undefined,
  }
}

/**
 * Reads the chosen files. `files` are `File`s (or anything with `name`, `size` and `arrayBuffer()`); `expected`
 * is `expectedFromInstance(instance)`. Resolves `{ items, total, tooBig }`, one item per file in order:
 * `{ name, size, ok, code?, message?, bytes?, read?, summary? }`. An accepted item carries its `bytes` and `read`.
 */
export async function analyseReviewFiles(files, expected) {
  const items = []
  let total = 0
  for (const file of files) {
    total += file.size
    if (!/\.docx$/i.test(file.name)) {
      items.push({ name: file.name, size: file.size, ok: false, code: 'not-word', message: 'This is not a Word (.docx) document.' })
      continue
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let read
    try {
      read = await readReviewedCopy(bytes)
    } catch (err) {
      if (!(err instanceof ReviewedCopyError)) throw err
      items.push({ name: file.name, size: file.size, ok: false, code: err.code, message: err.message })
      continue
    }
    const verdict = checkReviewedCopy(read.properties, expected)
    items.push(
      verdict.ok
        ? { name: file.name, size: file.size, ok: true, bytes, read, summary: summariseReview(read) }
        : { name: file.name, size: file.size, ok: false, code: verdict.code, message: verdict.message }
    )
  }
  return { items, total, tooBig: total > REVIEWED_COPY_MAX_BYTES }
}

function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

/**
 * Sends the accepted items to a server workspace or a Provider-hosted Instance: one request, which is one
 * commit on the current Stage's branch for a Provider. Resolves the manifest entries that were added;
 * rejects with the server's reason (`err.files` has the per-file verdicts when it refused the upload).
 */
export async function uploadReviewedCopies(slug, items, apiFetchForInstance) {
  const res = await apiFetchForInstance(slug, `/api/instance/reviews?slug=${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: items.map((item) => ({ filename: item.name, dataBase64: toBase64(item.bytes) })) }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message ?? body.error ?? `the server answered ${res.status}`)
    err.files = body.files
    throw err
  }
  return body.reviews
}

/**
 * A Local workspace's twin of the upload: each accepted item is written as `reviews/<id>.docx` in the
 * Instance's folder and the manifest gains its entries. `io.writeBinary(path, bytes)`, `io.writeText(path,
 * text)` and `io.readText(path)` take paths relative to the workspace folder, `gantry-workspace/<slug>/…`.
 */
export async function addReviewedCopiesLocally(slug, items, io, { now = () => new Date() } = {}) {
  const root = `gantry-workspace/${slug}`
  const added = []
  for (const item of items) {
    const id = newReviewId()
    await io.writeBinary(`${root}/${reviewFilePath(id)}`, item.bytes)
    added.push(reviewManifestEntry({ id, read: item.read, name: item.name, date: now().toISOString(), size: item.bytes.length }))
  }
  const existing = parseReviewManifest(await io.readText(`${root}/${REVIEWS_MANIFEST_PATH}`).catch(() => ''))
  await io.writeText(`${root}/${REVIEWS_MANIFEST_PATH}`, stringifyReviewManifest([...existing, ...added]))
  return added
}

/**
 * #303: after review comments were answered, raises the manifest's answered counts (`counts` is `{ [reviewId]: n }`, from the decisions logs). A server
 * workspace or a Provider-hosted Instance is told over HTTP; a Local workspace writes its own manifest. Resolves the manifest entries as they now stand.
 */
export async function recordAnsweredReviews(slug, counts, apiFetchForInstance) {
  const res = await apiFetchForInstance(slug, `/api/instance/reviews/answered?slug=${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answered: counts }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message ?? body.error ?? `the server answered ${res.status}`)
  return body.reviews
}

export async function recordAnsweredReviewsLocally(slug, counts, io) {
  const path = `gantry-workspace/${slug}/${REVIEWS_MANIFEST_PATH}`
  const { entries, changed } = withAnsweredCounts(parseReviewManifest(await io.readText(path).catch(() => '')), counts)
  if (changed) await io.writeText(path, stringifyReviewManifest(entries))
  return entries
}

// --- Reading what was kept -----------------------------------------------------------------------------------

/** An `io` for a server workspace or a Provider-hosted Instance, over `apiFetchForInstance(slug, url, options)`. */
export function remoteReviewIo(slug, apiFetchForInstance) {
  const q = (path, extra = '') => `${path}?slug=${encodeURIComponent(slug)}${extra}`
  const fail = async (res, what) => {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `Couldn't ${what} (${res.status})`)
  }
  return {
    kind: 'remote',
    async listManifest() {
      const res = await apiFetchForInstance(slug, q('/api/instance/reviews'))
      if (!res.ok) await fail(res, 'list the Reviewed copies')
      return (await res.json()).reviews ?? []
    },
    async readFile(entry) {
      const res = await apiFetchForInstance(slug, q(`/api/instance/reviews/${encodeURIComponent(entry.id)}/file`))
      if (!res.ok) await fail(res, 'read a Reviewed copy')
      return new Uint8Array(await res.arrayBuffer())
    },
    async basis({ commit, texts }) {
      const extra = `${commit ? `&commit=${encodeURIComponent(commit)}` : ''}${texts ? '' : '&texts=0'}`
      const res = await apiFetchForInstance(slug, q('/api/instance/review-basis', extra))
      if (!res.ok) await fail(res, 'read the content a render came from')
      return res.json()
    },
  }
}

/**
 * An `io` for a Local workspace: `readText(path)` and `readBinary(path)` read the workspace folder, and
 * `localBasis({ texts })` gives today's content of every Field (`{ basis: 'today', fields }`), since a
 * folder has no history to rebuild a render from.
 */
export function localReviewIo(slug, { readText, readBinary, localBasis }) {
  const root = `gantry-workspace/${slug}`
  return {
    kind: 'local',
    async listManifest() {
      return parseReviewManifest(await readText(`${root}/${REVIEWS_MANIFEST_PATH}`).catch(() => ''))
    },
    async readFile(entry) {
      if (!isReviewId(entry.id)) throw new Error('Not a Reviewed copy')
      return readBinary(`${root}/${reviewFilePath(entry.id)}`)
    },
    basis: (options) => localBasis(options),
  }
}

/**
 * Reads one kept copy and places its comments: `{ entry, read, placed }`, or `{ entry, error }` when it can't
 * be read (a missing file, say), so one bad copy doesn't hide the rest. The Fields come from the Definition;
 * only a copy that lost its Field bookmarks, or has a comment they don't place, also needs the Fields'
 * wording, which is fetched at the render's commit (or as it is today where there is none).
 */
export async function loadReviewedCopy(io, entry) {
  try {
    const read = await readReviewedCopy(await io.readFile(entry))
    let basis = await io.basis({ texts: false })
    let placed = placeReview(read, { fieldIndex: buildFieldIndex(basis.fields) })
    const anything = read.threads.length > 0 || read.changes.length > 0
    if (anything && (read.fieldBookmarks === 0 || placed.groups.some((group) => group.kind === 'unplaced'))) {
      basis = await io.basis({ commit: read.properties.commit || entry.commit, texts: true })
      placed = placeReview(read, { fieldIndex: buildFieldIndex(basis.fields), basis })
    }
    return { entry, read, placed, basis }
  } catch (err) {
    return { entry, error: err.message }
  }
}

/** Every kept copy, read and placed, in the order they were brought in. */
export async function loadReviewedCopies(io) {
  const entries = await io.listManifest()
  const copies = []
  for (const entry of entries) copies.push(await loadReviewedCopy(io, entry))
  return copies
}

/** A date for a list: the day, as an ISO date (`2026-11-03`). */
export function reviewDay(iso) {
  return String(iso ?? '').slice(0, 10)
}

/** "Ana Reviewer, 2026-11-03" */
export function threadByline(item) {
  return [item.author, reviewDay(item.date)].filter(Boolean).join(', ')
}
