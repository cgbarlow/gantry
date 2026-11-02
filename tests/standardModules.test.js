import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblems,
  findDefinitionProblemsInStructure,
  writeDefinitionVersion,
  publishDefinitionVersion,
} from '../lib/definition.js'
import { renderArtefact } from '../lib/render.js'
import { findLocalDefinitionProblems, getLocalStatus } from '../web/lib/localStatus.js'
import { renderDefinitionYaml } from '../web/lib/localDefinitionFiles.js'
import {
  STANDARD_MODULES,
  listStandardModules,
  resolveStandardModule,
  standardModuleProblems,
  standardModuleVersions,
} from '../web/lib/standardModules.js'

// #283 (ADR-0065): **standard modules** — Glossary and Open questions — are Modules Gantry provides,
// with a fixed id, Field shape and version. A Definition mounts a named version on the Stages it
// chooses and may add guidance and Interview instructions, but cannot change the shape. A Gantry
// release adds a version beside the old ones, so a published Definition renders the same forever.

const COMMIT = { sha: '0000000000000000000000000000000000000000', shortSha: '0000000', branch: 'main', date: '2026-01-01T00:00:00Z' }

function definitionYaml({ mounts = '', stageModules = ['notes', 'glossary', 'open-questions'], requires = ['notes', 'glossary', 'open-questions'], status = 'published' } = {}) {
  return `id: std
version: 1
status: ${status}
title: Standard
description: Mounts standard modules
${mounts}stages:
  - id: shape
    title: Shape
    purpose: Shape it
    gate: shaped
    modules: [${stageModules.join(', ')}]
artefacts:
  - id: doc
    title: Document
    purpose: The document
    template: templates/doc.md.tmpl
    gate: shaped
    requires: [${requires.join(', ')}]
`
}

const MOUNTS = `standard-modules:
  - id: glossary
    version: 1
    guidance: Use New Zealand spellings.
    interview: Ask which product names the client still uses.
  - id: open-questions
    version: 1
`

const NOTES_MODULE = `id: notes
title: Notes
purpose: Notes
fields:
  - id: body
    title: Body
    type: markdown
    required: true
`

const TEMPLATE = `# Doc

## Notes

<%~ it.modules.notes.body %>

## Terms

<%~ it.modules.glossary.terms %>

## Questions

<%~ it.modules['open-questions'].questions %>
`

function writeDefinition(definitionsDir, yaml, { ownModules = { notes: NOTES_MODULE } } = {}) {
  const dir = join(definitionsDir, 'std', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), yaml)
  writeFileSync(join(dir, 'templates', 'doc.md.tmpl'), TEMPLATE)
  for (const [id, text] of Object.entries(ownModules)) writeFileSync(join(dir, 'modules', `${id}.yaml`), text)
}

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'standard-modules-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  mkdirSync(definitionsDir)
  mkdirSync(instancesDir)
  return Promise.resolve(fn({ root, definitionsDir, instancesDir })).finally(() => rmSync(root, { recursive: true, force: true }))
}

function writeInstance(instancesDir, { terms = '| Term | Meaning | Avoid |\n| --- | --- | --- |\n| Mooring | The berth | Dock |', questions = '| Question | Who resolves | By when | Status |\n| --- | --- | --- | --- |\n| Who signs? | Chair | Friday | Open |' } = {}) {
  const dir = join(instancesDir, 'harbour')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  writeFileSync(join(dir, 'instance.yaml'), 'definition: std\nslug: harbour\nname: Harbour\nstage: shape\nassignee: a.person\ndefinitionVersion: 1\n')
  writeFileSync(join(dir, 'modules', 'notes.md'), '---\nmodule: notes\nstatus: agreed\nowner: a.person\n---\n# Notes\n\n## Body\n\nSome notes.\n')
  writeFileSync(join(dir, 'modules', 'glossary.md'), `---\nmodule: glossary\nstatus: agreed\nowner: a.person\n---\n# Glossary\n\n## Terms and definitions\n\n${terms}\n`)
  writeFileSync(join(dir, 'modules', 'open-questions.md'), `---\nmodule: open-questions\nstatus: agreed\nowner: a.person\n---\n# Open questions\n\n## Open questions\n\n${questions}\n`)
}

// ---------- the catalogue ----------

