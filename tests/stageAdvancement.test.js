import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, readInstance, updateInstanceAssignee } from '../lib/instance.js'
import { advanceStage } from '../lib/stageAdvancement.js'
import { withScratchInstances } from './helpers/lifecycle.js'

// #115 (ADR-0012's local-instance self-serve mode): "Advance to next
// stage" moves a *local* instance's own persisted `stage` pointer forward
// by one, gated on the current stage's gate having genuinely passed —
// re-checked server-side, never trusted from an earlier client-side check.
// Plain lib-function tests against `advanceStage` directly, per this
// ticket's own testing decisions (prefer the lib-function seam).


// Fills a stage's modules with the `examples` fixture's own real content,
// so that stage's gate genuinely passes — mirrors
// tests/workItemLink.test.js's own `fillShapeStage` helper.
function fillStageModules(instancesDir, slug, moduleIds) {
  for (const moduleId of moduleIds) {
    cpSync(join('instances', 'examples', 'modules', `${moduleId}.md`), join(instancesDir, slug, 'modules', `${moduleId}.md`))
  }
}

const SHAPE_MODULES = ['background', 'introduction', 'solution-definition', 'team-and-estimates']

test('throws, and writes nothing, when the current stage\'s gate has not passed', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    assert.throws(() => advanceStage('my-initiative', { instancesDir }), /has not passed/)

    // Genuinely untouched — still at the stage it was created at.
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'shape')
  })
})

test('the thrown error names the outstanding modules', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    assert.throws(() => advanceStage('my-initiative', { instancesDir }), /outstanding:/)
  })
})

test('moves the instance to the next stage once the current gate has passed, preserving every other instance.yaml field', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    updateInstanceAssignee('my-initiative', 'c.barlow', { instancesDir })
    fillStageModules(instancesDir, 'my-initiative', SHAPE_MODULES)

    const result = advanceStage('my-initiative', { instancesDir })

    assert.deepEqual(result.fromStage, { id: 'shape', title: 'SOAP', gate: 'business-case' })
    assert.deepEqual(result.toStage, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' })

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'hld-define')
    // Every other field survives the write untouched.
    assert.equal(instance.definition, 'design')
    assert.equal(instance.slug, 'my-initiative')
    assert.equal(instance.assignee, 'c.barlow')
  })
})

test('throws, and writes nothing, once the instance is already at its definition\'s final stage', async () => {
  await withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillStageModules(instancesDir, 'my-initiative', SHAPE_MODULES)
    advanceStage('my-initiative', { instancesDir }) // shape -> hld-define

    fillStageModules(instancesDir, 'my-initiative', [
      'hld-submission',
      'background',
      'proposed-solution',
      'alternatives-considered',
      'open-questions',
      'nfrs',
      'risks',
      'security',
      'dependencies',
      'introduction',
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
      'glossary', // WI #227: shared module now referenced by the sad/ssad artefacts
      // WI #228: introduction / recovery-plan / data-security-controls are now
      // shared into detailed-design and the sad artefact's `requires`, so the
      // build-ready-checklist gate needs their gating fields filled too.
      'introduction',
      'recovery-plan',
      'data-security-controls',
    ])
    advanceStage('my-initiative', { instancesDir }) // detailed-design -> handover

    // WI #227: the handover stage's module set is the shared glossary / introduction /
    // recovery-plan / data-security-controls plus as-built-notes.
    fillStageModules(instancesDir, 'my-initiative', [
      'glossary',
      'introduction',
      'as-built-notes',
      'recovery-plan',
      'data-security-controls',
    ])
    assert.throws(() => advanceStage('my-initiative', { instancesDir }), /already at its final stage/)

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'handover')
  })
})
