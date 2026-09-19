import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createBlankDefinition, writeDefinitionVersion, writeDefinitionTemplate, publishDefinitionVersion } from '../lib/definition.js'
import { serverWorkspaceDefinitionsDir } from '../lib/definitionHome.js'
import { addLibraryRepo } from '../lib/librarySettings.js'

// #20 (docs/adr/0037/0039, spec #1): Promote across providers — a definition authored in a
// server workspace can be promoted into a GitHub library repo as a Pull Request, exactly as it
// already can into an Azure DevOps one (tests/serverDefinitionPromote.test.js), and a single
// fan-out call can target repos on both providers at once, independently.

const GITHUB_OWNER = 'fake-owner'
const GITHUB_PAT = 'promote-github-test-pat'
const ADO_ORGANIZATION = 'fake-org'
const ADO_PROJECT = 'fake-project'
const ADO_PAT = 'promote-ado-test-pat'

function seedServerWorkspaceDefinition(instancesDir, workspaceId, id, { title } = {}) {
  mkdirSync(join(instancesDir, workspaceId), { recursive: true })
  writeWorkspaceJson(instancesDir, workspaceId, { name: workspaceId, kind: 'local', createdAt: new Date().toISOString() })
  const definitionsDir = serverWorkspaceDefinitionsDir(instancesDir, workspaceId)
  createBlankDefinition(id, { definitionsDir, title: title ?? id })
  const structure = {
    title: title ?? id,
    description: `${id} description`,
    modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
    stages: [{ id: 'kickoff', title: 'Kickoff', purpose: 'p', gate: 'kickoff-review', modules: ['intro'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'kickoff-review', requires: ['intro'] }],
  }
  const result = writeDefinitionVersion(id, 1, structure, { definitionsDir })
  assert.ok(!result.problems, `seed structure for "${id}" should be valid: ${JSON.stringify(result.problems)}`)
  writeDefinitionTemplate(id, 1, 'doc.md.tmpl', '# {{title}}', { definitionsDir })
  publishDefinitionVersion(id, 1, { definitionsDir })
  return definitionsDir
}

function withScratchDirs(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p20-lib-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p20-ws-'))
    try {
      await fn(definitionsDir, instancesDir)
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

// ---------- single-repo: GitHub ----------

test(
  'promoting a published server-workspace definition version into a GitHub library repo opens a branch, one commit and a Pull Request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-gh-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-gh-repo', baseUrl } }, { instancesDir })

        const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results.length, 1)
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))
        assert.equal(body.results[0].branch, 'definition/widget-process-v1')
        assert.equal(body.results[0].status, 'active')
        assert.equal(typeof body.results[0].pullRequestId, 'number')
        assert.match(body.results[0].pullRequestUrl, new RegExp(`/${GITHUB_OWNER}/promote-gh-repo/pull/\\d+$`))
        assert.equal(body.results[0].review.state, 'pending')

        // The branch carries the full version folder as one commit; main is untouched.
        const branchRes = await fetch(
          `${baseUrl}/repos/${GITHUB_OWNER}/promote-gh-repo/contents/definitions/widget-process/1/definition.yaml?ref=definition%2Fwidget-process-v1`,
          { headers: { Authorization: `Bearer ${GITHUB_PAT}` } }
        )
        assert.equal(branchRes.status, 200)

        const mainRes = await fetch(
          `${baseUrl}/repos/${GITHUB_OWNER}/promote-gh-repo/contents/definitions/widget-process/1/definition.yaml?ref=main`,
          { headers: { Authorization: `Bearer ${GITHUB_PAT}` } }
        )
        assert.equal(mainRes.status, 404, 'the promoted content never lands on main directly — only the PR branch')

        // Persisted: a page reload sees the same promotion without a fresh promote.
        const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(persisted.promotions.length, 1)
        assert.equal(persisted.promotions[0].repoId, added.id)
      })
    })
  })
)

