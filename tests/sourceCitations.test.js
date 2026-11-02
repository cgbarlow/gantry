import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import {
  buildSourceAppendix,
  citedSourceIds,
  findSourceCitations,
  sourceAppendixProblem,
  sourceCitationFor,
  sourceCitationsForWord,
} from '../web/lib/sourceCitations.js'
import { ASSET_IMAGE_EXTENSIONS, assetFilenameForSource, canUseSourceAsImage } from '../web/lib/sourceDocuments.js'
import { renderArtefact } from '../lib/render.js'
import { runLocalWorkspaceCompute, LocalWorkspaceRequestError } from '../lib/localWorkspace.js'
import { createAsset, listAssets } from '../lib/assets.js'
import { findDefinitionProblemsInStructure, loadDefinition, buildDefinitionYamlObject } from '../lib/definition.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'

// #281 (map #238, decided in #245): Source documents cited from module content as `[text](source:<id>)`, printed as plain "(text)" in Word, and an optional Sources appendix an Artefact's Definition opts into with `source-appendix: true`.

describe('the citation syntax', () => {
  test('a citation is a link to source:<id>, whatever its text', () => {
    assert.deepEqual(findSourceCitations('See [Client brief, p. 4](source:client-brief) and [Notes](source:notes-2).'), [
      { id: 'client-brief', text: 'Client brief, p. 4' },
      { id: 'notes-2', text: 'Notes' },
    ])
  })

  test('an image, an ordinary link, a code span and a fenced block are not citations', () => {
    const markdown = [
      '![a picture](source:client-brief)',
      '[the web](https://example.com/source:x)',
      'Type `[Brief](source:in-code)` to cite.',
      '```',
      '[Brief](source:in-fence)',
      '```',
      '~~~markdown',
      '[Brief](source:in-tildes)',
      '~~~',
      'After: [Real](source:real)',
    ].join('\n')
    assert.deepEqual(citedSourceIds(markdown), ['real'])
  })

  test('link text may hold escaped brackets, and a citation cannot span lines', () => {
    assert.deepEqual(findSourceCitations('[Plan \\[v2\\], p. 3](source:plan)'), [{ id: 'plan', text: 'Plan [v2], p. 3' }])
    assert.deepEqual(findSourceCitations('[broken\ntext](source:plan)'), [])
  })

  test('the ids cited are listed once each, in the order they are first cited', () => {
    assert.deepEqual(citedSourceIds('[b](source:b) [a](source:a) [b again](source:b)'), ['b', 'a'])
  })

  test('the citation to paste for a document uses its title and id', () => {
    assert.equal(sourceCitationFor({ id: 'client-brief', title: 'Client brief' }), '[Client brief](source:client-brief)')
    assert.equal(sourceCitationFor({ id: 'plan', title: 'Plan [v2]' }), '[Plan \\[v2\\]](source:plan)')
  })
})

describe('what Word prints', () => {
  test('a citation is its text in parentheses with no link', () => {
    assert.equal(sourceCitationsForWord('Median time is 12.4 days [Client brief, p. 4](source:client-brief).'), 'Median time is 12.4 days (Client brief, p. 4).')
  })

  test('an empty text falls back on the document title, then the id', () => {
    assert.equal(sourceCitationsForWord('x [](source:a) y [](source:b)', (id) => (id === 'a' ? 'Client brief' : undefined)), 'x (Client brief) y (b)')
  })

  test('code, fenced blocks, images and other links are left exactly as they were', () => {
    const markdown = 'Use `[T](source:a)`.\n\n```\n[T](source:a)\n```\n\n![T](source:a) [T](https://example.com)'
    assert.equal(sourceCitationsForWord(markdown), markdown)
  })

  test('text with no citation comes back unchanged', () => {
    const markdown = '# Title\n\nSome *words* and a [link](https://example.com).\n'
    assert.equal(sourceCitationsForWord(markdown), markdown)
  })
})

