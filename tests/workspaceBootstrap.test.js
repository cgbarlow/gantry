import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBootstrapWorkspaces, applyBootstrapWorkspaces } from '../lib/workspaceBootstrap.js'
import { deriveWorkspaceId, listWorkspaces, findWorkspaceByLocation, registerWorkspace } from '../lib/workspaceRegistry.js'
import { createServer } from '../lib/server.js'
import { withScratchInstances, withRunningServer, withRunningExamplesServer } from './helpers/lifecycle.js'

const GITHUB_LOCATION = { owner: 'cgbarlow', repository: 'gantry-workspace-testing' }
const GITHUB_DECLARATION = { provider: 'github', location: GITHUB_LOCATION, owner: 'c.barlow' }

function withEnv(env, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const result = fn()
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  if (result && typeof result.then === 'function') {
    return result.finally(restore)
  }
  restore()
  return result
}

// ---------------------------------------------------------------------------
// parseBootstrapWorkspaces
// ---------------------------------------------------------------------------

test('parseBootstrapWorkspaces: unset/undefined is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapWorkspaces(undefined), [])
})

test('parseBootstrapWorkspaces: null is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapWorkspaces(null), [])
})

test('parseBootstrapWorkspaces: empty/whitespace-only string is a no-op, not an error', () => {
  assert.deepEqual(parseBootstrapWorkspaces(''), [])
  assert.deepEqual(parseBootstrapWorkspaces('   \n '), [])
})

test('parseBootstrapWorkspaces: a valid JSON array of declarations parses through unchanged', () => {
  const raw = JSON.stringify([GITHUB_DECLARATION])
  assert.deepEqual(parseBootstrapWorkspaces(raw), [GITHUB_DECLARATION])
})

test('parseBootstrapWorkspaces: malformed JSON throws one line naming GANTRY_BOOTSTRAP_WORKSPACES', () => {
  assert.throws(
    () => parseBootstrapWorkspaces('{not json'),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES must be valid JSON:/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: a JSON object (not an array) throws, naming the env var', () => {
  assert.throws(
    () => parseBootstrapWorkspaces(JSON.stringify({ provider: 'github', location: GITHUB_LOCATION })),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES must be a JSON array/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: an entry with an unknown provider throws, naming the env var', () => {
  const raw = JSON.stringify([{ provider: 'trello', location: GITHUB_LOCATION }])
  assert.throws(
    () => parseBootstrapWorkspaces(raw),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES/)
      assert.match(err.message, /unknown provider "trello"/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: an entry missing location throws, naming the env var', () => {
  const raw = JSON.stringify([{ provider: 'github', owner: 'c.barlow' }])
  assert.throws(
    () => parseBootstrapWorkspaces(raw),
    (err) => {
      assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES/)
      assert.match(err.message, /missing required field "location"/)
      return true
    }
  )
})

test('parseBootstrapWorkspaces: defaults an entry with no provider to azure-devops (valid) rather than rejecting it', () => {
  const raw = JSON.stringify([{ location: { organization: 'org', project: 'proj', repository: 'repo' } }])
  const parsed = parseBootstrapWorkspaces(raw)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].provider, undefined)
})

// ---------------------------------------------------------------------------
// applyBootstrapWorkspaces
// ---------------------------------------------------------------------------

