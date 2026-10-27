import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinitionChangelog } from '../lib/definition.js'
import { createInstance } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { bodyParagraphs, docxPart } from './helpers/wordDocx.js'
import { classificationField, headerVisibleText, paragraphStyleFormat, sectionHeaders } from './helpers/wordHeaders.js'

// #207 (spec #192 follow-up): a design v3 document carries its classification in the page header
// of every page, centred, as Word does for a marked document. The cover keeps its classification
// line; the footer is unchanged.
//
// Pandoc copies a reference document's headers into the output byte for byte, on both render paths,
// so a header can't hold a different literal value per document. Each v3 reference document's
// headers instead hold a `STYLEREF "Cover Classification"` field, which Word fills from the cover's
// classification paragraph as it lays the pages out. Its stored result is empty: a viewer that
// doesn't update fields shows nothing there rather than another document's marking. With no
// classification, the Word conversion still gets a Cover Classification paragraph, holding only a
// non-breaking space, so the field finds it and shows nothing instead of Word's "Error! No text of
// specified style in document." (ADR-0052, amendment for #207.)
//
// tests/designV3HeaderClassification.playwright.test.js checks the browser's pandoc-wasm render by
// the same rules (tests/helpers/wordHeaders.js).

const TEMPLATES = (version) => join('definitions', 'design', String(version), 'templates')
const REFERENCE_DOCS = (version) => readdirSync(TEMPLATES(version)).filter((f) => /^reference(-[\w-]+)?\.docx$/.test(f)).sort()
const PAGE_TYPES = ['default', 'even', 'first']
const NBSP = ' '

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-header-classification-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Asserts what every v3 header must be, in a reference document or a rendered one: every page type
// has a header, and each header prints the classification through the field, in the Header
// Classification style, with nothing else a reader would see.
function assertClassificationHeaders(docx, label) {
  const headers = sectionHeaders(docx)
  assert.deepEqual(headers.map((h) => h.type).sort(), PAGE_TYPES, `${label}: a header for every page type`)
  for (const { type, part, xml } of headers) {
    const field = classificationField(xml)
    assert.ok(field, `${label}: the ${type} header (${part}) has a STYLEREF "Cover Classification" field`)
    assert.equal(field.paragraphStyle, 'HeaderClassification', `${label}: the ${type} header's field is in the Header Classification style`)
    assert.equal(field.result, '', `${label}: the ${type} header's field stores no result, so a viewer that doesn't update fields shows nothing`)
    assert.equal(headerVisibleText(xml).trim(), '', `${label}: the ${type} header shows no text of its own`)
  }
}

