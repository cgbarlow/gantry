import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the GitHub REST API, standing in for a real `api.github.com` (or
 * GitHub Enterprise Server) owner/repository in tests (#8, #19) — a real HTTP server on an ephemeral
 * port that `lib/githubClient.js` talks to over real `fetch` calls, never a mock of `fetch` itself.
 * Mirrors `tests/helpers/fakeAzureDevOpsServer.js`'s own shape and conventions so the two fakes read
 * the same way to a caller working across both providers.
 *
 * Covers the subset `lib/githubClient.js` implements: the repository-metadata endpoint
 * (`GET /repos/:owner/:repo`) that `checkGitHubRepo`/`createGitHubClient().getRepo()` call to prove a
 * PAT reaches a real repository before a workspace is registered (#8), the Contents API (get a file,
 * list a folder) `lib/definitionGitHub.js` reads a library repo's `definitions/` folder over (#19), and
 * the Git Data API (blobs/trees/commits/refs) `writeFile`/`writeFiles` uses to land one or several
 * files as a single commit (#11). Later tickets (#13 pull requests, #14 work items, #15 review labels,
 * #10 identity) extend this the same incremental way #99/#118/#120 extended the Azure DevOps fake — new
 * endpoints added here as the GitHub client itself grows them, never a parallel second fake.
 *
 * The Git Data API is modelled loosely, not as real git objects: a "tree" is just the flat
 * `Map<path, content>` a branch already is (no nested subtrees, no real SHA-1 hashing) — enough to
 * prove `lib/githubClient.js`'s own request sequence (blob → tree → commit → ref) round-trips real
 * content through real HTTP, without reimplementing git itself. Blob/tree/commit ids are opaque
 * incrementing fake shas (`blob-1`, `tree-1`, `commit-1`, ...), never validated by this fake or by the
 * client, which never parses a sha's shape.
 *
 * `files` seeds `main`'s initial content, keyed by repo-relative path (leading "/" optional).
 * `branchFiles`, if given, seeds one or more other branches the same way. `validPat` is the PAT (or,
 * if an array, any one of several) accepted in the `Authorization: Bearer <pat>` header GitHub itself
 * expects — anything else, or a missing/malformed header, gets a 401, mirroring a rejected PAT's real
 * shape. `repoExists` (default `true`) controls whether `GET /repos/:owner/:repo` reports the
 * repository as existing. `false` returns 404, simulating both a genuinely nonexistent repository and
 * — per docs/adr/0040's own noted trap — a fine-grained PAT with insufficient scope against a repo it
 * can't see, which GitHub itself also reports as 404 rather than 403.
 *
 * `ownerType` (`'User'` (default) or `'Organization'`) drives the repo-metadata `owner.type` field —
 * `lib/githubIdentityClient.js`'s own signal for whether an org-members search is even meaningful for
 * this repo (#10, docs/adr/0040's person picker). `collaborators` (default `[]`) seeds
 * `GET /repos/:owner/:repo/collaborators` (each `{ login, id }`) — everyone this repo already grants
 * access to, direct or team-granted alike (real GitHub's own `affiliation=all` semantics). `orgMembers`
 * (default `[]`) seeds `GET /orgs/:org/members`, only reachable when `ownerType` is `'Organization'`
 * (a 404 otherwise, mirroring the real API). `permissions` (default `{}`) maps a login to the
 * permission `GET /repos/:owner/:repo/collaborators/:username/permission` reports for them —
 * `'none'` for any login not listed, `'admin'|'write'|'read'` otherwise; this is the endpoint that
 * makes team-granted access resolve as access for a name that's an org member but not a direct
 * collaborator.
 *
 * Issues, per #14's `lib/githubWorkItemsClient.js`: `POST /repos/:owner/:repo/issues` (create),
 * `GET .../issues/:number` (read), `PATCH .../issues/:number` (title/body/state update), and
 * `POST .../issues/:number/sub_issues` (attach as a native sub-issue). `subIssuesEnabled` (default
 * `true`) controls whether that last endpoint works at all — `false` makes it 404, reproducing the
 * "feature unavailable" case docs/adr/0040's hierarchy fallback (a task-list entry in the parent's body
 * plus a "Part of #<n>" line in the child) exists to handle.
 */
export function createFakeGitHubServer({
  owner,
  repository,
  validPat,
  files = {},
  branchFiles = {},
  repoExists = true,
  ownerType = 'User',
  collaborators = [],
  orgMembers = [],
  permissions = {},
  subIssuesEnabled = true,
} = {}) {
  const issues = new Map() // number -> issue object
  const issueIdToNumber = new Map() // internal id -> number
  const subIssues = new Map() // parent number -> Set<child number>
  let issueCounter = 0
  let issueIdCounter = 1000
  const branches = new Map()
  const refs = new Map() // branch name -> commit sha
  const commits = new Map() // commit sha -> { treeSha, parents }
  const trees = new Map() // tree sha -> Map<path, content> (the materialized file set at that tree)
  const blobs = new Map() // blob sha -> { content, encoding }
  let objectCounter = 0
  const nextSha = (kind) => `${kind}-${++objectCounter}`

  // Seeds a branch with both the Contents-API-facing flat file map (`branches`) and a synthetic
  // initial commit/tree/ref, so `writeFiles`'s own `getBranchTip` finds a real tip (and a real
  // `base_tree` to build on) even for a repo seeded directly via `files`/`branchFiles`, not through a
  // prior write.
  //
  // #16: every stored file is a real `Buffer` — a fixture may pass either a plain string (a text
  // file's UTF-8 content) or a `Buffer` (a binary file's real bytes, e.g. a seeded PNG), matching how
  // a write via the Git Data API below also ends up storing real bytes. This is what makes the
  // Contents API GET below byte-accurate for binary content, mirroring real GitHub rather than
  // silently mangling it through a UTF-8 round trip.
  function seedBranch(name, seedFiles) {
    const entries = Object.entries(seedFiles)
    const store = new Map(
      entries.map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')])
    )
    branches.set(name, store)
    const treeSha = nextSha('tree')
    trees.set(treeSha, new Map(store))
    const commitSha = nextSha('commit')
    commits.set(commitSha, { treeSha, parents: [] })
    refs.set(name, commitSha)
  }
  seedBranch('main', files)
  for (const [branchName, seedFiles] of Object.entries(branchFiles)) {
    seedBranch(branchName, seedFiles)
  }

  const repoBasePath = `/repos/${owner}/${repository}`

  async function readJsonBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-github.invalid')
    const pathname = decodeURIComponent(url.pathname)
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const auth = req.headers['authorization'] ?? ''
    const [, providedPat] = auth.match(/^Bearer (.+)$/) ?? []
    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    if (!validPats.includes(providedPat)) {
      return json(401, { message: 'Bad credentials (fake server: invalid or missing PAT)' })
    }

    // GET the repository metadata itself — lib/githubClient.js's getRepo()/repoExists() call this.
    if (req.method === 'GET' && pathname === repoBasePath) {
      if (!repoExists) {
        return json(404, { message: 'Not Found (fake: repository does not exist, or PAT scope insufficient to see it)' })
      }
      return json(200, {
        id: 1,
        name: repository,
        full_name: `${owner}/${repository}`,
        owner: { login: owner, type: ownerType },
        default_branch: 'main',
      })
    }

    // Collaborators — lib/githubIdentityClient.js's own list of "already has repo access" candidates
    // (#10). Real GitHub's default `affiliation=all` already folds in team-granted access, which this
    // fake mirrors by simply returning whatever `collaborators` the test seeded.
    if (req.method === 'GET' && pathname === `${repoBasePath}/collaborators`) {
      return json(200, collaborators.map(({ login, id }) => ({ login, id })))
    }

    // Per-user permission — the endpoint that resolves whether an organization member who *isn't*
    // already a collaborator can actually be assigned (#10, docs/adr/0040). Defaults to `'none'` for
    // any login the test didn't explicitly grant a permission to, matching real GitHub's own response
    // shape for someone with no access to this repository.
    const permissionMatch = pathname.match(new RegExp(`^${repoBasePath}/collaborators/([^/]+)/permission$`))
    if (req.method === 'GET' && permissionMatch) {
      const username = permissionMatch[1]
      return json(200, { permission: permissions[username] ?? 'none', user: { login: username } })
    }

    // Organization members — only a real endpoint for an org-owned repo; a personal-account owner
    // 404s here exactly as real GitHub does (there's no such organization to list members of).
    if (req.method === 'GET' && pathname === `/orgs/${owner}/members`) {
      if (ownerType !== 'Organization') {
        return json(404, { message: `Not Found (fake: "${owner}" is not an organization)` })
      }
      return json(200, orgMembers.map(({ login, id }) => ({ login, id })))
    }

    // Contents API — GET /repos/{owner}/{repo}/contents/{path}?ref={branch}, one route for both a
    // single file (object response) and a folder listing (array response), exactly like the real API.
    if (req.method === 'GET' && pathname.startsWith(`${repoBasePath}/contents`)) {
      const branchName = url.searchParams.get('ref') ?? 'main'
      const store = branches.get(branchName) ?? new Map()
      const scopePath = pathname.slice(`${repoBasePath}/contents`.length).replace(/^\/+/, '')
      const normalizedScope = scopePath === '' ? '' : scopePath.replace(/\/+$/, '')

      // A single file at exactly this path. #16: `content` is always a real Buffer (see seedBranch
      // and the tree-materialization handler below) — base64-encoding it directly, rather than
      // assuming it's UTF-8 text first, is what makes this byte-accurate for a binary file.
      if (store.has(`/${normalizedScope}`)) {
        const content = store.get(`/${normalizedScope}`)
        return json(200, {
          type: 'file',
          name: normalizedScope.split('/').pop(),
          path: normalizedScope,
          content: content.toString('base64'),
          encoding: 'base64',
        })
      }

      // Otherwise, treat it as a folder listing — derive immediate children from stored paths, the
      // same "no real folder concept, infer from flat paths" approach fakeAzureDevOpsServer.js uses.
      const prefix = normalizedScope === '' ? '/' : `/${normalizedScope}/`
      const children = new Map() // name -> isFolder
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [name, ...more] = rest.split('/')
        const isFolder = more.length > 0
        children.set(name, (children.get(name) ?? false) || isFolder)
      }
      if (children.size === 0) {
        return json(404, { message: `Not Found (fake server: no item at "${scopePath}")` })
      }
      const value = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, isFolder]) => ({
          type: isFolder ? 'dir' : 'file',
          name,
          path: normalizedScope === '' ? name : `${normalizedScope}/${name}`,
        }))
      return json(200, value)
    }

    // GET /repos/:owner/:repo/git/ref/heads/:branch — the current tip commit of a branch;
    // lib/githubClient.js's getBranchTip calls this first, then GET .../git/commits/:sha below.
    const refMatch = pathname.match(new RegExp(`^${repoBasePath}/git/ref/heads/(.+)$`))
    if (req.method === 'GET' && refMatch) {
      const branchName = refMatch[1]
      const sha = refs.get(branchName)
      if (!sha) return json(404, { message: `No fake ref for "heads/${branchName}"` })
      return json(200, { ref: `refs/heads/${branchName}`, object: { sha, type: 'commit' } })
    }

    // GET /repos/:owner/:repo/git/commits/:sha — just enough of a commit object for
    // lib/githubClient.js's getBranchTip to read the tree it points at.
    const commitMatch = pathname.match(new RegExp(`^${repoBasePath}/git/commits/([^/]+)$`))
    if (req.method === 'GET' && commitMatch) {
      const commit = commits.get(commitMatch[1])
      if (!commit) return json(404, { message: `No fake commit "${commitMatch[1]}"` })
      return json(200, { sha: commitMatch[1], tree: { sha: commit.treeSha } })
    }

    // POST /repos/:owner/:repo/git/blobs — stores one file's content, keyed by a fake blob sha.
    if (req.method === 'POST' && pathname === `${repoBasePath}/git/blobs`) {
      const body = await readJsonBody(req)
      const sha = nextSha('blob')
      blobs.set(sha, { content: body.content, encoding: body.encoding ?? 'utf-8' })
      return json(201, { sha })
    }

    // POST /repos/:owner/:repo/git/trees — materializes a new flat file map from `base_tree` (if
    // given) plus the entries in `tree`; an entry with `sha: null` removes that path (GitHub's own
    // documented convention for deleting a path via the Git Data API).
    if (req.method === 'POST' && pathname === `${repoBasePath}/git/trees`) {
      const body = await readJsonBody(req)
      const base = body.base_tree ? trees.get(body.base_tree) : undefined
      if (body.base_tree && !base) return json(404, { message: `No fake tree "${body.base_tree}"` })
      const materialized = new Map(base ?? [])
      for (const entry of body.tree ?? []) {
        const key = entry.path.startsWith('/') ? entry.path : `/${entry.path}`
        if (entry.sha === null) {
          materialized.delete(key)
          continue
        }
        const blob = blobs.get(entry.sha)
        if (!blob) return json(422, { message: `No fake blob "${entry.sha}"` })
        // #16: decode to the blob's real bytes and keep them as a Buffer — real GitHub's blob store
        // holds real bytes regardless of which encoding the caller used to submit them, and a prior
        // version of this fake re-stringified them as UTF-8 here, silently mangling any binary
        // (base64-submitted) content the moment it was written rather than only when it was read.
        materialized.set(key, Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8'))
      }
      const sha = nextSha('tree')
      trees.set(sha, materialized)
      return json(201, { sha })
    }

    // POST /repos/:owner/:repo/git/commits — records a new commit object pointing at `tree`.
    // #16: real GitHub always returns `author`/`committer` (each `{ name, email, date }`) on a created
    // commit — defaulted from the authenticated identity/current time when the request body omits them,
    // exactly as `lib/githubClient.js`'s `writeFiles` does. This fake stamps a fresh ISO date per commit
    // (rather than a fixed constant) so `lib/render.js`'s Document Control commit date reflects a real,
    // if fake, moment, the same way a real GitHub commit would.
    if (req.method === 'POST' && pathname === `${repoBasePath}/git/commits`) {
      const body = await readJsonBody(req)
      if (!trees.has(body.tree)) return json(422, { message: `No fake tree "${body.tree}"` })
      const sha = nextSha('commit')
      const date = new Date().toISOString()
      const committer = body.committer ?? { name: 'Fake Committer', email: 'fake-committer@example.invalid', date }
      const author = body.author ?? { name: 'Fake Author', email: 'fake-author@example.invalid', date }
      commits.set(sha, { treeSha: body.tree, parents: body.parents ?? [], committer, author })
      return json(201, { sha, committer, author })
    }

    // PATCH /repos/:owner/:repo/git/refs/heads/:branch — fast-forwards an existing branch to a new
    // commit; the final step of lib/githubClient.js's writeFiles for a branch that already exists.
    // Syncs `branches` (the Contents-API-facing store) to the new tip's materialized tree so a
    // subsequent GET .../contents immediately reflects the write.
    const updateRefMatch = pathname.match(new RegExp(`^${repoBasePath}/git/refs/heads/(.+)$`))
    if (req.method === 'PATCH' && updateRefMatch) {
      const branchName = updateRefMatch[1]
      const body = await readJsonBody(req)
      const commit = commits.get(body.sha)
      if (!commit) return json(422, { message: `No fake commit "${body.sha}"` })
      refs.set(branchName, body.sha)
      branches.set(branchName, new Map(trees.get(commit.treeSha)))
      return json(200, { ref: `refs/heads/${branchName}`, object: { sha: body.sha } })
    }

    // POST /repos/:owner/:repo/git/refs — creates a brand-new branch ref; writeFiles's path for the
    // very first commit onto a branch that doesn't exist yet (mirrors a genuinely empty repo/branch),
    // and lib/githubClient.js's createBranch's own path for stacking/forking a stage branch (#12).
    // Real GitHub rejects creating a ref that already exists with 422 "Reference already exists" —
    // mirrored here so createBranch's own "name already exists" failure mode is genuinely testable,
    // the same way fakeAzureDevOpsServer.js's ref-update handler rejects a duplicate branch name.
    if (req.method === 'POST' && pathname === `${repoBasePath}/git/refs`) {
      const body = await readJsonBody(req)
      const branchName = String(body.ref ?? '').replace(/^refs\/heads\//, '')
      if (!branchName) return json(422, { message: 'Missing or malformed "ref"' })
      if (refs.has(branchName)) return json(422, { message: `Reference already exists (fake: "refs/heads/${branchName}")` })
      const commit = commits.get(body.sha)
      if (!commit) return json(422, { message: `No fake commit "${body.sha}"` })
      refs.set(branchName, body.sha)
      branches.set(branchName, new Map(trees.get(commit.treeSha)))
      return json(201, { ref: `refs/heads/${branchName}`, object: { sha: body.sha } })
    }

    // POST /repos/:owner/:repo/issues — creates a new issue. Mirrors real GitHub's response shape
    // closely enough for lib/githubWorkItemsClient.js: `number` (repo-scoped, user-visible) and `id`
    // (opaque, global — what the sub_issues endpoint actually addresses a child by) are deliberately
    // distinct counters, the same way real GitHub's are.
    if (req.method === 'POST' && pathname === `${repoBasePath}/issues`) {
      const body = await readJsonBody(req)
      const number = ++issueCounter
      const id = ++issueIdCounter
      const issue = {
        id,
        number,
        title: body.title ?? '',
        body: body.body ?? '',
        state: 'open',
        state_reason: null,
        html_url: `https://fake-github.invalid/${owner}/${repository}/issues/${number}`,
      }
      issues.set(number, issue)
      issueIdToNumber.set(id, number)
      return json(201, issue)
    }

    // GET /repos/:owner/:repo/issues/:number
    const issueGetMatch = pathname.match(new RegExp(`^${repoBasePath}/issues/(\\d+)$`))
    if (req.method === 'GET' && issueGetMatch) {
      const issue = issues.get(Number(issueGetMatch[1]))
      if (!issue) return json(404, { message: `No fake issue #${issueGetMatch[1]}` })
      return json(200, issue)
    }

    // PATCH /repos/:owner/:repo/issues/:number — partial update (title/body/state/state_reason).
    if (req.method === 'PATCH' && issueGetMatch) {
      const issue = issues.get(Number(issueGetMatch[1]))
      if (!issue) return json(404, { message: `No fake issue #${issueGetMatch[1]}` })
      const body = await readJsonBody(req)
      Object.assign(issue, body)
      return json(200, issue)
    }

    // POST /repos/:owner/:repo/issues/:number/sub_issues — attaches an existing issue (by its internal
    // `id`, per real GitHub's own contract) as a sub-issue of :number. 404s outright when
    // `subIssuesEnabled` is false, simulating a repository (or GitHub Enterprise Server version)
    // without the feature — indistinguishable, by design, from the parent issue not existing.
    const subIssuesMatch = pathname.match(new RegExp(`^${repoBasePath}/issues/(\\d+)/sub_issues$`))
    if (req.method === 'POST' && subIssuesMatch) {
      if (!subIssuesEnabled) {
        return json(404, { message: 'Not Found (fake: sub-issues is not enabled for this repository)' })
      }
      const parentNumber = Number(subIssuesMatch[1])
      const parent = issues.get(parentNumber)
      if (!parent) return json(404, { message: `No fake issue #${parentNumber}` })
      const body = await readJsonBody(req)
      const childNumber = issueIdToNumber.get(body.sub_issue_id)
      if (!childNumber) return json(404, { message: `No fake issue with id ${body.sub_issue_id}` })
      if (!subIssues.has(parentNumber)) subIssues.set(parentNumber, new Set())
      subIssues.get(parentNumber).add(childNumber)
      return json(201, parent)
    }

    // GET /repos/:owner/:repo/issues/:number/sub_issues — lists the sub-issues attached to :number
    // (test-facing convenience, mirroring real GitHub's own read endpoint).
    const subIssuesGetMatch = pathname.match(new RegExp(`^${repoBasePath}/issues/(\\d+)/sub_issues$`))
    if (req.method === 'GET' && subIssuesGetMatch) {
      const parentNumber = Number(subIssuesGetMatch[1])
      const children = [...(subIssues.get(parentNumber) ?? [])].map((number) => issues.get(number))
      return json(200, children)
    }

    return json(404, { message: `No fake route for ${req.method} ${pathname}` })
  })
}

/** Starts a `createFakeGitHubServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeAzureDevOpsServer.js`'s own `withFakeAzureDevOpsServer` shape. */
export function withFakeGitHubServer(
  { owner, repository, validPat, files, branchFiles, repoExists, ownerType, collaborators, orgMembers, permissions, subIssuesEnabled },
  fn
) {
  return new Promise((resolve, reject) => {
    const server = createFakeGitHubServer({
      owner,
      repository,
      validPat,
      files,
      branchFiles,
      repoExists,
      ownerType,
      collaborators,
      orgMembers,
      permissions,
      subIssuesEnabled,
    })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

export const GITHUB_OWNER = 'fake-owner'
export const GITHUB_REPOSITORY = 'fake-repo'
export const GITHUB_VALID_PAT = 'valid-github-test-pat'
