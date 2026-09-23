import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { createInstance, readModule } from '../lib/instance.js'
import { loadDefinition, definitionVersionProjection, findDefinitionProblemsInStructure } from '../lib/definition.js'
import { validateDefinition } from '../lib/validate.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { buildLocalModuleEntry } from '../web/lib/localInstanceFiles.js'
import { getStatus } from '../lib/status.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { stageBranchName as azureDevOpsStageBranchName } from '../lib/stageBranch.js'
import { stageBranchName as gitHubStageBranchName } from '../lib/githubStageBranch.js'
import { withRunningServer, withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #152 (docs/adr/0050): a Stage's `read-only-modules` — Modules it mounts so its documents render and
// its Gate is evaluated, shown read-only in the editor and refused by the server's module-write
// routes. The fixture is recruitment-onboarding v2 with the key added to two Stages, so a Module can
// be read-only at a later Stage and editable at an earlier one:
//   requisition   role engagement role-evaluation open-questions
//   selection     role advertising selection vetting open-questions          read-only: role
//   appointment   role engagement selection vetting offer contract payroll … (nothing read-only)
//   provisioning  role … selection … identity device access handover …     read-only: role, selection
// `role`'s home at selection is requisition (the nearest earlier Stage mounting it editably); at
// provisioning it is appointment — nearest, not first.

const DEFINITION = 'recruitment-onboarding'

function withReadOnlyFixture(readOnly, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-read-only-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  cpSync(`definitions/${DEFINITION}/2`, join(definitionsDir, DEFINITION, '2'), { recursive: true })
  const yamlPath = join(definitionsDir, DEFINITION, '2', 'definition.yaml')
  const raw = parseYAML(readFileSync(yamlPath, 'utf8'))
  for (const stage of raw.stages) {
    if (readOnly[stage.id]) stage['read-only-modules'] = readOnly[stage.id]
  }
  writeFileSync(yamlPath, stringifyYAML(raw))
  return Promise.resolve(fn({ definitionsDir, instancesDir })).finally(() => rmSync(root, { recursive: true, force: true }))
}

const FIXTURE = { selection: ['role'], provisioning: ['role', 'selection'] }

function putModules(base, query, modules) {
  return fetch(`${base}/api/instance/modules?${new URLSearchParams(query)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modules }),
  })
}

function putModule(base, moduleId, query, body) {
  return fetch(`${base}/api/instance/modules/${moduleId}?${new URLSearchParams(query)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// The server module-write route
// ---------------------------------------------------------------------------

test('PUT /api/instance/modules refuses a read-only Module at the browsed Stage, naming its home Stage, and writes nothing', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const res = await putModules(base, { slug: 'hire', stage: 'provisioning' }, {
        identity: { fields: { account: 'jsmith' } },
        role: { fields: { summary: 'Changed behind the stage that signed it off.' } },
      })
      assert.equal(res.status, 400)
      const { error } = await res.json()
      assert.match(error, /"Role" \(role\) is read-only at stage "Provisioning"/)
      assert.match(error, /carried forward from stage "Appointment"/)
    })
    // The whole save is refused — the editable Module in the same request doesn't land either.
    const moduleFile = (id) => join(instancesDir, 'default', 'hire', 'modules', `${id}.md`)
    assert.doesNotMatch(readFileSync(moduleFile('role'), 'utf8'), /Changed behind/)
    assert.equal(existsSync(moduleFile('identity')), false)
  })
})

test('PUT /api/instance/modules refuses a read-only Module at the instance\'s current Stage when no stage is named — the MCP update_instance_modules default', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    const instanceYaml = join(instancesDir, 'hire', 'instance.yaml')
    writeFileSync(instanceYaml, readFileSync(instanceYaml, 'utf8').replace('stage: requisition', 'stage: selection'))
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const res = await putModules(base, { slug: 'hire' }, { role: { fields: { summary: 'Nope.' } } })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /read-only at stage "Selection".*carried forward from stage "Requisition"/)
    })
  })
})

