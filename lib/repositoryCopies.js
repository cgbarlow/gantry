import { createHash } from 'node:crypto'
import { CopyTooBigError } from './repositoryCopy.js'

// #338 (docs/adr/0074): the **Repository copies** the Gantry server holds, in memory only, and the few things it remembers alongside them.
// One store serves the whole server process (lib/server.js makes it at startup, from the operator's settings), so every request, and every
// architect, shares it:
//
// - a copy per repository, commit and (only when just some folders could be copied) folders, kept until it has gone unused for the idle
//   lifetime or room is needed for another, the least recently used going first. All copies together stay within the total limit, and
//   each within the per-repository limit;
// - a download under way, which a second caller joins rather than starting another, and which says how far it has got (`receivedBytes`),
//   so a request can answer "preparing" before it is done;
// - who has shown, with their own token and recently, that they can read a repository. A copy made without a token (a public repository)
//   is shared outright; any other is used by a caller only once they have passed that check. A token is only ever held here as its
//   SHA-256 hash (`credentialHash`), never as itself;
// - each branch's head as last asked, per repository, branch and caller, so a burst of reads asks the Provider at most once a minute;
// - a repository found too big to copy (for the idle lifetime), and a download that failed (for a few minutes, per caller), so neither is
//   tried again on every read.
//
// The store never talks to a Provider itself: a caller (lib/repositorySource.js) hands it the work, `download` and `checkAccess`. A test
// hands it its own clock, limits and work.

const MB = 1024 * 1024

/** The store's limits when nothing is set: the operator's defaults (lib/repositorySettings.js). */
export const REPOSITORY_COPY_DEFAULTS = Object.freeze({
  totalBytes: 512 * MB,
  perRepositoryBytes: 150 * MB,
  idleMs: 2 * 60 * 60 * 1000,
  headIntervalMs: 60 * 1000,
  // How long a caller's passed access check lets them use a copy someone else made.
  accessCheckMs: 5 * 60 * 1000,
  // How long a failed download is remembered for that caller, so a blocked host costs one try, not one per read.
  failureMemoryMs: 5 * 60 * 1000,
})

/** The key a caller's token is remembered by: its SHA-256 hash, or null for a caller with no token. Never the token itself. */
export function credentialHash(pat) {
  return pat ? createHash('sha256').update(String(pat)).digest('hex') : null
}

/**
 * A store of Repository copies. Every option has its default (REPOSITORY_COPY_DEFAULTS); `totalBytes: 0` keeps no copies at all (every
 * read is file by file), though branch heads are still remembered. `now` is the clock; `sweepIntervalMs`, when above 0, drops idle copies
 * on a timer as well as on every use (the timer never keeps the process alive; `stop()` ends it).
 *
 * `ensureCopy({ repositoryKey, commit, scope, credential, download, checkAccess })` resolves a handle for the copy:
 *
 * - `{ state: 'ready', copy }`;
 * - `{ state: 'preparing', receivedBytes, startedAt, settled }` while it downloads. `receivedBytes` reads the bytes received so far each
 *   time it is read, and `settled` resolves the `ready` or `unavailable` handle the download ends with;
 * - `{ state: 'unavailable', reason }`: `off` (the store keeps no copies), `too-big`, or `failed` (with `error`).
 *
 * `repositoryKey` names the repository wherever it is (Provider, address, name), `scope` the folders copied ('' for the whole repository),
 * `credential` the caller's `credentialHash`. `download({ onProgress, limitBytes, archiveLimitBytes })` is the caller's work to make the copy
 * (lib/repositoryCopy.js's shape, `{ files, leftOut, folders, bytes }`), reporting the bytes received; it throws CopyTooBigError for one
 * that won't fit. `checkAccess()` is the caller's own cheap request to the Provider with their own token: it resolves when they can read
 * the repository and throws (the Provider's refusal) when they can't, and ensureCopy then throws that, giving them nothing.
 */
