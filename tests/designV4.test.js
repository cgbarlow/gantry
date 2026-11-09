import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { listDefinitions, loadDefinition, loadDefinitionChangelog, definitionVersionProjection, findDefinitionProblems } from '../lib/definition.js'
import { createInstance, readInstance, readModule, writeModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { checkGate } from '../lib/check.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { designV3Examples, moveExampleBackToV3, V3_REFERENCES } from './helpers/designExamples.js'

// #359: design v4 is v3 without `team-and-estimates.references`. A v3 document printed the same
// documents twice, under References and then under the Sources appendix that lists every Source
// document it cites; Sources is now the document's one list of what it drew on. v4 started as a file
// copy of v3, as v3 did of v2 (#193), so the comments and the changelog history carry over; then the
// Field left the Module, every template and every `requires` list, and nothing else changed. v3 stays
// published and byte for byte as it was, so an Instance on it renders exactly as before.
//
// The harness follows tests/designV3.test.js's: the version itself; the examples on v4; every
// Artefact rendered from them. Those v3 tests keep pinning v3, on a copy of the examples as they were
// on v3 (tests/helpers/designExamples.js).

const DEFINITION = 'design'
const VERSION = 4
const EXAMPLES_DIR = 'workspaces/examples'
const DROPPED = 'team-and-estimates.references'

// The Gates each bundled example passes, the same on v4 as on v3.
const EXAMPLES = {
  'kiwi-cover-mutual': ['business-case', 'hld-arb-approved', 'build-ready-checklist', 'operational-handover'],
  gantry: ['business-case'],
}

const STAGE_EXAMPLE = 'kiwi-cover-mutual'

// Every v4 Artefact, rendered from the example named here, and its rendered filename.
const DOCUMENTS = {
  soap: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution on a Page' },
  'soap-full': { example: 'gantry', basename: 'Gantry hosting - Full Solution on a Page' },
  hld: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - High Level Design' },
  sad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Architecture Document' },
  ssad: { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - Solution Support Architecture Document' },
  'as-built': { example: 'kiwi-cover-mutual', basename: 'Kiwi Cover Mutual - As-built' },
}

// v1, v2 and v3 must stay byte for byte as published: a SHA-256 over each version folder's files
// (sorted relative path, then contents), the same digest tests/designV3.test.js takes. Never update
// these to make a test pass: a mismatch means a published version was edited.
const PUBLISHED_DIGESTS = {
  1: '0ae25f645898869d4274b3b9d1f80978dcb543ee21a9a18ade91378bdc6577ca',
  2: 'e3d5fea9932e877ec79e91fa5b7d4e9e2085718070572d71eaecf7f095c9b0bb',
  3: 'ef38a81d518a3c53358e0a296be504e8a4f745568724ed3baeb25978742429a3',
}

// The only files v4 changed from v3. Every other file, the reference Word documents among them, is v3's.
const CHANGED_FILES = [
  'CHANGELOG.md',
  'definition.yaml',
  'modules/team-and-estimates.yaml',
  'templates/sad.md.tmpl',
  'templates/soap-full.md.tmpl',
  'templates/soap.md.tmpl',
  'templates/ssad.md.tmpl',
]

const v4 = () => loadDefinition(DEFINITION, { version: VERSION })
const v3 = () => loadDefinition(DEFINITION, { version: 3 })
const versionDir = (version) => join('definitions', DEFINITION, String(version))

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
  const dir = mkdtempSync(join(tmpdir(), 'gantry-design-v4-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A scratch copy of one bundled example, so a test can change it.
function withExample(slug, fn) {
  return withScratchDir((dir) => {
    cpSync(join(EXAMPLES_DIR, slug), join(dir, slug), { recursive: true })
    rmSync(join(dir, slug, 'out'), { recursive: true, force: true })
    return fn(dir)
  })
}

const render = (slug, id, instancesDir = EXAMPLES_DIR) => renderArtefact(slug, id, { instancesDir, dryRun: true }).markdown
const headings = (markdown) => markdown.split('\n').filter((line) => /^#{1,2} /.test(line))
const withoutDropped = (requires) => requires.filter((ref) => ref.replace(/\?$/, '') !== DROPPED)

describe('design v4 is v3 without References (#359)', () => {
  test('v4 is published and is the latest published version; v1, v2 and v3 stay published', () => {
    assert.equal(v4().status, 'published')
    assert.equal(v4().version, VERSION)
    for (const version of [1, 2, 3]) assert.equal(loadDefinition(DEFINITION, { version }).status, 'published', `v${version}`)
    assert.equal(listDefinitions().find((d) => d.id === DEFINITION).latestPublished, VERSION)
    assert.equal(loadDefinition(DEFINITION).version, VERSION, 'loading design with no version gives v4')
  })

  test('a new design Instance pins v4, and one created on v3 stays on v3', () => {
    withScratchDir((instancesDir) => {
      createInstance(DEFINITION, 'new-initiative', { instancesDir })
      assert.equal(readInstance('new-initiative', { instancesDir }).definitionVersion, VERSION)
      createInstance(DEFINITION, 'older-initiative', { instancesDir, version: 3 })
      assert.equal(readInstance('older-initiative', { instancesDir }).definitionVersion, 3)
    })
  })

  test('findDefinitionProblems and its Local Workspace twin report zero problems for v4', () => {
    assert.deepEqual(findDefinitionProblems(DEFINITION, { version: VERSION }), [])
    assert.deepEqual(findLocalDefinitionProblems(definitionVersionProjection(v4())), [])
  })

  test('gantry validate passes on v4', () => {
    const out = execFileSync(process.execPath, ['bin/gantry.js', 'validate', DEFINITION, '--version', String(VERSION)], { encoding: 'utf8' })
    assert.match(out, /valid/i)
  })

  test('v1, v2 and v3 are byte for byte unchanged', () => {
    for (const [version, digest] of Object.entries(PUBLISHED_DIGESTS)) {
      assert.equal(folderDigest(versionDir(version)), digest, `definitions/design/${version} changed`)
    }
  })

  test('v4 is a file copy of v3: every file but the ones #359 changed is v3\'s, byte for byte', () => {
    const files = (version) => filesUnder(versionDir(version)).map((f) => relative(versionDir(version), f)).sort()
    assert.deepEqual(files(VERSION), files(3))
    const changed = files(VERSION).filter((file) => !readFileSync(join(versionDir(VERSION), file)).equals(readFileSync(join(versionDir(3), file))))
    assert.deepEqual(changed, CHANGED_FILES)
  })

  test('the References Field is gone from the Module, and every other Field of every Module is v3\'s', () => {
    const fields = (def, id) => def.modules.get(id).fields
    assert.deepEqual(fields(v4(), 'team-and-estimates').map((f) => f.id), ['teams-required', 'estimates'])
    assert.deepEqual(fields(v4(), 'team-and-estimates'), fields(v3(), 'team-and-estimates').filter((f) => f.id !== 'references'))
    assert.deepEqual([...v4().modules.keys()].sort(), [...v3().modules.keys()].sort())
    for (const id of v3().modules.keys()) {
      if (id === 'team-and-estimates') continue
      assert.deepEqual(v4().modules.get(id), v3().modules.get(id), id)
    }
  })

  test('no Artefact requires References any more, and nothing else about any Artefact or Stage changed', () => {
    for (const artefact of v4().artefacts) {
      assert.ok(!artefact.requires.some((ref) => ref.startsWith(`${DROPPED}`)), `${artefact.id} no longer requires References`)
      const before = v3().artefacts.find((a) => a.id === artefact.id)
      assert.deepEqual(artefact, { ...before, requires: withoutDropped(before.requires) }, artefact.id)
    }
    assert.deepEqual(v4().artefacts.map((a) => a.id), v3().artefacts.map((a) => a.id))
    assert.deepEqual(v4().stages, v3().stages)
    assert.deepEqual(v4().standardModules, v3().standardModules)
    assert.equal(v4().interview, v3().interview)
    assert.deepEqual(v4().instanceSettings, v3().instanceSettings)
  })

  test('the References Field was in the SOAP, Full SOAP, SAD and SSAD, and no v4 template reads it', () => {
    const requiredBy = (def) => def.artefacts.filter((a) => a.requires.some((ref) => ref.startsWith(DROPPED))).map((a) => a.id)
    assert.deepEqual(requiredBy(v3()), ['soap', 'soap-full', 'sad', 'ssad'])
    assert.deepEqual(requiredBy(v4()), [])
    for (const file of readdirSync(join(versionDir(VERSION), 'templates')).filter((f) => f.endsWith('.tmpl'))) {
      assert.doesNotMatch(readFileSync(join(versionDir(VERSION), 'templates', file), 'utf8'), /\.references\b|^# References$/m, file)
    }
  })

  test('the v4 CHANGELOG opens with a published v4 section, says how to move an Instance from v3, and carries v3\'s CHANGELOG whole below it', () => {
    const changelog = loadDefinitionChangelog(DEFINITION, VERSION)
    assert.deepEqual([...changelog.matchAll(/^## (v\d+)\b/gm)].map((m) => m[1]), ['v4', 'v3', 'v2', 'v1'])
    const v4Section = changelog.slice(0, changelog.indexOf('\n## v3'))
    assert.match(v4Section, /#359/)
    assert.match(v4Section, /\*\*Status: published\b/)
    assert.match(v4Section, /^### Started as a copy of v3 \(#359\)$/m)
    assert.match(v4Section, /^### Moving an Instance from v3 \(#359\)$/m)
    assert.match(v4Section, /team-and-estimates\.md/)
    assert.match(v4Section, /definitionVersion: 4/)
    assert.ok(changelog.endsWith(loadDefinitionChangelog(DEFINITION, 3)), 'v3\'s CHANGELOG follows the v4 section')
  })
})

describe('the design examples are on v4 (#359)', () => {
  for (const [slug, gates] of Object.entries(EXAMPLES)) {
    test(`${slug} is pinned to v4 and has no References section`, () => {
      const instance = readInstance(slug, { instancesDir: EXAMPLES_DIR })
      assert.equal(instance.definition, DEFINITION)
      assert.equal(instance.definitionVersion, VERSION)
      const module = readModule(v4(), slug, 'team-and-estimates', { instancesDir: EXAMPLES_DIR })
      assert.deepEqual(module.customFields, [], 'nothing left over in team-and-estimates.md')
      assert.doesNotMatch(readFileSync(join(EXAMPLES_DIR, slug, 'modules', 'team-and-estimates.md'), 'utf8'), /^## References$/m)
    })

    // The same Gates it passed on v3 (tests/designV3.test.js runs them there, on the example as it was).
    for (const gate of gates) {
      test(`${slug} passes ${gate} on v4`, () => {
        const result = checkGate(slug, { instancesDir: EXAMPLES_DIR, gate })
        assert.equal(result.pass, true, JSON.stringify(result.artefacts.map((a) => [a.id, a.outstanding])))
      })
    }
  }

  test(`every v4 Stage's example is ${STAGE_EXAMPLE}, which has example text for every Module the Stage mounts`, () => {
    for (const stage of v4().stages) {
      assert.equal(stage.example, STAGE_EXAMPLE, stage.id)
      for (const moduleId of stage.modules) {
        assert.ok(existsSync(join(EXAMPLES_DIR, STAGE_EXAMPLE, 'modules', `${moduleId}.md`)), `${stage.id}: ${moduleId} has example text`)
      }
    }
  })

  // On v3 the Full SOAP's Gate asks for References, bare; on v4 there is nothing to ask for. The
  // example leaves its Epic/Project blank (the SOAP passes business-case for it), so it is filled
  // here to let the Full SOAP pass the Gate on its own.
  test('the Full SOAP\'s Gate passes on v4 without a References Field, where the same content on v3 is held up for one', () => {
    withExample('gantry', (dir) => {
      const detailsPath = join(dir, 'gantry', 'modules', 'soap-full-details.md')
      writeFileSync(detailsPath, readFileSync(detailsPath, 'utf8').replace('## Epic/Project\n\n', '## Epic/Project\n\nGantry hosting\n\n'))
      const check = () => checkGate('gantry', { instancesDir: dir, gate: 'business-case' })
      const fullSoap = () => check().artefacts.find((a) => a.id === 'soap-full')
      assert.deepEqual(fullSoap().outstanding, [])
      assert.equal(check().pass, true)
      const instancePath = join(dir, 'gantry', 'instance.yaml')
      writeFileSync(instancePath, readFileSync(instancePath, 'utf8').replace(/^definitionVersion: 4$/m, 'definitionVersion: 3'))
      assert.deepEqual(fullSoap().outstanding, [DROPPED])
    })
  })
})

describe('every v4 Artefact renders from the example data, without References (#359)', () => {
  test('the harness covers every v4 Artefact', () => {
    assert.deepEqual(Object.keys(DOCUMENTS).sort(), v4().artefacts.map((a) => a.id).sort())
  })

  for (const [id, { example, basename }] of Object.entries(DOCUMENTS)) {
    test(`${example} renders the v4 ${id} with no References section`, () => {
      const result = renderArtefact(example, id, { instancesDir: EXAMPLES_DIR, dryRun: true })
      assert.equal(result.basename, basename)
      assert.match(result.markdown, /## Document Control/)
      assert.match(result.markdown, /design v4 · /)
      assert.ok(!headings(result.markdown).some((line) => /^#+ References$/.test(line)), `${id} has no References heading`)
    })

    // Nothing else changed: the v4 document is the v3 document of the same example, as it was on v3,
    // with its References section taken out. Its Sources appendix is v3's, word for word.
    test(`the v4 ${id} is the v3 ${id} without its References section, with the same Sources appendix`, () => {
      const onV3 = render(example, id, designV3Examples())
      const onV4 = render(example, id)
      const withoutReferences = onV3.replace(/\n# References\n[\s\S]*?(?=\n# |$)/, '\n')
      // A dry run links each image by its absolute path, which names the folder the example was read from.
      const tidy = (markdown) =>
        markdown
          .replaceAll(resolve(designV3Examples()), '<examples>')
          .replaceAll(resolve(EXAMPLES_DIR), '<examples>')
          .replace(/design v[34] · /g, 'design · ')
          .replace(/\n{3,}/g, '\n\n')
          .trimEnd()
      assert.equal(tidy(onV4), tidy(withoutReferences))
      const sources = (markdown) => markdown.split('\n# Sources\n')[1] ?? null
      assert.equal(sources(onV4), sources(onV3))
      if (example === 'kiwi-cover-mutual') assert.notEqual(sources(onV4), null, `the example cites its Source documents, so the ${id} ends with Sources`)
    })

    test(`${example} renders the v4 ${id} as a Word document styled from v4's reference document`, () => {
      withExample(example, (dir) => {
        const result = renderArtefact(example, id, { instancesDir: dir, deliverToClient: true })
        assert.equal(result.referenceDocPath, `definitions/design/4/templates/reference-${id}.docx`)
        const docxPath = join(dir, `${id}.docx`)
        writeFileSync(docxPath, result.docxBytes)
        const documentXml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        assert.match(documentXml, /w:pStyle w:val="Heading1"/)
        assert.ok(!/<w:t[^>]*>References<\/w:t>/.test(documentXml), `${id} has no References heading in Word`)
      })
    })
  }
})

describe('an Instance on v3 renders as before, and a References section left behind on v4 is kept but not printed (#359)', () => {
  // v3 is unchanged, so the example as it was on v3 still prints its References where it always did.
  test('the v3 SOAP, Full SOAP, SAD and SSAD still print References', () => {
    const dir = designV3Examples()
    for (const [id, example] of [['soap', 'kiwi-cover-mutual'], ['soap-full', 'gantry'], ['sad', 'kiwi-cover-mutual'], ['ssad', 'kiwi-cover-mutual']]) {
      const markdown = render(example, id, dir)
      assert.ok(headings(markdown).includes('# References'), `${id} on v3 prints References`)
      for (const item of V3_REFERENCES[example].split('\n').filter((line) => line.startsWith('- '))) {
        assert.ok(markdown.includes(item), `${id} on v3 prints ${item}`)
      }
    }
  })

  // Moving an Instance is the architect's step: delete the section, then set definitionVersion: 4. An
  // Instance moved without deleting it gets what Gantry does with any `##` section the Definition
  // doesn't know: an added section (#132), kept in the file and shown in the editor, never printed by
  // a template and never asked for by a Gate.
  test('an Instance moved to v4 with its References section still in team-and-estimates.md keeps it as an added section', () => {
    withExample('kiwi-cover-mutual', (dir) => {
      moveExampleBackToV3(dir, 'kiwi-cover-mutual')
      const instancePath = join(dir, 'kiwi-cover-mutual', 'instance.yaml')
      writeFileSync(instancePath, readFileSync(instancePath, 'utf8').replace(/^definitionVersion: 3$/m, 'definitionVersion: 4'))
      const module = readModule(v4(), 'kiwi-cover-mutual', 'team-and-estimates', { instancesDir: dir })
      assert.deepEqual(module.customFields.map((c) => [c.title, c.type, c.value.length]), [['References', 'list', 4]])
      assert.deepEqual(Object.keys(module.fields), ['teams-required', 'estimates'])

      for (const gate of EXAMPLES['kiwi-cover-mutual']) {
        assert.equal(checkGate('kiwi-cover-mutual', { instancesDir: dir, gate }).pass, true, gate)
      }
      for (const id of ['soap', 'sad', 'ssad']) {
        const markdown = render('kiwi-cover-mutual', id, dir)
        assert.ok(!headings(markdown).includes('# References'), `${id} does not print the section`)
        assert.ok(!markdown.includes('KCM Delivery Office T-shirt sizing guide v3'), `${id} does not print its items`)
      }

      // A save from the editor writes the section back where it was.
      writeModule(v4(), 'kiwi-cover-mutual', 'team-and-estimates', module, { instancesDir: dir })
      const saved = readFileSync(join(dir, 'kiwi-cover-mutual', 'modules', 'team-and-estimates.md'), 'utf8')
      assert.ok(saved.trimEnd().endsWith(V3_REFERENCES['kiwi-cover-mutual'].trimEnd()), 'the References section survives a save')
    })
  })
})

describe('the change is recorded (#359)', () => {
  test('the User Guide names design v4 as the default and says it drops References', () => {
    const guide = readFileSync('docs/user-guide/index.md', 'utf8')
    const paragraph = guide.split('\n').find((line) => line.startsWith('The worked example throughout this guide remains the `design` definition'))
    assert.match(paragraph, /`design` version 4, which is published and is the default for new `design` instances/)
    assert.match(paragraph, /References/)
    assert.match(paragraph, /Sources/)
    assert.match(paragraph, /from version 3 to version 4, is a per-instance step/)
    assert.match(paragraph, /definitionVersion: 4/)
  })
})
