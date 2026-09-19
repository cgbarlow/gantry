import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createBlankDefinition, writeDefinitionVersion, writeDefinitionTemplate, writeDefinitionReferenceDocx, publishDefinitionVersion } from '../lib/definition.js'
import { serverWorkspaceDefinitionsDir } from '../lib/definitionHome.js'
import { addLibraryRepo } from '../lib/librarySettings.js'

// WI #387 (Feature #380 phase 7, ADR-0036's Promote section): a published server-workspace
// definition version is promoted to one or more configured library repos, each via a fresh
// `definition/<id>-v<n>` branch, one commit carrying the full version folder, and a Pull Request
// into the repo's `main` with the repo's configured code owner attached as a required reviewer —
// never a direct write. Covers branch/commit/PR creation and the multi-repo fan-out against
// `tests/helpers/fakeAzureDevOpsServer.js`, per this ticket's own "Done when" bar.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const VALID_PAT = 'promote-test-pat'
const REAL_DOCX = readFileSync('definitions/design/1/templates/reference-soap.docx')

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
  writeDefinitionReferenceDocx(id, 1, 'doc', REAL_DOCX, { definitionsDir })
  publishDefinitionVersion(id, 1, { definitionsDir })
  return definitionsDir
}

function withScratchDirs(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p7-lib-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p7-ws-'))
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

// ---------- single-repo branch/commit/PR creation ----------

test(
  'promoting a published server-workspace definition version opens a definition/<id>-v<n> branch, one commit with the full version folder, and a Pull Request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-repo', validPat: VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-repo', baseUrl } }, { instancesDir })

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
        assert.match(body.results[0].pullRequestUrl, /pullrequest\/\d+$/)

        // The branch exists and carries the full version folder as one commit, in the fake ADO
        // repo's own store — proven by reading the pushed files straight back over the same Git
        // Items API the real client uses.
        const itemsRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-repo/items?path=${encodeURIComponent('/definitions/widget-process/1/definition.yaml')}&versionDescriptor.version=definition%2Fwidget-process-v1&versionDescriptor.versionType=branch&api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(itemsRes.status, 200)
        const item = await itemsRes.json()
        assert.match(item.content, /id: widget-process/)

        const moduleRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-repo/items?path=${encodeURIComponent('/definitions/widget-process/1/modules/intro.yaml')}&versionDescriptor.version=definition%2Fwidget-process-v1&versionDescriptor.versionType=branch&api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(moduleRes.status, 200, 'the module file made it into the same commit')

        const templateRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-repo/items?path=${encodeURIComponent('/definitions/widget-process/1/templates/doc.md.tmpl')}&versionDescriptor.version=definition%2Fwidget-process-v1&versionDescriptor.versionType=branch&api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(templateRes.status, 200, 'the markdown template made it into the same commit')

        const docxRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-repo/items?path=${encodeURIComponent('/definitions/widget-process/1/templates/reference-doc.docx')}&versionDescriptor.version=definition%2Fwidget-process-v1&versionDescriptor.versionType=branch&api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(docxRes.status, 200, 'the reference .docx made it into the same commit, base64-shipped')

        // Never a direct write to main — main is completely untouched.
        const mainRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-repo/items?path=${encodeURIComponent('/definitions/widget-process/1/definition.yaml')}&versionDescriptor.version=main&versionDescriptor.versionType=branch&api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(mainRes.status, 404, 'the promoted content never lands on main directly — only the PR branch')

        // Persisted: a page reload sees the same promotion without a fresh promote.
        const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(persisted.promotions.length, 1)
        assert.equal(persisted.promotions[0].repoId, added.id)
        assert.equal(persisted.promotions[0].pullRequestId, body.results[0].pullRequestId)
      })
    })
  })
)

test(
  'a configured code owner is resolved and attached as a required reviewer on the promotion Pull Request',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-owner-repo', validPat: VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        // The fake server's identity endpoint resolves any query matching "Test User" /
        // "testuser@example.com" (see tests/helpers/fakeAzureDevOpsServer.js).
        const added = addLibraryRepo(
          { location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-owner-repo', baseUrl }, codeOwner: 'testuser@example.com' },
          { instancesDir }
        )

        const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        assert.equal(status, 200, JSON.stringify(body))
        assert.equal(body.results[0].reviewerResolved, true)

        const prRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-owner-repo/pullrequests/${body.results[0].pullRequestId}?api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        const pr = await prRes.json()
        assert.equal(pr.reviewers.length, 1)
        assert.equal(pr.reviewers[0].id, 'fake-identity-id-001')
        assert.equal(pr.reviewers[0].isRequired, true)
      })
    })
  })
)

// ---------- multi-repo fan-out ----------

test(
  'promoting to two library repos at once opens a Pull Request in each, and one repo failing does not block the other',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-fanout-a', validPat: VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrlA) => {
      await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-fanout-b', validPat: 'a-different-pat', files: { 'README.md': '# repo' } }, async (baseUrlB) => {
        seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

        // The server's own libraryPat (VALID_PAT) is valid against repo A but not repo B —
        // repo B's promotion fails with a rejected-PAT error while repo A's still succeeds.
        await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const repoA = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-fanout-a', baseUrl: baseUrlA } }, { instancesDir })
          const repoB = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-fanout-b', baseUrl: baseUrlB } }, { instancesDir })

          const { status, body } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoIds: [repoA.id, repoB.id] }),
          })
          assert.equal(status, 200, JSON.stringify(body))
          assert.equal(body.results.length, 2)
          const resultA = body.results.find((r) => r.repoId === repoA.id)
          const resultB = body.results.find((r) => r.repoId === repoB.id)
          assert.equal(resultA.ok, true, JSON.stringify(resultA))
          assert.equal(typeof resultA.pullRequestId, 'number')
          assert.equal(resultB.ok, false)
          assert.ok(resultB.error, 'repo B reports its own failure rather than aborting the whole fan-out')

          // Persisted promotions reflect only the successful repo — a failed one isn't recorded as
          // if it succeeded.
          const { body: persisted } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
          assert.equal(persisted.promotions.length, 1)
          assert.equal(persisted.promotions[0].repoId, repoA.id)
        })
      })
    })
  })
)

