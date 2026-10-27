import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadDefinition, loadDefinitionChangelog, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, readInstance, readModule, writeModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { countWords, overTargetNotes, TARGET_SIZES } from '../web/lib/targetSize.js'
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
    const after = documentXml.slice(documentXml.indexOf('>Design decisions<'))
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
