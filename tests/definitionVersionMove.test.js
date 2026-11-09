import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseYAML } from 'yaml'
import { loadDefinition, definitionVersionProjection } from '../lib/definition.js'
import {
  definitionVersionChanges,
  removedFieldModuleIds,
  fieldSectionContent,
  withoutFieldSections,
  planDefinitionMove,
  definitionMoveTarget,
  definitionMoveSummary,
  definitionMoveCommitMessage,
  definitionMoveEntry,
  definitionMoveWrites,
  withDefinitionVersion,
  changelogSection,
  definitionMoveBlockedReason,
  writeAllOrRestore,
} from '../web/lib/definitionVersionMove.js'
import { parseDecisionsLog, ENTRY_KINDS } from '../web/lib/decisionsLog.js'
import { describeEntry } from '../web/lib/decisionsLogPanel.js'
import { V3_REFERENCES, withV3References } from './helpers/designExamples.js'

// #362: "Move to v<N>" in an Instance's Settings. What changes between two versions of a Definition is
// worked out from the two versions' structures alone, with no per-version script: the Fields the newer
// version no longer has, the Fields it adds, the Fields a Gate the Instance has still to pass now asks
// for, and the Fields whose type changed. Only the first are acted on: their sections leave the Module
// files. This suite drives the pure half (web/lib/definitionVersionMove.js), shared by the server and a
// Local workspace's browser, on a stand-in pair of versions; tests/definitionVersionMoveServer.test.js
// drives the move on each kind of workspace.

const field = (id, title, type, extra = {}) => ({ id, title, type, ...extra })

// The stand-in pair. v1 → v2:
//   - summary.links is removed, and so is the whole `extras` Module (its one Field, tips);
//   - plan.owner is new, and required (so the Detail Gate, which needs all of `plan`, asks for it);
//   - summary.notes becomes required at the Detail Gate;
//   - plan.budget becomes a bare requirement of the Brief, at the Shape Gate;
//   - summary.risks changes from a list to Markdown (a list that became a table).
const V1 = {
  id: 'moving',
  version: 1,
  stages: [
    { id: 'shape', title: 'Shape', gate: 'shaped', modules: ['summary', 'extras'] },
    { id: 'detail', title: 'Detail', gate: 'detailed', modules: ['summary', 'plan'] },
  ],
  artefacts: [
    { id: 'brief', title: 'Brief', gate: 'shaped', requires: ['summary'] },
    { id: 'plan-doc', title: 'Plan', gate: 'detailed', requires: ['plan', 'summary.notes?'] },
  ],
  modules: [
    {
      id: 'summary',
      title: 'Summary',
      fields: [
        field('overview', 'Overview', 'markdown', { required: true }),
        field('risks', 'Risks', 'list'),
        field('notes', 'Notes', 'markdown'),
        field('links', 'Links', 'list'),
      ],
    },
    { id: 'extras', title: 'Extras', fields: [field('tips', 'Tips', 'markdown')] },
    { id: 'plan', title: 'Plan', fields: [field('steps', 'Steps', 'list', { required: true }), field('budget', 'Budget', 'text')] },
  ],
}

const V2 = {
  id: 'moving',
  version: 2,
  stages: [
    { id: 'shape', title: 'Shape', gate: 'shaped', modules: ['summary'] },
    { id: 'detail', title: 'Detail', gate: 'detailed', modules: ['summary', 'plan'] },
  ],
  artefacts: [
    { id: 'brief', title: 'Brief', gate: 'shaped', requires: ['summary', 'plan.budget'] },
    { id: 'plan-doc', title: 'Plan', gate: 'detailed', requires: ['plan', 'summary.notes?'] },
  ],
  modules: [
    {
      id: 'summary',
      title: 'Summary',
      fields: [
        field('overview', 'Overview', 'markdown', { required: true }),
        field('risks', 'Risks', 'markdown'),
        field('notes', 'Notes', 'markdown', { requiredAt: ['detailed'] }),
      ],
    },
    {
      id: 'plan',
      title: 'Plan',
      fields: [field('steps', 'Steps', 'list', { required: true }), field('budget', 'Budget', 'text'), field('owner', 'Owner', 'text', { required: true })],
    },
  ],
}

const SUMMARY_FILE = `---
module: summary
status: draft
owner: a.person
---
# Summary

## Overview

What this is.

## Risks

- Late delivery

## Links

- https://example.invalid/one
- https://example.invalid/two

## Notes

Some notes.
`

const named = (list) => list.map((f) => `${f.moduleId}.${f.fieldId}`)

