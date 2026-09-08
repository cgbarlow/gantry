import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInstance, writeModule } from '../lib/instance.js'
import { loadDefinition, definitionVersionProjection } from '../lib/definition.js'
import { getStatus } from '../lib/status.js'
import { checkGate, formatGateOutstanding } from '../lib/check.js'
import { validateDefinition } from '../lib/validate.js'
import { withScratchInstances } from './helpers/lifecycle.js'

import { writeTextFile } from '../web/lib/localWorkspace.js'
import {
  getLocalStatus,
  checkLocalGate,
  resolveLocalCheckStage,
  formatLocalGateOutstanding,
  findLocalDefinitionProblems,
  validateLocalDefinition,
  splitLocalArtefactRequirement,
  readLocalModuleData,
} from '../web/lib/localStatus.js'

// ---------------------------------------------------------------------------
// In-memory File System Access API stub — the same minimal shape
// tests/localWorkspace.test.js uses for `web/lib/localWorkspace.js`'s own
// tests; duplicated here rather than shared (this repo's established
// convention for web/lib helpers, see web/lib/localInstanceFiles.js's own
// header comment) so this file has no test-only coupling to that one.
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
    }
  }

  async createWritable() {
    const handle = this
    return {
      async write(data) {
        handle.bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
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
}

// Populates an in-memory directory handle's `gantry-workspace/<slug>/modules/*.md`
// from whatever real `.md` files exist on disk at `instancesDir/<slug>/modules` —
// the bridge between this suite's disk-backed server-side fixtures (`createInstance`,
// `writeModule`, real repo instances) and the FSA-backed client-side functions
// under test, so both sides evaluate byte-identical file content.
async function memHandleFromInstance(instancesDir, slug) {
  const root = new MemDirHandle()
  const modulesDir = join(instancesDir, slug, 'modules')
  let names = []
  try {
    names = readdirSync(modulesDir)
  } catch {
    names = []
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const text = readFileSync(join(modulesDir, name), 'utf8')
    await writeTextFile(root, `gantry-workspace/${slug}/modules/${name}`, text)
  }
  return root
}

function projectionFor(definitionId, options) {
  return definitionVersionProjection(loadDefinition(definitionId, options))
}

// ---------------------------------------------------------------------------
// getLocalStatus vs. lib/status.js's getStatus — same fixtures as
// tests/status.test.js, asserting the client-side result is byte-identical to
// the server-computed one (this ticket's acceptance criterion).
// ---------------------------------------------------------------------------

describe('getLocalStatus matches getStatus', () => {
  test('a freshly-created instance is incomplete, with every required field outstanding', async () => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const serverStatus = getStatus('my-initiative', { instancesDir })

      const structure = projectionFor('design')
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localStatus = await getLocalStatus(handle, 'my-initiative', structure, serverStatus.stage.id)

      assert.deepEqual(localStatus, serverStatus)
      assert.equal(localStatus.complete, false)
      const background = localStatus.modules.find((m) => m.id === 'background')
      assert.deepEqual(background.outstanding, ['problem', 'affected-domains'])
    })
  })

  test('a module with no file on disk is reported missing, with all required fields outstanding', async () => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'team-and-estimates.md'))
      const serverStatus = getStatus('my-initiative', { instancesDir })

      const structure = projectionFor('design')
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localStatus = await getLocalStatus(handle, 'my-initiative', structure, serverStatus.stage.id)

      assert.deepEqual(localStatus, serverStatus)
      const teamAndEstimates = localStatus.modules.find((m) => m.id === 'team-and-estimates')
      assert.equal(teamAndEstimates.exists, false)
      assert.deepEqual(teamAndEstimates.outstanding, ['teams-required', 'estimates'])
    })
  })

  test('the examples fixture is complete', async () => {
    const serverStatus = getStatus('examples')
    // instances/examples is pinned to `definitionVersion: 2` (WI #348) — the
    // projection must match, or the local and server views would diverge.
    const structure = projectionFor('design', { version: 2 })
    const handle = await memHandleFromInstance('instances', 'examples')
    const localStatus = await getLocalStatus(handle, 'examples', structure, serverStatus.stage.id)

    assert.deepEqual(localStatus, serverStatus)
    assert.equal(localStatus.complete, true)
    for (const mod of localStatus.modules) {
      assert.equal(mod.exists, true)
      assert.deepEqual(mod.outstanding, [])
    }
  })

  test('a stageId lets a caller evaluate a stage other than the instance\'s current one', async () => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const serverStatus = getStatus('my-initiative', { instancesDir, stageId: 'hld-define' })

      const structure = projectionFor('design')
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localStatus = await getLocalStatus(handle, 'my-initiative', structure, 'hld-define')

      assert.deepEqual(localStatus, serverStatus)
      assert.deepEqual(localStatus.stage, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' })
      const hldSubmission = localStatus.modules.find((m) => m.id === 'hld-submission')
      assert.equal(hldSubmission.exists, false)
    })
  })

  test('an unknown stageId throws', async () => {
    const structure = projectionFor('design')
    const handle = await memHandleFromInstance('instances', 'examples')
    await assert.rejects(() => getLocalStatus(handle, 'examples', structure, 'not-a-real-stage'), /has no stage/)
  })
})

