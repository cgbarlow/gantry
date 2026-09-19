import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { createGitLabClient } from '../lib/gitlabClient.js'

// #32 (ADR-0036, ADR-0037, ADR-0039, ADR-0041) — the GitLab twin of
// tests/serverDefinitionEditorGitHub.test.js's own "GitHub workspace: the commit path" and "no
// shadowing" coverage: a GitLab workspace's own `definitions/` folder works as a definition home at
// parity with Azure DevOps and GitHub — list, create-blank, new-draft-version, load, save and
// publish, each landing as exactly one commit straight to the fake GitLab server's `main` — and a
// duplicate definition id is refused wherever it collides, including across all three providers,
// never resolved by precedence.

const GITLAB_NAMESPACE = 'fake-group/fake-subgroup'
const GITLAB_REPOSITORY = 'fake-repo'
const VALID_GITLAB_PAT = 'valid-gitlab-test-pat'
const GITHUB_OWNER = 'fake-owner'
const GITHUB_REPOSITORY = 'fake-repo'
const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const AZURE_DEVOPS_REPOSITORY = 'fake-ado-repo'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

async function withScratchDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p32-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p32-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// ---------- GitLab workspace: the commit path ----------

test('GitLab workspace definitions: create, save and publish each land as exactly one commit straight to main', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )

      await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
        const auth = basicAuthHeader(VALID_GITLAB_PAT)

        // No credential at all -> 401, the same structured response every other provider-backed route uses.
        const noAuth = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newId: 'gl-process' }),
        })
        assert.equal(noAuth.status, 401)

        const createRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'gl-process', title: 'GL Process' }),
        })
        assert.equal(createRes.status, 201, await createRes.text())

        // Colliding with the library is refused 409, same "no shadowing" rule as the other providers.
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
        assert.equal(rows[0].id, 'gl-process')
        assert.deepEqual(rows[0].home, { kind: 'gitlab-workspace', id: workspace.id, name: GITLAB_REPOSITORY })

        const client = createGitLabClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: VALID_GITLAB_PAT, baseUrl })
        const definitionYamlAfterCreate = await client.getFileContent('definitions/gl-process/1/definition.yaml')
        assert.ok(definitionYamlAfterCreate)

        const getRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1`, { headers: { Authorization: auth } })
        assert.equal(getRes.status, 200)
        const proj = await getRes.json()
        proj.modules = [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }]
        proj.stages = [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }]
        proj.artefacts = []

        const saveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(proj),
        })
        assert.equal(saveRes.status, 200, await saveRes.text())

        const moduleYaml = await client.getFileContent('definitions/gl-process/1/modules/intro.yaml')
        assert.match(moduleYaml, /Introduction/)

        const publishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const publishText = await publishRes.text()
        assert.equal(publishRes.status, 200, publishText)
        const published = JSON.parse(publishText)
        assert.equal(published.status, 'published')

        // Publishing again (already published) is rejected, not silently accepted.
        const rePublishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(rePublishRes.status, 409)

        // Archive / restore.
        const archiveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/archive`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(archiveRes.status, 200)
        const listArchivedRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions?archived=1`, { headers: { Authorization: auth } })
        const archivedRows = await listArchivedRes.json()
        assert.equal(archivedRows.find((r) => r.id === 'gl-process').archived, true)

        const restoreRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/restore`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(restoreRes.status, 200)
      })
    })
  })
})

test('GitLab workspace: a new draft version copies the latest version\'s modules, as one commit', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
        const auth = basicAuthHeader(VALID_GITLAB_PAT)
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'gl-process' }),
        })
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const draftRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        const draftText = await draftRes.text()
        assert.equal(draftRes.status, 200, draftText)
        const draft = JSON.parse(draftText)
        assert.equal(draft.version, 2)

        const v2Res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/2`, { headers: { Authorization: auth } })
        assert.equal(v2Res.status, 200)
        const v2 = await v2Res.json()
        assert.equal(v2.status, 'draft')
      })
    })
  })
})

test('a GitLab workspace definition can be created, saved and published, and the published version loads with the exact structure it was saved with', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
        const auth = basicAuthHeader(VALID_GITLAB_PAT)
        await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'gl-process', title: 'GL Process' }),
        })
        const proj = await (
          await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1`, { headers: { Authorization: auth } })
        ).json()
        proj.modules = [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }]
        proj.stages = [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }]
        proj.artefacts = [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }]
        const saveRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(proj),
        })
        assert.equal(saveRes.status, 200, await saveRes.text())
        const publishRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1/publish`, {
          method: 'POST',
          headers: { Authorization: auth },
        })
        assert.equal(publishRes.status, 200, await publishRes.text())

        const reReadRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/gl-process/versions/1`, { headers: { Authorization: auth } })
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

test('creating a library definition with an id that already exists in a GitLab workspace is refused 409, no shadowing', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
        const auth = basicAuthHeader(VALID_GITLAB_PAT)

        const createGlRes = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ newId: 'shadow-process' }),
        })
        assert.equal(createGlRes.status, 201, await createGlRes.text())

        // The browser attaches the same PAT to every request (lib/credential.js), including this
        // plain library create — it must see the GitLab workspace's own id and refuse.
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
          body: JSON.stringify({ newId: 'no-pat-process-gl' }),
        })
        assert.equal(noAuthRes.status, 201, await noAuthRes.text())
      })
    })
  })
})

