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

// #87 (ADR-0045): filename: pattern resolution — still the one naming seam. An artefact with
// no pattern (patternContext.pattern undefined/blank) keeps the WI226 default exercised above.

test('renderedArtefactBasename ignores an absent or blank pattern and falls back to the WI226 default', () => {
  assert.equal(
    renderedArtefactBasename('ATLAS Reference Design', 'High Level Design', {}),
    'ATLAS Reference Design - High Level Design'
  )
  assert.equal(
    renderedArtefactBasename('ATLAS Reference Design', 'High Level Design', { pattern: '' }),
    'ATLAS Reference Design - High Level Design'
  )
  assert.equal(
    renderedArtefactBasename('ATLAS Reference Design', 'High Level Design', { pattern: '   ' }),
    'ATLAS Reference Design - High Level Design'
  )
})

test('a pattern resolves {module.field} tokens against the already-fetched modules data', () => {
  const modules = { selection: { 'candidate-name': 'Jane Smith' }, offer: { 'start-date': '2026-11-03' } }
  assert.equal(
    renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', {
      pattern: '{selection.candidate-name} - Offer - {offer.start-date}',
      modules,
    }),
    'Jane Smith - Offer - 2026-11-03'
  )
})

test('a pattern can reference {instance.name}, {instance.slug} and {today}', () => {
  assert.equal(
    renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', {
      pattern: '{instance.name} ({instance.slug}) — {today}',
      instanceSlug: 'senior-platform-engineer',
      today: '2026-09-21',
    }),
    'Senior Platform Engineer (senior-platform-engineer) — 2026-09-21'
  )
})

test('{today} defaults to the current date when not supplied — the date of THIS call, not a frozen one', () => {
  const today = new Date().toISOString().slice(0, 10)
  assert.equal(
    renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', { pattern: '{today}' }),
    today
  )
})

test('ADR-0045 §5: an empty token is dropped and its surrounding separators tidied, not left as a literal gap', () => {
  assert.equal(
    renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', {
      pattern: '{selection.candidate-name} - Offer Pack',
      modules: { selection: {} },
    }),
    'Offer Pack'
  )
  // A token naming a module that was never fetched at all (e.g. an optional
  // requirement whose module was never saved) resolves the same way — blank, not a crash.
  assert.equal(
    renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', {
      pattern: '{selection.candidate-name} - Offer Pack',
    }),
    'Offer Pack'
  )
})

test('a pattern-resolved name is still sanitised — path-hostile characters replaced', () => {
  assert.equal(
    renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', {
      pattern: '{selection.candidate-name} - Offer',
      modules: { selection: { 'candidate-name': 'Jane / Smith' } },
    }),
    'Jane - Smith - Offer'
  )
})

test('a pattern-resolved name longer than 200 characters is capped, without leaving a dangling separator', () => {
  const longName = 'A'.repeat(250)
  const result = renderedArtefactBasename('Senior Platform Engineer', 'Offer Pack', {
    pattern: '{selection.candidate-name} - Offer Pack',
    modules: { selection: { 'candidate-name': longName } },
  })
  assert.ok(result.length <= 200, `expected length <= 200, got ${result.length}`)
  assert.equal(result, 'A'.repeat(200))
  assert.doesNotMatch(result, /[\s-]$/)
})
