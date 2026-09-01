import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { registerWorkspace, isWorkspaceArchived } from '../lib/workspaceRegistry.js'
import { registerInstance, isInstanceArchived } from '../lib/instanceRegistry.js'
import { withRunningServer } from './helpers/lifecycle.js'

// POST /api/workspace/archive|restore and POST /api/instance/archive|restore (#223): the
// HTTP-API-boundary half of the archive/restore acceptance criteria — exercised as real HTTP
// requests against a real running server, mirroring tests/serverWorkspaces.test.js. None of these
// routes consult a PAT (archived-ness is registry metadata), so no fake Azure DevOps server is
// needed here.


function withScratchServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir }, (base) => fn(base, instancesDir)).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

function postJSON(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const LOCATION = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }

// ---------- POST /api/instance/archive ----------

test('POST /api/instance/archive archives a known instance and is reflected on disk', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'alpha-initiative', { instancesDir })

    const res = await postJSON(base, '/api/instance/archive', { slug: 'alpha-initiative' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      slug: 'alpha-initiative',
      location: { kind: 'local' },
      archived: true,
    })
    assert.equal(isInstanceArchived('alpha-initiative', { instancesDir }), true)
  })
})

test('POST /api/instance/archive is idempotent for an already-archived instance', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'alpha-initiative', { instancesDir })
    await postJSON(base, '/api/instance/archive', { slug: 'alpha-initiative' })

    const res = await postJSON(base, '/api/instance/archive', { slug: 'alpha-initiative' })
    assert.equal(res.status, 200)
    assert.equal(isInstanceArchived('alpha-initiative', { instancesDir }), true)
  })
})

test('POST /api/instance/archive 404s for an unknown instance', async () => {
  await withScratchServer(async (base) => {
    const res = await postJSON(base, '/api/instance/archive', { slug: 'nowhere' })
    assert.equal(res.status, 404)
    assert.match((await res.json()).error, /Unknown instance/)
  })
})

test('POST /api/instance/archive 400s for an invalid slug', async () => {
  await withScratchServer(async (base) => {
    const res = await postJSON(base, '/api/instance/archive', { slug: '../evil' })
    assert.equal(res.status, 400)
  })
})

// ---------- POST /api/instance/restore ----------

test('POST /api/instance/restore returns an archived instance to exactly its prior state', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'alpha-initiative', { instancesDir })
    await postJSON(base, '/api/instance/archive', { slug: 'alpha-initiative' })

    const res = await postJSON(base, '/api/instance/restore', { slug: 'alpha-initiative' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      slug: 'alpha-initiative',
      location: { kind: 'local' },
      archived: false,
    })
    assert.equal(isInstanceArchived('alpha-initiative', { instancesDir }), false)
  })
})

test('POST /api/instance/restore is idempotent, and 404s for an unknown instance', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'alpha-initiative', { instancesDir })
    const ok = await postJSON(base, '/api/instance/restore', { slug: 'alpha-initiative' })
    assert.equal(ok.status, 200)

    const missing = await postJSON(base, '/api/instance/restore', { slug: 'nowhere' })
    assert.equal(missing.status, 404)
  })
})

// ---------- archived instance still resolves read-only ----------

test('an archived instance still resolves at GET /api/instance, flagged archived: true (read-only-resolves, #223)', async () => {
  await withScratchServer(async (base) => {
    await postJSON(base, '/api/instances', { definition: 'design', slug: 'alpha-initiative' })
    await postJSON(base, '/api/instance/archive', { slug: 'alpha-initiative' })

    const res = await fetch(`${base}/api/instance?slug=alpha-initiative`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.archived, true)
    assert.equal(body.slug, 'alpha-initiative')

    // A non-archived instance reports archived: false.
    await postJSON(base, '/api/instances', { definition: 'design', slug: 'beta-initiative' })
    const active = await (await fetch(`${base}/api/instance?slug=beta-initiative`)).json()
    assert.equal(active.archived, false)
  })
})

// ---------- GET /api/instances filtering ----------