// ---------------------------------------------------------------------------
// checkLocalGate vs. lib/check.js's checkGate — same fixtures/assertions as
// tests/check.test.js.
// ---------------------------------------------------------------------------

// Unlike tests/check.test.js's own version of this helper (whose callback is
// always synchronous), every callback here does async work (reads through
// the in-memory FSA handle) — so, unlike that one, this awaits `fn` inside
// the `try` before the `finally` cleans up, rather than returning its
// still-pending promise straight into an immediate synchronous `finally`.
async function withAnyArtefactDefinition(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-definition-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  const definitionsDir = join(root, 'definitions')
  const definitionDir = join(definitionsDir, 'any-artefact')
  const modulesDir = join(definitionDir, 'modules')
  mkdirSync(modulesDir, { recursive: true })
  writeFileSync(
    join(definitionDir, 'definition.yaml'),
    [
      'id: any-artefact',
      'title: Any Artefact',
      'stages:',
      '  - id: stage',
      '    title: Stage',
      '    gate: gate',
      '    modules: [light, heavy]',
      'artefacts:',
      '  - id: light',
      '    title: Light Artefact',
      '    template: light.md.tmpl',
      '    gate: gate',
      '    requires: [light]',
      '  - id: heavy',
      '    title: Heavy Artefact',
      '    template: heavy.md.tmpl',
      '    gate: gate',
      '    requires: [heavy]',
    ].join('\n')
  )
  for (const moduleId of ['light', 'heavy']) {
    writeFileSync(
      join(modulesDir, `${moduleId}.yaml`),
      `id: ${moduleId}\ntitle: ${moduleId[0].toUpperCase()}${moduleId.slice(1)}\nfields:\n  - id: content\n    title: Content\n    type: markdown\n    required: true\n`
    )
  }

  try {
    createInstance('any-artefact', 'my-initiative', { instancesDir, definitionsDir })
    return await fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function completeArtefactModule(definitionsDir, instancesDir, moduleId) {
  const definition = loadDefinition('any-artefact', { definitionsDir })
  writeModule(definition, 'my-initiative', moduleId, { status: 'agreed', owner: '', fields: { content: 'Complete.' } }, { instancesDir })
}

describe('checkLocalGate matches checkGate', () => {
  test('a gate with two different artefacts passes when either one is complete', async () => {
    await withAnyArtefactDefinition(async ({ instancesDir, definitionsDir }) => {
      completeArtefactModule(definitionsDir, instancesDir, 'light')
      const serverResult = checkGate('my-initiative', { instancesDir, definitionsDir })

      const structure = projectionFor('any-artefact', { definitionsDir })
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localResult = await checkLocalGate(handle, 'my-initiative', structure, 'stage')

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, true)
      assert.deepEqual(
        localResult.artefacts.map((a) => ({ id: a.id, complete: a.complete })),
        [
          { id: 'light', complete: true },
          { id: 'heavy', complete: false },
        ]
      )
    })
  })

  test('a gate with two different artefacts fails when neither artefact is complete and reports artefact-scoped outstanding data', async () => {
    await withAnyArtefactDefinition(async ({ instancesDir, definitionsDir }) => {
      unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'light.md'))
      unlinkSync(join(instancesDir, 'my-initiative', 'modules', 'heavy.md'))
      const serverResult = checkGate('my-initiative', { instancesDir, definitionsDir })

      const structure = projectionFor('any-artefact', { definitionsDir })
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localResult = await checkLocalGate(handle, 'my-initiative', structure, 'stage')

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, false)
      assert.equal(formatLocalGateOutstanding(localResult), formatGateOutstanding(serverResult))
      assert.equal(formatLocalGateOutstanding(localResult), 'Light Artefact: Light (file missing)')
    })
  })

  test('the identical SAD and SSAD requirements still pass both artefacts together', async () => {
    const serverResult = checkGate('examples', { gate: 'build-ready-checklist' })

    // instances/examples is pinned to `definitionVersion: 2` (WI #348).
    const structure = projectionFor('design', { version: 2 })
    const handle = await memHandleFromInstance('instances', 'examples')
    const localResult = await checkLocalGate(handle, 'examples', structure, 'shape', { gate: 'build-ready-checklist' })

    assert.deepEqual(localResult, serverResult)
    assert.equal(localResult.pass, true)
    assert.deepEqual(localResult.artefacts.map((a) => a.id), ['sad', 'ssad'])
  })

  test('identical SAD and SSAD requirements still fail together when their shared module data is missing', async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
      unlinkSync(join(instancesDir, 'examples', 'modules', 'architecture.md'))
      const serverResult = checkGate('examples', { instancesDir, gate: 'build-ready-checklist' })

      // Copied from instances/examples, so pinned to v2 like the fixture (WI #348).
      const structure = projectionFor('design', { version: 2 })
      const handle = await memHandleFromInstance(instancesDir, 'examples')
      const localResult = await checkLocalGate(handle, 'examples', structure, 'shape', { gate: 'build-ready-checklist' })

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, false)
      assert.deepEqual(
        localResult.artefacts.map((a) => ({ id: a.id, complete: a.complete })),
        [
          { id: 'sad', complete: false },
          { id: 'ssad', complete: false },
        ]
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })

  test('fails a freshly-created instance against its current stage, with every required field outstanding', async () => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const serverResult = checkGate('my-initiative', { instancesDir })

      const structure = projectionFor('design')
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localResult = await checkLocalGate(handle, 'my-initiative', structure, 'shape')

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, false)
      assert.equal(localResult.gate, 'business-case')
      const background = localResult.modules.find((m) => m.id === 'background')
      assert.deepEqual(background.outstanding, ['problem', 'affected-domains'])
    })
  })

  test('passes the examples fixture against its current stage', async () => {
    const serverResult = checkGate('examples')
    // instances/examples has no `definitionVersion`, so it resolves to v1 —
    // pinned here to match (WI #318).
    const structure = projectionFor('design', { version: 2 })
    const handle = await memHandleFromInstance('instances', 'examples')
    const localResult = await checkLocalGate(handle, 'examples', structure, 'shape')

    assert.deepEqual(localResult, serverResult)
    assert.equal(localResult.pass, true)
    assert.equal(localResult.complete, true)
  })

  test('--gate resolves the stage owning that gate, even when it is not the instance\'s current stage', async () => {
    const serverResult = checkGate('examples', { gate: 'hld-tac-approved' })
    // instances/examples has no `definitionVersion`, so it resolves to v1 —
    // pinned here to match (WI #318).
    const structure = projectionFor('design', { version: 2 })
    const handle = await memHandleFromInstance('instances', 'examples')
    const localResult = await checkLocalGate(handle, 'examples', structure, 'shape', { gate: 'hld-tac-approved' })

    assert.deepEqual(localResult, serverResult)
    assert.equal(localResult.stage.gate, 'hld-tac-approved')
  })

  test('an unknown --gate throws', async () => {
    const structure = projectionFor('design')
    const handle = await memHandleFromInstance('instances', 'examples')
    await assert.rejects(
      () => checkLocalGate(handle, 'examples', structure, 'shape', { gate: 'not-a-real-gate' }),
      /has no stage with gate/
    )
  })

  test('an unknown current stage throws', async () => {
    const structure = projectionFor('design')
    const handle = await memHandleFromInstance('instances', 'examples')
    await assert.rejects(
      () => checkLocalGate(handle, 'examples', structure, 'not-a-real-stage'),
      /is at unknown stage/
    )
  })

  test('a parser anomaly in a module file fails hard, via strict parsing, rather than passing silently', async () => {
    await withScratchInstances(async (instancesDir) => {
      createInstance('design', 'my-initiative', { instancesDir })
      const badText =
        '---\nmodule: background\nstatus: draft\nowner:\n---\n\n# Background and context\n\n## Problem statement\n\nFirst.\n\n## Problem statement\n\nSecond.\n'
      writeFileSync(join(instancesDir, 'my-initiative', 'modules', 'background.md'), badText)

      assert.throws(() => checkGate('my-initiative', { instancesDir }), /duplicate heading/)

      const structure = projectionFor('design')
      const handle = new MemDirHandle()
      await writeTextFile(handle, 'gantry-workspace/my-initiative/modules/background.md', badText)
      // Every other module for this stage is missing entirely from this
      // deliberately-partial handle — exercised for its own sake by the
      // "module with no file on disk" test above; here only background.md's
      // anomaly matters.
      await assert.rejects(
        () => checkLocalGate(handle, 'my-initiative', structure, 'shape'),
        /duplicate heading/
      )
    })
  })

  // Mirrors tests/check.test.js's own withOptionalRefDefinition-driven cases
  // — the `module.field?` branch of artefactRequirements (a field that's in
  // an artefact's scope but only gates when independently required at this
  // gate via `required-at`).
  function withOptionalRefDefinition(requires, fn) {
    const root = mkdtempSync(join(tmpdir(), 'gantry-definition-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    const definitionsDir = join(root, 'definitions')
    const definitionDir = join(definitionsDir, 'optref')
    const modulesDir = join(definitionDir, 'modules')
    mkdirSync(modulesDir, { recursive: true })
    writeFileSync(
      join(definitionDir, 'definition.yaml'),
      [
        'id: optref',
        'title: Opt Ref',
        'stages:',
        '  - id: stage',
        '    title: Stage',
        '    gate: gate',
        '    modules: [ctx]',
        'artefacts:',
        '  - id: doc',
        '    title: Doc',
        '    template: doc.md.tmpl',
        '    gate: gate',
        `    requires: [${requires.join(', ')}]`,
      ].join('\n')
    )
    writeFileSync(
      join(modulesDir, 'ctx.yaml'),
      [
        'id: ctx',
        'title: Ctx',
        'fields:',
        '  - id: driver',
        '    title: Driver',
        '    type: markdown',
        '    required: true',
        '  - id: extra',
        '    title: Extra',
        '    type: markdown',
        '    required: false',
        '  - id: late',
        '    title: Late',
        '    type: markdown',
        '    required-at: [gate]',
      ].join('\n')
    )
    try {
      createInstance('optref', 'my-initiative', { instancesDir, definitionsDir })
      return fn({ instancesDir, definitionsDir })
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }

  function writeCtx(definitionsDir, instancesDir, fields) {
    const definition = loadDefinition('optref', { definitionsDir })
    writeModule(definition, 'my-initiative', 'ctx', { status: 'agreed', owner: '', fields }, { instancesDir })
  }

  test('an optional field ref DOES fail the gate when the field is required there via required-at', async () => {
    await withOptionalRefDefinition(['ctx.driver', 'ctx.late?'], async ({ instancesDir, definitionsDir }) => {
      writeCtx(definitionsDir, instancesDir, { driver: 'Present.' })
      const serverResult = checkGate('my-initiative', { instancesDir, definitionsDir })

      const structure = projectionFor('optref', { definitionsDir })
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localResult = await checkLocalGate(handle, 'my-initiative', structure, 'stage')

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, false)
      assert.deepEqual(localResult.artefacts[0].outstanding, ['ctx.late'])
    })
  })

  test('an optional field ref passes once its required-at field is filled in', async () => {
    await withOptionalRefDefinition(['ctx.driver', 'ctx.late?'], async ({ instancesDir, definitionsDir }) => {
      writeCtx(definitionsDir, instancesDir, { driver: 'Present.', late: 'Also present.' })
      const serverResult = checkGate('my-initiative', { instancesDir, definitionsDir })

      const structure = projectionFor('optref', { definitionsDir })
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localResult = await checkLocalGate(handle, 'my-initiative', structure, 'stage')

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, true)
    })
  })

  // formatLocalGateOutstanding's module-level fallback (no artefact at all
  // matches the failed gate, so it falls through to reporting incomplete
  // modules by title) — a stage whose gate no artefact requires.
  test('formatLocalGateOutstanding falls back to incomplete module titles when no artefact matches the gate', async () => {
    await withOptionalRefDefinition(['ctx.driver'], async ({ instancesDir, definitionsDir }) => {
      // The artefact's own gate is "gate"; check a different gate that no
      // artefact requires, so `checkResult.artefacts` is empty and the
      // fallback (module-level) branch is what has to report the failure.
      const definitionDir = join(definitionsDir, 'optref')
      writeFileSync(
        join(definitionDir, 'definition.yaml'),
        [
          'id: optref',
          'title: Opt Ref',
          'stages:',
          '  - id: stage',
          '    title: Stage',
          '    gate: gate',
          '    modules: [ctx]',
          '  - id: other-stage',
          '    title: Other Stage',
          '    gate: other-gate',
          '    modules: [ctx]',
          'artefacts:',
          '  - id: doc',
          '    title: Doc',
          '    template: doc.md.tmpl',
          '    gate: gate',
          '    requires: [ctx.driver]',
        ].join('\n')
      )
      const serverResult = checkGate('my-initiative', { instancesDir, definitionsDir, gate: 'other-gate' })

      const structure = projectionFor('optref', { definitionsDir })
      const handle = await memHandleFromInstance(instancesDir, 'my-initiative')
      const localResult = await checkLocalGate(handle, 'my-initiative', structure, 'stage', { gate: 'other-gate' })

      assert.deepEqual(localResult, serverResult)
      assert.equal(localResult.pass, false)
      assert.deepEqual(localResult.artefacts, [])
      assert.equal(formatLocalGateOutstanding(localResult), formatGateOutstanding(serverResult))
      assert.equal(formatLocalGateOutstanding(localResult), 'Ctx')
    })
  })
})

