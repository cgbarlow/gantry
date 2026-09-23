import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, writeModule, readModule, readInstance } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'

// #153 (spec #147): the harness every recruitment-onboarding v3 ticket extends. `definitions/
// recruitment-onboarding/3` starts as a draft copy of v2, and tests/fixtures/recruitment-
// onboarding-v3/platform-engineer is a copy of the platform-engineer worked hire
// (workspaces/examples/platform-engineer, still pinned to v2) migrated to v3 and pinned to the v3
// draft. The example itself is not repointed — migrating it is a process-owner step once v3 is
// published.
//
// The harness runs the gate check at every Gate and dry-run renders every Artefact against that
// fixture. Two tables drive it, so a later ticket changes a row rather than adding a test:
//   - GATES: which Artefacts satisfy each Gate, and every Artefact's bar there — the number of
//     bare Fields a blank Instance has outstanding against it (the spec's "Gate arithmetic").
//     `satisfiedBy` is checked by behaviour: completing only one Artefact's Fields on a blank
//     Instance passes the Gate exactly when that Artefact is listed.
//   - DOCUMENTS: each Artefact's rendered filename and outline — headings it must and must not have.
// A ticket that changes the Definition migrates the fixture alongside it, so every Gate still
// passes on the worked hire.

const VERSION = 3
const FIXTURE = 'tests/fixtures/recruitment-onboarding-v3'
const SLUG = 'platform-engineer'

// While v3 is a copy of v2, these are v2's bars, and every Artefact at a Gate satisfies it: the
// Gate passes when any one of `satisfiedBy` is complete (ADR-0019).
const GATES = [
  { gate: 'approved-to-recruit', satisfiedBy: ['requisition-brief'], bars: { 'requisition-brief': 9 } },
  { gate: 'candidate-selected', satisfiedBy: ['selection-report'], bars: { 'selection-report': 10 } },
  {
    gate: 'onboarding-approved',
    satisfiedBy: ['appointment-case', 'offer-pack'],
    bars: { 'appointment-case': 14, 'offer-pack': 13 },
  },
  {
    gate: 'ready-to-start',
    satisfiedBy: ['starter-readiness', 'manager-handover', 'hire-record'],
    bars: { 'starter-readiness': 13, 'manager-handover': 14, 'hire-record': 36 },
  },
]

const today = new Date().toISOString().slice(0, 10)

// Every document carries the Document Control and Review & sign-off tables until the audience
// documents opt out of them.
const CONTROL = ['## Document Control', '## Review & sign-off']

const DOCUMENTS = {
  'requisition-brief': {
    basename: 'Platform Engineer - Requisition Brief',
    present: [...CONTROL, '# The role', '# Engagement', '## Approval route', '# Role evaluation', '# Open questions'],
    absent: [],
  },
  'selection-report': {
    basename: 'Platform Engineer - Selection Report',
    present: [...CONTROL, '# Advertising', '# Selection', '## Candidate name', '# Vetting', '## Conditions', '# Open questions'],
    absent: [],
  },
  'appointment-case': {
    basename: 'Marama Clarke - Appointment Case',
    present: [...CONTROL, '# The appointment', '# Offer', '# Contract', '## Signatures', '# Payroll', '# Open questions'],
    absent: [],
  },
  'offer-pack': {
    basename: 'Marama Clarke - Offer Pack - 2026-04-20',
    present: [...CONTROL, '# Your role', '# Your offer', '# Your contract', '# Payroll', '# Open questions'],
    absent: [],
  },
  'starter-readiness': {
    basename: 'Marama Clarke - Starter Readiness - 2026-04-20',
    present: [...CONTROL, '# The starter', '# Identity', '# Device', '# Access', '# Handover', '# Open questions'],
    absent: [],
  },
  'manager-handover': {
    basename: `Marama Clarke - Manager Handover - ${today}`,
    present: [...CONTROL, '# Your new starter', '# What you need to do', '# What is already in place', '# Open questions'],
    absent: [],
  },
  'hire-record': {
    basename: 'Marama Clarke - Hire Record',
    present: [...CONTROL, '# Requisition', '# Selection', '# Appointment', '# Provisioning', '# Open questions and process gaps'],
    absent: [],
  },
}

function headings(markdown) {
  return new Set(markdown.split('\n').filter((line) => line.startsWith('#')))
}

