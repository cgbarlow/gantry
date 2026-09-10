import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../../lib/server.js'

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
 * `withRunningServer`, pre-seeded with a scratch copy of the real bundled `instances/examples`
 * fixture (WI #356: this repo's real `instances/` directory must never be read as a live server
 * root by the test suite — it's still bare/pre-migration until Feature #358 moves it under
 * `workspaces/examples/`, and pointing a real server at it directly would migrate it in place,
 * leaving the checked-out working tree dirty). A read-only `cpSync` into a fresh temp directory
 * gives every caller the fixture's full real content with none of that risk; auto-migration then
 * runs on it exactly as `withRunningServer` already does for any other explicit `instancesDir`.
 * `fn` receives the running server's base URL, same as `withRunningServer` itself.
 */
export async function withRunningExamplesServer(options, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
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
