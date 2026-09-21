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
  findDefinitionProblemsInStructure,
} from '../lib/definition.js'
import { createInstance, writeModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'

// #87 (ADR-0045): an Artefact's `filename:` pattern resolves against the Instance's own
// content at render time — everything here goes through `renderedArtefactBasename`
// (tests/renderedArtefactBasename.test.js covers that pure function directly); this file
// covers the definition.yaml plumbing (both write paths, both validators) and the end-to-end
// render path.

const STRUCTURE = {
  id: 'filename-fixture',
  title: 'Filename Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['candidate'] }],
  artefacts: [
    {
      id: 'offer',
      title: 'Offer Pack',
      purpose: 'The offer',
      template: 'templates/offer.md.tmpl',
      gate: 'g',
      requires: ['candidate.name', 'candidate.start-date'],
      filename: '{candidate.name} - Offer - {candidate.start-date}',
    },
    {
      id: 'summary',
      title: 'Summary',
      purpose: 'No pattern — must render exactly as before',
      template: 'templates/summary.md.tmpl',
      gate: 'g',
      requires: ['candidate.name'],
    },
  ],
  modules: [
    {
      id: 'candidate',
      title: 'Candidate',
      purpose: 'Who and when',
      fields: [
        { id: 'name', title: 'Candidate name', type: 'text', required: true },
        { id: 'start-date', title: 'Start date', type: 'date', required: true },
        { id: 'notes', title: 'Notes', type: 'markdown' },
        { id: 'tags', title: 'Tags', type: 'list' },
        { id: 'level', title: 'Level', type: 'select', options: ['Junior', 'Senior'], multiple: true },
      ],
    },
  ],
}

function withFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-filename-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-filename-'))
  try {
    createBlankDefinition('filename-fixture', { definitionsDir })
    writeDefinitionVersion('filename-fixture', 1, STRUCTURE, { definitionsDir })
    publishDefinitionVersion('filename-fixture', 1, { definitionsDir })
    for (const artefact of STRUCTURE.artefacts) {
      const templatePath = join(definitionsDir, 'filename-fixture', '1', artefact.template)
      mkdirSync(join(templatePath, '..'), { recursive: true })
      writeFileSync(templatePath, `# ${artefact.title}\n\nName: <%~ it.modules.candidate.name %>\n`)
    }
    return fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('a valid filename: pattern is accepted by findDefinitionProblems, and round-trips through loadDefinition/definitionVersionProjection', () => {
  withFixture(({ definitionsDir }) => {
    const problems = findDefinitionProblems('filename-fixture', { definitionsDir })
    assert.deepEqual(problems, [])

    const def = loadDefinition('filename-fixture', { definitionsDir })
    const offer = def.artefacts.find((a) => a.id === 'offer')
    assert.equal(offer.filename, '{candidate.name} - Offer - {candidate.start-date}')
    const summary = def.artefacts.find((a) => a.id === 'summary')
    assert.equal(summary.filename, undefined)

    createBlankDefinition('filename-fixture-v2-host', { definitionsDir })
    writeDefinitionVersion('filename-fixture-v2-host', 1, definitionVersionProjection(def), { definitionsDir })
    publishDefinitionVersion('filename-fixture-v2-host', 1, { definitionsDir })
    const reloaded = loadDefinition('filename-fixture-v2-host', { definitionsDir })
    assert.equal(reloaded.artefacts.find((a) => a.id === 'offer').filename, '{candidate.name} - Offer - {candidate.start-date}')
    assert.equal(reloaded.artefacts.find((a) => a.id === 'summary').filename, undefined)
  })
})

test('findLocalDefinitionProblems (Local Workspace twin) accepts the same valid pattern', () => {
  withFixture(({ definitionsDir }) => {
    const def = loadDefinition('filename-fixture', { definitionsDir })
    const problems = findLocalDefinitionProblems(definitionVersionProjection(def))
    assert.deepEqual(problems, [])
  })
})

test('a render resolves the pattern against the instance content and names the document accordingly', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('filename-fixture', 'filename-demo', { definitionsDir, instancesDir })
    const definition = loadDefinition('filename-fixture', { definitionsDir })
    writeModule(definition, 'filename-demo', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-11-03' },
    }, { instancesDir })

    const result = renderArtefact('filename-demo', 'offer', { dryRun: true, instancesDir, definitionsDir })
    assert.equal(result.basename, 'Jane Smith - Offer - 2026-11-03')
  })
})

test('an artefact with no filename: pattern still renders under "<Instance name> - <Artefact title>", unchanged', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('filename-fixture', 'filename-plain', { definitionsDir, instancesDir })
    const definition = loadDefinition('filename-fixture', { definitionsDir })
    writeModule(definition, 'filename-plain', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-11-03' },
    }, { instancesDir })

    const result = renderArtefact('filename-plain', 'summary', { dryRun: true, instancesDir, definitionsDir })
    assert.equal(result.basename, 'Filename Plain - Summary')
  })
})

