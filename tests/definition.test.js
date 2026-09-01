import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, splitArtefactRequirement } from '../lib/definition.js'

test('loads the real design definition', () => {
  const design = loadDefinition('design')

  assert.equal(design.id, 'design')
  assert.equal(design.stages.length, 4)

  const shape = design.stages.find((stage) => stage.id === 'shape')
  assert.match(shape.purpose, /business case/i)
  assert.deepEqual(shape.modules, ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction'])
  assert.equal(shape.example, 'examples')

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
