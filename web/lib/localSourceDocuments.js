// #279: a Local Workspace's Source documents, kept in the Instance's own `sources/` folder on the architect's machine and read and written through the folder handle, with no server round trip (ADR-0029). The folder, the manifest and the lifecycle are web/lib/sourceDocuments.js's, shared with a server workspace; this file only supplies the folder-handle half of the file interface that module is written against.
import { listDir, readBinaryFile, readTextFile, removeFile, writeBinaryFile, writeTextFile } from './localWorkspace.js'
import { SourceDocumentError, USE_AS_IMAGE_REFUSAL, assetFilenameForSource, canUseSourceAsImage, createSourceStore } from './sourceDocuments.js'

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
  const store = createSourceStore(io, options)
  return {
    ...store,
    /**
     * **Use as image** (#281): copies the document into the Instance's `assets/` folder as a new file of its own, the way a Local Workspace keeps every image, to be referenced as `![alt](assets/<name>)`. The Asset keeps no link back to the document: removing either leaves the other alone. Returns `{ id, filename, name, reference }`.
     */
    async useAsImage(id) {
      const { entry, bytes } = await store.readOriginal(id)
      if (!canUseSourceAsImage(entry.filename)) throw new SourceDocumentError(USE_AS_IMAGE_REFUSAL, { code: 'not-an-image' })
      if (!bytes) throw new SourceDocumentError(`The file for "${entry.title}" is missing from this Instance's sources folder.`, { code: 'file-missing', status: 404 })
      const taken = (await listDir(handle, at('assets')).catch(() => [])).map((e) => e.name)
      const filename = assetFilenameForSource(entry.filename, taken)
      await writeBinaryFile(handle, at(`assets/${filename}`), bytes)
      const alt = entry.title.replace(/[[\]]/g, '')
      return { id: filename, filename, name: entry.title, reference: `![${alt}](assets/${filename})` }
    },
  }
}
