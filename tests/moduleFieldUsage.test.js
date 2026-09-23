import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moduleFieldUsage } from '../web/lib/moduleFieldUsage.js'
import { loadDefinition, definitionVersionProjection } from '../lib/definition.js'

const modules = [
  { id: 'context', fields: [{ id: 'driver' }, { id: 'affected-domains' }] },
  { id: 'details', fields: [{ id: 'summary' }, { id: 'notes' }, { id: 'extra' }] },
  { id: 'unused', fields: [{ id: 'a' }] },
]

const usageOf = (map, id) => {
  const u = map.get(id)
  return u && { used: u.used, optional: u.optional, total: u.total }
}

test('every module is reported, with its total field count, even when nothing uses it', () => {
  const usage = moduleFieldUsage(modules, [])
  assert.deepEqual(usageOf(usage, 'context'), { used: 0, optional: 0, total: 2 })
  assert.deepEqual(usageOf(usage, 'details'), { used: 0, optional: 0, total: 3 })
  assert.deepEqual(usageOf(usage, 'unused'), { used: 0, optional: 0, total: 1 })
})

test('a whole-module requirement uses every field; a field requirement uses one', () => {
  const usage = moduleFieldUsage(modules, [{ requires: ['context', 'details.summary'] }])
  assert.deepEqual(usageOf(usage, 'context'), { used: 2, optional: 0, total: 2 })
  assert.deepEqual(usageOf(usage, 'details'), { used: 1, optional: 0, total: 3 })
  assert.deepEqual(usageOf(usage, 'unused'), { used: 0, optional: 0, total: 1 })
})

test('an optional `module.field?` ref is used, and counted as optional', () => {
  const usage = moduleFieldUsage(modules, [{ requires: ['details.summary', 'details.notes?'] }])
  assert.deepEqual(usageOf(usage, 'details'), { used: 2, optional: 1, total: 3 })
})

test('a ref to a field the module does not have is not counted, so used never exceeds total', () => {
  const usage = moduleFieldUsage(modules, [{ requires: ['details.gone', 'details.summary', 'missing-module.x'] }])
  assert.deepEqual(usageOf(usage, 'details'), { used: 1, optional: 0, total: 3 })
  assert.equal(usage.has('missing-module'), false)
})

test('several documents combine: a field counts once, and is optional only if no document needs it', () => {
  const usage = moduleFieldUsage(modules, [
    { requires: ['details.summary?', 'details.notes?'] },
    { requires: ['details.summary', 'details.extra?'] },
  ])
  // summary is bare in the second document, so it is not optional overall
  assert.deepEqual(usageOf(usage, 'details'), { used: 3, optional: 2, total: 3 })
})

test('a whole-module ref outranks an optional field ref to the same module', () => {
  const usage = moduleFieldUsage(modules, [{ requires: ['context.driver?'] }, { requires: ['context'] }])
  assert.deepEqual(usageOf(usage, 'context'), { used: 2, optional: 0, total: 2 })
})

test('a whole-module ref to a module with no fields key counts nothing rather than throwing', () => {
  assert.deepEqual(usageOf(moduleFieldUsage([{ id: 'x' }], [{ requires: ['x'] }]), 'x'), { used: 0, optional: 0, total: 0 })
})

test('two modules sharing an id (a draft mid-edit) report the first, matching every other lookup', () => {
  const usage = moduleFieldUsage(
    [{ id: 'm', fields: [{ id: 'a' }, { id: 'b' }] }, { id: 'm', fields: [{ id: 'c' }] }],
    [{ requires: ['m'] }]
  )
  assert.deepEqual(usageOf(usage, 'm'), { used: 2, optional: 0, total: 2 })
})

test('recruitment-onboarding v2: the Offer Pack uses Offer 2/3 and no Vetting fields at all', () => {
  // The same projection the Definitions page is served, so this checks the shape the Map receives.
  const definition = definitionVersionProjection(loadDefinition('recruitment-onboarding', { definitionsDir: 'definitions', version: 2 }))
  const offerPack = definition.artefacts.find((a) => a.id === 'offer-pack')
  const usage = moduleFieldUsage(definition.modules, [offerPack])
  const summary = Object.fromEntries([...usage].map(([id, u]) => [id, `${u.used}/${u.total}`]))
  assert.deepEqual(summary, {
    role: '3/4',
    engagement: '1/4',
    'role-evaluation': '0/3',
    'open-questions': '1/2',
    advertising: '0/4',
    selection: '1/5',
    vetting: '0/3',
    offer: '2/3',
    contract: '4/5',
    payroll: '3/4',
    identity: '0/3',
    device: '0/3',
    access: '0/3',
    handover: '0/3',
  })
})
