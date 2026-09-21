import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, splitArtefactRequirement, findDefinitionProblems, writeDefinitionVersion, definitionVersionProjection } from '../lib/definition.js'

test('loads the real design definition', () => {
  // Pinned to v1 explicitly (WI #318 published v2 alongside it, so an unpinned
  // load no longer resolves here — this test is about v1's specific shape).
  const design = loadDefinition('design', { version: 1 })

  assert.equal(design.id, 'design')
  assert.equal(design.stages.length, 4)

  const shape = design.stages.find((stage) => stage.id === 'shape')
  assert.match(shape.purpose, /business case/i)
  assert.deepEqual(shape.modules, ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction'])
  // WI #348: the `examples` fixture moved to v2, so v1 no longer declares it as a stage example.
  assert.equal(shape.example, undefined)

  const soap = design.artefacts.find((artefact) => artefact.id === 'soap')
  assert.match(soap.purpose, /summarise/i)
  // WI #276: field-level list of exactly what soap.md.tmpl renders. WI #280
  // merges context -> background, moves scope to introduction, and promotes
  // solution-definition.high-level-requirements to a bare gated entry.
  assert.deepEqual(soap.requires, [
    'background.problem',
    'background.affected-domains',
    'introduction.in-scope',
    'introduction.out-of-scope',
    'solution-definition.process-flow',
    'solution-definition.high-level-solution-overview',
    'solution-definition.high-level-requirements',
    'solution-definition.feature-breakdown',
    'team-and-estimates.teams-required',
    'team-and-estimates.estimates',
    'team-and-estimates.references?',
  ])
  assert.ok(!soap.requires.includes('context.opportunity'))
  assert.ok(!soap.requires.includes('context.in-scope'))

  const soapFull = design.artefacts.find((artefact) => artefact.id === 'soap-full')
  assert.equal(soapFull.template, 'templates/soap-full.md.tmpl')
  assert.ok(soapFull.requires.includes('background.opportunity'))
  assert.ok(soapFull.requires.includes('solution-definition.high-level-requirements'))
  assert.ok(soapFull.requires.includes('solution-definition.alternatives-sketch?'))
  assert.ok(soapFull.requires.includes('soap-full-details.sequencing'))

  const sad = design.artefacts.find((artefact) => artefact.id === 'sad')
  const ssad = design.artefacts.find((artefact) => artefact.id === 'ssad')
  assert.notDeepEqual(sad.requires, ssad.requires)
  assert.ok(sad.requires.includes('architecture.design-decisions'))
  assert.ok(sad.requires.includes('support-and-operations.support-handover-readiness'))
  assert.ok(ssad.requires.includes('support-and-operations.monitoring-and-alerting'))
  assert.ok(ssad.requires.includes('nfrs.availability-and-continuity'))
  assert.ok(!ssad.requires.includes('architecture.design-decisions'))

  const background = design.modules.get('background')
  assert.equal(background.title, 'Background and context')
  const problem = background.fields.find((field) => field.id === 'problem')
  assert.equal(problem.type, 'markdown')
  assert.deepEqual(problem.requiredAt, ['business-case', 'hld-tac-approved'])

  // dependencies uses required-at, not required, at the field level
  const dependencies = design.modules.get('dependencies')
  const overview = dependencies.fields.find((field) => field.id === 'dependencies-overview')
  assert.deepEqual(overview.requiredAt, ['business-case', 'hld-tac-approved'])

  assert.ok(design.stages.every((stage) => stage.purpose))
  assert.ok(design.artefacts.every((artefact) => artefact.purpose))
})

test('splitArtefactRequirement parses whole modules, field refs and the optional `?` suffix', () => {
  assert.deepEqual(splitArtefactRequirement('context'), { moduleId: 'context', fieldId: undefined, optional: false })
  assert.deepEqual(splitArtefactRequirement('context.driver'), { moduleId: 'context', fieldId: 'driver', optional: false })
  assert.deepEqual(splitArtefactRequirement('context.out-of-scope?'), { moduleId: 'context', fieldId: 'out-of-scope', optional: true })
  // `?` on a whole module still parses (validation rejects it separately)
  assert.deepEqual(splitArtefactRequirement('context?'), { moduleId: 'context', fieldId: undefined, optional: true })
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

// #81 (ADR-0044): type: select — a closed-set dropdown field.
test('loads a select field with options', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'has-select')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: has-select\ntitle: Has Select\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [engagement]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'engagement.yaml'),
      'id: engagement\ntitle: Engagement\nfields:\n  - id: type\n    title: Type\n    type: select\n    options:\n      - Permanent\n      - Fixed term\n'
    )

    const def = loadDefinition('has-select', { definitionsDir: join(root, 'definitions') })
    const field = def.modules.get('engagement').fields.find((f) => f.id === 'type')
    assert.equal(field.type, 'select')
    assert.deepEqual(field.options, ['Permanent', 'Fixed term'])
  })
})

test('fails loudly when a select field declares no options', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'select-no-options')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: select-no-options\ntitle: Select No Options\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [engagement]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'engagement.yaml'),
      'id: engagement\ntitle: Engagement\nfields:\n  - id: type\n    title: Type\n    type: select\n'
    )

    assert.throws(
      () => loadDefinition('select-no-options', { definitionsDir: join(root, 'definitions') }),
      /declares no "options:" list/
    )
  })
})

test('findDefinitionProblems reports a select field with no options rather than throwing', () => {
  withScratchDefinition((root) => {
    const defDir = join(root, 'definitions', 'select-no-options-report')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: select-no-options-report\ntitle: X\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [engagement]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'engagement.yaml'),
      'id: engagement\ntitle: Engagement\nfields:\n  - id: type\n    title: Type\n    type: select\n'
    )

    const problems = findDefinitionProblems('select-no-options-report', { definitionsDir: join(root, 'definitions') })
    assert.ok(problems.some((p) => p.type === 'select-missing-options'))
  })
})

test('a write-then-read round trip through writeDefinitionVersion preserves a select field\'s options (ADR-0044 §7 — the writer\'s fixed key whitelist)', () => {
  withScratchDefinition((root) => {
    const definitionsDir = join(root, 'definitions')
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let yamlText = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    yamlText = yamlText.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), yamlText)

    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const projection = definitionVersionProjection(def)
    const background = projection.modules.find((m) => m.id === 'background')
    background.fields.push({ id: 'engagement-type', title: 'Engagement type', type: 'select', options: ['Permanent', 'Fixed term', 'Contractor'] })

    const result = writeDefinitionVersion('design', 2, projection, { definitionsDir })
    assert.equal(result.problems, undefined)

    // Re-load from disk — this is the round trip: a save that went through buildModuleYamlObject's
    // fixed key whitelist and back through loadModuleSpec must not have dropped "options:".
    const reloaded = loadDefinition('design', { definitionsDir, version: 2 })
    const field = reloaded.modules.get('background').fields.find((f) => f.id === 'engagement-type')
    assert.equal(field.type, 'select')
    assert.deepEqual(field.options, ['Permanent', 'Fixed term', 'Contractor'])
  })
})
