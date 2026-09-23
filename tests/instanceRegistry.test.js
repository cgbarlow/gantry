import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import {
  resolveInstanceLocation,
  registerInstance,
  listRegisteredInstances,
  listRegisteredScopedSlugsInStorageOrder,
  resolveInstanceWorkspaceId,
  archiveInstance,
  restoreInstance,
  isInstanceArchived,
  scopeIdForDirectoryFolder,
  directoryFolderForScopeId,
  MIGRATED_DEFAULT_WORKSPACE_FOLDER,
  workspaceHasRegisteredInstances,
  hasUndiscoveredProviderWorkspaces,
} from '../lib/instanceRegistry.js'
import { LOCAL_SCOPE } from '../lib/numberRegistry.js'
import { listWorkspaces, resolveWorkspace, findWorkspaceByLocation } from '../lib/workspaceRegistry.js'
import { localFilesystemStorage } from '../lib/storage.js'
import { withScratchInstances } from './helpers/lifecycle.js'

// A server workspace directory (lib/workspaceDirectory.js, #355) is just a folder with a
// workspace.json marker — this seeds one under a scratch workspaces root so createInstance's own
// (unchanged, flat-directory) local path can be pointed at it directly.
function seedWorkspace(workspacesDir, folder) {
  writeWorkspaceJson(workspacesDir, folder, { name: folder, kind: 'local', createdAt: new Date().toISOString() })
  return join(workspacesDir, folder)
}

test('resolveInstanceLocation returns undefined for a slug that is neither registered nor on disk', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(resolveInstanceLocation('nowhere', { instancesDir }), undefined)
  })
})

test('registerInstance then resolveInstanceLocation round-trips a directory location', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    assert.deepEqual(resolveInstanceLocation('my-initiative', { instancesDir, workspace: 'acme' }), {
      kind: 'directory',
      workspace: 'acme',
    })
  })
})

test('registerInstance then resolveInstanceLocation round-trips an Azure DevOps location', async () => {
  await withScratchInstances((instancesDir) => {
    const location = {
      kind: 'azureDevOps',
      organization: 'fake-org',
      project: 'fake-project',
      repository: 'fake-repo',
    }
    registerInstance('remote-initiative', location, { instancesDir })
    assert.deepEqual(resolveInstanceLocation('remote-initiative', { instancesDir }), location)
  })
})

test('registerInstance persists an optional baseUrl on an Azure DevOps location', async () => {
  await withScratchInstances((instancesDir) => {
    const location = {
      kind: 'azureDevOps',
      organization: 'fake-org',
      project: 'fake-project',
      repository: 'fake-repo',
      baseUrl: 'https://ado.example.internal',
    }
    registerInstance('remote-initiative', location, { instancesDir })
    assert.deepEqual(resolveInstanceLocation('remote-initiative', { instancesDir }), location)
  })
})

test('registerInstance rejects the retired "local" kind, naming the replacement', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => registerInstance('bad', { kind: 'local' }, { instancesDir }), /no longer a valid registry location kind/)
  })
})

test('registerInstance rejects an unknown location kind', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => registerInstance('bad', { kind: 'ftp' }, { instancesDir }), /Unknown registry location kind/)
  })
})

test('registerInstance rejects a directory location with no workspace', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => registerInstance('bad', { kind: 'directory' }, { instancesDir }), /must carry a workspace/)
  })
})

test('registerInstance rejects an Azure DevOps location missing required fields', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerInstance('bad', { kind: 'azureDevOps', organization: 'org' }, { instancesDir }),
      /missing: project, repository/
    )
  })
})

test('an instance.yaml under a real server workspace folder with no registry entry is auto-backfilled as directory, with no manual step', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir, 'acme')
    createInstance('design', 'pre-existing', { instancesDir: workspaceDir })

    assert.deepEqual(resolveInstanceLocation('pre-existing', { instancesDir, workspace: 'acme' }), {
      kind: 'directory',
      workspace: 'acme',
    })
  })
})

