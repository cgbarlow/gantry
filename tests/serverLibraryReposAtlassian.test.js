import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { withFakeBitbucketServer } from './helpers/fakeBitbucketServer.js'
import { buildDefinitionYamlObject, buildModuleYamlObject } from '../lib/definition.js'

// #49 (ADR-0036, ADR-0042): library repos gain Atlassian (Bitbucket-backed) as a fourth provider — a
// Bitbucket repo can be registered as a library repo, its definitions read into the server library,
// the definition cache refreshes from it on the existing explicit Refresh action, and it resolves its
// own server-held Bitbucket credential (GANTRY_LIBRARY_PAT_ATLASSIAN — a single token, never a
// `{bitbucket, jira}` pair) independently of the other three providers. Per ADR-0042/lib/librarySettings.js's
// own doc comment, only the *credential* is Bitbucket-only — an Atlassian library repo's location is
// the same full `{owner, repository, jiraSite, jiraProjectKey}` shape as a workspace's; its Jira half
// is simply never read for a library repo's own (content-store-only) operations. This suite is the
// Atlassian twin of tests/serverLibraryReposGitLab.test.js.
//
// Atlassian's location schema carries no `baseUrl` at all (ADR-0042: Cloud-only, no self-hosted
// override) — so, unlike the GitHub/GitLab twins of this suite, there is no way to add a repo through
// the real `POST /api/library-repos` route and have its *read* actually reach a fake server (the
// route's own `normalizeProviderLocation` call would simply drop a `baseUrl` field on the way in, the
// same restriction tests/renderAtlassian.test.js's own doc comment already documents for the render
// pipeline). The "no Jira credential anywhere in the flow" and "schema accepted" behaviours below are
// therefore proven through the real route (with `libraryPatAtlassian: null`, so nothing ever attempts
// a real network call); the "definitions are actually read and unioned" behaviours instead seed
// `library-repos.json` directly with a test-only `baseUrl` — the same "exercise the module directly
// with an explicit baseUrl" convention already established for Atlassian by
// tests/librarySettings.test.js's own legacy-record read-forward tests and
// tests/definitionAtlassian.test.js/tests/renderAtlassian.test.js more broadly — then lets the real
// running server's startup refresh (and every other route) read it back exactly as it would a
// production repo, `baseUrl` included.

const VALID_BITBUCKET_PAT = 'bitbucket-library-test-pat'
const BITBUCKET_OWNER = 'fake-account'
const GITHUB_OWNER = 'fake-owner'
const VALID_GITHUB_PAT = 'github-library-test-pat'

function atlassianLocation(repository, overrides = {}) {
  return { owner: BITBUCKET_OWNER, repository, jiraSite: 'acme.atlassian.net', jiraProjectKey: 'PROJ', ...overrides }
}

// Builds the raw `{ path: content }` map a fake Bitbucket repo needs to seed one small, valid,
// published definition — the same minimal shape tests/serverLibraryReposGitHub.test.js's own
// `githubDefinitionFiles` produces.
function atlassianDefinitionFiles(id, { title } = {}) {
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

// Seeds `library-repos.json` directly (this suite's own doc comment explains why) with an Atlassian
// entry whose location carries a test-only `baseUrl` alongside the real four required fields.
function seedAtlassianLibraryRepo(instancesDir, id, { repository, baseUrl, codeOwner }) {
  mkdirSync(instancesDir, { recursive: true })
  const path = join(instancesDir, 'library-repos.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        [id]: {
          provider: 'atlassian',
          location: atlassianLocation(repository, { baseUrl }),
          ...(codeOwner ? { codeOwner } : {}),
          addedAt: new Date().toISOString(),
        },
      },
      null,
      2
    ) + '\n'
  )
}

async function withScratchLibraryDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p49-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p49-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// ---------- Settings can add a Bitbucket-hosted library repo; no Jira credential anywhere ----------

