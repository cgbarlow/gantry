import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from './providerErrors.js'

const DEFAULT_BASE_URL = 'https://dev.azure.com'
const DEFAULT_API_VERSION = '7.1'
const ZERO_OBJECT_ID = '0'.repeat(40)

// The Azure DevOps provider tag (docs/adr/0039, #7): every provider-neutral error this client (and
// its three siblings — lib/azureDevOpsPullRequestsClient.js, lib/azureDevOpsWorkItemsClient.js,
// lib/azureDevOpsIdentityClient.js, which import this) throws carries `provider: PROVIDER`, so a
// caller that catches the neutral AuthenticationError/NotFoundError/RepoNotFoundError/RequestError
// (lib/providerErrors.js) can still report which provider failed — an untagged neutral error is
// never constructed anywhere in this client. There used to be four Azure-DevOps-named subclasses
// (AzureDevOpsAuthenticationError etc.) for exactly this purpose; #7 deleted them once every catch
// site across the codebase was migrated to the neutral classes, since a class per provider per error
// kind doesn't scale past one provider (ADR-0039's "every catch site would have to catch both and
// grow a third arm per provider added").
const PROVIDER = 'azure-devops'
export { PROVIDER }

// Exported (not just used internally) so lib/azureDevOpsWorkItemsClient.js (#99, a parallel client for the Work Items REST endpoints) can build the same Basic-auth header without duplicating this one-liner.
function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`
}

// A trailing slash is the only difference between two otherwise-identical
// paths this client needs to treat as the same location (e.g. a caller's
// `scopePath` vs. the same path as Azure DevOps echoes it back in an
// Items API entry) — never stripped down to `''`, since that would make
// the repo root ('/') indistinguishable from "no path at all".
function stripTrailingSlash(path) {
  return path === '/' ? path : path.replace(/\/+$/, '')
}

export { DEFAULT_BASE_URL, DEFAULT_API_VERSION, basicAuthHeader }

/**
 * A general-purpose Azure DevOps REST client, authenticated with a caller-supplied Personal Access Token via HTTP Basic auth (empty username, PAT as password — Azure DevOps's own supported convention). Covers the Git Items/Refs/Pushes endpoints instance-data read/write needs (#84, under #82's spec). The Work Items REST endpoints are covered by a separate, parallel client instead of functions added here — see lib/azureDevOpsWorkItemsClient.js (#99, under #95's spec), which reuses this module's auth helper and error-class taxonomy.
 *
 * `baseUrl` defaults to the real Azure DevOps API but is overridable, so tests can point it at a fake in-process server (see tests/helpers/fakeAzureDevOpsServer.js) instead of `dev.azure.com`.
 *
 * `repository` may be a repository name or its GUID — Azure DevOps's Git REST API accepts either in this position.
 */
export function createAzureDevOpsClient({
  organization,
  project,
  repository,
  pat,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_API_VERSION,
} = {}) {
  for (const [name, value] of Object.entries({ organization, project, repository, pat })) {
    if (!value) throw new Error(`createAzureDevOpsClient: "${name}" is required`)
  }

  // Every path segment is encoded — organisation and project names are free text in Azure DevOps (e.g. "Team & Co", "Q&A") and can contain characters ("#", "?", " ") that would otherwise be misparsed as a URL fragment/query delimiter rather than sent as part of the path.
  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: basicAuthHeader(pat), ...headers },
        body,
      })
    } catch (err) {
      throw new RequestError(`Network error calling Azure DevOps API (${method} ${url}): ${err.message}`, {
        provider: PROVIDER,
        cause: err,
      })
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`Azure DevOps rejected the supplied PAT (HTTP ${res.status})`, {
        provider: PROVIDER,
        status: res.status,
      })
    }
    if (res.status === 404) {
      throw new NotFoundError(`Azure DevOps found no item for ${method} ${url} (HTTP 404)`, {
        provider: PROVIDER,
        status: res.status,
      })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new RequestError(`Azure DevOps API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        provider: PROVIDER,
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /**
   * Fetches an existing file's raw text content by repo-relative path. Throws NotFoundError if no item exists at that path (on the given branch, default "main").
   */
  async function getFileContent(path, { branch = 'main' } = {}) {
    const url = new URL(`${repoUrl}/items`)
    url.searchParams.set('path', normalizePath(path))
    url.searchParams.set('api-version', apiVersion)
    url.searchParams.set('includeContent', 'true')
    url.searchParams.set('versionDescriptor.version', branch)
    url.searchParams.set('versionDescriptor.versionType', 'branch')

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const item = await res.json()
    return item.content
  }

  // The commit a branch currently points at — needed as a push's refUpdates.oldObjectId, Azure DevOps's optimistic-concurrency check that the branch hasn't moved since the caller last read it.
  async function getBranchObjectId(branch) {
    const url = new URL(`${repoUrl}/refs`)
    url.searchParams.set('filter', `heads/${branch}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const { value = [] } = await res.json()
    const ref = value.find((r) => r.name === `refs/heads/${branch}`)
    // No ref yet (brand-new/empty repo) — Azure DevOps's documented convention for "this branch doesn't exist yet" in a push.
    return ref ? ref.objectId : ZERO_OBJECT_ID
  }

  async function fileExists(path, branch) {
    try {
      await getFileContent(path, { branch })
      return true
    } catch (err) {
      if (err instanceof NotFoundError) return false
      throw err
    }
  }

  /**
   * Whether `branch` currently has a ref at all — true once any commit has ever landed on it (a push, or `createBranch` below) and it hasn't since been deleted; false if it's never existed, or existed and was deleted (e.g. Azure DevOps's own "complete pull request and delete source branch" option). The per-stage branch lifecycle (#122, ADR-0014) uses this for two distinct purposes: read-only callers (viewing an instance, checking a gate, the dashboard listing) use it to decide "has work begun on this stage yet" without ever creating anything themselves; `createBranch`'s own caller (`resolveStageBranch`, lib/stageBranch.js) uses it to decide whether an earlier stage's branch is still open (stack on it) or already merged/gone (fork fresh from `main` instead).
   */
  async function branchExists(branch) {
    return (await getBranchObjectId(branch)) !== ZERO_OBJECT_ID
  }

  /** Fetches the newest commit reachable from a branch. Azure DevOps returns commits newest-first for this query, so requesting one is enough for the dashboard's last-updated indicator without reading any PR state. */
  async function getLatestCommit({ branch = 'main' } = {}) {
    const url = new URL(`${repoUrl}/commits`)
    url.searchParams.set('searchCriteria.itemVersion.version', branch)
    url.searchParams.set('searchCriteria.itemVersion.versionType', 'branch')
    url.searchParams.set('$top', '1')
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const { value = [] } = await res.json()
    return value[0] ?? null
  }

  /**
   * Lists commits reachable from `branch`, optionally filtered to those not on
   * `compareTo` (Azure DevOps's `compareVersion` filter). Used by the
   * pre-Pull-Request commit history panel (WI198) to show a stage branch's own
   * commits versus `main` before a PR exists.
   */
  async function listBranchCommits(branch, { compareTo = 'main', top = 250 } = {}) {
    if (!branch) throw new Error('listBranchCommits: "branch" is required')

    const url = new URL(`${repoUrl}/commits`)
    url.searchParams.set('searchCriteria.itemVersion.version', branch)
    url.searchParams.set('searchCriteria.itemVersion.versionType', 'branch')
    if (compareTo) {
      url.searchParams.set('searchCriteria.compareVersion.version', compareTo)
      url.searchParams.set('searchCriteria.compareVersion.versionType', 'branch')
    }
    if (top) url.searchParams.set('$top', String(top))
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const { value = [] } = await res.json()
    return value
  }

  /**
   * Creates a new file, or updates an existing one, at `path` — a single Azure DevOps push. Which of the two happens is detected automatically (an extra read of the current state) rather than requiring the caller to already know if the file exists.
   *
   * `contentType` defaults to `'rawtext'` (every existing caller writes markdown/YAML). Pass `'base64encoded'` with `content` already base64-encoded to push binary content (e.g. a rendered `.docx`) — Azure DevOps's own push API convention, mirrored here rather than this client attempting any encoding/decoding of its own.
   */
  async function writeFile(
    path,
    content,
    { branch = 'main', message = `Update ${normalizePath(path)}`, contentType = 'rawtext' } = {}
  ) {
    const { changes, push } = await writeFiles([{ path, content, contentType }], { branch, message })
    return { path: changes[0].path, changeType: changes[0].changeType, push }
  }

  /**
   * Writes several files as one commit in one push (WI #376 — one Save is one commit). Each entry is `{ path, content, contentType? }`, with the same add/edit detection and `contentType` convention as `writeFile`. All or nothing: Azure DevOps applies a push atomically, so a rejected push leaves every file as it was.
   *
   * `deletePaths` (WI #383 — a workspace definition's save can drop a module the author removed, in
   * the same single commit as everything it did add/edit, rather than a second push) is an optional
   * array of repo-relative paths to delete as part of this same push. A path that doesn't currently
   * exist is silently skipped (mirrors `deleteFile`'s own "not there to begin with" tolerance) rather
   * than turning an already-gone file into a failed push.
   */
  async function writeFiles(files, { branch = 'main', message, deletePaths = [] } = {}) {
    const normalized = files.map((file) => ({ ...file, path: normalizePath(file.path) }))
    const normalizedDeletes = deletePaths.map((path) => normalizePath(path))
    const [oldObjectId, existingFlags, deleteFlags] = await Promise.all([
      getBranchObjectId(branch),
      Promise.all(normalized.map((file) => fileExists(file.path, branch))),
      Promise.all(normalizedDeletes.map((path) => fileExists(path, branch))),
    ])
    const changes = normalized.map((file, i) => ({ path: file.path, changeType: existingFlags[i] ? 'edit' : 'add' }))
    const deleteChanges = normalizedDeletes
      .filter((_, i) => deleteFlags[i])
      .map((path) => ({ path, changeType: 'delete' }))

    const url = new URL(`${repoUrl}/pushes`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId }],
        commits: [
          {
            comment: message ?? `Update ${changes.map((c) => c.path).join(', ')}`,
            changes: [
              ...normalized.map((file, i) => ({
                changeType: changes[i].changeType,
                item: { path: file.path },
                newContent: { content: file.content, contentType: file.contentType ?? 'rawtext' },
              })),
              ...deleteChanges.map((c) => ({ changeType: 'delete', item: { path: c.path } })),
            ],
          },
        ],
      }),
    })

    const push = await res.json()
    return { changes: [...changes, ...deleteChanges], push }
  }

  /**
   * Creates a new branch named `name`, pointing at the current tip of `from` (default `"main"`) — Azure DevOps's Git Refs "create/update/delete a ref" endpoint (a single ref update whose `oldObjectId` is the all-zero id, meaning "this ref doesn't exist yet"), not a push: no commit of its own is made, the new branch simply starts out pointing at whatever commit `from` currently points at. New capability (#119), added as the primitive the per-stage branch lifecycle (#122) builds on — created from `main` normally, or "stacked" on an in-progress earlier stage's branch by passing that branch's name as `from` instead, so it carries that branch's commits too. #122 still owns actually targeting a specific stage's branch for every existing read/write path (currently all hardcoded to `main`); this function only creates the ref itself.
   *
   * Throws NotFoundError if `from` itself doesn't exist yet (no commit to branch from). Throws RequestError if Azure DevOps rejects the ref update itself — e.g. `name` already exists — since the Update Refs API reports that as a per-update `success: false` result inside an HTTP 200 response, not as a failing HTTP status the shared `request()` error handling above would otherwise catch.
   */
  async function createBranch(name, { from = 'main' } = {}) {
    const fromObjectId = await getBranchObjectId(from)
    if (fromObjectId === ZERO_OBJECT_ID) {
      throw new NotFoundError(`Cannot create branch "${name}": source branch "${from}" does not exist`, { provider: PROVIDER })
    }

    const url = new URL(`${repoUrl}/refs`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify([{ name: `refs/heads/${name}`, oldObjectId: ZERO_OBJECT_ID, newObjectId: fromObjectId }]),
    })
    const { value = [] } = await res.json()
    const [update] = value
    if (!update?.success) {
      const reason = update?.customMessage ?? update?.updateStatus ?? 'unknown reason'
      throw new RequestError(`Azure DevOps rejected creating branch "${name}" from "${from}": ${reason}`, {
        provider: PROVIDER,
        body: update,
      })
    }
    return { name, from, objectId: update.newObjectId }
  }

  /**
   * Lists the immediate children of a repo-relative folder path (Azure DevOps's Items API with `recursionLevel=OneLevel`) — `[{ path, isFolder }, ...]`, sorted by path. `[]` (not an error) if the folder itself doesn't exist — the same "absence is not exceptional" contract `getFileContent`'s `NotFoundError` maps to for a single file, since a caller enumerating a folder to see "what's in here" (see lib/repoCheck.js's `gantry-workspace/` discovery, #100) wants an empty list, not a thrown error, when nothing has been written there yet.
   *
   * The real Azure DevOps Items API includes the queried folder itself as one of the entries in `value` (its own `scopePath`, `isFolder: true`) alongside its immediate children — filtered out here so a caller enumerating "what's inside this folder" never mistakes the folder for one of its own children (#116: this previously made every single-instance `gantry-workspace/<slug>/` workspace look like it held more than one instance, since `gantry-workspace` itself came back as an extra folder entry alongside the one real `<slug>` subfolder).
   */
  async function listFolder(path, { branch = 'main' } = {}) {
    const normalizedPath = normalizePath(path)
    const url = new URL(`${repoUrl}/items`)
    url.searchParams.set('scopePath', normalizedPath)
    url.searchParams.set('recursionLevel', 'OneLevel')
    url.searchParams.set('api-version', apiVersion)
    url.searchParams.set('versionDescriptor.version', branch)
    url.searchParams.set('versionDescriptor.versionType', 'branch')

    try {
      const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
      const { value = [] } = await res.json()
      return value.filter((item) => stripTrailingSlash(item.path) !== stripTrailingSlash(normalizedPath))
    } catch (err) {
      if (err instanceof NotFoundError) return []
      throw err
    }
  }

  /**
   * Whether the repository itself exists in Azure DevOps — a cheap GET against the Git Repositories API, used by lib/repoCheck.js to distinguish "repository doesn't exist" from "empty repository" before listing any folders. Without this, both cases look identical (listFolder returns `[]` for a missing repo), so workspace registration would succeed for a nonexistent repo and only fail later with an opaque REST error when instance creation tries to write.
   */
  async function repoExists() {
    const url = `${repoUrl}?api-version=${apiVersion}`
    try {
      await request(url, { headers: { Accept: 'application/json' } })
      return true
    } catch (err) {
      if (err instanceof NotFoundError) return false
      throw err
    }
  }

  /**
   * Deletes an existing file at `path` — a single Azure DevOps push with a `delete` change, the counterpart to `writeFile`'s `add`/`edit`. Used by lib/repoCheck.js's legacy-root-to-`gantry-workspace/<slug>/` migration (#100) to remove each file's old copy once its new copy has been written, so a migrated repo is never left with instance data at both locations at once.
   */
  async function deleteFile(path, { branch = 'main', message = `Delete ${normalizePath(path)}` } = {}) {
    const normalizedPath = normalizePath(path)
    const oldObjectId = await getBranchObjectId(branch)

    const url = new URL(`${repoUrl}/pushes`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId }],
        commits: [{ comment: message, changes: [{ changeType: 'delete', item: { path: normalizedPath } }] }],
      }),
    })
    const push = await res.json()
    return { path: normalizedPath, push }
  }

  /**
   * Lists items under `scopePath` with the given recursion level — the cheap
   * tree-comparison primitive WI256's stageSync detection builds on. Cheap
   * because it never fetches file *content*, only the tree metadata Azure
   * DevOps already stores per path (gitObjectId). `listFolder` above is the
   * OneLevel special-case; this is the Full-recursion generalisation.
   */
  async function listItems(scopePath, { branch = 'main', recursionLevel = 'OneLevel', includeContentMetadata = false } = {}) {
    const normalizedPath = normalizePath(scopePath)
    const url = new URL(`${repoUrl}/items`)
    url.searchParams.set('scopePath', normalizedPath)
    url.searchParams.set('recursionLevel', recursionLevel)
    url.searchParams.set('api-version', apiVersion)
    url.searchParams.set('versionDescriptor.version', branch)
    url.searchParams.set('versionDescriptor.versionType', 'branch')
    if (includeContentMetadata) url.searchParams.set('includeContentMetadata', 'true')

    try {
      const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
      const { value = [] } = await res.json()
      // The real API includes the queried folder itself as the first entry
      // when recursionLevel is OneLevel — filtered there too, but for Full it
      // also appears; filter it out so callers enumerating "what's inside"
      // never mistake the folder for its own child.
      return value.filter((item) => stripTrailingSlash(item.path) !== stripTrailingSlash(normalizedPath))
    } catch (err) {
      if (err instanceof NotFoundError) return []
      throw err
    }
  }

  return {
    organization,
    project,
    repository,
    baseUrl,
    getFileContent,
    fileExists,
    writeFile,
    writeFiles,
    listFolder,
    listItems,
    getBranchObjectId,
    deleteFile,
    createBranch,
    branchExists,
    getLatestCommit,
    listBranchCommits,
    repoExists,
  }
}
