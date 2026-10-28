import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createInstance, readInstance } from '../lib/instance.js'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems, findDefinitionProblemsInStructure, writeDefinitionVersion, publishDefinitionVersion } from '../lib/definition.js'
import { renderArtefact } from '../lib/render.js'
import { program } from '../bin/gantry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import {
  definitionInstanceSettings,
  effectiveInstanceSetting,
  instanceClassification,
  instanceSettingProblem,
  instanceSettingsProblem,
  instanceSettingsDeclarationProblems,
} from '../web/lib/instanceSettings.js'
import { renderInstanceYaml, withStoredInstanceSettings } from '../web/lib/localInstanceFiles.js'
import { bodyParagraphs, docxPart } from './helpers/wordDocx.js'
import { classificationField, sectionHeaders } from './helpers/wordHeaders.js'
import { withRunningServer, withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #220 (spec #223, ADR-0058 §2, §6): **Classification** is the second Instance setting. A Definition
// declares its own markings, with an optional default, under `instance-settings:`; an Instance
// stores its chosen marking as `classification:` in its instance record, set at creation and in
// Instance Settings; and every cover and page header prints it. A Definition that declares no
// markings keeps printing any `cover-classification` Field (ADR-0052), as a quiet fallback.
// tests/instanceSettings.test.js covers the group and Size; tests/designV3.test.js and
// tests/designV3HeaderClassification.test.js cover design v3 and its examples.
//
// Fixture Definitions, one Stage and one covered Artefact each, whose `summary.marking` text Field is
// also the Artefact's `cover-classification`:
//   - `marked`    declares three markings and no default;
//   - `defaulted` declares the same markings with IN-CONFIDENCE as its default;
//   - `legacy`    declares none, so the Field the pointer names is what the cover prints.

const MARKINGS = ['PUBLIC', 'IN-CONFIDENCE', 'SECRET']

const MODULE_YAML = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
  - id: marking
    title: Marking
    type: text
`

function definitionYaml(id, declaration = '', status = 'published') {
  return `id: ${id}
version: 1
status: ${status}
title: ${id}
description: A one-stage fixture
${declaration}stages:
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
    cover-page: true
    cover-classification: summary.marking
    requires:
      - summary
`
}

const DECLARATION = `instance-settings:\n  classification:\n    choices: [${MARKINGS.join(', ')}]\n`
const DEFAULTED = `${DECLARATION}    default: IN-CONFIDENCE\n`

function writeFixtureDefinition(definitionsDir, id, declaration, status) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, declaration, status))
  writeFileSync(join(dir, 'modules', 'summary.yaml'), MODULE_YAML)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withLibrary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-220-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  mkdirSync(instancesDir, { recursive: true })
  try {
    writeFixtureDefinition(definitionsDir, 'marked', DECLARATION)
    writeFixtureDefinition(definitionsDir, 'defaulted', DEFAULTED)
    writeFixtureDefinition(definitionsDir, 'legacy', '')
    return await fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const load = (id, definitionsDir) => loadDefinition(id, { definitionsDir, version: 1 })
const classificationOf = (definition) => definitionInstanceSettings(definition).find((setting) => setting.id === 'classification')
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const put = (body, headers = {}) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const localInstanceYaml = (instancesDir, slug) => parseYAML(readFileSync(join(instancesDir, 'default', slug, 'instance.yaml'), 'utf8'))

// The text of the paragraph a cover gives the custom style `style`, or undefined.
const coverParagraph = (markdown, style) => new RegExp(`::: \\{custom-style="${style}"\\}\\n([\\s\\S]*?)\\n:::`).exec(markdown)?.[1]

// ---------- The description every surface reads ----------

test('a Definition that declares markings offers Classification: its own markings verbatim, optional, with no default', () =>
  withLibrary(({ definitionsDir }) => {
    const marked = load('marked', definitionsDir)
    assert.deepEqual(definitionInstanceSettings(marked).map((s) => s.id), ['classification'], 'Size stays off: no Field declares word targets')
    const setting = classificationOf(marked)
    assert.equal(setting.label, 'Classification')
    assert.equal(setting.name, 'Classification')
    assert.deepEqual(setting.choices, MARKINGS.map((value) => ({ value, label: value })))
    assert.equal(setting.default, null)
    assert.equal(setting.fixedChoices, false)
    assert.equal(setting.optional, true, 'blank — no marking — is a choice')
    assert.equal(setting.offeredBecause, 'the Definition declares 3 markings')
    assert.match(setting.guidance, /cover and in the page header/)
    // The browser reads the version projection: both describe it the same.
    assert.deepEqual(definitionInstanceSettings(definitionVersionProjection(marked)), definitionInstanceSettings(marked))
  }))

test('a declared default is pre-selected, and then blank is no longer offered', () =>
  withLibrary(({ definitionsDir }) => {
    const setting = classificationOf(load('defaulted', definitionsDir))
    assert.equal(setting.default, 'IN-CONFIDENCE')
    assert.equal(setting.optional, false)
  }))

test('a Definition that declares no markings offers no Classification, whatever its Artefacts point at', () =>
  withLibrary(({ definitionsDir }) => {
    assert.deepEqual(definitionInstanceSettings(load('legacy', definitionsDir)), [])
    assert.equal(instanceClassification(load('legacy', definitionsDir), { classification: 'SECRET' }), null)
    for (const [id, version] of [['design', 1], ['design', 2], ['recruitment-onboarding', 2]]) {
      assert.equal(classificationOf(loadDefinition(id, { version })), undefined, `${id} v${version}`)
    }
  }))

test('the effective Classification is the stored marking, else the Definition\'s default, else blank', () =>
  withLibrary(({ definitionsDir }) => {
    const marked = load('marked', definitionsDir)
    const defaulted = load('defaulted', definitionsDir)
    assert.equal(effectiveInstanceSetting(classificationOf(marked), 'SECRET'), 'SECRET')
    assert.equal(effectiveInstanceSetting(classificationOf(marked), undefined), '')
    assert.equal(effectiveInstanceSetting(classificationOf(marked), 'TOP SECRET'), '', 'a marking not in the list is no marking')
    assert.equal(instanceClassification(defaulted, {}), 'IN-CONFIDENCE')
    assert.equal(instanceClassification(defaulted, { classification: 'PUBLIC' }), 'PUBLIC')
    assert.equal(instanceClassification(marked, {}), '')
  }))

test('storing a marking not in the Definition\'s list, or any marking on a Definition that declares none, is refused; blank is not', () =>
  withLibrary(({ definitionsDir }) => {
    const marked = load('marked', definitionsDir)
    const legacy = load('legacy', definitionsDir)
    assert.equal(instanceSettingProblem(marked, 'classification', 'SECRET'), null)
    assert.equal(
      instanceSettingProblem(marked, 'classification', 'secret'),
      'Unknown classification "secret" — choose one of the Definition\'s markings: "PUBLIC", "IN-CONFIDENCE", "SECRET"'
    )
    assert.equal(
      instanceSettingProblem(legacy, 'classification', 'SECRET'),
      'Definition "legacy" v1 declares no classification markings, so its instances have no classification'
    )
    assert.equal(instanceSettingsProblem(marked, { classification: '' }), null)
    assert.equal(instanceSettingsProblem(legacy, { classification: '' }), null, 'a blank value chooses nothing')
  }))

// ---------- A malformed declaration is a Definition problem ----------

const MALFORMED = [
  ['a declaration that is not a map', 'instance-settings: [classification]\n', /^"instance-settings" must map each Instance setting's id to its declaration/],
  ['a setting a Definition can\'t declare', 'instance-settings:\n  colour:\n    choices: [red]\n', /^Instance setting "colour" is not one a Definition can declare — Gantry knows "size", "classification"$/],
  ['a Classification with no choices', 'instance-settings:\n  classification:\n    choices: []\n', /^Instance setting "classification" declares no "choices" — list at least one marking$/],
  ['a Classification that isn\'t a map', 'instance-settings:\n  classification: [PUBLIC]\n', /^Instance setting "classification" must declare its "choices"/],
  ['a blank marking', 'instance-settings:\n  classification:\n    choices: [PUBLIC, " "]\n', /^Instance setting "classification" has a blank or non-text marking \(" "\)/],
  ['a duplicated marking', 'instance-settings:\n  classification:\n    choices: [PUBLIC, PUBLIC]\n', /^Instance setting "classification" lists the marking "PUBLIC" more than once$/],
  ['a default that isn\'t a choice', 'instance-settings:\n  classification:\n    choices: [PUBLIC]\n    default: SECRET\n', /^Instance setting "classification" has "default: SECRET", which is not one of its choices \("PUBLIC"\)$/],
  ['a misspelt key', 'instance-settings:\n  classification:\n    markings: [PUBLIC]\n', /^Instance setting "classification" has an unknown key "markings"/],
]

for (const [label, declaration, message] of MALFORMED) {
  test(`${label} is an invalid-instance-settings problem for gantry validate, the Definitions page and a Local Workspace, and the Definition still loads offering no Classification`, () =>
    withLibrary(({ definitionsDir }) => {
      writeFixtureDefinition(definitionsDir, 'broken', declaration, 'draft')
      const onDisk = findDefinitionProblems('broken', { definitionsDir, version: 1 })
      assert.ok(onDisk.length > 0 && onDisk.every((p) => p.type === 'invalid-instance-settings'), JSON.stringify(onDisk))
      assert.match(onDisk[0].message, message)

      const broken = load('broken', definitionsDir)
      const projection = definitionVersionProjection(broken)
      assert.deepEqual(findDefinitionProblemsInStructure(projection), onDisk, 'the Definitions page sees the same problem')
      assert.deepEqual(findLocalDefinitionProblems(projection), onDisk, 'a Local Workspace sees the same problem')
      assert.equal(classificationOf(broken), undefined, 'readers ignore a malformed setting')
    }))
}

test('Save and Publish refuse a malformed declaration, and keep a well-formed one', () =>
  withLibrary(({ definitionsDir }) => {
    writeFixtureDefinition(definitionsDir, 'draft-marked', DECLARATION, 'draft')
    const projection = definitionVersionProjection(load('draft-marked', definitionsDir))
    const refused = writeDefinitionVersion('draft-marked', 1, { ...projection, instanceSettings: { classification: { choices: ['PUBLIC'], default: 'SECRET' } } }, { definitionsDir })
    assert.deepEqual(refused.problems.map((p) => p.type), ['invalid-instance-settings'])
    assert.deepEqual(load('draft-marked', definitionsDir).instanceSettings, { classification: { choices: MARKINGS } }, 'a refused Save writes nothing')

    writeFixtureDefinition(definitionsDir, 'draft-broken', 'instance-settings:\n  classification:\n    choices: []\n', 'draft')
    assert.deepEqual(publishDefinitionVersion('draft-broken', 1, { definitionsDir }).problems.map((p) => p.type), ['invalid-instance-settings'])

    const saved = writeDefinitionVersion('draft-marked', 1, projection, { definitionsDir })
    assert.deepEqual(saved.instanceSettings, { classification: { choices: MARKINGS } })
    assert.deepEqual(instanceSettingsDeclarationProblems(saved.instanceSettings), [])
  }))

// ---------- Instance creation and the instance record ----------

test('creating an Instance stores the chosen marking as `classification:`, and nothing when none is chosen, even with a default', () =>
  withLibrary(({ definitionsDir, instancesDir }) => {
    createInstance('marked', 'chosen', { definitionsDir, instancesDir, classification: 'SECRET' })
    assert.equal(readInstance('chosen', { instancesDir }).classification, 'SECRET')
    createInstance('marked', 'unmarked', { definitionsDir, instancesDir, classification: '' })
    assert.equal('classification' in readInstance('unmarked', { instancesDir }), false)
    createInstance('defaulted', 'by-default', { definitionsDir, instancesDir })
    assert.equal('classification' in readInstance('by-default', { instancesDir }), false, 'the default applies without being stored')

    assert.throws(() => createInstance('marked', 'bad', { definitionsDir, instancesDir, classification: 'TOP SECRET' }), /Unknown classification "TOP SECRET"/)
    assert.throws(() => createInstance('legacy', 'bad', { definitionsDir, instancesDir, classification: 'SECRET' }), /declares no classification markings/)

    // The Local Workspace writers make the same choice the server does.
    assert.match(renderInstanceYaml({ definition: 'marked', slug: 's', stage: 'draft', assignee: '', definitionVersion: 1, classification: 'PUBLIC' }), /^classification: PUBLIC$/m)
    assert.doesNotMatch(renderInstanceYaml({ definition: 'marked', slug: 's', stage: 'draft', assignee: '', definitionVersion: 1, classification: '' }), /classification/)
    assert.equal(withStoredInstanceSettings({ slug: 's', classification: 'PUBLIC' }, { classification: '' }), 'slug: s\n')
  }))

test('`gantry new --classification` stores the marking, and refuses one the Definition doesn\'t list', () =>
  withLibrary(async ({ definitionsDir, instancesDir }) => {
    program.exitOverride()
    const origLog = console.log
    console.log = () => {}
    const cli = (...args) => program.parseAsync(['node', 'gantry.js', 'new', ...args, '--workspaces-dir', instancesDir, '--definitions-dir', definitionsDir])
    try {
      await cli('marked', 'cli-marked', '--classification', 'IN-CONFIDENCE')
      await assert.rejects(cli('marked', 'cli-bad', '--classification', 'TOP SECRET'), /Unknown classification "TOP SECRET"/)
    } finally {
      console.log = origLog
    }
    assert.equal(localInstanceYaml(instancesDir, 'cli-marked').classification, 'IN-CONFIDENCE')
    assert.equal(existsSync(join(instancesDir, 'default', 'cli-bad')), false)
  }))

// ---------- The server API (and so the wizard, Instance Settings and MCP) ----------

function withServer(fn) {
  return withLibrary(({ definitionsDir, instancesDir }) => withRunningServer({ definitionsDir, instancesDir }, (base) => fn({ base, definitionsDir, instancesDir })))
}

test('POST /api/instances stores a chosen marking, refuses one outside the list, and GET /api/instance returns the effective Classification', () =>
  withServer(async ({ base, instancesDir }) => {
    assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'marked', slug: 'marked-one', classification: 'SECRET' }))).status, 201)
    assert.equal(localInstanceYaml(instancesDir, 'marked-one').classification, 'SECRET')
    const marked = await (await fetch(`${base}/api/instance?slug=marked-one`)).json()
    assert.deepEqual(
      marked.instanceSettings.map(({ id, value, default: byDefault, optional, choices }) => ({ id, value, default: byDefault, optional, choices: choices.map((c) => c.value) })),
      [{ id: 'classification', value: 'SECRET', default: null, optional: true, choices: MARKINGS }]
    )

    assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'defaulted', slug: 'defaulted-one' }))).status, 201)
    const defaulted = await (await fetch(`${base}/api/instance?slug=defaulted-one`)).json()
    assert.equal(defaulted.instanceSettings[0].value, 'IN-CONFIDENCE', 'the default, unstored, is what the instance carries')

    for (const [body, message] of [
      [{ definition: 'marked', slug: 'bad-one', classification: 'TOP SECRET' }, /Unknown classification "TOP SECRET"/],
      [{ definition: 'legacy', slug: 'bad-two', classification: 'SECRET' }, /declares no classification markings/],
    ]) {
      const res = await fetch(`${base}/api/instances`, json(body))
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, message)
    }
    const legacy = await fetch(`${base}/api/instances`, json({ definition: 'legacy', slug: 'legacy-one' }))
    assert.equal(legacy.status, 201)
    assert.equal('instanceSettings' in (await (await fetch(`${base}/api/instance?slug=legacy-one`)).json()), false)
  }))

test('PUT /api/instance/settings changes the marking, a blank clears it, and a marking outside the list or on a Definition without markings is refused', () =>
  withServer(async ({ base, instancesDir }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'marked', slug: 'remarked' }))
    await fetch(`${base}/api/instances`, json({ definition: 'legacy', slug: 'old-style' }))

    const res = await fetch(`${base}/api/instance/settings?slug=remarked`, put({ settings: { classification: 'PUBLIC' } }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { slug: 'remarked', settings: { classification: 'PUBLIC' } })
    assert.equal(localInstanceYaml(instancesDir, 'remarked').classification, 'PUBLIC')

    const cleared = await fetch(`${base}/api/instance/settings?slug=remarked`, put({ settings: { classification: '' } }))
    assert.deepEqual(await cleared.json(), { slug: 'remarked', settings: {} })
    assert.equal('classification' in localInstanceYaml(instancesDir, 'remarked'), false)

    for (const [slug, settings, message] of [
      ['remarked', { classification: 'Public' }, /Unknown classification "Public"/],
      ['old-style', { classification: 'PUBLIC' }, /declares no classification markings/],
    ]) {
      const refused = await fetch(`${base}/api/instance/settings?slug=${slug}`, put({ settings }))
      assert.equal(refused.status, 400)
      assert.match((await refused.json()).error, message)
    }
    assert.equal('classification' in localInstanceYaml(instancesDir, 'old-style'), false, 'a refused write writes nothing')
  }))

// Each Provider writes the change on the stage branch, as Size and the Assignee are.
const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    create: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    create: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    // POST /api/instances doesn't create on GitLab, so the instance is seeded and registered.
    name: 'GitLab',
    provider: 'gitlab',
    serverOptions: {},
    fakeServerOptions: (slug) => ({ files: { [`/gantry-workspace/${slug}/instance.yaml`]: `definition: marked\ndefinitionVersion: 1\nslug: ${slug}\nstage: draft\nassignee: ""\nclassification: SECRET\n` } }),
    register: (ctx, slug, instancesDir) => {
      registerInstance(slug, { kind: 'gitlab', namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, { instancesDir })
      registerWorkspace({ provider: 'gitlab', location: { namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, owner: '' }, { instancesDir })
    },
    client: (ctx) => createGitLabClient({ namespace: ctx.namespace, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
]

for (const { name, provider, serverOptions, create, fakeServerOptions, register, client: clientFor } of PROVIDERS) {
  test(`${name}-backed: the instance carries its marking from creation, and a Settings change is written on the stage branch`, () =>
    withLibrary(({ definitionsDir }) =>
      withScratchInstances((instancesDir) =>
        withRunningServerForProvider(
          provider,
          { options: { definitionsDir, instancesDir, ...serverOptions }, fakeServerOptions: fakeServerOptions?.('remote-marked') },
          async (ctx) => {
            const auth = { Authorization: basicAuthHeader(ctx.pat) }
            const slug = 'remote-marked'
            const client = clientFor(ctx)
            if (register) register(ctx, slug, instancesDir)
            else {
              const created = await fetch(`${ctx.gantryBase}/api/instances`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ definition: 'marked', slug, classification: 'SECRET', ...create(ctx) }),
              })
              assert.equal(created.status, 201, await created.text())
            }
            assert.match(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`), /^classification: SECRET$/m)

            const read = await (await fetch(`${ctx.gantryBase}/api/instance?slug=${slug}`, { headers: auth })).json()
            assert.equal(read.instanceSettings.find((s) => s.id === 'classification').value, 'SECRET')

            const res = await fetch(`${ctx.gantryBase}/api/instance/settings?slug=${slug}`, put({ settings: { classification: 'PUBLIC' } }, auth))
            assert.equal(res.status, 200, await res.clone().text())
            assert.match(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`, { branch: stageBranchName(slug, 'draft') }), /^classification: PUBLIC$/m)
            assert.match(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`), /^classification: SECRET$/m, 'main is untouched until the stage is approved')

            const bad = await fetch(`${ctx.gantryBase}/api/instance/settings?slug=${slug}`, put({ settings: { classification: 'TOP SECRET' } }, auth))
            assert.equal(bad.status, 400)
            assert.match((await bad.json()).error, /Unknown classification "TOP SECRET"/)
          }
        )
      )
    ))
}

