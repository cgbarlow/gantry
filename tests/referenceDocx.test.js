import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isValidDocxBuffer, readDefinitionReferenceDocx, writeDefinitionReferenceDocx } from '../lib/definition.js'

// WI #385 — an artefact's reference .docx: Replace (upload) and Download. These are the
// lib/definition.js-level unit tests; tests/definition-viewer.playwright.test.js covers the
// same behaviour end to end through the artefact focus pane's Replace/Download UI.

const REAL_DOCX = readFileSync('definitions/design/1/templates/reference-soap.docx')

test('isValidDocxBuffer accepts a real reference .docx', () => {
  assert.equal(isValidDocxBuffer(REAL_DOCX), true)
})

test('isValidDocxBuffer rejects non-zip bytes, a bare zip, and anything too short', () => {
  assert.equal(isValidDocxBuffer(Buffer.from('not a docx at all')), false)
  assert.equal(isValidDocxBuffer(Buffer.from([])), false)
  assert.equal(isValidDocxBuffer(Buffer.from([0x50, 0x4b])), false)
  // A zip with the right magic but neither OOXML manifest nor Word part — e.g. a renamed
  // ordinary .zip, or an .xlsx/.pptx wearing a .docx extension — must still be rejected; this is
  // exactly the "don't just trust the extension/mimetype" check WI #385 asked for.
  const fakeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('hello.txt some other zip entirely')])
  assert.equal(isValidDocxBuffer(fakeZip), false)
})

function withScratchDefinitions(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-refdocx-'))
  try {
    // draft version 2, published version 1 — mirrors tests/definition-viewer.playwright.test.js's
    // withDraftDesignV2 fixture shape.
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let raw = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    raw = raw.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), raw)
    fn(definitionsDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

test('readDefinitionReferenceDocx returns the stored bytes, or null when none was uploaded', () => {
  withScratchDefinitions((definitionsDir) => {
    const bytes = readDefinitionReferenceDocx('design', 1, 'soap', { definitionsDir })
    assert.ok(Buffer.isBuffer(bytes))
    assert.deepEqual(bytes, REAL_DOCX)

    assert.equal(readDefinitionReferenceDocx('design', 1, 'no-such-artefact', { definitionsDir }), null)
  })
})

test('writeDefinitionReferenceDocx replaces the file on a draft version', () => {
  withScratchDefinitions((definitionsDir) => {
    const result = writeDefinitionReferenceDocx('design', 2, 'soap', REAL_DOCX, { definitionsDir })
    assert.equal(result.name, 'reference-soap.docx')
    const roundTripped = readDefinitionReferenceDocx('design', 2, 'soap', { definitionsDir })
    assert.deepEqual(roundTripped, REAL_DOCX)
  })
})

test('writeDefinitionReferenceDocx refuses a published version', () => {
  withScratchDefinitions((definitionsDir) => {
    assert.throws(
      () => writeDefinitionReferenceDocx('design', 1, 'soap', REAL_DOCX, { definitionsDir }),
      /not a draft/
    )
    // and the on-disk file is untouched
    assert.deepEqual(readDefinitionReferenceDocx('design', 1, 'soap', { definitionsDir }), REAL_DOCX)
  })
})

test('writeDefinitionReferenceDocx refuses bytes that are not a real .docx', () => {
  withScratchDefinitions((definitionsDir) => {
    assert.throws(
      () => writeDefinitionReferenceDocx('design', 2, 'soap', Buffer.from('definitely not a docx'), { definitionsDir }),
      /not a valid \.docx/
    )
  })
})

test('writeDefinitionReferenceDocx and readDefinitionReferenceDocx reject a path-traversal artefact id', () => {
  withScratchDefinitions((definitionsDir) => {
    assert.throws(() => writeDefinitionReferenceDocx('design', 2, '../../evil', REAL_DOCX, { definitionsDir }), /Invalid artefact id/)
    assert.throws(() => readDefinitionReferenceDocx('design', 1, '../../evil', { definitionsDir }), /Invalid artefact id/)
  })
})