describe('design v3 prints the classification in the page header of every page (#207)', () => {
  test('every v3 reference document has the classification field in its default, first-page and even-page headers', () => {
    const files = REFERENCE_DOCS(3)
    assert.equal(files.length, 7, files.join(', '))
    for (const file of files) assertClassificationHeaders(join(TEMPLATES(3), file), file)
  })

  test('all seven v3 reference documents share one set of headers', () => {
    const shared = sectionHeaders(join(TEMPLATES(3), 'reference.docx'))
    for (const file of REFERENCE_DOCS(3)) {
      const headers = sectionHeaders(join(TEMPLATES(3), file))
      assert.deepEqual(headers.map(({ type, part }) => [type, part]), shared.map(({ type, part }) => [type, part]), file)
      for (const [i, { xml }] of headers.entries()) assert.ok(xml === shared[i].xml, `${file}: ${headers[i].part}`)
    }
  })

  test('the Header Classification style is centred, small and grey, and based on Header', () => {
    const stylesXml = docxPart(join(TEMPLATES(3), 'reference.docx'), 'word/styles.xml')
    const format = paragraphStyleFormat(stylesXml, 'HeaderClassification')
    assert.equal(format.exists, true)
    assert.equal(format.name, 'Header Classification')
    assert.match(stylesXml, /<w:style [^>]*w:styleId="HeaderClassification"[^>]*>[\s\S]*?<w:basedOn w:val="Header"\/>/)
    assert.equal(format.jc, 'center')
    assert.ok(format.size && format.size <= 18, `a small size (at most 9pt), not ${format.size} half-points`)
    const [r, g, b] = (format.color ?? '').match(/../g)?.map((h) => parseInt(h, 16)) ?? []
    assert.ok(r === g && g === b && r > 0x20 && r < 0xc0, `a readable neutral grey, not ${format.color}`)
  })

  test('the footers are v2\'s, unchanged: the header is the only place the classification is added', () => {
    for (const file of REFERENCE_DOCS(3)) {
      for (const part of ['word/footer1.xml', 'word/footer2.xml']) {
        assert.ok(docxPart(join(TEMPLATES(3), file), part) === docxPart(join(TEMPLATES(2), file), part), `${file}: ${part}`)
      }
    }
  })

  test('v1 and v2 reference documents have no classification field', () => {
    for (const version of [1, 2]) {
      for (const file of REFERENCE_DOCS(version)) {
        for (const { type, xml } of sectionHeaders(join(TEMPLATES(version), file))) {
          assert.equal(classificationField(xml), undefined, `design v${version} ${file}: ${type} header`)
        }
      }
    }
  })

  test('the rendered v3 SAD keeps the field in every page type\'s header, with the cover\'s classification paragraph for it to read', () => {
    withScratchDir((dir) => {
      cpSync('workspaces/examples/kiwi-cover-mutual', join(dir, 'kiwi-cover-mutual'), { recursive: true })
      rmSync(join(dir, 'kiwi-cover-mutual', 'out'), { recursive: true, force: true })
      const { docxBytes } = renderArtefact('kiwi-cover-mutual', 'sad', { instancesDir: dir, deliverToClient: true })
      assertClassificationHeaders(docxBytes, 'rendered SAD')
      const [first, second] = bodyParagraphs(docxPart(docxBytes, 'word/document.xml'))
      assert.deepEqual([first.style, first.text], ['CoverClassification', 'IN-CONFIDENCE'])
      assert.equal(second.style, 'Title')
      assert.equal(paragraphStyleFormat(docxPart(docxBytes, 'word/styles.xml'), 'HeaderClassification').jc, 'center', 'the header\'s style reaches the document')
    })
  })

  test('with no classification, Word gets an empty-looking Cover Classification paragraph for the field, and the exported .md has none', () => {
    withScratchDir((instancesDir) => {
      createInstance('design', 'claims-portal', { instancesDir, version: 3 })
      const { markdown, docxMarkdown } = renderArtefact('claims-portal', 'soap', { instancesDir, dryRun: true })
      assert.doesNotMatch(markdown, /Cover Classification/, 'the .md keeps the classification off the cover')
      assert.ok(docxMarkdown.startsWith('::: {custom-style="Cover Classification"}\n\\ \n:::\n\n::: {custom-style="Title"}'), docxMarkdown.slice(0, 200))

      const { docxBytes } = renderArtefact('claims-portal', 'soap', { instancesDir, deliverToClient: true })
      const [first, second] = bodyParagraphs(docxPart(docxBytes, 'word/document.xml'))
      assert.deepEqual([first.style, first.text], ['CoverClassification', NBSP], 'a non-breaking space: something for the field to find, nothing to see')
      assert.deepEqual([second.style, second.text], ['Title', 'Claims Portal'])
      for (const { type, xml } of sectionHeaders(docxBytes)) assert.equal(headerVisibleText(xml).trim(), '', `${type} header`)
    })
  })

  test('the blank classification paragraph is only for a document with a cover that names a classification Field', () => {
    withScratchDir((instancesDir) => {
      createInstance('design', 'claims-portal', { instancesDir, version: 2 })
      const { markdown, docxMarkdown } = renderArtefact('claims-portal', 'soap', { instancesDir, dryRun: true })
      assert.doesNotMatch(docxMarkdown, /Cover Classification/, 'design v2 has no cover')
      assert.equal(docxMarkdown, markdown)
    })

    // A scratch copy of design v3 whose SOAP drops one of the two keys at a time.
    for (const [label, edit] of [
      ['a cover without a classification Field', (yaml) => yaml.replace(SOAP_KEYS, '    cover-page: true\n    table-of-contents: true\n')],
      ['a classification Field without a cover', (yaml) => yaml.replace(SOAP_KEYS, '    cover-classification: document-handling.classification\n    table-of-contents: true\n')],
    ]) {
      withScratchDir((root) => {
        const definitionsDir = join(root, 'definitions')
        const instancesDir = join(root, 'instances')
        cpSync(join('definitions', 'design'), join(definitionsDir, 'design'), { recursive: true })
        const yamlPath = join(definitionsDir, 'design', '3', 'definition.yaml')
        const yaml = readFileSync(yamlPath, 'utf8')
        assert.ok(yaml.includes(SOAP_KEYS), 'the fixture edit must land')
        writeFileSync(yamlPath, edit(yaml))
        createInstance('design', 'claims-portal', { instancesDir, definitionsDir, version: 3 })
        const { docxMarkdown } = renderArtefact('claims-portal', 'soap', { instancesDir, definitionsDir, dryRun: true })
        assert.doesNotMatch(docxMarkdown, /Cover Classification/, label)
      })
    }
  })
})

test('the v3 CHANGELOG records the header classification under v3, and v3 stays a draft (#207)', () => {
  const changelog = loadDefinitionChangelog('design', 3)
  const v3Section = changelog.slice(0, changelog.indexOf('\n## v2'))
  assert.match(v3Section, /^### Classification in the page header \(#207\)$/m)
  assert.match(v3Section, /\*\*Status: draft\b/)
})

const SOAP_KEYS = '    cover-page: true\n    cover-classification: document-handling.classification\n    table-of-contents: true\n'