export function createRepositoryCopyStore(options = {}) {
  const limits = { ...REPOSITORY_COPY_DEFAULTS }
  for (const key of Object.keys(limits)) if (options[key] !== undefined) limits[key] = options[key]
  const now = options.now ?? (() => Date.now())
  const enabled = limits.totalBytes > 0

  const copies = new Map() // key -> copy entry, least recently used first
  const pending = new Map() // key -> download under way
  const passes = new Map() // repositoryKey + credential -> when the caller last showed they can read it
  const heads = new Map() // repositoryKey + branch + credential -> { commit, at } or { asking }
  const tooBig = new Map() // repositoryKey + scope -> when it was found too big
  const failures = new Map() // key + credential -> { at, error }
  let heldBytes = 0

  const copyKey = (repositoryKey, commit, scope) => `${repositoryKey}\n${commit}\n${scope ?? ''}`
  const passKey = (repositoryKey, credential) => `${repositoryKey}\n${credential ?? 'anonymous'}`

  function drop(key) {
    const entry = copies.get(key)
    if (!entry) return
    copies.delete(key)
    heldBytes -= entry.copy.bytes
  }

  /** Drops every copy unused for the idle lifetime, and forgets what is too old to count any more. */
  function sweep() {
    const at = now()
    for (const [key, entry] of copies) if (at - entry.lastUsed >= limits.idleMs) drop(key)
    for (const [key, when] of passes) if (at - when >= limits.accessCheckMs) passes.delete(key)
    for (const [key, when] of tooBig) if (at - when >= limits.idleMs) tooBig.delete(key)
    for (const [key, failure] of failures) if (at - failure.at >= limits.failureMemoryMs) failures.delete(key)
    for (const [key, head] of heads) if (head.at !== undefined && at - head.at >= Math.max(limits.headIntervalMs, 1)) heads.delete(key)
  }

  const timer = options.sweepIntervalMs > 0 ? setInterval(sweep, options.sweepIntervalMs) : null
  timer?.unref?.()

  /** Records that this caller has just shown they can read the repository. */
  function notePass({ repositoryKey, credential }) {
    passes.set(passKey(repositoryKey, credential), now())
  }

  const passed = (repositoryKey, credential) => {
    const when = passes.get(passKey(repositoryKey, credential))
    return when !== undefined && now() - when < limits.accessCheckMs
  }

  // A caller may use a copy, or join its download, when it was made without a token or by the same token, or once they have passed the
  // access check recently. The check is asked here, and its refusal is theirs.
  async function admit(entry, { repositoryKey, credential, checkAccess }) {
    if (entry.credential === null || entry.credential === credential || passed(repositoryKey, credential)) return
    await checkAccess()
    notePass({ repositoryKey, credential })
  }

  const readyHandle = (entry) => ({ state: 'ready', copy: entry.copy })
  const preparingHandle = (entry) => ({
    state: 'preparing',
    get receivedBytes() {
      return entry.receivedBytes
    },
    startedAt: entry.startedAt,
    settled: entry.settled,
  })

  // Makes room for `bytes` more, dropping the least recently used copies first.
  function makeRoom(bytes) {
    for (const key of copies.keys()) {
      if (heldBytes + bytes <= limits.totalBytes) break
      drop(key)
    }
  }

  async function ensureCopy({ repositoryKey, commit, scope = '', credential = null, download, checkAccess }) {
    sweep()
    if (!enabled) return { state: 'unavailable', reason: 'off' }
    const key = copyKey(repositoryKey, commit, scope)
    const ready = copies.get(key)
    if (ready) {
      await admit(ready, { repositoryKey, credential, checkAccess })
      // Most recently used goes last, so the least recently used is met first when room is needed.
      copies.delete(key)
      ready.lastUsed = now()
      copies.set(key, ready)
      return readyHandle(ready)
    }
    const underWay = pending.get(key)
    if (underWay) {
      await admit(underWay, { repositoryKey, credential, checkAccess })
      return preparingHandle(underWay)
    }
    if (tooBig.has(`${repositoryKey}\n${scope}`)) return { state: 'unavailable', reason: 'too-big' }
    const failed = failures.get(`${key}\n${credential ?? 'anonymous'}`)
    if (failed) return { state: 'unavailable', reason: 'failed', error: failed.error }

    const limit = Math.min(limits.perRepositoryBytes, limits.totalBytes)
    const entry = { credential, receivedBytes: 0, startedAt: now() }
    entry.settled = (async () => {
      try {
        const copy = await download({ onProgress: (bytes) => (entry.receivedBytes = bytes), limitBytes: limit, archiveLimitBytes: limits.totalBytes })
        if (copy.bytes > limit) throw new CopyTooBigError()
        makeRoom(copy.bytes)
        const made = { copy: { ...copy, commit, scope }, credential, lastUsed: now() }
        copies.set(key, made)
        heldBytes += copy.bytes
        if (credential !== null) notePass({ repositoryKey, credential })
        return readyHandle(made)
      } catch (err) {
        if (err instanceof CopyTooBigError) {
          tooBig.set(`${repositoryKey}\n${scope}`, now())
          return { state: 'unavailable', reason: 'too-big' }
        }
        failures.set(`${key}\n${credential ?? 'anonymous'}`, { at: now(), error: err })
        return { state: 'unavailable', reason: 'failed', error: err }
      } finally {
        pending.delete(key)
      }
    })()
    pending.set(key, entry)
    return preparingHandle(entry)
  }

  /**
   * The copy at this commit if one is held (and this caller may use it), else null; never starts a download. Out of date's comparison
   * reads a recorded commit's files from its copy this way, when there is one.
   */
  async function existingCopy({ repositoryKey, commit, scope = '', credential = null, checkAccess }) {
    sweep()
    const entry = copies.get(copyKey(repositoryKey, commit, scope))
    if (!entry) return null
    await admit(entry, { repositoryKey, credential, checkAccess })
    entry.lastUsed = now()
    return entry.copy
  }

  /**
   * The branch's head: as last asked, when that was within the re-check interval, else `ask()`ed now (and one ask is shared by callers
   * who arrive while it is under way). `fresh` always asks. A refusal is never remembered.
   */
  async function head({ repositoryKey, branch, credential = null, ask, fresh = false }) {
    const key = `${repositoryKey}\n${branch}\n${credential ?? 'anonymous'}`
    const known = heads.get(key)
    if (!fresh && known?.asking) return known.asking
    if (!fresh && known?.commit && now() - known.at < limits.headIntervalMs) return known.commit
    const asking = ask()
    heads.set(key, { asking })
    try {
      const commit = await asking
      noteHead({ repositoryKey, branch, credential, commit })
      return commit
    } catch (err) {
      if (heads.get(key)?.asking === asking) heads.delete(key)
      throw err
    }
  }

  /** Records a head just asked fresh elsewhere (a check, or Out of date's comparison), so the next read starts from it. */
  function noteHead({ repositoryKey, branch, credential = null, commit }) {
    heads.set(`${repositoryKey}\n${branch}\n${credential ?? 'anonymous'}`, { commit, at: now() })
  }

  return {
    enabled,
    limits: Object.freeze({ ...limits }),
    ensureCopy,
    existingCopy,
    head,
    noteHead,
    notePass,
    sweep,
    /** What is held now, for a test or a status page: `{ heldBytes, copies: [{ key, bytes, lastUsed }], preparing: [{ key, receivedBytes }] }`. */
    stats: () => ({
      heldBytes,
      copies: [...copies].map(([key, entry]) => ({ key, bytes: entry.copy.bytes, lastUsed: entry.lastUsed })),
      preparing: [...pending].map(([key, entry]) => ({ key, receivedBytes: entry.receivedBytes })),
    }),
    /** Forgets everything. */
    clear() {
      copies.clear()
      pending.clear()
      passes.clear()
      heads.clear()
      tooBig.clear()
      failures.clear()
      heldBytes = 0
    },
    /** Ends the sweep timer, if there is one. */
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}
