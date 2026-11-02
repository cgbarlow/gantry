// #269 (parent #238, docs/adr/0070): the storage seam over a real Blob endpoint (Azurite), and the workspaces kept in
// a container. These pin what a Blob container must do for a server workspace to live in it: bytes and text read
// back with an ETag, writes conditional on what was read, listing by prefix, a lease that keeps a second saver out
// until it is released, and a workspace found in the container with the same numbers by a second reader, a copied
// folder numbered afresh, and an unreachable container reported with its reason.
import { test, describe, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobServiceClient } from '@azure/storage-blob'
import { createBlobStorage, withLease } from '../lib/blobStorage.js'
import { StorageConflictError, StorageLeaseHeldError } from '../lib/storage.js'
import { createBlobContainerRegistry } from '../lib/blobContainers.js'
import { createBlobWorkspaces, deriveBlobWorkspaceId, isBlobWorkspaceId, BlobContainerUnavailableError } from '../lib/blobWorkspaces.js'
import { resolveScopeAndSlugForRef } from '../lib/numberRegistry.js'
import { DuplicateServerWorkspaceError, InvalidServerWorkspaceError } from '../lib/workspaceDirectory.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'

const skip = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'
after(stopAzurite)

let counter = 0
async function freshContainer(emulator) {
  const name = `c${Date.now().toString(36)}${counter++}`
  const client = BlobServiceClient.fromConnectionString(emulator.connectionString).getContainerClient(name)
  await client.createIfNotExists()
  return { name, client }
}

describe('the Blob storage seam', { skip }, () => {
  test('writes and reads text and bytes, with an ETag as the version', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { client } = await freshContainer(emulator)
      const storage = createBlobStorage(client)
      const written = await storage.putText('ws/a/instance.yaml', 'definition: design\n')
      assert.ok(written.version)
      const read = await storage.getText('ws/a/instance.yaml')
      assert.equal(read.text, 'definition: design\n')
      assert.equal(read.version, written.version)

      const bytes = Buffer.from([0, 1, 2, 250, 255])
      await storage.putBytes('ws/a/assets/x.png', bytes)
      assert.deepEqual((await storage.getBytes('ws/a/assets/x.png')).bytes, bytes)

      await assert.rejects(storage.getText('ws/a/nope.yaml'), (err) => err.code === 'ENOENT')
    })
  })

  test('a write is conditional on the version it read, and create-only with null', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const storage = createBlobStorage((await freshContainer(emulator)).client)
      const first = await storage.putText('f.txt', 'one', { ifVersion: null })
      await assert.rejects(storage.putText('f.txt', 'again', { ifVersion: null }), StorageConflictError)
      const second = await storage.putText('f.txt', 'two', { ifVersion: first.version })
      await assert.rejects(storage.putText('f.txt', 'three', { ifVersion: first.version }), (err) => err instanceof StorageConflictError && /f\.txt/.test(err.message))
      assert.equal((await storage.getText('f.txt')).text, 'two')
      await assert.rejects(storage.putText('missing.txt', 'x', { ifVersion: second.version }), StorageConflictError)
      await assert.rejects(storage.remove('f.txt', { ifVersion: first.version }), StorageConflictError)
      assert.equal(await storage.remove('f.txt', { ifVersion: second.version }), true)
      assert.equal(await storage.remove('f.txt'), false)
    })
  })

  test('lists by prefix, sorted, never showing the lock blobs, and lists top-level folders', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const storage = createBlobStorage((await freshContainer(emulator)).client)
      for (const path of ['a/z.txt', 'a/b/c.txt', 'ab/x.txt', 'b/y.txt', 'root.txt']) await storage.putText(path, path)
      assert.deepEqual((await storage.list('a/')).map((e) => e.path), ['a/b/c.txt', 'a/z.txt'])
      assert.equal((await storage.list('a/'))[0].size, 'a/b/c.txt'.length)
      assert.deepEqual(await storage.listFolders(''), ['a', 'ab', 'b'])
      await withLease(storage, 'a', async () => {})
      assert.ok(!(await storage.list('')).some((e) => e.path.startsWith('.gantry/locks/')))
    })
  })

  test('a lease keeps a second holder out until it is released', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const storage = createBlobStorage((await freshContainer(emulator)).client)
      const lease = await storage.acquireLease('ws/instance-a', { ttlMs: 20000 })
      await assert.rejects(storage.acquireLease('ws/instance-a'), StorageLeaseHeldError)
      // Another instance is its own key.
      await storage.releaseLease(await storage.acquireLease('ws/instance-b'))
      await storage.renewLease(lease)
      await storage.releaseLease(lease)
      const again = await storage.acquireLease('ws/instance-a')
      await storage.releaseLease(again)
    })
  })

  test('withLease releases when the work throws', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const storage = createBlobStorage((await freshContainer(emulator)).client)
      await assert.rejects(withLease(storage, 'k', async () => { throw new Error('boom') }), /boom/)
      assert.equal(await withLease(storage, 'k', async () => 'ok'), 'ok')
    })
  })
})

