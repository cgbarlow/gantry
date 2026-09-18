import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the GitHub REST API, standing in for a real `api.github.com`
 * owner/repo in tests (#19) — a real HTTP server on an ephemeral port that `lib/gitHubClient.js`
 * talks to over real `fetch` calls, never a mock of `fetch` itself. Mirrors
 * `tests/helpers/fakeAzureDevOpsServer.js`'s own shape and scope: currently the Contents API (get a
 * file, list a folder) and the Repository metadata endpoint (`repoExists`) — the read-only subset
 * `lib/gitHubClient.js` implements for #19's library-repo use. Extended by later tickets (#11-#18)
 * as `lib/gitHubClient.js` grows branches/commits/pull-requests/issues/labels/collaborators.
 *
 * `files` seeds `main`'s initial content, keyed by repo-relative path (leading "/" optional).
 * `branchFiles`, if given, seeds one or more other branches the same way. `validPat` is the PAT (or,
 * if an array, any one of several) accepted as the bearer token — anything else, or no Authorization
 * header at all, gets a 401, mirroring a rejected PAT surfacing from the real API. `repoExists`
 * (default `true`) controls whether `GET /repos/{owner}/{repo}` reports the repository as existing —
 * `false` simulates a nonexistent (or PAT-invisible) GitHub repository, mirroring
 * `fakeAzureDevOpsServer.js`'s identical option for `lib/repoCheck.js`-style tests.
 */
export function createFakeGitHubServer({ owner, repository, validPat, files = {}, branchFiles = {}, repoExists = true } = {}) {
  const branches = new Map()

  function seedBranch(name, seedFiles) {
    const entries = Object.entries(seedFiles)
    const store = new Map(entries.map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, content]))
    branches.set(name, store)
  }
  seedBranch('main', files)
  for (const [branchName, seedFiles] of Object.entries(branchFiles)) {
    seedBranch(branchName, seedFiles)
  }

  const repoBasePath = `/repos/${owner}/${repository}`

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

    // GET the repository metadata itself — lib/gitHubClient.js's repoExists() calls this.
    if (req.method === 'GET' && pathname === repoBasePath) {
      if (!repoExists) {
        return json(404, { message: 'Not Found (fake server)' })
      }
      return json(200, { name: repository, full_name: `${owner}/${repository}`, default_branch: 'main' })
    }

    // Contents API — GET /repos/{owner}/{repo}/contents/{path}?ref={branch}, one route for both a
    // single file (object response) and a folder listing (array response), exactly like the real API.
    if (req.method === 'GET' && pathname.startsWith(`${repoBasePath}/contents`)) {
      const branchName = url.searchParams.get('ref') ?? 'main'
      const store = branches.get(branchName) ?? new Map()
      const scopePath = pathname.slice(`${repoBasePath}/contents`.length).replace(/^\/+/, '')
      const normalizedScope = scopePath === '' ? '' : scopePath.replace(/\/+$/, '')

      // A single file at exactly this path.
      if (store.has(`/${normalizedScope}`)) {
        const content = store.get(`/${normalizedScope}`)
        return json(200, {
          type: 'file',
          name: normalizedScope.split('/').pop(),
          path: normalizedScope,
          content: Buffer.from(content, 'utf8').toString('base64'),
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

    return json(404, { message: `No fake route for ${req.method} ${pathname}` })
  })
}

/** Starts a `createFakeGitHubServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeAzureDevOpsServer.js`'s own `withFakeAzureDevOpsServer` shape. */
export function withFakeGitHubServer({ owner, repository, validPat, files, branchFiles, repoExists }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeGitHubServer({ owner, repository, validPat, files, branchFiles, repoExists })
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
