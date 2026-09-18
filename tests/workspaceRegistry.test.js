import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  assertValidProvider,
  PROVIDERS,
  AVAILABLE_PROVIDERS,
  DEFAULT_PROVIDER,
} from '../lib/workspaceRegistry.js'
import { withScratchInstances } from './helpers/lifecycle.js'


const LOCATION = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }

// ---------- registerWorkspace ----------

test('registerWorkspace persists organization/project/repository/owner/ticketingSystem, and generates an id', async () => {
  await withScratchInstances((instancesDir) => {
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

test('registerWorkspace defaults owner to \'\' and ticketingSystem to \'azure-devops\' when omitted', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(LOCATION, { instancesDir })
    assert.equal(workspace.owner, '')
    assert.equal(workspace.ticketingSystem, 'azure-devops')
  })
})

test('registerWorkspace persists an optional baseUrl', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ ...LOCATION, baseUrl: 'https://ado.example.internal' }, { instancesDir })
    assert.equal(workspace.baseUrl, 'https://ado.example.internal')
  })
})

test('registerWorkspace rejects a location missing organization/project/repository', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ organization: 'org' }, { instancesDir }),
      /missing: project, repository/
    )
  })
})

test('registerWorkspace rejects ticketingSystem "jira" — modeled, but not accepted yet', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ ...LOCATION, ticketingSystem: 'jira' }, { instancesDir }),
      /not supported yet/
    )
  })
})

test('registerWorkspace rejects a completely unknown ticketingSystem value', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ ...LOCATION, ticketingSystem: 'trello' }, { instancesDir }),
      /Unknown ticketing system/
    )
  })
})

test('registerWorkspace always creates a fresh id, even for a repeated organization/project/repository tuple', async () => {
  await withScratchInstances((instancesDir) => {
    const first = registerWorkspace(LOCATION, { instancesDir })
    const second = registerWorkspace(LOCATION, { instancesDir })
    assert.notEqual(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 2)
  })
})

// ---------- resolveWorkspace / listWorkspaces ----------

test('resolveWorkspace round-trips a registered workspace by id', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    assert.deepEqual(resolveWorkspace(created.id, { instancesDir }), created)
  })
})

test('resolveWorkspace returns undefined for an unknown id', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(resolveWorkspace('nowhere', { instancesDir }), undefined)
  })
})

test('listWorkspaces returns an empty array when nothing is registered', async () => {
  await withScratchInstances((instancesDir) => {
    assert.deepEqual(listWorkspaces({ instancesDir }), [])
  })
})

test('listWorkspaces lists every workspace, sorted by id', async () => {
  await withScratchInstances((instancesDir) => {
    const a = registerWorkspace(LOCATION, { instancesDir })
    const b = registerWorkspace({ organization: 'other-org', project: 'p', repository: 'r' }, { instancesDir })
    const ids = listWorkspaces({ instancesDir }).map((w) => w.id)
    assert.deepEqual(ids, [a.id, b.id].sort())
  })
})

test('the workspace registry survives across separate calls (a fresh call sees a previous call\'s registration)', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    // Each of these calls re-reads the registry file from scratch — no shared in-memory state — so this only passes if persistence is real.
    assert.deepEqual(resolveWorkspace(created.id, { instancesDir }), created)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('the registered workspace is actually written to disk as JSON, keyed by id', async () => {
  await withScratchInstances((instancesDir) => {
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

test('findWorkspaceByLocation finds an existing workspace by its exact organization/project/repository tuple', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    assert.deepEqual(findWorkspaceByLocation(LOCATION, { instancesDir }), created)
  })
})

test('findWorkspaceByLocation returns undefined when no workspace matches', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ organization: 'other-org', project: 'p', repository: 'r' }, { instancesDir }),
      undefined
    )
  })
})

test('findWorkspaceByLocation treats baseUrl as part of the match — same org/project/repo but a different baseUrl is a different workspace', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ ...LOCATION, baseUrl: 'https://ado.example.internal' }, { instancesDir }),
      undefined
    )
  })
})

