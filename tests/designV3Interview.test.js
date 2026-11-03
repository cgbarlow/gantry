import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import { loadDefinition, findDefinitionProblems, definitionVersionProjection } from '../lib/definition.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { STANDARD_MODULES } from '../web/lib/standardModules.js'
import { removeCitations } from './helpers/uncite.js'

// #308 (v0.13.0, #258, #252): design v3 is published with Gantry's Glossary, Open questions and Key
// decisions standard modules (ADR-0065), its own Interview instructions (ADR-0062) and the Sources
// appendix (#281). The Key decisions' content and rendering is pinned in tests/designV3.test.js beside
// the other v3 conventions; this file pins the mounts, the Interview instructions and the appendix.

const EXAMPLES_DIR = 'workspaces/examples'
const EXAMPLE = 'kiwi-cover-mutual'
const v3 = () => loadDefinition('design', { version: 3 })

describe('design v3 mounts the standard modules', () => {
  test('v3 validates in both validators and is published', () => {
    assert.equal(v3().status, 'published')
    assert.deepEqual(findDefinitionProblems('design', { version: 3 }), [])
    assert.deepEqual(findLocalDefinitionProblems(definitionVersionProjection(v3())), [])
  })

  test('Glossary, Open questions and Key decisions are mounted at version 1, in Gantry\'s shape, and v3 has no Modules of its own with those ids', () => {
    const def = v3()
    assert.deepEqual(def.standardModules.map((m) => [m.id, m.version]), [['glossary', 1], ['open-questions', 1], ['key-decisions', 1]])
    for (const id of ['glossary', 'open-questions', 'key-decisions']) {
      assert.deepEqual(def.modules.get(id).standard.version, 1, id)
      assert.deepEqual(def.modules.get(id).fields.map((f) => f.id), STANDARD_MODULES[id].versions[1].fields.map((f) => f.id), id)
      assert.equal(existsSync(join('definitions/design/3/modules', `${id}.yaml`)), false, `${id} is not a Module file`)
    }
    assert.deepEqual(def.modules.get('glossary').fields.map((f) => f.id), ['terms'])
    assert.deepEqual(def.modules.get('open-questions').fields.map((f) => f.id), ['questions'])
    assert.deepEqual(def.modules.get('key-decisions').fields.map((f) => f.id), ['decisions'])
  })

  test('they are mounted on the Stages that carried the Modules they replace', () => {
    const stages = (id) => v3().stages.filter((s) => s.modules.includes(id)).map((s) => s.id)
    assert.deepEqual(stages('glossary'), ['detailed-design', 'handover'])
    assert.deepEqual(stages('open-questions'), ['shape', 'hld-define'])
    assert.deepEqual(stages('key-decisions'), ['detailed-design', 'handover'])
    const v2 = loadDefinition('design', { version: 2 })
    assert.deepEqual(v2.stages.filter((s) => s.modules.includes('glossary')).map((s) => s.id), stages('glossary'))
    assert.deepEqual(v2.stages.filter((s) => s.modules.includes('open-questions')).map((s) => s.id), stages('open-questions'))
  })

  test('every Artefact that printed the Fields prints the standard ones, with Gate arithmetic unchanged', () => {
    const v2 = loadDefinition('design', { version: 2 })
    const requires = (def, id) => def.artefacts.find((a) => a.id === id).requires
    const rename = (ref) => ref.replace('glossary.terms-and-definitions', 'glossary.terms').replace('architecture.design-decisions', 'key-decisions.decisions').replace('as-built-notes.architecture-decisions', 'key-decisions.decisions')
    // v3 reorders and adds to some Artefacts (#213, #231, #232), so compare only the standard modules' entries, not the order. A bare entry stays bare and an optional one stays optional.
    for (const artefact of v2.artefacts) {
      const standard = (refs) => refs.filter((r) => /^(glossary|key-decisions|open-questions)\./.test(r)).sort()
      assert.deepEqual(standard(requires(v3(), artefact.id)), standard(requires(v2, artefact.id).map(rename)), `${artefact.id} requires`)
    }
  })

  test('the mounts add this process\'s guidance, which reaches the Fields', () => {
    const def = v3()
    assert.match(def.modules.get('glossary').fields[0].guidance, /Contracted name/)
    assert.match(def.modules.get('open-questions').fields[0].guidance, /Full SOAP/)
    assert.match(def.modules.get('key-decisions').fields[0].guidance, /ADRYYY/)
    assert.match(def.modules.get('glossary').fields[0].guidance, /Preferred term \| Definition \| Avoid/, 'Gantry\'s own guidance comes first')
  })
})

