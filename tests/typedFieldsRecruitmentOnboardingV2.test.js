import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, writeModule, readModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'

// #90 (epic #77): `recruitment-onboarding/2`, the bundled definition's second version — typed
// Fields (select, select + multiple: true, text, date) and filename: patterns applied on top of
// v1's own process, v1 left untouched. Unlike tests/typedFieldsSelect.test.js and its siblings,
// which build a throwaway STRUCTURE fixture, this file exercises the real definition shipped at
// definitions/recruitment-onboarding/2 — the point is to prove the bundled files themselves are
// correct, not a fixture standing in for them.
//
// v2 is left as an unpublished draft (see its own definition.yaml and CHANGELOG.md for why), so
// every test here passes `version: 2` explicitly rather than relying on
// getLatestPublishedVersion, which would still resolve to v1.

function withInstancesDir(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-ro-v2-'))
  try {
    return fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('recruitment-onboarding/2 exists on disk as an unpublished draft, and v1 is still published', () => {
  const v1 = loadDefinition('recruitment-onboarding', { version: 1 })
  const v2 = loadDefinition('recruitment-onboarding', { version: 2 })
  assert.equal(v1.status, 'published')
  assert.equal(v2.status, 'draft')
})

test('findDefinitionProblems reports zero problems for recruitment-onboarding/2', () => {
  const problems = findDefinitionProblems('recruitment-onboarding', { version: 2 })
  assert.deepEqual(problems, [])
})

test('findLocalDefinitionProblems (Local Workspace twin) also reports zero problems', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const problems = findLocalDefinitionProblems(definitionVersionProjection(def))
  assert.deepEqual(problems, [])
})

test('the seven fields the epic named "select" are select in v2, with the options traced to v1\'s own guidance', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const field = (moduleId, fieldId) => def.modules.get(moduleId).fields.find((f) => f.id === fieldId)

  assert.equal(field('engagement', 'type').type, 'select')
  assert.deepEqual(field('engagement', 'type').options, ['Fixed term', 'Permanent', 'Vendor', 'Contractor'])

  assert.equal(field('engagement', 'approval-route').type, 'select')
  assert.deepEqual(field('engagement', 'approval-route').options, ['Full approval chain', 'Shortened approval chain'])

  assert.equal(field('offer', 'status').type, 'select')
  assert.deepEqual(field('offer', 'status').options, ['Extended', 'Accepted', 'Declined'])

  assert.equal(field('vetting', 'outcome').type, 'select')
  assert.deepEqual(field('vetting', 'outcome').options, ['Cleared', 'Cleared with conditions', 'Not cleared'])

  assert.equal(field('payroll', 'validation-outcome').type, 'select')
  assert.deepEqual(field('payroll', 'validation-outcome').options, ['Passed', 'Failed'])

  assert.equal(field('device', 'build-status').type, 'select')
  assert.deepEqual(field('device', 'build-status').options, ['Requested', 'Built', 'Configured', 'Ready'])

  assert.equal(field('handover', 'readiness-confirmation').type, 'select')
  assert.deepEqual(field('handover', 'readiness-confirmation').options, ['Ready', 'Ready with outstanding items', 'Not ready'])
})

test('vetting.checks-required and advertising.channels are select with multiple: true', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const field = (moduleId, fieldId) => def.modules.get(moduleId).fields.find((f) => f.id === fieldId)

  assert.equal(field('vetting', 'checks-required').type, 'select')
  assert.equal(field('vetting', 'checks-required').multiple, true)
  assert.deepEqual(field('vetting', 'checks-required').options, ['Right to work', 'Criminal record', 'Credit', 'Professional registration', 'Referee checks'])

  assert.equal(field('advertising', 'channels').type, 'select')
  assert.equal(field('advertising', 'channels').multiple, true)
  assert.deepEqual(field('advertising', 'channels').options, ['Job boards', 'Careers site', 'Agencies', 'Internal channels', 'Professional networks'])
})

test('selection.preferred-candidate is split into candidate-name (text) and rationale (markdown)', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const selection = def.modules.get('selection')
  assert.equal(selection.fields.some((f) => f.id === 'preferred-candidate'), false)
  const name = selection.fields.find((f) => f.id === 'candidate-name')
  const rationale = selection.fields.find((f) => f.id === 'rationale')
  assert.equal(name.type, 'text')
  assert.equal(name.required, true)
  assert.equal(rationale.type, 'markdown')
  assert.equal(rationale.required, true)
})

test('contract.start-date is a date field, with a separate optional start-date-changes field', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const contract = def.modules.get('contract')
  const startDate = contract.fields.find((f) => f.id === 'start-date')
  const changes = contract.fields.find((f) => f.id === 'start-date-changes')
  assert.equal(startDate.type, 'date')
  assert.equal(startDate.required, true)
  assert.equal(changes.type, 'markdown')
  assert.equal(changes.required, false)
})

