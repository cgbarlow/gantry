// #318 (docs/adr/0071): the browser's half of adding a Source document from a web address. Browsers refuse most cross-site fetches, so the
// Gantry server fetches the page (POST /api/sources/fetch, lib/sourceFetch.js) and hands the bytes back; the panel then reads the text exactly
// as for an upload and stores the document through the Instance's own store, so a Local Workspace keeps it in its own folder. Nothing here
// stores anything.
import { SourceDocumentError } from './sourceDocuments.js'

/** Shown when a Local Workspace's Gantry server can't be reached: the folder still works, but only the server can fetch a page. */
export const SOURCE_FETCH_NEEDS_SERVER = "Adding a document by web address needs the Gantry server, which can't be reached right now. Uploading still works: save the page as a PDF and upload it."

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Asks the Gantry server whether it offers adding by address. `{ enabled: true }`, `{ enabled: false }` when the operator has switched it
 * off (the option is then not offered at all), or `{ enabled: false, unreachable: true }` when the server can't be reached.
 */
export async function sourceFetchStatus(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/sources/fetch')
    if (!res.ok) return { enabled: false, unreachable: res.status >= 500 }
    const body = await res.json()
    return { enabled: body?.enabled === true }
  } catch {
    return { enabled: false, unreachable: true }
  }
}

/**
 * Has the Gantry server fetch `address`. Resolves `{ address, finalAddress, fetchedAt, contentType, filename, title, bytes }` (`bytes` a
 * `Uint8Array`), or rejects with a `SourceDocumentError` carrying the server's sentence for what went wrong.
 */
export async function fetchSourceAddress(address, fetchImpl = fetch) {
  let res
  try {
    res = await fetchImpl('/api/sources/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) })
  } catch {
    throw new SourceDocumentError(SOURCE_FETCH_NEEDS_SERVER, { code: 'server-unreachable', status: 503 })
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new SourceDocumentError(body.error ?? `Could not fetch that address (${res.status}).`, { code: body.code, status: res.status })
  const { dataBase64, size: _size, ...rest } = body
  return { ...rest, bytes: base64ToBytes(dataBase64 ?? '') }
}

/** The `origin` a fetched document's manifest entry records, from what `fetchSourceAddress` gave. */
export function originOf(fetched) {
  return { address: fetched.address, finalAddress: fetched.finalAddress, fetchedAt: fetched.fetchedAt }
}
