import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Eta } from 'eta'
import { renderArtefact } from '../lib/render.js'
import {
  applyFieldTags,
  collapseBlankLines,
  createFieldTagger,
  fieldBookmarkName,
  stripFieldTags,
  tagFieldOutputs,
  TAG_FUNCTION_HEADER,
  wordDocumentProperties,
} from '../lib/wordFieldTags.js'

// #301 (ADR-0066): every Word render is tagged, so a Reviewed copy can be read back onto Fields.
// Each printed Field's value sits in an invisible bookmark (`gf_` + a hash of module/field) and the
// document carries `gantry-*` properties. These tests cover the tagging itself, the visible output
// being what it was, and both render paths: the native Pandoc and the browser's pandoc-wasm convert
// the same `docxMarkdown`.

const NA = (v) => (typeof v === 'string' && v.trim() !== '' ? v : '— n/a —')
const S = (name) => `\uE000${name}\uE001`
const E = (name) => `\uE002${name}\uE001`

// --- Bookmark names ---

test('a Field bookmark name is gf_ and eight hex digits, the same every time, and differs per Field', () => {
  const name = fieldBookmarkName('background', 'problem')
  assert.match(name, /^gf_[0-9a-f]{8}$/)
  assert.equal(fieldBookmarkName('background', 'problem'), name)
  assert.notEqual(fieldBookmarkName('background', 'opportunity'), name)
  assert.notEqual(fieldBookmarkName('introduction', 'problem'), name)
})

// --- Markers to Divs and Spans ---

test('a value that is its own block becomes a Div with the Field bookmark as its id', () => {
  const out = applyFieldTags(`## Heading\n\n${S('gf_aaaaaaaa')}First paragraph.\n\nSecond.${E('gf_aaaaaaaa')}\n\n## Next\n`)
  assert.equal(out, '## Heading\n\n::: {#gf_aaaaaaaa}\nFirst paragraph.\n\nSecond.\n:::\n\n## Next\n')
})

test('a single-line value inside a line becomes a Span, including in a table cell', () => {
  const out = applyFieldTags(`| Epic | ${S('gf_bbbbbbbb')}Payments${E('gf_bbbbbbbb')} |\n`)
  assert.equal(out, '| Epic | [Payments]{#gf_bbbbbbbb} |\n')
})

test('a list value (first bullet to last) becomes one Div', () => {
  const out = applyFieldTags(`Intro\n\n- ${S('gf_cccccccc')}One\n- Two\n- Three${E('gf_cccccccc')}\n\nAfter\n`)
  assert.equal(out, 'Intro\n\n::: {#gf_cccccccc}\n- One\n- Two\n- Three\n:::\n\nAfter\n')
})

