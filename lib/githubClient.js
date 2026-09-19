import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from './providerErrors.js'

const DEFAULT_BASE_URL = 'https://api.github.com'
const API_VERSION_HEADER = '2022-11-28'

const PROVIDER = 'github'

/**
 * Thrown when GitHub rejects the supplied PAT (401, or 403 for a scope/permission problem this
 * client doesn't otherwise distinguish). Mirrors `lib/azureDevOpsClient.js`'s
 * `AzureDevOpsAuthenticationError` — extends the provider-neutral `AuthenticationError`
 * (`docs/adr/0039`) so a call site can catch either the vendor-named class or the neutral one.
 *
 * Note (`docs/adr/0040`, ADR-0040's own "Consequences"): a fine-grained PAT missing a required scope
 * against a repo it otherwise can't see reports as **404**, not 401/403 — GitHub's own documented
 * behaviour, not a gap in this client. That case surfaces as `GitHubNotFoundError`/
 * `GitHubRepoNotFoundError` below, not this class; a caller chasing an unexplained "not found"
 * should suspect a missing scope before a missing repo.
 */
export class GitHubAuthenticationError extends AuthenticationError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitHubAuthenticationError'
  }
}

/** Thrown when the repository itself doesn't exist (or the PAT can't see it) — distinct from a missing path within an existing repo (`GitHubNotFoundError`) and from a rejected PAT (`GitHubAuthenticationError`). Raised by `getRepo()` (#8's `checkGitHubRepo` needs this to distinguish "no such repo" from "PAT rejected" from "empty, but real"); `repoExists()` reduces it to a boolean instead of throwing, mirroring `lib/azureDevOpsClient.js`'s own `repoExists`. */
export class GitHubRepoNotFoundError extends RepoNotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitHubRepoNotFoundError'
  }
}

/** Thrown when a requested item (file or folder path) doesn't exist in the repo, at the given ref — distinct from the repository itself not existing (`GitHubRepoNotFoundError`). */
export class GitHubNotFoundError extends NotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitHubNotFoundError'
  }
}

/** Catch-all for any other failed call to the GitHub API: a non-2xx response this client doesn't otherwise distinguish, or a network-level failure reaching GitHub at all. */
export class GitHubRequestError extends RequestError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { status, body, provider: PROVIDER, cause })
    this.name = 'GitHubRequestError'
  }
}

function normalizeRepoRelativePath(path) {
  return path.replace(/^\/+/, '')
}

/**
 * A GitHub REST client, authenticated with a caller-supplied Personal Access Token
 * (`Authorization: Bearer <pat>`, GitHub's own current convention for both classic and fine-grained
 * tokens — distinct from the browser-to-gantry Basic-auth header docs/adr/0038 leaves unchanged;
 * "only the gantry-to-provider header is provider-specific" per that ADR). Covers the **read-only**
 * subset of the content-store capability (`docs/adr/0039`) two tickets need: proving a PAT reaches a
 * real repository before it's registered (#8's `getRepo`/`repoExists`, used by
 * `lib/repoCheck.js`'s `checkGitHubRepo`), and reading an existing file/folder over the Contents API
 * (#19's `getFileContent`/`fileExists`/`listFolder`, used by `lib/definitionGitHub.js` to read a
 * library repo's `definitions/` folder). Branches/commits/writes (the rest of the content-store
 * interface Azure DevOps's client already implements) are a later ticket's job (#11 — GitHub content
 * store: save and load stage content); this client is deliberately a narrower surface until that
 * lands, not a redesign of the interface.
 *
 * `baseUrl` defaults to the public GitHub API but is overridable — for a GitHub Enterprise Server
 * instance (its own REST API lives under `<host>/api/v3`, GitHub's own documented convention, so a
 * caller supplies that full path) or, in tests, a fake in-process server
 * (`tests/helpers/fakeGitHubServer.js`) instead of `api.github.com`.
 */