test('a bare instance.yaml directly under the workspaces root (no workspace.json folder) is NOT auto-backfilled — that is migration\'s job', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'legacy-bare', { instancesDir })
    assert.equal(resolveInstanceLocation('legacy-bare', { instancesDir }), undefined)
  })
})

test('auto-backfill persists to the registry file, not just the in-memory result', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir, 'acme')
    createInstance('design', 'pre-existing', { instancesDir: workspaceDir })
    resolveInstanceLocation('pre-existing', { instancesDir, workspace: 'acme' })

    const registryPath = join(instancesDir, 'instance-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(persisted.acme['pre-existing'], { kind: 'directory' })
  })
})

test('listRegisteredInstances lists every entry, sorted by slug then workspace, mixing registered and backfilled instances', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir, 'acme')
    createInstance('design', 'zebra-initiative', { instancesDir: workspaceDir })
    registerInstance('alpha-remote', { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })

    const rows = listRegisteredInstances({ instancesDir })
    // WI #366: every row carries the raw scope id it is stored under. A directory workspace's is its
    // own folder-derived scope id; an Azure DevOps workspace's is a generated uuid, so it is checked
    // for shape rather than value.
    assert.equal(typeof rows[0].scopeId, 'string')
    assert.equal(rows[1].scopeId, 'acme')
    assert.deepEqual(rows.map(({ scopeId, ...row }) => row), [
      { slug: 'alpha-remote', workspace: undefined, location: { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' } },
      { slug: 'zebra-initiative', workspace: 'acme', location: { kind: 'directory', workspace: 'acme' } },
    ])
  })
})

test('listRegisteredInstances returns an empty array when there is nothing registered or on disk', async () => {
  await withScratchInstances((instancesDir) => {
    assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
  })
})

test('the registry survives across multiple reads/writes (a fresh call sees a previous call\'s registration)', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('first', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    registerInstance('second', { kind: 'directory', workspace: 'acme' }, { instancesDir })

    assert.deepEqual(resolveInstanceLocation('first', { instancesDir, workspace: 'acme' }), { kind: 'directory', workspace: 'acme' })
    assert.deepEqual(resolveInstanceLocation('second', { instancesDir, workspace: 'acme' }), { kind: 'directory', workspace: 'acme' })
    assert.equal(listRegisteredInstances({ instancesDir }).length, 2)
  })
})

test('a custom registryPath overrides the default instancesDir-colocated file', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const registryDir = mkdtempSync(join(tmpdir(), 'gantry-registry-'))
  const registryPath = join(registryDir, 'custom-registry.json')
  try {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('somewhere', { kind: 'directory', workspace: 'acme' }, { instancesDir, registryPath })
    assert.deepEqual(resolveInstanceLocation('somewhere', { instancesDir, registryPath, workspace: 'acme' }), {
      kind: 'directory',
      workspace: 'acme',
    })
    // Not written to the default location when an explicit path is given.
    assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(registryDir, { recursive: true, force: true })
  }
})

// ---------- WI #356: two workspaces, one slug each — the whole point ----------

test('two different server workspaces can each have their own instance with the same slug', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    seedWorkspace(instancesDir, 'globex')
    registerInstance('foo', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    registerInstance('foo', { kind: 'directory', workspace: 'globex' }, { instancesDir })

    assert.deepEqual(resolveInstanceLocation('foo', { instancesDir, workspace: 'acme' }), { kind: 'directory', workspace: 'acme' })
    assert.deepEqual(resolveInstanceLocation('foo', { instancesDir, workspace: 'globex' }), { kind: 'directory', workspace: 'globex' })
  })
})

test('a bare (workspace-unqualified) slug unique across every workspace still resolves', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('unique-slug', { kind: 'directory', workspace: 'acme' }, { instancesDir })

    assert.deepEqual(resolveInstanceLocation('unique-slug', { instancesDir }), { kind: 'directory', workspace: 'acme' })
  })
})

