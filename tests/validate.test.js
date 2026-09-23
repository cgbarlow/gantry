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

function writeOptRefDefinition(root, requires) {
  const defDir = join(root, 'definitions', 'optref')
  mkdirSync(join(defDir, 'modules'), { recursive: true })
  writeFileSync(
    join(defDir, 'definition.yaml'),
    [
      'id: optref',
      'title: Opt Ref',
      'stages:',
      '  - id: only',
      '    title: Only',
      '    gate: g',
      '    modules: [thing]',
      'artefacts:',
      '  - id: art',
      '    title: Art',
      '    template: t.md.tmpl',
      '    gate: g',
      `    requires: [${requires.join(', ')}]`,
    ].join('\n')
  )
  writeFileSync(
    join(defDir, 'modules', 'thing.yaml'),
    'id: thing\ntitle: Thing\nfields:\n  - id: whatsit\n    title: Whatsit\n    type: markdown\n    required: false\n'
  )
}

test('accepts an optional `module.field?` requires entry', () => {
  withScratchDefinition((root) => {
    writeOptRefDefinition(root, ['thing.whatsit?'])
    const problems = findDefinitionProblems('optref', { definitionsDir: join(root, 'definitions') })
    assert.deepEqual(problems, [])
  })
})

test('rejects `?` on a whole-module requires entry', () => {
  withScratchDefinition((root) => {
    writeOptRefDefinition(root, ['thing?'])
    const problems = findDefinitionProblems('optref', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'optional-whole-module')
    assert.match(problems[0].message, /only valid on a field reference/)
  })
})

test('rejects `?` on an unknown field', () => {
  withScratchDefinition((root) => {
    writeOptRefDefinition(root, ['thing.nope?'])
    const problems = findDefinitionProblems('optref', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'missing-field')
    assert.match(problems[0].message, /requires field "thing.nope\?"/)
  })
})

// WI #381 adversarial-review fix: duplicate stage/artefact/module/field ids used to go entirely
// unchecked (no validation anywhere ever looked for them), which let writeProposedFilesToDir silently
// clobber one module's real content with another's when both were given the same id.
test('reports duplicate stage ids', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'dup-stage')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: dup-stage\ntitle: Dup Stage\nstages:\n  - id: only\n    title: First\n    gate: g\n    modules: []\n  - id: only\n    title: Second\n    gate: g\n    modules: []\nartefacts: []\n'
    )

    const problems = findDefinitionProblems('dup-stage', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'duplicate-stage-id')
    assert.match(problems[0].message, /Stage "only" is used by 2 stages/)
  })
})

test('reports duplicate artefact ids', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'dup-artefact')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      [
        'id: dup-artefact',
        'title: Dup Artefact',
        // #149: a real stage gate for both artefacts to name, so the only problem is the duplicate id.
        'stages:',
        '  - id: only',
        '    title: Only',
        '    gate: g',
        '    modules: []',
        'artefacts:',
        '  - id: art',
        '    title: First',
        '    template: t.md.tmpl',
        '    gate: g',
        '    requires: []',
        '  - id: art',
        '    title: Second',
        '    template: t.md.tmpl',
        '    gate: g',
        '    requires: []',
      ].join('\n')
    )

    const problems = findDefinitionProblems('dup-artefact', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'duplicate-artefact-id')
    assert.match(problems[0].message, /Artefact "art" is used by 2 artefacts/)
  })
})

test('reports duplicate field ids within a module, even when the module is unreferenced', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'dup-field')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: dup-field\ntitle: Dup Field\nstages: []\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'thing.yaml'),
      'id: thing\ntitle: Thing\nfields:\n  - id: whatsit\n    title: Whatsit\n    type: markdown\n  - id: whatsit\n    title: Whatsit Again\n    type: markdown\n'
    )

    const problems = findDefinitionProblems('dup-field', { definitionsDir: join(root, 'definitions') })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'duplicate-field-id')
    assert.match(problems[0].message, /Module "thing" field "whatsit" is used by 2 fields/)
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
