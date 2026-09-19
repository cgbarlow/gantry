import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'

const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4'

const PROVIDER = 'gitlab'

/**
 * Thrown when GitLab rejects the supplied PAT (401, or 403 for a token that's real but lacks the
 * required scope/access level against this project). Mirrors `lib/githubClient.js`'s
 * `GitHubAuthenticationError` — extends the provider-neutral `AuthenticationError` (`docs/adr/0039`)
 * so a call site can catch either the vendor-named class or the neutral one.
 */
export class GitLabAuthenticationError extends AuthenticationError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitLabAuthenticationError'
  }
}

/** Thrown when a requested item (file or folder path) doesn't exist in the project, at the given ref. GitLab returns the same 404 shape whether the project itself is unreachable with this token or just the one path is missing — this client's `getFileContent`/`listFolder` don't need to tell those apart (unlike `lib/githubClient.js`'s dedicated repo-metadata call), since #27's only caller (`lib/definitionGitLab.js`, read-only) never needs a repo-level existence check ahead of reading `definitions/` itself. */
export class GitLabNotFoundError extends NotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitLabNotFoundError'
  }
}

/** Catch-all for any other failed call to the GitLab API: a non-2xx response this client doesn't otherwise distinguish, or a network-level failure reaching GitLab at all. */
export class GitLabRequestError extends RequestError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { status, body, provider: PROVIDER, cause })
    this.name = 'GitLabRequestError'
  }
}

export { PROVIDER }

function normalizeRepoRelativePath(path) {
  return path.replace(/^\/+/, '')
}

/**
 * A read-only GitLab REST API v4 client, authenticated with a caller-supplied Personal/Project/Group
 * Access Token (`PRIVATE-TOKEN: <pat>` header — GitLab's own convention for all three token kinds,
 * distinct from the browser-to-gantry Basic-auth header ADR-0038 leaves unchanged). `namespace` is
 * GitLab's full group/subgroup path as one opaque string (ADR-0041) and `repository` is a GitLab
 * Project's name — together addressed as GitLab's own `:id` path parameter, the URL-encoded
 * `namespace%2Frepository` string (GitLab's documented way to address a project by its full path
 * rather than its numeric id, which gantry never has reason to look up).
 *
 * Scope (#27, ADR-0041, ADR-0036): only what `lib/definitionGitLab.js` needs to read a **library
 * repo**'s `definitions/` folder — `getFileContent` and `listFolder`, both read-only. A library repo
 * is read-only by design (`lib/librarySettings.js`'s own doc comment), so this client has no write
 * path at all yet. GitLab's content-store capability proper — writing files, branches, commits,
 * registered in `lib/providerRegistry.js` — is ticket #26's job; that ticket is expected to extend
 * this same file (mirroring how `lib/githubClient.js` grew write support alongside its read support)
 * rather than duplicate it.
 *
 * `baseUrl` defaults to gitlab.com's own API but is overridable for a self-hosted GitLab CE/EE
 * instance's own `<host>/api/v4` (ADR-0041's "self-hosted from day one") or, in tests, a fake
 * in-process server (`tests/helpers/fakeGitLabServer.js`) instead of `gitlab.com`.
 */
export function createGitLabClient({ namespace, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ namespace, repository, pat })) {
    if (!value) throw new Error(`createGitLabClient: "${name}" is required`)
  }

  const projectId = encodeURIComponent(`${namespace}/${repository}`)
  const projectUrl = `${baseUrl.replace(/\/+$/, '')}/projects/${projectId}`

  function authHeaders() {
    return { 'PRIVATE-TOKEN': pat }
  }

  // Low-level GET for anything within the project — a 404 here always means "this item doesn't
  // exist at this ref", the only 404 case this read-only client's two callers below ever hit.
  async function request(url) {
    let res
    try {
      res = await fetch(url, { headers: authHeaders() })
    } catch (err) {
      throw new GitLabRequestError(`Network error calling GitLab API (GET ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitLabAuthenticationError(`GitLab rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitLabNotFoundError(`GitLab found no item for GET ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new GitLabRequestError(`GitLab API request failed: GET ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  function rawFileUrl(path, ref) {
    const normalized = normalizeRepoRelativePath(path)
    const url = new URL(`${projectUrl}/repository/files/${encodeURIComponent(normalized)}/raw`)
    url.searchParams.set('ref', ref)
    return url.toString()
  }

  /**
   * Fetches an existing file's raw text content by repo-relative path — GitLab's Repository Files
   * "raw" endpoint, which returns the file's bytes directly rather than a JSON-wrapped, base64
   * envelope (the shape `lib/githubClient.js`'s Contents API needs to decode; GitLab's own Files API
   * has that JSON form too, but the raw endpoint is simpler for a read-only, text-only caller).
   * Throws `GitLabNotFoundError` if no file exists at that path on the given branch (default "main").
   */
  async function getFileContent(path, { branch = 'main' } = {}) {
    const res = await request(rawFileUrl(path, branch))
    return res.text()
  }

  async function fileExists(path, branch) {
    try {
      await getFileContent(path, { branch })
      return true
    } catch (err) {
      if (err instanceof GitLabNotFoundError) return false
      throw err
    }
  }

  /**
   * Lists the immediate children of a repo-relative folder path — `[{ path, isFolder }, ...]`, sorted
   * by path. `[]` (not an error) if the folder itself doesn't exist, mirroring
   * `lib/githubClient.js`'s `listFolder`'s identical "absence is not exceptional" contract: GitLab's
   * own Repository Tree endpoint already returns `200 []` for a path with nothing under it (as
   * opposed to a ref that doesn't exist at all, which 404s and is left to propagate — there is no
   * tolerant case for a missing *branch*, only a missing *path*).
   */
  async function listFolder(path, { branch = 'main' } = {}) {
    const normalized = normalizeRepoRelativePath(path)
    const url = new URL(`${projectUrl}/repository/tree`)
    url.searchParams.set('ref', branch)
    url.searchParams.set('per_page', '100')
    if (normalized) url.searchParams.set('path', normalized)
    const res = await request(url.toString())
    const data = await res.json()
    return data
      .map((entry) => ({ path: entry.path, isFolder: entry.type === 'tree' }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  return {
    namespace,
    repository,
    baseUrl,
    getFileContent,
    fileExists,
    listFolder,
  }
}

export { DEFAULT_BASE_URL }