// ---------- The rendered document ----------

test('the cover prints the Instance\'s marking, a blank one prints none, and the Definition\'s default applies when none is stored', () =>
  withLibrary(({ definitionsDir, instancesDir }) => {
    createInstance('marked', 'secret-brief', { definitionsDir, instancesDir, classification: 'SECRET' })
    createInstance('marked', 'open-brief', { definitionsDir, instancesDir })
    createInstance('defaulted', 'default-brief', { definitionsDir, instancesDir })
    const render = (slug) => renderArtefact(slug, 'brief', { definitionsDir, instancesDir, dryRun: true })

    const secret = render('secret-brief')
    assert.equal(coverParagraph(secret.markdown, 'Cover Classification'), 'SECRET')
    assert.equal(coverParagraph(secret.docxMarkdown, 'Cover Classification'), 'SECRET')

    const open = render('open-brief')
    assert.doesNotMatch(open.markdown, /Cover Classification/, 'the .md has no marking')
    assert.equal(coverParagraph(open.docxMarkdown, 'Cover Classification'), '\\ ', 'Word gets only an invisible paragraph for the header field to find')

    assert.equal(coverParagraph(render('default-brief').markdown, 'Cover Classification'), 'IN-CONFIDENCE')
  }))

test('when the Definition declares markings the Instance\'s marking wins over a cover-classification Field; when it declares none, the Field still prints', () =>
  withLibrary(({ definitionsDir, instancesDir }) => {
    const markField = (slug) => {
      const file = join(instancesDir, slug, 'modules', 'summary.md')
      writeFileSync(file, readFileSync(file, 'utf8').replace(/## Marking\n\n?/, '## Marking\n\nFIELD MARKING\n\n'))
    }
    createInstance('marked', 'both', { definitionsDir, instancesDir, classification: 'PUBLIC' })
    createInstance('marked', 'field-only', { definitionsDir, instancesDir })
    createInstance('legacy', 'legacy-brief', { definitionsDir, instancesDir })
    for (const slug of ['both', 'field-only', 'legacy-brief']) markField(slug)
    const cover = (slug) => coverParagraph(renderArtefact(slug, 'brief', { definitionsDir, instancesDir, dryRun: true }).markdown, 'Cover Classification')

    assert.equal(cover('both'), 'PUBLIC')
    assert.equal(cover('field-only'), undefined, 'the pointer is ignored once markings are declared, even with the Instance\'s blank')
    assert.equal(cover('legacy-brief'), 'FIELD MARKING', 'the quiet fallback for a Definition written before Instance settings')
  }))

test('a rendered design v3 .docx prints the Instance\'s marking on the cover, for every page header\'s field to show', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-220-docx-'))
  try {
    cpSync('workspaces/examples/gantry', join(dir, 'gantry'), { recursive: true })
    rmSync(join(dir, 'gantry', 'out'), { recursive: true, force: true })
    const file = join(dir, 'gantry', 'instance.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace('classification: IN-CONFIDENCE', 'classification: SENSITIVE'))
    const { docxBytes } = renderArtefact('gantry', 'soap-full', { instancesDir: dir, deliverToClient: true })
    const [first] = bodyParagraphs(docxPart(docxBytes, 'word/document.xml'))
    assert.deepEqual([first.style, first.text], ['CoverClassification', 'SENSITIVE'])
    for (const { type, xml } of sectionHeaders(docxBytes)) assert.ok(classificationField(xml), `the ${type} header reads the cover's classification`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
