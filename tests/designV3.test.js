import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadDefinition, loadDefinitionChangelog, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, readInstance, readModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #193 (spec #192): the harness every design v3 ticket extends. `definitions/design/3` starts as a
// draft copy of v2, and the two bundled design examples in workspaces/examples move onto it — the
// recruitment-onboarding v3 precedent (#153, #186), except that the examples are migrated in place
// from the start rather than through a test fixture, because #192 builds v3's example conventions
// into the bundled examples themselves.
//
// Tables drive it, so a later ticket changes a row rather than adding a test:
//   - EXAMPLES: each bundled example instance and the Gates it passes on v3.
//   - DOCUMENTS: every v3 Artefact, the example that renders it, its rendered filename and its
//     opening heading.
// A ticket that changes the Definition migrates the examples alongside it, so every Gate still
// passes and every Artefact still renders.
//
// Sections, in order: the draft itself; the examples on v3; rendering every Artefact. Later tickets
// add their own `describe` block after these (front matter, Word styles, captions, guidance and
// example conventions, target size), keyed by ticket number.
//
// A ticket that adds a Module to v3 lists it in V3_ADDED_MODULES, so the copy-of-v2 checks below
// keep comparing everything else with v2.

const DEFINITION = 'design'
const VERSION = 3
const EXAMPLES_DIR = 'workspaces/examples'

// The Gates each bundled example passes on v3, and the classification its documents carry (#196).
// Kiwi Cover Mutual is the full worked design, filled in at every Stage; the gantry instance is
// Gantry's own hosting proposal, a complete Full SOAP at the Shape stage only.
const EXAMPLES = {
  'kiwi-cover-mutual': {
    name: 'Kiwi Cover Mutual',
    classification: 'IN-CONFIDENCE',
    gates: ['business-case', 'hld-arb-approved', 'build-ready-checklist', 'operational-handover'],
  },
  gantry: { name: 'Gantry hosting', classification: 'IN-CONFIDENCE', gates: ['business-case'] },
}

// Modules v3 has that v2 doesn't, each added by the ticket named.
const V3_ADDED_MODULES = {
  'document-handling': 196,
}

// Each Stage's "Populate example text" source: the one example that covers every Stage.
const STAGE_EXAMPLE = 'kiwi-cover-mutual'

// Every v3 Artefact, rendered from the example named here. `heading` is the document's first heading,
// section 1: since #196 the title is on the cover, and no template opens with a title line of its own.
const DOCUMENTS = {
  soap: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution on a Page', heading: '# Background and context' },
  'soap-full': { example: 'gantry', basename: 'Gantry hosting - Full Solution on a Page', heading: '# Metadata' },
  hld: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - High Level Design', heading: '# Submission' },
  sad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Architecture Document', heading: '# Overview' },
  ssad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Support Architecture Document', heading: '# Logical components' },
  'as-built': { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - As-built', heading: '# Terms & Definitions' },
}

// v1 and v2 must stay byte-for-byte as published: a SHA-256 over each version folder's files
// (sorted relative path, then contents). Never update these to make a test pass — a mismatch means
// a published version was edited.
const PUBLISHED_DIGESTS = {
  1: '0ae25f645898869d4274b3b9d1f80978dcb543ee21a9a18ade91378bdc6577ca',
  2: 'e3d5fea9932e877ec79e91fa5b7d4e9e2085718070572d71eaecf7f095c9b0bb',
}

// A Field value is a string, or an array of rows for a table Field.
function hasContent(value) {
  return Array.isArray(value) ? value.length > 0 : /\S/.test(value ?? '')
}

function v3() {
  return loadDefinition(DEFINITION, { version: VERSION })
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]
  )
}

