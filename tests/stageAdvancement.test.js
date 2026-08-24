import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readInstance, updateInstanceAssignee } from '../lib/instance.js'
import { advanceStage } from '../lib/stageAdvancement.js'

// #115 (ADR-0012's local-instance self-serve mode): "Advance to next
// stage" moves a *local* instance's own persisted `stage` pointer forward
// by one, gated on the current stage's gate having genuinely passed —
// re-checked server-side, never trusted from an earlier client-side check.
// Plain lib-function tests against `advanceStage` directly, per this
// ticket's own testing decisions (prefer the lib-function seam).

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    return fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// Fills a stage's modules with the `examples` fixture's own real content,
// so that stage's gate genuinely passes — mirrors
// tests/workItemLink.test.js's own `fillShapeStage` helper.
function fillStageModules(instancesDir, slug, moduleIds) {
  for (const moduleId of moduleIds) {
    cpSync(join('instances', 'examples', 'modules', `${moduleId}.md`), join(instancesDir, slug, 'modules', `${moduleId}.md`))
  }
}

const SHAPE_MODULES = ['context', 'solution-definition', 'team-and-estimates']

test('throws, and writes nothing, when the current stage\'s gate has not passed', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    assert.throws(() => advanceStage('my-initiative', { instancesDir }), /has not passed/)

    // Genuinely untouched — still at the stage it was created at.
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'shape')
  })
})

test('the thrown error names the outstanding modules', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    assert.throws(() => advanceStage('my-initiative', { instancesDir }), /outstanding:/)
  })
})

test('moves the instance to the next stage once the current gate has passed, preserving every other instance.yaml field', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    updateInstanceAssignee('my-initiative', 'c.barlow', { instancesDir })
    fillStageModules(instancesDir, 'my-initiative', SHAPE_MODULES)

    const result = advanceStage('my-initiative', { instancesDir })

    assert.deepEqual(result.fromStage, { id: 'shape', title: 'Shape', gate: 'business-case' })
    assert.deepEqual(result.toStage, { id: 'hld-define', title: 'HLD Definition', gate: 'hld-tac-approved' })

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'hld-define')
    // Every other field survives the write untouched.
    assert.equal(instance.definition, 'design')
    assert.equal(instance.slug, 'my-initiative')
    assert.equal(instance.assignee, 'c.barlow')
  })
})

test('throws, and writes nothing, once the instance is already at its definition\'s final stage', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillStageModules(instancesDir, 'my-initiative', SHAPE_MODULES)
    advanceStage('my-initiative', { instancesDir }) // shape -> hld-define

    fillStageModules(instancesDir, 'my-initiative', [
      'hld-submission',
      'problem-statement',
      'proposed-solution',
      'alternatives-considered',
      'open-questions',
      'nfrs',
      'risks',
      'security',
      'dependencies',
    ])
    advanceStage('my-initiative', { instancesDir }) // hld-define -> detailed-design

    fillStageModules(instancesDir, 'my-initiative', [
      'architecture',
      'integration',
      'data',
      'nfrs',
      'security',
      'risks',
      'dependencies',
      'support-and-operations',
    ])
    advanceStage('my-initiative', { instancesDir }) // detailed-design -> handover

    fillStageModules(instancesDir, 'my-initiative', ['as-built-notes'])
    assert.throws(() => advanceStage('my-initiative', { instancesDir }), /already at its final stage/)

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'handover')
  })
})
