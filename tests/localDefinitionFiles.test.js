import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { isValidSlug } from '../lib/slug.js'
import { createBlankDefinition, writeDefinitionVersion, loadDefinition, definitionVersionProjection, buildDefinitionYamlObject, buildModuleYamlObject } from '../lib/definition.js'
import { withScratchInstances } from './helpers/lifecycle.js'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'

import {
  isValidLocalDefinitionId,
  isValidDocxBuffer,
  blankLocalDefinitionStructure,
  renderDefinitionYaml,
  parseDefinitionYaml,
  renderModuleYaml,
  parseModuleYaml,
  readLocalDefinitionStructure,
  writeLocalDefinitionStructure,
  readLocalDefinitionTemplate,
  writeLocalDefinitionTemplate,
  readLocalDefinitionReferenceDocx,
  writeLocalDefinitionReferenceDocx,
  listLocalDefinitions,
  localDefinitionExists,
  resolveDefinitionStructure,
  listLocalDefinitionRows,
} from '../web/lib/localDefinitionFiles.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'

// ---------------------------------------------------------------------------
// In-memory File System Access API stub — same minimal shape
// tests/localStatus.test.js / tests/localWorkspace.test.js use for their own
// web/lib/ modules; duplicated here rather than shared, per this repo's
// established convention (see web/lib/localInstanceFiles.js's own header
// comment).
// ---------------------------------------------------------------------------

class MemFileHandle {
  constructor(name) {
    this.kind = 'file'
    this.name = name
    this.bytes = new Uint8Array()
  }

  async getFile() {
    const bytes = this.bytes
    return {
      async text() {
        return new TextDecoder().decode(bytes)
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
    }
  }

  async createWritable() {
    const handle = this
    return {
      async write(data) {
        if (typeof data === 'string') {
          handle.bytes = new TextEncoder().encode(data)
        } else if (data instanceof Uint8Array) {
          handle.bytes = data
        } else if (data instanceof ArrayBuffer) {
          handle.bytes = new Uint8Array(data)
        } else {
          handle.bytes = new Uint8Array(0)
        }
      },
      async close() {},
    }
  }
}

class MemDirHandle {
  constructor(name = '') {
    this.kind = 'directory'
    this.name = name
    this.children = new Map()
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    let entry = this.children.get(name)
    if (!entry) {
      if (!create) throw new Error(`NotFoundError: no directory "${name}"`)
      entry = new MemDirHandle(name)
      this.children.set(name, entry)
    }
    if (entry.kind !== 'directory') throw new Error(`TypeMismatchError: "${name}" is a file`)
    return entry
  }

  async getFileHandle(name, { create = false } = {}) {
    let entry = this.children.get(name)
    if (!entry) {
      if (!create) throw new Error(`NotFoundError: no file "${name}"`)
      entry = new MemFileHandle(name)
      this.children.set(name, entry)
    }
    if (entry.kind !== 'file') throw new Error(`TypeMismatchError: "${name}" is a directory`)
    return entry
  }

