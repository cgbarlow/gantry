import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { getStatus, evaluateStage } from '../lib/status.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('a freshly-created instance is incomplete, with every required field outstanding', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const status = getStatus('my-initiative', { instancesDir })

    assert.equal(status.slug, 'my-initiative')
    assert.equal(status.definition, 'design')
    assert.deepEqual(status.stage, { id: 'shape', title: 'Shape', gate: 'business-case' })
    assert.equal(status.complete, false)

    const context = status.modules.find((m) => m.id === 'context')
    assert.equal(context.exists, true)
    assert.equal(context.complete, false)
    assert.deepEqual(context.outstanding, ['driver', 'affected-domains'])
  })
})

test('a module with no file on disk is reported missing, with all required fields outstanding', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'team-and-estimates.md'))

    const status = getStatus('my-initiative', { instancesDir })
    const teamAndEstimates = status.modules.find((m) => m.id === 'team-and-estimates')
    assert.equal(teamAndEstimates.exists, false)
    assert.equal(teamAndEstimates.complete, false)
    assert.deepEqual(teamAndEstimates.outstanding, ['teams-and-contacts', 'estimates'])
  })
})

test('the examples fixture is complete', () => {
  const status = getStatus('examples')
  assert.equal(status.complete, true)
  for (const mod of status.modules) {
    assert.equal(mod.exists, true)
    assert.deepEqual(mod.outstanding, [])
  }
})

test('stageId lets a caller evaluate a stage other than the instance\'s current one', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const status = getStatus('my-initiative', { instancesDir, stageId: 'hld-define' })

    assert.deepEqual(status.stage, { id: 'hld-define', title: 'HLD Definition', gate: 'hld-tac-approved' })
    assert.equal(status.complete, false)
    const hldSubmission = status.modules.find((m) => m.id === 'hld-submission')
    assert.equal(hldSubmission.exists, false)
  })
})

test('an unknown stageId throws', () => {
  assert.throws(() => getStatus('examples', { stageId: 'not-a-real-stage' }), /has no stage/)
})

// --- Azure DevOps-backed instances (#86) ---------------------------------
//
// getStatus/evaluateStage's second storage backend, exercised the same way
// tests/instance.test.js exercises lib/instance.js's — a fake in-process
// Azure DevOps server, never the real dev.azure.com.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function azureDevOpsOptions(baseUrl) {
  return { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
}

test('getStatus against Azure DevOps reports the same shape as the local path, with a module missing entirely from the fake repo reported as not existing', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
        '/modules/context.md': '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nDone.\n',
      },
    },
    async (baseUrl) => {
      const azureDevOps = azureDevOpsOptions(baseUrl)
      const status = await getStatus('my-initiative', { azureDevOps })

      assert.equal(status.slug, 'my-initiative')
      assert.equal(status.definition, 'design')
      assert.deepEqual(status.stage, { id: 'shape', title: 'Shape', gate: 'business-case' })
      assert.equal(status.complete, false)

      const context = status.modules.find((m) => m.id === 'context')
      assert.equal(context.exists, true)
      assert.deepEqual(context.outstanding, ['affected-domains'])

      // "team-and-estimates" has no file at all in the fake repo.
      const teamAndEstimates = status.modules.find((m) => m.id === 'team-and-estimates')
      assert.equal(teamAndEstimates.exists, false)
      assert.deepEqual(teamAndEstimates.outstanding, ['teams-and-contacts', 'estimates'])
    }
  )
})

test('getStatus stays a plain synchronous return with no options.azureDevOps given', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const status = getStatus('my-initiative', { instancesDir })
    assert.equal(status instanceof Promise, false)
  })
})

// Regression test for a review finding: evaluateStage's Azure-DevOps-backed
// path used to silently ignore `options.strict`, so a parser anomaly (a
// heading matching no field) would be swallowed rather than throwing — the
// same anomaly throws on the local path when `strict: true` (`check`'s own
// contract). `readModule` (lib/instance.js) now forwards `options.strict`
// to `parseModuleFile` on both storage backends, so this must throw here
// exactly as the equivalent local-path call does.
test('evaluateStage in strict mode over Azure DevOps throws on a parser anomaly, instead of silently ignoring strict', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
        '/modules/context.md':
          '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Not A Real Field\n\nWhatever.\n',
      },
    },
    async (baseUrl) => {
      const azureDevOps = azureDevOpsOptions(baseUrl)
      const definition = loadDefinition('design')
      const stage = definition.stages.find((s) => s.id === 'shape')

      await assert.rejects(
        () => evaluateStage(definition, stage, 'my-initiative', { azureDevOps, strict: true }),
        /does not match any field/
      )
    }
  )
})
