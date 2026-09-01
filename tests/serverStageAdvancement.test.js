import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// HTTP-boundary tests for #115's new route: POST /api/instance/advance-stage
// (the local-instance "Advance to next stage" self-serve action, ADR-0012),
// plus GET /api/instance's accompanying `workspaceBacked` flag the web
// form's Stage advancement panel gates on. Real HTTP requests against a
// real running server throughout, mirroring tests/serverWorkItems.test.js's
// own conventions.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
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

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return (async () => fn(instancesDir))().finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

function fillShapeStage(instancesDir, slug) {
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    cpSync(join('instances', 'examples', 'modules', `${moduleId}.md`), join(instancesDir, slug, 'modules', `${moduleId}.md`))
  }
}

test('POST /api/instance/advance-stage rejects a local instance whose current gate has not passed, and leaves it unchanged', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/advance-stage?slug=my-initiative`, { method: 'POST' })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /has not passed/)
    })

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'shape')
  })
})

test('POST /api/instance/advance-stage advances a local instance whose current gate has passed', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')

    await withRunningServer({ instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/instance/advance-stage?slug=my-initiative`, { method: 'POST' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.fromStage.id, 'shape')
      assert.equal(body.toStage.id, 'hld-define')
    })

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'hld-define')
  })
})

test('POST /api/instance/advance-stage rejects a Workspace-backed instance outright, never calling advanceStage at all', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (adoBaseUrl) => {
    await withScratchInstances(async (instancesDir) => {
      registerInstance(
        'remote-initiative',
        { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
        { instancesDir }
      )

      await withRunningServer({ instancesDir }, async (base) => {
        // No PAT attached at all — if this route mistakenly tried to treat
        // the instance as Azure-DevOps-backed before rejecting it, it would
        // fail with the credential-gating layer's 401 instead of this
        // route's own explicit 400; asserting 400 here confirms the
        // Workspace-backed check runs (and rejects) before any credential
        // or Azure DevOps network call is ever made.
        const res = await fetch(`${base}/api/instance/advance-stage?slug=remote-initiative`, { method: 'POST' })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /Workspace-backed/)
      })
    })
  })
})

test('GET /api/instance reports workspaceBacked: false for a local instance and workspaceBacked: true for a Workspace-backed one', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nslug: remote-initiative\nstage: shape\n',
      },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        createInstance('design', 'local-initiative', { instancesDir })
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer({ instancesDir }, async (base) => {
          const localRes = await fetch(`${base}/api/instance?slug=local-initiative`)
          assert.equal(localRes.status, 200)
          assert.equal((await localRes.json()).workspaceBacked, false)

          const remoteRes = await fetch(`${base}/api/instance?slug=remote-initiative`, {
            headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`, 'utf8').toString('base64')}` },
          })
          assert.equal(remoteRes.status, 200)
          assert.equal((await remoteRes.json()).workspaceBacked, true)
        })
      })
    }
  )
})
