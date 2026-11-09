import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition, findDefinitionProblems, findDefinitionProblemsInStructure } from '../lib/definition.js'
import { renderArtefact } from '../lib/render.js'
import { getStatus } from '../lib/status.js'
import { readModule, writeModule } from '../lib/instance.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { buildLocalModuleEntry, parseLocalModuleFile, renderLocalModuleInstanceFile } from '../web/lib/localInstanceFiles.js'
import {
  STANDARD_MODULES,
  resolveStandardModule,
  standardModuleProblems,
  keyDecisionsSettings,
  keyDecisionWarnings,
} from '../web/lib/standardModules.js'
import {
  parseKeyDecisions,
  serialiseKeyDecisions,
  addDecision,
  removeDecision,
  moveDecision,
  nextDecisionNumber,
  whySentence,
  renderKeyDecisions,
  keyDecisionProblems,
  decisionReference,
  decisionStyleGuidance,
  decisionStyleSummary,
  DECISION_STYLES,
  STYLE_PARTS,
  STYLE_LINKS,
} from '../web/lib/keyDecisions.js'

// #284 (ADR-0065): the Key decisions standard module. A Definition mounts it with a prefix and a
// decision style (default, or WH(Y)); each decision keeps the number it was given when decisions are
// reordered or removed; both styles round-trip through the editor's text and print in Word; the
// validator checks the prefix, the style and the links.

const COMMIT = { sha: '0000000000000000000000000000000000000000', shortSha: '0000000', branch: 'main', date: '2026-01-01T00:00:00Z' }

const DEFAULT_TEXT = `**AD01: Use PostgreSQL**

**Context:** The ledger needs transactions.

**Decision:** Postgres 16.

**Why:** Strong consistency.
Second line of the reason.

**Considered options:** MySQL, DynamoDB.

**Consequences:** We run a database.

**AD03: Keep sessions in Redis**

**Context:** Sessions are hot.`

const WHY_TEXT = `**AD01: Use PostgreSQL**

**In the context of:** the ledger

**Facing:** a need for transactions

**We decided for:** PostgreSQL 16

**And neglected:** MySQL

**To achieve:** strong consistency

**Accepting that:** we run a database

**AD02: Cache reads**

**In the context of:** read-heavy traffic

**We decided for:** a read-through cache

**Depends on:** AD01

**Relates to:** AD01, AD04`

// ---------- the text: both styles, stable numbers ----------

test('the default style reads and writes back exactly as written', () => {
  const parsed = parseKeyDecisions(DEFAULT_TEXT)
  assert.deepEqual(parsed.decisions.map((d) => [d.number, d.title]), [[1, 'Use PostgreSQL'], [3, 'Keep sessions in Redis']])
  assert.equal(parsed.decisions[0].context, 'The ledger needs transactions.')
  assert.equal(parsed.decisions[0].why, 'Strong consistency.\nSecond line of the reason.')
  assert.equal(parsed.decisions[0].options, 'MySQL, DynamoDB.')
  assert.equal(serialiseKeyDecisions(parsed, { prefix: 'AD' }), DEFAULT_TEXT)
})

test('WH(Y) reads the six parts and the typed links, and writes them back exactly as written', () => {
  const parsed = parseKeyDecisions(WHY_TEXT)
  const [first, second] = parsed.decisions
  assert.equal(first.inContext, 'the ledger')
  assert.equal(first.facing, 'a need for transactions')
  assert.equal(first.decided, 'PostgreSQL 16')
  assert.equal(first.neglected, 'MySQL')
  assert.equal(first.achieve, 'strong consistency')
  assert.equal(first.accepting, 'we run a database')
  assert.deepEqual(second.links, [
    { type: 'depends-on', to: 1, raw: 'AD01' },
    { type: 'relates-to', to: 1, raw: 'AD01' },
    { type: 'relates-to', to: 4, raw: 'AD04' },
  ])
  assert.equal(serialiseKeyDecisions(parsed, { prefix: 'AD' }), WHY_TEXT)
})

test('an empty Field has no decisions, and the first one added is number 1', () => {
  assert.deepEqual(parseKeyDecisions('').decisions, [])
  assert.deepEqual(parseKeyDecisions(undefined).decisions, [])
  assert.equal(serialiseKeyDecisions(parseKeyDecisions('')), '')
  const added = addDecision(parseKeyDecisions(''))
  assert.deepEqual(added.decisions.map((d) => d.number), [1])
  assert.equal(serialiseKeyDecisions(added, { prefix: 'AD' }), '**AD01**')
})