test('engagement.type gains a companion prose field, engagement.term, for the duration', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const term = def.modules.get('engagement').fields.find((f) => f.id === 'term')
  assert.equal(term.type, 'markdown')
  assert.equal(term.required, false)
})

test('the three deliberately-undocumented fields remain prose (markdown) in v2', () => {
  const def = loadDefinition('recruitment-onboarding', { version: 2 })
  const field = (moduleId, fieldId) => def.modules.get(moduleId).fields.find((f) => f.id === fieldId)

  assert.equal(field('role-evaluation', 'method').type, 'markdown')
  assert.equal(field('advertising', 'period').type, 'markdown')
  assert.equal(field('advertising', 'response').type, 'markdown')
  assert.equal(field('advertising', 'notes').type, 'markdown')
  assert.equal(field('device', 'non-standard-decision').type, 'markdown')
})

test('v1 is completely untouched by v2\'s changes — same field types and ids throughout', () => {
  const v1 = loadDefinition('recruitment-onboarding', { version: 1 })
  const field = (moduleId, fieldId) => v1.modules.get(moduleId).fields.find((f) => f.id === fieldId)

  assert.equal(field('engagement', 'type').type, 'markdown')
  assert.equal(field('selection', 'preferred-candidate').type, 'markdown')
  assert.equal(field('contract', 'start-date').type, 'markdown')
  assert.equal(v1.modules.get('selection').fields.some((f) => f.id === 'candidate-name'), false)
  assert.equal(v1.modules.get('contract').fields.some((f) => f.id === 'start-date-changes'), false)
})

// --- End to end: create an Instance against the draft v2, fill every field type, render, and
// assert the rendered filename — the ticket's own acceptance criterion taken literally. ---

const FIELDS = {
  role: {
    summary: 'Platform Engineer',
    team: 'Technology, reports to the CTO',
    responsibilities: ['Build platforms', 'Support delivery teams'],
    justification: 'The team is at capacity and the backlog is growing.',
  },
  engagement: {
    type: 'Fixed term',
    term: '12 months, covering parental leave',
    rationale: 'Covers a period of parental leave on the platform team.',
    'approval-route': 'Full approval chain',
  },
  'role-evaluation': { method: 'The usual banding process, run by HR.', outcome: 'Band 5, confirmed 2026-09-01.' },
  'open-questions': {},
  advertising: {
    channels: ['Job boards', 'Careers site'],
    period: '1-14 March 2026',
    response: '40 applications, a strong field.',
  },
  selection: {
    shortlist: 'Two shortlisted against technical depth and platform experience.',
    interviews: 'Two rounds: technical, then panel. Week of 17 March.',
    'candidate-name': 'Jane Smith',
    rationale: 'Best technical fit and strongest platform experience of the shortlist.',
  },
  vetting: { 'checks-required': ['Right to work', 'Criminal record'], outcome: 'Cleared' },
  offer: { terms: 'Standard terms, base plus benefits.', status: 'Accepted' },
  contract: {
    'terms-summary': 'As offered, no changes.',
    signatures: 'Manager signed 1 March, candidate signed 3 March.',
    'start-date': '2026-11-03',
  },
  payroll: {
    'details-requested': 'Sent 2 March by email.',
    'validation-outcome': 'Passed',
    confirmed: 'Confirmed 5 March by Payroll.',
  },
  identity: {
    account: 'jsmith created 28 October in the identity platform.',
    propagation: 'Propagated to directory and service management.',
    'credential-issue': 'Emailed by the hiring manager, 29 October.',
  },
  device: { specification: 'Standard issue laptop.', 'build-status': 'Ready' },
  access: { entitlements: ['VPN', 'Email', 'Shared drive'], setup: 'Set up 1 November.' },
  handover: {
    'manager-actions': ['Book induction session', 'Confirm desk'],
    'day-one': 'Meet the team at 9am, complete induction.',
    'readiness-confirmation': 'Ready',
  },
}

function seedInstance(slug, instancesDir, overrides = {}) {
  createInstance('recruitment-onboarding', slug, { instancesDir, version: 2 })
  const definition = loadDefinition('recruitment-onboarding', { version: 2 })
  const merged = { ...FIELDS, ...overrides }
  for (const [moduleId, fields] of Object.entries(merged)) {
    writeModule(definition, slug, moduleId, { status: 'draft', owner: '', fields }, { instancesDir })
  }
  return definition
}

