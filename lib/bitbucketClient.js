import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from './providerErrors.js'

// Bitbucket Cloud's own API host — always this exact host (ADR-0042: Atlassian v1 is Cloud-only, so
// there is no self-hosted override to gate behind ADR-0039's SSRF-allow-flag the way Azure
// DevOps/GitHub/GitLab's own `baseUrl` is; `baseUrl` below exists purely so tests can point this
// client at `tests/helpers/fakeBitbucketServer.js` instead).
const DEFAULT_BASE_URL = 'https://api.bitbucket.org/2.0'

// The *registered Provider* this client's errors are tagged with is `'atlassian'` (ADR-0037's
// Provider concept, `lib/provider.js`'s `PROVIDERS`, `lib/providerRegistry.js`'s registry key) — never
// `'bitbucket'`. Atlassian is the first split-suite provider (ADR-0042): this file covers only its
// Bitbucket (content-store) half, and `lib/jiraWorkItemsClient.js` (a later ticket) covers its Jira
// half, but both halves belong to the same one Provider a workspace names. The error *class* names
// below are prefixed `Bitbucket`, not `Atlassian`, purely to say which product's client threw —
// mirroring this file's own name (`lib/bitbucketClient.js`, not `lib/atlassianBitbucketClient.js`) —
// while the `provider` field every instance carries (via the `PROVIDER` constant passed to `super()`)
// stays `'atlassian'`, matching `getProviderCapabilities('atlassian')` and every contract-test
// assertion of `err.provider`.
const PROVIDER = 'atlassian'

/** Thrown when Bitbucket rejects the supplied token (401), or a valid token lacks write/admin access for the call being made (403 — Bitbucket's own "authenticated but not authorized" case, folded into the same neutral AuthenticationError per ADR-0039's existing GitHub/GitLab precedent for a scope/permission problem this client doesn't otherwise distinguish). */
export class BitbucketAuthenticationError extends AuthenticationError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'BitbucketAuthenticationError'
  }
}

/**
 * Thrown when the repository itself doesn't exist — distinct from a missing path within an existing
 * repository (`BitbucketNotFoundError`) and from a rejected/insufficiently-scoped token
 * (`BitbucketAuthenticationError`). Raised by `getRepo()`; `repoExists()` reduces it to a boolean.
 *
 * Unlike GitHub/GitLab (whose own "not found" 404 is genuinely ambiguous between "doesn't exist" and
 * "PAT can't see it" — see `lib/gitlabClient.js`'s own `repoNotFoundMessage`), Bitbucket Cloud's own
 * `GET /repositories/{workspace}/{repo_slug}` documents the two cases as *distinct* responses: 404
 * when no repository exists at that location at all, 403 when it exists but the calling token can't
 * see it (a private repo the token lacks access to). This client preserves that distinction rather
 * than manufacturing GitLab's own ambiguity: a 403 here throws `BitbucketAuthenticationError` (a
 * credential/access problem), a 404 throws this class (nothing to fix but the workspace/repository
 * slug, or create the repo).
 */
export class BitbucketRepoNotFoundError extends RepoNotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'BitbucketRepoNotFoundError'
  }
}

/** Thrown when a requested item (file, folder path, or branch) doesn't exist in the repository at the given ref — distinct from the repository itself not existing (`BitbucketRepoNotFoundError`). */
export class BitbucketNotFoundError extends NotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'BitbucketNotFoundError'
  }
}

/** Catch-all for any other failed call to the Bitbucket API: a non-2xx response this client doesn't otherwise distinguish, or a network-level failure reaching Bitbucket at all. */
export class BitbucketRequestError extends RequestError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { status, body, provider: PROVIDER, cause })
    this.name = 'BitbucketRequestError'
  }
}

