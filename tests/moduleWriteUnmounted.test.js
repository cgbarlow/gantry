import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { stageBranchName as azureDevOpsStageBranchName } from '../lib/stageBranch.js'
import { stageBranchName as gitHubStageBranchName } from '../lib/githubStageBranch.js'
import { withRunningServer, withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #168: the module-write routes (`PUT /api/instance/modules` and `PUT /api/instance/modules/:id`)
// refuse, with a 400 naming the Stage, any Module the target Stage doesn't mount — so naming a different
// Stage is no way round a Module being read-only (#152) or owned elsewhere. recruitment-onboarding
// mounts `selection` from the `selection` Stage on; `requisition` doesn't mount it (nor `payroll`).

const DEFINITION = 'recruitment-onboarding'

function putModules(base, query, modules, headers = { 'Content-Type': 'application/json' }) {
  return fetch(`${base}/api/instance/modules?${new URLSearchParams(query)}`, { method: 'PUT', headers, body: JSON.stringify({ modules }) })
}

function putModule(base, moduleId, query, body, headers = { 'Content-Type': 'application/json' }) {
  return fetch(`${base}/api/instance/modules/${moduleId}?${new URLSearchParams(query)}`, { method: 'PUT', headers, body: JSON.stringify(body) })
}

test('local: both module-write routes refuse a Module the named Stage does not mount, naming the Stage, and write nothing', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance(DEFINITION, 'hire', { instancesDir })
    const moduleFile = (id) => join(instancesDir, 'default', 'hire', 'modules', `${id}.md`)
    await withRunningServer({ slug: 'hire', instancesDir }, async (base) => {
      const bulk = await putModules(base, { slug: 'hire', stage: 'requisition' }, {
        engagement: { fields: { rationale: 'Growth.' } },
        selection: { fields: { 'candidate-name': 'Sneaky' } },
      })
      assert.equal(bulk.status, 400)
      assert.match((await bulk.json()).error, /Stage "Requisition" \(requisition\) does not mount module "Selection" \(selection\)/)

      const single = await putModule(base, 'selection', { slug: 'hire', stage: 'requisition' }, { fields: { 'candidate-name': 'Sneaky' } })
      assert.equal(single.status, 400)
      assert.match((await single.json()).error, /Stage "Requisition" \(requisition\) does not mount module "Selection" \(selection\)/)

      // With no ?stage= the instance's current Stage (requisition) is the one checked.
      const current = await putModule(base, 'payroll', { slug: 'hire' }, { fields: {} })
      assert.equal(current.status, 400)
      assert.match((await current.json()).error, /Stage "Requisition" \(requisition\) does not mount/)
    })
    // The whole bulk save is refused: the mounted Module beside the unmounted one doesn't land either.
    assert.equal(existsSync(moduleFile('selection')), false)
    assert.equal(existsSync(moduleFile('engagement')) && /Growth\./.test(readFileSync(moduleFile('engagement'), 'utf8')), false)
  })
})

test('local: a Module the Stage does mount is still written by both routes', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance(DEFINITION, 'hire', { instancesDir })
    await withRunningServer({ slug: 'hire', instancesDir }, async (base) => {
      const bulk = await putModules(base, { slug: 'hire', stage: 'requisition' }, { engagement: { fields: { rationale: 'Growth.' } } })
      assert.equal(bulk.status, 200)
      const single = await putModule(base, 'role', { slug: 'hire', stage: 'requisition' }, { fields: { summary: 'A role.' } })
      assert.equal(single.status, 200)
      const atMounting = await putModule(base, 'selection', { slug: 'hire', stage: 'selection' }, { fields: { 'candidate-name': 'Jane Smith' } })
      assert.equal(atMounting.status, 200)
    })
  })
})

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
  test(`${name}-backed: both module-write routes refuse an unmounted Module before any stage branch exists, and still write a mounted one`, async () => {
    await withScratchInstances((instancesDir) =>
      withRunningServerForProvider(provider, { options: { instancesDir, ...serverOptions } }, async (ctx) => {
        const auth = { 'Content-Type': 'application/json', Authorization: basicAuthHeader(ctx.pat) }
        const created = await fetch(`${ctx.gantryBase}/api/instances`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ definition: DEFINITION, slug: 'hire', ...location(ctx) }),
        })
        assert.equal(created.status, 201)
        const client = clientFor(ctx)
        const requisitionBranch = stageBranchName('hire', 'requisition')

        const bulk = await putModules(ctx.gantryBase, { slug: 'hire', stage: 'requisition' }, { selection: { fields: { 'candidate-name': 'Sneaky' } } }, auth)
        assert.equal(bulk.status, 400)
        assert.match((await bulk.json()).error, /Stage "Requisition" \(requisition\) does not mount module "Selection" \(selection\)/)

        const single = await putModule(ctx.gantryBase, 'selection', { slug: 'hire', stage: 'requisition' }, { fields: { 'candidate-name': 'Sneaky' } }, auth)
        assert.equal(single.status, 400)
        assert.match((await single.json()).error, /Stage "Requisition" \(requisition\) does not mount module "Selection" \(selection\)/)

        assert.equal(await client.branchExists(requisitionBranch), false, 'a refused save creates no stage branch')

        const mounted = await putModule(ctx.gantryBase, 'role', { slug: 'hire', stage: 'requisition' }, { fields: { summary: 'Edited where it is mounted.' } }, auth)
        assert.equal(mounted.status, 200)
        assert.match(await client.getFileContent('gantry-workspace/hire/modules/role.md', { branch: requisitionBranch }), /Edited where it is mounted\./)
      })
    )
  })
}
