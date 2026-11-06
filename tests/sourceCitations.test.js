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
import { removeCitations } from './helpers/uncite.js'

// #281 (map #238, decided in #245): Source documents cited from module content as `[text](source:<id>)`, printed in Word as a real footnote (#351), and an optional Sources appendix an Artefact's Definition opts into with `source-appendix: true`.

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

  test('link text may hold closed brackets, and a bracket of the writer\'s before a citation is not part of it (#351)', () => {
    assert.deepEqual(findSourceCitations('[see [x], p. 3](source:plan)'), [{ id: 'plan', text: 'see [x], p. 3' }])
    assert.deepEqual(findSourceCitations('[[a](source:a); [b](source:b)]'), [
      { id: 'a', text: 'a' },
      { id: 'b', text: 'b' },
    ])
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
  // #351: a citation in running text is a real Word footnote. The compile step writes it as a Pandoc inline note, `^[words]`, which
  // Pandoc turns into a native footnote; the brackets around it go, and the mark sits against the word before it.
  test('a citation in running text is an inline note holding its words, against the word before it', () => {
    assert.equal(sourceCitationsForWord('Median time is 12.4 days [Client brief, p. 4](source:client-brief).'), 'Median time is 12.4 days^[Client brief, p. 4].')
    assert.equal(sourceCitationsForWord('see [Client brief, p. 4](source:client-brief) for the figures'), 'see^[Client brief, p. 4] for the figures')
  })

  test('brackets that hold nothing but citations go, so no empty "()" is left', () => {
    assert.equal(sourceCitationsForWord('…built from it ([operating model](source:operating-model)).'), '…built from it^[operating model].')
    // Two notes side by side keep a space between them: Pandoc would read `^[a]^[b]` as a superscript "[a]".
    assert.equal(sourceCitationsForWord('x ([a](source:a); [b](source:b)) y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('x [[a](source:a), [b](source:b)] y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('x ( [a](source:a) ) y'), 'x^[a] y')
  })

  test('brackets that hold anything else stay, and two citations side by side are two notes', () => {
    assert.equal(sourceCitationsForWord('x (see [a](source:a)) y'), 'x (see^[a]) y')
    assert.equal(sourceCitationsForWord('x ([a](source:a) and more) y'), 'x (^[a] and more) y')
    assert.equal(sourceCitationsForWord('x [a](source:a) [b](source:b) y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('x [a](source:a)[b](source:b) y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('E = mc[a](source:a)^2^'), 'E = mc^[a] ^2^', "and so does a note before the writer's own superscript")
    assert.equal(sourceCitationsForWord('x \\([a](source:a)) y'), 'x \\(^[a]) y', 'an escaped bracket is the text\'s own')
  })

  test('an empty text falls back on the document title, then the id', () => {
    assert.equal(sourceCitationsForWord('x [](source:a) y [](source:b)', (id) => (id === 'a' ? 'Client brief' : undefined)), 'x^[Client brief] y^[b]')
  })

  test('nothing in the words can break the note, and the author\'s own Markdown in them is kept', () => {
    // The link text was already Markdown, and stays so, as it does where a citation labels a list item: only a `^`, which
    // Pandoc could read as the end of a superscript begun by the note's own, is escaped. Its brackets are closed or escaped.
    assert.equal(sourceCitationsForWord('x [Plan \\[v2\\]^2 *draft*](source:plan) y'), 'x^[Plan \\[v2\\]\\^2 *draft*] y')
    assert.equal(sourceCitationsForWord('x [*Client brief*, p. 4](source:a) y'), 'x^[*Client brief*, p. 4] y')
    // A document's title, a repository's file and its commit are not Markdown, so they are taken literally.
    assert.equal(sourceCitationsForWord('x [](source:plan) y', () => 'A_b <c> @d $e'), 'x^[A\\_b \\<c\\> \\@d \\$e] y')
    assert.equal(sourceCitationsForWord('x [*a*](source:r?path=src/my_file.ts) y'), 'x^[*a*, src/my\\_file.ts] y')
  })

  test("a repository citation's note names the file and the short commit it was read at", () => {
    const HEAD = 'de62a9e1234567890abcdef1234567890abcdef1'
    assert.equal(sourceCitationsForWord(`as the [gantry](source:gantry?path=README.md&commit=${HEAD}) says`), 'as the^[gantry, README.md, at commit de62a9e] says')
    // The words Copy citation writes already name the file, so it isn't said twice.
    assert.equal(sourceCitationsForWord(`x [Gantry, README.md](source:gantry?path=README.md&commit=${HEAD}) y`), 'x^[Gantry, README.md, at commit de62a9e] y')
    assert.equal(sourceCitationsForWord('x [Gantry](source:gantry) y'), 'x^[Gantry] y', 'a citation of the repository as a whole is its words')
  })

  test('a citation that labels a list item or a table cell prints its words, with no brackets and no note', () => {
    assert.equal(sourceCitationsForWord('- [Gantry_Two_pager](source:gantry-two-pager): scope, costing'), '- Gantry_Two_pager: scope, costing')
    assert.equal(sourceCitationsForWord('1. [](source:a) and more [b](source:b)', () => 'Client brief'), '1. Client brief and more^[b]')
    assert.equal(sourceCitationsForWord('> * **[Brief](source:a)**: x'), '> * **Brief**: x')
    const table = '| Document | Note |\n| --- | --- |\n| [Brief](source:a) | as said [Notes](source:b) |'
    assert.equal(sourceCitationsForWord(table), '| Document | Note |\n| --- | --- |\n| Brief | as said^[Notes] |')
    const bare = 'Document | Note\n--- | ---\n[Brief](source:a) | x'
    assert.equal(sourceCitationsForWord(bare), 'Document | Note\n--- | ---\nBrief | x', 'a table without the outer pipes too')
    // An item that opens with bracketed citations is not labelled by them; the list marker stays where it was.
    assert.equal(sourceCitationsForWord('- ([a](source:a)) x'), '- ^[a] x')
    // A Word Field tag (#301) in front of the citation is not something in the item.
    const tagged = '- `<w:bookmarkStart w:id="2000000" w:name="gf_m_f"/>`{=openxml}[Brief](source:a): x'
    assert.equal(sourceCitationsForWord(tagged), '- `<w:bookmarkStart w:id="2000000" w:name="gf_m_f"/>`{=openxml}Brief: x')
  })

  test('a paragraph that is not a list or a table, and a heading, are not mistaken for one', () => {
    assert.equal(sourceCitationsForWord('[Brief](source:a) says so.'), '^[Brief] says so.')
    assert.equal(sourceCitationsForWord('a | b [Brief](source:a)'), 'a | b^[Brief]')
    assert.equal(sourceCitationsForWord('## Background ([Brief](source:a))'), '## Background (Brief)', 'a heading prints the words as before, since a note there would also land in the table of contents')
  })

  test('a Field tag Span (#301) around a citation is not taken for square brackets', () => {
    // Pandoc 2 reads `[^` as the start of a footnote reference, so a note straight after a `[` has a space before it; a Span
    // drops it, so Word prints nothing extra.
    assert.equal(sourceCitationsForWord('x [[a](source:a)]{#gf_m_f} y'), 'x [ ^[a]]{#gf_m_f} y')
    assert.equal(sourceCitationsForWord('Owner: [[Brief](source:a) says so.]{#gf_m_f}'), 'Owner: [ ^[Brief] says so.]{#gf_m_f}')
  })

  test('two marks with only punctuation between them, and a mark beside the writer\'s own ^, are never read as a superscript', () => {
    // Pandoc 2 reads `^[a],^[b]` as a superscript "[a]," followed by "[b]", so whatever sits between a note and the next `^`
    // keeps a space in it.
    assert.equal(sourceCitationsForWord('two places [Client brief, p. 4](source:a), [Notes](source:b).'), 'two places^[Client brief, p. 4], ^[Notes].')
    assert.equal(sourceCitationsForWord('(see [Brief](source:a); [Notes](source:b))'), '(see^[Brief]; ^[Notes])')
    assert.equal(sourceCitationsForWord('x [a](source:a),[b](source:b) y'), 'x^[a], ^[b] y')
    assert.equal(sourceCitationsForWord('x [a](source:a)x^2^ y'), 'x^[a]x ^2^ y')
    // A word before the mark that holds a `^` of the writer's keeps its space, or `^2)^[a]` would be a superscript "2)".
    assert.equal(sourceCitationsForWord('it is O(n^2) [a](source:a).'), 'it is O(n^2) ^[a].')
    assert.equal(sourceCitationsForWord('it is O(n\\^2) [a](source:a).'), 'it is O(n\\^2)^[a].', 'an escaped ^ is plain text')
  })

  test('a definition list keeps the space after its marker', () => {
    assert.equal(sourceCitationsForWord('Term\n: [a](source:a) definition'), 'Term\n: ^[a] definition')
    assert.equal(sourceCitationsForWord('Term\n\n:   [a](source:a) definition'), 'Term\n\n:   ^[a] definition')
    assert.equal(sourceCitationsForWord('Term\n~ [a](source:a) definition'), 'Term\n~ ^[a] definition')
    assert.equal(sourceCitationsForWord('Owner: [a](source:a) x'), 'Owner:^[a] x', 'a colon after a word is not a marker')
  })

  test('the Pandoc this server converts with reads every one of them as notes, with nothing left as a superscript or literal', async () => {
    const { execFileSync } = await import('node:child_process')
    const cases = [
      ['two places [Client brief, p. 4](source:a), [Notes](source:b).', 2],
      ['(see [Brief](source:a); [Notes](source:b))', 2],
      ['x [a](source:a),[b](source:b) y', 2],
      ['x ([a](source:a); [b](source:b)) y', 2],
      ['E = mc[a](source:a)^2^', 1],
      ['it is O(n^2) [a](source:a).', 1],
      ['x [[a](source:a)]{#gf_m_f} y', 1],
      ['Owner: [[Brief](source:a) says so.]{#gf_m_f}', 1],
      ['x [Plan \\[v2\\]^2 *draft*](source:plan) y', 1],
      ['Term\n: [a](source:a) definition', 1],
    ]
    for (const [markdown, notes] of cases) {
      const ast = JSON.stringify(JSON.parse(execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], { input: sourceCitationsForWord(markdown), encoding: 'utf8' })).blocks)
      assert.equal(ast.match(/"t":"Note"/g)?.length ?? 0, notes, `${markdown} → ${sourceCitationsForWord(markdown)}`)
      assert.doesNotMatch(ast, /"t":"Superscript","c":\[\{"t":"Str","c":"\[/, markdown)
      assert.doesNotMatch(ast, /"\^\[|"\[\^/, `${markdown}: no note left as literal text`)
      if (markdown.includes('{#gf_m_f}')) assert.match(ast, /"t":"Span","c":\[\["gf_m_f"/, `${markdown}: the Field's bookmark is still there`)
      if (markdown.startsWith('Term')) assert.match(ast, /"t":"DefinitionList"/, markdown)
      if (markdown.includes('*draft*')) assert.match(ast, /"t":"Emph"/, markdown)
    }
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

  test('a document fetched from a web address shows its title, the address and "retrieved <date>" in place of the filename and upload date (#318)', () => {
    const fetched = { id: 'vendor-api', title: 'Vendor API guide', filename: 'Vendor API guide.html', uploadedAt: '2026-11-03T09:00:05.000Z', origin: { address: 'https://vendor.example.com/api', finalAddress: 'https://docs.vendor.example.com/api', fetchedAt: '2026-11-03T09:00:00.000Z' } }
    const appendix = buildSourceAppendix('[a](source:vendor-api) [b](source:client-brief)', [...entries, fetched])
    assert.match(appendix, /\| Vendor API guide \| https:\/\/vendor\.example\.com\/api \| retrieved 3 Nov 2026 \|/)
    assert.match(appendix, /\| Client brief \| Client brief v3\.docx \| 4 Mar 2026 \|/, 'an upload is listed as before')
    assert.doesNotMatch(appendix, /Vendor API guide\.html/)
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
async function withCitingExample({ appendix, manifest = MANIFEST, citing = CITED }, fn) {
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
    const cited = background.replace(/\n## Affected domains/, `\n${citing}\n\n## Affected domains`)
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
    // #310: the example brings its own Source documents; an Instance "with no Source documents" has none.
    if (!manifest) rmSync(join(instancesDir, SLUG, 'sources'), { recursive: true, force: true })
    if (manifest) {
      mkdirSync(join(instancesDir, SLUG, 'sources'), { recursive: true })
      writeFileSync(join(instancesDir, SLUG, 'sources', 'manifest.yaml'), stringifyYAML(manifest))
    }
    return await fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A rendered .docx's body text, with each footnote mark written "[<id>]" where it sits, and its footnotes in the order they are
// cited: `{ id, text, xml }` each, leaving out Word's separator notes.
async function wordParts(docxPath) {
  const { execFileSync } = await import('node:child_process')
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' })
  const textOf = (part) => [...part.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:footnoteReference w:id="(\d+)" ?\/>/g)].map((m) => m[1] ?? `[${m[2]}]`).join('')
  const notesXml = execFileSync('unzip', ['-p', docxPath, 'word/footnotes.xml'], { encoding: 'utf8' })
  const byId = new Map([...notesXml.matchAll(/<w:footnote(?: [^>]*)? w:id="(\d+)"(?: [^>]*)?>([\s\S]*?)<\/w:footnote>/g)].filter((m) => !/w:type="(?:continuation)?[sS]eparator"/.test(m[0].slice(0, m[0].indexOf('>')))).map((m) => [m[1], m[2]]))
  // Pandoc keeps "p. 4" together with a no-break space; read as an ordinary one.
  const footnotes = [...xml.matchAll(/<w:footnoteReference w:id="(\d+)"/g)].map((m) => ({ id: m[1], xml: byId.get(m[1]), text: textOf(byId.get(m[1]) ?? '').replace(/ /g, ' ').trim() }))
  return { xml, text: textOf(xml), footnotes }
}

describe('rendering', () => {
  test('Word prints a citation as a footnote with no link, and the exported .md keeps it as written', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.match(result.markdown, /\[Client brief, p\. 4\]\(source:client-brief\)/)
      assert.match(result.docxMarkdown, /12\.4 working days\^\[Client brief, p\. 4\], confirmed in the\^\[notes\]\./)
      assert.doesNotMatch(result.docxMarkdown, /source:/)
    })
  })

  test('the same holds when the Word text carries its Field tags', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true })
      assert.match(result.docxMarkdown, /\^\[Client brief, p\. 4\]/)
      assert.doesNotMatch(result.docxMarkdown, /\]\(source:/)
    })
  })

  test('the real .docx has the words as footnotes and no hyperlink to the document', async () => {
    await withCitingExample({ appendix: false }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { xml, text, footnotes } = await wordParts(result.docxPath)
      const ours = /12\.4 working days\[(\d+)\], confirmed in the\[(\d+)\]\./.exec(text)
      assert.ok(ours, 'a footnote mark where each citation was')
      assert.deepEqual(ours.slice(1).map((id) => footnotes.find((f) => f.id === id)?.text), ['Client brief, p. 4', 'notes'])
      assert.doesNotMatch(xml, /source:/)
      const { execFileSync } = await import('node:child_process')
      const rels = execFileSync('unzip', ['-p', result.docxPath, 'word/_rels/document.xml.rels'], { encoding: 'utf8' })
      assert.doesNotMatch(rels, /source:/)
    })
  })

  // #351: the acceptance examples, through the compile step and a real Pandoc conversion, with the Field tags on as they are in use.
  test('the .docx carries one real Word footnote per citation in running text, in the Footnote styles, and plain words where a citation labels a list item', async () => {
    const citing = [
      'It was built from it ([operating model](source:client-brief)). See [Client brief, p. 4](source:client-brief) for the figures ([a](source:old-notes); [b](source:client-brief)).',
      '',
      '- [Client brief](source:client-brief): scope, costing',
    ].join('\n')
    await withCitingExample({ appendix: true, citing }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { xml, text, footnotes } = await wordParts(result.docxPath)
      const ours = /It was built from it\[(\d+)\]\. See\[(\d+)\] for the figures\[(\d+)\] \[(\d+)\]\./.exec(text)
      assert.ok(ours, `a mark where each citation was, and no brackets or semicolon left: ${text.slice(text.indexOf('It was built'), text.indexOf('It was built') + 80)}`)
      const notes = ours.slice(1).map((id) => footnotes.find((f) => f.id === id))
      assert.deepEqual(notes.map((f) => f?.text), ['operating model', 'Client brief, p. 4', 'a', 'b'])
      // One footnote in word/footnotes.xml for each mark in the text (the example's own citations among them).
      assert.equal((xml.match(/<w:footnoteReference /g) ?? []).length, footnotes.length)
      assert.equal(new Set(footnotes.map((f) => f.id)).size, footnotes.length)
      assert.ok(footnotes.every((f) => f.xml))
      for (const f of notes) {
        assert.match(f.xml, /<w:pStyle w:val="FootnoteText" ?\/>/, 'the reference document\'s Footnote Text style')
        assert.match(f.xml, /<w:rStyle w:val="FootnoteReference" ?\/>/, 'and its Footnote Reference style for the number')
      }
      assert.match(text, /Client brief: scope, costing/, 'the References-style item prints its words')
      assert.doesNotMatch(text, /\(Client brief\)|\(operating model\)/)
      // The Sources appendix is unchanged: the cited documents, once each.
      assert.match(text, /Client brief\s*Client brief v3\.docx\s*4 Mar 2026\s*Old notes \(removed\)\s*notes\.txt\s*15 Jan 2026/)
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
      assert.match(result.docxMarkdown, /\^\[Client brief, p\. 4\]/)
    })
  })

  test('an Artefact that cites nothing renders exactly as it did, with the setting on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-nocite-'))
    try {
      const instancesDir = join(root, 'instances')
      cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
      rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
      writeFileSync(join(instancesDir, SLUG, 'instance.yaml'), readFileSync(join(instancesDir, SLUG, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3'))
      removeCitations(join(instancesDir, SLUG))
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
    assert.match(result.docxMarkdown, /12\.4 working days\^\[Client brief, p\. 4\], confirmed in the\^\[notes\]\./)
    assert.match(result.markdown, /\(source:client-brief\)/)
  })

  test('without them a citation still prints its words', async () => {
    const result = await runLocalWorkspaceCompute('compile', payload(), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /\^\[Client brief, p\. 4\]/)
  })

  test('a request that names an unsafe id, or too many entries, is refused before anything is written', async () => {
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: [{ id: '../x', filename: 'x.txt' }] }), { definitionsDir: 'definitions' }), LocalWorkspaceRequestError)
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: 'nope' }), { definitionsDir: 'definitions' }), /sources must be an array/)
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: [{ id: 'a', filename: 7 }] }), { definitionsDir: 'definitions' }), /must carry a filename/)
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, filename: 'x.txt' }))
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: many }), { definitionsDir: 'definitions' }), (err) => err.status === 413)
  })
})

