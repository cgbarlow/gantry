import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { printedFields, changedPrintedFields, describeChangedFields, withoutWording, findChangedSinceApproval } from '../lib/changedSinceApproval.js'
import { canRestoreChange, changeLabel, restorePanelHeading, wordingText, alsoReapprovesLine, changedEntryFor, changedEntryLabel, dashboardBadgeText, dashboardBadgeTitle, fieldCountLabel } from '../web/lib/changedSinceApproval.js'

// #273, ADR-0069 — the parts of "changed since approval" that need no Provider: which Fields an earlier
// stage's Artefacts print, what counts as a change to one, and how the flag is worded on screen. The
// Provider-facing half (merge commits, reads at a commit, the routes) is tests/serverChangedSinceApproval.test.js.

const definition = loadDefinition('design', { version: 2 })
const shape = definition.stages.find((s) => s.id === 'shape')

test('printedFields collects the Fields every Artefact at the stage\'s gate lists, optional ones included', () => {
  const printed = printedFields(definition, shape)
  assert.ok(printed.get('background').has('problem'), 'SOAP prints background.problem')
  assert.ok(printed.get('design-basis').has('assumptions'), 'an optional `module.field?` entry still prints')
  assert.ok(printed.get('background').has('opportunity'), 'the Full SOAP at the same gate counts too')
})

test('printedFields leaves out Fields only a later stage\'s Artefacts print', () => {
  const printed = printedFields(definition, shape)
  assert.equal(printed.get('background').has('success-criteria'), false, 'only the HLD prints background.success-criteria')
  assert.equal(printed.has('proposed-solution'), false)
})

test('changedPrintedFields reports only printed Fields that differ, in Definition order', () => {
  const printed = new Map([['background', new Set(['problem', 'opportunity'])]])
  const approved = new Map([['background', { problem: 'A', opportunity: 'B', 'success-criteria': 'C' }]])
  const current = new Map([['background', { problem: 'A2', opportunity: 'B', 'success-criteria': 'C2' }]])
  assert.deepEqual(changedPrintedFields(definition, printed, approved, current), ['background.problem'])
})

test('changedPrintedFields ignores whitespace and line endings, and treats absent, empty and an empty list alike', () => {
  const printed = new Map([
    ['background', new Set(['problem', 'opportunity'])],
    ['team-and-estimates', new Set(['teams-required'])],
  ])
  const approved = new Map([['background', { problem: 'Line one\nLine two', opportunity: undefined }]])
  const current = new Map([
    ['background', { problem: '  Line one\r\nLine two\n\n', opportunity: '' }],
    ['team-and-estimates', { 'teams-required': [] }],
  ])
  assert.deepEqual(changedPrintedFields(definition, printed, approved, current), [])
})

test('changedPrintedFields flags a Field that was empty at approval and has been filled since, and a Module that had no file', () => {
  const printed = new Map([['background', new Set(['problem'])]])
  assert.deepEqual(changedPrintedFields(definition, printed, new Map([['background', null]]), new Map([['background', { problem: 'Now written' }]])), ['background.problem'])
  assert.deepEqual(changedPrintedFields(definition, printed, new Map(), new Map([['background', { problem: 'Now written' }]])), ['background.problem'])
})

test('changedPrintedFields compares list Fields item by item', () => {
  const printed = new Map([['team-and-estimates', new Set(['teams-required'])]])
  const approved = new Map([['team-and-estimates', { 'teams-required': ['Platform', 'Security'] }]])
  assert.deepEqual(changedPrintedFields(definition, printed, approved, new Map([['team-and-estimates', { 'teams-required': [' Platform ', 'Security'] }]])), [])
  assert.deepEqual(changedPrintedFields(definition, printed, approved, new Map([['team-and-estimates', { 'teams-required': ['Platform'] }]])), ['team-and-estimates.teams-required'])
})

test('findChangedSinceApproval flags nothing for the first stage, for an unsupported provider, or when no earlier stage has a Pull Request', async () => {
  const base = { slug: 'x', definition, base: {} }
  assert.deepEqual(await findChangedSinceApproval({ ...base, providerKey: 'github', instance: { stage: 'shape', pullRequests: { shape: 3 } } }), [])
  assert.deepEqual(await findChangedSinceApproval({ ...base, providerKey: 'atlassian', instance: { stage: 'hld-define', pullRequests: { shape: 3 } } }), [])
  assert.deepEqual(await findChangedSinceApproval({ ...base, providerKey: 'github', instance: { stage: 'hld-define', pullRequests: {} } }), [])
  assert.deepEqual(await findChangedSinceApproval({ ...base, providerKey: 'github', instance: { stage: 'hld-define' } }), [])
})

