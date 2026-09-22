import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSharedWorkspaceCache } from '../lib/sharedWorkspaceCache.js'

// #127 (parent #109, docs/adr/0047 "Cache design") — unit-level coverage of the cache mechanism itself,
// against a hand-rolled fake content-store client (no HTTP, no mocking framework — same style as
// tests/writeAccessCheck.test.js's own callCount-counting fakes) rather than the real
// fakeGitHubServer/fakeAzureDevOpsServer, so a freshness-check call is trivially distinguishable from a
// full read by which counter it bumps.

function fakeClient({ refs = { main: 'sha-1' }, files = {} } = {}) {
  const calls = { getBranchObjectId: 0, getFileContent: 0, getFileBytes: 0, listFolder: 0, writeFile: 0, writeFiles: 0, deleteFile: 0 }
  const store = new Map(Object.entries(files)) // "branch/path" -> content
  const branchRefs = { ...refs }

  return {
    calls,
    setRef(branch, sha) {
      branchRefs[branch] = sha
    },
    setFile(branch, path, content) {
      store.set(`${branch}/${path}`, content)
    },
    client: {
      async getBranchObjectId(branch) {
        calls.getBranchObjectId++
        return branchRefs[branch] ?? null
      },
      async getFileContent(path, { branch = 'main' } = {}) {
        calls.getFileContent++
        const key = `${branch}/${path}`
        if (!store.has(key)) throw new Error(`fake: no file at ${key}`)
        return store.get(key)
      },
      async getFileBytes(path, { branch = 'main' } = {}) {
        calls.getFileBytes++
        const key = `${branch}/${path}`
        if (!store.has(key)) throw new Error(`fake: no file at ${key}`)
        return store.get(key)
      },
      async listFolder(path, { branch = 'main' } = {}) {
        calls.listFolder++
        return [...store.keys()].filter((k) => k.startsWith(`${branch}/${path}/`))
      },
      async writeFile(path, content, { branch = 'main', contentType } = {}) {
        calls.writeFile++
        store.set(`${branch}/${path}`, content)
        branchRefs[branch] = `sha-write-${calls.writeFile}-${Math.random().toString(36).slice(2)}`
        return { path, changeType: 'edit', push: { commits: [{ commitId: branchRefs[branch] }] } }
      },
      async writeFiles(files, { branch = 'main' } = {}) {
        calls.writeFiles++
        for (const f of files) store.set(`${branch}/${f.path}`, f.content)
        branchRefs[branch] = `sha-multi-${calls.writeFiles}`
        return { changes: files.map((f) => ({ path: f.path, changeType: 'edit' })), push: { commits: [{ commitId: branchRefs[branch] }] } }
      },
      async deleteFile(path, { branch = 'main' } = {}) {
        calls.deleteFile++
        store.delete(`${branch}/${path}`)
        return { path, changeType: 'delete' } // GitHub's real deleteFile shape — no `push` field
      },
    },
  }
}

test('cachedRead: a repeated read of unchanged content issues only the cheap freshness check, never a second full read', async () => {
  const fake = fakeClient({ files: { 'main/instance.yaml': 'stage: shape\n' } })
  const cache = createSharedWorkspaceCache()
  const wrapped = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })

  const first = await wrapped.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(first, 'stage: shape\n')
  assert.equal(fake.calls.getFileContent, 1)
  assert.equal(fake.calls.getBranchObjectId, 1)

  for (let i = 0; i < 5; i++) {
    const value = await wrapped.getFileContent('instance.yaml', { branch: 'main' })
    assert.equal(value, 'stage: shape\n')
  }

  // Five more reads: five more cheap freshness checks, but the full read count never moves off 1.
  assert.equal(fake.calls.getFileContent, 1, 'must not re-read content when the ref has not moved')
  assert.equal(fake.calls.getBranchObjectId, 6, 'every read still performs its own cheap freshness check')
})

