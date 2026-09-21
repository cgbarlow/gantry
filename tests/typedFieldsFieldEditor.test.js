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
  buildModuleYamlObject,
} from '../lib/definition.js'
import { reorder } from '../web/lib/reorder.js'
import {
  writeLocalDefinitionStructure,
  readLocalDefinitionStructure,
} from '../web/lib/localDefinitionFiles.js'

// #86 (ADR-0044): the Definition editor (web/pages/definition-viewer.js, server-hosted; and
// web/pages/local-definition-editor.js, Local Workspace) authors a select field's options:/
// multiple:/default: — and reorders/removes options, and warns before a type switch discards
// them — purely by mutating the same field-shape object #81/#83/#84 already taught both YAML
// writers to preserve. This file exercises those exact mutation sequences (add field → switch
// type to "select" → add/reorder/remove options → set multiple/default → switch type away)
// through the real save/read path on both twins, proving the editor's own object shape survives
// end to end without needing any further change to either writer.

// ---------------------------------------------------------------------------
// In-memory File System Access API stub — same minimal shape tests/localDefinitionFiles.test.js
// already establishes for web/lib/*.js, duplicated here per this repo's convention (see
// web/lib/localInstanceFiles.js's own header comment on why these twins never share code).
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

const BASE_STRUCTURE = {
  id: 'fieldeditor-fixture',
  title: 'Field Editor Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['engagement'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: [] }],
  modules: [{ id: 'engagement', title: 'Engagement', purpose: 'How the engagement is classified', fields: [] }],
}

// The exact object "+ Add field" seeds in both editors (web/pages/definition-viewer.js and
// web/pages/local-definition-editor.js's addField).
function freshField(id) {
  return { id, title: 'New Field', type: 'markdown', guidance: '' }
}

// Mirrors the Type <select>'s onChange handler in both editors: switching a field to "select"
// changes nothing else; switching a field away from "select" drops options:/multiple:/default:.
function setType(field, nextType) {
  const next = { ...field, type: nextType }
  if (nextType !== 'select') {
    delete next.options
    delete next.multiple
    delete next.default
  }
  return next
}

// Mirrors the "+ Add option" button.
function addOption(field, value = '') {
  return { ...field, options: [...(field.options ?? []), value] }
}

// Mirrors an option row's remove button: clears default if it named the removed option.
function removeOption(field, index) {
  const removed = field.options[index]
  const next = { ...field, options: field.options.filter((_, i) => i !== index) }
  if (next.default === removed) delete next.default
  return next
}