test('PUT /api/instance/modules still writes a Module at its home Stage, and an editable Module beside a read-only one', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      // role is editable at appointment (mounted, not listed read-only) …
      const atHome = await putModules(base, { slug: 'hire', stage: 'appointment' }, { role: { fields: { summary: 'Edited where it is owned.' } } })
      assert.equal(atHome.status, 200)
      // … and at requisition, the instance's current Stage, when no stage is named.
      const current = await putModules(base, { slug: 'hire' }, { engagement: { fields: { rationale: 'Growth.' } } })
      assert.equal(current.status, 200)
      // At provisioning, identity is editable even though role and selection are read-only there.
      const beside = await putModules(base, { slug: 'hire', stage: 'provisioning' }, { identity: { fields: { account: 'jsmith' } } })
      assert.equal(beside.status, 200)
      assert.deepEqual((await beside.json()).saved, ['identity'])
    })
    const definition = loadDefinition(DEFINITION, { definitionsDir })
    const read = (id) => readModule(definition, 'hire', id, { instancesDir: join(instancesDir, 'default') })
    assert.equal(read('role').fields.summary, 'Edited where it is owned.')
    assert.equal(read('identity').fields.account, 'jsmith')
  })
})

test('PUT /api/instance/modules/:id refuses a read-only Module the same way, and allows it at its home Stage', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const refused = await putModule(base, 'selection', { slug: 'hire', stage: 'provisioning' }, { fields: { 'candidate-name': 'Someone else' } })
      assert.equal(refused.status, 400)
      assert.match((await refused.json()).error, /"Selection" \(selection\) is read-only at stage "Provisioning".*carried forward from stage "Appointment"/)

      const allowed = await putModule(base, 'selection', { slug: 'hire', stage: 'selection' }, { fields: { 'candidate-name': 'Jane Smith' } })
      assert.equal(allowed.status, 200)
    })
    const definition = loadDefinition(DEFINITION, { definitionsDir })
    assert.equal(readModule(definition, 'hire', 'selection', { instancesDir: join(instancesDir, 'default') }).fields['candidate-name'], 'Jane Smith')
  })
})

test('opt-in: a Definition without read-only-modules writes every mounted Module at every Stage, as before', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    // design mounts nfrs at both hld-define and detailed-design, filled in progressively.
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      for (const stage of loadDefinition('design').stages) {
        const modules = Object.fromEntries(stage.modules.map((id) => [id, { status: 'draft' }]))
        const res = await putModules(base, { slug: 'my-initiative', stage: stage.id }, modules)
        assert.equal(res.status, 200, `stage ${stage.id}`)
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('PUT /api/instance/modules and /:id return 400 for a stage the Definition does not have, writing nothing — a bad ?stage= is no way round the refusal', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    const selectionFile = join(instancesDir, 'default', 'hire', 'modules', 'selection.md')
    const before = existsSync(selectionFile) ? readFileSync(selectionFile, 'utf8') : null
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const bulk = await putModules(base, { slug: 'hire', stage: 'bogus' }, { selection: { fields: { 'candidate-name': 'Sneaky' } } })
      assert.equal(bulk.status, 400)
      assert.match((await bulk.json()).error, /has no stage "bogus"/)
      const single = await putModule(base, 'selection', { slug: 'hire', stage: 'bogus' }, { fields: { 'candidate-name': 'Sneaky' } })
      assert.equal(single.status, 400)
      assert.match((await single.json()).error, /has no stage "bogus"/)
    })
    assert.equal(existsSync(selectionFile) ? readFileSync(selectionFile, 'utf8') : null, before)
  })
})

// The Azure DevOps and GitHub branches of both routes make the same check, and make it before the
// stage branch is resolved — so a refused save neither writes nor creates or stacks a stage branch.
const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    location: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    stageBranchName: azureDevOpsStageBranchName,
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    stageBranchName: gitHubStageBranchName,
  },
]

