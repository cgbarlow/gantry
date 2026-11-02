import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Puts every file under the disk directory `diskDir` into `storage`, at `keyPrefix/<relative path>`. Test setup: gives a store a Definition (or a whole workspace) copied from the repo.
 */
export async function copyTreeIntoStorage(storage, diskDir, keyPrefix) {
  for (const name of readdirSync(diskDir)) {
    const full = join(diskDir, name)
    if (statSync(full).isDirectory()) await copyTreeIntoStorage(storage, full, `${keyPrefix}/${name}`)
    else await storage.putBytes(`${keyPrefix}/${name}`, readFileSync(full))
  }
}