// --- #319: a code repository in the render -------------------------------------------------------------------------
// A repository is cited by a file at a commit. Word prints a footnote of the words, the file and the short commit (#351); the Sources appendix gives its title, address, branch and the
// commits cited, through the real render (lib/render.js) on a server workspace and through a Local Workspace's compute request.

describe('a code repository in the render (#319)', () => {
  const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'
  const OLD = '0ld0ld1234567890abcdef1234567890abcdef12'
  const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
  const REPO_MANIFEST = [...MANIFEST, { id: 'billing-api', title: 'Billing API', uploadedBy: 'a.architect', uploadedAt: '2026-11-01T00:00:00.000Z', repository }]
  const REPO_CITED = `${CITED} Orders are capped [Billing API, limits](source:billing-api?path=src/orders/limits.ts&commit=${HEAD}) as the [readme](source:billing-api?path=README.md&commit=${OLD}) says.`
  const APPENDIX = [
    '# Sources',
    '',
    '| Document | File | Added |',
    '| --- | --- | --- |',
    '| Client brief | Client brief v3.docx | 4 Mar 2026 |',
    '| Old notes (removed) | notes.txt | 15 Jan 2026 |',
    '| Billing API | https://github.com/acme/billing-api/tree/main | branch main, commits c0ffee1, 0ld0ld1 |',
  ].join('\n')
  const appendixOf = (text) => text.slice(text.lastIndexOf('# Sources')).trim()

  test('Word prints a repository citation as a footnote naming the file and commit, and the Sources appendix (Word and .md) gives its title, address, branch and commits cited', async () => {
    await withCitingExample({ appendix: true, manifest: REPO_MANIFEST, citing: REPO_CITED }, ({ instancesDir, definitionsDir }) => {
      for (const options of [{ wordTags: false }, {}]) {
        const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, ...options })
        assert.match(result.markdown, new RegExp(`\\[Billing API, limits\\]\\(source:billing-api\\?path=src/orders/limits\\.ts&commit=${HEAD}\\)`), 'the .md keeps the citation as written')
        assert.match(result.docxMarkdown, /Orders are capped\^\[Billing API, limits, src\/orders\/limits\.ts, at commit c0ffee1\] as the\^\[readme, README\.md, at commit 0ld0ld1\] says\./)
        assert.doesNotMatch(result.docxMarkdown, /\]\(source:/)
        for (const text of [result.markdown, result.docxMarkdown]) assert.equal(appendixOf(text), APPENDIX)
      }
    })
  })

  test('the real .docx carries the appendix row, a footnote naming the file and short commit, and no link to the repository citation', async () => {
    await withCitingExample({ appendix: true, manifest: REPO_MANIFEST, citing: REPO_CITED }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { xml, text, footnotes } = await wordParts(result.docxPath)
      const ours = /Orders are capped\[(\d+)\] as the\[(\d+)\] says\./.exec(text)
      assert.ok(ours, 'a footnote mark where each citation was')
      assert.deepEqual(ours.slice(1).map((id) => footnotes.find((f) => f.id === id)?.text), ['Billing API, limits, src/orders/limits.ts, at commit c0ffee1', 'readme, README.md, at commit 0ld0ld1'])
      assert.match(text, /Billing API.*https:\/\/github\.com\/acme\/billing-api\/tree\/main.*branch main, commits c0ffee1, 0ld0ld1/)
      assert.doesNotMatch(xml, /source:/)
    })
  })

  test('a Local Workspace render request takes a repository entry with no filename and prints the same appendix', async () => {
    const instanceYaml = readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    const moduleFiles = {}
    for (const file of readdirSync(join(EXAMPLE, 'modules'))) {
      const text = readFileSync(join(EXAMPLE, 'modules', file), 'utf8')
      moduleFiles[file.replace(/\.md$/, '')] = file === 'background.md' ? text.replace(/\n## Affected domains/, `\n${REPO_CITED}\n\n## Affected domains`) : text
    }
    const assets = readdirSync(join(EXAMPLE, 'assets')).map((file) => ({ id: file, base64: readFileSync(join(EXAMPLE, 'assets', file)).toString('base64') }))
    // What web/app.js's buildLocalComputePayload sends: the cited entries' id, filename, title, dates, origin and (#319) pointer.
    const sources = REPO_MANIFEST.filter((e) => e.id !== 'never-cited').map(({ id, filename, title, uploadedAt, removedAt, origin, repository }) => ({ id, filename, title, uploadedAt, removedAt, origin, repository }))
    assert.equal(sources.find((s) => s.id === 'billing-api').filename, undefined)
    const request = (list) => ({ definitionId: 'design', definitionVersion: 3, instanceYaml, moduleFiles, assets, artefact: 'soap', sources: list })
    const result = await runLocalWorkspaceCompute('compile', request(sources), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /Orders are capped\^\[Billing API, limits, src\/orders\/limits\.ts, at commit c0ffee1\] as the\^\[readme, README\.md, at commit 0ld0ld1\] says\./)
    for (const text of [result.markdown, result.docxMarkdown]) assert.equal(appendixOf(text), APPENDIX)
    // An entry with neither a filename nor a pointer is still refused.
    await assert.rejects(runLocalWorkspaceCompute('compile', request([{ id: 'billing-api', title: 'Billing API' }]), { definitionsDir: 'definitions' }), /must carry a filename/)
  })
})
