import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createInstance, readInstance } from '../lib/instance.js'
import { loadDefinition, definitionVersionProjection } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import {
  INSTANCE_SETTING_IDS,
  definitionInstanceSettings,
  effectiveInstanceSetting,
  instanceSettingsWithValues,
  instanceSettingProblem,
  instanceSettingsProblem,
  chosenInstanceSettings,
  withChangedInstanceSettings,
} from '../web/lib/instanceSettings.js'
import { withStoredInstanceSettings, renderInstanceYaml } from '../web/lib/localInstanceFiles.js'
import { withRunningServer, withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #219 (spec #223, ADR-0058): an Instance's **Instance settings** are the per-Instance choices its
// Definition declares, each as its choices plus an optional default, read by every surface from one
// description (web/lib/instanceSettings.js). Target size (ADR-0054) is the first member, so this
// covers what that grouping adds over tests/targetSize.test.js — which must keep passing unchanged:
// the description itself, `instanceSettings` on GET /api/instance, and the one settings write,
// `PUT /api/instance/settings`, locally and on every Provider. The fixture is
// tests/targetSize.test.js's: `sized` declares word targets, `plain` is the same Definition without.

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

function writeFixtureDefinition(definitionsDir, id, moduleYaml) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    `id: ${id}\nversion: 1\nstatus: published\ntitle: ${id}\ndescription: A one-stage fixture\nstages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
  )
  writeFileSync(join(dir, 'modules', 'summary.yaml'), moduleYaml)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withLibrary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-219-'))
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

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const put = (body, headers = {}) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const localInstanceYaml = (instancesDir, slug) => parseYAML(readFileSync(join(instancesDir, 'default', slug, 'instance.yaml'), 'utf8'))

// ---------- The description every surface reads ----------

test('a Definition with word targets offers Size — fixed Small/Medium/Large choices, default Medium — and says which Fields make it so', () =>
  withLibrary(({ definitionsDir }) => {
    const sized = loadDefinition('sized', { definitionsDir, version: 1 })
    const settings = definitionInstanceSettings(sized)
    assert.deepEqual(settings.map((s) => s.id), ['size'])
    const [size] = settings
    assert.equal(size.label, 'Size')
    assert.equal(size.name, 'Target size')
    assert.deepEqual(size.choices, [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ])
    assert.equal(size.default, 'medium')
    assert.equal(size.fixedChoices, true)
    assert.equal(size.offeredBecause, '2 Fields declare word targets')

    // The browser reads the version projection, not the loaded Definition: both describe it the same.
    assert.deepEqual(definitionInstanceSettings(definitionVersionProjection(sized)), settings)

    const oneField = { id: 'one', version: 1, modules: [{ id: 'm', fields: [{ id: 'f', type: 'markdown', targetWords: { small: 1, medium: 2, large: 3 } }] }] }
    assert.equal(definitionInstanceSettings(oneField)[0].offeredBecause, '1 Field declares word targets')
  }))

test('a Definition without word targets offers no Instance settings, and a malformed budget doesn\'t count', () =>
  withLibrary(({ definitionsDir }) => {
    assert.deepEqual(definitionInstanceSettings(loadDefinition('plain', { definitionsDir, version: 1 })), [])
    const malformed = { id: 'bad', version: 1, modules: [{ id: 'm', fields: [{ id: 'f', type: 'markdown', targetWords: { small: 1, medium: 2 } }] }] }
    assert.deepEqual(definitionInstanceSettings(malformed), [])
    assert.deepEqual(definitionInstanceSettings({ id: 'empty', modules: [] }), [])
  }))

test('the packaged Definitions: design v3 offers Size; design v1/v2 and recruitment-onboarding offer nothing, as before', () => {
  assert.deepEqual(definitionInstanceSettings(loadDefinition('design', { version: 3 })).map((s) => s.id), ['size'])
  for (const [id, version] of [['design', 1], ['design', 2], ['recruitment-onboarding', 1], ['recruitment-onboarding', 2], ['recruitment-onboarding', 3]]) {
    assert.deepEqual(definitionInstanceSettings(loadDefinition(id, { version })), [], `${id} v${version}`)
  }
})

test('the effective value is the stored one when it is a choice, else the Definition\'s default', () =>
  withLibrary(({ definitionsDir }) => {
    const sized = loadDefinition('sized', { definitionsDir, version: 1 })
    const [size] = definitionInstanceSettings(sized)
    assert.equal(effectiveInstanceSetting(size, 'large'), 'large')
    assert.equal(effectiveInstanceSetting(size, undefined), 'medium')
    assert.equal(effectiveInstanceSetting(size, 'huge'), 'medium')
    assert.deepEqual(instanceSettingsWithValues(sized, { size: 'small' }).map((s) => [s.id, s.value]), [['size', 'small']])
    assert.deepEqual(instanceSettingsWithValues(sized, {}).map((s) => [s.id, s.value]), [['size', 'medium']])
  }))

test('every write is checked the same way: an unknown setting, a value outside the choices, or a setting the Definition doesn\'t offer is refused', () =>
  withLibrary(({ definitionsDir }) => {
    const sized = loadDefinition('sized', { definitionsDir, version: 1 })
    const plain = loadDefinition('plain', { definitionsDir, version: 1 })
    assert.equal(instanceSettingProblem(sized, 'size', 'large'), null)
    assert.match(instanceSettingProblem(sized, 'size', 'huge'), /Unknown size "huge" — choose small, medium or large/)
    // Size's choices are Gantry's, so an unknown size is named as such whatever the Definition.
    assert.match(instanceSettingProblem(plain, 'size', 'huge'), /Unknown size "huge"/)
    assert.match(instanceSettingProblem(plain, 'size', 'small'), /Definition "plain" v1 declares no target-words, so its instances have no size/)
    assert.match(instanceSettingProblem(sized, 'colour', 'blue'), /Unknown Instance setting "colour" — Gantry knows "size"/)

    assert.equal(instanceSettingsProblem(sized, { size: 'small' }), null)
    assert.equal(instanceSettingsProblem(plain, { size: '' }), null, 'a blank value chooses nothing')
    assert.match(instanceSettingsProblem(plain, { size: 'small' }), /declares no target-words/)
    assert.match(instanceSettingsProblem(sized, { colour: '' }), /Unknown Instance setting "colour"/)
  }))

test('a key is written only when a value is chosen, and a blank Settings save removes it', () => {
  assert.deepEqual(INSTANCE_SETTING_IDS, ['size'])
  assert.deepEqual(chosenInstanceSettings({ size: 'large', assignee: 'a.person', slug: 'x' }), { size: 'large' })
  assert.deepEqual(chosenInstanceSettings({ size: '' }), {})
  assert.deepEqual(chosenInstanceSettings(null), {})
  assert.deepEqual(withChangedInstanceSettings({ slug: 'x', size: 'small' }, { size: 'large' }), { slug: 'x', size: 'large' })
  assert.deepEqual(withChangedInstanceSettings({ slug: 'x', size: 'small' }, { size: '' }), { slug: 'x' })

  // The Local Workspace writers make the same choice the server does.
  assert.doesNotMatch(renderInstanceYaml({ definition: 'd', slug: 's', stage: 'st', assignee: '', definitionVersion: 1 }), /size/)
  assert.match(renderInstanceYaml({ definition: 'd', slug: 's', stage: 'st', assignee: '', definitionVersion: 1, size: 'small' }), /^size: small$/m)
  assert.equal(withStoredInstanceSettings({ slug: 's', size: 'small' }, { size: 'large' }), 'size: large\nslug: s\n')
  assert.equal(withStoredInstanceSettings({ slug: 's', size: 'small' }, { size: '' }), 'slug: s\n')
})

// ---------- The server API ----------

function withServer(fn) {
  return withLibrary(({ definitionsDir, instancesDir }) =>
    withRunningServer({ definitionsDir, instancesDir }, (base) => fn({ base, definitionsDir, instancesDir }))
  )
}

test('GET /api/instance carries the offered Instance settings with this instance\'s values; a Definition without any gets no key', () =>
  withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'grouped', size: 'large' }))).status, 201)
    assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'ungrouped' }))).status, 201)

    const sized = await (await fetch(`${base}/api/instance?slug=grouped`)).json()
    assert.deepEqual(
      sized.instanceSettings.map(({ id, label, value, default: byDefault, choices }) => ({ id, label, value, default: byDefault, choices: choices.map((c) => c.value) })),
      [{ id: 'size', label: 'Size', value: 'large', default: 'medium', choices: ['small', 'medium', 'large'] }]
    )
    assert.equal(sized.size, 'large', 'Size itself is still returned as it always was')

    const plain = await (await fetch(`${base}/api/instance?slug=ungrouped`)).json()
    assert.equal('instanceSettings' in plain, false)
  }))

test('PUT /api/instance/settings saves a setting, and a blank value clears it so the instance works to the default again', () =>
  withServer(async ({ base, instancesDir }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'resized' }))

    const res = await fetch(`${base}/api/instance/settings?slug=resized`, put({ settings: { size: 'small' } }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { slug: 'resized', settings: { size: 'small' } })
    assert.equal(localInstanceYaml(instancesDir, 'resized').size, 'small')
    assert.equal(readInstance('resized', { instancesDir: join(instancesDir, 'default') }).definition, 'sized', 'every other field is kept')

    const body = await (await fetch(`${base}/api/instance?slug=resized`)).json()
    assert.equal(body.instanceSettings[0].value, 'small')
    assert.equal(body.modules[0].fields.find((f) => f.id === 'overview').targetWords, 5)

    const cleared = await fetch(`${base}/api/instance/settings?slug=resized`, put({ settings: { size: '' } }))
    assert.deepEqual(await cleared.json(), { slug: 'resized', settings: {} })
    assert.equal('size' in localInstanceYaml(instancesDir, 'resized'), false)
    assert.equal((await (await fetch(`${base}/api/instance?slug=resized`)).json()).size, 'medium')
  }))

test('PUT /api/instance/settings refuses an unknown setting, a value outside its choices, a setting the Definition doesn\'t offer, and an empty body', () =>
  withServer(async ({ base, instancesDir }) => {
    await fetch(`${base}/api/instances`, json({ definition: 'sized', slug: 'sized-one' }))
    await fetch(`${base}/api/instances`, json({ definition: 'plain', slug: 'plain-one' }))

    const refusals = [
      ['sized-one', { settings: { colour: 'blue' } }, /Unknown Instance setting "colour"/],
      ['sized-one', { settings: { size: 'Large' } }, /Unknown size "Large"/],
      ['plain-one', { settings: { size: 'small' } }, /declares no target-words/],
      ['sized-one', { settings: {} }, /settings must be an object/],
      ['sized-one', { size: 'small' }, /settings must be an object/],
    ]
    for (const [slug, body, message] of refusals) {
      const res = await fetch(`${base}/api/instance/settings?slug=${slug}`, put(body))
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.match((await res.json()).error, message)
    }
    assert.equal('size' in localInstanceYaml(instancesDir, 'sized-one'), false, 'a refused write writes nothing')
    assert.equal('size' in localInstanceYaml(instancesDir, 'plain-one'), false)
  }))

// Each Provider writes the settings change on the stage branch, as the Assignee and Size always have.
const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    create: async (ctx, slug) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    create: async (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    // POST /api/instances doesn't create on GitLab, so the instance is seeded in the fake repo and
    // registered, as tests/serverGitLabAssetsAndRender.test.js does.
    name: 'GitLab',
    provider: 'gitlab',
    serverOptions: {},
    fakeServerOptions: (slug) => ({ files: { [`/gantry-workspace/${slug}/instance.yaml`]: `definition: sized\ndefinitionVersion: 1\nslug: ${slug}\nstage: draft\nassignee: ""\n` } }),
    register: (ctx, slug, instancesDir) => {
      registerInstance(slug, { kind: 'gitlab', namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, { instancesDir })
      registerWorkspace({ provider: 'gitlab', location: { namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, owner: '' }, { instancesDir })
    },
    client: (ctx) => createGitLabClient({ namespace: ctx.namespace, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
]

for (const { name, provider, serverOptions, create, fakeServerOptions, register, client: clientFor } of PROVIDERS) {
  test(`${name}-backed: PUT /api/instance/settings writes the change to instance.yaml on the stage branch, and refuses an out-of-range value`, () =>
    withLibrary(({ definitionsDir }) =>
      withScratchInstances((instancesDir) =>
        withRunningServerForProvider(
          provider,
          { options: { definitionsDir, instancesDir, ...serverOptions }, fakeServerOptions: fakeServerOptions?.('remote-settings') },
          async (ctx) => {
            const auth = { Authorization: basicAuthHeader(ctx.pat) }
            const slug = 'remote-settings'
            if (register) register(ctx, slug, instancesDir)
            else {
              const created = await fetch(`${ctx.gantryBase}/api/instances`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ definition: 'sized', slug, ...(await create(ctx, slug)) }),
              })
              assert.equal(created.status, 201, await created.text())
            }

            const res = await fetch(`${ctx.gantryBase}/api/instance/settings?slug=${slug}`, put({ settings: { size: 'large' } }, auth))
            assert.equal(res.status, 200, await res.clone().text())
            assert.deepEqual(await res.json(), { slug, settings: { size: 'large' } })
            const client = clientFor(ctx)
            assert.match(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`, { branch: stageBranchName(slug, 'draft') }), /^size: large$/m)
            assert.doesNotMatch(await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`), /^size: large$/m, 'main is untouched until the stage is approved')

            const bad = await fetch(`${ctx.gantryBase}/api/instance/settings?slug=${slug}`, put({ settings: { size: 'huge' } }, auth))
            assert.equal(bad.status, 400)
            assert.match((await bad.json()).error, /Unknown size "huge"/)
          }
        )
      )
    ))
}

test('`createInstance` refuses a setting the Definition doesn\'t offer before writing anything, and stores only what was chosen', () =>
  withLibrary(({ definitionsDir, instancesDir }) => {
    assert.throws(() => createInstance('plain', 'plain-sized', { definitionsDir, instancesDir, size: 'small' }), /declares no target-words/)
    createInstance('sized', 'sized-blank', { definitionsDir, instancesDir, size: '' })
    assert.equal('size' in readInstance('sized-blank', { instancesDir }), false)
  }))
