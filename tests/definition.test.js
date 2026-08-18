import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'

test('loads the real design definition', () => {
  const design = loadDefinition('design')

  assert.equal(design.id, 'design')
  assert.equal(design.stages.length, 4)

  const shape = design.stages.find((stage) => stage.id === 'shape')
  assert.deepEqual(shape.modules, ['context', 'solution-definition', 'team-and-estimates'])

  const soap = design.artefacts.find((artefact) => artefact.id === 'soap')
  assert.deepEqual(soap.requires, ['context', 'solution-definition', 'team-and-estimates'])

  const context = design.modules.get('context')
  assert.equal(context.title, 'Context')
  const driver = context.fields.find((field) => field.id === 'driver')
  assert.equal(driver.type, 'markdown')
  assert.equal(driver.required, true)

  // dependencies uses required-at, not required, at the field level
  const dependencies = design.modules.get('dependencies')
  const overview = dependencies.fields.find((field) => field.id === 'dependencies-overview')
  assert.deepEqual(overview.requiredAt, ['hld-tac-approved'])
})

function withScratchDefinition(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-test-'))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('fails loudly when a stage references a missing module', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'broken')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: broken\ntitle: Broken\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [nope]\nartefacts: []\n'
    )

    assert.throws(
      () => loadDefinition('broken', { definitionsDir: join(root, 'definitions') }),
      /references module "nope"/
    )
  })
})

test('fails loudly on an unknown field type', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'broken-field')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: broken-field\ntitle: Broken Field\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [thing]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'thing.yaml'),
      'id: thing\ntitle: Thing\nfields:\n  - id: whatsit\n    title: Whatsit\n    type: freeform\n'
    )

    assert.throws(
      () => loadDefinition('broken-field', { definitionsDir: join(root, 'definitions') }),
      /unknown type "freeform"/
    )
  })
})