test('a bare (workspace-unqualified) slug present in more than one workspace throws, naming every candidate', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    seedWorkspace(instancesDir, 'globex')
    registerInstance('foo', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    registerInstance('foo', { kind: 'directory', workspace: 'globex' }, { instancesDir })

    assert.throws(() => resolveInstanceLocation('foo', { instancesDir }), (err) => {
      assert.match(err.message, /ambiguous/)
      assert.match(err.message, /acme\/foo/)
      assert.match(err.message, /globex\/foo/)
      return true
    })
  })
})

// ---------- #96 (unchanged by #356): workspace-referencing storage shape for Azure DevOps ----------

test('registerInstance persists an azureDevOps location keyed by workspace id, not a duplicated organization/project/repository', async () => {
  await withScratchInstances((instancesDir) => {
    const location = { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
    registerInstance('remote-initiative', location, { instancesDir })

    const registryPath = join(instancesDir, 'instance-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    const scopeIds = Object.keys(persisted)
    assert.equal(scopeIds.length, 1)
    assert.deepEqual(persisted[scopeIds[0]]['remote-initiative'], { kind: 'azureDevOps' })

    const workspace = resolveWorkspace(scopeIds[0], { instancesDir })
    assert.equal(workspace.location.organization, 'fake-org')
    assert.equal(workspace.location.project, 'fake-project')
    assert.equal(workspace.location.repository, 'fake-repo')
  })
})

test('registerInstance accepts a direct { workspaceId } location once a workspace already exists', async () => {
  await withScratchInstances((instancesDir) => {
    registerInstance(
      'first',
      { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      { instancesDir }
    )
    const firstWorkspaceId = Object.keys(JSON.parse(readFileSync(join(instancesDir, 'instance-registry.json'), 'utf8')))[0]

    registerInstance('second', { kind: 'azureDevOps', workspaceId: firstWorkspaceId }, { instancesDir })

    assert.deepEqual(resolveInstanceLocation('second', { instancesDir }), {
      kind: 'azureDevOps',
      organization: 'fake-org',
      project: 'fake-project',
      repository: 'fake-repo',
    })
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('registerInstance rejects a { workspaceId } location referencing an unknown workspace', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerInstance('bad', { kind: 'azureDevOps', workspaceId: 'nowhere' }, { instancesDir }),
      /Unknown workspace/
    )
  })
})

test('two instances registered against the same organization/project/repository share one auto-created workspace', async () => {
  await withScratchInstances((instancesDir) => {
    const location = { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
    registerInstance('first', location, { instancesDir })
    registerInstance('second', location, { instancesDir })

    const registryPath = join(instancesDir, 'instance-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    const scopeIds = Object.keys(persisted)
    assert.equal(scopeIds.length, 1)
    assert.ok(persisted[scopeIds[0]].first)
    assert.ok(persisted[scopeIds[0]].second)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

// ---------- WI #356: migrating a pre-#356 flat registry file (any pre-#356 shape) ----------

test('a pre-#356 flat "kind: local" entry migrates onto the reserved LOCAL_SCOPE, as a directory entry', async () => {
  await withScratchInstances((instancesDir) => {
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(registryPath, JSON.stringify({ 'legacy-local': { kind: 'local' } }))

    // Physically, a migrated instance now lives under the reserved `default` folder (lib/workspaceMigration.js) —
    // seed it so resolution finds real data, matching what migration actually does before this ever runs.
    seedWorkspace(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER)

    const location = resolveInstanceLocation('legacy-local', { instancesDir })
    assert.deepEqual(location, { kind: 'directory', workspace: MIGRATED_DEFAULT_WORKSPACE_FOLDER })

    const migrated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(migrated[LOCAL_SCOPE]['legacy-local'], { kind: 'directory' })
  })
})

test('a pre-#356 flat "kind: azureDevOps, workspaceId" entry migrates onto that workspace id\'s scope', async () => {
  await withScratchInstances((instancesDir) => {
    // Establish a real workspace first (as #96-era code always did).
    registerInstance('bootstrap', { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })
    const registryPath = join(instancesDir, 'instance-registry.json')
    const before = JSON.parse(readFileSync(registryPath, 'utf8'))
    const workspaceId = Object.keys(before)[0]

    // Overwrite with a pre-#356 *flat* shape referencing that same workspace id.
    writeFileSync(registryPath, JSON.stringify({ 'legacy-remote': { kind: 'azureDevOps', workspaceId } }))

    const location = resolveInstanceLocation('legacy-remote', { instancesDir })
    assert.equal(location.kind, 'azureDevOps')
    assert.equal(location.organization, 'org')

    const migrated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(migrated[workspaceId]['legacy-remote'], { kind: 'azureDevOps' })
  })
})

test('a pre-#96-*and*-pre-#356 entry (raw organization/project/repository, no workspaceId, flat) migrates in one step', async () => {
  await withScratchInstances((instancesDir) => {
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(
      registryPath,
      JSON.stringify({
        'ancient-remote': { kind: 'azureDevOps', organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' },
      })
    )

    const location = resolveInstanceLocation('ancient-remote', { instancesDir })
    assert.deepEqual(location, {
      kind: 'azureDevOps',
      organization: 'legacy-org',
      project: 'legacy-project',
      repository: 'legacy-repo',
    })

    const workspaces = listWorkspaces({ instancesDir })
    assert.equal(workspaces.length, 1)
    const migrated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(migrated[workspaces[0].id]['ancient-remote'], { kind: 'azureDevOps' })
  })
})

test('an archived flag on a legacy flat entry survives the shape migration', async () => {
  await withScratchInstances((instancesDir) => {
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(registryPath, JSON.stringify({ 'legacy-local': { kind: 'local', archived: true } }))
    seedWorkspace(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER)

    assert.equal(isInstanceArchived('legacy-local', { instancesDir }), true)
    const migrated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(migrated[LOCAL_SCOPE]['legacy-local'], { kind: 'directory', archived: true })
  })
})

// ---------- scope id <-> folder name mapping ----------

test('scopeIdForDirectoryFolder/directoryFolderForScopeId: the reserved default folder maps to LOCAL_SCOPE and back; every other folder maps to itself', () => {
  assert.equal(scopeIdForDirectoryFolder(MIGRATED_DEFAULT_WORKSPACE_FOLDER), LOCAL_SCOPE)
  assert.equal(directoryFolderForScopeId(LOCAL_SCOPE), MIGRATED_DEFAULT_WORKSPACE_FOLDER)
  assert.equal(scopeIdForDirectoryFolder('acme'), 'acme')
  assert.equal(directoryFolderForScopeId('acme'), 'acme')
})

// ---------- #104 (WI #356: extended to directory scopes) ----------

test('resolveInstanceWorkspaceId returns LOCAL_SCOPE for an instance in the reserved default server workspace', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER)
    createInstance('design', 'in-default', { instancesDir: workspaceDir })
    assert.equal(resolveInstanceWorkspaceId('in-default', { instancesDir }), LOCAL_SCOPE)
  })
})

test('resolveInstanceWorkspaceId returns the folder name for an instance in any other server workspace', async () => {
  await withScratchInstances((instancesDir) => {
    const workspaceDir = seedWorkspace(instancesDir, 'acme')
    createInstance('design', 'in-acme', { instancesDir: workspaceDir })
    assert.equal(resolveInstanceWorkspaceId('in-acme', { instancesDir }), 'acme')
  })
})

test('resolveInstanceWorkspaceId returns null for a slug neither registered nor on disk', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(resolveInstanceWorkspaceId('nowhere', { instancesDir }), null)
  })
})

test('resolveInstanceWorkspaceId returns the real workspace id for an Azure-DevOps-backed instance', async () => {
  await withScratchInstances((instancesDir) => {
    registerInstance(
      'remote-initiative',
      { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      { instancesDir }
    )
    const location = resolveInstanceLocation('remote-initiative', { instancesDir })
    const workspace = findWorkspaceByLocation(
      {
        provider: 'azure-devops',
        location: { organization: location.organization, project: location.project, repository: location.repository, baseUrl: location.baseUrl },
      },
      { instancesDir }
    )
    assert.equal(resolveInstanceWorkspaceId('remote-initiative', { instancesDir }), workspace.id)
  })
})

// ---------- listRegisteredScopedSlugsInStorageOrder ----------

test('listRegisteredScopedSlugsInStorageOrder returns every { workspace, slug } pair, scope-nested', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('foo', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    registerInstance('remote', { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })

    const pairs = listRegisteredScopedSlugsInStorageOrder({ instancesDir })
    assert.equal(pairs.length, 2)
    assert.deepEqual(
      pairs.find((p) => p.slug === 'foo'),
      { workspace: 'acme', slug: 'foo' }
    )
    const remotePair = pairs.find((p) => p.slug === 'remote')
    assert.equal(typeof remotePair.workspace, 'string')
  })
})

// ---------- #223: archive / restore (WI #356: directory kind) ----------

test('archiveInstance sets archived: true on the entry; restoreInstance removes it (exact prior shape)', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })

    archiveInstance('my-initiative', { instancesDir, workspace: 'acme' })
    assert.equal(isInstanceArchived('my-initiative', { instancesDir, workspace: 'acme' }), true)

    const registryPath = join(instancesDir, 'instance-registry.json')
    assert.deepEqual(JSON.parse(readFileSync(registryPath, 'utf8')).acme['my-initiative'], {
      kind: 'directory',
      archived: true,
    })

    restoreInstance('my-initiative', { instancesDir, workspace: 'acme' })
    assert.equal(isInstanceArchived('my-initiative', { instancesDir, workspace: 'acme' }), false)
    assert.deepEqual(JSON.parse(readFileSync(registryPath, 'utf8')).acme['my-initiative'], { kind: 'directory' })
  })
})

