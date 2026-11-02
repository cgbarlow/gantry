import { extname } from 'node:path'
import { createSourceStore } from '../web/lib/sourceDocuments.js'
import { getBytesOrNull, getTextVersionedOrNull } from './storageFiles.js'

// #279 (docs/adr/0070): a server workspace's Source documents, read and written through the storage layer (lib/storage.js) like its assets, so a Blob container can sit behind them. The folder, the manifest and the lifecycle are web/lib/sourceDocuments.js's, shared with a Local Workspace; this file only supplies the server's half of the file interface that module is written against, and the media types a download is served with.

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
  return createSourceStore(io, options)
}

const SOURCE_MEDIA_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * The headers a stored Source document is downloaded with. A type Gantry does not take is `application/octet-stream`, so an unexpected upload (an HTML file, say) can never run in the app's own origin. A PDF or image shows in the tab; everything else downloads under its stored name.
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
