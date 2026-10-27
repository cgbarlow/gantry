import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, readInstance, readModule, writeModule } from '../lib/instance.js'
import {
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblems,
  findDefinitionProblemsInStructure,
  writeDefinitionVersion,
} from '../lib/definition.js'
import { validateDefinition } from '../lib/validate.js'
import { checkGate } from '../lib/check.js'
import { renderArtefact } from '../lib/render.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import {
  withRunningServer,
  withRunningServerForProvider,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #202 (spec #192, ADR-0054): an Instance has a Target size — Small, Medium or Large, default
// Medium — that picks each Field's word budget (`target-words`) for its authors. It is an authoring
// target, not a render-time transformation: the editor and MCP read it, the gate check and the
// renderer never do. Everything here goes through the existing seams — Definition validation, the
// `/api/instance*` routes the web editor and the MCP server both call, the gate check and the
// renderer. The fixture is a small two-Definition library: `sized` declares budgets, `plain` is the
// same Definition without them (every packaged Definition today), which must behave exactly as before.

const BUDGETED_MODULE = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
    target-words:
      small: 5
      medium: 10
      large: 20
  - id: risks
    title: Risks
    type: list
    target-words:
      small: 2
      medium: 4
      large: 8
  - id: owner
    title: Owner
    type: text
`

const PLAIN_MODULE = BUDGETED_MODULE.replace(/ {4}target-words:\n( {6}\w+: \d+\n){3}/g, '')

function definitionYaml(id) {
  return `id: ${id}
version: 1
status: published
title: ${id}
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
}

