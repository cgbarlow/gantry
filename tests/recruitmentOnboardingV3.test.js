import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
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

// Until the audience documents opt out of satisfying their Gate, every Artefact at a Gate
// satisfies it: the Gate passes when any one of `satisfiedBy` is complete (ADR-0019). Bars are
// v2's except where a v3 ticket changes them:
//   - approved-to-recruit: 8, v2's 9 less `engagement.approval-route` (#154).
//   - candidate-selected: 9, v2's 10 less `role.summary`. The Selection Report references it
//     `role.summary?` (#154), and it is required only at approved-to-recruit (#157).
//   - ready-to-start: #157's, with the Hire Record's 37 less `engagement.approval-route` (#154).
const GATES = [
  { gate: 'approved-to-recruit', satisfiedBy: ['requisition-brief'], bars: { 'requisition-brief': 8 } },
  { gate: 'candidate-selected', satisfiedBy: ['selection-report'], bars: { 'selection-report': 9 } },
  // #155: the executive approval, before any offer. The Appointment Case has 4 bare Fields (see
  // BARE below); its bar is 5 because engagement.type, in scope as `?`, is still `required: true`
  // until #159 moves it to its home Gate. role.summary and role.team are required only at
  // approved-to-recruit (#157), so they don't count here.
  { gate: 'approved-to-appoint', satisfiedBy: ['appointment-case'], bars: { 'appointment-case': 5 } },
  // #155: onboarding approval, after the contract is signed and payroll validates, passes through
  // the internal Onboarding Case. Its bar is its 8 bare Fields plus engagement.type (`?`, still
  // `required: true` until #159). #156 replaces the Offer Pack with the Appointment Confirmation,
  // which is `satisfies-gate: false` (its own bar is its 8 bare Fields — every `requires` entry
  // except `engagement.term?`) — the loop below proves it complete on a blank Instance never
  // passes the Gate on its own.
  {
    gate: 'onboarding-approved',
    satisfiedBy: ['onboarding-case'],
    bars: { 'onboarding-case': 9, 'appointment-confirmation': 8 },
  },
  {
    gate: 'ready-to-start',
    satisfiedBy: ['starter-readiness', 'manager-handover', 'hire-record'],
    bars: { 'starter-readiness': 13, 'manager-handover': 13, 'hire-record': 36 },
  },
]

// #157: at ready-to-start, Starter Readiness and the Hire Record owe the same bare Fields from
// the Modules Provisioning writes, so neither is the easier way through the Gate. The spec's
// "13-Field bar" is those 11 plus the two filename tokens.
const PROVISIONING_MODULES = ['identity', 'device', 'access', 'handover']

// The bare Fields — `requires` entries without `?` — of the Artefacts a ticket pins exactly. These
// are what the Gate always asks of that Artefact, whatever the carried Fields' own `required` says.
const BARE = {
  'appointment-case': ['selection.candidate-name', 'selection.rationale', 'vetting.outcome', 'offer.terms'],
  'onboarding-case': [
    'selection.candidate-name',
    'offer.status',
    'contract.terms-summary',
    'contract.manager-signed',
    'contract.candidate-signed',
    'contract.start-date',
    'payroll.details-requested',
    'payroll.confirmed',
  ],
}

const today = new Date().toISOString().slice(0, 10)

// Every document carries the Document Control and Review & sign-off tables until the audience
// documents opt out of them.
const CONTROL = ['## Document Control', '## Review & sign-off']

