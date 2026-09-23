import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { program } from '../bin/gantry.js'
import { createInstance, writeModule, readInstance } from '../lib/instance.js'
import {
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblemsInStructure,
  writeDefinitionVersion,
  publishDefinitionVersion,
} from '../lib/definition.js'
import { validateDefinition } from '../lib/validate.js'
import { checkGate, formatGateOutstanding } from '../lib/check.js'
import { getStatus } from '../lib/status.js'
import { advanceStage } from '../lib/stageAdvancement.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { writeTextFile } from '../web/lib/localWorkspace.js'
import { checkLocalGate, getLocalStatus, formatLocalGateOutstanding, validateLocalDefinition } from '../web/lib/localStatus.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #151 (spec #147, ADR-0051): an Artefact that sets `satisfies-gate: false` — an audience document
// trimmed to what its reader needs — never makes its Gate pass on its own. Its completeness is still
// worked out and reported, it is still rendered and linked in the approval request when complete, and
// a failed Gate points at the closest Artefact that *can* pass it. The fixture is a two-Stage
// Definition whose first Gate has a Candidate Letter (one Field, excluded) beside an Offer Case (three
// Fields, satisfying): without the flag the Letter would be both the easy way through the Gate and the
// "closest" document a failure message names.

const SLUG = 'new-starter'

function definitionYaml({ status = 'published', caseSatisfiesGate } = {}) {
  return `id: audience
version: 1
status: ${status}
title: Audience
description: An audience document beside the record that passes the gate
stages:
  - id: offer
    title: Offer
    purpose: Make the offer
    gate: offer-approved
    modules:
      - terms
      - record
  - id: start
    title: Start
    purpose: The first day
    gate: started
    modules:
      - terms
artefacts:
  - id: letter
    title: Candidate Letter
    purpose: What the candidate is sent
    template: templates/letter.md.tmpl
    gate: offer-approved
    satisfies-gate: false
    requires:
      - terms
  - id: case
    title: Offer Case
    purpose: The internal record the gate is signed on
    template: templates/case.md.tmpl
    gate: offer-approved
${caseSatisfiesGate === undefined ? '' : `    satisfies-gate: ${caseSatisfiesGate}\n`}    requires:
      - terms
      - record
`
}

const TERMS_MODULE = `id: terms
title: Terms
purpose: The terms offered
fields:
  - id: summary
    title: Summary
    type: markdown
    required: true
`

const RECORD_MODULE = `id: record
title: Record
purpose: The internal record
fields:
  - id: rationale
    title: Rationale
    type: markdown
    required: true
  - id: approvals
    title: Approvals
    type: markdown
    required: true
`

function writeFixture(definitionsDir, options) {
  const dir = join(definitionsDir, 'audience', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(options))
  writeFileSync(join(dir, 'modules', 'terms.yaml'), TERMS_MODULE)
  writeFileSync(join(dir, 'modules', 'record.yaml'), RECORD_MODULE)
  writeFileSync(join(dir, 'templates', 'letter.md.tmpl'), '# Candidate Letter\n')
  writeFileSync(join(dir, 'templates', 'case.md.tmpl'), '# Offer Case\n')
}

async function withInstance(fn, options) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-151-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeFixture(definitionsDir, options)
    createInstance('audience', SLUG, { instancesDir, definitionsDir })
    return await fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function fill(ctx, moduleId, fields) {
  const definition = loadDefinition('audience', { definitionsDir: ctx.definitionsDir, version: 1 })
  writeModule(definition, SLUG, moduleId, { status: 'draft', owner: '', fields }, { instancesDir: ctx.instancesDir })
}

const fillLetter = (ctx) => fill(ctx, 'terms', { summary: 'Permanent, full time.' })
const fillCase = (ctx) => {
  fillLetter(ctx)
  fill(ctx, 'record', { rationale: 'Strongest candidate.', approvals: 'Approved by the panel.' })
}

// A minimal in-memory File System Access API directory, the shape tests/localStatus.test.js uses.
class MemDir {
  constructor() {
    this.kind = 'directory'
    this.children = new Map()
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new Error(`NotFoundError: no directory "${name}"`)
      this.children.set(name, new MemDir())
    }
    return this.children.get(name)
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new Error(`NotFoundError: no file "${name}"`)
      let text = ''
      this.children.set(name, {
        kind: 'file',
        async getFile() { return { text: async () => text } },
        async createWritable() { return { write: async (data) => { text = data }, close: async () => {} } },
      })
    }
    return this.children.get(name)
  }
}

