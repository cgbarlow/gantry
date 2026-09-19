import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from './providerErrors.js'

// gitlab.com's own API host already includes the versioned `/api/v4` prefix — a self-hosted CE/EE
// instance's own REST API lives at the same `<host>/api/v4` path (GitLab's own documented
// convention, ADR-0041's "self-hosted GitLab is supported from day one"), so a caller overriding
// `baseUrl` supplies that full path, exactly like `lib/githubClient.js`'s own GitHub Enterprise
// Server convention.
const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4'

const PROVIDER = 'gitlab'

/**
 * Thrown when GitLab rejects the supplied PAT (401, or 403 for a scope/permission problem this
 * client doesn't otherwise distinguish). Mirrors `lib/githubClient.js`'s `GitHubAuthenticationError`
 * — extends the provider-neutral `AuthenticationError` (`docs/adr/0039`) so a call site can catch
 * either the vendor-named class or the neutral one.
 */
export class GitLabAuthenticationError extends AuthenticationError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitLabAuthenticationError'
  }
}

/** Thrown when the project itself doesn't exist (or the PAT can't see it) — distinct from a missing path within an existing project (`GitLabNotFoundError`) and from a rejected PAT (`GitLabAuthenticationError`). Raised by `getRepo()`; `repoExists()` reduces it to a boolean instead of throwing, mirroring `lib/githubClient.js`'s own `getRepo`/`repoExists` split. */
export class GitLabRepoNotFoundError extends RepoNotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'GitLabRepoNotFoundError'
  }
}

/** Thrown when a requested item (file, folder path, or branch) doesn't exist in the project at the given ref — distinct from the project itself not existing (`GitLabRepoNotFoundError`). */
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

function normalizeRepoRelativePath(path) {
  return path.replace(/^\/+/, '')
}

/**
 * The message every "this GitLab project doesn't exist" error surfaces (`getRepo` below) — one
 * wording shared across every call site that constructs it, mirroring
 * `lib/githubClient.js`'s own `repoNotFoundMessage`.
 *
 * Deliberately does not say only "does not exist": GitLab, like GitHub, returns this same 404 both
 * for a project that is genuinely missing and for a PAT whose scopes (`api` or `read_repository`)
 * don't reach an otherwise-real one — the two are indistinguishable from the HTTP response alone.
 */
function repoNotFoundMessage(namespace, repository) {
  return (
    `GitLab project ${namespace}/${repository} was not found, or this Personal Access Token cannot see it. ` +
    'GitLab returns the same "not found" response both when a project genuinely does not exist and when a PAT ' +
    "is missing a required scope (api or read_repository) — check the PAT's scopes before assuming the " +
    'namespace or repository name is wrong. Create the project on GitLab first if it truly does not exist yet.'
  )
}

export { PROVIDER, repoNotFoundMessage }