test('a render with the field still blank drops the empty token and tidies the separator, per ADR-0045 §5', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('filename-fixture', 'filename-blank', { definitionsDir, instancesDir })
    const definition = loadDefinition('filename-fixture', { definitionsDir })
    // "start-date" is required by the gate but not by a dry-run render — leave it blank to
    // exercise the mid-stage "render before every field is filled" case ADR-0045 §5 covers.
    writeModule(definition, 'filename-blank', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '' },
    }, { instancesDir })

    const result = renderArtefact('filename-blank', 'offer', { dryRun: true, instancesDir, definitionsDir })
    assert.equal(result.basename, 'Jane Smith - Offer')
  })
})

test('{today} in a filename: pattern is the date of this render, not a frozen one', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createBlankDefinition('filename-today', { definitionsDir })
    const structure = {
      ...STRUCTURE,
      id: 'filename-today',
      artefacts: [{ ...STRUCTURE.artefacts[0], filename: '{candidate.name} - {today}' }],
    }
    writeDefinitionVersion('filename-today', 1, structure, { definitionsDir })
    publishDefinitionVersion('filename-today', 1, { definitionsDir })
    const templatePath = join(definitionsDir, 'filename-today', '1', 'templates', 'offer.md.tmpl')
    mkdirSync(join(templatePath, '..'), { recursive: true })
    writeFileSync(templatePath, '# Offer\n')

    createInstance('filename-today', 'filename-today-demo', { definitionsDir, instancesDir })
    const definition = loadDefinition('filename-today', { definitionsDir })
    writeModule(definition, 'filename-today-demo', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-11-03' },
    }, { instancesDir })

    const today = new Date().toISOString().slice(0, 10)
    const result = renderArtefact('filename-today-demo', 'offer', { dryRun: true, instancesDir, definitionsDir })
    assert.equal(result.basename, `Jane Smith - ${today}`)
  })
})

// --- Validation (definition publish time, not render time) ---

function structureWithArtefactFilename(filename, requires = STRUCTURE.artefacts[0].requires) {
  return {
    ...STRUCTURE,
    artefacts: [{ ...STRUCTURE.artefacts[0], requires, filename }, STRUCTURE.artefacts[1]],
  }
}

test('a filename: token naming no field or built-in is rejected — server and Local Workspace twin', () => {
  const structure = structureWithArtefactFilename('{candidate.nickname} - Offer')
  const problems = findDefinitionProblemsInStructure(structure)
  assert.ok(problems.some((p) => p.type === 'filename-unknown-token'), JSON.stringify(problems))

  const localProblems = findLocalDefinitionProblems(structure)
  assert.ok(localProblems.some((p) => p.type === 'filename-unknown-token'), JSON.stringify(localProblems))
})

test('a filename: token naming an unknown module is rejected', () => {
  const structure = structureWithArtefactFilename('{nosuch.field} - Offer')
  const problems = findDefinitionProblemsInStructure(structure)
  assert.ok(problems.some((p) => p.type === 'filename-unknown-token'), JSON.stringify(problems))
})

test('a filename: token naming a markdown or list field is rejected, not truncated', () => {
  const markdownProblems = findDefinitionProblemsInStructure(
    structureWithArtefactFilename('{candidate.notes} - Offer', ['candidate.name', 'candidate.start-date', 'candidate.notes'])
  )
  assert.ok(markdownProblems.some((p) => p.type === 'filename-invalid-field-type' && /"markdown"/.test(p.message)), JSON.stringify(markdownProblems))

  const listProblems = findDefinitionProblemsInStructure(
    structureWithArtefactFilename('{candidate.tags} - Offer', ['candidate.name', 'candidate.start-date', 'candidate.tags'])
  )
  assert.ok(listProblems.some((p) => p.type === 'filename-invalid-field-type' && /"list"/.test(p.message)), JSON.stringify(listProblems))
})

test('a filename: token naming a multiple: true select field is rejected — it stores more than one string', () => {
  const problems = findDefinitionProblemsInStructure(
    structureWithArtefactFilename('{candidate.level} - Offer', ['candidate.name', 'candidate.start-date', 'candidate.level'])
  )
  assert.ok(
    problems.some((p) => p.type === 'filename-invalid-field-type' && /multiple: true/.test(p.message)),
    JSON.stringify(problems)
  )
})

test('a filename: token naming a field absent from the artefact\'s own requires list is rejected', () => {
  const structure = structureWithArtefactFilename('{candidate.name} - Offer - {candidate.start-date}', ['candidate.name'])
  const problems = findDefinitionProblemsInStructure(structure)
  assert.ok(problems.some((p) => p.type === 'filename-field-not-required'), JSON.stringify(problems))

  const localProblems = findLocalDefinitionProblems(structure)
  assert.ok(localProblems.some((p) => p.type === 'filename-field-not-required'), JSON.stringify(localProblems))
})

test('a whole-module requirement (no field suffix) already puts every one of its fields in scope for filename:', () => {
  const structure = structureWithArtefactFilename('{candidate.name} - Offer - {candidate.start-date}', ['candidate'])
  const problems = findDefinitionProblemsInStructure(structure)
  assert.deepEqual(problems.filter((p) => p.type.startsWith('filename-')), [])
})

test('a select/text/date field that IS in requires is accepted', () => {
  const structure = structureWithArtefactFilename('{candidate.name} - Offer', ['candidate.name', 'candidate.start-date'])
  const problems = findDefinitionProblemsInStructure(structure)
  assert.deepEqual(problems.filter((p) => p.type.startsWith('filename-')), [])
})
