import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadDefinition,
  findDefinitionProblems,
  findDefinitionProblemsInStructure,
  writeDefinitionVersion,
  publishDefinitionVersion,
  createDraftVersion,
  cloneDefinition,
  definitionVersionProjection,
} from '../lib/definition.js'
import { planCopy, applyPlan } from '../lib/copyPlanner.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { interviewInstructionsProblems, stackedInterviewInstructions, interviewText, hasInterviewText } from '../web/lib/interviewInstructions.js'

// (A `null` option below means "write no such key"; `undefined` takes the default text.)
// #282 (ADR-0062): Interview instructions — an optional `interview:` text key on the Definition, a
// Stage and a Module. The validator accepts them at all three levels and rejects what isn't text; a
// draft's Save writes them (and drops blank ones); a published version keeps them fixed; creating a
// draft, cloning, copying a Stage or Module and the Library cache carry them. The round trip across
// every Provider's loader is pinned in tests/definitionKeyRoundTrip.test.js, the Definitions page
// itself in tests/interviewInstructions.playwright.test.js.

function definitionYaml(id, { interview = 'Ask who the sponsor is first.', stageInterview = 'Probe integrations.', status = 'draft', version = 1 } = {}) {
  return `id: ${id}
version: ${version}
status: ${status}
title: Interview
description: Has Interview instructions
${interview === null ? '' : `interview: ${JSON.stringify(interview)}\n`}stages:
  - id: first
    title: First
    purpose: The first stage
    gate: first-gate
${stageInterview === null ? '' : `    interview: ${JSON.stringify(stageInterview)}\n`}    modules:
      - details
artefacts:
  - id: brief
    title: Brief
    purpose: The brief
    template: templates/brief.md.tmpl
    gate: first-gate
    requires:
      - details
`
}

function moduleYaml({ interview = 'Spell authorisation with an s.' } = {}) {
  return `id: details
title: Details
purpose: What it is
${interview === null ? '' : `interview: ${JSON.stringify(interview)}\n`}fields:
  - id: kind
    title: Kind
    type: text
    required: true
`
}

