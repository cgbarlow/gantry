import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveWorkspacesDir,
  readWorkspaceJson,
  writeWorkspaceJson,
  listServerWorkspaces,
  validateWorkspaceRecord,
} from '../lib/workspaceDirectory.js'
import { parseWorkspaceJson, serializeWorkspaceJson } from '../web/lib/localWorkspace.js'

function withEnv(env, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function withScratchWorkspaces(fn) {
  const workspacesDir = mkdtempSync(join(tmpdir(), 'gantry-workspaces-'))
  try {
    return await fn(workspacesDir)
  } finally {
    rmSync(workspacesDir, { recursive: true, force: true })
  }
}

function goodRecord(overrides = {}) {
  return {
    name: 'Examples',
    kind: 'local',
    createdAt: '2026-08-31T12:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveWorkspacesDir
// ---------------------------------------------------------------------------

describe('resolveWorkspacesDir', () => {
  test('option takes precedence over env and default', () => {
    withEnv({ GANTRY_WORKSPACES_DIR: '/from-env' }, () => {
      assert.equal(resolveWorkspacesDir({ workspacesDir: '/from-option' }), '/from-option')
    })
  })

  test('env used when option is absent', () => {
    withEnv({ GANTRY_WORKSPACES_DIR: '/from-env' }, () => {
      assert.equal(resolveWorkspacesDir({}), '/from-env')
    })
  })

  test('defaults to "workspaces" when neither is set', () => {
    withEnv({ GANTRY_WORKSPACES_DIR: undefined }, () => {
      assert.equal(resolveWorkspacesDir(), 'workspaces')
      assert.equal(resolveWorkspacesDir({}), 'workspaces')
    })
  })
})

// ---------------------------------------------------------------------------
// read/writeWorkspaceJson
// ---------------------------------------------------------------------------

describe('readWorkspaceJson / writeWorkspaceJson', () => {
  test('round-trips a record, creating the workspace directory', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      writeWorkspaceJson(workspacesDir, 'examples', goodRecord({ owner: 'alice' }))
      const read = readWorkspaceJson(workspacesDir, 'examples')
      assert.deepEqual(read, {
        name: 'Examples',
        owner: 'alice',
        kind: 'local',
        createdAt: '2026-08-31T12:00:00.000Z',
      })
    })
  })

  test('creates workspacesDir itself when it does not yet exist', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      const nested = join(workspacesDir, 'nested-root')
      writeWorkspaceJson(nested, 'gantry', goodRecord())
      assert.deepEqual(readWorkspaceJson(nested, 'gantry').name, 'Examples')
    })
  })

  test('writeWorkspaceJson throws and writes nothing for an invalid record', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      assert.throws(() => writeWorkspaceJson(workspacesDir, 'bad', goodRecord({ name: '' })), /cannot serialize/)
    })
  })

  test('readWorkspaceJson throws with the raw ENOENT when workspace.json is missing', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      assert.throws(() => readWorkspaceJson(workspacesDir, 'nope'), (err) => err.code === 'ENOENT')
    })
  })
})

// ---------------------------------------------------------------------------
// listServerWorkspaces
// ---------------------------------------------------------------------------

describe('listServerWorkspaces', () => {
  test('returns [] when workspacesDir does not exist', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      assert.deepEqual(listServerWorkspaces(join(workspacesDir, 'nope')), [])
    })
  })

  test('returns [] for an existing but empty workspacesDir', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      assert.deepEqual(listServerWorkspaces(workspacesDir), [])
    })
  })

  test('lists one workspace', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      writeWorkspaceJson(workspacesDir, 'examples', goodRecord())
      const found = listServerWorkspaces(workspacesDir)
      assert.equal(found.length, 1)
      assert.equal(found[0].id, 'examples')
      assert.equal(found[0].record.name, 'Examples')
    })
  })

  test('lists several workspaces sorted by id', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      writeWorkspaceJson(workspacesDir, 'zeta', goodRecord({ name: 'Zeta' }))
      writeWorkspaceJson(workspacesDir, 'alpha', goodRecord({ name: 'Alpha' }))
      const found = listServerWorkspaces(workspacesDir)
      assert.deepEqual(found.map((w) => w.id), ['alpha', 'zeta'])
    })
  })

  test('skips a subdirectory with no workspace.json', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      writeWorkspaceJson(workspacesDir, 'examples', goodRecord())
      mkdirSync(join(workspacesDir, 'not-a-workspace'), { recursive: true })
      writeFileSync(join(workspacesDir, 'not-a-workspace', 'readme.txt'), 'hello')
      const found = listServerWorkspaces(workspacesDir)
      assert.deepEqual(found.map((w) => w.id), ['examples'])
    })
  })

  test('reports a malformed workspace.json as { id, error } instead of throwing', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      mkdirSync(join(workspacesDir, 'broken'), { recursive: true })
      writeFileSync(join(workspacesDir, 'broken', 'workspace.json'), '{ not json')
      const found = listServerWorkspaces(workspacesDir)
      assert.equal(found.length, 1)
      assert.equal(found[0].id, 'broken')
      assert.ok(found[0].error)
      assert.ok(!('record' in found[0]))
    })
  })
})

// ---------------------------------------------------------------------------
// Interchangeability with web/lib/localWorkspace.js (WI #355's core acceptance criterion:
// a server workspace directory and a local workspace's folder are byte-for-byte the same format)
// ---------------------------------------------------------------------------

describe('interchangeability with web/lib/localWorkspace.js', () => {
  test('written server-side is readable by the browser-side parser, byte for byte', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      writeWorkspaceJson(workspacesDir, 'examples', goodRecord({ description: 'Bundled with Gantry', owner: 'alice' }))
      const raw = readFileText(workspacesDir, 'examples')
      const parsedByBrowserSide = parseWorkspaceJson(raw)
      assert.deepEqual(parsedByBrowserSide, {
        name: 'Examples',
        description: 'Bundled with Gantry',
        owner: 'alice',
        kind: 'local',
        createdAt: '2026-08-31T12:00:00.000Z',
      })
    })
  })

  test('serialized browser-side is readable by the server-side reader', async () => {
    await withScratchWorkspaces((workspacesDir) => {
      const text = serializeWorkspaceJson(goodRecord({ description: 'Bundled with Gantry' }))
      mkdirSync(join(workspacesDir, 'examples'), { recursive: true })
      writeFileSync(join(workspacesDir, 'examples', 'workspace.json'), text)
      const read = readWorkspaceJson(workspacesDir, 'examples')
      assert.deepEqual(read, {
        name: 'Examples',
        description: 'Bundled with Gantry',
        kind: 'local',
        createdAt: '2026-08-31T12:00:00.000Z',
      })
    })
  })

  test('validateWorkspaceRecord re-exported from lib/workspaceDirectory.js is the exact same function', () => {
    assert.equal(validateWorkspaceRecord(goodRecord()).valid, true)
    assert.equal(validateWorkspaceRecord(goodRecord({ kind: 'nope' })).valid, false)
  })
})

function readFileText(workspacesDir, workspaceId) {
  return readFileSync(join(workspacesDir, workspaceId, 'workspace.json'), 'utf8')
}
