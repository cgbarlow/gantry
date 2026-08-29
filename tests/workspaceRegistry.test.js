import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerWorkspace,
  resolveWorkspace,
  listWorkspaces,
  findWorkspaceByLocation,
  getOrCreateWorkspace,
  updateWorkspace,
  archiveWorkspace,
  restoreWorkspace,
  isWorkspaceArchived,
  assertValidTicketingSystem,
  TICKETING_SYSTEMS,
  DEFAULT_TICKETING_SYSTEM,
} from '../lib/workspaceRegistry.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const LOCATION = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }

// ---------- registerWorkspace ----------

test('registerWorkspace persists organization/project/repository/owner/ticketingSystem, and generates an id', () => {
  withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ ...LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(typeof workspace.id, 'string')
    assert.ok(workspace.id.length > 0)
    assert.equal(workspace.organization, 'fake-org')
    assert.equal(workspace.project, 'fake-project')
    assert.equal(workspace.repository, 'fake-repo')
    assert.equal(workspace.owner, 'c.barlow')
    assert.equal(workspace.ticketingSystem, DEFAULT_TICKETING_SYSTEM)
  })
})

test('registerWorkspace defaults owner to \'\' and ticketingSystem to \'azure-devops\' when omitted', () => {
  withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(LOCATION, { instancesDir })
    assert.equal(workspace.owner, '')
    assert.equal(workspace.ticketingSystem, 'azure-devops')
  })
})

test('registerWorkspace persists an optional baseUrl', () => {
  withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ ...LOCATION, baseUrl: 'https://ado.example.internal' }, { instancesDir })
    assert.equal(workspace.baseUrl, 'https://ado.example.internal')
  })
})

test('registerWorkspace rejects a location missing organization/project/repository', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ organization: 'org' }, { instancesDir }),
      /missing: project, repository/
    )
  })
})

test('registerWorkspace rejects ticketingSystem "jira" — modeled, but not accepted yet', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ ...LOCATION, ticketingSystem: 'jira' }, { instancesDir }),
      /not supported yet/
    )
  })
})

test('registerWorkspace rejects a completely unknown ticketingSystem value', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ ...LOCATION, ticketingSystem: 'trello' }, { instancesDir }),
      /Unknown ticketing system/
    )
  })
})

test('registerWorkspace always creates a fresh id, even for a repeated organization/project/repository tuple', () => {
  withScratchInstances((instancesDir) => {
    const first = registerWorkspace(LOCATION, { instancesDir })
    const second = registerWorkspace(LOCATION, { instancesDir })
    assert.notEqual(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 2)
  })
})

// ---------- resolveWorkspace / listWorkspaces ----------

test('resolveWorkspace round-trips a registered workspace by id', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    assert.deepEqual(resolveWorkspace(created.id, { instancesDir }), created)
  })
})

test('resolveWorkspace returns undefined for an unknown id', () => {
  withScratchInstances((instancesDir) => {
    assert.equal(resolveWorkspace('nowhere', { instancesDir }), undefined)
  })
})

test('listWorkspaces returns an empty array when nothing is registered', () => {
  withScratchInstances((instancesDir) => {
    assert.deepEqual(listWorkspaces({ instancesDir }), [])
  })
})

test('listWorkspaces lists every workspace, sorted by id', () => {
  withScratchInstances((instancesDir) => {
    const a = registerWorkspace(LOCATION, { instancesDir })
    const b = registerWorkspace({ organization: 'other-org', project: 'p', repository: 'r' }, { instancesDir })
    const ids = listWorkspaces({ instancesDir }).map((w) => w.id)
    assert.deepEqual(ids, [a.id, b.id].sort())
  })
})

test('the workspace registry survives across separate calls (a fresh call sees a previous call\'s registration)', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    // Each of these calls re-reads the registry file from scratch — no shared in-memory state — so this only passes if persistence is real.
    assert.deepEqual(resolveWorkspace(created.id, { instancesDir }), created)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('the registered workspace is actually written to disk as JSON, keyed by id', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    const registryPath = join(instancesDir, 'workspace-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(persisted[created.id], {
      organization: 'fake-org',
      project: 'fake-project',
      repository: 'fake-repo',
      owner: '',
      ticketingSystem: 'azure-devops',
    })
  })
})

// ---------- findWorkspaceByLocation / getOrCreateWorkspace ----------

test('findWorkspaceByLocation finds an existing workspace by its exact organization/project/repository tuple', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    assert.deepEqual(findWorkspaceByLocation(LOCATION, { instancesDir }), created)
  })
})

test('findWorkspaceByLocation returns undefined when no workspace matches', () => {
  withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ organization: 'other-org', project: 'p', repository: 'r' }, { instancesDir }),
      undefined
    )
  })
})

test('findWorkspaceByLocation treats baseUrl as part of the match — same org/project/repo but a different baseUrl is a different workspace', () => {
  withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ ...LOCATION, baseUrl: 'https://ado.example.internal' }, { instancesDir }),
      undefined
    )
  })
})