test('Gantry provides Glossary and Open questions, each at version 1', () => {
  assert.deepEqual(Object.keys(STANDARD_MODULES), ['glossary', 'open-questions'])
  assert.deepEqual(standardModuleVersions('glossary'), [1])
  assert.deepEqual(standardModuleVersions('open-questions'), [1])
  assert.deepEqual(standardModuleVersions('no-such-module'), [])
  assert.deepEqual(listStandardModules().map((m) => [m.id, m.title, m.versions.map((v) => v.version)]), [
    ['glossary', 'Glossary', [1]],
    ['open-questions', 'Open questions', [1]],
  ])
})

// A released version never changes: this pins version 1's exact shape, so editing it in place (rather
// than adding a version 2) fails the build. If you mean to change a shape, add a version.
test('version 1 of each standard module is frozen: its id, Fields, types and table columns', () => {
  const glossary = STANDARD_MODULES.glossary.versions[1]
  assert.deepEqual(glossary.fields.map((f) => [f.id, f.title, f.type, f.required, f.requiredAt]), [['terms', 'Terms and definitions', 'markdown', undefined, undefined]])
  assert.match(glossary.fields[0].guidance, /Preferred term \| Definition \| Avoid/)
  assert.deepEqual(glossary.fields[0].targetWords, { small: 140, medium: 275, large: 460 })

  const questions = STANDARD_MODULES['open-questions'].versions[1]
  assert.deepEqual(questions.fields.map((f) => [f.id, f.title, f.type, f.required, f.requiredAt]), [['questions', 'Open questions', 'markdown', undefined, undefined]])
  assert.match(questions.fields[0].guidance, /Question \| Who resolves \| By when \| Status/)
  assert.deepEqual(questions.fields[0].targetWords, { small: 85, medium: 175, large: 290 })

  assert.equal(Object.isFrozen(glossary), true)
  assert.equal(Object.isFrozen(glossary.fields[0]), true)
  assert.throws(() => { 'use strict'; glossary.fields[0].title = 'Changed' }, TypeError)
})

test('a mount resolves to an ordinary Module: guidance added after Gantry\'s, Interview instructions carried', () => {
  const plain = resolveStandardModule({ id: 'glossary', version: 1 })
  assert.deepEqual(plain.standard, { version: 1 })
  assert.equal(plain.fields[0].guidance, STANDARD_MODULES.glossary.versions[1].fields[0].guidance)
  assert.equal(plain.interview, undefined)

  const added = resolveStandardModule({ id: 'glossary', version: 1, guidance: 'Use New Zealand spellings.', interview: 'Ask for legacy names.' })
  assert.equal(added.fields[0].guidance, `${plain.fields[0].guidance}\n\nUse New Zealand spellings.`)
  assert.equal(added.interview, 'Ask for legacy names.')
  assert.equal(added.title, 'Glossary')
  // Resolving never edits the catalogue.
  assert.equal(STANDARD_MODULES.glossary.versions[1].fields[0].guidance, plain.fields[0].guidance)

  assert.equal(resolveStandardModule({ id: 'glossary', version: 9 }), undefined)
  assert.equal(resolveStandardModule({ id: 'nope', version: 1 }), undefined)
})

// ---------- mounting: a Definition mounts by version on chosen stages; they edit and render like any module ----------

test('a Definition mounts Glossary and Open questions by version, and they load like any Module', () =>
  withScratch(({ definitionsDir }) => {
    writeDefinition(definitionsDir, definitionYaml({ mounts: MOUNTS }))
    assert.deepEqual(findDefinitionProblems('std', { definitionsDir }), [])

    const def = loadDefinition('std', { definitionsDir })
    assert.deepEqual(def.stages[0].modules, ['notes', 'glossary', 'open-questions'])
    const glossary = def.modules.get('glossary')
    assert.equal(glossary.title, 'Glossary')
    assert.deepEqual(glossary.fields.map((f) => f.id), ['terms'])
    assert.deepEqual(glossary.standard, { version: 1 })
    assert.match(glossary.fields[0].guidance, /Use New Zealand spellings\.$/)
    assert.equal(glossary.interview, 'Ask which product names the client still uses.')
    assert.deepEqual(def.modules.get('open-questions').fields.map((f) => f.id), ['questions'])
    assert.equal(def.modules.get('notes').standard, undefined)
    assert.deepEqual(def.standardModules, [
      { id: 'glossary', version: 1, guidance: 'Use New Zealand spellings.', interview: 'Ask which product names the client still uses.' },
      { id: 'open-questions', version: 1 },
    ])
  }))

