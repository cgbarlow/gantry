import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'yaml'
import { loadDefinition, writeDefinitionVersion, publishDefinitionVersion, definitionVersionProjection } from '../lib/definition.js'

// WI #382: `copied-from: { definition, version, element }` is an optional property on
// stage/artefact/module/field YAML shapes, recording provenance for a copied element (ADR-0035).
// It must round-trip through load -> projection -> save -> load -> publish without tripping the
// duplicate-id check WI #381 added (lib/definition.js's findDuplicateIdProblems only ever reads
// `.id`/`.fields`, so an extra `copied-from` property must be inert to it).

function withDraftFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-provenance-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let raw = yaml.parse(readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8'))
    raw.version = 2
    raw.status = 'draft'
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), yaml.stringify(raw))
    fn({ definitionsDir })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

test('copied-from on a module and its field round-trips through writeDefinitionVersion and loadDefinition', () => {
  withDraftFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const structure = definitionVersionProjection(def)

    structure.modules.push({
      id: 'borrowed-module',
      title: 'Borrowed Module',
      purpose: 'Copied in from elsewhere.',
      copiedFrom: { definition: 'procurement', version: 3, element: 'module:borrowed-module' },
      fields: [
        { id: 'note', title: 'Note', type: 'markdown', copiedFrom: { definition: 'procurement', version: 3, element: 'field:borrowed-module.note' } },
      ],
    })
    // A copied module only survives loadDefinition's referenced-modules pass (and so shows up in
    // the projection writeDefinitionVersion returns) once something actually references it — same
    // as any other module a real copy operation lands, which always adds it to a stage or artefact.
    structure.stages[0].modules.push('borrowed-module')

    const result = writeDefinitionVersion('design', 2, structure, { definitionsDir })
    assert.equal(result.problems, undefined, JSON.stringify(result.problems))

    // The projection returned by writeDefinitionVersion itself carries the stamp straight through.
    const savedModule = result.modules.find((m) => m.id === 'borrowed-module')
    assert.deepEqual(savedModule.copiedFrom, { definition: 'procurement', version: 3, element: 'module:borrowed-module' })
    assert.deepEqual(savedModule.fields[0].copiedFrom, { definition: 'procurement', version: 3, element: 'field:borrowed-module.note' })

    // And it survives a fresh disk read too — not just held in the in-memory return value.
    const reloaded = loadDefinition('design', { definitionsDir, version: 2 })
    const reloadedModule = reloaded.modules.get('borrowed-module')
    assert.deepEqual(reloadedModule.copiedFrom, { definition: 'procurement', version: 3, element: 'module:borrowed-module' })
    assert.deepEqual(reloadedModule.fields[0].copiedFrom, { definition: 'procurement', version: 3, element: 'field:borrowed-module.note' })

    // The raw YAML uses the kebab-case key, per lib/definition.js's usual required/required-at convention.
    const rawYaml = readFileSync(join(definitionsDir, 'design/2/modules/borrowed-module.yaml'), 'utf8')
    assert.match(rawYaml, /copied-from:/)
    assert.doesNotMatch(rawYaml, /copiedFrom:/)
  })
})

test('copied-from on a stage and an artefact round-trips, and does not trip the duplicate-id check', () => {
  withDraftFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const structure = definitionVersionProjection(def)

    structure.stages.push({
      id: 'borrowed-stage', title: 'Borrowed Stage', purpose: '', gate: 'borrowed-gate', modules: [],
      copiedFrom: { definition: 'procurement', version: 3, element: 'stage:borrowed-stage' },
    })
    structure.artefacts.push({
      id: 'borrowed-artefact', title: 'Borrowed Artefact', purpose: '', template: '', gate: 'borrowed-gate', requires: [],
      copiedFrom: { definition: 'procurement', version: 3, element: 'artefact:borrowed-artefact' },
    })

    const result = writeDefinitionVersion('design', 2, structure, { definitionsDir })
    assert.equal(result.problems, undefined, JSON.stringify(result.problems))

    const stage = result.stages.find((s) => s.id === 'borrowed-stage')
    const artefact = result.artefacts.find((a) => a.id === 'borrowed-artefact')
    assert.deepEqual(stage.copiedFrom, { definition: 'procurement', version: 3, element: 'stage:borrowed-stage' })
    assert.deepEqual(artefact.copiedFrom, { definition: 'procurement', version: 3, element: 'artefact:borrowed-artefact' })

    const rawYaml = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    assert.match(rawYaml, /copied-from:/)
  })
})

test('an element with no copied-from omits the key entirely (not written as null/undefined)', () => {
  withDraftFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const structure = definitionVersionProjection(def)
    const result = writeDefinitionVersion('design', 2, structure, { definitionsDir })
    assert.equal(result.problems, undefined)
    for (const m of result.modules) assert.equal(m.copiedFrom, undefined)
    const rawYaml = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    assert.doesNotMatch(rawYaml, /copied-from:/)
  })
})

test('a definition carrying copied-from elements still publishes cleanly', () => {
  withDraftFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const structure = definitionVersionProjection(def)
    structure.modules.push({
      id: 'borrowed-module', title: 'Borrowed Module', purpose: '',
      copiedFrom: { definition: 'procurement', version: 1, element: 'module:borrowed-module' },
      fields: [{ id: 'note', title: 'Note', type: 'markdown' }],
    })
    structure.stages[0].modules.push('borrowed-module')
    writeDefinitionVersion('design', 2, structure, { definitionsDir })
    const published = publishDefinitionVersion('design', 2, { definitionsDir })
    assert.equal(published.problems, undefined, JSON.stringify(published.problems))
    assert.equal(published.status, 'published')
    const module = published.modules.find((m) => m.id === 'borrowed-module')
    assert.deepEqual(module.copiedFrom, { definition: 'procurement', version: 1, element: 'module:borrowed-module' })
  })
})