// The same instance through the Local Workspace twin (web/lib/localStatus.js): the module files as
// the browser would read them, and the Definition as the projection the browser holds.
async function localTwin(ctx) {
  const handle = new MemDir()
  // #145: getLocalStatus now reads instance.yaml itself (for the instance's optional display
  // name) — mirrored here the same way the modules below are, from the real on-disk fixture.
  await writeTextFile(handle, `gantry-workspace/${SLUG}/instance.yaml`, readFileSync(join(ctx.instancesDir, SLUG, 'instance.yaml'), 'utf8'))
  const modulesDir = join(ctx.instancesDir, SLUG, 'modules')
  for (const name of readdirSync(modulesDir)) {
    await writeTextFile(handle, `gantry-workspace/${SLUG}/modules/${name}`, readFileSync(join(modulesDir, name), 'utf8'))
  }
  const structure = definitionVersionProjection(loadDefinition('audience', { definitionsDir: ctx.definitionsDir, version: 1 }))
  return { handle, structure }
}

const summary = (result) => result.artefacts.map(({ id, complete, satisfiesGate }) => ({ id, complete, satisfiesGate }))

// ── The gate check ─────────────────────────────────────────────────────────────────────────────────

test('an excluded Artefact complete on its own does not pass the Gate, and is still reported complete', () =>
  withInstance((ctx) => {
    fillLetter(ctx)
    const result = checkGate(SLUG, ctx)
    assert.equal(result.pass, false)
    assert.equal(result.complete, false)
    assert.deepEqual(summary(result), [
      { id: 'letter', complete: true, satisfiesGate: false },
      { id: 'case', complete: false, satisfiesGate: true },
    ])
    assert.equal(formatGateOutstanding(result), 'Offer Case: record.rationale, record.approvals')
  }))

test('a failed Gate names the closest satisfying Artefact, never a closer excluded one', () =>
  withInstance((ctx) => {
    const result = checkGate(SLUG, ctx)
    assert.equal(result.pass, false)
    // The Letter has one Field outstanding and the Case three, but only the Case can pass the Gate.
    assert.deepEqual(result.artefacts.map((a) => a.outstanding.length), [1, 3])
    assert.equal(formatGateOutstanding(result), 'Offer Case: terms.summary, record.rationale, record.approvals')
  }))

test('a satisfying Artefact complete passes the Gate', () =>
  withInstance((ctx) => {
    fillCase(ctx)
    const result = checkGate(SLUG, ctx)
    assert.equal(result.pass, true)
    assert.deepEqual(summary(result), [
      { id: 'letter', complete: true, satisfiesGate: false },
      { id: 'case', complete: true, satisfiesGate: true },
    ])
  }))

test('status reports the Stage incomplete while only the excluded Artefact is complete', () =>
  withInstance((ctx) => {
    fillLetter(ctx)
    const status = getStatus(SLUG, ctx)
    assert.equal(status.complete, false)
    assert.deepEqual(summary(status), [
      { id: 'letter', complete: true, satisfiesGate: false },
      { id: 'case', complete: false, satisfiesGate: true },
    ])
  }))

test('the Local Workspace twin gives the same check, status and failure message as the server', () =>
  withInstance(async (ctx) => {
    for (const step of [() => {}, fillLetter, fillCase]) {
      step(ctx)
      const { handle, structure } = await localTwin(ctx)
      const server = checkGate(SLUG, ctx)
      const local = await checkLocalGate(handle, SLUG, structure, 'offer')
      assert.deepEqual(local, server)
      assert.equal(formatLocalGateOutstanding(local), formatGateOutstanding(server))
      assert.deepEqual(await getLocalStatus(handle, SLUG, structure, 'offer'), getStatus(SLUG, ctx))
    }
  }))

// ── Stage advancement ──────────────────────────────────────────────────────────────────────────────