test('getOrCreateWorkspace reuses an existing workspace for the same tuple rather than creating a duplicate', () => {
  withScratchInstances((instancesDir) => {
    const first = getOrCreateWorkspace(LOCATION, { instancesDir })
    const second = getOrCreateWorkspace(LOCATION, { instancesDir })
    assert.equal(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('getOrCreateWorkspace creates a new workspace when nothing matches yet', () => {
  withScratchInstances((instancesDir) => {
    const workspace = getOrCreateWorkspace(LOCATION, { instancesDir })
    assert.deepEqual(resolveWorkspace(workspace.id, { instancesDir }), workspace)
  })
})

// ---------- updateWorkspace ----------

test('updateWorkspace updates owner and re-persists it', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    const updated = updateWorkspace(created.id, { owner: 'c.barlow' }, { instancesDir })
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(resolveWorkspace(created.id, { instancesDir }).owner, 'c.barlow')
  })
})

test('updateWorkspace rejects setting ticketingSystem to "jira"', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    assert.throws(
      () => updateWorkspace(created.id, { ticketingSystem: 'jira' }, { instancesDir }),
      /not supported yet/
    )
    // The rejected update must not have been persisted.
    assert.equal(resolveWorkspace(created.id, { instancesDir }).ticketingSystem, 'azure-devops')
  })
})

test('updateWorkspace throws for an unknown workspace id', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(() => updateWorkspace('nowhere', { owner: 'x' }, { instancesDir }), /Unknown workspace/)
  })
})

// ---------- id lookups must never match an inherited property ----------

test('resolveWorkspace returns undefined for "__proto__" — an inherited property, never a real registry entry', () => {
  withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.equal(resolveWorkspace('__proto__', { instancesDir }), undefined)
  })
})

test('updateWorkspace throws "Unknown workspace" for "__proto__" rather than treating it as an existing entry', () => {
  withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.throws(() => updateWorkspace('__proto__', { owner: 'x' }, { instancesDir }), /Unknown workspace/)
  })
})

// ---------- ticketing-system validation (shared enforcement point) ----------

test('TICKETING_SYSTEMS models both azure-devops and jira, so a future selector can list jira as a known-but-disabled option', () => {
  assert.deepEqual(TICKETING_SYSTEMS, ['azure-devops', 'jira'])
})

test('assertValidTicketingSystem accepts "azure-devops" and rejects "jira" and anything unknown', () => {
  assert.doesNotThrow(() => assertValidTicketingSystem('azure-devops'))
  assert.throws(() => assertValidTicketingSystem('jira'), /not supported yet/)
  assert.throws(() => assertValidTicketingSystem('trello'), /Unknown ticketing system/)
})

// ---------- #223: archive / restore ----------

test('archiveWorkspace sets archived: true; restoreWorkspace removes the flag entirely (exact prior state)', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ ...LOCATION, owner: 'c.barlow' }, { instancesDir })

    const archived = archiveWorkspace(created.id, { instancesDir })
    assert.equal(archived.archived, true)
    assert.equal(isWorkspaceArchived(created.id, { instancesDir }), true)

    const restored = restoreWorkspace(created.id, { instancesDir })
    assert.equal(restored.archived, undefined)
    assert.equal(isWorkspaceArchived(created.id, { instancesDir }), false)
    // Back to byte-for-byte the record it was registered as.
    assert.deepEqual(restored, created)
  })
})

test('archiveWorkspace writes canonical JSON with archived last, and restore rewrites without it', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ ...LOCATION, baseUrl: 'https://ado.example.internal' }, { instancesDir })
    const registryPath = join(instancesDir, 'workspace-registry.json')

    archiveWorkspace(created.id, { instancesDir })
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(registryPath, 'utf8'))[created.id]), [
      'organization',
      'project',
      'repository',
      'baseUrl',
      'owner',
      'ticketingSystem',
      'archived',
    ])

    restoreWorkspace(created.id, { instancesDir })
    const restoredKeys = Object.keys(JSON.parse(readFileSync(registryPath, 'utf8'))[created.id])
    assert.ok(!restoredKeys.includes('archived'))
  })
})

test('listWorkspaces excludes archived by default, includes them with includeArchived', () => {
  withScratchInstances((instancesDir) => {
    const a = registerWorkspace(LOCATION, { instancesDir })
    const b = registerWorkspace({ organization: 'other-org', project: 'p', repository: 'r' }, { instancesDir })
    archiveWorkspace(b.id, { instancesDir })

    assert.deepEqual(listWorkspaces({ instancesDir }).map((w) => w.id), [a.id])
    assert.deepEqual(
      listWorkspaces({ instancesDir, includeArchived: true }).map((w) => w.id).sort(),
      [a.id, b.id].sort()
    )
    // The archived one carries archived: true on the includeArchived listing.
    assert.equal(
      listWorkspaces({ instancesDir, includeArchived: true }).find((w) => w.id === b.id).archived,
      true
    )
  })
})

test('archiveWorkspace / restoreWorkspace are idempotent, and throw for an unknown id', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    archiveWorkspace(created.id, { instancesDir })
    assert.doesNotThrow(() => archiveWorkspace(created.id, { instancesDir }))
    restoreWorkspace(created.id, { instancesDir })
    assert.doesNotThrow(() => restoreWorkspace(created.id, { instancesDir }))

    assert.throws(() => archiveWorkspace('nowhere', { instancesDir }), /Unknown workspace/)
    assert.throws(() => restoreWorkspace('nowhere', { instancesDir }), /Unknown workspace/)
  })
})

test('updateWorkspace preserves an archived flag through an unrelated owner edit', () => {
  withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    archiveWorkspace(created.id, { instancesDir })

    const updated = updateWorkspace(created.id, { owner: 'c.barlow' }, { instancesDir })
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(updated.archived, true)
    assert.equal(isWorkspaceArchived(created.id, { instancesDir }), true)
  })
})
