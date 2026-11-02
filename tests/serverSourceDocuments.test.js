import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { MAX_SOURCE_BYTES, MAX_SOURCE_UPLOAD_BODY_BYTES } from '../web/lib/sourceDocuments.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #279: the /api/instance/sources routes on a server workspace (disk). The unit tests for the lifecycle itself are in tests/sourceDocuments.test.js; these cover the HTTP surface, the 25 MB limit enforced on the server, and the capped upload body.

async function withInstance(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, (base) => fn(base, instancesDir))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const post = (base, body, path = '/api/instance/sources') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const send = (base, method, path, body) =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const b64 = (text) => Buffer.from(text).toString('base64')

test('a freshly created Instance has no Source documents, and the limits are listed', async () => {
  await withInstance(async (base) => {
    const res = await fetch(`${base}/api/instance/sources`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.entries, [])
    assert.equal(body.totalBytes, 0)
    assert.equal(body.warning, null)
    assert.equal(body.limits.maxBytes, 25 * 1024 * 1024)
  })
})

test('upload, list, download, rename, new text and remove on a server workspace', async () => {
  await withInstance(async (base, instancesDir) => {
    const created = await post(base, { filename: 'Client brief.docx', dataBase64: b64('word bytes'), text: '# Client brief\n', uploadedBy: 'a.architect' })
    assert.equal(created.status, 201)
    const { entry } = await created.json()
    assert.equal(entry.id, 'client-brief')
    assert.equal(entry.title, 'Client brief')
    assert.equal(entry.uploadedBy, 'a.architect')
    assert.equal(entry.size, 10)
    assert.match(entry.uploadedAt, /^\d{4}-\d\d-\d\dT/)
    const dir = join(instancesDir, 'default', 'my-initiative', 'sources')
    assert.equal(readFileSync(join(dir, 'Client brief.docx'), 'utf8'), 'word bytes')
    assert.equal(readFileSync(join(dir, '.text', 'Client brief.docx.md'), 'utf8'), '# Client brief\n')
    assert.ok(existsSync(join(dir, 'manifest.yaml')))

    const listed = await (await fetch(`${base}/api/instance/sources`)).json()
    assert.deepEqual(listed.entries, [entry])
    assert.equal(listed.totalBytes, 10)

    const file = await fetch(`${base}/api/instance/sources/client-brief/file`)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.match(file.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Client%20brief\.docx$/)
    assert.equal(await file.text(), 'word bytes')

    const text = await fetch(`${base}/api/instance/sources/client-brief/text`)
    assert.equal(text.status, 200)
    assert.equal(await text.text(), '# Client brief\n')

    const renamed = await send(base, 'PATCH', '/api/instance/sources/client-brief', { title: 'Client brief (signed)' })
    assert.equal(renamed.status, 200)
    assert.equal((await renamed.json()).entry.title, 'Client brief (signed)')
    assert.equal(readFileSync(join(dir, 'Client brief.docx'), 'utf8'), 'word bytes', 'renaming never touches the stored file')

    const replaced = await send(base, 'PUT', '/api/instance/sources/client-brief/text', { text: '# Re-read\n' })
    assert.equal(replaced.status, 200)
    assert.equal(await (await fetch(`${base}/api/instance/sources/client-brief/text`)).text(), '# Re-read\n')
    const cleared = await send(base, 'PUT', '/api/instance/sources/client-brief/text', { text: null })
    assert.equal('text' in (await cleared.json()).entry, false)
    assert.equal((await fetch(`${base}/api/instance/sources/client-brief/text`)).status, 404)

    const removed = await send(base, 'DELETE', '/api/instance/sources/client-brief', { removedBy: 'b.reviewer' })
    assert.equal(removed.status, 200)
    const gone = (await removed.json()).entry
    assert.equal(gone.removedBy, 'b.reviewer')
    assert.match(gone.removedAt, /^\d{4}-\d\d-\d\dT/)
    assert.equal(existsSync(join(dir, 'Client brief.docx')), false)
    const after = await (await fetch(`${base}/api/instance/sources`)).json()
    assert.equal(after.entries.length, 1, 'the entry stays, marked removed')
    assert.equal(after.entries[0].title, 'Client brief (signed)')
    assert.equal(after.totalBytes, 0)
    assert.equal((await fetch(`${base}/api/instance/sources/client-brief/file`)).status, 409)
    assert.equal((await send(base, 'PATCH', '/api/instance/sources/client-brief', { title: 'x' })).status, 409)
  })
})

