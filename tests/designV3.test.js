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

const DEFINITION = 'design'
const VERSION = 3
const EXAMPLES_DIR = 'workspaces/examples'

// The Gates each bundled example passes on v3. Kiwi Cover Mutual is the full worked design, filled
// in at every Stage; the gantry instance is Gantry's own hosting proposal, a complete Full SOAP at
// the Shape stage only.
const EXAMPLES = {
  'kiwi-cover-mutual': { gates: ['business-case', 'hld-arb-approved', 'build-ready-checklist', 'operational-handover'] },
  gantry: { gates: ['business-case'] },
}

// Each Stage's "Populate example text" source: the one example that covers every Stage.
const STAGE_EXAMPLE = 'kiwi-cover-mutual'

// Every v3 Artefact, rendered from the example named here. `heading` is the document's opening
// heading, which still carries the slug until #196 replaces it with the display name.
const DOCUMENTS = {
  soap: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution on a Page', heading: '# kiwi-cover-mutual: Solution on a Page' },
  'soap-full': { example: 'gantry', basename: 'Gantry hosting - Full Solution on a Page', heading: '# gantry: Full Solution on a Page' },
  hld: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - High Level Design', heading: '# kiwi-cover-mutual: High Level Design' },
  sad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Architecture Document', heading: '# kiwi-cover-mutual: Solution Architecture Document' },
  ssad: {
    example: 'kiwi-cover-mutual',
    basename: 'Kiwi Cover Mutual - Solution Support Architecture Document',
    heading: '# kiwi-cover-mutual: Solution Support Architecture Document',
  },
  'as-built': { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - As-built', heading: '# kiwi-cover-mutual: As-built' },
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

  test('v3 has the same Stages, Gates, Artefacts and Modules as v2', () => {
    const v2 = loadDefinition(DEFINITION, { version: 2 })
    const outline = (def) => ({
      stages: def.stages.map((s) => [s.id, s.gate, s.modules]),
      artefacts: def.artefacts.map((a) => [a.id, a.title]),
      modules: [...def.modules.keys()].sort(),
    })
    assert.deepEqual(outline(v3()), outline(v2))
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
  // the same under v2 as under v3, and v2's "Populate example text" keeps filling.
  test('the migrated example content still reads field-for-field under v2', () => {
    const v2 = loadDefinition(DEFINITION, { version: 2 })
    for (const slug of Object.keys(EXAMPLES)) {
      for (const file of readdirSync(join(EXAMPLES_DIR, slug, 'modules'))) {
        const moduleId = file.replace(/\.md$/, '')
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