// ---------------------------------------------------------------------------
// readLocalModuleData — the FSA-backed existence/parse split that keeps a
// genuine parse anomaly from being folded into "module missing".
// ---------------------------------------------------------------------------

describe('readLocalModuleData', () => {
  const structure = {
    id: 'd',
    stages: [{ id: 's', title: 'S', gate: 'g', modules: ['m'] }],
    artefacts: [],
    modules: [{ id: 'm', title: 'M', fields: [{ id: 'f', title: 'F', type: 'markdown' }] }],
  }

  test('a genuinely missing file is reported as not-existing, not thrown', async () => {
    const handle = new MemDirHandle()
    const data = await readLocalModuleData(handle, 'slug', structure.stages[0], structure, { strict: true })
    assert.equal(data.get('m').exists, false)
    assert.deepEqual(data.get('m').fields, {})
  })

  test('an existing file with a strict-mode parser anomaly throws, rather than being read as missing', async () => {
    const handle = new MemDirHandle()
    const badText = '---\nmodule: m\nstatus: draft\nowner:\n---\n\n## F\n\nFirst.\n\n## F\n\nSecond.\n'
    await writeTextFile(handle, 'gantry-workspace/slug/modules/m.md', badText)

    await assert.rejects(
      () => readLocalModuleData(handle, 'slug', structure.stages[0], structure, { strict: true }),
      /duplicate heading/
    )

    // Non-strict: the same anomaly is folded into a warning, not a throw,
    // and the module still reports as present.
    const data = await readLocalModuleData(handle, 'slug', structure.stages[0], structure, { strict: false })
    assert.equal(data.get('m').exists, true)
  })
})

