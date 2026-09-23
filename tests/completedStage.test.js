import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { withRunningServerForProvider, withScratchInstances, basicAuthHeader } from './helpers/lifecycle.js'

// #142: a completed Stage — one the instance has already advanced past — must say so (naming where a
// sibling Stage's unmerged changes to a shared Module actually live), and must never let a save
// recreate its already-merged-and-cleaned-up branch. `design`'s `background` Module is exactly the
// real-world case the issue describes: mounted at both `shape` (SOAP) and `hld-define` (HLD),
// filled in progressively — see definitions/design/2/modules/background.yaml's own doc comment.
const DEFINITION = 'design'
const definition = loadDefinition(DEFINITION)
const [SHAPE, HLD_DEFINE] = definition.stages
const SLUG = 'hire'

function putModules(base, auth, query, modules) {
  return fetch(`${base}/api/instance/modules?${new URLSearchParams(query)}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modules }),
  })
}

function putModule(base, auth, moduleId, query, body) {
  return fetch(`${base}/api/instance/modules/${moduleId}?${new URLSearchParams(query)}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getInstance(base, auth, query) {
  return fetch(`${base}/api/instance?${new URLSearchParams(query)}`, { headers: auth })
}

// Moves the instance straight to hld-define, on `main`, without ever creating shape's own stage
// branch — the refusal below must not depend on that branch having existed at all.
async function advanceToHldDefine(client, instancePath) {
  await client.writeFile(instancePath, `definition: design\nslug: ${SLUG}\nstage: hld-define\ndefinitionVersion: 2\n`, {
    message: 'advance to hld-define',
    branch: 'main',
  })
}

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    location: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
]

for (const { name, provider, serverOptions, location, client: clientFor } of PROVIDERS) {
  test(`${name}-backed: both module-write routes refuse a save aimed at a completed Stage, naming it and pointing at Re-open, and create no branch for it`, async () => {
    await withScratchInstances((instancesDir) =>
      withRunningServerForProvider(provider, { options: { instancesDir, ...serverOptions } }, async (ctx) => {
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        const created = await fetch(`${ctx.gantryBase}/api/instances`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: DEFINITION, slug: SLUG, ...location(ctx) }),
        })
        assert.equal(created.status, 201, await created.text())
        const client = clientFor(ctx)
        await advanceToHldDefine(client, `gantry-workspace/${SLUG}/instance.yaml`)

        const shapeBranch = stageBranchName(SLUG, SHAPE.id)
        assert.equal(await client.branchExists(shapeBranch), false, 'precondition: shape has no branch yet')

        const bulk = await putModules(ctx.gantryBase, auth, { slug: SLUG, stage: SHAPE.id }, { background: { fields: { problem: 'Sneaky.' } } })
        assert.equal(bulk.status, 400)
        assert.match((await bulk.json()).error, new RegExp(`Stage "${SHAPE.title}" \\(shape\\) is complete — it shows the approved version on main\\. Re-open it to make further edits\\.`))

        const single = await putModule(ctx.gantryBase, auth, 'background', { slug: SLUG, stage: SHAPE.id }, { fields: { problem: 'Sneaky.' } })
        assert.equal(single.status, 400)
        assert.match((await single.json()).error, new RegExp(`Stage "${SHAPE.title}" \\(shape\\) is complete.*Re-open it to make further edits\\.`))

        assert.equal(await client.branchExists(shapeBranch), false, 'a refused save creates no stage branch')
        assert.doesNotMatch(await client.getFileContent(`gantry-workspace/${SLUG}/modules/background.md`), /Sneaky/)

        // The instance's actual current Stage is entirely unaffected by the new check.
        const atCurrent = await putModule(ctx.gantryBase, auth, 'background', { slug: SLUG, stage: HLD_DEFINE.id }, { fields: { problem: 'Allowed at the current stage.' } })
        assert.equal(atCurrent.status, 200, await atCurrent.text())
      })
    )
  })

}

// ---------------------------------------------------------------------------
// POST /api/instance/work-items/sync — the same branch-recreation hazard, reachable via `gate`
// ---------------------------------------------------------------------------

