import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import {
  resolveInstanceLocation,
  registerInstance,
  listRegisteredInstances,
  resolveInstanceWorkspaceId,
} from '../lib/instanceRegistry.js'
import { listWorkspaces, resolveWorkspace, findWorkspaceByLocation } from '../lib/workspaceRegistry.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('resolveInstanceLocation returns undefined for a slug that is neither registered nor on disk', () => {
  withScratchInstances((instancesDir) => {
    assert.equal(resolveInstanceLocation('nowhere', { instancesDir }), undefined)
  })
})

test('registerInstance then resolveInstanceLocation round-trips a local location', () => {
  withScratchInstances((instancesDir) => {
    registerInstance('my-initiative', { kind: 'local' }, { instancesDir })
    assert.deepEqual(resolveInstanceLocation('my-initiative', { instancesDir }), { kind: 'local' })
  })
})

test('registerInstance then resolveInstanceLocation round-trips an Azure DevOps location', () => {
  withScratchInstances((instancesDir) => {
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

test('registerInstance persists an optional baseUrl on an Azure DevOps location', () => {
  withScratchInstances((instancesDir) => {
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

test('registerInstance rejects an unknown location kind', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(() => registerInstance('bad', { kind: 'ftp' }, { instancesDir }), /Unknown registry location kind/)
  })
})

test('registerInstance rejects an Azure DevOps location missing required fields', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerInstance('bad', { kind: 'azureDevOps', organization: 'org' }, { instancesDir }),
      /missing: project, repository/
    )
  })
})

test('an instance.yaml already on disk with no registry entry is auto-backfilled as local, with no manual step', () => {
  withScratchInstances((instancesDir) => {
    // Simulates a pre-existing instance created before the registry ever
    // existed (or by a caller that bypassed registerInstance entirely,
    // e.g. createInstance's local path, which never calls it).
    createInstance('design', 'pre-existing', { instancesDir })

    assert.deepEqual(resolveInstanceLocation('pre-existing', { instancesDir }), { kind: 'local' })
  })
})

test('auto-backfill persists to the registry file, not just the in-memory result', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'pre-existing', { instancesDir })
    resolveInstanceLocation('pre-existing', { instancesDir })

    const registryPath = join(instancesDir, 'instance-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.deepEqual(persisted['pre-existing'], { kind: 'local' })
  })
})

test('listRegisteredInstances lists every entry, sorted by slug, mixing registered and backfilled instances', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'zebra-initiative', { instancesDir })
    registerInstance('alpha-remote', { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })

    assert.deepEqual(listRegisteredInstances({ instancesDir }), [
      { slug: 'alpha-remote', location: { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' } },
      { slug: 'zebra-initiative', location: { kind: 'local' } },
    ])
  })
})

test('listRegisteredInstances returns an empty array when there is nothing registered or on disk', () => {
  withScratchInstances((instancesDir) => {
    assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
  })
})

test('the registry survives across multiple reads/writes (a fresh call sees a previous call\'s registration)', () => {
  withScratchInstances((instancesDir) => {
    registerInstance('first', { kind: 'local' }, { instancesDir })
    registerInstance('second', { kind: 'local' }, { instancesDir })

    // Each of these calls re-reads the registry file from scratch — no
    // shared in-memory state — so this only passes if persistence is real.
    assert.deepEqual(resolveInstanceLocation('first', { instancesDir }), { kind: 'local' })
    assert.deepEqual(resolveInstanceLocation('second', { instancesDir }), { kind: 'local' })
    assert.equal(listRegisteredInstances({ instancesDir }).length, 2)
  })
})

test('instance.yaml\'s own (descriptive) azureDevOps field is never consulted — the registry alone decides kind', () => {
  withScratchInstances((instancesDir) => {
    // A local instance.yaml can't itself carry an azureDevOps field the way
    // createInstance's Azure DevOps path writes one — but even if a local
    // instance.yaml were hand-edited to include one, resolving a slug's
    // location must come from the registry file alone, never from
    // reading/parsing instance.yaml's own content.
    createInstance('design', 'local-only', { instancesDir })
    assert.deepEqual(resolveInstanceLocation('local-only', { instancesDir }), { kind: 'local' })
  })
})

test('a custom registryPath overrides the default instancesDir-colocated file', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const registryDir = mkdtempSync(join(tmpdir(), 'gantry-registry-'))
  const registryPath = join(registryDir, 'custom-registry.json')
  try {
    registerInstance('somewhere', { kind: 'local' }, { instancesDir, registryPath })
    assert.deepEqual(resolveInstanceLocation('somewhere', { instancesDir, registryPath }), { kind: 'local' })
    // Not written to the default location when an explicit path is given.
    assert.deepEqual(listRegisteredInstances({ instancesDir }), [])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
    rmSync(registryDir, { recursive: true, force: true })
  }
})

// ---------- #96: workspace-referencing storage shape ----------