test('Settings can add a Bitbucket-hosted library repo, using only one server-held Bitbucket credential — no Jira credential field or prompt anywhere in the flow', async () => {
  await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
    // No `libraryPatAtlassian` at all: proves the add/schema path never needs (or attempts to reach)
    // a live Bitbucket API, and never asks for a Jira credential of any kind.
    await withRunningServer({ definitionsDir, instancesDir, libraryPat: null }, async (base) => {
      const addRes = await fetch(`${base}/api/library-repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'atlassian', location: atlassianLocation('bb-add-repo') }),
      })
      const addBody = await addRes.json()
      assert.equal(addRes.status, 201, JSON.stringify(addBody))
      assert.equal(addBody.repo.provider, 'atlassian')
      assert.deepEqual(addBody.repo.location, atlassianLocation('bb-add-repo'))
      // Refresh is attempted (as for every provider) and fails for the expected reason — a missing
      // *Bitbucket* credential, never a missing Jira one, and no separate "Jira PAT" field or prompt
      // was ever surfaced to get here.
      assert.equal(addBody.refresh.ok, false)
      assert.match(addBody.refresh.error, /provider "atlassian"/)
      assert.match(addBody.refresh.error, /GANTRY_LIBRARY_PAT_ATLASSIAN/)
      // `jiraSite`/`jiraProjectKey` legitimately ride along on the location (the full workspace-shaped
      // schema, per lib/provider.js's own doc comment) — what must never appear is a *credential*
      // naming Jira, since a library repo's refresh only ever resolves its single Bitbucket token.
      assert.doesNotMatch(JSON.stringify(addBody), /jira.?(pat|token|credential)/i, 'no mention of a Jira credential anywhere in the add response')
    })
  })
})

test('a Bitbucket location missing jiraSite or jiraProjectKey is rejected — a library repo location is the same full schema as a workspace\'s', async () => {
  await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
    await withRunningServer({ definitionsDir, instancesDir, libraryPat: null }, async (base) => {
      const addRes = await fetch(`${base}/api/library-repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'atlassian', location: { owner: BITBUCKET_OWNER, repository: 'bb-incomplete' } }),
      })
      const addBody = await addRes.json()
      assert.equal(addRes.status, 400, JSON.stringify(addBody))
      assert.match(addBody.error, /missing: jiraSite, jiraProjectKey/)
    })
  })
})

test('a missing GANTRY_LIBRARY_PAT_ATLASSIAN credential reports the provider and the env var name, the same class of error as the other providers', async () => {
  await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
    await withRunningServer({ definitionsDir, instancesDir, libraryPat: null }, async (base) => {
      const addRes = await fetch(`${base}/api/library-repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'atlassian', location: atlassianLocation('bb-nopat-repo') }),
      })
      const addBody = await addRes.json()
      assert.equal(addRes.status, 201)
      assert.equal(addBody.refresh.ok, false)
      assert.match(addBody.refresh.error, /provider "atlassian"/)
      assert.match(addBody.refresh.error, /GANTRY_LIBRARY_PAT_ATLASSIAN/)

      const rows = await (await fetch(`${base}/api/definitions`)).json()
      assert.equal(rows.some((r) => r.id === 'bb-process'), false)
    })
  })
})

// ---------- actually reading a Bitbucket library repo (baseUrl seeded directly — see this suite's own doc comment) ----------

test('a Bitbucket library repo (seeded with a fake-server baseUrl) has its definitions read and unioned in read-only, at server startup', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'bb-lib-union', validPat: VALID_BITBUCKET_PAT, files: atlassianDefinitionFiles('widget-process', { title: 'Widget Process' }) }, async (baseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      seedAtlassianLibraryRepo(instancesDir, 'bb-repo-1', { repository: 'bb-lib-union', baseUrl })

      await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: VALID_BITBUCKET_PAT }, async (base) => {
        // Startup refresh is fire-and-forget (lib/server.js's own doc comment) — poll the definitions
        // union until the Bitbucket-sourced row shows up, the same "no fixed sleep" convention every
        // other startup-refresh test in this codebase uses.
        let repoRow
        for (let attempt = 0; attempt < 50 && !repoRow; attempt++) {
          const rows = await (await fetch(`${base}/api/definitions`)).json()
          repoRow = rows.find((r) => r.id === 'widget-process')
          if (!repoRow) await new Promise((r) => setTimeout(r, 20))
        }
        assert.ok(repoRow, 'Bitbucket library repo definition is in the unioned listing')
        assert.equal(repoRow.home.kind, 'library-repo')
        assert.equal(repoRow.readOnly, true)
        assert.equal(repoRow.title, 'Widget Process')

        const detail = await (await fetch(`${base}/api/definitions/widget-process/versions/1`)).json()
        assert.deepEqual(detail.stages.map((s) => s.id), ['shape'])
        assert.deepEqual(detail.modules.map((m) => m.id), ['intro'])

        // Read-only in the editor, exactly like every other provider's library repo.
        const publishRes = await fetch(`${base}/api/definitions/widget-process/versions/1/publish`, { method: 'POST' })
        assert.equal(publishRes.status, 403)
      })
    })
  })
})

test('the explicit Refresh route re-reads a Bitbucket library repo on demand', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'bb-refresh-repo', validPat: VALID_BITBUCKET_PAT, files: atlassianDefinitionFiles('bb-refresh-process') }, async (baseUrl) => {
    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      seedAtlassianLibraryRepo(instancesDir, 'bb-repo-2', { repository: 'bb-refresh-repo', baseUrl })

      // Suppress the fire-and-forget startup refresh so this test controls exactly when the one
      // refresh it asserts on happens.
      await withRunningServer({ definitionsDir, instancesDir, libraryPatAtlassian: VALID_BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
        const refreshBody = await (await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })).json()
        assert.equal(refreshBody.results.length, 1)
        assert.equal(refreshBody.results[0].ok, true, JSON.stringify(refreshBody.results[0]))
        assert.equal(refreshBody.results[0].definitionCount, 1)

        const rows = await (await fetch(`${base}/api/definitions`)).json()
        assert.ok(rows.find((r) => r.id === 'bb-refresh-process' && r.home.kind === 'library-repo'))
      })
    })
  })
})

test('GitHub and Atlassian library repos coexist and refresh independently, each resolving its own credential', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'gh-coexist-repo-49', validPat: VALID_GITHUB_PAT, files: atlassianDefinitionFiles('gh-process', { title: 'GitHub Process' }) }, async (ghBaseUrl) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'bb-coexist-repo', validPat: VALID_BITBUCKET_PAT, files: atlassianDefinitionFiles('bb-process', { title: 'Bitbucket Process' }) }, async (bbBaseUrl) => {
      await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
        seedAtlassianLibraryRepo(instancesDir, 'bb-repo-3', { repository: 'bb-coexist-repo', baseUrl: bbBaseUrl })

        await withRunningServer(
          { definitionsDir, instancesDir, libraryPatGithub: VALID_GITHUB_PAT, libraryPatAtlassian: VALID_BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true },
          async (base) => {
            const ghAdd = await (
              await fetch(`${base}/api/library-repos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'github', location: { owner: GITHUB_OWNER, repository: 'gh-coexist-repo-49', baseUrl: ghBaseUrl } }),
              })
            ).json()
            assert.equal(ghAdd.refresh.ok, true, JSON.stringify(ghAdd.refresh))

            // The Refresh route re-reads both the just-added GitHub repo and the pre-seeded Bitbucket
            // one, independently.
            const refreshBody = await (await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })).json()
            assert.equal(refreshBody.results.length, 2)
            assert.ok(refreshBody.results.every((r) => r.ok), JSON.stringify(refreshBody.results))

            const rows = await (await fetch(`${base}/api/definitions`)).json()
            assert.ok(rows.find((r) => r.id === 'gh-process' && r.home.kind === 'library-repo'))
            assert.ok(rows.find((r) => r.id === 'bb-process' && r.home.kind === 'library-repo'))
          }
        )
      })
    })
  })
})