// #142 code review: the two module-write routes above refuse a completed Stage before ever calling
// resolveStageBranch (the function that creates a stage's branch on demand), but work-items/sync
// resolved its own stage by an arbitrary `gate` id (the MCP `sync_work_item` tool's own `gate`
// parameter documents exactly this) and, unlike the two routes above, called resolveStageBranch too —
// so a sync naming a completed stage's gate could recreate its already-merged-and-deleted branch from
// a stale `main`, the exact hazard #142 exists to close, just via a route the issue never named. Fixed
// by making this route's own branch resolution read-only (`findStageBranch`, never creating a branch)
// — matching GET /api/instance/check's own read-only resolution just above it in lib/server.js — since
// this route only ever reads that stage's content to re-check its gate, never writes to it.
test('Azure DevOps-backed: POST /api/instance/work-items/sync never recreates a completed Stage\'s branch when `gate` names it', async () => {
  await withScratchInstances((instancesDir) =>
    withRunningServerForProvider('azure-devops', { options: { instancesDir, allowAzureDevOpsBaseUrlOverride: true } }, async (ctx) => {
      const auth = { Authorization: basicAuthHeader(ctx.pat) }
      const created = await fetch(`${ctx.gantryBase}/api/instances`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: DEFINITION, slug: SLUG, azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
      })
      assert.equal(created.status, 201, await created.text())
      const client = createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl })
      await advanceToHldDefine(client, `gantry-workspace/${SLUG}/instance.yaml`)

      const shapeBranch = stageBranchName(SLUG, SHAPE.id)
      assert.equal(await client.branchExists(shapeBranch), false, 'precondition: shape has no branch yet')

      // `gate` names shape's own gate — an earlier, completed Stage relative to the instance's actual
      // current Stage (hld-define).
      const res = await fetch(`${ctx.gantryBase}/api/instance/work-items/sync?slug=${SLUG}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gate: SHAPE.gate }),
      })
      // Shape's gate hasn't genuinely passed in this fixture (no modules filled in), so the request
      // itself still ends in a 400 — but whatever its own outcome, it must never have recreated
      // shape's branch along the way.
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /has not passed/)
      assert.equal(await client.branchExists(shapeBranch), false, "sync must never recreate a completed Stage's branch")
    })
  )
})

// ---------------------------------------------------------------------------
// GET /api/instance — the completed-stage label's own two facts
// ---------------------------------------------------------------------------

test('GET /api/instance (Azure DevOps): stageCompleted is false for the current Stage, true for one browsed after advancing past it', async () => {
  await withScratchInstances((instancesDir) =>
    withRunningServerForProvider('azure-devops', { options: { instancesDir, allowAzureDevOpsBaseUrlOverride: true } }, async (ctx) => {
      const auth = { Authorization: basicAuthHeader(ctx.pat) }
      const created = await fetch(`${ctx.gantryBase}/api/instances`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: DEFINITION, slug: SLUG, azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
      })
      assert.equal(created.status, 201, await created.text())

      const atShape = await getInstance(ctx.gantryBase, auth, { slug: SLUG, stage: SHAPE.id })
      assert.equal((await atShape.json()).stageCompleted, false)

      const client = createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl })
      await advanceToHldDefine(client, `gantry-workspace/${SLUG}/instance.yaml`)

      const completed = await getInstance(ctx.gantryBase, auth, { slug: SLUG, stage: SHAPE.id })
      const completedBody = await completed.json()
      assert.equal(completedBody.stageCompleted, true)
      assert.equal(completedBody.crossStageEdit, null, 'hld-define has no branch yet, so nothing to point at')

      const current = await getInstance(ctx.gantryBase, auth, { slug: SLUG, stage: HLD_DEFINE.id })
      assert.equal((await current.json()).stageCompleted, false)
    })
  )
})

test('GET /api/instance (Azure DevOps): once the current Stage edits a Module shared with the completed Stage being browsed, crossStageEdit names it', async () => {
  await withScratchInstances((instancesDir) =>
    withRunningServerForProvider('azure-devops', { options: { instancesDir, allowAzureDevOpsBaseUrlOverride: true } }, async (ctx) => {
      const auth = { Authorization: basicAuthHeader(ctx.pat) }
      const created = await fetch(`${ctx.gantryBase}/api/instances`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: DEFINITION, slug: SLUG, azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
      })
      assert.equal(created.status, 201, await created.text())
      const client = createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl })
      await advanceToHldDefine(client, `gantry-workspace/${SLUG}/instance.yaml`)

      // hld-define (the real current Stage) edits `background` — a Module shape (the completed Stage
      // being browsed) also mounts — on its own branch. Main's copy (shape's approved version) is
      // untouched.
      const edited = await putModule(ctx.gantryBase, auth, 'background', { slug: SLUG, stage: HLD_DEFINE.id }, { fields: { problem: 'Reworded during HLD review.' } })
      assert.equal(edited.status, 200, await edited.text())

      const body = await (await getInstance(ctx.gantryBase, auth, { slug: SLUG, stage: SHAPE.id })).json()
      assert.equal(body.stageCompleted, true)
      assert.deepEqual(body.crossStageEdit, { id: 'hld-define', title: HLD_DEFINE.title })
      // The completed Stage's own screen still reads main, not hld-define's branch.
      const background = body.modules.find((m) => m.id === 'background')
      assert.doesNotMatch(background.fields.find((f) => f.id === 'problem')?.value ?? '', /Reworded during HLD review/)
    })
  )
})