test('an Instance created against v2 stores select, multi-select, text and date values, and round-trips through readModule', () => {
  withInstancesDir((instancesDir) => {
    const definition = seedInstance('ro-v2-roundtrip', instancesDir)

    const engagement = readModule(definition, 'ro-v2-roundtrip', 'engagement', { instancesDir })
    assert.equal(engagement.fields.type, 'Fixed term')

    const vetting = readModule(definition, 'ro-v2-roundtrip', 'vetting', { instancesDir })
    assert.deepEqual(vetting.fields['checks-required'], ['Right to work', 'Criminal record'])

    const selection = readModule(definition, 'ro-v2-roundtrip', 'selection', { instancesDir })
    assert.equal(selection.fields['candidate-name'], 'Jane Smith')

    const contract = readModule(definition, 'ro-v2-roundtrip', 'contract', { instancesDir })
    assert.equal(contract.fields['start-date'], '2026-11-03')

    const result = checkGate('ro-v2-roundtrip', { instancesDir })
    assert.deepEqual(result.warnings, [])
  })
})

test('rendering the Requisition Brief and Selection Report names them from the Instance, before any candidate exists', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-early', instancesDir)

    // titleCaseSlug (lib/instance.js) upper-cases each ≤4-char word of a slug wholesale — "ro"
    // and "v2" both qualify — so "ro-v2-early" displays as "RO V2 Early", not "Ro V2 Early".
    const brief = renderArtefact('ro-v2-early', 'requisition-brief', { dryRun: true, instancesDir })
    assert.equal(brief.basename, 'RO V2 Early - Requisition Brief')

    const report = renderArtefact('ro-v2-early', 'selection-report', { dryRun: true, instancesDir })
    assert.equal(report.basename, 'RO V2 Early - Selection Report')
  })
})

test('rendering the Appointment Case and Hire Record names them from the candidate', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-candidate', instancesDir)

    const appointment = renderArtefact('ro-v2-candidate', 'appointment-case', { dryRun: true, instancesDir })
    assert.equal(appointment.basename, 'Jane Smith - Appointment Case')

    const hireRecord = renderArtefact('ro-v2-candidate', 'hire-record', { dryRun: true, instancesDir })
    assert.equal(hireRecord.basename, 'Jane Smith - Hire Record')
  })
})

test('rendering the Offer Pack and Starter Readiness names them from the candidate and the start date', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-startdate', instancesDir)

    const offerPack = renderArtefact('ro-v2-startdate', 'offer-pack', { dryRun: true, instancesDir })
    assert.equal(offerPack.basename, 'Jane Smith - Offer Pack - 2026-11-03')

    const starterReadiness = renderArtefact('ro-v2-startdate', 'starter-readiness', { dryRun: true, instancesDir })
    assert.equal(starterReadiness.basename, 'Jane Smith - Starter Readiness - 2026-11-03')
  })
})

test('rendering the Manager Handover names it from the candidate and today\'s date', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-today', instancesDir)

    const today = new Date().toISOString().slice(0, 10)
    const handover = renderArtefact('ro-v2-today', 'manager-handover', { dryRun: true, instancesDir })
    assert.equal(handover.basename, `Jane Smith - Manager Handover - ${today}`)
  })
})

test('the Appointment Case shows a select value, the split candidate-name/rationale fields, and a formatted date in its rendered markdown', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-markdown', instancesDir)
    const result = renderArtefact('ro-v2-markdown', 'appointment-case', { dryRun: true, instancesDir })
    assert.match(result.markdown, /## Engagement type\n\nFixed term/)
    assert.match(result.markdown, /## Candidate name\n\nJane Smith/)
    assert.match(result.markdown, /## Selection rationale\n\nBest technical fit/)
    // formatDate() renders the stored ISO 2026-11-03 as human-readable long-form English.
    assert.match(result.markdown, /## Start date\n\n3 November 2026/)
  })
})

test('a filename token still drops out when its Field is blank, mid-stage, per ADR-0045 §5', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-blank', instancesDir, { selection: { ...FIELDS.selection, 'candidate-name': '' } })
    const result = renderArtefact('ro-v2-blank', 'appointment-case', { dryRun: true, instancesDir })
    assert.equal(result.basename, 'Appointment Case')
  })
})

test('the optional engagement.term and contract.start-date-changes sections suppress when blank and appear when filled', () => {
  withInstancesDir((instancesDir) => {
    seedInstance('ro-v2-optional-blank', instancesDir, { engagement: { ...FIELDS.engagement, term: '' } })
    const blank = renderArtefact('ro-v2-optional-blank', 'requisition-brief', { dryRun: true, instancesDir })
    assert.doesNotMatch(blank.markdown, /Term or expected duration/)

    seedInstance('ro-v2-optional-filled', instancesDir, {
      contract: { ...FIELDS.contract, 'start-date-changes': 'Moved from 20 October after a payroll validation failure.' },
    })
    const filled = renderArtefact('ro-v2-optional-filled', 'appointment-case', { dryRun: true, instancesDir })
    assert.match(filled.markdown, /## Start date changes\n\nMoved from 20 October/)
  })
})
