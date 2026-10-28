import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createInstance, readInstance } from '../lib/instance.js'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems, findDefinitionProblemsInStructure } from '../lib/definition.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
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
  instanceTargetSize,
  instanceSettingsDeclarationProblems,
  classificationMarkings,
  withInstanceSettingDefault,
  withoutInstanceSetting,
  withClassificationMarkingAdded,
  withClassificationMarkingRenamed,
  withClassificationMarkingRemoved,
  withClassificationMarkingMoved,
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

const SMALL_DEFAULT = 'instance-settings:\n  size:\n    default: small\n'

// #221: `declaration` is an `instance-settings:` block, and `status` lets a fixture be a draft.
function writeFixtureDefinition(definitionsDir, id, moduleYaml, { declaration = '', status = 'published' } = {}) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    `id: ${id}\nversion: 1\nstatus: ${status}\ntitle: ${id}\ndescription: A one-stage fixture\n${declaration}stages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
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
    // #221: `small-first` is `sized` with Small as its declared default size.
    writeFixtureDefinition(definitionsDir, 'small-first', BUDGETED_MODULE, { declaration: SMALL_DEFAULT })
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

// #220 adds Classification to design v3 (tests/instanceClassification.test.js covers it).
test('the packaged Definitions: design v3 offers Size and Classification; design v1/v2 and recruitment-onboarding offer nothing, as before', () => {
  assert.deepEqual(definitionInstanceSettings(loadDefinition('design', { version: 3 })).map((s) => s.id), ['size', 'classification'])
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
  assert.deepEqual(INSTANCE_SETTING_IDS, ['size', 'classification'])
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

// ---------- #221: a Definition's default size, and editing the declaration ----------

test('a Definition can declare its default size: the description, the wizard\'s pre-selection and the effective value all follow it', () =>
  withLibrary(({ definitionsDir }) => {
    const smallFirst = loadDefinition('small-first', { definitionsDir, version: 1 })
    const [size] = definitionInstanceSettings(smallFirst)
    assert.equal(size.default, 'small')
    assert.deepEqual(size.choices.map((c) => c.value), ['small', 'medium', 'large'], 'the choices are still Gantry\'s')
    assert.equal(effectiveInstanceSetting(size, undefined), 'small', 'what the wizard pre-selects')
    assert.equal(effectiveInstanceSetting(size, 'large'), 'large', 'a stored size still wins')
    assert.deepEqual(definitionInstanceSettings(definitionVersionProjection(smallFirst)), definitionInstanceSettings(smallFirst))

    assert.equal(instanceTargetSize(smallFirst, {}), 'small')
    assert.equal(instanceTargetSize(smallFirst, { size: 'large' }), 'large')
    assert.equal(instanceTargetSize(smallFirst, { size: 'huge' }), 'small')
    assert.equal(instanceTargetSize(loadDefinition('sized', { definitionsDir, version: 1 }), {}), 'medium', 'no default declared: Medium, as before')
    assert.equal(instanceSettingProblem(smallFirst, 'size', 'medium'), null)
  }))

const MALFORMED_SIZE = [
  ['a default that isn\'t a size', { size: { default: 'huge' } }, /^Instance setting "size" has "default: huge", which is not one of its choices \("small", "medium", "large"\)$/],
  ['a default spelt as its label', { size: { default: 'Small' } }, /^Instance setting "size" has "default: Small", which is not one of its choices/],
  ['its own choices', { size: { choices: ['tiny', 'huge'], default: 'tiny' } }, /^Instance setting "size" declares "choices", but Small, Medium and Large are fixed by Gantry/],
  ['an unknown key', { size: { defualt: 'small' } }, /^Instance setting "size" has an unknown key "defualt"/],
  ['a bare value', { size: 'small' }, /^Instance setting "size" must declare its "default"/],
]

for (const [label, declaration, message] of MALFORMED_SIZE) {
  test(`a Size declaration with ${label} is an invalid-instance-settings problem everywhere, and the Definition still works to Medium`, () =>
    withLibrary(({ definitionsDir }) => {
      const problems = instanceSettingsDeclarationProblems(declaration)
      assert.ok(problems.length > 0 && problems.every((p) => p.type === 'invalid-instance-settings'), JSON.stringify(problems))
      assert.match(problems[0].message, message)

      const projection = { ...definitionVersionProjection(loadDefinition('sized', { definitionsDir, version: 1 })), instanceSettings: declaration }
      assert.deepEqual(findDefinitionProblemsInStructure(projection), problems, 'the Definitions page sees the same problem')
      assert.deepEqual(findLocalDefinitionProblems(projection), problems, 'a Local Workspace sees the same problem')
      const [size] = definitionInstanceSettings(projection)
      assert.equal(size.default, 'medium', 'readers ignore a malformed setting')
      assert.equal(instanceTargetSize(projection, {}), 'medium')
    }))
}

test('gantry validate reports a malformed Size declaration on disk', () =>
  withLibrary(({ definitionsDir }) => {
    writeFixtureDefinition(definitionsDir, 'bad-size', BUDGETED_MODULE, { declaration: 'instance-settings:\n  size:\n    default: huge\n', status: 'draft' })
    assert.deepEqual(findDefinitionProblems('bad-size', { definitionsDir, version: 1 }).map((p) => p.type), ['invalid-instance-settings'])
    assert.deepEqual(definitionInstanceSettings(loadDefinition('bad-size', { definitionsDir, version: 1 }))[0].default, 'medium')
  }))

test('an instance with no stored size works to its Definition\'s default: GET /api/instance, its word targets and a save\'s over-budget notes', () =>
  withServer(async ({ base, instancesDir }) => {
    assert.equal((await fetch(`${base}/api/instances`, json({ definition: 'small-first', slug: 'unsized' }))).status, 201)
    assert.equal('size' in localInstanceYaml(instancesDir, 'unsized'), false, 'the default applies without being stored')

    const body = await (await fetch(`${base}/api/instance?slug=unsized`)).json()
    assert.equal(body.size, 'small')
    assert.equal(body.modules[0].fields.find((f) => f.id === 'overview').targetWords, 5)
    assert.deepEqual(body.instanceSettings.map(({ id, value, default: byDefault }) => ({ id, value, default: byDefault })), [{ id: 'size', value: 'small', default: 'small' }])

    const saved = await (await fetch(`${base}/api/instance/modules?slug=unsized`, put({
      modules: { summary: { fields: { risks: ['Late delivery', 'Over budget'] } } },
    }))).json()
    assert.deepEqual(saved.targetWordNotes.map((n) => n.message), ['summary.risks: 4 words, Small target ~2'])

    // Choosing a size overrides the default; clearing it goes back to the default, not to Medium.
    await fetch(`${base}/api/instance/settings?slug=unsized`, put({ settings: { size: 'large' } }))
    assert.equal((await (await fetch(`${base}/api/instance?slug=unsized`)).json()).size, 'large')
    await fetch(`${base}/api/instance/settings?slug=unsized`, put({ settings: { size: '' } }))
    assert.equal((await (await fetch(`${base}/api/instance?slug=unsized`)).json()).size, 'small')
  }))

test('editing a declaration: a default is set and cleared, and Classification\'s markings are added, renamed, reordered and removed', () => {
  // Size: a default, and clearing it removes the whole entry, since a Size declaration is only its default.
  assert.deepEqual(withInstanceSettingDefault(undefined, 'size', 'large'), { size: { default: 'large' } })
  assert.deepEqual(withInstanceSettingDefault({ size: { default: 'large' } }, 'size', ''), {})

  // Classification: the first marking declares it; later ones join the end, in order.
  assert.equal(classificationMarkings(undefined), null)
  let declaration = withClassificationMarkingAdded({ size: { default: 'small' } }, 'OFFICIAL')
  declaration = withClassificationMarkingAdded(declaration, 'SENSITIVE')
  declaration = withClassificationMarkingAdded(declaration, 'PROTECTED')
  assert.deepEqual(declaration, { size: { default: 'small' }, classification: { choices: ['OFFICIAL', 'SENSITIVE', 'PROTECTED'] } })
  assert.deepEqual(classificationMarkings(declaration), ['OFFICIAL', 'SENSITIVE', 'PROTECTED'])

  // A default follows its marking when the marking is renamed, and goes when it is removed.
  declaration = withInstanceSettingDefault(declaration, 'classification', 'SENSITIVE')
  declaration = withClassificationMarkingRenamed(declaration, 1, 'OFFICIAL: Sensitive')
  assert.deepEqual(declaration.classification, { choices: ['OFFICIAL', 'OFFICIAL: Sensitive', 'PROTECTED'], default: 'OFFICIAL: Sensitive' })
  declaration = withClassificationMarkingRenamed(declaration, 0, 'UNOFFICIAL')
  assert.equal(declaration.classification.default, 'OFFICIAL: Sensitive', 'renaming another marking leaves the default alone')

  declaration = withClassificationMarkingMoved(declaration, 2, -1)
  assert.deepEqual(declaration.classification.choices, ['UNOFFICIAL', 'PROTECTED', 'OFFICIAL: Sensitive'])
  assert.deepEqual(withClassificationMarkingMoved(declaration, 0, -1), declaration, 'unchanged at the top')
  assert.deepEqual(withClassificationMarkingMoved(declaration, 2, 1), declaration, 'and at the bottom')

  const removed = withClassificationMarkingRemoved(declaration, 2)
  assert.deepEqual(removed.classification, { choices: ['UNOFFICIAL', 'PROTECTED'] })
  assert.deepEqual(withClassificationMarkingRemoved(declaration, 0).classification.default, 'OFFICIAL: Sensitive')
  assert.equal(withInstanceSettingDefault(declaration, 'classification', '').classification.default, undefined)
  assert.deepEqual(withoutInstanceSetting(declaration, 'classification'), { size: { default: 'small' } })

  // Nothing here refuses an edit: what an author types is kept, and the validator reports it.
  const typed = withClassificationMarkingAdded(withClassificationMarkingRenamed(removed, 1, ''), 'UNOFFICIAL')
  assert.deepEqual(typed.classification.choices, ['UNOFFICIAL', '', 'UNOFFICIAL'])
  assert.deepEqual(instanceSettingsDeclarationProblems(typed).map((p) => p.message), [
    'Instance setting "classification" has a blank or non-text marking ("") — every choice must be the marking\'s text',
    'Instance setting "classification" lists the marking "UNOFFICIAL" more than once',
  ])
  const emptied = withClassificationMarkingRemoved(withClassificationMarkingRemoved(removed, 0), 0)
  assert.deepEqual(emptied.classification, { choices: [] })
  assert.match(instanceSettingsDeclarationProblems(emptied)[0].message, /declares no "choices"/)

  // The edits never change the declaration they are given.
  const before = JSON.stringify(declaration)
  withClassificationMarkingRemoved(declaration, 0)
  withInstanceSettingDefault(declaration, 'size', 'large')
  assert.equal(JSON.stringify(declaration), before)
})

test('the Definitions page\'s Save and Publish carry an edited declaration onto disk, refuse a malformed one, and a published version can\'t change', () =>
  withServer(async ({ base, definitionsDir }) => {
    writeFixtureDefinition(definitionsDir, 'drafty', BUDGETED_MODULE, { status: 'draft', declaration: 'instance-settings:\n  classification:\n    choices: [PUBLIC, SECRET]\n' })
    const url = `${base}/api/definitions/drafty/versions/1`
    const onDisk = () => parseYAML(readFileSync(join(definitionsDir, 'drafty', '1', 'definition.yaml'), 'utf8'))['instance-settings']
    const draft = await (await fetch(url)).json()
    assert.deepEqual(draft.instanceSettings, { classification: { choices: ['PUBLIC', 'SECRET'] } })

    let edited = withClassificationMarkingRenamed(draft.instanceSettings, 1, 'IN-CONFIDENCE')
    edited = withClassificationMarkingAdded(edited, 'RESTRICTED')
    edited = withClassificationMarkingMoved(edited, 2, -2)
    edited = withInstanceSettingDefault(edited, 'classification', 'PUBLIC')
    edited = withInstanceSettingDefault(edited, 'size', 'large')

    // The live validator and Save both refuse a malformed edit, and a refused Save writes nothing.
    const malformed = withClassificationMarkingAdded(edited, 'PUBLIC')
    const validated = await (await fetch(`${url}/validate`, json({ ...draft, instanceSettings: malformed }))).json()
    assert.deepEqual(validated.problems.map((p) => p.message), ['Instance setting "classification" lists the marking "PUBLIC" more than once'])
    const refused = await fetch(url, put({ ...draft, instanceSettings: malformed }))
    assert.equal(refused.status, 422)
    assert.deepEqual((await refused.json()).problems.map((p) => p.type), ['invalid-instance-settings'])
    assert.deepEqual(onDisk(), { classification: { choices: ['PUBLIC', 'SECRET'] } })

    const saved = await fetch(url, put({ ...draft, instanceSettings: edited }))
    assert.equal(saved.status, 200, await saved.clone().text())
    const expected = { classification: { choices: ['RESTRICTED', 'PUBLIC', 'IN-CONFIDENCE'], default: 'PUBLIC' }, size: { default: 'large' } }
    assert.deepEqual(onDisk(), expected)
    const reloaded = await (await fetch(url)).json()
    assert.deepEqual(reloaded.instanceSettings, expected)
    assert.deepEqual(definitionInstanceSettings(reloaded).map((s) => [s.id, s.default]), [['size', 'large'], ['classification', 'PUBLIC']])

    const published = await fetch(`${url}/publish`, { method: 'POST' })
    assert.equal(published.status, 200, await published.clone().text())
    assert.deepEqual(onDisk(), expected)
    const afterPublish = await fetch(url, put({ ...reloaded, instanceSettings: withoutInstanceSetting(expected, 'classification') }))
    assert.equal(afterPublish.status, 409)
    assert.deepEqual(onDisk(), expected, 'a published version stays as it was')
  }))
