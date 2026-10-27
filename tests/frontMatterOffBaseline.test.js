import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderArtefact } from '../lib/render.js'
import { loadDefinition } from '../lib/definition.js'
import { writeModule } from '../lib/instance.js'

// #194 (spec #192, ADR-0052): `cover-page` and `table-of-contents` are opt-in, so a Definition that
// sets neither must compile every Artefact to exactly the Markdown it compiled to before the keys
// existed. The baseline below was recorded from the compile step as it stood before #194; this test
// compiles every Artefact of every packaged Definition version that must not change (design v1 and
// v2, recruitment-onboarding v1–v3) and compares a SHA-256 of the Markdown against it. The `.docx` is
// Pandoc's conversion of that Markdown with the same arguments as before, so identical Markdown
// means an identical document.
//
// The instance content is generated here rather than borrowed from the bundled examples, which the
// design v3 work is migrating: every Field of every Module gets a fixed value of its own type, so
// every template prints every section and nothing outside this file can move the baseline. The
// commit is fixed too, since Document Control prints it.
//
// Regenerate the baseline (UPDATE_FRONT_MATTER_BASELINE=1) only for a deliberate change to one of
// these Definitions' templates — which the spec rules out for all five.

const BASELINE_PATH = 'tests/fixtures/front-matter-off-baseline.json'
const DEFINITIONS = [['design', 1], ['design', 2], ['recruitment-onboarding', 1], ['recruitment-onboarding', 2], ['recruitment-onboarding', 3]]
const COMMIT = { hash: 'abc1234', fullHash: 'abc1234def5678abc1234def5678abc1234def5', date: '2026-01-02' }
const SLUG = 'front-matter-off'

function fieldValue(moduleId, field) {
  if (field.type === 'select') return field.options[0]
  if (field.type === 'date') return '2026-03-04'
  if (field.type === 'text') return `${moduleId} ${field.id}`
  if (field.type === 'list') return `- First ${field.id}\n- Second ${field.id}`
  return `Sample ${field.title ?? field.id} for ${moduleId}.\n\nA second paragraph with **emphasis** and a [link](https://example.com).`
}

function compileEveryArtefact(definitionId, version) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-front-matter-off-'))
  try {
    const definition = loadDefinition(definitionId, { version })
    mkdirSync(join(instancesDir, SLUG, 'modules'), { recursive: true })
    writeFileSync(
      join(instancesDir, SLUG, 'instance.yaml'),
      `definition: ${definitionId}\nslug: ${SLUG}\nname: Front Matter Off\nstage: ${definition.stages[0].id}\nassignee: a.author\ndefinitionVersion: ${version}\n`
    )
    for (const [moduleId, moduleSpec] of definition.modules) {
      const fields = Object.fromEntries(moduleSpec.fields.map((field) => [field.id, fieldValue(moduleId, field)]))
      writeModule(definition, SLUG, moduleId, { fields }, { instancesDir })
    }
    const compiled = {}
    for (const artefact of definition.artefacts) {
      const { markdown } = renderArtefact(SLUG, artefact.id, { dryRun: true, instancesDir, definitionsDir: 'definitions', commit: COMMIT })
      compiled[`${definitionId}/${version}/${artefact.id}`] = createHash('sha256').update(markdown).digest('hex')
    }
    return compiled
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('with neither cover-page nor table-of-contents, every Artefact of design v1/v2 and recruitment-onboarding compiles byte-for-byte as before', () => {
  const actual = Object.assign({}, ...DEFINITIONS.map(([id, version]) => compileEveryArtefact(id, version)))
  if (process.env.UPDATE_FRONT_MATTER_BASELINE === '1') {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(baseline).sort(), 'the same Artefacts compile')
  for (const [key, hash] of Object.entries(baseline)) {
    assert.equal(actual[key], hash, `${key} compiles to different Markdown than before`)
  }
})
