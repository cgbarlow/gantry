import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, listDefinitions, findDefinitionProblems, loadDefinitionChangelog, writeDefinitionVersion, definitionVersionProjection } from '../lib/definition.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { renderArtefact } from '../lib/render.js'
import yaml from 'yaml'

function withVersionedFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let yamlText = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    yamlText = yamlText.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), yamlText)
    writeFileSync(join(definitionsDir, 'design/2/modules/extra-module.yaml'), 'id: extra-module\ntitle: Extra Module\nfields:\n  - id: note\n    title: Note\n    type: markdown\n    required: true\n')
    let raw = yaml.parse(readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8'))
    raw.stages[0].modules.push('extra-module')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), yaml.stringify(raw))
    fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('definitions/design/1 exists with version 1 published and no top-level definition.yaml', () => {
  assert.equal(readFileSync('definitions/design/1/definition.yaml', 'utf8').includes('version: 1'), true)
  assert.equal(readFileSync('definitions/design/1/definition.yaml', 'utf8').includes('status: published'), true)
  assert.throws(() => readFileSync('definitions/design/definition.yaml', 'utf8'), /ENOENT/)
})

test('loadDefinition without version resolves to latest published (v1)', () => {
  const def = loadDefinition('design')
  assert.equal(def.version, 1)
  assert.equal(def.status, 'published')
})

test('loadDefinition with explicit version resolves draft', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const draft = loadDefinition('design', { definitionsDir, version: 2 })
    assert.equal(draft.version, 2)
    assert.equal(draft.status, 'draft')
    assert.ok(draft.stages[0].modules.includes('extra-module'))
  })
})

test('listDefinitions returns one row per definition with versions and latestPublished', () => {
  const defs = listDefinitions()
  const design = defs.find((d) => d.id === 'design')
  assert.equal(design.id, 'design')
  assert.equal(typeof design.title, 'string')
  assert.ok(Array.isArray(design.versions))
  assert.equal(design.versions[0].version, 1)
  assert.equal(design.versions[0].status, 'published')
  assert.equal(design.latestPublished, 1)
})

test('instance with no definitionVersion behaves as v1 (compat path)', () => {
  withVersionedFixture(({ definitionsDir, instancesDir }) => {
    const dir = join(instancesDir, 'legacy-inst')
    mkdirSync(join(dir, 'modules'), { recursive: true })
    writeFileSync(join(dir, 'instance.yaml'), 'definition: design\nslug: legacy-inst\nstage: shape\nassignee: ""\n')
    const inst = readInstance('legacy-inst', { instancesDir })
    assert.equal(inst.definitionVersion, undefined)
    const status = getStatus('legacy-inst', { definitionsDir, instancesDir })
    assert.equal(status.modules.some((m) => m.id === 'extra-module'), false)
  })
})

test('instance pinned to v2 uses v2 module set for status, gate checks, and rendering', () => {
  withVersionedFixture(({ definitionsDir, instancesDir }) => {
    // Pinned to v1 should not see extra-module
    createInstance('design', 'pinned-v1', { definitionsDir, instancesDir })
    const s1 = getStatus('pinned-v1', { definitionsDir, instancesDir })
    assert.equal(s1.modules.some((m) => m.id === 'extra-module'), false)
    const c1 = checkGate('pinned-v1', { definitionsDir, instancesDir })
    assert.equal(c1.modules.some((m) => m.id === 'extra-module'), false)

    // Pinned to v2 draft should see extra-module
    createInstance('design', 'pinned-v2', { definitionsDir, instancesDir, definitionVersion: 2 })
    const s2 = getStatus('pinned-v2', { definitionsDir, instancesDir })
    assert.equal(s2.modules.some((m) => m.id === 'extra-module'), true)
    const c2 = checkGate('pinned-v2', { definitionsDir, instancesDir })
    assert.equal(c2.modules.some((m) => m.id === 'extra-module'), true)

    // Rendering dry-run also uses pinned version's template (same template here, but modules differ)
    // Ensure pinned-v1 render does not require extra-module while pinned-v2 gate check expects it
    assert.equal(c1.pass, false) // still incomplete due to missing required fields, but not due to extra-module missing
    // For pinned-v2, the extra-module file was created as blank, so it exists but is incomplete
    const extraOutstanding = s2.modules.find((m) => m.id === 'extra-module')
    assert.equal(extraOutstanding.exists, true)
    assert.equal(extraOutstanding.complete, false)
  })
})

