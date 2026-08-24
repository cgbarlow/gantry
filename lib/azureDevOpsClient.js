const DEFAULT_BASE_URL = 'https://dev.azure.com'
const DEFAULT_API_VERSION = '7.1'
const ZERO_OBJECT_ID = '0'.repeat(40)

/**
 * Thrown when Azure DevOps rejects the supplied PAT (401/403). Kept
 * distinct from AzureDevOpsRequestError so a caller (e.g. gantry's own
 * server, per #82) can fold "PAT rejected" and "no PAT supplied" into the
 * same structured "authentication required" response without string-
 * matching a generic error's message.
 */
export class AzureDevOpsAuthenticationError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'AzureDevOpsAuthenticationError'
    this.status = status
  }
}

/**
 * Thrown when the requested item (file/path) doesn't exist in the repo —
 * distinct from a rejected PAT or any other request failure, so callers
 * can e.g. treat "file not found" as "create it" rather than an error.
 */
export class AzureDevOpsNotFoundError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'AzureDevOpsNotFoundError'
    this.status = status
  }
}

/**
 * Catch-all for any other failed call to the Azure DevOps API: a non-2xx
 * response this client doesn't otherwise distinguish, or a network-level
 * failure reaching the server at all (DNS, connection refused, etc.).
 *
 * `body` is usually the raw response text (`res.text()`) for a non-2xx
 * response. For an API that instead reports failure *inline* inside an
 * HTTP 200 (e.g. the Update Refs endpoint `createBranch` calls, which
 * reports a rejected ref update as `{ success: false, ... }` rather than a
 * failing status code), `body` is that per-item result object instead —
 * callers should not assume `body` is always a string.
 */
export class AzureDevOpsRequestError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'AzureDevOpsRequestError'
    this.status = status
    this.body = body
  }
}

