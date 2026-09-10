import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readModule, writeModule, readInstance, instanceDefinitionVersion } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { checkGate, formatGateOutstanding } from '../lib/check.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withScratchInstances, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'



function azureDevOpsOptions(baseUrl, overrides = {}) {
  return { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, ...overrides }
}

function withFakeRepo(files, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, fn)
}

function withAnyArtefactDefinition(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-definition-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const definitionsDir = join(root, 'definitions')
  const definitionDir = join(definitionsDir, 'any-artefact')
  const modulesDir = join(definitionDir, 'modules')
  mkdirSync(modulesDir, { recursive: true })
  writeFileSync(
    join(definitionDir, 'definition.yaml'),
    [
      'id: any-artefact',
      'title: Any Artefact',
      'stages:',
      '  - id: stage',
      '    title: Stage',
      '    gate: gate',
      '    modules: [light, heavy]',
      'artefacts:',
      '  - id: light',
      '    title: Light Artefact',
      '    template: light.md.tmpl',
      '    gate: gate',
      '    requires: [light]',
      '  - id: heavy',
      '    title: Heavy Artefact',
      '    template: heavy.md.tmpl',
      '    gate: gate',
      '    requires: [heavy]',
    ].join('\n')
  )
  for (const moduleId of ['light', 'heavy']) {
    writeFileSync(
      join(modulesDir, `${moduleId}.yaml`),
      `id: ${moduleId}\ntitle: ${moduleId[0].toUpperCase()}${moduleId.slice(1)}\nfields:\n  - id: content\n    title: Content\n    type: markdown\n    required: true\n`
    )
  }

  try {
    createInstance('any-artefact', 'my-initiative', { instancesDir, definitionsDir })
    return fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function completeArtefactModule(definitionsDir, instancesDir, moduleId) {
  const definition = loadDefinition('any-artefact', { definitionsDir })
  writeModule(
    definition,
    'my-initiative',
    moduleId,
    { status: 'agreed', owner: '', fields: { content: 'Complete.' } },
    { instancesDir }
  )
}

test('a gate with two different artefacts passes when either one is complete', () => {
  withAnyArtefactDefinition(({ instancesDir, definitionsDir }) => {
    completeArtefactModule(definitionsDir, instancesDir, 'light')

    const result = checkGate('my-initiative', { instancesDir, definitionsDir })

    assert.equal(result.pass, true)
    assert.equal(result.complete, true)
    assert.deepEqual(result.modules.map((module) => module.id), ['light', 'heavy'])
    assert.deepEqual(
      result.artefacts.map((artefact) => ({ id: artefact.id, complete: artefact.complete })),
      [
        { id: 'light', complete: true },
        { id: 'heavy', complete: false },
      ]
    )
  })
})

test('a gate with two different artefacts fails when neither artefact is complete and reports artefact-scoped outstanding data', () => {
  withAnyArtefactDefinition(({ instancesDir, definitionsDir }) => {
    unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'light.md'))
    unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'heavy.md'))
    const result = checkGate('my-initiative', { instancesDir, definitionsDir })

    assert.equal(result.pass, false)
    assert.equal(result.complete, false)
    assert.ok(result.artefacts.every((artefact) => artefact.complete === false))
    assert.equal(formatGateOutstanding(result), 'Light Artefact: Light (file missing)')
  })
})

test('a gate with the existing identical SAD and SSAD requirements still passes both artefacts together', () => {
  const result = checkGate('kiwi-cover-mutual', { instancesDir: 'workspaces/examples', gate: 'build-ready-checklist' })

  assert.equal(result.pass, true)
  assert.deepEqual(result.artefacts.map((artefact) => artefact.id), ['sad', 'ssad'])
  assert.ok(result.artefacts.every((artefact) => artefact.complete))
})

test('identical SAD and SSAD requirements still fail together when their shared module data is missing', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    unlinkSync(join(instancesDir, 'examples', 'modules', 'architecture.md'))

    const result = checkGate('examples', { instancesDir, gate: 'build-ready-checklist' })

    assert.equal(result.pass, false)
    assert.deepEqual(
      result.artefacts.map((artefact) => ({ id: artefact.id, complete: artefact.complete })),
      [
        { id: 'sad', complete: false },
        { id: 'ssad', complete: false },
      ]
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('fails a freshly-created instance against its current stage, with every required field outstanding', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const result = checkGate('my-initiative', { instancesDir })

    assert.equal(result.pass, false)
    assert.equal(result.complete, false)
    assert.equal(result.gate, 'business-case')
    assert.deepEqual(result.stage, { id: 'shape', title: 'SOAP', gate: 'business-case' })

    const background = result.modules.find((m) => m.id === 'background')
    assert.deepEqual(background.outstanding, ['problem', 'affected-domains'])
  })
})