test('cachedRead: when the ref has moved (a push outside Gantry), the next read re-reads for real and re-caches', async () => {
  const fake = fakeClient({ files: { 'main/instance.yaml': 'stage: shape\n' } })
  const cache = createSharedWorkspaceCache()
  const wrapped = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })

  await wrapped.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(fake.calls.getFileContent, 1)

  // Someone pushes directly to the repo, outside Gantry.
  fake.setFile('main', 'instance.yaml', 'stage: build\n')
  fake.setRef('main', 'sha-2')

  const updated = await wrapped.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(updated, 'stage: build\n')
  assert.equal(fake.calls.getFileContent, 2, 'a moved ref forces exactly one real re-read')

  // And it's cached again from there.
  await wrapped.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(fake.calls.getFileContent, 2, 'the re-read result is itself served from cache on the next request')
})

test('write-through: a write recorded through the wrapped client is visible on the very next read, with no freshness-check re-read', async () => {
  const fake = fakeClient({ files: {} })
  const cache = createSharedWorkspaceCache()
  const wrapped = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })

  await wrapped.writeFile('modules/background.md', '# Background\n', { branch: 'main' })
  assert.equal(fake.calls.writeFile, 1)

  const value = await wrapped.getFileContent('modules/background.md', { branch: 'main' })
  assert.equal(value, '# Background\n')
  // The freshness check still runs (cheap, always does) but no full read was needed — the write-through
  // entry already matched the branch's new ref.
  assert.equal(fake.calls.getFileContent, 0, 'write-through must make the write itself visible with no extra read')
  assert.equal(fake.calls.getBranchObjectId, 1)
})

test('write-through does not require cacheReads: a write-only wrap (cacheReads: false) still writes through for a later cacheReads:true read', async () => {
  const fake = fakeClient({ files: {} })
  const cache = createSharedWorkspaceCache()
  const writeWrap = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: false })
  await writeWrap.writeFile('modules/background.md', '# v2\n', { branch: 'main' })

  // A write-side wrap with cacheReads:false must never itself read from cache.
  const readBack = await writeWrap.getFileContent('modules/background.md', { branch: 'main' })
  assert.equal(readBack, '# v2\n')
  assert.equal(fake.calls.getFileContent, 1, 'cacheReads:false never reads from cache, even right after a write it recorded')

  // But a *separate* cacheReads:true wrap against the same store/branch sees the write-through result.
  const readWrap = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })
  const cached = await readWrap.getFileContent('modules/background.md', { branch: 'main' })
  assert.equal(cached, '# v2\n')
  assert.equal(fake.calls.getFileContent, 1, 'the cacheReads:true wrap serves the write-through entry with no additional real read')
})

test('the credential boundary: cacheReads:false never reads from or populates the cache, even for the exact same storeKey/branch/path a cacheReads:true wrap already cached', async () => {
  const fake = fakeClient({ files: { 'main/instance.yaml': 'stage: shape\n' } })
  const cache = createSharedWorkspaceCache()

  const sharedWrap = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })
  await sharedWrap.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(fake.calls.getFileContent, 1)

  // A different client instance (as if built from a *different* individual's own PAT), wrapped with
  // cacheReads:false — the shape every request-credentialed read gets. Its read methods are the bare,
  // unwrapped client methods (see wrapContentStore's own doc comment: cacheReads:false means "reads pass
  // straight through, untouched") — never even consulting `cache`'s own freshness-check machinery.
  const ownCredentialFake = fakeClient({ files: { 'main/instance.yaml': 'stage: shape\n' } })
  const ownWrap = cache.wrapContentStore(ownCredentialFake.client, { storeKey: 'workspace-a', cacheReads: false })
  await ownWrap.getFileContent('instance.yaml', { branch: 'main' })

  // The own-credential read did its own real read — it was never served the shared wrap's cached value —
  // and never called getBranchObjectId at all, proving it took no path through the cache machinery.
  assert.equal(ownCredentialFake.calls.getFileContent, 1, 'an own-credential read always does its own real read')
  assert.equal(ownCredentialFake.calls.getBranchObjectId, 0, 'an own-credential (cacheReads:false) read never even calls the freshness check — it never touches cache machinery at all')

  // And the own-credential read never populated the shared cache either: a subsequent cacheReads:true
  // read against the *original* client still only ever did the one real read from before.
  await sharedWrap.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(fake.calls.getFileContent, 1, 'the shared cache is unaffected by any own-credential read')
})