function writeFixtureDefinition(definitionsDir, id, moduleYaml) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id))
  writeFileSync(join(dir, 'modules', 'summary.yaml'), moduleYaml)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withLibrary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-202-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  mkdirSync(instancesDir, { recursive: true })
  try {
    writeFixtureDefinition(definitionsDir, 'sized', BUDGETED_MODULE)
    writeFixtureDefinition(definitionsDir, 'plain', PLAIN_MODULE)
    return await fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function withServer(fn) {
  return withLibrary(({ definitionsDir, instancesDir }) =>
    withRunningServer({ definitionsDir, instancesDir }, (base) => fn({ base, definitionsDir, instancesDir }))
  )
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const put = (body) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function fieldsById(instanceBody) {
  return new Map(instanceBody.modules.find((m) => m.id === 'summary').fields.map((f) => [f.id, f]))
}

// After the server's startup migration, a local instance lives in the reserved `default` workspace.
const localInstanceYaml = (instancesDir, slug) => readFileSync(join(instancesDir, 'default', slug, 'instance.yaml'), 'utf8')

// ---------- The `target-words` Definition key ----------

const MALFORMED = [
  ['a size left out', '{ small: 5, medium: 10 }'],
  ['zero words', '{ small: 0, medium: 10, large: 20 }'],
  ['a negative budget', '{ small: -5, medium: 10, large: 20 }'],
  ['a fraction', '{ small: 5.5, medium: 10, large: 20 }'],
  ['a quoted number', '{ small: "5", medium: 10, large: 20 }'],
  ['a size Gantry does not know', '{ small: 5, medium: 10, large: 20, huge: 40 }'],
  ['a bare number', '10'],
  ['a list', '[5, 10, 20]'],
]

for (const [label, value] of MALFORMED) {
  test(`target-words with ${label} is an invalid-target-words problem, reported by gantry validate and the in-memory and Local Workspace validators alike`, () =>
    withLibrary(({ definitionsDir }) => {
      writeFileSync(
        join(definitionsDir, 'sized', '1', 'modules', 'summary.yaml'),
        BUDGETED_MODULE.replace(/ {4}target-words:\n( {6}\w+: \d+\n){3}/, `    target-words: ${value}\n`)
      )
      const problems = findDefinitionProblems('sized', { definitionsDir, version: 1 })
      assert.deepEqual(problems.map((p) => p.type), ['invalid-target-words'])
      assert.match(problems[0].message, /^Module "summary" field "overview" sets "target-words" to .* positive whole number of words for each of small, medium and large/)
      assert.equal(validateDefinition('sized', { definitionsDir, version: 1 }).valid, false)

      // Advisory, so it never stops an instance's Definition loading — like #149's gate-id problems.
      const structure = definitionVersionProjection(loadDefinition('sized', { definitionsDir, version: 1 }))
      assert.deepEqual(findDefinitionProblemsInStructure(structure), problems)
      assert.deepEqual(findLocalDefinitionProblems(structure), problems)
    }))
}

test('target-words on a select, text or date field is refused: only prose has a length to budget', () =>
  withLibrary(({ definitionsDir }) => {
    writeFileSync(
      join(definitionsDir, 'sized', '1', 'modules', 'summary.yaml'),
      `${BUDGETED_MODULE}    target-words: { small: 1, medium: 2, large: 3 }\n`
    )
    const problems = findDefinitionProblems('sized', { definitionsDir, version: 1 })
    assert.deepEqual(problems.map((p) => p.type), ['invalid-target-words'])
    assert.match(problems[0].message, /^Module "summary" field "owner" sets "target-words", but is type "text"/)
  }))

test('a well-formed budget is no problem, and a Definitions-page Save refuses a malformed one without writing it', () =>
  withLibrary(({ definitionsDir }) => {
    assert.deepEqual(findDefinitionProblems('sized', { definitionsDir, version: 1 }), [])
    const yamlPath = join(definitionsDir, 'sized', '1', 'definition.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('status: published', 'status: draft'))

    const structure = definitionVersionProjection(loadDefinition('sized', { definitionsDir, version: 1 }))
    assert.deepEqual(structure.modules[0].fields[0].targetWords, { small: 5, medium: 10, large: 20 })
    structure.modules[0].fields[0].targetWords = { small: 5, medium: 10, large: 0 }
    const saved = writeDefinitionVersion('sized', 1, structure, { definitionsDir })
    assert.deepEqual(saved.problems.map((p) => p.type), ['invalid-target-words'])
    assert.match(readFileSync(join(definitionsDir, 'sized', '1', 'modules', 'summary.yaml'), 'utf8'), /large: 20/)
  }))

// ---------- The instance's `size` ----------

test('POST /api/instances stores the chosen size, and GET /api/instance returns it with each budgeted field\'s target at that size', () =>
  withServer(async ({ base, instancesDir }) => {
    const res = await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'small-one', size: 'small' }))
    assert.equal(res.status, 201)
    assert.match(localInstanceYaml(instancesDir, 'small-one'), /^size: small$/m)

    const body = await (await fetch(`${base}/api/instance?slug=small-one`)).json()
    assert.equal(body.size, 'small')
    const fields = fieldsById(body)
    assert.equal(fields.get('overview').targetWords, 5)
    assert.equal(fields.get('risks').targetWords, 2)
    assert.equal('targetWords' in fields.get('owner'), false, 'a field with no budget carries no target')
  }))

test('an instance created with no size stores none and works to Medium', () =>
  withServer(async ({ base, instancesDir }) => {
    assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'unsized' }))).status, 201)
    assert.doesNotMatch(localInstanceYaml(instancesDir, 'unsized'), /size:/)

    const body = await (await fetch(`${base}/api/instance?slug=unsized`)).json()
    assert.equal(body.size, 'medium')
    assert.equal(fieldsById(body).get('overview').targetWords, 10)
  }))

test('POST /api/instances refuses a size Gantry does not know, and a size for a Definition with no budgets', () =>
  withServer(async ({ base, instancesDir }) => {
    const unknown = await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'huge-one', size: 'huge' }))
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /"huge".*small, medium or large/)

    const unbudgeted = await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'plain-one', size: 'small' }))
    assert.equal(unbudgeted.status, 400)
    assert.match((await unbudgeted.json()).error, /declares no target-words/)
    assert.equal(existsSync(join(instancesDir, 'default', 'plain-one')), false)
  }))

