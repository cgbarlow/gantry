import { AuthenticationError, NotFoundError, RepoNotFoundError, providerDisplayName } from './providerErrors.js'
import { resolveContentStore } from './providerRegistry.js'
import { REPOSITORY_READER_DEFAULTS } from './repositorySettings.js'
import { credentialHash } from './repositoryCopies.js'
import {
  PATH_PAGE_SIZE,
  REGEX_TIME_BUDGET_MS,
  SEARCH_PAGE_LINES,
  copyFilePaths,
  emptyCopy,
  fileTypeTest,
  lineRange,
  listCopyFolder,
  namePatternTest,
  pageOf,
  readArchiveBody,
  scanTexts,
  searchPattern,
  unpackRepositoryArchive,
  wholePage,
} from './repositoryCopy.js'
import {
  cleanRepositoryPath,
  looksBinary,
  normalizeSourceRepository,
  repositoryCitationQuery,
  repositoryName,
  repositoryProviderLabel,
  skippedRepositoryPath,
  withinRepositoryFolders,
} from '../web/lib/sourceRepository.js'

// #319 (docs/adr/0072): reading a **code repository** that an Instance points at as a Source document. It is read live, through the
// Provider clients Gantry already has (lib/providerRegistry.js's content store: list a folder, read a file at a branch or a commit), with
// the token of whoever is asking: the architect's own in the editor and the Interview page, the MCP server's for that workspace over MCP.
// Nothing is stored. Every answer carries the commit it was read at, so a citation and the decisions log can name it.
//
// The pointer itself (its shape, the paths always skipped, its web addresses) is web/lib/sourceRepository.js's, shared with the browser.
//
// #338 (docs/adr/0074): given the server's store of **Repository copies** (lib/repositoryCopies.js), a reader lists, finds, searches and
// reads at a commit from a copy of the whole repository at that commit, downloaded once as one archive and shared with every caller who
// can read it. Without a store, or when a copy can't be made (too big, or the download refused or blocked), it reads file by file as above,
// and a find or search says why, so the AI can be told to narrow to a folder. "Nothing is stored" still holds for the Instance: a copy is
// the server's working memory only.

// #338: the Providers that can make an archive of a single folder, so a repository too big to copy whole can be copied for the folders a
// Source document is narrowed to.
const FOLDER_ARCHIVES = new Set(['gitlab', 'azure-devops'])

/** A file bigger than this is not read: it is almost never source code an architect cites. */
export const MAX_REPOSITORY_FILE_BYTES = 1024 * 1024
/**
 * A search reads at most this many files, and lists at most this many folders, so one call stays quick on a large repository. #335: it also
 * stops at a time limit, an operator's setting (lib/repositorySettings.js), whichever comes first.
 */
export const MAX_SEARCH_FILES = 400
export const MAX_SEARCH_FOLDERS = 200
/** A search returns at most this many matching lines. */
export const MAX_SEARCH_MATCHES = 60
/** A file a search reads is skipped above this size. */
const MAX_SEARCH_FILE_BYTES = 256 * 1024

/**
 * #336: why a request to the Provider failed for a temporary reason, so that it is worth asking again: `timed-out` (no answer within the
 * time limit per request), `cut-off` (the connection dropped or was reset), `unavailable` (a 502, 503 or 504), or null for a definite
 * answer, which is never asked again: a used-up rate limit (#325), no access, not found, no such branch, or anything else.
 */
export function temporaryFailure(err) {
  if (!err || err instanceof RepositorySourceError) return null
  if (err.name === 'RateLimitError' || err.status === 429) return null
  if (err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError') return 'timed-out'
  if ([502, 503, 504].includes(err.status)) return 'unavailable'
  if (err.status !== undefined) return null
  // A request that never reached the Provider (each client says "Network error"), or one whose answer stopped part way ("terminated").
  if (/network error/i.test(err.message ?? '') || (err.name === 'TypeError' && /terminated|fetch failed|other side closed|socket/i.test(err.message ?? ''))) return 'cut-off'
  return null
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * #336: runs `work` (one call of a Provider client) and, when it fails for a temporary reason (temporaryFailure), runs it again, up to
 * `retries` more times, waiting `retryWaitMs` before the first retry and twice as long before each later one. It is not run again once
 * `stillWanted()` says nobody is waiting for it any more (a search that has answered, say). The error it finally fails with carries
 * `tries`, how many times it was asked.
 */
async function retried(work, { retries, retryWaitMs, stillWanted = () => true }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      if (attempt >= retries || !temporaryFailure(err) || !stillWanted()) {
        if (err && typeof err === 'object') err.tries = attempt + 1
        throw err
      }
      await pause(retryWaitMs * 2 ** attempt)
      if (!stillWanted()) throw err
    }
  }
}

// #338: a search's matching lines as the files they are in, `{ path, count }` each, in the order first met: its files-only answer.
function filesOf(matches) {
  const counts = new Map()
  for (const match of matches) if (match.line !== undefined) counts.set(match.path, (counts.get(match.path) ?? 0) + 1)
  return [...counts].map(([path, count]) => ({ path, count }))
}

/** A refusal with an HTTP-ish `status` and a `code`, its message written for the architect. */
export class RepositorySourceError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message)
    this.name = 'RepositorySourceError'
    this.code = code
    this.status = status
  }
}

/** The sentence an architect sees when the repository can't be read with the token given (or with none). Never a raw Provider error. */
export function noAccessMessage(repository, { hasToken }) {
  const where = `${repositoryProviderLabel(repository.provider)} repository ${repositoryName(repository)}`
  return hasToken
    ? `You can't read the ${where} with the token you gave. Check that it exists and that your token can read it.`
    : `You can't read the ${where} without a token. If it is private, give a token that can read it.`
}

