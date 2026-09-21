import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBlankDefinition,
  writeDefinitionVersion,
  publishDefinitionVersion,
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblems,
} from '../lib/definition.js'
import { createInstance, writeModule, readModule } from '../lib/instance.js'
import { checkGate } from '../lib/check.js'
import { evaluateLocalStage, findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import {
  blankLocalDefinitionStructure,
  writeLocalDefinitionStructure,
  readLocalDefinitionStructure,
} from '../web/lib/localDefinitionFiles.js'
import { renderArtefact } from '../lib/render.js'

// #85 (ADR-0044): `text` (a single-line string) and `date` (a calendar date, stored as ISO
// 8601 YYYY-MM-DD) — the two short single-line field types the filename work (#87) needs.

const STRUCTURE = {
  id: 'textdate-fixture',
  title: 'TextDate Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['candidate'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: ['candidate.name', 'candidate.start-date'] }],
  modules: [
    {
      id: 'candidate',
      title: 'Candidate',
      purpose: 'Who and when',
      fields: [
        { id: 'name', title: 'Candidate name', type: 'text', required: true },
        { id: 'start-date', title: 'Start date', type: 'date', required: true },
      ],
    },
  ],
}

function withFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-textdate-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-textdate-'))
  try {
    createBlankDefinition('textdate-fixture', { definitionsDir })
    writeDefinitionVersion('textdate-fixture', 1, STRUCTURE, { definitionsDir })
    publishDefinitionVersion('textdate-fixture', 1, { definitionsDir })
    return fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('text and date load, and round-trip through the projection round trip', () => {
  withFixture(({ definitionsDir }) => {
    const def = loadDefinition('textdate-fixture', { definitionsDir })
    const name = def.modules.get('candidate').fields.find((f) => f.id === 'name')
    const startDate = def.modules.get('candidate').fields.find((f) => f.id === 'start-date')
    assert.equal(name.type, 'text')
    assert.equal(startDate.type, 'date')

    createBlankDefinition('textdate-fixture-v2-host', { definitionsDir })
    writeDefinitionVersion('textdate-fixture-v2-host', 1, definitionVersionProjection(def), { definitionsDir })
    publishDefinitionVersion('textdate-fixture-v2-host', 1, { definitionsDir })
    const reloaded = loadDefinition('textdate-fixture-v2-host', { definitionsDir })
    assert.equal(reloaded.modules.get('candidate').fields.find((f) => f.id === 'name').type, 'text')
    assert.equal(reloaded.modules.get('candidate').fields.find((f) => f.id === 'start-date').type, 'date')
  })
})

test('findDefinitionProblems accepts text and date fields with no problems', () => {
  withFixture(({ definitionsDir }) => {
    const problems = findDefinitionProblems('textdate-fixture', { definitionsDir })
    assert.deepEqual(problems, [])
  })
})

test('findLocalDefinitionProblems (Local Workspace twin) accepts text and date fields with no problems', () => {
  withFixture(({ definitionsDir }) => {
    const def = loadDefinition('textdate-fixture', { definitionsDir })
    const problems = findLocalDefinitionProblems(definitionVersionProjection(def))
    assert.deepEqual(problems, [])
  })
})

test('an unrecognised field type is still rejected, naming text/date among the valid ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-definition-'))
  try {
    const defDir = join(root, 'definitions', 'bad-type')
    mkdirSync(join(defDir, 'modules'), { recursive: true })
    writeFileSync(
      join(defDir, 'definition.yaml'),
      'id: bad-type\ntitle: Bad Type\nstages:\n  - id: only\n    title: Only\n    gate: g\n    modules: [candidate]\nartefacts: []\n'
    )
    writeFileSync(
      join(defDir, 'modules', 'candidate.yaml'),
      'id: candidate\ntitle: Candidate\nfields:\n  - id: name\n    title: Name\n    type: bogus\n'
    )
    assert.throws(
      () => loadDefinition('bad-type', { definitionsDir: join(root, 'definitions') }),
      /expected "markdown", "list", "select", "text" or "date"/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a text value stores one line and a date value stores YYYY-MM-DD, both round-tripping through writeModule/readModule', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-demo', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })

    writeModule(definition, 'textdate-demo', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-11-03' },
    }, { instancesDir })

    const onDisk = readModule(definition, 'textdate-demo', 'candidate', { instancesDir })
    assert.equal(onDisk.fields.name, 'Jane Smith')
    assert.equal(onDisk.fields['start-date'], '2026-11-03')

    const result = checkGate('textdate-demo', { instancesDir, definitionsDir })
    assert.equal(result.pass, true)
    assert.deepEqual(result.warnings, [])
  })
})

test('a malformed date value is reported by check as a warning, and the gate still passes', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-bad-date', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })

    writeModule(definition, 'textdate-bad-date', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-02-30' },
    }, { instancesDir })

    const result = checkGate('textdate-bad-date', { instancesDir, definitionsDir })
    assert.equal(result.pass, true, 'a malformed date does not block the Gate')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /field "Start date"/)
    assert.match(result.warnings[0], /"2026-02-30"/)
    assert.match(result.warnings[0], /not a valid date/)
  })
})

