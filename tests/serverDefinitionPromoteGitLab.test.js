import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createBlankDefinition, writeDefinitionVersion, writeDefinitionTemplate, publishDefinitionVersion } from '../lib/definition.js'
import { serverWorkspaceDefinitionsDir } from '../lib/definitionHome.js'
import { addLibraryRepo } from '../lib/librarySettings.js'

// #36 (docs/adr/0037/0039/0041, spec #23): Promote across providers, GitLab's own twin of #20 — a
// definition authored in a server workspace can be promoted into a GitLab library repo as a Merge
// Request, exactly as it already can into an Azure DevOps or GitHub one
// (tests/serverDefinitionPromote.test.js, tests/serverDefinitionPromoteGitHub.test.js), and a single
// fan-out call can target repos on any mix of the three providers at once, independently.

const GITLAB_NAMESPACE = 'fake-group/fake-subgroup'
const GITLAB_PAT = 'promote-gitlab-test-pat'
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
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p36-lib-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p36-ws-'))
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

// ---------- single-repo: GitLab ----------

test(
  'promoting a published server-workspace definition version into a GitLab library repo opens a branch, one commit and a Merge Request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-gl-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-repo', baseUrl } }, { instancesDir })

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
        assert.match(body.results[0].pullRequestUrl, new RegExp(`/${GITLAB_NAMESPACE}/promote-gl-repo/-/merge_requests/\\d+$`))
        assert.equal(body.results[0].review.state, 'pending')

        // The branch carries the full version folder as one commit; main is untouched.
        const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/promote-gl-repo`)
        const branchRes = await fetch(
          `${baseUrl}/projects/${projectId}/repository/files/${encodeURIComponent('definitions/widget-process/1/definition.yaml')}?ref=definition%2Fwidget-process-v1`,
          { headers: { 'PRIVATE-TOKEN': GITLAB_PAT } }
        )
        assert.equal(branchRes.status, 200)

        const mainRes = await fetch(
          `${baseUrl}/projects/${projectId}/repository/files/${encodeURIComponent('definitions/widget-process/1/definition.yaml')}?ref=main`,
          { headers: { 'PRIVATE-TOKEN': GITLAB_PAT } }
        )
        assert.equal(mainRes.status, 404, 'the promoted content never lands on main directly — only the MR branch')

        // Persisted: a page reload sees the same promotion without a fresh promote.
        const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(persisted.promotions.length, 1)
        assert.equal(persisted.promotions[0].repoId, added.id)
      })
    })
  })
)

test(
  'a configured code owner is resolved through GitLab identity and requested as a reviewer on the promotion Merge Request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer(
      {
        namespace: GITLAB_NAMESPACE,
        repository: 'promote-gl-owner-repo',
        validPat: GITLAB_PAT,
        files: { 'README.md': '# repo' },
        members: [{ id: 42, username: 'octocat', name: 'Octo Cat', access_level: 30 }],
      },
      async (baseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

        await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
          const added = addLibraryRepo(
            { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-owner-repo', baseUrl }, codeOwner: 'octocat' },
            { instancesDir }
          )

          const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [added.id] }),
          })
          assert.equal(status, 200, JSON.stringify(body))
          assert.equal(body.results[0].reviewerResolved, true, JSON.stringify(body.results[0]))

          const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/promote-gl-owner-repo`)
          const mrRes = await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${body.results[0].pullRequestId}`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_PAT },
          })
          const mr = await mrRes.json()
          assert.deepEqual(mr.reviewer_ids, [42])
        })
      }
    )
  })
)

test(
  'an unconfigurable code owner is reported by name — GitLab, not Azure DevOps — with no reviewer attached',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-gl-badowner-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo(
          { provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-badowner-repo', baseUrl }, codeOwner: 'nobody-matches' },
          { instancesDir }
        )

        const { body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        assert.equal(body.results[0].reviewerResolved, false)
        assert.match(body.results[0].reviewerError, /GitLab identity/)
        assert.doesNotMatch(body.results[0].reviewerError, /Azure DevOps/)
      })
    })
  })
)

// ---------- cross-provider fan-out ----------

test(
  'a single promote call fanning out to an Azure DevOps repo and a GitLab repo succeeds independently on each',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer(
      { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-cross-ado2', validPat: ADO_PAT, files: { 'README.md': '# repo' } },
      async (adoBaseUrl) => {
        await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-cross-gl', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (glBaseUrl) => {
          seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

          await withRunningServer(
            { definitionsDir, instancesDir, libraryPat: ADO_PAT, libraryPatGitlab: GITLAB_PAT, allowAzureDevOpsBaseUrlOverride: true, allowGitLabBaseUrlOverride: true },
            async (base) => {
              const adoRepo = addLibraryRepo({ location: { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-cross-ado2', baseUrl: adoBaseUrl } }, { instancesDir })
              const glRepo = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-cross-gl', baseUrl: glBaseUrl } }, { instancesDir })

              const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoIds: [adoRepo.id, glRepo.id] }),
              })
              assert.equal(status, 200, JSON.stringify(body))
              assert.equal(body.results.length, 2)
              const adoResult = body.results.find((r) => r.repoId === adoRepo.id)
              const glResult = body.results.find((r) => r.repoId === glRepo.id)
              assert.equal(adoResult.ok, true, JSON.stringify(adoResult))
              assert.equal(glResult.ok, true, JSON.stringify(glResult))
              assert.match(adoResult.pullRequestUrl, /_git\/promote-cross-ado2\/pullrequest\/\d+$/)
              assert.match(glResult.pullRequestUrl, new RegExp(`/${GITLAB_NAMESPACE}/promote-cross-gl/-/merge_requests/\\d+$`))

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
  'a promote call fanning out to a GitHub repo and a GitLab repo — from a non-GitLab, non-GitHub server workspace — succeeds independently on each',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'promote-cross-gh2', validPat: GITHUB_PAT, files: { 'README.md': '# repo' } }, async (ghBaseUrl) => {
      await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-cross-gl2', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (glBaseUrl) => {
        // The source workspace is a plain server (local) workspace, not tied to either provider —
        // Promote already treats the library repo's own provider as the one that matters, independent
        // of the source workspace's provider (#36's own acceptance criteria).
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

        await withRunningServer(
          { definitionsDir, instancesDir, libraryPatGithub: GITHUB_PAT, libraryPatGitlab: GITLAB_PAT, allowGitHubBaseUrlOverride: true, allowGitLabBaseUrlOverride: true },
          async (base) => {
            const ghRepo = addLibraryRepo({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'promote-cross-gh2', baseUrl: ghBaseUrl } }, { instancesDir })
            const glRepo = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-cross-gl2', baseUrl: glBaseUrl } }, { instancesDir })

            const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoIds: [ghRepo.id, glRepo.id] }),
            })
            assert.equal(status, 200, JSON.stringify(body))
            const ghResult = body.results.find((r) => r.repoId === ghRepo.id)
            const glResult = body.results.find((r) => r.repoId === glRepo.id)
            assert.equal(ghResult.ok, true, JSON.stringify(ghResult))
            assert.equal(glResult.ok, true, JSON.stringify(glResult))
          }
        )
      })
    })
  })
)

test(
  'a promote call naming only a GitLab repo is never blocked by an unset Azure DevOps server PAT',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-gl-only-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      // No Azure DevOps PAT configured at all (libraryPat: null) — only GitLab's.
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: null, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-only-repo', baseUrl } }, { instancesDir })

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
  'in a mixed-provider fan-out, a GitLab repo whose provider has no configured server PAT fails on its own without blocking the other repo',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer(
      { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-nopat-ado2', validPat: ADO_PAT, files: { 'README.md': '# repo' } },
      async (adoBaseUrl) => {
        await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-nopat-gl', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (glBaseUrl) => {
          seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

          // No GitLab PAT configured — the Azure DevOps repo should still succeed.
          await withRunningServer({ definitionsDir, instancesDir, libraryPat: ADO_PAT, allowAzureDevOpsBaseUrlOverride: true, allowGitLabBaseUrlOverride: true }, async (base) => {
            const adoRepo = addLibraryRepo({ location: { organization: ADO_ORGANIZATION, project: ADO_PROJECT, repository: 'promote-nopat-ado2', baseUrl: adoBaseUrl } }, { instancesDir })
            const glRepo = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-nopat-gl', baseUrl: glBaseUrl } }, { instancesDir })

            const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoIds: [adoRepo.id, glRepo.id] }),
            })
            assert.equal(status, 200, JSON.stringify(body))
            const adoResult = body.results.find((r) => r.repoId === adoRepo.id)
            const glResult = body.results.find((r) => r.repoId === glRepo.id)
            assert.equal(adoResult.ok, true, JSON.stringify(adoResult))
            assert.equal(glResult.ok, false)
            assert.match(glResult.error, /provider "gitlab"/)
            assert.match(glResult.error, /GANTRY_LIBRARY_PAT_GITLAB/)
          })
        })
      }
    )
  })
)

test(
  're-promoting the same version to the same GitLab repo while an earlier promotion branch is still open is refused, not silently overwritten',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-gl-repeat-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-repeat-repo', baseUrl } }, { instancesDir })
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
  'POST /api/local/definitions/promote fans a client-supplied file set out to a GitLab repo, and persists nothing server-side',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-local-gl-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-local-gl-repo', baseUrl } }, { instancesDir })

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

        const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/promote-local-gl-repo`)
        const itemRes = await fetch(
          `${baseUrl}/projects/${projectId}/repository/files/${encodeURIComponent('definitions/local-widget/1/definition.yaml')}?ref=definition%2Flocal-widget-v1`,
          { headers: { 'PRIVATE-TOKEN': GITLAB_PAT } }
        )
        assert.equal(itemRes.status, 200)
      })
    })
  })
)

