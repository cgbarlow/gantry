import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderArtefact } from '../lib/render.js'
import { loadDefinition } from '../lib/definition.js'
import { buildFieldIndex, checkReviewedCopy, placeReview, readReviewedCopy } from '../web/lib/reviewedCopy.js'
import { fieldBookmarkName } from '../web/lib/fieldBookmark.js'
import { expectedRender } from '../lib/reviews.js'
import { unzip, zip } from './helpers/reviewedCopyFixture.js'

// #302 (ADR-0066): the reader against a real Gantry render — Pandoc's own bookmarks and properties from
// the bundled Kiwi Cover Mutual example — with a comment added the way Word adds one. The fixtures in
// tests/helpers/reviewedCopyFixture.js stand in for Word and Google Docs; this proves they are shaped like
// what Gantry really renders.

function renderDocx(instancesDir, options) {
  const result = renderArtefact('e', 'hld', { dryRun: true, instancesDir, ...options })
  const mdPath = join(instancesDir, 'hld.md')
  const docxPath = join(instancesDir, 'hld.docx')
  writeFileSync(mdPath, result.docxMarkdown)
  execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '--reference-doc', result.referenceDocPath, '-o', docxPath, mdPath])
  return readFileSync(docxPath)
}

// Wraps the first run after the first Field bookmark whose name is `name` in a comment, as Word does.
function withComment(docx, name, text) {
  const parts = unzip(docx)
  const xml = parts['word/document.xml'].toString('utf8')
  const start = xml.indexOf(`w:name="${name}"`)
  assert.notEqual(start, -1, `${name} is in the document`)
  const runStart = xml.indexOf('<w:r>', start)
  const runEnd = xml.indexOf('</w:r>', runStart) + '</w:r>'.length
  const wrapped = `<w:commentRangeStart w:id="0"/>${xml.slice(runStart, runEnd)}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`
  parts['word/document.xml'] = xml.slice(0, runStart) + wrapped + xml.slice(runEnd)
  parts['word/comments.xml'] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Ana Reviewer" w:date="2026-11-03T10:00:00Z" w:initials="AR"><w:p><w:r><w:t>' +
    text +
    '</w:t></w:r></w:p></w:comment></w:comments>'
  return { docx: zip(parts), runText: /<w:t[^>]*>([^<]*)<\/w:t>/.exec(xml.slice(runStart, runEnd))?.[1] }
}

function withExample(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-302-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(root, 'e'), { recursive: true })
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a real tagged render is accepted by its own Instance, and a comment on a Field is placed on that Field from its bookmark', () =>
  withExample(async (root) => {
    const definition = loadDefinition('design', { version: 3 })
    const docx = renderDocx(root, { contentCommit: true, commit: { hash: 'abc1234', fullHash: 'abc1234def5678abc1234def5678abc1234def5', date: '2026-01-02' } })
    const plain = await readReviewedCopy(docx)
    assert.equal(plain.properties.instance, 'e')
    assert.equal(plain.properties.artefact, 'hld')
    assert.equal(plain.properties.commit, 'abc1234def5678abc1234def5678abc1234def5')
    assert.ok(plain.fieldBookmarks >= 10, `${plain.fieldBookmarks} Field bookmarks`)
    // The cover, Document Control and the table of contents are Gantry's own, so a comment on one is about the document.
    const aboutTheDocument = new Set(plain.paragraphs.map((p) => p.about))
    for (const region of ['cover', 'document-control', 'table-of-contents']) assert.ok(aboutTheDocument.has(region), region)
    assert.ok(plain.paragraphs.filter((p) => p.fields.length).every((p) => !p.about), 'a Field is never about the document')
    assert.deepEqual(checkReviewedCopy(plain.properties, expectedRender('e', definition)), { ok: true })
    assert.equal(checkReviewedCopy(plain.properties, expectedRender('another', definition)).code, 'other-instance')

    // The first Field bookmark in the document that the Definition knows.
    const index = buildFieldIndex([...definition.modules].flatMap(([moduleId, spec]) => spec.fields.map((f) => ({ moduleId, moduleTitle: spec.title, fieldId: f.id, fieldTitle: f.title }))))
    const xml = unzip(docx)['word/document.xml'].toString('utf8')
    const name = [...xml.matchAll(/<w:bookmarkStart [^>]*w:name="(gf_[0-9a-f]{8})"/g)].map((m) => m[1]).find((n) => index.has(n))
    assert.ok(name)
    const { docx: reviewed, runText } = withComment(docx, name, 'Is this right?')

    const read = await readReviewedCopy(reviewed)
    assert.equal(read.threads.length, 1)
    assert.equal(read.threads[0].text, 'Is this right?')
    assert.equal(read.threads[0].author, 'Ana Reviewer')
    assert.equal(read.threads[0].fields[0], name)
    assert.ok(runText === undefined || read.threads[0].anchor.text.length > 0)
    const placed = placeReview(read, { fieldIndex: index })
    const field = index.get(name)
    assert.equal(placed.groups[0].kind, 'field')
    assert.equal(`${placed.groups[0].field.moduleId}/${placed.groups[0].field.fieldId}`, `${field.moduleId}/${field.fieldId}`)
    assert.equal(fieldBookmarkName(field.moduleId, field.fieldId), name)
  }))

test('a real render made without the tags (no gantry-* properties) is refused as untagged', () =>
  withExample(async (root) => {
    const definition = loadDefinition('design', { version: 3 })
    const untagged = await readReviewedCopy(renderDocx(root, { wordTags: false }))
    assert.deepEqual(untagged.properties, {})
    assert.equal(untagged.fieldBookmarks, 0)
    const verdict = checkReviewedCopy(untagged.properties, expectedRender('e', definition))
    assert.equal(verdict.code, 'untagged')
  }))