describe('the Sources appendix', () => {
  const entries = [
    { id: 'client-brief', title: 'Client brief', filename: 'Client brief v3.docx', uploadedAt: '2026-03-04T09:30:00.000Z' },
    { id: 'old-notes', title: 'Old notes', filename: 'notes.txt', uploadedAt: '2026-01-15T00:00:00.000Z', removedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'never-cited', title: 'Never cited', filename: 'other.pdf', uploadedAt: '2026-01-01T00:00:00.000Z' },
  ]

  test('lists only the documents the Artefact cites, each with its title, original filename and upload date', () => {
    const appendix = buildSourceAppendix('[a](source:client-brief)', entries)
    assert.equal(appendix, '# Sources\n\n| Document | File | Added |\n| --- | --- | --- |\n| Client brief | Client brief v3.docx | 4 Mar 2026 |\n')
    assert.doesNotMatch(appendix, /Never cited/)
  })

  test('a removed document is still listed, marked removed', () => {
    const appendix = buildSourceAppendix('[a](source:old-notes) [b](source:client-brief)', entries)
    assert.match(appendix, /\| Old notes \(removed\) \| notes\.txt \| 15 Jan 2026 \|/)
    assert.ok(appendix.indexOf('Old notes') < appendix.indexOf('Client brief'), 'in the order first cited')
  })

  test('a document the manifest does not list is left out, and nothing cited means no list at all', () => {
    assert.equal(buildSourceAppendix('[a](source:unknown)', entries), '')
    assert.equal(buildSourceAppendix('no citations here', entries), '')
    assert.equal(buildSourceAppendix('[a](source:client-brief)', []), '')
  })

  test('a title or filename holding a pipe cannot break the table', () => {
    const appendix = buildSourceAppendix('[a](source:x)', [{ id: 'x', title: 'A | B', filename: 'a|b.txt', uploadedAt: '2026-03-04T00:00:00Z' }])
    assert.match(appendix, /\| A \\\| B \| a\\\|b\.txt \|/)
  })
})

