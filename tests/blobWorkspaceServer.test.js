// #269 (parent #238, docs/adr/0070): a server workspace stored in a Blob container, driven through the HTTP API
// against Azurite. Covers the ticket's acceptance criteria: create a blob-stored workspace and an Instance in
// it, save modules, upload an asset, advance a stage and render; a second server pointed at the same
// container sees the workspace with the same short numbers without restarting; a restart loses nothing; an
// unreachable container marks its workspaces unavailable with the reason while other workspaces carry on;
// and a folder copied into the container with Azure's tools is a new workspace with a new id and new numbers.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BlobServiceClient } from '@azure/storage-blob'
import { createBlobStorage } from '../lib/blobStorage.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import { docxPart } from './helpers/wordDocx.js'

const skip = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'
after(stopAzurite)

const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'open-questions']
const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const json = { 'Content-Type': 'application/json' }

let counter = 0
async function freshContainer(emulator) {
  const name = `s${Date.now().toString(36)}${counter++}`
  const client = BlobServiceClient.fromConnectionString(emulator.connectionString).getContainerClient(name)
  await client.createIfNotExists()
  return { name, client, storage: createBlobStorage(client) }
}

const declaration = (emulator, containerName, extra = {}) => ({
  blobContainers: JSON.stringify([{ name: 'main', url: emulator.containerUrl(containerName), credentialType: 'connection-string', secretEnv: 'GANTRY_TEST_BLOB_CS' }]),
  env: { ...process.env, GANTRY_TEST_BLOB_CS: emulator.connectionString },
  blobRefreshMs: 0,
  ...extra,
})