  async *entries() {
    for (const [name, handle] of this.children) yield [name, handle]
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw new Error(`NotFoundError: no entry "${name}"`)
  }
}

const FIXTURE_STRUCTURE = {
  id: 'wi384-fixture',
  title: 'WI384 Fixture',
  description: 'A minimal definition for phase 4 file-IO tests.',
  version: 1,
  status: 'draft',
  stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the idea', gate: 'business-case', modules: ['background'] }],
  artefacts: [{ id: 'soap', title: 'SOAP', purpose: 'Summarise', template: 'templates/main.md.tmpl', gate: 'business-case', requires: ['background.summary'] }],
  modules: [
    {
      id: 'background',
      title: 'Background',
      purpose: 'Why this exists',
      fields: [
        { id: 'summary', title: 'Summary', type: 'markdown', required: true },
        { id: 'risks', title: 'Risks', type: 'list', requiredAt: ['business-case'] },
      ],
    },
  ],
}

describe('isValidLocalDefinitionId', () => {
  test('matches lib/slug.js isValidSlug exactly, for every case that matters', () => {
    for (const candidate of ['design', 'wi384-fixture', '', '.', '..', 'a/b', 'a\\b', 'a b', null, undefined, 42]) {
      assert.equal(isValidLocalDefinitionId(candidate), isValidSlug(candidate), `mismatch for ${JSON.stringify(candidate)}`)
    }
  })
})

describe('blankLocalDefinitionStructure', () => {
  test('produces a fresh, empty, draft v1 structure', () => {
    const structure = blankLocalDefinitionStructure('my-def', 'My Definition')
    assert.deepEqual(structure, {
      id: 'my-def',
      title: 'My Definition',
      description: '',
      version: 1,
      status: 'draft',
      stages: [],
      artefacts: [],
      modules: [],
    })
  })

  test('falls back to the id as the title when none is given', () => {
    assert.equal(blankLocalDefinitionStructure('my-def').title, 'my-def')
  })
})

describe('renderDefinitionYaml / parseDefinitionYaml', () => {
  test('renderDefinitionYaml produces the exact same object lib/definition.js would build server-side', () => {
    const clientYaml = renderDefinitionYaml(FIXTURE_STRUCTURE)
    const serverObj = buildDefinitionYamlObject(FIXTURE_STRUCTURE.id, FIXTURE_STRUCTURE.version, FIXTURE_STRUCTURE.status, FIXTURE_STRUCTURE, {})
    assert.deepEqual(parseYAML(clientYaml), serverObj)
  })

  test('round-trips id/title/description/version/status/stages/artefacts', () => {
    const text = renderDefinitionYaml(FIXTURE_STRUCTURE)
    const raw = parseDefinitionYaml(text)
    assert.equal(raw.id, 'wi384-fixture')
    assert.equal(raw.version, 1)
    assert.equal(raw.status, 'draft')
    assert.equal(raw.stages[0].id, 'shape')
    assert.deepEqual(raw.stages[0].modules, ['background'])
    assert.equal(raw.artefacts[0].template, 'templates/main.md.tmpl')
  })

  test('writes "copied-from" (kebab) on disk for a stage/artefact carrying copiedFrom (camel)', () => {
    const structure = { ...FIXTURE_STRUCTURE, stages: [{ ...FIXTURE_STRUCTURE.stages[0], copiedFrom: { definitionId: 'design', elementId: 'shape' } }] }
    const raw = parseDefinitionYaml(renderDefinitionYaml(structure))
    assert.deepEqual(raw.stages[0]['copied-from'], { definitionId: 'design', elementId: 'shape' })
    assert.equal(raw.stages[0].copiedFrom, undefined)
  })
})

describe('renderModuleYaml / parseModuleYaml', () => {
  test('renderModuleYaml matches lib/definition.js\'s buildModuleYamlObject exactly', () => {
    const mod = FIXTURE_STRUCTURE.modules[0]
    const clientYaml = renderModuleYaml(mod)
    assert.deepEqual(parseYAML(clientYaml), buildModuleYamlObject(mod))
  })

  test('a required-at field round-trips as "required-at" (kebab) on disk, not "required"', () => {
    const raw = parseModuleYaml(renderModuleYaml(FIXTURE_STRUCTURE.modules[0]))
    const risks = raw.fields.find((f) => f.id === 'risks')
    assert.deepEqual(risks['required-at'], ['business-case'])
    assert.equal(risks.required, undefined)
  })
})

describe('writeLocalDefinitionStructure / readLocalDefinitionStructure', () => {
  test('round-trips a structure through an in-memory directory handle idempotently (write, read, write again, read again — identical)', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
    const firstRead = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    assert.equal(firstRead.id, 'wi384-fixture')
    assert.equal(firstRead.stages[0].modules[0], 'background')
    assert.equal(firstRead.modules[0].fields[0].id, 'summary')

    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, firstRead)
    const secondRead = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    assert.deepEqual(secondRead, firstRead)
  })

