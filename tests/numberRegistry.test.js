import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import {
  LOCAL_SCOPE,
  LOCAL_WORKSPACE_NUMBER,
  getOrAssignWorkspaceNumber,
  resolveWorkspaceNumber,
  resolveWorkspaceIdByNumber,
  getOrAssignInstanceNumber,
  resolveInstanceNumber,
  resolveSlugByNumber,
  scopeKeyForSlug,
  instanceNumbersFor,
  formatInstanceRef,
  parseInstanceRef,
  resolveSlugForRef,
  stageNumberForStageId,
  stageIdForNumber,
  backfillNumberRegistry,
} from '../lib/numberRegistry.js'
import { withScratchInstances } from './helpers/lifecycle.js'


function makeLocalInstance(instancesDir, slug) {
  mkdirSync(join(instancesDir, slug), { recursive: true })
}

// ---------- workspace numbers ----------

test('getOrAssignWorkspaceNumber assigns 1, 2, 3... in call order, and is idempotent', async () => {
  await withScratchInstances((instancesDir) => {
    const a = getOrAssignWorkspaceNumber('ws-a', { instancesDir })
    const b = getOrAssignWorkspaceNumber('ws-b', { instancesDir })
    const aAgain = getOrAssignWorkspaceNumber('ws-a', { instancesDir })
    assert.equal(a, 1)
    assert.equal(b, 2)
    assert.equal(aAgain, 1)
  })
})

test('resolveWorkspaceNumber/resolveWorkspaceIdByNumber round-trip, undefined when unknown', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(resolveWorkspaceNumber('nope', { instancesDir }), undefined)
    const n = getOrAssignWorkspaceNumber('ws-a', { instancesDir })
    assert.equal(resolveWorkspaceNumber('ws-a', { instancesDir }), n)
    assert.equal(resolveWorkspaceIdByNumber(n, { instancesDir }), 'ws-a')
    assert.equal(resolveWorkspaceIdByNumber(9999, { instancesDir }), undefined)
  })
})

// ---------- instance numbers (scoped) ----------

test('instance numbering restarts at 1 within each scope', async () => {
  await withScratchInstances((instancesDir) => {
    const a1 = getOrAssignInstanceNumber('workspace-1', 'alpha', { instancesDir })
    const a2 = getOrAssignInstanceNumber('workspace-1', 'beta', { instancesDir })
    const b1 = getOrAssignInstanceNumber('workspace-2', 'gamma', { instancesDir })
    assert.equal(a1, 1)
    assert.equal(a2, 2)
    assert.equal(b1, 1) // restarts at 1 in a different scope
  })
})

test('getOrAssignInstanceNumber is idempotent per slug within a scope', async () => {
  await withScratchInstances((instancesDir) => {
    const first = getOrAssignInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir })
    const second = getOrAssignInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir })
    assert.equal(first, second)
  })
})

test('resolveInstanceNumber/resolveSlugByNumber round-trip, undefined when unknown', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(resolveInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir }), undefined)
    const n = getOrAssignInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir })
    assert.equal(resolveInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir }), n)
    assert.equal(resolveSlugByNumber(LOCAL_SCOPE, n, { instancesDir }), 'demo')
    assert.equal(resolveSlugByNumber(LOCAL_SCOPE, 999, { instancesDir }), undefined)
  })
})

test('scopeKeyForSlug returns LOCAL_SCOPE for a local instance and the workspace id for an azureDevOps one', async () => {
  await withScratchInstances((instancesDir) => {
    makeLocalInstance(instancesDir, 'local-one')
    registerInstance('local-one', { kind: 'local' }, { instancesDir })
    assert.equal(scopeKeyForSlug('local-one', { instancesDir }), LOCAL_SCOPE)

    registerInstance(
      'remote-one',
      { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' },
      { instancesDir }
    )
    const scopeKey = scopeKeyForSlug('remote-one', { instancesDir })
    assert.notEqual(scopeKey, LOCAL_SCOPE)
    assert.equal(typeof scopeKey, 'string')
  })
})

test('scopeKeyForSlug treats a never-registered slug as local', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(scopeKeyForSlug('never-heard-of-it', { instancesDir }), LOCAL_SCOPE)
  })
})

// ---------- instanceNumbersFor / ref format ----------

test('instanceNumbersFor gives a local instance workspaceNumber = LOCAL_WORKSPACE_NUMBER', async () => {
  await withScratchInstances((instancesDir) => {
    makeLocalInstance(instancesDir, 'demo')
    registerInstance('demo', { kind: 'local' }, { instancesDir })
    const { workspaceNumber, instanceNumber } = instanceNumbersFor('demo', { instancesDir })
    assert.equal(workspaceNumber, LOCAL_WORKSPACE_NUMBER)
    assert.equal(instanceNumber, 1)
  })
})

test('instanceNumbersFor gives an azureDevOps instance its real workspace number', async () => {
  await withScratchInstances((instancesDir) => {
    registerInstance(
      'remote-one',
      { kind: 'azureDevOps', organization: 'org', project: 'proj', repository: 'repo' },
      { instancesDir }
    )
    const { workspaceNumber, instanceNumber } = instanceNumbersFor('remote-one', { instancesDir })
    assert.notEqual(workspaceNumber, LOCAL_WORKSPACE_NUMBER)
    assert.equal(instanceNumber, 1)
    // Idempotent across calls.
    assert.deepEqual(instanceNumbersFor('remote-one', { instancesDir }), { workspaceNumber, instanceNumber })
  })
})

