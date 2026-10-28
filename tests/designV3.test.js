import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadDefinition, loadDefinitionChangelog, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, readInstance, readModule, writeModule } from '../lib/instance.js'
import { renderArtefact, unnumberedHeadingsForWord } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { definitionInstanceSettings } from '../web/lib/instanceSettings.js'
import { countWords, overTargetNotes, TARGET_SIZES } from '../web/lib/targetSize.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { bodyParagraphs, bodyTables, docxPart, expectedTableOfContents, headerRowFormat, headingBookmarks, headingNumbers, keepsWithNext, numberingLevels, rowsCantSplit, styleFontSize, styleNumbering, tableOfContents, wordStyles } from './helpers/wordDocx.js'

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

// Modules v3 has that v2 doesn't, each added by the ticket named. #196's `document-handling` left
// again in #220, when the Classification became an Instance setting (ADR-0058).
const V3_ADDED_MODULES = {}

// Each Stage's "Populate example text" source: the one example that covers every Stage.
const STAGE_EXAMPLE = 'kiwi-cover-mutual'

// Every v3 Artefact, rendered from the example named here. `heading` is the document's first heading,
// section 1: since #196 the title is on the cover, and no template opens with a title line of its own.
const DOCUMENTS = {
  soap: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution on a Page', heading: '# Background and context' },
  'soap-full': { example: 'gantry', basename: 'Gantry hosting - Full Solution on a Page', heading: '# Metadata' },
  hld: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - High Level Design', heading: '# Submission' },
  sad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Architecture Document', heading: '# Overview' },
  ssad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Support Architecture Document', heading: '# Overview' },
  'as-built': { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - As-built', heading: '# Overview' },
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

// One `#` or `##` section of rendered Markdown: its heading line and everything up to the next `#` or
// `##` heading. Two documents that render a Field under the same heading give the same section.
function sectionOf(markdown, heading) {
  const start = markdown.indexOf(`\n${heading}\n`)
  assert.ok(start >= 0, `${heading} is in the document`)
  const next = markdown.slice(start + 1).search(/\n#{1,2} /)
  return markdown.slice(start + 1, next < 0 ? undefined : start + 1 + next)
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

// #200 (GF-007, GF-008): design decisions are an AD | Decision | ADR table. Every decision gets an
// AD id; only a decision that needs governance endorsement carries an ADR, as `ADRYYY` until the ADR
// is registered. The SAD's `architecture.design-decisions` and the as-built's
// `as-built-notes.architecture-decisions` share the table.
describe('design decisions are an AD | Decision | ADR table, without assuming ARB endorsement (#200)', () => {
  const DECISION_FIELDS = [
    ['architecture', 'design-decisions'],
    ['as-built-notes', 'architecture-decisions'],
  ]
  const ADR_CRITERIA = [
    /enterprise reuse/i,
    /new platform or product/i,
    /architecture precedent/i,
    /governance endorsement is explicitly required/i,
  ]

  function guidanceOf(moduleId, fieldId) {
    return v3().modules.get(moduleId).fields.find((f) => f.id === fieldId).guidance
  }

  // The rows of the one pipe table in a Field value, as arrays of trimmed cells; the header row first.
  function tableRows(markdown) {
    return markdown
      .split('\n')
      .filter((line) => line.trim().startsWith('|') && !/^\|[\s|:-]+\|$/.test(line.trim()))
      .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
  }

  function exampleDecisions(moduleId, fieldId) {
    const value = readModule(v3(), 'kiwi-cover-mutual', moduleId, { instancesDir: EXAMPLES_DIR }).fields[fieldId]
    const [header, ...rows] = tableRows(value)
    return { value, header, rows }
  }

  test('the design-decisions guidance asks for the table, the four ADR-candidate criteria, the ADRYYY placeholder and no assumed ARB endorsement', () => {
    const guidance = guidanceOf('architecture', 'design-decisions')
    assert.ok(guidance.includes('`| AD | Decision | ADR |`'), 'names the table and its columns')
    assert.match(guidance, /AD01/)
    for (const criterion of ADR_CRITERIA) assert.match(guidance, criterion)
    assert.match(guidance, /`ADRYYY`/)
    assert.match(guidance, /don't assume ARB endorsement/i)
    assert.match(guidance, /A decision is not an ADR, and an ADR is not an ARB item/)
  })

  test('the as-built architecture-decisions guidance asks for the same table, keeping the SAD\'s AD ids', () => {
    const guidance = guidanceOf('as-built-notes', 'architecture-decisions')
    assert.ok(guidance.includes('`| AD | Decision | ADR |`'))
    assert.match(guidance, /architecture\.design-decisions/)
    assert.match(guidance, /`ADRYYY`/)
  })

  for (const [moduleId, fieldId] of DECISION_FIELDS) {
    test(`the example's ${moduleId}.${fieldId} is the table, and only a minority of decisions carry an ADR`, () => {
      const { value, header, rows } = exampleDecisions(moduleId, fieldId)
      assert.deepEqual(header, ['AD', 'Decision', 'ADR'])
      assert.ok(rows.length >= 3, value)
      rows.forEach(([ad, decision, adr], i) => {
        assert.equal(ad, `AD${String(i + 1).padStart(2, '0')}`, 'AD ids run AD01, AD02, … in order')
        assert.ok(decision, `${ad} states its decision`)
        assert.match(adr, /^(ADR(YYY|\d{3}))?$/, `${ad}'s ADR is blank, ADRYYY or a registered ADR number`)
      })
      const withAdr = rows.filter(([, , adr]) => adr)
      assert.ok(withAdr.length > 0, 'some decisions need an ADR')
      assert.ok(withAdr.length < rows.length / 2, 'only a minority of decisions need an ADR')
    })
  }

  test('the SAD\'s ADRs not yet registered use the ADRYYY placeholder; the as-built keeps the SAD\'s AD ids and ADR decisions', () => {
    const sad = exampleDecisions('architecture', 'design-decisions').rows
    const asBuilt = exampleDecisions('as-built-notes', 'architecture-decisions').rows
    assert.ok(sad.some(([, , adr]) => adr === 'ADRYYY'))
    for (const [ad, , adr] of sad) {
      const built = asBuilt.find(([id]) => id === ad)
      assert.ok(built, `${ad} carries into the as-built`)
      assert.equal(Boolean(built[2]), Boolean(adr), `${ad} needs an ADR in both or neither`)
    }
  })

  test('the rendered v3 SAD shows the table under Design decisions, in Markdown and in Word', () => {
    const { markdown } = renderArtefact('kiwi-cover-mutual', 'sad', { instancesDir: EXAMPLES_DIR, dryRun: true })
    const section = markdown.slice(markdown.indexOf('## Design decisions'), markdown.indexOf('## Architectural risks'))
    assert.deepEqual(tableRows(section)[0], ['AD', 'Decision', 'ADR'])
    assert.match(section, /\| AD01 \|/)

    const { documentXml } = renderWord('kiwi-cover-mutual', 'sad')
    // The heading, not its entry in the table of contents (#206).
    const heading = /<w:pStyle w:val="Heading2" ?\/><\/w:pPr><w:r><w:t xml:space="preserve">Design decisions</.exec(documentXml)
    const after = documentXml.slice(heading.index + heading[0].length)
    const nextHeading = after.indexOf('w:pStyle w:val="Heading2"')
    const table = after.indexOf('<w:tbl>')
    assert.ok(table > 0 && table < nextHeading, 'a Word table follows the Design decisions heading')
    assert.match(after.slice(table, after.indexOf('</w:tbl>')), /AD01[\s\S]*ADRYYY/)
  })

  test('the rendered v3 as-built shows the table under Architecture decisions', () => {
    const { markdown } = renderArtefact('kiwi-cover-mutual', 'as-built', { instancesDir: EXAMPLES_DIR, dryRun: true })
    const start = markdown.indexOf('## Architecture decisions')
    const section = markdown.slice(start, markdown.indexOf('\n#', start + 1))
    assert.deepEqual(tableRows(section)[0], ['AD', 'Decision', 'ADR'])
  })
})

// #201 (GF-006, GF-018, GF-022, GF-023): v3 steers authors — people and MCP agents alike — towards
// sourced figures, the glossary's preferred terms, architecture names over contracted names, and
// tables whose columns say what the rows are. These are conventions set by Field guidance and shown
// by the example instance; Gantry has no checker for them in the product (spec #192, Out of Scope),
// so the tests below guard the guidance text and the bundled example only.
//
// Tables drive it, as above:
//   - SOURCED_FIGURE_FIELDS: the Fields whose guidance carries the sourced-figures rule. Every NFR
//     Field, plus the other Fields that invite figures. The example's value for each is scanned.
//   - PREFERRED_TERM_FIELDS: the Fields, besides the glossary itself, that name the solution's parts
//     in headings, tables, diagrams and prose, and so point authors at the glossary's preferred terms.
//   - ARCHITECTURE_NAME_FIELDS: the licence, account and platform Fields, which use the architecture
//     name and give the contracted product name only where it has been verified.

const SOURCED_FIGURE_FIELDS = [
  'nfrs.scalability-and-capacity',
  'nfrs.performance',
  'nfrs.availability-and-continuity',
  'nfrs.disaster-recovery-and-backup',
  'nfrs.other-nfrs',
  'nfrs.requirements-traceability',
  'architecture.architectural-risks',
  'integration.hardware',
  'integration.bandwidth',
  'integration.san',
]

const PREFERRED_TERM_FIELDS = [
  'solution-definition.high-level-solution-overview',
  'architecture.solution-description',
  'integration.interfaces',
  'integration.network-and-infrastructure',
  'integration.software-and-licences',
  'integration.communication-and-network-protocols',
  'support-and-operations.operational-accounts-and-licenses',
]

const ARCHITECTURE_NAME_FIELDS = [
  'integration.network-and-infrastructure',
  'integration.software-and-licences',
  'integration.hardware',
  'support-and-operations.operational-accounts-and-licenses',
]

const CONVENTIONS_EXAMPLE = 'kiwi-cover-mutual'

function v3Field(ref) {
  const [moduleId, fieldId] = ref.split('.')
  const field = v3().modules.get(moduleId)?.fields.find((f) => f.id === fieldId)
  assert.ok(field, `${ref} is a v3 Field`)
  return field
}

function exampleValue(ref, slug = CONVENTIONS_EXAMPLE) {
  const [moduleId, fieldId] = ref.split('.')
  return readModule(v3(), slug, moduleId, { instancesDir: EXAMPLES_DIR }).fields[fieldId]
}

// Every Markdown table in a value, as { header, rows } of trimmed cell text.
function markdownTables(markdown) {
  const tables = []
  let lines = []
  for (const line of `${markdown}\n`.split('\n')) {
    if (line.trim().startsWith('|')) {
      lines.push(line)
      continue
    }
    if (lines.length >= 2) {
      const [header, , ...rows] = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
      tables.push({ header, rows })
    }
    lines = []
  }
  return tables
}

// A figure is a number with a unit that makes it a claim about the solution: a percentage, a
// duration, a size, a rate or a count of things. Version numbers, identifiers (PDM-01, R2), times of
// day and ordinals ("95th") are not figures.
const FIGURE = new RegExp(
  String.raw`(?<![\w:.\-§])\d[\d,]*(?:\.\d+)?(?:\s*|-)` +
    String.raw`(?:%|percent\b|ms\b|milliseconds?\b|seconds?\b|minutes?\b|hours?\b|days?\b|weeks?\b|months?\b|years?\b|` +
    String.raw`[KMGT]B\b|[KMG]bps\b|vCPUs?\b|transactions?\b|claims?\b|registrations?\b|pages?\b|requests?\b|users?\b|members?\b|seats?\b|` +
    String.raw`a (?:working )?(?:second|minute|hour|day|week|month|year)\b)`,
  'gi'
)

// Every figure in `text` with no source after it in its clause. A source is a bracketed note — the
// document or agreement the figure comes from, or the marker `(target assumption)` — anywhere after
// the figure and before the clause ends (a `;`, a full stop, a line end or a table cell boundary), so
// one bracket can source a pair such as "3 seconds at the 95th percentile and 5 seconds at the 99th
// (target assumption)". Neither a bracketed cross-reference ("(see Data)") nor an aside that holds
// figures of its own ("(roughly 150 a day)") is a source: the aside's figures need sources too.
function unsourcedFigures(text) {
  const holdsFigure = (inner) => new RegExp(FIGURE.source, 'i').test(inner)
  const masked = text.replace(/\(([^()]*)\)/g, (_, inner) => {
    if (/^\s*see\b/i.test(inner)) return ' '.repeat(inner.length + 2)
    if (holdsFigure(inner)) return ` ${inner} `
    return `(${'x'.repeat(inner.length)})`
  })
  const found = []
  for (const clause of masked.split(/;|\.(?=\s|$)|\n|\|/)) {
    for (const match of clause.matchAll(FIGURE)) {
      if (!/\(x+\)/.test(clause.slice(match.index + match[0].length))) found.push(match[0])
    }
  }
  return found
}

function valueText(value) {
  return Array.isArray(value) ? value.join('\n') : value ?? ''
}

describe('v3 guidance and example: sourced figures, preferred terms, architecture names and path-led columns (#201)', () => {
  describe('sourced figures (GF-022)', () => {
    test('the figure scan catches a bare figure and accepts a sourced or target-assumption one', () => {
      assert.deepEqual(unsourcedFigures('Claim registration completes within 3 seconds at peak.'), ['3 seconds'])
      assert.deepEqual(unsourcedFigures('Claims payment: 99.5 percent, measured monthly.'), ['99.5 percent'])
      assert.deepEqual(unsourcedFigures('Documents under 10 MB open within 2 seconds (see Data).'), ['10 MB', '2 seconds'])
      assert.deepEqual(unsourcedFigures('Availability 99.5% (hosting SLA §4.2); RTO 4 hours (target assumption).'), [])
      assert.deepEqual(unsourcedFigures('| Production | 400 GB (target assumption) | 2 vCPU |'), ['2 vCPU'])
      assert.deepEqual(unsourcedFigures('Within 3 seconds at the 95th percentile and 5 seconds at the 99th (target assumption).'), [])
      assert.deepEqual(unsourcedFigures('PDM-01, R2, TLS 1.3, WCAG 2.1 and 07:00–21:00 are not figures.'), [])
      assert.deepEqual(unsourcedFigures('About 38,000 claims a year (roughly 150 a working day).'), ['38,000 claims', '150 a working day'])
    })

    test('every NFR Field is in the sourced-figures table', () => {
      for (const field of v3().modules.get('nfrs').fields) {
        assert.ok(SOURCED_FIGURE_FIELDS.includes(`nfrs.${field.id}`), `nfrs.${field.id}`)
      }
    })

    for (const ref of SOURCED_FIGURE_FIELDS) {
      test(`${ref}'s guidance asks for a source in brackets or "(target assumption)" for every figure`, () => {
        const { guidance } = v3Field(ref)
        assert.match(guidance ?? '', /source in brackets/)
        assert.match(guidance ?? '', /`\(target assumption\)`/)
        assert.match(guidance ?? '', /Never invent a figure/)
      })

      test(`the example's ${ref} has no unsourced figure`, () => {
        assert.deepEqual(unsourcedFigures(valueText(exampleValue(ref))), [], ref)
      })
    }

    test('the example NFRs show both a named source and the target-assumption marker', () => {
      const nfrs = v3().modules.get('nfrs').fields.map((f) => valueText(exampleValue(`nfrs.${f.id}`))).join('\n')
      assert.match(nfrs, /\(target assumption\)/)
      assert.ok([...nfrs.matchAll(/\(([^()]+)\)/g)].some(([, inner]) => inner !== 'target assumption' && !/^see\b/i.test(inner) && /[A-Za-z]{3}/.test(inner)), 'a figure cites a named source')
      for (const bare of ['3 seconds', '99.5 percent', '10 MB']) {
        assert.ok(!unsourcedFigures(nfrs).includes(bare), `no unsourced "${bare}"`)
      }
    })
  })

  describe('preferred terms (GF-006)', () => {
    test('the glossary guidance asks for the preferred term for the solution, its platforms and products, and the variants to avoid', () => {
      const { guidance } = v3Field('glossary.terms-and-definitions')
      assert.match(guidance, /Preferred term \| Definition \| Variants to avoid/)
      assert.match(guidance, /the solution itself, its platforms and its products/)
      assert.match(guidance, /headings, tables, diagrams and prose/)
    })

    for (const ref of PREFERRED_TERM_FIELDS) {
      test(`${ref}'s guidance says to use the glossary's preferred terms consistently`, () => {
        assert.match(v3Field(ref).guidance ?? '', /glossary's preferred terms/)
        assert.match(v3Field(ref).guidance ?? '', /headings, tables, diagrams and prose/)
      })
    }

    // Preferred term -> its variants to avoid, from the example glossary.
    function examplePreferredTerms() {
      const [table] = markdownTables(exampleValue('glossary.terms-and-definitions'))
      assert.deepEqual(table.header, ['Preferred term', 'Definition', 'Variants to avoid'])
      return table
    }

    function variantsOf(row) {
      return row[2] === '—' ? [] : row[2].split(',').map((v) => v.trim()).filter(Boolean)
    }

    test('the example glossary lists preferred terms, starting from the solution itself, with variants to avoid', () => {
      const { rows } = examplePreferredTerms()
      assert.ok(rows.some((row) => row[1].startsWith('This solution') && variantsOf(row).length > 0), 'the solution has a preferred term')
      assert.ok(rows.filter((row) => variantsOf(row).length > 0).length >= 5, 'its platforms and products have preferred terms too')
    })

    test('the example uses each preferred term, and no variant to avoid, outside the glossary', () => {
      const dir = join(EXAMPLES_DIR, CONVENTIONS_EXAMPLE, 'modules')
      const others = readdirSync(dir)
        .filter((file) => file !== 'glossary.md')
        .map((file) => readFileSync(join(dir, file), 'utf8'))
        .join('\n')
      const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      for (const row of examplePreferredTerms().rows.filter((r) => variantsOf(r).length > 0)) {
        assert.match(others, new RegExp(`(?<!\\w)${escape(row[0])}(?!\\w)`, 'i'), `the example uses "${row[0]}"`)
        // Case matters for a variant: "Bibit" is the variant, "BIBIT" the preferred spelling.
        for (const variant of variantsOf(row)) {
          assert.doesNotMatch(others, new RegExp(`(?<!\\w)${escape(variant)}(?!\\w)`), `"${variant}" (use "${row[0]}")`)
        }
      }
    })
  })

  describe('architecture names and contracted names (GF-023)', () => {
    for (const ref of ARCHITECTURE_NAME_FIELDS) {
      test(`${ref}'s guidance says to use the architecture name, and the contracted name only where verified`, () => {
        const { guidance } = v3Field(ref)
        assert.match(guidance ?? '', /architecture name by default/)
        assert.match(guidance ?? '', /contracted product name only where it has been verified/)
      })
    }

    test('the example licences table has a "Contracted name" column beside the architecture name', () => {
      const [table] = markdownTables(exampleValue('integration.software-and-licences'))
      assert.deepEqual(table.header.slice(0, 2), ['Software', 'Contracted name'])
      assert.ok(table.rows.some((row) => /verified/i.test(row[1]) && !/not yet verified/i.test(row[1])), 'a verified contracted name')
      assert.ok(table.rows.some((row) => /not yet verified/i.test(row[1])), 'an unverified one is left as such, not guessed')
    })
  })

  describe('context-aware column names (GF-018)', () => {
    test('communication-and-network-protocols guidance is path-led, not environment-led', () => {
      const { guidance } = v3Field('integration.communication-and-network-protocols')
      assert.match(guidance, /one row per path: Path \/ Protocol \/ From \/ To \/ Port \/ Direction \/ Environment\(s\)/)
      assert.doesNotMatch(guidance, /per path with environment/)
    })

    test('san and software-and-licences guidance name their rows, not environments', () => {
      assert.match(v3Field('integration.san').guidance, /one row per storage use: Storage use \/ Environment\(s\) \/ Tier \/ Size/)
      assert.match(v3Field('integration.software-and-licences').guidance, /one row per product: Software \/ Contracted name \/ Version \/ Count/)
    })

    test('the example integration tables lead with what each row is', () => {
      const [protocols] = markdownTables(exampleValue('integration.communication-and-network-protocols'))
      assert.deepEqual(protocols.header, ['Path', 'Protocol', 'From', 'To', 'Port', 'Direction', 'Environment(s)', 'Comments'])
      const [san] = markdownTables(exampleValue('integration.san'))
      assert.deepEqual(san.header.slice(0, 2), ['Storage use', 'Environment(s)'])
      const [licences] = markdownTables(exampleValue('integration.software-and-licences'))
      assert.equal(licences.header[0], 'Software')
    })
  })

  // The MCP server is a separate package (docs/adr/0043) and is not present in every build context
  // that runs this file (see tests/envVarCheck.test.js), so this skips rather than passes without it.
  test('the MCP server instructions tell an agent to follow each field\'s guidance and the example, and never invent figures or names', async (t) => {
    const instructions = join(new URL('..', import.meta.url).pathname, 'mcp-server', 'src', 'instructions.js')
    if (!existsSync(instructions)) return t.skip('mcp-server/ is not present in this build context')
    const { SERVER_INSTRUCTIONS } = await import(instructions)
    const authoring = SERVER_INSTRUCTIONS.split('\n').filter((line) => /field's guidance/.test(line))
    assert.equal(authoring.length, 1, 'one line')
    assert.match(authoring[0], /example's conventions/)
    assert.match(authoring[0], /never invent figures or names/i)
  })
})

describe('design v3 numbers and captions its diagrams (#195)', () => {
  // ADR-0053: `diagram-captions` is an opt-in engine option, and v3 switches it on for every
  // Artefact. v1 and v2 never set it, so their documents convert exactly as they always did.
  test('every v3 Artefact sets diagram-captions: true, and no v1 or v2 Artefact sets it', () => {
    assert.deepEqual(v3().artefacts.filter((a) => a.diagramCaptions !== true).map((a) => a.id), [])
    for (const version of [1, 2]) {
      const def = loadDefinition(DEFINITION, { version })
      assert.deepEqual(def.artefacts.filter((a) => a.diagramCaptions !== undefined).map((a) => a.id), [], `v${version}`)
    }
  })

  test('the v3 SAD numbers the example\'s captioned images in one sequence, "Diagram N. <title>", the caption doubling as alt text', () => {
    const { result, documentXml } = renderWord('kiwi-cover-mutual', 'sad')
    assert.doesNotMatch(result.markdown, /Diagram \d/, 'the exported .md keeps the images as authored')
    const paragraphs = [...documentXml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(([, body]) => body)
    const captions = paragraphs.flatMap((body, i) =>
      body.includes('w:val="ImageCaption"')
        ? [{ text: [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''), alt: paragraphs[i - 1].match(/<wp:docPr [^>]*descr="([^"]*)"/)?.[1] }]
        : []
    )
    assert.ok(captions.length > 1, 'the SAD has captioned images')
    captions.forEach(({ text, alt }, i) => {
      assert.match(text, new RegExp(`^Diagram ${i + 1}\\. \\S`), text)
      assert.equal(alt, text, 'the caption is the image\'s alt text')
    })
  })
})

describe('v3 documents open with a cover page, a classification and a table of contents (#196)', () => {
  const MARKINGS = ['UNCLASSIFIED', 'IN-CONFIDENCE', 'SENSITIVE', 'RESTRICTED']
  const PAGE_BREAK = '<w:br w:type="page"/>'

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

  // #220 (ADR-0058): the Classification is an Instance setting the Definition declares, not a Field
  // in a `document-handling` Module mounted at every Stage.
  function classificationSetting() {
    return definitionInstanceSettings(v3()).find((setting) => setting.id === 'classification')
  }

  test('v3 declares Classification as an Instance setting offering exactly the four NZ Protective Security Requirements markings, with no default', () => {
    const setting = classificationSetting()
    assert.ok(setting, 'v3 offers a Classification')
    assert.deepEqual(setting.choices.map((choice) => choice.value), MARKINGS)
    assert.equal(setting.default, null)
    assert.equal(setting.optional, true, 'blank can be chosen: no marking')
    assert.deepEqual(findDefinitionProblems(DEFINITION, { version: VERSION }), [])
    const yaml = readFileSync(join('definitions', DEFINITION, String(VERSION), 'definition.yaml'), 'utf8')
    assert.match(yaml, /Protective Security Requirements/)
    assert.match(yaml, /lists\s+(#\s+)?its own markings here/)
  })

  test('no Stage mounts document-handling and no Artefact requires it, so no gate shows a Document handling section', () => {
    assert.equal(v3().modules.has('document-handling'), false)
    assert.equal(existsSync(join('definitions', DEFINITION, String(VERSION), 'modules', 'document-handling.yaml')), false)
    for (const stage of v3().stages) assert.ok(!stage.modules.includes('document-handling'), stage.id)
    for (const artefact of v3().artefacts) {
      assert.ok(!artefact.requires.some((r) => r.startsWith('document-handling')), artefact.id)
    }
  })

  test('a new v3 Instance has no marking until one is chosen, and one chosen at creation is on its first render\'s cover', () => {
    withScratchDir((instancesDir) => {
      createInstance(DEFINITION, 'claims-portal', { instancesDir, version: VERSION })
      assert.equal(existsSync(join(instancesDir, 'claims-portal', 'modules', 'document-handling.md')), false)
      assert.equal('classification' in readInstance('claims-portal', { instancesDir }), false)
      const { cover } = splitCover(renderArtefact('claims-portal', 'soap', { instancesDir, dryRun: true }).markdown)
      assert.equal(coverParagraph(cover, 'Cover Classification'), undefined, 'a blank classification is left off the cover')
      assert.equal(coverParagraph(cover, 'Title'), 'Claims Portal', 'the title is the display name, the slug title-cased')

      createInstance(DEFINITION, 'marked-portal', { instancesDir, version: VERSION, classification: 'SENSITIVE' })
      assert.equal(readInstance('marked-portal', { instancesDir }).classification, 'SENSITIVE')
      const marked = splitCover(renderArtefact('marked-portal', 'soap', { instancesDir, dryRun: true }).markdown)
      assert.equal(coverParagraph(marked.cover, 'Cover Classification'), 'SENSITIVE')
    })
  })

  test('every v3 Artefact switches on a cover page and a table of contents, and names no cover-classification Field', () => {
    for (const artefact of v3().artefacts) {
      assert.equal(artefact.coverPage, true, artefact.id)
      assert.equal(artefact.tableOfContents, true, artefact.id)
      assert.equal(artefact.coverClassification, undefined, artefact.id)
    }
  })

  // #205: the cover's purpose line is a statement for the reader ("This document describes …"),
  // not the author-facing instruction in `purpose` ("Describe …"), which stays as it was.
  test('every v3 Artefact with a cover has a cover-purpose phrased as a statement, distinct from its purpose', () => {
    for (const artefact of v3().artefacts.filter((a) => a.coverPage === true)) {
      assert.equal(typeof artefact.coverPurpose, 'string', artefact.id)
      const statement = artefact.coverPurpose.replace(/\s+/g, ' ').trim()
      assert.match(statement, /^This document [a-z]+s\b[^.]*\.$/, `${artefact.id}: one sentence opening "This document <verb>s"`)
      assert.notEqual(statement, artefact.purpose.replace(/\s+/g, ' ').trim(), artefact.id)
      assert.doesNotMatch(artefact.purpose, /^This document/, `${artefact.id}: purpose is still the author-facing instruction`)
    }
  })

  test('the v3 CHANGELOG records the cover purpose under its own #205 heading', () => {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    const v3Section = changelog.slice(0, changelog.indexOf('\n## v2'))
    assert.match(v3Section, /^### Cover purpose \(#205\)$/m)
  })

  test('no v3 template emits the instance slug in a heading', () => {
    const templates = join('definitions', DEFINITION, String(VERSION), 'templates')
    for (const file of readdirSync(templates).filter((f) => f.endsWith('.md.tmpl'))) {
      const offending = headings(readFileSync(join(templates, file), 'utf8')).filter((line) => line.includes('instance.slug'))
      assert.deepEqual(offending, [], file)
    }
  })

  for (const [slug, { classification }] of Object.entries(EXAMPLES)) {
    test(`${slug} stores its classification as its Instance setting, one of the markings`, () => {
      const instance = readInstance(slug, { instancesDir: EXAMPLES_DIR })
      assert.equal(instance.classification, classification)
      assert.ok(MARKINGS.includes(instance.classification))
      assert.equal(existsSync(join(EXAMPLES_DIR, slug, 'modules', 'document-handling.md')), false)
    })
  }

  test('a classification that is not one of the markings is refused at creation, and one written into instance.yaml by hand prints nothing', () => {
    withScratchDir((dir) => {
      assert.throws(
        () => createInstance(DEFINITION, 'top-secret', { instancesDir: dir, version: VERSION, classification: 'TOP SECRET' }),
        /Unknown classification "TOP SECRET" — choose one of the Definition's markings: "UNCLASSIFIED", "IN-CONFIDENCE", "SENSITIVE", "RESTRICTED"/
      )
      assert.equal(existsSync(join(dir, 'top-secret')), false, 'nothing is written')

      cpSync(join(EXAMPLES_DIR, 'kiwi-cover-mutual'), join(dir, 'kiwi-cover-mutual'), { recursive: true })
      const file = join(dir, 'kiwi-cover-mutual', 'instance.yaml')
      writeFileSync(file, readFileSync(file, 'utf8').replace('classification: IN-CONFIDENCE', 'classification: TOP SECRET'))
      const { cover } = splitCover(renderArtefact('kiwi-cover-mutual', 'soap', { instancesDir: dir, dryRun: true }).markdown)
      assert.equal(coverParagraph(cover, 'Cover Classification'), undefined)
      assert.equal(checkGate('kiwi-cover-mutual', { instancesDir: dir, gate: 'business-case' }).pass, true, 'it never blocks a Gate')
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
      // #205: the cover prints the reader-facing cover-purpose, never the author-facing purpose.
      assert.equal(coverParagraph(cover, 'Cover Purpose'), artefact.coverPurpose.replace(/\s+/g, ' ').trim())
      assert.ok(!cover.includes(artefact.purpose.replace(/\s+/g, ' ').trim()), 'the author-facing purpose is not on the cover')

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

// #199 (GF-009 to GF-012, GF-020, GF-021): v3 guidance sets a short diagram pattern and three
// inline state labels, and the example shows each. Guidance only, as for #201: no new Field, and
// Gantry checks none of it in the product, so the tests guard the guidance text and the bundled
// example.
//
// Tables drive it:
//   - DIAGRAM_FIELDS: every Field that carries a diagram. Its guidance gives the intro → diagram →
//     caption → interpretation → detail order, and the architecture-state labels.
//   - CAPABILITY_STATUS_FIELDS: the inventories, which give each entry a Status.
//   - INTERIM_OWNER_FIELDS: the Fields that name owners, which mark an unconfirmed one `(interim)`.

const DIAGRAM_FIELDS = [
  'introduction.overview',
  'solution-definition.process-flow',
  'solution-definition.high-level-solution-overview',
  'soap-full-details.sequencing',
  'architecture.business-context',
  'architecture.solution-description',
  'integration.network-and-infrastructure',
  'data.logical-data-model',
  'security.security-architecture',
  'support-and-operations.monitoring-and-alerting',
  'as-built-notes.design-overview',
  'as-built-notes.process-flows',
]

const CAPABILITY_STATUS_FIELDS = ['architecture.logical-components', 'integration.interfaces']

const INTERIM_OWNER_FIELDS = [
  'support-and-operations.stakeholders',
  'risks.risk-register',
  'risks.open-issues',
  'design-basis.outcomes-and-deliverables',
]

const ARCHITECTURE_STATES = ['current', 'interim', 'target', 'enduring']
const CAPABILITY_STATUSES = ['existing', 'implemented', 'in delivery', 'planned', 'future']

// A diagram is an image alone on its line, or a Mermaid fence.
const DIAGRAM_LINE = /^(?:!\[[^\]]*\]\([^)]*\)\s*$|```mermaid\b)/m

// The sentences of a guidance paragraph. Inline code, quoted phrases and "e.g." hold full stops
// that don't end a sentence.
function sentencesOf(paragraph) {
  const plain = paragraph
    .replace(/`[^`]*`/g, 'code')
    .replace(/"[^"]*"/g, 'quote')
    .replace(/\b(?:e\.g|i\.e)\./g, 'eg')
  return plain.split(/(?<=[.!?])\s+/).filter((s) => /\S/.test(s))
}

// The guidance paragraph that sets the diagram pattern.
function diagramPatternOf(guidance) {
  return (guidance ?? '').split('\n').find((paragraph) => /introductory sentence/.test(paragraph))
}

// Each diagram in a Field value with the blocks around it: the one before (its opening sentence),
// its caption, the one after (its interpretation) and the rest. Blocks are separated by blank
// lines; a fence is one block.
function diagramLayouts(markdown) {
  const blocks = []
  let fence = null
  for (const line of markdown.split('\n')) {
    if (fence !== null) {
      fence.push(line)
      if (/^```\s*$/.test(line)) {
        blocks.push(fence.join('\n'))
        fence = null
      }
    } else if (line.startsWith('```')) {
      fence = [line]
    } else if (/\S/.test(line)) {
      if (blocks.length && blocks.at(-1) !== null && !blocks.at(-1).startsWith('```')) blocks[blocks.length - 1] += `\n${line}`
      else blocks.push(line)
    } else if (blocks.at(-1) !== null) {
      blocks.push(null)
    }
  }
  const paragraphs = blocks.filter((b) => b !== null)
  return paragraphs.flatMap((block, i) => {
    if (!DIAGRAM_LINE.test(block)) return []
    const caption = block.match(/^```mermaid\s*\{caption="([^"]*)"\}/)?.[1] ?? block.match(/^!\[([^\]]*)\]/)?.[1] ?? null
    return [{ caption, before: paragraphs[i - 1] ?? '', after: paragraphs[i + 1] ?? '', rest: paragraphs.slice(i + 2) }]
  })
}

describe('v3 guidance and example: the diagram pattern and current / interim / target state labels (#199)', () => {
  describe('the diagram pattern (GF-009, GF-010, GF-011)', () => {
    test('every Field that carries a diagram in a bundled example is in the diagram table', () => {
      for (const slug of Object.keys(EXAMPLES)) {
        for (const file of readdirSync(join(EXAMPLES_DIR, slug, 'modules'))) {
          const moduleId = file.replace(/\.md$/, '')
          for (const [fieldId, value] of Object.entries(readModule(v3(), slug, moduleId, { instancesDir: EXAMPLES_DIR }).fields)) {
            if (DIAGRAM_LINE.test(valueText(value))) assert.ok(DIAGRAM_FIELDS.includes(`${moduleId}.${fieldId}`), `${slug}: ${moduleId}.${fieldId}`)
          }
        }
      }
    })

    test('the sentence counter ignores the full stops in code, quotes and "e.g."', () => {
      assert.equal(sentencesOf('One ("The following diagram presents…"), e.g. `Diagram 3. Flow`. Two.').length, 2)
    })

    for (const ref of DIAGRAM_FIELDS) {
      test(`${ref}'s guidance gives the intro → diagram → caption → interpretation → detail order in no more than two sentences`, () => {
        const pattern = diagramPatternOf(v3Field(ref).guidance)
        assert.ok(pattern, `${ref} has the diagram pattern`)
        assert.match(pattern, /introductory sentence[\s\S]*\bthe diagram\b[\s\S]*\bcaption\b[\s\S]*\binterpret[\s\S]*\bdetail\b/)
        assert.match(pattern, /"The following diagram presents…"/)
        assert.match(pattern, /"The diagram shows how…"/)
        assert.ok(sentencesOf(pattern).length <= 2, pattern)
      })

      test(`${ref}'s guidance labels a diagram that isn't the enduring design current, interim, target or enduring, in its caption and opening sentence`, () => {
        const { guidance } = v3Field(ref)
        assert.match(guidance, /`current`, `interim`, `target` or `enduring`/)
        assert.match(guidance, /in its caption and its opening sentence/)
        assert.ok(guidance.includes('`Diagram 3. Publishing flow (interim)`'), 'shows a labelled caption')
      })
    }

    test('the example shows the pattern: a captioned Mermaid diagram introduced in one sentence, interpreted, then the detail', () => {
      const [layout] = diagramLayouts(exampleValue('security.security-architecture'))
      assert.ok(layout, 'the example security architecture has a diagram')
      assert.match(exampleValue('security.security-architecture'), /^```mermaid \{caption="[^"]+"\}$/m, 'captioned on the fence (#195)')
      assert.match(layout.before, /^The following diagram presents /)
      assert.equal(sentencesOf(layout.before).length, 1, 'one introductory sentence')
      assert.match(layout.after, /^The diagram shows how /)
      assert.ok(layout.rest.some((block) => /^- /m.test(block)), 'the detail follows, with the layered controls as bullets')
    })

    test('the rendered v3 SAD captions the example\'s Mermaid diagram in the same sequence as its images', () => {
      const { markdown, docxMarkdown } = renderArtefact(CONVENTIONS_EXAMPLE, 'sad', { instancesDir: EXAMPLES_DIR, dryRun: true })
      assert.ok(markdown.includes('```mermaid {caption="Security architecture (interim)"}'), 'the exported .md keeps the fence as written')
      const numbers = [...docxMarkdown.matchAll(/Diagram (\d+)\. /g)].map((m) => Number(m[1]))
      assert.deepEqual(numbers, numbers.map((_, i) => i + 1), 'one sequence')
      assert.match(docxMarkdown, new RegExp(`Diagram ${numbers.length}\\. Security architecture \\(interim\\)`))
    })
  })

  describe('architecture state (GF-012)', () => {
    test('a labelled diagram in the example names its state in its caption and its opening sentence', () => {
      const labelled = DIAGRAM_FIELDS.flatMap((ref) => (hasContent(exampleValue(ref)) ? diagramLayouts(exampleValue(ref)) : [])).filter(({ caption }) =>
        /\((\w+)\)$/.test(caption ?? '')
      )
      assert.ok(labelled.some(({ caption }) => caption.endsWith('(interim)')), 'an interim diagram')
      for (const { caption, before } of labelled) {
        const state = caption.match(/\((\w+)\)$/)[1]
        assert.ok(ARCHITECTURE_STATES.includes(state), `"${caption}" uses a state label`)
        assert.match(before, new RegExp(`\\b${state}\\b`), `"${caption}": the opening sentence names the state too`)
      }
    })
  })

  describe('capability status (GF-021)', () => {
    for (const ref of CAPABILITY_STATUS_FIELDS) {
      test(`${ref}'s guidance asks for a Status of existing, implemented, in delivery, planned or future, and not to assume a capability exists`, () => {
        const { guidance } = v3Field(ref)
        assert.match(guidance, /\bStatus\b/)
        assert.match(guidance, /`existing`, `implemented`, `in delivery`, `planned` or `future`/)
        assert.match(guidance, /Don't assume an? (capability|component|interface) exists/)
      })
    }

    test('every logical component in the example states its Status, and not every one exists yet', () => {
      const items = exampleValue('architecture.logical-components')
      assert.ok(items.length > 0)
      const statuses = items.map((item) => item.match(/^.+? — Status: ([a-z ]+) — \S/)?.[1])
      items.forEach((item, i) => assert.ok(CAPABILITY_STATUSES.includes(statuses[i]), item))
      assert.ok(statuses.includes('existing'))
      assert.ok(statuses.some((s) => s !== 'existing' && s !== 'implemented'), 'some components are still to come')
    })

    test('the example interfaces table has a Status column', () => {
      const [table] = markdownTables(exampleValue('integration.interfaces'))
      const column = table.header.indexOf('Status')
      assert.ok(column > 0, table.header.join(' | '))
      for (const row of table.rows) assert.ok(CAPABILITY_STATUSES.includes(row[column]), row.join(' | '))
    })

    test('the rendered v3 SAD lists each logical component with its Status', () => {
      const { markdown } = renderArtefact(CONVENTIONS_EXAMPLE, 'sad', { instancesDir: EXAMPLES_DIR, dryRun: true })
      const start = markdown.indexOf('# Logical components view')
      const section = markdown.slice(start, markdown.indexOf('\n# ', start + 1))
      assert.match(section, /^- Customer Information Service \(CIS\) — Status: \w/m)
    })
  })

  describe('interim ownership (GF-020)', () => {
    for (const ref of INTERIM_OWNER_FIELDS) {
      test(`${ref}'s guidance marks an owner who is not yet confirmed (interim)`, () => {
        const { guidance } = v3Field(ref)
        assert.match(guidance, /owner who is not yet confirmed/)
        assert.match(guidance, /`\(interim\)`/)
      })
    }

    test('the example marks an unconfirmed owner (interim) in the support contacts and the risk register', () => {
      const contact = exampleValue('support-and-operations.stakeholders').find((item) => /\(interim\)/.test(item))
      assert.ok(contact, 'a support contact is interim')
      const owner = contact.match(/— ([^;(]+?) \(interim\)/)?.[1]
      assert.ok(owner, contact)
      const [register] = markdownTables(exampleValue('risks.risk-register'))
      const column = register.header.indexOf('Owner')
      assert.ok(register.rows.some((row) => row[column] === `${owner} (interim)`), `${owner} is the interim owner of a risk too`)
    })
  })
})

// #197 (GF-003, GF-004, GF-014 to GF-017, GF-024): production Word styles. v3's seven reference
// documents share one styles.xml and one numbering.xml, and every rule below is a style in them —
// numbering, keep-with-next, the table header and typography, and rows that don't split — so an
// organisation's house style (its own reference document) can change any of it without changing
// Gantry. The one thing a style can't say is "this heading isn't numbered": the front matter's
// headings carry Pandoc's `.unnumbered` class, which the compile step turns into a heading with its
// numbering switched off (ADR-0056). The rendered documents are judged the way Word reads them
// (tests/helpers/wordDocx.js); tests/designV3WordStyles.playwright.test.js judges the browser's
// pandoc-wasm render by the same rules.
describe('v3 Word styles: numbered headings, keep-with-next, one table style, rows that don\'t split (#197)', () => {
  const TEMPLATES = join('definitions', DEFINITION, String(VERSION), 'templates')
  const REFERENCE_DOCS = readdirSync(TEMPLATES).filter((f) => /^reference(-[\w-]+)?\.docx$/.test(f)).sort()
  // Styles that must keep with the next paragraph: every heading, every caption, and the figure
  // paragraph a caption sits under.
  const KEEP_WITH_NEXT = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Caption', 'TableCaption', 'ImageCaption', 'Figure', 'CaptionedFigure']

  function referenceStyles(file = 'reference.docx') {
    return wordStyles(docxPart(join(TEMPLATES, file), 'word/styles.xml'))
  }

  function renderedWord(example, artefactId) {
    return withScratchDir((dir) => {
      cpSync(join(EXAMPLES_DIR, example), join(dir, example), { recursive: true })
      rmSync(join(dir, example, 'out'), { recursive: true, force: true })
      const { docxBytes } = renderArtefact(example, artefactId, { instancesDir: dir, deliverToClient: true })
      return {
        documentXml: docxPart(docxBytes, 'word/document.xml'),
        styles: wordStyles(docxPart(docxBytes, 'word/styles.xml')),
        numberingXml: docxPart(docxBytes, 'word/numbering.xml'),
      }
    })
  }

  test('all seven v3 reference documents share one styles.xml and one numbering.xml', () => {
    assert.equal(REFERENCE_DOCS.length, 7, REFERENCE_DOCS.join(', '))
    for (const part of ['word/styles.xml', 'word/numbering.xml']) {
      const shared = docxPart(join(TEMPLATES, 'reference.docx'), part)
      for (const file of REFERENCE_DOCS) assert.ok(docxPart(join(TEMPLATES, file), part) === shared, `${file}: ${part}`)
    }
  })

  test('Heading 1–3 are numbered 1 / 1.1 / 1.1.1 by one multilevel list; Heading 4–6 are not numbered', () => {
    const styles = referenceStyles()
    const numberingXml = docxPart(join(TEMPLATES, 'reference.docx'), 'word/numbering.xml')
    const numbering = ['Heading1', 'Heading2', 'Heading3'].map((id) => styleNumbering(styles, id))
    assert.ok(numbering.every(Boolean), JSON.stringify(numbering))
    assert.equal(new Set(numbering.map((n) => n.numId)).size, 1, 'one list numbers all three levels')
    assert.deepEqual(numbering.map((n) => n.ilvl), [0, 1, 2])
    const levels = numberingLevels(numberingXml, numbering[0].numId)
    assert.deepEqual(
      levels.slice(0, 3).map(({ numFmt, lvlText, pStyle }) => ({ numFmt, lvlText, pStyle })),
      [
        { numFmt: 'decimal', lvlText: '%1', pStyle: 'Heading1' },
        { numFmt: 'decimal', lvlText: '%1.%2', pStyle: 'Heading2' },
        { numFmt: 'decimal', lvlText: '%1.%2.%3', pStyle: 'Heading3' },
      ]
    )
    for (const id of ['Heading4', 'Heading5', 'Heading6']) assert.equal(styleNumbering(styles, id), null, id)
  })

  test('the front matter\'s styles are not numbered: the cover\'s Title and Subtitle, and TOC Heading (based on Heading 1)', () => {
    const styles = referenceStyles()
    assert.equal(styles.get('TOCHeading').basedOn, 'Heading1')
    for (const id of ['Title', 'Subtitle', 'TOCHeading']) assert.equal(styleNumbering(styles, id), null, id)
  })

  test('every heading, caption and table title, and the figure paragraph, keeps with the next paragraph', () => {
    const styles = referenceStyles()
    for (const id of KEEP_WITH_NEXT) assert.equal(keepsWithNext(styles, id), true, id)
  })

  test('one table style: a dark shaded header row with white bold text, one explicit font size for the table and its cells, and rows that don\'t split', () => {
    const styles = referenceStyles()
    const table = styles.get('Table')
    assert.equal(table?.type, 'table')
    const header = headerRowFormat(styles, 'Table')
    assert.match(header.fill ?? '', /^[0-9A-F]{6}$/i, 'the header row is shaded')
    const [r, g, b] = header.fill.match(/../g).map((h) => parseInt(h, 16))
    assert.ok(r === g && g === b && r <= 0x60, `the shading is a dark neutral grey, not ${header.fill}`)
    assert.equal(header.color, 'FFFFFF')
    assert.equal(header.bold, true)
    const size = styleFontSize(styles, 'Table')
    assert.ok(size, 'the table style sets a font size')
    assert.ok(table.xml.includes('<w:sz '), 'the font size is explicit on the table style itself')
    assert.ok(styles.get('Compact').xml.includes('<w:sz '), 'and explicit on the cell paragraph style')
    assert.equal(styleFontSize(styles, 'Compact'), size, 'table cells are the table style\'s size')
    assert.equal(header.size ?? size, size, 'the header row is the same size')
    assert.equal(rowsCantSplit(styles, 'Table'), true)
  })

  test('the v3 SAD numbers its sections 1 / 1.1 / 1.1.1 from its first section, and leaves the front matter unnumbered', () => {
    const { documentXml, styles, numberingXml } = renderedWord('kiwi-cover-mutual', 'sad')
    const headings = headingNumbers(documentXml, styles, numberingXml)
    const first = headings.findIndex((h) => h.style === 'Heading1')
    assert.ok(first > 0)
    const frontMatter = headings.slice(0, first)
    assert.deepEqual(
      frontMatter.map(({ text, number }) => [text, number]),
      [['Kiwi Cover Mutual', null], ['Document Control', null], ['Review & sign-off', null], ['Table of Contents', null]]
    )
    const body = headings.slice(first)
    assert.equal(body[0].text, 'Overview')
    assert.equal(body[0].number, '1')
    for (const { text, style, number } of body) {
      const level = Number(style.replace('Heading', ''))
      if (level > 3) assert.equal(number, null, `${text} (Heading ${level}) is not numbered`)
      else assert.match(number ?? '', level === 1 ? /^\d+$/ : level === 2 ? /^\d+\.\d+$/ : /^\d+\.\d+\.\d+$/, `${text} (Heading ${level})`)
    }
    const h1s = body.filter((h) => h.style === 'Heading1').map((h) => h.number)
    assert.deepEqual(h1s, h1s.map((_, i) => String(i + 1)), 'Heading 1s count 1, 2, 3, …')
    assert.ok(body.some((h) => h.style === 'Heading2' && h.number === '1.1'))
    // The table of contents lists the numbered levels, so it shows the same numbers.
    assert.match(documentXml, /TOC \\o "1-3"/)
  })

  test('the exported Markdown keeps Document Control and Review & sign-off as headings, marked .unnumbered', () => {
    const { markdown } = renderArtefact('kiwi-cover-mutual', 'sad', { instancesDir: EXAMPLES_DIR, dryRun: true })
    assert.match(markdown, /^## Document Control \{\.unnumbered\}$/m)
    assert.match(markdown, /^## Review & sign-off \{\.unnumbered\}$/m)
  })

  // The raw OpenXML paragraph a heading marked `.unnumbered` becomes, parsed back: its style, its
  // own numbering, the bookmarks on it and its runs.
  function wordHeadings(word) {
    return [...word.matchAll(/```\{=openxml\}\n(<w:p>[\s\S]*?<\/w:p>)\n```/g)].map(([, xml]) => ({
      xml,
      style: /<w:pStyle w:val="([^"]+)"\/>/.exec(xml)?.[1],
      numId: /<w:numId w:val="([^"]+)"\/>/.exec(xml)?.[1],
      bookmarks: [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]*)"\/>/g)].map(([, id, name]) => ({ id, name })),
      bookmarkEnds: [...xml.matchAll(/<w:bookmarkEnd w:id="(\d+)"\/>/g)].map(([, id]) => id),
      text: [...xml.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map(([, t]) => t).join(''),
      runs: [...xml.matchAll(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?<w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r>/g)].map(([, rPr = '', t]) => ({ rPr, t })),
    }))
  }

  test('for Word, any heading marked .unnumbered (or {-}) has its numbering switched off; other headings and code are left as they are', () => {
    const markdown = [
      '## Review & sign-off {.unnumbered}',
      '# Notes {#notes -}',
      '## Numbered {#numbered}',
      '```markdown',
      '## Inside a fence {.unnumbered}',
      '```',
      '### A \\*literal\\* <star> {.unnumbered .unlisted}',
    ].join('\n')
    const word = unnumberedHeadingsForWord(markdown)
    const headings = wordHeadings(word)
    assert.deepEqual(
      headings.map(({ style, numId, text }) => [style, numId, text]),
      [['Heading2', '0', 'Review &amp; sign-off'], ['Heading1', '0', 'Notes'], ['Heading3', '0', 'A *literal* &lt;star&gt;']]
    )
    for (const h of headings) assert.match(h.xml, /^<w:p><w:pPr><w:pStyle w:val="Heading\d"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="0"\/><\/w:numPr><\/w:pPr>/)
    assert.match(word, /^## Numbered \{#numbered\}$/m)
    assert.match(word, /^## Inside a fence \{\.unnumbered\}$/m)
    assert.equal(unnumberedHeadingsForWord('# Title\n\nText {.unnumbered}\n'), '# Title\n\nText {.unnumbered}\n', 'nothing marked, nothing changed')
  })

  test('for Word, an .unnumbered heading keeps its inline formatting and links instead of printing the Markdown', () => {
    const [heading] = wordHeadings(
      unnumberedHeadingsForWord('## Data **flows**, *in* `code`, ~~gone~~ and [CIS](https://x.example/a?b=1&c="d") or [back](#top) {#flows .unnumbered}')
    )
    assert.equal(heading.text, 'Data flows, in code, gone and CIS or back')
    assert.doesNotMatch(heading.xml, /\*\*|\]\(|~~|`/, 'no Markdown syntax reaches Word')
    const run = (t) => heading.runs.find((r) => r.t === t)
    assert.match(run('flows').rPr, /<w:b\/><w:bCs\/>/)
    assert.match(run('in').rPr, /<w:i\/><w:iCs\/>/)
    assert.match(run('code').rPr, /<w:rStyle w:val="VerbatimChar"\/>/)
    assert.match(run('gone').rPr, /<w:strike\/>/)
    assert.equal(run('Data ').rPr, '', 'plain text is a plain run')
    // An external link is a HYPERLINK field (raw OpenXML can't add the relationship Pandoc's own links
    // use); an internal one points at its bookmark. Both look like Pandoc's links.
    assert.match(heading.xml, /<w:instrText xml:space="preserve"> HYPERLINK "https:\/\/x\.example\/a\?b=1&amp;c=%22d%22" <\/w:instrText>/)
    assert.match(run('CIS').rPr, /<w:rStyle w:val="Hyperlink"\/>/)
    assert.match(heading.xml, /<w:hyperlink w:anchor="top"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">back<\/w:t><\/w:r><\/w:hyperlink>/)
  })

  test('for Word, an .unnumbered heading keeps its anchor: its {#id}, or else the identifier Pandoc would give it', () => {
    const word = unnumberedHeadingsForWord(
      [
        '## Data flows {#flows .unnumbered}',
        '## Review & sign-off {.unnumbered}',
        '## 2.1 Über_alles *now* {-}',
        '## Notes {.unnumbered}',
        '# Notes',
      ].join('\n\n')
    )
    const headings = wordHeadings(word)
    assert.deepEqual(
      headings.map((h) => h.bookmarks.map((b) => b.name)),
      [['flows'], ['review-sign-off'], ['über_alles-now'], []],
      'an identifier another heading would take too is left to that heading'
    )
    const ids = headings.flatMap((h) => h.bookmarks.map((b) => b.id))
    assert.equal(new Set(ids).size, ids.length, 'every bookmark id is unique')
    for (const h of headings) assert.deepEqual(h.bookmarkEnds, h.bookmarks.map((b) => b.id), 'each bookmark is closed in its own paragraph')
  })

  test('in the rendered v3 SAD, an authored .unnumbered heading is unnumbered, formatted, and the target of a link to it', () => {
    const { documentXml, styles, numberingXml, markdown } = withScratchDir((dir) => {
      cpSync(join(EXAMPLES_DIR, 'kiwi-cover-mutual'), join(dir, 'kiwi-cover-mutual'), { recursive: true })
      rmSync(join(dir, 'kiwi-cover-mutual', 'out'), { recursive: true, force: true })
      const definition = loadDefinition(DEFINITION, { version: VERSION })
      const { fields } = readModule(definition, 'kiwi-cover-mutual', 'introduction', { instancesDir: dir })
      const [fieldId] = Object.entries(fields).find(([, value]) => typeof value === 'string' && value.startsWith('The build-ready Solution Architecture Document'))
      fields[fieldId] += '\n\n### Data **flows** and [CIS](https://example.com/cis) {#authored-flows .unnumbered}\n\nSee [the flows](#authored-flows).'
      writeModule(definition, 'kiwi-cover-mutual', 'introduction', { fields }, { instancesDir: dir })
      const result = renderArtefact('kiwi-cover-mutual', 'sad', { instancesDir: dir, deliverToClient: true })
      return {
        markdown: result.markdown,
        documentXml: docxPart(result.docxBytes, 'word/document.xml'),
        styles: wordStyles(docxPart(result.docxBytes, 'word/styles.xml')),
        numberingXml: docxPart(result.docxBytes, 'word/numbering.xml'),
      }
    })
    assert.match(markdown, /^### Data \*\*flows\*\* and \[CIS\]\(https:\/\/example\.com\/cis\) \{#authored-flows \.unnumbered\}$/m, 'the .md keeps it as authored')
    const heading = headingNumbers(documentXml, styles, numberingXml).find((h) => h.text === 'Data flows and CIS')
    assert.ok(heading, 'the heading reaches Word as its text, without Markdown syntax')
    assert.equal(heading.style, 'Heading3')
    assert.equal(heading.number, null)
    const paragraph = bodyParagraphs(documentXml).find((p) => p.text === 'Data flows and CIS' && p.style === 'Heading3')
    assert.match(paragraph.xml, /<w:b\/>[\s\S]*?flows/, 'bold stays bold')
    assert.match(paragraph.xml, /<w:bookmarkStart w:id="\d+" w:name="authored-flows"\/>/)
    assert.match(documentXml, /<w:hyperlink w:anchor="authored-flows">/, 'and the link to it lands on it')
  })

  test('an Artefact that opts into none of cover-page, table-of-contents and diagram-captions hands Word its authored headings unchanged; only its Document Control partial\'s .unnumbered headings are rewritten', () => {
    withScratchDir((dir) => {
      // design v3 with the SAD's opt-ins switched off: its partial still marks Document Control
      // `{.unnumbered}`, and its reference documents still number headings.
      const definitionsDir = join(dir, 'definitions')
      cpSync(join('definitions', DEFINITION), join(definitionsDir, DEFINITION), { recursive: true })
      const yamlPath = join(definitionsDir, DEFINITION, String(VERSION), 'definition.yaml')
      writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace(/^ {4}(cover-page|table-of-contents|diagram-captions): true\n/gm, ''))
      const instancesDir = join(dir, 'instances')
      cpSync(join(EXAMPLES_DIR, 'kiwi-cover-mutual'), join(instancesDir, 'kiwi-cover-mutual'), { recursive: true })
      const definition = loadDefinition(DEFINITION, { version: VERSION, definitionsDir })
      const sad = definition.artefacts.find((a) => a.id === 'sad')
      assert.ok(!sad.coverPage && !sad.tableOfContents && !sad.diagramCaptions)
      const { fields } = readModule(definition, 'kiwi-cover-mutual', 'introduction', { instancesDir })
      const [fieldId] = Object.entries(fields).find(([, value]) => typeof value === 'string' && value.startsWith('The build-ready Solution Architecture Document'))
      fields[fieldId] += '\n\n### Data **flows** {#authored-flows .unnumbered}'
      writeModule(definition, 'kiwi-cover-mutual', 'introduction', { fields }, { instancesDir })
      const { markdown, docxMarkdown } = renderArtefact('kiwi-cover-mutual', 'sad', { instancesDir, definitionsDir, dryRun: true })
      assert.match(docxMarkdown, /^### Data \*\*flows\*\* \{#authored-flows \.unnumbered\}$/m, 'the authored heading is left for Pandoc')
      assert.deepEqual(
        wordHeadings(docxMarkdown).map(({ style, numId, text }) => [style, numId, text]),
        [['Heading2', '0', 'Document Control'], ['Heading2', '0', 'Review &amp; sign-off']]
      )
      assert.match(markdown, /^## Document Control \{\.unnumbered\}$/m, 'the .md keeps the partial as written')
    })
  })

  for (const [id, { example }] of Object.entries(DOCUMENTS)) {
    test(`every table in the v3 ${id} uses the one table style: a repeating, shaded header row, uniform cells, rows that don't split`, () => {
      const { documentXml, styles } = renderedWord(example, id)
      const tables = bodyTables(documentXml)
      assert.ok(tables.length > 0)
      for (const [i, table] of tables.entries()) {
        assert.equal(table.style, 'Table', `table ${i + 1}`)
        assert.equal(table.rows[0].header, true, `table ${i + 1}'s first row repeats as a header row`)
        for (const row of table.rows) {
          assert.notEqual(row.cantSplit, false, `table ${i + 1}: no row is allowed to split`)
          for (const p of row.paragraphs) {
            assert.equal(p.style, 'Compact', `table ${i + 1}: "${p.text}"`)
            assert.deepEqual(p.runSizes, [], `table ${i + 1}: "${p.text}" has no font size of its own`)
          }
        }
      }
      assert.equal(rowsCantSplit(styles, 'Table'), true, 'the document\'s own table style keeps rows together')
      assert.equal(headerRowFormat(styles, 'Table').color, 'FFFFFF', 'and shades its header row')
    })
  }
})

// #203 (spec #192): every v3 Field that renders into an Artefact has a word budget (`target-words`,
// #202, docs/adr/0054), calibrated from the example as it stood before this ticket: Large is the
// longer of the two bundled examples' lengths for the Field, rounded up to the next ten; Medium is
// about half of Large and Small about a fifth, adjusted per Field where a section is a table or
// inherently short. The v3 CHANGELOG records the measured lengths and the budgets in one table, and
// the tests below hold the Definition to that table, so a later change to a budget changes the record
// too. The examples are then condensed to Medium, the default. The #195 and #199–#201 tests above run
// against the condensed example, so they are what show its captions, state labels, AD table, sourced
// figures, preferred terms and path-led columns survived the cut.
describe('v3 word budgets, and the examples condensed to Medium (#203)', () => {
  const BUDGET_SECTION = /^### .*\(#203\)$/m

  function budgetRecord() {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    const start = changelog.search(BUDGET_SECTION)
    assert.ok(start >= 0, 'the v3 CHANGELOG has a #203 section')
    const ends = ['\n### ', '\n## '].map((heading) => changelog.indexOf(heading, start + 1)).filter((i) => i > 0)
    const section = changelog.slice(start, ends.length ? Math.min(...ends) : undefined)
    const tables = markdownTables(section)
    const fields = tables.find((t) => t.header[0] === 'Field')
    const documents = tables.find((t) => t.header[0] === 'Document')
    assert.ok(fields && documents, 'the section records the per-Field lengths and the rendered documents\' lengths')
    const number = (cell) => (cell === '—' ? null : Number(cell.replace(/,/g, '')))
    return {
      header: fields.header,
      fields: new Map(
        fields.rows.map(([ref, kiwi, gantry, large, medium, small]) => [
          ref.replace(/`/g, ''),
          { kiwi: number(kiwi), gantry: number(gantry), large: number(large), medium: number(medium), small: number(small) },
        ])
      ),
      documents: new Map(documents.rows.map(([id, example, before]) => [id.replace(/`/g, ''), { example: example.replace(/`/g, ''), before: number(before) }])),
    }
  }

  // Every markdown and list Field of v3 whose value reaches a rendered Artefact: each Field of a scratch
  // copy of the full example is set to a marker naming it, every Artefact is rendered, and the markers
  // that come out name the Fields. A Field no template reads would need no budget.
  function renderedFreeTextFields() {
    return withScratchDir((dir) => {
      const slug = 'kiwi-cover-mutual'
      cpSync(join(EXAMPLES_DIR, slug), join(dir, slug), { recursive: true })
      const marker = (moduleId, fieldId) => `zzz${moduleId}0${fieldId}zzz`.replace(/-/g, '1')
      const refs = new Map()
      for (const [moduleId, spec] of v3().modules) {
        const current = readModule(v3(), slug, moduleId, { instancesDir: dir })
        const fields = { ...current.fields }
        for (const field of spec.fields.filter((f) => f.type === 'markdown' || f.type === 'list')) {
          fields[field.id] = field.type === 'list' ? [marker(moduleId, field.id)] : marker(moduleId, field.id)
          refs.set(marker(moduleId, field.id), `${moduleId}.${field.id}`)
        }
        writeModule(v3(), slug, moduleId, { ...current, fields }, { instancesDir: dir })
      }
      const found = new Set()
      for (const artefact of v3().artefacts) {
        const { markdown } = renderArtefact(slug, artefact.id, { instancesDir: dir, dryRun: true })
        for (const [text, ref] of refs) if (markdown.includes(text)) found.add(ref)
      }
      return [...found].sort()
    })
  }

  function budgetedFields() {
    return [...v3().modules].flatMap(([moduleId, spec]) => spec.fields.filter((f) => f.targetWords).map((f) => [`${moduleId}.${f.id}`, f.targetWords]))
  }

  test('every free-text v3 Field that renders into an Artefact has a word budget, with Small < Medium < Large', () => {
    const rendered = renderedFreeTextFields()
    assert.ok(rendered.length > 90, `the marker render finds the Fields (${rendered.length})`)
    const budgets = new Map(budgetedFields())
    assert.deepEqual(rendered.filter((ref) => !budgets.has(ref)), [], 'Fields with no target-words')
    for (const [ref, { small, medium, large }] of budgets) {
      assert.ok(small < medium && medium < large, `${ref}: ${small} < ${medium} < ${large}`)
    }
  })

  test('the v3 CHANGELOG records each budgeted Field\'s pre-condense example lengths beside its budgets, and the Definition matches it', () => {
    const record = budgetRecord()
    assert.deepEqual(record.header, ['Field', 'Kiwi Cover Mutual', 'Gantry hosting', 'Large', 'Medium', 'Small'])
    const budgets = budgetedFields()
    assert.deepEqual([...record.fields.keys()].sort(), budgets.map(([ref]) => ref).sort(), 'one row per budgeted Field')
    for (const [ref, budget] of budgets) {
      const row = record.fields.get(ref)
      assert.deepEqual({ small: row.small, medium: row.medium, large: row.large }, budget, ref)
    }
  })

  test('each Large budget is the longer example\'s pre-condense length rounded up to the next ten', () => {
    for (const [ref, { kiwi, gantry, large }] of budgetRecord().fields) {
      const longest = Math.max(kiwi ?? 0, gantry ?? 0)
      assert.equal(large, Math.max(10, Math.ceil(longest / 10) * 10), `${ref}: measured ${kiwi} / ${gantry}`)
    }
  })

  test('across the Definition, Medium is about half of Large and Small about a fifth', () => {
    const total = Object.fromEntries(TARGET_SIZES.map((size) => [size, budgetedFields().reduce((sum, [, budget]) => sum + budget[size], 0)]))
    const medium = total.medium / total.large
    const small = total.small / total.large
    assert.ok(medium >= 0.45 && medium <= 0.6, `Medium is ${Math.round(medium * 100)}% of Large`)
    assert.ok(small >= 0.15 && small <= 0.3, `Small is ${Math.round(small * 100)}% of Large`)
  })

  for (const slug of Object.keys(EXAMPLES)) {
    test(`${slug} works to Medium, and every one of its Fields is within its Medium budget`, () => {
      assert.ok([undefined, 'medium'].includes(readInstance(slug, { instancesDir: EXAMPLES_DIR }).size), 'no other size is stored')
      const written = Object.fromEntries(
        readdirSync(join(EXAMPLES_DIR, slug, 'modules')).map((file) => {
          const moduleId = file.replace(/\.md$/, '')
          return [moduleId, { fields: readModule(v3(), slug, moduleId, { instancesDir: EXAMPLES_DIR }).fields }]
        })
      )
      assert.deepEqual(overTargetNotes(v3().modules, written, 'medium').map((note) => note.message), [])
    })
  }

  // A rendered document's length is counted as a Field's is (countWords), over the whole dry-run
  // Markdown: cover, Document Control and headings included.
  test('the rendered v3 SAD is roughly half its pre-condense length, and every v3 document is shorter', () => {
    const { documents } = budgetRecord()
    assert.deepEqual([...documents.keys()].sort(), Object.keys(DOCUMENTS).sort())
    const now = new Map()
    for (const [id, { example, before }] of documents) {
      assert.equal(example, DOCUMENTS[id].example, id)
      const { markdown } = renderArtefact(example, id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      now.set(id, countWords(markdown))
      assert.ok(now.get(id) < before, `${id}: ${now.get(id)} words, ${before} before`)
    }
    const ratio = now.get('sad') / documents.get('sad').before
    assert.ok(ratio >= 0.4 && ratio <= 0.6, `the SAD is ${Math.round(ratio * 100)}% of its ${documents.get('sad').before} words`)
  })
})

// #213 (ADR-0057): the SSAD follows the SAD's reading order and heading names, not the FV Help Tool
// SSAD reference's. Every chapter up to Technology architecture is the SAD's, in the SAD's order;
// the support material then stays together in one Support and operations chapter. Same Fields,
// same bare / `?` form, so build-ready-checklist is exactly as strict as on v2.
describe('the v3 SSAD follows the SAD\'s order and headings (#213)', () => {
  const SSAD_REQUIRES = [
    'introduction.executive-summary?',
    'introduction.overview',
    'introduction.purpose',
    'introduction.in-scope',
    'introduction.out-of-scope',
    'introduction.content-standards?',
    'design-basis.assumptions?',
    'design-basis.constraints?',
    'support-and-operations.stakeholders',
    'architecture.solution-description',
    'dependencies.dependency-list',
    'architecture.architectural-risks',
    'risks.open-issues',
    'risks.risk-register',
    'architecture.logical-components',
    'integration.interfaces',
    'support-and-operations.environments-and-domains',
    'data.data-classification',
    'nfrs.disaster-recovery-and-backup',
    'nfrs.scalability-and-capacity',
    'nfrs.availability-and-continuity',
    'security.identity-and-access',
    'security.privacy-and-confidentiality',
    'data-security-controls.controls',
    'data-security-controls.inheritance-and-dependencies?',
    'support-and-operations.operational-accounts-and-licenses',
    'support-and-operations.monitoring-and-alerting',
    'support-and-operations.release-procedures',
    'support-and-operations.support-handover-readiness',
    'glossary.terms-and-definitions',
    'team-and-estimates.references?',
  ]

  // The example fills every SSAD Field, so every optional section shows.
  const SSAD_OUTLINE = [
    '# Overview',
    '## Executive summary',
    '## Overview',
    '## Purpose',
    '## In scope',
    '## Out of scope',
    '## Content standards',
    '# Design basis',
    '## Assumptions',
    '## Constraints',
    '# Business architecture',
    '## Stakeholders and support contacts',
    '# Solution overview',
    '## Solution description',
    '## Dependency list',
    '## Architectural risks',
    '# Open issues',
    '# Risks',
    '## Risk register',
    '# Logical components view',
    '# Technology architecture',
    '## Interfaces',
    '# Support and operations',
    '## Environments, URLs and domains',
    '## Data classification',
    '## Backup and archiving policy',
    '## Scalability and capacity',
    '## Availability and continuity',
    '## Identity and access management',
    '## Privacy and confidentiality concerns',
    '## Security concerns',
    '## Security control inheritance and dependencies',
    '## Operational accounts and licenses',
    '## Monitoring and alerting',
    '## Release procedures',
    '## Support handover readiness',
    '# Glossary',
    '# References',
  ]

  const requiresOf = (definition, id) => definition.artefacts.find((a) => a.id === id).requires
  const outlineOf = (id) =>
    renderArtefact('kiwi-cover-mutual', id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      .markdown.split('\n')
      .filter((line) => /^#{1,2} /.test(line) && !/\{\.unnumbered\}/.test(line))

  test('the SSAD\'s requires list is the new outline, in render order', () => {
    assert.deepEqual(requiresOf(v3(), 'ssad'), SSAD_REQUIRES)
  })

  // #213 moved no Field in or out; #214 added the SAD's Overview paragraph and Design basis. (#196's
  // classification Field left again in #220.)
  test('beyond #214\'s three Fields, no Field entered or left the SSAD, and none changed between mandatory and optional', () => {
    const v2 = loadDefinition(DEFINITION, { version: 2 })
    const added = ['introduction.overview', 'design-basis.assumptions?', 'design-basis.constraints?']
    assert.deepEqual([...requiresOf(v3(), 'ssad')].sort(), [...requiresOf(v2, 'ssad'), ...added].sort())
  })

  test('the rendered SSAD has the SAD-led outline, with the support material in one chapter', () => {
    assert.deepEqual(outlineOf('ssad'), SSAD_OUTLINE)
  })

  test('every SSAD chapter before Support and operations is a SAD chapter, in the SAD\'s order', () => {
    const chapters = (id) => outlineOf(id).filter((line) => line.startsWith('# '))
    const ssad = chapters('ssad')
    const shared = ssad.slice(0, ssad.indexOf('# Support and operations'))
    const sad = chapters('sad')
    assert.deepEqual(sad.filter((chapter) => shared.includes(chapter)), shared)
  })

  // By its text, whatever its level: the SAD's "# Environments, URLs and domains" chapter is a
  // section of Support and operations in the SSAD.
  test('a section both documents render carries the SAD\'s heading, except Stakeholders and support contacts', () => {
    const text = (line) => line.replace(/^#+ /, '')
    const sad = new Set(outlineOf('sad').map(text))
    const ssadOnly = outlineOf('ssad').map(text).filter((heading) => !sad.has(heading))
    assert.deepEqual(ssadOnly, ['Content standards', 'Stakeholders and support contacts', 'Support and operations', 'Release procedures', 'Support handover readiness'])
  })

  test('the change is recorded: the v3 CHANGELOG, ADR-0057 and the User Guide', () => {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    assert.match(changelog.slice(0, changelog.indexOf('\n## v2')), /^### The SSAD follows the SAD's order and headings \(#213\)$/m)
    assert.ok(existsSync('docs/adr/0057-the-ssad-follows-the-sad-not-its-reference-instance.md'))
    assert.match(readFileSync('docs/user-guide/index.md', 'utf8'), /\*\*Version 3 \(draft\)\*\* puts the SSAD in the SAD's order/)
  })
})

// #214: the SSAD opens the way the SAD does, with the Overview paragraph and a Design basis chapter
// (assumptions and constraints). Authors are asked for nothing new: the SAD already requires the
// Overview paragraph at build-ready-checklist, and Design basis is optional and shows only when filled.
describe('the v3 SSAD opens with the SAD\'s Overview paragraph and Design basis (#214)', () => {
  test('the SSAD renders the same Overview paragraph and Design basis as the SAD', () => {
    const render = (id) => renderArtefact('kiwi-cover-mutual', id, { instancesDir: EXAMPLES_DIR, dryRun: true }).markdown
    const [sad, ssad] = [render('sad'), render('ssad')]
    for (const heading of ['## Overview', '# Design basis']) assert.equal(sectionOf(ssad, heading), sectionOf(sad, heading), heading)
    for (const heading of ['## Assumptions', '## Constraints']) assert.equal(sectionOf(ssad, heading), sectionOf(sad, heading), heading)
  })

  test('with assumptions and constraints both blank, the SSAD has no Design basis heading; with one filled, only its section shows', () => {
    withScratchDir((dir) => {
      const slug = 'kiwi-cover-mutual'
      cpSync(join(EXAMPLES_DIR, slug), join(dir, slug), { recursive: true })
      const setDesignBasis = (fields) => {
        const current = readModule(v3(), slug, 'design-basis', { instancesDir: dir })
        writeModule(v3(), slug, 'design-basis', { ...current, fields: { ...current.fields, ...fields } }, { instancesDir: dir })
      }
      const headings = () =>
        renderArtefact(slug, 'ssad', { instancesDir: dir, dryRun: true })
          .markdown.split('\n')
          .filter((line) => /^#{1,2} (Design basis|Assumptions|Constraints)$/.test(line))

      setDesignBasis({ assumptions: '', constraints: '' })
      assert.deepEqual(headings(), [])
      setDesignBasis({ constraints: 'Must run in the existing data centre.' })
      assert.deepEqual(headings(), ['# Design basis', '## Constraints'])
    })
  })

  // The example still passing build-ready-checklist is covered by the #193 harness above.
  test('a blank Overview paragraph holds up the SSAD at build-ready-checklist, as it already holds up the SAD', () => {
    withScratchDir((dir) => {
      const slug = 'kiwi-cover-mutual'
      cpSync(join(EXAMPLES_DIR, slug), join(dir, slug), { recursive: true })
      const current = readModule(v3(), slug, 'introduction', { instancesDir: dir })
      writeModule(v3(), slug, 'introduction', { ...current, fields: { ...current.fields, overview: '' } }, { instancesDir: dir })
      const result = checkGate(slug, { instancesDir: dir, gate: 'build-ready-checklist' })
      for (const id of ['sad', 'ssad']) {
        const artefact = result.artefacts.find((a) => a.id === id)
        assert.ok(JSON.stringify(artefact.outstanding).includes('introduction.overview'), `${id}: ${JSON.stringify(artefact.outstanding)}`)
      }
    })
  })

  test('the change is recorded: the v3 CHANGELOG and the User Guide', () => {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    assert.match(changelog.slice(0, changelog.indexOf('\n## v2')), /^### The SSAD opens with the Overview and Design basis \(#214\)$/m)
    const guide = readFileSync('docs/user-guide/index.md', 'utf8')
    assert.match(guide, /\| Overview › Overview `introduction\.overview` \|[^\n]*SSAD/)
    assert.match(guide, /\| Design Basis › Constraints `design-basis\.constraints` \|[^\n]*SSAD/)
    assert.match(guide, /\| Design Basis › Assumptions `design-basis\.assumptions` \|[^\n]*SSAD/)
  })
})

// #231 (ADR-0060): the As-built follows the SAD's reading order and heading names wherever the two
// render the same Field, as the SSAD does since #213, rather than the ATLAS reference's. Its own
// chapters (As-built design, Appendix and the four handover chapters) keep their order after the
// shared ones. The optional Executive summary is the only Field added, so operational-handover is
// exactly as strict as on v2. The digests in the #193 block keep v1 and v2 as they were.
describe('the v3 As-built follows the SAD\'s order and headings (#231)', () => {
  const AS_BUILT_REQUIRES = [
    'introduction.executive-summary?',
    'introduction.overview',
    'introduction.purpose',
    'introduction.in-scope',
    'introduction.out-of-scope',
    'design-basis.assumptions?',
    'design-basis.constraints?',
    'design-basis.caveats?',
    'design-basis.design-principles?',
    'design-basis.outcomes-and-deliverables?',
    'as-built-notes.design-overview',
    'as-built-notes.architecture-decisions?',
    'as-built-notes.process-flows',
    'as-built-notes.infrastructure-and-configuration',
    'recovery-plan.recovery-approach',
    'recovery-plan.resiliency?',
    'recovery-plan.test-scenarios?',
    'recovery-plan.raci?',
    'nfrs.disaster-recovery-and-backup',
    'data-security-controls.controls',
    'data-security-controls.inheritance-and-dependencies?',
    'as-built-notes.appendix?',
    'as-built-notes.changes-from-design',
    'as-built-notes.acceptance-criteria',
    'as-built-notes.operational-notes?',
    'as-built-notes.handover-confirmation',
    'glossary.terms-and-definitions',
  ]

  // The example fills every As-built Field, so every optional section shows.
  const AS_BUILT_OUTLINE = [
    '# Overview',
    '## Executive summary',
    '## Overview',
    '## Purpose',
    '## In scope',
    '## Out of scope',
    '# Design basis',
    '## Assumptions',
    '## Constraints',
    '## Caveats',
    '## Design principles',
    '## Outcomes and deliverables',
    '# As-built design',
    '## As-built overview',
    '## Architecture decisions',
    '## Data migration and process flows',
    '## Infrastructure and configuration',
    '# Failure and recovery',
    '## Recovery approach',
    '## Resiliency',
    '## Test scenarios',
    '## RACI',
    '## Backup and archiving policy',
    '# Security',
    '## Security concerns',
    '## Security control inheritance and dependencies',
    '# Appendix',
    '# Changes from the agreed design',
    '# Acceptance criteria',
    '# Operational notes',
    '# Handover confirmation',
    '# Glossary',
  ]

  // The headings only the As-built has: its own chapters, and the Design basis Fields the SAD leaves
  // out of its scope.
  const AS_BUILT_ONLY = [
    'Caveats',
    'Design principles',
    'Outcomes and deliverables',
    'As-built design',
    'As-built overview',
    'Architecture decisions',
    'Data migration and process flows',
    'Infrastructure and configuration',
    'Appendix',
    'Changes from the agreed design',
    'Acceptance criteria',
    'Operational notes',
    'Handover confirmation',
  ]

  const slug = 'kiwi-cover-mutual'
  const requiresOf = (definition) => definition.artefacts.find((a) => a.id === 'as-built').requires
  const render = (id, instancesDir = EXAMPLES_DIR) => renderArtefact(slug, id, { instancesDir, dryRun: true }).markdown
  const outlineOf = (markdown) => markdown.split('\n').filter((line) => /^#{1,2} /.test(line) && !/\{\.unnumbered\}/.test(line))
  const text = (line) => line.replace(/^#+ /, '')

  // A scratch copy of the bundled example, and a way to write over some of a Module's Fields in it.
  function withExample(fn) {
    return withScratchDir((dir) => {
      cpSync(join(EXAMPLES_DIR, slug), join(dir, slug), { recursive: true })
      const setFields = (moduleId, fields) => {
        const current = readModule(v3(), slug, moduleId, { instancesDir: dir })
        writeModule(v3(), slug, moduleId, { ...current, fields: { ...current.fields, ...fields } }, { instancesDir: dir })
      }
      return fn(dir, setFields)
    })
  }

  test('the As-built\'s requires list is the new outline, in render order', () => {
    assert.deepEqual(requiresOf(v3()), AS_BUILT_REQUIRES)
  })

  test('beyond the optional Executive summary, no Field entered or left the As-built, none changed between mandatory and optional, and no Module is newly mounted', () => {
    const v2 = loadDefinition(DEFINITION, { version: 2 })
    assert.deepEqual([...requiresOf(v3())].sort(), [...requiresOf(v2), 'introduction.executive-summary?'].sort())
    const handover = (definition) => definition.stages.find((stage) => stage.id === 'handover').modules
    assert.deepEqual(handover(v3()), handover(v2))
  })

  test('with every As-built Field blank, operational-handover holds up exactly the Fields it held up on v2', () => {
    withExample((dir, setFields) => {
      for (const moduleId of new Set(AS_BUILT_REQUIRES.map((entry) => entry.split('.')[0]))) {
        const { fields } = readModule(v3(), slug, moduleId, { instancesDir: dir })
        setFields(moduleId, Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, Array.isArray(value) ? [] : ''])))
      }
      const outstanding = () => {
        const result = checkGate(slug, { instancesDir: dir, gate: 'operational-handover' })
        assert.equal(result.pass, false)
        return {
          artefact: [...result.artefacts.find((a) => a.id === 'as-built').outstanding].sort(),
          modules: result.modules.map((m) => [m.id, [...m.outstanding].sort()]),
        }
      }
      const onV3 = outstanding()
      const file = join(dir, slug, 'instance.yaml')
      writeFileSync(file, readFileSync(file, 'utf8').replace('definitionVersion: 3', 'definitionVersion: 2'))
      assert.deepEqual(onV3, outstanding())
    })
  })

  test('the rendered As-built has the SAD-led outline, with its own chapters after the shared ones', () => {
    assert.deepEqual(outlineOf(render('as-built')), AS_BUILT_OUTLINE)
  })

  test('the chapters the As-built shares with the SAD are in the SAD\'s order', () => {
    const chapters = (id) => outlineOf(render(id)).filter((line) => line.startsWith('# '))
    const sad = chapters('sad')
    const shared = chapters('as-built').filter((chapter) => sad.includes(chapter))
    assert.deepEqual(shared, ['# Overview', '# Design basis', '# Failure and recovery', '# Security', '# Glossary'])
    assert.deepEqual(sad.filter((chapter) => shared.includes(chapter)), shared)
  })

  // Same heading and same content: a Field both documents render sits under the SAD's heading in the
  // As-built, not merely a heading of the same name.
  test('a section both documents render carries the SAD\'s heading, and the same Field under it', () => {
    const [sad, asBuilt] = [render('sad'), render('as-built')]
    const sadHeadings = new Set(outlineOf(sad))
    const shared = outlineOf(asBuilt).filter((heading) => sadHeadings.has(heading))
    assert.deepEqual(outlineOf(asBuilt).filter((heading) => !shared.includes(heading)).map(text), AS_BUILT_ONLY)
    for (const heading of shared.filter((h) => h.startsWith('## ')).concat('# Glossary')) {
      assert.equal(sectionOf(asBuilt, heading).trimEnd(), sectionOf(sad, heading).trimEnd(), heading)
    }
  })

  test('the Executive summary shows only when filled, and a blank one still passes operational-handover', () => {
    withExample((dir, setFields) => {
      assert.match(render('as-built', dir), /^## Executive summary$/m)
      setFields('introduction', { 'executive-summary': '' })
      assert.doesNotMatch(render('as-built', dir), /^## Executive summary$/m)
      assert.equal(checkGate(slug, { instancesDir: dir, gate: 'operational-handover' }).pass, true)
    })
  })

  test('with every Design basis Field blank there is no Design basis heading; with some filled, only theirs show, Assumptions first', () => {
    withExample((dir, setFields) => {
      const designBasis = /^#{1,2} (Design basis|Assumptions|Constraints|Caveats|Design principles|Outcomes and deliverables)$/
      const headings = () => outlineOf(render('as-built', dir)).filter((line) => designBasis.test(line))
      setFields('design-basis', { assumptions: '', constraints: '', caveats: '', 'design-principles': '', 'outcomes-and-deliverables': '' })
      assert.deepEqual(headings(), [])
      setFields('design-basis', { constraints: 'Must run in the existing data centre.', caveats: 'Valuation stays partly manual.' })
      assert.deepEqual(headings(), ['# Design basis', '## Constraints', '## Caveats'])
      setFields('design-basis', { assumptions: 'Claim volumes stay within 20 percent of today\'s.' })
      assert.deepEqual(headings(), ['# Design basis', '## Assumptions', '## Constraints', '## Caveats'])
    })
  })

  // The front matter the #196 block checks in the Markdown, here in the Word document itself, as the
  // SAD's Word tests do (above, and tests/tableOfContentsPrefill.test.js for its table of contents).
  test('in Word, the As-built keeps the SAD\'s front matter: its cover, Document Control, then a filled-in table of contents in the new order', () => {
    const artefact = v3().artefacts.find((a) => a.id === 'as-built')
    const { result, documentXml } = renderWord(slug, 'as-built')
    const paragraphs = bodyParagraphs(documentXml)
    const documentControl = paragraphs.findIndex((p) => p.text === 'Document Control')
    const contents = paragraphs.findIndex((p) => p.style === 'TOCHeading')
    assert.deepEqual(
      paragraphs.slice(0, documentControl).filter((p) => p.text.trim() !== '').map(({ style, text }) => [style, text]),
      [
        ['CoverClassification', 'IN-CONFIDENCE'],
        ['Title', 'Kiwi Cover Mutual'],
        ['Subtitle', 'As-built'],
        ['CoverDetails', 'Version: design v3 · Operational Handover'],
        ['CoverDetails', 'Status: Draft'],
        ['CoverDetails', 'Author: c.barlow'],
        ['CoverPurpose', artefact.coverPurpose.replace(/\s+/g, ' ').trim()],
      ],
      'the cover: classification, title, document type, version, status, author and cover purpose'
    )
    assert.ok(contents > documentControl, 'the table of contents follows Document Control')
    assert.equal(paragraphs[contents].text, 'Table of Contents')

    const toc = tableOfContents(documentXml)
    assert.equal(toc.dirty, true, 'Word still rebuilds it, with page numbers, on open')
    const styles = wordStyles(docxPart(result.docxBytes, 'word/styles.xml'))
    const expected = expectedTableOfContents(documentXml, styles, docxPart(result.docxBytes, 'word/numbering.xml'))
    assert.deepEqual(toc.entries.map(({ style, text }) => ({ style, text })), expected.map(({ style, text }) => ({ style, text })))
    const bookmarks = headingBookmarks(documentXml)
    for (const [i, entry] of toc.entries.entries()) assert.equal(bookmarks.get(entry.anchor)?.heading, expected[i].heading, entry.text)

    const chapters = AS_BUILT_OUTLINE.filter((line) => line.startsWith('# ')).map((line, i) => `${i + 1}\t${text(line)}`)
    assert.deepEqual(toc.entries.filter((e) => e.style === 'TOC1').map((e) => e.text), chapters, 'one numbered entry per chapter, in the new order')
    assert.deepEqual(toc.entries.slice(0, 4).map((e) => e.text), ['Document Control', 'Review & sign-off', '1\tOverview', '1.1\tExecutive summary'])
  })

  test('the change is recorded: the v3 CHANGELOG, ADR-0060 (pointed to from ADR-0057) and the User Guide', () => {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    assert.match(changelog.slice(0, changelog.indexOf('\n## v2')), /^### The As-built follows the SAD's order and headings \(#231\)$/m)
    const adr = readdirSync('docs/adr').filter((file) => file.startsWith('0060-'))
    assert.equal(adr.length, 1, 'one ADR-0060')
    assert.match(readFileSync(join('docs/adr', adr[0]), 'utf8'), /standing template/)
    assert.match(readFileSync('docs/adr/0057-the-ssad-follows-the-sad-not-its-reference-instance.md', 'utf8'), /ADR-0060/)
    assert.match(readFileSync('docs/user-guide/index.md', 'utf8'), /\*\*Version 3 \(draft\)\*\* puts the As-built in the SAD's order/)
  })
})
