import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBlankDefinition,
  writeDefinitionVersion,
  publishDefinitionVersion,
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblems,
} from '../lib/definition.js'
import { createInstance, readModule } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'

// #84 (ADR-0044): default: pre-selects in the editor, but only reaches the Module file on the
// Stage's first save — never at Instance creation, so a required field with a default is not
// satisfied by an Instance nobody has opened.

const STRUCTURE = {
  id: 'default-fixture',
  title: 'Default Fixture',
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
      fields: [{ id: 'type', title: 'Engagement type', type: 'select', required: true, default: 'Permanent', options: ['Permanent', 'Fixed term', 'Contractor'] }],
    },
  ],
}

function withDefaultFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-default-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-default-'))
  try {
    createBlankDefinition('default-fixture', { definitionsDir })
    writeDefinitionVersion('default-fixture', 1, STRUCTURE, { definitionsDir })
    publishDefinitionVersion('default-fixture', 1, { definitionsDir })
    return fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('loads default: and carries it through the projection round trip', () => {
  withDefaultFixture(({ definitionsDir }) => {
    const def = loadDefinition('default-fixture', { definitionsDir })
    const field = def.modules.get('engagement').fields.find((f) => f.id === 'type')
    assert.equal(field.default, 'Permanent')

    createBlankDefinition('default-fixture-v2-host', { definitionsDir })
    writeDefinitionVersion('default-fixture-v2-host', 1, definitionVersionProjection(def), { definitionsDir })
    publishDefinitionVersion('default-fixture-v2-host', 1, { definitionsDir })
    const reloaded = loadDefinition('default-fixture-v2-host', { definitionsDir })
    assert.equal(reloaded.modules.get('engagement').fields.find((f) => f.id === 'type').default, 'Permanent')
  })
})

test('a default not present in options: is a validation error', () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-definition-'))
  try {
    const defDir = join(root, 'definitions', 'bad-default')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: bad-default\ntitle: Bad Default\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [engagement]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'engagement.yaml'),
      'id: engagement\ntitle: Engagement\nfields:\n  - id: type\n    title: Type\n    type: select\n    default: Nope\n    options:\n      - Permanent\n      - Fixed term\n'
    )

    assert.throws(
      () => loadDefinition('bad-default', { definitionsDir: join(root, 'definitions') }),
      /"default: Nope" which is not in its own "options:" list/
    )
    const problems = findDefinitionProblems('bad-default', { definitionsDir: join(root, 'definitions') })
    assert.ok(problems.some((p) => p.type === 'select-invalid-default'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a freshly created Instance has the field empty regardless of its default, and the Gate stays blocked until saved', () => {
  withDefaultFixture(({ definitionsDir, instancesDir }) => {
    createInstance('default-fixture', 'default-demo', { definitionsDir, instancesDir })
    const definition = loadDefinition('default-fixture', { definitionsDir })

    const onDisk = readModule(definition, 'default-demo', 'engagement', { instancesDir })
    assert.equal(onDisk.fields.type, '', 'the default is not written at creation')

    const result = checkGate('default-demo', { instancesDir, definitionsDir })
    assert.equal(result.pass, false, 'a required field with only a default, never saved, does not satisfy the Gate')
  })
})
