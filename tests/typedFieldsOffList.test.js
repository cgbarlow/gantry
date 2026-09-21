import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion, loadDefinition } from '../lib/definition.js'
import { createInstance, writeModule } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'
import { evaluateLocalStage } from '../web/lib/localStatus.js'

// #82 (ADR-0044): a select field's stored value that isn't in its own options: list is
// preserved and flagged as a warning — the Gate must still pass on it.

const STRUCTURE = {
  id: 'offlist-fixture',
  title: 'OffList Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['engagement'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: ['engagement.type'] }],
  modules: [
    {
      id: 'engagement',
      title: 'Engagement',
      purpose: 'How the engagement is classified',
      fields: [{ id: 'type', title: 'Engagement type', type: 'select', required: true, options: ['Permanent', 'Fixed term'] }],
    },
  ],
}

function withOffListFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-offlist-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-offlist-'))
  try {
    createBlankDefinition('offlist-fixture', { definitionsDir })
    writeDefinitionVersion('offlist-fixture', 1, STRUCTURE, { definitionsDir })
    publishDefinitionVersion('offlist-fixture', 1, { definitionsDir })
    createInstance('offlist-fixture', 'offlist-demo', { definitionsDir, instancesDir })
    const definition = loadDefinition('offlist-fixture', { definitionsDir })
    // A value not in options: — as if hand-edited, or the option list changed since this was saved.
    writeModule(definition, 'offlist-demo', 'engagement', {
      status: 'draft',
      owner: '',
      fields: { type: 'Contractor (grandfathered)' },
    }, { instancesDir })
    return fn({ definitionsDir, instancesDir, definition })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('checkGate reports a warning naming the field and the off-list value, and the gate still passes', () => {
  withOffListFixture(({ definitionsDir, instancesDir }) => {
    const result = checkGate('offlist-demo', { instancesDir, definitionsDir })
    assert.equal(result.pass, true, 'a required-but-filled select field, even off-list, satisfies the Gate')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /field "Engagement type"/)
    assert.match(result.warnings[0], /"Contractor \(grandfathered\)"/)
  })
})

test('an on-list value produces no warning', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-offlist-ok-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-offlist-ok-'))
  try {
    createBlankDefinition('offlist-fixture-ok', { definitionsDir })
    writeDefinitionVersion('offlist-fixture-ok', 1, { ...STRUCTURE, id: 'offlist-fixture-ok' }, { definitionsDir })
    publishDefinitionVersion('offlist-fixture-ok', 1, { definitionsDir })
    createInstance('offlist-fixture-ok', 'offlist-ok', { definitionsDir, instancesDir })
    const definition = loadDefinition('offlist-fixture-ok', { definitionsDir })
    writeModule(definition, 'offlist-ok', 'engagement', { status: 'draft', owner: '', fields: { type: 'Permanent' } }, { instancesDir })

    const result = checkGate('offlist-ok', { instancesDir, definitionsDir })
    assert.deepEqual(result.warnings, [])
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Local Workspace twin (web/lib/localStatus.js's evaluateLocalStage) — same warning, computed
// purely over an in-memory structure/moduleData, no disk involved (STRUCTURE is already the
// definition-version-projection shape both this twin and the server twin's projection share).
test('evaluateLocalStage (Local Workspace twin) reports the identical warning', () => {
  const stage = STRUCTURE.stages[0]
  const moduleData = new Map([['engagement', { exists: true, fields: { type: 'Contractor (grandfathered)' } }]])

  const result = evaluateLocalStage(STRUCTURE, stage, moduleData)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /field "Engagement type"/)
  assert.match(result.warnings[0], /"Contractor \(grandfathered\)"/)
})
