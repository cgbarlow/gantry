import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, readInstance, readModule, writeModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { STANDARD_MODULES } from '../web/lib/standardModules.js'

// #309 (v0.13.0, #258): recruitment-onboarding v4 is published. It is v3 plus the Glossary and Open
// questions standard modules (ADR-0065) and its own Interview instructions (ADR-0062), and the
// bundled platform-engineer example moves to it. v3's behaviour is pinned in
// tests/recruitmentOnboardingV3.test.js, which still runs against its own fixture.

const VERSION = 4
const SLUG = 'platform-engineer'
const FIXTURE = 'tests/fixtures/recruitment-onboarding-v4'
const EXAMPLES = 'workspaces/examples'
const GATES = ['approved-to-recruit', 'candidate-selected', 'approved-to-appoint', 'onboarding-approved', 'ready-to-start']
const v4 = () => loadDefinition('recruitment-onboarding', { version: VERSION })

test('v4 validates in both validators and is published, and the earlier versions stay published', () => {
  assert.equal(v4().status, 'published')
  for (const version of [1, 2, 3]) assert.equal(loadDefinition('recruitment-onboarding', { version }).status, 'published', `v${version}`)
  assert.deepEqual(findDefinitionProblems('recruitment-onboarding', { version: VERSION }), [])
  assert.deepEqual(findLocalDefinitionProblems(definitionVersionProjection(v4())), [])
})

test('v4 has the same Stages, Gates and Artefacts as v3', () => {
  const v3 = loadDefinition('recruitment-onboarding', { version: 3 })
  const shape = (def) => def.stages.map((s) => [s.id, s.gate, s.readOnlyModules ?? []])
  assert.deepEqual(shape(v4()), shape(v3))
  assert.deepEqual(v4().artefacts.map((a) => a.id), v3.artefacts.map((a) => a.id))
})

test('v4 mounts Glossary and Open questions (version 1) on every Stage, and not Key decisions', () => {
  const def = v4()
  assert.deepEqual(def.standardModules.map((m) => [m.id, m.version]), [['glossary', 1], ['open-questions', 1]])
  for (const id of ['glossary', 'open-questions']) {
    assert.deepEqual(def.modules.get(id).standard, { version: 1 }, id)
    // the shape is Gantry's, not the Definition's
    assert.deepEqual(def.modules.get(id).fields.map((f) => f.id), STANDARD_MODULES[id].versions[1].fields.map((f) => f.id))
  }
  assert.equal(def.modules.has('key-decisions'), false)
  for (const stage of def.stages) {
    for (const id of ['glossary', 'open-questions', 'process-gaps']) assert.ok(stage.modules.includes(id), `${stage.id} lists ${id}`)
  }
})

test("Process gaps moved to a Module of its own, since Open questions' shape is Gantry's", () => {
  const def = v4()
  assert.deepEqual(def.modules.get('process-gaps').fields.map((f) => f.id), ['gaps'])
  assert.equal(def.modules.get('open-questions').fields.some((f) => f.id === 'process-gaps'), false)
  for (const artefact of def.artefacts) {
    assert.equal(artefact.requires.some((r) => r.startsWith('open-questions.process-gaps')), false, artefact.id)
  }
  assert.ok(def.artefacts.find((a) => a.id === 'hire-record').requires.includes('process-gaps.gaps?'))
})

test('v4 carries its own Interview instructions at the Definition, Stage and Module levels', () => {
  const def = v4()
  assert.match(def.interview, /HR personal data/)
  assert.match(def.stages.find((s) => s.id === 'selection').interview, /vetting/i)
  assert.match(def.modules.get('glossary').interview, /Glossary row/)
  assert.match(def.modules.get('process-gaps').interview, /process/i)
})

test('older versions still carry no standard modules or Interview instructions', () => {
  for (const version of [1, 2, 3]) {
    const def = loadDefinition('recruitment-onboarding', { version })
    assert.equal(def.standardModules, undefined, `v${version}`)
    assert.equal(def.interview, undefined, `v${version}`)
    assert.ok(def.modules.get('open-questions').fields.some((f) => f.id === 'questions' && f.type === 'list'), `v${version} keeps its own open-questions`)
  }
})

