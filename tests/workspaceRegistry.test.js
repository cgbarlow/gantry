import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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
import { withScratchInstances } from './helpers/lifecycle.js'


const LOCATION = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
const GITHUB_LOCATION = { owner: 'octocat', repository: 'fake-repo' }

// ---------- registerWorkspace (pre-#3 flat shape — no consumer of this shape is migrated) ----------

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

// ---------- provider + nested location (#3, ADR-0037) ----------

test('registerWorkspace accepts the nested {provider, location} shape for an Azure DevOps workspace, and emits both the nested and flat shapes', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ provider: 'azure-devops', location: LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(workspace.provider, 'azure-devops')
    assert.deepEqual(workspace.location, LOCATION)
    assert.equal(workspace.organization, 'fake-org')
    assert.equal(workspace.project, 'fake-project')
    assert.equal(workspace.repository, 'fake-repo')
    assert.equal(workspace.ticketingSystem, 'azure-devops')
    assert.equal(workspace.owner, 'c.barlow')
  })
})

test('registerWorkspace accepts a GitHub {provider, location} — owner/repository, no project required', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(workspace.provider, 'github')
    assert.deepEqual(workspace.location, GITHUB_LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
    // No pre-#3 flat organization/project accessors for a provider that never had them.
    assert.equal(workspace.organization, undefined)
    assert.equal(workspace.project, undefined)
    assert.equal(workspace.ticketingSystem, undefined)
  })
})

test('registerWorkspace persists a GitHub workspace\'s optional baseUrl (GitHub Enterprise Server)', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(
      { provider: 'github', location: { ...GITHUB_LOCATION, baseUrl: 'https://ghe.example.internal' } },
      { instancesDir }
    )
    assert.equal(workspace.location.baseUrl, 'https://ghe.example.internal')
  })
})

test('registerWorkspace rejects a GitHub location missing owner or repository — never requires a project', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'github', location: { owner: 'octocat' } }, { instancesDir }),
      /missing: repository/
    )
    assert.throws(
      () => registerWorkspace({ provider: 'github', location: { repository: 'fake-repo' } }, { instancesDir }),
      /missing: owner/
    )
  })
})

test('registerWorkspace rejects an unknown provider', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'trello', location: GITHUB_LOCATION }, { instancesDir }),
      /Unknown provider/
    )
  })
})

test('registerWorkspace rejects "atlassian" — modeled, but not built yet', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'atlassian', location: {} }, { instancesDir }),
      /not supported yet/
    )
  })
})

test('a stray field for the wrong provider is dropped, not persisted — a GitHub location is never required to carry a project', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(
      { provider: 'github', location: { ...GITHUB_LOCATION, project: 'should-be-dropped' } },
      { instancesDir }
    )
    assert.deepEqual(workspace.location, GITHUB_LOCATION)
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

test('listWorkspaces lists Azure DevOps and GitHub workspaces side by side', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = registerWorkspace(LOCATION, { instancesDir })
    const gh = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })
    const providers = listWorkspaces({ instancesDir }).map((w) => [w.id, w.provider])
    assert.deepEqual(new Map(providers), new Map([[ado.id, 'azure-devops'], [gh.id, 'github']]))
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