test('formatInstanceRef/parseInstanceRef round-trip, and parseInstanceRef rejects a non-numeric slug', () => {
  const ref = formatInstanceRef({ workspaceNumber: 2, instanceNumber: 3 })
  assert.equal(ref, 'w2i3')
  assert.deepEqual(parseInstanceRef(ref), { workspaceNumber: 2, instanceNumber: 3, stageNumber: null })
  assert.deepEqual(parseInstanceRef('w4'), { workspaceNumber: 4, instanceNumber: null, stageNumber: null })
  assert.deepEqual(parseInstanceRef('w4i5s1'), { workspaceNumber: 4, instanceNumber: 5, stageNumber: 1 })
  assert.equal(parseInstanceRef('my-slug'), null)
  assert.equal(parseInstanceRef(''), null)
})

test('resolveSlugForRef resolves a fully-qualified ref, and defaults a workspace-only ref to instance 1', async () => {
  await withScratchInstances((instancesDir) => {
    makeLocalInstance(instancesDir, 'first')
    makeLocalInstance(instancesDir, 'second')
    registerInstance('first', { kind: 'local' }, { instancesDir })
    registerInstance('second', { kind: 'local' }, { instancesDir })
    instanceNumbersFor('first', { instancesDir })
    instanceNumbersFor('second', { instancesDir })

    assert.equal(resolveSlugForRef('w0i1', { instancesDir }), 'first')
    assert.equal(resolveSlugForRef('w0i2', { instancesDir }), 'second')
    // Workspace-only (local scope) defaults to instance 1.
    assert.equal(resolveSlugForRef('w0', { instancesDir }), 'first')
  })
})

test('resolveSlugForRef returns undefined for an unknown workspace/instance number or a non-numeric ref', async () => {
  await withScratchInstances((instancesDir) => {
    assert.equal(resolveSlugForRef('w99', { instancesDir }), undefined)
    assert.equal(resolveSlugForRef('not-a-ref', { instancesDir }), undefined)
  })
})

// ---------- stage numbers (pure, derived) ----------

test('stageNumberForStageId/stageIdForNumber are 1-based positions in definition.stages, no persistence involved', () => {
  const definition = { stages: [{ id: 'shape' }, { id: 'design' }, { id: 'build' }] }
  assert.equal(stageNumberForStageId(definition, 'shape'), 1)
  assert.equal(stageNumberForStageId(definition, 'design'), 2)
  assert.equal(stageNumberForStageId(definition, 'build'), 3)
  assert.equal(stageNumberForStageId(definition, 'nope'), undefined)
  assert.equal(stageIdForNumber(definition, 1), 'shape')
  assert.equal(stageIdForNumber(definition, 3), 'build')
  assert.equal(stageIdForNumber(definition, 99), undefined)
})

// ---------- backfill ----------

test('backfillNumberRegistry assigns numbers to pre-existing workspaces/instances', async () => {
  await withScratchInstances((instancesDir) => {
    const ws = registerWorkspace({ organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })
    registerInstance('remote-one', { kind: 'azureDevOps', workspaceId: ws.id }, { instancesDir })
    makeLocalInstance(instancesDir, 'local-one')
    registerInstance('local-one', { kind: 'local' }, { instancesDir })

    const result = backfillNumberRegistry({ instancesDir })
    assert.equal(result.workspacesAssigned, 1)
    assert.equal(result.instancesAssigned, 2)

    assert.equal(resolveWorkspaceNumber(ws.id, { instancesDir }), 1)
    assert.equal(resolveInstanceNumber(ws.id, 'remote-one', { instancesDir }), 1)
    assert.equal(resolveInstanceNumber(LOCAL_SCOPE, 'local-one', { instancesDir }), 1)
  })
})

test('backfillNumberRegistry orders pre-existing local instances by directory creation-time proxy, not alphabetically', async () => {
  await withScratchInstances((instancesDir) => {
    // Deliberately created/registered in reverse-alphabetical order, with 'zeta' given
    // an *older* mtime than 'alpha' — the backfill should number by that timestamp
    // proxy, not by name.
    makeLocalInstance(instancesDir, 'zeta')
    makeLocalInstance(instancesDir, 'alpha')
    const older = new Date(Date.now() - 60_000)
    const newer = new Date()
    utimesSync(join(instancesDir, 'zeta'), older, older)
    utimesSync(join(instancesDir, 'alpha'), newer, newer)
    registerInstance('zeta', { kind: 'local' }, { instancesDir })
    registerInstance('alpha', { kind: 'local' }, { instancesDir })

    backfillNumberRegistry({ instancesDir })

    assert.equal(resolveInstanceNumber(LOCAL_SCOPE, 'zeta', { instancesDir }), 1)
    assert.equal(resolveInstanceNumber(LOCAL_SCOPE, 'alpha', { instancesDir }), 2)
  })
})

test('backfillNumberRegistry is idempotent — a second call assigns nothing new and keeps existing numbers', async () => {
  await withScratchInstances((instancesDir) => {
    registerWorkspace({ organization: 'org', project: 'proj', repository: 'repo' }, { instancesDir })
    makeLocalInstance(instancesDir, 'demo')
    registerInstance('demo', { kind: 'local' }, { instancesDir })

    const first = backfillNumberRegistry({ instancesDir })
    assert.ok(first.workspacesAssigned + first.instancesAssigned > 0)
    const before = resolveInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir })

    const second = backfillNumberRegistry({ instancesDir })
    assert.equal(second.workspacesAssigned, 0)
    assert.equal(second.instancesAssigned, 0)
    assert.equal(resolveInstanceNumber(LOCAL_SCOPE, 'demo', { instancesDir }), before)
  })
})
