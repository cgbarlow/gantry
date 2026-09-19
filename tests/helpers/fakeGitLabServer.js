import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the GitLab REST API (v4), standing in for a real `gitlab.com` (or
 * self-hosted CE/EE) namespace/repository in tests (#26) — a real HTTP server on an ephemeral port
 * that `lib/gitlabClient.js` talks to over real `fetch` calls, never a mock of `fetch` itself. Mirrors
 * `tests/helpers/fakeGitHubServer.js`'s own shape and conventions so the two fakes read the same way
 * to a caller working across both providers.
 *
 * Covers the subset `lib/gitlabClient.js` implements so far (#26's content-store scope): the project
 * metadata endpoint (`GET /projects/:id`), the Repository Files API (get a file), the Repository Tree
 * API (list a folder), the Repository Branches API (get/create a branch), and the Commits API (write
 * one or several files as a single commit). Later tickets (#28 identity, #29 stage branches, #30 work
 * items, #33 merge requests, ...) extend this the same incremental way `fakeGitHubServer.js` grew —
 * new endpoints added here as the GitLab client itself grows them, never a parallel second fake.
 *
 * A project's `:id` is GitLab's own `namespace%2Frepository` URL-encoded path — both the project id
 * and a file's `file_path` are single path *segments* that may themselves contain `%2F`-encoded
 * slashes (GitLab's own convention). Node's `URL#pathname` deliberately leaves `%2F` un-decoded (it
 * would otherwise be indistinguishable from a real `/` path separator), so this fake matches routes
 * against the *raw* (still-`%2F`-encoded) pathname and only `decodeURIComponent`s an individual
 * captured segment once its boundaries are known — never the pathname as a whole.
 *
 * `files` seeds `main`'s initial content, keyed by repo-relative path (leading "/" optional).
 * `branchFiles`, if given, seeds one or more other branches the same way. `validPat` is the PAT (or,
 * if an array, any one of several) accepted in the `PRIVATE-TOKEN` header GitLab itself expects —
 * anything else, or a missing header, gets a 401, mirroring a rejected PAT's real shape. `repoExists`
 * (default `true`) controls whether `GET /projects/:id` reports the project as existing; `false`
 * returns 404, simulating both a genuinely nonexistent project and a PAT whose scopes can't see an
 * otherwise-real one — GitLab, like GitHub, reports both cases identically.
 */
export function createFakeGitLabServer({ namespace, repository, validPat, files = {}, branchFiles = {}, repoExists = true } = {}) {
  const branches = new Map() // branch name -> Map<path, Buffer>
  const branchTips = new Map() // branch name -> { commitId, committedDate, authoredDate }
  let commitCounter = 0

  // #26: every stored file is a real Buffer — a fixture may pass either a plain string (a text file's
  // UTF-8 content) or a Buffer (a binary file's real bytes) — matching how a write via the Commits API
  // below also ends up storing real bytes, and mirroring `fakeGitHubServer.js`'s own identical
  // convention.
  function seedBranch(name, seedFiles) {
    const entries = Object.entries(seedFiles)
    const store = new Map(
      entries.map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')])
    )
    branches.set(name, store)
    commitCounter += 1
    const date = new Date().toISOString()
    branchTips.set(name, { commitId: `fake-commit-${commitCounter}`, committedDate: date, authoredDate: date })
  }
  seedBranch('main', files)
  for (const [branchName, seedFiles] of Object.entries(branchFiles)) {
    seedBranch(branchName, seedFiles)
  }

  const projectIdEncoded = encodeURIComponent(`${namespace}/${repository}`)
  const projectBasePath = `/api/v4/projects/${projectIdEncoded}`

  async function readJsonBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }

  return createServer(async (req, res) => {
    // Deliberately NOT decoded up front — the project id segment and any file_path segment carry
    // GitLab's own `%2F`-encoded internal slashes, which must survive route matching intact; see this
    // module's own doc comment above.
    const url = new URL(req.url, 'http://fake-gitlab.invalid')
    const rawPathname = url.pathname
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    if (!validPats.includes(req.headers['private-token'])) {
      return json(401, { message: '401 Unauthorized (fake server: invalid or missing PRIVATE-TOKEN)' })
    }

    if (!rawPathname.startsWith(projectBasePath)) {
      return json(404, { message: `No fake route for ${req.method} ${rawPathname}` })
    }
    const rest = rawPathname.slice(projectBasePath.length)

    // GET /projects/:id — lib/gitlabClient.js's getRepo()/repoExists() call this.
    if (req.method === 'GET' && rest === '') {
      if (!repoExists) {
        return json(404, { message: '404 Project Not Found (fake: project does not exist, or PAT scope insufficient to see it)' })
      }
      return json(200, {
        id: 1,
        name: repository,
        path: repository,
        path_with_namespace: `${namespace}/${repository}`,
        namespace: { full_path: namespace },
        default_branch: 'main',
      })
    }

    // GET /projects/:id/repository/files/:file_path?ref=<branch> — a single file's metadata + base64
    // content, GitLab's own Repository Files API. `:file_path` is itself a single, `%2F`-encoded path
    // segment (real internal slashes are already literal `/` in the raw pathname at this point, since
    // this route only ever matches the *remainder* after the fixed `/repository/files/` prefix).
    if (req.method === 'GET' && rest.startsWith('/repository/files/')) {
      const encodedFilePath = rest.slice('/repository/files/'.length)
      const filePath = decodeURIComponent(encodedFilePath)
      const branchName = url.searchParams.get('ref') ?? 'main'
      const store = branches.get(branchName)
      const key = filePath.startsWith('/') ? filePath : `/${filePath}`
      const content = store?.get(key)
      if (content === undefined) {
        return json(404, { message: '404 File Not Found (fake server)' })
      }
      return json(200, {
        file_name: filePath.split('/').pop(),
        file_path: filePath,
        encoding: 'base64',
        content: content.toString('base64'),
        ref: branchName,
      })
    }

    // GET /projects/:id/repository/tree?path=&ref=&per_page= — immediate children of `path` (or the
    // repo root if omitted), derived from the stored flat paths the same "no real folder concept,
    // infer from flat paths" approach `fakeGitHubServer.js` uses for GitHub's own Contents API.
    if (req.method === 'GET' && rest === '/repository/tree') {
      const branchName = url.searchParams.get('ref') ?? 'main'
      const store = branches.get(branchName) ?? new Map()
      const scopePath = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '')
      const prefix = scopePath === '' ? '/' : `/${scopePath}/`
      const children = new Map() // name -> isFolder
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue
        const restOfKey = key.slice(prefix.length)
        if (restOfKey === '') continue
        const [name, ...more] = restOfKey.split('/')
        const isFolder = more.length > 0
        children.set(name, (children.get(name) ?? false) || isFolder)
      }
      const value = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, isFolder]) => ({
          id: `fake-tree-${name}`,
          name,
          type: isFolder ? 'tree' : 'blob',
          path: scopePath === '' ? name : `${scopePath}/${name}`,
          mode: isFolder ? '040000' : '100644',
        }))
      return json(200, value)
    }

    // GET /projects/:id/repository/branches/:branch — GitLab's own Repository Branches API,
    // lib/gitlabClient.js's getBranchObjectId's single request (unlike GitHub's own two-step
    // ref-then-commit lookup, the branch's tip commit is already embedded here).
    const branchGetMatch = rest.match(/^\/repository\/branches\/(.+)$/)
    if (req.method === 'GET' && branchGetMatch) {
      const branchName = decodeURIComponent(branchGetMatch[1])
      const tip = branchTips.get(branchName)
      if (!tip) return json(404, { message: `404 Branch Not Found (fake: "${branchName}")` })
      return json(200, { name: branchName, commit: { id: tip.commitId, committed_date: tip.committedDate } })
    }

    // POST /projects/:id/repository/branches?branch=&ref= — creates a new branch pointing at `ref`'s
    // current tip. Mirrors real GitLab's own two documented failure modes: `ref` not existing (404)
    // and `branch` already existing (400 "Branch already exists").
    if (req.method === 'POST' && rest === '/repository/branches') {
      const branchName = url.searchParams.get('branch')
      const fromName = url.searchParams.get('ref')
      if (!branchName || !fromName) return json(400, { message: 'branch and ref are required' })
      if (branchTips.has(branchName)) {
        return json(400, { message: 'Branch already exists' })
      }
      const fromTip = branchTips.get(fromName)
      if (!fromTip) return json(404, { message: `404 Branch Not Found (fake: "${fromName}")` })
      branches.set(branchName, new Map(branches.get(fromName)))
      branchTips.set(branchName, fromTip)
      return json(201, { name: branchName, commit: { id: fromTip.commitId, committed_date: fromTip.committedDate } })
    }

    // POST /projects/:id/repository/commits — GitLab's Commits API: several file `actions`
    // (create/update/delete) landed as a single commit. A `branch` that doesn't exist yet is accepted
    // as this project's very first commit only when the project is otherwise completely empty (no
    // branch has ever existed) — GitLab's own real behaviour for an empty project; any other
    // nonexistent `branch` here is a caller error this fake refuses with 400, the same shape a real,
    // non-empty GitLab project would refuse it with for lacking `start_branch`.
    if (req.method === 'POST' && rest === '/repository/commits') {
      const body = await readJsonBody(req)
      const { branch, actions = [] } = body
      if (!branch) return json(400, { message: 'branch is required' })
      if (!actions.length) return json(400, { message: "You can't commit an empty changelist" })

      let store = branches.get(branch)
      if (!store) {
        if (branches.size > 0) {
          return json(400, { message: `404 Branch Not Found (fake: "${branch}" does not exist and project is not empty — pass start_branch)` })
        }
        store = new Map()
        branches.set(branch, store)
      }

      for (const action of actions) {
        const key = action.file_path.startsWith('/') ? action.file_path : `/${action.file_path}`
        if (action.action === 'delete') {
          store.delete(key)
          continue
        }
        const content = Buffer.from(action.content, action.encoding === 'base64' ? 'base64' : 'utf8')
        store.set(key, content)
      }

      commitCounter += 1
      const date = new Date().toISOString()
      const commit = { commitId: `fake-commit-${commitCounter}`, committedDate: date, authoredDate: date }
      branchTips.set(branch, commit)
      return json(201, { id: commit.commitId, short_id: commit.commitId, committed_date: commit.committedDate, authored_date: commit.authoredDate })
    }

    return json(404, { message: `No fake route for ${req.method} ${rawPathname}` })
  })
}

/** Starts a `createFakeGitLabServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeGitHubServer.js`'s own `withFakeGitHubServer` shape. */
export function withFakeGitLabServer({ namespace, repository, validPat, files, branchFiles, repoExists }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeGitLabServer({ namespace, repository, validPat, files, branchFiles, repoExists })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}/api/v4`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

export const GITLAB_NAMESPACE = 'fake-group/fake-subgroup'
export const GITLAB_REPOSITORY = 'fake-repo'
export const GITLAB_VALID_PAT = 'valid-gitlab-test-pat'
