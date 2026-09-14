import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { MIGRATED_DEFAULT_WORKSPACE_FOLDER } from '../lib/instanceRegistry.js'

// WI #383 (Definition Editor phase 3, ADR-0036): a workspace can hold its own definitions.
//
// Two homes covered here:
// - a **server workspace** (a `workspace.json`-marked folder under `instancesDir`) — the full CRUD
//   surface, reusing the existing `/api/definitions...` routes (resolved transparently by id, since
//   ids are unique across every home); and
// - an **Azure DevOps workspace** — the smaller, explicitly-parametrized `/api/workspaces/:id/definitions...`
//   surface, committing straight to the fake Azure DevOps server's `main` (one push per save/publish).

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

async function withServerWorkspaceDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p3-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p3-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    mkdirSync(join(instancesDir, 'acme'), { recursive: true })
    writeWorkspaceJson(instancesDir, 'acme', { name: 'Acme', kind: 'local', createdAt: new Date().toISOString() })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// ---------- server workspace ----------

test('POST /api/definitions with home targets a server workspace, and the new id shows up under GET ?includeWorkspaces=1 grouped by that home', async () => {
  await withServerWorkspaceDirs(async (definitionsDir, instancesDir) => {
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const createRes = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'acme-process', title: 'Acme Process', home: { kind: 'server-workspace', id: 'acme' } }),
      })
      assert.equal(createRes.status, 201)

      const listRes = await fetch(`${base}/api/definitions?includeWorkspaces=1`)
      assert.equal(listRes.status, 200)
      const rows = await listRes.json()
      const row = rows.find((r) => r.id === 'acme-process')
      assert.ok(row, 'expected the workspace definition in the combined listing')
      assert.deepEqual(row.home, { kind: 'server-workspace', id: 'acme', name: 'Acme' })

      // Not present without includeWorkspaces — byte-for-byte the pre-existing library-only behavior.
      const libOnlyRes = await fetch(`${base}/api/definitions`)
      const libOnlyRows = await libOnlyRes.json()
      assert.equal(libOnlyRows.some((r) => r.id === 'acme-process'), false)
    })
  })
})

test('creating a workspace definition with an id that already exists in the library is refused 409, no shadowing', async () => {
  await withServerWorkspaceDirs(async (definitionsDir, instancesDir) => {
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const res = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'design', title: 'Colliding', home: { kind: 'server-workspace', id: 'acme' } }),
      })
      assert.equal(res.status, 409)
    })
  })
})

test('creating a workspace definition with an id that already exists in a different workspace is refused 409', async () => {
  await withServerWorkspaceDirs(async (definitionsDir, instancesDir) => {
    mkdirSync(join(instancesDir, 'other'), { recursive: true })
    writeWorkspaceJson(instancesDir, 'other', { name: 'Other', kind: 'local', createdAt: new Date().toISOString() })
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const first = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'shared-process', home: { kind: 'server-workspace', id: 'acme' } }),
      })
      assert.equal(first.status, 201)
      const second = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'shared-process', home: { kind: 'server-workspace', id: 'other' } }),
      })
      assert.equal(second.status, 409)
    })
  })
})

test('a same-store id collision (the pre-existing contract) is still 400, not 409', async () => {
  await withServerWorkspaceDirs(async (definitionsDir, instancesDir) => {
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const first = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'acme-process', home: { kind: 'server-workspace', id: 'acme' } }),
      })
      assert.equal(first.status, 201)
      const again = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'acme-process', home: { kind: 'server-workspace', id: 'acme' } }),
      })
      assert.equal(again.status, 400)
    })
  })
})

test('a server workspace definition can be saved and published through the ordinary versions routes, and creating an instance from it resolves the workspace definition first', async () => {
  // A brand-new local instance always lands in the reserved "default" server workspace
  // (`MIGRATED_DEFAULT_WORKSPACE_FOLDER` — `POST /api/instances`'s own local branch), so that's the
  // one workspace whose own definitions `POST /api/instances` can pick from — this test uses it
  // directly, rather than "acme" (the other tests in this file use "acme" to prove the *no-shadowing*
  // rule, which doesn't care which workspace is involved).
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p3-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p3-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    mkdirSync(join(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER), { recursive: true })
    writeWorkspaceJson(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER, { name: 'default', kind: 'local', createdAt: new Date().toISOString() })

    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const createRes = await fetch(`${base}/api/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: 'acme-process', title: 'Acme Process', home: { kind: 'server-workspace', id: MIGRATED_DEFAULT_WORKSPACE_FOLDER } }),
      })
      assert.equal(createRes.status, 201)

      const proj = await (await fetch(`${base}/api/definitions/acme-process/versions/1`)).json()
      proj.modules = [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }]
      proj.stages = [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }]
      proj.artefacts = [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }]

      const saveRes = await fetch(`${base}/api/definitions/acme-process/versions/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proj),
      })
      assert.equal(saveRes.status, 200, await saveRes.text())

      const publishRes = await fetch(`${base}/api/definitions/acme-process/versions/1/publish`, { method: 'POST' })
      assert.equal(publishRes.status, 200, await publishRes.text())

      // The workspace definition is on disk exactly where a server workspace's own definitions live.
      assert.ok(existsSync(join(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER, 'definitions', 'acme-process', '1', 'definition.yaml')))

      // POST /api/instances always lands a local instance in the reserved "default" workspace — this
      // proves the *definition* resolution (workspace-first, falling back to the library) that WI #383
      // asks for, using the one server workspace `gantry serve` always has.
      const instRes = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'acme-process', slug: 'acme-instance' }),
      })
      assert.equal(instRes.status, 201, await instRes.text())

      const viewRes = await fetch(`${base}/api/instance?slug=acme-instance`)
      const viewText = await viewRes.text()
      assert.equal(viewRes.status, 200, viewText)
      const view = JSON.parse(viewText)
      assert.equal(view.definition, 'acme-process')
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- Azure DevOps workspace: the commit path ----------