// A v3 Instance whose every module file exists but holds no Fields, so each Artefact's bar is
// exactly its bare Fields.
function writeBlankInstance(instancesDir) {
  createInstance('recruitment-onboarding', 'blank', { instancesDir, version: VERSION })
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  for (const moduleId of def.modules.keys()) {
    writeModule(def, 'blank', moduleId, { status: 'draft', owner: '', fields: {} }, { instancesDir })
  }
  return def
}

function withInstancesDir(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-ro-v3-'))
  try {
    return fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('recruitment-onboarding/3 is a draft, and v2 stays published', () => {
  assert.equal(loadDefinition('recruitment-onboarding', { version: 3 }).status, 'draft')
  assert.equal(loadDefinition('recruitment-onboarding', { version: 2 }).status, 'published')
})

test('findDefinitionProblems reports zero problems for recruitment-onboarding/3', () => {
  assert.deepEqual(findDefinitionProblems('recruitment-onboarding', { version: VERSION }), [])
})

test('findLocalDefinitionProblems (Local Workspace twin) also reports zero problems for v3', () => {
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  assert.deepEqual(findLocalDefinitionProblems(definitionVersionProjection(def)), [])
})

test('v3 tells a deployment that its Instances hold HR personal data', () => {
  const { description } = loadDefinition('recruitment-onboarding', { version: VERSION })
  assert.match(description, /HR personal data/)
  assert.match(description, /HR-file access and retention controls/)
})

test('the harness pins the worked hire to v3 and covers every v3 Gate and Artefact', () => {
  assert.equal(readInstance(SLUG, { instancesDir: FIXTURE }).definitionVersion, VERSION)
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  assert.deepEqual(GATES.map((g) => g.gate), def.stages.map((s) => s.gate))
  assert.deepEqual(Object.keys(DOCUMENTS).sort(), def.artefacts.map((a) => a.id).sort())
})

for (const { gate, satisfiedBy, bars } of GATES) {
  test(`the worked hire, pinned to v3, passes ${gate}`, () => {
    const result = checkGate(SLUG, { instancesDir: FIXTURE, gate })
    assert.equal(result.definition, 'recruitment-onboarding')
    assert.equal(result.pass, true)
    for (const id of satisfiedBy) {
      const artefact = result.artefacts.find((a) => a.id === id)
      assert.ok(artefact, `${id} is checked at ${gate}`)
      assert.deepEqual(artefact.outstanding, [], `${id} is complete`)
    }
  })

  test(`${gate}'s bars: the bare Fields a blank Instance still owes each Artefact there`, () => {
    withInstancesDir((instancesDir) => {
      writeBlankInstance(instancesDir)
      const result = checkGate('blank', { instancesDir, gate })
      assert.equal(result.pass, false)
      assert.deepEqual(Object.fromEntries(result.artefacts.map((a) => [a.id, a.outstanding.length])), bars)
    })
  })

  for (const id of Object.keys(bars)) {
    const satisfies = satisfiedBy.includes(id)
    test(`completing only ${id} on a blank Instance ${satisfies ? 'passes' : 'does not pass'} ${gate}`, () => {
      withInstancesDir((instancesDir) => {
        const def = writeBlankInstance(instancesDir)
        const owed = checkGate('blank', { instancesDir, gate }).artefacts.find((a) => a.id === id).outstanding
        // Copy just the Fields this Artefact still owes from the worked hire into the blank Instance.
        const byModule = Map.groupBy(owed, (reference) => reference.split('.')[0])
        for (const [moduleId, references] of byModule) {
          const worked = readModule(def, SLUG, moduleId, { instancesDir: FIXTURE })
          const fields = Object.fromEntries(
            references.map((reference) => reference.split('.')[1]).map((fieldId) => [fieldId, worked.fields[fieldId]])
          )
          writeModule(def, 'blank', moduleId, { status: 'draft', owner: '', fields }, { instancesDir })
        }
        const result = checkGate('blank', { instancesDir, gate })
        assert.equal(result.artefacts.find((a) => a.id === id).complete, true, `${id} is complete`)
        assert.equal(result.pass, satisfies)
      })
    })
  }
}

for (const [id, { basename, present, absent }] of Object.entries(DOCUMENTS)) {
  test(`the worked hire renders the v3 ${id}`, () => {
    const result = renderArtefact(SLUG, id, { instancesDir: FIXTURE, dryRun: true })
    assert.equal(result.basename, basename)
    const outline = headings(result.markdown)
    for (const heading of present) assert.ok(outline.has(heading), `${id} has "${heading}"`)
    for (const heading of absent) assert.ok(!outline.has(heading), `${id} has no "${heading}"`)
  })
}
