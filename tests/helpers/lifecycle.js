import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../../lib/server.js'
import { withFakeAzureDevOpsServer } from './fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './fakeGitLabServer.js'

/**
 * Creates a temp directory under `os.tmpdir()`, runs `fn(instancesDir)`, and
 * cleans up the directory in a `finally` block — safe for both sync and async
 * callbacks.
 */
export async function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    return await fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

/**
 * Starts a real HTTP server on an ephemeral port, runs `fn(baseUrl)`, and
 * closes the server in a `finally` block.
 *
 * WI #356: auto-migrates on start (`migrateWorkspacesOnStart: true`) whenever the caller explicitly
 * names its own `options.instancesDir` — always a scratch directory this suite creates and tears
 * down itself — so a bare, pre-#356-style fixture the test seeded directly (the pervasive
 * `createInstance('design', slug, { instancesDir })` pattern throughout this test suite) keeps
 * getting picked up, exactly as a real `gantry serve` would on first start. **Never** defaults to
 * migrating when `instancesDir` is left unset (several Playwright specs call this with `{}` —
 * they don't care about server-side instance data at all, and that omission means "point at
 * whatever `createServer` itself defaults to," which must never be silently rewritten by a test
 * run — see WI #356's own explicit instruction not to touch this repo's real `instances/` directory
 * from the test suite). Pass `migrateWorkspacesOnStart` explicitly to override either way.
 */
export function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer({ migrateWorkspacesOnStart: Boolean(options?.instancesDir), ...options })
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

/**
 * `withRunningServer`, pre-seeded with a scratch copy of the real bundled Kiwi Cover Mutual fixture
 * (`workspaces/examples/kiwi-cover-mutual`, WI #358). This repo's real `workspaces/` directory must
 * never be read as a live server root by the test suite — pointing a real server at it directly
 * would run its startup migration/registration against the checked-out working tree, leaving it
 * dirty. A read-only `cpSync` into a fresh temp directory (kept at the scratch slug `examples`,
 * matching this helper's own pre-#358 name and every existing caller's assertions) gives every
 * caller the fixture's full real content with none of that risk. `fn` receives the running server's
 * base URL, same as `withRunningServer` itself.
 */
export async function withRunningExamplesServer(options, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    await withRunningServer({ slug: 'examples', ...options, instancesDir }, fn)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

/**
 * Encodes a PAT as an HTTP Basic Authorization header value, matching the
 * `:<pat>` format Azure DevOps expects.
 */
export function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

export const ORGANIZATION = 'fake-org'
export const PROJECT = 'fake-project'
export const REPOSITORY = 'fake-repo'
export const VALID_PAT = 'valid-test-pat'

export { GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT }
export { GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT }

/**
 * Stands up a real gantry server (`withRunningServer`) alongside a real fake provider server
 * (`withFakeAzureDevOpsServer` or `withFakeGitHubServer`) for the duration of `fn(ctx)`, closing both
 * afterwards — the "provider-aware test lifecycle" #8's own acceptance criteria calls for, so a route
 * suite can stand up the exact same shape of fixture against either provider rather than duplicating
 * this wiring per provider. `provider` is `'azure-devops'` (default) or `'github'`.
 *
 * `ctx` passed to `fn` is `{ gantryBase, providerBaseUrl, provider, pat, ...location }` — `location`
 * is `{ organization, project, repository }` for azure-devops, `{ owner, repository }` for github, so
 * a caller writes `ctx.repository` either way and only branches on the fields that genuinely differ.
 * The fake provider server's own `baseUrl` is pre-allowed on the gantry server it starts (via
 * `allowedAzureDevOpsBaseUrls` / `allowGitHubBaseUrlOverride`, whichever the chosen provider needs) —
 * a real deployment sets neither, so this is only ever exercised by tests. `options` is forwarded to
 * `withRunningServer` (e.g. `instancesDir`); `fakeServerOptions` is forwarded to the fake provider
 * server (e.g. `files` for azure-devops, `repoExists` for either).
 */
export function withRunningServerForProvider(provider, { options, fakeServerOptions } = {}, fn) {
  if (provider === 'github') {
    return withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, ...fakeServerOptions },
      (providerBaseUrl) =>
        withRunningServer({ allowGitHubBaseUrlOverride: true, ...options }, (gantryBase) =>
          fn({ gantryBase, providerBaseUrl, provider, owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT })
        )
    )
  }
  if (provider === 'gitlab') {
    // #31 — the GitLab twin of the GitHub branch above: same "real fake provider server + real gantry
    // server" lifecycle, over GitLab's own `{ namespace, repository }` location fields (ADR-0041).
    return withFakeGitLabServer(
      { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, ...fakeServerOptions },
      (providerBaseUrl) =>
        withRunningServer({ ...options }, (gantryBase) =>
          fn({ gantryBase, providerBaseUrl, provider, namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT })
        )
    )
  }
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, ...fakeServerOptions },
    (providerBaseUrl) =>
      withRunningServer({ allowedAzureDevOpsBaseUrls: [providerBaseUrl], ...options }, (gantryBase) =>
        fn({
          gantryBase,
          providerBaseUrl,
          provider: 'azure-devops',
          organization: ORGANIZATION,
          project: PROJECT,
          repository: REPOSITORY,
          pat: VALID_PAT,
        })
      )
  )
}
