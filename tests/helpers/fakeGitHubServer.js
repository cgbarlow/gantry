import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the GitHub REST API, standing in for a real `api.github.com` (or
 * GitHub Enterprise Server) owner/repository in tests (#8) — a real HTTP server on an ephemeral port
 * that lib/githubClient.js talks to over real `fetch` calls, never a mock of `fetch` itself. Mirrors
 * tests/helpers/fakeAzureDevOpsServer.js's own shape and conventions (see that file's doc comment)
 * so the two fakes read the same way to a caller working across both providers.
 *
 * Covers only what #8 needs today: the repository-metadata endpoint (`GET /repos/:owner/:repo`) that
 * `checkGitHubRepo`/`createGitHubClient().getRepo()` call to prove a PAT reaches a real repository
 * before a workspace is registered. Later tickets (#11 content store, #13 pull requests, #14 work
 * items, #15 review labels, #10 identity) extend this the same incremental way #99/#118/#120 extended
 * the Azure DevOps fake — new endpoints added here as the GitHub client itself grows them, never a
 * parallel second fake.
 *
 * `validPat` is the PAT (or, if an array, any one of several) accepted in the
 * `Authorization: Bearer <pat>` header GitHub itself expects — anything else, or a missing/malformed
 * header, gets a 401, mirroring a rejected PAT's real shape.
 *
 * `repoExists` (default `true`) controls whether `GET /repos/:owner/:repo` reports the repository as
 * existing. `false` returns 404, simulating both a genuinely nonexistent repository and — per
 * docs/adr/0040's own noted trap — a fine-grained PAT with insufficient scope against a repo it can't
 * see, which GitHub itself also reports as 404 rather than 403.
 */
export function createFakeGitHubServer({ owner, repository, validPat, repoExists = true } = {}) {
  const repoPath = `/repos/${owner}/${repository}`
  const validPats = Array.isArray(validPat) ? validPat : [validPat]

  return createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-github.invalid')
    const pathname = decodeURIComponent(url.pathname)
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const authHeader = req.headers['authorization'] ?? ''
    const [scheme, token] = authHeader.split(' ')
    const providedPat = scheme?.toLowerCase() === 'bearer' ? token : undefined
    if (!validPats.includes(providedPat)) {
      return json(401, { message: 'Bad credentials (fake: invalid or missing PAT)' })
    }

    if (req.method === 'GET' && pathname === repoPath) {
      if (!repoExists) {
        return json(404, { message: 'Not Found (fake: repository does not exist, or PAT scope insufficient to see it)' })
      }
      return json(200, {
        id: 1,
        name: repository,
        full_name: `${owner}/${repository}`,
        owner: { login: owner },
        default_branch: 'main',
      })
    }

    return json(404, { message: `Not Found (fake: no route for ${req.method} ${pathname})` })
  })
}

/**
 * Starts a `createFakeGitHubServer` on an ephemeral port for the duration of `fn(baseUrl)`, then
 * closes it — mirrors tests/helpers/fakeAzureDevOpsServer.js's own `withFakeAzureDevOpsServer` shape,
 * so both providers' fakes are driven the same way from a test.
 */
export function withFakeGitHubServer({ owner, repository, validPat, repoExists }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeGitHubServer({ owner, repository, validPat, repoExists })
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