test('a mounted standard module renders in an Artefact like any other module', () =>
  withScratch(({ definitionsDir, instancesDir }) => {
    writeDefinition(definitionsDir, definitionYaml({ mounts: MOUNTS }))
    writeInstance(instancesDir)
    const { markdown } = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir, instancesDir, commit: COMMIT })
    assert.match(markdown, /## Terms\n\n\| Term \| Meaning \| Avoid \|/)
    assert.match(markdown, /\| Mooring \| The berth \| Dock \|/)
    assert.match(markdown, /\| Who signs\? \| Chair \| Friday \| Open \|/)
  }))

test('the Definitions page projection lists the mounts apart from the Definition\'s own modules, and Save round-trips them', () =>
  withScratch(({ definitionsDir }) => {
    writeDefinition(definitionsDir, definitionYaml({ mounts: MOUNTS, status: 'draft' }))
    const projection = definitionVersionProjection(loadDefinition('std', { definitionsDir, version: 1 }))
    assert.deepEqual(projection.modules.map((m) => m.id), ['notes'])
    assert.deepEqual(projection.standardModules.map((m) => m.id), ['glossary', 'open-questions'])
    assert.deepEqual(projection.stages[0].modules, ['notes', 'glossary', 'open-questions'])

    const saved = writeDefinitionVersion('std', 1, projection, { definitionsDir })
    assert.equal(saved.problems, undefined, JSON.stringify(saved.problems))
    assert.deepEqual(saved.standardModules, projection.standardModules)
    assert.equal(saved.modules.some((m) => m.id === 'glossary'), false)
    // Gantry's modules are never written out as files of the Definition's own.
    assert.deepEqual(readFileSync(join(definitionsDir, 'std/1/definition.yaml'), 'utf8').match(/^standard-modules:/m)?.length, 1)
    assert.throws(() => readFileSync(join(definitionsDir, 'std/1/modules/glossary.yaml')), /ENOENT/)

    const published = publishDefinitionVersion('std', 1, { definitionsDir })
    assert.equal(published.problems, undefined, JSON.stringify(published.problems))
    assert.equal(published.status, 'published')
  }))

test('a draft can unmount a standard module: the editor drops the mount and the key goes when none is left', () =>
  withScratch(({ definitionsDir }) => {
    writeDefinition(definitionsDir, definitionYaml({ mounts: MOUNTS, status: 'draft' }))
    const projection = definitionVersionProjection(loadDefinition('std', { definitionsDir, version: 1 }))
    const without = {
      ...projection,
      standardModules: [],
      stages: projection.stages.map((s) => ({ ...s, modules: ['notes'] })),
      artefacts: projection.artefacts.map((a) => ({ ...a, requires: ['notes'] })),
    }
    const saved = writeDefinitionVersion('std', 1, without, { definitionsDir })
    assert.equal(saved.problems, undefined, JSON.stringify(saved.problems))
    assert.equal('standardModules' in saved, false)
    assert.doesNotMatch(readFileSync(join(definitionsDir, 'std/1/definition.yaml'), 'utf8'), /standard-modules/)
  }))

// ---------- the validator: refuses a changed shape or a version that doesn't exist; accepts added guidance ----------

const refused = (problems, type) => problems.filter((p) => p.type === type)

test('added guidance and Interview instructions on a mounted standard module are accepted', () => {
  const mounts = [{ id: 'glossary', version: 1, guidance: 'Spell it our way.', interview: 'Ask about acronyms first.' }]
  assert.deepEqual(standardModuleProblems(mounts), [])
  assert.deepEqual(standardModuleProblems(undefined), [])
  assert.deepEqual(standardModuleProblems([]), [])
})

test('the validator refuses a mount that names a version Gantry does not provide, or none', () => {
  for (const version of [2, 0, 1.5, '1', null, undefined]) {
    const problems = standardModuleProblems([{ id: 'glossary', ...(version === undefined ? {} : { version }) }])
    assert.equal(refused(problems, 'unknown-standard-module-version').length, 1, `version ${JSON.stringify(version)}`)
    assert.match(problems[0].message, /^Standard module "glossary" /)
    assert.match(problems[0].message, /available: 1/)
  }
})

test('the validator refuses a standard module Gantry does not provide', () => {
  const problems = standardModuleProblems([{ id: 'risks', version: 1 }])
  assert.deepEqual(problems.map((p) => p.type), ['unknown-standard-module'])
  assert.match(problems[0].message, /Gantry provides: glossary, open-questions/)
})

