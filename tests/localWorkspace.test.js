import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// `fake-indexeddb/auto` installs `indexedDB` / `IDBKeyRange` / … onto
// `globalThis`, so web/lib/localWorkspace.js's `getIndexedDB()` finds a real
// (in-memory) implementation. `IDBFactory` lets each test start from an
// empty database.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import {
  LOCAL_WORKSPACE_KIND,
  validateWorkspaceRecord,
  parseWorkspaceJson,
  serializeWorkspaceJson,
  isSupported,
  ensurePermission,
  rememberWorkspace,
  recentLocalWorkspaces,
  getWorkspaceHandle,
  forgetWorkspace,
  readTextFile,
  writeTextFile,
  readBinaryFile,
  writeBinaryFile,
  listDir,
  getFileLastModified,
} from '../web/lib/localWorkspace.js'

// ---------------------------------------------------------------------------
// In-memory File System Access API stub
// ---------------------------------------------------------------------------

class MemFileHandle {
  constructor(name) {
    this.kind = 'file'
    this.name = name
    this.bytes = new Uint8Array()
    // Real File System Access API `File` objects carry `lastModified` (epoch ms); the mock stamps
    // it at creation and bumps it on every write, mirroring a real filesystem closely enough for
    // `getFileLastModified` (WI #357) to be exercised meaningfully.
    this.lastModified = Date.now()
  }

  async getFile() {
    const bytes = this.bytes
    const lastModified = this.lastModified
    return {
      lastModified,
      async text() {
        return new TextDecoder().decode(bytes)
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
    }
  }

  async createWritable() {
    const handle = this
    return {
      async write(data) {
        if (typeof data === 'string') {
          handle.bytes = new TextEncoder().encode(data)
        } else if (data instanceof Uint8Array) {
          handle.bytes = data
        } else if (data instanceof ArrayBuffer) {
          handle.bytes = new Uint8Array(data)
        } else if (data && typeof data.arrayBuffer === 'function') {
          handle.bytes = new Uint8Array(await data.arrayBuffer())
        } else {
          throw new Error(`unsupported write payload: ${typeof data}`)
        }
      },
      async close() {
        handle.lastModified = Date.now()
      },
    }
  }
}

class MemDirHandle {
  constructor(name = '') {
    this.kind = 'directory'
    this.name = name
    this.children = new Map()
    this.permission = 'granted'
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    let entry = this.children.get(name)
    if (!entry) {
      if (!create) throw new Error(`NotFoundError: no directory "${name}"`)
      entry = new MemDirHandle(name)
      this.children.set(name, entry)
    }
    if (entry.kind !== 'directory') throw new Error(`TypeMismatchError: "${name}" is a file`)
    return entry
  }

  async getFileHandle(name, { create = false } = {}) {
    let entry = this.children.get(name)
    if (!entry) {
      if (!create) throw new Error(`NotFoundError: no file "${name}"`)
      entry = new MemFileHandle(name)
      this.children.set(name, entry)
    }
    if (entry.kind !== 'file') throw new Error(`TypeMismatchError: "${name}" is a directory`)
    return entry
  }

  async removeEntry(name) {
    this.children.delete(name)
  }

  async *entries() {
    for (const [name, handle] of this.children) yield [name, handle]
  }

  async queryPermission() {
    return this.permission
  }

