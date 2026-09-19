import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { withRunningServer, basicAuthHeader, VALID_PAT } from './helpers/lifecycle.js'

// #24: generalizes lib/server.js's provider dispatch from a binary `provider === 'github' ? ... :
// <assume azure-devops>` (or `githubLocation ? 'github' : 'azure-devops'`) to genuine N-way routing —
// this suite proves each fixed call site correctly reports a third, validated-but-not-yet-registered
// provider (GitLab, ADR-0041 — `gitlab` is a real `assertValidProvider`-accepted provider as of this
// ticket, with no registered capability of its own yet) as unsupported, rather than silently running
// Azure DevOps's own logic against a GitLab-shaped location/body.

function withScratchServer(serverOptions, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir, ...serverOptions }, (base) => fn(base, instancesDir)).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

// ---------- /api/workspaces/:workspaceId/definitions* (rejectUnlessAzureDevOpsWorkspace) ----------

test('GET /api/workspaces/:id/definitions on a GitLab workspace reports 400 "not supported yet", not Azure DevOps behaviour', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ provider: 'gitlab', location: { namespace: 'group/subgroup', repository: 'repo' }, owner: '' }, { instancesDir })

    const res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet for provider "gitlab"/)
  })
})

test('POST /api/workspaces/:id/definitions on a GitLab workspace reports 400 "not supported yet"', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ provider: 'gitlab', location: { namespace: 'group', repository: 'repo' }, owner: '' }, { instancesDir })

    const res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId: 'gl-process' }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet for provider "gitlab"/)
  })
})

test('GET /api/workspaces/:id/definitions/:id/versions/:v on a GitLab workspace reports 400 "not supported yet"', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ provider: 'gitlab', location: { namespace: 'group', repository: 'repo' }, owner: '' }, { instancesDir })

    const res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/design/versions/1`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet for provider "gitlab"/)
  })
})

test('POST /api/workspaces/:id/definitions/:id/versions/:v/publish on a GitLab workspace reports 400 "not supported yet"', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ provider: 'gitlab', location: { namespace: 'group', repository: 'repo' }, owner: '' }, { instancesDir })

    const res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/design/versions/1/publish`, { method: 'POST' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet for provider "gitlab"/)
  })
})

test('POST /api/workspaces/:id/definitions/:id/archive on a GitLab workspace reports 400 "not supported yet"', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    const workspace = registerWorkspace({ provider: 'gitlab', location: { namespace: 'group', repository: 'repo' }, owner: '' }, { instancesDir })

    const res = await fetch(`${base}/api/workspaces/${workspace.id}/definitions/design/archive`, { method: 'POST' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet for provider "gitlab"/)
  })
})

// ---------- POST /api/instance/work-items/link ----------

// #30 gave GitLab its own work-items linker (a dedicated `gitlab` branch, mirroring `github`'s), so
// this dispatch-guard test now names a provider gantry genuinely has no linker for at all, keeping its
// original intent: a declared-but-unregistered provider must report 400 clearly, never fall through to
// Azure DevOps's own field validation.
test('POST /api/instance/work-items/link with a declared but unsupported provider reports 400, rather than Azure DevOps\'s own missing-field validation', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    const res = await fetch(`${base}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ provider: 'atlassian', namespace: 'group', repository: 'repo', parentId: 1 }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /"atlassian" work item is not supported yet/)
  })
})

// ---------- GET /api/identities ----------

test('GET /api/identities?provider=gitlab reports 400 "not supported yet" rather than silently falling through to the Azure DevOps/first-workspace default', async () => {
  await withScratchServer({}, async (base) => {
    const res = await fetch(`${base}/api/identities?q=someone&provider=gitlab`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not supported yet for provider "gitlab"/)
  })
})