test('a Field printed twice gets the same name, then a numbered one', () => {
  const out = applyFieldTags(`${S('gf_dddddddd')}One${E('gf_dddddddd')}\n\n${S('gf_dddddddd')}Two${E('gf_dddddddd')}\n`)
  assert.match(out, /\{#gf_dddddddd\}/)
  assert.match(out, /\{#gf_dddddddd_2\}/)
})

test('a value is left as it was where wrapping it would change how the Markdown reads', () => {
  // Inside a code fence of the template, in a heading, in a link target, text that runs on from the
  // line before: nothing is wrapped, and nothing is lost.
  const cases = [
    '```mermaid\n%V%\n```\n',
    '# Title %V%\n',
    'See [link](%V%) now\n',
  ]
  for (const template of cases) {
    const marked = template.replace('%V%', `${S('gf_eeeeeeee')}value${E('gf_eeeeeeee')}`)
    const out = applyFieldTags(marked)
    assert.equal(out, template.replace('%V%', 'value'), template)
  }
})

test('two list values with only a blank line between them stay one list: bookmarked in place, not split by Divs', () => {
  const marked = `## NFR\n\n- ${S('gf_11111111')}Fast\n- Safe${E('gf_11111111')}\n\n- ${S('gf_22222222')}Cheap\n- Small${E('gf_22222222')}\n`
  const out = applyFieldTags(marked)
  assert.ok(!out.includes(':::'), 'no Div may split the list')
  assert.equal(stripFieldTags(out), '## NFR\n\n- Fast\n- Safe\n\n- Cheap\n- Small\n')
  assert.match(out, /w:name="gf_11111111"/)
  assert.match(out, /w:name="gf_22222222"/)
  assert.equal((out.match(/<w:bookmarkStart/g) ?? []).length, 2)
  assert.equal((out.match(/<w:bookmarkEnd/g) ?? []).length, 2)
})

test('markers that were never closed are dropped, leaving the text as it was', () => {
  assert.equal(applyFieldTags(`${S('gf_ffffffff')}text only\n`), 'text only\n')
})

test('blank lines collapse around markers exactly as they do without them', () => {
  const marked = `a${E('gf_aaaaaaaa')}\n\n\n${S('gf_bbbbbbbb')}\n\nb`
  assert.equal(collapseBlankLines(marked).replace(/[\uE000-\uE002][^\uE001]*\uE001/g, ''), 'a\n\nb')
})

// --- Tagging while compiling: templates keep seeing plain values ---

function compileWithTagger(template, modules, data = {}) {
  const tagger = createFieldTagger(modules)
  const eta = new Eta({
    autoTrim: false,
    functionHeader: `const na = ${NA.toString()};` + TAG_FUNCTION_HEADER,
    autoFilter: true,
    filterFunction: tagger.filter,
    plugins: [{ processAST: tagFieldOutputs }],
  })
  return eta.renderString(template, { modules: tagger.modules, __gantryTagger: tagger, ...data })
}

test('conditions, comparisons and helpers see exactly the plain values while the printed Fields are tagged', () => {
  const modules = { vetting: { outcome: 'passed', notes: '', conditions: 'None' }, role: { team: ['A', 'B'] } }
  const template = [
    "<% if (it.modules.vetting.outcome === 'passed') { %>OK <%~ na(it.modules.vetting.conditions) %><% } %>",
    "<% if (!it.modules.vetting.notes) { %> EMPTY <%~ na(it.modules.vetting.notes) %><% } %>",
    "<% it.modules.role.team.forEach(function(item) { %>\n- <%~ item %><% }) %>",
    '<%~ it.instance %>',
  ].join('')
  const out = compileWithTagger(template, modules, { instance: 'inst' })
  const plain = out.replace(/[\uE000-\uE002][^\uE001]*\uE001/g, '')
  assert.equal(plain, 'OK None EMPTY — n/a —\n- A\n- Binst')
  assert.equal([...out.matchAll(/\uE000([^\uE001]*)\uE001/g)].map((m) => m[1]).join(','), [fieldBookmarkName('vetting', 'conditions'), fieldBookmarkName('vetting', 'notes'), fieldBookmarkName('role', 'team')].join(','))
})

// --- Properties ---

test('document properties are a metadata block that leaves out anything without a value', () => {
  const block = wordDocumentProperties({ instance: 'acme', commit: undefined, 'render-id': 'a-b' })
  assert.match(block, /^---\ngantry-instance: "acme"\ngantry-render-id: "a\\\\-b"\n---\n\n$/)
  assert.equal(wordDocumentProperties({ commit: '' }), '')
})

// --- The two render paths ---

const SP = new Set(['kiwi-cover-mutual:soap', 'kiwi-cover-mutual:hld', 'kiwi-cover-mutual:sad', 'kiwi-cover-mutual:ssad', 'kiwi-cover-mutual:as-built', 'gantry:soap', 'gantry:soap-full'])

function withExample(example, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync(`workspaces/examples/${example}`, join(instancesDir, 'e'), { recursive: true })
    const result = fn(instancesDir)
    if (result?.then) return result.finally(() => rmSync(instancesDir, { recursive: true, force: true }))
    rmSync(instancesDir, { recursive: true, force: true })
    return result
  } catch (error) {
    rmSync(instancesDir, { recursive: true, force: true })
    throw error
  }
}

// Normalises what is allowed to differ between two renders of the same Markdown that differ only in
// the bookmarks and properties: the bookmark elements themselves and the ids and relationship numbers
// Pandoc counts through them.
function withoutBookmarks(xml) {
  return xml
    .replace(/<w:bookmarkStart [^>]*w:name="gf_[^"]*" *\/>/g, '')
    .replace(/<w:bookmarkEnd [^>]*\/>/g, '')
    .replace(/ w:id="\d+"/g, '')
    .replace(/(<(?:wp:docPr|pic:cNvPr) [^>]*?) id="\d+"/g, '$1')
    .replace(/rId\d+/g, 'rId')
}

function docxPart(docxPath, part) {
  return execFileSync('unzip', ['-p', docxPath, part], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

test('the Word text of every example is its untagged text plus Field Divs, Spans and properties, and the exported .md is untouched', () => {
  for (const key of SP) {
    const [example, artefactId] = key.split(':')
    withExample(example, (instancesDir) => {
      const tagged = renderArtefact('e', artefactId, { dryRun: true, instancesDir })
      const untagged = renderArtefact('e', artefactId, { dryRun: true, instancesDir, wordTags: false })
      assert.equal(stripFieldTags(tagged.docxMarkdown), untagged.docxMarkdown, key)
      assert.equal(tagged.markdown, untagged.markdown, key)
      assert.doesNotMatch(tagged.markdown, /gf_[0-9a-f]{8}|^gantry-instance:/m, key)
      assert.doesNotMatch(tagged.docxMarkdown, /[\uE000-\uE002]/, key)
      assert.match(tagged.docxMarkdown, /^---\ngantry-instance: /, key)
    })
  }
})

test('a Word render has a bookmark for every printed Field and nothing is lost from the document', () => {
  withExample('kiwi-cover-mutual', (instancesDir) => {
    for (const artefactId of ['soap', 'hld', 'sad']) {
      const tagged = renderArtefact('e', artefactId, { dryRun: true, instancesDir })
      const untagged = renderArtefact('e', artefactId, { dryRun: true, instancesDir, wordTags: false })
      const names = [...tagged.docxMarkdown.matchAll(/gf_[0-9a-f]{8}(?:_\d+)?/g)].map((m) => m[0])
      assert.ok(names.length >= 10, `${artefactId} has ${names.length} Field bookmarks`)

      const taggedPath = join(instancesDir, `${artefactId}-tagged.docx`)
      const untaggedPath = join(instancesDir, `${artefactId}-untagged.docx`)
      for (const [result, path] of [[tagged, taggedPath], [untagged, untaggedPath]]) {
        const mdPath = path.replace(/\.docx$/, '.md')
        writeFileSync(mdPath, result.docxMarkdown)
        execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '--reference-doc', result.referenceDocPath, '-o', path, mdPath])
      }
      const taggedXml = docxPart(taggedPath, 'word/document.xml')
      const untaggedXml = docxPart(untaggedPath, 'word/document.xml')
      const starts = [...taggedXml.matchAll(/<w:bookmarkStart [^>]*w:name="(gf_[^"]+)"/g)].map((m) => m[1])
      assert.deepEqual(starts.sort(), [...new Set(names)].sort(), `${artefactId}: one bookmark per printed Field`)
      assert.equal(untaggedXml.includes('w:name="gf_'), false)
      assert.equal(withoutBookmarks(taggedXml), withoutBookmarks(untaggedXml), `${artefactId}: the visible document is unchanged`)
    }
  })
})

test('a native Word render writes the gantry-* properties, and every render has a new render id', () => {
  withExample('gantry', (instancesDir) => {
    const first = renderArtefact('e', 'soap', { dryRun: true, instancesDir, contentCommit: true, commit: { hash: 'abc1234', fullHash: 'abc1234def5678abc1234def5678abc1234def5', date: '2026-01-02' } })
    const second = renderArtefact('e', 'soap', { dryRun: true, instancesDir })
    // A local render's commit is the Gantry build's, not the content's, so it is not recorded.
    assert.doesNotMatch(second.docxMarkdown, /gantry-commit/)
    const idOf = (md) => /gantry-render-id: "([^"]+)"/.exec(md)[1].replace(/\\/g, '')
    assert.notEqual(idOf(first.docxMarkdown), idOf(second.docxMarkdown))

    const mdPath = join(instancesDir, 'p.md')
    const docxPath = join(instancesDir, 'p.docx')
    writeFileSync(mdPath, first.docxMarkdown)
    execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '--reference-doc', first.referenceDocPath, '-o', docxPath, mdPath])
    const custom = docxPart(docxPath, 'docProps/custom.xml')
    const property = (name) => new RegExp(`name="gantry-${name}"><vt:lpwstr>([^<]*)</vt:lpwstr>`).exec(custom)?.[1]
    assert.equal(property('instance'), 'e')
    assert.equal(property('artefact'), 'soap')
    assert.equal(property('stage'), 'shape')
    assert.equal(property('definition'), 'design@3')
    assert.equal(property('commit'), 'abc1234def5678abc1234def5678abc1234def5')
    assert.equal(property('render-id'), idOf(first.docxMarkdown))
    assert.notEqual(property('render-id'), property('instance'))
  })
})

