import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readModule, writeModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { checkGate, formatGateOutstanding } from '../lib/check.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

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
  const result = checkGate('examples', { gate: 'build-ready-checklist' })

  assert.equal(result.pass, true)
  assert.deepEqual(result.artefacts.map((artefact) => artefact.id), ['sad', 'ssad'])
  assert.ok(result.artefacts.every((artefact) => artefact.complete))
})

test('identical SAD and SSAD requirements still fail together when their shared module data is missing', () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
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

test('fails a freshly-created instance against its current stage, with every required field outstanding', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const result = checkGate('my-initiative', { instancesDir })

    assert.equal(result.pass, false)
    assert.equal(result.complete, false)
    assert.equal(result.gate, 'business-case')
    assert.deepEqual(result.stage, { id: 'shape', title: 'SOAP', gate: 'business-case' })

    const context = result.modules.find((m) => m.id === 'context')
    assert.deepEqual(context.outstanding, ['driver', 'affected-domains'])
  })
})

test('a module with no file on disk fails the gate, with all its required fields outstanding', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'team-and-estimates.md'))

    const result = checkGate('my-initiative', { instancesDir })
    const teamAndEstimates = result.modules.find((m) => m.id === 'team-and-estimates')
    assert.equal(teamAndEstimates.exists, false)
    assert.equal(result.pass, false)
  })
})

test('passes the examples fixture against its current stage', () => {
  const result = checkGate('examples')
  assert.equal(result.pass, true)
  assert.equal(result.complete, true)
  assert.equal(result.gate, 'business-case')
})

test('passes Business Case Approved with only the lightweight SOAP fields', () => {
  withScratchInstances((instancesDir) => {
    const definition = loadDefinition('design')
    createInstance('design', 'light-soap', { instancesDir })

    const source = {
      context: readModule(definition, 'examples', 'context').fields,
      'solution-definition': readModule(definition, 'examples', 'solution-definition').fields,
      'team-and-estimates': readModule(definition, 'examples', 'team-and-estimates').fields,
    }
    writeModule(definition, 'light-soap', 'context', {
      fields: {
        driver: source.context.driver,
        'affected-domains': source.context['affected-domains'],
        'out-of-scope': source.context['out-of-scope'],
      },
    }, { instancesDir })
    writeModule(definition, 'light-soap', 'solution-definition', {
      fields: {
        'process-flow': source['solution-definition']['process-flow'],
        'high-level-solution-overview': source['solution-definition']['high-level-solution-overview'],
        'assumptions-and-considerations': source['solution-definition']['assumptions-and-considerations'],
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

test('passes Business Case Approved with only the Full SOAP fields, without process-flow or feature-breakdown', () => {
  withScratchInstances((instancesDir) => {
    const definition = loadDefinition('design')
    createInstance('design', 'full-soap', { instancesDir })

    writeModule(definition, 'full-soap', 'context', {
      fields: {
        driver: 'The current service creates an avoidable barrier.',
        opportunity: 'The initiative creates a simpler path for clients.',
        'in-scope': 'The new service flow and its supporting integrations.',
        'out-of-scope': 'Unrelated service changes.',
      },
    }, { instancesDir })
    writeModule(definition, 'full-soap', 'solution-definition', {
      fields: {
        'high-level-requirements': '| Section | Requirement |\n| --- | --- |\n| Service | Provide the new service flow. |',
        'high-level-solution-overview': 'The service uses the existing intake and workflow platforms.',
        'assumptions-and-considerations': 'The existing platforms can support the new service flow.',
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

test('--gate resolves the stage owning that gate, even when it is not the instance\'s current stage', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const result = checkGate('my-initiative', { instancesDir, gate: 'hld-tac-approved' })

    assert.deepEqual(result.stage, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' })
    assert.equal(result.gate, 'hld-tac-approved')
    assert.equal(result.pass, false)

    const hldSubmission = result.modules.find((m) => m.id === 'hld-submission')
    assert.equal(hldSubmission.exists, false)
  })
})

test('an unknown --gate throws', () => {
  withScratchInstances((instancesDir) => {
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
  for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
    seedFiles[`/gantry-workspace/my-initiative/modules/${moduleId}.md`] = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
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
    'module: context',
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
    '/gantry-workspace/my-initiative/modules/context.md': badModuleText,
  }
  await withFakeRepo(seedFiles, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await assert.rejects(() => checkGate('my-initiative', { azureDevOps }), /duplicate heading/)
  })
})

test('a parser anomaly in a module file fails hard, via strict parseModuleFile, rather than passing silently', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    writeFileSync(
      contextPath,
      [
        '---',
        'module: context',
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