test('applyBootstrapWorkspaces registers a declared workspace with its derived id', async () => {
  await withScratchInstances((instancesDir) => {
    const [workspace] = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    assert.equal(workspace.id, deriveWorkspaceId('github', GITHUB_LOCATION))
    assert.deepEqual(workspace.location, GITHUB_LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
  })
})

test('applyBootstrapWorkspaces is idempotent across two applications — no duplicates, same ids both times', async () => {
  await withScratchInstances((instancesDir) => {
    const first = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    const second = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    assert.equal(first[0].id, second[0].id)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('applyBootstrapWorkspaces restores a declared workspace to the same id even after the registry file is wiped clean', async () => {
  await withScratchInstances((instancesDir1) => {
    const before = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir: instancesDir1 })

    // A fresh, empty registry — nothing on disk to find-by-location any more, the way a fully
    // ephemeral container filesystem restarts.
    return withScratchInstances((instancesDir2) => {
      const after = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir: instancesDir2 })
      assert.equal(after[0].id, before[0].id)
      assert.equal(after[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
    })
  })
})

test('an explicit id on a declaration is used instead of the derived one', async () => {
  await withScratchInstances((instancesDir) => {
    const explicitId = 'my-pinned-workspace-id'
    const [workspace] = applyBootstrapWorkspaces([{ ...GITHUB_DECLARATION, id: explicitId }], { instancesDir })
    assert.equal(workspace.id, explicitId)
    assert.notEqual(workspace.id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

test('applyBootstrapWorkspaces never re-keys a workspace that already exists at that location under a different (pre-existing) id', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(findWorkspaceByLocation({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir }), undefined)

    // Register it first under a random id, the way a pre-#111 caller (e.g. the wizard) might have.
    const randomlyRegistered = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })

    const [applied] = applyBootstrapWorkspaces([GITHUB_DECLARATION], { instancesDir })
    assert.equal(applied.id, randomlyRegistered.id)
    assert.notEqual(applied.id, deriveWorkspaceId('github', GITHUB_LOCATION))
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

// ---------------------------------------------------------------------------
// createServer wiring: GANTRY_BOOTSTRAP_WORKSPACES / options.bootstrapWorkspaces
// ---------------------------------------------------------------------------

test('createServer applies options.bootstrapWorkspaces at startup, registering the declared workspace', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir, bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]) }, async (base) => {
      const res = await fetch(`${base}/api/workspaces`)
      const listing = await res.json()
      assert.equal(listing.length, 1)
      assert.equal(listing[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
      assert.deepEqual(listing[0].location, GITHUB_LOCATION)
    })
  })
})

test('createServer bootstrap is idempotent across restarts — starting twice against the same instancesDir registers no duplicates and keeps the same id', async () => {
  await withScratchInstances((instancesDir) => {
    const options = { instancesDir, bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]), migrateWorkspacesOnStart: true }
    const first = createServer(options)
    first.close?.()
    const second = createServer(options)
    second.close?.()

    const listing = listWorkspaces({ instancesDir })
    assert.equal(listing.length, 1)
    assert.equal(listing[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

test('createServer falls back to process.env.GANTRY_BOOTSTRAP_WORKSPACES when options.bootstrapWorkspaces is not supplied', async () => {
  await withScratchInstances((instancesDir) => {
    withEnv({ GANTRY_BOOTSTRAP_WORKSPACES: JSON.stringify([GITHUB_DECLARATION]) }, () => {
      const server = createServer({ instancesDir, migrateWorkspacesOnStart: true })
      server.close?.()
    })
    const listing = listWorkspaces({ instancesDir })
    assert.equal(listing.length, 1)
    assert.equal(listing[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})

test('createServer does not apply GANTRY_BOOTSTRAP_WORKSPACES unless migrateWorkspacesOnStart is set — same gate as the migrate/ensure-default-workspace block', async () => {
  await withScratchInstances((instancesDir) => {
    const server = createServer({ instancesDir, bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]) })
    server.close?.()
    assert.equal(listWorkspaces({ instancesDir }).length, 0)
  })
})

test('createServer throws (rather than starting) when GANTRY_BOOTSTRAP_WORKSPACES is malformed JSON', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: '{not json' }),
      (err) => {
        assert.match(err.message, /^GANTRY_BOOTSTRAP_WORKSPACES must be valid JSON:/)
        return true
      }
    )
  })
})

test('createServer throws when GANTRY_BOOTSTRAP_WORKSPACES names an unknown provider', async () => {
  await withScratchInstances((instancesDir) => {
    const raw = JSON.stringify([{ provider: 'trello', location: GITHUB_LOCATION }])
    assert.throws(
      () => createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: raw }),
      /GANTRY_BOOTSTRAP_WORKSPACES.*unknown provider "trello"/
    )
  })
})

test('createServer throws when a GANTRY_BOOTSTRAP_WORKSPACES entry is missing location', async () => {
  await withScratchInstances((instancesDir) => {
    const raw = JSON.stringify([{ provider: 'github', owner: 'c.barlow' }])
    assert.throws(
      () => createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: raw }),
      /GANTRY_BOOTSTRAP_WORKSPACES.*missing required field "location"/
    )
  })
})

test('an unset GANTRY_BOOTSTRAP_WORKSPACES is a no-op — createServer boots cleanly with an empty workspace registry', async () => {
  await withScratchInstances((instancesDir) => {
    withEnv({ GANTRY_BOOTSTRAP_WORKSPACES: undefined }, () => {
      const server = createServer({ instancesDir, migrateWorkspacesOnStart: true })
      server.close?.()
    })
    assert.equal(listWorkspaces({ instancesDir }).length, 0)
  })
})

// ---------------------------------------------------------------------------
// The bundled Examples workspace stays visible — bootstrapping never touches GANTRY_WORKSPACES_DIR
// ---------------------------------------------------------------------------

test('bootstrapping a workspace does not hide the bundled Examples workspace/instances — GANTRY_WORKSPACES_DIR is never touched', async () => {
  await withRunningExamplesServer({ bootstrapWorkspaces: JSON.stringify([GITHUB_DECLARATION]) }, async (base) => {
    const instanceRes = await fetch(`${base}/api/instance`)
    assert.equal(instanceRes.status, 200)
    const instance = await instanceRes.json()
    assert.equal(instance.slug, 'examples')

    const workspacesRes = await fetch(`${base}/api/workspaces`)
    const workspaces = await workspacesRes.json()
    assert.equal(workspaces.length, 1)
    assert.equal(workspaces[0].id, deriveWorkspaceId('github', GITHUB_LOCATION))
  })
})
