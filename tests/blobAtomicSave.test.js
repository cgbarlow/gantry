// #271 (parent #238, docs/adr/0070): Blob Saves are all-or-nothing across servers, run against Azurite.
//   - two servers saving the same stage at once: one succeeds and the other is handed the Field-by-Field Save check,
//     never a silent overwrite;
//   - a Save interrupted part-way (fault injection: the saving server dies after some of the stage's files) leaves
//     the stage entirely as before once the dead server's lease has run out, whether the next thing to touch it is a
//     read or a Save;
//   - a lease left by a server that died expires, and the next Save goes ahead.
// The create-only 409/412 handling is in tests/blobCreateOnly.test.js. The lease cannot be shorter than Azure's 15
// seconds, so the interrupted-Save test waits for a real expiry.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { BlobServiceClient } from '@azure/storage-blob'
import { createBlobStorage } from '../lib/blobStorage.js'
import { journalPathFor, writeFilesAllOrNothing } from '../lib/atomicSave.js'
import { withLease } from '../lib/blobStorage.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'
import { createDyingStorage } from './helpers/dyingStorage.js'

const skip = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'
after(stopAzurite)

const json = { 'Content-Type': 'application/json' }
let counter = 0
async function freshContainer(emulator) {
  const name = `a${Date.now().toString(36)}${counter++}`
  const client = BlobServiceClient.fromConnectionString(emulator.connectionString).getContainerClient(name)
  await client.createIfNotExists()
  return { name, client, storage: createBlobStorage(client) }
}

const declaration = (emulator, containerName) => ({
  blobContainers: JSON.stringify([{ name: 'main', url: emulator.containerUrl(containerName), credentialType: 'connection-string', secretEnv: 'GANTRY_TEST_BLOB_CS' }]),
  env: { ...process.env, GANTRY_TEST_BLOB_CS: emulator.connectionString },
  blobRefreshMs: 0,
})

