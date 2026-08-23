import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'
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

test('fails a freshly-created instance against its current stage, with every required field outstanding', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const result = checkGate('my-initiative', { instancesDir })

    assert.equal(result.pass, false)
    assert.equal(result.complete, false)
    assert.equal(result.gate, 'business-case')
    assert.deepEqual(result.stage, { id: 'shape', title: 'Shape', gate: 'business-case' })

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

test('--gate resolves the stage owning that gate, even when it is not the instance\'s current stage', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const result = checkGate('my-initiative', { instancesDir, gate: 'hld-tac-approved' })

    assert.deepEqual(result.stage, { id: 'hld-define', title: 'HLD Definition', gate: 'hld-tac-approved' })
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
// checkGate previously only ever read from the local filesystem — an
// Azure-DevOps-backed instance's gate could never actually be checked at
// all (a pre-existing gap #103's own confirmed gate-pass-sync flow depends
// on not existing). These mirror the local-path tests above, one storage
// backend removed.

test('checkGate against Azure DevOps fails a freshly-created instance the same way the local path does', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })

    const result = await checkGate('my-initiative', { azureDevOps })
    assert.equal(result.pass, false)
    assert.equal(result.gate, 'business-case')
    assert.deepEqual(result.stage, { id: 'shape', title: 'Shape', gate: 'business-case' })
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
    assert.deepEqual(result.stage, { id: 'hld-define', title: 'HLD Definition', gate: 'hld-tac-approved' })
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
    '## Business driver',
    '',
    'One.',
    '',
    '## Business driver',
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
        '## Business driver',
        '',
        'A new law requires this by June.',
        '',
        '## Business driver',
        '',
        'Duplicate section.',
        '',
      ].join('\n')
    )

    assert.throws(() => checkGate('my-initiative', { instancesDir }), /duplicate heading/)
  })
})