describe('design v3 has its own Interview instructions', () => {
  test('at the Definition, every Stage and the Glossary and Key decisions mounts', () => {
    const def = v3()
    assert.match(def.interview, /New Zealand spelling/)
    assert.match(def.interview, /\(target assumption\)/)
    for (const stage of def.stages) assert.ok(stage.interview && stage.interview.trim().length > 40, `${stage.id} has Interview instructions`)
    assert.match(def.modules.get('glossary').interview, /Glossary row/)
    assert.match(def.modules.get('key-decisions').interview, /ADR candidate/)
    assert.equal(def.modules.get('open-questions').interview, undefined)
  })

  test('they only add: none claims to override Gantry\'s rules', () => {
    const def = v3()
    const all = [def.interview, ...def.stages.map((s) => s.interview), ...[...def.modules.values()].map((m) => m.interview)].filter(Boolean).join('\n')
    assert.doesNotMatch(all, /\b(ignore|override|instead of Gantry|never pass)\b/i)
    assert.doesNotMatch(all, /\bapprove (the )?(Gate|stage)\b/i)
  })

  test('v1 and v2 carry none', () => {
    for (const version of [1, 2]) {
      const def = loadDefinition('design', { version })
      assert.equal(def.interview, undefined, `v${version}`)
      assert.equal(def.standardModules, undefined, `v${version}`)
      assert.ok(def.stages.every((s) => s.interview === undefined), `v${version} stages`)
    }
  })
})

