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
 *
 * Labels and assignees, per #15's Request Review (docs/adr/0040 "Review status rides reserved
 * labels"): `POST /repos/:owner/:repo/labels` creates a label definition (422 "already_exists" for a
 * name already taken, mirroring real GitHub — this is what makes `ensureLabelsExist`'s
 * tolerate-already-exists behaviour genuinely testable). Creating an issue with `assignees` validates
 * each login against the same access rule `lib/githubIdentityClient.js`'s own `canAssign` already
 * models — a `collaborators` entry, or an `orgMembers` entry with a non-`'none'` `permissions` value —
 * and 422s with GitHub's own "Validation Failed" shape for one that isn't, reproducing docs/adr/0040's
 * "GitHub rejects an issue assignee who lacks repo access" as a real server response rather than only
 * a client-side gate. Creating (or updating) an issue with `labels` (an array of plain name strings)
 * auto-creates any name not already defined via `POST .../labels` — mirroring real GitHub's own
 * create-issue behaviour — and the issue's own `labels` field always reports full `{ name, color,
 * description }` objects, matching the real API's shape.
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
  mergeRefusal = null,
} = {}) {
  const issues = new Map() // number -> issue object
  const issueIdToNumber = new Map() // internal id -> number
  const subIssues = new Map() // parent number -> Set<child number>
  const labelDefs = new Map() // name -> { name, color, description }
  let issueCounter = 0
  let issueIdCounter = 1000

  // The same "who can actually be assigned" rule lib/githubIdentityClient.js's own `canAssign`
  // models (#10, docs/adr/0040): a collaborator always can; an org member who isn't one can only if
  // `permissions` grants them something other than `'none'`.
  function isAssignable(login) {
    if (collaborators.some((c) => c.login === login)) return true
    return (permissions[login] ?? 'none') !== 'none'
  }

  // Real GitHub auto-creates a label from a bare name the first time it's attached to an issue if no
  // such label exists yet — this mirrors that so a caller doesn't have to call the labels endpoint
  // itself to observe an issue's labels field in the label-object shape the real API returns.
  function resolveLabelObjects(names) {
    return (names ?? []).map((name) => {
      if (!labelDefs.has(name)) labelDefs.set(name, { name, color: 'ededed', description: null })
      return labelDefs.get(name)
    })
  }
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

  // Pull Requests (#20) — see this file's own "Pull Requests" section below for the endpoints these
  // back. Declared here (not inside the request handler) so state persists across requests against
  // the same fake server instance, exactly like `branches`/`refs`/`commits` above.
  const pulls = new Map() // number -> { number, head, base, title, body, state, merged, requested_reviewers }
  let pullCounter = 0
  const reviews = new Map() // number -> [{ id, user, state, submitted_at }]

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

    // DELETE /repos/:owner/:repo/git/refs/heads/:branch — real GitHub's own branch-deletion endpoint.
    // Not called by any gantry client (merging never deletes the source branch itself — same as the
    // Azure DevOps fake), but test-facing: mirrors the "a stage branch was cleaned up after merge, by
    // a repo setting or a human, before a later re-open" scenario `tests/serverStageReopen.test.js`
    // already simulates for Azure DevOps by deleting the ref directly.
    const deleteRefMatch = pathname.match(new RegExp(`^${repoBasePath}/git/refs/heads/(.+)$`))
    if (req.method === 'DELETE' && deleteRefMatch) {
      const branchName = deleteRefMatch[1]
      if (!refs.has(branchName)) return json(422, { message: `Reference does not exist (fake: "refs/heads/${branchName}")` })
      refs.delete(branchName)
      branches.delete(branchName)
      res.writeHead(204)
      res.end()
      return
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
    // lib/githubClient.js's createBranch's own path for stacking/forking a stage branch (#12), and its
    // own path for lib/definitionPromote.js's promotion branch (#20). Real GitHub rejects creating a
    // ref that already exists with 422 "Reference already exists" — mirrored here so createBranch's
    // own "name already exists" failure mode is genuinely testable, the same way
    // fakeAzureDevOpsServer.js's ref-update handler rejects a duplicate branch name.
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

    // GET /repos/:owner/:repo/labels — lists every label defined on the repo (test-facing
    // convenience, mirroring real GitHub's own read endpoint, the same way the sub-issues GET below
    // does for hierarchy).
    if (req.method === 'GET' && pathname === `${repoBasePath}/labels`) {
      return json(200, [...labelDefs.values()])
    }

    // POST /repos/:owner/:repo/labels — creates a label definition. 422s "already_exists" for a name
    // already taken, mirroring real GitHub — the case lib/githubWorkItemsClient.js's
    // `ensureLabelsExist` tolerates rather than fails over.
    if (req.method === 'POST' && pathname === `${repoBasePath}/labels`) {
      const body = await readJsonBody(req)
      if (labelDefs.has(body.name)) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] })
      }
      const label = { name: body.name, color: body.color ?? 'ededed', description: body.description ?? null }
      labelDefs.set(body.name, label)
      return json(201, label)
    }

    // POST /repos/:owner/:repo/issues — creates a new issue. Mirrors real GitHub's response shape
    // closely enough for lib/githubWorkItemsClient.js: `number` (repo-scoped, user-visible) and `id`
    // (opaque, global — what the sub_issues endpoint actually addresses a child by) are deliberately
    // distinct counters, the same way real GitHub's are. `assignees` is validated against
    // `isAssignable` above — an unassignable login 422s exactly like real GitHub, never silently
    // dropped — and `labels` (bare name strings) are resolved to full label objects, auto-creating any
    // gantry hasn't already defined via POST .../labels.
    if (req.method === 'POST' && pathname === `${repoBasePath}/issues`) {
      const body = await readJsonBody(req)
      const invalidAssignee = (body.assignees ?? []).find((login) => !isAssignable(login))
      if (invalidAssignee) {
        return json(422, {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'assignee', code: 'invalid', value: invalidAssignee }],
        })
      }
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
        assignees: (body.assignees ?? []).map((login) => ({ login })),
        labels: resolveLabelObjects(body.labels),
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

    // PATCH /repos/:owner/:repo/issues/:number — partial update (title/body/state/state_reason/labels).
    if (req.method === 'PATCH' && issueGetMatch) {
      const issue = issues.get(Number(issueGetMatch[1]))
      if (!issue) return json(404, { message: `No fake issue #${issueGetMatch[1]}` })
      const body = await readJsonBody(req)
      const { labels, ...rest } = body
      Object.assign(issue, rest)
      if (labels !== undefined) issue.labels = resolveLabelObjects(labels)
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

    // ---- Pull Requests (#20) ----
    //
    // A minimal fake of GitHub's Pulls API: enough for `lib/githubPullRequestsClient.js` to open a
    // Promote Pull Request, read it back (status + reviews) and attach a requested reviewer. Real
    // review *submission* is a reviewer's own action, performed with their own token; this fake has
    // only one accepted PAT, so a test simulates "the code owner reviewed" the same way real GitHub's
    // own API models it — `POST .../pulls/:number/reviews` with `{event}` — rather than inventing a
    // second, fake-only endpoint.
    //
    // Merge (`PUT .../pulls/:number/merge`, #13's `completePullRequest`) always uses a merge commit,
    // fast-forwarding the base branch's own file map/ref to the head branch's current tip — enough to
    // prove a caller can read the merged content back afterwards, without modelling a genuine
    // two-parent merge commit. `mergeRefusal`, if set (`{ status, message }`), makes every merge
    // attempt fail with that response instead — reproducing a branch-protection or required-check
    // refusal (ADR-0040: "surfaced verbatim as a blocked sign-off, never retried, never downgraded to
    // another merge method") so that behaviour is genuinely testable.
    if (req.method === 'POST' && pathname === `${repoBasePath}/pulls`) {
      const body = await readJsonBody(req)
      if (!body.head || !body.base || !body.title) return json(422, { message: 'head, base and title are required' })
      const number = ++pullCounter
      const pr = { number, head: { ref: body.head }, base: { ref: body.base }, title: body.title, body: body.body ?? null, state: 'open', merged: false }
      pulls.set(number, pr)
      reviews.set(number, [])
      return json(201, pr)
    }

    const pullMatch = pathname.match(new RegExp(`^${repoBasePath}/pulls/(\\d+)$`))
    if (req.method === 'GET' && pullMatch) {
      const pr = pulls.get(Number(pullMatch[1]))
      if (!pr) return json(404, { message: `No fake pull request #${pullMatch[1]}` })
      return json(200, pr)
    }

    const requestedReviewersMatch = pathname.match(new RegExp(`^${repoBasePath}/pulls/(\\d+)/requested_reviewers$`))
    if (req.method === 'POST' && requestedReviewersMatch) {
      const number = Number(requestedReviewersMatch[1])
      const pr = pulls.get(number)
      if (!pr) return json(404, { message: `No fake pull request #${number}` })
      const body = await readJsonBody(req)
      pr.requested_reviewers = [...(pr.requested_reviewers ?? []), ...(body.reviewers ?? []).map((login) => ({ login }))]
      return json(201, pr)
    }

    const reviewsMatch = pathname.match(new RegExp(`^${repoBasePath}/pulls/(\\d+)/reviews$`))
    if (req.method === 'GET' && reviewsMatch) {
      const number = Number(reviewsMatch[1])
      if (!pulls.has(number)) return json(404, { message: `No fake pull request #${number}` })
      return json(200, reviews.get(number) ?? [])
    }
    if (req.method === 'POST' && reviewsMatch) {
      const number = Number(reviewsMatch[1])
      if (!pulls.has(number)) return json(404, { message: `No fake pull request #${number}` })
      const body = await readJsonBody(req)
      const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[body.event] ?? 'COMMENTED'
      const review = { id: (reviews.get(number)?.length ?? 0) + 1, user: { login: 'fake-reviewer' }, state, submitted_at: new Date().toISOString() }
      reviews.set(number, [...(reviews.get(number) ?? []), review])
      return json(200, review)
    }

    // GET /repos/:owner/:repo/pulls/:number/commits — #13's getPullRequestCommits. This fake's git
    // model has no real commit history to walk, so it reports the head branch's own current tip commit
    // (real author/committer stamps from that commit, if it has any) as the PR's sole commit — enough
    // for lib/stageStatus.js's commit-panel summary, never used for anything git-history-shaped.
    const prCommitsMatch = pathname.match(new RegExp(`^${repoBasePath}/pulls/(\\d+)/commits$`))
    if (req.method === 'GET' && prCommitsMatch) {
      const number = Number(prCommitsMatch[1])
      const pr = pulls.get(number)
      if (!pr) return json(404, { message: `No fake pull request #${number}` })
      const sha = refs.get(pr.head.ref)
      if (!sha) return json(200, [])
      const commit = commits.get(sha)
      const date = new Date().toISOString()
      const stamp = { name: 'Fake Author', email: 'fake-author@example.invalid', date }
      return json(200, [
        {
          sha,
          commit: {
            message: `fake commit ${sha}`,
            author: commit?.author ?? stamp,
            committer: commit?.committer ?? stamp,
          },
        },
      ])
    }

    // PUT /repos/:owner/:repo/pulls/:number/merge — #13's completePullRequest. `mergeRefusal`
    // (`{ status, message }`) simulates a branch-protection or required-check block; otherwise the
    // merge always succeeds with a merge commit, fast-forwarding `base` to `head`'s current content.
    const mergeMatch = pathname.match(new RegExp(`^${repoBasePath}/pulls/(\\d+)/merge$`))
    if (req.method === 'PUT' && mergeMatch) {
      const number = Number(mergeMatch[1])
      const pr = pulls.get(number)
      if (!pr) return json(404, { message: `No fake pull request #${number}` })
      if (pr.merged) return json(405, { message: 'Pull Request is not mergeable (fake: already merged)' })
      if (mergeRefusal) {
        return json(mergeRefusal.status ?? 405, { message: mergeRefusal.message ?? 'Pull Request is not mergeable' })
      }
      const headSha = refs.get(pr.head.ref)
      const headTree = headSha ? commits.get(headSha)?.treeSha : undefined
      const mergeSha = nextSha('commit')
      const date = new Date().toISOString()
      commits.set(mergeSha, {
        treeSha: headTree ?? trees.get([...trees.keys()].at(-1)),
        parents: [refs.get(pr.base.ref), headSha].filter(Boolean),
        committer: { name: 'Fake Committer', email: 'fake-committer@example.invalid', date },
        author: { name: 'Fake Author', email: 'fake-author@example.invalid', date },
      })
      refs.set(pr.base.ref, mergeSha)
      branches.set(pr.base.ref, new Map(branches.get(pr.head.ref) ?? new Map()))
      pr.merged = true
      pr.state = 'closed'
      pr.merge_commit_sha = mergeSha
      return json(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' })
    }

    return json(404, { message: `No fake route for ${req.method} ${pathname}` })
  })
}

/** Starts a `createFakeGitHubServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeAzureDevOpsServer.js`'s own `withFakeAzureDevOpsServer` shape. */
export function withFakeGitHubServer(
  { owner, repository, validPat, files, branchFiles, repoExists, ownerType, collaborators, orgMembers, permissions, subIssuesEnabled, mergeRefusal },
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
      mergeRefusal,
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
