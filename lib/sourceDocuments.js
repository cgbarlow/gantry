import { extname } from 'node:path'
import { SOURCE_MEDIA_TYPES, SourceDocumentError, USE_AS_IMAGE_REFUSAL, canUseSourceAsImage, createSourceStore } from '../web/lib/sourceDocuments.js'
import { assetReference } from '../web/lib/assetRefs.js'
import { createAsset } from './assets.js'
import { getBytesOrNull, getTextVersionedOrNull } from './storageFiles.js'

// #279 (docs/adr/0070): a server workspace's Source documents, read and written through the storage layer (lib/storage.js) like its assets, so a Blob container can sit behind them. The folder, the manifest and the lifecycle are web/lib/sourceDocuments.js's, shared with a Local Workspace; this file only supplies the server's half of the file interface that module is written against, and the headers a download is served with (the media types themselves are web/lib/sourceDocuments.js's SOURCE_MEDIA_TYPES, which the fetch from a web address reads too).

/**
 * The store for one Instance's Source documents. `storage` is the asynchronous half of lib/storage.js, `instancesDir` the directory (or key prefix) holding the Instance folders, as for `createAsset`.
 */
export function createInstanceSourceStore(storage, instancesDir, slug, options = {}) {
  const key = (path) => `${instancesDir}/${slug}/${path}`
  const io = {
    readText: (path) => getTextVersionedOrNull(storage, key(path)),
    readBytes: (path) => getBytesOrNull(storage, key(path)),
    writeText: (path, text, writeOptions) => storage.putText(key(path), text, writeOptions),
    writeBytes: (path, bytes) => storage.putBytes(key(path), bytes),
    remove: (path) => storage.remove(key(path)),
  }
  const store = createSourceStore(io, options)
  return {
    ...store,
    /**
     * **Use as image** (#281): copies the stored document into the Instance's Assets as a new Asset of its own (a PNG or JPEG only). The Asset's source is where it was copied from, `sources/<file>`, and it keeps no link back: removing either leaves the other alone. Returns `{ asset, reference }`, the reference being what to put in a field to show it.
     */
    async useAsImage(id, { uploadedBy = '' } = {}) {
      const { entry, bytes } = await store.readOriginal(id)
      if (!canUseSourceAsImage(entry.filename)) throw new SourceDocumentError(USE_AS_IMAGE_REFUSAL, { code: 'not-an-image', status: 400 })
      if (!bytes) throw new SourceDocumentError(`The file for "${entry.title}" is missing from the Instance's sources folder.`, { code: 'file-missing', status: 404 })
      const asset = await createAsset(
        slug,
        { filename: entry.filename, buffer: Buffer.from(bytes), name: entry.title, uploadedBy },
        { storage, instancesDir, copiedFromSource: `sources/${entry.filename}` }
      )
      return { asset, reference: assetReference({ id: asset.id, name: entry.title.replace(/[[\]]/g, '') }) }
    },
  }
}

/**
 * The headers a stored Source document is downloaded with. A type Gantry does not take is `application/octet-stream`, so an unexpected upload, or a web page fetched as its HTML (#318), can never run in the app's own origin. A PDF or image shows in the tab; everything else downloads under its stored name.
 */
export function sourceDownloadHeaders(storedFilename, bytesLength) {
  const ext = extname(storedFilename).toLowerCase()
  const contentType = SOURCE_MEDIA_TYPES[ext] ?? 'application/octet-stream'
  const inline = ext === '.pdf' || contentType.startsWith('image/')
  return {
    'Content-Type': contentType,
    'Content-Length': bytesLength,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(storedFilename)}`,
    'X-Content-Type-Options': 'nosniff',
  }
}