test('the definition-id-uniqueness guarantee holds across a Bitbucket library repo alongside a GitHub one — the second repo\'s clashing id is reported as a problem, not silently shadowed', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: 'gh-clash-repo', validPat: VALID_GITHUB_PAT, files: atlassianDefinitionFiles('shared-process', { title: 'GitHub Version' }) }, async (ghBaseUrl) => {
    await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: 'bb-clash-repo', validPat: VALID_BITBUCKET_PAT, files: atlassianDefinitionFiles('shared-process', { title: 'Bitbucket Version' }) }, async (bbBaseUrl) => {
      await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
        // GitHub's own entry is seeded first (JSON key insertion order — lib/librarySettings.js's own
        // "first repo configured wins" rule) so its copy of "shared-process" is the one that survives
        // the clash; Bitbucket's is seeded second and is the one reported as a problem.
        mkdirSync(instancesDir, { recursive: true })
        writeFileSync(
          join(instancesDir, 'library-repos.json'),
          JSON.stringify(
            {
              'gh-repo': { provider: 'github', location: { owner: GITHUB_OWNER, repository: 'gh-clash-repo', baseUrl: ghBaseUrl }, addedAt: new Date().toISOString() },
              'bb-repo': { provider: 'atlassian', location: atlassianLocation('bb-clash-repo', { baseUrl: bbBaseUrl }), addedAt: new Date().toISOString() },
            },
            null,
            2
          ) + '\n'
        )

        await withRunningServer({ definitionsDir, instancesDir, libraryPatGithub: VALID_GITHUB_PAT, libraryPatAtlassian: VALID_BITBUCKET_PAT, skipLibraryRepoStartupRefresh: true }, async (base) => {
          const refreshBody = await (await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })).json()
          assert.equal(refreshBody.results.length, 2)
          assert.ok(refreshBody.results.every((r) => r.ok), JSON.stringify(refreshBody.results))

          const rows = await (await fetch(`${base}/api/definitions`)).json()
          const shared = rows.filter((r) => r.id === 'shared-process')
          assert.equal(shared.length, 1, 'only the first-configured (GitHub) copy is exposed, never both')
          assert.equal(shared[0].title, 'GitHub Version')

          const problemsBody = await (await fetch(`${base}/api/library-repos`)).json()
          assert.equal(problemsBody.problems.length, 1)
          assert.equal(problemsBody.problems[0].id, 'shared-process')
          assert.equal(problemsBody.problems[0].repoId, 'bb-repo')
          assert.match(problemsBody.problems[0].message, /already exists/)
        })
      })
    })
  })
})
