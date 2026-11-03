import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServerWorkspace, listServerWorkspaces, InvalidServerWorkspaceError, DuplicateServerWorkspaceError } from '../lib/workspaceDirectory.js'
import { readInstance } from '../lib/instance.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'

// #268 (docs/adr/0070): the "+ New Workspace" wizard's "New server workspace" creates a real server
// workspace on the server's disk. Unit tests for the folder primitive first, then the HTTP routes: create
// a workspace, create an instance in it, save it and advance it - the "self-serve" the ticket asks for.

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-ws-create-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('createServerWorkspace', () => {
  test('writes a workspace.json the local-workspace reader accepts, in a folder derived from the name', () => {
    withScratchDir((dir) => {
      const { id, record } = createServerWorkspace(dir, { name: 'Payments Team', description: 'Cards and ledger' })
      assert.equal(id, 'payments-team')
      assert.equal(record.name, 'Payments Team')
      assert.equal(record.description, 'Cards and ledger')
      assert.equal(record.kind, 'local')
      assert.ok(existsSync(join(dir, 'payments-team', 'workspace.json')))
      assert.deepEqual(listServerWorkspaces(dir).map((w) => w.id), ['payments-team'])
    })
  })

  test('refuses a missing or blank name, and an over-long name or description, writing nothing', () => {
    withScratchDir((dir) => {
      for (const name of [undefined, null, 42, '', '   ']) {
        assert.throws(() => createServerWorkspace(dir, { name }), InvalidServerWorkspaceError)
      }
      assert.throws(() => createServerWorkspace(dir, { name: 'x'.repeat(101) }), InvalidServerWorkspaceError)
      assert.throws(() => createServerWorkspace(dir, { name: 'ok', description: 7 }), InvalidServerWorkspaceError)
      assert.throws(() => createServerWorkspace(dir, { name: 'ok', description: 'x'.repeat(501) }), InvalidServerWorkspaceError)
      assert.deepEqual(listServerWorkspaces(dir), [])
    })
  })

  test('refuses a name already in use, compared without case, and suffixes a folder that is merely taken', () => {
    withScratchDir((dir) => {
      createServerWorkspace(dir, { name: 'Risk Register' })
      assert.throws(() => createServerWorkspace(dir, { name: '  risk register ' }), DuplicateServerWorkspaceError)
      // "Risk-Register" is a different name that derives the same folder.
      const second = createServerWorkspace(dir, { name: 'Risk-Register' })
      assert.equal(second.id, 'risk-register-2')
      const third = createServerWorkspace(dir, { name: 'Risk  Register!' })
      assert.equal(third.id, 'risk-register-3')
    })
  })

  test('never hands out the reserved default folder, and gives a name with nothing usable in it a folder anyway', () => {
    withScratchDir((dir) => {
      assert.equal(createServerWorkspace(dir, { name: 'Default' }).id, 'default-2')
      assert.equal(createServerWorkspace(dir, { name: 'Examples' }).id, 'examples-2')
      assert.equal(createServerWorkspace(dir, { name: '!!!' }).id, 'workspace')
    })
  })
})