test('a local instance is not advanced while only the excluded Artefact is complete', () =>
  withInstance((ctx) => {
    fillLetter(ctx)
    assert.throws(() => advanceStage(SLUG, ctx), /has not passed.*outstanding: Offer Case: record\.rationale, record\.approvals$/)
    assert.equal(readInstance(SLUG, ctx).stage, 'offer')

    fillCase(ctx)
    assert.equal(advanceStage(SLUG, ctx).toStage.id, 'start')
  }))

test('a Local Workspace instance is not advanced while only the excluded Artefact is complete', () =>
  withInstance(async (ctx) => {
    fillLetter(ctx)
    const { handle, structure } = await localTwin(ctx)
    const result = await checkLocalGate(handle, SLUG, structure, 'offer')
    // The browser's "Advance to next stage" refuses on exactly this result (web/app.js).
    assert.equal(result.pass, false)
    assert.equal(formatLocalGateOutstanding(result), 'Offer Case: record.rationale, record.approvals')
  }))

// ── gantry check ───────────────────────────────────────────────────────────────────────────────────

async function runCli(args) {
  program.exitOverride()
  const logs = []
  const origLog = console.log
  const savedExitCode = process.exitCode
  console.log = (...parts) => logs.push(parts.join(' '))
  try {
    await program.parseAsync(['node', 'gantry.js', ...args])
    return { out: logs.join('\n'), exitCode: process.exitCode }
  } finally {
    console.log = origLog
    process.exitCode = savedExitCode
  }
}