  async requestPermission() {
    return this.permission
  }
}

function goodRecord(overrides = {}) {
  return {
    name: 'Demo Workspace',
    owner: 'alice',
    kind: LOCAL_WORKSPACE_KIND,
    createdAt: '2026-08-31T12:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('workspace.json schema', () => {
  test('accepts a well-formed local record', () => {
    const { valid, errors } = validateWorkspaceRecord(goodRecord())
    assert.equal(valid, true)
    assert.deepEqual(errors, [])
  })

  test('accepts a record with no owner (owner is optional)', () => {
    const { valid } = validateWorkspaceRecord(goodRecord({ owner: undefined }))
    assert.equal(valid, true)
  })

  test('rejects a kind that is not exactly "local"', () => {
    for (const kind of ['Local', 'LOCAL', 'server-hosted', '', undefined, null]) {
      const { valid, errors } = validateWorkspaceRecord(goodRecord({ kind }))
      assert.equal(valid, false, `kind=${JSON.stringify(kind)} should be invalid`)
      assert.ok(errors.some((e) => e.includes('kind')))
    }
  })

  test('rejects a missing or whitespace-only name', () => {
    for (const name of [undefined, '', '   ', '\t\n']) {
      const { valid, errors } = validateWorkspaceRecord(goodRecord({ name }))
      assert.equal(valid, false, `name=${JSON.stringify(name)} should be invalid`)
      assert.ok(errors.some((e) => e.includes('name')))
    }
  })

  test('rejects a non-string owner', () => {
    const { valid, errors } = validateWorkspaceRecord(goodRecord({ owner: 42 }))
    assert.equal(valid, false)
    assert.ok(errors.some((e) => e.includes('owner')))
  })

  test('accepts a record with no description (description is optional)', () => {
    const { valid } = validateWorkspaceRecord(goodRecord({ description: undefined }))
    assert.equal(valid, true)
  })

  test('accepts a record with a description', () => {
    const { valid, errors } = validateWorkspaceRecord(goodRecord({ description: 'Bundled with Gantry' }))
    assert.equal(valid, true)
    assert.deepEqual(errors, [])
  })

  test('rejects a non-string description', () => {
    const { valid, errors } = validateWorkspaceRecord(goodRecord({ description: 42 }))
    assert.equal(valid, false)
    assert.ok(errors.some((e) => e.includes('description')))
  })

  test('rejects a createdAt that is not an ISO date string', () => {
    for (const createdAt of ['not-a-date', '2026-08-31', 1234567890, undefined]) {
      const { valid, errors } = validateWorkspaceRecord(goodRecord({ createdAt }))
      assert.equal(valid, false, `createdAt=${JSON.stringify(createdAt)} should be invalid`)
      assert.ok(errors.some((e) => e.includes('createdAt')))
    }
  })

  test('parseWorkspaceJson throws on invalid JSON', () => {
    assert.throws(() => parseWorkspaceJson('{ not json'), /not valid JSON/)
  })

  test('parseWorkspaceJson throws on a structurally invalid record', () => {
    assert.throws(
      () => parseWorkspaceJson(JSON.stringify(goodRecord({ kind: 'nope', name: ' ' }))),
      /invalid workspace\.json/,
    )
  })

  test('round-trips through serialize -> parse (with owner)', () => {
    const record = goodRecord()
    const parsed = parseWorkspaceJson(serializeWorkspaceJson(record))
    assert.deepEqual(parsed, {
      name: 'Demo Workspace',
      owner: 'alice',
      kind: 'local',
      createdAt: '2026-08-31T12:00:00.000Z',
    })
  })

  test('round-trips through serialize -> parse (no owner)', () => {
    const record = goodRecord({ owner: undefined })
    const parsed = parseWorkspaceJson(serializeWorkspaceJson(record))
    assert.deepEqual(parsed, {
      name: 'Demo Workspace',
      kind: 'local',
      createdAt: '2026-08-31T12:00:00.000Z',
    })
    assert.ok(!('owner' in parsed))
  })

  test('round-trips through serialize -> parse (with description)', () => {
    const record = goodRecord({ description: 'Bundled with Gantry' })
    const parsed = parseWorkspaceJson(serializeWorkspaceJson(record))
    assert.deepEqual(parsed, {
      name: 'Demo Workspace',
      description: 'Bundled with Gantry',
      owner: 'alice',
      kind: 'local',
      createdAt: '2026-08-31T12:00:00.000Z',
    })
  })

  test('round-trips through serialize -> parse (no description)', () => {
    const record = goodRecord({ description: undefined })
    const parsed = parseWorkspaceJson(serializeWorkspaceJson(record))
    assert.ok(!('description' in parsed))
  })

  test('serializeWorkspaceJson refuses an invalid record', () => {
    assert.throws(() => serializeWorkspaceJson(goodRecord({ kind: 'x' })), /cannot serialize/)
  })

  test('serialized text is pretty-printed with a trailing newline', () => {
    const text = serializeWorkspaceJson(goodRecord())
    assert.ok(text.endsWith('\n'))
    assert.ok(text.includes('\n  "name"'))
  })
})

// ---------------------------------------------------------------------------
// isSupported
// ---------------------------------------------------------------------------

describe('isSupported', () => {
  test('is false in an environment with no window.showDirectoryPicker', () => {
    // node:test runs this file with no DOM, so the module-load-time check
    // resolved to false.
    assert.equal(typeof window, 'undefined')
    assert.equal(isSupported, false)
  })
})

// ---------------------------------------------------------------------------
// ensurePermission
// ---------------------------------------------------------------------------

describe('ensurePermission', () => {
  test('returns "granted" without calling requestPermission when already granted', async () => {
    let requested = 0
    const handle = {
      async queryPermission() {
        return 'granted'
      },
      async requestPermission() {
        requested += 1
        return 'granted'
      },
    }
    assert.equal(await ensurePermission(handle), 'granted')
    assert.equal(requested, 0)
  })

  test('calls requestPermission when the query result is "prompt"', async () => {
    const calls = []
    const handle = {
      async queryPermission(opts) {
        calls.push(['query', opts.mode])
        return 'prompt'
      },
      async requestPermission(opts) {
        calls.push(['request', opts.mode])
        return 'granted'
      },
    }
    assert.equal(await ensurePermission(handle, 'readwrite'), 'granted')
    assert.deepEqual(calls, [
      ['query', 'readwrite'],
      ['request', 'readwrite'],
    ])
  })

  test('returns "denied" without throwing when permission is refused', async () => {
    const handle = {
      async queryPermission() {
        return 'prompt'
      },
      async requestPermission() {
        return 'denied'
      },
    }
    assert.equal(await ensurePermission(handle), 'denied')
  })

  test('returns "denied" without throwing when requestPermission rejects', async () => {
    const handle = {
      async queryPermission() {
        return 'prompt'
      },
      async requestPermission() {
        throw new Error('user dismissed')
      },
    }
    assert.equal(await ensurePermission(handle), 'denied')
  })
})

// ---------------------------------------------------------------------------
// Handle persistence (IndexedDB)
// ---------------------------------------------------------------------------

describe('recent local workspaces cache', () => {
  beforeEach(() => {
    // Fresh in-memory IndexedDB per test.
    globalThis.indexedDB = new IDBFactory()
  })

  test('rememberWorkspace then recentLocalWorkspaces returns the entry', async () => {
    const id = await rememberWorkspace({ handle: { kind: 'directory', name: 'demo' }, name: 'Demo' })
    assert.equal(typeof id, 'string')
    const recent = await recentLocalWorkspaces()
    assert.equal(recent.length, 1)
    assert.equal(recent[0].id, id)
    assert.equal(recent[0].name, 'Demo')
    assert.equal(typeof recent[0].lastOpened, 'string')
    // The opaque handle is not surfaced by the list accessor.
    assert.ok(!('handle' in recent[0]))
  })

  test('getWorkspaceHandle returns the stored handle; null for an unknown id', async () => {
    const handle = { kind: 'directory', name: 'demo' }
    const id = await rememberWorkspace({ handle, name: 'Demo' })
    assert.deepEqual(await getWorkspaceHandle(id), handle)
    assert.equal(await getWorkspaceHandle('no-such-id'), null)
  })

  test('defaults the name from the handle when none is given', async () => {
    const id = await rememberWorkspace({ handle: { kind: 'directory', name: 'from-handle' } })
    const recent = await recentLocalWorkspaces()
    assert.equal(recent.find((w) => w.id === id).name, 'from-handle')
  })

  test('forgetWorkspace removes the entry', async () => {
    const id = await rememberWorkspace({ handle: { kind: 'directory', name: 'demo' }, name: 'Demo' })
    await forgetWorkspace(id)
    assert.deepEqual(await recentLocalWorkspaces(), [])
    // Forgetting an unknown id is a no-op.
    await forgetWorkspace('no-such-id')
  })

  test('orders most-recently-opened first, and re-remembering bumps an entry', async () => {
    const a = await rememberWorkspace({ handle: { kind: 'directory', name: 'a' }, name: 'A' })
    const b = await rememberWorkspace({ handle: { kind: 'directory', name: 'b' }, name: 'B' })
    const c = await rememberWorkspace({ handle: { kind: 'directory', name: 'c' }, name: 'C' })

    assert.deepEqual(
      (await recentLocalWorkspaces()).map((w) => w.id),
      [c, b, a],
    )

    // Re-open A: it should jump to the front, still three entries.
    await rememberWorkspace({ id: a, handle: { kind: 'directory', name: 'a' } })
    const recent = await recentLocalWorkspaces()
    assert.equal(recent.length, 3)
    assert.equal(recent[0].id, a)
    assert.equal(recent[0].name, 'A') // name preserved on upsert
  })

  test('recentLocalWorkspaces is empty when nothing has been remembered', async () => {
    assert.deepEqual(await recentLocalWorkspaces(), [])
  })
})

// ---------------------------------------------------------------------------
// File ops
// ---------------------------------------------------------------------------

describe('file ops over the gantry-workspace layout', () => {
  let root

  beforeEach(() => {
    root = new MemDirHandle('picked')
  })

  test('writeTextFile then readTextFile round-trips, creating intermediate dirs', async () => {
    const path = 'gantry-workspace/demo/instance.yaml'
    await writeTextFile(root, path, 'kind: demo\n')
    assert.equal(await readTextFile(root, path), 'kind: demo\n')

    // Intermediate directories were created.
    const top = await listDir(root)
    assert.deepEqual(top, [{ name: 'gantry-workspace', kind: 'directory' }])
  })

  test('listDir shows a written file with its kind', async () => {
    await writeTextFile(root, 'gantry-workspace/demo/instance.yaml', 'x: 1\n')
    await writeTextFile(root, 'gantry-workspace/workspace.json', '{}\n')
    const wsDir = await listDir(root, 'gantry-workspace')
    assert.deepEqual(wsDir, [
      { name: 'demo', kind: 'directory' },
      { name: 'workspace.json', kind: 'file' },
    ])
    const slugDir = await listDir(root, 'gantry-workspace/demo')
    assert.deepEqual(slugDir, [{ name: 'instance.yaml', kind: 'file' }])
  })

  test('binary round-trip', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    await writeBinaryFile(root, 'gantry-workspace/demo/assets/logo.bin', bytes)
    const read = await readBinaryFile(root, 'gantry-workspace/demo/assets/logo.bin')
    assert.deepEqual([...read], [...bytes])
  })

  test('rejects a "../" traversal path', async () => {
    await assert.rejects(() => readTextFile(root, '../secret'), /"\.\." segments/)
    await assert.rejects(() => writeTextFile(root, 'gantry-workspace/../../etc/passwd', 'x'), /"\.\." segments/)
    await assert.rejects(() => listDir(root, 'gantry-workspace/../..'), /"\.\." segments/)
  })

  test('rejects an absolute path', async () => {
    await assert.rejects(() => readTextFile(root, '/etc/passwd'), /must be relative/)
    await assert.rejects(() => writeTextFile(root, '/tmp/x', 'x'), /must be relative/)
    await assert.rejects(() => readTextFile(root, 'C:\\Windows\\system32'), /drive-letter|must be relative/)
  })

  test('rejects an empty path', async () => {
    await assert.rejects(() => readTextFile(root, ''), /non-empty relative path/)
  })

  test('reading a missing file rejects', async () => {
    await assert.rejects(() => readTextFile(root, 'gantry-workspace/demo/nope.yaml'), /NotFoundError/)
  })

  test('getFileLastModified reports a numeric timestamp that advances on rewrite (WI #357)', async () => {
    const path = 'gantry-workspace/demo/instance.yaml'
    await writeTextFile(root, path, 'kind: demo\n')
    const firstStamp = await getFileLastModified(root, path)
    assert.equal(typeof firstStamp, 'number')

    await new Promise((resolve) => setTimeout(resolve, 2))
    await writeTextFile(root, path, 'kind: demo\nstage: shape\n')
    const secondStamp = await getFileLastModified(root, path)
    assert.ok(secondStamp >= firstStamp, 'a rewrite should not report an earlier timestamp than the original write')
  })

  test('getFileLastModified on a missing file rejects', async () => {
    await assert.rejects(() => getFileLastModified(root, 'gantry-workspace/demo/nope.yaml'), /NotFoundError/)
  })
})
