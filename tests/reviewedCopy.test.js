import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { parseXml, attribute } from '../web/lib/ooxml.js'
import { baseFieldBookmark, fieldBookmarkName } from '../web/lib/fieldBookmark.js'
import {
  REVIEWED_COPY_MAX_BYTES,
  ReviewedCopyError,
  buildFieldIndex,
  checkReviewedCopy,
  placeReview,
  plainText,
  readReviewedCopy,
  summariseReview,
} from '../web/lib/reviewedCopy.js'
import { FIELDS, OPPORTUNITY, PROBLEM, SUCCESS, RENDER_PROPERTIES, reviewedCopy, zip } from './helpers/reviewedCopyFixture.js'

// #302 (ADR-0066): Gantry's own reader of a Reviewed copy. These tests cover the reader on the two kinds
// of file that come back (saved by Word, exported by Google Docs), the checks that refuse a document that
// isn't one of this Instance's own renders, and where each comment is placed.

const EXPECTED = { slug: 'acme', definition: 'design', artefactIds: ['hld', 'sad'], stageIds: ['shape'] }
const fieldIndex = buildFieldIndex(FIELDS)
const BASIS = { basis: 'commit', commit: RENDER_PROPERTIES.commit, fields: FIELDS }
const byText = (items, text) => items.find((item) => item.text === text)

describe('the Field bookmark name', () => {
  test('is gf_ and the first eight hex digits of a SHA-1 of module/field, the same as node:crypto gives', () => {
    for (const [moduleId, fieldId] of [['background', 'problem'], ['hld-submission', 'authors-and-contributors'], ['nfrs', 'performance'], ['a', 'ünïcode ✓'], ['x'.repeat(200), 'y']]) {
      const expected = 'gf_' + createHash('sha1').update(`${moduleId}/${fieldId}`).digest('hex').slice(0, 8)
      assert.equal(fieldBookmarkName(moduleId, fieldId), expected)
    }
  })

  test('baseFieldBookmark drops a _2 copy suffix and recognises nothing else', () => {
    assert.equal(baseFieldBookmark('gf_3f9a1c2e'), 'gf_3f9a1c2e')
    assert.equal(baseFieldBookmark('gf_3f9a1c2e_2'), 'gf_3f9a1c2e')
    for (const name of ['al07iqog7ysd', 'gf_3f9a1c2', 'gf_3F9A1C2E', '_Toc123', '', undefined]) assert.equal(baseFieldBookmark(name), null, String(name))
  })
})

describe('the XML reader', () => {
  test('reads elements, attributes, entities and text, and keeps a lone space inside w:t', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1" w:id=\'2\'><w:t> </w:t><b>x &amp; &lt;y&gt; &#65;&#x42;</b><c/><![CDATA[raw <>]]></a>')
    assert.equal(root.name, 'a')
    assert.equal(attribute(root, 'id'), '2')
    assert.equal(root.attrs.x, '1')
    assert.deepEqual(root.children[0].children, [' '])
    assert.deepEqual(root.children[1].children, ['x & <y> AB'])
    assert.equal(root.children[2].name, 'c')
    assert.equal(root.children[3], 'raw <>')
  })

  test('refuses markup that does not nest', () => {
    assert.throws(() => parseXml('<a><b></a>'), /Unexpected/)
    assert.throws(() => parseXml('<a><b>'), /ends before/)
  })
})

