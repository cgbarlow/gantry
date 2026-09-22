import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createBlankDefinition,
  writeDefinitionVersion,
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblemsInStructure,
} from '../lib/definition.js'
import {
  writeLocalDefinitionStructure,
  readLocalDefinitionStructure,
} from '../web/lib/localDefinitionFiles.js'

// #89 (ADR-0045): the Definition editor (web/pages/definition-viewer.js, server-hosted; and
// web/pages/local-definition-editor.js, Local Workspace) authors an Artefact's filename:
// pattern purely by setting a.filename on the same draft object structure #87 already taught
// both YAML writers to preserve — this file exercises the set/edit/clear mutation sequence
// through the real save/read path on both twins, and drives the shared
// findDefinitionProblemsInStructure rule set (the same one both editors' live validation calls
// hit — lib/server.js's POST /.../validate and POST /api/local/definition/validate) with the
// exact problem shapes the editor's inline "eligible tokens"/error-list UI depends on: unknown
// token, wrong field type, and field-not-required, plus the two acceptance paths (direct
// module.field requirement, and a bare whole-module requirement putting the field in scope).

// ---------------------------------------------------------------------------
// In-memory File System Access API stub — same minimal shape
// tests/typedFieldsFieldEditor.test.js already establishes, duplicated here per this repo's
// convention (see web/lib/localInstanceFiles.js's own header comment on why these twins never
// share code).
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

const CANDIDATE_MODULE = {
  id: 'candidate',
  title: 'Candidate',
  purpose: 'Who the offer is for',
  fields: [
    { id: 'name', title: 'Candidate name', type: 'text' },
    { id: 'start-date', title: 'Start date', type: 'date' },
    { id: 'department', title: 'Department', type: 'select', options: ['Engineering', 'Sales'], multiple: true },
    { id: 'role', title: 'Role', type: 'text' },
  ],
}

function baseStructure(overrides = {}) {
  return {
    id: 'filenamepattern-fixture',
    title: 'Filename Pattern Fixture',
    description: '',
    version: 1,
    status: 'draft',
    stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['candidate'] }],
    artefacts: [
      {
        id: 'offer-pack',
        title: 'Offer Pack',
        purpose: 'The candidate-facing offer',
        template: 'templates/offer-pack.md.tmpl',
        gate: 'g',
        requires: ['candidate.name', 'candidate.start-date'],
      },
    ],
    modules: [CANDIDATE_MODULE],
    ...overrides,
  }
}

// Mirrors the "click to insert a token" button in both editors: appends {token} to whatever
// the pattern already holds.
function insertToken(artefact, token) {
  return { ...artefact, filename: `${artefact.filename ?? ''}{${token}}` }
}

