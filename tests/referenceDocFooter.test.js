import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { listDefinitions, listVersionNumbers, loadDefinition } from '../lib/definition.js'

// WI #363: the Full SOAP rendered to .docx with the footer "Technical
// Architecture Committee – High Level Solution Design" — the HLD's committee,
// on a document that never goes to that committee.
//
// The cause was an absent asset, not broken code. `lib/render.js` resolves the
// pandoc reference doc per artefact (`templates/reference-<artefact.id>.docx`)
// and falls back to the definition-level `templates/reference.docx`. Every
// artefact had its own file except `soap-full`, which was added after the
// per-artefact split (WI153) — so it fell through to `reference.docx`, which
// had been built from the TAC HLD source and still carried its footer.
//
// A missing file is exactly the kind of fault no amount of code review catches,
// so this test stands in for the review: for every artefact of every published
// definition it resolves the reference doc the same way the renderer does and
// asserts (a) the artefact has its own reference doc rather than silently
// borrowing another artefact's, and (b) whatever committee the footer names is
// a committee that artefact actually goes to. Add a seventh artefact tomorrow
// and the build fails here until its reference doc exists.

// Which committee each artefact's footer is allowed to name. Anything not
// listed must be committee-neutral. Per the WI153 triage: HLD goes to the
// Technical Architecture Committee; SOAP is a Business Case and as-built is
// "for noting", so neither names one; SAD/SSAD stay neutral pending the
// ARB/TAC vs Design Authority decision. `soap-full` is the same document
// family as `soap` — neutral.
const ALLOWED_COMMITTEES = {
  hld: ['Technical Architecture Committee'],
}