test('the screens word the flag the same way everywhere', () => {
  const changed = [
    { stageId: 'shape', title: 'SOAP', count: 2, fields: ['background.problem', 'background.affected-domains'] },
    { stageId: 'hld-define', title: 'High-level Design', count: 1, fields: ['risks.risk-register'] },
  ]
  assert.equal(fieldCountLabel(1), '1 Field')
  assert.equal(fieldCountLabel(2), '2 Fields')
  assert.equal(changedEntryLabel(changed[0]), 'SOAP: 2 Fields')
  assert.equal(changedEntryFor(changed, 'hld-define').count, 1)
  assert.equal(changedEntryFor(changed, 'nope'), undefined)
  assert.equal(alsoReapprovesLine(changed.slice(0, 1)), 'also re-approves SOAP: 2 Fields')
  assert.equal(alsoReapprovesLine(changed), 'also re-approves SOAP: 2 Fields, High-level Design: 1 Field')
  assert.equal(alsoReapprovesLine([]), null)
  assert.equal(alsoReapprovesLine(undefined), null)
  assert.equal(dashboardBadgeText(changed), 'CHANGED SINCE APPROVAL')
  assert.equal(dashboardBadgeText([]), null)
  assert.equal(dashboardBadgeTitle(changed), 'SOAP: 2 Fields; High-level Design: 1 Field')
})

// #274 — Restore approved text: the wording behind each flagged Field.

test('describeChangedFields gives each flagged Field its Module, title and wording at approval and now, shaped as the editor holds it', () => {
  const approved = new Map([
    ['background', { problem: 'Original wording.\r\nSecond line.' }],
    ['team-and-estimates', { 'teams-required': ['Platform', ' Security '] }],
  ])
  const current = new Map([
    ['background', { problem: 'Reworded.' }],
    ['team-and-estimates', {}],
  ])
  const [problem, teams] = describeChangedFields(definition, ['background.problem', 'team-and-estimates.teams-required'], approved, current)
  assert.equal(problem.ref, 'background.problem')
  assert.equal(problem.moduleId, 'background')
  assert.equal(problem.fieldId, 'problem')
  assert.equal(problem.title, definition.modules.get('background').fields.find((f) => f.id === 'problem').title)
  assert.equal(problem.approved, 'Original wording.\nSecond line.')
  assert.equal(problem.current, 'Reworded.')
  assert.deepEqual(teams.approved, ['Platform', 'Security'])
  assert.deepEqual(teams.current, [], 'a list Field with nothing saved is an empty list')
})

test('describeChangedFields reads a Module with no file at approval as empty wording', () => {
  const [problem] = describeChangedFields(definition, ['background.problem'], new Map(), new Map([['background', { problem: 'Now written' }]]))
  assert.equal(problem.approved, '')
  assert.equal(problem.current, 'Now written')
})

test('withoutWording keeps the summary and drops each Field\'s wording', () => {
  const flagged = [{ stageId: 'shape', title: 'SOAP', fields: ['background.problem'], count: 1, changes: [{ ref: 'background.problem' }] }]
  assert.deepEqual(withoutWording(flagged), [{ stageId: 'shape', title: 'SOAP', fields: ['background.problem'], count: 1 }])
})

test('the restore panel words a flagged Field, a list Field and an empty one', () => {
  const change = { ref: 'background.problem', moduleId: 'background', moduleTitle: 'Background', fieldId: 'problem', title: 'Problem statement' }
  assert.equal(changeLabel(change), 'Background \u203a Problem statement')
  assert.equal(restorePanelHeading({ title: 'SOAP', count: 2 }), 'SOAP was approved with different wording in 2 Fields')
  assert.equal(wordingText('Some text'), 'Some text')
  assert.equal(wordingText(['One', 'Two']), '- One\n- Two')
  assert.equal(wordingText([]), '')
  assert.equal(wordingText(undefined), '')
})

test('canRestoreChange needs the Field\'s Module mounted on the viewed stage and not read-only', () => {
  const change = { moduleId: 'background', fieldId: 'problem' }
  const mounted = [{ id: 'background', fields: [{ id: 'problem' }] }]
  assert.equal(canRestoreChange(change, mounted), true)
  assert.equal(canRestoreChange(change, [{ ...mounted[0], readOnly: { homeStage: null } }]), false, 'read-only here')
  assert.equal(canRestoreChange(change, [{ id: 'other', fields: [] }]), false, 'Module not on this stage')
  assert.equal(canRestoreChange(change, [{ id: 'background', fields: [{ id: 'x' }] }]), false, 'Field not in the Module')
  assert.equal(canRestoreChange(change, undefined), false)
})