describe('reading a Word-saved Reviewed copy', async () => {
  const read = await readReviewedCopy(reviewedCopy({ kind: 'word' }))

  test('gives the Render properties and counts the Field bookmarks', () => {
    assert.deepEqual(read.properties, RENDER_PROPERTIES)
    assert.equal(read.fieldBookmarks, 3)
    assert.equal(read.commentCount, 9)
    assert.deepEqual(read.commenters, ['Ana Reviewer', 'Ben Commenter'])
  })

  test('lists each thread with its replies and resolved flag, and the Field it sits on', () => {
    assert.equal(read.threads.length, 8, 'a reply is part of its thread, not a thread of its own')
    const which = byText(read.threads, 'Which card schemes?')
    assert.equal(which.author, 'Ana Reviewer')
    assert.equal(which.date, '2026-11-03T10:00:00Z')
    assert.equal(which.resolved, true)
    assert.deepEqual(which.replies.map((r) => [r.author, r.text]), [['Ben Commenter', 'Visa and Mastercard.']])
    assert.equal(which.anchor.text, 'new payments platform')
    assert.deepEqual(which.fields, [PROBLEM])
    assert.equal(byText(read.threads, 'Add the team').resolved, false)
    assert.deepEqual(byText(read.threads, 'Add the team').fields, [SUCCESS])
  })

  test('a comment that spans two Fields lists both, in document order', () => {
    const spanning = byText(read.threads, 'Say who signs this off')
    assert.deepEqual(spanning.fields, [PROBLEM, OPPORTUNITY])
  })

  test('a comment with no range is a point on the Field it sits in', () => {
    const point = byText(read.threads, 'Point comment with no range')
    assert.equal(point.anchor.text, '')
    assert.deepEqual(point.fields, [OPPORTUNITY])
  })

  test('comments on the cover, Document Control and table of contents are about the document', () => {
    assert.equal(byText(read.threads, 'Put the date on the cover').about, 'cover')
    assert.equal(byText(read.threads, 'Is this the right version?').about, 'document-control')
    assert.equal(byText(read.threads, 'Why is this here?').about, 'table-of-contents')
    for (const text of ['Put the date on the cover', 'Is this the right version?', 'Why is this here?']) assert.deepEqual(byText(read.threads, text).fields, [])
  })

  test('a comment on a template heading belongs to the Field under it', () => {
    const heading = byText(read.threads, 'Rename to Purpose')
    assert.equal(heading.onHeading, true)
    assert.deepEqual(heading.fields, [PROBLEM])
  })

  test('lists tracked changes with author, date, text and the Field they sit on', () => {
    assert.deepEqual(
      read.changes.map((c) => [c.kind, c.author, c.text, c.fields]),
      [
        ['deletion', 'Ana Reviewer', 'must', [PROBLEM]],
        ['insertion', 'Ana Reviewer', 'should', [PROBLEM]],
        ['insertion', 'Ben Commenter', 'Improve settlement speed.', [OPPORTUNITY]],
      ]
    )
    assert.equal(read.changes[0].date, '2026-11-03T10:00:00Z')
  })

  test('as rendered, the anchor has no inserted text and keeps deleted text', () => {
    const rendered = read.paragraphs.find((p) => /^It /.test(p.original))
    assert.equal(rendered.original, 'It must support card schemes.')
    assert.equal(rendered.current, 'It should support card schemes.')
  })

  test('places everything from the bookmarks, grouped by Field in Definition order, with nothing said about text matching', () => {
    const placed = placeReview(read, { fieldIndex })
    assert.equal(placed.mode, 'bookmarks')
    assert.equal(placed.notice, null)
    assert.deepEqual(
      placed.groups.map((g) => (g.kind === 'field' ? g.field.fieldId : g.kind)),
      ['problem', 'opportunity', 'success-criteria', 'document']
    )
    const problem = placed.groups[0]
    assert.deepEqual(problem.threads.map((t) => t.text), ['Rename to Purpose', 'Which card schemes?', 'Say who signs this off'])
    assert.deepEqual(problem.changes.map((c) => c.text), ['must', 'should'])
    assert.equal(problem.threads[2].placement.alsoFields[0].fieldId, 'opportunity', 'a spanning comment is answered once, on its first Field')
    assert.equal(problem.threads[0].placement.method, 'heading')
    const document = placed.groups.at(-1)
    assert.deepEqual(document.threads.map((t) => t.placement.aboutTitle), ['the cover page', 'Document Control', 'the table of contents'])
  })

  test('summarises itself in a line', () => {
    assert.equal(summariseReview(read), '8 comment threads and 3 tracked changes from Ana Reviewer, Ben Commenter')
  })
})

