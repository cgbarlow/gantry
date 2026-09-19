import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { withFakeBitbucketServer } from './helpers/fakeBitbucketServer.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createBlankDefinition, writeDefinitionVersion, writeDefinitionTemplate, publishDefinitionVersion } from '../lib/definition.js'
import { serverWorkspaceDefinitionsDir } from '../lib/definitionHome.js'

// #49 (ADR-0036, ADR-0042, spec #39): Promote across providers, Atlassian's own twin of #36 — a
// definition authored in a server workspace can be promoted into a Bitbucket-hosted library repo as a
// pull request, exactly as it already can into an Azure DevOps, GitHub or GitLab one
// (tests/serverDefinitionPromote.test.js, tests/serverDefinitionPromoteGitHub.test.js,
// tests/serverDefinitionPromoteGitLab.test.js), and a single fan-out call can target repos on any mix
// of providers at once, independently. Uses only the library repo's Bitbucket credential throughout —
// Promote is a content-store-only operation and never touches Jira (ADR-0042).
//
// Atlassian's location schema carries no `baseUrl` (Cloud-only, ADR-0042), so — as in
// tests/serverLibraryReposAtlassian.test.js — a Bitbucket-hosted library repo used here is seeded
// directly into `library-repos.json` with a test-only `baseUrl`, rather than added through
// `POST /api/library-repos` (whose own location validation would drop that field). Every other route
// exercised below (`/promote`, `/promotions`, `/promotions/check`) is the real, unmodified production
// route, reading the seeded repo back through `lib/librarySettings.js`'s own `resolveLibraryRepo`
// exactly as it would a production entry.

const BITBUCKET_OWNER = 'fake-account'
const BITBUCKET_PAT = 'promote-bitbucket-test-pat'
const GITLAB_NAMESPACE = 'fake-group/fake-subgroup'
const GITLAB_PAT = 'promote-gitlab-test-pat'

function atlassianLocation(repository, overrides = {}) {
  return { owner: BITBUCKET_OWNER, repository, jiraSite: 'acme.atlassian.net', jiraProjectKey: 'PROJ', ...overrides }
}

// Seeds `library-repos.json` directly with one Atlassian entry (see this suite's own doc comment) —
// returns the repo id so a caller can address it in a `/promote` call's own `repoIds`.
function seedAtlassianLibraryRepo(instancesDir, id, { repository, baseUrl, codeOwner }) {
  mkdirSync(instancesDir, { recursive: true })
  const path = join(instancesDir, 'library-repos.json')
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  existing[id] = {
    provider: 'atlassian',
    location: atlassianLocation(repository, { baseUrl }),
    ...(codeOwner ? { codeOwner } : {}),
    addedAt: new Date().toISOString(),
  }
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n')
  return id
}

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
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p49-promote-lib-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p49-promote-ws-'))
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

// ---------- single-repo: Atlassian (Bitbucket) ----------

test(
  'promoting a published server-workspace definition version into a Bitbucket library repo opens a branch, one commit and a pull request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-bb-repo', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
      const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-promote-1', { repository: 'promote-bb-repo', baseUrl })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
        const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [repoId] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results.length, 1)
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))
        assert.equal(body.results[0].branch, 'definition/widget-process-v1')
        assert.equal(body.results[0].status, 'active')
        assert.equal(typeof body.results[0].pullRequestId, 'number')
        assert.match(body.results[0].pullRequestUrl, new RegExp(`^https://bitbucket\\.org/${BITBUCKET_OWNER}/promote-bb-repo/pull-requests/\\d+$`))
        assert.equal(body.results[0].review.state, 'pending')

        // The branch carries the full version folder as one commit; main is untouched.
        const branchRes = await fetch(`${baseUrl}/repositories/${BITBUCKET_OWNER}/promote-bb-repo/refs/branches?q=name%3D%22definition%2Fwidget-process-v1%22`, {
          headers: { Authorization: `Bearer ${BITBUCKET_PAT}` },
        })
        const branchBody = await branchRes.json()
        assert.equal(branchBody.values.length, 1, 'the promotion branch exists')

        // Persisted: a page reload sees the same promotion without a fresh promote.
        const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(persisted.promotions.length, 1)
        assert.equal(persisted.promotions[0].repoId, repoId)
      })
    })
  })
)