test('numbers stay stable when decisions are reordered or removed, and a removed number is never handed out again', () => {
  let parsed = parseKeyDecisions('')
  for (let i = 0; i < 3; i++) parsed = addDecision(parsed)
  parsed = { ...parsed, decisions: parsed.decisions.map((d) => ({ ...d, title: `Decision ${d.number}` })) }
  assert.deepEqual(parsed.decisions.map((d) => d.number), [1, 2, 3])

  // Reordering moves the decision, not its number.
  const moved = moveDecision(parsed, 3, -2)
  assert.deepEqual(moved.decisions.map((d) => [d.number, d.title]), [[3, 'Decision 3'], [1, 'Decision 1'], [2, 'Decision 2']])
  const reread = parseKeyDecisions(serialiseKeyDecisions(moved, { prefix: 'AD' }))
  assert.deepEqual(reread.decisions.map((d) => d.number), [3, 1, 2])
  // Moving past either end is a no-op.
  assert.equal(moveDecision(parsed, 1, -1), parsed)
  assert.equal(moveDecision(parsed, 3, 1), parsed)

  // Removing leaves a gap; the others keep their numbers.
  const removed = removeDecision(parsed, 2)
  assert.deepEqual(removed.decisions.map((d) => d.number), [1, 3])
  assert.deepEqual(parseKeyDecisions(serialiseKeyDecisions(removed, { prefix: 'AD' })).decisions.map((d) => d.number), [1, 3])

  // Removing the highest and adding again does not reuse its number, even after the text is saved and read back.
  const withoutLast = removeDecision(parsed, 3)
  const text = serialiseKeyDecisions(withoutLast, { prefix: 'AD' })
  assert.match(text, /<!-- next: 4 -->$/)
  const again = addDecision(parseKeyDecisions(text))
  assert.deepEqual(again.decisions.map((d) => d.number), [1, 2, 4])
  assert.equal(nextDecisionNumber(parseKeyDecisions(text)), 4)
})

test('the next-number line is only written when it protects a removed number', () => {
  const parsed = parseKeyDecisions(DEFAULT_TEXT)
  assert.doesNotMatch(serialiseKeyDecisions(parsed, { prefix: 'AD' }), /next:/)
  // A hand-written Field with no such line numbers its next decision above the highest present.
  assert.equal(nextDecisionNumber(parsed), 4)
})

test('words that look like structure survive a round trip as typed', () => {
  const parsed = parseKeyDecisions('')
  const one = addDecision(parsed)
  const tricky = '**Decision:** is the label I mean to type\n**AD09: not a heading**\n<!-- next: 99 -->'
  const edited = { ...one, decisions: [{ ...one.decisions[0], title: 'Tricky', context: tricky }] }
  const text = serialiseKeyDecisions(edited, { prefix: 'AD' })
  const back = parseKeyDecisions(text)
  assert.equal(back.decisions.length, 1)
  assert.equal(back.decisions[0].context, tricky)
  assert.equal(back.decisions[0].decision, '')
  assert.equal(back.next, 2)
})

test('text written by hand outside the layout is kept, not lost', () => {
  const text = 'Some introduction.\n\n**AD01: First**\n\nA stray note.\n\n**Context:** C'
  const parsed = parseKeyDecisions(text)
  assert.equal(parsed.preamble, 'Some introduction.')
  assert.equal(parsed.decisions[0].lead, 'A stray note.')
  assert.equal(serialiseKeyDecisions(parsed, { prefix: 'AD' }), text)
})

test('reading accepts any prefix and writing uses the Definition\'s, so a changed prefix keeps every number', () => {
  const parsed = parseKeyDecisions(WHY_TEXT)
  const text = serialiseKeyDecisions(parsed, { prefix: 'KD' })
  assert.match(text, /^\*\*KD01: Use PostgreSQL\*\*/)
  assert.match(text, /\*\*Depends on:\*\* KD01/)
  assert.deepEqual(parseKeyDecisions(text).decisions.map((d) => d.number), [1, 2])
  assert.equal(decisionReference('AD', 7), 'AD07')
  assert.equal(decisionReference('AD', 123), 'AD123')
})

// ---------- printing in Word ----------

test('WH(Y) prints each decision as its one-sentence statement, then its links, under the current prefix', () => {
  const printed = renderKeyDecisions(WHY_TEXT, { prefix: 'AD', style: 'why' })
  assert.match(printed, /\*\*AD01: Use PostgreSQL\*\*\n\nIn the context of the ledger, facing a need for transactions, we decided for PostgreSQL 16 and neglected MySQL, to achieve strong consistency, accepting that we run a database\./)
  assert.match(printed, /\*\*AD02: Cache reads\*\*\n\nIn the context of read-heavy traffic, we decided for a read-through cache\.\n\nDepends on AD01\.\n\nRelates to AD01, AD04\./)
  assert.doesNotMatch(printed, /<!--/)
  // A different prefix re-spells every number and reference.
  assert.match(renderKeyDecisions(WHY_TEXT, { prefix: 'DEC', style: 'why' }), /Depends on DEC01\./)
})

