import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { BlobServiceClient } from '@azure/storage-blob'
import { createBlobStorage } from '../lib/blobStorage.js'
import { parseDecisionsLog } from '../web/lib/decisionsLog.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'

// #288 (parent #238, docs/adr/0064, 0070): the decisions log on a server workspace kept in a Blob container, against Azurite. The disk
// server's tests are tests/decisionsLogRoutes.test.js.

const json = { 'Content-Type': 'application/json' }
const put = (base, path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const BACKGROUND = { status: 'draft', owner: '', fields: { problem: 'Claims take too long.', 'affected-domains': ['Claims'], opportunity: '' } }
const answer = (id, over = {}) => ({ id, kind: 'answer', at: '2026-11-02T10:00:00.000Z', session: 's-1', question: `Question ${id}`, answer: ['Yes'], fields: ['background.problem'], ...over })
const delta = (entries) => ({ status: { session: 's-1', who: 'a.architect', target: 'shape', state: 'in-progress' }, fields: {}, entries })

// ---------- a Blob container ----------

const skip = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'
after(stopAzurite)

describe('the decisions log in a Blob container', { skip }, () => {
  test('is written in the same all-or-nothing Save as the Modules, and read back', { timeout: 280000 }, async () => {
    await withAzurite(async (emulator) => {
      const name = `d${Date.now().toString(36)}`
      const client = BlobServiceClient.fromConnectionString(emulator.connectionString).getContainerClient(name)
      await client.createIfNotExists()
      const storage = createBlobStorage(client)
      await withScratchInstances(async (dir) => {
        await withRunningServer(
          {
            instancesDir: dir,
            blobContainers: JSON.stringify([{ name: 'main', url: emulator.containerUrl(name), credentialType: 'connection-string', secretEnv: 'GANTRY_TEST_BLOB_CS' }]),
            env: { ...process.env, GANTRY_TEST_BLOB_CS: emulator.connectionString },
            blobRefreshMs: 0,
          },
          async (base) => {
            const created = await fetch(`${base}/api/server-workspaces`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Cloud Team', description: 'In the cloud', storage: 'blob', container: 'main' }) })
            const workspace = await created.json()
            const made = await fetch(`${base}/api/instances`, { method: 'POST', headers: json, body: JSON.stringify({ definition: 'design', slug: 'cards', definitionVersion: 2, serverWorkspace: workspace.id }) })
            const row = await made.json()

            const res = await put(base, `/api/instance/modules?ref=${row.ref}`, { modules: { background: BACKGROUND }, decisions: delta([answer('s-1-1')]) })
            assert.equal(res.status, 200)
            assert.match((await storage.getText('cloud-team/cards/modules/background.md')).text, /Claims take too long/)
            const log = parseDecisionsLog((await storage.getText('cloud-team/cards/interview/shape.yaml')).text, 'shape')
            assert.deepEqual(log.entries.map((e) => e.id), ['s-1-1'])

            const read = await (await fetch(`${base}/api/instance/decisions?ref=${row.ref}&stage=shape`)).json()
            assert.deepEqual(read.log, log)

            const refused = await put(base, `/api/instance/decisions?ref=${row.ref}`, { decisions: delta([answer('s-1-1', { answer: ['No'] })]) })
            assert.equal(refused.status, 409)
          }
        )
      })
    })
  })
})
