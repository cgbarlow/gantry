// #279: the browser's half of a server workspace's Source documents, over the /api/instance/sources routes (lib/server.js). It has the same methods as the store a Local Workspace uses (web/lib/sourceDocuments.js's createSourceStore), so the panel (web/lib/sourceDocumentsPanel.js) does not care which it is given.
import { SourceDocumentError } from './sourceDocuments.js'

function bytesToBase64(bytes) {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

/**
 * `fetchForInstance(url, init)` is `apiFetchForInstance` bound to this Instance's slug: it works out the workspace and attaches its credential.
 */
export function createServerSourceClient(slug, fetchForInstance) {
  const qs = `?slug=${encodeURIComponent(slug)}`
  const path = (suffix = '') => `/api/instance/sources${suffix}${qs}`
  const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  async function parse(res, failure) {
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new SourceDocumentError(body.error ?? body.message ?? `${failure} (${res.status})`, { code: body.code, status: res.status })
    return body
  }

  return {
    async list() {
      const { entries, totalBytes, warning } = await parse(await fetchForInstance(path()), 'Failed to load Source documents')
      return { entries, totalBytes, warning }
    },
    async upload({ filename, bytes, text, title, uploadedBy }) {
      const res = await fetchForInstance(path(), { method: 'POST', ...json({ filename, dataBase64: bytesToBase64(bytes), text, title, uploadedBy }) })
      return parse(res, 'Failed to upload')
    },
    async rename(id, title) {
      return (await parse(await fetchForInstance(path(`/${encodeURIComponent(id)}`), { method: 'PATCH', ...json({ title }) }), 'Failed to rename')).entry
    },
    /** #292: **Read visually** on or off for a PDF. */
    async setReadVisually(id, on) {
      return (await parse(await fetchForInstance(path(`/${encodeURIComponent(id)}`), { method: 'PATCH', ...json({ readVisually: on === true }) }), 'Failed to change how the AI reads it')).entry
    },
    async remove(id, { removedBy } = {}) {
      return (await parse(await fetchForInstance(path(`/${encodeURIComponent(id)}`), { method: 'DELETE', ...json({ removedBy }) }), 'Failed to remove')).entry
    },
    async setText(id, text) {
      return (await parse(await fetchForInstance(path(`/${encodeURIComponent(id)}/text`), { method: 'PUT', ...json({ text }) }), 'Failed to save the text')).entry
    },
    /** **Use as image** (#281): the server copies the stored document into the Instance's Assets as a new, independent Asset. Returns `{ id, filename, name, reference }`. */
    async useAsImage(id, { uploadedBy } = {}) {
      const { asset, reference } = await parse(await fetchForInstance(path(`/${encodeURIComponent(id)}/as-asset`), { method: 'POST', ...json({ uploadedBy }) }), 'Failed to copy to the images')
      return { ...asset, reference }
    },
    /** The text kept for a document, or null when it has none. */
    async readText(id) {
      const res = await fetchForInstance(path(`/${encodeURIComponent(id)}/text`))
      if (res.status === 404) return null
      if (!res.ok) await parse(res, 'Failed to read the text')
      return res.text()
    },
    async readOriginal(id) {
      const res = await fetchForInstance(path(`/${encodeURIComponent(id)}/file`))
      if (!res.ok) await parse(res, 'Failed to download')
      return { bytes: new Uint8Array(await res.arrayBuffer()) }
    },
  }
}