test(
  'a configured code owner is resolved through GitHub identity and requested as a reviewer on the promotion Pull Request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer(
      { owner: GITHUB_OWNER, repository: 'promote-gh-owner-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' }, collaborators: [{ login: 'octocat', id: 42 }] },
      async (baseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

        await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
          const added = addLibraryRepo(
            { provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-gh-owner-repo', baseUrl }, codeOwner: 'octocat' },
            { instancesDir }
          )

          const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [added.id] }),
          })
          assert.equal(status, 200, JSON.stringify(body))
          assert.equal(body.results[0].reviewerResolved, true, JSON.stringify(body.results[0]))

          const prRes = await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/promote-gh-owner-repo/pulls/${body.results[0].pullRequestId}`, {
            headers: { Authorization: `Bearer ${GITHUB_PAT}` },
          })
          const pr = await prRes.json()
          assert.deepEqual(pr.requested_reviewers, [{ login: 'octocat' }])
        })
      }
    )
  })
)

test(
  'an unconfigurable code owner is reported by name — GitHub, not Azure DevOps — with no reviewer attached',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-gh-badowner-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo(
          { provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-gh-badowner-repo', baseUrl }, codeOwner: 'nobody-matches' },
          { instancesDir }
        )

        const { body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        assert.equal(body.results[0].reviewerResolved, false)
        assert.match(body.results[0].reviewerError, /GitHub identity/)
        assert.doesNotMatch(body.results[0].reviewerError, /Azure DevOps/)
      })
    })
  })
)

// ---------- cross-provider fan-out ----------

test(
  'a single promote call fanning out to an Azure DevOps repo and a GitHub repo succeeds independently on each',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer(
      { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-cross-ado', validPat: ADO_PAT, files: { 'README.md': '# repo' } },
      async (adoBaseUrl) => {
        await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-cross-gh', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (ghBaseUrl) => {
          seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

          await withRunningServer(
            { definitionsDir, instancesDir, libraryPat: ADO_PAT, libraryPatGithub: GITHUB_PAT, allowAzureDevOpsBaseUrlOverride: true, allowGitHubBaseUrlOverride: true },
            async (base) => {
              const adoRepo = addLibraryRepo({ location: { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-cross-ado', baseUrl: adoBaseUrl } }, { instancesDir })
              const ghRepo = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-cross-gh', baseUrl: ghBaseUrl } }, { instancesDir })

              const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoIds: [adoRepo.id, ghRepo.id] }),
              })
              assert.equal(status, 200, JSON.stringify(body))
              assert.equal(body.results.length, 2)
              const adoResult = body.results.find((r) => r.repoId === adoRepo.id)
              const ghResult = body.results.find((r) => r.repoId === ghRepo.id)
              assert.equal(adoResult.ok, true, JSON.stringify(adoResult))
              assert.equal(ghResult.ok, true, JSON.stringify(ghResult))
              assert.match(adoResult.pullRequestUrl, /_git\/promote-cross-ado\/pullrequest\/\d+$/)
              assert.match(ghResult.pullRequestUrl, new RegExp(`/${GITHUB_OWNER}/promote-cross-gh/pull/\\d+$`))

              const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
              assert.equal(persisted.promotions.length, 2)
            }
          )
        })
      }
    )
  })
)

test(
  'a promote call naming only a GitHub repo is never blocked by an unset Azure DevOps server PAT',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-gh-only-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      // No Azure DevOps PAT configured at all (libraryPat: null) — only GitHub's.
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: null, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-gh-only-repo', baseUrl } }, { instancesDir })

        const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))
      })
    })
  })
)

test(
  'in a mixed-provider fan-out, a repo whose own provider has no configured server PAT fails on its own without blocking the other repo',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer(
      { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-nopat-ado', validPat: ADO_PAT, files: { 'README.md': '# repo' } },
      async (adoBaseUrl) => {
        await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-nopat-gh', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (ghBaseUrl) => {
          seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

          // No GitHub PAT configured — the Azure DevOps repo should still succeed.
          await withRunningServer({ definitionsDir, instancesDir, libraryPat: ADO_PAT, allowAzureDevOpsBaseUrlOverride: true, allowGitHubBaseUrlOverride: true }, async (base) => {
            const adoRepo = addLibraryRepo({ location: { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-nopat-ado', baseUrl: adoBaseUrl } }, { instancesDir })
            const ghRepo = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-nopat-gh', baseUrl: ghBaseUrl } }, { instancesDir })

            const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoIds: [adoRepo.id, ghRepo.id] }),
            })
            assert.equal(status, 200, JSON.stringify(body))
            const adoResult = body.results.find((r) => r.repoId === adoRepo.id)
            const ghResult = body.results.find((r) => r.repoId === ghRepo.id)
            assert.equal(adoResult.ok, true, JSON.stringify(adoResult))
            assert.equal(ghResult.ok, false)
            assert.match(ghResult.error, /provider "github"/)
            assert.match(ghResult.error, /GANTRY_LIBRARY_PAT_GITHUB/)
          })
        })
      }
    )
  })
)

test(
  're-promoting the same version to the same GitHub repo while an earlier promotion branch is still open is refused, not silently overwritten',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-gh-repeat-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-gh-repeat-repo', baseUrl } }, { instancesDir })
        const promoteOnce = () =>
          fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [added.id] }),
          })

        const first = await promoteOnce()
        assert.equal(first.body.results[0].ok, true, JSON.stringify(first.body.results[0]))

        const second = await promoteOnce()
        assert.equal(second.status, 200)
        assert.equal(second.body.results[0].ok, false)
        assert.match(second.body.results[0].error, /already exists/)
      })
    })
  })
)

// ---------- the stateless local-workspace endpoint ----------

test(
  'POST /api/local/definitions/promote fans a client-supplied file set out to a GitHub repo, and persists nothing server-side',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-local-gh-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-local-gh-repo', baseUrl } }, { instancesDir })

        const files = [
          { path: 'definition.yaml', content: 'id: local-widget\nversion: 1\nstatus: published\ntitle: Local Widget\n', contentType: 'rawtext' },
          { path: 'CHANGELOG.md', content: '## v1\n\nPublished.\n', contentType: 'rawtext' },
        ]
        const { status, body } = await fetchJson(`${base}/api/local/definitions/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'local-widget', version: 1, files, repoIds: [added.id] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))

        const itemRes = await fetch(
          `${baseUrl}/repos/${GITHUB_OWNER}/promote-local-gh-repo/contents/definitions/local-widget/1/definition.yaml?ref=definition%2Flocal-widget-v1`,
          { headers: { Authorization: `Bearer ${GITHUB_PAT}` } }
        )
        assert.equal(itemRes.status, 200)
      })
    })
  })
)

