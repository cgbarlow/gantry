import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

/**
 * The raw read/write seam for instance data (`instance.yaml`, module `.md` files) that `lib/instance.js`'s parsing/rendering functions go through, instead of calling `node:fs` directly. `localFilesystemStorage` is the only implementation today — everything still lives on the local filesystem, addressed by the same paths as before. The seam exists so a later Azure-DevOps-backed implementation (see docs/adr/0005-instance-data-in-external-ado-repo.md) can be swapped in to read/write that same raw text over the Azure DevOps REST API, reusing `lib/instance.js`'s frontmatter/field parsing unchanged.
 *
 * Errors from `readText` propagate as-is (e.g. a Node `ENOENT` with its `code` property intact) so callers can keep distinguishing "missing" from other failures the same way they do for a plain `readFileSync` call.
 */
export const localFilesystemStorage = {
  exists(path) {
    return existsSync(path)
  },
  readText(path) {
    return readFileSync(path, 'utf8')
  },
  stat(path) {
    return statSync(path)
  },
  writeText(path, text) {
    writeFileSync(path, text)
  },
  ensureDir(path) {
    mkdirSync(path, { recursive: true })
  },
  listDir(path) {
    return existsSync(path) ? readdirSync(path) : []
  },
}
