import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDefinitionProblems } from '../lib/definition.js'
import { validateDefinition } from '../lib/validate.js'

function withScratchDefinition(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-test-'))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the real design definition has no problems', () => {
  const result = validateDefinition('design')
  assert.equal(result.valid, true)
  assert.deepEqual(result.problems, [])
})

test('reports a missing module reference', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'broken')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: broken\ntitle: Broken\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [nope]\nartefacts: []\n'
    )

    const problems = findDefinitionProblems('broken', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'missing-module')
    assert.match(problems[0].message, /references module "nope"/)
  })
})

test('reports an unknown field type', () => {
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

    const problems = findDefinitionProblems('broken-field', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'unknown-field-type')
    assert.match(problems[0].message, /unknown type "freeform"/)
  })
})

test('reports a required/required-at mutual-exclusivity violation', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'broken-required')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: broken-required\ntitle: Broken Required\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [thing]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'thing.yaml'),
      'id: thing\ntitle: Thing\nfields:\n  - id: whatsit\n    title: Whatsit\n    type: markdown\n    required: true\n    required-at: [g]\n'
    )

    const problems = findDefinitionProblems('broken-required', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'mutually-exclusive-required')
    assert.match(problems[0].message, /mutually exclusive/)
  })
})

test('reports every problem in one pass, not just the first', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'very-broken')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      [
        'id: very-broken',
        'title: Very Broken',
        'stages:',
        '  - id: only',
        '    title: Only',
        '    gate: g',
        '    modules: [nope, thing]',
        'artefacts:',
        '  - id: art',
        '    title: Art',
        '    template: t.md.tmpl',
        '    gate: g',
        '    requires: [also-nope]',
      ].join('\n')
    )
    writeFileSync(
      join(defDir, 'modules', 'thing.yaml'),
      [
        'id: thing',
        'title: Thing',
        'fields:',
        '  - id: whatsit',
        '    title: Whatsit',
        '    type: freeform',
        '  - id: other',
        '    title: Other',
        '    type: markdown',
        '    required: true',
        '    required-at: [g]',
      ].join('\n')
    )

    const problems = findDefinitionProblems('very-broken', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 4)
    assert.deepEqual(
      problems.map((p) => p.type).sort(),
      ['missing-module', 'missing-module', 'mutually-exclusive-required', 'unknown-field-type']
    )
  })
})
