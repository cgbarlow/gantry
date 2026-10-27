import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { loadDefinition } from '../lib/definition.js'
import { readModule, writeModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { docxPart, expectedTableOfContents, headingBookmarks, tableOfContents, wordStyles } from './helpers/wordDocx.js'

// #206 (ADR-0052 amendment): the Word TOC field a `table-of-contents: true` Artefact gets is filled
// in when the document is rendered, so a viewer that never updates fields (a preview, a web viewer,
// another editor) shows the contents rather than a placeholder. These tests read the field's result
// out of the .docx from both converters, native Pandoc (CLI and server) and pandoc-wasm (the browser,
// through its Node entry; tests/designV3WordStyles.playwright.test.js checks it in a real browser),
// and hold it to what Word itself lists when it updates the field: one entry per Heading 1–3
// paragraph, in order, in the TOC 1–3 styles, numbered as the document numbers its headings, each
// linking to a bookmark on its heading. Page numbers are left to Word.

const EXAMPLES_DIR = 'workspaces/examples'
const EXAMPLE = 'kiwi-cover-mutual'
const PLACEHOLDER = 'Open this document in Word, or update this field, to build the table of contents.'

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-toc-prefill-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

function copyExample(dir) {
  cpSync(join(EXAMPLES_DIR, EXAMPLE), join(dir, EXAMPLE), { recursive: true })
  rmSync(join(dir, EXAMPLE, 'out'), { recursive: true, force: true })
}

// Headings an author might write that Pandoc and Word treat in ways a naive reading wouldn't: a
// title another heading already has, an unnumbered heading with formatting and its own anchor, a
// numbered heading after it, a level-4 heading (not listed), a heading-like line in a code block and
// one that only continues a paragraph (neither is a heading), closing hashes, smart punctuation, a
// setext heading, and an explicit identifier.
const AUTHORED_HEADINGS = [
  '### Overview',
  '### Data **flows** and [CIS](https://example.com/cis) {#authored-flows .unnumbered}',
  '### Numbered after it',
  '#### Too deep to list',
  '```markdown\n# Inside a fence\n```',
  'A paragraph line\n# Not a heading, it continues the paragraph',
  '### Closing hashes ###',
  '### Don\'t -- stop... "now"',
  'Setext heading\n--------------',
  '### Named *anchor* {#named-anchor}',
].join('\n\n')

// The v3 SAD from a scratch copy of the bundled example, with `extra` appended to its first section.
// A module file's own `##` headings are its Fields, so authored headings start at `###`.
function compileSad(dir, extra) {
  copyExample(dir)
  if (extra) {
    const definition = loadDefinition('design', { version: 3 })
    const { fields } = readModule(definition, EXAMPLE, 'introduction', { instancesDir: dir })
    const [fieldId] = Object.entries(fields).find(([, value]) => typeof value === 'string' && value.startsWith('The build-ready Solution Architecture Document'))
    fields[fieldId] += `\n\n${extra}`
    writeModule(definition, EXAMPLE, 'introduction', { fields }, { instancesDir: dir })
  }
  return renderArtefact(EXAMPLE, 'sad', { instancesDir: dir, dryRun: true })
}

function nativeDocx(dir) {
  return renderArtefact(EXAMPLE, 'sad', { instancesDir: dir, deliverToClient: true }).docxBytes
}

// The same converter build web/lib/pandocWasm.js loads in the browser, through its Node entry, given
// the Markdown and reference document every prepare route hands the browser.
async function wasmDocx(compiled) {
  const { convert } = await import(new URL('../node_modules/pandoc-wasm/src/index.node.js', import.meta.url))
  const files = { 'reference.docx': new Blob([readFileSync(compiled.referenceDocPath)]) }
  const result = await convert({ from: 'markdown', to: 'docx', 'output-file': 'output.docx', 'reference-doc': 'reference.docx' }, compiled.docxMarkdown, files)
  return Buffer.from(await result.files['output.docx'].arrayBuffer())
}

// The TOC field's result lists what Word would list, numbered as the document shows it, each entry
// linking to a bookmark on its own heading; the field is still marked for Word to rebuild.
function assertPrefilled(docx, what) {
  const documentXml = docxPart(docx, 'word/document.xml')
  const styles = wordStyles(docxPart(docx, 'word/styles.xml'))
  const numberingXml = docxPart(docx, 'word/numbering.xml')
  const toc = tableOfContents(documentXml)
  assert.ok(toc, `${what}: there is a TOC field`)
  assert.equal(toc.instruction, ' TOC \\o "1-3" \\h \\z \\u ', what)
  assert.equal(toc.dirty, true, `${what}: Word still rebuilds the field, with page numbers, on open`)
  assert.ok(!documentXml.includes(PLACEHOLDER), `${what}: no placeholder`)
  const expected = expectedTableOfContents(documentXml, styles, numberingXml)
  assert.ok(expected.length > 0)
  assert.deepEqual(
    toc.entries.map(({ style, text }) => ({ style, text })),
    expected.map(({ style, text }) => ({ style, text })),
    `${what}: one entry per Heading 1–3, in order, numbered as the document numbers it`
  )
  const bookmarks = headingBookmarks(documentXml)
  for (const [i, entry] of toc.entries.entries()) {
    assert.ok(entry.anchor, `${what}: "${entry.text}" is a link`)
    assert.equal(bookmarks.get(entry.anchor)?.heading, expected[i].heading, `${what}: "${entry.text}" links to its own heading (#${entry.anchor})`)
  }
  return toc
}

test('the native render of the v3 SAD fills its table of contents with its numbered headings, each linked to its heading', async () => {
  await withScratchDir((dir) => {
    compileSad(dir)
    const toc = assertPrefilled(nativeDocx(dir), 'native Pandoc')
    assert.deepEqual(
      toc.entries.slice(0, 5).map(({ style, text }) => [style, text]),
      [['TOC2', 'Document Control'], ['TOC2', 'Review & sign-off'], ['TOC1', '1\tOverview'], ['TOC2', '1.1\tExecutive summary'], ['TOC2', '1.2\tOverview']],
      'the unnumbered front matter, then section 1 numbered as Word numbers it'
    )
    assert.ok(toc.entries.some((e) => e.style === 'TOC3' && /^\d+\.\d+\.\d+\t/.test(e.text)), 'level 3 is listed')
    assert.ok(
      toc.entries.some((e) => e.text.endsWith('SAN (Database, Application Server, Backup, DR)') && /^X[0-9a-f]{39}$/.test(e.anchor)),
      'an identifier over 40 characters links to the bookmark name Pandoc gives it'
    )
  })
})

test('pandoc-wasm (the browser\'s converter) fills the same table of contents from the same Markdown', async () => {
  await withScratchDir(async (dir) => {
    const toc = assertPrefilled(await wasmDocx(compileSad(dir)), 'pandoc-wasm')
    assert.deepEqual(toc.entries.slice(0, 3).map(({ text }) => text), ['Document Control', 'Review & sign-off', '1\tOverview'])
  })
})

test('authored headings are listed as Word lists them: duplicates, unnumbered, too deep, in code, mid-paragraph, setext, smart punctuation', async () => {
  await withScratchDir(async (dir) => {
    const compiled = compileSad(dir, AUTHORED_HEADINGS)
    for (const [what, docx] of [['native Pandoc', nativeDocx(dir)], ['pandoc-wasm', await wasmDocx(compiled)]]) {
      const toc = assertPrefilled(docx, what)
      const texts = toc.entries.map((e) => e.text.replace(/^[\d.]+\t/, ''))
      const at = texts.indexOf('Data flows and CIS')
      assert.ok(at > 0, `${what}: the unnumbered heading is listed, as its text`)
      assert.equal(toc.entries[at].text, 'Data flows and CIS', `${what}: without a number`)
      assert.equal(toc.entries[at].anchor, 'authored-flows')
      assert.equal(toc.entries[at - 1].anchor, 'overview-2', `${what}: a third "Overview" links to the bookmark Pandoc made unique for it`)
      assert.deepEqual(
        texts.slice(at - 1, at + 6),
        ['Overview', 'Data flows and CIS', 'Numbered after it', 'Closing hashes', 'Don’t – stop… “now”', 'Setext heading', 'Named anchor'],
        `${what}: in order, leaving out the level-4 heading, the fenced line and the paragraph line`
      )
      assert.equal(toc.entries[at + 5].anchor, 'named-anchor')
      assert.ok(!texts.some((t) => /Inside a fence|Not a heading|Too deep/.test(t)), what)
    }
  })
})

test('the exported .md keeps the field as Pandoc input; only the Word conversion is filled in', async () => {
  await withScratchDir((dir) => {
    const { markdown, docxMarkdown } = compileSad(dir)
    assert.ok(markdown.includes(PLACEHOLDER), 'the .md is unchanged')
    assert.ok(!docxMarkdown.includes(PLACEHOLDER))
    assert.match(docxMarkdown, /<w:pStyle w:val="TOC1"\/>/)
  })
})

// ── The numbers come from the reference document ────────────────────────────────────────────────

// A zip of `entries` ({ name: text }), stored uncompressed: enough of a reference document for the
// compile step, which reads only its styles and numbering.
function storedZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text)
    const nameBytes = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const V3_REFERENCE = 'definitions/design/3/templates/reference-sad.docx'