  test('matches the real definitionVersionProjection for the exact same structure written to real disk', async () => {
    await withScratchInstances(async (definitionsDir) => {
      createBlankDefinition('wi384-fixture', { definitionsDir })
      writeDefinitionVersion('wi384-fixture', 1, FIXTURE_STRUCTURE, { definitionsDir })
      const diskProjection = definitionVersionProjection(loadDefinition('wi384-fixture', { definitionsDir, version: 1 }))

      const handle = new MemDirHandle()
      await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
      const localStructure = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)

      assert.deepEqual(localStructure, diskProjection)
    })
  })

  test('deletes a stale module file whose id was removed from the structure', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
    const trimmed = { ...FIXTURE_STRUCTURE, stages: [{ ...FIXTURE_STRUCTURE.stages[0], modules: [] }], artefacts: [], modules: [] }
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, trimmed)
    const read = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    assert.deepEqual(read.modules, [])
  })

  test('readLocalDefinitionStructure throws when the folder\'s declared id does not match the requested id', async () => {
    // A folder genuinely at definitions/typo-id/1/ (so the read gets as far as
    // parsing definition.yaml), but whose definition.yaml still declares the
    // original id — e.g. the folder was renamed on disk without updating the
    // file inside it.
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'typo-id', 1, FIXTURE_STRUCTURE)
    await assert.rejects(readLocalDefinitionStructure(handle, 'typo-id', 1), /declares id "wi384-fixture", expected "typo-id"/)
  })

  test('a definition with no modules yet round-trips to an empty modules array, not a missing directory error', async () => {
    const handle = new MemDirHandle()
    const blank = blankLocalDefinitionStructure('empty-def', 'Empty')
    await writeLocalDefinitionStructure(handle, 'empty-def', 1, blank)
    const read = await readLocalDefinitionStructure(handle, 'empty-def', 1)
    assert.deepEqual(read.modules, [])
  })

  // #81 (ADR-0044): a select field's options: must survive the Local-Workspace writer the same
  // way it must survive the server-side one (tests/definition.test.js's own round-trip test) —
  // both YAML writers rebuild each field from a fixed key whitelist, so either one left untaught
  // deletes options: on save.
  test('round-trips a select field\'s options, and matches the server-side projection for the same structure', async () => {
    const withSelect = {
      ...FIXTURE_STRUCTURE,
      modules: [
        {
          ...FIXTURE_STRUCTURE.modules[0],
          fields: [
            ...FIXTURE_STRUCTURE.modules[0].fields,
            { id: 'engagement-type', title: 'Engagement type', type: 'select', options: ['Permanent', 'Fixed term', 'Contractor'] },
          ],
        },
      ],
    }

    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, withSelect)
    const read = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    const field = read.modules[0].fields.find((f) => f.id === 'engagement-type')
    assert.equal(field.type, 'select')
    assert.deepEqual(field.options, ['Permanent', 'Fixed term', 'Contractor'])

    await withScratchInstances(async (definitionsDir) => {
      createBlankDefinition('wi384-fixture', { definitionsDir })
      writeDefinitionVersion('wi384-fixture', 1, withSelect, { definitionsDir })
      const diskProjection = definitionVersionProjection(loadDefinition('wi384-fixture', { definitionsDir, version: 1 }))
      assert.deepEqual(read.modules, diskProjection.modules)
    })
  })

  // #148 (spec #147): the local-workspace Definition copy keeps every key the server-side lifecycle
  // does — Stage `read-only-modules` and `copied-from`, Artefact `filename`, `document-control`,
  // `satisfies-gate` and `copied-from` — and projects them exactly as the server does, so the two
  // booleans appear only when false.
  test('round-trips every Stage and Artefact key, and matches the server-side projection for the same structure', async () => {
    const provenance = { definition: 'elsewhere', version: 2, element: 'artefact:letter' }
    const withEveryKey = {
      ...FIXTURE_STRUCTURE,
      stages: [
        FIXTURE_STRUCTURE.stages[0],
        { id: 'review', title: 'Review', purpose: 'Review it', gate: 'sign-off', modules: ['background'], readOnlyModules: ['background'], copiedFrom: { ...provenance, element: 'stage:review' } },
      ],
      artefacts: [
        FIXTURE_STRUCTURE.artefacts[0],
        {
          id: 'letter', title: 'Letter', purpose: 'For the reader', template: 'templates/letter.md.tmpl', gate: 'sign-off', requires: ['background.summary'],
          filename: '{instance.name} - Letter', documentControl: false, satisfiesGate: false, copiedFrom: provenance,
        },
      ],
    }

    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, withEveryKey)
    const yamlText = await (await (await (await (await (await handle.getDirectoryHandle('definitions')).getDirectoryHandle('wi384-fixture')).getDirectoryHandle('1')).getFileHandle('definition.yaml')).getFile()).text()
    assert.match(yamlText, /read-only-modules:/)
    assert.match(yamlText, /document-control: false/)
    assert.match(yamlText, /satisfies-gate: false/)

    const read = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    const review = read.stages.find((s) => s.id === 'review')
    const letter = read.artefacts.find((a) => a.id === 'letter')
    assert.deepEqual(review.readOnlyModules, ['background'])
    assert.equal('readOnlyModules' in read.stages[0], false)
    assert.equal(letter.filename, '{instance.name} - Letter')
    assert.equal(letter.documentControl, false)
    assert.equal(letter.satisfiesGate, false)
    assert.deepEqual(letter.copiedFrom, provenance)
    assert.equal('documentControl' in read.artefacts[0], false)
    assert.equal('satisfiesGate' in read.artefacts[0], false)

    await withScratchInstances(async (definitionsDir) => {
      createBlankDefinition('wi384-fixture', { definitionsDir })
      writeDefinitionVersion('wi384-fixture', 1, withEveryKey, { definitionsDir })
      const diskProjection = definitionVersionProjection(loadDefinition('wi384-fixture', { definitionsDir, version: 1 }))
      assert.deepEqual(read, diskProjection)
    })
  })

  // #148: an explicit `true` on disk is kept in the file but left out of the projection, as
  // lib/definition.js's definitionVersionProjection does — only `false` is projected.
  test('keeps document-control / satisfies-gate: true on disk but leaves them out of the projection, matching the server', async () => {
    const withTrue = {
      ...FIXTURE_STRUCTURE,
      artefacts: [{ ...FIXTURE_STRUCTURE.artefacts[0], documentControl: true, satisfiesGate: true }],
    }

    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, withTrue)
    const yamlText = await (await (await (await (await (await handle.getDirectoryHandle('definitions')).getDirectoryHandle('wi384-fixture')).getDirectoryHandle('1')).getFileHandle('definition.yaml')).getFile()).text()
    assert.match(yamlText, /document-control: true/)
    assert.match(yamlText, /satisfies-gate: true/)

    const read = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    assert.equal('documentControl' in read.artefacts[0], false)
    assert.equal('satisfiesGate' in read.artefacts[0], false)

    await withScratchInstances(async (definitionsDir) => {
      createBlankDefinition('wi384-fixture', { definitionsDir })
      writeDefinitionVersion('wi384-fixture', 1, withTrue, { definitionsDir })
      const diskProjection = definitionVersionProjection(loadDefinition('wi384-fixture', { definitionsDir, version: 1 }))
      assert.deepEqual(read, diskProjection)
    })
  })
})

