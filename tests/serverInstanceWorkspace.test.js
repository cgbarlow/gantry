import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'

// GET /api/instance/workspace (#104): the small, registry-only lookup the
// client-side request layer (web/lib/apiFetch.js's `apiFetchForInstance`)
// asks *before* deciding which PAT to attach to a request that actually
// touches Azure DevOps for a given slug — see lib/instanceRegistry.js's
// `resolveInstanceWorkspaceId` for why this is a separate function/route
// rather than a new field on the existing `resolveInstanceLocation`/`GET
// /api/instances` shapes.

function withRunningServer(options, fn) {
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

function withScratchServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir }, (base) => fn(base, instancesDir)).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

test('GET /api/instance/workspace?slug=<local> reports workspaceId: null, with no PAT required', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    const res = await fetch(`${base}/api/instance/workspace?slug=my-initiative`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { workspaceId: null })
  })
})

test('GET /api/instance/workspace?slug=<azureDevOps> reports the real workspace id it was registered against', async () => {
  await withScratchServer(async (base, instancesDir) => {
    registerInstance(
      'remote-initiative',
      { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      { instancesDir }
    )

    const res = await fetch(`${base}/api/instance/workspace?slug=remote-initiative`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.workspaceId, 'string')
  })
})

test('GET /api/instance/workspace?slug=<unknown> reports workspaceId: null rather than an error', async () => {
  await withScratchServer(async (base) => {
    const res = await fetch(`${base}/api/instance/workspace?slug=never-heard-of-it`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { workspaceId: null })
  })
})

test('GET /api/instance/workspace with no slug given (no default, no query param) reports 400, not a crash', async () => {
  await withScratchServer(async (base) => {
    const res = await fetch(`${base}/api/instance/workspace`)
    assert.equal(res.status, 400)
  })
})

test('GET /api/instance/workspace?slug=<traversal> is rejected with 400', async () => {
  await withScratchServer(async (base) => {
    const res = await fetch(`${base}/api/instance/workspace?slug=${encodeURIComponent('../../etc/passwd')}`)
    assert.equal(res.status, 400)
  })
})
