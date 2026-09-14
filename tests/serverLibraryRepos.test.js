import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createBlankAzureDevOpsDefinition, writeAzureDevOpsDefinitionVersion, publishAzureDevOpsDefinitionVersion } from '../lib/definitionAzureDevOps.js'
import { addLibraryRepo } from '../lib/librarySettings.js'
import { libraryRepoDefinitionsDir, refreshLibraryRepo } from '../lib/libraryCache.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'

// WI #386 (Feature #380 phase 6, ADR-0036): Global Settings' library repos — the server library
// becomes the union of the packaged/configured `definitions/` directory and every library repo's
// `definitions/` folder, ids unique across all of them, read with the server's own PAT and cached
// on disk (re-read at startup / on add / on an explicit Refresh, never polled). Covers the union,
// the uniqueness clash, the cache (including graceful degradation when a repo goes unreachable),
// and Refresh — all against `tests/helpers/fakeAzureDevOpsServer.js`, per this ticket's own "Done
// when" bar.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const VALID_PAT = 'library-test-pat'

// Publishes a small, valid definition (one stage, one artefact, one module — the same minimal shape
// `tests/serverDefinitionEditorPhase3.test.js` already proves passes `findDefinitionProblemsInStructure`)
// directly into a fake Azure DevOps repo's `main`, via the exact primitives WI #383 built
// (`lib/definitionAzureDevOps.js`) — three real commits (create, save, publish), matching how a real
// library repo's content would actually get there.
async function seedAzureDevOpsDefinition(azureDevOps, id, { title } = {}) {
  await createBlankAzureDevOpsDefinition(id, { azureDevOps }, { title: title ?? id })
  const structure = {
    title: title ?? id,
    description: `${id} description`,
    modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
    stages: [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'shape-review', modules: ['intro'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'shape-review', requires: ['intro'] }],
  }
  const result = await writeAzureDevOpsDefinitionVersion(id, 1, structure, { azureDevOps })
  assert.ok(!result.problems, `seed structure for "${id}" should be valid: ${JSON.stringify(result.problems)}`)
  await publishAzureDevOpsDefinitionVersion(id, 1, { azureDevOps })
}

async function withScratchLibraryDirs(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p6-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p6-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    await fn(definitionsDir, instancesDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// ---------- union ----------

test('a library repo definition is unioned into GET /api/definitions, tagged home: library-repo and readOnly, alongside the packaged library', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-union', validPat: VALID_PAT }, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-union', baseUrl, pat: VALID_PAT }
    await seedAzureDevOpsDefinition(azureDevOps, 'widget-process', { title: 'Widget Process' })

    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-union', baseUrl }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201, JSON.stringify(addBody))
        assert.equal(addBody.refresh.ok, true, JSON.stringify(addBody.refresh))
        assert.equal(addBody.refresh.definitionCount, 1)

        const listRes = await fetch(`${base}/api/definitions`)
        const rows = await listRes.json()
        assert.equal(rows.some((r) => r.id === 'design' && r.home.kind === 'library'), true, 'packaged library row is unaffected')
        const repoRow = rows.find((r) => r.id === 'widget-process')
        assert.ok(repoRow, 'library repo definition is in the unioned listing')
        assert.equal(repoRow.home.kind, 'library-repo')
        assert.equal(repoRow.readOnly, true)
        assert.equal(repoRow.title, 'Widget Process')

        // Full content (not just the row) is readable, and copyable-from, via the ordinary route.
        const detailRes = await fetch(`${base}/api/definitions/widget-process/versions/1`)
        const detail = await detailRes.json()
        assert.equal(detailRes.status, 200)
        assert.equal(detail.status, 'published')
        assert.deepEqual(detail.stages.map((s) => s.id), ['shape'])
        assert.deepEqual(detail.modules.map((m) => m.id), ['intro'])
      })
    })
  })
})

// ---------- uniqueness clash ----------

test('a library repo definition whose id already exists in the packaged library is ignored, not listed, and reported as a problem', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-clash-pkg', validPat: VALID_PAT }, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-clash-pkg', baseUrl, pat: VALID_PAT }
    // "design" clashes with the packaged library's own definition; "widget-process" does not.
    await seedAzureDevOpsDefinition(azureDevOps, 'design', { title: 'Impostor Design' })
    await seedAzureDevOpsDefinition(azureDevOps, 'widget-process', { title: 'Widget Process' })

    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-clash-pkg', baseUrl }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201, JSON.stringify(addBody))
        assert.equal(addBody.refresh.ok, true)
        // Both definitions were read into the cache — the clash is a listing-time concern, not a
        // refresh-time one; the repo copy of "design" is still cached, just never surfaced.
        assert.equal(addBody.refresh.definitionCount, 2)

        // Never a hard error blocking everything else: the non-clashing definition still lists.
        const rows = await (await fetch(`${base}/api/definitions`)).json()
        const designRows = rows.filter((r) => r.id === 'design')
        assert.equal(designRows.length, 1, 'exactly one "design" — the packaged copy, never both')
        assert.equal(designRows[0].home.kind, 'library')
        assert.ok(rows.find((r) => r.id === 'widget-process' && r.home.kind === 'library-repo'))

        // Reported as a problem on the Definitions page.
        const problemsBody = await (await fetch(`${base}/api/library-repos`)).json()
        assert.equal(problemsBody.problems.length, 1)
        assert.equal(problemsBody.problems[0].id, 'design')
        assert.match(problemsBody.problems[0].message, /already exists/)
      })
    })
  })
})

