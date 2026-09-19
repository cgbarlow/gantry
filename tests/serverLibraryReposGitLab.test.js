import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { buildDefinitionYamlObject, buildModuleYamlObject } from '../lib/definition.js'

// #27 (ADR-0037, ADR-0038, ADR-0039, ADR-0041): library repos gain GitLab as a third provider — a
// GitLab repo can be registered as a library repo, its definitions read into the server library, the
// definition cache refreshes from it on the existing explicit Refresh action, and it resolves its own
// server-held credential (GANTRY_LIBRARY_PAT_GITLAB) independently of the other two providers.
// tests/serverLibraryReposGitHub.test.js already covers this same ground for GitHub; this is its
// GitLab twin, plus a three-provider coexistence case.

const VALID_GITLAB_PAT = 'gitlab-library-test-pat'
const GITLAB_NAMESPACE = 'engineering/platform'
const GITHUB_OWNER = 'fake-owner'
const VALID_GITHUB_PAT = 'github-library-test-pat'

// Builds the raw `{ path: content }` map a fake GitLab repo needs to seed one small, valid,
// published definition — the same minimal shape tests/serverLibraryReposGitHub.test.js's own
// `githubDefinitionFiles` produces (lib/definitionGitLab.js is read-only — there is no GitLab write
// path to drive here, unlike the Azure DevOps client).
function gitlabDefinitionFiles(id, { title } = {}) {
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
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p27-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p27-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('a GitLab repo can be registered as a library repo, with provider and nested location, and its definitions are unioned in read-only', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'gl-lib-union', validPat: VALID_GITLAB_PAT, files: gitlabDefinitionFiles('widget-process', { title: 'Widget Process' }) }, async (baseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: VALID_GITLAB_PAT }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'gl-lib-union', baseUrl } }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201, JSON.stringify(addBody))
        assert.equal(addBody.repo.provider, 'gitlab')
        assert.deepEqual(addBody.repo.location, { namespace: GITLAB_NAMESPACE, repository: 'gl-lib-union', baseUrl })
        assert.equal(addBody.refresh.ok, true, JSON.stringify(addBody.refresh))
        assert.equal(addBody.refresh.definitionCount, 1)

        const rows = await (await fetch(`${base}/api/definitions`)).json()
        const repoRow = rows.find((r) => r.id === 'widget-process')
        assert.ok(repoRow, 'GitLab library repo definition is in the unioned listing')
        assert.equal(repoRow.home.kind, 'library-repo')
        assert.equal(repoRow.readOnly, true)
        assert.equal(repoRow.title, 'Widget Process')

        const detail = await (await fetch(`${base}/api/definitions/widget-process/versions/1`)).json()
        assert.deepEqual(detail.stages.map((s) => s.id), ['shape'])
        assert.deepEqual(detail.modules.map((m) => m.id), ['intro'])

        // Read-only in the editor, exactly like an Azure DevOps or GitHub library repo.
        const publishRes = await fetch(`${base}/api/definitions/widget-process/versions/1/publish`, { method: 'POST' })
        assert.equal(publishRes.status, 403)
      })
    })
  })
})

test('GitHub and GitLab library repos coexist and refresh independently, each resolving its own credential', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'gh-coexist-repo', validPat: VALID_GITHUB_PAT, files: gitlabDefinitionFiles('gh-process', { title: 'GitHub Process' }) }, async (ghBaseUrl) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'gl-coexist-repo', validPat: VALID_GITLAB_PAT, files: gitlabDefinitionFiles('gl-process', { title: 'GitLab Process' }) }, async (glBaseUrl) => {
      await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
        await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: VALID_GITHUB_PAT, libraryPatGitlab: VALID_GITLAB_PAT }, async (base) => {
          const ghAdd = await (
            await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'gh-coexist-repo', baseUrl: ghBaseUrl } }),
            })
          ).json()
          assert.equal(ghAdd.refresh.ok, true, JSON.stringify(ghAdd.refresh))

          const glAdd = await (
            await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'gl-coexist-repo', baseUrl: glBaseUrl } }),
            })
          ).json()
          assert.equal(glAdd.refresh.ok, true, JSON.stringify(glAdd.refresh))

          const rows = await (await fetch(`${base}/api/definitions`)).json()
          assert.ok(rows.find((r) => r.id === 'gh-process' && r.home.kind === 'library-repo'))
          assert.ok(rows.find((r) => r.id === 'gl-process' && r.home.kind === 'library-repo'))

          // The Refresh route re-reads both, independently.
          const refreshBody = await (await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })).json()
          assert.equal(refreshBody.results.length, 2)
          assert.ok(refreshBody.results.every((r) => r.ok))
        })
      })
    })
  })
})

test('a missing GANTRY_LIBRARY_PAT_GITLAB credential reports the provider and the env var name, the same class of error as the other providers', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'gl-nopat-repo', validPat: VALID_GITLAB_PAT, files: gitlabDefinitionFiles('gl-process') }, async (glBaseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      // No libraryPatGitlab supplied at all — GitLab's own env var is simply unset in this test run.
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: null }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'gl-nopat-repo', baseUrl: glBaseUrl } }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201)
        assert.equal(addBody.refresh.ok, false)
        assert.match(addBody.refresh.error, /provider "gitlab"/)
        assert.match(addBody.refresh.error, /GANTRY_LIBRARY_PAT_GITLAB/)

        const rows = await (await fetch(`${base}/api/definitions`)).json()
        assert.equal(rows.some((r) => r.id === 'gl-process'), false)
      })
    })
  })
})

test('an invalid GitLab PAT is reported as a refresh failure, not a thrown/unhandled error', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'gl-badpat-repo', validPat: VALID_GITLAB_PAT, files: gitlabDefinitionFiles('gl-process') }, async (glBaseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: 'wrong-pat' }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'gl-badpat-repo', baseUrl: glBaseUrl } }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201)
        assert.equal(addBody.refresh.ok, false)
        assert.match(addBody.refresh.error, /rejected the supplied PAT/)
      })
    })
  })
})