describe('the validator knows the setting', () => {
  test('only a real true or false is accepted', () => {
    assert.equal(sourceAppendixProblem('soap', undefined), null)
    assert.equal(sourceAppendixProblem('soap', true), null)
    assert.equal(sourceAppendixProblem('soap', false), null)
    assert.deepEqual(sourceAppendixProblem('soap', 'yes'), {
      type: 'invalid-source-appendix',
      message: 'Artefact "soap" sets "source-appendix" to "yes" — it must be true or false',
    })
    assert.equal(sourceAppendixProblem('soap', 1).type, 'invalid-source-appendix')
  })

  const structure = (artefactExtra) => ({
    id: 'tiny',
    version: 1,
    stages: [{ id: 's', title: 'S', purpose: 'p', gate: 'g', modules: ['m'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'templates/doc.md.tmpl', gate: 'g', requires: ['m.f'], ...artefactExtra }],
    modules: [{ id: 'm', title: 'M', fields: [{ id: 'f', title: 'F', type: 'markdown', required: true }] }],
  })

  test('a bad value is reported when a Definition is validated (server and Local Workspace)', () => {
    const types = (problems) => problems.map((p) => p.type)
    assert.deepEqual(types(findDefinitionProblemsInStructure(structure({ sourceAppendix: true }))), [])
    assert.deepEqual(types(findDefinitionProblemsInStructure(structure({ 'source-appendix': 'yes' }))), ['invalid-source-appendix'])
    assert.deepEqual(types(findDefinitionProblemsInStructure(structure({ sourceAppendix: 'yes' }))), ['invalid-source-appendix'])
    assert.ok(types(findLocalDefinitionProblems(structure({ sourceAppendix: 'yes' }))).includes('invalid-source-appendix'))
    assert.ok(!types(findLocalDefinitionProblems(structure({ sourceAppendix: true }))).includes('invalid-source-appendix'))
  })

  test('the setting round-trips through the Definition files, and is projected only when switched on', () => {
    const written = buildDefinitionYamlObject('tiny', 1, 'draft', structure({ sourceAppendix: true }), {})
    assert.equal(written.artefacts[0]['source-appendix'], true)
    const off = buildDefinitionYamlObject('tiny', 1, 'draft', structure({}), {})
    assert.ok(!('source-appendix' in off.artefacts[0]))
  })

  test('design v1 and v2 leave it off, and design v3 (#308) turns it on for every Artefact', () => {
    for (const version of [1, 2]) {
      const definition = loadDefinition('design', { definitionsDir: 'definitions', version })
      assert.ok(definition.artefacts.every((a) => a.sourceAppendix === undefined), `design v${version}`)
    }
    const v3 = loadDefinition('design', { definitionsDir: 'definitions', version: 3 })
    assert.ok(v3.artefacts.length > 0 && v3.artefacts.every((a) => a.sourceAppendix === true), 'design v3')
  })
})

describe('Use as image', () => {
  test('only a PNG or JPEG can be used as an image', () => {
    assert.deepEqual([...ASSET_IMAGE_EXTENSIONS], ['.png', '.jpg', '.jpeg'])
    assert.equal(canUseSourceAsImage('Whiteboard.png'), true)
    assert.equal(canUseSourceAsImage('Photo.JPG'), true)
    assert.equal(canUseSourceAsImage('anim.gif'), false)
    assert.equal(canUseSourceAsImage('Brief.docx'), false)
    assert.equal(canUseSourceAsImage('png'), false)
  })

  test('a Local Workspace copy is named so it can be typed into assets/<name>, and never overwrites an image', () => {
    assert.equal(assetFilenameForSource('Whiteboard sketch (v2).PNG', []), 'Whiteboard-sketch-v2.png')
    assert.equal(assetFilenameForSource('Whiteboard.png', ['whiteboard.png']), 'Whiteboard-2.png')
    assert.equal(assetFilenameForSource('Whiteboard.png', ['Whiteboard.png', 'Whiteboard-2.png']), 'Whiteboard-3.png')
    assert.equal(assetFilenameForSource('!!!.jpg', []), 'image.jpg')
  })

  test('the server copy is a new Asset that keeps no link to the document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gantry-useasimage-'))
    try {
      const png = Buffer.from('89504e470d0a1a0a', 'hex')
      const asset = createAsset('inst', { filename: 'Whiteboard.png', buffer: png, name: 'Whiteboard', uploadedBy: 'a.architect' }, { instancesDir: dir, copiedFromSource: 'sources/Whiteboard.png' })
      assert.equal(asset.name, 'Whiteboard')
      assert.equal(asset.source, 'sources/Whiteboard.png')
      assert.match(asset.filename, /\.png$/)
      assert.deepEqual(readFileSync(join(dir, 'inst', 'assets', asset.filename)), png)
      // An upload's own body can never claim a Source document as its origin: the usual web address is still required.
      assert.throws(() => createAsset('inst', { filename: 'x.png', buffer: png, source: 'sources/x.png' }, { instancesDir: dir }), /valid URL/)
      assert.throws(() => createAsset('inst', { filename: 'x.png', buffer: png }, { instancesDir: dir, copiedFromSource: 'elsewhere/x.png' }), /Source location is required/)
      // Only an image type: the Asset rules still apply.
      assert.throws(() => createAsset('inst', { filename: 'Brief.docx', buffer: png }, { instancesDir: dir, copiedFromSource: 'sources/Brief.docx' }), /Unsupported image file type/)
      assert.equal(listAssets({ modules: new Map() }, 'inst', { instancesDir: dir }).length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- The render ----------------------------------------------------------------------------------------------------

const SLUG = 'examples'
const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const MANIFEST = [
  { id: 'client-brief', filename: 'Client brief v3.docx', title: 'Client brief', uploadedBy: 'a.architect', uploadedAt: '2026-03-04T09:30:00.000Z', size: 1000 },
  { id: 'old-notes', filename: 'notes.txt', title: 'Old notes', uploadedBy: 'a.architect', uploadedAt: '2026-01-15T00:00:00.000Z', size: 10, removedAt: '2026-02-01T00:00:00.000Z', removedBy: 'a.architect' },
  { id: 'never-cited', filename: 'other.pdf', title: 'Never cited', uploadedBy: 'a.architect', uploadedAt: '2026-01-01T00:00:00.000Z', size: 10 },
]
const CITED = 'Median time to payment is 12.4 working days [Client brief, p. 4](source:client-brief), confirmed in the [notes](source:old-notes).'

// A scratch copy of the example Instance (design v3) with a citation in its Background, a Source documents manifest, and a copy of the bundled Definitions whose Solution on a Page (and only it) turns the appendix on when `appendix` is true.
async function withCitingExample({ appendix, manifest = MANIFEST }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-citations-'))
  try {
    const instancesDir = join(root, 'instances')
    const definitionsDir = join(root, 'definitions')
    cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
    rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
    const instanceYaml = readFileSync(join(instancesDir, SLUG, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    writeFileSync(join(instancesDir, SLUG, 'instance.yaml'), instanceYaml)
    const backgroundPath = join(instancesDir, SLUG, 'modules', 'background.md')
    const background = readFileSync(backgroundPath, 'utf8')
    const cited = background.replace(/\n## Affected domains/, `\n${CITED}\n\n## Affected domains`)
    assert.notEqual(cited, background, 'the citation lands in the Background')
    writeFileSync(backgroundPath, cited)
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    // Design v3 turns the appendix on for every Artefact (#308). Take it out of all of them, then put it back on the Solution on a Page alone when `appendix` is true.
    const defPath = join(definitionsDir, 'design', '3', 'definition.yaml')
    const text = readFileSync(defPath, 'utf8')
    assert.match(text, /^    source-appendix: true$/m)
    const without = text.replace(/^    source-appendix: true\n/gm, '')
    writeFileSync(defPath, without)
    if (appendix) {
      const edited = without.replace('    diagram-captions: true\n', '    diagram-captions: true\n    source-appendix: true\n')
      assert.notEqual(edited, without)
      writeFileSync(defPath, edited)
    }
    if (manifest) {
      mkdirSync(join(instancesDir, SLUG, 'sources'), { recursive: true })
      writeFileSync(join(instancesDir, SLUG, 'sources', 'manifest.yaml'), stringifyYAML(manifest))
    }
    return await fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('rendering', () => {
  test('Word prints a citation as plain text with no link, and the exported .md keeps it as written', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.match(result.markdown, /\[Client brief, p\. 4\]\(source:client-brief\)/)
      assert.match(result.docxMarkdown, /12\.4 working days \(Client brief, p\. 4\), confirmed in the \(notes\)\./)
      assert.doesNotMatch(result.docxMarkdown, /source:/)
    })
  })

  test('the same holds when the Word text carries its Field tags', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true })
      assert.match(result.docxMarkdown, /\(Client brief, p\. 4\)/)
      assert.doesNotMatch(result.docxMarkdown, /\]\(source:/)
    })
  })

  test('the real .docx has the words and no hyperlink to the document', async () => {
    await withCitingExample({ appendix: false }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { execFileSync } = await import('node:child_process')
      const xml = execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], { encoding: 'utf8' })
      const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
      assert.match(text, /12\.4 working days \(Client brief, p\.\s4\), confirmed in the \(notes\)\./)
      assert.doesNotMatch(xml, /source:/)
      const rels = execFileSync('unzip', ['-p', result.docxPath, 'word/_rels/document.xml.rels'], { encoding: 'utf8' })
      assert.doesNotMatch(rels, /source:/)
    })
  })

  test('with the setting off there is no Sources list', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.doesNotMatch(result.markdown, /^# Sources$/m)
      assert.doesNotMatch(result.docxMarkdown, /^# Sources$/m)
    })
  })

  test('with the setting on the Artefact ends with a Sources list of only the documents it cites, removed ones marked', async () => {
    await withCitingExample({ appendix: true }, ({ instancesDir, definitionsDir }) => {
      for (const options of [{ wordTags: false }, {}]) {
        const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, ...options })
        for (const text of [result.markdown, result.docxMarkdown]) {
          const appendix = text.slice(text.lastIndexOf('# Sources'))
          assert.equal(
            appendix.trim(),
            [
              '# Sources',
              '',
              '| Document | File | Added |',
              '| --- | --- | --- |',
              '| Client brief | Client brief v3.docx | 4 Mar 2026 |',
              '| Old notes (removed) | notes.txt | 15 Jan 2026 |',
            ].join('\n')
          )
          assert.ok(text.trimEnd().endsWith('15 Jan 2026 |'), 'the list is the last thing in the document')
          assert.ok(!text.includes('Never cited'))
        }
      }
    })
  })

  test('an Instance with no Source documents has no list, and a citation of an unknown id still prints its words', async () => {
    await withCitingExample({ appendix: true, manifest: null }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.doesNotMatch(result.docxMarkdown, /^# Sources$/m)
      assert.match(result.docxMarkdown, /\(Client brief, p\. 4\)/)
    })
  })

  test('an Artefact that cites nothing renders exactly as it did, with the setting on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-nocite-'))
    try {
      const instancesDir = join(root, 'instances')
      cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
      rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
      writeFileSync(join(instancesDir, SLUG, 'instance.yaml'), readFileSync(join(instancesDir, SLUG, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3'))
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir: 'definitions', dryRun: true, wordTags: false })
      assert.doesNotMatch(result.docxMarkdown, /# Sources/)
      assert.equal(result.docxMarkdown.includes('source:'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a Local Workspace render request', () => {
  const payload = (extra = {}) => {
    const instanceYaml = readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    const moduleFiles = {}
    for (const file of readdirSync(join(EXAMPLE, 'modules'))) {
      const text = readFileSync(join(EXAMPLE, 'modules', file), 'utf8')
      moduleFiles[file.replace(/\.md$/, '')] = file === 'background.md' ? text.replace(/\n## Affected domains/, `\n${CITED}\n\n## Affected domains`) : text
    }
    const assets = readdirSync(join(EXAMPLE, 'assets')).map((file) => ({ id: file, base64: readFileSync(join(EXAMPLE, 'assets', file)).toString('base64') }))
    return { definitionId: 'design', definitionVersion: 3, instanceYaml, moduleFiles, assets, artefact: 'soap', ...extra }
  }
  const entry = (id) => {
    const { id: _id, size: _size, uploadedBy: _by, removedBy: _rb, ...rest } = MANIFEST.find((e) => e.id === id)
    return { id, ...rest }
  }

  test('the manifest entries of the cited documents give Word the titles, and nothing else of a document travels', async () => {
    const result = await runLocalWorkspaceCompute('compile', payload({ sources: [entry('client-brief'), entry('old-notes')] }), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /12\.4 working days \(Client brief, p\. 4\), confirmed in the \(notes\)\./)
    assert.match(result.markdown, /\(source:client-brief\)/)
  })

  test('without them a citation still prints its words', async () => {
    const result = await runLocalWorkspaceCompute('compile', payload(), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /\(Client brief, p\. 4\)/)
  })

  test('a request that names an unsafe id, or too many entries, is refused before anything is written', async () => {
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: [{ id: '../x', filename: 'x.txt' }] }), { definitionsDir: 'definitions' }), LocalWorkspaceRequestError)
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: 'nope' }), { definitionsDir: 'definitions' }), /sources must be an array/)
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: [{ id: 'a', filename: 7 }] }), { definitionsDir: 'definitions' }), /must carry a filename/)
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, filename: 'x.txt' }))
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: many }), { definitionsDir: 'definitions' }), (err) => err.status === 413)
  })
})
