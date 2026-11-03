import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sha256Hex, stageVersionOfPayloads, stageVersionOfModules, mergeStage, conflictKey, conflictText, conflictValueFromText } from '../web/lib/stageVersion.js'

// ADR-0068 (#270): a stage's version, and the Field-by-Field three-way settle of a clash.

const payload = (fields, extra = {}) => ({
  status: 'draft',
  owner: '',
  fields,
  layout: Object.keys(fields).map((id) => ({ field: id })),
  ...extra,
})

const custom = (id, title, value, type = 'markdown') => ({ custom: { id, title, type, value } })

test('sha256Hex agrees with node:crypto, including across block boundaries and for non-ASCII text', () => {
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Zoë — naïve “quotes” 日本語']) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'), JSON.stringify(text.slice(0, 12)))
  }
})

test('the version follows Field content only: same content, same version, whatever the Module order, line endings or blank list rows', () => {
  const a = { one: payload({ a: 'Alpha', list: ['x', 'y'] }), two: payload({ b: 'Beta' }) }
  const same = { two: payload({ b: 'Beta' }), one: payload({ a: 'Alpha', list: [' x ', 'y', ''] }) }
  assert.equal(stageVersionOfPayloads(a), stageVersionOfPayloads(same))
  assert.equal(stageVersionOfPayloads({ one: payload({ a: 'A\r\nB' }) }), stageVersionOfPayloads({ one: payload({ a: 'A\nB' }) }))
  assert.match(stageVersionOfPayloads(a), /^[0-9a-f]{16}$/)
})

test('the version changes when any Field, status, owner, section or the order changes', () => {
  const base = { one: payload({ a: 'Alpha', b: 'Beta' }) }
  const v = stageVersionOfPayloads(base)
  assert.notEqual(v, stageVersionOfPayloads({ one: payload({ a: 'Alpha!', b: 'Beta' }) }))
  assert.notEqual(v, stageVersionOfPayloads({ one: payload({ a: 'Alpha', b: 'Beta' }, { status: 'approved' }) }))
  assert.notEqual(v, stageVersionOfPayloads({ one: payload({ a: 'Alpha', b: 'Beta' }, { owner: 'Sam' }) }))
  assert.notEqual(v, stageVersionOfPayloads({ one: { ...base.one, layout: [{ field: 'b' }, { field: 'a' }] } }))
  assert.notEqual(v, stageVersionOfPayloads({ one: { ...base.one, layout: [...base.one.layout, custom('c1', 'Notes', 'x')], fields: { ...base.one.fields, c1: 'x' } } }))
  assert.notEqual(v, stageVersionOfPayloads({ ...base, two: payload({ z: '' }) }))
})

test('a custom section counts by title, type and content, not by its client-side id', () => {
  const withId = (id) => ({ status: 'draft', owner: '', fields: { a: 'A', [id]: 'body' }, layout: [{ field: 'a' }, custom(id, 'Notes', 'body')] })
  assert.equal(stageVersionOfPayloads({ one: withId('client-7') }), stageVersionOfPayloads({ one: withId('custom:notes') }))
})

test('stageVersionOfModules reads the same entries GET /api/instance returns', () => {
  const entries = [{ id: 'one', status: 'draft', owner: '', fields: [{ id: 'a', type: 'markdown', value: 'Alpha' }] }]
  assert.equal(stageVersionOfModules(entries), stageVersionOfPayloads({ one: payload({ a: 'Alpha' }) }))
})

// ---- mergeStage ----

test('only the saved side changed a Field: theirs is taken', () => {
  const base = { one: payload({ a: 'Alpha', b: 'Beta' }) }
  const theirs = { one: payload({ a: 'Alpha (theirs)', b: 'Beta' }) }
  const out = mergeStage({ base, mine: base, theirs })
  assert.equal(out.payloads.one.fields.a, 'Alpha (theirs)')
  assert.deepEqual(out.conflicts, [])
  assert.deepEqual(out.toWrite, [], 'nothing of the saver\'s to write')
})

test('only the saver changed a Field: theirs is kept', () => {
  const base = { one: payload({ a: 'Alpha', b: 'Beta' }) }
  const mine = { one: payload({ a: 'Alpha', b: 'Beta (mine)' }) }
  const out = mergeStage({ base, mine, theirs: base })
  assert.equal(out.payloads.one.fields.b, 'Beta (mine)')
  assert.deepEqual(out.toWrite, ['one'])
})

test('different Fields of the same Module both survive', () => {
  const base = { one: payload({ a: 'Alpha', b: 'Beta' }) }
  const mine = { one: payload({ a: 'Alpha', b: 'Beta (mine)' }) }
  const theirs = { one: payload({ a: 'Alpha (theirs)', b: 'Beta' }) }
  const out = mergeStage({ base, mine, theirs })
  assert.equal(out.payloads.one.fields.a, 'Alpha (theirs)')
  assert.equal(out.payloads.one.fields.b, 'Beta (mine)')
  assert.deepEqual(out.conflicts, [])
  assert.deepEqual(out.toWrite, ['one'])
})

