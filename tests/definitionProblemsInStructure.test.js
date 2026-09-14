import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDefinitionProblemsInStructure, createBlankDefinition, loadDefinition } from '../lib/definition.js'

// WI #381: the definition editor's live validation markers call
// `findDefinitionProblemsInStructure` directly (via `POST .../validate`, see tests/server.test.js)
// against the in-memory draft — this covers the pure rule set on its own, with the same problem
// `type`s `findDefinitionProblems` reports (tests/validate.test.js), so the two never drift apart.

test('findDefinitionProblemsInStructure: clean structure has no problems', () => {
  const problems = findDefinitionProblemsInStructure({
    stages: [{ id: 'shape', modules: ['background'] }],
    artefacts: [{ id: 'soap', requires: ['background.problem'] }],
    modules: [{ id: 'background', fields: [{ id: 'problem', type: 'markdown', required: true }] }],
  })
  assert.deepEqual(problems, [])
})

test('findDefinitionProblemsInStructure: reports every problem type in one pass', () => {
  const problems = findDefinitionProblemsInStructure({
    stages: [{ id: 'shape', modules: ['missing-one'] }],
    artefacts: [
      { id: 'soap', requires: ['also-missing', 'background.no-such-field', 'background?'] },
    ],
    modules: [
      {
        id: 'background',
        fields: [
          { id: 'weird', type: 'freeform' },
          { id: 'both', type: 'markdown', required: true, requiredAt: ['shape'] },
        ],
      },
    ],
  })
  const types = problems.map((p) => p.type).sort()
  assert.deepEqual(types, [
    'missing-field',
    'missing-module',
    'missing-module',
    'mutually-exclusive-required',
    'optional-whole-module',
    'unknown-field-type',
  ])
})

test('findDefinitionProblemsInStructure: an unreferenced module is never checked or complained about', () => {
  const problems = findDefinitionProblemsInStructure({
    stages: [],
    artefacts: [],
    modules: [{ id: 'unused', fields: [{ id: 'x', type: 'not-a-type' }] }],
  })
  assert.deepEqual(problems, [])
})

test('findDefinitionProblemsInStructure: tolerates a bare structure with no stages/artefacts/modules', () => {
  assert.deepEqual(findDefinitionProblemsInStructure({}), [])
})

test('createBlankDefinition writes a valid empty draft v1 that loadDefinition can read back', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-blank-def-'))
  try {
    const result = createBlankDefinition('my-new-def', { definitionsDir, title: 'My New Def' })
    assert.equal(result.id, 'my-new-def')
    assert.ok(existsSync(join(definitionsDir, 'my-new-def/1/definition.yaml')))
    assert.ok(existsSync(join(definitionsDir, 'my-new-def/1/modules')))
    const loaded = loadDefinition('my-new-def', { definitionsDir, version: 1 })
    assert.equal(loaded.status, 'draft')
    assert.equal(loaded.version, 1)
    assert.equal(loaded.title, 'My New Def')
    assert.deepEqual(loaded.stages, [])
    assert.deepEqual(loaded.artefacts, [])
    assert.equal(loaded.modules.size, 0)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

test('createBlankDefinition rejects an id that already exists', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-blank-def2-'))
  try {
    createBlankDefinition('dup', { definitionsDir })
    assert.throws(() => createBlankDefinition('dup', { definitionsDir }), /already exists/)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

test('createBlankDefinition rejects an invalid slug', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-blank-def3-'))
  try {
    assert.throws(() => createBlankDefinition('../escape', { definitionsDir }), /Invalid slug/)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})
