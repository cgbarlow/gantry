import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import {
  INSTANCE_SOURCES_WARN_BYTES,
  MAX_SOURCE_BYTES,
  SOURCE_FILE_ACCEPT,
  SourceDocumentError,
  cleanSourceFilename,
  createSourceStore,
  defaultSourceTitle,
  formatBytes,
  instanceSourcesWarning,
  isFetchedSource,
  normalizeSourceOrigin,
  parseSourceManifest,
  replacedBy,
  sourceFileKind,
  sourceFileTypeProblem,
  sourceIdFor,
  sourceSizeProblem,
  uniqueSourceFilename,
} from '../web/lib/sourceDocuments.js'
import { createInstanceSourceStore, sourceDownloadHeaders } from '../lib/sourceDocuments.js'
import { createInstance } from '../lib/instance.js'
import { createLocalFilesystemStorage } from '../lib/storage.js'
import { createInMemoryStorage } from './helpers/inMemoryStorage.js'

// #279 (docs/adr/0070): Source documents are kept in a flat `sources/` folder with a manifest. The lifecycle is one module, run here over an in-memory store (no disk at all), over the disk, and with two uploads racing.

const bytes = (text) => new TextEncoder().encode(text)
const fixedNow = (...times) => {
  let i = 0
  return () => times[Math.min(i++, times.length - 1)]
}

describe('names and ids', () => {
  test('a filename is cleaned to be safe as a path and keeps what it can of the original', () => {
    assert.equal(cleanSourceFilename('Client brief v3.docx'), 'Client brief v3.docx')
    assert.equal(cleanSourceFilename('../../etc/passwd'), 'passwd')
    assert.equal(cleanSourceFilename('C:\\Users\\me\\Plan: "final"?.pdf'), 'Plan final.pdf')
    assert.equal(cleanSourceFilename('  spaced   out  .md '), 'spaced out .md')
    assert.equal(cleanSourceFilename('.hidden'), 'hidden')
    assert.equal(cleanSourceFilename('.text'), 'text')
    assert.equal(cleanSourceFilename(''), 'document')
    assert.equal(cleanSourceFilename('...'), 'document')
    assert.equal(cleanSourceFilename('manifest.yaml'), 'manifest-document.yaml')
    assert.equal(cleanSourceFilename('CON.txt'), '_CON.txt')
    assert.equal(cleanSourceFilename('trailing dots...'), 'trailing dots')
    assert.equal(cleanSourceFilename('Ünïcode brief.docx'), 'Ünïcode brief.docx')
    const long = cleanSourceFilename(`${'a'.repeat(300)}.docx`)
    assert.equal(long.length, 150)
    assert.ok(long.endsWith('.docx'))
  })

  test('a taken name gets -2, -3 before its extension, whatever the case', () => {
    assert.equal(uniqueSourceFilename('brief.docx', []), 'brief.docx')
    assert.equal(uniqueSourceFilename('brief.docx', ['brief.docx']), 'brief-2.docx')
    assert.equal(uniqueSourceFilename('brief.docx', ['Brief.DOCX', 'brief-2.docx']), 'brief-3.docx')
    assert.equal(uniqueSourceFilename('notes', ['notes']), 'notes-2')
  })

  test('an id is made from the filename, lower-case and dashed, with -2 when taken', () => {
    assert.equal(sourceIdFor('Client brief v3.docx', []), 'client-brief-v3')
    assert.equal(sourceIdFor('Client brief v3.pdf', ['client-brief-v3']), 'client-brief-v3-2')
    assert.equal(sourceIdFor('Café menu.docx', []), 'cafe-menu')
    assert.equal(sourceIdFor('日本語.docx', []), 'document')
    assert.equal(defaultSourceTitle('Client brief v3.docx'), 'Client brief v3')
    assert.equal(defaultSourceTitle('C:\\x\\Plan.pdf'), 'Plan')
  })

  test('the file types Gantry takes, and a helpful sentence for the ones it does not', () => {
    assert.equal(sourceFileKind('a.DOCX'), 'word')
    assert.equal(sourceFileKind('a.pptx'), 'powerpoint')
    assert.equal(sourceFileKind('a.xlsx'), 'spreadsheet')
    assert.equal(sourceFileKind('a.pdf'), 'pdf')
    assert.equal(sourceFileKind('a.md'), 'text')
    assert.equal(sourceFileKind('a.jpeg'), 'image')
    assert.equal(sourceFileKind('a.vsdx'), null)
    assert.equal(sourceFileTypeProblem('a.docx'), null)
    assert.match(sourceFileTypeProblem('old.doc'), /Save it as \.docx/)
    assert.match(sourceFileTypeProblem('thing.zip'), /can't take \.zip files/)
  })

  test('the size limits read as sentences', () => {
    assert.equal(sourceSizeProblem(1024, 'a.docx'), null)
    assert.equal(sourceSizeProblem(MAX_SOURCE_BYTES, 'a.docx'), null)
    assert.match(sourceSizeProblem(MAX_SOURCE_BYTES + 1, 'big.pdf'), /"big\.pdf" is 25(\.0)? MB.*over the 25 MB limit/)
    assert.match(sourceSizeProblem(26 * 1024 * 1024, 'big.pdf'), /26 MB, over the 25 MB limit/)
    assert.match(sourceSizeProblem(0, 'e.txt'), /is empty/)
    assert.equal(instanceSourcesWarning(INSTANCE_SOURCES_WARN_BYTES), null)
    assert.match(instanceSourcesWarning(INSTANCE_SOURCES_WARN_BYTES + 1), /past about 100 MB/)
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(1536), '1.5 KB')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  })
})