test('getOrCreateWorkspace reuses an existing workspace for the same tuple rather than creating a duplicate', async () => {
  await withScratchInstances((instancesDir) => {
    const first = getOrCreateWorkspace(LOCATION, { instancesDir })
    const second = getOrCreateWorkspace(LOCATION, { instancesDir })
    assert.equal(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('getOrCreateWorkspace creates a new workspace when nothing matches yet', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = getOrCreateWorkspace(LOCATION, { instancesDir })
    assert.deepEqual(resolveWorkspace(workspace.id, { instancesDir }), workspace)
  })
})

// ---------- updateWorkspace ----------

test('updateWorkspace updates owner and re-persists it', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    const updated = updateWorkspace(created.id, { owner: 'c.barlow' }, { instancesDir })
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(resolveWorkspace(created.id, { instancesDir }).owner, 'c.barlow')
  })
})

test('updateWorkspace rejects setting ticketingSystem to "jira"', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    assert.throws(
      () => updateWorkspace(created.id, { ticketingSystem: 'jira' }, { instancesDir }),
      /not supported yet/
    )
    // The rejected update must not have been persisted.
    assert.equal(resolveWorkspace(created.id, { instancesDir }).ticketingSystem, 'azure-devops')
  })
})

test('updateWorkspace throws for an unknown workspace id', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => updateWorkspace('nowhere', { owner: 'x' }, { instancesDir }), /Unknown workspace/)
  })
})

// ---------- id lookups must never match an inherited property ----------

test('resolveWorkspace returns undefined for "__proto__" — an inherited property, never a real registry entry', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace(LOCATION, { instancesDir })
    assert.equal(resolveWorkspace('__proto__', { instancesDir }), undefined)
  })
})

test('updateWorkspace throws "Unknown workspace" for "__proto__" rather than treating it as an existing entry', async () => {
  await withScratchInstances((instancesDir) => {
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

test('archiveWorkspace sets archived: true; restoreWorkspace removes the flag entirely (exact prior state)', async () => {
  await withScratchInstances((instancesDir) => {
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

test('archiveWorkspace writes canonical JSON with archived last, and restore rewrites without it', async () => {
  await withScratchInstances((instancesDir) => {
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

test('listWorkspaces excludes archived by default, includes them with includeArchived', async () => {
  await withScratchInstances((instancesDir) => {
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

test('archiveWorkspace / restoreWorkspace are idempotent, and throw for an unknown id', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    archiveWorkspace(created.id, { instancesDir })
    assert.doesNotThrow(() => archiveWorkspace(created.id, { instancesDir }))
    restoreWorkspace(created.id, { instancesDir })
    assert.doesNotThrow(() => restoreWorkspace(created.id, { instancesDir }))

    assert.throws(() => archiveWorkspace('nowhere', { instancesDir }), /Unknown workspace/)
    assert.throws(() => restoreWorkspace('nowhere', { instancesDir }), /Unknown workspace/)
  })
})

test('updateWorkspace preserves an archived flag through an unrelated owner edit', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    archiveWorkspace(created.id, { instancesDir })

    const updated = updateWorkspace(created.id, { owner: 'c.barlow' }, { instancesDir })
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(updated.archived, true)
    assert.equal(isWorkspaceArchived(created.id, { instancesDir }), true)
  })
})

// ---------- #8: Provider (docs/adr/0037) ----------

const GITHUB_LOCATION = { provider: 'github', repoOwner: 'octocat', repository: 'hello-world' }

test('PROVIDERS models azure-devops, github and atlassian; AVAILABLE_PROVIDERS is the narrower accepted set', () => {
  assert.deepEqual(PROVIDERS, ['azure-devops', 'github', 'atlassian'])
  assert.deepEqual(AVAILABLE_PROVIDERS, ['azure-devops', 'github'])
  assert.equal(DEFAULT_PROVIDER, 'azure-devops')
})

test('assertValidProvider accepts azure-devops and github, rejects atlassian (modeled, not available) and anything unknown', () => {
  assert.doesNotThrow(() => assertValidProvider('azure-devops'))
  assert.doesNotThrow(() => assertValidProvider('github'))
  assert.throws(() => assertValidProvider('atlassian'), /not available yet/)
  assert.throws(() => assertValidProvider('bitbucket'), /Unknown provider/)
})

test('registerWorkspace omitting provider still defaults to azure-devops (unchanged pre-#8 behaviour)', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(LOCATION, { instancesDir })
    assert.equal(workspace.provider, 'azure-devops')
  })
})

test('registerWorkspace registers a github workspace with owner/repository, no organization/project/ticketingSystem required', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(GITHUB_LOCATION, { instancesDir })
    assert.equal(workspace.provider, 'github')
    assert.equal(workspace.repoOwner, 'octocat')
    assert.equal(workspace.repository, 'hello-world')
    assert.equal(workspace.organization, undefined)
    assert.equal(workspace.ticketingSystem, undefined)
  })
})

test('registerWorkspace persists a github workspace with no provider-specific ticketingSystem key on disk', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(GITHUB_LOCATION, { instancesDir })
    const registryPath = join(instancesDir, 'workspace-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(persisted[created.id], {
      provider: 'github',
      repoOwner: 'octocat',
      repository: 'hello-world',
      owner: '',
    })
  })
})