test('the validator refuses a mount that would change the shape: Fields, title, purpose, or anything but guidance and interview', () => {
  for (const [key, value] of [['fields', [{ id: 'x', title: 'X', type: 'text' }]], ['title', 'My glossary'], ['purpose', 'Mine'], ['required-at', ['shaped']], ['copied-from', {}]]) {
    const problems = standardModuleProblems([{ id: 'glossary', version: 1, [key]: value }])
    assert.deepEqual(problems.map((p) => p.type), ['standard-module-shape-changed'], key)
    assert.match(problems[0].message, new RegExp(`sets "${key}", which would change its shape`))
  }
})

test('the validator refuses a Definition\'s own module with a standard module\'s id, and a mount listed twice', () => {
  assert.deepEqual(standardModuleProblems([{ id: 'glossary', version: 1 }], ['glossary']).map((p) => p.type), ['standard-module-shape-changed'])
  assert.deepEqual(standardModuleProblems([{ id: 'glossary', version: 1 }, { id: 'glossary', version: 1 }]).map((p) => p.type), ['duplicate-standard-module'])
  assert.deepEqual(standardModuleProblems([{ id: 'glossary', version: 1, guidance: 3 }]).map((p) => p.type), ['invalid-standard-module-text'])
  assert.deepEqual(standardModuleProblems({ glossary: 1 }).map((p) => p.type), ['invalid-standard-modules'])
  assert.deepEqual(standardModuleProblems(['glossary']).map((p) => p.type), ['invalid-standard-modules'])
})

test('the disk validator refuses a wrong version and a changed shape in definition.yaml', () =>
  withScratch(({ definitionsDir }) => {
    const bad = `standard-modules:
  - id: glossary
    version: 7
  - id: open-questions
    version: 1
    fields: []
`
    writeDefinition(definitionsDir, definitionYaml({ mounts: bad }))
    const onDisk = findDefinitionProblems('std', { definitionsDir })
    assert.deepEqual(onDisk.filter((p) => /^Standard module /.test(p.message)).map((p) => p.type).sort(), ['standard-module-shape-changed', 'unknown-standard-module-version'])
  }))

test('the in-memory and Local Workspace validators agree with the disk validator', () => {
  const structure = {
    id: 'std',
    stages: [{ id: 'shape', gate: 'shaped', modules: ['glossary', 'open-questions'] }],
    artefacts: [{ id: 'doc', gate: 'shaped', requires: ['glossary.terms', 'open-questions.questions'] }],
    modules: [],
    standardModules: [{ id: 'glossary', version: 1 }, { id: 'open-questions', version: 1 }],
  }
  assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
  assert.deepEqual(findLocalDefinitionProblems(structure), [])

  const bad = { ...structure, standardModules: [{ id: 'glossary', version: 7 }, { id: 'open-questions', version: 1, fields: [] }] }
  for (const problems of [findDefinitionProblemsInStructure(bad), findLocalDefinitionProblems(bad)]) {
    const standard = problems.filter((p) => /^Standard module /.test(p.message)).map((p) => p.type).sort()
    assert.deepEqual(standard, ['standard-module-shape-changed', 'unknown-standard-module-version'])
  }

  // A stage that mounts a standard module the Definition never declared still has nothing to resolve.
  const undeclared = { ...structure, standardModules: [] }
  assert.ok(findDefinitionProblemsInStructure(undeclared).some((p) => p.type === 'missing-module'))
  assert.ok(findLocalDefinitionProblems(undeclared).some((p) => p.type === 'missing-module'))

  // And a field the shape does not have is caught like any other missing field.
  const wrongField = { ...structure, artefacts: [{ id: 'doc', gate: 'shaped', requires: ['glossary.entries'] }] }
  assert.ok(findDefinitionProblemsInStructure(wrongField).some((p) => p.type === 'missing-field'))
})