const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const put = (base, path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const get = async (base, path) => (await fetch(`${base}${path}`)).json()

describe('a server workspace stored in a Blob container', { skip }, () => {
  test('is created, holds an Instance that is saved, given an asset, rendered and advanced, and is shared by a second server and survives a restart', { timeout: 280000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, storage } = await freshContainer(emulator)
      let workspace
      let row
      let assetId

      await withScratchInstances(async (dirA) => {
        await withRunningServer({ instancesDir: dirA, ...declaration(emulator, name) }, async (base) => {
          // The plain list is the disk's alone; the Definitions page's home picker relies on that.
          assert.ok(!(await get(base, '/api/server-workspaces')).some((w) => w.storage === 'blob'))

          const created = await post(base, '/api/server-workspaces', { name: 'Cloud Team', description: 'In the cloud', storage: 'blob', container: 'main' })
          assert.equal(created.status, 201)
          workspace = await created.json()
          assert.match(workspace.id, /^blob-[0-9a-f]{32}$/)
          assert.equal(workspace.storage, 'blob')
          assert.equal(workspace.container, 'main')
          assert.equal(workspace.available, true)
          assert.equal(typeof workspace.number, 'number')
          assert.equal((await storage.getText('cloud-team/workspace.json')).text.includes('Cloud Team'), true, 'a folder with a workspace.json in the container')

          const listed = await get(base, '/api/server-workspaces?include=blob')
          assert.deepEqual(listed.filter((w) => w.storage === 'blob').map((w) => w.id), [workspace.id])
          assert.doesNotMatch(JSON.stringify(listed), new RegExp(emulator.key.slice(0, 20)))

          // An Instance, addressed by its short reference.
          const makeInstance = await post(base, '/api/instances', { definition: 'design', slug: 'cards', definitionVersion: 2, assignee: 'c.barlow', serverWorkspace: workspace.id })
          assert.equal(makeInstance.status, 201)
          row = await makeInstance.json()
          assert.equal(row.workspace.id, workspace.id)
          assert.equal(row.workspace.storage, 'blob')
          assert.equal(row.ref, `w${workspace.number}i1`)
          assert.equal((await post(base, '/api/instances', { definition: 'design', slug: 'cards', serverWorkspace: workspace.id })).status, 409)
          assert.ok((await storage.list('cloud-team/cards/')).some((f) => f.path === 'cloud-team/cards/instance.yaml'))

          const instance = await get(base, `/api/instance?ref=${row.ref}`)
          assert.equal(instance.slug, 'cards')
          assert.equal(instance.ref, row.ref)
          assert.equal(instance.stage.id, 'shape')
          assert.equal(instance.workspaceBacked, false)
          assert.equal(instance.modules.length, SHAPE_MODULES.length)
          assert.deepEqual(await get(base, `/api/instance/workspace?ref=${row.ref}`), { workspaceId: workspace.id, scope: workspace.id })
          // The web client asks by bare slug first and sends the answer back as ?scope=.
          assert.deepEqual(await get(base, '/api/instance/workspace?slug=cards'), { workspaceId: workspace.id, scope: workspace.id })
          assert.equal((await get(base, `/api/instance?slug=cards&scope=${workspace.id}`)).ref, row.ref)
          assert.equal((await fetch(`${base}/api/instance?slug=nobody&scope=${workspace.id}`)).status, 404)

          // Save one Module, then the stage in one request against the version that was read.
          const background = { status: 'agreed', owner: 'c.barlow', fields: { problem: 'Cards settle slowly.', 'affected-domains': ['Payments'], opportunity: '' } }
          assert.equal((await put(base, `/api/instance/modules/background?ref=${row.ref}`, background)).status, 200)
          assert.match((await storage.getText('cloud-team/cards/modules/background.md')).text, /Cards settle slowly/)

          const reread = await get(base, `/api/instance?ref=${row.ref}`)
          const bulk = await put(base, `/api/instance/modules?ref=${row.ref}`, { baseVersion: reread.stageVersion, modules: { background: { ...background, fields: { ...background.fields, problem: 'Cards settle slowly, and refunds slower.' } } } })
          assert.equal(bulk.status, 200)
          const saved = await bulk.json()
          assert.deepEqual(saved.saved, ['background'])
          assert.notEqual(saved.stageVersion, reread.stageVersion)
          // The same stale version again is a clash, not an overwrite.
          const stale = await put(base, `/api/instance/modules?ref=${row.ref}`, { baseVersion: reread.stageVersion, modules: { background } })
          assert.equal(stale.status, 409)
          assert.equal((await stale.json()).code, 'stage_changed')
          assert.match((await storage.getText('cloud-team/cards/modules/background.md')).text, /refunds slower/)

          // An asset.
          const upload = await post(base, `/api/instance/assets?ref=${row.ref}`, { filename: 'flow.png', dataBase64: ONE_PX_PNG_BASE64, name: 'Flow', source: 'https://draw.io/flow', uploadedBy: 'c.barlow' })
          assert.equal(upload.status, 201)
          assetId = (await upload.json()).id
          const assets = await get(base, `/api/instance/assets?ref=${row.ref}`)
          assert.deepEqual(assets.map((a) => a.id), [assetId])
          const file = await fetch(`${base}/api/instance/assets/${assetId}/file?ref=${row.ref}`)
          assert.equal(file.status, 200)
          assert.equal(file.headers.get('content-type'), 'image/png')
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(ONE_PX_PNG_BASE64, 'base64'))

          // The gate fails until every Module is saved; then the stage advances.
          const check = await get(base, `/api/instance/check?ref=${row.ref}`)
          assert.equal(check.pass, false)
          assert.equal((await post(base, `/api/instance/advance-stage?ref=${row.ref}`, {})).status, 400)
          for (const moduleId of SHAPE_MODULES) await storage.putText(`cloud-team/cards/modules/${moduleId}.md`, exampleModuleText(moduleId, { definitionVersion: 2 }))
          assert.equal((await get(base, `/api/instance/check?ref=${row.ref}`)).pass, true)

          // Render: delivered to the browser, never written into the container.
          const before = (await storage.list('cloud-team/cards/')).map((f) => f.path)
          const rendered = await post(base, `/api/instance/render/soap?ref=${row.ref}`, {})
          assert.equal(rendered.status, 200)
          const renderBody = await rendered.json()
          assert.ok(renderBody.docxBase64.length > 1000)
          assert.match(docxPart(Buffer.from(renderBody.docxBase64, 'base64'), 'word/document.xml'), /<w:body>/)
          assert.deepEqual((await storage.list('cloud-team/cards/')).map((f) => f.path), before, 'a render writes nothing to the container')
          const markdown = await (await post(base, `/api/instance/render/soap?ref=${row.ref}&format=md`, {})).json()
          assert.match(markdown.markdown, /Solution on a Page/)

          const advanced = await post(base, `/api/instance/advance-stage?ref=${row.ref}`, {})
          assert.equal(advanced.status, 200)
          assert.equal((await advanced.json()).toStage.id, 'hld-define')
          assert.equal((await get(base, `/api/instance?ref=${row.ref}`)).currentStageId, 'hld-define')

          // Settings: assignee.
          assert.equal((await put(base, `/api/instance/assignee?ref=${row.ref}`, { assignee: 'someone.else' })).status, 200)
          assert.equal((await get(base, `/api/instance?ref=${row.ref}`)).assignee, 'someone.else')

          // Nothing about this workspace was written to this server's own folder.
          assert.ok(!existsSync(join(dirA, 'cloud-team')))
          assert.ok(!readdirSync(dirA).some((entry) => entry.startsWith('blob-')))
        })
      })

      // A second server, its own folder, the same container: sees the workspace and the Instance with the same
      // short numbers, and opens the Instance by the reference the first one handed out.
      await withScratchInstances(async (dirB) => {
        await withRunningServer({ instancesDir: dirB, ...declaration(emulator, name) }, async (base) => {
          const listed = await get(base, '/api/server-workspaces?include=blob')
          const seen = listed.find((w) => w.id === workspace.id)
          assert.equal(seen.number, workspace.number)
          const rows = await get(base, '/api/instances')
          const same = rows.find((r) => r.workspace.id === workspace.id && r.slug === 'cards')
          assert.equal(same.ref, row.ref)
          assert.equal(same.stage, 'hld-define')
          const instance = await get(base, `/api/instance?ref=${row.ref}`)
          assert.equal(instance.slug, 'cards')
          assert.equal(instance.currentStageId, 'hld-define')
          assert.equal((await fetch(`${base}/api/instance/assets/${assetId}/file?ref=${row.ref}`)).status, 200)

          // Made on the second server, visible on the first without a restart of either.
          const second = await post(base, '/api/instances', { definition: 'design', slug: 'ledger', definitionVersion: 2, serverWorkspace: workspace.id })
          assert.equal(second.status, 201)
          assert.equal((await second.json()).ref, `w${workspace.number}i2`)
        })
      })

      // A third, after "a redeploy" wiped every server's own disk: nothing is lost.
      await withScratchInstances(async (dirC) => {
        await withRunningServer({ instancesDir: dirC, ...declaration(emulator, name) }, async (base) => {
          const refs = (await get(base, '/api/instances')).filter((r) => r.workspace.id === workspace.id).map((r) => `${r.slug}:${r.ref}`).sort()
          assert.deepEqual(refs, [`cards:w${workspace.number}i1`, `ledger:w${workspace.number}i2`])
          assert.equal((await get(base, `/api/instance?ref=w${workspace.number}i1`)).currentStageId, 'hld-define')
        })
      })
    })
  })

  test('a second server sees a workspace made after it started, without restarting', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name } = await freshContainer(emulator)
      await withScratchInstances(async (dirA) => {
        await withScratchInstances(async (dirB) => {
          await withRunningServer({ instancesDir: dirA, ...declaration(emulator, name) }, async (baseA) => {
            await withRunningServer({ instancesDir: dirB, ...declaration(emulator, name) }, async (baseB) => {
              assert.deepEqual((await get(baseB, '/api/server-workspaces?include=blob')).filter((w) => w.storage === 'blob'), [])
              const made = await (await post(baseA, '/api/server-workspaces', { name: 'Later', storage: 'blob', container: 'main' })).json()
              const seen = (await get(baseB, '/api/server-workspaces?include=blob')).find((w) => w.id === made.id)
              assert.equal(seen.name, 'Later')
              assert.equal(seen.number, made.number)
            })
          })
        })
      })
    })
  })

  test('an unreachable container marks its workspaces unavailable with the reason, and other workspaces keep working', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, client } = await freshContainer(emulator)
      await withScratchInstances(async (dir) => {
        await withRunningServer({ instancesDir: dir, ...declaration(emulator, name) }, async (base) => {
          const disk = await (await post(base, '/api/server-workspaces', { name: 'On Disk' })).json()
          const diskInstance = await (await post(base, '/api/instances', { definition: 'design', slug: 'local-one', serverWorkspace: disk.id })).json()
          const cloud = await (await post(base, '/api/server-workspaces', { name: 'Fragile', storage: 'blob', container: 'main' })).json()
          const cloudInstance = await (await post(base, '/api/instances', { definition: 'design', slug: 'cloud-one', serverWorkspace: cloud.id })).json()

          await client.delete() // the container goes away

          const listed = await get(base, '/api/server-workspaces?include=blob')
          const entry = listed.find((w) => w.id === cloud.id)
          assert.equal(entry.available, false)
          assert.match(entry.reason, /does not exist \(404\)/)
          assert.equal(entry.name, 'Fragile')

          // The dashboard feed still works and still has the disk workspace's Instance.
          const rows = await get(base, '/api/instances')
          assert.ok(rows.some((r) => r.slug === 'local-one'))
          assert.ok(!rows.some((r) => r.slug === 'cloud-one'))

          const refused = await fetch(`${base}/api/instance?ref=${cloudInstance.ref}`)
          assert.equal(refused.status, 503)
          const body = await refused.json()
          assert.equal(body.code, 'workspace_unavailable')
          assert.match(body.reason, /does not exist/)

          const diskStill = await get(base, `/api/instance?ref=${diskInstance.ref}`)
          assert.equal(diskStill.slug, 'local-one')
          assert.equal((await post(base, '/api/server-workspaces', { name: 'More', storage: 'blob', container: 'main' })).status, 503)
        })
      })
    })
  })

  test('a container that was never reachable shows once, unavailable, and the server still starts', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      await withScratchInstances(async (dir) => {
        await withRunningServer({ instancesDir: dir, ...declaration(emulator, 'never-created') }, async (base) => {
          const listed = (await get(base, '/api/server-workspaces?include=blob')).filter((w) => w.storage === 'blob')
          assert.equal(listed.length, 1)
          assert.equal(listed[0].available, false)
          assert.match(listed[0].reason, /does not exist/)
          const made = await post(base, '/api/instances', { definition: 'design', slug: 'plain' })
          assert.equal(made.status, 201)
        })
      })
    })
  })

  test('a workspace folder copied into the container is found as a new workspace, with a new id and new short numbers', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, storage } = await freshContainer(emulator)
      await withScratchInstances(async (dir) => {
        await withRunningServer({ instancesDir: dir, ...declaration(emulator, name) }, async (base) => {
          const original = await (await post(base, '/api/server-workspaces', { name: 'Original', storage: 'blob', container: 'main' })).json()
          const first = await (await post(base, '/api/instances', { definition: 'design', slug: 'alpha', definitionVersion: 2, serverWorkspace: original.id })).json()
          assert.equal(first.ref, `w${original.number}i1`)

          // What azcopy or Storage Explorer does.
          for (const entry of await storage.list('original/')) {
            await storage.putBytes(entry.path.replace('original/', 'copied/'), (await storage.getBytes(entry.path)).bytes)
          }

          const listed = (await get(base, '/api/server-workspaces?include=blob')).filter((w) => w.storage === 'blob')
          const copy = listed.find((w) => w.id !== original.id)
          assert.ok(copy, 'the copy is a workspace of its own')
          assert.equal(copy.name, 'Original')
          assert.notEqual(copy.number, original.number)

          const rows = await get(base, '/api/instances')
          const copied = rows.find((r) => r.workspace.id === copy.id)
          assert.equal(copied.slug, 'alpha')
          assert.equal(copied.ref, `w${copy.number}i1`)
          assert.notEqual(copied.ref, first.ref)
          // Each opens by its own reference and they are separate Instances.
          assert.equal((await get(base, `/api/instance?ref=${copied.ref}`)).ref, copied.ref)
          assert.equal((await get(base, `/api/instance?ref=${first.ref}`)).ref, first.ref)
        })
      })
    })
  })

  test('two saves at once: the second waits for the first or is refused, and the stage is never half-written', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, storage } = await freshContainer(emulator)
      await withScratchInstances(async (dir) => {
        await withRunningServer({ instancesDir: dir, ...declaration(emulator, name) }, async (base) => {
          const ws = await (await post(base, '/api/server-workspaces', { name: 'Busy', storage: 'blob', container: 'main' })).json()
          const row = await (await post(base, '/api/instances', { definition: 'design', slug: 'race', definitionVersion: 2, serverWorkspace: ws.id })).json()
          const body = (text) => ({ modules: { background: { status: 'draft', owner: '', fields: { problem: text, 'affected-domains': [], opportunity: '' } } } })
          const results = await Promise.all(['one', 'two', 'three'].map((text) => put(base, `/api/instance/modules?ref=${row.ref}`, body(text))))
          assert.ok(results.every((r) => r.status === 200 || r.status === 409), results.map((r) => r.status).join(','))
          assert.ok(results.some((r) => r.status === 200))
          assert.match((await storage.getText('busy/race/modules/background.md')).text, /one|two|three/)
          // The lock left nothing visible in the workspace.
          assert.ok(!(await storage.list('busy/')).some((f) => f.path.includes('lock')))
        })
      })
    })
  })
})

describe('with no Blob container declared', () => {
  test('nothing about the routes changes', async () => {
    await withScratchInstances(async (dir) => {
      await withRunningServer({ instancesDir: dir }, async (base) => {
        const listed = await get(base, '/api/server-workspaces?include=blob')
        assert.ok(listed.every((w) => w.storage === 'disk'))
        const made = await post(base, '/api/instances', { definition: 'design', slug: 'plain' })
        assert.equal(made.status, 201)
        assert.equal((await get(base, '/api/instance?slug=plain')).slug, 'plain')
      })
    })
  })
})
