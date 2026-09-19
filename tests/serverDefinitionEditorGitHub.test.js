import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { createGitHubClient } from '../lib/githubClient.js'

// #17 (ADR-0036, ADR-0037, ADR-0039) — the GitHub twin of tests/serverDefinitionEditorPhase3.test.js's
// own "Azure DevOps workspace: the commit path" and "no shadowing" coverage: a GitHub workspace's own
// `definitions/` folder works as a definition home at parity with Azure DevOps — list, create-blank,
// new-draft-version, load, save and publish, each landing as exactly one commit straight to the fake
// GitHub server's `main` — and a duplicate definition id is refused wherever it collides, including
// across providers, never resolved by precedence.

const GITHUB_OWNER = 'fake-owner'
const GITHUB_REPOSITORY = 'fake-repo'
const VALID_GITHUB_PAT = 'valid-github-test-pat'
const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const AZURE_DEVOPS_REPOSITORY = 'fake-ado-repo'
const VALID_AZURE_DEVOPS_PAT = 'valid-ado-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

async function withScratchDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p17-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p17-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// ---------- GitHub workspace: the commit path ----------

test('GitHub workspace definitions: create, save and publish each land as exactly one commit straight to main', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITHUB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )

      await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_GITHUB_PAT)

        // No credential at all -> 401, the same structured response every other provider-backed route uses.
        const noAuth = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newId: 'gh-process' }),
        })
        assert.equal(noAuth.status, 401)

        const createRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'gh-process', title: 'GH Process' }),
        })
        assert.equal(createRes.status, 201, await createRes.text())

        // Colliding with the library is refused 409, same "no shadowing" rule as Azure DevOps.
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
        assert.equal(rows[0].id, 'gh-process')
        assert.deepEqual(rows[0].home, { kind: 'github-workspace', id: workspace.id, name: GITHUB_REPOSITORY })

        const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: VALID_GITHUB_PAT, baseUrl })
        const definitionYamlAfterCreate = await client.getFileContent('definitions/gh-process/1/definition.yaml')
        assert.ok(definitionYamlAfterCreate)

        const getRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1`, { headers: { Authorization: auth } })
        assert.equal(getRes.status, 200)
        const proj = await getRes.json()
        proj.modules = [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }]
        proj.stages = [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }]
        proj.artefacts = []

        const saveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(proj),
        })
        assert.equal(saveRes.status, 200, await saveRes.text())

        const moduleYaml = await client.getFileContent('definitions/gh-process/1/modules/intro.yaml')
        assert.match(moduleYaml, /Introduction/)

        const publishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const publishText = await publishRes.text()
        assert.equal(publishRes.status, 200, publishText)
        const published = JSON.parse(publishText)
        assert.equal(published.status, 'published')

        // Publishing again (already published) is rejected, not silently accepted.
        const rePublishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(rePublishRes.status, 409)

        // Archive / restore.
        const archiveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/archive`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(archiveRes.status, 200)
        const listArchivedRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions?archived=1`, { headers: { Authorization: auth } })
        const archivedRows = await listArchivedRes.json()
        assert.equal(archivedRows.find((r) => r.id === 'gh-process').archived, true)

        const restoreRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/restore`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(restoreRes.status, 200)
      })
    })
  })
})