async function postJSON(base, path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

describe('POST /api/server-workspaces', () => {
  test('creates a workspace that GET /api/server-workspaces lists, with a short number', async () => {
    await withScratchInstances(async (instancesDir) => {
      await withRunningServer({ instancesDir }, async (base) => {
        const res = await postJSON(base, '/api/server-workspaces', { name: 'Payments Team' })
        assert.equal(res.status, 201)
        const body = await res.json()
        assert.equal(body.id, 'payments-team')
        assert.equal(body.name, 'Payments Team')
        assert.equal(body.storage, 'disk')
        assert.equal(typeof body.number, 'number')
        assert.ok(existsSync(join(instancesDir, 'payments-team', 'workspace.json')))

        const listed = await (await fetch(`${base}/api/server-workspaces`)).json()
        assert.ok(listed.some((w) => w.id === 'payments-team' && w.name === 'Payments Team'))
      })
    })
  })

  test('answers 400 for a blank name and for storage it does not offer, and 409 for a name in use', async () => {
    await withScratchInstances(async (instancesDir) => {
      await withRunningServer({ instancesDir }, async (base) => {
        assert.equal((await postJSON(base, '/api/server-workspaces', { name: '  ' })).status, 400)
        const blob = await postJSON(base, '/api/server-workspaces', { name: 'Blobby', storage: 'blob' })
        assert.equal(blob.status, 400)
        assert.match((await blob.json()).error, /storage.*Blob container/i)
        const tape = await postJSON(base, '/api/server-workspaces', { name: 'Tape', storage: 'tape' })
        assert.equal(tape.status, 400)
        assert.match((await tape.json()).error, /Unknown storage/i)
        assert.equal((await postJSON(base, '/api/server-workspaces', { name: 'Once' })).status, 201)
        assert.equal((await postJSON(base, '/api/server-workspaces', { name: 'once' })).status, 409)
      })
    })
  })
})

const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']

describe('an instance in a created server workspace', () => {
  test('can be created, saved and advanced, and its slug is unique within its own workspace only', async () => {
    await withScratchInstances(async (instancesDir) => {
      await withRunningServer({ instancesDir }, async (base) => {
        const ws = await (await postJSON(base, '/api/server-workspaces', { name: 'Payments Team' })).json()

        const created = await postJSON(base, '/api/instances', { definition: 'design', slug: 'cards', serverWorkspace: ws.id })
        assert.equal(created.status, 201)
        const row = await created.json()
        assert.equal(row.slug, 'cards')
        assert.equal(row.workspace.kind, 'directory')
        assert.equal(row.workspace.id, ws.id)
        assert.equal(row.workspace.name, 'Payments Team')
        assert.match(row.ref, /^w\d+i1$/)
        assert.ok(existsSync(join(instancesDir, ws.id, 'cards', 'instance.yaml')))

        // The same slug in the same workspace is refused; in another workspace it is fine (docs/adr/0031).
        assert.equal((await postJSON(base, '/api/instances', { definition: 'design', slug: 'cards', serverWorkspace: ws.id })).status, 409)
        const other = await (await postJSON(base, '/api/server-workspaces', { name: 'Ledger Team' })).json()
        const twin = await postJSON(base, '/api/instances', { definition: 'design', slug: 'cards', serverWorkspace: other.id })
        assert.equal(twin.status, 201)
        assert.equal((await twin.json()).workspace.id, other.id)

        // It lists under its workspace on the dashboard's feed.
        const listed = await (await fetch(`${base}/api/instances`)).json()
        assert.deepEqual(listed.filter((i) => i.slug === 'cards').map((i) => i.workspace.id).sort(), [ws.id, other.id].sort())

        // Save a Module, addressed by its numeric ref.
        const save = await fetch(`${base}/api/instance/modules/background?ref=${row.ref}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'agreed', owner: 'c.barlow', fields: { problem: 'Cards settle slowly.', 'affected-domains': ['Payments'], opportunity: '' } }),
        })
        assert.equal(save.status, 200)
        assert.match(readFileSync(join(instancesDir, ws.id, 'cards', 'modules', 'background.md'), 'utf8'), /Cards settle slowly/)

        // Advance: refused until the gate passes, then allowed, with no branches or approvals involved.
        const early = await fetch(`${base}/api/instance/advance-stage?ref=${row.ref}`, { method: 'POST' })
        assert.equal(early.status, 400)
        for (const moduleId of SHAPE_MODULES) {
          cpSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), join(instancesDir, ws.id, 'cards', 'modules', `${moduleId}.md`))
        }
        const advanced = await fetch(`${base}/api/instance/advance-stage?ref=${row.ref}`, { method: 'POST' })
        assert.equal(advanced.status, 200)
        assert.equal((await advanced.json()).toStage.id, 'hld-define')
        assert.equal(readInstance('cards', { instancesDir: join(instancesDir, ws.id) }).stage, 'hld-define')
        // The twin in the other workspace did not move.
        assert.equal(readInstance('cards', { instancesDir: join(instancesDir, other.id) }).stage, 'shape')
      })
    })
  })

  test('is refused for a server workspace that does not exist, and when combined with a Provider location', async () => {
    await withScratchInstances(async (instancesDir) => {
      await withRunningServer({ instancesDir }, async (base) => {
        const missing = await postJSON(base, '/api/instances', { definition: 'design', slug: 'x', serverWorkspace: 'nope' })
        assert.equal(missing.status, 404)
        assert.match((await missing.json()).error, /Unknown server workspace/)
        const mixed = await postJSON(base, '/api/instances', {
          definition: 'design',
          slug: 'x',
          serverWorkspace: 'default',
          github: { owner: 'o', repository: 'r' },
        })
        assert.equal(mixed.status, 400)
      })
    })
  })

  test('still defaults to the reserved default workspace when no serverWorkspace is named', async () => {
    await withScratchInstances(async (instancesDir) => {
      await withRunningServer({ instancesDir }, async (base) => {
        const res = await postJSON(base, '/api/instances', { definition: 'design', slug: 'plain' })
        assert.equal(res.status, 201)
        assert.equal((await res.json()).workspace.id, 'default')
        assert.ok(existsSync(join(instancesDir, 'default', 'plain', 'instance.yaml')))
      })
    })
  })
})