test('when two library repos both have the same id, the first repo added wins and the second is reported as a problem', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-a', validPat: VALID_PAT }, async (baseUrlA) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-b', validPat: VALID_PAT }, async (baseUrlB) => {
      const azureDevOpsA = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-a', baseUrl: baseUrlA, pat: VALID_PAT }
      const azureDevOpsB = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-b', baseUrl: baseUrlB, pat: VALID_PAT }
      await seedAzureDevOpsDefinition(azureDevOpsA, 'shared-id', { title: 'From Repo A' })
      await seedAzureDevOpsDefinition(azureDevOpsB, 'shared-id', { title: 'From Repo B' })

      await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
        await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const addA = await (
            await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-a', baseUrl: baseUrlA }),
            })
          ).json()
          assert.equal(addA.refresh.ok, true)
          const addB = await (
            await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-b', baseUrl: baseUrlB }),
            })
          ).json()
          assert.equal(addB.refresh.ok, true)

          const rows = await (await fetch(`${base}/api/definitions`)).json()
          const sharedRows = rows.filter((r) => r.id === 'shared-id')
          assert.equal(sharedRows.length, 1)
          assert.equal(sharedRows[0].title, 'From Repo A')
          assert.equal(sharedRows[0].home.id, addA.repo.id)

          const problemsBody = await (await fetch(`${base}/api/library-repos`)).json()
          assert.equal(problemsBody.problems.length, 1)
          assert.equal(problemsBody.problems[0].id, 'shared-id')
          assert.equal(problemsBody.problems[0].repoId, addB.repo.id)
        })
      })
    })
  })
})

// ---------- cache: graceful degradation when a repo becomes unreachable ----------

test('a library repo definition keeps listing and loading from its cache after the repo becomes unreachable, and Refresh reports the failure without wiping the cache', async () => {
  let baseUrl
  let azureDevOps
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p6-cache-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p6-cache-ws-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })

    // The fake server is deliberately closed (via withFakeAzureDevOpsServer's own lifecycle) before
    // the assertions below run, simulating "the repo is currently unreachable" — everything after
    // this block runs against a base URL nothing is listening on any more.
    let cachedRepo
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-cache', validPat: VALID_PAT }, async (url) => {
      baseUrl = url
      azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-cache', baseUrl, pat: VALID_PAT }
      await seedAzureDevOpsDefinition(azureDevOps, 'widget-process', { title: 'Widget Process' })
      cachedRepo = addLibraryRepo({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-cache', baseUrl }, { instancesDir })
      const meta = await refreshLibraryRepo(cachedRepo, { instancesDir, pat: VALID_PAT })
      assert.equal(meta.ids.length, 1)
      assert.ok(existsSync(join(libraryRepoDefinitionsDir(instancesDir, cachedRepo.id), 'widget-process', '1', 'definition.yaml')))
    })

    // The fake server has now been closed — every network call to `baseUrl` fails.
    await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true, skipLibraryRepoStartupRefresh: true }, async (base) => {
      // Still listed, still fully loadable — served entirely from the on-disk mirror, no network
      // involved on this path at all.
      const rows = await (await fetch(`${base}/api/definitions`)).json()
      assert.ok(rows.find((r) => r.id === 'widget-process' && r.home.kind === 'library-repo'))
      const detailRes = await fetch(`${base}/api/definitions/widget-process/versions/1`)
      assert.equal(detailRes.status, 200)

      // An instance already pinned to it keeps working too.
      const instRes = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'widget-process', slug: 'widget-instance' }),
      })
      assert.equal(instRes.status, 201, await instRes.text())
      const viewRes = await fetch(`${base}/api/instance?slug=widget-instance`)
      const viewBody = await viewRes.text()
      assert.equal(viewRes.status, 200, viewBody)
      assert.equal(JSON.parse(viewBody).definition, 'widget-process')

      // Explicit Refresh, against the now-unreachable repo: reports the failure, never throws, and
      // — critically — never wipes what was already cached.
      const refreshRes = await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })
      const refreshBody = await refreshRes.json()
      assert.equal(refreshRes.status, 200)
      assert.equal(refreshBody.results.length, 1)
      assert.equal(refreshBody.results[0].ok, false)
      assert.ok(refreshBody.results[0].error)

      const rowsAfter = await (await fetch(`${base}/api/definitions`)).json()
      assert.ok(rowsAfter.find((r) => r.id === 'widget-process'), 'cached content survives a failed refresh')
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('with no server PAT configured, adding a repo reports the refresh as failed and lists no definitions from it — but nothing throws', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-nopat', validPat: VALID_PAT }, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-nopat', baseUrl, pat: VALID_PAT }
    await seedAzureDevOpsDefinition(azureDevOps, 'widget-process', { title: 'Widget Process' })

    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: null, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const addRes = await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-nopat', baseUrl }),
        })
        const addBody = await addRes.json()
        assert.equal(addRes.status, 201)
        assert.equal(addBody.refresh.ok, false)
        assert.match(addBody.refresh.error, /No server PAT configured/)

        const rows = await (await fetch(`${base}/api/definitions`)).json()
        assert.equal(rows.some((r) => r.id === 'widget-process'), false)
      })
    })
  })
})

