import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as officeparser from 'officeparser'
import { createInstance } from '../lib/instance.js'
import { extractSourceText } from '../web/lib/sourceExtract.js'
import { SOURCE_READ_PAGE_CHARS, paginateSourceText } from '../web/lib/sourceDocuments.js'
import { extractSourceTextOnServer } from '../lib/sourceExtractNode.js'
import { RENDER_PROPERTIES, reviewedCopy } from './helpers/reviewedCopyFixture.js'
import { pngImage, scannedPdf, textPdf, wordDocument } from './helpers/sourceFixtures.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'

// #305 (docs/adr/0067): what gantry serve gives the MCP server beyond the browser's routes. An upload with `extractText` is read on the
// server with the browser's own reader; a document's text is read back by page and a picture as a picture; a Reviewed copy's threads are
// listed by Field; and the Fields that are Out of date are reported. The MCP tools themselves are tested in mcp-server/test.

const SLUG = 'my-initiative'
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const send = (base, method, path, body) =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const upload = (base, body) => send(base, 'POST', '/api/instance/sources', body)

async function withInstance(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', SLUG, { instancesDir })
    await withRunningServer({ slug: SLUG, instancesDir }, (base) => fn(base, instancesDir, join(instancesDir, 'default', SLUG)))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// What the browser does before it uploads: reads the text itself (with officeparser's Node build standing in for the browser one).
const browserExtract = (filename, bytes) =>
  extractSourceText(filename, bytes, {
    loadParser: async () => ({ parseOffice: (data, { pdfWorkerSrc: _w, pdfCMapUrl: _c, pdfDecoderUrl: _d, ...config }) => officeparser.parseOffice(data, config) }),
  })

describe('an upload that asks the server to read the document (extractText)', () => {
  test('gives the same manifest entry and extracted text as a browser upload of the same file', async () => {
    const bytes = wordDocument()
    let browser
    let mcp
    await withInstance(async (base, _dir, folder) => {
      const { text } = await browserExtract('Client brief.docx', bytes)
      const res = await upload(base, { filename: 'Client brief.docx', dataBase64: b64(bytes), text, uploadedBy: 'a.architect' })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.equal('extraction' in body, false, 'a browser upload is answered as before')
      browser = { entry: body.entry, text: readFileSync(join(folder, 'sources', '.text', 'Client brief.docx.md'), 'utf8') }
    })
    await withInstance(async (base, _dir, folder) => {
      const res = await upload(base, { filename: 'Client brief.docx', dataBase64: b64(bytes), extractText: true, uploadedBy: 'a.architect' })
      assert.equal(res.status, 201, await res.clone().text())
      const body = await res.json()
      assert.deepEqual(body.extraction, { read: true, note: 'The text was read from it.' })
      mcp = { entry: body.entry, text: readFileSync(join(folder, 'sources', '.text', 'Client brief.docx.md'), 'utf8') }
    })
    assert.match(mcp.text, /The platform must support \*\*5000\*\* users\./)
    assert.equal(mcp.text, browser.text)
    assert.deepEqual({ ...mcp.entry, uploadedAt: undefined }, { ...browser.entry, uploadedAt: undefined })
  })

  test('reads a text-layer PDF page by page, and says why a scanned one and a picture have no text', async () => {
    await withInstance(async (base, _dir, folder) => {
      const pdf = await (await upload(base, { filename: 'plan.pdf', dataBase64: b64(textPdf([['The first page says the budget is NZD 1.2 million'], ['The second page says we launch in March next year']])), extractText: true })).json()
      assert.equal(pdf.extraction.read, true)
      assert.match(readFileSync(join(folder, 'sources', '.text', 'plan.pdf.md'), 'utf8'), /## Page 2\n\nThe second page says we launch in March next year/)

      const scanned = await (await upload(base, { filename: 'scan.pdf', dataBase64: b64(scannedPdf(2)), extractText: true })).json()
      assert.equal(scanned.extraction.read, false)
      assert.match(scanned.extraction.note, /looks scanned/)
      assert.equal('text' in scanned.entry, false)

      const picture = await (await upload(base, { filename: 'diagram.png', dataBase64: b64(pngImage()), extractText: true })).json()
      assert.equal(picture.extraction.read, false)
      assert.match(picture.extraction.note, /A picture has no text/)
    })
  })

  test('refuses a type Gantry does not take and a document over 25 MB, as the browser does, and keeps nothing', async () => {
    await withInstance(async (base, _dir, folder) => {
      const odd = await upload(base, { filename: 'page.html', dataBase64: b64('<p>hi</p>'), extractText: true })
      assert.equal(odd.status, 400)
      assert.equal((await odd.json()).code, 'unsupported-type')
      const old = await upload(base, { filename: 'old.doc', dataBase64: b64('x'), extractText: true })
      assert.match((await old.json()).error, /Save it as \.docx and upload that/)
      const big = await upload(base, { filename: 'big.pdf', dataBase64: Buffer.alloc(26 * 1024 * 1024, 1).toString('base64'), extractText: true })
      assert.equal(big.status, 413)
      assert.match((await big.json()).error, /over the 25 MB limit/)
      const empty = await upload(base, { filename: 'empty.txt', dataBase64: '', extractText: true })
      assert.equal(empty.status, 400)
      assert.equal(existsSync(join(folder, 'sources')), false)
    })
  })

  test('a document that cannot be read is still kept, with the reason', async () => {
    await withInstance(async (base) => {
      const res = await upload(base, { filename: 'broken.docx', dataBase64: b64('not really a word document'), extractText: true })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.equal(body.extraction.read, false)
      assert.match(body.extraction.note, /Gantry could not read its text/)
      assert.equal('text' in body.entry, false)
    })
  })

  test('text sent with the upload wins, and the replaces link is kept', async () => {
    await withInstance(async (base) => {
      await upload(base, { filename: 'brief.txt', dataBase64: b64('first'), extractText: true })
      const second = await (await upload(base, { filename: 'brief-v2.txt', dataBase64: b64('second'), text: 'given text', extractText: true, replaces: 'brief' })).json()
      assert.equal(second.entry.replaces, 'brief')
      assert.equal('extraction' in second, false)
      assert.equal(await (await fetch(`${base}/api/instance/sources/brief-v2/text`)).text(), 'given text')
      assert.equal(await (await fetch(`${base}/api/instance/sources/brief/text`)).text(), 'first')
    })
  })
})

describe('GET /api/instance/sources/:id/content', () => {
  test('gives a PDF back one page at a time, numbered as the PDF is', async () => {
    await withInstance(async (base) => {
      await upload(base, { filename: 'plan.pdf', dataBase64: b64(textPdf([['The budget is NZD 1.2m for the whole programme'], ['Launch is planned for March next year'], ['Risks: vendor lock-in and a tight timeline']])), extractText: true })
      const first = await (await fetch(`${base}/api/instance/sources/plan/content`)).json()
      assert.equal(first.kind, 'pdf')
      assert.equal(first.by, 'pdf-page')
      assert.equal(first.page, 1)
      assert.equal(first.pageCount, 3)
      assert.match(first.text, /budget is NZD 1\.2m/)
      assert.equal(first.entry.title, 'plan')
      const third = await (await fetch(`${base}/api/instance/sources/plan/content?page=3`)).json()
      assert.match(third.text, /Risks: vendor lock-in/)
      assert.doesNotMatch(third.text, /## Page/)
      const past = await fetch(`${base}/api/instance/sources/plan/content?page=4`)
      assert.equal(past.status, 400)
      assert.match((await past.json()).error, /has 3 pages; page must be a whole number from 1 to 3/)
      assert.equal((await fetch(`${base}/api/instance/sources/plan/content?page=abc`)).status, 400)
    })
  })

  test('cuts a long document into sections, with nothing lost between them', async () => {
    await withInstance(async (base) => {
      const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${'word '.repeat(150)}`.trim())
      const text = paragraphs.join('\n\n')
      await upload(base, { filename: 'long.md', dataBase64: b64(text), extractText: true })
      const first = await (await fetch(`${base}/api/instance/sources/long/content`)).json()
      assert.equal(first.by, 'section')
      assert.ok(first.pageCount > 1)
      const pieces = []
      for (let page = 1; page <= first.pageCount; page++) {
        const piece = (await (await fetch(`${base}/api/instance/sources/long/content?page=${page}`)).json()).text
        assert.ok(piece.length <= SOURCE_READ_PAGE_CHARS)
        pieces.push(piece)
      }
      assert.equal(pieces.join('\n\n'), text)
    })
  })

  test('gives a picture back as a picture, and says why a document with no text has none', async () => {
    await withInstance(async (base) => {
      await upload(base, { filename: 'diagram.png', dataBase64: b64(pngImage()), extractText: true })
      await upload(base, { filename: 'scan.pdf', dataBase64: b64(scannedPdf(1)), extractText: true })
      const picture = await (await fetch(`${base}/api/instance/sources/diagram/content`)).json()
      assert.equal(picture.kind, 'image')
      assert.equal(picture.image.mimeType, 'image/png')
      assert.deepEqual(Buffer.from(picture.image.dataBase64, 'base64'), Buffer.from(pngImage()))
      const scan = await (await fetch(`${base}/api/instance/sources/scan/content`)).json()
      assert.equal(scan.text, null)
      assert.match(scan.note, /looks scanned/)
    })
  })

  test('is a 404 for a document that is not there and a 409 for one that was removed', async () => {
    await withInstance(async (base) => {
      await upload(base, { filename: 'brief.txt', dataBase64: b64('hello'), extractText: true })
      assert.equal((await fetch(`${base}/api/instance/sources/nope/content`)).status, 404)
      await send(base, 'DELETE', '/api/instance/sources/brief', {})
      assert.equal((await fetch(`${base}/api/instance/sources/brief/content`)).status, 409)
      assert.equal((await send(base, 'POST', '/api/instance/sources/brief/content', {})).status, 405)
    })
  })
})

describe('paginateSourceText', () => {
  test('a PDF without page headings (its text was replaced by hand) is cut into sections', () => {
    const { by, pages } = paginateSourceText('Just some notes.\n\nMore notes.', 'plan.pdf')
    assert.equal(by, 'section')
    assert.deepEqual(pages, ['Just some notes.\n\nMore notes.'])
  })

  test('a paragraph longer than a page is split, and empty text is one empty page', () => {
    const long = 'x'.repeat(SOURCE_READ_PAGE_CHARS * 2 + 5)
    assert.deepEqual(paginateSourceText(long, 'a.txt').pages.map((p) => p.length), [SOURCE_READ_PAGE_CHARS, SOURCE_READ_PAGE_CHARS, 5])
    assert.deepEqual(paginateSourceText('', 'a.txt').pages, [''])
  })

  test('a PDF page with no text keeps its number', () => {
    const { pages } = paginateSourceText('## Page 1\n\none\n\n## Page 3\n\nthree', 'a.pdf')
    assert.deepEqual(pages, ['one', '', 'three'])
  })
})

describe('extractSourceTextOnServer', () => {
  test('never throws, and says what is wrong with a file it cannot read', async () => {
    const result = await extractSourceTextOnServer('broken.pptx', new Uint8Array([1, 2, 3]))
    assert.equal(result.text, null)
    assert.match(result.problem, /could not read/)
  })
})

describe('GET /api/instance/reviews/:id (a Reviewed copy read by Field)', () => {
  const props = { ...RENDER_PROPERTIES, instance: SLUG }
  const withServer = (fn) =>
    withScratchInstances((instancesDir) =>
      withRunningServer({ instancesDir }, async (base) => {
        const created = await fetch(`${base}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: 'design', slug: SLUG }) })
        assert.equal(created.status, 201, await created.clone().text())
        return fn(base)
      })
    )
  const bring = async (base, bytes, name = 'HLD - Ana and Ben.docx') => {
    const res = await send(base, 'POST', `/api/instance/reviews?slug=${SLUG}`, { files: [{ filename: name, dataBase64: b64(bytes) }] })
    assert.equal(res.status, 201, await res.clone().text())
    return (await res.json()).reviews[0]
  }

  test('lists the threads and tracked changes on the Field each traces to', () =>
    withServer(async (base) => {
      const entry = await bring(base, reviewedCopy({ properties: props }))
      const res = await fetch(`${base}/api/instance/reviews/${entry.id}?slug=${SLUG}`)
      assert.equal(res.status, 200, await res.clone().text())
      const body = await res.json()
      assert.equal(body.entry.id, entry.id)
      assert.match(body.summary, /comment threads/)
      assert.deepEqual(body.commenters, ['Ana Reviewer', 'Ben Commenter'])
      assert.equal(body.mode, 'bookmarks')
      const problem = body.groups.find((g) => g.kind === 'field' && g.field.key === 'background.problem')
      assert.ok(problem, JSON.stringify(body.groups.map((g) => g.kind)))
      assert.equal(problem.field.fieldTitle, 'Problem statement')
      const which = problem.threads.find((t) => t.text === 'Which card schemes?')
      assert.equal(which.author, 'Ana Reviewer')
      assert.equal(which.resolved, true)
      assert.deepEqual(which.replies.map((r) => r.text), ['Visa and Mastercard.'])
      assert.equal(which.anchor, 'new payments platform')
      assert.equal('paragraph' in which, false)
      assert.deepEqual(problem.changes.map((c) => [c.kind, c.text]), [['deletion', 'must'], ['insertion', 'should']])
      const about = body.groups.find((g) => g.kind === 'document')
      assert.ok(about.threads.some((t) => t.text === 'Put the date on the cover'))
    }))

  test('places a copy that lost its Field bookmarks by matching text, and says so', () =>
    withServer(async (base) => {
      const saved = await send(base, 'PUT', `/api/instance/modules?slug=${SLUG}`, { modules: { background: { fields: { problem: 'We need a new payments platform.\n\nIt must support card schemes.', opportunity: 'Reduce cost per transaction.' } } } })
      assert.equal(saved.status, 200, await saved.clone().text())
      const entry = await bring(base, reviewedCopy({ kind: 'google', properties: props }), 'Google export.docx')
      const body = await (await fetch(`${base}/api/instance/reviews/${entry.id}?slug=${SLUG}`)).json()
      assert.match(body.notice, /Field bookmarks were lost/)
      assert.notEqual(body.mode, 'bookmarks')
      const problem = body.groups.find((g) => g.kind === 'field' && g.field.key === 'background.problem')
      assert.ok(problem.threads.length > 0 && problem.threads.every((t) => t.placement.method === 'text'), JSON.stringify(body.groups.map((g) => [g.kind, g.field?.key, g.threads.map((t) => t.text)])))
    }))

  test('is a 404 for a copy that is not there', () =>
    withServer(async (base) => {
      const res = await fetch(`${base}/api/instance/reviews/00000000-0000-4000-8000-000000000000?slug=${SLUG}`)
      assert.equal(res.status, 404)
    }))

  test('an untagged document is refused with the same message over the same route the MCP tool uses', () =>
    withServer(async (base) => {
      const res = await send(base, 'POST', `/api/instance/reviews?slug=${SLUG}`, { files: [{ filename: 'plain.docx', dataBase64: b64(reviewedCopy({ properties: {} })) }] })
      assert.equal(res.status, 422)
      assert.match((await res.json()).error, /wasn't rendered by Gantry/)
    }))
})

describe('GET /api/instance/out-of-date', () => {
  async function withDraftedInstance(fn) {
    return withInstance(async (base, instancesDir, folder) => {
      const instance = await (await fetch(`${base}/api/instance`)).json()
      const moduleId = instance.modules[0].id
      const fieldId = instance.modules[0].fields.find((f) => f.type === 'markdown' || f.type === 'text')?.id ?? instance.modules[0].fields[0].id
      return fn({ base, folder, moduleId, fieldId, key: `${moduleId}.${fieldId}`, stageVersion: instance.stageVersion })
    })
  }
  const save = (base, moduleId, fieldId, value) => send(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [fieldId]: value } } } })

  test('flags a Field that cites a Source document that was then replaced, and clears when nothing changed', () =>
    withDraftedInstance(async ({ base, moduleId, fieldId, key }) => {
      await upload(base, { filename: 'Client brief.txt', dataBase64: b64('Five thousand users.'), extractText: true })
      assert.equal((await save(base, moduleId, fieldId, 'We expect 5000 users ([Client brief, p. 1](source:client-brief)).')).status, 200)
      const calm = await (await fetch(`${base}/api/instance/out-of-date`)).json()
      assert.deepEqual(calm.fields, [])
      assert.equal(calm.supported, true)

      const replacement = await upload(base, { filename: 'Client brief v2.txt', dataBase64: b64('Eight thousand users.'), extractText: true, replaces: 'client-brief' })
      assert.equal(replacement.status, 201)
      const body = await (await fetch(`${base}/api/instance/out-of-date`)).json()
      assert.equal(body.fields.length, 1)
      assert.equal(body.fields[0].field, key)
      assert.match(body.fields[0].title, / · /)
      assert.match(body.fields[0].note, /^Out of date: Client brief was replaced by Client brief v2$/)
      assert.equal(body.fields[0].flags[0].change, 'replaced')
      assert.equal(body.fields[0].flags[0].source, 'client-brief')
      assert.deepEqual(body.fields[0].flags[0].replacedBy, { id: 'client-brief-v2', title: 'Client brief v2' })
      assert.deepEqual(body.summary, ['1 Field drew on Client brief, now replaced by Client brief v2'])
    }))

  test('flags a Field that drew on a document, per the decisions log, when the document is removed', () =>
    withDraftedInstance(async ({ base, moduleId, fieldId, key }) => {
      await upload(base, { filename: 'notes.txt', dataBase64: b64('Some facts.'), extractText: true })
      const stage = (await (await fetch(`${base}/api/instance`)).json()).stage.id
      const logged = await send(base, 'PUT', `/api/instance/decisions?stage=${stage}`, {
        decisions: { fields: { [key]: { drafted: '2026-11-01T09:00:00.000Z', inputs: [{ source: 'notes' }] } } },
      })
      assert.equal(logged.status, 200, await logged.clone().text())
      await save(base, moduleId, fieldId, 'Drafted from the notes.')
      assert.deepEqual((await (await fetch(`${base}/api/instance/out-of-date`)).json()).fields, [])
      await send(base, 'DELETE', '/api/instance/sources/notes', { removedBy: 'a.architect' })
      const body = await (await fetch(`${base}/api/instance/out-of-date`)).json()
      assert.deepEqual(body.fields.map((f) => [f.field, f.flags[0].change]), [[key, 'removed']])
    }))

  test('an Instance with no Source documents has nothing Out of date', () =>
    withInstance(async (base) => {
      assert.deepEqual(await (await fetch(`${base}/api/instance/out-of-date`)).json(), { supported: true, fields: [], summary: [], newSinceLastInterview: [] })
    }))

  test('is a 404 for an Instance the server does not know', () =>
    withInstance(async (base) => {
      assert.equal((await fetch(`${base}/api/instance/out-of-date?slug=ghost`)).status, 404)
    }))
})