function withDefinition(id, options, fn) {
  const root = mkdtempSync(join(tmpdir(), 'defs-282-'))
  const definitionsDir = join(root, 'definitions')
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, options))
  writeFileSync(join(dir, 'modules', 'details.yaml'), moduleYaml(options))
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# {{title}}\n')
  try {
    return fn({ definitionsDir, dir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the validator', () => {
  test('accepts interview at the Definition, Stage and Module levels', () => {
    withDefinition('ok', {}, ({ definitionsDir }) => {
      assert.deepEqual(findDefinitionProblems('ok', { definitionsDir, version: 1 }), [])
      const def = loadDefinition('ok', { definitionsDir, version: 1 })
      assert.equal(def.interview, 'Ask who the sponsor is first.')
      assert.equal(def.stages[0].interview, 'Probe integrations.')
      assert.equal(def.modules.get('details').interview, 'Spell authorisation with an s.')
    })
  })

  test('a Definition without any carries no interview keys at all', () => {
    withDefinition('none', { interview: null, stageInterview: null }, ({ definitionsDir }) => {
      const def = loadDefinition('none', { definitionsDir, version: 1 })
      assert.equal('interview' in def, false)
      assert.equal('interview' in def.stages[0], false)
      const projection = definitionVersionProjection(def)
      assert.equal('interview' in projection, false)
      assert.equal('interview' in projection.stages[0], false)
    })
  })

  test('text at each level is accepted, blank text too (it means none)', () => {
    assert.deepEqual(interviewInstructionsProblems({ interview: 'a', stages: [{ id: 's', interview: '' }], modules: [{ id: 'm', interview: '  ' }] }), [])
    assert.deepEqual(interviewInstructionsProblems({}), [])
  })

  test('anything that is not text is reported at each level, naming the element', () => {
    const problems = interviewInstructionsProblems({
      interview: ['a'],
      stages: [{ id: 'first', interview: 5 }],
      modules: [{ id: 'details', interview: { a: 1 } }],
    })
    assert.deepEqual(problems.map((p) => p.type), ['invalid-interview', 'invalid-interview', 'invalid-interview'])
    assert.match(problems[0].message, /^Interview instructions on the Definition/)
    assert.match(problems[1].message, /^Stage "first" sets "interview"/)
    assert.match(problems[2].message, /^Module "details" sets "interview"/)
  })

  test('findDefinitionProblems (disk) and findDefinitionProblemsInStructure (a draft) both report a bad one', () => {
    withDefinition('bad', {}, ({ definitionsDir, dir }) => {
      writeFileSync(join(dir, 'definition.yaml'), definitionYaml('bad', {}).replace('interview: "Ask who the sponsor is first."', 'interview: 7').replace('interview: "Probe integrations."', 'interview:\n      - one'))
      writeFileSync(join(dir, 'modules', 'details.yaml'), moduleYaml().replace('interview: "Spell authorisation with an s."', 'interview: true'))
      const problems = findDefinitionProblems('bad', { definitionsDir, version: 1 }).filter((p) => p.type === 'invalid-interview')
      assert.equal(problems.length, 3)

      const structure = definitionVersionProjection(loadDefinition('bad', { definitionsDir, version: 1 }))
      assert.deepEqual(
        findDefinitionProblemsInStructure(structure).filter((p) => p.type === 'invalid-interview').map((p) => p.message),
        problems.map((p) => p.message)
      )
    })
  })

  test('a malformed one never stops the Definition loading (authoring-time only)', () => {
    withDefinition('loads', {}, ({ definitionsDir, dir }) => {
      writeFileSync(join(dir, 'definition.yaml'), definitionYaml('loads', {}).replace('interview: "Probe integrations."', 'interview: 5'))
      const def = loadDefinition('loads', { definitionsDir, version: 1 })
      assert.equal(def.stages[0].interview, 5)
      assert.equal(interviewText(def.stages[0].interview), '')
    })
  })

  test('a Local Workspace reports the same problems', () => {
    const problems = findLocalDefinitionProblems({
      id: 'd',
      interview: 3,
      stages: [{ id: 'first', gate: 'g', modules: ['details'], interview: 4 }],
      artefacts: [],
      modules: [{ id: 'details', fields: [], interview: 5 }],
    }).filter((p) => p.type === 'invalid-interview')
    assert.equal(problems.length, 3)
  })
})

describe('saving, publishing and copying', () => {
  test('Save on a draft writes all three levels and drops cleared ones', () => {
    withDefinition('save', { interview: null, stageInterview: null }, ({ definitionsDir, dir }) => {
      writeFileSync(join(dir, 'modules', 'details.yaml'), moduleYaml({ interview: null }))
      const structure = definitionVersionProjection(loadDefinition('save', { definitionsDir, version: 1 }))
      structure.interview = 'Definition wide.'
      structure.stages[0].interview = 'Stage wide.'
      structure.modules[0].interview = 'Module wide.'
      const saved = writeDefinitionVersion('save', 1, structure, { definitionsDir })
      assert.equal(saved.problems, undefined)
      const written = loadDefinition('save', { definitionsDir, version: 1 })
      assert.equal(written.interview, 'Definition wide.')
      assert.equal(written.stages[0].interview, 'Stage wide.')
      assert.equal(written.modules.get('details').interview, 'Module wide.')

      // Clearing each box leaves no key behind.
      structure.interview = ''
      structure.stages[0].interview = '   '
      delete structure.modules[0].interview
      writeDefinitionVersion('save', 1, structure, { definitionsDir })
      assert.doesNotMatch(readFileSync(join(dir, 'definition.yaml'), 'utf8'), /interview/)
      assert.doesNotMatch(readFileSync(join(dir, 'modules', 'details.yaml'), 'utf8'), /interview/)
    })
  })

  test('a Save that does not mention the Definition-level key keeps what is on disk (an MCP update_definition)', () => {
    withDefinition('keep', {}, ({ definitionsDir }) => {
      const structure = definitionVersionProjection(loadDefinition('keep', { definitionsDir, version: 1 }))
      delete structure.interview
      writeDefinitionVersion('keep', 1, structure, { definitionsDir })
      assert.equal(loadDefinition('keep', { definitionsDir, version: 1 }).interview, 'Ask who the sponsor is first.')
    })
  })

  test('Save refuses an Interview instructions value that is not text', () => {
    withDefinition('refuse', {}, ({ definitionsDir }) => {
      const structure = definitionVersionProjection(loadDefinition('refuse', { definitionsDir, version: 1 }))
      structure.stages[0].interview = 12
      const result = writeDefinitionVersion('refuse', 1, structure, { definitionsDir })
      assert.equal(result.problems.some((p) => p.type === 'invalid-interview'), true)
    })
  })

  test('publishing keeps them, and a published version cannot be edited', () => {
    withDefinition('pub', {}, ({ definitionsDir }) => {
      publishDefinitionVersion('pub', 1, { definitionsDir })
      const def = loadDefinition('pub', { definitionsDir, version: 1 })
      assert.equal(def.status, 'published')
      assert.equal(def.interview, 'Ask who the sponsor is first.')
      assert.equal(def.stages[0].interview, 'Probe integrations.')
      assert.equal(def.modules.get('details').interview, 'Spell authorisation with an s.')
      const structure = definitionVersionProjection(def)
      structure.interview = 'Changed after publishing.'
      assert.throws(() => writeDefinitionVersion('pub', 1, structure, { definitionsDir }), /not a draft/)
      assert.equal(loadDefinition('pub', { definitionsDir, version: 1 }).interview, 'Ask who the sponsor is first.')
    })
  })

  test('a new draft version and a clone carry them', () => {
    withDefinition('src', {}, ({ definitionsDir }) => {
      publishDefinitionVersion('src', 1, { definitionsDir })
      createDraftVersion('src', { definitionsDir })
      const draft = loadDefinition('src', { definitionsDir, version: 2 })
      assert.equal(draft.interview, 'Ask who the sponsor is first.')
      assert.equal(draft.stages[0].interview, 'Probe integrations.')
      assert.equal(draft.modules.get('details').interview, 'Spell authorisation with an s.')

      cloneDefinition('src', 'copy', { definitionsDir })
      const copy = loadDefinition('copy', { definitionsDir, version: 1 })
      assert.equal(copy.interview, 'Ask who the sponsor is first.')
      assert.equal(copy.stages[0].interview, 'Probe integrations.')
      assert.equal(copy.modules.get('details').interview, 'Spell authorisation with an s.')
    })
  })

  test('copying a Stage or a Module from another Definition brings its Interview instructions', () => {
    const source = {
      id: 'src',
      version: 1,
      interview: 'Not copied: it belongs to the source Definition.',
      stages: [{ id: 'first', title: 'First', gate: 'g', modules: ['details'], interview: 'Probe integrations.' }],
      artefacts: [],
      modules: [{ id: 'details', title: 'Details', interview: 'Spell authorisation with an s.', fields: [{ id: 'kind', title: 'Kind', type: 'text' }] }],
    }
    const target = { id: 'dst', version: 1, stages: [], artefacts: [], modules: [] }
    const plan = planCopy(target, source, { kind: 'stage', id: 'first' })
    const { target: next } = applyPlan(target, source, plan)
    assert.equal(next.stages[0].interview, 'Probe integrations.')
    assert.equal(next.modules[0].interview, 'Spell authorisation with an s.')
    assert.equal('interview' in next, false)
  })
})

describe('stacking', () => {
  const definition = {
    interview: 'D',
    stages: [{ id: 's1', interview: 'S' }, { id: 's2' }],
    modules: new Map([['m1', { id: 'm1', interview: 'M' }], ['m2', { id: 'm2', interview: '   ' }]]),
  }

  test('stack broad to narrow: Definition, Stage, Module', () => {
    assert.deepEqual(stackedInterviewInstructions(definition, { stageId: 's1', moduleId: 'm1' }), [
      { level: 'definition', text: 'D' },
      { level: 'stage', id: 's1', text: 'S' },
      { level: 'module', id: 'm1', text: 'M' },
    ])
  })

  test('levels with nothing to say are left out, and a projection (modules as an array) reads the same', () => {
    assert.deepEqual(stackedInterviewInstructions(definition, { stageId: 's2', moduleId: 'm2' }), [{ level: 'definition', text: 'D' }])
    const projection = { ...definition, modules: [...definition.modules.values()] }
    assert.deepEqual(stackedInterviewInstructions(projection, { stageId: 's1', moduleId: 'm1' }).map((entry) => entry.level), ['definition', 'stage', 'module'])
    assert.deepEqual(stackedInterviewInstructions({}), [])
  })

  test('hasInterviewText is false only for absent or blank text', () => {
    assert.equal(hasInterviewText(undefined), false)
    assert.equal(hasInterviewText(' \n'), false)
    assert.equal(hasInterviewText('x'), true)
    assert.equal(hasInterviewText(5), true)
  })
})