test('`gantry check` lists each Artefact\'s completeness and whether it counts toward the Gate', () =>
  withInstance(async (ctx) => {
    fillLetter(ctx)
    const { out, exitCode } = await runCli(['check', SLUG, '--workspaces-dir', ctx.instancesDir, '--definitions-dir', ctx.definitionsDir])
    assert.equal(exitCode, 1)
    assert.match(out, /^FAIL\n/)
    assert.match(out, /\n {2}outstanding: Offer Case: record\.rationale, record\.approvals\n/)
    assert.match(out, /\nArtefacts:\n {2}\[complete\] Candidate Letter \(doesn't count toward the gate\)\n {2}\[incomplete\] Offer Case\n {6}outstanding: record\.rationale, record\.approvals/)

    fillCase(ctx)
    const passed = await runCli(['check', SLUG, '--workspaces-dir', ctx.instancesDir, '--definitions-dir', ctx.definitionsDir])
    assert.match(passed.out, /^PASS\n/)
    assert.doesNotMatch(passed.out, /outstanding: Offer Case/)
    assert.match(passed.out, /\n {2}\[complete\] Offer Case(\n|$)/)
  }))

test('`gantry check --json` carries satisfiesGate on every Artefact', () =>
  withInstance(async (ctx) => {
    const { out } = await runCli(['check', SLUG, '--json', '--workspaces-dir', ctx.instancesDir, '--definitions-dir', ctx.definitionsDir])
    assert.deepEqual(JSON.parse(out).artefacts.map((a) => [a.id, a.satisfiesGate]), [['letter', false], ['case', true]])
  }))

// ── Validation: unsatisfiable-gate ─────────────────────────────────────────────────────────────────

function withDefinitions(fn, options) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-151-defs-'))
  const definitionsDir = join(root, 'definitions')
  try {
    writeFixture(definitionsDir, options)
    return fn(definitionsDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const UNSATISFIABLE = /^Stage "offer" has gate "offer-approved", but every artefact at that gate \("letter", "case"\) sets "satisfies-gate: false", so the gate can never pass/

function assertUnsatisfiable(problems, where) {
  assert.deepEqual(problems.map((p) => p.type), ['unsatisfiable-gate'], `${where}: ${JSON.stringify(problems)}`)
  assert.match(problems[0].message, UNSATISFIABLE, where)
}

test('a Stage whose Artefacts all opt out of its Gate is an unsatisfiable-gate problem for gantry validate, the Definitions page and a Local Workspace', () =>
  withDefinitions((definitionsDir) => {
    assertUnsatisfiable(validateDefinition('audience', { definitionsDir, version: 1 }).problems, 'gantry validate')
    const structure = definitionVersionProjection(loadDefinition('audience', { definitionsDir, version: 1 }))
    assertUnsatisfiable(findDefinitionProblemsInStructure(structure), 'live markers')
    assertUnsatisfiable(validateLocalDefinition(structure).problems, 'Local Workspace validate')
  }, { caseSatisfiesGate: false }))

test('one satisfying Artefact is enough, and a Stage with no Artefacts at all is not flagged', () =>
  withDefinitions((definitionsDir) => {
    // The fixture's "start" Stage has no Artefacts.
    assert.deepEqual(validateDefinition('audience', { definitionsDir, version: 1 }).problems, [])
    const structure = definitionVersionProjection(loadDefinition('audience', { definitionsDir, version: 1 }))
    assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
    assert.deepEqual(validateLocalDefinition(structure).problems, [])
  }, { caseSatisfiesGate: true }))

test('save and publish refuse an unsatisfiable gate, but a Definition already carrying one still loads', () =>
  withDefinitions((definitionsDir) => {
    const structure = definitionVersionProjection(loadDefinition('audience', { definitionsDir, version: 1 }))
    structure.artefacts.find((a) => a.id === 'case').satisfiesGate = false
    assertUnsatisfiable(writeDefinitionVersion('audience', 1, structure, { definitionsDir }).problems ?? [], 'save')
    assert.equal(loadDefinition('audience', { definitionsDir, version: 1 }).artefacts.find((a) => a.id === 'case').satisfiesGate, undefined, 'the refused save wrote nothing')

    const yamlPath = join(definitionsDir, 'audience', '1', 'definition.yaml')
    writeFileSync(yamlPath, definitionYaml({ status: 'draft', caseSatisfiesGate: false }))
    assertUnsatisfiable(publishDefinitionVersion('audience', 1, { definitionsDir }).problems ?? [], 'publish')

    writeFileSync(yamlPath, definitionYaml({ status: 'published', caseSatisfiesGate: false }))
    assert.equal(loadDefinition('audience', { definitionsDir, version: 1 }).artefacts.length, 2)
  }, { status: 'draft' }))

// ── The approval request ───────────────────────────────────────────────────────────────────────────

// design v2's Build-ready Checklist gate has the SAD and the SSAD, which share their requirements.
// Opting the SSAD out leaves the SAD to pass the Gate, and both are still verified and linked.
test('requesting approval links an excluded Artefact that is complete beside the satisfying one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-151-approval-'))
  try {
    const definitionsDir = join(root, 'definitions')
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    const yamlPath = join(definitionsDir, 'design', '2', 'definition.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    const optedOut = yaml.replace('    template: templates/ssad.md.tmpl\n', '    template: templates/ssad.md.tmpl\n    satisfies-gate: false\n')
    assert.notEqual(optedOut, yaml, 'the fixture edit must land')
    writeFileSync(yamlPath, optedOut)
    const definition = loadDefinition('design', { definitionsDir, version: 2 })
    const stage = definition.stages.find((s) => s.id === 'detailed-design')

    const location = { organization: 'org-151', project: 'project-151', repository: 'repo-151' }
    const files = { '/gantry-workspace/my-initiative/instance.yaml': `definition: design\nslug: my-initiative\nstage: ${stage.id}\ndefinitionVersion: 2\n` }
    await withFakeAzureDevOpsServer({ ...location, validPat: VALID_PAT, files }, async (baseUrl) => {
      const azureDevOps = { ...location, pat: VALID_PAT, baseUrl }
      const branch = await resolveStageBranch(azureDevOps, definition, 'my-initiative', stage.id)
      const client = createAzureDevOpsClient(azureDevOps)
      for (const moduleId of stage.modules) {
        await client.writeFile(`gantry-workspace/my-initiative/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
      }

      const check = await checkGate('my-initiative', { azureDevOps: { ...azureDevOps, branch }, definitionsDir })
      assert.equal(check.pass, true)
      assert.deepEqual(summary(check), [
        { id: 'sad', complete: true, satisfiesGate: true },
        { id: 'ssad', complete: true, satisfiesGate: false },
      ])

      const result = await requestStageApproval('my-initiative', { azureDevOps, definitionsDir })
      const pr = await createAzureDevOpsPullRequestsClient(azureDevOps).getPullRequest(result.pullRequestId)
      assert.match(pr.description, /\[Solution Architecture Document\]\(/)
      assert.match(pr.description, /\[Solution Support Architecture Document\]\(/)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
