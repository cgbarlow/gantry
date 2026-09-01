import { mkdtempSync, rmSync } from 'node:fs'
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
 */
export function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
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
