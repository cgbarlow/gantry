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

export { PROVIDER }

/**
 * A GitHub REST client, authenticated with a caller-supplied Personal Access Token
 * (`Authorization: Bearer <pat>`, GitHub's own current convention for both classic and fine-grained
 * tokens — distinct from the browser-to-gantry Basic-auth header docs/adr/0038 leaves unchanged;
 * "only the gantry-to-provider header is provider-specific" per that ADR). Covers the content-store
 * capability (`docs/adr/0039`) gantry needs against a GitHub repo: proving a PAT reaches a real
 * repository before it's registered (#8's `getRepo`/`repoExists`, used by `lib/repoCheck.js`'s
 * `checkGitHubRepo`), reading an existing file/folder over the Contents API (#19's
 * `getFileContent`/`fileExists`/`listFolder`, used by `lib/definitionGitHub.js` to read a library
 * repo's `definitions/` folder), and writing one or several files as a single commit (#11's
 * `writeFile`/`writeFiles`, used by `lib/instance.js` to create/save a GitHub-backed instance).
 *
 * `writeFiles` goes through the Git Data API (blobs → tree → commit → ref update) rather than the
 * simpler single-file Contents API `PUT /contents/:path` — that endpoint accepts one file per call, so
 * saving several modules through it would take several commits, breaking "one Save is one commit"
 * (CONTEXT.md's **Save** entry, mirrored from Azure DevOps's own one-push-per-Save contract). Every
 * write in this client, including a lone `writeFile`, is built on `writeFiles` for exactly this reason
 * — so there is only one code path that can ever diverge from that contract.
 *
 * Stage branches (creating/stacking a `gantry-workspace/<slug>/<stageId>` ref) are a later ticket's job
 * (#12); every write here defaults to `main`, same as `lib/azureDevOpsClient.js` before its own
 * `createBranch` existed.
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

  // Low-level request for anything *within* a real repo (Contents API paths, the Git Data API) — a
  // 404 here always means "this item doesn't exist", never "this repo doesn't exist" (see getRepo's
  // own dedicated request below, which throws the repo-level error instead). GET by default; `method`/
  // `body` let the write methods below reuse the exact same status-code-to-error mapping as every read.
  async function request(url, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new GitHubRequestError(`Network error calling GitHub API (${method} ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitHubAuthenticationError(`GitHub rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitHubNotFoundError(`GitHub found no item for ${method} ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new GitHubRequestError(`GitHub API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
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

  /**
   * #16 — fetches an existing file's real bytes, undecoded: the Contents API's `content` is always
   * base64 of the file's actual git-blob bytes (GitHub's own convention, regardless of whether the
   * file is text or binary), so this is the one honest decode step — `Buffer.from(data.content,
   * 'base64')` and nothing more. `getFileContent` above deliberately goes one step further
   * (`.toString('utf8')`) for the text callers (module/instance.yaml reads) that need a string back;
   * that extra step is exactly what would silently corrupt a binary asset's bytes (arbitrary raw bytes
   * are not valid UTF-8), which is why every asset-serving/render path reads through this instead.
   */
  async function getFileBytes(path, { branch = 'main' } = {}) {
    const res = await request(contentsUrl(path, branch))
    const data = await res.json()
    if (Array.isArray(data) || data.type !== 'file') {
      throw new GitHubNotFoundError(`GitHub found no file at "${path}" on "${branch}" (it is a directory, or does not exist)`)
    }
    return Buffer.from(data.content, data.encoding ?? 'base64')
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

  // The branch's current tip commit and the tree it points at — `null` when the branch has no ref yet
  // (a brand-new, still-empty GitHub repo has none), the write methods' equivalent of
  // `lib/azureDevOpsClient.js`'s `ZERO_OBJECT_ID` sentinel for "this ref doesn't exist yet".
  async function getBranchTip(branch) {
    let res
    try {
      res = await request(`${repoUrl}/git/ref/heads/${encodeURIComponent(branch)}`)
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null
      throw err
    }
    const { object } = await res.json()
    const commitRes = await request(`${repoUrl}/git/commits/${object.sha}`)
    const commit = await commitRes.json()
    return { commitSha: object.sha, treeSha: commit.tree.sha }
  }

  /**
   * The commit sha `branch` currently points at, or `null` if the branch has no ref at all — this
   * client's equivalent of `lib/azureDevOpsClient.js`'s `getBranchObjectId`/`ZERO_OBJECT_ID`
   * sentinel, just spelled as `null` rather than an all-zero id since GitHub shas are already opaque
   * strings a caller never compares to a magic constant.
   */
  async function getBranchObjectId(branch) {
    try {
      const res = await request(`${repoUrl}/git/ref/heads/${encodeURIComponent(branch)}`)
      const { object } = await res.json()
      return object.sha
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null
      throw err
    }
  }

  /**
   * Whether `branch` currently has a ref at all — true once any commit has ever landed on it (a
   * push, or `createBranch` below) and it hasn't since been deleted. Mirrors
   * `lib/azureDevOpsClient.js`'s `branchExists`, which the per-stage branch lifecycle (#12,
   * `lib/githubStageBranch.js`) needs for the same two reasons: read-only callers ask "has work
   * begun on this stage yet" without creating anything, and `resolveGitHubStageBranch` asks whether
   * an earlier stage's branch is still open (stack on it) or already merged/gone (fork fresh from
   * `main` instead).
   */
  async function branchExists(branch) {
    return (await getBranchObjectId(branch)) !== null
  }

  /**
   * Creates a new branch named `name`, pointing at the current tip of `from` (default `"main"`) —
   * GitHub's Git Data API "create a reference" endpoint, not a push: no commit of its own is made,
   * the new branch simply starts out pointing at whatever commit `from` currently points at. Mirrors
   * `lib/azureDevOpsClient.js`'s own `createBranch`, including its two failure modes: `from` not
   * existing (`GitHubNotFoundError`, since there is no commit to branch from) and `name` already
   * existing (`GitHubRequestError`, surfacing GitHub's own 422 "Reference already exists" verbatim
   * rather than retrying or silently succeeding).
   */
  async function createBranch(name, { from = 'main' } = {}) {
    const fromSha = await getBranchObjectId(from)
    if (fromSha === null) {
      throw new GitHubNotFoundError(`Cannot create branch "${name}": source branch "${from}" does not exist`)
    }
    const res = await request(`${repoUrl}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${name}`, sha: fromSha },
    })
    const data = await res.json()
    return { name, from, objectId: data.object?.sha ?? fromSha }
  }

  /**
   * Writes several files as one commit in one push — GitHub's Git Data API (blob → tree → commit →
   * ref), the only way to land more than one file in a single commit over the REST API (see this
   * function's doc comment on `createGitHubClient` for why the simpler Contents API can't do this).
   * `deletePaths` removes the given repo-relative paths in that same commit (a tree entry with `sha:
   * null` is GitHub's documented way to drop a path from a tree built on `base_tree`) — mirrors
   * `lib/azureDevOpsClient.js`'s `writeFiles`'s own `deletePaths`, including its "a path that doesn't
   * currently exist is silently skipped" tolerance.
   *
   * All-or-nothing up to the final ref update: a failure creating any blob/tree/commit leaves the
   * branch untouched. `contentType: 'base64encoded'` (mirroring the Azure DevOps client's own
   * convention) pushes already-base64-encoded binary content — GitHub's blob API accepts either
   * encoding directly, so this client passes it straight through rather than re-encoding.
   */
  async function writeFiles(files, { branch = 'main', message, deletePaths = [] } = {}) {
    const normalized = files.map((file) => ({ ...file, path: normalizeRepoRelativePath(file.path) }))
    const normalizedDeletes = deletePaths.map((path) => normalizeRepoRelativePath(path))

    const tip = await getBranchTip(branch)
    const [existingFlags, deleteFlags] = await Promise.all([
      Promise.all(normalized.map((file) => fileExists(file.path, branch))),
      Promise.all(normalizedDeletes.map((path) => fileExists(path, branch))),
    ])
    const changes = normalized.map((file, i) => ({ path: file.path, changeType: existingFlags[i] ? 'edit' : 'add' }))
    const deleteChanges = normalizedDeletes.filter((_, i) => deleteFlags[i]).map((path) => ({ path, changeType: 'delete' }))

    const blobShas = await Promise.all(
      normalized.map(async (file) => {
        const res = await request(`${repoUrl}/git/blobs`, {
          method: 'POST',
          body: { content: file.content, encoding: file.contentType === 'base64encoded' ? 'base64' : 'utf-8' },
        })
        return (await res.json()).sha
      })
    )

    const treeEntries = [
      ...normalized.map((file, i) => ({ path: file.path, mode: '100644', type: 'blob', sha: blobShas[i] })),
      ...deleteChanges.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: null })),
    ]
    const treeRes = await request(`${repoUrl}/git/trees`, {
      method: 'POST',
      body: { ...(tip ? { base_tree: tip.treeSha } : {}), tree: treeEntries },
    })
    const { sha: newTreeSha } = await treeRes.json()

    const commitRes = await request(`${repoUrl}/git/commits`, {
      method: 'POST',
      body: {
        message: message ?? `Update ${changes.map((c) => c.path).join(', ')}`,
        tree: newTreeSha,
        parents: tip ? [tip.commitSha] : [],
      },
    })
    const newCommit = await commitRes.json()

    if (tip) {
      await request(`${repoUrl}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: { sha: newCommit.sha },
      })
    } else {
      await request(`${repoUrl}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: newCommit.sha },
      })
    }

    // #16 — render provenance: `committer`/`author` (each `{ date }`, GitHub's real commit-object
    // shape) ride along on the returned commit so a caller learning this write's own commit (the
    // same "push response already carries the answer" trick `lib/render.js`'s `commitInfoFromPush`
    // uses for Azure DevOps) can read a real committer date without a second round-trip. Naming the
    // field `commitId` (not `sha`) is deliberate: it's what makes `commitInfoFromPush` reusable
    // verbatim against a GitHub push response, not just an Azure DevOps one.
    return {
      changes: [...changes, ...deleteChanges],
      push: { commits: [{ commitId: newCommit.sha, committer: newCommit.committer, author: newCommit.author }] },
    }
  }

  /**
   * Creates a new file, or updates an existing one, at `path` — a single-file convenience wrapper
   * over `writeFiles` (still one real commit), mirroring `lib/azureDevOpsClient.js`'s own
   * `writeFile`/`writeFiles` split so callers that only ever have one file to write (e.g. a single
   * module's own `PUT /api/instance/modules/:id`) don't have to build a one-element array themselves.
   */
  async function writeFile(path, content, { branch = 'main', message = `Update ${normalizeRepoRelativePath(path)}`, contentType = 'rawtext' } = {}) {
    const { changes, push } = await writeFiles([{ path, content, contentType }], { branch, message })
    return { path: changes[0].path, changeType: changes[0].changeType, push }
  }

  /**
   * Deletes an existing file at `path` — a single commit with one `deletePaths` entry and no files to
   * add, built on `writeFiles` for the same reason every other write here is (see this function's
   * sibling `writeFile`'s doc comment) — the GitHub twin of `lib/azureDevOpsClient.js`'s own
   * `deleteFile`, used by `lib/definitionGitHub.js`'s `restoreGitHubDefinition` to remove a workspace
   * definition's `.archived` marker.
   */
  async function deleteFile(path, { branch = 'main', message = `Delete ${normalizeRepoRelativePath(path)}` } = {}) {
    const { changes } = await writeFiles([], { branch, message, deletePaths: [path] })
    return { path: changes[0]?.path ?? normalizeRepoRelativePath(path), changeType: 'delete' }
  }

  return {
    owner,
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
