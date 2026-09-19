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
} from '../lib/workspaceRegistry.js'
import { withScratchInstances } from './helpers/lifecycle.js'


const LOCATION = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
const GITHUB_LOCATION = { owner: 'octocat', repository: 'fake-repo' }
const GITLAB_LOCATION = { namespace: 'fake-group/fake-subgroup', repository: 'fake-repo' }
const ATLASSIAN_LOCATION = { owner: 'acme', repository: 'fake-repo', jiraSite: 'acme.atlassian.net', jiraProjectKey: 'PROJ' }

// ---------- registerWorkspace: nested {provider, location} shape only (ticket #6) ----------

test('registerWorkspace persists location/owner, and generates an id', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ location: LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(typeof workspace.id, 'string')
    assert.ok(workspace.id.length > 0)
    assert.deepEqual(workspace.location, LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
  })
})

test('registerWorkspace defaults owner to \'\' and provider to \'azure-devops\' when omitted', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.equal(workspace.owner, '')
    assert.equal(workspace.provider, 'azure-devops')
  })
})

test('registerWorkspace persists an optional baseUrl', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ location: { ...LOCATION, baseUrl: 'https://ado.example.internal' } }, { instancesDir })
    assert.equal(workspace.location.baseUrl, 'https://ado.example.internal')
  })
})

test('registerWorkspace rejects a location missing organization/project/repository', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ location: { organization: 'org' } }, { instancesDir }),
      /missing: project, repository/
    )
  })
})

test('registerWorkspace rejects a location with no location key at all — flat input is no longer accepted', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ ...LOCATION }, { instancesDir }),
      /missing: organization, project, repository/
    )
  })
})

test('registerWorkspace always creates a fresh id, even for a repeated organization/project/repository tuple', async () => {
  await withScratchInstances((instancesDir) => {
    const first = registerWorkspace({ location: LOCATION }, { instancesDir })
    const second = registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.notEqual(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 2)
  })
})

// ---------- provider + nested location (#3, ADR-0037) ----------

test('registerWorkspace accepts the nested {provider, location} shape for an Azure DevOps workspace', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ provider: 'azure-devops', location: LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(workspace.provider, 'azure-devops')
    assert.deepEqual(workspace.location, LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
  })
})

test('registerWorkspace accepts a GitHub {provider, location} — owner/repository, no project required', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(workspace.provider, 'github')
    assert.deepEqual(workspace.location, GITHUB_LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
    // No location accessor exists at all any more (ticket #6) — a GitHub workspace never had one.
    assert.equal(workspace.organization, undefined)
    assert.equal(workspace.project, undefined)
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

// ---------- gitlab {provider, location} (#25, ADR-0041) ----------

test('registerWorkspace accepts a GitLab {provider, location} — namespace/repository, no project required', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ provider: 'gitlab', location: GITLAB_LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(workspace.provider, 'gitlab')
    assert.deepEqual(workspace.location, GITLAB_LOCATION)
    assert.equal(workspace.owner, 'c.barlow')
    // No location accessor exists at all any more (ticket #6) — a GitLab workspace never had one.
    assert.equal(workspace.organization, undefined)
    assert.equal(workspace.project, undefined)
  })
})

test('registerWorkspace persists a GitLab workspace\'s optional baseUrl (self-hosted CE/EE)', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace(
      { provider: 'gitlab', location: { ...GITLAB_LOCATION, baseUrl: 'https://gitlab.example.internal' } },
      { instancesDir }
    )
    assert.equal(workspace.location.baseUrl, 'https://gitlab.example.internal')
  })
})

test('registerWorkspace rejects a GitLab location missing namespace or repository — never requires a project', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'gitlab', location: { namespace: 'fake-group' } }, { instancesDir }),
      /missing: repository/
    )
    assert.throws(
      () => registerWorkspace({ provider: 'gitlab', location: { repository: 'fake-repo' } }, { instancesDir }),
      /missing: namespace/
    )
  })
})

test('findWorkspaceByLocation matches a gitlab workspace within its own provider only', async () => {
  await withScratchInstances((instancesDir) => {
    const gl = registerWorkspace({ provider: 'gitlab', location: { namespace: 'shared', repository: 'shared-repo' } }, { instancesDir })
    const gh = registerWorkspace({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ provider: 'gitlab', location: { namespace: 'shared', repository: 'shared-repo' } }, { instancesDir }).id,
      gl.id
    )
    assert.notEqual(gl.id, gh.id)
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

// #40, ADR-0042: atlassian is now a genuinely accepted, storable provider at this layer — only its
// capability registration (a live Bitbucket/Jira client) is still absent, which is a separate,
// later ticket's concern, not this registry's.
test('registerWorkspace accepts an "atlassian" location', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = registerWorkspace({ provider: 'atlassian', location: ATLASSIAN_LOCATION, owner: 'c.barlow' }, { instancesDir })
    assert.equal(workspace.provider, 'atlassian')
    assert.deepEqual(workspace.location, ATLASSIAN_LOCATION)
  })
})

