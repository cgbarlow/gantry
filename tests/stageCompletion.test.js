import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCompletedStage, completedStageRefusal } from '../web/lib/stageCompletion.js'

// #142: shape/hld-define/detailed-design, in that order — mirrors the `design` definition's own
// stage order (shape < hld-define < detailed-design).
const STAGES = [{ id: 'shape', title: 'Shape' }, { id: 'hld-define', title: 'HLD' }, { id: 'detailed-design', title: 'Detailed Design' }]

test('isCompletedStage: a Stage earlier than the instance\'s current Stage is completed', () => {
  assert.equal(isCompletedStage(STAGES, 'shape', 'hld-define'), true)
  assert.equal(isCompletedStage(STAGES, 'shape', 'detailed-design'), true)
})

test('isCompletedStage: the current Stage itself, and any later Stage, are not completed', () => {
  assert.equal(isCompletedStage(STAGES, 'hld-define', 'hld-define'), false)
  assert.equal(isCompletedStage(STAGES, 'detailed-design', 'hld-define'), false)
})

test('isCompletedStage: an unknown Stage id on either side is never completed', () => {
  assert.equal(isCompletedStage(STAGES, 'bogus', 'hld-define'), false)
  assert.equal(isCompletedStage(STAGES, 'shape', 'bogus'), false)
})

test('completedStageRefusal: null for the current Stage and any later Stage', () => {
  assert.equal(completedStageRefusal(STAGES, { id: 'hld-define', title: 'HLD' }, 'hld-define'), null)
  assert.equal(completedStageRefusal(STAGES, { id: 'detailed-design', title: 'Detailed Design' }, 'hld-define'), null)
})

test('completedStageRefusal: names the Stage and points at Re-open for a completed Stage', () => {
  const refusal = completedStageRefusal(STAGES, { id: 'shape', title: 'Shape' }, 'hld-define')
  assert.match(refusal, /^Stage "Shape" \(shape\) is complete — it shows the approved version on main\./)
  assert.match(refusal, /Re-open it to make further edits\.$/)
})

test('completedStageRefusal: falls back to the Stage id when it carries no title', () => {
  const refusal = completedStageRefusal(STAGES, { id: 'shape' }, 'hld-define')
  assert.match(refusal, /^Stage "shape" \(shape\) is complete/)
})