/**
 * A GitLab REST (v4) client, authenticated with a caller-supplied Personal Access Token
 * (`PRIVATE-TOKEN: <pat>`, GitLab's own documented convention for a PAT/Project/Group Access Token
 * alike — distinct from the browser-to-gantry Basic-auth header docs/adr/0038 leaves unchanged).
 * Covers the content-store capability (`docs/adr/0039`) gantry needs against a GitLab project: proving
 * a PAT reaches a real project (`getRepo`/`repoExists`), reading an existing file/folder over the
 * Repository Files and Repository Tree APIs (`getFileContent`/`getFileBytes`/`fileExists`/
 * `listFolder`), and writing one or several files as a single commit
 * (`writeFile`/`writeFiles`/`deleteFile`), per #26's acceptance criteria.
 *
 * A GitLab project is addressed by its full `namespace/repository` path, URL-encoded as one opaque
 * `namespace%2Frepository` path segment (`namespace` is the project's own full group/subgroup path,
 * however many segments deep — ADR-0041) — GitLab's own documented convention for the `:id` parameter
 * on every `/projects/:id/...` endpoint this client calls, mirrored here rather than resolving
 * `namespace/repository` to a numeric project id first (an extra round trip this encoding avoids
 * entirely).
 *
 * `writeFiles` goes through GitLab's Commits API (`POST .../repository/commits` with an `actions`
 * array) rather than the single-file Repository Files API (`POST`/`PUT .../repository/files/:path`)
 * — that endpoint accepts one file per call, so saving several modules through it would take several
 * commits, breaking "one Save is one commit" (CONTEXT.md's **Save** entry, mirrored from Azure DevOps
 * and GitHub's own one-push-per-Save contract, `lib/githubClient.js`'s own `writeFiles` doc comment).
 * Every write in this client, including a lone `writeFile`, is built on `writeFiles` for exactly this
 * reason — so there is only one code path that can ever diverge from that contract. Unlike
 * `lib/githubClient.js`'s own Git-Data-API-based `writeFiles` (blob → tree → commit → ref, four
 * requests), GitLab's Commits API commits several file actions in a single request — no separate
 * blob/tree bookkeeping, and no branch-tip lookup either: GitLab accepts a commit onto a branch name
 * that doesn't exist yet as that project's very first commit (an empty project has no other ref to
 * disambiguate from), which is the only "branch doesn't exist yet" case any caller here ever hits —
 * every other new branch is created explicitly first, via `createBranch` below.
 *
 * Stage branches (creating/stacking a `gantry-workspace/<slug>/<stageId>` ref) are a later ticket's
 * job (#29, mirroring GitHub's own #12); every write here defaults to `main`, same as
 * `lib/githubClient.js` before its own per-stage branch support existed.
 *
 * `baseUrl` defaults to the public gitlab.com API but is overridable — for self-hosted GitLab CE/EE
 * (ADR-0041) or, in tests, a fake in-process server (`tests/helpers/fakeGitLabServer.js`) instead of
 * `gitlab.com`.
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

  // Low-level request for anything *within* a real project (Repository Files, Tree and Branches
  // endpoints) — a 404 here always means "this item doesn't exist", never "this project doesn't
  // exist" (see getRepo's own dedicated request below, which throws the repo-level error instead).
  // GET by default; `method`/`body` let the write methods below reuse the exact same
  // status-code-to-error mapping as every read.
  async function request(url, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new GitLabRequestError(`Network error calling GitLab API (${method} ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitLabAuthenticationError(`GitLab rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitLabNotFoundError(`GitLab found no item for ${method} ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new GitLabRequestError(`GitLab API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  function fileUrl(path, ref) {
    const encodedPath = encodeURIComponent(normalizeRepoRelativePath(path))
    const url = new URL(`${projectUrl}/repository/files/${encodedPath}`)
    if (ref) url.searchParams.set('ref', ref)
    return url.toString()
  }

  /**
   * Fetches an existing file's raw text content by repo-relative path. Throws GitLabNotFoundError if
   * no file exists at that path (on the given branch, default "main") — including when `path` names a
   * directory instead of a file, since GitLab's Repository Files API only ever addresses a single
   * file and 404s for anything else, the same "there is no file here" case
   * `lib/githubClient.js`'s own `getFileContent` handles explicitly for its own (array-returning)
   * Contents API.
   */
  async function getFileContent(path, { branch = 'main' } = {}) {
    const res = await request(fileUrl(path, branch))
    const data = await res.json()
    return Buffer.from(data.content, data.encoding ?? 'base64').toString('utf8')
  }

  /**
   * Fetches an existing file's real bytes, undecoded — GitLab's Repository Files API always returns
   * `content` as base64 of the file's real bytes regardless of whether the file is text or binary, so
   * this is the one honest decode step, mirroring `lib/githubClient.js`'s own `getFileBytes` and its
   * "don't corrupt binary content with a UTF-8 round trip" reasoning.
   */
  async function getFileBytes(path, { branch = 'main' } = {}) {
    const res = await request(fileUrl(path, branch))
    const data = await res.json()
    return Buffer.from(data.content, data.encoding ?? 'base64')
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
   * by path — over GitLab's Repository Tree API. `[]` (not an error) if the folder itself doesn't
   * exist, mirroring `lib/githubClient.js`'s own `listFolder`'s identical "absence is not exceptional"
   * contract; GitLab's own tree endpoint already returns an empty array rather than a 404 for a path
   * with no children, but a 404 (e.g. `branch` itself not existing) is folded into the same empty
   * result rather than thrown, for the same reason.
   */
  async function listFolder(path, { branch = 'main' } = {}) {
    const normalized = normalizeRepoRelativePath(path).replace(/\/+$/, '')
    const url = new URL(`${projectUrl}/repository/tree`)
    if (normalized) url.searchParams.set('path', normalized)
    url.searchParams.set('ref', branch)
    url.searchParams.set('per_page', '100')
    try {
      const res = await request(url.toString())
      const data = await res.json()
      return data
        .map((entry) => ({ path: entry.path, isFolder: entry.type === 'tree' }))
        .sort((a, b) => a.path.localeCompare(b.path))
    } catch (err) {
      if (err instanceof GitLabNotFoundError) return []
      throw err
    }
  }

  /**
   * Fetches the project's own metadata — the "does this project exist and does this PAT reach it"
   * check a later ticket's `checkGitLabRepo` will need (mirroring #8's `checkGitHubRepo`). A dedicated
   * request rather than going through `request()` above, because a 404 *here* means the project
   * itself doesn't exist — `GitLabRepoNotFoundError` — never the generic item-level
   * `GitLabNotFoundError` every other 404 in this client throws.
   */
  async function getRepo() {
    let res
    try {
      res = await fetch(projectUrl, { headers: authHeaders() })
    } catch (err) {
      throw new GitLabRequestError(`Network error calling GitLab API (GET ${projectUrl}): ${err.message}`, { cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitLabAuthenticationError(`GitLab rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitLabRepoNotFoundError(repoNotFoundMessage(namespace, repository), { status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GitLabRequestError(`GitLab API request failed: GET ${projectUrl} -> HTTP ${res.status}`, { status: res.status, body })
    }
    return res.json()
  }

  /** Whether the project exists and is reachable with this PAT — `getRepo` reduced to a boolean, mirroring `lib/githubClient.js`'s own `repoExists`. */
  async function repoExists() {
    try {
      await getRepo()
      return true
    } catch (err) {
      if (err instanceof GitLabRepoNotFoundError) return false
      throw err
    }
  }

  /**
   * The commit sha `branch` currently points at, or `null` if the branch has no ref at all — this
   * client's equivalent of `lib/githubClient.js`'s own `getBranchObjectId`, read directly off
   * GitLab's Repository Branches API (which already embeds the branch's tip commit, so — unlike
   * GitHub's two-step ref-then-commit lookup — this is a single request).
   */
  async function getBranchObjectId(branch) {
    try {
      const res = await request(`${projectUrl}/repository/branches/${encodeURIComponent(branch)}`)
      const data = await res.json()
      return data.commit.id
    } catch (err) {
      if (err instanceof GitLabNotFoundError) return null
      throw err
    }
  }

  /**
   * Whether `branch` currently has a ref at all — true once any commit has ever landed on it and it
   * hasn't since been deleted. Mirrors `lib/githubClient.js`'s own `branchExists`, needed by the
   * per-stage branch lifecycle (a later ticket, #29) the same way GitHub's own #12 needed it.
   */
  async function branchExists(branch) {
    return (await getBranchObjectId(branch)) !== null
  }

  /**
   * Creates a new branch named `name`, pointing at the current tip of `from` (default `"main"`) —
   * GitLab's own Repository Branches "create" endpoint. Mirrors `lib/githubClient.js`'s own
   * `createBranch`, including its two failure modes: `from` not existing (GitLab 404s, mapped to
   * `GitLabNotFoundError` by the generic `request()` mapping above) and `name` already existing
   * (GitLab 400s "Branch already exists", mapped to the generic `GitLabRequestError`).
   */
  async function createBranch(name, { from = 'main' } = {}) {
    const url = new URL(`${projectUrl}/repository/branches`)
    url.searchParams.set('branch', name)
    url.searchParams.set('ref', from)
    const res = await request(url.toString(), { method: 'POST' })
    const data = await res.json()
    return { name, from, objectId: data.commit?.id }
  }

  /**
   * Writes several files as one commit in one push — GitLab's Commits API (`POST
   * .../repository/commits` with an `actions` array), the only way to land more than one file in a
   * single commit over the REST API without GitHub's lower-level blob/tree bookkeeping (see this
   * function's doc comment on `createGitLabClient` for the full comparison). `deletePaths` removes
   * the given repo-relative paths in that same commit (a `delete` action) — mirrors
   * `lib/githubClient.js`'s `writeFiles`'s own `deletePaths`, including its "a path that doesn't
   * currently exist is silently skipped" tolerance.
   *
   * An empty `actions` array (every file already matches what's being "written", and every
   * `deletePaths` entry was already absent) is never sent to GitLab at all — GitLab's Commits API
   * itself rejects a no-op commit with a 400, unlike GitHub's Git Data API, which tolerates
   * constructing a tree identical to its parent; short-circuiting here avoids depending on that
   * platform difference at every call site.
   *
   * `contentType: 'base64encoded'` (mirroring `lib/githubClient.js`'s own convention) pushes
   * already-base64-encoded binary content — GitLab's commit-action `encoding` field accepts `'base64'`
   * directly, so this client passes it straight through rather than re-encoding.
   */
  async function writeFiles(files, { branch = 'main', message, deletePaths = [] } = {}) {
    const normalized = files.map((file) => ({ ...file, path: normalizeRepoRelativePath(file.path) }))
    const normalizedDeletes = deletePaths.map((path) => normalizeRepoRelativePath(path))

    const [existingFlags, deleteFlags] = await Promise.all([
      Promise.all(normalized.map((file) => fileExists(file.path, branch))),
      Promise.all(normalizedDeletes.map((path) => fileExists(path, branch))),
    ])
    const changes = normalized.map((file, i) => ({ path: file.path, changeType: existingFlags[i] ? 'edit' : 'add' }))
    const deleteChanges = normalizedDeletes.filter((_, i) => deleteFlags[i]).map((path) => ({ path, changeType: 'delete' }))

    const actions = [
      ...normalized.map((file, i) => ({
        action: existingFlags[i] ? 'update' : 'create',
        file_path: file.path,
        content: file.content,
        encoding: file.contentType === 'base64encoded' ? 'base64' : 'text',
      })),
      ...deleteChanges.map((c) => ({ action: 'delete', file_path: c.path })),
    ]

    if (actions.length === 0) {
      return { changes: [...changes, ...deleteChanges], push: { commits: [] } }
    }

    const res = await request(`${projectUrl}/repository/commits`, {
      method: 'POST',
      body: {
        branch,
        commit_message: message ?? `Update ${changes.map((c) => c.path).join(', ')}`,
        actions,
      },
    })
    const commit = await res.json()

    // Render provenance: `committer`/`author` (each `{ date }`) ride along on the returned commit so
    // a caller learning this write's own commit can read a real committer date without a second
    // round-trip — the same shape `lib/githubClient.js`'s own `writeFiles` returns (naming the field
    // `commitId`, not `id`/`sha`, is deliberate: it's what makes `lib/render.js`'s
    // `commitInfoFromPush` reusable verbatim against any provider's push response).
    return {
      changes: [...changes, ...deleteChanges],
      push: {
        commits: [{ commitId: commit.id, committer: { date: commit.committed_date }, author: { date: commit.authored_date } }],
      },
    }
  }

  /**
   * Creates a new file, or updates an existing one, at `path` — a single-file convenience wrapper
   * over `writeFiles` (still one real commit), mirroring `lib/githubClient.js`'s own
   * `writeFile`/`writeFiles` split.
   */
  async function writeFile(path, content, { branch = 'main', message = `Update ${normalizeRepoRelativePath(path)}`, contentType = 'rawtext' } = {}) {
    const { changes, push } = await writeFiles([{ path, content, contentType }], { branch, message })
    return { path: changes[0].path, changeType: changes[0].changeType, push }
  }

  /**
   * Deletes an existing file at `path` — a single commit with one `deletePaths` entry and no files to
   * add, built on `writeFiles` for the same reason every other write here is — the GitLab twin of
   * `lib/githubClient.js`'s own `deleteFile`.
   */
  async function deleteFile(path, { branch = 'main', message = `Delete ${normalizeRepoRelativePath(path)}` } = {}) {
    const { changes } = await writeFiles([], { branch, message, deletePaths: [path] })
    return { path: changes[0]?.path ?? normalizeRepoRelativePath(path), changeType: 'delete' }
  }

  return {
    namespace,
    repository,
    baseUrl,
    getRepo,
    repoExists,
    getFileContent,
    getFileBytes,
    fileExists,
    listFolder,
    writeFile,
    writeFiles,
    deleteFile,
    getBranchObjectId,
    branchExists,
    createBranch,
  }
}

export { DEFAULT_BASE_URL }