// ---------- explicit Check, not polled ----------

test(
  "the explicit Check action re-reads a GitHub promotion Pull Request's status and review state, and never merges it",
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-gh-check-repo', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, allowGitHubBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-gh-check-repo', baseUrl } }, { instancesDir })
        const { body: promoteBody } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        const pullRequestId = promoteBody.results[0].pullRequestId
        assert.equal(promoteBody.results[0].review.state, 'pending')

        // Simulate the code owner approving directly on GitHub — this server never polls for it.
        await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/promote-gh-check-repo/pulls/${pullRequestId}/reviews`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${GITHUB_PAT}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'APPROVE' }),
        })

        // Before Check: the persisted record still shows the stale, pre-review status.
        const { body: beforeCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(beforeCheck.promotions[0].review.state, 'pending')

        const { status, body: afterCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions/check`, { method: 'POST' })
        assert.equal(status, 200)
        assert.equal(afterCheck.promotions[0].review.state, 'approved')
        // Never merged — an approved review changes only the recorded review state, never the PR's own status.
        assert.equal(afterCheck.promotions[0].status, 'active')

        const prRes = await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/promote-gh-check-repo/pulls/${pullRequestId}`, {
          headers: { Authorization: `Bearer ${GITHUB_PAT}` },
        })
        assert.equal((await prRes.json()).state, 'open')
      })
    })
  })
)