test('a module with no file on disk fails the gate, with all its required fields outstanding', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'team-and-estimates.md'))

    const result = checkGate('my-initiative', { instancesDir })
    const teamAndEstimates = result.modules.find((m) => m.id === 'team-and-estimates')
    assert.equal(teamAndEstimates.exists, false)
    assert.equal(result.pass, false)
  })
})

test('passes the examples fixture against its current stage', () => {
  const result = checkGate('kiwi-cover-mutual', { instancesDir: 'workspaces/examples' })
  assert.equal(result.pass, true)
  assert.equal(result.complete, true)
  assert.equal(result.gate, 'business-case')
})

test('passes Business Case Approved with only the lightweight SOAP fields', async () => {
  await withScratchInstances((instancesDir) => {
    const definition = loadDefinition('design')
    createInstance('design', 'light-soap', { instancesDir })

    // Reading the real, checked-in `examples` fixture as a source of realistic
    // field values — resolved against *its own* pinned definition version
    // (instanceDefinitionVersion defaults to 1; `examples`'s instance.yaml has
    // no `definitionVersion`), not the bare `definition` above (which resolves
    // to the latest published version, currently v2). Reading it against a
    // mismatched version's moduleSpec would trip readModule's lazy
    // heading-scale migration write-back against the real on-disk fixture —
    // corrupting a checked-in file as a side effect of a test read (WI #333).
    const exampleInstancesDir = 'workspaces/examples'
    const examplesDefinition = loadDefinition('design', { version: instanceDefinitionVersion(readInstance('kiwi-cover-mutual', { instancesDir: exampleInstancesDir })) })
    const source = {
      background: readModule(examplesDefinition, 'kiwi-cover-mutual', 'background', { instancesDir: exampleInstancesDir }).fields,
      introduction: readModule(examplesDefinition, 'kiwi-cover-mutual', 'introduction', { instancesDir: exampleInstancesDir }).fields,
      'solution-definition': readModule(examplesDefinition, 'kiwi-cover-mutual', 'solution-definition', { instancesDir: exampleInstancesDir }).fields,
      'team-and-estimates': readModule(examplesDefinition, 'kiwi-cover-mutual', 'team-and-estimates', { instancesDir: exampleInstancesDir }).fields,
    }
    writeModule(definition, 'light-soap', 'background', {
      fields: {
        problem: source.background.problem,
        'affected-domains': source.background['affected-domains'],
      },
    }, { instancesDir })
    writeModule(definition, 'light-soap', 'introduction', {
      fields: {
        'in-scope': source.introduction['in-scope'],
        'out-of-scope': source.introduction['out-of-scope'],
      },
    }, { instancesDir })
    writeModule(definition, 'light-soap', 'solution-definition', {
      fields: {
        'process-flow': source['solution-definition']['process-flow'],
        'high-level-solution-overview': source['solution-definition']['high-level-solution-overview'],
        'high-level-requirements': source['solution-definition']['high-level-requirements'],
        'feature-breakdown': source['solution-definition']['feature-breakdown'],
      },
    }, { instancesDir })
    writeModule(definition, 'light-soap', 'team-and-estimates', {
      fields: {
        'teams-required': source['team-and-estimates']['teams-required'],
        estimates: source['team-and-estimates'].estimates,
      },
    }, { instancesDir })

    const result = checkGate('light-soap', { instancesDir })
    assert.equal(result.pass, true)
    assert.equal(result.artefacts.find((artefact) => artefact.id === 'soap').complete, true)
    assert.equal(result.artefacts.find((artefact) => artefact.id === 'soap-full').complete, false)
  })
})