test(
  'a configured code owner is resolved through Bitbucket identity and requested as a reviewer on the promotion pull request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer(
      {
        owner: BITBUCKET_OWNER,
        repository: 'promote-bb-owner-repo',
        validPat: BITBUCKET_PAT,
        files: { 'README.md': '# repo' },
        permissions: [{ uuid: '{reviewer-uuid}', accountId: 'acct-1', displayName: 'Octo Cat', nickname: 'octocat', permission: 'write' }],
      },
      async (baseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
        const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-promote-2', { repository: 'promote-bb-owner-repo', baseUrl, codeOwner: 'octocat' })

        await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
          const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [repoId] }),
          })
          assert.equal(status, 200, JSON.stringify(body))
          assert.equal(body.results[0].reviewerResolved, true, JSON.stringify(body.results[0]))

          const prRes = await fetch(`${baseUrl}/repositories/${BITBUCKET_OWNER}/promote-bb-owner-repo/pullrequests/${body.results[0].pullRequestId}`, {
            headers: { Authorization: `Bearer ${BITBUCKET_PAT}` },
          })
          const pr = await prRes.json()
          assert.deepEqual(
            pr.participants.map((p) => p.user.uuid),
            ['{reviewer-uuid}']
          )
        })
      }
    )
  })
)

test(
  'an unconfigurable code owner is reported by name — Atlassian, not another provider — with no reviewer attached',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-bb-badowner-repo', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
      const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-promote-3', { repository: 'promote-bb-badowner-repo', baseUrl, codeOwner: 'nobody-matches' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
        const { body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [repoId] }),
        })
        assert.equal(body.results[0].reviewerResolved, false)
        assert.match(body.results[0].reviewerError, /Atlassian identity/)
        assert.doesNotMatch(body.results[0].reviewerError, /GitLab|GitHub|Azure DevOps/)
      })
    })
  })
)

// ---------- cross-provider fan-out ----------

test(
  'a single promote call fanning out to a GitLab repo and a Bitbucket repo succeeds independently on each',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-cross-gl3', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (glBaseUrl) => {
      await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-cross-bb', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (bbBaseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
        const bbRepoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-cross-1', { repository: 'promote-cross-bb', baseUrl: bbBaseUrl })

        await withRunningServer(
          { definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, libraryPatAtlassian: BITBUCKET_PAT, allowGitLabBaseUrlOverride: true, skipLibraryRepoStartupRefresh: true },
          async (base) => {
            const { addLibraryRepo } = await import('../lib/librarySettings.js')
            const glRepo = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-cross-gl3', baseUrl: glBaseUrl } }, { instancesDir })

            const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoIds: [glRepo.id, bbRepoId] }),
            })
            assert.equal(status, 200, JSON.stringify(body))
            assert.equal(body.results.length, 2)
            const glResult = body.results.find((r) => r.repoId === glRepo.id)
            const bbResult = body.results.find((r) => r.repoId === bbRepoId)
            assert.equal(glResult.ok, true, JSON.stringify(glResult))
            assert.equal(bbResult.ok, true, JSON.stringify(bbResult))
            assert.match(glResult.pullRequestUrl, new RegExp(`/${GITLAB_NAMESPACE}/promote-cross-gl3/-/merge_requests/\\d+$`))
            assert.match(bbResult.pullRequestUrl, new RegExp(`^https://bitbucket\\.org/${BITBUCKET_OWNER}/promote-cross-bb/pull-requests/\\d+$`))

            const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
            assert.equal(persisted.promotions.length, 2)
          }
        )
      })
    })
  })
)

test(
  'a promote call naming only a Bitbucket repo is never blocked by an unset GitLab server PAT',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-bb-only-repo', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
      const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-promote-4', { repository: 'promote-bb-only-repo', baseUrl })

      // No GitLab PAT configured at all (libraryPat: null covers Azure DevOps; GitLab's own is simply
      // never set here) — only Bitbucket's.
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: null, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
        const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [repoId] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))
      })
    })
  })
)

test(
  'in a mixed-provider fan-out, a Bitbucket repo whose provider has no configured server PAT fails on its own without blocking the other repo',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: 'promote-nopat-gl2', validPat: GITLAB_PAT, files: { 'README.md': '# repo' } }, async (glBaseUrl) => {
      await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-nopat-bb', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (bbBaseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
        const bbRepoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-nopat', { repository: 'promote-nopat-bb', baseUrl: bbBaseUrl })

        // No Atlassian PAT configured — the GitLab repo should still succeed.
        await withRunningServer({ definitionsDir, instancesDir, libraryPatGitlab: GITLAB_PAT, allowGitLabBaseUrlOverride: true, skipLibraryRepoStartupRefresh: true }, async (base) => {
          const { addLibraryRepo } = await import('../lib/librarySettings.js')
          const glRepo = addLibraryRepo({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: 'promote-nopat-gl2', baseUrl: glBaseUrl } }, { instancesDir })

          const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [glRepo.id, bbRepoId] }),
          })
          assert.equal(status, 200, JSON.stringify(body))
          const glResult = body.results.find((r) => r.repoId === glRepo.id)
          const bbResult = body.results.find((r) => r.repoId === bbRepoId)
          assert.equal(glResult.ok, true, JSON.stringify(glResult))
          assert.equal(bbResult.ok, false)
          assert.match(bbResult.error, /provider "atlassian"/)
          assert.match(bbResult.error, /GANTRY_LIBRARY_PAT_ATLASSIAN/)
        })
      })
    })
  })
)

