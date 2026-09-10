import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withScratchInstances } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import {
  registerInstance,
  resolveInstanceLocation,
  isInstanceArchived,
  MIGRATED_DEFAULT_WORKSPACE_FOLDER,
} from '../lib/instanceRegistry.js'
import { instanceNumbersFor, resolveSlugForRef, formatInstanceRef } from '../lib/numberRegistry.js'
import { readWorkspaceJson, listServerWorkspaces } from '../lib/workspaceDirectory.js'
import { planWorkspaceMigration, migrateLegacyWorkspaceDirectory } from '../lib/workspaceMigration.js'

test('planWorkspaceMigration reports every bare instance directly under the workspaces root, and nothing when none exist', async () => {
  await withScratchInstances((instancesDir) => {
    assert.deepEqual(planWorkspaceMigration(instancesDir), { legacySlugs: [], targetFolder: 'default' })

    createInstance('design', 'legacy-one', { instancesDir })
    createInstance('design', 'legacy-two', { instancesDir })
    const plan = planWorkspaceMigration(instancesDir)
    assert.deepEqual(plan.legacySlugs.sort(), ['legacy-one', 'legacy-two'])
    assert.equal(plan.targetFolder, MIGRATED_DEFAULT_WORKSPACE_FOLDER)
  })
})

test('migrateLegacyWorkspaceDirectory --dry-run (options.dryRun) reports the plan without touching disk', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'legacy-one', { instancesDir })

    const result = migrateLegacyWorkspaceDirectory(instancesDir, { dryRun: true })
    assert.deepEqual(result, { migrated: ['legacy-one'], targetFolder: 'default', dryRun: true })

    // Nothing actually moved.
    assert.equal(existsSync(join(instancesDir, 'legacy-one', 'instance.yaml')), true)
    assert.equal(existsSync(join(instancesDir, 'default')), false)
  })
})

test('migrateLegacyWorkspaceDirectory moves every bare instance under a new "default" server workspace', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'legacy-one', { instancesDir })
    createInstance('design', 'legacy-two', { instancesDir })

    const result = migrateLegacyWorkspaceDirectory(instancesDir)
    assert.deepEqual(result.migrated.sort(), ['legacy-one', 'legacy-two'])
    assert.equal(result.targetFolder, 'default')

    assert.equal(existsSync(join(instancesDir, 'legacy-one')), false)
    assert.equal(existsSync(join(instancesDir, 'legacy-two')), false)
    assert.equal(existsSync(join(instancesDir, 'default', 'legacy-one', 'instance.yaml')), true)
    assert.equal(existsSync(join(instancesDir, 'default', 'legacy-two', 'instance.yaml')), true)

    const record = readWorkspaceJson(instancesDir, 'default')
    assert.equal(record.name, 'default')
    assert.equal(record.kind, 'local')

    const workspaces = listServerWorkspaces(instancesDir)
    assert.deepEqual(workspaces.map((w) => w.id), ['default'])
  })
})

test('migrateLegacyWorkspaceDirectory is idempotent — a second call finds nothing left to move', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'legacy-one', { instancesDir })
    migrateLegacyWorkspaceDirectory(instancesDir)
    const second = migrateLegacyWorkspaceDirectory(instancesDir)
    assert.deepEqual(second, { migrated: [], targetFolder: 'default' })
  })
})

test('migrateLegacyWorkspaceDirectory does nothing to a workspaces root that does not exist yet', async () => {
  await withScratchInstances((instancesDir) => {
    const neverCreated = join(instancesDir, 'does-not-exist')
    const result = migrateLegacyWorkspaceDirectory(neverCreated)
    assert.deepEqual(result, { migrated: [], targetFolder: 'default' })
  })
})

test('migrateLegacyWorkspaceDirectory reuses an already-existing default/workspace.json rather than overwriting it', async () => {
  await withScratchInstances((instancesDir) => {
    mkdirSync(join(instancesDir, 'default'), { recursive: true })
    writeFileSync(
      join(instancesDir, 'default', 'workspace.json'),
      JSON.stringify({ name: 'Custom name', kind: 'local', createdAt: '2020-01-01T00:00:00.000Z' })
    )
    createInstance('design', 'legacy-one', { instancesDir })

    migrateLegacyWorkspaceDirectory(instancesDir)

    const record = readWorkspaceJson(instancesDir, 'default')
    assert.equal(record.name, 'Custom name')
    assert.equal(existsSync(join(instancesDir, 'default', 'legacy-one', 'instance.yaml')), true)
  })
})

// ---------- WI #356 acceptance criterion 1: numbered refs survive migration byte-for-byte ----------

test('a pre-migration numbered reference (w0i1, w0i2) resolves to the exact same instance after migration', async () => {
  await withScratchInstances((instancesDir) => {
    // Simulate the pre-#356 world: bare instances directly under the workspaces root, registered
    // the old flat way, each already carrying a real numbered reference.
    createInstance('design', 'alpha', { instancesDir })
    createInstance('design', 'beta', { instancesDir })
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(registryPath, JSON.stringify({ alpha: { kind: 'local' }, beta: { kind: 'local' } }))

    const alphaBefore = instanceNumbersFor('alpha', { instancesDir })
    const betaBefore = instanceNumbersFor('beta', { instancesDir })
    const alphaRef = formatInstanceRef(alphaBefore)
    const betaRef = formatInstanceRef(betaBefore)
    assert.equal(alphaRef, 'w0i1')
    assert.equal(betaRef, 'w0i2')

    // Run the migration — directories move, default/workspace.json is created.
    migrateLegacyWorkspaceDirectory(instancesDir)

    // The exact same numbered references resolve to the exact same slugs afterward — this is the
    // whole point: nothing about number-registry.json changed, and instance-registry.json's legacy
    // flat entries auto-migrate onto the scope the moved directories now really live under.
    assert.equal(resolveSlugForRef(alphaRef, { instancesDir }), 'alpha')
    assert.equal(resolveSlugForRef(betaRef, { instancesDir }), 'beta')

    // And the registry resolves them through the new workspace-qualified location too.
    assert.deepEqual(resolveInstanceLocation('alpha', { instancesDir, workspace: 'default' }), {
      kind: 'directory',
      workspace: 'default',
    })
  })
})

test('an archived pre-migration instance stays archived after migration', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'alpha', { instancesDir })
    const registryPath = join(instancesDir, 'instance-registry.json')
    writeFileSync(registryPath, JSON.stringify({ alpha: { kind: 'local', archived: true } }))

    migrateLegacyWorkspaceDirectory(instancesDir)

    assert.equal(isInstanceArchived('alpha', { instancesDir, workspace: 'default' }), true)
  })
})

test('registerInstance rejects the retired "local" kind — a caller migrating manually must use "directory"', async () => {
  await withScratchInstances((instancesDir) => {
    assert.throws(() => registerInstance('x', { kind: 'local' }, { instancesDir }))
  })
})