// #150 (ADR-0049): a hand-edited `document-control:` that isn't a boolean — unquoted `no` reads
// as the string "no" under YAML 1.2 — must reach the Local Workspace's validation as it is, not be
// projected away as if it were absent. Otherwise the render prints both tables with no warning and
// the next Save quietly deletes the author's key.
describe('a non-boolean document-control read from a Local Workspace folder', () => {
  test('is kept by readLocalDefinitionStructure, reported by findLocalDefinitionProblems, and survives a write', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
    const fileHandle = await (await (await (await handle.getDirectoryHandle('definitions')).getDirectoryHandle('wi384-fixture')).getDirectoryHandle('1')).getFileHandle('definition.yaml')
    const yamlText = await (await fileHandle.getFile()).text()
    const edited = yamlText.replace('    requires:\n', '    document-control: no\n    requires:\n')
    assert.notEqual(edited, yamlText, 'the fixture edit must land')
    const writable = await fileHandle.createWritable()
    await writable.write(edited)
    await writable.close()

    const read = await readLocalDefinitionStructure(handle, 'wi384-fixture', 1)
    assert.equal(read.artefacts[0].documentControl, 'no')
    const problems = findLocalDefinitionProblems(read)
    assert.deepEqual(problems.map((p) => p.type), ['invalid-document-control'])
    assert.match(problems[0].message, /^Artefact "soap" sets "document-control" to "no"/)

    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, read)
    assert.match(await (await fileHandle.getFile()).text(), /document-control: no/)
  })
})

describe('templates and reference docx', () => {
  test('template text round-trips, and reads back null before any save', async () => {
    const handle = new MemDirHandle()
    assert.equal(await readLocalDefinitionTemplate(handle, 'wi384-fixture', 1, 'main.md.tmpl'), null)
    await writeLocalDefinitionTemplate(handle, 'wi384-fixture', 1, 'main.md.tmpl', '# <%= it.instance.slug %>\n')
    assert.equal(await readLocalDefinitionTemplate(handle, 'wi384-fixture', 1, 'main.md.tmpl'), '# <%= it.instance.slug %>\n')
  })

  test('rejects a template name that does not end .md.tmpl', async () => {
    const handle = new MemDirHandle()
    await assert.rejects(writeLocalDefinitionTemplate(handle, 'wi384-fixture', 1, 'main.txt', 'x'), /Invalid template name/)
  })

  test('isValidDocxBuffer accepts a real PK/OOXML signature and rejects plain bytes', () => {
    const fakeDocx = new TextEncoder().encode('PK\x03\x04 ... [Content_Types].xml ... word/document.xml ...')
    assert.equal(isValidDocxBuffer(fakeDocx), true)
    assert.equal(isValidDocxBuffer(new TextEncoder().encode('not a docx')), false)
    assert.equal(isValidDocxBuffer(new Uint8Array(2)), false)
  })

  test('reference docx bytes round-trip, and read back null before any upload', async () => {
    const handle = new MemDirHandle()
    assert.equal(await readLocalDefinitionReferenceDocx(handle, 'wi384-fixture', 1, 'soap'), null)
    const bytes = new TextEncoder().encode('PK\x03\x04 [Content_Types].xml word/document.xml')
    await writeLocalDefinitionReferenceDocx(handle, 'wi384-fixture', 1, 'soap', bytes)
    const read = await readLocalDefinitionReferenceDocx(handle, 'wi384-fixture', 1, 'soap')
    assert.deepEqual(new Uint8Array(read), bytes)
  })
})

