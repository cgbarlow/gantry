import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderUserGuide } from '../lib/userGuide.js'

// #194: the User Guide's Stages & Gates / Artefacts & Rendering sections are
// expanded from the loaded `design` definition. These are plain lib-function
// tests against `renderUserGuide` directly (rather than through the
// server/playwright seam) so the fallback and escaping branches — which are
// hard to provoke through the real `design` definition, since every stage
// and artefact in it has a well-formed `purpose` and plain-text `id`/`gate`
// values — are exercised directly.

const STAGES_MARKER = '<!-- GANTRY-DESIGN-STAGES -->'
const ARTEFACTS_MARKER = '<!-- GANTRY-DESIGN-ARTEFACTS -->'

function markdown() {
  return `# Guide\n\n${STAGES_MARKER}\n\n${ARTEFACTS_MARKER}\n`
}

test('renderUserGuide: falls back to a default purpose when a stage has none defined', () => {
  const definition = {
    id: 'design',
    stages: [{ title: 'Discovery', id: 'discovery', gate: 'approved' }],
    artefacts: [],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /No purpose is defined for this item\./)
})

test('renderUserGuide: falls back to a default purpose when a stage purpose is blank/whitespace-only', () => {
  const definition = {
    id: 'design',
    stages: [{ title: 'Discovery', id: 'discovery', gate: 'approved', purpose: '   ' }],
    artefacts: [],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /No purpose is defined for this item\./)
})

test('renderUserGuide: falls back to a default purpose when an artefact has none defined', () => {
  const definition = {
    id: 'design',
    stages: [],
    artefacts: [{ title: 'Solution Brief', id: 'solution-brief', gate: 'approved', requires: [] }],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /No purpose is defined for this item\./)
})

test('renderUserGuide: uses the real stage/artefact purpose when one is defined', () => {
  const definition = {
    id: 'design',
    stages: [{ title: 'Discovery', id: 'discovery', gate: 'approved', purpose: 'Shape the initiative.' }],
    artefacts: [{ title: 'Brief', id: 'brief', gate: 'approved', purpose: 'Capture the ask.', requires: [] }],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /Shape the initiative\./)
  assert.match(result, /Capture the ask\./)
  assert.doesNotMatch(result, /No purpose is defined for this item\./)
})

test('renderUserGuide: escapes backticks in ids and gates so inline code spans stay well-formed', () => {
  const definition = {
    id: 'design`x',
    stages: [{ title: 'Discovery', id: 'stage`id', gate: 'gate`name', purpose: 'p' }],
    artefacts: [],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /stage\\`id/)
  assert.match(result, /gate\\`name/)
  assert.match(result, /design\\`x/)
})

test('renderUserGuide: lists each of an artefact\'s requirements as its own bullet', () => {
  const definition = {
    id: 'design',
    stages: [],
    artefacts: [{ title: 'Brief', id: 'brief', gate: 'approved', purpose: 'p', requires: ['context.driver', 'context.scope'] }],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /^ {2}- `context\.driver`$/m)
  assert.match(result, /^ {2}- `context\.scope`$/m)
})

test('renderUserGuide: renders an artefact with no requirements without error', () => {
  const definition = {
    id: 'design',
    stages: [],
    artefacts: [{ title: 'Brief', id: 'brief', gate: 'approved', purpose: 'p', requires: [] }],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /- Requires:/)
})

test('renderUserGuide: replaces both markers, leaving the surrounding markdown intact', () => {
  const definition = { id: 'design', stages: [], artefacts: [] }
  const result = renderUserGuide(markdown(), definition)
  assert.doesNotMatch(result, /GANTRY-DESIGN-STAGES/)
  assert.doesNotMatch(result, /GANTRY-DESIGN-ARTEFACTS/)
  assert.match(result, /^# Guide/)
  assert.match(result, /### Stages in the `design` definition/)
  assert.match(result, /### Artefacts in the `design` definition/)
})

test('renderUserGuide: joins multiple stages and artefacts with a blank line between entries', () => {
  const definition = {
    id: 'design',
    stages: [
      { title: 'Discovery', id: 'discovery', gate: 'approved', purpose: 'p1' },
      { title: 'Design', id: 'design-stage', gate: 'approved', purpose: 'p2' },
    ],
    artefacts: [
      { title: 'Brief', id: 'brief', gate: 'approved', purpose: 'p1', requires: [] },
      { title: 'Plan', id: 'plan', gate: 'approved', purpose: 'p2', requires: ['context.driver'] },
    ],
  }
  const result = renderUserGuide(markdown(), definition)
  assert.match(result, /#### Discovery \(`discovery`\)[\s\S]*#### Design \(`design-stage`\)/)
  assert.match(result, /#### Brief \(`brief`\)[\s\S]*#### Plan \(`plan`\)/)
})
