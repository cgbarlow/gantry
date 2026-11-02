import { test } from 'node:test'
import assert from 'node:assert/strict'
import { differingFields, overwrittenFields } from '../lib/stageFieldsWritten.js'

// #272 (ADR-0068): which Fields of a stage-level Save are saved differently now (what a stale-version
// refusal names) and which of them held content (what a versionless Save reports it overwrote).

const payload = (fields, layoutExtra = []) => ({
  status: 'draft',
  owner: '',
  fields,
  layout: [...Object.keys(fields).filter((id) => !layoutExtra.some((e) => e.custom?.id === id)).map((field) => ({ field })), ...layoutExtra],
})

const current = {
  role: payload({ summary: 'Saved summary', team: '', tags: ['a', 'b'] }),
  budget: payload({ amount: '100' }),
}

test('differingFields names each Field in the call whose saved content differs, as moduleId.fieldId', () => {
  const modules = { role: { fields: { summary: 'New summary', team: 'Platform', tags: ['a', 'b'] } } }
  assert.deepEqual(differingFields(current, modules), ['role.summary', 'role.team'])
})

test('a Field written with the content it already has is not named, whatever its blank or padded list rows', () => {
  const modules = { role: { fields: { summary: 'Saved summary', tags: [' a ', 'b', ''] } } }
  assert.deepEqual(differingFields(current, modules), [])
})

test('only the Fields in the call are considered, and a Module with nothing saved yet has nothing to differ from', () => {
  assert.deepEqual(differingFields(current, { budget: { fields: { amount: '200' } } }), ['budget.amount'])
  assert.deepEqual(differingFields(current, { unseen: { fields: { x: 'y' } } }), [])
  assert.deepEqual(differingFields(current, {}), [])
})

test('overwrittenFields leaves out a Field that held nothing: filling a blank overwrites nothing', () => {
  const modules = { role: { fields: { summary: 'New summary', team: 'Platform', tags: ['c'] } } }
  assert.deepEqual(overwrittenFields(current, modules), ['role.summary', 'role.tags'])
})

test('a custom section is named by its title, and matched to the saved one by title', () => {
  const saved = { role: payload({ summary: 'S', c1: 'old notes' }, [{ custom: { id: 'c1', title: 'Open Points', type: 'markdown', value: 'old notes' } }]) }
  const edit = { role: { fields: { c9: 'new notes' }, layout: [{ custom: { id: 'c9', title: 'open points', type: 'markdown', value: 'new notes' } }] } }
  assert.deepEqual(overwrittenFields(saved, edit), ['role."open points"'])
  const same = { role: { fields: {}, layout: [{ custom: { id: 'zz', title: 'Open Points', type: 'markdown', value: 'old notes' } }] } }
  assert.deepEqual(differingFields(saved, same), [])
  const added = { role: { fields: {}, layout: [{ custom: { id: 'n', title: 'Brand new', type: 'markdown', value: 'x' } }] } }
  assert.deepEqual(differingFields(saved, added), [])
})

test('status and owner are not Fields and are never named', () => {
  assert.deepEqual(differingFields(current, { role: { status: 'approved', owner: 'Sam' } }), [])
})