describe('reading a Google-Docs-exported Reviewed copy', async () => {
  const read = await readReviewedCopy(reviewedCopy({ kind: 'google' }))

  test('keeps the properties and comments but has lost the bookmarks, the links and the resolved thread', () => {
    assert.deepEqual(read.properties, RENDER_PROPERTIES)
    assert.equal(read.fieldBookmarks, 0)
    assert.equal(read.threads.length, 7)
    assert.equal(byText(read.threads, 'Which card schemes?'), undefined)
    assert.ok(read.threads.every((t) => t.fields.length === 0 && !t.resolved && t.replies.length === 0))
  })

  test('places comments by matching text against the render rebuilt from its commit, and says so', () => {
    const placed = placeReview(read, { fieldIndex, basis: BASIS })
    assert.equal(placed.mode, 'text')
    assert.match(placed.notice, /bookmarks were lost/i)
    assert.match(placed.notice, /matching their text against the content as it was at commit abc1234/)
    const field = (id) => placed.groups.find((g) => g.kind === 'field' && g.field.fieldId === id)
    assert.deepEqual(field('problem').threads.map((t) => t.text), ['Say who signs this off'])
    assert.deepEqual(field('opportunity').threads.map((t) => t.text), ['Point comment with no range'])
    assert.deepEqual(field('success-criteria').threads.map((t) => t.text), ['Add the team'])
    assert.ok([...field('problem').threads, ...field('opportunity').threads, ...field('success-criteria').threads].every((t) => t.placement.method === 'text'))
    assert.deepEqual(field('problem').changes.map((c) => c.text), ['must', 'should'], 'a deletion matches on the text as rendered, an insertion on its paragraph')
    assert.deepEqual(field('opportunity').changes.map((c) => c.text), ['Improve settlement speed.'], 'an insertion matches on its paragraph')
    // Cover, Document Control and the contents are still about the document; the heading text is not any Field's wording.
    const document = placed.groups.find((g) => g.kind === 'document')
    assert.equal(document.threads.length, 3)
    const unplaced = placed.groups.find((g) => g.kind === 'unplaced')
    assert.deepEqual(unplaced.threads.map((t) => t.text), ['Rename to Purpose'])
  })

  test('against today\'s content (a server workspace has no commit) it says that instead', () => {
    const placed = placeReview(read, { fieldIndex, basis: { basis: 'today', fields: FIELDS } })
    assert.match(placed.notice, /matching their text against today's content/)
  })

  test('with no content to match against, nothing is guessed', () => {
    const placed = placeReview(read, { fieldIndex })
    assert.equal(placed.groups.filter((g) => g.kind === 'field').length, 0)
    assert.match(placed.notice, /couldn't be placed/)
  })

  test('a match on text more than one Field holds is marked as a best guess', () => {
    const fields = [
      { moduleId: 'm', moduleTitle: 'M', fieldId: 'one', fieldTitle: 'One', text: 'The platform must support card schemes.' },
      { moduleId: 'm', moduleTitle: 'M', fieldId: 'two', fieldTitle: 'Two', text: 'Card schemes are listed elsewhere.' },
    ]
    const placed = placeReview(read, { fieldIndex: buildFieldIndex(fields), basis: { basis: 'today', fields } })
    const one = placed.groups.find((g) => g.kind === 'field' && g.field.fieldId === 'one')
    const guess = one.threads.find((t) => t.text === 'Say who signs this off')
    assert.equal(guess.placement.confidence, 'low')
    assert.equal(guess.placement.alsoFields[0].fieldId, 'two')
  })
})

describe('refusing a document that is not one of this Instance\'s renders', () => {
  test('one without the gantry-* properties is refused and the architect is told to upload it as a Source document', async () => {
    const read = await readReviewedCopy(reviewedCopy({ properties: {} }))
    const verdict = checkReviewedCopy(read.properties, EXPECTED)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'untagged')
    assert.match(verdict.message, /Upload it as a Source document instead/)
  })

  test('one with only some of them (no render id) is refused the same way', () => {
    assert.equal(checkReviewedCopy({ instance: 'acme' }, EXPECTED).code, 'untagged')
    assert.equal(checkReviewedCopy({ 'render-id': 'x' }, EXPECTED).code, 'untagged')
  })

  test('one from another Instance is refused, naming where it came from', async () => {
    const read = await readReviewedCopy(reviewedCopy({ properties: { ...RENDER_PROPERTIES, instance: 'globex', stage: 'build' } }))
    const verdict = checkReviewedCopy(read.properties, EXPECTED)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'other-instance')
    assert.match(verdict.message, /Instance "globex", Artefact "hld", Stage "build"/)
    assert.match(verdict.message, /not from "acme"/)
  })

  test('one from an Instance of the same name built on another Definition is refused too', () => {
    const verdict = checkReviewedCopy({ ...RENDER_PROPERTIES, definition: 'recruitment@1' }, EXPECTED)
    assert.equal(verdict.code, 'other-instance')
    assert.match(verdict.message, /Definition "recruitment"/)
  })

  test('one from an Artefact this Instance does not have is refused', () => {
    const verdict = checkReviewedCopy({ ...RENDER_PROPERTIES, artefact: 'offer-pack' }, EXPECTED)
    assert.equal(verdict.code, 'other-artefact')
    assert.match(verdict.message, /no Artefact "offer-pack"/)
  })

  test('its own render, of any Definition version, is accepted', () => {
    assert.deepEqual(checkReviewedCopy(RENDER_PROPERTIES, EXPECTED), { ok: true })
    assert.deepEqual(checkReviewedCopy({ ...RENDER_PROPERTIES, definition: 'design@2' }, EXPECTED), { ok: true })
  })

  test('a file that is not a Word document is refused with a plain message', async () => {
    await assert.rejects(readReviewedCopy(Buffer.from('just some text')), (err) => err instanceof ReviewedCopyError && /not a Word/.test(err.message))
    await assert.rejects(readReviewedCopy(zip({ 'readme.txt': 'hi' })), ReviewedCopyError)
    await assert.rejects(readReviewedCopy(zip({ 'word/document.xml': '<w:document><w:body></w:document>' })), ReviewedCopyError)
  })
})

describe('placing by text', () => {
  test('plainText strips Markdown marks so a Field\'s wording can be compared with what Word shows', () => {
    assert.equal(plainText('**Bold** and [a link](http://x.test) with `code`.').replace(/\s+/g, ' ').trim(), 'Bold and a link with code .')
    assert.equal(plainText('- one\n- two\n\n1. three').replace(/\s+/g, ' ').trim(), 'one two three')
    assert.equal(plainText('| a | b |\n|---|---|').includes('a'), true)
  })

  test('the upload cap is 25 MB', () => {
    assert.equal(REVIEWED_COPY_MAX_BYTES, 25 * 1024 * 1024)
  })
})
