import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modulePayload, payloadKey, savedFields, saveStatusLine } from '../web/lib/stageSave.js'

const mod = {
  id: 'background',
  status: 'draft',
  owner: 'c.barlow',
  fields: [
    { id: 'problem', title: 'Problem statement', type: 'markdown', value: 'Line one\r\nLine two' },
    { id: 'custom:1', title: 'Risks', type: 'markdown', value: 'None yet', custom: true },
    { id: 'affected-domains', title: 'Affected domains', type: 'list', value: ['Payments'] },
  ],
}

test('modulePayload builds the writer payload in displayed order, preferring live values', () => {
  const payload = modulePayload(mod, (field) => (field.id === 'problem' ? 'Edited' : undefined))
  assert.deepEqual(payload, {
    status: 'draft',
    owner: 'c.barlow',
    fields: { problem: 'Edited', 'custom:1': 'None yet', 'affected-domains': ['Payments'] },
    layout: [
      { field: 'problem' },
      { custom: { id: 'custom:1', title: 'Risks', type: 'markdown', value: 'None yet' } },
      { field: 'affected-domains' },
    ],
  })
})

test('payloadKey treats what saves identically as unchanged: editor line endings, blank or padded list rows', () => {
  const saved = payloadKey(modulePayload(mod))
  const live = { problem: 'Line one\nLine two', 'affected-domains': [' Payments ', ''] }
  assert.equal(payloadKey(modulePayload(mod, (field) => live[field.id])), saved)
})

test('payloadKey sees text edits, list edits and inserted sections as changes — and undoing back as clean', () => {
  const saved = payloadKey(modulePayload(mod))
  assert.notEqual(payloadKey(modulePayload(mod, (f) => (f.id === 'problem' ? 'Line one\nLine two!' : undefined))), saved)
  assert.notEqual(payloadKey(modulePayload(mod, (f) => (f.id === 'affected-domains' ? ['Payments', 'Claims'] : undefined))), saved)
  const inserted = { ...mod, fields: [...mod.fields, { id: 'custom:2', title: 'Untitled list', type: 'list', value: [], custom: true }] }
  assert.notEqual(payloadKey(modulePayload(inserted)), saved)
  assert.equal(payloadKey(modulePayload(mod, (f) => (f.id === 'problem' ? 'Line one\nLine two' : undefined))), saved)
})

test('savedFields restores the saved layout: inserted sections go, removed ones come back with their saved text', () => {
  const saved = modulePayload(mod)
  const edited = {
    ...mod,
    fields: [
      { ...mod.fields[0], value: 'changed' },
      { id: 'custom:9', title: 'New', type: 'markdown', value: 'x', custom: true },
      mod.fields[2],
    ],
  }
  const restored = savedFields(edited, saved)
  assert.deepEqual(restored.map((f) => f.id), ['problem', 'custom:1', 'affected-domains'])
  assert.equal(restored[0].value, 'Line one\r\nLine two')
  assert.equal(restored[1].title, 'Risks')
  assert.equal(restored[1].value, 'None yet')
  assert.equal(restored[1].custom, true)
})

test('saveStatusLine keeps the card\'s completeness wording', () => {
  assert.equal(saveStatusLine({ complete: true }), 'Saved — complete.')
  assert.equal(saveStatusLine({ complete: false, outstanding: ['problem', 'opportunity'] }), 'Saved — outstanding: problem, opportunity')
  assert.equal(saveStatusLine(undefined), 'Saved — outstanding: none')
})