test('registerInstance persists an azureDevOps location as a workspace reference, not a duplicated organization/project/repository', () => {
  withScratchInstances((instancesDir) => {
    const location = { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
    registerInstance('remote-initiative', location, { instancesDir })

    // resolveInstanceLocation still hands back the familiar shape (see the
    // round-trip test above) — this asserts on the *raw file on disk*,
    // which is the actual acceptance criterion: no organization/project/
    // repository duplicated per instance, only a workspace id.
    const registryPath = join(instancesDir, 'instance-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(persisted['remote-initiative'].kind, 'azureDevOps')
    assert.equal(typeof persisted['remote-initiative'].workspaceId, 'string')
    assert.equal(persisted['remote-initiative'].organization, undefined)
    assert.equal(persisted['remote-initiative'].project, undefined)
    assert.equal(persisted['remote-initiative'].repository, undefined)

    // The workspace it references really was created, with the right
    // organization/project/repository.
    const workspace = resolveWorkspace(persisted['remote-initiative'].workspaceId, { instancesDir })
    assert.equal(workspace.organization, 'fake-org')
    assert.equal(workspace.project, 'fake-project')
    assert.equal(workspace.repository, 'fake-repo')
  })
})

test('registerInstance accepts a direct { workspaceId } location once a workspace already exists', () => {
  withScratchInstances((instancesDir) => {
    registerInstance(
      'first',
      { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      { instancesDir }
    )
    const firstWorkspaceId = JSON.parse(readFileSync(join(instancesDir, 'instance-registry.json'), 'utf8'))['first']
      .workspaceId

    registerInstance('second', { kind: 'azureDevOps', workspaceId: firstWorkspaceId }, { instancesDir })

    assert.deepEqual(resolveInstanceLocation('second', { instancesDir }), {
      kind: 'azureDevOps',
      organization: 'fake-org',
      project: 'fake-project',
      repository: 'fake-repo',
    })
    // Both instances share the one workspace — no second was created.
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

test('registerInstance rejects a { workspaceId } location referencing an unknown workspace', () => {
  withScratchInstances((instancesDir) => {
    assert.throws(
      () => registerInstance('bad', { kind: 'azureDevOps', workspaceId: 'nowhere' }, { instancesDir }),
      /Unknown workspace/
    )
  })
})

test('two instances registered against the same organization/project/repository share one auto-created workspace', () => {
  withScratchInstances((instancesDir) => {
    const location = { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
    registerInstance('first', location, { instancesDir })
    registerInstance('second', location, { instancesDir })

    const registryPath = join(instancesDir, 'instance-registry.json')
    const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(persisted.first.workspaceId, persisted.second.workspaceId)
    assert.equal(listWorkspaces({ instancesDir }).length, 1)
  })
})

// ---------- #96: backfilling a pre-#96 (legacy-shape) registry file ----------

test('a registry file written before workspaces existed (organization/project/repository duplicated per entry) is auto-migrated on read, with no manual step', () => {
  withScratchInstances((instancesDir) => {
    const registryPath = join(instancesDir, 'instance-registry.json')
    // Simulates a registry file persisted by a pre-#96 version of gantry —
    // the exact shape `registerInstance`/`listRegisteredInstances` used to
    // read and write before this ticket.
    writeFileSync(
      registryPath,
      JSON.stringify({
        'legacy-initiative': { kind: 'azureDevOps', organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' },
      })
    )

    const location = resolveInstanceLocation('legacy-initiative', { instancesDir })
    // Still resolves exactly as before — callers relying on the old shape
    // are unaffected by the migration underneath them.
    assert.deepEqual(location, {
      kind: 'azureDevOps',
      organization: 'legacy-org',
      project: 'legacy-project',
      repository: 'legacy-repo',
    })

    // But the underlying workspace was really auto-created…
    const workspaces = listWorkspaces({ instancesDir })
    assert.equal(workspaces.length, 1)
    assert.equal(workspaces[0].organization, 'legacy-org')

    // …and the registry file on disk was rewritten to reference it, rather
    // than staying in the legacy duplicated-fields shape forever.
    const migrated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(migrated['legacy-initiative'].workspaceId, workspaces[0].id)
    assert.equal(migrated['legacy-initiative'].organization, undefined)
  })
})

test('migrating two legacy entries for the same organization/project/repository backfills exactly one shared workspace', () => {
  withScratchInstances((instancesDir) => {
    const registryPath = join(instancesDir, 'instance-registry.json')
    const legacyLocation = { kind: 'azureDevOps', organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' }
    writeFileSync(
      registryPath,
      JSON.stringify({ 'legacy-one': legacyLocation, 'legacy-two': legacyLocation })
    )

    resolveInstanceLocation('legacy-one', { instancesDir })

    assert.equal(listWorkspaces({ instancesDir }).length, 1)
    const migrated = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(migrated['legacy-one'].workspaceId, migrated['legacy-two'].workspaceId)
  })
})

// ---------- #104: resolveInstanceWorkspaceId ----------

test('resolveInstanceWorkspaceId returns null for a local instance', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'local-only', { instancesDir })
    assert.equal(resolveInstanceWorkspaceId('local-only', { instancesDir }), null)
  })
})

test('resolveInstanceWorkspaceId returns null for a slug neither registered nor on disk', () => {
  withScratchInstances((instancesDir) => {
    assert.equal(resolveInstanceWorkspaceId('nowhere', { instancesDir }), null)
  })
})

test('resolveInstanceWorkspaceId returns the real workspace id for an Azure-DevOps-backed instance', () => {
  withScratchInstances((instancesDir) => {
    registerInstance(
      'remote-initiative',
      { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' },
      { instancesDir }
    )
    const location = resolveInstanceLocation('remote-initiative', { instancesDir })
    const workspace = findWorkspaceByLocation(location, { instancesDir })
    assert.equal(resolveInstanceWorkspaceId('remote-initiative', { instancesDir }), workspace.id)
  })
})

test('resolveInstanceWorkspaceId resolves correctly even against a pre-#96 legacy-shape registry file (migrated on read)', () => {
  withScratchInstances((instancesDir) => {
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(
      registryPath,
      JSON.stringify({
        'legacy-initiative': { kind: 'azureDevOps', organization: 'legacy-org', project: 'legacy-project', repository: 'legacy-repo' },
      })
    )
    const workspaceId = resolveInstanceWorkspaceId('legacy-initiative', { instancesDir })
    assert.equal(typeof workspaceId, 'string')
    assert.equal(resolveWorkspace(workspaceId, { instancesDir }).organization, 'legacy-org')
  })
})