// Names a governance body — "<Some Words> Committee/Board/Authority". Broad on
// purpose: a footer that names *any* body an artefact doesn't go to is the bug,
// not just the TAC one that was reported.
const COMMITTEE_RE = /(?:[A-Z][\w'-]*\s+){1,4}(?:Committee|Board|Authority)/g

// --- minimal .docx (zip) reader -------------------------------------------
// A .docx is a zip; the footers are `word/footer*.xml` inside it. Reading them
// with zlib keeps this test dependency-free — the alternative is shelling out
// to `unzip`, which isn't guaranteed to exist on a build agent.

function zipEntries(buf) {
  // End-of-central-directory record: signature 0x06054b50, then (at +10) the
  // entry count and (at +16) the offset of the central directory.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.notEqual(eocd, -1, 'not a zip archive: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, 'corrupt zip central directory')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readZipEntry(buf, entry) {
  // The local file header repeats the name/extra lengths, which can differ from
  // the central directory's, so the data offset has to come from here.
  assert.equal(buf.readUInt32LE(entry.localOffset), 0x04034b50, `corrupt local header for ${entry.name}`)
  const nameLen = buf.readUInt16LE(entry.localOffset + 26)
  const extraLen = buf.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  assert.equal(entry.method, 8, `unsupported zip compression method ${entry.method} for ${entry.name}`)
  return inflateRawSync(raw)
}

/** Visible text of every `word/footer*.xml` part in a .docx, as one string. */
export function docxFooterText(path) {
  const buf = readFileSync(path)
  const footers = zipEntries(buf).filter((e) => /^word\/footer\d*\.xml$/.test(e.name))
  assert.ok(footers.length > 0, `${path} has no word/footer*.xml part`)
  return footers
    .map((entry) => [...readZipEntry(buf, entry).toString('utf8').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .join(' ')
}

function committeesNamedIn(text) {
  return [...text.matchAll(COMMITTEE_RE)].map((m) => m[0].trim())
}

// --- the definitions under test --------------------------------------------

/** Every published (definitionId, version) pair shipped in `definitions/`. */
function publishedDefinitions() {
  const found = []
  for (const row of listDefinitions()) {
    for (const version of listVersionNumbers(row.id)) {
      const definition = loadDefinition(row.id, { version })
      if (definition.status === 'published') found.push(definition)
    }
  }
  assert.ok(found.length > 0, 'no published definitions found under definitions/')
  return found
}

/** The same resolution lib/render.js does: artefact-specific first, then the definition default. */
function resolveReferenceDoc(definition, artefactId) {
  const artefactDoc = join(definition.definitionDir, 'templates', `reference-${artefactId}.docx`)
  const defaultDoc = join(definition.definitionDir, 'templates', 'reference.docx')
  return existsSync(artefactDoc) ? artefactDoc : defaultDoc
}

test('every artefact of every published definition has its own reference doc (no silent fallback)', () => {
  for (const definition of publishedDefinitions()) {
    const label = `${definition.id} v${definition.version}`
    const templatesDir = join(definition.definitionDir, 'templates')
    // A definition that has split its reference doc per artefact must have done
    // so for *every* artefact — a partial split is what let `soap-full` inherit
    // the HLD's footer. A definition that has not split at all is fine: one
    // shared, committee-neutral reference.docx is a deliberate choice.
    const hasSplit = definition.artefacts.some((a) => existsSync(join(templatesDir, `reference-${a.id}.docx`)))
    if (!hasSplit) continue
    for (const artefact of definition.artefacts) {
      assert.ok(
        existsSync(join(templatesDir, `reference-${artefact.id}.docx`)),
        `${label}: artefact "${artefact.id}" has no reference-${artefact.id}.docx, so it falls back to ` +
          `templates/reference.docx and inherits whatever footer that file carries. Add ` +
          `${join(templatesDir, `reference-${artefact.id}.docx`)} (a copy of the closest artefact's).`
      )
    }
  }
})

test('a rendered artefact never carries a committee footer belonging to a different artefact', () => {
  for (const definition of publishedDefinitions()) {
    const label = `${definition.id} v${definition.version}`
    for (const artefact of definition.artefacts) {
      const referenceDoc = resolveReferenceDoc(definition, artefact.id)
      if (!existsSync(referenceDoc)) continue // no reference doc at all: pandoc's default, no footer to police
      const allowed = ALLOWED_COMMITTEES[artefact.id] ?? []
      for (const committee of committeesNamedIn(docxFooterText(referenceDoc))) {
        assert.ok(
          allowed.includes(committee),
          `${label}: artefact "${artefact.id}" renders with ${referenceDoc}, whose footer names ` +
            `"${committee}". That artefact does not go to that body — ${allowed.length > 0 ? `it may only name ${allowed.join(', ')}` : 'its footer must be committee-neutral'}.`
        )
      }
    }
  }
})

test('the fallback reference.docx is committee-neutral in every published definition', () => {
  for (const definition of publishedDefinitions()) {
    const fallback = join(definition.definitionDir, 'templates', 'reference.docx')
    if (!existsSync(fallback)) continue
    const named = committeesNamedIn(docxFooterText(fallback))
    assert.deepEqual(
      named,
      [],
      `${definition.id} v${definition.version}: templates/reference.docx is the fallback for any artefact ` +
        `without its own reference doc, so its footer must name no committee — it names ${named.join(', ')}. ` +
        'Whatever inherits it would claim a governance body it never went to.'
    )
  }
})

test('the HLD reference doc still names the Technical Architecture Committee', () => {
  // The mirror image of the bug: stripping footers too enthusiastically would
  // quietly drop the one committee line that is correct.
  for (const definition of publishedDefinitions()) {
    const hld = definition.artefacts.find((a) => a.id === 'hld')
    if (!hld) continue
    const referenceDoc = resolveReferenceDoc(definition, 'hld')
    assert.match(
      docxFooterText(referenceDoc),
      /Technical Architecture Committee/,
      `${definition.id} v${definition.version}: ${referenceDoc} no longer names the Technical Architecture Committee`
    )
  }
})
