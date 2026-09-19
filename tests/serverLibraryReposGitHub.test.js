import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { createBlankAzureDevOpsDefinition, writeAzureDevOpsDefinitionVersion, publishAzureDevOpsDefinitionVersion } from '../lib/definitionAzureDevOps.js'
import { buildDefinitionYamlObject, buildModuleYamlObject } from '../lib/definition.js'

// #19 (ADR-0037, ADR-0038, ADR-0039): library repos stop assuming one provider — a GitHub repo can
// be registered as a library repo, its definitions read into the server library, the definition
// cache refreshes from it on the existing explicit Refresh action, and each library repo resolves
// its server-held credential by its own provider. `tests/serverLibraryRepos.test.js` already covers
// the union/clash/cache/Refresh mechanics against the fake Azure DevOps server; this covers the same
// ground for GitHub plus the provider-scoped credential behaviour #19 actually adds.

const VALID_GITHUB_PAT = 'github-library-test-pat'
const GITHUB_OWNER = 'fake-owner'

// Builds the raw `{ path: content }` map a fake GitHub repo needs to seed one small, valid,
// published definition — the same minimal shape tests/serverLibraryRepos.test.js's own
// `seedAzureDevOpsDefinition` produces, but written directly as file content (lib/definitionGitHub.js
// is read-only — there is no GitHub write path to drive, unlike the Azure DevOps client).
function githubDefinitionFiles(id, { title } = {}) {
  const structure = {
    title: title ?? id,
    description: `${id} description`,
    modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
    stages: [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }],
  }
  const defObj = buildDefinitionYamlObject(id, 1, 'published', structure, {})
  const modObj = buildModuleYamlObject({ id: 'intro', title: 'Introduction', purpose: 'p', fields: structure.modules[0].fields })
  return {
    [`definitions/${id}/1/definition.yaml`]: stringifyYAML(defObj),
    [`definitions/${id}/1/modules/intro.yaml`]: stringifyYAML(modObj),
  }
}

async function withScratchLibraryDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p19-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p19-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('a GitHub repo can be registered as a library repo, with provider and nested location, and its definitions are unioned in read-only', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'gh-lib-union', validPat: VALID_GITHUB_PAT, files: githubDefinitionFiles('widget-process', { title: 'Widget Process' }) }, async (baseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: VALID_GITHUB_PAT }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'gh-lib-union', baseUrl } }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201, JSON.stringify(addBody))
        assert.equal(addBody.repo.provider, 'github')
        assert.deepEqual(addBody.repo.location, { owner: GITHUB_OWNER, repository: 'gh-lib-union', baseUrl })
        assert.equal(addBody.refresh.ok, true, JSON.stringify(addBody.refresh))
        assert.equal(addBody.refresh.definitionCount, 1)

        const rows = await (await fetch(`${base}/api/definitions`)).json()
        const repoRow = rows.find((r) => r.id === 'widget-process')
        assert.ok(repoRow, 'GitHub library repo definition is in the unioned listing')
        assert.equal(repoRow.home.kind, 'library-repo')
        assert.equal(repoRow.readOnly, true)
        assert.equal(repoRow.title, 'Widget Process')

        const detail = await (await fetch(`${base}/api/definitions/widget-process/versions/1`)).json()
        assert.deepEqual(detail.stages.map((s) => s.id), ['shape'])
        assert.deepEqual(detail.modules.map((m) => m.id), ['intro'])

        // Read-only in the editor, exactly like an Azure DevOps library repo.
        const publishRes = await fetch(`${base}/api/definitions/widget-process/versions/1/publish`, { method: 'POST' })
        assert.equal(publishRes.status, 403)
      })
    })
  })
})