test('removed, added, newly required and type-changed Fields are worked out from the two versions\' structures', () => {
  const changes = definitionVersionChanges(V1, V2, { stageId: 'detail' })
  assert.deepEqual(named(changes.removed), ['summary.links', 'extras.tips'])
  assert.deepEqual(changes.removed[0], { moduleId: 'summary', moduleTitle: 'Summary', fieldId: 'links', fieldTitle: 'Links' })
  assert.deepEqual(named(changes.added), ['plan.owner'])
  assert.deepEqual(changes.added[0].requiredAt, [{ id: 'detail', title: 'Detail' }], 'the Detail Gate needs every required Field of plan')
  // On Detail, only the Gates from Detail on count: the Brief's new plan.budget is Shape's, which is passed.
  assert.deepEqual(named(changes.newlyRequired), ['summary.notes'])
  assert.deepEqual(changes.newlyRequired[0].stages, [{ id: 'detail', title: 'Detail' }])
  assert.deepEqual(named(changes.typeChanged), ['summary.risks'])
  assert.deepEqual([changes.typeChanged[0].fromType, changes.typeChanged[0].toType], ['list', 'markdown'])
})

test('a Stage not yet passed is every Stage from the Instance\'s current one on', () => {
  const changes = definitionVersionChanges(V1, V2, { stageId: 'shape' })
  assert.deepEqual(named(changes.newlyRequired), ['summary.notes', 'plan.budget'])
  assert.deepEqual(changes.newlyRequired.find((f) => f.fieldId === 'budget').stages, [{ id: 'shape', title: 'Shape' }])
  // A new Field is listed once, as new, never also as newly required.
  assert.ok(!named(changes.newlyRequired).includes('plan.owner'))
})

test('an optional requirement only counts when the Field is required at that Gate, and a select that became multiple is a type change', () => {
  const withOptionalOnly = {
    ...V1,
    artefacts: [{ id: 'brief', title: 'Brief', gate: 'shaped', requires: ['summary.links?'] }],
    modules: [{ id: 'summary', title: 'Summary', fields: [field('links', 'Links', 'list'), field('kind', 'Kind', 'select', { options: ['a', 'b'] })] }],
    stages: [{ id: 'shape', title: 'Shape', gate: 'shaped', modules: [] }],
  }
  const multiple = { ...withOptionalOnly, version: 2, modules: [{ id: 'summary', title: 'Summary', fields: [field('links', 'Links', 'list'), field('kind', 'Kind', 'select', { options: ['a', 'b'], multiple: true })] }] }
  const changes = definitionVersionChanges(withOptionalOnly, multiple, { stageId: 'shape' })
  assert.deepEqual(changes.newlyRequired, [])
  assert.deepEqual(changes.typeChanged.map((f) => [f.fieldId, f.fromType, f.toType]), [['kind', 'select', 'select (multiple)']])
  assert.deepEqual(definitionVersionChanges(V1, V1, { stageId: 'shape' }), { removed: [], added: [], newlyRequired: [], typeChanged: [] }, 'the same version changes nothing')
})

test('the structures can be the loaded Definition (Modules in a Map) or its projection, and Gantry\'s own standard Modules are left out', () => {
  const v3 = loadDefinition('design', { version: 3 })
  const v4 = loadDefinition('design', { version: 4 })
  for (const [from, to] of [[v3, v4], [definitionVersionProjection(v3), definitionVersionProjection(v4)]]) {
    const changes = definitionVersionChanges(from, to, { stageId: 'shape' })
    assert.deepEqual(named(changes.removed), ['team-and-estimates.references'])
    assert.equal(changes.removed[0].moduleTitle, 'Teams, contact persons, and high-level estimates')
    assert.deepEqual([changes.added, changes.newlyRequired, changes.typeChanged], [[], [], []])
  }
  assert.deepEqual(removedFieldModuleIds(v3, v4), ['team-and-estimates'])
})

test('a Field\'s section is found as the parser finds it, and removing it leaves every other byte as it was', () => {
  assert.equal(fieldSectionContent(SUMMARY_FILE, 'Links'), '- https://example.invalid/one\n- https://example.invalid/two')
  assert.equal(fieldSectionContent(SUMMARY_FILE, 'Budget'), null)
  assert.equal(fieldSectionContent('---\nmodule: m\n---\n# M\n\n## **Links**\n\n', 'Links'), '', 'formatting in the heading is ignored, and an empty section is found')

  const without = withoutFieldSections(SUMMARY_FILE, ['Links'])
  assert.equal(without, SUMMARY_FILE.replace('## Links\n\n- https://example.invalid/one\n- https://example.invalid/two\n\n', ''))
  // The last section goes with the blank lines before it, so the file still ends with one newline.
  assert.equal(withoutFieldSections(SUMMARY_FILE, ['Notes']), SUMMARY_FILE.replace('\n## Notes\n\nSome notes.\n', ''))
  assert.equal(withoutFieldSections(SUMMARY_FILE, ['Budget']), SUMMARY_FILE, 'nothing to remove leaves the file alone')
  assert.equal(withoutFieldSections('no frontmatter', ['Links']), 'no frontmatter')
})