const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const put = (base, path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const get = async (base, path) => (await fetch(`${base}${path}`)).json()

const background = (problem) => ({ status: 'agreed', owner: 'c.barlow', fields: { problem, 'affected-domains': ['Payments'], opportunity: '' } })
const introduction = (text) => ({ status: 'draft', owner: 'c.barlow', fields: { purpose: text } })

// A fresh blob workspace with one Instance, on a server whose own folder is `dir`. Resolves to what a test needs.
async function setUp(emulator, base, containerName) {
  const workspace = await (await post(base, '/api/server-workspaces', { name: 'Cloud Team', storage: 'blob', container: 'main' })).json()
  const row = await (await post(base, '/api/instances', { definition: 'design', slug: 'cards', definitionVersion: 2, assignee: 'c.barlow', serverWorkspace: workspace.id })).json()
  return { workspace, ref: row.ref }
}

const problemOf = (instance) => instance.modules.find((m) => m.id === 'background').fields.find((f) => f.id === 'problem').value

describe('a Blob Save across servers', { skip }, () => {
  test('two servers saving the same stage at once: one succeeds, the other is handed the Field-by-Field check, and nothing is silently overwritten', { timeout: 240000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, storage } = await freshContainer(emulator)
      await withScratchInstances(async (dirA) => {
        await withScratchInstances(async (dirB) => {
          await withRunningServer({ instancesDir: dirA, ...declaration(emulator, name) }, async (baseA) => {
            await withRunningServer({ instancesDir: dirB, ...declaration(emulator, name) }, async (baseB) => {
              const { ref } = await setUp(emulator, baseA, name)
              const read = await get(baseA, `/api/instance?ref=${ref}`)
              const sameRead = await get(baseB, `/api/instance?ref=${ref}`)
              assert.equal(read.stageVersion, sameRead.stageVersion, 'both servers fingerprint the stage alike')

              const saveOn = (base, text) => put(base, `/api/instance/modules?ref=${ref}`, { baseVersion: read.stageVersion, modules: { background: background(text), introduction: introduction(`Covers ${text}`) } })
              const [fromA, fromB] = await Promise.all([saveOn(baseA, 'Written on server A.'), saveOn(baseB, 'Written on server B.')])
              const statuses = [fromA.status, fromB.status].sort()
              assert.deepEqual(statuses, [200, 409], 'exactly one of them wins')

              const [winnerText, loser, loserText] = fromA.status === 200 ? ['Written on server A.', fromB, 'Written on server B.'] : ['Written on server B.', fromA, 'Written on server A.']
              const refusal = await loser.json()
              assert.equal(refusal.code, 'stage_changed')
              assert.ok(refusal.differingFields.length > 0, 'it names the Fields that differ')
              assert.match(JSON.stringify(refusal.current), new RegExp(winnerText), 'and hands back what is saved now to settle against')

              // The winner's stage is on disk whole: both Modules, and no mix with the loser's.
              assert.match((await storage.getText('cloud-team/cards/modules/background.md')).text, new RegExp(winnerText))
              assert.match((await storage.getText('cloud-team/cards/modules/introduction.md')).text, new RegExp(`Covers ${winnerText}`))
              assert.doesNotMatch((await storage.getText('cloud-team/cards/modules/background.md')).text, new RegExp(loserText))
              assert.equal((await storage.list('.gantry/journal/')).length, 0, 'no write-ahead record left behind')

              // Having settled the clash, the loser saves against the new version.
              const fresh = await get(baseA, `/api/instance?ref=${ref}`)
              const retry = await put(baseA, `/api/instance/modules?ref=${ref}`, { baseVersion: fresh.stageVersion, modules: { background: background(`${winnerText} ${loserText}`) } })
              assert.equal(retry.status, 200)
            })
          })
        })
      })
    })
  })

  // Another server starts a Save of both Modules and dies after writing the first. Its Save is the real one
  // (lib/atomicSave.js) over a store that stops answering after one file and never releases the lease it holds.
  async function dieMidSave(client, storage) {
    const key = 'cloud-team/cards'
    const paths = ['background', 'introduction'].map((id) => `cloud-team/cards/modules/${id}.md`)
    const before = await Promise.all(paths.map(async (path) => (await storage.getText(path)).text))
    const dying = createDyingStorage(createBlobStorage(client), { dieAfterPuts: 1 })
    await assert.rejects(
      withLease(dying, key, () => writeFilesAllOrNothing(dying, key, paths.map((path, i) => ({ path, text: `${before[i]}\nHalf of a Save.\n` }))), { ttlMs: 15_000, waitMs: 0 }),
      (err) => err.code === 'SERVER_DIED'
    )
    assert.match((await storage.getText(paths[0])).text, /Half of a Save\./, 'the dead server got one file in')
    assert.doesNotMatch((await storage.getText(paths[1])).text, /Half of a Save\./, 'and not the other')
    assert.ok((await storage.getText(journalPathFor(key))).text.includes('"writes"'), 'and left its write-ahead record')
    return { paths, before }
  }

  const expectStageAsBefore = async (storage, { paths, before }) => {
    for (const [i, path] of paths.entries()) assert.equal((await storage.getText(path)).text, before[i], `${path} is exactly as before`)
    assert.equal((await storage.list('.gantry/journal/')).length, 0, 'and the write-ahead record is gone')
  }

  test('a Save cut short by a dying server leaves the stage entirely as before once its lease expires, and a read settles it', { timeout: 240000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, client, storage } = await freshContainer(emulator)
      await withScratchInstances(async (dir) => {
        await withRunningServer({ instancesDir: dir, ...declaration(emulator, name) }, async (base) => {
          const { ref } = await setUp(emulator, base, name)
          const saved = await put(base, `/api/instance/modules?ref=${ref}`, { modules: { background: background('Before the crash.'), introduction: introduction('Introduced before the crash.') } })
          assert.equal(saved.status, 200)
          const died = await dieMidSave(client, storage)
          const diedAt = Date.now()

          // Until the dead server's lease runs out nobody can settle it, so a read may still see the half-written stage;
          // once it has, the first read finds the stage entirely as before.
          let instance
          for (;;) {
            instance = await get(base, `/api/instance?ref=${ref}`)
            if (!(await storage.getText(died.paths[0])).text.includes('Half of a Save.')) break
            assert.ok(Date.now() - diedAt < 90_000, 'the stage was settled within a minute of the crash')
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
          await expectStageAsBefore(storage, died)

          // And the next Save goes ahead.
          const next = await put(base, `/api/instance/modules?ref=${ref}`, { baseVersion: instance.stageVersion, modules: { background: background('After the crash.') } })
          assert.equal(next.status, 200)
          assert.equal(problemOf(await get(base, `/api/instance?ref=${ref}`)), 'After the crash.')
        })
      })
    })
  })

  test("a Save that arrives while a dead server's lease is still running waits for it to expire, settles the half-written stage itself, and goes ahead", { timeout: 240000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, client, storage } = await freshContainer(emulator)
      await withScratchInstances(async (dir) => {
        await withRunningServer({ instancesDir: dir, ...declaration(emulator, name) }, async (base) => {
          const { ref } = await setUp(emulator, base, name)
          assert.equal((await put(base, `/api/instance/modules?ref=${ref}`, { modules: { background: background('Before.'), introduction: introduction('Intro before.') } })).status, 200)
          const died = await dieMidSave(client, storage)

          // Saving the Module the dead server never reached must not carry the dead server's half on.
          const saved = await put(base, `/api/instance/modules?ref=${ref}`, { modules: { introduction: introduction('Intro after.') } })
          assert.equal(saved.status, 200, 'the Save goes ahead once the lease has expired')
          assert.equal((await storage.getText(died.paths[0])).text, died.before[0], "the dead server's file was put back, not kept")
          assert.match((await storage.getText(died.paths[1])).text, /Intro after\./)
          assert.equal((await storage.list('.gantry/journal/')).length, 0)
        })
      })
    })
  })
})