function folderDigest(dir) {
  const hash = createHash('sha256')
  for (const file of filesUnder(dir).map((f) => relative(dir, f)).sort()) {
    hash.update(`${file}\0`)
    hash.update(readFileSync(join(dir, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-design-v3-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-design-v3-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Renders a real Word document from a scratch copy of the bundled example (the render never writes
// into workspaces/), returning the render result and the docx's word/document.xml.
function renderWord(example, artefactId) {
  return withScratchDir((dir) => {
    cpSync(join(EXAMPLES_DIR, example), join(dir, example), { recursive: true })
    rmSync(join(dir, example, 'out'), { recursive: true, force: true })
    const result = renderArtefact(example, artefactId, { instancesDir: dir, deliverToClient: true })
    const docxPath = join(dir, `${artefactId}.docx`)
    writeFileSync(docxPath, result.docxBytes)
    const documentXml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { result, documentXml }
  })
}

describe('design v3 is a draft copy of v2 (#193)', () => {
  test('v3 is a draft, and v1 and v2 stay published', () => {
    assert.equal(v3().status, 'draft')
    assert.equal(v3().version, VERSION)
    assert.equal(loadDefinition(DEFINITION, { version: 1 }).status, 'published')
    assert.equal(loadDefinition(DEFINITION, { version: 2 }).status, 'published')
  })

  test('a new design Instance still pins v2, the latest published version', () => {
    withScratchDir((instancesDir) => {
      createInstance(DEFINITION, 'new-initiative', { instancesDir })
      assert.equal(readInstance('new-initiative', { instancesDir }).definitionVersion, 2)
    })
  })

  test('findDefinitionProblems reports zero problems for design/3', () => {
    assert.deepEqual(findDefinitionProblems(DEFINITION, { version: VERSION }), [])
  })

  test('findLocalDefinitionProblems (Local Workspace twin) also reports zero problems for v3', () => {
    assert.deepEqual(findLocalDefinitionProblems(definitionVersionProjection(v3())), [])
  })

  test('v1 and v2 are byte-for-byte unchanged', () => {
    for (const [version, digest] of Object.entries(PUBLISHED_DIGESTS)) {
      assert.equal(folderDigest(join('definitions', DEFINITION, version)), digest, `definitions/design/${version} changed`)
    }
  })

  test('v3 has the same Stages, Gates, Artefacts and Modules as v2, plus the Modules later tickets add', () => {
    const v2 = loadDefinition(DEFINITION, { version: 2 })
    const v2Modules = (ids) => ids.filter((id) => !(id in V3_ADDED_MODULES))
    const outline = (def) => ({
      stages: def.stages.map((s) => [s.id, s.gate, v2Modules(s.modules)]),
      artefacts: def.artefacts.map((a) => [a.id, a.title]),
      modules: v2Modules([...def.modules.keys()]).sort(),
    })
    assert.deepEqual(outline(v3()), outline(v2))
    for (const id of Object.keys(V3_ADDED_MODULES)) assert.ok(v3().modules.has(id), `v3 has ${id}`)
  })

  test('the v3 CHANGELOG opens with a draft v3 section citing the parent spec, with the v2 and v1 history below it', () => {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    const sections = [...changelog.matchAll(/^## (v\d+)\b/gm)].map((m) => m[1])
    assert.deepEqual(sections, ['v3', 'v2', 'v1'])
    const v3Section = changelog.slice(0, changelog.indexOf('\n## v2'))
    assert.match(v3Section, /#192/)
    assert.match(v3Section, /\*\*Status: draft\b/)
    // The history below is v2's own CHANGELOG, carried whole.
    assert.ok(changelog.endsWith(loadDefinitionChangelog(DEFINITION, 2)), 'v2\'s CHANGELOG follows the v3 section')
  })
})

describe('the design examples are on v3 (#193)', () => {
  for (const [slug, { gates }] of Object.entries(EXAMPLES)) {
    test(`${slug} is pinned to v3`, () => {
      const instance = readInstance(slug, { instancesDir: EXAMPLES_DIR })
      assert.equal(instance.definition, DEFINITION)
      assert.equal(instance.definitionVersion, VERSION)
    })

    for (const gate of gates) {
      test(`${slug} passes ${gate} on v3`, () => {
        const result = checkGate(slug, { instancesDir: EXAMPLES_DIR, gate })
        assert.equal(result.pass, true, JSON.stringify(result.artefacts.map((a) => [a.id, a.outstanding])))
      })
    }
  }

  test(`every v3 Stage's example is ${STAGE_EXAMPLE}, the bundled example that covers every Stage`, () => {
    for (const stage of v3().stages) {
      assert.equal(stage.example, STAGE_EXAMPLE, stage.id)
      for (const moduleId of stage.modules) {
        assert.ok(existsSync(join(EXAMPLES_DIR, STAGE_EXAMPLE, 'modules', `${moduleId}.md`)), `${stage.id}: ${moduleId} has example text`)
      }
    }
  })

  test('"Populate example text" on a new v3 Instance fills from the bundled example in the Examples workspace', async () => {
    await withScratchDirAsync(async (root) => {
      cpSync(EXAMPLES_DIR, join(root, 'examples'), { recursive: true })
      createInstance(DEFINITION, 'new-sad', { instancesDir: join(root, 'examples'), version: VERSION })
      await withRunningServer({ instancesDir: root }, async (base) => {
        for (const stage of v3().stages) {
          const res = await fetch(`${base}/api/instance?slug=new-sad&stage=${stage.id}`)
          assert.equal(res.status, 200, stage.id)
          const body = await res.json()
          assert.equal(body.hasExample, true, stage.id)
          const fields = body.modules.flatMap((m) => m.fields)
          assert.ok(fields.length > 0)
          assert.deepEqual(fields.filter((f) => hasContent(f.value)).map((f) => f.id), [], `${stage.id}: the new Instance is blank`)
          assert.ok(fields.some((f) => hasContent(f.example)), `${stage.id}: example text is offered`)
        }
      })
    })
  })

  // v2 keeps reading the same files: every Field id carries over, so the example content parses
  // the same under v2 as under v3, and v2's "Populate example text" keeps filling. A Module only v3
  // has is a file v2 never reads.
  test('the migrated example content still reads field-for-field under v2', () => {
    const v2 = loadDefinition(DEFINITION, { version: 2 })
    for (const slug of Object.keys(EXAMPLES)) {
      for (const file of readdirSync(join(EXAMPLES_DIR, slug, 'modules'))) {
        const moduleId = file.replace(/\.md$/, '')
        if (moduleId in V3_ADDED_MODULES) continue
        const underV2 = readModule(v2, slug, moduleId, { instancesDir: EXAMPLES_DIR }).fields
        const underV3 = readModule(v3(), slug, moduleId, { instancesDir: EXAMPLES_DIR }).fields
        assert.deepEqual(underV2, underV3, `${slug}/${moduleId}`)
        assert.ok(Object.values(underV2).some(hasContent), `${slug}/${moduleId} has content under v2`)
      }
    }
  })
})

describe('every v3 Artefact renders from the example data (#193)', () => {
  test('the harness covers every v3 Artefact', () => {
    assert.deepEqual(Object.keys(DOCUMENTS).sort(), v3().artefacts.map((a) => a.id).sort())
  })

  for (const [id, { example, basename, heading }] of Object.entries(DOCUMENTS)) {
    test(`${example} renders the v3 ${id}`, () => {
      const result = renderArtefact(example, id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      assert.equal(result.basename, basename)
      assert.equal(result.markdown.split('\n').find((line) => line.startsWith('# ')), heading)
      assert.match(result.markdown, /## Document Control/)
    })

    test(`${example} renders the v3 ${id} as a Word document styled from v3's reference document`, () => {
      const { result, documentXml } = renderWord(example, id)
      assert.equal(result.referenceDocPath, `definitions/design/3/templates/reference-${id}.docx`)
      assert.match(documentXml, /w:pStyle w:val="Heading1"/)
      assert.ok(documentXml.includes(basename.split(' - ').pop().replace(/&/g, '&amp;')), `${id}'s title is in the document`)
    })
  }
})

describe('v3 documents open with a cover page, a classification and a table of contents (#196)', () => {
  const CLASSIFICATION = 'document-handling.classification'
  const MARKINGS = ['UNCLASSIFIED', 'IN-CONFIDENCE', 'SENSITIVE', 'RESTRICTED']
  const PAGE_BREAK = '<w:br w:type="page"/>'

  function classificationField() {
    return v3().modules.get('document-handling').fields.find((f) => f.id === 'classification')
  }

  // The cover is everything before the first page break; the rest of the document follows it.
  function splitCover(markdown) {
    const end = markdown.indexOf(PAGE_BREAK)
    assert.ok(end > 0, 'the document opens with a cover that ends with a page break')
    return { cover: markdown.slice(0, end), rest: markdown.slice(end) }
  }

  // The text of the paragraph a cover gives the custom style `style`, or undefined.
  function coverParagraph(cover, style) {
    return new RegExp(`::: \\{custom-style="${style}"\\}\\n([\\s\\S]*?)\\n:::`).exec(cover)?.[1]
  }

  function headings(markdown) {
    return markdown.split('\n').filter((line) => /^#{1,6} /.test(line))
  }

  test('v3 has a Classification select offering exactly the four NZ Protective Security Requirements markings', () => {
    const field = classificationField()
    assert.equal(field.type, 'select')
    assert.notEqual(field.multiple, true)
    assert.deepEqual(field.options, MARKINGS)
    assert.match(field.guidance, /Protective Security Requirements/)
    assert.match(field.guidance, /replace (these|the) options with (its|their) own/i)
  })

  test('the Classification is mounted from the first Stage onward, so every Stage can set it', () => {
    for (const stage of v3().stages) assert.ok(stage.modules.includes('document-handling'), stage.id)
  })

  test('a new v3 Instance has the Classification from creation, so its first render already opens with a cover', () => {
    withScratchDir((instancesDir) => {
      createInstance(DEFINITION, 'claims-portal', { instancesDir, version: VERSION })
      assert.ok(existsSync(join(instancesDir, 'claims-portal', 'modules', 'document-handling.md')))
      const { markdown } = renderArtefact('claims-portal', 'soap', { instancesDir, dryRun: true })
      const { cover } = splitCover(markdown)
      assert.equal(coverParagraph(cover, 'Cover Classification'), undefined, 'a blank classification is left off the cover')
      assert.equal(coverParagraph(cover, 'Title'), 'Claims Portal', 'the title is the display name, the slug title-cased')
    })
  })

  test('every v3 Artefact switches on a cover page and a table of contents, its cover classification the Classification field', () => {
    for (const artefact of v3().artefacts) {
      assert.equal(artefact.coverPage, true, artefact.id)
      assert.equal(artefact.tableOfContents, true, artefact.id)
      assert.equal(artefact.coverClassification, CLASSIFICATION, artefact.id)
    }
  })

  test('no v3 template emits the instance slug in a heading', () => {
    const templates = join('definitions', DEFINITION, String(VERSION), 'templates')
    for (const file of readdirSync(templates).filter((f) => f.endsWith('.md.tmpl'))) {
      const offending = headings(readFileSync(join(templates, file), 'utf8')).filter((line) => line.includes('instance.slug'))
      assert.deepEqual(offending, [], file)
    }
  })

  for (const [slug, { classification }] of Object.entries(EXAMPLES)) {
    test(`${slug} has a classification from the option list`, () => {
      const { fields } = readModule(v3(), slug, 'document-handling', { instancesDir: EXAMPLES_DIR })
      assert.equal(fields.classification, classification)
      assert.ok(MARKINGS.includes(fields.classification))
    })
  }

  test('a classification that is not one of the markings warns, as any off-list select value does, without blocking the Gate', () => {
    withScratchDir((dir) => {
      cpSync(join(EXAMPLES_DIR, 'kiwi-cover-mutual'), join(dir, 'kiwi-cover-mutual'), { recursive: true })
      const file = join(dir, 'kiwi-cover-mutual', 'modules', 'document-handling.md')
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\nIN-CONFIDENCE\n/, '\nTOP SECRET\n'))
      const result = checkGate('kiwi-cover-mutual', { instancesDir: dir, gate: 'business-case' })
      assert.equal(result.pass, true)
      assert.ok(
        result.warnings.some((w) => /field "Classification" has a value \("TOP SECRET"\) that is not in its option list/.test(w)),
        JSON.stringify(result.warnings)
      )
    })
  })

  for (const [id, { example, heading }] of Object.entries(DOCUMENTS)) {
    const { name, classification } = EXAMPLES[example]

    test(`the v3 ${id} opens with a cover, then Document Control, then the Table of Contents, then section 1`, () => {
      const artefact = v3().artefacts.find((a) => a.id === id)
      const { markdown } = renderArtefact(example, id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      const { cover, rest } = splitCover(markdown)

      assert.equal(coverParagraph(cover, 'Cover Classification'), classification)
      assert.equal(coverParagraph(cover, 'Title'), name)
      assert.equal(coverParagraph(cover, 'Subtitle'), artefact.title)
      const details = coverParagraph(cover, 'Cover Details')
      assert.match(details, /\*\*Version:\*\* design v3 · /)
      assert.match(details, /\*\*Status:\*\* Draft/)
      assert.match(details, /\*\*Author:\*\* c\.barlow/)
      assert.equal(coverParagraph(cover, 'Cover Purpose'), artefact.purpose.replace(/\s+/g, ' ').trim())

      // Nothing from the body: no heading, no diagram, no image.
      assert.deepEqual(headings(cover), [])
      assert.doesNotMatch(cover, /```mermaid|!\[/)

      const documentControl = rest.indexOf('## Document Control')
      const contents = rest.indexOf('::: {custom-style="TOC Heading"}\nTable of Contents\n:::')
      assert.ok(documentControl > 0, 'Document Control follows the cover')
      assert.ok(contents > documentControl, 'the Table of Contents follows Document Control')
      // The Table of Contents ends with a page break; the first thing after it is section 1.
      const afterContents = rest.slice(rest.indexOf(PAGE_BREAK, contents))
      const firstLine = afterContents.split('\n').slice(2).find((line) => line.trim() !== '')
      assert.equal(firstLine, heading)
    })

    test(`no heading in the rendered v3 ${id} names the instance slug`, () => {
      const { markdown } = renderArtefact(example, id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      assert.deepEqual(headings(markdown).filter((line) => line.includes(`${example}:`) || line.includes(example)), [])
    })
  }

  test('the SAD and SSAD carry no "<slug>:" heading', () => {
    for (const id of ['sad', 'ssad']) {
      const { markdown } = renderArtefact('kiwi-cover-mutual', id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      assert.doesNotMatch(markdown, /^#+ kiwi-cover-mutual:/m, id)
    }
  })

  test('in Word, the SAD\'s cover carries the classification and the display name in the Title style, before Document Control', () => {
    const { documentXml } = renderWord('kiwi-cover-mutual', 'sad')
    const paragraphs = documentXml.split('</w:p>')
    const styled = (style, text) => paragraphs.findIndex((p) => new RegExp(`<w:pStyle w:val="${style}" ?/>`).test(p) && p.includes(`>${text}<`))
    const classificationAt = styled('CoverClassification', 'IN-CONFIDENCE')
    const titleAt = styled('Title', 'Kiwi Cover Mutual')
    const documentControlAt = paragraphs.findIndex((p) => p.includes('>Document Control<'))
    assert.ok(classificationAt >= 0, 'the classification is in the Cover Classification style')
    assert.ok(titleAt > classificationAt, 'the title is in the Title style, under the classification')
    assert.ok(documentControlAt > titleAt, 'Document Control follows the cover')
  })
})