describe('the manifest', () => {
  test('a missing, empty or garbled manifest is an empty list', () => {
    assert.deepEqual(parseSourceManifest(undefined), [])
    assert.deepEqual(parseSourceManifest(''), [])
    assert.deepEqual(parseSourceManifest('not: a list'), [])
    assert.deepEqual(parseSourceManifest(': : :\n  - ['), [])
    assert.deepEqual(parseSourceManifest('- just a string\n- id: ok\n  filename: ok.md\n  title: Ok\n').map((e) => e.id), ['ok'])
  })
})

function memoryIo() {
  const files = new Map()
  let versionCounter = 0
  const versions = new Map()
  const conflict = () => Object.assign(new Error('conflict'), { code: 'STORAGE_CONFLICT' })
  const io = {
    files,
    raceOnce: null,
    async readText(path) {
      return files.has(path) ? { text: new TextDecoder().decode(files.get(path)), version: versions.get(path) } : null
    },
    async readBytes(path) {
      return files.has(path) ? files.get(path) : null
    },
    async writeText(path, text, { ifVersion } = {}) {
      if (io.raceOnce && path === 'sources/manifest.yaml') {
        const race = io.raceOnce
        io.raceOnce = null
        await race()
      }
      if (ifVersion !== undefined) {
        const current = versions.get(path) ?? null
        if (current !== ifVersion) throw conflict()
      }
      files.set(path, new TextEncoder().encode(text))
      versions.set(path, `v${++versionCounter}`)
    },
    async writeBytes(path, data) {
      files.set(path, data)
      versions.set(path, `v${++versionCounter}`)
    },
    async remove(path) {
      files.delete(path)
      versions.delete(path)
    },
  }
  return io
}