test('an azure-devops workspace registered the pre-#8 way is still persisted with no explicit provider key at all', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    const registryPath = join(instancesDir, 'workspace-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.ok(!Object.hasOwn(persisted[created.id], 'provider'))
    // ...but is still read forward as 'azure-devops' on the public object (ADR-0037's read-forward convention).
    assert.equal(created.provider, 'azure-devops')
  })
})

test('registerWorkspace rejects a github location missing owner/repository, naming the wizard-facing field name', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'github', repository: 'hello-world' }, { instancesDir }),
      /missing: owner/
    )
    assert.throws(
      () => registerWorkspace({ provider: 'github', repoOwner: 'octocat' }, { instancesDir }),
      /missing: repository/
    )
  })
})

test('registerWorkspace rejects provider "atlassian" — modeled, but not available yet', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'atlassian', repoOwner: 'x', repository: 'y' }, { instancesDir }),
      /not available yet/
    )
  })
})

test('findWorkspaceByLocation distinguishes an azure-devops workspace from a github workspace sharing the same repository name', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = registerWorkspace({ organization: 'shared', project: 'shared', repository: 'shared-name' }, { instancesDir })
    const gh = registerWorkspace({ provider: 'github', repoOwner: 'shared', repository: 'shared-name' }, { instancesDir })
    assert.notEqual(ado.id, gh.id)

    assert.equal(
      findWorkspaceByLocation({ organization: 'shared', project: 'shared', repository: 'shared-name' }, { instancesDir }).id,
      ado.id
    )
    assert.equal(
      findWorkspaceByLocation({ provider: 'github', repoOwner: 'shared', repository: 'shared-name' }, { instancesDir }).id,
      gh.id
    )
  })
})

test('getOrCreateWorkspace reuses an existing github workspace for the same owner/repository tuple rather than creating a duplicate', async () => {
  await withScratchInstances((instancesDir) => {
    const first = getOrCreateWorkspace(GITHUB_LOCATION, { instancesDir })
    const second = getOrCreateWorkspace(GITHUB_LOCATION, { instancesDir })
    assert.equal(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('updateWorkspace updates a github workspace\'s owner (person) without requiring organization/project/ticketingSystem', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(GITHUB_LOCATION, { instancesDir })
    const updated = updateWorkspace(created.id, { owner: 'c.barlow' }, { instancesDir })
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(updated.provider, 'github')
    assert.equal(updated.repoOwner, 'octocat')
  })
})