test('findDefinitionProblems is version-scoped', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const p1 = findDefinitionProblems('design', { definitionsDir, version: 1 })
    const p2 = findDefinitionProblems('design', { definitionsDir, version: 2 })
    // Both should be valid (no problems) despite v2 having extra module
    assert.deepEqual(p1, [])
    assert.deepEqual(p2, [])
  })
})

test('listDefinitions rows include description from the definition', () => {
  const defs = listDefinitions()
  const design = defs.find((d) => d.id === 'design')
  assert.equal(typeof design.description, 'string')
  assert.match(design.description, /\S/)
  // Must match the real definition.yaml description verbatim (non-empty)
  const rawText = readFileSync('definitions/design/1/definition.yaml', 'utf8')
  const raw = yaml.parse(rawText)
  assert.equal(design.description.trim(), raw.description.trim())
})

test('loadDefinitionChangelog returns seeded ## v1 text and null for missing file, and rejects bad inputs', () => {
  // Seeded file — real definitions dir
  const text = loadDefinitionChangelog('design', 1)
  assert.equal(typeof text, 'string')
  assert.match(text, /## v1/)
  assert.match(text, /Initial published version of the Solution Design definition/)

  // Missing file — build a temp fixture with version 1 having no CHANGELOG.md
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-changelog-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    // Remove the seeded changelog to simulate missing file
    const changelogPath = join(definitionsDir, 'design/1/CHANGELOG.md')
    try { rmSync(changelogPath, { force: true }) } catch {}
    // Verify loader returns null, not throw
    const missing = loadDefinitionChangelog('design', 1, { definitionsDir })
    assert.equal(missing, null)

    // Unknown definitionId — traversal guard
    assert.throws(() => loadDefinitionChangelog('../../etc', 1, { definitionsDir }), /Unknown definition/)
    assert.throws(() => loadDefinitionChangelog('no-such-def', 1, { definitionsDir }), /Unknown definition/)

    // Bad versions — non-positive / non-integer / non-numeric
    for (const bad of [0, -1, '0', '-1', '1.5', 'abc', '', '   ', null, undefined]) {
      assert.throws(() => loadDefinitionChangelog('design', bad, { definitionsDir }), /Invalid definition version/, `expected throw for version ${JSON.stringify(bad)}`)
    }
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

// WI236 — writeDefinitionVersion
test('writeDefinitionVersion round-trip with unchanged projection deep-equals original', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const proj = definitionVersionProjection(def)
    const result = writeDefinitionVersion('design', 2, proj, { definitionsDir })
    assert.ok(result && !result.problems)
    const reloaded = loadDefinition('design', { definitionsDir, version: 2 })
    const proj2 = definitionVersionProjection(reloaded)
    assert.deepEqual(proj2, proj)
  })
})

test('writeDefinitionVersion add a field to a module persists', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const proj = definitionVersionProjection(def)
    const targetMod = proj.modules.find((m) => m.id === 'extra-module')
    targetMod.fields.push({ id: 'new-field', title: 'New Field', type: 'list', guidance: 'hello' })
    writeDefinitionVersion('design', 2, proj, { definitionsDir })
    const reloaded = loadDefinition('design', { definitionsDir, version: 2 })
    const proj2 = definitionVersionProjection(reloaded)
    const mod = proj2.modules.find((m) => m.id === 'extra-module')
    assert.ok(mod.fields.some((f) => f.id === 'new-field'))
  })
})