describe('the lifecycle', () => {
  test('upload writes the original, its text and a manifest entry with the fields #245 lists', async () => {
    const io = memoryIo()
    const store = createSourceStore(io, { now: fixedNow('2026-11-02T09:00:00.000Z') })
    const { entry, totalBytes, warning } = await store.upload({ filename: 'Client brief v3.docx', bytes: bytes('0123456789'), text: '# Brief\n', uploadedBy: 'a.architect' })
    assert.deepEqual(entry, {
      id: 'client-brief-v3',
      filename: 'Client brief v3.docx',
      title: 'Client brief v3',
      uploadedBy: 'a.architect',
      uploadedAt: '2026-11-02T09:00:00.000Z',
      size: 10,
      text: '.text/Client brief v3.docx.md',
    })
    assert.equal(totalBytes, 10)
    assert.equal(warning, null)
    assert.deepEqual([...io.files.keys()].sort(), ['sources/.text/Client brief v3.docx.md', 'sources/Client brief v3.docx', 'sources/manifest.yaml'])
    assert.deepEqual(parseYAML(new TextDecoder().decode(io.files.get('sources/manifest.yaml'))), [entry])
    assert.equal(new TextDecoder().decode((await store.readOriginal('client-brief-v3')).bytes), '0123456789')
    assert.equal(await store.readText('client-brief-v3'), '# Brief\n')
  })

  test('a document with no text has no text entry and no text file', async () => {
    const io = memoryIo()
    const store = createSourceStore(io)
    const { entry } = await store.upload({ filename: 'whiteboard.png', bytes: bytes('png') })
    assert.equal('text' in entry, false)
    assert.equal(io.files.has('sources/.text/whiteboard.png.md'), false)
    assert.equal(await store.readText(entry.id), null)
  })

  test('an upload is always a new document, even when it is named like an existing one', async () => {
    const store = createSourceStore(memoryIo())
    const first = (await store.upload({ filename: 'brief.docx', bytes: bytes('v1'), text: 'one' })).entry
    const second = (await store.upload({ filename: 'brief.docx', bytes: bytes('v2'), text: 'two' })).entry
    const third = (await store.upload({ filename: 'Brief.docx', bytes: bytes('v3') })).entry
    assert.deepEqual([first.id, second.id, third.id], ['brief', 'brief-2', 'brief-3'])
    assert.deepEqual([first.filename, second.filename, third.filename], ['brief.docx', 'brief-2.docx', 'Brief-3.docx'])
    assert.equal(new TextDecoder().decode((await store.readOriginal('brief')).bytes), 'v1')
    assert.equal(await store.readText('brief-2'), 'two')
    assert.equal((await store.list()).entries.length, 3)
  })

  test('rename changes only the title; the id and stored filename never move', async () => {
    const store = createSourceStore(memoryIo())
    const { entry } = await store.upload({ filename: 'brief.docx', bytes: bytes('x') })
    const renamed = await store.rename(entry.id, '  Client brief, signed  ')
    assert.equal(renamed.title, 'Client brief, signed')
    assert.equal(renamed.id, entry.id)
    assert.equal(renamed.filename, entry.filename)
    assert.deepEqual({ ...renamed, title: entry.title }, entry)
    await assert.rejects(store.rename(entry.id, '   '), (err) => err instanceof SourceDocumentError && err.code === 'bad-title')
    await assert.rejects(store.rename('nope', 'x'), (err) => err.code === 'not-found' && err.status === 404)
  })

  test('remove deletes the file and its text, keeps the entry marked removed, and keeps the name and id taken', async () => {
    const io = memoryIo()
    const store = createSourceStore(io, { now: fixedNow('2026-11-02T09:00:00.000Z', '2026-11-03T10:00:00.000Z', '2026-11-03T11:00:00.000Z') })
    const { entry } = await store.upload({ filename: 'brief.docx', bytes: bytes('x'), text: 'words', uploadedBy: 'a' })
    const removed = await store.remove(entry.id, { removedBy: 'b.reviewer' })
    assert.deepEqual(removed, {
      id: 'brief',
      filename: 'brief.docx',
      title: 'brief',
      uploadedBy: 'a',
      uploadedAt: '2026-11-02T09:00:00.000Z',
      size: 1,
      removedBy: 'b.reviewer',
      removedAt: '2026-11-03T10:00:00.000Z',
    })
    assert.deepEqual([...io.files.keys()], ['sources/manifest.yaml'])
    const listed = await store.list()
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.totalBytes, 0, 'a removed document no longer counts toward the Instance total')
    await assert.rejects(store.rename(entry.id, 'x'), (err) => err.code === 'removed' && err.status === 409)
    await assert.rejects(store.remove(entry.id), (err) => err.code === 'removed')
    await assert.rejects(store.readOriginal(entry.id), (err) => err.code === 'removed')
    const again = (await store.upload({ filename: 'brief.docx', bytes: bytes('y') })).entry
    assert.equal(again.id, 'brief-2', 'a removed id is never reused')
    assert.equal(again.filename, 'brief-2.docx')
  })

  test('Extract text again replaces, or clears, the text and the entry follows', async () => {
    const io = memoryIo()
    const store = createSourceStore(io)
    const { entry } = await store.upload({ filename: 'scan.pdf', bytes: bytes('pdf') })
    assert.equal('text' in entry, false)
    const withText = await store.setText(entry.id, '## Page 1\n\nHello')
    assert.equal(withText.text, '.text/scan.pdf.md')
    assert.equal(await store.readText(entry.id), '## Page 1\n\nHello')
    const replaced = await store.setText(entry.id, 'Better text')
    assert.equal(await store.readText(entry.id), 'Better text')
    assert.equal(replaced.id, entry.id)
    const cleared = await store.setText(entry.id, null)
    assert.equal('text' in cleared, false)
    assert.equal(io.files.has('sources/.text/scan.pdf.md'), false)
  })

  test('a document over 25 MB is refused with 413 and nothing is written; an empty one with 400', async () => {
    const io = memoryIo()
    const store = createSourceStore(io)
    const tooBig = { byteLength: MAX_SOURCE_BYTES + 1 }
    await assert.rejects(store.upload({ filename: 'big.pdf', bytes: tooBig }), (err) => err.code === 'too-large' && err.status === 413 && /over the 25 MB limit/.test(err.message))
    await assert.rejects(store.upload({ filename: 'empty.txt', bytes: new Uint8Array() }), (err) => err.code === 'empty' && err.status === 400)
    await assert.rejects(store.upload({ filename: 'x.txt', bytes: bytes('x'), text: 'y'.repeat(1_500_001) }), (err) => err.code === 'text-too-large' && err.status === 413)
    assert.equal(io.files.size, 0)
    const exactly = await store.upload({ filename: 'edge.pdf', bytes: new Uint8Array(MAX_SOURCE_BYTES) })
    assert.equal(exactly.entry.size, MAX_SOURCE_BYTES)
  })

  test('the Instance warning shows past about 100 MB of live documents, and goes when some are removed', async () => {
    const store = createSourceStore(memoryIo())
    const ids = []
    for (let i = 0; i < 5; i++) ids.push((await store.upload({ filename: `pack-${i}.pdf`, bytes: new Uint8Array(MAX_SOURCE_BYTES) })).entry.id)
    let listed = await store.list()
    assert.equal(listed.totalBytes, 5 * MAX_SOURCE_BYTES)
    assert.match(listed.warning, /past about 100 MB/)
    await store.remove(ids[0])
    listed = await store.list()
    assert.equal(listed.warning, null)
  })

  test('two uploads at once each keep their entry, with different names and ids', async () => {
    const io = memoryIo()
    const store = createSourceStore(io)
    // The other upload lands between this one reading the manifest and writing it.
    io.raceOnce = async () => {
      await store.upload({ filename: 'brief.docx', bytes: bytes('other') })
    }
    const mine = (await store.upload({ filename: 'brief.docx', bytes: bytes('mine') })).entry
    const { entries } = await store.list()
    assert.deepEqual(entries.map((e) => e.id).sort(), ['brief', 'brief-2'])
    assert.equal(mine.id, 'brief-2')
    assert.equal(new TextDecoder().decode((await store.readOriginal('brief')).bytes), 'other')
    assert.equal(new TextDecoder().decode((await store.readOriginal('brief-2')).bytes), 'mine')
  })

  test('an upload whose files cannot be written leaves no entry behind', async () => {
    const io = memoryIo()
    const original = io.writeBytes
    io.writeBytes = async () => {
      throw new Error('disk full')
    }
    const store = createSourceStore(io)
    await assert.rejects(store.upload({ filename: 'brief.docx', bytes: bytes('x') }), /disk full/)
    assert.deepEqual((await store.list()).entries, [])
    io.writeBytes = original
    assert.equal((await store.upload({ filename: 'brief.docx', bytes: bytes('x') })).entry.id, 'brief')
  })

  test('a missing id is a 404 and a missing original reads back as null', async () => {
    const io = memoryIo()
    const store = createSourceStore(io)
    await assert.rejects(store.readOriginal('nope'), (err) => err.code === 'not-found')
    const { entry } = await store.upload({ filename: 'a.txt', bytes: bytes('x') })
    io.files.delete('sources/a.txt')
    assert.equal((await store.readOriginal(entry.id)).bytes, null)
  })
})