test('creating a definition in one GitLab workspace with an id that already exists in a different GitLab workspace is refused 409, no shadowing', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (baseUrlA) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'fake-repo-2', validPat: VALID_GITLAB_PAT }, async (baseUrlB) => {
      await withScratchDirs(async (definitionsDir, instancesDir) => {
        const workspaceA = registerWorkspace(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: baseUrlA }, owner: '' },
          { instancesDir }
        )
        const workspaceB = registerWorkspace(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'fake-repo-2', baseUrl: baseUrlB }, owner: '' },
          { instancesDir }
        )

        await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
          const auth = basicAuthHeader(VALID_GITLAB_PAT)

          const createA = await fetch(`${base}/api/workspaces/${workspaceA.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'multi-gl-process' }),
          })
          assert.equal(createA.status, 201, await createA.text())

          const createB = await fetch(`${base}/api/workspaces/${workspaceB.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'multi-gl-process' }),
          })
          assert.equal(createB.status, 409)
        })
      })
    })
  })
})

test('a duplicate definition id across a GitHub workspace and a GitLab workspace is refused 409, in either direction', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (githubBaseUrl) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (gitlabBaseUrl) => {
      await withScratchDirs(async (definitionsDir, instancesDir) => {
        const githubWorkspace = registerWorkspace(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: githubBaseUrl }, owner: '' },
          { instancesDir }
        )
        const gitlabWorkspace = registerWorkspace(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: gitlabBaseUrl }, owner: '' },
          { instancesDir }
        )

        // Both fakes are seeded to accept the same PAT string, since docs/adr/0038's single ambient
        // browser credential is attached to every request regardless of which provider it targets.
        await withRunningServer({ definitionsDir, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_GITLAB_PAT)

          const createGithub = await fetch(`${base}/api/workspaces/${githubWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'cross-provider-gh-gl' }),
          })
          assert.equal(createGithub.status, 201, await createGithub.text())

          // Same id, now attempted in the GitLab workspace: refused, no shadowing across providers.
          const createGitlab = await fetch(`${base}/api/workspaces/${gitlabWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'cross-provider-gh-gl' }),
          })
          assert.equal(createGitlab.status, 409)

          // And the reverse direction: an id already claimed in the GitLab workspace is refused when
          // creating in the GitHub workspace too.
          const createGitlabOther = await fetch(`${base}/api/workspaces/${gitlabWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'other-cross-provider-gh-gl' }),
          })
          assert.equal(createGitlabOther.status, 201, await createGitlabOther.text())

          const createGithubOther = await fetch(`${base}/api/workspaces/${githubWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'other-cross-provider-gh-gl' }),
          })
          assert.equal(createGithubOther.status, 409)
        })
      })
    })
  })
})

test('a duplicate definition id across an Azure DevOps workspace and a GitLab workspace is refused 409, in either direction', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: AZURE_DEVOPS_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (adoBaseUrl) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (gitlabBaseUrl) => {
      await withScratchDirs(async (definitionsDir, instancesDir) => {
        const adoWorkspace = registerWorkspace(
          { provider: 'azure-devops', location: { organization: ORGANIZATION, project: PROJECT, repository: AZURE_DEVOPS_REPOSITORY, baseUrl: adoBaseUrl }, owner: '' },
          { instancesDir }
        )
        const gitlabWorkspace = registerWorkspace(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: gitlabBaseUrl }, owner: '' },
          { instancesDir }
        )

        await withRunningServer({ definitionsDir, instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_GITLAB_PAT)

          const createAdo = await fetch(`${base}/api/workspaces/${adoWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'cross-provider-ado-gl' }),
          })
          assert.equal(createAdo.status, 201, await createAdo.text())

          // Same id, now attempted in the GitLab workspace: refused, no shadowing across providers.
          const createGitlab = await fetch(`${base}/api/workspaces/${gitlabWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'cross-provider-ado-gl' }),
          })
          assert.equal(createGitlab.status, 409)

          // And the reverse direction: an id already claimed in the GitLab workspace is refused when
          // creating in the Azure DevOps workspace too.
          const createGitlabOther = await fetch(`${base}/api/workspaces/${gitlabWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'other-cross-provider-ado-gl' }),
          })
          assert.equal(createGitlabOther.status, 201, await createGitlabOther.text())

          const createAdoOther = await fetch(`${base}/api/workspaces/${adoWorkspace.id}/definitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ newId: 'other-cross-provider-ado-gl' }),
          })
          assert.equal(createAdoOther.status, 409)
        })
      })
    })
  })
})

test('a validation-failing draft save on a GitLab workspace definition returns problems, not a commit', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: VALID_GITLAB_PAT }, async (baseUrl) => {
    await withScratchDirs(async (definitionsDir, instancesDir) => {
      const workspace = registerWorkspace(
        { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl }, owner: '' },
        { instancesDir }
      )
      await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
        const auth = basicAuthHeader(VALID_GITLAB_PAT)
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
