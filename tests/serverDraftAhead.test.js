import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { stageBranchName as githubStageBranchName } from '../lib/githubStageBranch.js'
import { readInstance, recordInstancePullRequest } from '../lib/instance.js'
import { withRunningServerForProvider, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/lifecycle.js'

// #296, ADR-0063: "shared Modules wait". While the Instance's current Stage has a Pull Request open, a write to a later Stage may not put
// content in a Module that Stage also mounts, and Gantry enforces that itself, on both module-write routes, on Azure DevOps and GitHub.
// The `design` Definition's Shape and HLD define Stages share `background`, `introduction`, `dependencies` and `open-questions`; HLD define
// alone mounts `risks`.

const SLUG = 'drafting-ahead'
const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages
const SHARED = 'background'
const HEAD_START = 'risks'

const seedFiles = () => ({ [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: ${SHAPE.id}\ndefinitionVersion: 2\n` })
const json = { 'Content-Type': 'application/json' }
const put = (url, headers, modules) => fetch(url, { method: 'PUT', headers: { ...headers, ...json }, body: JSON.stringify({ modules }) })
const putOne = (url, headers, body) => fetch(url, { method: 'PUT', headers: { ...headers, ...json }, body: JSON.stringify(body) })
const body = (moduleId) => ({ status: 'draft', owner: '', fields: { [moduleId === HEAD_START ? 'risk-register' : 'summary']: 'Words.' } })

async function withScratchServer(provider, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(provider, { options: { instancesDir }, fakeServerOptions: { files: seedFiles() } }, (ctx) => fn({ ...ctx, instancesDir }))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// What differs between the two Providers, so the same cases run on each.
const PROVIDERS = [
  {
    name: 'GitHub',
    provider: 'github',
    auth: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
    register: (instancesDir, baseUrl) => registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, { instancesDir }),
    location: (baseUrl) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl }),
    key: 'github',
    resolve: resolveGitHubStageBranch,
    client: (location) => createGitHubClient(location),
    branchName: githubStageBranchName,
  },
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    auth: { Authorization: basicAuthHeader(VALID_PAT) },
    register: (instancesDir, baseUrl) => registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }, { instancesDir }),
    location: (baseUrl) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }),
    key: 'azureDevOps',
    resolve: resolveStageBranch,
    client: (location) => createAzureDevOpsClient(location),
    branchName: stageBranchName,
  },
]

for (const spec of PROVIDERS) {
  // Shape has its branch and (when `open`) its Pull Request on file; the Instance is still on Shape.
  async function setUp({ gantryBase, providerBaseUrl, instancesDir }, { open }) {
    spec.register(instancesDir, providerBaseUrl)
    const location = spec.location(providerBaseUrl)
    const shapeBranch = await spec.resolve(location, definition, SLUG, SHAPE.id)
    if (open) await recordInstancePullRequest(SLUG, SHAPE.id, 41, { [spec.key]: { ...location, branch: shapeBranch }, pullRequestStatus: 'active' })
    return { location, client: spec.client(location), url: (path, stage = HLD_DEFINE.id) => `${gantryBase}${path}?slug=${SLUG}&stage=${stage}` }
  }

  test(`${spec.name}: with Shape's Pull Request open, a write to a Module HLD define shares with it is refused, naming the Stage, and nothing is written`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { client, location, url } = await setUp(ctx, { open: true })

      const bulk = await put(url('/api/instance/modules'), spec.auth, { [SHARED]: body(SHARED) })
      assert.equal(bulk.status, 400)
      const refusal = await bulk.json()
      assert.equal(refusal.code, 'shared-module-pending')
      assert.match(refusal.error, /Stage "High-level Design" \(hld-define\) is being drafted ahead/)
      assert.match(refusal.error, /\(background\) with Stage "SOAP" \(shape\)/)

      const single = await putOne(url(`/api/instance/modules/${SHARED}`), spec.auth, body(SHARED))
      assert.equal(single.status, 400)
      assert.equal((await single.json()).code, 'shared-module-pending')

      // A save that mixes the head start with a shared Module is refused whole: the head start does not land beside it.
      const mixed = await put(url('/api/instance/modules'), spec.auth, { [HEAD_START]: body(HEAD_START), [SHARED]: body(SHARED) })
      assert.equal(mixed.status, 400)

      // Refused before any branch is started: HLD define has none, and nothing was written to Shape's branch either.
      assert.equal(await client.branchExists(spec.branchName(SLUG, HLD_DEFINE.id)), false)
      assert.equal(await client.fileExists(`gantry-workspace/${SLUG}/modules/${SHARED}.md`, await spec.resolve(location, definition, SLUG, SHAPE.id)), false)
    })
  })

  test(`${spec.name}: with Shape's Pull Request open, HLD define's own Modules are written (the head start), on both routes, as one commit on its branch`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { client, url } = await setUp(ctx, { open: true })
      const bulk = await put(url('/api/instance/modules'), spec.auth, { [HEAD_START]: body(HEAD_START) })
      assert.equal(bulk.status, 200, await bulk.clone().text())
      const branch = spec.branchName(SLUG, HLD_DEFINE.id)
      assert.equal(await client.branchExists(branch), true)
      assert.match(await client.getFileContent(`gantry-workspace/${SLUG}/modules/${HEAD_START}.md`, { branch }), /Words\./)

      const single = await putOne(url(`/api/instance/modules/${HEAD_START}`), spec.auth, { ...body(HEAD_START), fields: { 'risk-register': 'More words.' } })
      assert.equal(single.status, 200, await single.clone().text())
      assert.match(await client.getFileContent(`gantry-workspace/${SLUG}/modules/${HEAD_START}.md`, { branch }), /More words\./)
    })
  })

  test(`${spec.name}: the Stage the Instance is on is never held, and with no Pull Request open a later Stage's shared Module is not refused`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { url } = await setUp(ctx, { open: false })
      // Shape is current and shares with nobody pending.
      const own = await put(url('/api/instance/modules', SHAPE.id), spec.auth, { [SHARED]: body(SHARED) })
      assert.equal(own.status, 200, await own.clone().text())
      // Shape has a branch but no Pull Request yet: nothing is awaiting approval, so nothing waits.
      const ahead = await put(url('/api/instance/modules'), spec.auth, { [SHARED]: body(SHARED) })
      assert.equal(ahead.status, 200, await ahead.clone().text())
    })
  })

  test(`${spec.name}: a Pull Request that is no longer open does not hold anything`, async () => {
    await withScratchServer(spec.provider, async (ctx) => {
      const { location, url } = await setUp(ctx, { open: false })
      const shapeBranch = await spec.resolve(location, definition, SLUG, SHAPE.id)
      await recordInstancePullRequest(SLUG, SHAPE.id, 41, { [spec.key]: { ...location, branch: shapeBranch }, pullRequestStatus: 'abandoned' })
      assert.equal((await readInstance(SLUG, { [spec.key]: { ...location, branch: shapeBranch } })).pullRequestStatuses?.[SHAPE.id], 'abandoned')
      const res = await put(url('/api/instance/modules'), spec.auth, { [SHARED]: body(SHARED) })
      assert.equal(res.status, 200, await res.clone().text())
    })
  })
}