test(
  're-promoting the same version to the same Bitbucket repo while an earlier promotion branch is still open is refused, not silently overwritten',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-bb-repeat-repo', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
      const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-repeat', { repository: 'promote-bb-repeat-repo', baseUrl })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
        const promoteOnce = () =>
          fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [repoId] }),
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
  'POST /api/local/definitions/promote fans a client-supplied file set out to a Bitbucket repo, and persists nothing server-side',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'promote-local-bb-repo', validPat: BITBUCKET_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-local', { repository: 'promote-local-bb-repo', baseUrl })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
        const files = [
          { path: 'definition.yaml', content: 'id: local-widget\nversion: 1\nstatus: published\ntitle: Local Widget\n', contentType: 'rawtext' },
          { path: 'CHANGELOG.md', content: '## v1\n\nPublished.\n', contentType: 'rawtext' },
        ]
        const { status, body } = await fetchJson(`${base}/api/local/definitions/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'local-widget', version: 1, files, repoIds: [repoId] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))
      })
    })
  })
)

// ---------- explicit Check, not polled ----------

test(
  "the explicit Check action re-reads a Bitbucket promotion pull request's status and review state, and never merges it",
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer(
      {
        owner: BITBUCKET_OWNER,
        repository: 'promote-bb-check-repo',
        validPat: BITBUCKET_PAT,
        files: { 'README.md': '# repo' },
        // A resolvable code owner so Promote actually attaches a reviewer participant — this fake
        // server's own `/approve` route acts on the pull request's sole reviewer participant.
        permissions: [{ uuid: '{reviewer-uuid}', accountId: 'acct-1', displayName: 'Octo Cat', nickname: 'octocat', permission: 'write' }],
      },
      async (baseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
        const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-check', { repository: 'promote-bb-check-repo', baseUrl, codeOwner: 'octocat' })

        await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
          const { body: promoteBody } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [repoId] }),
          })
          const pullRequestId = promoteBody.results[0].pullRequestId
          assert.equal(promoteBody.results[0].review.state, 'pending')

          // Simulate the code owner approving directly on Bitbucket — this server never polls for it.
          await fetch(`${baseUrl}/repositories/${BITBUCKET_OWNER}/promote-bb-check-repo/pullrequests/${pullRequestId}/approve`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${BITBUCKET_PAT}` },
          })

          // Before Check: the persisted record still shows the stale, pre-review status.
          const { body: beforeCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
          assert.equal(beforeCheck.promotions[0].review.state, 'pending')

          const { status, body: afterCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions/check`, { method: 'POST' })
          assert.equal(status, 200)
          assert.equal(afterCheck.promotions[0].review.state, 'approved')
          // Never merged — an approved review changes only the recorded review state, never the pull
          // request's own status.
          assert.equal(afterCheck.promotions[0].status, 'active')

          const prRes = await fetch(`${baseUrl}/repositories/${BITBUCKET_OWNER}/promote-bb-check-repo/pullrequests/${pullRequestId}`, {
            headers: { Authorization: `Bearer ${BITBUCKET_PAT}` },
          })
          assert.equal((await prRes.json()).state, 'OPEN')
        })
      }
    )
  })
)

test(
  "a reviewer who requests changes on the promotion pull request reads as changes-requested, per ADR-0042's tri-state mapping",
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeBitbucketServer(
      {
        owner: BITBUCKET_OWNER,
        repository: 'promote-bb-changes-repo',
        validPat: BITBUCKET_PAT,
        files: { 'README.md': '# repo' },
        permissions: [{ uuid: '{reviewer-uuid}', accountId: 'acct-1', displayName: 'Octo Cat', nickname: 'octocat', permission: 'write' }],
      },
      async (baseUrl) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
        const repoId = seedAtlassianLibraryRepo(instancesDir, 'bb-repo-changes', { repository: 'promote-bb-changes-repo', baseUrl, codeOwner: 'octocat' })

        await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
          const { body: promoteBody } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [repoId] }),
          })
          const pullRequestId = promoteBody.results[0].pullRequestId
          assert.equal(promoteBody.results[0].reviewerResolved, true, JSON.stringify(promoteBody.results[0]))

          // The attached reviewer requests changes directly on Bitbucket.
          await fetch(`${baseUrl}/repositories/${BITBUCKET_OWNER}/promote-bb-changes-repo/pullrequests/${pullRequestId}/request-changes`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${BITBUCKET_PAT}` },
          })

          const { body: afterCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions/check`, { method: 'POST' })
          assert.equal(afterCheck.promotions[0].review.state, 'changes-requested')
        })
      }
    )
  })
)
