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
// existed. This test compiles every Artefact of every packaged Definition version that must not
// change (design v1 and v2, recruitment-onboarding v1–v3) and compares SHA-256 hashes against the
// baseline below, for both texts the compile step returns:
//   - `markdown`, the exported `.md`;
//   - `docxMarkdown`, the text both render paths convert to Word (native Pandoc and pandoc-wasm).
// Pandoc converts that text with the same arguments as before, so an identical `docxMarkdown` means
// an identical document. The Word text has to be checked on its own: design v3's Word-only steps
// (diagram numbering, #195; unnumbered headings, #197) run in the same compile step for every
// Definition, and a slip in their opt-in would leave `markdown` unchanged while the `.docx` changed.
//
// Two instances are compiled per Definition version:
//   - "plain": every Field of every Module gets a fixed value of its own type, so every template
//     prints every section;
//   - "authored": the same, but every long-text Field also carries what design v3 gives a meaning
//     in Word — a heading marked `{.unnumbered}` with bold text, an anchor and a link to it, a
//     `{-}` heading, and a Mermaid block captioned on its fence. On these Definitions none of that
//     may change the Word text.
// The content is generated here rather than borrowed from the bundled examples, which the design v3
// work is migrating, so nothing outside this file can move the baseline. The commit is fixed too,
// since Document Control prints it.
//
// The baseline was recorded from origin/main at 0.9.26-beta, before any of spec #192, where the Word
// conversion was handed `markdown` itself — so each `docxMarkdown` hash there is that release's
// `markdown` hash. Regenerate it (UPDATE_FRONT_MATTER_BASELINE=1) only for a deliberate change to one
// of these Definitions' templates — which the spec rules out for all five.

const BASELINE_PATH = 'tests/fixtures/front-matter-off-baseline.json'
const DEFINITIONS = [['design', 1], ['design', 2], ['recruitment-onboarding', 1], ['recruitment-onboarding', 2], ['recruitment-onboarding', 3]]
const COMMIT = { hash: 'abc1234', fullHash: 'abc1234def5678abc1234def5678abc1234def5', date: '2026-01-02' }

function plainValue(moduleId, field) {
  if (field.type === 'select') return field.options[0]
  if (field.type === 'date') return '2026-03-04'
  if (field.type === 'text') return `${moduleId} ${field.id}`
  if (field.type === 'list') return `- First ${field.id}\n- Second ${field.id}`
  return `Sample ${field.title ?? field.id} for ${moduleId}.\n\nA second paragraph with **emphasis** and a [link](https://example.com).`
}

function authoredValue(moduleId, field) {
  const plain = plainValue(moduleId, field)
  if (['select', 'date', 'text', 'list'].includes(field.type)) return plain
  const anchor = `${moduleId}-${field.id}-flows`
  return [
    plain,
    `### Data **flows** and [CIS](https://example.com/cis) {#${anchor} .unnumbered}`,
    `See [the flows](#${anchor}).`,
    `#### Revision notes {-}`,
    '```mermaid {caption="Data flows"}\nflowchart LR\n  A --> B\n```',
  ].join('\n\n')
}

const INSTANCES = { plain: ['front-matter-off', plainValue], authored: ['front-matter-off-authored', authoredValue] }

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function compileEveryArtefact(definitionId, version, kind) {
  const [slug, fieldValue] = INSTANCES[kind]
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-front-matter-off-'))
  try {
    const definition = loadDefinition(definitionId, { version })
    mkdirSync(join(instancesDir, slug, 'modules'), { recursive: true })
    writeFileSync(
      join(instancesDir, slug, 'instance.yaml'),
      `definition: ${definitionId}\nslug: ${slug}\nname: Front Matter Off\nstage: ${definition.stages[0].id}\nassignee: a.author\ndefinitionVersion: ${version}\n`
    )
    for (const [moduleId, moduleSpec] of definition.modules) {
      const fields = Object.fromEntries(moduleSpec.fields.map((field) => [field.id, fieldValue(moduleId, field)]))
      writeModule(definition, slug, moduleId, { fields }, { instancesDir })
    }
    const compiled = {}
    for (const artefact of definition.artefacts) {
      const { markdown, docxMarkdown } = renderArtefact(slug, artefact.id, { dryRun: true, instancesDir, definitionsDir: 'definitions', commit: COMMIT })
      const key = kind === 'plain' ? `${definitionId}/${version}/${artefact.id}` : `${definitionId}/${version}/${artefact.id} (${kind})`
      compiled[key] = { markdown, docxMarkdown }
    }
    return compiled
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const compiled = Object.assign(
  {},
  ...DEFINITIONS.flatMap(([id, version]) => Object.keys(INSTANCES).map((kind) => compileEveryArtefact(id, version, kind)))
)

test('with neither cover-page nor table-of-contents, every Artefact of design v1/v2 and recruitment-onboarding compiles byte-for-byte as before, for the .md and for Word', () => {
  const actual = Object.fromEntries(
    Object.entries(compiled).map(([key, { markdown, docxMarkdown }]) => [key, { markdown: sha256(markdown), docxMarkdown: sha256(docxMarkdown) }])
  )
  if (process.env.UPDATE_FRONT_MATTER_BASELINE === '1') {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(baseline).sort(), 'the same Artefacts compile')
  for (const [key, { markdown, docxMarkdown }] of Object.entries(baseline)) {
    assert.equal(actual[key].markdown, markdown, `${key} compiles to different Markdown than before`)
    assert.equal(actual[key].docxMarkdown, docxMarkdown, `${key} hands Word different text than before`)
  }
})

test('on these Definitions an authored {.unnumbered} heading and a captioned Mermaid fence reach Word exactly as written in the .md', () => {
  const authored = Object.entries(compiled).filter(([key]) => key.endsWith('(authored)'))
  assert.ok(authored.length > 0)
  let carried = 0
  for (const [key, { markdown, docxMarkdown }] of authored) {
    assert.equal(docxMarkdown, markdown, `${key}: Word is converted from the .md's own text`)
    if (/^### Data \*\*flows\*\* .*\{#[\w-]+ \.unnumbered\}$/m.test(markdown) && markdown.includes('```mermaid {caption="Data flows"}')) carried += 1
  }
  assert.ok(carried >= DEFINITIONS.length, `the authored heading and fence reach the documents (${carried} carry both)`)
})
