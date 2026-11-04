import { AuthenticationError, NotFoundError, RepoNotFoundError, providerDisplayName } from './providerErrors.js'
import { resolveContentStore } from './providerRegistry.js'
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

/** A file bigger than this is not read: it is almost never source code an architect cites. */
export const MAX_REPOSITORY_FILE_BYTES = 1024 * 1024
/** A search reads at most this many files, and lists at most this many folders, so one call stays quick on a large repository. */
export const MAX_SEARCH_FILES = 400
export const MAX_SEARCH_FOLDERS = 200
/** A search returns at most this many matching lines. */
export const MAX_SEARCH_MATCHES = 60
/** A file a search reads is skipped above this size. */
const MAX_SEARCH_FILE_BYTES = 256 * 1024

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
 */
export function createRepositoryReader(repositoryInput, pat, { allowBaseUrl = false, clientBaseUrl, rawBaseUrl } = {}) {
  // A placeholder branch lets a pointer with none yet be checked; `branch` below stays null for it.
  const repository = normalizeSourceRepository({ ...repositoryInput, branch: repositoryInput?.branch || 'unset' })
  if (!repository) throw new RepositorySourceError('A code repository needs its Provider and its location, as for a workspace.', { code: 'bad-repository', status: 400 })
  if (repository.location.baseUrl && !allowBaseUrl) {
    throw new RepositorySourceError(`This Gantry server doesn't take a self-hosted ${repositoryProviderLabel(repository.provider)} address.`, { code: 'base-url-not-allowed', status: 400 })
  }
  const branch = repositoryInput?.branch ? repository.branch : null
  const hasToken = Boolean(pat)
  const client = resolveContentStore(repository.provider, { ...repository.location, ...(clientBaseUrl ? { baseUrl: clientBaseUrl } : {}), ...(rawBaseUrl ? { rawBaseUrl } : {}), pat: pat ?? undefined, anonymous: !hasToken })

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
      if (err?.status === undefined && /network error/i.test(err?.message ?? '')) {
        throw new RepositorySourceError(`Gantry couldn't reach ${providerDisplayName(repository.provider)} to read ${repositoryName(repository)}. Try again in a moment.`, { code: 'unreachable', status: 502 })
      }
      throw err
    }
  }

  // The commit the branch points at now; refused as missing branch when there is none.
  async function headOf(name) {
    const commit = await client.getBranchObjectId(name)
    if (!commit || /^0+$/.test(commit)) throw new RepositorySourceError(`${repositoryName(repository)} has no branch "${name}".`, { code: 'no-branch', status: 404 })
    return commit
  }

  const needBranch = () => {
    if (!branch) throw new RepositorySourceError('Say which branch of the repository to read.', { code: 'bad-repository', status: 400 })
    return branch
  }

  // The commit to read at: the one asked for, else the branch's head now.
  const commitFor = async (commit) => (typeof commit === 'string' && commit.trim() ? commit.trim() : headOf(needBranch()))

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

  // A folder's children at `commit`, with the skipped paths and anything outside the pointer's folders left out.
  async function children(path, commit) {
    const items = await client.listFolder(path, atCommit(repository.provider, commit))
    return items
      .map((item) => ({ path: cleanRepositoryPath(item.path) ?? '', isFolder: Boolean(item.isFolder) }))
      .filter((item) => item.path && !skippedRepositoryPath(item.path) && withinRepositoryFolders(repository, item.path, { orAbove: item.isFolder }))
      .sort((a, b) => (a.isFolder === b.isFolder ? a.path.localeCompare(b.path) : a.isFolder ? -1 : 1))
  }

  async function bytesAt(path, commit) {
    try {
      return Buffer.from(await client.getFileBytes(path, atCommit(repository.provider, commit)))
    } catch (err) {
      if (err instanceof NotFoundError || err?.name === 'NotFoundError') return null
      throw err
    }
  }

  return {
    repository,

    /**
     * Whether this caller can read the repository, and where its branch stands: `{ branch, defaultBranch, commit }`. The branch is the
     * one asked for, or the repository's default branch when none was. Refused with a clear sentence when the caller can't read it.
     */
    check: () =>
      guarded(async () => {
        const meta = await client.getRepo()
        const defaultBranch = defaultBranchOf(repository.provider, meta) ?? 'main'
        const wanted = branch ?? defaultBranch
        return { branch: wanted, defaultBranch, commit: await headOf(wanted) }
      }),

    /** The branch's head commit now. */
    head: () => guarded(() => headOf(needBranch())),

    /** A folder's files and folders at the branch's head (or at `commit`): `{ commit, path, entries: [{ path, isFolder }] }`. */
    list: ({ path = '', commit } = {}) =>
      guarded(async () => {
        const clean = pathOrRefusal(path)
        const at = await commitFor(commit)
        return { commit: at, path: clean, entries: await children(clean, at) }
      }),

    /**
     * One file's text at the branch's head (or at `commit`): `{ commit, path, text, size, citationQuery }`. Refused for a path that is skipped, outside
     * the pointer's folders, missing, over MAX_REPOSITORY_FILE_BYTES or binary.
     */
    read: ({ path, commit } = {}) =>
      guarded(async () => {
        const clean = pathOrRefusal(path, { file: true })
        const at = await commitFor(commit)
        const bytes = await bytesAt(clean, at)
        if (!bytes) throw new RepositorySourceError(`There is no file ${clean} in ${repositoryName(repository)} at ${at.slice(0, 7)}.`, { code: 'not-found', status: 404 })
        if (bytes.byteLength > MAX_REPOSITORY_FILE_BYTES) throw new RepositorySourceError(`${clean} is over ${MAX_REPOSITORY_FILE_BYTES / (1024 * 1024)} MB, too big to read here.`, { code: 'too-large', status: 413 })
        if (looksBinary(bytes)) throw new RepositorySourceError(`${clean} is a binary file, which Gantry never reads.`, { code: 'skipped', status: 400 })
        // `citationQuery` is what a citation of this file at this commit carries after the document's id.
        return { commit: at, path: clean, text: bytes.toString('utf8'), size: bytes.byteLength, citationQuery: repositoryCitationQuery({ path: clean, commit: at }) }
      }),

    /**
     * Finds `query` (case-insensitive) in the file names and the text of the repository at the branch's head, within the pointer's folders
     * (or `path`), skipping what is always skipped: `{ commit, query, matches: [{ path, line?, text? }], filesSearched, truncated }`. A walk
     * over the folder listing (one listing of the whole repository where the Provider gives one, #325); it stops at MAX_SEARCH_FILES files.
     */
    search: ({ query, path = '' } = {}) =>
      guarded(async () => {
        const wanted = String(query ?? '').trim()
        if (wanted.length < 2) throw new RepositorySourceError('Search for at least two characters.', { code: 'bad-query', status: 400 })
        const needle = wanted.toLowerCase()
        const start = pathOrRefusal(path)
        const at = await commitFor()
        const roots = start ? [start] : repository.folders ?? ['']
        const matches = []
        let filesSearched = 0
        let foldersListed = 0
        let truncated = false
        const searchFile = async (path) => {
          if (path.toLowerCase().includes(needle)) matches.push({ path })
          filesSearched += 1
          const bytes = await bytesAt(path, at)
          if (!bytes || bytes.byteLength > MAX_SEARCH_FILE_BYTES || looksBinary(bytes)) return
          const lines = bytes.toString('utf8').split('\n')
          for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
            if (lines[i].toLowerCase().includes(needle)) matches.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) })
          }
        }
        // #325: where the Provider lists the whole repository in one request (GitHub), search walks that instead of one request per folder,
        // and passes over a file too big to search by its listed size without fetching it.
        const tree = client.listTree ? await client.listTree(at) : null
        if (tree && !tree.truncated) {
          const under = (path) => roots.some((root) => !root || path === root || path.startsWith(`${root}/`))
          const files = tree.entries
            .map((item) => ({ ...item, path: cleanRepositoryPath(item.path) ?? '' }))
            .filter((item) => !item.isFolder && item.path && under(item.path) && !skippedRepositoryPath(item.path) && withinRepositoryFolders(repository, item.path))
            .sort((a, b) => a.path.localeCompare(b.path))
          for (const item of files) {
            if (filesSearched >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true
              break
            }
            if (item.size > MAX_SEARCH_FILE_BYTES) {
              if (item.path.toLowerCase().includes(needle)) matches.push({ path: item.path })
              filesSearched += 1
              continue
            }
            await searchFile(item.path)
          }
          return { commit: at, query: wanted, matches, filesSearched, truncated }
        }
        const queue = [...roots]
        while (queue.length && !truncated) {
          const folder = queue.shift()
          if (++foldersListed > MAX_SEARCH_FOLDERS) {
            truncated = true
            break
          }
          for (const item of await children(folder, at)) {
            if (item.isFolder) {
              queue.push(item.path)
              continue
            }
            if (filesSearched >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true
              break
            }
            await searchFile(item.path)
          }
        }
        return { commit: at, query: wanted, matches, filesSearched, truncated }
      }),

    /**
     * Out of date (#319): for each `{ path, commit }` a Field drew on, whether that file at the branch's head differs from what it was at
     * the recorded commit: `{ head, results: [{ path, commit, changed, deleted }] }`. A new commit that touches none of them changes nothing.
     */
    compare: ({ reads } = {}) =>
      guarded(async () => {
        const head = await headOf(needBranch())
        const results = []
        const nowCache = new Map()
        for (const read of Array.isArray(reads) ? reads : []) {
          const path = cleanRepositoryPath(read?.path)
          const commit = typeof read?.commit === 'string' ? read.commit.trim() : ''
          if (!path || !commit) continue
          if (commit === head) {
            results.push({ path, commit, changed: false, deleted: false })
            continue
          }
          if (!nowCache.has(path)) nowCache.set(path, await bytesAt(path, head))
          const now = nowCache.get(path)
          const then = await bytesAt(path, commit)
          const deleted = now === null && then !== null
          const changed = deleted || (now !== null && (then === null || !now.equals(then)))
          results.push({ path, commit, changed, deleted })
        }
        return { head, results }
      }),
  }
}