test('the bundled platform-engineer example is on v4, identical to the fixture, and passes every Gate', () => {
  assert.equal(readInstance(SLUG, { instancesDir: EXAMPLES }).definitionVersion, VERSION)
  assert.equal(readInstance(SLUG, { instancesDir: FIXTURE }).definitionVersion, VERSION)
  const modules = readdirSync(join(FIXTURE, SLUG, 'modules'))
  assert.deepEqual(readdirSync(join(EXAMPLES, SLUG, 'modules')).sort(), [...modules].sort())
  for (const file of ['instance.yaml', ...modules.map((m) => join('modules', m))]) {
    assert.equal(readFileSync(join(EXAMPLES, SLUG, file), 'utf8'), readFileSync(join(FIXTURE, SLUG, file), 'utf8'), file)
  }
  for (const gate of GATES) assert.equal(checkGate(SLUG, { instancesDir: EXAMPLES, gate }).pass, true, gate)
})

test('the example has its Glossary, Open questions and Process gaps filled in as the standard shapes', () => {
  const def = v4()
  const glossary = readModule(def, SLUG, 'glossary', { instancesDir: EXAMPLES })
  assert.match(glossary.fields.terms, /^\| Preferred term \| Definition \| Avoid \|/)
  const questions = readModule(def, SLUG, 'open-questions', { instancesDir: EXAMPLES })
  assert.match(questions.fields.questions, /^\| Question \| Who resolves \| By when \| Status \|/)
  assert.match(readModule(def, SLUG, 'process-gaps', { instancesDir: EXAMPLES }).fields.gaps, /payroll request/)
})

test('every Artefact renders cleanly from the example, with Open questions as a table', () => {
  for (const artefact of v4().artefacts) {
    const { markdown } = renderArtefact(SLUG, artefact.id, { instancesDir: EXAMPLES, dryRun: true })
    assert.ok(markdown.length > 100, artefact.id)
    assert.doesNotMatch(markdown, /undefined|\[object Object\]/, artefact.id)
    if (/# Open questions/.test(markdown)) assert.match(markdown, /\| Question \| Who resolves \| By when \| Status \|/, artefact.id)
  }
})

test('the Hire Record closes with Questions still open, Process gaps and the Glossary', () => {
  const { markdown } = renderArtefact(SLUG, 'hire-record', { instancesDir: EXAMPLES, dryRun: true })
  const at = (heading) => markdown.indexOf(heading)
  assert.ok(at('# Questions still open at sign-off') > 0)
  assert.ok(at('## Process gaps') > at('## Questions'))
  assert.ok(at('# Glossary') > at('## Process gaps'))
  assert.match(markdown, /\| Approved to Recruit \|/)
})

test('an Instance with empty Glossary, Open questions and Process gaps still passes, and prints none of them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-ro-v4-'))
  try {
    cpSync(join(FIXTURE, SLUG), join(dir, SLUG), { recursive: true })
    const def = v4()
    for (const id of ['glossary', 'open-questions', 'process-gaps']) writeModule(def, SLUG, id, { status: 'draft', owner: '', fields: {} }, { instancesDir: dir })
    assert.equal(checkGate(SLUG, { instancesDir: dir, gate: 'ready-to-start' }).pass, true)
    const { markdown } = renderArtefact(SLUG, 'hire-record', { instancesDir: dir, dryRun: true })
    assert.doesNotMatch(markdown, /# Glossary|Questions still open|## Process gaps/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Gate arithmetic is unchanged from v3: the same Fields are bare, so a blank Instance owes each
// Artefact the same number of them. (The standard modules' Fields are all optional `?` entries.)
test('a blank v4 Instance owes every Artefact the same bare Fields as a blank v3 one', () => {
  const owed = (version) => {
    const dir = mkdtempSync(join(tmpdir(), `gantry-ro-v${version}-blank-`))
    try {
      createInstance('recruitment-onboarding', 'blank', { instancesDir: dir, version })
      const def = loadDefinition('recruitment-onboarding', { version })
      for (const id of def.modules.keys()) writeModule(def, 'blank', id, { status: 'draft', owner: '', fields: {} }, { instancesDir: dir })
      return GATES.flatMap((gate) => checkGate('blank', { instancesDir: dir, gate }).artefacts.map((a) => [gate, a.id, a.outstanding.length]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.deepEqual(owed(4), owed(3))
})