// ---------------------------------------------------------------------------
// splitLocalArtefactRequirement — pure port of lib/definition.js's
// splitArtefactRequirement.
// ---------------------------------------------------------------------------

describe('splitLocalArtefactRequirement', () => {
  test('a bare module reference has no fieldId and is not optional', () => {
    assert.deepEqual(splitLocalArtefactRequirement('background'), { moduleId: 'background', fieldId: undefined, optional: false })
  })

  test('a module.field reference splits on the dot', () => {
    assert.deepEqual(splitLocalArtefactRequirement('ctx.driver'), { moduleId: 'ctx', fieldId: 'driver', optional: false })
  })

  test('a trailing "?" marks a field reference optional', () => {
    assert.deepEqual(splitLocalArtefactRequirement('ctx.driver?'), { moduleId: 'ctx', fieldId: 'driver', optional: true })
  })
})

// ---------------------------------------------------------------------------
// validateLocalDefinition / findLocalDefinitionProblems vs. lib/validate.js's
// validateDefinition / lib/definition.js's findDefinitionProblems.
// ---------------------------------------------------------------------------

describe('validateLocalDefinition matches validateDefinition', () => {
  test('the real design definition has no problems', () => {
    const serverResult = validateDefinition('design')
    const structure = projectionFor('design')
    const localResult = validateLocalDefinition(structure)

    assert.equal(localResult.valid, true)
    assert.deepEqual(localResult.problems, [])
    assert.equal(localResult.valid, serverResult.valid)
  })
})

