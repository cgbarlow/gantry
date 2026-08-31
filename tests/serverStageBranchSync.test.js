import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function moduleContent(text) {
  return `---\nmodule: context\nstatus: draft\nowner: \n---\n\n# Background and context\n\n## Problem statement\n\n${text}\n`
}

function withServer(instancesDir, adoBaseUrl, fn) {
  const server = createServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] })
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

test('GET /api/instance stageSync.behind + behindFiles correct when behind (main has changes)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        // stage branch stays at old, main moves ahead
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('main updated'), { branch: 'main' })
        await client.writeFile('/gantry-workspace/my-slug/modules/extra.md', moduleContent('extra main'), { branch: 'main' })

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const res = await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.stageSync.behind, true)
          assert.deepEqual(body.stageSync.behindFiles, ['/gantry-workspace/my-slug/modules/context.md', '/gantry-workspace/my-slug/modules/extra.md'])
          assert.equal(body.stageSync.ahead, false)
          // Must not have created a branch for a different stage
          assert.equal(await client.branchExists('gantry-workspace/my-slug/hld-define'), false)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance stageSync.behind:false when level (up to date)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const res = await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.stageSync.behind, false)
          assert.deepEqual(body.stageSync.behindFiles, [])
          assert.equal(body.stageSync.ahead, false)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance stageSync.behind:false when ahead only (stage has changes, main not)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('stage version'), { branch: 'gantry-workspace/my-slug/shape' })

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const res = await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.stageSync.behind, false)
          assert.deepEqual(body.stageSync.behindFiles, [])
          assert.equal(body.stageSync.ahead, true)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GET /api/instance stageSync does not create a branch when none exists (opening editor must not create)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const res = await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.equal(body.stageSync.behind, false)
          assert.equal(await client.branchExists('gantry-workspace/my-slug/shape'), false)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/stage-branch/sync fast-forwards and clears behind', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('main updated'), { branch: 'main' })
        await client.writeFile('/gantry-workspace/my-slug/modules/extra.md', moduleContent('extra main'), { branch: 'main' })

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const before = await (await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(before.stageSync.behind, true)

          const syncRes = await fetch(`${base}/api/instance/stage-branch/sync?slug=my-slug&stage=shape`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(syncRes.status, 200)
          const syncBody = await syncRes.json()
          assert.equal(syncBody.branch, 'gantry-workspace/my-slug/shape')
          assert.equal(typeof syncBody.objectId, 'string')
          assert.equal(syncBody.fastForward, true)

          const after = await (await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(after.stageSync.behind, false)
          assert.deepEqual(after.stageSync.behindFiles, [])
          // Verify file actually landed on stage branch via fast-forward
          const extra = await client.getFileContent('/gantry-workspace/my-slug/modules/extra.md', { branch: 'gantry-workspace/my-slug/shape' })
          assert.match(extra, /extra main/)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/stage-branch/sync merges divergent non-conflicting changes via PR', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
          '/gantry-workspace/my-slug/modules/other.md': moduleContent('old other'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('stage version'), { branch: 'gantry-workspace/my-slug/shape' })
        await client.writeFile('/gantry-workspace/my-slug/modules/other.md', moduleContent('main updated other'), { branch: 'main' })

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const before = await (await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(before.stageSync.behind, true)
          assert.equal(before.stageSync.ahead, true)

          const syncRes = await fetch(`${base}/api/instance/stage-branch/sync?slug=my-slug&stage=shape`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(syncRes.status, 200)
          const syncBody = await syncRes.json()
          assert.equal(syncBody.branch, 'gantry-workspace/my-slug/shape')
          assert.equal(syncBody.fastForward, false)
          assert.equal(typeof syncBody.pullRequestId, 'number')

          const after = await (await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(after.stageSync.behind, false)

          const ctx = await client.getFileContent('/gantry-workspace/my-slug/modules/context.md', { branch: 'gantry-workspace/my-slug/shape' })
          const other = await client.getFileContent('/gantry-workspace/my-slug/modules/other.md', { branch: 'gantry-workspace/my-slug/shape' })
          assert.match(ctx, /stage version/)
          assert.match(other, /main updated other/)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/stage-branch/sync conflict returns 409 with pullRequestUrl and leaves branch untouched', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('stage version'), { branch: 'gantry-workspace/my-slug/shape' })
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('main updated'), { branch: 'main' })
        const stageHeadBefore = await client.getBranchObjectId('gantry-workspace/my-slug/shape')

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const syncRes = await fetch(`${base}/api/instance/stage-branch/sync?slug=my-slug&stage=shape`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(syncRes.status, 409)
          const body = await syncRes.json()
          assert.equal(body.error, 'Merge conflict — resolve in the opened pull request')
          assert.equal(typeof body.pullRequestUrl, 'string')
          assert.match(body.pullRequestUrl, /pullrequest/i)
          assert.equal(typeof body.pullRequestId, 'number')

          const stageHeadAfter = await client.getBranchObjectId('gantry-workspace/my-slug/shape')
          assert.equal(stageHeadAfter, stageHeadBefore)
          const ctx = await client.getFileContent('/gantry-workspace/my-slug/modules/context.md', { branch: 'gantry-workspace/my-slug/shape' })
          assert.match(ctx, /stage version/)
          assert.doesNotMatch(ctx, /main updated/)

          const after = await (await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(after.stageSync.behind, true)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('POST /api/instance/stage-branch/sync requires PAT (401 when missing)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const res = await fetch(`${base}/api/instance/stage-branch/sync?slug=my-slug&stage=shape`, { method: 'POST' })
          assert.equal(res.status, 401)
          const body = await res.json()
          assert.equal(body.error, 'authentication_required')
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('WI262: completed stage with leftover divergent branch — GET behind:false and POST already complete', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: hld-define\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        // Diverge: main moves ahead (would make behind:true) and shape branch also diverges (would make ahead:true + conflict on sync)
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('main updated for hld'), { branch: 'main' })
        await client.writeFile('/gantry-workspace/my-slug/modules/extra.md', moduleContent('extra main'), { branch: 'main' })
        // Also write instance.yaml advancement already on main (shape -> hld-define), so shape branch is left behind
        await client.writeFile('/gantry-workspace/my-slug/instance.yaml', 'definition: design\nslug: my-slug\nstage: hld-define\n', { branch: 'main' })
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('stale shape branch version'), { branch: 'gantry-workspace/my-slug/shape' })
        const shapeHeadBefore = await client.getBranchObjectId('gantry-workspace/my-slug/shape')

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          // GET for the completed stage must NOT report behind, even though main has diverged
          const res = await fetch(`${base}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(res.status, 200)
          const body = await res.json()
          assert.deepEqual(body.stageSync, { behind: false, behindFiles: [], ahead: false })

          // POST for the completed stage must return already-complete, not a merge or 409 conflict
          const syncRes = await fetch(`${base}/api/instance/stage-branch/sync?slug=my-slug&stage=shape`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(syncRes.status, 409)
          const syncBody = await syncRes.json()
          assert.match(syncBody.error, /already complete/i)
          assert.match(syncBody.error, /shape/i)

          // Branch must be untouched
          const shapeHeadAfter = await client.getBranchObjectId('gantry-workspace/my-slug/shape')
          assert.equal(shapeHeadAfter, shapeHeadBefore)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('WI262 regression: current stage still reports behind and syncs (happy path unchanged)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-'))
  try {
    await withFakeAzureDevOpsServer(
      {
        organization: ORGANIZATION,
        project: PROJECT,
        repository: REPOSITORY,
        validPat: VALID_PAT,
        files: {
          '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: hld-define\n',
          '/gantry-workspace/my-slug/modules/context.md': moduleContent('old'),
        },
      },
      async (adoBaseUrl) => {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/hld-define')
        await client.writeFile('/gantry-workspace/my-slug/modules/context.md', moduleContent('main updated for current'), { branch: 'main' })
        await client.writeFile('/gantry-workspace/my-slug/modules/extra.md', moduleContent('extra main current'), { branch: 'main' })

        await withServer(instancesDir, adoBaseUrl, async (base) => {
          const before = await (await fetch(`${base}/api/instance?slug=my-slug&stage=hld-define`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(before.stageSync.behind, true)
          assert.deepEqual(before.stageSync.behindFiles, ['/gantry-workspace/my-slug/modules/context.md', '/gantry-workspace/my-slug/modules/extra.md'])

          const syncRes = await fetch(`${base}/api/instance/stage-branch/sync?slug=my-slug&stage=hld-define`, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT) } })
          assert.equal(syncRes.status, 200)
          const syncBody = await syncRes.json()
          assert.equal(syncBody.branch, 'gantry-workspace/my-slug/hld-define')
          assert.equal(syncBody.fastForward, true)

          const after = await (await fetch(`${base}/api/instance?slug=my-slug&stage=hld-define`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })).json()
          assert.equal(after.stageSync.behind, false)
          assert.deepEqual(after.stageSync.behindFiles, [])
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