test('both changed the same Field differently: a conflict, until it is settled', () => {
  const base = { one: payload({ a: 'Alpha' }) }
  const mine = { one: payload({ a: 'Mine' }) }
  const theirs = { one: payload({ a: 'Theirs' }) }
  const open = mergeStage({ base, mine, theirs })
  assert.equal(open.conflicts.length, 1)
  assert.deepEqual({ moduleId: open.conflicts[0].moduleId, key: open.conflicts[0].key, kind: open.conflicts[0].kind }, { moduleId: 'one', key: 'field:a', kind: 'field' })
  assert.equal(open.conflicts[0].mine.value, 'Mine')
  assert.equal(open.conflicts[0].theirs.value, 'Theirs')

  for (const [choice, expected] of [['Mine', 'Mine'], ['Theirs', 'Theirs'], ['Edited by hand', 'Edited by hand']]) {
    const settled = mergeStage({ base, mine, theirs, resolutions: { [conflictKey('one', 'field:a')]: { value: choice } } })
    assert.deepEqual(settled.conflicts, [])
    assert.equal(settled.payloads.one.fields.a, expected)
  }
})

test('both made the same change: no conflict', () => {
  const base = { one: payload({ a: 'Alpha' }) }
  const both = { one: payload({ a: 'Same' }) }
  const out = mergeStage({ base, mine: both, theirs: both })
  assert.deepEqual(out.conflicts, [])
  assert.deepEqual(out.toWrite, [])
})

test('a Module the saver did not touch takes theirs wholesale, and is not written', () => {
  const base = { one: payload({ a: 'A' }), two: payload({ b: 'B' }) }
  const theirs = { one: payload({ a: 'A' }), two: payload({ b: 'B2' }) }
  const mine = { one: payload({ a: 'A!' }), two: base.two }
  const out = mergeStage({ base, mine, theirs })
  assert.equal(out.payloads.two.fields.b, 'B2')
  assert.deepEqual(out.toWrite, ['one'])
})

test('list Fields settle as wholes; a list Field both changed is a conflict whose text round-trips as lines', () => {
  const base = { one: payload({ l: ['a'] }) }
  const out = mergeStage({ base, mine: { one: payload({ l: ['a', 'm'] }) }, theirs: { one: payload({ l: ['a', 't'] }) } })
  assert.equal(out.conflicts.length, 1)
  assert.equal(conflictText(out.conflicts[0].mine.value), 'a\nm')
  assert.deepEqual(conflictValueFromText('a\n m \n\nt', out.conflicts[0].mine.value), ['a', 'm', 't'])
  assert.equal(conflictText(undefined), '')
})

test('custom sections: added by either side are both kept; edited on one side keeps that edit; matched by title', () => {
  const field = (extra) => ({ status: 'draft', owner: '', fields: { a: 'A', ...Object.fromEntries(extra.map((c) => [c.custom.id, c.custom.value])) }, layout: [{ field: 'a' }, ...extra] })
  const base = { one: field([custom('custom:notes', 'Notes', 'n0')]) }
  const mine = { one: field([custom('client-1', 'Notes', 'n0'), custom('client-2', 'Mine only', 'x')]) }
  const theirs = { one: field([custom('custom:notes', 'Notes', 'n1'), custom('custom:theirs-only', 'Theirs only', 'y')]) }
  const out = mergeStage({ base, mine, theirs })
  assert.deepEqual(out.conflicts, [])
  const titles = out.payloads.one.layout.filter((e) => e.custom).map((e) => `${e.custom.title}=${e.custom.value}`)
  assert.deepEqual(titles.sort(), ['Mine only=x', 'Notes=n1', 'Theirs only=y'])
})

test('a section removed by one side and edited by the other is a conflict that can be settled either way', () => {
  const withNotes = (value) => ({ status: 'draft', owner: '', fields: { a: 'A', n: value }, layout: [{ field: 'a' }, custom('n', 'Notes', value)] })
  const without = { status: 'draft', owner: '', fields: { a: 'A' }, layout: [{ field: 'a' }] }
  const base = { one: withNotes('n0') }
  const open = mergeStage({ base, mine: { one: without }, theirs: { one: withNotes('n1') } })
  assert.equal(open.conflicts.length, 1)
  assert.equal(open.conflicts[0].mine, undefined)
  const removed = mergeStage({ base, mine: { one: without }, theirs: { one: withNotes('n1') }, resolutions: { [conflictKey('one', 'custom:notes')]: { remove: true } } })
  assert.equal(removed.payloads.one.layout.some((e) => e.custom), false)
  const kept = mergeStage({ base, mine: { one: without }, theirs: { one: withNotes('n1') }, resolutions: { [conflictKey('one', 'custom:notes')]: { value: 'n1' } } })
  assert.equal(kept.payloads.one.layout.find((e) => e.custom).custom.value, 'n1')
})

test('status and owner settle like any Field', () => {
  const base = { one: payload({ a: 'A' }) }
  const out = mergeStage({
    base,
    mine: { one: payload({ a: 'A' }, { status: 'approved' }) },
    theirs: { one: payload({ a: 'A' }, { owner: 'Sam' }) },
  })
  assert.equal(out.payloads.one.status, 'approved')
  assert.equal(out.payloads.one.owner, 'Sam')
  const clash = mergeStage({ base, mine: { one: payload({ a: 'A' }, { owner: 'Me' }) }, theirs: { one: payload({ a: 'A' }, { owner: 'Sam' }) } })
  assert.equal(clash.conflicts[0].kind, 'owner')
})

test('the settled content hashes to a version a fresh read of it would give', () => {
  const base = { one: payload({ a: 'Alpha', b: 'Beta' }) }
  const mine = { one: payload({ a: 'Alpha', b: 'Beta (mine)' }) }
  const theirs = { one: payload({ a: 'Alpha (theirs)', b: 'Beta' }) }
  const out = mergeStage({ base, mine, theirs })
  assert.equal(stageVersionOfPayloads(out.payloads), stageVersionOfPayloads({ one: payload({ a: 'Alpha (theirs)', b: 'Beta (mine)' }) }))
})
