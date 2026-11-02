import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { createAsset } from '../lib/assets.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { stageBranchName as azureDevOpsStageBranchName } from '../lib/stageBranch.js'
import { stageBranchName as gitHubStageBranchName } from '../lib/githubStageBranch.js'
import { modulePayload } from '../web/lib/stageSave.js'
import { mergeStage, stagePayloads } from '../web/lib/stageVersion.js'
import { withRunningServer, withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #270 (ADR-0068): every editor Save compares the stage's version now with the one noted when the
// stage was read. The same scenario runs against a server workspace, a GitHub-backed and an Azure
// DevOps-backed one: two browsers edit different Fields (both save), the second to save a stage that
// has moved on gets a 409 carrying what is saved now (nothing written), settling it Field by Field
// lets it through, and an Asset uploaded in between raises no clash. A Local workspace runs the same
// check in the browser (tests/editor-local-workspace.playwright.test.js).

const DEFINITION = 'recruitment-onboarding'
const QUERY = { slug: 'hire', stage: 'requisition' }

function client(base, headers) {
  const url = (path, query = QUERY) => `${base}${path}?${new URLSearchParams(query)}`
  return {
    read: async () => {
      const res = await fetch(url('/api/instance'), { headers })
      assert.equal(res.status, 200)
      return res.json()
    },
    put: (modules, baseVersion) =>
      fetch(url('/api/instance/modules'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(baseVersion === undefined ? { modules } : { modules, baseVersion }),
      }),
  }
}

// The payload the editor would send for `moduleId` once `changes` are typed into it.
function edited(instance, moduleId, changes) {
  const entry = instance.modules.find((m) => m.id === moduleId)
  const payload = modulePayload(entry)
  return { ...payload, fields: { ...payload.fields, ...changes } }
}

async function scenario({ base, headers, uploadAsset, savedRole }) {
  const api = client(base, headers)
  const readA = await api.read()
  const readB = await api.read()
  const v0 = readA.stageVersion
  assert.match(v0, /^[0-9a-f]{16}$/, 'reading an Instance returns the stage version')
  assert.equal(readB.stageVersion, v0)

  // Browser A edits one Field and saves: it goes through and moves the version on.
  const savedA = await api.put({ role: edited(readA, 'role', { summary: 'A wrote this summary.' }) }, v0)
  assert.equal(savedA.status, 200)
  const v1 = (await savedA.json()).stageVersion
  assert.notEqual(v1, v0)
  assert.equal((await api.read()).stageVersion, v1, 'a read now returns the version the save returned')

  // Browser B started from v0 and edited a different Field. The stage has moved on, so it is told so.
  const mineB = { role: edited(readB, 'role', { team: 'B wrote this team.' }) }
  const clash = await api.put(mineB, v0)
  assert.equal(clash.status, 409)
  const clashBody = await clash.json()
  assert.equal(clashBody.code, 'stage_changed')
  assert.equal(clashBody.stageVersion, v1)
  assert.equal(clashBody.current.role.fields.summary, 'A wrote this summary.', 'the refusal carries what is saved now')
  assert.doesNotMatch(await savedRole(), /B wrote this team/, 'nothing was written')

  // Settling the clash Field by Field keeps both; the retry carries the new version.
  const settled = mergeStage({ base: stagePayloads(readB.modules), mine: { role: mineB.role }, theirs: clashBody.current })
  assert.deepEqual(settled.conflicts, [])
  assert.deepEqual(settled.toWrite, ['role'])
  const retry = await api.put({ role: settled.payloads.role }, clashBody.stageVersion)
  assert.equal(retry.status, 200)
  const v2 = (await retry.json()).stageVersion
  const afterBoth = await savedRole()
  assert.match(afterBoth, /A wrote this summary\./)
  assert.match(afterBoth, /B wrote this team\./)

  // Both change the same Field: still a clash, and the saved text is untouched until it is settled.
  const readC = await api.read()
  assert.equal(readC.stageVersion, v2)
  const savedFirst = await api.put({ role: edited(readC, 'role', { summary: 'First to save.' }) }, v2)
  assert.equal(savedFirst.status, 200)
  const second = await api.put({ role: edited(readC, 'role', { summary: 'Second to save.' }) }, v2)
  assert.equal(second.status, 409)
  const conflictBody = await second.json()
  const open = mergeStage({ base: stagePayloads(readC.modules), mine: { role: edited(readC, 'role', { summary: 'Second to save.' }) }, theirs: conflictBody.current })
  assert.deepEqual(open.conflicts.map((c) => c.key), ['field:summary'])
  assert.match(await savedRole(), /First to save\./)

  // An Asset uploaded between reading and saving changes no Field, so it raises no clash.
  const readD = await api.read()
  await uploadAsset()
  assert.equal((await api.read()).stageVersion, readD.stageVersion, 'an upload leaves the version alone')
  const afterUpload = await api.put({ role: edited(readD, 'role', { team: 'After an upload.' }) }, readD.stageVersion)
  assert.equal(afterUpload.status, 200)
  assert.match(await savedRole(), /After an upload\./)

  // A caller that sends no version (an agent that predates the check) is let through as before.
  const unversioned = await api.put({ role: edited(await api.read(), 'role', { justification: 'No version sent.' }) })
  assert.equal(unversioned.status, 200)
  assert.match(await savedRole(), /No version sent\./)
}

test('server workspace: two editors on different Fields both save; the same Field is a clash; an Asset upload is not', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance(DEFINITION, 'hire', { instancesDir })
    const moduleFile = join(instancesDir, 'default', 'hire', 'modules', 'role.md')
    await withRunningServer({ slug: 'hire', instancesDir }, async (base) => {
      await scenario({
        base,
        headers: {},
        savedRole: async () => readFileSync(moduleFile, 'utf8'),
        uploadAsset: async () => {
          createAsset('hire', { filename: 'diagram.png', buffer: Buffer.from('png'), name: 'Diagram', source: 'https://example.test/d' }, { instancesDir: join(instancesDir, 'default') })
        },
      })
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
    // Azure DevOps assets are committed to the repo by hand (there is no upload route for them).
    upload: async ({ client, branch }) => {
      await client.writeFile('gantry-workspace/hire/assets/diagram.png', 'png-bytes', { message: 'Add an asset', branch })
    },
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    stageBranchName: gitHubStageBranchName,
    upload: async ({ ctx, auth }) => {
      const res = await fetch(`${ctx.gantryBase}/api/instance/assets?${new URLSearchParams(QUERY)}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ filename: 'diagram.png', dataBase64: Buffer.from('png-bytes').toString('base64'), name: 'Diagram', source: 'https://example.test/d' }),
      })
      assert.equal(res.status, 201)
    },
  },
]

for (const { name, provider, serverOptions, location, client: clientFor, stageBranchName, upload } of PROVIDERS) {
  test(`${name}-backed: two editors on different Fields both save; the same Field is a clash that creates no branch; an Asset upload is not a clash`, async () => {
    await withScratchInstances((instancesDir) =>
      withRunningServerForProvider(provider, { options: { instancesDir, ...serverOptions } }, async (ctx) => {
        const auth = { 'Content-Type': 'application/json', Authorization: basicAuthHeader(ctx.pat) }
        const created = await fetch(`${ctx.gantryBase}/api/instances`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ definition: DEFINITION, slug: 'hire', ...location(ctx) }),
        })
        assert.equal(created.status, 201)
        const store = clientFor(ctx)
        const branch = stageBranchName('hire', 'requisition')

        // A stale version before any stage branch exists is refused without creating the branch.
        const api = client(ctx.gantryBase, auth)
        const first = await api.read()
        const stale = await api.put({ role: edited(first, 'role', { summary: 'Never lands.' }) }, 'stale-version')
        assert.equal(stale.status, 409)
        assert.equal(await store.branchExists(branch), false, 'a refused save creates no stage branch')

        await scenario({
          base: ctx.gantryBase,
          headers: auth,
          savedRole: () => store.getFileContent('gantry-workspace/hire/modules/role.md', { branch }),
          uploadAsset: () => upload({ ctx, auth, client: store, branch }),
        })
      })
    )
  })
}