test('GET /api/instances hides archived instances by default and shows them with ?archived=1', async () => {
  await withScratchServer(async (base) => {
    await postJSON(base, '/api/instances', { definition: 'design', slug: 'alpha-initiative' })
    await postJSON(base, '/api/instances', { definition: 'design', slug: 'zebra-initiative' })
    await postJSON(base, '/api/instance/archive', { slug: 'zebra-initiative' })

    const dflt = await (await fetch(`${base}/api/instances`)).json()
    assert.deepEqual(dflt.map((i) => i.slug), ['alpha-initiative'])
    assert.equal('archived' in dflt[0], false)

    const withArchived = await (await fetch(`${base}/api/instances?archived=1`)).json()
    assert.deepEqual(
      withArchived.map((i) => ({ slug: i.slug, archived: i.archived })),
      [
        { slug: 'alpha-initiative', archived: false },
        { slug: 'zebra-initiative', archived: true },
      ]
    )
  })
})

// ---------- POST /api/workspace/archive ----------

test('POST /api/workspace/archive archives a workspace with no active instances', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const ws = registerWorkspace(LOCATION, { instancesDir })

    const res = await postJSON(base, '/api/workspace/archive', { workspaceId: ws.id })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).archived, true)
    assert.equal(isWorkspaceArchived(ws.id, { instancesDir }), true)

    // Hidden from the default workspace listing, visible via includeArchived.
    const listed = await (await fetch(`${base}/api/workspaces`)).json()
    assert.equal(listed.find((w) => w.id === ws.id), undefined)
  })
})

test('POST /api/workspace/archive is BLOCKED (409) while the workspace still has an active instance (#223 decision)', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const ws = registerWorkspace(LOCATION, { instancesDir })
    registerInstance('remote-initiative', { kind: 'azureDevOps', workspaceId: ws.id }, { instancesDir })

    const blocked = await postJSON(base, '/api/workspace/archive', { workspaceId: ws.id })
    assert.equal(blocked.status, 409)
    assert.match((await blocked.json()).error, /still has 1 active instance \(remote-initiative\)/)
    assert.equal(isWorkspaceArchived(ws.id, { instancesDir }), false)

    // Archive the instance first, then the workspace archives fine.
    await postJSON(base, '/api/instance/archive', { slug: 'remote-initiative' })
    const ok = await postJSON(base, '/api/workspace/archive', { workspaceId: ws.id })
    assert.equal(ok.status, 200)
    assert.equal(isWorkspaceArchived(ws.id, { instancesDir }), true)
  })
})

test('POST /api/workspace/archive is idempotent, 404s for an unknown id, and 400s with no workspaceId', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const ws = registerWorkspace(LOCATION, { instancesDir })
    await postJSON(base, '/api/workspace/archive', { workspaceId: ws.id })
    const again = await postJSON(base, '/api/workspace/archive', { workspaceId: ws.id })
    assert.equal(again.status, 200)

    assert.equal((await postJSON(base, '/api/workspace/archive', { workspaceId: 'nowhere' })).status, 404)
    assert.equal((await postJSON(base, '/api/workspace/archive', {})).status, 400)
  })
})

// ---------- POST /api/workspace/restore ----------

test('POST /api/workspace/restore returns an archived workspace to exactly its prior state', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const ws = registerWorkspace({ ...LOCATION, owner: 'c.barlow' }, { instancesDir })
    await postJSON(base, '/api/workspace/archive', { workspaceId: ws.id })

    const res = await postJSON(base, '/api/workspace/restore', { workspaceId: ws.id })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.archived, undefined)
    assert.equal(body.owner, 'c.barlow')
    assert.equal(isWorkspaceArchived(ws.id, { instancesDir }), false)
  })
})

test('POST /api/workspace/restore is idempotent, and 404s for an unknown id', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const ws = registerWorkspace(LOCATION, { instancesDir })
    assert.equal((await postJSON(base, '/api/workspace/restore', { workspaceId: ws.id })).status, 200)
    assert.equal((await postJSON(base, '/api/workspace/restore', { workspaceId: 'nowhere' })).status, 404)
  })
})
