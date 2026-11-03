import { createHash } from 'node:crypto'
import { parseWorkspaceJson, serializeWorkspaceJson } from '../web/lib/localWorkspace.js'
import { StorageConflictError } from './storage.js'
import { createBlobStorage } from './blobStorage.js'
import { getTextVersionedOrNull } from './storageFiles.js'
import { describeProbeFailure } from './blobContainers.js'
import { mirrorScopeNumbers, highestWorkspaceNumber } from './numberRegistry.js'
import {
  DuplicateServerWorkspaceError,
  InvalidServerWorkspaceError,
  validateWorkspaceInput,
  workspaceFolderFor,
} from './workspaceDirectory.js'

/**
 * Server workspaces kept in Blob containers (#269, docs/adr/0070). A blob-stored workspace is a folder in a container
 * with the layout a workspace has on disk (`workspace.json`, then one folder per Instance, `definitions/`, ...).
 * The container is the truth, and several servers may share it: nothing here is cached beyond a few seconds, and
 * nothing is kept in a server's own folder except a copy of the numbers that `lib/numberRegistry.js` resolves
 * `w2i3` references through (`mirrorScopeNumbers`), rebuilt from the container on every refresh.
 *
 *   <container>/workspace-folder/workspace.json
 *   <container>/workspace-folder/<instance>/instance.yaml ...
 *   <container>/.gantry/registry.json      the workspaces' and Instances' short numbers
 *   <container>/.gantry/locks/...          the short leases a Save holds (lib/blobStorage.js)
 *
 * **Ids.** A workspace's id is derived from its container's URL and its folder, so two servers that declare the same
 * container under different names still agree on it. It is `blob-` and 32 hex digits. A folder copied into the
 * container with Azure's tools is a different folder, so it is a different workspace with a new id.
 *
 * **Short numbers.** The workspace number and each Instance's number are in `.gantry/registry.json`, written with the
 * ETag it was read at, so two servers numbering at once cannot hand the same number out twice. They are not in the
 * workspace's own folder on purpose: a folder copied in (or a second copy of one) must be numbered afresh rather than
 * arrive with the numbers of the workspace it was copied from. A workspace number is allocated above every number the
 * creating server already uses, and another server claims it if it is free there (`mirrorScopeNumbers`).
 *
 * **Unavailable.** A container that cannot be reached keeps the workspaces last seen in it, each marked
 * `available: false` with the reason (the fixed phrases of `describeProbeFailure`, never an SDK message). A container
 * never reached since the server started shows as one placeholder entry carrying the reason. The rest of Gantry
 * carries on either way.
 */

const WORKSPACE_JSON = 'workspace.json'
const REGISTRY_PATH = '.gantry/registry.json'
const BLOB_ID_PREFIX = 'blob-'

/** Whether `id` has the shape of a blob-stored workspace's id (a cheap test before asking which one it is). */
export const isBlobWorkspaceId = (id) => typeof id === 'string' && /^blob-[0-9a-f]{32}$/.test(id)

/** The workspace id for `folder` in the container at `containerUrl` (`''` for the placeholder of a container not yet read). */
export function deriveBlobWorkspaceId(containerUrl, folder) {
  const name = `blob-workspace\n${containerUrl.replace(/\/+$/, '').toLowerCase()}\n${folder}`
  return `${BLOB_ID_PREFIX}${createHash('sha256').update(name).digest('hex').slice(0, 32)}`
}

const emptyRegistry = () => ({ version: 1, workspaces: {} })

function parseRegistry(text) {
  if (text === null || text.trim() === '') return emptyRegistry()
  try {
    const parsed = JSON.parse(text)
    return { version: 1, workspaces: parsed && typeof parsed.workspaces === 'object' && parsed.workspaces ? parsed.workspaces : {} }
  } catch {
    // An unreadable registry is rebuilt from what the container holds rather than taking every workspace in it down.
    return emptyRegistry()
  }
}

function nextAbove(numbers) {
  return numbers.length ? Math.max(...numbers) + 1 : 1
}

/**
 * Reads the container's registry, lets `mutate(registry)` change it and writes it back conditional on the ETag it was
 * read at, reading again and retrying when another server wrote in between. `mutate` returns whether it changed
 * anything; nothing is written when it did not. Returns the registry as it now stands.
 */
async function updateRegistry(storage, mutate) {
  for (let attempt = 0; ; attempt++) {
    const stored = await getTextVersionedOrNull(storage, REGISTRY_PATH)
    const registry = parseRegistry(stored?.text ?? null)
    if (!mutate(registry)) return registry
    try {
      await storage.putText(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, { ifVersion: stored ? stored.version : null })
      return registry
    } catch (err) {
      if (!(err instanceof StorageConflictError) || attempt >= 12) throw err
    }
  }
}