// ---------- explicit Check, not polled ----------

test(
  'the explicit Check action re-reads a promotion Pull Request\'s status and reviewer votes from Azure DevOps',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-check-repo', validPat: VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })

      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-check-repo', baseUrl } }, { instancesDir })
        const { body: promoteBody } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoIds: [added.id] }),
        })
        const pullRequestId = promoteBody.results[0].pullRequestId
        assert.equal(promoteBody.results[0].review.state, 'pending')

        // Simulate the code owner casting an approval vote directly in Azure DevOps — this server
        // never polls for it; only an explicit Check call reads it.
        await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-check-repo/pullrequests/${pullRequestId}/reviewers/reviewer-1?api-version=7.1`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` },
            body: JSON.stringify({ vote: 10 }),
          }
        )

        // Before Check: the persisted record still shows the stale, pre-vote status.
        const { body: beforeCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(beforeCheck.promotions[0].review.state, 'pending')

        const { status, body: afterCheck } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions/check`, { method: 'POST' })
        assert.equal(status, 200)
        assert.equal(afterCheck.promotions[0].review.state, 'approved')

        // And it's persisted — a plain re-read (no Check) sees the same fresh state afterwards.
        const { body: rereadAfter } = await fetchJson(`${base}/api/definitions/widget-process/versions/1/promotions`)
        assert.equal(rereadAfter.promotions[0].review.state, 'approved')
      })
    })
  })
)

// ---------- guards ----------

test(
  'promoting a draft version, or a definition that is not a server-workspace one, is refused',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    seedServerWorkspaceDefinition(instancesDir, 'acme', 'widget-process', { title: 'Widget Process' })
    const workspaceDefinitionsDir = serverWorkspaceDefinitionsDir(instancesDir, 'acme')
    createBlankDefinition('draft-only', { definitionsDir: workspaceDefinitionsDir, title: 'Draft Only' })

    await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
      const added = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'unused-repo' } }, { instancesDir })

      const draftAttempt = await fetchJson(`${base}/api/definitions/draft-only/versions/1/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoIds: [added.id] }),
      })
      assert.equal(draftAttempt.status, 400)
      assert.match(draftAttempt.body.error, /published/)

      const libraryAttempt = await fetchJson(`${base}/api/definitions/design/versions/1/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoIds: [added.id] }),
      })
      assert.equal(libraryAttempt.status, 400)
      assert.match(libraryAttempt.body.error, /workspace/)
    })
  })
)

// ---------- the stateless local-workspace endpoint ----------

test(
  'POST /api/local/definitions/promote fans a client-supplied file set out to the selected repos, and persists nothing server-side',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-local-repo', validPat: VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-local-repo', baseUrl } }, { instancesDir })

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
        assert.equal(body.results.length, 1)
        assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]))

        const itemsRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-local-repo/items?path=${encodeURIComponent('/definitions/local-widget/1/definition.yaml')}&versionDescriptor.version=definition%2Flocal-widget-v1&versionDescriptor.versionType=branch&api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(itemsRes.status, 200)

        // Nothing server-side to read back — no `definitions/` folder for "local-widget" exists
        // anywhere under instancesDir, proving this route persisted nothing of its own.
        assert.equal(existsSync(join(instancesDir, 'local-widget')), false)
      })
    })
  })
)

test(
  'POST /api/local/definitions/promote refuses a caller-supplied file set whose definition.yaml is not published, without touching any repo',
  withScratchDirs(async (definitionsDir, instancesDir) => {
    await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: 'promote-local-draft-repo', validPat: VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
      await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
        const added = addLibraryRepo({ location: { organization: ORGANIZATION, project: PROJECT, repository: 'promote-local-draft-repo', baseUrl } }, { instancesDir })

        const draftFiles = [
          { path: 'definition.yaml', content: 'id: local-draft\nversion: 1\nstatus: draft\ntitle: Local Draft\n', contentType: 'rawtext' },
        ]
        const draftAttempt = await fetchJson(`${base}/api/local/definitions/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'local-draft', version: 1, files: draftFiles, repoIds: [added.id] }),
        })
        assert.equal(draftAttempt.status, 400)
        assert.match(draftAttempt.body.error, /published/)

        const missingDefinitionYamlAttempt = await fetchJson(`${base}/api/local/definitions/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'local-draft', version: 1, files: [{ path: 'CHANGELOG.md', content: '## v1\n', contentType: 'rawtext' }], repoIds: [added.id] }),
        })
        assert.equal(missingDefinitionYamlAttempt.status, 400)
        assert.match(missingDefinitionYamlAttempt.body.error, /definition\.yaml/)

        // Neither refused attempt reached the fan-out — no `definition/...` branch was ever
        // created against the configured repo (only the repo's own pre-existing `main`).
        const branchesRes = await fetch(
          `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/promote-local-draft-repo/refs?api-version=7.1`,
          { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } }
        )
        assert.equal(branchesRes.status, 200)
        const branches = await branchesRes.json()
        assert.deepEqual(branches.value.map((b) => b.name).filter((name) => name.startsWith('refs/heads/definition')), [])
      })
    })
  })
)