test('a render with no commit (a server workspace) has no gantry-commit property', () => {
  const block = wordDocumentProperties({ instance: 'e', commit: undefined })
  assert.doesNotMatch(block, /gantry-commit/)
})

test('the browser path (pandoc-wasm) writes the same bookmarks and properties from the same Markdown', async () => {
  const { convert } = await import('../node_modules/pandoc-wasm/src/index.node.js')
  await withExample('kiwi-cover-mutual', async (instancesDir) => {
    const result = renderArtefact('e', 'hld', { dryRun: true, instancesDir })
    const reference = new Blob([readFileSync(result.referenceDocPath)])
    const wasm = await convert(
      { from: 'markdown', to: 'docx', 'output-file': 'output.docx', 'reference-doc': 'reference.docx' },
      result.docxMarkdown,
      { 'reference.docx': reference }
    )
    const docxPath = join(instancesDir, 'wasm.docx')
    writeFileSync(docxPath, new Uint8Array(await wasm.files['output.docx'].arrayBuffer()))
    const xml = docxPart(docxPath, 'word/document.xml')
    const names = [...new Set([...result.docxMarkdown.matchAll(/gf_[0-9a-f]{8}(?:_\d+)?/g)].map((m) => m[0]))].sort()
    const starts = [...xml.matchAll(/<w:bookmarkStart [^>]*w:name="(gf_[^"]+)"/g)].map((m) => m[1]).sort()
    assert.deepEqual(starts, names)
    const custom = docxPart(docxPath, 'docProps/custom.xml')
    for (const name of ['instance', 'artefact', 'stage', 'definition', 'render-id']) {
      assert.match(custom, new RegExp(`name="gantry-${name}"><vt:lpwstr>[^<]+</vt:lpwstr>`))
    }
  })
})

test('a format: md render is compiled and exported untagged', () => {
  withExample('gantry', (instancesDir) => {
    const result = renderArtefact('e', 'soap', { dryRun: true, instancesDir, format: 'md' })
    assert.doesNotMatch(result.docxMarkdown, /gf_[0-9a-f]{8}|^gantry-instance:/m)
  })
})

test('a template the tagging can not compile still renders, with the properties but no Field bookmarks', () => {
  withExample('gantry', (instancesDir) => {
    // `<%~ x; y %>` is a fine statement for the plain engine but not a value for the tagged one.
    cpSync('definitions', join(instancesDir, 'definitions'), { recursive: true })
    const templatePath = join(instancesDir, 'definitions', 'design', '3', 'templates', 'soap.md.tmpl')
    writeFileSync(templatePath, readFileSync(templatePath, 'utf8') + '\n<% const q = 1 %><%~ q; q %>\n')
    const result = renderArtefact('e', 'soap', { dryRun: true, instancesDir, definitionsDir: join(instancesDir, 'definitions') })
    assert.doesNotMatch(result.docxMarkdown, /gf_[0-9a-f]{8}/)
    assert.match(result.docxMarkdown, /^---\ngantry-instance: /)
  })
})
