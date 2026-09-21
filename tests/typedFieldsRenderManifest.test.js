import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRenderManifest, resolveRenderManifestUpdate, RENDER_MANIFEST_FILENAME } from '../lib/instance.js'

// #88 (ADR-0045 §7): the render manifest's two pure decisions — "what does a manifest file's raw
// content actually mean" (parseRenderManifest) and "given that, does this render's own filename
// change anything" (resolveRenderManifestUpdate) — covered directly, independent of local disk or
// any Provider. tests/render.test.js covers the end-to-end behaviour (local disk and an Azure
// DevOps fake server) these two functions drive.

test('RENDER_MANIFEST_FILENAME is a dotfile — bookkeeping, not a document a user would open', () => {
  assert.match(RENDER_MANIFEST_FILENAME, /^\./)
  assert.match(RENDER_MANIFEST_FILENAME, /\.json$/)
})

test('parseRenderManifest: undefined/missing content degrades to an empty manifest', () => {
  assert.deepEqual(parseRenderManifest(undefined), {})
  assert.deepEqual(parseRenderManifest(null), {})
  assert.deepEqual(parseRenderManifest(''), {})
  assert.deepEqual(parseRenderManifest('   '), {})
})

test('parseRenderManifest: malformed JSON degrades to an empty manifest rather than throwing', () => {
  assert.deepEqual(parseRenderManifest('not json at all {{{'), {})
  assert.deepEqual(parseRenderManifest('{"soap": "Kiwi Cover Mutual - SOAP.docx"'), {}) // truncated
})

test('parseRenderManifest: valid JSON that is not a plain object (array, string, number) degrades to empty', () => {
  assert.deepEqual(parseRenderManifest('[]'), {})
  assert.deepEqual(parseRenderManifest('["soap.docx"]'), {})
  assert.deepEqual(parseRenderManifest('"just a string"'), {})
  assert.deepEqual(parseRenderManifest('42'), {})
  assert.deepEqual(parseRenderManifest('null'), {})
})

test('parseRenderManifest: a real manifest round-trips verbatim', () => {
  const raw = JSON.stringify({ soap: 'Kiwi Cover Mutual - SOAP.docx', hld: 'Kiwi Cover Mutual - HLD.docx' })
  assert.deepEqual(parseRenderManifest(raw), { soap: 'Kiwi Cover Mutual - SOAP.docx', hld: 'Kiwi Cover Mutual - HLD.docx' })
})

test('resolveRenderManifestUpdate: no manifest yet — first render of an artefact is recorded, nothing to delete', () => {
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate(undefined, 'soap', 'Kiwi Cover Mutual - SOAP.docx')
  assert.deepEqual(manifest, { soap: 'Kiwi Cover Mutual - SOAP.docx' })
  assert.equal(changed, true)
  assert.equal(staleFilename, null)
})

test('resolveRenderManifestUpdate: same filename as last time — unchanged, nothing stale, no write needed', () => {
  const raw = JSON.stringify({ soap: 'Kiwi Cover Mutual - SOAP.docx' })
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate(raw, 'soap', 'Kiwi Cover Mutual - SOAP.docx')
  assert.deepEqual(manifest, { soap: 'Kiwi Cover Mutual - SOAP.docx' })
  assert.equal(changed, false)
  assert.equal(staleFilename, null)
})

test('resolveRenderManifestUpdate: a different filename for an already-tracked artefact reports the old one as stale', () => {
  const raw = JSON.stringify({ soap: 'Kiwi Cover Mutual - SOAP.docx' })
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate(raw, 'soap', 'Kiwi Cover Mutual Renamed - SOAP.docx')
  assert.deepEqual(manifest, { soap: 'Kiwi Cover Mutual Renamed - SOAP.docx' })
  assert.equal(changed, true)
  assert.equal(staleFilename, 'Kiwi Cover Mutual - SOAP.docx')
})

test('resolveRenderManifestUpdate: other artefacts already in the manifest are left alone', () => {
  const raw = JSON.stringify({ soap: 'A - SOAP.docx', hld: 'A - HLD.docx' })
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate(raw, 'soap', 'B - SOAP.docx')
  assert.deepEqual(manifest, { soap: 'B - SOAP.docx', hld: 'A - HLD.docx' })
  assert.equal(changed, true)
  assert.equal(staleFilename, 'A - SOAP.docx')
})

test('resolveRenderManifestUpdate: an unreadable/garbage manifest behaves exactly like no manifest — no stale filename to delete, just records this render', () => {
  const { manifest, changed, staleFilename } = resolveRenderManifestUpdate('not json {{{', 'soap', 'Kiwi Cover Mutual - SOAP.docx')
  assert.deepEqual(manifest, { soap: 'Kiwi Cover Mutual - SOAP.docx' })
  assert.equal(changed, true)
  assert.equal(staleFilename, null)
})

test('resolveRenderManifestUpdate: a hand-edited manifest entry containing a path separator is never reported as a file to delete', () => {
  for (const malicious of ['../../../etc/passwd', '..\\..\\secrets.txt', 'sub/dir/file.docx', '.', '..']) {
    const raw = JSON.stringify({ soap: malicious })
    const { staleFilename } = resolveRenderManifestUpdate(raw, 'soap', 'Kiwi Cover Mutual - SOAP.docx')
    assert.equal(staleFilename, null, `expected "${malicious}" to never be treated as a safe file to delete`)
  }
})