for (const { name, provider, serverOptions, location, client: clientFor, stageBranchName } of PROVIDERS) {
  test(`${name}-backed: both module-write routes refuse a read-only Module before any stage branch exists, and allow it at its home Stage`, async () => {
    await withReadOnlyFixture(FIXTURE, ({ definitionsDir }) =>
      withScratchInstances((instancesDir) =>
        withRunningServerForProvider(provider, { options: { instancesDir, definitionsDir, ...serverOptions } }, async (ctx) => {
          const auth = { 'Content-Type': 'application/json', Authorization: basicAuthHeader(ctx.pat) }
          const created = await fetch(`${ctx.gantryBase}/api/instances`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ definition: DEFINITION, slug: 'hire', ...location(ctx) }),
          })
          assert.equal(created.status, 201)
          const client = clientFor(ctx)
          const selectionBranch = stageBranchName('hire', 'selection')

          const bulk = await fetch(`${ctx.gantryBase}/api/instance/modules?slug=hire&stage=selection`, {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ modules: { role: { fields: { summary: 'Changed behind requisition.' } } } }),
          })
          assert.equal(bulk.status, 400)
          assert.match((await bulk.json()).error, /"Role" \(role\) is read-only at stage "Selection".*carried forward from stage "Requisition"/)

          const single = await fetch(`${ctx.gantryBase}/api/instance/modules/role?slug=hire&stage=selection`, {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ fields: { summary: 'Changed behind requisition.' } }),
          })
          assert.equal(single.status, 400)
          assert.match((await single.json()).error, /read-only at stage "Selection".*carried forward from stage "Requisition"/)

          assert.equal(await client.branchExists(selectionBranch), false, 'a refused save creates no stage branch')
          assert.doesNotMatch(await client.getFileContent('gantry-workspace/hire/modules/role.md'), /Changed behind/)

          const atHome = await fetch(`${ctx.gantryBase}/api/instance/modules/role?slug=hire&stage=requisition`, {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ fields: { summary: 'Edited where it is owned.' } }),
          })
          assert.equal(atHome.status, 200)
          const requisitionBranch = stageBranchName('hire', 'requisition')
          assert.match(await client.getFileContent('gantry-workspace/hire/modules/role.md', { branch: requisitionBranch }), /Edited where it is owned\./)
        })
      )
    )
  })
}

// ---------------------------------------------------------------------------
// GET /api/instance — what the instance editor is given
// ---------------------------------------------------------------------------

test('GET /api/instance marks a read-only Module with its home Stage and no required Fields; editable Modules are unchanged', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const body = await (await fetch(`${base}/api/instance?slug=hire&stage=provisioning`)).json()
      const byId = new Map(body.modules.map((m) => [m.id, m]))
      assert.deepEqual(byId.get('role').readOnly, { homeStage: { id: 'appointment', title: 'Appointment' } })
      assert.deepEqual(byId.get('selection').readOnly, { homeStage: { id: 'appointment', title: 'Appointment' } })
      assert.ok(byId.get('role').fields.every((f) => f.required === false))
      // Editable Modules carry no readOnly key at all, and keep their required markers.
      assert.equal('readOnly' in byId.get('identity'), false)
      assert.ok(byId.get('identity').fields.some((f) => f.required === true))

      const atHome = await (await fetch(`${base}/api/instance?slug=hire&stage=appointment`)).json()
      const role = atHome.modules.find((m) => m.id === 'role')
      assert.equal('readOnly' in role, false)
      assert.ok(role.fields.some((f) => f.required === true))
    })
  })
})

test('a Module read-only at its first mounting Stage has no home Stage — still read-only, and the refusal says no earlier Stage owns it', async () => {
  await withReadOnlyFixture({ requisition: ['role'] }, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const body = await (await fetch(`${base}/api/instance?slug=hire&stage=requisition`)).json()
      assert.deepEqual(body.modules.find((m) => m.id === 'role').readOnly, { homeStage: null })
      const res = await putModules(base, { slug: 'hire', stage: 'requisition' }, { role: { fields: { summary: 'Nope.' } } })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /read-only at stage "Requisition".*no earlier stage owns it/)
    })
  })
})

