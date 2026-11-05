import { zipSync } from 'fflate'

// #338 (docs/adr/0074): the zip archive a stand-in Provider answers for "the repository at this commit", built from its stored files the way
// each real Provider lays one out. `top` is the archive's own top-level folder (every Provider but Azure DevOps has one); `folder`, when
// given, keeps only the files under that folder, and `relative` then puts them in the archive relative to it rather than at their full path
// (the two ways a Provider's folder archive might come, both of which lib/repositoryCopy.js takes). `extra` adds entries as they are
// (a submodule's empty folder, `name/`, say).
export function zipOfFiles(store, { top = '', folder = null, relative = false, extra = {} } = {}) {
  const entries = {}
  const prefix = top ? `${top.replace(/\/+$/, '')}/` : ''
  if (prefix) entries[prefix] = new Uint8Array(0)
  for (const [rawPath, content] of store) {
    const path = String(rawPath).replace(/^\/+/, '')
    if (folder && path !== folder && !path.startsWith(`${folder}/`)) continue
    const inArchive = folder && relative ? path.slice(folder.length + 1) : path
    entries[`${prefix}${inArchive}`] = Buffer.isBuffer(content) ? new Uint8Array(content) : new TextEncoder().encode(String(content))
  }
  for (const [name, content] of Object.entries(extra)) entries[`${prefix}${name}`] = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return Buffer.from(zipSync(entries, { level: 1 }))
}

/**
 * Answers `res` with `zip`. `delayMs` spreads the answer over that long (half of it straight away, the rest after the wait), so a test can
 * see a download under way with some bytes received.
 */
export async function sendArchive(res, zip, { delayMs = 0 } = {}) {
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zip.length) })
  if (!delayMs) return res.end(zip)
  const half = Math.floor(zip.length / 2)
  res.write(zip.subarray(0, half))
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (!res.destroyed) res.end(zip.subarray(half))
}