test('the default style prints as written, without the editor\'s bookkeeping line', () => {
  const removed = serialiseKeyDecisions(removeDecision(parseKeyDecisions(DEFAULT_TEXT), 3), { prefix: 'AD' })
  assert.match(removed, /<!-- next: 4 -->/)
  const printed = renderKeyDecisions(removed, { prefix: 'AD', style: 'default' })
  assert.doesNotMatch(printed, /<!--/)
  assert.match(printed, /\*\*Context:\*\* The ledger needs transactions\./)
  assert.match(printed, /\*\*Consequences:\*\* We run a database\./)
})

test('the one-sentence statement leaves out a part that has no words, with its connector', () => {
  assert.equal(whySentence({ inContext: 'the ledger', decided: 'Postgres', accepting: 'upkeep.' }), 'In the context of the ledger, we decided for Postgres, accepting that upkeep.')
  assert.equal(whySentence({ decided: 'Postgres', neglected: 'MySQL' }), 'We decided for Postgres and neglected MySQL.')
  assert.equal(whySentence({ neglected: 'MySQL' }), 'Neglected MySQL.')
  assert.equal(whySentence({}), '')
})

test('a Field with no decisions in it prints as it is', () => {
  assert.equal(renderKeyDecisions('Just prose.', { prefix: 'AD', style: 'why' }), 'Just prose.')
  assert.equal(renderKeyDecisions('', { prefix: 'AD', style: 'why' }), '')
})

// ---------- the checks on a Field's decisions ----------

test('the checks name a repeated number, a link to nothing, to itself, to a non-number, and a loop', () => {
  assert.deepEqual(keyDecisionProblems(WHY_TEXT, { prefix: 'AD', style: 'why' }), ['AD02 relates to AD04, which is not in this list'])
  assert.deepEqual(keyDecisionProblems(DEFAULT_TEXT, { prefix: 'AD', style: 'default' }), [])

  const messy = `**AD01: A**\n\n**Depends on:** AD01, banana, AD02\n\n**AD01: Again**\n\n**AD02: B**\n\n**Depends on:** AD01`
  const problems = keyDecisionProblems(messy, { prefix: 'AD', style: 'why' })
  assert.ok(problems.includes('AD01 is used by more than one decision'))
  assert.ok(problems.includes('AD01 depends on itself'))
  assert.ok(problems.includes('AD01 depends on "banana", which is not a decision number'))
  assert.ok(problems.some((p) => /^Depends on loops back on itself through AD0[12], AD0[12]$/.test(p)), JSON.stringify(problems))

  // Links belong to WH(Y): a default-style Field holding them is flagged.
  assert.ok(keyDecisionProblems(WHY_TEXT, { prefix: 'AD', style: 'default' }).some((p) => /uses the default decision style/.test(p)))
})

// ---------- the catalogue and the mount ----------

test('Key decisions is version 1, one Markdown Field, frozen', () => {
  const v1 = STANDARD_MODULES['key-decisions'].versions[1]
  assert.deepEqual(v1.fields.map((f) => [f.id, f.title, f.type, f.required, f.requiredAt]), [['decisions', 'Key decisions', 'markdown', undefined, undefined]])
  assert.deepEqual(v1.fields[0].targetWords, { small: 200, medium: 420, large: 720 })
  assert.match(v1.fields[0].guidance, /hard to reverse, surprising without its context/)
  assert.equal(Object.isFrozen(v1), true)
  // #356: how to write each style is built from the style's parts when a mount resolves, not pinned here.
  assert.equal('styleGuidance' in v1, false)
})