// The v3 SAD's Word Markdown, compiled against a house-style reference document made of `styles`
// and `numbering`, and the TOC entries in it.
async function entriesWithReference(styles, numbering) {
  return withScratchDir((dir) => {
    const definitionsDir = join(dir, 'definitions')
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    writeFileSync(join(definitionsDir, 'design', '3', 'templates', 'reference-sad.docx'), storedZip({ 'word/styles.xml': styles, 'word/numbering.xml': numbering }))
    copyExample(dir)
    const { docxMarkdown } = renderArtefact(EXAMPLE, 'sad', { instancesDir: dir, definitionsDir, dryRun: true })
    return tableOfContents(docxMarkdown).entries.map(({ style, text }) => [style, text])
  })
}

test('the entries are numbered in the reference document\'s own format: its number styles, start, separator and legal numbering', async () => {
  const styles = docxPart(V3_REFERENCE, 'word/styles.xml')
  const level = (ilvl, numFmt, lvlText, extra = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>${extra}<w:lvlText w:val="${lvlText}"/></w:lvl>`
  const houseStyle =
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="42">' +
    level(0, 'upperRoman', '%1.', '<w:suff w:val="space"/>') +
    level(1, 'lowerLetter', '%1.%2') +
    level(2, 'decimal', '%1.%2.%3', '<w:isLgl/>') +
    '</w:abstractNum>' +
    '<w:num w:numId="51"><w:abstractNumId w:val="42"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>' +
    '</w:numbering>'
  const entries = await entriesWithReference(styles, houseStyle)
  assert.deepEqual(entries.slice(0, 5), [
    ['TOC2', 'Document Control'],
    ['TOC2', 'Review & sign-off'],
    ['TOC1', 'III. Overview'],
    ['TOC2', 'III.a\tExecutive summary'],
    ['TOC2', 'III.b\tOverview'],
  ])
  assert.ok(entries.some(([style, text]) => style === 'TOC3' && text === '6.2.1\tTake out insurance'), 'legal numbering shows every level as a decimal')
})

test('a reference document that numbers no headings gives entries without numbers', async () => {
  const unnumbered = docxPart(V3_REFERENCE, 'word/styles.xml').replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '')
  const entries = await entriesWithReference(unnumbered, docxPart(V3_REFERENCE, 'word/numbering.xml'))
  assert.deepEqual(entries.slice(0, 4), [['TOC2', 'Document Control'], ['TOC2', 'Review & sign-off'], ['TOC1', 'Overview'], ['TOC2', 'Executive summary']])
  assert.ok(!entries.some(([, text]) => text.includes('\t')))
})
