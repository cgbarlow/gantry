import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/**
 * Whole-file helpers over the asynchronous half of `lib/storage.js` (ADR-0070), so the code that keeps a server workspace in a store (an Instance's files, its assets, a Definition) can ask "is this file there", "what is in this folder" and "copy this folder to a scratch directory" without knowing what the store is. They use only what the storage seam offers: `getText`, `getBytes`, `putText`, `putBytes`, `list` and `remove`.
 *
 * A store lists by string prefix, not by directory, so a folder is always addressed with a trailing slash (`<dir>/`); without it `instances/a` would also match `instances/ab/...`.
 */

const asDirPrefix = (dir) => (dir.endsWith('/') ? dir : `${dir}/`)

/** The file's text, or `null` when there is no such file. Any other failure propagates. */
export async function getTextOrNull(storage, path) {
  try {
    return (await storage.getText(path)).text
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** `{ text, version }`, or `null` when there is no such file. */
export async function getTextVersionedOrNull(storage, path) {
  try {
    return await storage.getText(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** The file's bytes, or `null` when there is no such file. */
export async function getBytesOrNull(storage, path) {
  try {
    return (await storage.getBytes(path)).bytes
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** Whether a file (not a folder) is stored at exactly `path`. */
export async function fileExists(storage, path) {
  const found = await storage.list(path)
  return found.some((entry) => entry.path === path)
}

/** Whether anything is stored under the folder `dir`. */
export async function folderHasFiles(storage, dir) {
  return (await storage.list(asDirPrefix(dir))).length > 0
}

/**
 * The names directly inside the folder `dir`: `{ files: [...], folders: [...] }`, each sorted. A folder is a name that has files below it.
 */
export async function listChildren(storage, dir) {
  const prefix = asDirPrefix(dir)
  const files = new Set()
  const folders = new Set()
  for (const { path } of await storage.list(prefix)) {
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) files.add(rest)
    else folders.add(rest.slice(0, slash))
  }
  return { files: [...files].sort(), folders: [...folders].sort() }
}

/**
 * Copies every file stored under the folder `dir` into the local directory `destDir`, keeping the layout beneath `dir`. `options.filter(relativePath)` leaves files out. Used to give Pandoc, which reads local files, the few it needs; the copy lives in a scratch directory the caller removes, and nothing is written back.
 * Returns the relative paths copied.
 */
export async function copyFolderToDirectory(storage, dir, destDir, { filter } = {}) {
  const prefix = asDirPrefix(dir)
  const copied = []
  for (const { path } of await storage.list(prefix)) {
    const rel = path.slice(prefix.length)
    if (filter && !filter(rel)) continue
    const { bytes } = await storage.getBytes(path)
    const target = join(destDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    copied.push(rel)
  }
  return copied
}

async function walkDirectory(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return
    throw err
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkDirectory(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

/**
 * Makes the folder `dir` in the store match the local directory `srcDir`: files that are new or whose bytes changed are written, and files in the store with no counterpart in `srcDir` are deleted. Only changes are sent. Returns `{ written, removed }` as relative paths.
 */
export async function syncDirectoryToFolder(storage, dir, srcDir) {
  const prefix = asDirPrefix(dir)
  const local = []
  await walkDirectory(srcDir, local)
  const localRel = new Map(local.map((full) => [relative(srcDir, full).split(sep).join('/'), full]))
  const stored = new Map((await storage.list(prefix)).map((entry) => [entry.path.slice(prefix.length), entry.path]))

  const written = []
  const removed = []
  for (const [rel, full] of localRel) {
    const bytes = await readFile(full)
    if (stored.has(rel)) {
      const current = await storage.getBytes(stored.get(rel))
      if (Buffer.compare(Buffer.from(current.bytes), bytes) === 0) continue
    }
    await storage.putBytes(`${prefix}${rel}`, bytes)
    written.push(rel)
  }
  for (const [rel, path] of stored) {
    if (localRel.has(rel)) continue
    await storage.remove(path)
    removed.push(rel)
  }
  return { written, removed }
}