test('cache keys distinguish workspace: two different storeKeys for the same branch/path never share an entry', async () => {
  const fakeA = fakeClient({ files: { 'main/instance.yaml': 'workspace: A\n' } })
  const fakeB = fakeClient({ files: { 'main/instance.yaml': 'workspace: B\n' } })
  const cache = createSharedWorkspaceCache()

  const wrapA = cache.wrapContentStore(fakeA.client, { storeKey: 'workspace-a', cacheReads: true })
  const wrapB = cache.wrapContentStore(fakeB.client, { storeKey: 'workspace-b', cacheReads: true })

  assert.equal(await wrapA.getFileContent('instance.yaml', { branch: 'main' }), 'workspace: A\n')
  assert.equal(await wrapB.getFileContent('instance.yaml', { branch: 'main' }), 'workspace: B\n')
  assert.equal(fakeA.calls.getFileContent, 1)
  assert.equal(fakeB.calls.getFileContent, 1)

  // Repeat reads on both: neither's cached entry leaks into the other's.
  assert.equal(await wrapA.getFileContent('instance.yaml', { branch: 'main' }), 'workspace: A\n')
  assert.equal(await wrapB.getFileContent('instance.yaml', { branch: 'main' }), 'workspace: B\n')
  assert.equal(fakeA.calls.getFileContent, 1)
  assert.equal(fakeB.calls.getFileContent, 1)
})

test('cache keys distinguish ref: two branches of the same workspace never share an entry', async () => {
  const fake = fakeClient({ refs: { main: 'sha-main', stage: 'sha-stage' }, files: { 'main/instance.yaml': 'stage: shape\n', 'stage/instance.yaml': 'stage: build\n' } })
  const cache = createSharedWorkspaceCache()
  const wrapped = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })

  assert.equal(await wrapped.getFileContent('instance.yaml', { branch: 'main' }), 'stage: shape\n')
  assert.equal(await wrapped.getFileContent('instance.yaml', { branch: 'stage' }), 'stage: build\n')
  assert.equal(fake.calls.getFileContent, 2)

  assert.equal(await wrapped.getFileContent('instance.yaml', { branch: 'main' }), 'stage: shape\n')
  assert.equal(await wrapped.getFileContent('instance.yaml', { branch: 'stage' }), 'stage: build\n')
  assert.equal(fake.calls.getFileContent, 2, 'repeat reads on both branches stay cached independently')
})

test('a freshness-check failure (Provider error/unreachable) degrades to a real read rather than serving a stale cached value, and does not crash', async () => {
  const fake = fakeClient({ files: { 'main/instance.yaml': 'stage: shape\n' } })
  const cache = createSharedWorkspaceCache()
  const wrapped = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })

  await wrapped.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(fake.calls.getFileContent, 1)

  // Simulate the Provider becoming unreachable for the freshness check itself.
  const originalGetBranchObjectId = fake.client.getBranchObjectId
  fake.client.getBranchObjectId = async () => {
    throw new Error('fake: Provider unreachable')
  }

  const value = await wrapped.getFileContent('instance.yaml', { branch: 'main' })
  assert.equal(value, 'stage: shape\n', 'still returns correct (real, not stale-as-current) content')
  assert.equal(fake.calls.getFileContent, 2, 'degrades to a real read rather than trusting the cache under a failed freshness check')

  // A genuine read failure still propagates rather than being swallowed.
  fake.client.getBranchObjectId = originalGetBranchObjectId
  fake.client.getFileContent = async () => {
    throw new Error('fake: read itself failed')
  }
  await assert.rejects(() => wrapped.getFileContent('instance.yaml', { branch: 'main' }), /read itself failed/)
})

test('deleteFile write-through drops the branch cache rather than serving the deleted path as though it still existed', async () => {
  const fake = fakeClient({ files: { 'main/assets/foo.png': 'bytes' } })
  const cache = createSharedWorkspaceCache()
  const wrapped = cache.wrapContentStore(fake.client, { storeKey: 'workspace-a', cacheReads: true })

  await wrapped.getFileContent('assets/foo.png', { branch: 'main' })
  assert.equal(fake.calls.getFileContent, 1)

  await wrapped.deleteFile('assets/foo.png', { branch: 'main' })
  await assert.rejects(() => wrapped.getFileContent('assets/foo.png', { branch: 'main' }), /no file/)
  assert.equal(fake.calls.getFileContent, 2, 'deleted path is never served stale from cache — the next read pays one real (failing) lookup')
})