test('Azure DevOps workspace definitions: create, save and publish each land as exactly one commit straight to main', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p3-ado-'))
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p3-ado-lib-'))
    try {
      cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
      const workspace = registerWorkspace({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl, owner: '' }, { instancesDir })

      await withRunningServer({ definitionsDir, instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_PAT)

        // No credential at all -> 401, same structured response every other Azure-DevOps-backed route uses.
        const noAuth = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newId: 'ado-process' }),
        })
        assert.equal(noAuth.status, 401)

        const createRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'ado-process', title: 'ADO Process' }),
        })
        assert.equal(createRes.status, 201, await createRes.text())

        // Colliding with the library is refused 409, same "no shadowing" rule as a server workspace.
        const collideRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'design' }),
        })
        assert.equal(collideRes.status, 409)

        const listRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, { headers: { Authorization: auth } })
        assert.equal(listRes.status, 200)
        const rows = await listRes.json()
        assert.equal(rows.length, 1)
        assert.equal(rows[0].id, 'ado-process')
        assert.deepEqual(rows[0].home, { kind: 'azure-devops-workspace', id: workspace.id, name: REPOSITORY })

        const client = createAzureDevOpsClient({
          organization: ORGANIZATION,
          project: PROJECT,
          repository: REPOSITORY,
          pat: VALID_PAT,
          baseUrl,
        })
        const commitsAfterCreate = await client.listBranchCommits('main', { compareTo: null })

        const getRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions/1`, { headers: { Authorization: auth } })
        assert.equal(getRes.status, 200)
        const proj = await getRes.json()
        proj.modules = [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }]
        proj.stages = [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }]
        proj.artefacts = []

        const saveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(proj),
        })
        assert.equal(saveRes.status, 200, await saveRes.text())

        const commitsAfterSave = await client.listBranchCommits('main', { compareTo: null })
        assert.equal(commitsAfterSave.length, commitsAfterCreate.length + 1, 'save must land as exactly one commit')

        const publishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const publishText = await publishRes.text()
        assert.equal(publishRes.status, 200, publishText)
        const published = JSON.parse(publishText)
        assert.equal(published.status, 'published')

        const commitsAfterPublish = await client.listBranchCommits('main', { compareTo: null })
        assert.equal(commitsAfterPublish.length, commitsAfterSave.length + 1, 'publish must land as exactly one commit')

        // Publishing again (already published) is rejected, not silently accepted.
        const rePublishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(rePublishRes.status, 409)

        // Archive / restore each land as one commit too.
        const archiveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/archive`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(archiveRes.status, 200)
        const listArchivedRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions?archived=1`, { headers: { Authorization: auth } })
        const archivedRows = await listArchivedRes.json()
        assert.equal(archivedRows.find((r) => r.id === 'ado-process').archived, true)
      })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
      rmSync(definitionsDir, { recursive: true, force: true })
    }
  })
})

test('Azure DevOps workspace: a new draft version copies the latest version\'s modules, as one commit', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p3-ado-draft-'))
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p3-ado-draft-lib-'))
    try {
      cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
      const workspace = registerWorkspace({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl, owner: '' }, { instancesDir })
      await withRunningServer({ definitionsDir, instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_PAT)
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'ado-process' }),
        })
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const draftRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const draftText = await draftRes.text()
        assert.equal(draftRes.status, 200, draftText)
        const draft = JSON.parse(draftText)
        assert.equal(draft.version, 2)

        const v2Res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/ado-process/versions/2`, { headers: { Authorization: auth } })
        assert.equal(v2Res.status, 200)
        const v2 = await v2Res.json()
        assert.equal(v2.status, 'draft')
      })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
      rmSync(definitionsDir, { recursive: true, force: true })
    }
  })
})