test('passes Business Case Approved with only the Full SOAP fields, without process-flow or feature-breakdown', async () => {
  await withScratchInstances((instancesDir) => {
    // Pinned to v1 explicitly (WI #318 published v2 alongside it) — this test
    // writes v1's exact Full SOAP field shape (e.g. `soap-full-details.questions`,
    // which v2 replaced with `open-questions.questions`).
    const definition = loadDefinition('design', { version: 1 })
    createInstance('design', 'full-soap', { instancesDir, definitionVersion: 1 })

    writeModule(definition, 'full-soap', 'background', {
      fields: {
        problem: 'The current service creates an avoidable barrier.',
        opportunity: 'The initiative creates a simpler path for clients.',
      },
    }, { instancesDir })
    writeModule(definition, 'full-soap', 'introduction', {
      fields: {
        'in-scope': 'The new service flow and its supporting integrations.',
        'out-of-scope': 'Unrelated service changes.',
      },
    }, { instancesDir })
    writeModule(definition, 'full-soap', 'solution-definition', {
      fields: {
        'high-level-requirements': '| Section | Requirement |\n| --- | --- |\n| Service | Provide the new service flow. |',
        'high-level-solution-overview': 'The service uses the existing intake and workflow platforms.',
      },
    }, { instancesDir })
    writeModule(definition, 'full-soap', 'team-and-estimates', {
      fields: {
        'teams-required': ['Delivery team — A. Person'],
        estimates: 'Delivery: M',
        references: ['Source brief'],
      },
    }, { instancesDir })
    writeModule(definition, 'full-soap', 'dependencies', {
      fields: { 'dependencies-overview': 'The delivery team depends on the platform team.' },
    }, { instancesDir })
    writeModule(definition, 'full-soap', 'soap-full-details', {
      fields: {
        'epic-project': 'Example Epic',
        'requested-lead-by': 'A. Person',
        'request-date': '2026-01-01',
        'draft-agreed-date': '2026-01-08',
        'delivered-date': '2026-01-15',
        sequencing: '| Requirement | Team | Estimate | Notes |\n| --- | --- | --- | --- |\n| Service | Delivery | M | Initial release |',
        questions: 'Which platform team will support the service?',
        caveats: '- This is a high level estimate.',
      },
    }, { instancesDir })

    const result = checkGate('full-soap', { instancesDir })
    assert.equal(result.pass, true)
    assert.equal(result.artefacts.find((artefact) => artefact.id === 'soap').complete, false)
    assert.equal(result.artefacts.find((artefact) => artefact.id === 'soap-full').complete, true)
  })
})

test('--gate resolves the stage owning that gate, even when it is not the instance\'s current stage', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const result = checkGate('my-initiative', { instancesDir, gate: 'hld-tac-approved' })

    assert.deepEqual(result.stage, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' })
    assert.equal(result.gate, 'hld-tac-approved')
    assert.equal(result.pass, false)

    const hldSubmission = result.modules.find((m) => m.id === 'hld-submission')
    assert.equal(hldSubmission.exists, false)
  })
})

test('an unknown --gate throws', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    assert.throws(
      () => checkGate('my-initiative', { instancesDir, gate: 'not-a-real-gate' }),
      /has no stage with gate/
    )
  })
})

// ---------- Azure-DevOps-backed checkGate (#103) ----------
// checkGate previously only ever read from the local filesystem — an Azure-DevOps-backed instance's gate could never actually be checked at all (a pre-existing gap #103's own confirmed gate-pass-sync flow depends on not existing). These mirror the local-path tests above, one storage backend removed.

test('checkGate against Azure DevOps fails a freshly-created instance the same way the local path does', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })

    const result = await checkGate('my-initiative', { azureDevOps })
    assert.equal(result.pass, false)
    assert.equal(result.gate, 'business-case')
    assert.deepEqual(result.stage, { id: 'shape', title: 'SOAP', gate: 'business-case' })
  })
})

test('checkGate against Azure DevOps passes once the Shape-stage modules are filled in, the same content that passes locally', async () => {
  const seedFiles = { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    seedFiles[`/gantry-workspace/my-initiative/modules/${moduleId}.md`] = exampleModuleText(moduleId)
  }

  await withFakeRepo(seedFiles, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    const result = await checkGate('my-initiative', { azureDevOps })
    assert.equal(result.pass, true)
    assert.equal(result.complete, true)
  })
})

test('checkGate against Azure DevOps honours --gate, resolving a stage other than the instance\'s current one', async () => {
  const seedFiles = { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }
  await withFakeRepo(seedFiles, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    const result = await checkGate('my-initiative', { azureDevOps, gate: 'hld-tac-approved' })
    assert.deepEqual(result.stage, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' })
    assert.equal(result.pass, false)
  })
})

test('checkGate against Azure DevOps fails hard on a parser anomaly, via strict parsing, exactly as the local path does', async () => {
  const badModuleText = [
    '---',
    'module: background',
    'status: draft',
    'owner:',
    '---',
    '',
    '## Problem statement',
    '',
    'One.',
    '',
    '## Problem statement',
    '',
    'Duplicate.',
    '',
  ].join('\n')
  const seedFiles = {
    '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
    '/gantry-workspace/my-initiative/modules/background.md': badModuleText,
  }
  await withFakeRepo(seedFiles, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await assert.rejects(() => checkGate('my-initiative', { azureDevOps }), /duplicate heading/)
  })
})