test('taking References out of a v3 design example gives the v4 example byte for byte', () => {
  for (const slug of Object.keys(V3_REFERENCES)) {
    const v4Text = readFileSync(`workspaces/examples/${slug}/modules/team-and-estimates.md`, 'utf8')
    // The example as it was on v3 (0.16.3), References and all.
    const v3Text = withV3References(slug, v4Text)
    assert.notEqual(v3Text, v4Text)
    assert.equal(withoutFieldSections(v3Text, ['References']), v4Text, slug)
    const v4Yaml = readFileSync(`workspaces/examples/${slug}/instance.yaml`, 'utf8')
    const v3Yaml = v4Yaml.replace(/^definitionVersion: 4$/m, 'definitionVersion: 3')
    assert.notEqual(v3Yaml, v4Yaml)
    assert.equal(withDefinitionVersion(v3Yaml, 4), v4Yaml, 'only the version line changes')
  }
})

test('instance.yaml changes on its version line alone, or is written canonically when it has no single one', () => {
  assert.equal(withDefinitionVersion('slug: a\ndefinitionVersion: 1\nstage: s\n', 2), 'slug: a\ndefinitionVersion: 2\nstage: s\n')
  assert.equal(withDefinitionVersion('stage: s\nslug: a\n', 2), 'definitionVersion: 2\nslug: a\nstage: s\n', 'an Instance with no version line was on v1')
})

test('the plan removes only Fields the Instance has a section for, names only those with content, and never a heading a Field of the new version still uses', () => {
  const plan = planDefinitionMove({ from: V1, to: V2, stageId: 'detail', moduleFiles: { summary: SUMMARY_FILE, extras: '---\nmodule: extras\n---\n# Extras\n\n## Tips\n\n' } })
  assert.equal(plan.definition, 'moving')
  assert.deepEqual([plan.from, plan.to, plan.stageId], [1, 2, 'detail'])
  assert.deepEqual(named(plan.removed), ['summary.links'], 'an empty Tips section had no content to name')
  assert.deepEqual(plan.files.map((f) => f.path), ['modules/summary.md', 'modules/extras.md'])
  assert.equal(plan.files[0].text, withoutFieldSections(SUMMARY_FILE, ['Links']))
  assert.equal(plan.files[1].text, '---\nmodule: extras\n---\n# Extras\n')
  assert.deepEqual(named(plan.changes.removed), ['summary.links', 'extras.tips'])

  const noFiles = planDefinitionMove({ from: V1, to: V2, stageId: 'detail', moduleFiles: {} })
  assert.deepEqual([noFiles.removed, noFiles.files], [[], []], 'a Module with no file has nothing to remove')

  // v2 drops `links` but a new Field takes its title: that heading is the new Field's, so it stays.
  const retitled = { ...V2, modules: V2.modules.map((m) => (m.id === 'summary' ? { ...m, fields: [...m.fields, field('references', 'Links', 'list')] } : m)) }
  const kept = planDefinitionMove({ from: V1, to: retitled, stageId: 'detail', moduleFiles: { summary: SUMMARY_FILE } })
  assert.deepEqual([kept.removed, kept.files], [[], []])
})

test('the move is recorded in the Stage\'s decisions log, appended, in the same words as its commit message', () => {
  const plan = planDefinitionMove({ from: V1, to: V2, stageId: 'detail', moduleFiles: { summary: SUMMARY_FILE } })
  assert.equal(definitionMoveSummary(plan), 'Moved from v1 to v2. Removed: Links (Summary).')
  assert.equal(definitionMoveSummary({ ...plan, removed: [] }), 'Moved from v1 to v2. No Field had content to remove.')
  assert.equal(definitionMoveCommitMessage('demo', plan), 'Instance "demo": Moved from v1 to v2. Removed: Links (Summary).')

  const entry = definitionMoveEntry(plan, { at: '2026-11-09T10:00:00.000Z', who: 'a.person' })
  assert.ok(ENTRY_KINDS.includes('definition-move'))
  assert.deepEqual(entry, {
    id: 'definition-move-v1-v2-20261109100000',
    at: '2026-11-09T10:00:00.000Z',
    kind: 'definition-move',
    who: 'a.person',
    definition: 'moving',
    from: 1,
    to: 2,
    removed: [{ module: 'summary', field: 'links', title: 'Links', moduleTitle: 'Summary' }],
    note: 'Moved from v1 to v2. Removed: Links (Summary).',
  })
  assert.equal(describeEntry(entry), 'Moved from v1 to v2. Removed: Links (Summary).')

  const existingLog = 'version: 1\nstage: detail\nstatus: []\nfields: {}\nentries:\n  - id: s1-1\n    kind: fact\n    at: "2026-11-01T00:00:00.000Z"\n    words: Earlier\n'
  const writes = definitionMoveWrites(plan, { instanceYaml: 'definition: moving\ndefinitionVersion: 1\nslug: demo\nstage: detail\n', logText: existingLog, entry })
  assert.deepEqual(writes.map((w) => w.path), ['modules/summary.md', 'interview/detail.yaml', 'instance.yaml'], 'the version changes last')
  const log = parseDecisionsLog(writes[1].text, 'detail')
  assert.deepEqual(log.entries.map((e) => e.id), ['s1-1', entry.id])
  assert.equal(parseYAML(writes[2].text).definitionVersion, 2)
  assert.equal(parseDecisionsLog(definitionMoveWrites(plan, { instanceYaml: 'definitionVersion: 1\n', logText: null, entry })[1].text, 'detail').entries.length, 1, 'a Stage with no log yet starts one')
})

