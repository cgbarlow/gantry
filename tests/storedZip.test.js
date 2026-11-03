import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storedZip } from '../web/lib/storedZip.js'
import { unzip } from './helpers/reviewedCopyFixture.js'

// #310: the zip "Download all" makes of an Instance's Source documents.

test('a stored zip holds each file under its name, byte for byte', () => {
  const files = [
    { name: 'Client brief.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255, 128, 7]) },
    { name: 'Notes é.docx', bytes: new Uint8Array(70_000).map((_, i) => i % 251) },
    { name: 'empty.txt', bytes: new Uint8Array(0) },
  ]
  const parts = unzip(Buffer.from(storedZip(files)))
  assert.deepEqual(Object.keys(parts), files.map((f) => f.name))
  for (const file of files) assert.deepEqual(Buffer.compare(parts[file.name], Buffer.from(file.bytes)), 0, file.name)
})

test('a system unzip tool reads it and finds nothing wrong with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-zip-'))
  try {
    const bytes = storedZip([
      { name: 'a.txt', bytes: new TextEncoder().encode('alpha') },
      { name: 'b.md', bytes: new TextEncoder().encode('# beta') },
    ])
    writeFileSync(join(dir, 'pack.zip'), bytes)
    let out
    try {
      out = execFileSync('unzip', ['-t', join(dir, 'pack.zip')], { encoding: 'utf8' })
    } catch (err) {
      if (err.code === 'ENOENT') return // no unzip on this machine; the test above covers the bytes
      throw err
    }
    assert.match(out, /No errors detected/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty pack is a valid, empty zip', () => {
  assert.deepEqual(unzip(Buffer.from(storedZip([]))), {})
})