test('archiveInstance keeps an Azure-DevOps entry as { kind: azureDevOps, archived: true }', async () => {
  await withScratchInstances((instancesDir) => {
    registerInstance(
      'remote-initiative',
      { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      { instancesDir }
    )
    archiveInstance('remote-initiative', { instancesDir })

    const persisted = JSON.parse(readFileSync(join(instancesDir, 'instance-registry.json'), 'utf8'))
    const scopeId = Object.keys(persisted)[0]
    assert.deepEqual(persisted[scopeId]['remote-initiative'], { kind: 'azureDevOps', archived: true })
    assert.deepEqual(resolveInstanceLocation('remote-initiative', { instancesDir }), {
      kind: 'azureDevOps',
      organization: 'fake-org',
      project: 'fake-project',
      repository: 'fake-repo',
    })
  })
})

test('listRegisteredInstances excludes archived by default, includes them (with an archived flag) on includeArchived', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('alpha', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    registerInstance('beta', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    archiveInstance('beta', { instancesDir, workspace: 'acme' })

    assert.deepEqual(listRegisteredInstances({ instancesDir }), [
      { slug: 'alpha', scopeId: 'acme', workspace: 'acme', location: { kind: 'directory', workspace: 'acme' } },
    ])
    assert.deepEqual(listRegisteredInstances({ instancesDir, includeArchived: true }), [
      { slug: 'alpha', scopeId: 'acme', workspace: 'acme', location: { kind: 'directory', workspace: 'acme' }, archived: false },
      { slug: 'beta', scopeId: 'acme', workspace: 'acme', location: { kind: 'directory', workspace: 'acme' }, archived: true },
    ])
  })
})