async function withScratchDefinitionsDir(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-filenamepattern-'))
  try {
    return await fn(definitionsDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

describe('server-hosted Definition editor filename: pattern round trip (web/pages/definition-viewer.js)', () => {
  test('setting, editing and clearing a pattern survives writeDefinitionVersion -> loadDefinition', async () => {
    await withScratchDefinitionsDir((definitionsDir) => {
      createBlankDefinition('filenamepattern-fixture', { definitionsDir })

      let artefact = baseStructure().artefacts[0]
      artefact = insertToken(artefact, 'candidate.name')
      artefact = { ...artefact, filename: `${artefact.filename} - Offer Pack` }
      artefact = insertToken(artefact, 'today')

      let structure = baseStructure({ artefacts: [artefact] })
      writeDefinitionVersion('filenamepattern-fixture', 1, structure, { definitionsDir })
      let projection = definitionVersionProjection(loadDefinition('filenamepattern-fixture', { definitionsDir, version: 1 }))
      assert.equal(projection.artefacts[0].filename, '{candidate.name} - Offer Pack{today}')

      // Edit
      structure = baseStructure({ artefacts: [{ ...artefact, filename: '{candidate.name} - Signed Offer' }] })
      writeDefinitionVersion('filenamepattern-fixture', 1, structure, { definitionsDir })
      projection = definitionVersionProjection(loadDefinition('filenamepattern-fixture', { definitionsDir, version: 1 }))
      assert.equal(projection.artefacts[0].filename, '{candidate.name} - Signed Offer')

      // Clear
      structure = baseStructure({ artefacts: [{ ...artefact, filename: '' }] })
      writeDefinitionVersion('filenamepattern-fixture', 1, structure, { definitionsDir })
      projection = definitionVersionProjection(loadDefinition('filenamepattern-fixture', { definitionsDir, version: 1 }))
      assert.equal(projection.artefacts[0].filename, '')
      assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
    })
  })

  test('a token naming a field outside the vocabulary is flagged, by name, against the artefact', () => {
    const artefact = insertToken(baseStructure().artefacts[0], 'candidate.does-not-exist')
    const structure = baseStructure({ artefacts: [artefact] })
    const problems = findDefinitionProblemsInStructure(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'filename-unknown-token')
    assert.match(problems[0].message, /Artefact "offer-pack"/)
    assert.match(problems[0].message, /\{candidate\.does-not-exist\}/)
  })

  test('a token naming a multi-valued select field is flagged as the wrong type, even when required', () => {
    let artefact = baseStructure().artefacts[0]
    artefact = { ...artefact, requires: [...artefact.requires, 'candidate.department'] }
    artefact = insertToken(artefact, 'candidate.department')
    const structure = baseStructure({ artefacts: [artefact] })
    const problems = findDefinitionProblemsInStructure(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'filename-invalid-field-type')
    assert.match(problems[0].message, /multiple: true/)
  })

  test('a token naming a real, single-valued field the artefact does not require is flagged, not silently accepted', () => {
    const artefact = insertToken(baseStructure().artefacts[0], 'candidate.role')
    const structure = baseStructure({ artefacts: [artefact] })
    const problems = findDefinitionProblemsInStructure(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'filename-field-not-required')
  })

  test('a bare whole-module requirement puts every one of its single-valued fields in scope for a token, matching the editor\'s eligible-tokens list', () => {
    let artefact = baseStructure().artefacts[0]
    artefact = { ...artefact, requires: ['candidate'] }
    artefact = insertToken(artefact, 'candidate.role')
    const structure = baseStructure({ artefacts: [artefact] })
    assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
  })

  test('the three built-in tokens and a required select/text/date field all validate clean together', () => {
    let artefact = baseStructure().artefacts[0]
    artefact = insertToken(artefact, 'instance.name')
    artefact = insertToken(artefact, 'instance.slug')
    artefact = insertToken(artefact, 'today')
    artefact = insertToken(artefact, 'candidate.name')
    artefact = insertToken(artefact, 'candidate.start-date')
    const structure = baseStructure({ artefacts: [artefact] })
    assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
  })
})

describe('Local Workspace Definition editor filename: pattern round trip (web/pages/local-definition-editor.js)', () => {
  test('the same set/edit/clear sequence round-trips through writeLocalDefinitionStructure -> readLocalDefinitionStructure', async () => {
    let artefact = baseStructure().artefacts[0]
    artefact = insertToken(artefact, 'candidate.name')
    artefact = { ...artefact, filename: `${artefact.filename} - Offer Pack` }

    const structure = baseStructure({ id: 'filenamepattern-local', artefacts: [artefact] })
    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'filenamepattern-local', 1, structure)
    let read = await readLocalDefinitionStructure(handle, 'filenamepattern-local', 1)
    assert.equal(read.artefacts[0].filename, '{candidate.name} - Offer Pack')

    await writeLocalDefinitionStructure(handle, 'filenamepattern-local', 1, { ...structure, artefacts: [{ ...artefact, filename: '' }] })
    read = await readLocalDefinitionStructure(handle, 'filenamepattern-local', 1)
    assert.equal(read.artefacts[0].filename, '')
  })

  test('matches the server-hosted editor\'s own projection for the identical filename: pattern', async () => {
    let artefact = baseStructure().artefacts[0]
    artefact = insertToken(artefact, 'candidate.name')
    artefact = { ...artefact, filename: `${artefact.filename} - Offer Pack ` }
    artefact = insertToken(artefact, 'today')
    const structure = baseStructure({ artefacts: [artefact] })

    await withScratchDefinitionsDir(async (definitionsDir) => {
      createBlankDefinition('filenamepattern-fixture', { definitionsDir })
      writeDefinitionVersion('filenamepattern-fixture', 1, structure, { definitionsDir })
      const serverProjection = definitionVersionProjection(loadDefinition('filenamepattern-fixture', { definitionsDir, version: 1 }))

      const handle = new MemDirHandle()
      await writeLocalDefinitionStructure(handle, 'filenamepattern-fixture', 1, structure)
      const localStructure = await readLocalDefinitionStructure(handle, 'filenamepattern-fixture', 1)

      assert.equal(localStructure.artefacts[0].filename, serverProjection.artefacts[0].filename)
    })
  })

  test('the same unknown-token/wrong-type/not-required validation rules apply identically (shared findDefinitionProblemsInStructure)', () => {
    let artefact = baseStructure().artefacts[0]
    artefact = insertToken(artefact, 'candidate.role')
    const structure = baseStructure({ artefacts: [artefact] })
    const problems = findDefinitionProblemsInStructure(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'filename-field-not-required')
  })
})