function normalizeRepoRelativePath(path) {
  return path.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * The message every "this Bitbucket repository doesn't exist" error surfaces (`getRepo` below).
 * Deliberately does not echo GitLab/GitHub's "same 404 either way" framing (see
 * `BitbucketRepoNotFoundError`'s own doc comment) — Bitbucket's 404 here means the repository
 * genuinely isn't there.
 */
function repoNotFoundMessage(owner, repository) {
  return (
    `Bitbucket repository ${owner}/${repository} was not found. Unlike GitHub or GitLab, Bitbucket Cloud's ` +
    "own API distinguishes a missing repository (this message) from one that exists but this token can't see " +
    '(surfaced as an authentication failure instead, not this one) — check that the workspace and repository ' +
    'slugs are correct, and that the repository has not been renamed or deleted, before assuming a token/scope ' +
    'problem instead.'
  )
}

function fileOrFolderNotFoundMessage(path, branch) {
  return (
    `Bitbucket found nothing at "${normalizeRepoRelativePath(path)}" on branch "${branch}" of this repository — ` +
    'the path may not exist, may name a directory rather than a file (or vice versa), or the branch itself may ' +
    'not exist.'
  )
}

export { PROVIDER, repoNotFoundMessage }

/**
 * A Bitbucket Cloud REST (2.0) client, authenticated with a caller-supplied API token (ADR-0042: the
 * `bitbucket` half of an Atlassian workspace's `{bitbucket, jira}` credential pair,
 * `web/lib/credential.js`'s own two-token shape from #40) — never the workspace's Jira token. Covers
 * the content-store capability (`docs/adr/0039`) gantry needs against a Bitbucket Cloud repository:
 * proving a token reaches a real repository (`getRepo`/`repoExists`), reading an existing file/folder
 * (`getFileContent`/`getFileBytes`/`fileExists`/`listFolder`), writing one or several files as a
 * single commit (`writeFile`/`writeFiles`/`deleteFile`), and the per-stage branch lifecycle's own
 * primitives (`getBranchObjectId`/`branchExists`/`createBranch`) a later ticket (#43, mirroring
 * GitHub's #12 and GitLab's #29) builds stage branches on top of.
 *
 * A Bitbucket Cloud repository is addressed by `{owner}/{repository}` (ADR-0042: these reuse GitHub's
 * own location keys — Bitbucket's `workspace-slug/repo-slug` addresses identically to GitHub's
 * `owner/repository`, so `owner` here holds Bitbucket's own "workspace" — the account-level container
 * ADR-0042 deliberately calls a **Bitbucket account** everywhere outside this addressing detail, never
 * "Bitbucket workspace", to resolve the term collision with gantry's own Workspace concept). Unlike
 * GitLab's own namespace (ADR-0041), a Bitbucket workspace slug is always a single path segment — no
 * subgroup-style nesting to encode.
 *
 * ## Authentication: Bearer, not Basic — deliberately, not by copying GitHub/GitLab unchanged
 *
 * This client sends `Authorization: Bearer <token>` on every call. Bitbucket Cloud's current API
 * tokens (the documented replacement for now fully-retired app passwords) support two schemes: HTTP
 * Basic with the Atlassian account *email* as the username and the token as the password, or Bearer
 * with the token alone — Atlassian's own docs note Bearer "removes the need to provide the Atlassian
 * email tied to the API token"
 * (https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/). Gantry's own credential
 * model (`web/lib/credential.js`) stores one opaque token string per product slot, with no email
 * field anywhere in `lib/provider.js`'s Atlassian location schema — so Basic auth's email requirement
 * simply has nowhere to be supplied from. Bearer is therefore not just "GitHub's own convention
 * carried over unchanged" (this ticket's own instruction not to assume that) but the scheme this
 * client's actual credential shape requires; the coincidence that GitHub also uses Bearer is exactly
 * that, a coincidence, confirmed independently against Bitbucket's current docs rather than assumed.
 *
 * ## Branch names containing "/" — a genuine Bitbucket API limitation, not a GitLab-style non-issue
 *
 * gantry's own stage branches are named `gantry-workspace/<slug>/<stageId>` — they contain literal
 * "/". GitLab's own `namespace%2Frepository`-style encoding (ADR-0041) has no equivalent fix here:
 * Bitbucket's content-reading routes address a ref directly as a raw path *segment*,
 * `/repositories/{workspace}/{repo_slug}/src/{commit}/{path}`, and unlike GitLab's opaque `:id`,
 * Bitbucket has no documented "encode the internal slash" convention for this segment — attempting to
 * `%2F`-encode a slash inside a branch name here does not work: Bitbucket still splits on it, trying
 * (and failing) to resolve everything before the first "real" slash as the ref
 * (https://community.atlassian.com/forums/Bitbucket-questions/Bitbucket-REST-API-reference-branches-with-forward-slash-in-name/qaq-p/1899723,
 * a still-open, still-current limitation of Bitbucket Cloud's own API). The one reliable workaround —
 * also the one Bitbucket's own community confirms — is to never put a branch *name* in one of these
 * URLs at all: resolve it to its current tip **commit hash** first (a hash never contains "/"), then
 * address content by that hash instead. `getBranchObjectId`/`getBranchTip` below do this resolution
 * via the *filtered branches list* (`GET .../refs/branches?q=name="<branch>"`), not the by-name
 * lookup route (`GET .../refs/branches/{name}`) — the filtered-list route takes the branch name as a
 * *query value*, not a path segment, so it has no equivalent ambiguity. Every read
 * (`getFileContent`/`getFileBytes`/`fileExists`/`listFolder`) resolves its `branch` argument to a hash
 * this same way before touching a `/src/...` URL, so a caller can pass any of gantry's own
 * slash-containing stage-branch names to any of this client's methods without hitting this limitation.
 * `createBranch`'s own `from` argument is resolved the identical way, for the same reason (a stage
 * re-open, #43, stacks a new branch from an existing one, which may itself carry a stage branch name).
 *
 * ## Writing files: the Source API's multipart/form-data commit, not GitLab's JSON Commits API
 *
 * `writeFiles` posts to `POST /repositories/{workspace}/{repo_slug}/src` — Bitbucket's own
 * "create a commit by uploading files" endpoint, `multipart/form-data` per its own documented
 * convention (https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/). Every
 * added/updated file becomes one form field, named by its full repo-relative path (a leading "/" is
 * prepended defensively so a path that happens to collide with a reserved meta field name — `message`,
 * `author`, `branch`, `parents`, `files` — is still read as a file, not as that meta field, per the
 * endpoint's own documented disambiguation rule) with real file content as its value — this client
 * always supplies real bytes here (a `Blob`), never text-only `application/x-www-form-urlencoded`, so
 * binary content round-trips without any base64/UTF-8 detour. Deletions go through the same request's
 * repeated `files` meta field (one entry per path to delete) rather than a separate call — Bitbucket's
 * own documented way to delete: "when the `files` field contains a file path that does not have a
 * corresponding, identically-named form field, Bitbucket interprets that as the client wanting to
 * replace the named file with the null set and the file is deleted instead." One POST, one commit,
 * covering every add/edit/delete in a single `writeFiles` call — the same "one Save is one commit"
 * contract `lib/gitlabClient.js`'s own `writeFiles` doc comment already states (CONTEXT.md's
 * **Save** entry). A successful commit's own response body is undocumented/empty (Bitbucket's own
 * OpenAPI spec lists no response schema for its 201) — this client re-reads the branch's new tip via
 * `getBranchTip` immediately after, rather than trying to parse a commit id out of a body that may not
 * reliably carry one, to build the `push.commits[0]` render-provenance shape
 * `lib/render.js`'s `commitInfoFromPush` already expects from every other provider.
 *
 * Every write in this client, including a lone `writeFile`, is built on `writeFiles` for the same
 * reason `lib/gitlabClient.js`'s own doc comment gives: one code path that can ever diverge from the
 * one-commit-per-Save contract.
 *
 * Stage branches themselves (creating/stacking a `gantry-workspace/<slug>/<stageId>` ref) are a later
 * ticket's job (#43, mirroring GitHub's #12 and GitLab's #29); every write here defaults to `main`.
 *
 * `baseUrl` defaults to Bitbucket Cloud's own fixed API host but is overridable in tests, to point at
 * `tests/helpers/fakeBitbucketServer.js` instead of `api.bitbucket.org` — there is no self-hosted
 * Bitbucket override in production use (ADR-0042: Cloud-only).
 */
export function createBitbucketClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createBitbucketClient: "${name}" is required`)
  }

  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  function authHeaders() {
    return { Authorization: `Bearer ${pat}` }
  }

  // Low-level request for anything within a real repository — a 404 here always means "this item
  // (file/folder/branch) doesn't exist", never "this repository doesn't exist" (see `getRepo`'s own
  // dedicated request below, which throws the repo-level error instead). GET by default; `method`/
  // `body`/`isForm` let the write path (`writeFiles`, `createBranch`) reuse the exact same
  // status-code-to-error mapping as every read. `isForm` sends `body` (a `FormData`) as-is, letting
  // `fetch` set its own `multipart/form-data; boundary=...` header, rather than JSON-stringifying it.
  async function request(url, { method = 'GET', body, isForm = false } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...authHeaders(),
          ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      })
    } catch (err) {
      throw new BitbucketRequestError(`Network error calling Bitbucket API (${method} ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new BitbucketAuthenticationError(`Bitbucket rejected the supplied token (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new BitbucketNotFoundError(`Bitbucket found no item for ${method} ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new BitbucketRequestError(`Bitbucket API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /**
   * Fetches the repository's own metadata — the "does this repository exist and does this token reach
   * it" check `checkAtlassianRepo` (a later ticket) will need, mirroring #8's `checkGitHubRepo`. A
   * dedicated request rather than going through `request()` above, because a 404 *here* means the
   * repository itself doesn't exist — `BitbucketRepoNotFoundError` — never the generic item-level
   * `BitbucketNotFoundError` every other 404 in this client throws; a 403 here means the repository
   * exists but this token can't see it, which this client folds into `BitbucketAuthenticationError`
   * (see that class's own doc comment for why this differs from GitHub/GitLab's own ambiguous 404).
   */
  async function getRepo() {
    let res
    try {
      res = await fetch(repoUrl, { headers: authHeaders() })
    } catch (err) {
      throw new BitbucketRequestError(`Network error calling Bitbucket API (GET ${repoUrl}): ${err.message}`, { cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new BitbucketAuthenticationError(`Bitbucket rejected the supplied token (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new BitbucketRepoNotFoundError(repoNotFoundMessage(owner, repository), { status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new BitbucketRequestError(`Bitbucket API request failed: GET ${repoUrl} -> HTTP ${res.status}`, { status: res.status, body })
    }
    return res.json()
  }

  /** Whether the repository exists and is reachable with this token — `getRepo` reduced to a boolean. */
  async function repoExists() {
    try {
      await getRepo()
      return true
    } catch (err) {
      if (err instanceof BitbucketRepoNotFoundError) return false
      throw err
    }
  }

  /**
   * `branch`'s current tip — `{ hash, date }`, or `null` if `branch` has no ref at all. Resolved via
   * Bitbucket's own filtered branches list (`GET .../refs/branches?q=name="<branch>"`), never the
   * by-name route (`GET .../refs/branches/{name}`) — see this factory's own doc comment ("Branch names
   * containing '/'") for why the by-name route can't safely address every branch name gantry uses.
   * `date` is Bitbucket's own single commit-date field (its branch/commit objects don't expose a
   * separate author-vs-committer date the way `lib/gitlabClient.js`'s own two-field `writeFiles`
   * return does); `writeFiles` below reuses this same value for both.
   */
  async function getBranchTip(branch) {
    const url = new URL(`${repoUrl}/refs/branches`)
    url.searchParams.set('q', `name="${branch}"`)
    const res = await request(url.toString())
    const data = await res.json()
    const match = (data.values ?? []).find((b) => b.name === branch)
    if (!match) return null
    return { hash: match.target?.hash ?? null, date: match.target?.date ?? null }
  }

  /** The commit hash `branch` currently points at, or `null` if the branch has no ref at all — this client's equivalent of `lib/gitlabClient.js`'s own `getBranchObjectId`. */
  async function getBranchObjectId(branch) {
    const tip = await getBranchTip(branch)
    return tip?.hash ?? null
  }

  /** Whether `branch` currently has a ref at all. Mirrors `lib/gitlabClient.js`'s own `branchExists`, needed by the per-stage branch lifecycle (a later ticket, #43) the same way GitHub's own #12 and GitLab's own #29 needed it. */
  async function branchExists(branch) {
    return (await getBranchObjectId(branch)) !== null
  }

  function srcUrl(hash, normalizedPath) {
    const encodedPath = normalizedPath ? normalizedPath.split('/').map(encodeURIComponent).join('/') : ''
    return `${repoUrl}/src/${encodeURIComponent(hash)}/${encodedPath}`
  }

  /**
   * `?format=meta` metadata for `normalizedPath` at `hash` — `{ type: 'commit_file' | 'commit_directory', ... }`
   * — or `null` if nothing exists there. The one disambiguation point every read below goes through
   * first: Bitbucket's plain (non-meta) `GET .../src/{hash}/{path}` returns a file's *raw* contents
   * with no distinguishing envelope when `path` is a file, but a JSON directory listing when `path` is
   * a directory — so without checking `type` first, a caller can't tell "this is an empty text file"
   * from "this is a directory" purely from a successful response's shape (and a `.json`-extensioned
   * *file*'s raw content is itself valid JSON, so shape-sniffing the plain response is not reliable
   * either). Addressed by resolved `hash`, never a raw branch name — see this factory's own "Branch
   * names containing '/'" doc comment.
   */
  async function metaAt(hash, normalizedPath) {
    try {
      const res = await request(`${srcUrl(hash, normalizedPath)}?format=meta`)
      return await res.json()
    } catch (err) {
      if (err instanceof BitbucketNotFoundError) return null
      throw err
    }
  }

  /**
   * Fetches an existing file's raw text content by repo-relative path. Throws `BitbucketNotFoundError`
   * if nothing exists at that path on the given branch (default "main"), the branch itself doesn't
   * exist, or the path names a directory rather than a file — the same three-way "there is no file
   * here" contract `lib/gitlabClient.js`'s own `getFileContent` throws for.
   */
  async function getFileContent(path, { branch = 'main' } = {}) {
    const normalized = normalizeRepoRelativePath(path)
    const hash = await getBranchObjectId(branch)
    const meta = hash === null ? null : await metaAt(hash, normalized)
    if (!meta || meta.type !== 'commit_file') {
      throw new BitbucketNotFoundError(fileOrFolderNotFoundMessage(path, branch), { status: 404 })
    }
    const res = await request(srcUrl(hash, normalized))
    return res.text()
  }

  /**
   * Fetches an existing file's real bytes, undecoded — Bitbucket's Source API returns a file's raw
   * bytes directly (no base64 envelope the way GitHub/GitLab's own Contents/Repository Files APIs
   * do), so this reads the response body as bytes with no decode step at all, mirroring
   * `lib/gitlabClient.js`'s own "don't corrupt binary content with a UTF-8 round trip" reasoning by a
   * different, simpler route.
   */
  async function getFileBytes(path, { branch = 'main' } = {}) {
    const normalized = normalizeRepoRelativePath(path)
    const hash = await getBranchObjectId(branch)
    const meta = hash === null ? null : await metaAt(hash, normalized)
    if (!meta || meta.type !== 'commit_file') {
      throw new BitbucketNotFoundError(fileOrFolderNotFoundMessage(path, branch), { status: 404 })
    }
    const res = await request(srcUrl(hash, normalized))
    return Buffer.from(await res.arrayBuffer())
  }

  /** Whether a file (specifically — not a directory) exists at `path` on `branch` (default "main"). Positional `branch`, not an options object, matching every other provider client's own `fileExists(path, branch)` shape (`tests/helpers/providerContractTests.js` calls it this same way regardless of provider). */
  async function fileExists(path, branch = 'main') {
    const normalized = normalizeRepoRelativePath(path)
    const hash = await getBranchObjectId(branch)
    if (hash === null) return false
    const meta = await metaAt(hash, normalized)
    return Boolean(meta) && meta.type === 'commit_file'
  }

  /**
   * Lists the immediate children of a repo-relative folder path — `[{ path, isFolder }, ...]`, sorted
   * by path — over Bitbucket's own Source API directory-listing response. `[]` (not an error) if the
   * folder doesn't exist, the branch doesn't exist, or `path` names a file rather than a folder —
   * mirroring `lib/gitlabClient.js`'s own `listFolder`'s identical "absence is not exceptional"
   * contract. `pagelen=100` mirrors that same client's own `per_page=100` — depths beyond one page are
   * a later concern, not exercised by any current caller.
   */
  async function listFolder(path, { branch = 'main' } = {}) {
    const normalized = normalizeRepoRelativePath(path)
    const hash = await getBranchObjectId(branch)
    if (hash === null) return []
    const meta = await metaAt(hash, normalized)
    if (!meta || meta.type !== 'commit_directory') return []

    const base = srcUrl(hash, normalized)
    const url = new URL(base.endsWith('/') ? base : `${base}/`)
    url.searchParams.set('pagelen', '100')
    const res = await request(url.toString())
    const data = await res.json()
    return (data.values ?? [])
      .map((entry) => ({ path: entry.path, isFolder: entry.type === 'commit_directory' }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * Creates a new branch named `name`, pointing at the current tip of `from` (default "main") —
   * Bitbucket's own `POST .../refs/branches` (`{ name, target: { hash } }`), resolving `from` to its
   * tip hash first via `getBranchTip` rather than passing `from` as a name Bitbucket itself would have
   * to resolve — the same slash-safety reasoning as every read above. Mirrors
   * `lib/gitlabClient.js`'s own `createBranch`, including its two failure modes: `from` not existing
   * (`BitbucketNotFoundError`, thrown directly here since there is no request left to make once
   * resolution itself fails) and `name` already existing (a non-2xx/401/403/404 response, mapped to
   * the generic `BitbucketRequestError` by `request()`'s own fallback).
   */
  async function createBranch(name, { from = 'main' } = {}) {
    const fromTip = await getBranchTip(from)
    if (!fromTip || fromTip.hash === null) {
      throw new BitbucketNotFoundError(
        `Bitbucket branch "${from}" was not found, so a new branch cannot be created from it.`,
        { status: 404 }
      )
    }
    const res = await request(`${repoUrl}/refs/branches`, { method: 'POST', body: { name, target: { hash: fromTip.hash } } })
    const data = await res.json()
    return { name, from, objectId: data.target?.hash ?? fromTip.hash }
  }

  /**
   * Writes several files as one commit in one push — Bitbucket's own Source API
   * (`POST .../src`, `multipart/form-data`), the only Bitbucket Cloud endpoint that lands more than
   * one file change in a single commit. `deletePaths` removes the given repo-relative paths in that
   * same commit (via the request's repeated `files` meta field — see this factory's own doc comment,
   * "Writing files") — mirrors `lib/gitlabClient.js`'s own `writeFiles`'s `deletePaths`, including its
   * "a path that doesn't currently exist is silently skipped" tolerance.
   *
   * An entirely empty request (no files to add/update, and no `deletePaths` entry that actually
   * exists to delete) is never sent to Bitbucket at all — short-circuited here the same way
   * `lib/gitlabClient.js`'s own `writeFiles` avoids GitLab's identical "empty changelist" rejection,
   * without this client needing to discover whether Bitbucket's own Source API tolerates or rejects an
   * empty multipart body.
   *
   * `contentType: 'base64encoded'` (mirroring `lib/gitlabClient.js`'s and `lib/githubClient.js`'s own
   * convention) decodes already-base64-encoded content to real bytes before uploading — Bitbucket's
   * own Source API has no base64 concept of its own (see `getFileBytes`'s doc comment); this client
   * always uploads real bytes in a `Blob`, so the base64-vs-rawtext distinction here exists purely to
   * know how to decode the *caller's* `content` string, not to pick a wire encoding.
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

    if (normalized.length === 0 && deleteChanges.length === 0) {
      return { changes: [...changes, ...deleteChanges], push: { commits: [] } }
    }

    const form = new FormData()
    form.set('message', message ?? `Update ${changes.map((c) => c.path).join(', ')}`)
    form.set('branch', branch)
    for (const file of normalized) {
      const bytes = file.contentType === 'base64encoded' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8')
      // A leading "/" disambiguates a file whose path happens to collide with a reserved meta field
      // name (`message`/`author`/`branch`/`parents`/`files`) — Bitbucket's own documented rule (see
      // this factory's "Writing files" doc comment) — even though every path gantry actually writes
      // today is nested under a directory and would never literally collide.
      form.append(`/${file.path}`, new Blob([bytes]), file.path.split('/').pop() || 'file')
    }
    for (const change of deleteChanges) {
      form.append('files', `/${change.path}`)
    }

    await request(`${repoUrl}/src`, { method: 'POST', body: form, isForm: true })

    // Render provenance: the POST's own success response carries no documented body (Bitbucket's own
    // OpenAPI spec declares no response schema for its 201), so the new commit is read back off the
    // branch's own tip instead — see this factory's "Writing files" doc comment for why.
    const tip = await getBranchTip(branch)
    return {
      changes: [...changes, ...deleteChanges],
      push: {
        commits: [{ commitId: tip?.hash ?? null, committer: { date: tip?.date ?? null }, author: { date: tip?.date ?? null } }],
      },
    }
  }

  /** Creates a new file, or updates an existing one, at `path` — a single-file convenience wrapper over `writeFiles` (still one real commit), mirroring `lib/gitlabClient.js`'s own `writeFile`/`writeFiles` split. */
  async function writeFile(path, content, { branch = 'main', message = `Update ${normalizeRepoRelativePath(path)}`, contentType = 'rawtext' } = {}) {
    const { changes, push } = await writeFiles([{ path, content, contentType }], { branch, message })
    return { path: changes[0].path, changeType: changes[0].changeType, push }
  }

  /** Deletes an existing file at `path` — a single commit with one `deletePaths` entry and no files to add, built on `writeFiles` for the same reason every other write here is — the Bitbucket twin of `lib/gitlabClient.js`'s own `deleteFile`. */
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