describe('findLocalDefinitionProblems', () => {
  function baseStructure(overrides = {}) {
    return {
      id: 'broken',
      stages: [{ id: 'only', title: 'Only', gate: 'g', modules: ['thing'] }],
      artefacts: [],
      modules: [{ id: 'thing', title: 'Thing', fields: [{ id: 'whatsit', title: 'Whatsit', type: 'markdown' }] }],
      ...overrides,
    }
  }

  test('reports a missing module reference', () => {
    const structure = baseStructure({ stages: [{ id: 'only', title: 'Only', gate: 'g', modules: ['nope'] }], modules: [] })
    const problems = findLocalDefinitionProblems(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'missing-module')
    assert.match(problems[0].message, /references module "nope"/)
  })

  test('reports an unknown field type', () => {
    const structure = baseStructure({
      modules: [{ id: 'thing', title: 'Thing', fields: [{ id: 'whatsit', title: 'Whatsit', type: 'freeform' }] }],
    })
    const problems = findLocalDefinitionProblems(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'unknown-field-type')
    assert.match(problems[0].message, /unknown type "freeform"/)
  })

  test('reports a required/required-at mutual-exclusivity violation', () => {
    const structure = baseStructure({
      modules: [{ id: 'thing', title: 'Thing', fields: [{ id: 'whatsit', title: 'Whatsit', type: 'markdown', required: true, requiredAt: ['g'] }] }],
    })
    const problems = findLocalDefinitionProblems(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'mutually-exclusive-required')
    assert.match(problems[0].message, /mutually exclusive/)
  })

  test('accepts an optional module.field? requires entry', () => {
    const structure = baseStructure({
      artefacts: [{ id: 'art', title: 'Art', template: 't.md.tmpl', gate: 'g', requires: ['thing.whatsit?'] }],
    })
    assert.deepEqual(findLocalDefinitionProblems(structure), [])
  })

  test('rejects "?" on a whole-module requires entry', () => {
    const structure = baseStructure({
      artefacts: [{ id: 'art', title: 'Art', template: 't.md.tmpl', gate: 'g', requires: ['thing?'] }],
    })
    const problems = findLocalDefinitionProblems(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'optional-whole-module')
    assert.match(problems[0].message, /only valid on a field reference/)
  })

  test('rejects "?" on an unknown field', () => {
    const structure = baseStructure({
      artefacts: [{ id: 'art', title: 'Art', template: 't.md.tmpl', gate: 'g', requires: ['thing.nope?'] }],
    })
    const problems = findLocalDefinitionProblems(structure)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].type, 'missing-field')
    assert.match(problems[0].message, /requires field "thing.nope\?"/)
  })

  test('reports every problem in one pass, not just the first', () => {
    const structure = {
      id: 'very-broken',
      stages: [{ id: 'only', title: 'Only', gate: 'g', modules: ['nope', 'thing'] }],
      artefacts: [{ id: 'art', title: 'Art', template: 't.md.tmpl', gate: 'g', requires: ['also-nope'] }],
      modules: [
        {
          id: 'thing',
          title: 'Thing',
          fields: [
            { id: 'whatsit', title: 'Whatsit', type: 'freeform' },
            { id: 'other', title: 'Other', type: 'markdown', required: true, requiredAt: ['g'] },
          ],
        },
      ],
    }
    const problems = findLocalDefinitionProblems(structure)
    assert.equal(problems.length, 4)
    assert.deepEqual(
      problems.map((p) => p.type).sort(),
      ['missing-module', 'missing-module', 'mutually-exclusive-required', 'unknown-field-type']
    )
  })
})

// ---------------------------------------------------------------------------
// resolveLocalCheckStage — direct coverage of lib/check.js's
// resolveCheckStage port, beyond what checkLocalGate's own tests exercise.
// ---------------------------------------------------------------------------

describe('resolveLocalCheckStage', () => {
  test('defaults to the instance\'s current stage when no gate is given', () => {
    const structure = projectionFor('design')
    const stage = resolveLocalCheckStage(structure, 'shape', 'my-initiative', {})
    assert.equal(stage.id, 'shape')
  })

  test('resolves any stage owning the requested gate', () => {
    const structure = projectionFor('design')
    const stage = resolveLocalCheckStage(structure, 'shape', 'my-initiative', { gate: 'hld-tac-approved' })
    assert.equal(stage.id, 'hld-define')
  })
})
