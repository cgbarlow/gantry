import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { withRunningServer, basicAuthHeader, VALID_PAT } from './helpers/lifecycle.js'

// #24: generalizes lib/server.js's provider dispatch from a binary `provider === 'github' ? ... :
// <assume azure-devops>` (or `githubLocation ? 'github' : 'azure-devops'`) to genuine N-way routing —
// this suite proves each fixed call site correctly reports a third, validated-but-not-yet-registered
// provider (GitLab, ADR-0041 — `gitlab` is a real `assertValidProvider`-accepted provider as of this
// ticket) as unsupported, rather than silently running Azure DevOps's own logic against a
// GitLab-shaped location/body, for every call site GitLab doesn't have a registered capability for
// yet.
//
// The `/api/workspaces/:workspaceId/definitions*` family's own five "GitLab reports 400" cases that
// used to live here moved out once #32 gave GitLab its own definitions-home implementation —
// `rejectUnlessAzureDevOpsWorkspace` no longer rejects a `gitlab` workspace at all (every currently-
// supported provider now has its own branch ahead of that fallback); GitLab's definitions-home
// behaviour itself is covered end-to-end in tests/serverDefinitionEditorGitLab.test.js, the GitLab
// twin of tests/serverDefinitionEditorGitHub.test.js. The remaining two families below (work-item
// linking, identity lookup) are unaffected by #32 and still correctly report GitLab as unsupported.

function withScratchServer(serverOptions, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir, ...serverOptions }, (base) => fn(base, instancesDir)).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

// ---------- POST /api/instance/work-items/link ----------

test('POST /api/instance/work-items/link with a declared but unsupported provider reports 400, rather than Azure DevOps\'s own missing-field validation', async () => {
  await withScratchServer({}, async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    const res = await fetch(`${base}/api/instance/work-items/link?slug=my-initiative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ provider: 'gitlab', namespace: 'group', repository: 'repo', parentId: 1 }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /"gitlab" work item is not supported yet/)
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