// ---------- explicit Check, not polled ----------

test(
  "the explicit Check action re-reads a GitLab promotion Merge Request's status and review state, and never merges it",
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-gl-check-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-check-repo', baseUrl } }, { instancesDir })
        const { body: promoteBody } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        const pullRequestId = promoteBody.results[0].pullRequestId
        assert.equal(promoteBody.results[0].review.state, 'pending')

        // Simulate the code owner approving directly on GitLab — this server never polls for it.
        const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/promote-gl-check-repo`)
        await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${pullRequestId}/approve`, {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': GITLAB_PAT },
        })

        // Before Check: the persisted record still shows the stale, pre-review status.
        const { body: beforeCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(beforeCheck.promotions[0].review.state, 'pending')

        const { status, body: afterCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions/check`, { method: 'POST' })
        assert.equal(status, 200)
        assert.equal(afterCheck.promotions[0].review.state, 'approved')
        // Never merged — an approved review changes only the recorded review state, never the MR's own status.
        assert.equal(afterCheck.promotions[0].status, 'active')

        const mrRes = await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${pullRequestId}`, {
          headers: { 'PRIVATE-TOKEN': GITLAB_PAT },
        })
        assert.equal((await mrRes.json()).state, 'opened')
      })
    })
  })
)

test(
  'a not-approved Merge Request with an unresolved discussion thread reads as changes-requested, per ADR-0041',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-gl-thread-repo', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-gl-thread-repo', baseUrl } }, { instancesDir })
        const { body: promoteBody } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        const pullRequestId = promoteBody.results[0].pullRequestId

        // A reviewer leaves feedback without approving — an unresolved discussion thread.
        const projectId = encodeURIComponent(`${GITLAB_NAMESPACE}/promote-gl-thread-repo`)
        await fetch(`${baseUrl}/projects/${projectId}/merge_requests/${pullRequestId}/discussions`, {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': GITLAB_PAT, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'Please fix the title.' }),
        })

        const { body: afterCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions/check`, { method: 'POST' })
        assert.equal(afterCheck.promotions[0].review.state, 'changes-requested')
      })
    })
  })
)
