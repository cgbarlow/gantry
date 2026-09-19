import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../../lib/server.js'
import { withFakeAzureDevOpsServer } from './fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './fakeGitLabServer.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './fakeBitbucketServer.js'
import { withFakeJiraServer, JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './fakeJiraServer.js'

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
export { BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT }
export { JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT }

/**
 * Stands up a real gantry server (`withRunningServer`) alongside a real fake provider server
 * (`withFakeAzureDevOpsServer`, `withFakeGitHubServer` or `withFakeGitLabServer`) for the duration of
 * `fn(ctx)`, closing both afterwards — the "provider-aware test lifecycle" #8's own acceptance criteria
 * calls for, so a route suite can stand up the exact same shape of fixture against either provider
 * rather than duplicating this wiring per provider. `provider` is `'azure-devops'` (default), `'github'`
 * or `'gitlab'`.
 *
 * `ctx` passed to `fn` is `{ gantryBase, providerBaseUrl, provider, pat, ...location }` — `location`
 * is `{ organization, project, repository }` for azure-devops, `{ owner, repository }` for github,
 * `{ namespace, repository }` for gitlab, so a caller writes `ctx.repository` either way and only
 * branches on the fields that genuinely differ. The fake provider server's own `baseUrl` is
 * pre-allowed on the gantry server it starts (via `allowedAzureDevOpsBaseUrls` /
 * `allowGitHubBaseUrlOverride` / `allowGitLabBaseUrlOverride`, whichever the chosen provider needs) —
 * a real deployment sets none of these, so this is only ever exercised by tests. `options` is
 * forwarded to `withRunningServer` (e.g. `instancesDir`); `fakeServerOptions` is forwarded to the fake
 * provider server (e.g. `files` for azure-devops, `repoExists` for any of the three).
 */
export function withRunningServerForProvider(provider, { options, fakeServerOptions } = {}, fn) {
  if (provider === 'atlassian') {
    // #48 (ADR-0042): the split-suite twin of the branches below — two real fake servers (Bitbucket
    // Cloud content store, Jira Cloud work items), each pointed at by the running gantry server's own
    // test-only `atlassianBitbucketBaseUrl`/`atlassianJiraBaseUrl` startup options (never a
    // caller-supplied `baseUrl`, unlike every other provider here — see `lib/server.js`'s own doc
    // comment on those two options for why). `ctx` carries both fake servers' own `baseUrl`s
    // (`providerBaseUrl` for Bitbucket, `jiraBaseUrl` for Jira) and both tokens (`pat` for Bitbucket,
    // `jiraPat` for Jira) — a caller writes `ctx.repository` the same way every other provider's own
    // `ctx` already lets it, and reaches for `ctx.jiraSite`/`ctx.jiraProjectKey`/`ctx.jiraPat` for the
    // half no other provider here has.
    const { bitbucketFakeServerOptions, jiraFakeServerOptions } = fakeServerOptions ?? {}
    return withFakeBitbucketServer(
      { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, ...bitbucketFakeServerOptions },
      (providerBaseUrl) =>
        withFakeJiraServer(
          { jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT, ...jiraFakeServerOptions },
          (jiraBaseUrl) =>
            withRunningServer(
              { atlassianBitbucketBaseUrl: providerBaseUrl, atlassianJiraBaseUrl: jiraBaseUrl, ...options },
              (gantryBase) =>
                fn({
                  gantryBase,
                  providerBaseUrl,
                  jiraBaseUrl,
                  provider: 'atlassian',
                  owner: BITBUCKET_OWNER,
                  repository: BITBUCKET_REPOSITORY,
                  jiraSite: JIRA_SITE,
                  jiraProjectKey: JIRA_PROJECT_KEY,
                  pat: BITBUCKET_VALID_PAT,
                  jiraPat: JIRA_VALID_PAT,
                })
            )
        )
    )
  }
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
    // `allowGitLabBaseUrlOverride: true` (#30) is needed for the work-items/link route's own SSRF
    // guard against this fixture's baseUrl; harmless for callers (like #31's asset/render tests) that
    // don't exercise that route.
    return withFakeGitLabServer(
      { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, ...fakeServerOptions },
      (providerBaseUrl) =>
        withRunningServer({ allowGitLabBaseUrlOverride: true, ...options }, (gantryBase) =>
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