test('the registered workspace is written to disk in the canonical nested {provider, location, owner} shape', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace(LOCATION, { instancesDir })
    const registryPath = join(instancesDir, 'workspace-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(persisted[created.id], {
      provider: 'azure-devops',
      location: { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      owner: '',
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

test('findWorkspaceByLocation matches within a provider only — a GitHub workspace sharing a repository name with an Azure DevOps one is distinct', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = registerWorkspace({ organization: 'shared', project: 'shared', repository: 'shared-repo' }, { instancesDir })
    const gh = registerWorkspace({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })

    assert.deepEqual(
      findWorkspaceByLocation({ organization: 'shared', project: 'shared', repository: 'shared-repo' }, { instancesDir }),
      ado
    )
    assert.deepEqual(
      findWorkspaceByLocation({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir }),
      gh
    )
    assert.notEqual(ado.id, gh.id)
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

test('getOrCreateWorkspace creates distinct workspaces for the same repository name on different providers', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = getOrCreateWorkspace({ organization: 'shared', project: 'shared', repository: 'shared-repo' }, { instancesDir })
    const gh = getOrCreateWorkspace({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })
    assert.notEqual(ado.id, gh.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 2)
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

test('updateWorkspace merges a partial nested location correction onto the existing one', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })
    const updated = updateWorkspace(created.id, { location: { repository: 'renamed-repo' } }, { instancesDir })
    assert.deepEqual(updated.location, { owner: 'octocat', repository: 'renamed-repo' })
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
      'provider',
      'location',
      'owner',
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

// ---------- read-forward: a pre-#3 flat record is lifted into {provider, location}, rewritten on next write ----------

function writeLegacyFlatRegistry(instancesDir, entries) {
  mkdirSync(instancesDir, { recursive: true })
  writeFileSync(join(instancesDir, 'workspace-registry.json'), JSON.stringify(entries, null, 2) + '\n')
}

test('a pre-#3 flat record is read forward as provider: "azure-devops" with its fields lifted into location', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-uuid-1'
    writeLegacyFlatRegistry(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', owner: 'a.person', ticketingSystem: 'azure-devops' },
    })

    const resolved = resolveWorkspace(legacyId, { instancesDir })
    assert.equal(resolved.provider, 'azure-devops')
    assert.deepEqual(resolved.location, { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' })
    // Flat accessors survive read-forward unchanged.
    assert.equal(resolved.organization, 'legacy-org')
    assert.equal(resolved.project, 'legacy-project')
    assert.equal(resolved.repository, 'legacy-repo')
    assert.equal(resolved.owner, 'a.person')
    assert.equal(resolved.ticketingSystem, 'azure-devops')
  })
})

test('a pre-#3 flat record\'s archived flag survives read-forward unchanged', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-uuid-2'
    writeLegacyFlatRegistry(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', owner: '', ticketingSystem: 'azure-devops', archived: true },
    })

    assert.equal(isWorkspaceArchived(legacyId, { instancesDir }), true)
    assert.equal(resolveWorkspace(legacyId, { instancesDir }).archived, true)
  })
})

test('a pre-#3 flat record is rewritten to the nested shape on disk the first time it is read', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-uuid-3'
    writeLegacyFlatRegistry(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', owner: '', ticketingSystem: 'azure-devops' },
    })

    resolveWorkspace(legacyId, { instancesDir })

    const registryPath = join(instancesDir, 'workspace-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(persisted[legacyId], {
      provider: 'azure-devops',
      location: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' },
      owner: '',
    })
  })
})

test('read-forward is idempotent — reading an already-migrated record twice produces the same result and does not rewrite again', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-uuid-4'
    writeLegacyFlatRegistry(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', owner: '', ticketingSystem: 'azure-devops' },
    })

    const first = resolveWorkspace(legacyId, { instancesDir })
    const registryPath = join(instancesDir, 'workspace-registry.json')
    const afterFirstRead = readFileSync(registryPath, 'utf8')

    const second = resolveWorkspace(legacyId, { instancesDir })
    const afterSecondRead = readFileSync(registryPath, 'utf8')

    assert.deepEqual(first, second)
    assert.equal(afterFirstRead, afterSecondRead)
  })
})

test('a flat record with no workspaceId-style scoping and a sibling already-nested record both resolve correctly in one registry', async () => {
  await withScratchInstances((instancesDir) => {
    const legacyId = 'legacy-uuid-5'
    writeLegacyFlatRegistry(instancesDir, {
      [legacyId]: { organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo', owner: '', ticketingSystem: 'azure-devops' },
    })
    const fresh = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })

    assert.equal(resolveWorkspace(legacyId, { instancesDir }).provider, 'azure-devops')
    assert.equal(resolveWorkspace(fresh.id, { instancesDir }).provider, 'github')
    assert.equal(listWorkspaces({ instancesDir }).length, 2)
  })
})
