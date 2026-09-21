import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBlankDefinition,
  writeDefinitionVersion,
  publishDefinitionVersion,
  loadDefinition,
  definitionVersionProjection,
} from '../lib/definition.js'
import { createInstance, writeModule, readModule } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'
import { evaluateLocalStage } from '../web/lib/localStatus.js'
import {
  blankLocalDefinitionStructure,
  writeLocalDefinitionStructure,
  readLocalDefinitionStructure,
} from '../web/lib/localDefinitionFiles.js'

// #83 (ADR-0044): select `multiple: true` — a variation within `select`, not a second type.
// Several ticked options store as bullets, byte-identical to how `list` already writes.

const STRUCTURE = {
  id: 'multiselect-fixture',
  title: 'MultiSelect Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['vetting'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: ['vetting.checks'] }],
  modules: [
    {
      id: 'vetting',
      title: 'Vetting',
      purpose: 'Which checks were run',
      fields: [
        { id: 'checks', title: 'Checks required', type: 'select', required: true, multiple: true, options: ['Police check', 'Reference check', 'Right-to-work check'] },
      ],
    },
  ],
}

test('loads and round-trips multiple: true through writeDefinitionVersion', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-multiselect-'))
  try {
    createBlankDefinition('multiselect-fixture', { definitionsDir })
    writeDefinitionVersion('multiselect-fixture', 1, STRUCTURE, { definitionsDir })
    publishDefinitionVersion('multiselect-fixture', 1, { definitionsDir })

    const def = loadDefinition('multiselect-fixture', { definitionsDir })
    const field = def.modules.get('vetting').fields.find((f) => f.id === 'checks')
    assert.equal(field.multiple, true)
    assert.deepEqual(field.options, ['Police check', 'Reference check', 'Right-to-work check'])

    // Round trip: save the loaded projection back through the writer (draft a v2) and re-load.
    createBlankDefinition('multiselect-fixture-v2-host', { definitionsDir })
    const projection = definitionVersionProjection(def)
    writeDefinitionVersion('multiselect-fixture-v2-host', 1, projection, { definitionsDir })
    publishDefinitionVersion('multiselect-fixture-v2-host', 1, { definitionsDir })
    const reloaded = loadDefinition('multiselect-fixture-v2-host', { definitionsDir })
    const reloadedField = reloaded.modules.get('vetting').fields.find((f) => f.id === 'checks')
    assert.equal(reloadedField.multiple, true)
    assert.deepEqual(reloadedField.options, ['Police check', 'Reference check', 'Right-to-work check'])
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

test('several selected options write as bullets and parse back as an array; empty means the Gate blocks a required field', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-multiselect-inst-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-multiselect-'))
  try {
    createBlankDefinition('multiselect-fixture', { definitionsDir })
    writeDefinitionVersion('multiselect-fixture', 1, STRUCTURE, { definitionsDir })
    publishDefinitionVersion('multiselect-fixture', 1, { definitionsDir })
    createInstance('multiselect-fixture', 'multiselect-demo', { definitionsDir, instancesDir })
    const definition = loadDefinition('multiselect-fixture', { definitionsDir })

    // Nothing chosen yet — required multi-select blocks the Gate exactly like an empty markdown field.
    let result = checkGate('multiselect-demo', { instancesDir, definitionsDir })
    assert.equal(result.pass, false)

    writeModule(definition, 'multiselect-demo', 'vetting', {
      status: 'draft',
      owner: '',
      fields: { checks: ['Police check', 'Reference check'] },
    }, { instancesDir })

    const onDisk = readModule(definition, 'multiselect-demo', 'vetting', { instancesDir })
    assert.deepEqual(onDisk.fields.checks, ['Police check', 'Reference check'])

    result = checkGate('multiselect-demo', { instancesDir, definitionsDir })
    assert.equal(result.pass, true)
    assert.deepEqual(result.warnings, [])
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('an off-list value inside a multi-select array is preserved and warned about individually', () => {
  const stage = STRUCTURE.stages[0]
  const moduleData = new Map([['vetting', { exists: true, fields: { checks: ['Police check', 'Credit check'] } }]])
  const result = evaluateLocalStage(STRUCTURE, stage, moduleData)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /field "Checks required"/)
  assert.match(result.warnings[0], /"Credit check"/)
  assert.ok(!result.warnings[0].includes('"Police check"'), 'only the off-list value is named')
})

test('Local Workspace twin: multiple: true round-trips through writeLocalDefinitionStructure / readLocalDefinitionStructure', async () => {
  // Minimal in-memory File System Access API stub — same shape tests/localDefinitionFiles.test.js's
  // own MemFileHandle/MemDirHandle use, duplicated here per this repo's established convention.
  class MemFileHandle {
    constructor(name) {
      this.kind = 'file'
      this.name = name
      this.bytes = new Uint8Array()
    }
    async getFile() {
      const bytes = this.bytes
      return {
        async text() { return new TextDecoder().decode(bytes) },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      }
    }
    async createWritable() {
      const handle = this
      return {
        async write(data) {
          if (typeof data === 'string') handle.bytes = new TextEncoder().encode(data)
          else if (data instanceof Uint8Array) handle.bytes = data
          else if (data instanceof ArrayBuffer) handle.bytes = new Uint8Array(data)
          else handle.bytes = new Uint8Array(0)
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

  const withMultiple = {
    ...blankLocalDefinitionStructure('multiselect-local', 'MultiSelect Local'),
    stages: STRUCTURE.stages,
    artefacts: STRUCTURE.artefacts,
    modules: STRUCTURE.modules,
  }

  const handle = new MemDirHandle()
  await writeLocalDefinitionStructure(handle, 'multiselect-local', 1, withMultiple)
  const read = await readLocalDefinitionStructure(handle, 'multiselect-local', 1)
  const field = read.modules[0].fields.find((f) => f.id === 'checks')
  assert.equal(field.multiple, true)
  assert.deepEqual(field.options, ['Police check', 'Reference check', 'Right-to-work check'])
})