test('a mount carries a prefix and a style; either left out takes its default', () => {
  assert.deepEqual(keyDecisionsSettings({ id: 'key-decisions', version: 1 }), { prefix: 'KD', style: 'default' })
  assert.deepEqual(keyDecisionsSettings({ prefix: 'AD', style: 'why' }), { prefix: 'AD', style: 'why' })

  const plain = resolveStandardModule({ id: 'key-decisions', version: 1 })
  assert.deepEqual(plain.standard, { version: 1, prefix: 'KD', style: 'default' })
  assert.match(plain.fields[0].guidance, /\*\*Context:\*\* /)

  const why = resolveStandardModule({ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why', guidance: 'Link every decision.' })
  assert.deepEqual(why.standard, { version: 1, prefix: 'AD', style: 'why' })
  assert.match(why.fields[0].guidance, /\*\*In the context of:\*\* /)
  assert.match(why.fields[0].guidance, /Link every decision\.$/)
  // Resolving never edits the catalogue.
  assert.doesNotMatch(STANDARD_MODULES['key-decisions'].versions[1].fields[0].guidance, /In the context of/)

  // Other standard modules still resolve exactly as before.
  assert.deepEqual(resolveStandardModule({ id: 'glossary', version: 1 }).standard, { version: 1 })
})

test('the validator accepts a prefix and a style on Key decisions and checks them', () => {
  assert.deepEqual(standardModuleProblems([{ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' }]), [])
  assert.deepEqual(standardModuleProblems([{ id: 'key-decisions', version: 1 }]), [])
  assert.deepEqual(standardModuleProblems([{ id: 'key-decisions', version: 1, guidance: 'More.', interview: 'Ask.' }]), [])

  for (const prefix of ['', 'ad', 'A1', 'ABCDEFG', 'A-D', 5, null]) {
    const problems = standardModuleProblems([{ id: 'key-decisions', version: 1, prefix }])
    assert.deepEqual(problems.map((p) => p.type), ['invalid-key-decisions-prefix'], `prefix ${JSON.stringify(prefix)}`)
    assert.match(problems[0].message, /^Standard module "key-decisions" sets prefix .* 1 to 6 capital letters/)
  }
  for (const style of ['', 'WH(Y)', 'fancy', 1, null]) {
    const problems = standardModuleProblems([{ id: 'key-decisions', version: 1, style }])
    assert.deepEqual(problems.map((p) => p.type), ['invalid-key-decisions-style'], `style ${JSON.stringify(style)}`)
    assert.match(problems[0].message, /"default" or "why"/)
  }

  // Still no other key changes the shape, and the prefix and style are Key decisions' alone.
  assert.deepEqual(standardModuleProblems([{ id: 'key-decisions', version: 1, fields: [] }]).map((p) => p.type), ['standard-module-shape-changed'])
  assert.deepEqual(standardModuleProblems([{ id: 'glossary', version: 1, prefix: 'AD' }]).map((p) => p.type), ['standard-module-shape-changed'])
  assert.deepEqual(standardModuleProblems([{ id: 'open-questions', version: 1, style: 'why' }]).map((p) => p.type), ['standard-module-shape-changed'])
})

test('the in-memory and Local Workspace validators check prefix and style too', () => {
  const structure = (mount) => ({
    id: 'dec',
    stages: [{ id: 'shape', gate: 'shaped', modules: ['key-decisions'] }],
    artefacts: [{ id: 'doc', gate: 'shaped', requires: ['key-decisions.decisions'] }],
    modules: [],
    standardModules: [mount],
  })
  const good = structure({ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' })
  assert.deepEqual(findDefinitionProblemsInStructure(good), [])
  assert.deepEqual(findLocalDefinitionProblems(good), [])
  const bad = structure({ id: 'key-decisions', version: 1, prefix: 'ad', style: 'plain' })
  for (const problems of [findDefinitionProblemsInStructure(bad), findLocalDefinitionProblems(bad)]) {
    assert.deepEqual(problems.map((p) => p.type).sort(), ['invalid-key-decisions-prefix', 'invalid-key-decisions-style'])
  }
})

// ---------- on disk: mounting, saving, status, the Word render ----------

function definitionYaml(mount) {
  return `id: dec
version: 1
status: published
title: Decisions
description: Mounts Key decisions
standard-modules:
${mount}stages:
  - id: shape
    title: Shape
    purpose: Shape it
    gate: shaped
    modules: [key-decisions]
artefacts:
  - id: doc
    title: Document
    purpose: The document
    template: templates/doc.md.tmpl
    gate: shaped
    requires: [key-decisions]
`
}

const TEMPLATE = `# Doc

## Decisions

<%~ it.modules['key-decisions'].decisions %>
`

function withScratch(mount, fn) {
  const root = mkdtempSync(join(tmpdir(), 'key-decisions-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const dir = join(definitionsDir, 'dec', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(mount))
  writeFileSync(join(dir, 'templates', 'doc.md.tmpl'), TEMPLATE)
  const instance = join(instancesDir, 'harbour')
  mkdirSync(join(instance, 'modules'), { recursive: true })
  writeFileSync(join(instance, 'instance.yaml'), 'definition: dec\nslug: harbour\nname: Harbour\nstage: shape\nassignee: a.person\ndefinitionVersion: 1\n')
  try {
    return fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const WHY_MOUNT = '  - id: key-decisions\n    version: 1\n    prefix: AD\n    style: why\n'
const DEFAULT_MOUNT = '  - id: key-decisions\n    version: 1\n    prefix: AD\n'

test('a Definition mounts Key decisions with a prefix and a style, and it loads like any Module', () =>
  withScratch(WHY_MOUNT, ({ definitionsDir }) => {
    assert.deepEqual(findDefinitionProblems('dec', { definitionsDir }), [])
    const def = loadDefinition('dec', { definitionsDir })
    const module = def.modules.get('key-decisions')
    assert.deepEqual(module.standard, { version: 1, prefix: 'AD', style: 'why' })
    assert.deepEqual(module.fields.map((f) => f.id), ['decisions'])
    assert.deepEqual(def.standardModules, [{ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' }])
  }))

test('the disk validator refuses a bad prefix or style in definition.yaml', () =>
  withScratch('  - id: key-decisions\n    version: 1\n    prefix: ad1\n    style: fancy\n', ({ definitionsDir }) => {
    const problems = findDefinitionProblems('dec', { definitionsDir })
    assert.deepEqual(problems.filter((p) => /^Standard module /.test(p.message)).map((p) => p.type).sort(), ['invalid-key-decisions-prefix', 'invalid-key-decisions-style'])
  }))

test('decisions save into the Instance and read back as written, numbers intact', () =>
  withScratch(WHY_MOUNT, ({ definitionsDir, instancesDir }) => {
    const def = loadDefinition('dec', { definitionsDir })
    writeModule(def, 'harbour', 'key-decisions', { status: 'draft', owner: 'a.person', fields: { decisions: WHY_TEXT } }, { instancesDir })
    const back = readModule(def, 'harbour', 'key-decisions', { instancesDir })
    assert.equal(back.fields.decisions, WHY_TEXT)
    assert.deepEqual(parseKeyDecisions(back.fields.decisions).decisions.map((d) => d.number), [1, 2])
  }))

test('the Word render prints WH(Y) as statements with their links, and the default style as written', () =>
  withScratch(WHY_MOUNT, ({ definitionsDir, instancesDir }) => {
    const def = loadDefinition('dec', { definitionsDir })
    writeModule(def, 'harbour', 'key-decisions', { status: 'agreed', owner: 'a.person', fields: { decisions: WHY_TEXT } }, { instancesDir })
    const { markdown, docxMarkdown } = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir, instancesDir, commit: COMMIT })
    for (const text of [markdown, docxMarkdown]) {
      assert.match(text, /\*\*AD01: Use PostgreSQL\*\*/)
      assert.match(text, /In the context of the ledger, facing a need for transactions, we decided for PostgreSQL 16 and neglected MySQL/)
      assert.match(text, /Depends on AD01\./)
      assert.match(text, /Relates to AD01, AD04\./)
    }
  }))

test('the default style renders its labelled parts', () =>
  withScratch(DEFAULT_MOUNT, ({ definitionsDir, instancesDir }) => {
    const def = loadDefinition('dec', { definitionsDir })
    writeModule(def, 'harbour', 'key-decisions', { status: 'agreed', owner: 'a.person', fields: { decisions: DEFAULT_TEXT } }, { instancesDir })
    const { markdown } = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir, instancesDir, commit: COMMIT })
    assert.match(markdown, /\*\*AD03: Keep sessions in Redis\*\*/)
    assert.match(markdown, /\*\*Decision:\*\* Postgres 16\./)
  }))

test('check warns about a link to a decision that is not there, and a clean Field warns about nothing', () =>
  withScratch(WHY_MOUNT, ({ definitionsDir, instancesDir }) => {
    const def = loadDefinition('dec', { definitionsDir })
    const statusWith = (text) => {
      writeModule(def, 'harbour', 'key-decisions', { status: 'draft', owner: 'a.person', fields: { decisions: text } }, { instancesDir })
      return getStatus('harbour', { definitionsDir, instancesDir }).modules.flatMap((m) => m.warnings)
    }
    assert.deepEqual(statusWith(WHY_TEXT), ['Module "Key decisions" field "Key decisions": AD02 relates to AD04, which is not in this list'])
    const clean = statusWith(WHY_TEXT.replace('**Relates to:** AD01, AD04', '**Relates to:** AD01'))
    assert.deepEqual(clean, [])
  }))

test('the warnings helper ignores every other Module and an unsaved one', () => {
  const key = resolveStandardModule({ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' })
  assert.deepEqual(keyDecisionWarnings(key, false, { decisions: '**AD01: A**\n\n**Depends on:** AD05' }), [])
  assert.equal(keyDecisionWarnings(key, true, { decisions: '**AD01: A**\n\n**Depends on:** AD05' }).length, 1)
  const glossary = resolveStandardModule({ id: 'glossary', version: 1 })
  assert.deepEqual(keyDecisionWarnings(glossary, true, { terms: '**AD01: A**\n\n**Depends on:** AD05' }), [])
})

test('the Local Workspace editor is told a Module is Key decisions, with its prefix and style, and the text round-trips through its files', () => {
  const key = resolveStandardModule({ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' })
  const stage = { id: 'shape', gate: 'shaped' }
  const entry = buildLocalModuleEntry(key, stage, { status: 'draft', owner: '', fields: { decisions: WHY_TEXT } }, null, [stage])
  assert.deepEqual(entry.keyDecisions, { prefix: 'AD', style: 'why' })
  assert.equal(entry.fields[0].value, WHY_TEXT)
  const other = buildLocalModuleEntry(resolveStandardModule({ id: 'glossary', version: 1 }), stage, { status: 'draft', owner: '', fields: {} }, null, [stage])
  assert.equal('keyDecisions' in other, false)

  const file = renderLocalModuleInstanceFile('key-decisions', key, { status: 'draft', owner: 'a.person', fields: { decisions: WHY_TEXT } })
  assert.deepEqual(parseLocalModuleFile(file, key).fields.decisions, WHY_TEXT)
})

// ---------- #356: a part's label however it is laid out, in whichever style the Definition uses ----------
//
// The AI wrote every part of AD01 and AD02 in WH(Y), with plain labels, and Gantry read none of them: it only
// knew `**Label:** …`. Gantry now reads a part's or a link's label at the start of a line whether it is plain,
// bold with the colon inside or outside, italic, or a bullet, for every label of every style (STYLE_PARTS and
// STYLE_LINKS), and still writes the one standard form.

// The Field as the AI wrote it in the issue: plain labels, one part per line, WH(Y), prefix AD.
const PLAIN_WHY_TEXT = `**AD01: Use PostgreSQL for the ledger**

In the context of: the payments ledger
Facing: the need to never lose or double-count a payment
We decided for: PostgreSQL 16
And neglected: DynamoDB
To achieve: transactions that keep every payment consistent
Accepting that: we run and patch a database cluster
Relates to: AD02

**AD02: Cache account balances**

In the context of: balance look-ups on every page
Facing: slow reads at month end
We decided for: a read-through cache
And neglected: reading the ledger every time
To achieve: fast pages
Accepting that: a balance can be a few seconds old
Depends on: AD01`

const layouts = (label, text) => [
  `${label}: ${text}`,
  `**${label}:** ${text}`,
  `**${label}**: ${text}`,
  `__${label}:__ ${text}`,
  `*${label}:* ${text}`,
  `_${label}_: ${text}`,
  `***${label}:*** ${text}`,
  `**_${label}:_** ${text}`,
  `- ${label}: ${text}`,
  `* **${label}:** ${text}`,
  `+ **${label}**: ${text}`,
  `- *${label}*: ${text}`,
  `${label.toUpperCase()}: ${text}`,
]

test('#356: the issue\'s AD01 and AD02, written with plain labels, read with all six parts and both links', () => {
  const [first, second] = parseKeyDecisions(PLAIN_WHY_TEXT).decisions
  assert.deepEqual(STYLE_PARTS.why.map((part) => first[part.key]), [
    'the payments ledger',
    'the need to never lose or double-count a payment',
    'PostgreSQL 16',
    'DynamoDB',
    'transactions that keep every payment consistent',
    'we run and patch a database cluster',
  ])
  assert.equal(first.lead, '')
  assert.deepEqual(first.links, [{ type: 'relates-to', to: 2, raw: 'AD02' }])
  assert.equal(second.accepting, 'a balance can be a few seconds old')
  assert.deepEqual(second.links, [{ type: 'depends-on', to: 1, raw: 'AD01' }])
  assert.deepEqual(keyDecisionProblems(PLAIN_WHY_TEXT, { prefix: 'AD', style: 'why' }), [])
})

test('#356: every part and link label of every style is read in each common layout', () => {
  const labels = [
    ...DECISION_STYLES.flatMap((style) => STYLE_PARTS[style].map((part) => ({ label: part.label, read: (d) => d[part.key] }))),
    ...DECISION_STYLES.flatMap((style) => STYLE_LINKS[style].map((link) => ({ label: link.label, read: (d) => d.links.filter((l) => l.type === link.type).map((l) => l.raw).join(', ') }))),
  ]
  assert.ok(labels.length >= 14, 'both styles\' parts and WH(Y)\'s links')
  for (const { label, read } of labels) {
    for (const line of layouts(label, 'AD07')) {
      const parsed = parseKeyDecisions(`**AD01: A**\n\n${line}`)
      assert.equal(read(parsed.decisions[0]), 'AD07', JSON.stringify(line))
      assert.equal(parsed.decisions[0].lead, '', JSON.stringify(line))
    }
  }
  // Anything else at the start of a line is the words of the part above it.
  for (const line of ['Contextual: no', 'The Context: no', '**Context:* no', '**Context:**no-space-is-still-a-label']) {
    const parsed = parseKeyDecisions(`**AD01: A**\n\n**Facing:** x\n${line}`)
    if (line.startsWith('**Context:**')) assert.equal(parsed.decisions[0].context, 'no-space-is-still-a-label')
    else assert.equal(parsed.decisions[0].facing, `x\n${line}`, JSON.stringify(line))
  }
})

test('#356: writing uses the one standard form, and the round trip is stable', () => {
  const written = serialiseKeyDecisions(parseKeyDecisions(PLAIN_WHY_TEXT), { prefix: 'AD' })
  assert.match(written, /^\*\*In the context of:\*\* the payments ledger$/m)
  assert.match(written, /^\*\*Accepting that:\*\* we run and patch a database cluster$/m)
  assert.match(written, /^\*\*Relates to:\*\* AD02$/m)
  assert.doesNotMatch(written, /^In the context of:/m)
  assert.equal(serialiseKeyDecisions(parseKeyDecisions(written), { prefix: 'AD' }), written)
  assert.deepEqual(parseKeyDecisions(written), parseKeyDecisions(PLAIN_WHY_TEXT))

  const plainDefault = '**AD01: Use PostgreSQL**\n\n- Context: The ledger needs transactions.\n- **Decision**: Postgres 16.\n*Why:* Strong consistency.'
  const back = serialiseKeyDecisions(parseKeyDecisions(plainDefault), { prefix: 'AD' })
  assert.equal(back, '**AD01: Use PostgreSQL**\n\n**Context:** The ledger needs transactions.\n\n**Decision:** Postgres 16.\n\n**Why:** Strong consistency.')
})

test('#356: an architect\'s line that now looks like a label still comes back as typed', () => {
  const typed = [
    'We weighed this for a month.',
    'Decision: revisit it every year.',
    '- Why: the licence costs change.',
    '**Considered options**: MySQL.',
    'context: lower case too',
    '### AD09: not a heading either',
    '\\Context: a backslash I typed myself',
    '\\\\**Why:** two of them',
    'AD04: a plain reference, which is never a header',
  ].join('\n')
  for (const style of DECISION_STYLES) {
    const key = STYLE_PARTS[style][0].key
    const one = addDecision(parseKeyDecisions(''))
    const edited = { ...one, decisions: [{ ...one.decisions[0], title: 'Tricky', [key]: typed, lead: typed }] }
    const text = serialiseKeyDecisions(edited, { prefix: 'AD' })
    const back = parseKeyDecisions(text)
    assert.equal(back.decisions.length, 1, style)
    assert.equal(back.decisions[0][key], typed, style)
    assert.equal(back.decisions[0].lead, typed, style)
    for (const part of [...STYLE_PARTS.default, ...STYLE_PARTS.why]) if (part.key !== key) assert.equal(back.decisions[0][part.key], '', `${style} ${part.key}`)
    assert.deepEqual(back.decisions[0].links, [])
    assert.equal(serialiseKeyDecisions(back, { prefix: 'AD' }), text, 'stable on a second pass')
  }
})

test('#356: a decision header may also be a Markdown heading; a plain "AD01: Title" line is not one', () => {
  const parsed = parseKeyDecisions('### AD01: Use PostgreSQL\n\nContext: the ledger\n\n## **AD02: Cache reads**\n\nContext: hot reads\n\n#### KD3\n\nAD04: Not a header')
  assert.deepEqual(parsed.decisions.map((d) => [d.number, d.title]), [[1, 'Use PostgreSQL'], [2, 'Cache reads']])
  assert.equal(parsed.decisions[0].context, 'the ledger')
  assert.equal(parsed.decisions[1].context, 'hot reads\n\n#### KD3\n\nAD04: Not a header')
  assert.equal(parsed.decisions[1].lead, '')
  // A heading needs the two-digit number Gantry writes, so an ordinary heading such as "## Q3" or "### H2: Background" stays text.
  assert.deepEqual(parseKeyDecisions('**AD01: A**\n\nContext: x\n## Q3\n### H2: Background').decisions.map((d) => d.number), [1])
  // A closing run of #s is the heading's, not the title's; a # in the title is kept.
  assert.deepEqual(parseKeyDecisions('## AD05: Port it to C# ##').decisions.map((d) => d.title), ['Port it to C#'])
  // Written back, the heading becomes the standard bold header.
  assert.match(serialiseKeyDecisions(parsed, { prefix: 'AD' }), /^\*\*AD01: Use PostgreSQL\*\*\n\n\*\*Context:\*\* the ledger\n\n\*\*AD02: Cache reads\*\*/)
})

test('#356: the Word render prints a plain-label Field\'s parts, in either style', () => {
  const printed = renderKeyDecisions(PLAIN_WHY_TEXT, { prefix: 'AD', style: 'why' })
  assert.match(printed, /\*\*AD01: Use PostgreSQL for the ledger\*\*\n\nIn the context of the payments ledger, facing the need to never lose or double-count a payment, we decided for PostgreSQL 16 and neglected DynamoDB, to achieve transactions that keep every payment consistent, accepting that we run and patch a database cluster\.\n\nRelates to AD02\./)
  assert.match(printed, /Depends on AD01\./)
  assert.doesNotMatch(printed, /^In the context of:/m)
  const plainDefault = renderKeyDecisions('**AD01: Use PostgreSQL**\n\nContext: The ledger needs transactions.\nDecision: Postgres 16.', { prefix: 'AD', style: 'default' })
  assert.equal(plainDefault, '**AD01: Use PostgreSQL**\n\n**Context:** The ledger needs transactions.\n\n**Decision:** Postgres 16.')
})

test('#356: the Word render reads a plain-label Field from disk', () =>
  withScratch(WHY_MOUNT, ({ definitionsDir, instancesDir }) => {
    const def = loadDefinition('dec', { definitionsDir })
    writeModule(def, 'harbour', 'key-decisions', { status: 'agreed', owner: 'a.person', fields: { decisions: PLAIN_WHY_TEXT } }, { instancesDir })
    const { markdown, docxMarkdown } = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir, instancesDir, commit: COMMIT })
    for (const text of [markdown, docxMarkdown]) {
      assert.match(text, /In the context of the payments ledger, facing the need to never lose or double-count a payment, we decided for PostgreSQL 16/)
      assert.match(text, /Relates to AD02\./)
      assert.doesNotMatch(text, /^In the context of:/m)
    }
  }))

test('#356: each style\'s guidance shows the line-per-part form with an example, built from its own parts and links', () => {
  for (const [style, prefix] of [['default', 'KD'], ['why', 'AD']]) {
    const guidance = resolveStandardModule({ id: 'key-decisions', version: 1, prefix, style }).fields[0].guidance
    assert.equal(guidance, `${STANDARD_MODULES['key-decisions'].versions[1].fields[0].guidance}\n\n${decisionStyleGuidance(style, prefix)}`)
    assert.doesNotMatch(guidance, /one statement/)
    assert.match(guidance, new RegExp(`\\*\\*${prefix}01: Short title\\*\\*`))
    // The example decision: its header, then every part on a line of its own as **Label:**, in the style's order.
    const example = guidance.slice(guidance.indexOf('For example:'))
    const lines = example.split('\n').filter((line) => line.startsWith('**'))
    assert.match(lines[0], new RegExp(`^\\*\\*${prefix}01: \\S`))
    assert.deepEqual(lines.slice(1, 1 + STYLE_PARTS[style].length).map((line) => line.slice(0, line.indexOf(':**') + 3)), STYLE_PARTS[style].map((part) => `**${part.label}:**`))
    assert.deepEqual(lines.slice(1 + STYLE_PARTS[style].length).map((line) => line.slice(0, line.indexOf(':**') + 3)), STYLE_LINKS[style].length ? [`**${STYLE_LINKS[style].at(-1).label}:**`] : [])
    // The example is itself a decision Gantry reads, with every part written.
    const read = parseKeyDecisions(lines.join('\n')).decisions
    assert.equal(read.length, 1)
    for (const part of STYLE_PARTS[style]) assert.notEqual(read[0][part.key], '', `${style} ${part.key}`)
  }
  const why = decisionStyleGuidance('why', 'AD')
  assert.match(why, /\*\*Relates to:\*\* AD02/)
  for (const link of STYLE_LINKS.why) assert.ok(why.includes(`**${link.label}:**`), link.label)
  assert.doesNotMatch(decisionStyleGuidance('default', 'KD'), /Depends on|Relates to|Supersedes/)
  // An unknown style has no guidance rather than a wrong one.
  assert.equal(decisionStyleGuidance('fancy', 'AD'), '')
})

test('#356: the Definitions page describes each style from its own parts and links', () => {
  assert.equal(decisionStyleSummary('default'), 'A title, then Context, Decision, Why, Considered options and Consequences.')
  assert.equal(decisionStyleSummary('why'), 'A title, then In the context of, Facing, We decided for, And neglected, To achieve and Accepting that, and links to other Key decisions (Depends on, Supersedes, Relates to).')
  assert.equal(decisionStyleSummary('fancy'), '')
})