// ---------- Refresh ----------

test('the explicit Refresh route re-reads a library repo and picks up a definition added since the last refresh', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-refresh', validPat: VALID_PAT }, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-refresh', baseUrl, pat: VALID_PAT }
    await seedAzureDevOpsDefinition(azureDevOps, 'first-process', { title: 'First Process' })

    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const addBody = await (
          await fetch(`${base}/api/library-repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-refresh', baseUrl }),
          })
        ).json()
        assert.equal(addBody.refresh.definitionCount, 1)

        const beforeRows = await (await fetch(`${base}/api/definitions`)).json()
        assert.equal(beforeRows.some((r) => r.id === 'second-process'), false)

        // The repo gains a second definition — nothing re-reads it until Refresh is explicitly hit.
        await seedAzureDevOpsDefinition(azureDevOps, 'second-process', { title: 'Second Process' })
        const stillBeforeRows = await (await fetch(`${base}/api/definitions`)).json()
        assert.equal(stillBeforeRows.some((r) => r.id === 'second-process'), false, 'no polling — GET alone never re-fetches')

        const refreshBody = await (await fetch(`${base}/api/library-repos/refresh`, { method: 'POST' })).json()
        assert.equal(refreshBody.results[0].ok, true)
        assert.equal(refreshBody.results[0].definitionCount, 2)

        const afterRows = await (await fetch(`${base}/api/definitions`)).json()
        assert.ok(afterRows.find((r) => r.id === 'second-process' && r.home.kind === 'library-repo'))
      })
    })
  })
})

// ---------- read-only enforcement + clone ----------

test('a library repo definition cannot be edited directly (403 on new draft/publish/archive/template/save), but clones into a workspace as an independent, editable draft', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-readonly', validPat: VALID_PAT }, async (baseUrl) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-readonly', baseUrl, pat: VALID_PAT }
    await seedAzureDevOpsDefinition(azureDevOps, 'widget-process', { title: 'Widget Process' })

    await withScratchLibraryDirs(async (definitionsDir, instancesDir) => {
      mkdirSync(join(instancesDir, 'acme'), { recursive: true })
      writeWorkspaceJson(instancesDir, 'acme', { name: 'Acme', kind: 'local', createdAt: new Date().toISOString() })

      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        await fetch(`${base}/api/library-repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: 'lib-repo-readonly', baseUrl }),
        })

        const newDraftRes = await fetch(`${base}/api/definitions/widget-process/versions`, { method: 'POST' })
        assert.equal(newDraftRes.status, 403)

        const publishRes = await fetch(`${base}/api/definitions/widget-process/versions/1/publish`, { method: 'POST' })
        assert.equal(publishRes.status, 403)

        const archiveRes = await fetch(`${base}/api/definitions/widget-process/archive`, { method: 'POST' })
        assert.equal(archiveRes.status, 403)

        const saveRes = await fetch(`${base}/api/definitions/widget-process/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Hacked', stages: [], artefacts: [], modules: [] }),
        })
        assert.equal(saveRes.status, 403)

        const templateRes = await fetch(`${base}/api/definitions/widget-process/versions/1/templates/doc.md.tmpl`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'hacked' }),
        })
        assert.equal(templateRes.status, 403)

        // Clonable into a workspace: a real, independent, editable copy.
        const cloneRes = await fetch(`${base}/api/definitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: 'widget-process', newId: 'widget-process-clone', home: { kind: 'server-workspace', id: 'acme' } }),
        })
        const cloneBody = await cloneRes.json()
        assert.equal(cloneRes.status, 201, JSON.stringify(cloneBody))

        const cloneDetail = await (await fetch(`${base}/api/definitions/widget-process-clone/versions/1`)).json()
        assert.equal(cloneDetail.status, 'draft')
        assert.deepEqual(cloneDetail.stages.map((s) => s.id), ['shape'])

        // Editing the clone doesn't need any special-casing — it's a plain workspace draft.
        cloneDetail.title = 'Widget Process (edited clone)'
        const editRes = await fetch(`${base}/api/definitions/widget-process-clone/versions/1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cloneDetail),
        })
        assert.equal(editRes.status, 200, await editRes.text())

        // The original is untouched by editing its clone.
        const originalStill = await (await fetch(`${base}/api/definitions/widget-process/versions/1`)).json()
        assert.equal(originalStill.title, 'Widget Process')
      })
    })
  })
})