test('a parser anomaly in a module file fails hard, via strict parseModuleFile, rather than passing silently', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const backgroundPath = join(instancesDir, 'my-initiative', 'modules', 'background.md')
    writeFileSync(
      backgroundPath,
      [
        '---',
        'module: background',
        'status: review',
        'owner: c.barlow',
        '---',
        '',
        '## Problem statement',
        '',
        'A new law requires this by June.',
        '',
        '## Problem statement',
        '',
        'Duplicate section.',
        '',
      ].join('\n')
    )

    assert.throws(() => checkGate('my-initiative', { instancesDir }), /duplicate heading/)
  })
})

// --- WI #276: optional field refs (`module.field?`) -----------------------
//
// A bare `module.field` always gates. A `module.field?` is in the artefact's
// scope but only gates when the field is independently required at that gate
// via its own `required` / `required-at`.

function withOptionalRefDefinition(requires, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-definition-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const definitionsDir = join(root, 'definitions')
  const definitionDir = join(definitionsDir, 'optref')
  const modulesDir = join(definitionDir, 'modules')
  mkdirSync(modulesDir, { recursive: true })
  writeFileSync(
    join(definitionDir, 'definition.yaml'),
    [
      'id: optref',
      'title: Opt Ref',
      'stages:',
      '  - id: stage',
      '    title: Stage',
      '    gate: gate',
      '    modules: [ctx]',
      'artefacts:',
      '  - id: doc',
      '    title: Doc',
      '    template: doc.md.tmpl',
      '    gate: gate',
      `    requires: [${requires.join(', ')}]`,
    ].join('\n')
  )
  writeFileSync(
    join(modulesDir, 'ctx.yaml'),
    [
      'id: ctx',
      'title: Ctx',
      'fields:',
      '  - id: driver',
      '    title: Driver',
      '    type: markdown',
      '    required: true',
      '  - id: extra',
      '    title: Extra',
      '    type: markdown',
      '    required: false',
      '  - id: late',
      '    title: Late',
      '    type: markdown',
      '    required-at: [gate]',
    ].join('\n')
  )
  try {
    createInstance('optref', 'my-initiative', { instancesDir, definitionsDir })
    return fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function writeCtx(definitionsDir, instancesDir, fields) {
  const definition = loadDefinition('optref', { definitionsDir })
  writeModule(definition, 'my-initiative', 'ctx', { status: 'agreed', owner: '', fields }, { instancesDir })
}

test('an optional field ref does not fail the gate when the field is blank and not independently required', () => {
  withOptionalRefDefinition(['ctx.driver', 'ctx.extra?'], ({ instancesDir, definitionsDir }) => {
    writeCtx(definitionsDir, instancesDir, { driver: 'Present.' })
    const result = checkGate('my-initiative', { instancesDir, definitionsDir })
    assert.equal(result.pass, true)
    assert.deepEqual(result.artefacts[0].outstanding, [])
  })
})

test('a bare field ref still fails the gate when that field is blank', () => {
  withOptionalRefDefinition(['ctx.driver', 'ctx.extra'], ({ instancesDir, definitionsDir }) => {
    writeCtx(definitionsDir, instancesDir, { driver: 'Present.' })
    const result = checkGate('my-initiative', { instancesDir, definitionsDir })
    assert.equal(result.pass, false)
    assert.deepEqual(result.artefacts[0].outstanding, ['ctx.extra'])
  })
})

test('an optional field ref DOES fail the gate when the field is required there via required-at', () => {
  withOptionalRefDefinition(['ctx.driver', 'ctx.late?'], ({ instancesDir, definitionsDir }) => {
    writeCtx(definitionsDir, instancesDir, { driver: 'Present.' })
    const result = checkGate('my-initiative', { instancesDir, definitionsDir })
    assert.equal(result.pass, false)
    assert.deepEqual(result.artefacts[0].outstanding, ['ctx.late'])
  })
})

test('an optional field ref passes once its required-at field is filled in', () => {
  withOptionalRefDefinition(['ctx.driver', 'ctx.late?'], ({ instancesDir, definitionsDir }) => {
    writeCtx(definitionsDir, instancesDir, { driver: 'Present.', late: 'Also present.' })
    const result = checkGate('my-initiative', { instancesDir, definitionsDir })
    assert.equal(result.pass, true)
  })
})