/**
 * #325: the sentence an architect sees when the Provider's rate limit is used up, which is not the same as having no access. Without a
 * token that limit is small (GitHub's is 60 requests an hour per server address, often shared), so the sentence says a token raises it.
 */
export function rateLimitMessage(repository, { hasToken, resetAt = null }) {
  const provider = repositoryProviderLabel(repository.provider)
  const until = resetAt instanceof Date && !Number.isNaN(resetAt.getTime()) ? `until ${resetAt.toISOString().slice(11, 16)} UTC` : 'for now'
  return hasToken
    ? `${provider}'s limit on reads with your token is used up ${until}, so ${repositoryName(repository)} can't be read just now. Try again then.`
    : `${provider} limits how much this Gantry server can read without a token, and that limit is used up ${until}. ${repositoryName(repository)} is fine; a token raises the limit (for a public repository any ${provider} token will do), or try again then.`
}

// The read options that address a commit, per Provider: GitHub and GitLab take a commit wherever they take a branch; Azure DevOps and
// Bitbucket are told it is one (`versionType: 'commit'`).
function atCommit(provider, commit) {
  return provider === 'azure-devops' || provider === 'atlassian' ? { branch: commit, versionType: 'commit' } : { branch: commit }
}

// A repository's default branch, from each Provider's own repository metadata.
function defaultBranchOf(provider, meta) {
  if (provider === 'azure-devops') return String(meta?.defaultBranch ?? '').replace(/^refs\/heads\//, '') || null
  if (provider === 'atlassian') return meta?.mainbranch?.name ?? null
  return meta?.default_branch ?? null
}

/**
 * A reader over one repository. `repository` is the pointer's `{ provider, location, branch?, folders? }` (the branch may be left out
 * for `check`, which then answers the repository's default branch). `pat` is the caller's token, or null to read a public repository
 * with none. `options.allowBaseUrl` says whether this server takes a self-hosted `location.baseUrl` for this Provider: the same rule a
 * workspace's location is held to (lib/server.js), and no other. `options.clientBaseUrl` is the API address a test points Bitbucket at
 * (Bitbucket is Cloud-only, so a pointer never carries one). `options.rawBaseUrl` is where a test's fake GitHub serves raw files (#325).
 * #335: `options.searchTimeLimitMs` and `options.searchParallelReads` are the operator's settings for a search (lib/repositorySettings.js).
 * #336: so are `options.requestTimeLimitMs`, the time limit of each request to the Provider, and `options.retries` and `options.retryWaitMs`,
 * how often and after how long a read that failed for a temporary reason is tried again.
 * #338: `options.copies` is the server's store of Repository copies (lib/repositoryCopies.js); without one, every read is file by file and
 * the branch head is asked on every read, as before. `options.archiveTimeLimitMs` is the time limit of an archive download, and
 * `options.regexBudgetMs` how long one search by regular expression may run.
 */
export function createRepositoryReader(
  repositoryInput,
  pat,
  {
    allowBaseUrl = false,
    clientBaseUrl,
    rawBaseUrl,
    searchTimeLimitMs = REPOSITORY_READER_DEFAULTS.searchTimeLimitMs,
    searchParallelReads = REPOSITORY_READER_DEFAULTS.searchParallelReads,
    requestTimeLimitMs = REPOSITORY_READER_DEFAULTS.requestTimeLimitMs,
    retries = REPOSITORY_READER_DEFAULTS.retries,
    retryWaitMs = REPOSITORY_READER_DEFAULTS.retryWaitMs,
    copies = null,
    archiveTimeLimitMs = REPOSITORY_READER_DEFAULTS.archiveTimeLimitMs,
    regexBudgetMs = REGEX_TIME_BUDGET_MS,
  } = {}
) {
  // A placeholder branch lets a pointer with none yet be checked; `branch` below stays null for it.
  const repository = normalizeSourceRepository({ ...repositoryInput, branch: repositoryInput?.branch || 'unset' })
  if (!repository) throw new RepositorySourceError('A code repository needs its Provider and its location, as for a workspace.', { code: 'bad-repository', status: 400 })
  if (repository.location.baseUrl && !allowBaseUrl) {
    throw new RepositorySourceError(`This Gantry server doesn't take a self-hosted ${repositoryProviderLabel(repository.provider)} address.`, { code: 'base-url-not-allowed', status: 400 })
  }
  const branch = repositoryInput?.branch ? repository.branch : null
  const hasToken = Boolean(pat)
  // #336: every request to the Provider has its own time limit, which also covers reading its answer, and a call that fails for a temporary
  // reason is asked again. `globalThis.fetch` is looked up per request, so a test that stands in for it sees every one.
  const timedFetch = (url, init = {}) => {
    const limit = AbortSignal.timeout(requestTimeLimitMs)
    return globalThis.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit })
  }
  const clientConfig = { ...repository.location, ...(clientBaseUrl ? { baseUrl: clientBaseUrl } : {}), ...(rawBaseUrl ? { rawBaseUrl } : {}), pat: pat ?? undefined, anonymous: !hasToken }
  const client = resolveContentStore(repository.provider, { ...clientConfig, fetchImpl: timedFetch })
  // #338: an archive download is one request for the whole repository, so it has its own, longer, time limit.
  const archiveFetch = (url, init = {}) => {
    const limit = AbortSignal.timeout(archiveTimeLimitMs)
    return globalThis.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit })
  }
  const archiveClient = copies?.enabled ? resolveContentStore(repository.provider, { ...clientConfig, fetchImpl: archiveFetch }) : null
  // #338: how the store knows this repository wherever it is asked about (its Provider, its address and its name), and this caller (their
  // token's hash, never the token).
  const repositoryKey = `${repository.provider}|${client.baseUrl ?? ''}|${repositoryName(repository)}`
  const credential = credentialHash(pat)
  // The folders a copy too big to make whole is made of instead, where the Provider can make an archive of one folder.
  const folderScope = repository.folders && FOLDER_ARCHIVES.has(repository.provider) ? [...repository.folders].sort().join('\n') : null
  // Every call of the client goes through here, so that each is asked again after a temporary failure.
  const ask = (work, { stillWanted } = {}) => retried(work, { retries, retryWaitMs, stillWanted })
  const provider = providerDisplayName(repository.provider)

  // Turns a Provider's error into one the architect can act on.
  async function guarded(work) {
    try {
      return await work()
    } catch (err) {
      if (err instanceof RepositorySourceError) throw err
      if (err?.name === 'RateLimitError' || err?.status === 429) {
        throw new RepositorySourceError(rateLimitMessage(repository, { hasToken, resetAt: err.resetAt ?? null }), { code: 'rate-limited', status: 429 })
      }
      if (err instanceof AuthenticationError || err instanceof RepoNotFoundError || err?.name === 'AuthenticationError' || err?.name === 'RepoNotFoundError') {
        throw new RepositorySourceError(noAccessMessage(repository, { hasToken }), { code: 'no-access', status: 403 })
      }
      if (err instanceof SyntaxError) {
        // A Provider that answers a sign-in page instead of data (Azure DevOps does, to a request with no token) is a repository this caller can't read.
        throw new RepositorySourceError(noAccessMessage(repository, { hasToken }), { code: 'no-access', status: 403 })
      }
      // #336: still failing for a temporary reason after the retries. A read that ran out of time says it took too long; none of these
      // is a reason to give up on the repository, only on this read.
      const temporary = temporaryFailure(err)
      if (temporary === 'timed-out') {
        const seconds = Number((requestTimeLimitMs / 1000).toFixed(1))
        const tries = err.tries > 1 ? `, asked ${err.tries} times` : ''
        throw new RepositorySourceError(
          `${provider} took too long to answer a read of ${repositoryName(repository)} (no answer within ${seconds} second${seconds === 1 ? '' : 's'}${tries}). Try again in a moment, or try something narrower.`,
          { code: 'timed-out', status: 504 }
        )
      }
      if (temporary === 'unavailable') {
        throw new RepositorySourceError(`${provider} couldn't answer a read of ${repositoryName(repository)} just now (HTTP ${err.status}). Try again in a moment.`, { code: 'unreachable', status: 502 })
      }
      if (temporary === 'cut-off') {
        throw new RepositorySourceError(`Gantry couldn't reach ${provider} to read ${repositoryName(repository)}. Try again in a moment.`, { code: 'unreachable', status: 502 })
      }
      throw err
    }
  }

  // The commit the branch points at now; refused as missing branch when there is none.
  async function headOf(name) {
    const commit = await ask(() => client.getBranchObjectId(name))
    if (!commit || /^0+$/.test(commit)) throw new RepositorySourceError(`${repositoryName(repository)} has no branch "${name}".`, { code: 'no-branch', status: 404 })
    return commit
  }

  const needBranch = () => {
    if (!branch) throw new RepositorySourceError('Say which branch of the repository to read.', { code: 'bad-repository', status: 400 })
    return branch
  }

  // #338: the branch's head, as the store last heard it within the re-check interval (one request a minute however many reads), or asked
  // now when `fresh` (a check, the head itself, Out of date) or when there is no store. A fresh answer is what the next read starts from.
  const branchHead = (name, { fresh = false } = {}) =>
    copies ? copies.head({ repositoryKey, branch: name, credential, ask: () => headOf(name), fresh }) : headOf(name)

  // The commit to read at: the one asked for, else the branch's head.
  const commitFor = async (commit) => (typeof commit === 'string' && commit.trim() ? commit.trim() : branchHead(needBranch()))

  // #338: the caller's own cheap request to show they can read the repository, before they use a copy someone else made.
  const checkAccess = () => ask(() => client.getRepo())

  // #338: the copy at `at`, of the whole repository (`scope` '') or of the folders in `scope`, downloaded as one archive per folder.
  async function downloadCopy(at, scope, { onProgress, limitBytes, archiveLimitBytes }) {
    const copy = emptyCopy()
    let received = 0
    for (const folder of scope ? scope.split('\n') : [null]) {
      // The download and the reading of its answer are tried again together after a temporary failure.
      const zip = await ask(async () => {
        const res = await archiveClient.downloadArchive(at, folder ? { path: folder } : {})
        return readArchiveBody(res, { limitBytes: archiveLimitBytes - received, onProgress, receivedBefore: received })
      })
      received += zip.byteLength
      const keep = folder ? (path, { isFolder }) => withinRepositoryFolders({ folders: [folder] }, path, { orAbove: isFolder }) : undefined
      unpackRepositoryArchive(zip, { provider: repository.provider, folder, limitBytes, keep, into: copy })
    }
    return copy
  }

  const ensureCopy = (at, scope) => copies.ensureCopy({ repositoryKey, commit: at, scope, credential, checkAccess, download: (work) => downloadCopy(at, scope, work) })

  /**
   * #338: the store's handle for the copy at `at` (lib/repositoryCopies.js), or null with no store. A repository too big to copy whole
   * that is narrowed to folders on a Provider that can download a folder is copied for those folders. With `wait`, a copy still downloading
   * is waited for (for at most `waitMs`, when given); without, its `preparing` handle is answered at once.
   */
  async function copyAt(at, { wait = true, waitMs } = {}) {
    if (!copies) return null
    const settle = async (handle) => {
      if (handle.state !== 'preparing' || !wait) return handle
      if (!(waitMs >= 0)) return handle.settled
      let timer
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve(handle), waitMs)))
      try {
        return await Promise.race([handle.settled, late])
      } finally {
        clearTimeout(timer)
      }
    }
    let handle = await settle(await ensureCopy(at, ''))
    if (handle.state === 'unavailable' && handle.reason === 'too-big' && folderScope) handle = await settle(await ensureCopy(at, folderScope))
    return handle
  }

  // #338: why there is no copy, as the AI (or an outside agent) is told it alongside a find or search read file by file instead.
  function notCopiedNote(reason) {
    const name = repositoryName(repository)
    const narrow = 'so it was read file by file, and a search may stop before it has seen every file. Search within a folder (path) to cover all of it.'
    if (reason === 'too-big') {
      const mb = Math.round(copies.limits.perRepositoryBytes / (1024 * 1024))
      return { reason: 'too-big', message: `${name} is too big for Gantry to copy for searching (over ${mb} MB of text), ${narrow}` }
    }
    if (reason === 'off') return { reason: 'off', message: `This Gantry server keeps no copies of code repositories, ${narrow}` }
    return { reason: 'unavailable', message: `Gantry couldn't download a copy of ${name}, ${narrow}` }
  }

  // #338: the copy at `at` to read from, `{ copy }`, or `{ copy: null, notCopied }` saying why there is none (null with no store at all).
  async function copyOrReason(at) {
    const handle = await copyAt(at)
    if (!handle) return { copy: null, notCopied: null }
    if (handle.state === 'ready') return { copy: handle.copy }
    return { copy: null, notCopied: notCopiedNote(handle.reason) }
  }

  function pathOrRefusal(path, { file = false } = {}) {
    const clean = cleanRepositoryPath(path)
    if (clean === null) throw new RepositorySourceError(`"${path}" is not a path inside the repository.`, { code: 'bad-path', status: 400 })
    if (file && !clean) throw new RepositorySourceError('Say which file to read, as a path from the root of the repository.', { code: 'bad-path', status: 400 })
    const skipped = clean ? skippedRepositoryPath(clean) : null
    if (skipped) throw new RepositorySourceError(`${clean} is ${skipped}, which Gantry never reads.`, { code: 'skipped', status: 400 })
    if (!withinRepositoryFolders(repository, clean, { orAbove: !file })) {
      throw new RepositorySourceError(`${clean} is outside the folders this Source document is narrowed to (${repository.folders.join(', ')}).`, { code: 'outside-folders', status: 400 })
    }
    return clean
  }

  // A folder's children at `commit`, with the skipped paths and anything outside the pointer's folders left out. `stillWanted` as for `ask`.
  async function children(path, commit, { stillWanted } = {}) {
    const items = await ask(() => client.listFolder(path, atCommit(repository.provider, commit)), { stillWanted })
    return items
      .map((item) => ({ path: cleanRepositoryPath(item.path) ?? '', isFolder: Boolean(item.isFolder) }))
      .filter((item) => item.path && !skippedRepositoryPath(item.path) && withinRepositoryFolders(repository, item.path, { orAbove: item.isFolder }))
      .sort((a, b) => (a.isFolder === b.isFolder ? a.path.localeCompare(b.path) : a.isFolder ? -1 : 1))
  }

  async function bytesAt(path, commit, { stillWanted } = {}) {
    try {
      return Buffer.from(await ask(() => client.getFileBytes(path, atCommit(repository.provider, commit)), { stillWanted }))
    } catch (err) {
      if (err instanceof NotFoundError || err?.name === 'NotFoundError') return null
      throw err
    }
  }

  // #335: the files a search reads, one at a time in the order a one-by-one walk would meet them, or null when there are no more (or the
  // search has stopped). Where the Provider lists the whole repository in one request (GitHub, #325), that listing, which also lets a file
  // too big to search be passed over by its listed size without fetching it, and says how many files there are to search; otherwise the
  // walk lists one folder at a time, at most MAX_SEARCH_FOLDERS of them.
  async function openSearchWalk({ at, roots, state }) {
    // #336: a search that has answered asks nothing again.
    const stillWanted = () => !state.over
    const tree = client.listTree ? await ask(() => client.listTree(at), { stillWanted }) : null
    if (tree && !tree.truncated) {
      const under = (path) => roots.some((root) => !root || path === root || path.startsWith(`${root}/`))
      const files = tree.entries
        .map((item) => ({ ...item, path: cleanRepositoryPath(item.path) ?? '' }))
        .filter((item) => !item.isFolder && item.path && under(item.path) && !skippedRepositoryPath(item.path) && withinRepositoryFolders(repository, item.path))
        .sort((a, b) => a.path.localeCompare(b.path))
      state.filesInWalk = files.length
      state.filesToSearch = Math.min(files.length, MAX_SEARCH_FILES)
      let next = 0
      return async () => files[next++] ?? null
    }
    const queue = [...roots]
    const files = []
    let foldersListed = 0
    return async () => {
      while (!files.length) {
        if (!queue.length || state.over) return null
        if (++foldersListed > MAX_SEARCH_FOLDERS) {
          state.truncatedBy = 'folder-limit'
          return null
        }
        for (const item of await children(queue.shift(), at, { stillWanted })) (item.isFolder ? queue : files).push(item.isFolder ? item.path : item)
      }
      return files.shift()
    }
  }

  // One file's matches, its name first (for plain text) and then its lines, as many as a search returns at most. #338: `pattern` is plain
  // text or a regular expression (lib/repositoryCopy.js's searchPattern), whose time `budget` ({ deadline, out }) all of a search's files
  // share; `ofType` passes a file over unread, and `context` asks for the lines around each match.
  async function matchesIn(item, { at, pattern, ofType, context, budget, stillWanted }) {
    if (!ofType(item.path)) return []
    const matches = !pattern.regex && item.path.toLowerCase().includes(pattern.source.toLowerCase()) ? [{ path: item.path }] : []
    if (item.size > MAX_SEARCH_FILE_BYTES) return matches
    const bytes = await bytesAt(item.path, at, { stillWanted })
    if (!bytes || bytes.byteLength > MAX_SEARCH_FILE_BYTES || looksBinary(bytes)) return matches
    if (pattern.regex && budget.out) return matches
    const scan = scanTexts([[item.path, bytes.toString('utf8')]], { pattern, context, skip: 0, take: MAX_SEARCH_MATCHES - matches.length, budgetMs: budget.deadline - Date.now() })
    if (scan.timedOut) budget.out = true
    return [...matches, ...scan.matches]
  }

  // #335: the refusal for a search whose caller has gone.
  const abandonedSearch = () => new RepositorySourceError('The search was given up before it finished.', { code: 'abandoned', status: 499 })

  /**
   * #335: searches the files `openSearchWalk` hands out, `searchParallelReads` at once, until there are none left, a cap is reached, the
   * `deadline` passes or `signal` aborts. Resolves `{ matches, filesSearched, truncatedBy, filesInWalk, filesToSearch }` (the last two null
   * where the walk can't count its files up front), the matches in walk order and cut
   * at MAX_SEARCH_MATCHES exactly as a one-by-one search would cut them. At the deadline it answers with the files searched so far, without
   * waiting for the reads under way; on abort it is refused as `abandoned`. Either way no read starts after it has answered.
   */
  async function searchFiles({ at, pattern, ofType = () => true, context = 0, roots, signal, deadline }) {
    // #335: a caller who left while the branch head was looked up costs no listing.
    if (signal?.aborted) throw abandonedSearch()
    const state = { over: false, truncatedBy: null, filesInWalk: null, filesToSearch: null }
    // #338: a search by regular expression shares one time budget across its files.
    const budget = { deadline: Date.now() + regexBudgetMs, out: false }
    // Each file's matches by its place in the walk; a gap is a file still being read.
    const found = []
    let handedOut = 0
    // How far the walk is searched without a gap, and the matches up to there: once those reach the cap, no further file is needed.
    let searchedThrough = 0
    let matchesThrough = 0
    let nextFile = null
    let queued = Promise.resolve()
    const handOut = async () => {
      if (state.over || state.truncatedBy || budget.out) return null
      nextFile ??= await openSearchWalk({ at, roots, state })
      const item = await nextFile()
      if (!item || state.over) return null
      for (; found[searchedThrough]; searchedThrough++) matchesThrough += found[searchedThrough].length
      if (matchesThrough >= MAX_SEARCH_MATCHES) state.truncatedBy = 'match-limit'
      else if (handedOut >= MAX_SEARCH_FILES) state.truncatedBy = 'file-limit'
      return state.truncatedBy ? null : { item, index: handedOut++ }
    }
    // The walk is one at a time (a folder is listed once, in order); the reads are not.
    // #335: a walk that failed (its listing refused, say) hands out nothing more, so no reader waiting its turn asks the Provider again;
    // the search fails with that first error.
    const take = () => {
      const turn = queued.then(handOut)
      queued = turn.catch(() => {
        state.over = true
      })
      return turn
    }
    const reader = async () => {
      for (let next = await take(); next; next = await take()) found[next.index] = await matchesIn(next.item, { at, pattern, ofType, context, budget, stillWanted: () => !state.over })
    }
    const readers = Promise.all(Array.from({ length: Math.max(1, searchParallelReads) }, reader))
    readers.catch(() => {})
    let timer
    let onAbort
    const stopped = new Promise((resolve, reject) => {
      timer = setTimeout(() => resolve('time-limit'), Math.max(0, deadline - Date.now()))
      onAbort = () => reject(abandonedSearch())
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    stopped.catch(() => {})
    try {
      if ((await Promise.race([readers.then(() => 'done'), stopped])) === 'time-limit') state.truncatedBy = 'time-limit'
    } finally {
      state.over = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (budget.out) state.truncatedBy ??= 'time-budget'
    const matches = []
    let filesSearched = 0
    for (const fileMatches of found) {
      if (!fileMatches) continue
      if (matches.length >= MAX_SEARCH_MATCHES) {
        state.truncatedBy ??= 'match-limit'
        break
      }
      filesSearched += 1
      matches.push(...fileMatches.slice(0, MAX_SEARCH_MATCHES - matches.length))
    }
    return { matches, filesSearched, truncatedBy: state.truncatedBy, filesInWalk: state.filesInWalk, filesToSearch: state.filesToSearch }
  }

  // #335: why a search stopped early and how far it got, as the AI and an outside agent are told it: "stopped after 30 seconds, 180 of 400
  // files searched".
  function truncatedReason(truncatedBy, { filesSearched, filesInWalk, filesToSearch }) {
    const count = (n) => n.toLocaleString('en-US')
    const searched = `${count(filesSearched)}${filesToSearch === null ? '' : ` of ${count(filesToSearch)}`} files searched`
    if (truncatedBy === 'time-limit') {
      const seconds = Number((searchTimeLimitMs / 1000).toFixed(1))
      return `stopped after ${seconds} second${seconds === 1 ? '' : 's'}, ${searched}`
    }
    if (truncatedBy === 'match-limit') return `stopped at ${MAX_SEARCH_MATCHES} matches, ${searched}`
    if (truncatedBy === 'time-budget') return budgetReason(searched)
    if (truncatedBy === 'folder-limit') return `stopped after listing ${MAX_SEARCH_FOLDERS} folders, ${searched}`
    return `stopped at its limit of ${count(MAX_SEARCH_FILES)} files${filesInWalk === null ? '' : `, of ${count(filesInWalk)} to search`}`
  }

  // #338: why a search by regular expression stopped: it reached its time budget.
  function budgetReason(searched) {
    const seconds = Number((regexBudgetMs / 1000).toFixed(1))
    return `the regular expression reached its ${seconds}-second time budget, ${searched}; make it simpler, or search within a folder`
  }

  // #338: every file a walk of the folder listings (file by file, without a copy) finds under `roots`: `{ files, truncatedBy }`, the
  // walk stopping (`folder-limit`) after MAX_SEARCH_FOLDERS folders where the Provider can't list the whole repository at once.
  async function walkAllFiles({ at, roots }) {
    const state = { over: false, truncatedBy: null }
    const next = await openSearchWalk({ at, roots, state })
    const files = []
    for (let item = await next(); item; item = await next()) files.push(item.path)
    return { files: files.sort((a, b) => a.localeCompare(b)), truncatedBy: state.truncatedBy }
  }

  // #338: refused for a query or a range that makes no sense.
  const badQuery = (message) => new RepositorySourceError(message, { code: 'bad-query', status: 400 })

  // #338: the line range `lines` of `text`, as a read answers it: `{ text, lines: { from, to, total } }`.
  function linesOf(text, range, path) {
    const all = text.split('\n')
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    const total = text === '' ? 0 : all.length
    if (range.from > total) throw badQuery(`${path} has ${total.toLocaleString('en-US')} line${total === 1 ? '' : 's'}, so there is no line ${range.from}.`)
    const to = Math.min(range.to, total)
    return { text: all.slice(range.from - 1, to).join('\n'), lines: { from: range.from, to, total } }
  }

  // #338: whether `path` lies under one of the folders a find or search was asked about.
  const underRoots = (roots) => (path) => roots.some((root) => !root || path === root || path.startsWith(`${root}/`))

  // #338: a page's numbers as every paged answer states them.
  const pageFields = ({ page, pageSize, total, pages, nextPage }) => ({ page, pageSize, total, pages, ...(nextPage ? { nextPage } : {}) })

  return {
    repository,

    /**
     * Whether this caller can read the repository, and where its branch stands: `{ branch, defaultBranch, commit }`. The branch is the
     * one asked for, or the repository's default branch when none was. Refused with a clear sentence when the caller can't read it.
     * #338: it asks the head fresh, and counts as the caller's access check for a copy someone else made.
     */
    check: () =>
      guarded(async () => {
        const meta = await ask(() => client.getRepo())
        copies?.notePass({ repositoryKey, credential })
        const defaultBranch = defaultBranchOf(repository.provider, meta) ?? 'main'
        const wanted = branch ?? defaultBranch
        return { branch: wanted, defaultBranch, commit: await branchHead(wanted, { fresh: true }) }
      }),

    /** The branch's head commit now (asked fresh). */
    head: () => guarded(() => branchHead(needBranch(), { fresh: true })),

    /**
     * #338: starts the copy at the branch's head (or at `commit`) downloading, if it isn't held or under way, and says where it stands
     * without waiting for it (or waiting at most `waitMs`): `{ commit, state: 'ready' }`, `{ commit, state: 'preparing', receivedBytes,
     * startedAt }`, or `{ commit, state: 'file-by-file', reason, message }` when there will be no copy (`too-big`, `unavailable`, `off`).
     * Asking again while it is preparing answers how far it has got. What a request answers "preparing" from, and what starting an
     * interview calls to start the download early.
     */
    prepare: ({ commit, waitMs = 0 } = {}) =>
      guarded(async () => {
        const at = await commitFor(commit)
        const handle = await copyAt(at, { wait: waitMs > 0, waitMs })
        if (!handle) return { commit: at, state: 'file-by-file', reason: 'off', message: null }
        if (handle.state === 'ready') return { commit: at, state: 'ready' }
        if (handle.state === 'preparing') return { commit: at, state: 'preparing', receivedBytes: handle.receivedBytes, startedAt: handle.startedAt }
        return { commit: at, state: 'file-by-file', ...notCopiedNote(handle.reason) }
      }),

    /**
     * A folder's files and folders at the branch's head (or at `commit`): `{ commit, path, entries: [{ path, isFolder }] }`. #338: from
     * the copy at that commit when there is one, PATH_PAGE_SIZE entries a page (`page`, from 1), with `page`, `pageSize`, `total`, `pages`
     * and `nextPage` when there is another.
     */
    list: ({ path = '', commit, page } = {}) =>
      guarded(async () => {
        const clean = pathOrRefusal(path)
        const at = await commitFor(commit)
        const { copy } = await copyOrReason(at)
        const entries = copy ? listCopyFolder(copy, clean).filter((item) => withinRepositoryFolders(repository, item.path, { orAbove: item.isFolder })) : await children(clean, at)
        const paged = pageOf(entries, page, PATH_PAGE_SIZE)
        return { commit: at, path: clean, entries: paged.items, ...pageFields(paged) }
      }),

    /**
     * One file's text at the branch's head (or at `commit`): `{ commit, path, text, size, citationQuery }`. Refused for a path that is skipped, outside
     * the pointer's folders, missing, over MAX_REPOSITORY_FILE_BYTES or binary. #338: from the copy at that commit when it holds the file;
     * a path the copy hasn't got (an archive can leave some out) is read from the Provider as before. `lines` (`{ from, to }`, `[from, to]`
     * or `"from-to"`) reads only those lines, and the answer then says which, of how many: `lines: { from, to, total }`.
     */
    read: ({ path, commit, lines } = {}) =>
      guarded(async () => {
        const clean = pathOrRefusal(path, { file: true })
        const range = lineRange(lines)
        if (range?.refusal) throw badQuery(range.refusal)
        const at = await commitFor(commit)
        const { copy } = await copyOrReason(at)
        const tooLarge = () => new RepositorySourceError(`${clean} is over ${MAX_REPOSITORY_FILE_BYTES / (1024 * 1024)} MB, too big to read here.`, { code: 'too-large', status: 413 })
        const binary = () => new RepositorySourceError(`${clean} is a binary file, which Gantry never reads.`, { code: 'skipped', status: 400 })
        let text
        let size
        if (copy?.files.has(clean)) {
          text = copy.files.get(clean)
          size = Buffer.byteLength(text)
        } else {
          const leftOut = copy?.leftOut.get(clean)?.reason
          if (leftOut === 'too-large') throw tooLarge()
          if (leftOut === 'binary') throw binary()
          const bytes = await bytesAt(clean, at)
          if (!bytes) throw new RepositorySourceError(`There is no file ${clean} in ${repositoryName(repository)} at ${at.slice(0, 7)}.`, { code: 'not-found', status: 404 })
          if (bytes.byteLength > MAX_REPOSITORY_FILE_BYTES) throw tooLarge()
          if (looksBinary(bytes)) throw binary()
          text = bytes.toString('utf8')
          size = bytes.byteLength
        }
        // `citationQuery` is what a citation of this file at this commit carries after the document's id.
        const answer = { commit: at, path: clean, text, size, citationQuery: repositoryCitationQuery({ path: clean, commit: at }) }
        return range ? { ...answer, ...linesOf(text, range, clean) } : answer
      }),

    /**
     * #338: the files whose names match `pattern` (lib/repositoryCopy.js's namePatternTest: `*`, `**`, `?`, `{a,b}`; a pattern with no `/`
     * matches a file's own name anywhere) at the branch's head, within the pointer's folders (or `path`): `{ commit, pattern, path, paths,
     * page, pageSize, total, pages, nextPage? }`, PATH_PAGE_SIZE paths a page, sorted. From the copy when there is one; otherwise from the
     * folder listings, with `notCopied` saying why, and `truncated` when the walk stopped at its limit of folders. `commit` finds at that
     * commit instead of the head (the route passes the one it prepared, so a find never lands on a newer copy than the one it waited for).
     */
    find: ({ pattern, path = '', page, commit } = {}) =>
      guarded(async () => {
        const wanted = String(pattern ?? '').trim()
        if (!wanted) throw badQuery('Give a name pattern to find, such as **/*.tf or src/**/order*.')
        const start = pathOrRefusal(path)
        const at = await commitFor(commit)
        const under = underRoots(start ? [start] : repository.folders ?? [''])
        const matchesName = namePatternTest(wanted)
        const wantedPath = (item) => under(item) && withinRepositoryFolders(repository, item) && matchesName(item)
        const { copy, notCopied } = await copyOrReason(at)
        let walked = null
        if (!copy) walked = await walkAllFiles({ at, roots: start ? [start] : repository.folders ?? [''] })
        const paged = pageOf((copy ? copyFilePaths(copy) : walked.files).filter(wantedPath), page, PATH_PAGE_SIZE)
        return {
          commit: at,
          pattern: wanted,
          path: start,
          paths: paged.items,
          ...pageFields(paged),
          ...(notCopied ? { notCopied } : {}),
          ...(walked?.truncatedBy ? { truncated: true, truncatedBy: walked.truncatedBy, truncatedReason: `stopped after listing ${MAX_SEARCH_FOLDERS} folders` } : {}),
        }
      }),

    /**
     * Finds `query` (case-insensitive) in the file names and the text of the repository at the branch's head, within the pointer's folders
     * (or `path`), skipping what is always skipped: `{ commit, query, matches: [{ path, line?, text? }], filesSearched, truncated }`, plus
     * `truncatedBy` (`time-limit`, `file-limit`, `match-limit` or `folder-limit`) and `truncatedReason`, a phrase saying why and how far it
     * got, when it stopped early. A walk over the folder listing (one listing of the whole repository where the Provider gives one, #325);
     * it stops at MAX_SEARCH_FILES files. #335: it reads `searchParallelReads` files at once, returns what it has found once
     * `searchTimeLimitMs` has passed, and once `signal` aborts (nobody is waiting for the answer any more) starts no further read and is
     * refused as `abandoned`.
     *
     * #338: `regex` searches by regular expression (case-insensitive too, at most MAX_PATTERN_LENGTH characters, and stopped at
     * `regexBudgetMs` with `truncatedBy: 'time-budget'`). `fileTypes` (extensions such as `ts`, or name patterns such as `*.test.js`) narrows
     * the files searched; `context` (0 to 5) adds the lines `before` and `after` each match (`[{ line, text }]`); `filesOnly` answers the
     * matching files instead, `{ path, count }` each. From the copy when there is one, which searches every file and pages the answer:
     * SEARCH_PAGE_LINES matching lines a page (PATH_PAGE_SIZE files in files-only mode), `page` from 1, every page stating `totalMatches`,
     * `totalFiles`, `page`, `pageSize`, `pages` and `nextPage` when there is another. A copy's search matches lines only (file names are
     * `find`'s). Without a copy it is the walk above, and `notCopied` (`{ reason, message }`) says why, to tell the AI to narrow to a folder.
     * `commit` searches at that commit instead of the head, as `find` does.
     */
    search: ({ query, regex = false, path = '', fileTypes, context = 0, filesOnly = false, page, commit, signal } = {}) =>
      guarded(async () => {
        const startedAt = Date.now()
        const pattern = searchPattern(query, { regex: Boolean(regex) })
        if (pattern.refusal) throw badQuery(pattern.refusal)
        const wanted = pattern.source
        const start = pathOrRefusal(path)
        const ofType = fileTypeTest(fileTypes)
        // #335: nothing is asked of the Provider for a caller already gone.
        if (signal?.aborted) throw abandonedSearch()
        const at = await commitFor(commit)
        const roots = start ? [start] : repository.folders ?? ['']
        const { copy, notCopied } = await copyOrReason(at)
        if (signal?.aborted) throw abandonedSearch()
        if (copy) {
          const under = underRoots(roots)
          const files = copyFilePaths(copy)
            .filter((item) => copy.files.has(item) && under(item) && withinRepositoryFolders(repository, item) && ofType(item))
            .map((item) => [item, copy.files.get(item)])
          const pageSize = filesOnly ? PATH_PAGE_SIZE : SEARCH_PAGE_LINES
          const at_page = wholePage(page)
          const scan = scanTexts(files, { pattern, context, filesOnly, skip: (at_page - 1) * pageSize, take: pageSize, budgetMs: regexBudgetMs })
          const total = filesOnly ? scan.totalFiles : scan.totalMatches
          const pages = Math.ceil(total / pageSize)
          const answer = {
            commit: at,
            query: wanted,
            ...(pattern.regex ? { regex: true } : {}),
            matches: scan.matches,
            filesSearched: scan.searched,
            truncated: false,
            totalMatches: scan.totalMatches,
            totalFiles: scan.totalFiles,
            ...pageFields({ page: at_page, pageSize, total, pages, nextPage: at_page < pages ? at_page + 1 : null }),
          }
          if (!scan.timedOut) return answer
          const count = (n) => n.toLocaleString('en-US')
          return { ...answer, truncated: true, truncatedBy: 'time-budget', truncatedReason: budgetReason(`${count(scan.searched)} of ${count(files.length)} files searched`) }
        }
        const { matches, filesSearched, truncatedBy, ...walked } = await searchFiles({ at, pattern, ofType, context, roots, signal, deadline: startedAt + searchTimeLimitMs })
        const shown = filesOnly ? filesOf(matches) : matches
        const extra = { ...(pattern.regex ? { regex: true } : {}), ...(notCopied ? { notCopied } : {}) }
        if (!truncatedBy) return { commit: at, query: wanted, matches: shown, filesSearched, truncated: false, ...extra }
        return { commit: at, query: wanted, matches: shown, filesSearched, truncated: true, truncatedBy, truncatedReason: truncatedReason(truncatedBy, { filesSearched, ...walked }), ...extra }
      }),

    /**
     * Out of date (#319): for each `{ path, commit }` a Field drew on, whether that file at the branch's head differs from what it was at
     * the recorded commit: `{ head, results: [{ path, commit, changed, deleted }] }`. A new commit that touches none of them changes nothing.
     * #338: the head is always asked fresh. A file is read from the copy at its commit when one is held (none is made for this), else from
     * the Provider.
     */
    compare: ({ reads } = {}) =>
      guarded(async () => {
        const head = await branchHead(needBranch(), { fresh: true })
        const results = []
        const nowCache = new Map()
        // A file at `commit` as `{ text }` from a copy, `{ bytes }` from the Provider, or null when it isn't there.
        const fileAt = async (path, commit) => {
          for (const scope of copies ? ['', ...(folderScope ? [folderScope] : [])] : []) {
            const copy = await copies.existingCopy({ repositoryKey, commit, scope, credential, checkAccess })
            if (copy?.files.has(path)) return { text: copy.files.get(path) }
          }
          const bytes = await bytesAt(path, commit)
          return bytes === null ? null : { bytes }
        }
        const same = (a, b) => (a.bytes && b.bytes ? a.bytes.equals(b.bytes) : (a.text ?? a.bytes.toString('utf8')) === (b.text ?? b.bytes.toString('utf8')))
        for (const read of Array.isArray(reads) ? reads : []) {
          const path = cleanRepositoryPath(read?.path)
          const commit = typeof read?.commit === 'string' ? read.commit.trim() : ''
          if (!path || !commit) continue
          if (commit === head) {
            results.push({ path, commit, changed: false, deleted: false })
            continue
          }
          if (!nowCache.has(path)) nowCache.set(path, await fileAt(path, head))
          const now = nowCache.get(path)
          const then = await fileAt(path, commit)
          const deleted = now === null && then !== null
          const changed = deleted || (now !== null && (then === null || !same(now, then)))
          results.push({ path, commit, changed, deleted })
        }
        return { head, results }
      }),
  }
}
