// #279: a Local Workspace's Source documents, kept in the Instance's own `sources/` folder on the architect's machine and read and written through the folder handle, with no server round trip (ADR-0029). The folder, the manifest and the lifecycle are web/lib/sourceDocuments.js's, shared with a server workspace; this file only supplies the folder-handle half of the file interface that module is written against.
import { readBinaryFile, readTextFile, removeFile, writeBinaryFile, writeTextFile } from './localWorkspace.js'
import { createSourceStore } from './sourceDocuments.js'

const isMissing = (err) => err?.name === 'NotFoundError' || err?.name === 'TypeMismatchError'

/**
 * The store for the Source documents of `slug` in the local workspace folder `handle`.
 */
export function createLocalSourceStore(handle, slug, options = {}) {
  const at = (path) => `gantry-workspace/${slug}/${path}`

  async function readText(path) {
    try {
      const text = await readTextFile(handle, at(path))
      // A folder keeps no version of a file, so the text itself stands for it: a write that says "only if it still reads like this" can be checked by reading it again.
      return { text, version: text }
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  const io = {
    readText,
    async readBytes(path) {
      try {
        return await readBinaryFile(handle, at(path))
      } catch (err) {
        if (isMissing(err)) return null
        throw err
      }
    },
    async writeText(path, text, { ifVersion } = {}) {
      if (ifVersion !== undefined) {
        const current = await readText(path)
        const holds = ifVersion === null ? current === null : current !== null && current.version === ifVersion
        if (!holds) throw Object.assign(new Error(`Cannot write ${path}: it changed since it was read`), { code: 'STORAGE_CONFLICT' })
      }
      await writeTextFile(handle, at(path), text)
    },
    async writeBytes(path, bytes) {
      await writeBinaryFile(handle, at(path), bytes)
    },
    async remove(path) {
      await removeFile(handle, at(path))
    },
  }
  return createSourceStore(io, options)
}