test('an upload named like an existing document is a new document with its own id', async () => {
  await withInstance(async (base) => {
    await post(base, { filename: 'brief.pdf', dataBase64: b64('one') })
    const second = await (await post(base, { filename: 'brief.pdf', dataBase64: b64('two') })).json()
    assert.equal(second.entry.id, 'brief-2')
    assert.equal(second.entry.filename, 'brief-2.pdf')
    assert.equal(await (await fetch(`${base}/api/instance/sources/brief/file`)).text(), 'one')
    assert.equal(await (await fetch(`${base}/api/instance/sources/brief-2/file`)).text(), 'two')
  })
})

test('a 26 MB document is refused by the server with 413 and nothing is written', async () => {
  await withInstance(async (base, instancesDir) => {
    const big = Buffer.alloc(26 * 1024 * 1024, 1).toString('base64')
    assert.ok(big.length < MAX_SOURCE_UPLOAD_BODY_BYTES, 'it gets past the body cap so the document limit itself is what refuses it')
    const res = await post(base, { filename: 'big.pdf', dataBase64: big })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.equal(body.code, 'too-large')
    assert.match(body.error, /over the 25 MB limit/)
    assert.equal(existsSync(join(instancesDir, 'default', 'my-initiative', 'sources')), false)
    const ok = await post(base, { filename: 'edge.pdf', dataBase64: Buffer.alloc(MAX_SOURCE_BYTES, 1).toString('base64') })
    assert.equal(ok.status, 201, 'exactly 25 MB is allowed')
  })
})

test('the upload route caps its body instead of reading it uncapped', async () => {
  await withInstance(async (base) => {
    const huge = JSON.stringify({ filename: 'huge.pdf', dataBase64: 'A'.repeat(MAX_SOURCE_UPLOAD_BODY_BYTES + 1024) })
    const res = await post(base, huge)
    assert.equal(res.status, 413)
    assert.match((await res.json()).error, /request limit/)
  })
})

test('bad requests are refused with a clear message', async () => {
  await withInstance(async (base) => {
    assert.equal((await post(base, '{not json')).status, 400)
    assert.equal((await post(base, { dataBase64: b64('x') })).status, 400)
    assert.equal((await post(base, { filename: 'x.txt' })).status, 400)
    const empty = await post(base, { filename: 'x.txt', dataBase64: '' })
    assert.equal(empty.status, 400)
    assert.match((await empty.json()).error, /empty/)
    assert.equal((await fetch(`${base}/api/instance/sources/nope/file`)).status, 404)
    assert.equal((await send(base, 'PATCH', '/api/instance/sources/nope', { title: 'x' })).status, 404)
    assert.equal((await send(base, 'DELETE', '/api/instance/sources/nope', {})).status, 404)
    assert.equal((await send(base, 'PUT', '/api/instance/sources')).status, 405)
    assert.equal((await send(base, 'POST', '/api/instance/sources/nope/file')).status, 405)
    await post(base, { filename: 'a.txt', dataBase64: b64('x') })
    assert.equal((await send(base, 'PATCH', '/api/instance/sources/a', { title: '  ' })).status, 400)
    assert.equal((await send(base, 'PUT', '/api/instance/sources/a/text', { text: 5 })).status, 400)
  })
})

test('Source documents stay out of the Asset library', async () => {
  await withInstance(async (base) => {
    await post(base, { filename: 'brief.pdf', dataBase64: b64('x') })
    assert.deepEqual(await (await fetch(`${base}/api/instance/assets`)).json(), [])
  })
})

test('an unknown Instance has no Source documents to list', async () => {
  await withInstance(async (base) => {
    const res = await fetch(`${base}/api/instance/sources?slug=no-such-instance`)
    assert.equal(res.status, 404)
    assert.match((await res.json()).error, /no-such-instance/)
  })
})