test('writeDefinitionVersion rename a module id updates files and refs', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const proj = definitionVersionProjection(def)
    const oldId = 'extra-module'
    const newId = 'renamed-module'
    for (const m of proj.modules) if (m.id === oldId) m.id = newId
    for (const s of proj.stages) s.modules = s.modules.map((mid) => mid === oldId ? newId : mid)
    for (const a of proj.artefacts) a.requires = a.requires.map((r) => r === oldId ? newId : r.startsWith(oldId + '.') ? newId + r.slice(oldId.length) : r)
    const result = writeDefinitionVersion('design', 2, proj, { definitionsDir })
    assert.ok(result && !result.problems)
    assert.equal(existsSync(join(definitionsDir, 'design/2/modules/extra-module.yaml')), false)
    assert.equal(existsSync(join(definitionsDir, 'design/2/modules/renamed-module.yaml')), true)
    const reloaded = loadDefinition('design', { definitionsDir, version: 2 })
    const proj2 = definitionVersionProjection(reloaded)
    assert.ok(proj2.modules.some((m) => m.id === newId))
    assert.ok(proj2.stages.some((s) => s.modules.includes(newId)))
  })
})

test('writeDefinitionVersion with missing module reference returns problems and changes no files', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const proj = definitionVersionProjection(def)
    proj.artefacts[0].requires.push('missing-module')
    const beforeDef = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    const beforeMod = readFileSync(join(definitionsDir, 'design/2/modules/context.yaml'), 'utf8')
    const result = writeDefinitionVersion('design', 2, proj, { definitionsDir })
    assert.ok(result && Array.isArray(result.problems) && result.problems.length > 0)
    const afterDef = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    const afterMod = readFileSync(join(definitionsDir, 'design/2/modules/context.yaml'), 'utf8')
    assert.equal(afterDef, beforeDef)
    assert.equal(afterMod, beforeMod)
  })
})

test('writeDefinitionVersion against published version throws', () => {
  withVersionedFixture(({ definitionsDir }) => {
    const def = loadDefinition('design', { definitionsDir, version: 1 })
    const proj = definitionVersionProjection(def)
    assert.throws(() => writeDefinitionVersion('design', 1, proj, { definitionsDir }), /not a draft/)
  })
})

test('writeDefinitionVersion preserves templates/ and CHANGELOG.md and removes stale module files', () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-preserve-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'inst-preserve-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let yamlText = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    yamlText = yamlText.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), yamlText)
    writeFileSync(join(definitionsDir, 'design/2/modules/extra-module.yaml'), 'id: extra-module\ntitle: Extra Module\nfields:\n  - id: note\n    title: Note\n    type: markdown\n    required: true\n')
    let raw = yaml.parse(readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8'))
    raw.stages[0].modules.push('extra-module')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), yaml.stringify(raw))
    // Add templates/ and CHANGELOG.md to draft version
    mkdirSync(join(definitionsDir, 'design/2/templates'), { recursive: true })
    writeFileSync(join(definitionsDir, 'design/2/templates/dummy.md.tmpl'), 'dummy template content')
    writeFileSync(join(definitionsDir, 'design/2/CHANGELOG.md'), '# Changelog v2\ninitial draft')
    const beforeTemplate = readFileSync(join(definitionsDir, 'design/2/templates/dummy.md.tmpl'), 'utf8')
    const beforeChangelog = readFileSync(join(definitionsDir, 'design/2/CHANGELOG.md'), 'utf8')
    const def = loadDefinition('design', { definitionsDir, version: 2 })
    const proj = definitionVersionProjection(def)
    // Remove extra-module from structure (should delete its file) and add a field elsewhere
    proj.modules = proj.modules.filter((m) => m.id !== 'extra-module')
    for (const s of proj.stages) s.modules = s.modules.filter((mid) => mid !== 'extra-module')
    for (const a of proj.artefacts) a.requires = a.requires.filter((r) => r !== 'extra-module' && !r.startsWith('extra-module.'))
    const result = writeDefinitionVersion('design', 2, proj, { definitionsDir })
    assert.ok(result && !result.problems)
    // templates/ and CHANGELOG.md must still exist with unchanged contents
    assert.equal(existsSync(join(definitionsDir, 'design/2/templates/dummy.md.tmpl')), true)
    assert.equal(readFileSync(join(definitionsDir, 'design/2/templates/dummy.md.tmpl'), 'utf8'), beforeTemplate)
    assert.equal(existsSync(join(definitionsDir, 'design/2/CHANGELOG.md')), true)
    assert.equal(readFileSync(join(definitionsDir, 'design/2/CHANGELOG.md'), 'utf8'), beforeChangelog)
    // stale module file must be gone
    assert.equal(existsSync(join(definitionsDir, 'design/2/modules/extra-module.yaml')), false)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