test('PUT /api/instance/size changes the size Instance Settings shows, and refuses an unknown size', () =>
  withServer(async ({ base, instancesDir }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'resized' }))

    const res = await fetch(`${base}/api/instance/size?slug=resized`, put({ size: 'large' }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { slug: 'resized', size: 'large' })
    const record = readInstance('resized', { instancesDir: join(instancesDir, 'default') })
    assert.equal(record.size, 'large')
    assert.equal(record.definition, 'sized', 'every other field of instance.yaml is kept')

    const body = await (await fetch(`${base}/api/instance?slug=resized`)).json()
    assert.equal(body.size, 'large')
    assert.equal(fieldsById(body).get('overview').targetWords, 20)

    const bad = await fetch(`${base}/api/instance/size?slug=resized`, put({ size: 'Large' }))
    assert.equal(bad.status, 400)
  }))

test('a Definition with no budgets shows no size: GET /api/instance is unchanged and PUT /api/instance/size is refused', () =>
  withServer(async ({ base }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'plain-one' }))

    const body = await (await fetch(`${base}/api/instance?slug=plain-one`)).json()
    assert.equal('size' in body, false)
    for (const field of fieldsById(body).values()) assert.equal('targetWords' in field, false)

    const res = await fetch(`${base}/api/instance/size?slug=plain-one`, put({ size: 'small' }))
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /declares no target-words/)
  }))

// ---------- Over-budget notes on save ----------

test('PUT /api/instance/modules saves an over-budget field and returns a note naming its count and target, without failing the write', () =>
  withServer(async ({ base, definitionsDir, instancesDir }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'wordy' }))
    // Twelve words of prose — the diagram's source and the link's address are not words a reader reads.
    const overview = 'One two three four five six seven eight nine [ten eleven](https://example.org/a/b) twelve.\n\n```mermaid\nflowchart LR\n  alpha --> beta --> gamma\n```\n'
    const res = await fetch(`${base}/api/instance/modules?slug=wordy`, put({
      modules: { summary: { fields: { overview, risks: ['Late', 'Over budget'], owner: 'A person with a long name' } } },
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.targetWordNotes, [
      { module: 'summary', field: 'overview', words: 12, target: 10, size: 'medium', message: 'summary.overview: 12 words, Medium target ~10' },
    ])

    const definition = loadDefinition('sized', { definitionsDir, version: 1 })
    const saved = readModule(definition, 'wordy', 'summary', { instancesDir: join(instancesDir, 'default') })
    assert.equal(saved.fields.overview.trim(), overview.trim(), 'the over-budget text is saved as written')
  }))

test('the notes follow the instance\'s size, and a Definition with no budgets returns none', () =>
  withServer(async ({ base }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'tight', size: 'small' }))
    const tight = await (await fetch(`${base}/api/instance/modules?slug=tight`, put({
      modules: { summary: { fields: { risks: ['Late delivery', 'Over budget'] } } },
    }))).json()
    assert.deepEqual(tight.targetWordNotes.map((n) => n.message), ['summary.risks: 4 words, Small target ~2'])

    await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'plain-one' }))
    const plain = await (await fetch(`${base}/api/instance/modules?slug=plain-one`, put({
      modules: { summary: { fields: { overview: 'word '.repeat(500) } } },
    }))).json()
    assert.equal('targetWordNotes' in plain, false)
  }))

// ---------- Advisory only: the gate check and the renderer never read it ----------