test('only a newer published version is offered, and only the latest', () => {
  assert.equal(definitionMoveTarget(3, 4), 4)
  assert.equal(definitionMoveTarget(2, 4), 4)
  assert.equal(definitionMoveTarget(4, 4), null)
  assert.equal(definitionMoveTarget(5, 4), null, 'an Instance on a draft newer than the latest published is not moved back')
  assert.equal(definitionMoveTarget(1, null), null)
})

test('the CHANGELOG section for the newer version is the one shown, and a sentence says why a Stage awaiting approval blocks the move', () => {
  const changelog = readFileSync('definitions/design/4/CHANGELOG.md', 'utf8')
  const section = changelogSection(changelog, 4)
  assert.match(section, /^## v4\n/)
  assert.ok(!section.includes('## v3'))
  assert.match(changelogSection('# Title\n\n## v2\n\nTwo.\n\n## v1\n\nOne.\n', 1), /^## v1\n\nOne\.$/)
  assert.equal(changelogSection('## v1\n\nOne.\n', 2), null)
  assert.equal(changelogSection(null, 2), null)
  assert.equal(
    definitionMoveBlockedReason({ title: 'Shape' }, 4),
    'Shape is awaiting approval, so this Instance can\'t move to v4 yet: the move would change content its Pull Request asks the Owner to approve. Move it once the Pull Request is approved or closed.'
  )
})

test('a write that fails part-way puts back every file it had written, and a file it created is removed', async () => {
  const files = new Map([['a.md', 'A'], ['instance.yaml', 'v1']])
  const io = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      if (path === 'instance.yaml') throw new Error('disk full')
      files.set(path, text)
    },
    remove: async (path) => files.delete(path),
  }
  await assert.rejects(writeAllOrRestore([{ path: 'a.md', text: 'A2' }, { path: 'log.yaml', text: 'new' }, { path: 'instance.yaml', text: 'v2' }], io), /disk full/)
  assert.deepEqual([...files], [['a.md', 'A'], ['instance.yaml', 'v1']])

  const ok = new Map()
  await writeAllOrRestore([{ path: 'x', text: '1' }], { read: async () => null, write: async (p, t) => ok.set(p, t), remove: async () => {} })
  assert.equal(ok.get('x'), '1')
})

test('the User Guide says how to move an Instance, and design v4\'s CHANGELOG points at the action and keeps the steps by hand', () => {
  const guide = readFileSync('docs/user-guide/index.md', 'utf8')
  const versions = guide.slice(guide.indexOf('### Definition versions and the Definitions page'), guide.indexOf('#### Interview instructions'))
  assert.match(versions, /\*\*Move to v\*N\*…\*\*/)
  assert.match(versions, /Only the latest published version is offered/)
  assert.match(versions, /If any part fails, nothing is changed/)
  assert.match(versions, /"Moved from v\*n\* to v\*N\*", naming the fields removed/)
  assert.match(versions, /awaiting approval/)
  const design = guide.split('\n').find((line) => line.startsWith('The worked example throughout this guide remains the `design` definition'))
  assert.match(design, /choose \*\*Move to v4…\*\* under its Version/)

  const v4 = changelogSection(readFileSync('definitions/design/4/CHANGELOG.md', 'utf8'), 4)
  const moving = v4.slice(v4.indexOf('### Moving an Instance from v3'), v4.indexOf('### Started as a copy of v3'))
  assert.match(moving, /\*\*Move to v4…\*\*/)
  assert.match(moving, /For reference, the move by hand: delete the `## References` section/)
})