/**
 * Builds the manager over the operator's declared containers.
 *
 * `containers` is `createBlobContainerRegistry`'s result (`containers`, `client(name)`); `instancesDir` is where this
 * server's number registry lives. `options.storageFor` replaces how a container's storage is built and `options.now`
 * the clock, for tests.
 */
export function createBlobWorkspaces({ containers, instancesDir, storageFor, now = () => Date.now() }) {
  const declared = containers?.containers ?? []
  const storages = new Map()
  const lastKnown = new Map() // container name -> workspaces last read from it
  let snapshot = { at: 0, workspaces: [] }
  let inFlight = null

  function storageOf(name) {
    if (!storages.has(name)) {
      const storage = storageFor ? storageFor(name) : createBlobStorage(containers.client(name), { now })
      storages.set(name, storage)
    }
    return storages.get(name)
  }

  /** Reads one container: its workspaces, numbered. Throws when the container cannot be read. */
  async function scan(container) {
    const storage = storageOf(container.name)
    const folders = (await storage.listFolders('')).filter((folder) => !folder.startsWith('.'))
    const found = []
    await Promise.all(
      folders.map(async (folder) => {
        const stored = await getTextVersionedOrNull(storage, `${folder}/${WORKSPACE_JSON}`)
        if (!stored) return
        let record
        try {
          record = parseWorkspaceJson(stored.text)
        } catch {
          return // a workspace.json Gantry would not accept is not a workspace
        }
        // One listing of the workspace's folder gives its Instances (a folder holding an instance.yaml) and when each last changed.
        const prefix = `${folder}/`
        const updatedAt = {}
        const files = await storage.list(prefix)
        const slugs = files
          .map((file) => /^([^/]+)\/instance\.yaml$/.exec(file.path.slice(prefix.length))?.[1])
          .filter(Boolean)
          .sort()
        for (const file of files) {
          const rel = file.path.slice(prefix.length)
          const slug = slugs.find((candidate) => rel === `${candidate}/instance.yaml` || rel.startsWith(`${candidate}/modules/`))
          if (slug && file.modifiedAt && (!updatedAt[slug] || file.modifiedAt > updatedAt[slug])) updatedAt[slug] = file.modifiedAt
        }
        found.push({ folder, record, slugs, updatedAt })
      })
    )
    found.sort((a, b) => (a.folder < b.folder ? -1 : 1))

    // Number what has no number yet: a workspace new to the container (made here or copied in) and its Instances.
    const localHighest = highestWorkspaceNumber({ instancesDir })
    const registry = await updateRegistry(storage, (reg) => {
      let changed = false
      for (const { folder, slugs } of found) {
        let entry = reg.workspaces[folder]
        if (!entry || !Number.isInteger(entry.number)) {
          const taken = Object.values(reg.workspaces).map((w) => w.number).filter(Number.isInteger)
          entry = { number: Math.max(nextAbove(taken), localHighest + 1), instances: entry?.instances ?? {} }
          reg.workspaces[folder] = entry
          changed = true
        }
        entry.instances ??= {}
        for (const slug of slugs) {
          if (Number.isInteger(entry.instances[slug])) continue
          entry.instances[slug] = nextAbove(Object.values(entry.instances).filter(Number.isInteger))
          changed = true
        }
      }
      return changed
    })

    return found.map(({ folder, record, slugs, updatedAt }) => {
      const numbers = registry.workspaces[folder]
      return {
        id: deriveBlobWorkspaceId(container.url, folder),
        container: container.name,
        folder,
        name: record.name,
        description: record.description ?? null,
        number: numbers.number,
        instanceNumbers: Object.fromEntries(slugs.map((slug) => [slug, numbers.instances[slug]])),
        slugs,
        updatedAt,
        available: true,
      }
    })
  }

  async function refreshAll() {
    const workspaces = []
    await Promise.all(
      declared.map(async (container) => {
        let result
        try {
          result = await scan(container)
          lastKnown.set(container.name, result)
        } catch (err) {
          const reason = describeProbeFailure(err)
          const known = lastKnown.get(container.name)
          result = known?.length
            ? known.map((workspace) => ({ ...workspace, available: false, reason }))
            : [{ id: deriveBlobWorkspaceId(container.url, ''), container: container.name, folder: null, name: container.name, description: null, number: null, instanceNumbers: {}, slugs: [], available: false, reason, placeholder: true }]
        }
        workspaces.push(...result)
      })
    )
    workspaces.sort((a, b) => a.container.localeCompare(b.container) || (a.folder ?? '').localeCompare(b.folder ?? ''))
    // This server resolves `w2i3` through its own registry, so make that agree with what the containers hold.
    for (const workspace of workspaces) {
      if (!workspace.available || workspace.number === null) continue
      const { workspaceNumber } = mirrorScopeNumbers(workspace.id, { workspaceNumber: workspace.number, instanceNumbers: workspace.instanceNumbers }, { instancesDir })
      workspace.number = workspaceNumber
    }
    snapshot = { at: now(), workspaces }
    return snapshot
  }

  /**
   * The workspaces in the declared containers, read now unless the last read is newer than `maxAgeMs` (0 always reads).
   * Reads in flight are shared, so a dashboard asking twice at once makes one round of requests (`afterWrite` waits for one under way and reads again).
   */
  async function refresh({ maxAgeMs = 0, afterWrite = false } = {}) {
    if (declared.length === 0) return snapshot
    if (maxAgeMs > 0 && snapshot.at && now() - snapshot.at < maxAgeMs) return snapshot
    // A read already under way began before a write this caller just made, so it may not show it: wait it out and read again.
    if (afterWrite && inFlight) await inFlight.catch(() => {})
    if (!inFlight) inFlight = refreshAll().finally(() => { inFlight = null })
    return inFlight
  }

  /** Creates a workspace in the named container: its folder, `workspace.json` and a short number. */
  async function create({ container: containerName, name, description } = {}) {
    const container = declared.find((c) => c.name === containerName)
    if (!container) throw new InvalidServerWorkspaceError(`Unknown Blob container "${containerName}"`)
    const { trimmedName } = validateWorkspaceInput({ name, description })
    const storage = storageOf(container.name)

    const snap = await refresh()
    const down = snap.workspaces.find((w) => w.container === container.name && !w.available)
    if (down) throw new BlobContainerUnavailableError(container.name, down.reason)
    const existing = snap.workspaces.filter((w) => w.container === container.name)
    let folders
    try {
      folders = new Set(await storage.listFolders(''))
    } catch (err) {
      throw new BlobContainerUnavailableError(container.name, describeProbeFailure(err))
    }
    const taken = existing.find((w) => w.name.trim().toLowerCase() === trimmedName.toLowerCase())
    if (taken) throw new DuplicateServerWorkspaceError(`A workspace named "${taken.name}" already exists`)

    const record = {
      name: trimmedName,
      ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
      kind: 'local',
      createdAt: new Date().toISOString(),
    }
    const text = serializeWorkspaceJson(record)
    const base = workspaceFolderFor(trimmedName)
    let folder
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`
      if (folders.has(candidate)) continue
      try {
        // Create-only: two servers picking the same folder at once cannot both win it.
        await storage.putText(`${candidate}/${WORKSPACE_JSON}`, text, { ifVersion: null })
        folder = candidate
        break
      } catch (err) {
        if (!(err instanceof StorageConflictError)) throw err
      }
    }
    const after = await refresh({ afterWrite: true })
    return after.workspaces.find((w) => w.container === container.name && w.folder === folder)
  }

  /** The workspace with this id from the last read, `undefined` if there is none. */
  const get = (id) => snapshot.workspaces.find((workspace) => workspace.id === id)

  /** Gives `slug` a short number in the workspace, for an Instance about to be created in it. */
  async function numberForNewInstance(workspace, slug) {
    const registry = await updateRegistry(storageOf(workspace.container), (reg) => {
      const entry = (reg.workspaces[workspace.folder] ??= { number: workspace.number, instances: {} })
      entry.instances ??= {}
      if (Number.isInteger(entry.instances[slug])) return false
      entry.instances[slug] = nextAbove(Object.values(entry.instances).filter(Number.isInteger))
      return true
    })
    return registry.workspaces[workspace.folder].instances[slug]
  }

  return {
    enabled: declared.length > 0,
    containers: declared,
    refresh,
    create,
    get,
    numberForNewInstance,
    storage: storageOf,
    /** The last read, without reading again. */
    current: () => snapshot,
  }
}

/** A container could not be read or written when a workspace was being made in it (the route answers 503). */
export class BlobContainerUnavailableError extends Error {
  constructor(container, reason) {
    super(`The Blob container "${container}" is unavailable: ${reason ?? 'it could not be reached'}`)
    this.name = 'BlobContainerUnavailableError'
    this.container = container
    this.reason = reason
  }
}
