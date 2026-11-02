import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fieldWriteNotes } from '../web/lib/fieldCheck.js'
import { checkDraft } from '../web/lib/interviewDraft.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #306 (docs/adr/0067): every content write gets the per-Field check as notes. `PUT /api/instance/modules` (and so MCP's
// `update_instance_modules`) runs the same check the AI interview's draft field step runs: a select value within its options,
// a word budget, every figure cited or marked "(target assumption)". Problems come back as `fieldNotes`; the save succeeds.

const MODULE = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
    target-words:
      small: 5
      medium: 8
      large: 20
  - id: priority
    title: Priority
    type: select
    options:
      - High
      - Low
  - id: areas
    title: Areas
    type: select
    multiple: true
    options:
      - Web
      - Mobile
  - id: owner
    title: Owner
    type: text
`

const DEFINITION = `id: noted
version: 1
status: published
title: noted
description: A one-stage fixture
stages:
  - id: draft
    title: Draft
    purpose: Write it
    gate: drafted
    modules:
      - summary
artefacts:
  - id: brief
    title: Brief
    purpose: The brief
    template: templates/brief.md.tmpl
    gate: drafted
    requires:
      - summary
`

async function withServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-306-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  mkdirSync(instancesDir, { recursive: true })
  const dir = join(definitionsDir, 'noted', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), DEFINITION)
  writeFileSync(join(dir, 'modules', 'summary.yaml'), MODULE)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
  try {
    return await withRunningServer({ definitionsDir, instancesDir }, (base) => fn({ base }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const put = (body) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function save(base, slug, fields) {
  const res = await fetch(`${base}/api/instance/modules?slug=${slug}`, put({ modules: { summary: { fields } } }))
  return { status: res.status, body: await res.json() }
}

test('an out-of-options select value, an over-budget Field and an uncited figure each come back as a note, and the save succeeds', () =>
  withServer(async ({ base }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'noted', slug: 'one' }))
    const { status, body } = await save(base, 'one', {
      priority: 'Urgent',
      overview: 'One two three four five six seven eight nine ten.',
      owner: 'Expected to cut cost by 40% in 2027',
    })
    assert.equal(status, 200)
    assert.deepEqual(body.saved, ['summary'])
    assert.deepEqual(body.fieldNotes.map((n) => [n.module, n.field, n.kind]), [
      ['summary', 'priority', 'options'],
      ['summary', 'overview', 'budget'],
      ['summary', 'owner', 'figures'],
    ])
    assert.match(body.fieldNotes[0].message, /^summary\.priority: "Urgent" is not one of the options/)
    assert.match(body.fieldNotes[1].message, /^summary\.overview: 10 words is over the Medium budget of about 8/)
    assert.match(body.fieldNotes[2].message, /^summary\.owner: "40%", "2027" have no source/)
    assert.equal(body.targetWordNotes.length, 1, 'the established over-budget notes are still returned')
  }))

test('a clean write returns no notes', () =>
  withServer(async ({ base }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'noted', slug: 'clean' }))
    const { status, body } = await save(base, 'clean', {
      priority: 'High',
      areas: ['Web', 'Mobile'],
      overview: 'Cut 40% [Brief](source:brief).',
      owner: 'Growth is a target of 12 users (target assumption)',
    })
    assert.equal(status, 200)
    assert.deepEqual(body.fieldNotes, [])
    assert.deepEqual(body.targetWordNotes, [])
  }))

test('the notes follow the Instance\'s size and never block a repeat save', () =>
  withServer(async ({ base }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'noted', slug: 'big', size: 'large' }))
    const wordy = 'One two three four five six seven eight nine ten.'
    const large = await save(base, 'big', { overview: wordy })
    assert.deepEqual(large.body.fieldNotes, [])
    await fetch(`${base}/api/instances`, json({ definition: 'noted', slug: 'little', size: 'small' }))
    const small = await save(base, 'little', { overview: wordy })
    assert.deepEqual(small.body.fieldNotes.map((n) => n.kind), ['budget'])
    assert.equal((await save(base, 'little', { overview: wordy })).status, 200)
  }))

// ---------- the shared implementation ----------

const FIELDS = new Map([
  ['summary', { id: 'summary', fields: [
    { id: 'priority', type: 'select', options: ['High', 'Low'] },
    { id: 'overview', type: 'markdown', targetWords: { small: 2, medium: 3, large: 4 } },
  ] }],
])

test('a select value is checked as written, not matched to an option\'s case, because the written value is what is stored', () => {
  assert.deepEqual(fieldWriteNotes(FIELDS, { summary: { fields: { priority: 'high' } } }, 'medium').map((n) => n.kind), ['options'])
  assert.deepEqual(checkDraft({ id: 'priority', type: 'select', options: ['High', 'Low'] }, 'high').problems, [], 'the draft step still tidies the case')
})

test('the notes are the draft field step\'s own problems, word for word', () => {
  const field = FIELDS.get('summary').fields[1]
  const value = 'One two three four 40% in 2027.'
  const drafted = checkDraft(field, value, { size: 'medium', label: 'summary.overview' }).problems
  const written = fieldWriteNotes(FIELDS, { summary: { fields: { overview: value } } }, 'medium')
  assert.deepEqual(written.map((n) => n.message), drafted.map((p) => p.message))
})

test('fields the Definition does not declare, and Modules with no fields, are left alone', () => {
  assert.deepEqual(fieldWriteNotes(FIELDS, { summary: { fields: { extra: 'Cut by 40%' } }, other: { fields: { a: 'x' } }, bare: { status: 'done' } }, 'medium'), [])
  assert.deepEqual(fieldWriteNotes(FIELDS, undefined, 'medium'), [])
})