describe('listLocalDefinitions', () => {
  test('is empty for a workspace with no definitions/ folder at all', async () => {
    assert.deepEqual(await listLocalDefinitions(new MemDirHandle()), [])
  })

  test('lists every definitions/<id>/<version>/ this workspace folder holds, sorted by id', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'zeta', 1, blankLocalDefinitionStructure('zeta'))
    await writeLocalDefinitionStructure(handle, 'alpha', 1, blankLocalDefinitionStructure('alpha'))
    await writeLocalDefinitionStructure(handle, 'alpha', 2, { ...blankLocalDefinitionStructure('alpha'), version: 2 })
    assert.deepEqual(await listLocalDefinitions(handle), [
      { id: 'alpha', versions: [1, 2] },
      { id: 'zeta', versions: [1] },
    ])
  })
})

// ---------------------------------------------------------------------------
// WI #384 item 4: letting a local-workspace instance pin a local-workspace
// definition — `localDefinitionExists`/`resolveDefinitionStructure` are the
// "does this workspace author this id itself" resolution every local-aware
// caller (the "+ New Instance" wizard, `loadLocalInstance`,
// `buildLocalInstanceRow`, all in web/app.js) goes through instead of
// unconditionally fetching the server library.
// ---------------------------------------------------------------------------

describe('localDefinitionExists', () => {
  test('is false for a workspace with no definitions/ folder at all', async () => {
    assert.equal(await localDefinitionExists(new MemDirHandle(), 'wi384-fixture', 1), false)
  })

  test('is false for a known id at a version that has not been written yet', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
    assert.equal(await localDefinitionExists(handle, 'wi384-fixture', 2), false)
  })

  test('is true once definition.yaml has been written at that id/version', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
    assert.equal(await localDefinitionExists(handle, 'wi384-fixture', 1), true)
  })
})

describe('resolveDefinitionStructure', () => {
  test('reads straight off this workspace\'s own definitions/ folder when the id/version lives there, never reaching fetch', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, FIXTURE_STRUCTURE)
    // No global.fetch stub at all — if this ever fell through to the network
    // branch it would throw (Node's fetch can't resolve a bare "/api/..."
    // path with no page origin), so a clean resolve proves the local branch
    // was actually taken.
    const structure = await resolveDefinitionStructure(handle, 'wi384-fixture', 1)
    assert.equal(structure.id, 'wi384-fixture')
    assert.equal(structure.modules[0].id, 'background')
  })
})

describe('listLocalDefinitionRows', () => {
  test('is empty for a workspace with no definitions/ folder at all', async () => {
    assert.deepEqual(await listLocalDefinitionRows(new MemDirHandle()), [])
  })

  test('tags every row home: { kind: "local-workspace" }, and prefers the latest published version for display', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, { ...FIXTURE_STRUCTURE, status: 'published', title: 'v1 title' })
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 2, { ...FIXTURE_STRUCTURE, version: 2, status: 'draft', title: 'v2 title' })
    const rows = await listLocalDefinitionRows(handle)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].home, { kind: 'local-workspace' })
    assert.equal(rows[0].title, 'v1 title')
    assert.equal(rows[0].latestPublished, 1)
    assert.deepEqual(rows[0].versions, [
      { version: 1, status: 'published' },
      { version: 2, status: 'draft' },
    ])
  })

  test('falls back to the latest version at all when nothing is published yet', async () => {
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'wi384-fixture', 1, { ...FIXTURE_STRUCTURE, status: 'draft', title: 'only draft' })
    const rows = await listLocalDefinitionRows(handle)
    assert.equal(rows[0].latestPublished, null)
    assert.equal(rows[0].title, 'only draft')
  })
})
