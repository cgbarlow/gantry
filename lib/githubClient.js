import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from './providerErrors.js'

const DEFAULT_BASE_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

const PROVIDER = 'github'

/**
 * Thrown when GitHub rejects the supplied PAT (401), or the PAT is valid but lacks a scope the
 * request needs (403). Extends the provider-neutral AuthenticationError (docs/adr/0039) so a call
 * site can catch either this vendor-named class or the neutral one.
 *
 * Per docs/adr/0040's own noted trap: an *insufficient* fine-grained-PAT scope against a repo the
 * token otherwise can't see comes back as 404, not 403 — this client cannot distinguish that case
 * from a genuinely nonexistent repository at the HTTP layer, so it maps 404 to
 * GitHubRepoNotFoundError (below) exactly as a real missing repo would. That ambiguity is a
 * documented, accepted consequence (ADR-0040), addressed by PAT-scope help text at the call sites
 * that prompt for a PAT, not by this client guessing.
 */
export class GitHubAuthenticationError extends AuthenticationError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitHubAuthenticationError'
  }
}

/** Thrown when the repository itself doesn't exist (or isn't visible to this PAT — see GitHubAuthenticationError's own doc comment on the 404-vs-403 ambiguity) — distinct from a missing item within an existing repo (GitHubNotFoundError) and from a rejected PAT (GitHubAuthenticationError). */
export class GitHubRepoNotFoundError extends RepoNotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitHubRepoNotFoundError'
  }
}

/** Thrown when a requested item (file, issue, pull request, …) within an existing, reachable repo doesn't exist. */
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

/**
 * A minimal GitHub REST client, authenticated with a caller-supplied Personal Access Token
 * (`Authorization: Bearer <pat>`, GitHub's own documented convention for both classic and
 * fine-grained PATs — distinct from the browser-to-gantry Basic-auth header docs/adr/0038 leaves
 * unchanged; "only the gantry-to-provider header is provider-specific" per that ADR).
 *
 * `baseUrl` defaults to the real GitHub API but is overridable — for a GitHub Enterprise Server
 * instance (its own REST API lives under `<host>/api/v3`, GitHub's own documented convention, so a
 * caller supplies that full path) or, in tests, a fake in-process server (see
 * tests/helpers/fakeGitHubServer.js) instead of `api.github.com`.
 *
 * Covers only what #8 (registering a GitHub remote workspace) needs today — proving a PAT against a
 * real repository. Content-store (#11), pull-request (#13), work-item (#14) and identity (#10)
 * capabilities land in their own later tickets and register here the same way
 * lib/azureDevOpsClient.js's siblings do.
 */
export function createGitHubClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createGitHubClient: "${name}" is required`)
  }

  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  function authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...extra,
    }
  }

  /**
   * Fetches the repository's own metadata — the "does this repo exist and does this PAT reach it"
   * check lib/repoCheck.js's `checkGitHubRepo` needs. Throws GitHubRepoNotFoundError on a 404
   * (nonexistent repo, or a PAT scope insufficient to see it — see GitHubAuthenticationError's own
   * doc comment).
   */
  async function getRepo() {
    const url = repoUrl
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
      throw new GitHubRepoNotFoundError(`GitHub repository ${owner}/${repository} does not exist — create it on GitHub first.`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new GitHubRequestError(`GitHub API request failed: GET ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res.json()
  }

  /** Whether the repository exists and is reachable with this PAT — `getRepo` reduced to a boolean, mirroring lib/azureDevOpsClient.js's own `repoExists`. */
  async function repoExists() {
    try {
      await getRepo()
      return true
    } catch (err) {
      if (err instanceof GitHubRepoNotFoundError) return false
      throw err
    }
  }

  return {
    owner,
    repository,
    baseUrl,
    getRepo,
    repoExists,
  }
}

export { DEFAULT_BASE_URL }