export function createGitHubClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createGitHubClient: "${name}" is required`)
  }

  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  function authHeaders() {
    return {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION_HEADER,
    }
  }

  // Low-level GET for anything *within* a real repo (Contents API paths) — a 404 here always means
  // "this item doesn't exist", never "this repo doesn't exist" (see getRepo's own dedicated request
  // below, which throws the repo-level error instead).
  async function request(url) {
    let res
    try {
      res = await fetch(url, { headers: authHeaders() })
    } catch (err) {
      throw new GitHubRequestError(`Network error calling GitHub API (GET ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitHubAuthenticationError(`GitHub rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitHubNotFoundError(`GitHub found no item for GET ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GitHubRequestError(`GitHub API request failed: GET ${url} -> HTTP ${res.status}`, { status: res.status, body })
    }
    return res
  }

  function contentsUrl(path, ref) {
    const normalized = normalizeRepoRelativePath(path)
    const encodedPath = normalized
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    const url = new URL(`${repoUrl}/contents${encodedPath ? `/${encodedPath}` : ''}`)
    if (ref) url.searchParams.set('ref', ref)
    return url.toString()
  }

  /**
   * Fetches an existing file's raw text content by repo-relative path. Throws GitHubNotFoundError if
   * no file exists at that path (on the given branch, default "main") — including when `path` names
   * a directory instead of a file, since a caller asking for file content at a directory path is the
   * same "there is no file here" case.
   */
  async function getFileContent(path, { branch = 'main' } = {}) {
    const res = await request(contentsUrl(path, branch))
    const data = await res.json()
    if (Array.isArray(data) || data.type !== 'file') {
      throw new GitHubNotFoundError(`GitHub found no file at "${path}" on "${branch}" (it is a directory, or does not exist)`)
    }
    return Buffer.from(data.content, data.encoding ?? 'base64').toString('utf8')
  }

  async function fileExists(path, branch) {
    try {
      await getFileContent(path, { branch })
      return true
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return false
      throw err
    }
  }

  /**
   * Lists the immediate children of a repo-relative folder path — `[{ path, isFolder }, ...]`, sorted
   * by path. `[]` (not an error) if the folder itself doesn't exist, mirroring
   * `lib/azureDevOpsClient.js`'s `listFolder`'s identical "absence is not exceptional" contract.
   */
  async function listFolder(path, { branch = 'main' } = {}) {
    try {
      const res = await request(contentsUrl(path, branch))
      const data = await res.json()
      if (!Array.isArray(data)) return [] // `path` names a file, not a folder — no children.
      return data
        .map((entry) => ({ path: entry.path, isFolder: entry.type === 'dir' }))
        .sort((a, b) => a.path.localeCompare(b.path))
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return []
      throw err
    }
  }

  /**
   * Fetches the repository's own metadata — the "does this repo exist and does this PAT reach it"
   * check `lib/repoCheck.js`'s `checkGitHubRepo` needs (#8). A dedicated request rather than going
   * through `request()` above, because a 404 *here* means the repository itself doesn't exist —
   * `GitHubRepoNotFoundError` — never the generic item-level `GitHubNotFoundError` every other 404 in
   * this client throws.
   */
  async function getRepo() {
    let res
    try {
      res = await fetch(repoUrl, { headers: authHeaders() })
    } catch (err) {
      throw new GitHubRequestError(`Network error calling GitHub API (GET ${repoUrl}): ${err.message}`, { cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitHubAuthenticationError(`GitHub rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitHubRepoNotFoundError(`GitHub repository ${owner}/${repository} does not exist — create it on GitHub first.`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GitHubRequestError(`GitHub API request failed: GET ${repoUrl} -> HTTP ${res.status}`, { status: res.status, body })
    }
    return res.json()
  }

  /** Whether the repository exists and is reachable with this PAT — `getRepo` reduced to a boolean, mirroring `lib/azureDevOpsClient.js`'s own `repoExists`. */
  async function repoExists() {
    try {
      await getRepo()
      return true
    } catch (err) {
      if (err instanceof GitHubRepoNotFoundError) return false
      throw err
    }
  }

  return { owner, repository, baseUrl, getRepo, repoExists, getFileContent, fileExists, listFolder }
}

export { DEFAULT_BASE_URL }