// #318 (docs/adr/0071): a document fetched from a web address is an ordinary Source document with an origin.
describe('documents fetched from a web address', () => {
  const origin = (fetchedAt = '2026-11-03T09:00:00.000Z', extra = {}) => ({ address: 'https://vendor.example.com/api', finalAddress: 'https://docs.vendor.example.com/api', fetchedAt, ...extra })

  test('an HTML page is a kind of its own that only ever comes from an address: an upload still refuses it', () => {
    assert.equal(sourceFileKind('API guide.html'), 'html')
    assert.equal(sourceFileKind('page.htm'), 'html')
    assert.match(sourceFileTypeProblem('page.html'), /can't take \.html files/)
    assert.equal(sourceFileTypeProblem('page.html', { fetched: true }), null)
    assert.match(sourceFileTypeProblem('thing.exe', { fetched: true }), /can't take \.exe files/)
    assert.ok(!SOURCE_FILE_ACCEPT.includes('.html'), 'the upload picker does not offer HTML')
  })

  test('the origin is kept in a fixed order, and anything that is not one is no origin at all', () => {
    assert.deepEqual(normalizeSourceOrigin({ fetchedAt: '2026-11-03T09:00:00.000Z', finalAddress: 'https://b.example/x', address: 'https://a.example/x', extra: 1 }), {
      address: 'https://a.example/x',
      finalAddress: 'https://b.example/x',
      fetchedAt: '2026-11-03T09:00:00.000Z',
    })
    assert.equal(normalizeSourceOrigin({ address: 'https://a.example/x', fetchedAt: '2026-11-03T09:00:00.000Z' }).finalAddress, 'https://a.example/x')
    assert.equal(normalizeSourceOrigin({ address: 'javascript:alert(1)', fetchedAt: '2026-11-03T09:00:00.000Z' }), null)
    assert.equal(normalizeSourceOrigin({ address: 'https://a.example/x', fetchedAt: 'yesterday' }), null)
    assert.equal(normalizeSourceOrigin(null), null)
    assert.equal(isFetchedSource({ id: 'a' }), false)
    assert.equal(isFetchedSource({ id: 'a', origin: origin() }), true)
  })

  test('an upload with an origin is stored like any other, its entry records where it came from, and an upload without one is unchanged', async () => {
    const io = memoryIo()
    const store = createSourceStore(io, { now: fixedNow('2026-11-03T09:00:05.000Z', '2026-11-03T09:01:00.000Z') })
    const { entry } = await store.upload({ filename: 'Vendor API guide.html', bytes: bytes('<h1>Limits</h1>'), text: '# Limits', title: 'Vendor API guide', uploadedBy: 'Ana', origin: origin() })
    assert.deepEqual(entry, {
      id: 'vendor-api-guide',
      filename: 'Vendor API guide.html',
      title: 'Vendor API guide',
      uploadedBy: 'Ana',
      uploadedAt: '2026-11-03T09:00:05.000Z',
      size: 15,
      text: '.text/Vendor API guide.html.md',
      origin: origin(),
    })
    const manifest = parseYAML(new TextDecoder().decode(io.files.get('sources/manifest.yaml')))
    assert.deepEqual(Object.keys(manifest[0]), ['id', 'filename', 'title', 'uploadedBy', 'uploadedAt', 'size', 'text', 'origin'])
    assert.deepEqual(Object.keys(manifest[0].origin), ['address', 'finalAddress', 'fetchedAt'])
    const { entry: upload } = await store.upload({ filename: 'brief.txt', bytes: bytes('x') })
    assert.equal('origin' in upload, false)
    await assert.rejects(store.upload({ filename: 'x.html', bytes: bytes('x'), origin: { address: 'nope' } }), (err) => err instanceof SourceDocumentError && err.code === 'bad-origin')
    // Renamed and removed like an upload, and the origin stays with the entry.
    assert.deepEqual((await store.rename(entry.id, 'API guide')).origin, origin())
    assert.deepEqual((await store.remove(entry.id)).origin, origin())
  })

  test('Fetch again with the very same bytes adds nothing and hands back the kept document', async () => {
    const io = memoryIo()
    const store = createSourceStore(io)
    const { entry } = await store.upload({ filename: 'guide.html', bytes: bytes('<p>same</p>'), text: 'same', origin: origin() })
    const manifestBefore = io.files.get('sources/manifest.yaml')
    let extracted = 0
    const result = await store.fetchAgain(entry.id, { filename: 'guide.html', bytes: bytes('<p>same</p>'), origin: origin('2026-11-10T00:00:00.000Z') }, { extract: async () => (extracted++, 'same') })
    assert.equal(result.unchanged, true)
    assert.equal(result.entry.id, entry.id)
    assert.equal(result.entry.origin.fetchedAt, '2026-11-03T09:00:00.000Z', 'the kept document says when it was fetched, for "unchanged since"')
    assert.equal(extracted, 0, 'nothing is read when nothing changed')
    assert.equal(io.files.get('sources/manifest.yaml'), manifestBefore, 'the manifest is not written')
    assert.equal((await store.list()).entries.length, 1)
  })

  test('Fetch again with changed bytes adds a new document that replaces the old one under its title', async () => {
    const io = memoryIo()
    const store = createSourceStore(io, { now: fixedNow('2026-11-03T09:00:05.000Z', '2026-11-10T08:00:05.000Z') })
    const { entry } = await store.upload({ filename: 'guide.html', bytes: bytes('<p>v1</p>'), text: 'v1', title: 'Vendor guide', origin: origin() })
    const result = await store.fetchAgain(entry.id, { filename: 'guide.html', bytes: bytes('<p>v2</p>'), uploadedBy: 'Ben', origin: origin('2026-11-10T08:00:00.000Z') }, { extract: async () => 'v2' })
    assert.equal(result.unchanged, false)
    assert.equal(result.entry.id, 'guide-2')
    assert.equal(result.entry.title, 'Vendor guide')
    assert.equal(result.entry.replaces, entry.id)
    assert.equal(result.entry.uploadedBy, 'Ben')
    assert.equal(result.entry.origin.fetchedAt, '2026-11-10T08:00:00.000Z')
    assert.equal(await store.readText('guide-2'), 'v2')
    assert.equal(await store.readText(entry.id), 'v1', 'the old one is kept and can still be cited')
    assert.equal(replacedBy((await store.list()).entries, entry.id).id, 'guide-2')
  })

  test('Fetch again is refused for an upload and for a removed document', async () => {
    const store = createSourceStore(memoryIo())
    const { entry: upload } = await store.upload({ filename: 'brief.txt', bytes: bytes('x') })
    await assert.rejects(store.fetchAgain(upload.id, { filename: 'brief.txt', bytes: bytes('y'), origin: origin() }), (err) => err.code === 'not-fetched')
    const { entry: page } = await store.upload({ filename: 'p.html', bytes: bytes('x'), origin: origin() })
    await store.remove(page.id)
    await assert.rejects(store.fetchAgain(page.id, { filename: 'p.html', bytes: bytes('y'), origin: origin() }), (err) => err.code === 'removed')
  })
})

describe('the user guide', () => {
  test('has a Source documents section under Workspaces & Instances that states the limits and the kept-apart rule', () => {
    const guide = readFileSync('docs/user-guide/index.md', 'utf8')
    const start = guide.indexOf('### Source documents')
    assert.ok(start > guide.indexOf('## Workspaces & Instances'), 'it sits inside Workspaces & Instances')
    assert.ok(start < guide.indexOf('## Stages & Gates'), 'and before the next top-level section')
    const section = guide.slice(start, guide.indexOf('\n### ', start + 5))
    for (const needle of ['25 MB', '100 MB', 'sources/manifest.yaml', 'Extract text again', 'Rename', 'Remove', 'NO TEXT', 'fetches nothing from the internet', 'separately', 'Add from address', 'Fetch again', 'unchanged since', 'save it as a PDF', 'GANTRY_SOURCE_FETCH_DISABLED', 'GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS']) {
      assert.ok(section.includes(needle), `the section mentions "${needle}"`)
    }
  })
})

describe('the server workspace store', () => {
  test('runs over a storage layer that has no disk behind it, and touches nothing outside sources/', async () => {
    const storage = createInMemoryStorage()
    const store = createInstanceSourceStore(storage, 'workspace/instances', 'my-initiative')
    const { entry } = await store.upload({ filename: 'Brief.docx', bytes: bytes('doc'), text: '# Brief' })
    assert.deepEqual([...storage.files.keys()].sort(), [
      'workspace/instances/my-initiative/sources/.text/Brief.docx.md',
      'workspace/instances/my-initiative/sources/Brief.docx',
      'workspace/instances/my-initiative/sources/manifest.yaml',
    ])
    await store.rename(entry.id, 'Signed brief')
    await store.setText(entry.id, '# Brief, again')
    await store.remove(entry.id, { removedBy: 'me' })
    assert.deepEqual([...storage.files.keys()], ['workspace/instances/my-initiative/sources/manifest.yaml'])
    const { entries } = await store.list()
    assert.equal(entries[0].title, 'Signed brief')
    assert.equal(entries[0].removedBy, 'me')
  })

  test('on disk it keeps a sources/ folder next to modules/ and assets/, and leaves Assets alone', async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sources-'))
    try {
      createInstance('design', 'my-initiative', { instancesDir })
      const before = readdirSync(join(instancesDir, 'my-initiative')).sort()
      const store = createInstanceSourceStore(createLocalFilesystemStorage(), instancesDir, 'my-initiative')
      await store.upload({ filename: 'Brief.docx', bytes: bytes('doc'), text: '# Brief' })
      const instanceDir = join(instancesDir, 'my-initiative')
      assert.deepEqual(readdirSync(instanceDir).sort(), [...before, 'sources'].sort())
      assert.ok(existsSync(join(instanceDir, 'sources', 'manifest.yaml')))
      assert.equal(readFileSync(join(instanceDir, 'sources', '.text', 'Brief.docx.md'), 'utf8'), '# Brief')
      assert.equal(existsSync(join(instanceDir, 'assets', 'manifest.yaml')), false, 'Source documents never write the assets manifest')
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })

  test('downloads are served with a type that cannot run in the app', () => {
    assert.equal(sourceDownloadHeaders('a.pdf', 4)['Content-Disposition'], "inline; filename*=UTF-8''a.pdf")
    assert.equal(sourceDownloadHeaders('a.png', 4)['Content-Type'], 'image/png')
    assert.match(sourceDownloadHeaders('Client brief.docx', 4)['Content-Disposition'], /^attachment; filename\*=UTF-8''Client%20brief\.docx$/)
    assert.equal(sourceDownloadHeaders('page.html', 4)['Content-Type'], 'application/octet-stream')
    assert.equal(sourceDownloadHeaders('x.pdf', 7)['X-Content-Type-Options'], 'nosniff')
  })
})
