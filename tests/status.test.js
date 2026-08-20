import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { getStatus } from '../lib/status.js'

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

test('the example-soap fixture is complete', () => {
  const status = getStatus('example-soap')
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
  assert.throws(() => getStatus('example-soap', { stageId: 'not-a-real-stage' }), /has no stage/)
})
