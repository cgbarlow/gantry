import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
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

test('passes the example-soap fixture against its current stage', () => {
  const result = checkGate('example-soap')
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