test('a read-only Module still counts toward its Gate — status and check read `modules`, not the subset', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    const withKey = loadDefinition(DEFINITION, { definitionsDir })
    const provisioning = withKey.stages.find((s) => s.id === 'provisioning')
    assert.deepEqual(provisioning.modules, loadDefinition(DEFINITION, { version: 2 }).stages.find((s) => s.id === 'provisioning').modules)
    const status = getStatus('hire', { instancesDir, definitionsDir, stageId: 'provisioning' })
    assert.ok(status.modules.some((m) => m.id === 'role'), 'role still reported in provisioning\'s status')
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validation flags a read-only id the Stage does not mount, on disk and in-memory, and the local twin agrees', async () => {
  await withReadOnlyFixture({ requisition: ['role', 'payroll'] }, async ({ definitionsDir }) => {
    const { valid, problems } = validateDefinition(DEFINITION, { definitionsDir, version: 2 })
    assert.equal(valid, false)
    assert.deepEqual(problems.map((p) => p.type), ['unknown-read-only-module'])
    assert.match(problems[0].message, /^Stage "requisition" lists module "payroll" as read-only, but the stage doesn't mount it/)

    const raw = parseYAML(readFileSync(join(definitionsDir, DEFINITION, '2', 'definition.yaml'), 'utf8'))
    const projection = definitionVersionProjection(loadDefinition(DEFINITION, { version: 2 }))
    projection.stages.find((s) => s.id === 'requisition').readOnlyModules = raw.stages[0]['read-only-modules']
    assert.deepEqual(findDefinitionProblemsInStructure(projection), problems.map(({ type, message }) => ({ type, message })))
    assert.deepEqual(findLocalDefinitionProblems(projection).map((p) => p.type), ['unknown-read-only-module'])
  })
})

test('validation flags read-only-modules that is not a list', async () => {
  await withReadOnlyFixture({ requisition: 'role' }, async ({ definitionsDir }) => {
    const { problems } = validateDefinition(DEFINITION, { definitionsDir, version: 2 })
    assert.deepEqual(problems.map((p) => p.type), ['invalid-read-only-modules'])
  })
})

test('a valid read-only-modules passes validation, and a Definition with a bad one still loads for existing instances', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir }) => {
    assert.equal(validateDefinition(DEFINITION, { definitionsDir, version: 2 }).valid, true)
  })
  await withReadOnlyFixture({ requisition: ['payroll'] }, async ({ definitionsDir }) => {
    const definition = loadDefinition(DEFINITION, { definitionsDir })
    assert.deepEqual(definition.stages[0].readOnlyModules, ['payroll'])
  })
})

// ---------------------------------------------------------------------------
// The local-workspace twin
// ---------------------------------------------------------------------------

test('buildLocalModuleEntry marks a read-only Module the same way the server does', async () => {
  await withReadOnlyFixture(FIXTURE, async ({ definitionsDir, instancesDir }) => {
    createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
    const projection = definitionVersionProjection(loadDefinition(DEFINITION, { definitionsDir }))
    const provisioning = projection.stages.find((s) => s.id === 'provisioning')
    const roleSpec = projection.modules.find((m) => m.id === 'role')
    const blank = { status: 'draft', owner: '', fields: {} }
    await withRunningServer({ slug: 'hire', instancesDir, definitionsDir }, async (base) => {
      const body = await (await fetch(`${base}/api/instance?slug=hire&stage=provisioning`)).json()
      const serverRole = body.modules.find((m) => m.id === 'role')
      assert.ok(serverRole.readOnly)
      const localRole = buildLocalModuleEntry(roleSpec, provisioning, blank, null, projection.stages)
      assert.deepEqual(localRole.readOnly, serverRole.readOnly)
      assert.deepEqual(localRole.fields.map((f) => f.required), serverRole.fields.map((f) => f.required))
    })
    const identity = buildLocalModuleEntry(projection.modules.find((m) => m.id === 'identity'), provisioning, blank, null, projection.stages)
    assert.equal('readOnly' in identity, false)
  })
})