test('registerWorkspace rejects an "atlassian" location missing jiraSite or jiraProjectKey', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerWorkspace({ provider: 'atlassian', location: { owner: 'acme', repository: 'fake-repo' } }, { instancesDir }),
      /missing: jiraSite, jiraProjectKey/
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
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
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
    const a = registerWorkspace({ location: LOCATION }, { instancesDir })
    const b = registerWorkspace({ location: { organization: 'other-org', project: 'p', repository: 'r' } }, { instancesDir })
    const ids = listWorkspaces({ instancesDir }).map((w) => w.id)
    assert.deepEqual(ids, [a.id, b.id].sort())
  })
})

test('listWorkspaces lists Azure DevOps and GitHub workspaces side by side', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = registerWorkspace({ location: LOCATION }, { instancesDir })
    const gh = registerWorkspace({ provider: 'github', location: GITHUB_LOCATION }, { instancesDir })
    const providers = listWorkspaces({ instancesDir }).map((w) => [w.id, w.provider])
    assert.deepEqual(new Map(providers), new Map([[ado.id, 'azure-devops'], [gh.id, 'github']]))
  })
})

test('the workspace registry survives across separate calls (a fresh call sees a previous call\'s registration)', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
    // Each of these calls re-reads the registry file from scratch — no shared in-memory state — so this only passes if persistence is real.
    assert.deepEqual(resolveWorkspace(created.id, { instancesDir }), created)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('the registered workspace is written to disk in the canonical nested {provider, location, owner} shape', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
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
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.deepEqual(findWorkspaceByLocation({ location: LOCATION }, { instancesDir }), created)
  })
})

test('findWorkspaceByLocation returns undefined when no workspace matches', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ location: { organization: 'other-org', project: 'p', repository: 'r' } }, { instancesDir }),
      undefined
    )
  })
})

test('findWorkspaceByLocation treats baseUrl as part of the match — same org/project/repo but a different baseUrl is a different workspace', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.equal(
      findWorkspaceByLocation({ location: { ...LOCATION, baseUrl: 'https://ado.example.internal' } }, { instancesDir }),
      undefined
    )
  })
})

test('findWorkspaceByLocation matches within a provider only — a GitHub workspace sharing a repository name with an Azure DevOps one is distinct', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = registerWorkspace({ location: { organization: 'shared', project: 'shared', repository: 'shared-repo' } }, { instancesDir })
    const gh = registerWorkspace({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })

    assert.deepEqual(
      findWorkspaceByLocation({ location: { organization: 'shared', project: 'shared', repository: 'shared-repo' } }, { instancesDir }),
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
    const first = getOrCreateWorkspace({ location: LOCATION }, { instancesDir })
    const second = getOrCreateWorkspace({ location: LOCATION }, { instancesDir })
    assert.equal(first.id, second.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('getOrCreateWorkspace creates a new workspace when nothing matches yet', async () => {
  await withScratchInstances((instancesDir) => {
    const workspace = getOrCreateWorkspace({ location: LOCATION }, { instancesDir })
    assert.deepEqual(resolveWorkspace(workspace.id, { instancesDir }), workspace)
  })
})

test('getOrCreateWorkspace creates distinct workspaces for the same repository name on different providers', async () => {
  await withScratchInstances((instancesDir) => {
    const ado = getOrCreateWorkspace({ location: { organization: 'shared', project: 'shared', repository: 'shared-repo' } }, { instancesDir })
    const gh = getOrCreateWorkspace({ provider: 'github', location: { owner: 'shared', repository: 'shared-repo' } }, { instancesDir })
    assert.notEqual(ado.id, gh.id)
    assert.equal(listWorkspaces({ instancesDir }).length, 2)
  })
})

// ---------- updateWorkspace ----------

test('updateWorkspace updates owner and re-persists it', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
    const updated = updateWorkspace(created.id, { owner: 'c.barlow' }, { instancesDir })
    assert.equal(updated.owner, 'c.barlow')
    assert.equal(resolveWorkspace(created.id, { instancesDir }).owner, 'c.barlow')
  })
})

test('updateWorkspace silently ignores an unrecognized field like the removed ticketingSystem', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
    const updated = updateWorkspace(created.id, { ticketingSystem: 'jira' }, { instancesDir })
    assert.equal(updated.ticketingSystem, undefined)
    assert.deepEqual(updated.location, LOCATION)
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
    registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.equal(resolveWorkspace('__proto__', { instancesDir }), undefined)
  })
})

test('updateWorkspace throws "Unknown workspace" for "__proto__" rather than treating it as an existing entry', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace({ location: LOCATION }, { instancesDir })
    assert.throws(() => updateWorkspace('__proto__', { owner: 'x' }, { instancesDir }), /Unknown workspace/)
  })
})

// ---------- #223: archive / restore ----------

test('archiveWorkspace sets archived: true; restoreWorkspace removes the flag entirely (exact prior state)', async () => {
  await withScratchInstances((instancesDir) => {
    const created = registerWorkspace({ location: LOCATION, owner: 'c.barlow' }, { instancesDir })

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
    const created = registerWorkspace({ location: { ...LOCATION, baseUrl: 'https://ado.example.internal' } }, { instancesDir })
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
    const a = registerWorkspace({ location: LOCATION }, { instancesDir })
    const b = registerWorkspace({ location: { organization: 'other-org', project: 'p', repository: 'r' } }, { instancesDir })
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
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
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
    const created = registerWorkspace({ location: LOCATION }, { instancesDir })
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
    assert.equal(resolved.owner, 'a.person')
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