describe('workspaces kept in a Blob container', { skip }, () => {
  let instancesDir
  before(() => {
    instancesDir = mkdtempSync(join(tmpdir(), 'gantry-blob-ws-'))
  })
  after(() => rmSync(instancesDir, { recursive: true, force: true }))

  async function managerFor(emulator, containerName, dir = instancesDir) {
    const env = { BLOB_CS: emulator.connectionString }
    const registry = createBlobContainerRegistry(
      JSON.stringify([{ name: 'main', url: emulator.containerUrl(containerName), credentialType: 'connection-string', secretEnv: 'BLOB_CS' }]),
      env
    )
    return createBlobWorkspaces({ containers: registry, instancesDir: dir })
  }

  test('a workspace is created with a folder, a derived id and a short number, and a second server sees the same', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name } = await freshContainer(emulator)
      const first = await managerFor(emulator, name)
      const made = await first.create({ container: 'main', name: 'Risk Review', description: 'Quarterly' })
      assert.equal(made.folder, 'risk-review')
      assert.equal(made.name, 'Risk Review')
      assert.equal(made.description, 'Quarterly')
      assert.ok(isBlobWorkspaceId(made.id))
      assert.equal(made.id, deriveBlobWorkspaceId(emulator.containerUrl(name), 'risk-review'))
      assert.equal(made.available, true)
      const number = await first.numberForNewInstance(made, 'alpha')
      assert.equal(number, 1)
      assert.equal(await first.numberForNewInstance(made, 'alpha'), 1)
      assert.equal(await first.numberForNewInstance(made, 'beta'), 2)

      // A second server, with its own number registry folder, pointed at the same container.
      const otherDir = mkdtempSync(join(tmpdir(), 'gantry-blob-ws-other-'))
      try {
        const second = await managerFor(emulator, name, otherDir)
        assert.deepEqual((await second.refresh()).workspaces.map((w) => w.id), [made.id], 'found without any restart')
        assert.equal(second.get(made.id).number, made.number)
      } finally {
        rmSync(otherDir, { recursive: true, force: true })
      }
    })
  })

  test('the number registry on this server resolves a reference to the workspace kept in the container', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, client } = await freshContainer(emulator)
      const manager = await managerFor(emulator, name)
      const made = await manager.create({ container: 'main', name: 'Refs' })
      const storage = manager.storage('main')
      await storage.putText('refs/alpha/instance.yaml', 'definition: design\nslug: alpha\nstage: shape\n')
      await storage.putText('refs/beta/instance.yaml', 'definition: design\nslug: beta\nstage: shape\n')
      await manager.refresh()
      const workspace = manager.get(made.id)
      assert.deepEqual(workspace.slugs, ['alpha', 'beta'])
      const ref = `w${workspace.number}i${workspace.instanceNumbers.beta}`
      assert.deepEqual(resolveScopeAndSlugForRef(ref, { instancesDir }), { scopeKey: made.id, slug: 'beta' })
      assert.ok(client)
    })
  })

  test('refuses a blank name, a taken name and a container that was not declared', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name } = await freshContainer(emulator)
      const manager = await managerFor(emulator, name)
      await manager.create({ container: 'main', name: 'Taken' })
      await assert.rejects(manager.create({ container: 'main', name: '  ' }), InvalidServerWorkspaceError)
      await assert.rejects(manager.create({ container: 'main', name: 'taken' }), DuplicateServerWorkspaceError)
      await assert.rejects(manager.create({ container: 'elsewhere', name: 'x' }), /Unknown Blob container/)
      // The same name in a folder that already exists gets a suffix, not an overwrite.
      await manager.storage('main').putText('other/readme.txt', 'not a workspace')
      const other = await manager.create({ container: 'main', name: 'Other' })
      assert.equal(other.folder, 'other-2')
    })
  })

  test('a workspace folder copied into the container is a new workspace with a new id and new numbers', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name } = await freshContainer(emulator)
      const manager = await managerFor(emulator, name)
      const original = await manager.create({ container: 'main', name: 'Original' })
      await manager.numberForNewInstance(original, 'one')
      const storage = manager.storage('main')
      await storage.putText('original/one/instance.yaml', 'definition: design\nslug: one\nstage: shape\nnumber: 1\n')
      await storage.putText('original/one/modules/background.md', 'x')

      // What azcopy or Storage Explorer does: the same files under another folder name, workspace.json included.
      for (const entry of await storage.list('original/')) {
        await storage.putBytes(entry.path.replace('original/', 'copy/'), (await storage.getBytes(entry.path)).bytes)
      }
      const snapshot = await manager.refresh()
      const copy = snapshot.workspaces.find((w) => w.folder === 'copy')
      const source = snapshot.workspaces.find((w) => w.folder === 'original')
      assert.ok(copy, 'found as a workspace')
      assert.notEqual(copy.id, source.id)
      assert.notEqual(copy.number, source.number)
      assert.deepEqual(copy.slugs, ['one'])
    })
  })

  test('an unreachable container marks its workspaces unavailable, with the reason, and the manager carries on', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const { name, client } = await freshContainer(emulator)
      const manager = await managerFor(emulator, name)
      const made = await manager.create({ container: 'main', name: 'Fragile' })
      await client.delete() // the container goes away

      const down = await manager.refresh()
      const entry = down.workspaces.find((w) => w.id === made.id)
      assert.equal(entry.available, false)
      assert.match(entry.reason, /does not exist \(404\)/)
      assert.equal(entry.name, 'Fragile', 'still known by name')
      assert.doesNotMatch(JSON.stringify(down), /AccountKey|SharedAccessSignature/i)
      await assert.rejects(manager.create({ container: 'main', name: 'Another' }), BlobContainerUnavailableError)

      // Back again: available as before, same id and number.
      await client.create()
      await manager.storage('main').putText('fragile/workspace.json', JSON.stringify({ name: 'Fragile', kind: 'local', createdAt: new Date().toISOString() }))
      const up = await manager.refresh()
      assert.equal(up.workspaces.find((w) => w.id === made.id).available, true)
    })
  })

  test('a container never reached shows as one unavailable placeholder', { timeout: 180000 }, async () => {
    await withAzurite(async (emulator) => {
      const manager = await managerFor(emulator, 'does-not-exist-yet')
      const snapshot = await manager.refresh()
      assert.equal(snapshot.workspaces.length, 1)
      assert.equal(snapshot.workspaces[0].available, false)
      assert.equal(snapshot.workspaces[0].placeholder, true)
      assert.equal(snapshot.workspaces[0].name, 'main')
    })
  })

  test('declares nothing: nothing is read', async () => {
    const manager = createBlobWorkspaces({ containers: createBlobContainerRegistry('', {}), instancesDir })
    assert.equal(manager.enabled, false)
    assert.deepEqual((await manager.refresh()).workspaces, [])
  })
})