test('a Definition on disk that redefines a standard module as its own is refused', () =>
  withScratch(({ definitionsDir }) => {
    const own = `id: glossary
title: My glossary
purpose: Mine
fields:
  - id: entries
    title: Entries
    type: list
`
    writeDefinition(definitionsDir, definitionYaml({ mounts: MOUNTS }), { ownModules: { notes: NOTES_MODULE, glossary: own } })
    const problems = findDefinitionProblems('std', { definitionsDir })
    const clash = refused(problems, 'standard-module-shape-changed')
    assert.equal(clash.length, 1)
    assert.match(clash[0].message, /^Standard module "glossary" is also defined as one of this Definition's own modules/)
    assert.throws(() => loadDefinition('std', { definitionsDir }), /Standard module "glossary"/)
  }))

test('loading a Definition that names a version Gantry does not provide fails with that message', () =>
  withScratch(({ definitionsDir }) => {
    writeDefinition(definitionsDir, definitionYaml({ mounts: 'standard-modules:\n  - id: glossary\n    version: 2\n  - id: open-questions\n    version: 1\n' }))
    assert.throws(() => loadDefinition('std', { definitionsDir }), /Standard module "glossary" names version 2, which Gantry does not provide \(available: 1\)/)
  }))

// ---------- a published Definition renders the same forever ----------

// A later Gantry release: the same two modules with a second version beside the first. Version 1 is
// the very object the real catalogue holds, so nothing about it is copied or restated.
function laterCatalogue() {
  return {
    glossary: {
      title: 'Glossary',
      versions: {
        ...STANDARD_MODULES.glossary.versions,
        2: {
          title: 'Glossary',
          purpose: 'A different purpose',
          fields: [
            { id: 'terms', title: 'Terms and definitions', type: 'markdown', guidance: 'Version two guidance.' },
            { id: 'acronyms', title: 'Acronyms', type: 'list' },
          ],
        },
      },
    },
    'open-questions': STANDARD_MODULES['open-questions'],
  }
}

test('adding a second version leaves a Definition pinned to the first rendering unchanged', () =>
  withScratch(({ definitionsDir, instancesDir }) => {
    writeDefinition(definitionsDir, definitionYaml({ mounts: MOUNTS }))
    writeInstance(instancesDir)
    const later = laterCatalogue()
    assert.deepEqual(standardModuleVersions('glossary', later), [1, 2])

    const before = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir, instancesDir, commit: COMMIT })
    const after = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir, instancesDir, commit: COMMIT, standardModules: later })
    // Each render stamps its own random render id; everything else must be byte-identical.
    const sameRender = (text) => text.replace(/^gantry-render-id: .*$/m, 'gantry-render-id: <id>')
    assert.equal(sameRender(after.markdown), sameRender(before.markdown))
    assert.equal(sameRender(after.docxMarkdown), sameRender(before.docxMarkdown))

    // The Definition itself loads the same too: same Fields, same guidance, same status of its module.
    const pinnedNow = loadDefinition('std', { definitionsDir })
    const pinnedLater = loadDefinition('std', { definitionsDir, standardModules: later })
    assert.deepEqual([...pinnedLater.modules.entries()], [...pinnedNow.modules.entries()])
    assert.deepEqual(definitionVersionProjection(pinnedLater), definitionVersionProjection(pinnedNow))
    assert.deepEqual(findDefinitionProblems('std', { definitionsDir, standardModules: later }), [])

    // A Definition that opts in to version 2 gets version 2 — and only that Definition does.
    const moved = definitionYaml({ mounts: MOUNTS.replace(/(id: glossary\n\s+version: )1/, '$12') })
    writeDefinition(definitionsDir, moved)
    const onTwo = loadDefinition('std', { definitionsDir, standardModules: later })
    assert.deepEqual(onTwo.modules.get('glossary').fields.map((f) => f.id), ['terms', 'acronyms'])
    assert.throws(() => loadDefinition('std', { definitionsDir }), /names version 2, which Gantry does not provide/)
  }))

test('the Local Workspace twin reads a mounted standard module like any other', () => {
  const structure = {
    id: 'std',
    stages: [{ id: 'shape', gate: 'shaped', modules: ['glossary'] }],
    artefacts: [{ id: 'doc', gate: 'shaped', requires: ['glossary.terms'] }],
    modules: [],
    standardModules: [{ id: 'glossary', version: 1 }],
  }
  assert.equal(typeof getLocalStatus, 'function')
  // The YAML the Local Workspace writes for it names the mount, not the module.
  const yaml = renderDefinitionYaml({ ...structure, version: 1, status: 'draft', title: 'Std', description: '' })
  assert.match(yaml, /standard-modules:\n {2}- id: glossary\n {4}version: 1/)
  assert.deepEqual(findLocalDefinitionProblems(structure), [])
})