// Exported (not just used internally) so lib/azureDevOpsWorkItemsClient.js
// (#99, a parallel client for the Work Items REST endpoints) can build the
// same Basic-auth header without duplicating this one-liner.
function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`
}

export { DEFAULT_BASE_URL, DEFAULT_API_VERSION, basicAuthHeader }

/**
 * A general-purpose Azure DevOps REST client, authenticated with a
 * caller-supplied Personal Access Token via HTTP Basic auth (empty
 * username, PAT as password — Azure DevOps's own supported convention).
 * Covers the Git Items/Refs/Pushes endpoints instance-data read/write
 * needs (#84, under #82's spec). The Work Items REST endpoints are
 * covered by a separate, parallel client instead of functions added
 * here — see lib/azureDevOpsWorkItemsClient.js (#99, under #95's spec),
 * which reuses this module's auth helper and error-class taxonomy.
 *
 * `baseUrl` defaults to the real Azure DevOps API but is overridable, so
 * tests can point it at a fake in-process server (see
 * tests/helpers/fakeAzureDevOpsServer.js) instead of `dev.azure.com`.
 *
 * `repository` may be a repository name or its GUID — Azure DevOps's Git
 * REST API accepts either in this position.
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

  // Every path segment is encoded — organisation and project names are
  // free text in Azure DevOps (e.g. "Team & Co", "Q&A") and can contain
  // characters ("#", "?", " ") that would otherwise be misparsed as a URL
  // fragment/query delimiter rather than sent as part of the path.
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
      throw new AzureDevOpsRequestError(`Network error calling Azure DevOps API (${method} ${url}): ${err.message}`, {
        cause: err,
      })
    }

    if (res.status === 401 || res.status === 403) {
      throw new AzureDevOpsAuthenticationError(`Azure DevOps rejected the supplied PAT (HTTP ${res.status})`, {
        status: res.status,
      })
    }
    if (res.status === 404) {
      throw new AzureDevOpsNotFoundError(`Azure DevOps found no item for ${method} ${url} (HTTP 404)`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new AzureDevOpsRequestError(`Azure DevOps API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /**
   * Fetches an existing file's raw text content by repo-relative path.
   * Throws AzureDevOpsNotFoundError if no item exists at that path (on the
   * given branch, default "main").
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

  // The commit a branch currently points at — needed as a push's
  // refUpdates.oldObjectId, Azure DevOps's optimistic-concurrency check
  // that the branch hasn't moved since the caller last read it.
  async function getBranchObjectId(branch) {
    const url = new URL(`${repoUrl}/refs`)
    url.searchParams.set('filter', `heads/${branch}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const { value = [] } = await res.json()
    const ref = value.find((r) => r.name === `refs/heads/${branch}`)
    // No ref yet (brand-new/empty repo) — Azure DevOps's documented
    // convention for "this branch doesn't exist yet" in a push.
    return ref ? ref.objectId : ZERO_OBJECT_ID
  }

  async function fileExists(path, branch) {
    try {
      await getFileContent(path, { branch })
      return true
    } catch (err) {
      if (err instanceof AzureDevOpsNotFoundError) return false
      throw err
    }
  }

  /**
   * Creates a new file, or updates an existing one, at `path` — a single
   * Azure DevOps push. Which of the two happens is detected automatically
   * (an extra read of the current state) rather than requiring the caller
   * to already know if the file exists.
   *
   * `contentType` defaults to `'rawtext'` (every existing caller writes
   * markdown/YAML). Pass `'base64encoded'` with `content` already
   * base64-encoded to push binary content (e.g. a rendered `.docx`) —
   * Azure DevOps's own push API convention, mirrored here rather than
   * this client attempting any encoding/decoding of its own.
   */
  async function writeFile(
    path,
    content,
    { branch = 'main', message = `Update ${normalizePath(path)}`, contentType = 'rawtext' } = {}
  ) {
    const normalizedPath = normalizePath(path)
    const [oldObjectId, alreadyExists] = await Promise.all([
      getBranchObjectId(branch),
      fileExists(normalizedPath, branch),
    ])

    const url = new URL(`${repoUrl}/pushes`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId }],
        commits: [
          {
            comment: message,
            changes: [
              {
                changeType: alreadyExists ? 'edit' : 'add',
                item: { path: normalizedPath },
                newContent: { content, contentType },
              },
            ],
          },
        ],
      }),
    })

    const push = await res.json()
    return { path: normalizedPath, changeType: alreadyExists ? 'edit' : 'add', push }
  }

  /**
   * Creates a new branch named `name`, pointing at the current tip of
   * `from` (default `"main"`) — Azure DevOps's Git Refs "create/update/
   * delete a ref" endpoint (a single ref update whose `oldObjectId` is the
   * all-zero id, meaning "this ref doesn't exist yet"), not a push: no
   * commit of its own is made, the new branch simply starts out pointing
   * at whatever commit `from` currently points at. New capability (#119),
   * added as the primitive the per-stage branch lifecycle (#122) builds
   * on — created from `main` normally, or "stacked" on an in-progress
   * earlier stage's branch by passing that branch's name as `from`
   * instead, so it carries that branch's commits too. #122 still owns
   * actually targeting a specific stage's branch for every existing
   * read/write path (currently all hardcoded to `main`); this function
   * only creates the ref itself.
   *
   * Throws AzureDevOpsNotFoundError if `from` itself doesn't exist yet (no
   * commit to branch from). Throws AzureDevOpsRequestError if Azure DevOps
   * rejects the ref update itself — e.g. `name` already exists — since the
   * Update Refs API reports that as a per-update `success: false` result
   * inside an HTTP 200 response, not as a failing HTTP status the shared
   * `request()` error handling above would otherwise catch.
   */
  async function createBranch(name, { from = 'main' } = {}) {
    const fromObjectId = await getBranchObjectId(from)
    if (fromObjectId === ZERO_OBJECT_ID) {
      throw new AzureDevOpsNotFoundError(`Cannot create branch "${name}": source branch "${from}" does not exist`)
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
      throw new AzureDevOpsRequestError(`Azure DevOps rejected creating branch "${name}" from "${from}": ${reason}`, {
        body: update,
      })
    }
    return { name, from, objectId: update.newObjectId }
  }

  /**
   * Lists the immediate children of a repo-relative folder path (Azure
   * DevOps's Items API with `recursionLevel=OneLevel`) — `[{ path,
   * isFolder }, ...]`, sorted by path. `[]` (not an error) if the folder
   * itself doesn't exist — the same "absence is not exceptional" contract
   * `getFileContent`'s `AzureDevOpsNotFoundError` maps to for a single
   * file, since a caller enumerating a folder to see "what's in here" (see
   * lib/repoCheck.js's `gantry-workspace/` discovery, #100) wants an empty
   * list, not a thrown error, when nothing has been written there yet.
   */
  async function listFolder(path, { branch = 'main' } = {}) {
    const url = new URL(`${repoUrl}/items`)
    url.searchParams.set('scopePath', normalizePath(path))
    url.searchParams.set('recursionLevel', 'OneLevel')
    url.searchParams.set('api-version', apiVersion)
    url.searchParams.set('versionDescriptor.version', branch)
    url.searchParams.set('versionDescriptor.versionType', 'branch')

    try {
      const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
      const { value = [] } = await res.json()
      return value
    } catch (err) {
      if (err instanceof AzureDevOpsNotFoundError) return []
      throw err
    }
  }

  /**
   * Deletes an existing file at `path` — a single Azure DevOps push with a
   * `delete` change, the counterpart to `writeFile`'s `add`/`edit`. Used by
   * lib/repoCheck.js's legacy-root-to-`gantry-workspace/<slug>/` migration
   * (#100) to remove each file's old copy once its new copy has been
   * written, so a migrated repo is never left with instance data at both
   * locations at once.
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

  return {
    organization,
    project,
    repository,
    baseUrl,
    getFileContent,
    writeFile,
    listFolder,
    deleteFile,
    createBranch,
  }
}