test('a non-ISO-shaped date value ("3 November 2026") is also reported by check', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-shape', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })

    writeModule(definition, 'textdate-shape', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '3 November 2026' },
    }, { instancesDir })

    const result = checkGate('textdate-shape', { instancesDir, definitionsDir })
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /"3 November 2026"/)
  })
})

test('an empty date value produces no warning', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-empty', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })

    writeModule(definition, 'textdate-empty', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '' },
    }, { instancesDir })

    const result = checkGate('textdate-empty', { instancesDir, definitionsDir })
    assert.deepEqual(result.warnings, [])
  })
})

test('a valid ISO date produces no warning', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-valid', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })

    writeModule(definition, 'textdate-valid', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-11-03' },
    }, { instancesDir })

    const result = checkGate('textdate-valid', { instancesDir, definitionsDir })
    assert.deepEqual(result.warnings, [])
  })
})

// Local Workspace twin (web/lib/localStatus.js's evaluateLocalStage) — same malformed-date
// warning, computed purely over an in-memory structure/moduleData, no disk involved.
test('evaluateLocalStage (Local Workspace twin) reports the identical malformed-date warning', () => {
  const stage = STRUCTURE.stages[0]
  const moduleData = new Map([['candidate', { exists: true, fields: { name: 'Jane Smith', 'start-date': '2026-02-30' } }]])

  const result = evaluateLocalStage(STRUCTURE, stage, moduleData)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /field "Start date"/)
  assert.match(result.warnings[0], /"2026-02-30"/)
})

test('evaluateLocalStage (Local Workspace twin): a valid date produces no warning', () => {
  const stage = STRUCTURE.stages[0]
  const moduleData = new Map([['candidate', { exists: true, fields: { name: 'Jane Smith', 'start-date': '2026-11-03' } }]])

  const result = evaluateLocalStage(STRUCTURE, stage, moduleData)
  assert.deepEqual(result.warnings, [])
})

test('Local Workspace twin: text and date round-trip through writeLocalDefinitionStructure / readLocalDefinitionStructure', async () => {
  // Minimal in-memory File System Access API stub — same shape
  // tests/typedFieldsMultiSelect.test.js's own MemFileHandle/MemDirHandle use, duplicated here
  // per this repo's established convention.
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

  const structure = {
    ...blankLocalDefinitionStructure('textdate-local', 'TextDate Local'),
    stages: STRUCTURE.stages,
    artefacts: STRUCTURE.artefacts,
    modules: STRUCTURE.modules,
  }

  const handle = new MemDirHandle()
  await writeLocalDefinitionStructure(handle, 'textdate-local', 1, structure)
  const read = await readLocalDefinitionStructure(handle, 'textdate-local', 1)
  const name = read.modules[0].fields.find((f) => f.id === 'name')
  const startDate = read.modules[0].fields.find((f) => f.id === 'start-date')
  assert.equal(name.type, 'text')
  assert.equal(startDate.type, 'date')
})

// Template helper: formatDate (#85, ADR-0044) — reads the stored ISO value as unambiguous
// long-form English without a second stored value ever existing to disagree with the first.
test('templates can format a date value for human reading with formatDate(), without changing what is stored', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-render', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })
    writeModule(definition, 'textdate-render', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-11-03' },
    }, { instancesDir })

    const templatePath = join(definitionsDir, 'textdate-fixture', '1', 'templates', 'summary.md.tmpl')
    mkdirSync(join(definitionsDir, 'textdate-fixture', '1', 'templates'), { recursive: true })
    writeFileSync(templatePath, '# Summary\n\nName: <%~ it.modules.candidate.name %>\nStart date: <%~ formatDate(it.modules.candidate["start-date"]) %>\n')

    const result = renderArtefact('textdate-render', 'summary', { dryRun: true, instancesDir, definitionsDir })
    assert.match(result.markdown, /Name: Jane Smith/)
    assert.match(result.markdown, /Start date: 3 November 2026/)

    // What's stored on disk is unchanged — still ISO.
    const onDisk = readModule(definition, 'textdate-render', 'candidate', { instancesDir })
    assert.equal(onDisk.fields['start-date'], '2026-11-03')
  })
})

test('formatDate() passes through an unparseable or malformed date unchanged', () => {
  withFixture(({ definitionsDir, instancesDir }) => {
    createInstance('textdate-fixture', 'textdate-render-bad', { definitionsDir, instancesDir })
    const definition = loadDefinition('textdate-fixture', { definitionsDir })
    writeModule(definition, 'textdate-render-bad', 'candidate', {
      status: 'draft',
      owner: '',
      fields: { name: 'Jane Smith', 'start-date': '2026-02-30' },
    }, { instancesDir })

    const templatePath = join(definitionsDir, 'textdate-fixture', '1', 'templates', 'summary.md.tmpl')
    mkdirSync(join(definitionsDir, 'textdate-fixture', '1', 'templates'), { recursive: true })
    writeFileSync(templatePath, 'Start date: <%~ formatDate(it.modules.candidate["start-date"]) %>\n')

    const result = renderArtefact('textdate-render-bad', 'summary', { dryRun: true, instancesDir, definitionsDir })
    assert.match(result.markdown, /Start date: 2026-02-30/)
  })
})