test('an over-budget instance still passes its gate and renders exactly what the same content renders without budgets', () =>
  withLibrary(async ({ definitionsDir, instancesDir }) => {
    const longText = 'A sentence that runs well past every budget this field declares for any size. '.repeat(10)
    for (const id of ['sized', 'plain']) {
      createInstance(id, `${id}-instance`, { instancesDir, definitionsDir, size: id === 'sized' ? 'small' : undefined })
      const definition = loadDefinition(id, { definitionsDir, version: 1 })
      writeModule(definition, `${id}-instance`, 'summary', { status: 'draft', owner: '', fields: { overview: longText, risks: ['One', 'Two', 'Three'], owner: 'Someone' } }, { instancesDir })
    }

    const sizedGate = checkGate('sized-instance', { instancesDir, definitionsDir })
    const plainGate = checkGate('plain-instance', { instancesDir, definitionsDir })
    assert.equal(sizedGate.pass, true)
    assert.deepEqual({ ...sizedGate, slug: undefined, definition: undefined }, { ...plainGate, slug: undefined, definition: undefined })

    const sized = renderArtefact('sized-instance', 'brief', { dryRun: true, instancesDir, definitionsDir })
    const plain = renderArtefact('plain-instance', 'brief', { dryRun: true, instancesDir, definitionsDir })
    // The two differ only by name — the Definition id and slug the Document Control table prints.
    assert.equal(sized.markdown.replaceAll('sized', 'X'), plain.markdown.replaceAll('plain', 'X'))
    assert.ok(sized.markdown.includes(longText.trim()), 'the whole over-budget field is rendered, never condensed')
  }))

// Spec #192's regression guard: the packaged Definitions declare no budgets, so the example instance
// reads exactly as before — no size, no targets — and a copy of design v2 that does declare one renders
// the same document from the same content.
test('design v2 renders the same SOAP for the example instance with or without a budget on one of its fields', () =>
  withLibrary(async ({ instancesDir }) => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-202-design-'))
    try {
      cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
      const modulePath = join(definitionsDir, 'design', '2', 'modules', 'background.yaml')
      const original = readFileSync(modulePath, 'utf8')
      const budgeted = original.replace(/( {2}- id: problem\n(?: {4}.*\n)*? {4}type: markdown\n)/, '$1    target-words: { small: 5, medium: 10, large: 20 }\n')
      assert.notEqual(budgeted, original, 'the fixture edit must land')
      writeFileSync(modulePath, budgeted)
      assert.deepEqual(findDefinitionProblems('design', { definitionsDir, version: 2 }), [])

      cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'kiwi-cover-mutual'), { recursive: true })
      const withBudget = renderArtefact('kiwi-cover-mutual', 'soap', { dryRun: true, instancesDir, definitionsDir })
      const withoutBudget = renderArtefact('kiwi-cover-mutual', 'soap', { dryRun: true, instancesDir, definitionsDir: 'definitions' })
      assert.equal(withBudget.markdown, withoutBudget.markdown)

      await withRunningServer({ instancesDir, migrateWorkspacesOnStart: true }, async (base) => {
        const body = await (await fetch(`${base}/api/instance?slug=kiwi-cover-mutual`)).json()
        assert.equal('size' in body, false)
        for (const mod of body.modules) for (const field of mod.fields) assert.equal('targetWords' in field, false, `${mod.id}.${field.id}`)
      })
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
    }
  }))

// ---------- A Provider-backed instance ----------

test('a GitHub-backed instance stores its size in its own repo and changes it on the stage branch', () =>
  withLibrary(({ definitionsDir, instancesDir }) =>
    withRunningServerForProvider('github', { options: { definitionsDir, instancesDir } }, async ({ gantryBase, providerBaseUrl }) => {
      const auth = { Authorization: basicAuthHeader(GITHUB_VALID_PAT) }
      const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }
      const created = await fetch(`${gantryBase}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ definition: 'sized', slug: 'remote-sized', size: 'large', github }),
      })
      assert.equal(created.status, 201)
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl })
      assert.match(await client.getFileContent('gantry-workspace/remote-sized/instance.yaml'), /^size: large$/m)

      const res = await fetch(`${gantryBase}/api/instance/size?slug=remote-sized`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ size: 'small' }),
      })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { slug: 'remote-sized', size: 'small' })
      assert.match(await client.getFileContent('gantry-workspace/remote-sized/instance.yaml', { branch: 'gantry-workspace/remote-sized/draft' }), /^size: small$/m)

      const body = await (await fetch(`${gantryBase}/api/instance?slug=remote-sized`, { headers: auth })).json()
      assert.equal(body.size, 'small')
      assert.equal(fieldsById(body).get('overview').targetWords, 5)
    })
  ))