async function withScratchDefinitionsDir(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-fieldeditor-'))
  try {
    return await fn(definitionsDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

describe('server-hosted Definition editor field-shape round trip (web/pages/definition-viewer.js)', () => {
  test('adding a field, switching it to select, adding/reordering options, and setting multiple/default all survive writeDefinitionVersion -> loadDefinition', async () => {
    await withScratchDefinitionsDir((definitionsDir) => {
      createBlankDefinition('fieldeditor-fixture', { definitionsDir })

      let field = freshField('engagement-type')
      field = setType(field, 'select')
      field = addOption(field, 'Permanent')
      field = addOption(field, 'Contractor')
      field = addOption(field, 'Fixed term')
      // Reorder button route: move "Fixed term" (index 2) up one, ahead of "Contractor".
      field = { ...field, options: reorder(field.options, 2, 1) }
      field = { ...field, multiple: true }
      field = { ...field, default: 'Permanent' }

      const structure = { ...BASE_STRUCTURE, modules: [{ ...BASE_STRUCTURE.modules[0], fields: [field] }] }
      writeDefinitionVersion('fieldeditor-fixture', 1, structure, { definitionsDir })

      const projection = definitionVersionProjection(loadDefinition('fieldeditor-fixture', { definitionsDir, version: 1 }))
      const savedField = projection.modules[0].fields[0]
      assert.equal(savedField.type, 'select')
      assert.deepEqual(savedField.options, ['Permanent', 'Fixed term', 'Contractor'])
      assert.equal(savedField.multiple, true)
      assert.equal(savedField.default, 'Permanent')
    })
  })

  test('removing the option currently named by default clears default, and the field validates clean', async () => {
    await withScratchDefinitionsDir((definitionsDir) => {
      createBlankDefinition('fieldeditor-fixture', { definitionsDir })

      let field = freshField('engagement-type')
      field = setType(field, 'select')
      field = addOption(field, 'Permanent')
      field = addOption(field, 'Contractor')
      field = { ...field, default: 'Contractor' }
      field = removeOption(field, 1) // removes "Contractor", the current default

      assert.deepEqual(field.options, ['Permanent'])
      assert.equal(field.default, undefined)

      const structure = { ...BASE_STRUCTURE, modules: [{ ...BASE_STRUCTURE.modules[0], fields: [field] }] }
      assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
    })
  })

  test('switching a select field to another type discards options/multiple/default from what gets written', () => {
    let field = freshField('engagement-type')
    field = setType(field, 'select')
    field = addOption(field, 'Permanent')
    field = { ...field, multiple: true, default: 'Permanent' }

    const discarded = setType(field, 'text')
    assert.equal(discarded.type, 'text')
    assert.equal(discarded.options, undefined)
    assert.equal(discarded.multiple, undefined)
    assert.equal(discarded.default, undefined)

    const written = buildModuleYamlObject({ id: 'engagement', title: 'Engagement', purpose: '', fields: [discarded] })
    assert.deepEqual(Object.keys(written.fields[0]), ['id', 'title', 'type', 'guidance'])
    assert.equal(written.fields[0].options, undefined)
    assert.equal(written.fields[0].multiple, undefined)
    assert.equal(written.fields[0].default, undefined)
  })

  test('a select field with an empty options: list (added, never filled in) is flagged by live validation, not silently accepted', () => {
    const field = setType(freshField('engagement-type'), 'select')
    const structure = { ...BASE_STRUCTURE, modules: [{ ...BASE_STRUCTURE.modules[0], fields: [field] }] }
    const problems = findDefinitionProblemsInStructure(structure)
    assert.ok(problems.some((p) => /declares no "options:" list/.test(p.message)))
  })
})

describe('Local Workspace Definition editor field-shape round trip (web/pages/local-definition-editor.js)', () => {
  test('the same add/switch-to-select/add-options/reorder/multiple/default sequence round-trips through writeLocalDefinitionStructure -> readLocalDefinitionStructure', async () => {
    let field = freshField('engagement-type')
    field = setType(field, 'select')
    field = addOption(field, 'Permanent')
    field = addOption(field, 'Contractor')
    field = addOption(field, 'Fixed term')
    field = { ...field, options: reorder(field.options, 2, 1) }
    field = { ...field, multiple: true }
    field = { ...field, default: 'Permanent' }

    const structure = { ...BASE_STRUCTURE, id: 'fieldeditor-local', modules: [{ ...BASE_STRUCTURE.modules[0], fields: [field] }] }

    const handle = new MemDirHandle()
    await writeLocalDefinitionStructure(handle, 'fieldeditor-local', 1, structure)
    const read = await readLocalDefinitionStructure(handle, 'fieldeditor-local', 1)

    const savedField = read.modules[0].fields[0]
    assert.equal(savedField.type, 'select')
    assert.deepEqual(savedField.options, ['Permanent', 'Fixed term', 'Contractor'])
    assert.equal(savedField.multiple, true)
    assert.equal(savedField.default, 'Permanent')
  })

  test('matches the server-hosted editor\'s own projection for the identical field-shape sequence', async () => {
    let field = freshField('engagement-type')
    field = setType(field, 'select')
    field = addOption(field, 'Permanent')
    field = addOption(field, 'Contractor')
    field = { ...field, default: 'Contractor' }

    const structure = { ...BASE_STRUCTURE, modules: [{ ...BASE_STRUCTURE.modules[0], fields: [field] }] }

    await withScratchDefinitionsDir(async (definitionsDir) => {
      createBlankDefinition('fieldeditor-fixture', { definitionsDir })
      writeDefinitionVersion('fieldeditor-fixture', 1, structure, { definitionsDir })
      const serverProjection = definitionVersionProjection(loadDefinition('fieldeditor-fixture', { definitionsDir, version: 1 }))

      const handle = new MemDirHandle()
      await writeLocalDefinitionStructure(handle, 'fieldeditor-fixture', 1, structure)
      const localStructure = await readLocalDefinitionStructure(handle, 'fieldeditor-fixture', 1)

      assert.deepEqual(localStructure.modules[0].fields[0], serverProjection.modules[0].fields[0])
    })
  })
})