describe('design v3 and the older versions', () => {
  test('v3 is the default for a new design Instance, and an Instance on v2 reads it as v2 with its tables and no standard modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gantry-design-308-'))
    try {
      createInstance('design', 'fresh', { instancesDir: dir })
      assert.equal(readInstance('fresh', { instancesDir: dir }).definitionVersion, 3)
      createInstance('design', 'older', { instancesDir: dir, definitionVersion: 2 })
      assert.equal(readInstance('older', { instancesDir: dir }).definitionVersion, 2)
      const older = loadDefinition('design', { version: 2 })
      assert.ok(older.modules.get('glossary').fields.some((f) => f.id === 'terms-and-definitions'))
      assert.equal(older.modules.get('glossary').standard, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// A scratch copy of the example, with a Source document cited from a Field each Artefact prints
// (the Background for the SOAP, Full SOAP and HLD; the Overview for the SAD, SSAD and As-built).
const CITED = 'Claims take 12.4 working days to pay [Client brief, p. 4](source:client-brief).'
const MANIFEST = [
  { id: 'client-brief', filename: 'Client brief v3.docx', title: 'Client brief', uploadedBy: 'a.architect', uploadedAt: '2026-03-04T09:30:00.000Z', size: 1000 },
  { id: 'never-cited', filename: 'other.pdf', title: 'Never cited', uploadedBy: 'a.architect', uploadedAt: '2026-01-01T00:00:00.000Z', size: 10 },
]

function withCitingExample({ cite = true, version = 3 } = {}, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-design-308-sources-'))
  try {
    cpSync(join(EXAMPLES_DIR, EXAMPLE), join(root, EXAMPLE), { recursive: true })
    rmSync(join(root, EXAMPLE, 'out'), { recursive: true, force: true })
    if (version !== 3) {
      const file = join(root, EXAMPLE, 'instance.yaml')
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^definitionVersion: \d+$/m, `definitionVersion: ${version}`))
    }
    if (!cite) removeCitations(join(root, EXAMPLE))
    if (cite) {
      for (const [module, heading] of [['background', '\n## Affected domains'], ['introduction', '\n## Purpose']]) {
        const path = join(root, EXAMPLE, 'modules', `${module}.md`)
        const text = readFileSync(path, 'utf8')
        const cited = text.replace(heading, `\n${CITED}\n${heading}`)
        assert.notEqual(cited, text, `the citation lands in ${module}`)
        writeFileSync(path, cited)
      }
      mkdirSync(join(root, EXAMPLE, 'sources'), { recursive: true })
      writeFileSync(join(root, EXAMPLE, 'sources', 'manifest.yaml'), stringifyYAML(MANIFEST))
    }
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('design v3 ends every Artefact with a Sources appendix where it cites a Source document', () => {
  test('every Artefact sets source-appendix', () => {
    assert.deepEqual(v3().artefacts.map((a) => [a.id, a.sourceAppendix]), v3().artefacts.map((a) => [a.id, true]))
  })

  for (const id of ['soap', 'soap-full', 'hld', 'sad', 'ssad', 'as-built']) {
    test(`${id} ends with a table of only the documents it cites`, () => {
      withCitingExample({}, (instancesDir) => {
        for (const options of [{ wordTags: false }, {}]) {
          const result = renderArtefact(EXAMPLE, id, { instancesDir, dryRun: true, ...options })
          for (const text of [result.markdown, result.docxMarkdown]) {
            const appendix = text.slice(text.lastIndexOf('# Sources'))
            assert.equal(
              appendix.trim(),
              ['# Sources', '', '| Document | File | Added |', '| --- | --- | --- |', '| Client brief | Client brief v3.docx | 4 Mar 2026 |'].join('\n'),
              id
            )
            assert.ok(!text.includes('Never cited'))
          }
        }
      })
    })
  }

  test('an Artefact that cites nothing has no Sources list', () => {
    withCitingExample({ cite: false }, (instancesDir) => {
      for (const id of ['soap', 'sad', 'as-built']) {
        const result = renderArtefact(EXAMPLE, id, { instancesDir, dryRun: true })
        assert.doesNotMatch(result.markdown, /^# Sources$/m, id)
      }
    })
  })

  test('an Instance on v2 renders the same cited text with no Sources list', () => {
    withCitingExample({ version: 2 }, (instancesDir) => {
      const result = renderArtefact(EXAMPLE, 'soap', { instancesDir, dryRun: true })
      assert.doesNotMatch(result.markdown, /^# Sources$/m)
      assert.doesNotMatch(result.docxMarkdown, /^# Sources$/m)
    })
  })
})

describe('the bundled examples still pass every Gate on v3', () => {
  const gates = {
    [EXAMPLE]: ['business-case', 'hld-arb-approved', 'build-ready-checklist', 'operational-handover'],
    gantry: ['business-case'],
  }
  for (const [slug, list] of Object.entries(gates)) {
    for (const gate of list) {
      test(`${slug} passes ${gate}`, () => {
        const result = checkGate(slug, { instancesDir: EXAMPLES_DIR, gate })
        assert.equal(result.pass, true, JSON.stringify(result.artefacts.map((a) => [a.id, a.outstanding])))
      })
    }
  }

  test('their Open questions are the standard table, and the Glossary uses the Avoid column', () => {
    for (const slug of [EXAMPLE, 'gantry']) {
      assert.match(readFileSync(join(EXAMPLES_DIR, slug, 'modules/open-questions.md'), 'utf8'), /\| Question \| Who resolves \| By when \| Status \|/, slug)
    }
    assert.match(readFileSync(join(EXAMPLES_DIR, EXAMPLE, 'modules/glossary.md'), 'utf8'), /\| Preferred term \| Definition \| Avoid \|/)
  })
})
