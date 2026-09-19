import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the GitLab REST API v4, standing in for a real `gitlab.com/api/v4`
 * (or self-hosted CE/EE) namespace/repository in tests (#27) — a real HTTP server on an ephemeral
 * port that `lib/gitlabClient.js` talks to over real `fetch` calls, never a mock of `fetch` itself.
 * Mirrors `tests/helpers/fakeGitHubServer.js`'s own shape and conventions so the fakes read the same
 * way to a caller working across providers.
 *
 * Covers the subset `lib/gitlabClient.js` implements today (#27's read-only scope, ADR-0041): the
 * Repository Files "raw" endpoint (`GET /projects/:id/repository/files/:file_path/raw`) that
 * `lib/definitionGitLab.js` reads a library repo's `definitions/` folder over, and the Repository
 * Tree endpoint (`GET /projects/:id/repository/tree`) that same module lists folders with. `:id` is
 * always the URL-encoded `namespace/repository` full-path form gantry addresses a project by — this
 * fake never invents or accepts a numeric project id.
 *
 * `files` seeds the branch's flat file map, keyed by repo-relative path (leading "/" optional).
 * `validPat` is the PAT (or, if an array, any one of several) accepted in the `PRIVATE-TOKEN` header
 * GitLab itself expects — anything else, or a missing header, gets a 401, mirroring a rejected PAT's
 * real shape.
 */
export function createFakeGitLabServer({ namespace, repository, validPat, files = {} } = {}) {
  const store = new Map(
    Object.entries(files).map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')])
  )

  const projectId = `${namespace}/${repository}`
  const projectBasePath = `/projects/${encodeURIComponent(projectId)}`

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-gitlab.invalid')
    // Deliberately *not* decoded here (unlike fakeGitHubServer.js's own `pathname`): GitLab's own
    // `:id` path parameter is itself a percent-encoded `namespace%2Frepository` segment (real slashes
    // inside it are part of the encoding, not path separators), so decoding the whole pathname up
    // front would collapse those `%2F`s into real `/`s and break every route match below. Each route
    // matches against the still-encoded `projectBasePath` computed the same way, and decodes only the
    // one captured segment (a file path) that's actually meant to come back out as text.
    const pathname = url.pathname
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const providedPat = req.headers['private-token']
    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    if (!validPats.includes(providedPat)) {
      return json(401, { message: '401 Unauthorized (fake server: invalid or missing PRIVATE-TOKEN)' })
    }

    // GET /projects/:id/repository/files/:file_path/raw?ref=branch — a single file's raw bytes.
    const rawMatch = pathname.match(new RegExp(`^${projectBasePath}/repository/files/([^/]+)/raw$`))
    if (req.method === 'GET' && rawMatch) {
      const filePath = decodeURIComponent(rawMatch[1])
      const key = `/${filePath}`
      if (!store.has(key)) {
        return json(404, { message: '404 File Not Found' })
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(store.get(key))
      return
    }

    // GET /projects/:id/repository/tree?path=X&ref=Y&per_page=100 — lists immediate children of
    // `path` (repo root when omitted). Real GitLab returns `200 []` for a valid ref with nothing at
    // that path, mirrored here — there is no "folder not found" error case, only a missing ref.
    if (req.method === 'GET' && pathname === `${projectBasePath}/repository/tree`) {
      const scopePath = url.searchParams.get('path') ?? ''
      const prefix = scopePath === '' ? '/' : `/${scopePath.replace(/\/+$/, '')}/`
      const children = new Map() // name -> isFolder
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [name, ...more] = rest.split('/')
        const isFolder = more.length > 0
        children.set(name, (children.get(name) ?? false) || isFolder)
      }
      const value = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, isFolder]) => ({
          id: `fake-${name}`,
          name,
          type: isFolder ? 'tree' : 'blob',
          path: scopePath === '' ? name : `${scopePath}/${name}`,
          mode: isFolder ? '040000' : '100644',
        }))
      return json(200, value)
    }

    return json(404, { message: `No fake route for ${req.method} ${pathname}` })
  })
}

/** Starts a `createFakeGitLabServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeGitHubServer.js`'s own `withFakeGitHubServer` shape. */
export function withFakeGitLabServer({ namespace, repository, validPat, files }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeGitLabServer({ namespace, repository, validPat, files })
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

export const GITLAB_NAMESPACE = 'fake-group'
export const GITLAB_REPOSITORY = 'fake-repo'
export const GITLAB_VALID_PAT = 'valid-gitlab-test-pat'