test('archiveInstance / restoreInstance are idempotent, and throw for an unknown slug', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    archiveInstance('my-initiative', { instancesDir, workspace: 'acme' })
    assert.doesNotThrow(() => archiveInstance('my-initiative', { instancesDir, workspace: 'acme' }))
    restoreInstance('my-initiative', { instancesDir, workspace: 'acme' })
    assert.doesNotThrow(() => restoreInstance('my-initiative', { instancesDir, workspace: 'acme' }))

    assert.throws(() => archiveInstance('nowhere', { instancesDir }), /Unknown instance/)
    assert.throws(() => restoreInstance('nowhere', { instancesDir }), /Unknown instance/)
  })
})

test('an archived instance still resolves at resolveInstanceLocation (read-only-resolves, #223)', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    archiveInstance('my-initiative', { instancesDir, workspace: 'acme' })
    assert.deepEqual(resolveInstanceLocation('my-initiative', { instancesDir, workspace: 'acme' }), {
      kind: 'directory',
      workspace: 'acme',
    })
  })
})

// #122 (parent #109, docs/adr/0047): `workspaceHasRegisteredInstances` is what lets `GET
// /api/workspaces` tell the dashboard "this workspace definitely has instances registered, even
// though none of them built a row this time" apart from "nothing has ever been registered here" — see
// its own doc comment in lib/instanceRegistry.js for exactly what it can and can't prove.