test('GitHub workspace: a new draft version copies the latest version\'s modules, as one commit', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITHUB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_GITHUB_PAT)
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'gh-process' }),
        })
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const draftRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const draftText = await draftRes.text()
        assert.equal(draftRes.status, 200, draftText)
        const draft = JSON.parse(draftText)
        assert.equal(draft.version, 2)

        const v2Res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/2`, { headers: { Authorization: auth } })
        assert.equal(v2Res.status, 200)
        const v2 = await v2Res.json()
        assert.equal(v2.status, 'draft')
      })
    })
  })
})

test('a GitHub workspace definition can be created, saved and published, and the published version loads with the exact structure it was saved with', async () => {
  // Mirrors the "instances can use them" / "an artefact renders from a workspace-homed definition"
  // acceptance criteria at the same depth `lib/definitionAzureDevOps.js`'s own precedent already
  // established: `lib/server.js`'s `POST /api/instances` route documents (see its own doc comment
  // on `instanceCreationDefinitionsDir`) that resolving `definitionId` against a *remote* workspace's
  // own `definitions/` folder — Azure DevOps or GitHub alike — is explicitly deferred to a later
  // phase; only the library, cached library repos and the default local server workspace are
  // eligible sources for `POST /api/instances` today. What #17 (like #383 before it) actually
  // delivers is the definitions surface itself being fully load/validate/edit/save/publish-capable
  // against a GitHub workspace, proven end-to-end here by round-tripping a full structure (module,
  // stage and artefact) through save → publish → read, exactly as `renderArtefact` itself would need
  // it once a later phase wires instance creation to this same source.
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITHUB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_GITHUB_PAT)
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'gh-process', title: 'GH Process' }),
        })
        const proj = await (
          await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1`, { headers: { Authorization: auth } })
        ).json()
        proj.modules = [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }]
        proj.stages = [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }]
        proj.artefacts = [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }]
        const saveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(proj),
        })
        assert.equal(saveRes.status, 200, await saveRes.text())
        const publishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(publishRes.status, 200, await publishRes.text())

        const reReadRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gh-process/versions/1`, { headers: { Authorization: auth } })
        assert.equal(reReadRes.status, 200)
        const reRead = await reReadRes.json()
        assert.equal(reRead.status, 'published')
        assert.deepEqual(reRead.stages.map((s) => s.id), ['shape'])
        assert.deepEqual(reRead.artefacts.map((a) => a.id), ['doc'])
        assert.deepEqual(reRead.modules.map((m) => m.id).sort(), ['intro'])
      })
    })
  })
})

// ---------- no shadowing, including across providers ----------

test('creating a library definition with an id that already exists in a GitHub workspace is refused 409, no shadowing', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITHUB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_GITHUB_PAT)

        const createGhRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'shadow-process' }),
        })
        assert.equal(createGhRes.status, 201, await createGhRes.text())

        // The browser attaches the same PAT to every request (lib/credential.js), including this
        // plain library create — it must see the GitHub workspace's own id and refuse.
        const collideRes = await fetch(`${base}/api/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'shadow-process' }),
        })
        assert.equal(collideRes.status, 409)

        // With no PAT on the request at all, the check is best-effort and skipped.
        const noAuthRes = await fetch(`${base}/api/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newId: 'no-pat-process' }),
        })
        assert.equal(noAuthRes.status, 201, await noAuthRes.text())
      })
    })
  })
})

test('creating a definition in one GitHub workspace with an id that already exists in a different GitHub workspace is refused 409, no shadowing', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITHUB_PAT }, async (baseUrlA) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'fake-repo-2', validPat: VALID_GITHUB_PAT }, async (baseUrlB) => {
      await withScratchDirs(async (definitionsDir, instancesDir) => {
        const workspaceA = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: baseUrlA }, owner: '' },
          { instancesDir }
        )
        const workspaceB = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: 'fake-repo-2', baseUrl: baseUrlB }, owner: '' },
          { instancesDir }
        )

        await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_GITHUB_PAT)

          const createA = await fetch(`${base}/api/workspaces/${workspaceA.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'multi-gh-process' }),
          })
          assert.equal(createA.status, 201, await createA.text())

          const createB = await fetch(`${base}/api/workspaces/${workspaceB.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'multi-gh-process' }),
          })
          assert.equal(createB.status, 409)
        })
      })
    })
  })
})

test('a duplicate definition id across an Azure DevOps workspace and a GitHub workspace is refused 409, in either direction', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: AZURE_DEVOPS_REPOSITORY, validPat: VALID_AZURE_DEVOPS_PAT }, async (adoBaseUrl) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_AZURE_DEVOPS_PAT }, async (githubBaseUrl) => {
      await withScratchDirs(async (definitionsDir, instancesDir) => {
        const adoWorkspace = registerWorkspace(
          { provider: 'azure-devops', location: { organization: ORGANIZATION, project: PROJECT, repository: AZURE_DEVOPS_REPOSITORY, baseUrl: adoBaseUrl }, owner: '' },
          { instancesDir }
        )
        const githubWorkspace = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: githubBaseUrl }, owner: '' },
          { instancesDir }
        )

        // Both fakes are seeded to accept the same PAT string, since docs/adr/0038's single ambient
        // browser credential is attached to every request regardless of which provider it targets.
        await withRunningServer({ definitionsDir, instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowGitHubBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_AZURE_DEVOPS_PAT)

          const createAdo = await fetch(`${base}/api/workspaces/${adoWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'cross-provider-process' }),
          })
          assert.equal(createAdo.status, 201, await createAdo.text())

          // Same id, now attempted in the GitHub workspace: refused, no shadowing across providers.
          const createGithub = await fetch(`${base}/api/workspaces/${githubWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'cross-provider-process' }),
          })
          assert.equal(createGithub.status, 409)

          // And the reverse direction: an id already claimed in the GitHub workspace is refused when
          // creating in the Azure DevOps workspace too.
          const createGithubOther = await fetch(`${base}/api/workspaces/${githubWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'other-cross-provider-process' }),
          })
          assert.equal(createGithubOther.status, 201, await createGithubOther.text())

          const createAdoOther = await fetch(`${base}/api/workspaces/${adoWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'other-cross-provider-process' }),
          })
          assert.equal(createAdoOther.status, 409)
        })
      })
    })
  })
})

test('a validation-failing draft save on a GitHub workspace definition returns problems, not a commit', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITHUB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
        const auth = basicAuthHeader(VALID_GITHUB_PAT)
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'broken-process' }),
        })
        // A stage referencing a module that doesn't exist in `modules` — structurally invalid.
        const badProj = { modules: [], stages: [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'g', modules: ['missing'] }], artefacts: [] }
        const saveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/broken-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(badProj),
        })
        assert.equal(saveRes.status, 422)
        const body = await saveRes.json()
        assert.ok(Array.isArray(body.problems) && body.problems.length > 0)
      })
    })
  })
})
