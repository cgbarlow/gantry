import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { BlobServiceClient } from '@azure/storage-blob'
import { parse as parseYAML } from 'yaml'
import { createBlobStorage } from '../lib/blobStorage.js'
import { parseDecisionsLog } from '../web/lib/decisionsLog.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'

// #362: "Move to v<N>" on a server workspace kept in a Blob container, against Azurite: whoever can save an Instance's settings
// there can move it, as on a server workspace on the server's disk (tests/definitionVersionMoveServer.test.js). The Instance is on
// design v2, so the move to v4 also shows that its own Glossary's content carries over to the standard Glossary v4 mounts, which
// reads the same section.

const json = { 'Content-Type': 'application/json' }
const post = (body) => ({ method: 'POST', headers: json, body: JSON.stringify(body) })

const GLOSSARY = `---
module: glossary
status: draft
owner: ""
---

# Glossary

## Terms and definitions

| Term | Definition | Avoid |
| --- | --- | --- |
| BIBIT | The payment gateway | — |
`
const TEAM = `---
module: team-and-estimates
status: draft
owner: ""
---

# Teams, contact persons, and high-level estimates

## Teams required

- Claims platform team

## References

- Claims strategy 2026
`

const skip = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'
after(stopAzurite)

describe('moving an Instance in a Blob container to a newer version of its Definition', { skip }, () => {
  test('is offered, and the move writes the Module files, the decisions log and instance.yaml in one save', { timeout: 280000 }, async () => {
    await withAzurite(async (emulator) => {
      const name = `m${Date.now().toString(36)}`
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
            const created = await fetch(`${base}/api/server-workspaces`, post({ name: 'Cloud Team', storage: 'blob', container: 'main' }))
            const workspace = await created.json()
            const made = await fetch(`${base}/api/instances`, post({ definition: 'design', slug: 'cards', definitionVersion: 2, serverWorkspace: workspace.id }))
            const row = await made.json()
            await storage.putText('cloud-team/cards/modules/glossary.md', GLOSSARY)
            await storage.putText('cloud-team/cards/modules/team-and-estimates.md', TEAM)

            const offerRes = await fetch(`${base}/api/instance/definition-move?ref=${row.ref}`)
            assert.equal(offerRes.status, 200, await offerRes.clone().text())
            const offer = await offerRes.json()
            assert.deepEqual([offer.available, offer.definition, offer.from, offer.to, offer.blocked], [true, 'design', 2, 4, null])
            assert.deepEqual(offer.removed.map((f) => `${f.moduleId}.${f.fieldId}`), ['team-and-estimates.references'], 'the Glossary is not removed')
            assert.ok(offer.added.some((f) => f.moduleId === 'key-decisions'), 'Key decisions is new in v4')
            assert.match(offer.changelog, /^## v4\n/)

            const stale = await fetch(`${base}/api/instance/definition-move?ref=${row.ref}`, post({ to: 3 }))
            assert.equal(stale.status, 409)
            assert.match((await storage.getText('cloud-team/cards/instance.yaml')).text, /^definitionVersion: 2$/m, 'a refused move changes nothing')

            const res = await fetch(`${base}/api/instance/definition-move?ref=${row.ref}`, post({ to: 4 }))
            assert.equal(res.status, 200, await res.clone().text())
            const moved = await res.json()
            assert.equal(moved.definitionVersion, 4)
            assert.deepEqual(moved.removed.map((f) => f.fieldId), ['references'])

            assert.equal((await storage.getText('cloud-team/cards/modules/glossary.md')).text, GLOSSARY, 'the Glossary is left as it was')
            assert.equal((await storage.getText('cloud-team/cards/modules/team-and-estimates.md')).text, TEAM.replace('\n## References\n\n- Claims strategy 2026\n', ''))
            assert.equal(parseYAML((await storage.getText('cloud-team/cards/instance.yaml')).text).definitionVersion, 4)
            const log = parseDecisionsLog((await storage.getText('cloud-team/cards/interview/shape.yaml')).text, 'shape')
            assert.deepEqual(log.entries.map((e) => [e.kind, e.from, e.to]), [['definition-move', 2, 4]])

            const after = await (await fetch(`${base}/api/instance/definition-move?ref=${row.ref}`)).json()
            assert.deepEqual(after, { available: false, definitionVersion: 4 })
          }
        )
      })
    })
  })
})