test('workspaceHasRegisteredInstances is false for a workspace id with no registry entry at all', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(workspaceHasRegisteredInstances('nonexistent-workspace-id', { instancesDir }), false)
  })
})

test('workspaceHasRegisteredInstances is true once an Azure-DevOps-backed instance is registered against that workspace', async () => {
  await withScratchInstances((instancesDir) => {
    const location = { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
    registerInstance('remote-initiative', location, { instancesDir })
    const [workspace] = listWorkspaces({ instancesDir })
    assert.equal(workspaceHasRegisteredInstances(workspace.id, { instancesDir }), true)
  })
})

test('workspaceHasRegisteredInstances is true for a directory workspace once an instance is registered under it, false for an unrelated one', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    seedWorkspace(instancesDir, 'other')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    assert.equal(workspaceHasRegisteredInstances('acme', { instancesDir }), true)
    assert.equal(workspaceHasRegisteredInstances('other', { instancesDir }), false)
  })
})

test('workspaceHasRegisteredInstances stays true for a workspace whose only instance was later archived (#223: archived still counts as registered)', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })
    archiveInstance('my-initiative', { instancesDir, workspace: 'acme' })
    assert.equal(workspaceHasRegisteredInstances('acme', { instancesDir }), true)
  })
})

// #133 regression: `lib/registry.js`'s `listRegistry` always passes a `sharedPats` object (`{}` by
// default — see its own comment on that default), so the early-exit guard here must key off whether
// there is an actual credential to try (an `options.pat`, or at least one `options.sharedPats` entry),
// not merely off whether a `sharedPats` object was passed at all — otherwise every request pays for a
// full `loadWithBackfill` (registry-file read + directory scan) for no reason, even though the
// returned answer (`false`) is unchanged either way.
test('hasUndiscoveredProviderWorkspaces stays synchronous-cheap (no registry read, no directory scan) when neither options.pat nor any GANTRY_SHARED_WORKSPACE_PATS entry is present', async () => {
  await withScratchInstances((instancesDir) => {
    seedWorkspace(instancesDir, 'acme')
    registerInstance('my-initiative', { kind: 'directory', workspace: 'acme' }, { instancesDir })

    const realExists = localFilesystemStorage.exists
    const realListDir = localFilesystemStorage.listDir
    let storageCalls = 0
    localFilesystemStorage.exists = (...args) => {
      storageCalls++
      return realExists(...args)
    }
    localFilesystemStorage.listDir = (...args) => {
      storageCalls++
      return realListDir(...args)
    }
    try {
      // Exactly how `lib/registry.js`'s `listRegistry` calls this today: no `options.pat`, and a
      // `sharedPats` object that is present but empty (the common "GANTRY_SHARED_WORKSPACE_PATS unset"
      // case), not simply omitted.
      const result = hasUndiscoveredProviderWorkspaces({ instancesDir, sharedPats: {} })
      assert.equal(result, false)
      assert.equal(
        storageCalls,
        0,
        'no filesystem read or directory scan should happen when this request carries no credential at all'
      )
    } finally {
      localFilesystemStorage.exists = realExists
      localFilesystemStorage.listDir = realListDir
    }
  })
})