const DOCUMENTS = {
  'requisition-brief': {
    basename: 'Platform Engineer - Requisition Brief',
    present: [
      ...CONTROL,
      '# The role',
      '# Engagement',
      '## Standard approval route for this engagement type',
      '## Route variation',
      '# Role evaluation',
      '# How the role was evaluated',
      '# Open questions',
    ],
    // The worked hire is Permanent, followed the standard route, and has a delegation on record.
    absent: ['## Approval route', '## Term or expected duration', '## Process gaps'],
  },
  'selection-report': {
    basename: 'Platform Engineer - Selection Report',
    present: [...CONTROL, '# Advertising', '# Selection', '## Candidate name', '# Vetting', '## Conditions', '# Open questions'],
    absent: ['## Process gaps'],
  },
  'appointment-case': {
    basename: 'Marama Clarke - Appointment Case',
    present: [
      ...CONTROL,
      '# The appointment',
      '## Role',
      '## Team and reporting line',
      '## Engagement type',
      '## Candidate name',
      '## Selection rationale',
      '## Vetting outcome',
      '# Proposed terms',
      '## Offer terms',
      '# Open questions',
    ],
    // The offer outcome, contract and payroll moved to the Onboarding Case; the worked hire is
    // Permanent, so the term marker doesn't show.
    absent: ['# Offer', '# Contract', '# Payroll', '## Term or expected duration'],
  },
  'onboarding-case': {
    basename: 'Marama Clarke - Onboarding Case',
    present: [
      ...CONTROL,
      '# The appointment',
      '## Candidate name',
      '## Engagement type',
      '# Offer',
      '## Offer terms as extended',
      '## Status',
      '## Negotiation',
      '# Contract',
      '## Contract terms',
      '## Variations from the offer',
      '## Manager signed',
      '## Candidate signed',
      '## Start date',
      '# Payroll',
      '## Details requested',
      '## Rework',
      '## Payroll confirmation',
      '# Open questions',
    ],
    // Authoring scope only (printed in the Hire Record), the case for appointing, which was
    // approved at the Stage before, and the term marker, as the worked hire is Permanent.
    absent: ['## Term or expected duration', '## Validation outcome', '## Elapsed time', '## Selection rationale', '## Vetting outcome', '## Signatures'],
  },
  // #156: replaces the Offer Pack. `document-control: false` and `satisfies-gate: false`, so it
  // carries no Document Control or sign-off tables and never counts toward onboarding-approved —
  // the only Artefact in this Definition where CONTROL is deliberately absent.
  'appointment-confirmation': {
    basename: 'Marama Clarke - Appointment Confirmation - 2026-04-20',
    present: ['# Your role', '## Role summary', '## Team and reporting line', '## Key responsibilities', '## Engagement type', '# Your terms', '## Start date', '## Terms', '# What happens next'],
    // No open questions, payroll history, staff names, offer terms or status, signatures,
    // start-date changes, or the Document Control / sign-off tables that every other Artefact
    // carries. The worked hire is Permanent, so the term marker doesn't show either.
    absent: [
      ...CONTROL,
      '# Open questions',
      '# Your offer',
      '## Offer terms',
      '## Status',
      '## Details requested',
      '## Validation outcome',
      '## Payroll confirmation',
      '## Manager signed',
      '## Candidate signed',
      '## Signatures',
      '## Start date changes',
      '## Term or expected duration',
    ],
  },
  'starter-readiness': {
    basename: 'Marama Clarke - Starter Readiness - 2026-04-20',
    present: [
      ...CONTROL,
      '# The starter',
      '## Starter',
      '## Role',
      '## Team and reporting line',
      '## Start date',
      '# Identity',
      '## User ID',
      '# Device',
      '## Standard or non-standard',
      '## Specification',
      '## Non-standard hardware decision',
      '## Build status',
      '## Build notes',
      '# Access',
      '## Not in place by the start date',
      '# Open questions',
    ],
    // Technology acts on neither the manager's actions nor the first day, and readiness is the
    // sign-off itself.
    absent: ['# Handover', '## Manager actions', '## First day', '## Readiness confirmation', '## Outstanding at start date'],
  },
  'manager-handover': {
    basename: `Marama Clarke - Manager Handover - ${today}`,
    present: [...CONTROL, '# Your new starter', '# What you need to do', '# What is already in place', '# Open questions'],
    absent: ['## Readiness confirmation'],
  },
  'hire-record': {
    basename: 'Marama Clarke - Hire Record',
    present: [
      ...CONTROL,
      '# Requisition',
      '## Standard approval route for this engagement type',
      '## Route variation',
      '# Selection',
      '# Appointment',
      '## Variations from the offer',
      '## Manager signed',
      '## Candidate signed',
      '# Provisioning',
      '## User ID',
      '## Standard or non-standard device',
      '## Non-standard hardware decision',
      '## Device build notes',
      '## Not in place by the start date',
      '# Open questions and process gaps',
    ],
    // The worked hire is Permanent with no term.
    absent: ['## Signatures', '## Approval route', '## Term or expected duration', '## Readiness confirmation', '## Outstanding at start date'],
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

// Renders one Artefact from a copy of the worked hire with some Fields changed, as a variation a
// real hire could reach that the worked hire itself doesn't.
function renderVariant(artefactId, changes) {
  return withInstancesDir((instancesDir) => {
    cpSync(join(FIXTURE, SLUG), join(instancesDir, SLUG), { recursive: true })
    const def = loadDefinition('recruitment-onboarding', { version: VERSION })
    for (const [moduleId, fields] of Object.entries(changes)) {
      const worked = readModule(def, SLUG, moduleId, { instancesDir })
      writeModule(def, SLUG, moduleId, { ...worked, fields: { ...worked.fields, ...fields } }, { instancesDir })
    }
    return renderArtefact(SLUG, artefactId, { instancesDir, dryRun: true }).markdown
  })
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

test('v3 splits Appointment into the executive approval and Offer, Contract and Payroll', () => {
  const { stages } = loadDefinition('recruitment-onboarding', { version: VERSION })
  assert.deepEqual(
    stages.map((s) => [s.id, s.gate]),
    [
      ['requisition', 'approved-to-recruit'],
      ['selection', 'candidate-selected'],
      ['appointment', 'approved-to-appoint'],
      ['offer-contract-payroll', 'onboarding-approved'],
      ['provisioning', 'ready-to-start'],
    ]
  )
  // Selection stays mounted at Offer, Contract and Payroll so reserve finalists can be recorded as
  // released once the offer is accepted.
  const ocp = stages.find((s) => s.id === 'offer-contract-payroll')
  assert.deepEqual(ocp.modules, ['role', 'engagement', 'selection', 'offer', 'contract', 'payroll', 'open-questions'])
})

for (const [id, bare] of Object.entries(BARE)) {
  test(`${id} has exactly ${bare.length} bare Fields`, () => {
    const artefact = loadDefinition('recruitment-onboarding', { version: VERSION }).artefacts.find((a) => a.id === id)
    assert.deepEqual(
      artefact.requires.filter((r) => !r.endsWith('?')),
      bare
    )
  })
}

// Process gaps can be written at every Stage, and the editor offers only the Fields in a Stage's
// Artefacts' `requires` — so each internal case this round owns carries the Field in scope.
for (const id of ['appointment-case', 'onboarding-case']) {
  test(`${id} has open-questions.process-gaps in authoring scope`, () => {
    const artefact = loadDefinition('recruitment-onboarding', { version: VERSION }).artefacts.find((a) => a.id === id)
    assert.ok(artefact.requires.includes('open-questions.process-gaps?'))
  })
}

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

test('ready-to-start has a 13-Field bar, and Starter Readiness and the Hire Record owe the same 11 Provisioning Fields', () => {
  withInstancesDir((instancesDir) => {
    writeBlankInstance(instancesDir)
    const { artefacts } = checkGate('blank', { instancesDir, gate: 'ready-to-start' })
    const owed = (id) => artefacts.find((a) => a.id === id).outstanding
    const sameStage = (id) => owed(id).filter((reference) => PROVISIONING_MODULES.includes(reference.split('.')[0])).sort()
    assert.deepEqual(owed('starter-readiness').sort(), [
      'access.entitlements',
      'access.setup',
      'contract.start-date',
      'device.build-status',
      'device.specification',
      'device.standard',
      'handover.day-one',
      'handover.manager-actions',
      'identity.account',
      'identity.credential-issue',
      'identity.propagation',
      'identity.user-id',
      'selection.candidate-name',
    ])
    assert.equal(sameStage('starter-readiness').length, 11)
    assert.deepEqual(sameStage('hire-record'), sameStage('starter-readiness'))
  })
})

test('the new Provisioning Fields lead their Modules, and handover.day-one stays required', () => {
  const { modules } = loadDefinition('recruitment-onboarding', { version: VERSION })
  const field = (moduleId, fieldId) => modules.get(moduleId).fields.find((f) => f.id === fieldId)
  const [userId] = modules.get('identity').fields
  assert.deepEqual([userId.id, userId.type, userId.required], ['user-id', 'text', true])
  const [standard] = modules.get('device').fields
  assert.deepEqual([standard.id, standard.type, standard.required], ['standard', 'select', true])
  assert.deepEqual(standard.options, ['Standard', 'Non-standard'])
  assert.equal(field('device', 'build-notes').required, false)
  assert.equal(field('handover', 'day-one').required, true)
})

test('Starter Readiness names the starter, their team, the user ID and the standard/non-standard line', () => {
  const { markdown } = renderArtefact(SLUG, 'starter-readiness', { instancesDir: FIXTURE, dryRun: true })
  assert.match(markdown, /## Starter\n\nMarama Clarke\n/)
  assert.match(markdown, /## Team and reporting line\n\nPlatform Engineering, within Technology/)
  assert.match(markdown, /## User ID\n\nmclarke\n/)
  assert.match(markdown, /## Standard or non-standard\n\nNon-standard\n/)
  // The manager's to-do list and first day stay in scope but are not printed.
  assert.doesNotMatch(markdown, /Meet the starter in reception/)
  assert.doesNotMatch(markdown, /walkthrough of the container platform/)
})

test('Starter Readiness warns when the device is not Ready and nothing is listed as not in place', () => {
  const WARNING = /\*\*Warning:\*\* the device is not Ready/
  const worked = renderArtefact(SLUG, 'starter-readiness', { instancesDir: FIXTURE, dryRun: true }).markdown
  assert.doesNotMatch(worked, WARNING, 'the worked hire\'s device is Ready')
  const unlisted = renderVariant('starter-readiness', { device: { 'build-status': 'Configured' }, access: { outstanding: '' } })
  assert.match(unlisted, WARNING)
  const listed = renderVariant('starter-readiness', { device: { 'build-status': 'Configured' } })
  assert.doesNotMatch(listed, WARNING, 'the worked hire lists the access card as not in place')
})

test('Starter Readiness marks a non-standard device with no recorded decision, and omits the heading for a standard one', () => {
  const blank = renderVariant('starter-readiness', { device: { 'non-standard-decision': '' } })
  assert.match(blank, /## Non-standard hardware decision\n\n— not stated —/)
  const standard = renderVariant('starter-readiness', { device: { standard: 'Standard', 'non-standard-decision': '' } })
  assert.ok(!headings(standard).has('## Non-standard hardware decision'))
})

test('the Hire Record also marks a non-standard device with no recorded decision', () => {
  const blank = renderVariant('hire-record', { device: { 'non-standard-decision': '' } })
  assert.match(blank, /## Non-standard hardware decision\n\n— not stated —/)
})

// #154: Requisition and Selection. The worked hire is Permanent, followed the standard route with
// one delegation, and cleared vetting outright, so the variations below each change one module of
// a copy of it and read the rendered document.

function withWorkedHire(fn) {
  return withInstancesDir((instancesDir) => {
    cpSync(join(FIXTURE, SLUG), join(instancesDir, SLUG), { recursive: true })
    const def = loadDefinition('recruitment-onboarding', { version: VERSION })
    const edit = (moduleId, fields) => {
      const current = readModule(def, SLUG, moduleId, { instancesDir })
      writeModule(def, SLUG, moduleId, { ...current, fields: { ...current.fields, ...fields } }, { instancesDir })
    }
    const render = (id) => renderArtefact(SLUG, id, { instancesDir, dryRun: true }).markdown
    return fn({ edit, render })
  })
}

// The body printed under `heading`, up to the next heading of any level.
function section(markdown, heading) {
  const lines = markdown.split('\n')
  const start = lines.indexOf(heading)
  if (start === -1) return undefined
  const end = lines.findIndex((line, i) => i > start && line.startsWith('#'))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
}

test('v3 drops engagement.approval-route and adds an optional engagement.route-variation', () => {
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  const fields = def.modules.get('engagement').fields
  assert.equal(fields.find((f) => f.id === 'approval-route'), undefined)
  const variation = fields.find((f) => f.id === 'route-variation')
  assert.equal(variation.type, 'markdown')
  assert.equal(variation.required, false)
  assert.match(variation.guidance, /delegation/)
  assert.doesNotMatch(fields.find((f) => f.id === 'rationale').guidance, /delegation/)
})

test('the Requisition sign-off is the "Approved to Recruit" confirmation', () => {
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  assert.match(def.stages.find((s) => s.id === 'requisition').purpose, /"Approved to Recruit" confirmation/)
  assert.match(def.artefacts.find((a) => a.id === 'requisition-brief').purpose, /"Approved to Recruit" confirmation/)
})

test('vetting.checks-required offers "Identity verification"', () => {
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  const checks = def.modules.get('vetting').fields.find((f) => f.id === 'checks-required')
  assert.ok(checks.options.includes('Identity verification'))
})

test('selection.unsuccessful lets reserve finalists be recorded after Selection', () => {
  const def = loadDefinition('recruitment-onboarding', { version: VERSION })
  const unsuccessful = def.modules.get('selection').fields.find((f) => f.id === 'unsuccessful')
  assert.match(unsuccessful.guidance, /reserve/)
  assert.match(unsuccessful.guidance, /after this stage/)
})

for (const id of ['requisition-brief', 'selection-report']) {
  test(`process gaps are in the ${id}'s scope but never printed in it`, () => {
    const def = loadDefinition('recruitment-onboarding', { version: VERSION })
    assert.ok(def.artefacts.find((a) => a.id === id).requires.includes('open-questions.process-gaps?'))
    withWorkedHire(({ render }) => {
      assert.doesNotMatch(render(id), /Nothing detects an unseen payroll request/)
    })
  })
}

for (const [type, route] of [
  ['Permanent', 'Full approval chain'],
  ['Fixed term', 'Full approval chain'],
  ['Vendor', 'Shortened approval chain'],
  ['Contractor', 'Shortened approval chain'],
]) {
  test(`a ${type} engagement prints the ${route} as its standard route`, () => {
    withWorkedHire(({ edit, render }) => {
      edit('engagement', { type })
      for (const id of ['requisition-brief', 'hire-record']) {
        assert.equal(section(render(id), '## Standard approval route for this engagement type'), route, id)
      }
    })
  })
}

test('a draft with no engagement type yet marks its standard route as not stated', () => {
  withWorkedHire(({ edit, render }) => {
    edit('engagement', { type: '' })
    for (const id of ['requisition-brief', 'hire-record']) {
      assert.equal(section(render(id), '## Standard approval route for this engagement type'), '— not stated —', id)
    }
  })
})

test('the route variation is printed only when one is recorded', () => {
  withWorkedHire(({ edit, render }) => {
    assert.match(section(render('requisition-brief'), '## Route variation'), /Sam Okafor/)
    edit('engagement', { 'route-variation': '' })
    for (const id of ['requisition-brief', 'hire-record']) {
      assert.ok(!headings(render(id)).has('## Route variation'), id)
    }
  })
})

test('a non-permanent engagement always shows its term, marked when not stated', () => {
  withWorkedHire(({ edit, render }) => {
    for (const type of ['Fixed term', 'Vendor', 'Contractor']) {
      edit('engagement', { type, term: '' })
      for (const id of ['requisition-brief', 'hire-record']) {
        assert.equal(section(render(id), '## Term or expected duration'), '— not stated —', `${type}: ${id}`)
      }
    }
    edit('engagement', { type: 'Fixed term', term: 'Twelve months, ending 19 April 2027.' })
    assert.equal(section(render('requisition-brief'), '## Term or expected duration'), 'Twelve months, ending 19 April 2027.')
  })
})

test('a conditional clearance always shows its Conditions, marked when not stated', () => {
  withWorkedHire(({ edit, render }) => {
    edit('vetting', { outcome: 'Cleared with conditions', conditions: '' })
    assert.equal(section(render('selection-report'), '## Conditions'), '— not stated —')
    assert.equal(section(render('hire-record'), '## Vetting conditions'), '— not stated —')
    edit('vetting', { outcome: 'Cleared', conditions: '' })
    assert.ok(!headings(render('selection-report')).has('## Conditions'))
    assert.ok(!headings(render('hire-record')).has('## Vetting conditions'))
  })
})

test('the Selection Report warns when vetting reads Not cleared', () => {
  withWorkedHire(({ edit, render }) => {
    assert.doesNotMatch(render('selection-report'), /\*\*Warning:\*\*/)
    edit('vetting', { outcome: 'Not cleared' })
    assert.match(render('selection-report'), /\*\*Warning:\*\* vetting did not clear this candidate/)
  })
})

// #155: Appointment, and Offer, Contract and Payroll.

test('the Appointment and Onboarding Cases show a blank term for a non-permanent hire, and the Appointment Case a blank condition for a conditional clearance', () => {
  const changes = { engagement: { type: 'Fixed term', term: '' }, vetting: { outcome: 'Cleared with conditions', conditions: '' } }
  const appointment = renderVariant('appointment-case', changes)
  assert.match(appointment, /## Term or expected duration\n\n— not stated —/)
  assert.match(appointment, /## Vetting conditions\n\n— not stated —/)
  assert.match(renderVariant('onboarding-case', changes), /## Term or expected duration\n\n— not stated —/)
})

test('the Onboarding Case warns when the offer has not been accepted, and only then', () => {
  const warning = /the offer has not been accepted/
  assert.doesNotMatch(renderArtefact(SLUG, 'onboarding-case', { instancesDir: FIXTURE, dryRun: true }).markdown, warning)
  assert.match(renderVariant('onboarding-case', { offer: { status: 'Extended' } }), warning)
})

// #156: the Appointment Confirmation replaces the Offer Pack, opts out of Document Control and
// of satisfying its Gate, and carries only what a candidate needs — never the organisation's
// internal record of how they got there. Overturns v1's "same core field set" for the two
// audience Artefacts at a shared Gate, and v2's "never as a rendered section" for the candidate's
// own name in this document. See CHANGELOG.md v3.

test('the Appointment Confirmation opts out of Document Control and of satisfying its Gate', () => {
  const artefact = loadDefinition('recruitment-onboarding', { version: VERSION }).artefacts.find(
    (a) => a.id === 'appointment-confirmation'
  )
  assert.equal(artefact.documentControl, false)
  assert.equal(artefact.satisfiesGate, false)
  assert.deepEqual(artefact.requires, [
    'selection.candidate-name',
    'role.summary',
    'role.team',
    'role.responsibilities',
    'engagement.type',
    'engagement.term?',
    'contract.start-date',
    'contract.terms-summary',
    'payroll.confirmed',
  ])
})

test('onboarding-approved never passes through the Appointment Confirmation alone, even complete', () => {
  const result = checkGate(SLUG, { instancesDir: FIXTURE, gate: 'onboarding-approved' })
  const confirmation = result.artefacts.find((a) => a.id === 'appointment-confirmation')
  assert.equal(confirmation.complete, true)
  assert.equal(confirmation.satisfiesGate, false)
  assert.equal(result.pass, true)
  // Pass comes from the Onboarding Case, not from the Appointment Confirmation.
  assert.equal(result.artefacts.find((a) => a.id === 'onboarding-case').complete, true)
})

test('the Appointment Confirmation names the candidate as "For {name}", and shows the term only when filled', () => {
  const worked = renderArtefact(SLUG, 'appointment-confirmation', { instancesDir: FIXTURE, dryRun: true }).markdown
  assert.match(worked, /^For Marama Clarke\n/m)
  assert.ok(!headings(worked).has('## Term or expected duration'), 'the worked hire is Permanent')
  const fixedTerm = renderVariant('appointment-confirmation', { engagement: { type: 'Fixed term', term: 'Twelve months.' } })
  assert.equal(section(fixedTerm, '## Term or expected duration'), 'Twelve months.')
  const noTerm = renderVariant('appointment-confirmation', { engagement: { type: 'Fixed term', term: '' } })
  // Never an internal "— not stated —" marker in a document a candidate reads.
  assert.ok(!headings(noTerm).has('## Term or expected duration'))
})

test('the Appointment Confirmation carries no staff name, payroll history or open question from the worked hire', () => {
  const worked = renderArtefact(SLUG, 'appointment-confirmation', { instancesDir: FIXTURE, dryRun: true }).markdown
  for (const name of ['Anaru Pihema', 'Hana Te Rangi', 'Mereana Walker']) assert.doesNotMatch(worked, new RegExp(name))
  assert.doesNotMatch(worked, /spam folder/)
  assert.doesNotMatch(worked, /Should the 32GB machine/)
  assert.doesNotMatch(worked, /full time, Technology Band 4/)
})

test('the Appointment Confirmation shows the fixed payroll-validated sentence only when payroll is confirmed', () => {
  const worked = renderArtefact(SLUG, 'appointment-confirmation', { instancesDir: FIXTURE, dryRun: true }).markdown
  assert.match(worked, /Your payroll details have been received and validated\./)
  const unconfirmed = renderVariant('appointment-confirmation', { payroll: { confirmed: '' } })
  assert.doesNotMatch(unconfirmed, /Your payroll details have been received and validated\./)
})