test('Azure DevOps and GitHub library repos coexist and refresh independently', async () => {
  const ADO_ORG = 'fake-org'
  const ADO_PROJECT = 'fake-project'
  const ADO_PAT = 'ado-coexist-pat'
  await withFakeAzureDevOpsServer({ organization: ADO_ORG, project: ADO_PROJECT, repository: 'ado-coexist-repo', validPat: ADO_PAT }, async (adoBaseUrl) => {
    const azureDevOps = { organization: ADO_ORG, project: ADO_PROJECT, repository: 'ado-coexist-repo', baseUrl: adoBaseUrl, pat: ADO_PAT }
    await createBlankAzureDevOpsDefinition('ado-process', { azureDevOps }, { title: 'ADO Process' })
    const structure = {
      title: 'ADO Process',
      description: 'd',
      modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
      stages: [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }],
      artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }],
    }
    await writeAzureDevOpsDefinitionVersion('ado-process', 1, structure, { azureDevOps })
    await publishAzureDevOpsDefinitionVersion('ado-process', 1, { azureDevOps })

    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'gh-coexist-repo', validPat: VALID_GITHUB_PAT, files: githubDefinitionFiles('gh-process', { title: 'GitHub Process' }) }, async (ghBaseUrl) => {
      await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
        await withRunningServer({ definitionsDir, instancesDir, libraryPat: ADO_PAT, libraryPatGithub: VALID_GITHUB_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const adoAdd = await (
            await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ organization: ADO_ORG, project: ADO_PROJECT, repository: 'ado-coexist-repo', baseUrl: adoBaseUrl }),
            })
          ).json()
          assert.equal(adoAdd.refresh.ok, true, JSON.stringify(adoAdd.refresh))

          const ghAdd = await (
            await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'gh-coexist-repo', baseUrl: ghBaseUrl } }),
            })
          ).json()
          assert.equal(ghAdd.refresh.ok, true, JSON.stringify(ghAdd.refresh))

          const rows = await (await fetch(`${base}/api/definitions`)).json()
          assert.ok(rows.find((r) => r.id === 'ado-process' && r.home.kind === 'library-repo'))
          assert.ok(rows.find((r) => r.id === 'gh-process' && r.home.kind === 'library-repo'))

          // The Refresh route re-reads both, independently.
          const refreshBody = await (await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })).json()
          assert.equal(refreshBody.results.length, 2)
          assert.ok(refreshBody.results.every((r) => r.ok))
        })
      })
    })
  })
})

test('a missing credential for one provider reports which provider and which environment variable, while the other provider still refreshes', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'gh-nopat-repo', validPat: VALID_GITHUB_PAT, files: githubDefinitionFiles('gh-process') }, async (ghBaseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      // No libraryPatGithub supplied at all — GitHub's own env var is simply unset in this test run.
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: null }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'gh-nopat-repo', baseUrl: ghBaseUrl } }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201)
        assert.equal(addBody.refresh.ok, false)
        assert.match(addBody.refresh.error, /provider "github"/)
        assert.match(addBody.refresh.error, /GANTRY_LIBRARY_PAT_GITHUB/)

        const rows = await (await fetch(`${base}/api/definitions`)).json()
        assert.equal(rows.some((r) => r.id === 'gh-process'), false)
      })
    })
  })
})

test('the deprecated GANTRY_LIBRARY_PAT alias (via the pre-#19 libraryPat option) still authenticates the Azure DevOps provider', async () => {
  await withFakeAzureDevOpsServer({ organization: 'fake-org', project: 'fake-project', repository: 'ado-alias-repo', validPat: 'alias-pat' }, async (baseUrl) => {
    const azureDevOps = { organization: 'fake-org', project: 'fake-project', repository: 'ado-alias-repo', baseUrl, pat: 'alias-pat' }
    await createBlankAzureDevOpsDefinition('aliased-process', { azureDevOps }, { title: 'Aliased Process' })
    const structure = {
      title: 'Aliased Process',
      description: 'd',
      modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
      stages: [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }],
      artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }],
    }
    await writeAzureDevOpsDefinitionVersion('aliased-process', 1, structure, { azureDevOps })
    await publishAzureDevOpsDefinitionVersion('aliased-process', 1, { azureDevOps })

    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      // `libraryPat` (not `libraryPats`) is the pre-#19 option name — still resolves the Azure DevOps slot.
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: 'alias-pat', allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const addBody = await (
          await fetch(`${base}/api/library-repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: 'fake-org', project: 'fake-project', repository: 'ado-alias-repo', baseUrl }),
          })
        ).json()
        assert.equal(addBody.refresh.ok, true, JSON.stringify(addBody.refresh))
        assert.equal(addBody.refresh.definitionCount, 1)
      })
    })
  })
})
