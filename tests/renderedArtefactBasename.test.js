import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  titleCaseSlug,
  instanceDisplayName,
  sanitiseRenderFilename,
  renderedArtefactBasename,
} from '../lib/instance.js'

// WI226: rendered artefacts are written locally and pushed to Azure DevOps as
// "<Instance name> - <Full artefact title>.docx". These pure helpers build
// that basename; the instance name falls back to a title-cased slug.

test('titleCaseSlug upper-cases short words and known acronyms, capitalises the rest', () => {
  assert.equal(titleCaseSlug('atlas-reference-design'), 'ATLAS Reference Design')
  assert.equal(titleCaseSlug('my-initiative'), 'MY Initiative')
  assert.equal(titleCaseSlug('hld-review-board'), 'HLD Review Board')
  assert.equal(titleCaseSlug('remote-initiative'), 'Remote Initiative')
  assert.equal(titleCaseSlug('api-db-nfr'), 'API DB NFR')
  assert.equal(titleCaseSlug('single'), 'Single')
  assert.equal(titleCaseSlug(''), '')
})

test('instanceDisplayName prefers an explicit name, otherwise falls back to the title-cased slug', () => {
  assert.equal(instanceDisplayName({ name: 'ATLAS Reference Design', slug: 'atlas-reference-design' }), 'ATLAS Reference Design')
  assert.equal(instanceDisplayName({ slug: 'atlas-reference-design' }), 'ATLAS Reference Design')
  assert.equal(instanceDisplayName({ name: '  ', slug: 'remote-initiative' }), 'Remote Initiative')
  assert.equal(instanceDisplayName({ name: 'Custom Name', slug: 'whatever' }), 'Custom Name')
})

test('sanitiseRenderFilename replaces path-separator / unsafe characters with "-", collapses repeats, trims', () => {
  assert.equal(sanitiseRenderFilename('Detailed Design / As-built'), 'Detailed Design - As-built')
  assert.equal(sanitiseRenderFilename('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(sanitiseRenderFilename('trailing / '), 'trailing')
  assert.equal(sanitiseRenderFilename('  multiple   spaces  '), 'multiple spaces')
})

test('renderedArtefactBasename joins the instance name and full artefact title', () => {
  assert.equal(
    renderedArtefactBasename('ATLAS Reference Design', 'High Level Design'),
    'ATLAS Reference Design - High Level Design'
  )
  assert.equal(
    renderedArtefactBasename('ATLAS Reference Design', 'Detailed Design / As-built'),
    'ATLAS Reference Design - Detailed Design - As-built'
  )
})
