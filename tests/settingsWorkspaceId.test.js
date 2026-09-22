import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkspace, listWorkspaces } from '../lib/workspaceRegistry.js'
import { workspaceCredentialMapId } from '../web/pages/settings.js'
import { withScratchInstances } from './helpers/lifecycle.js'

// #116 — which workspaces Settings shows an id for. The id is the key `GANTRY_BOOTSTRAP_PATS` (#113)
// and the MCP server's `GANTRY_WORKSPACE_PATS` (ADR-0043) are both keyed by, so it only exists for a
// remote workspace — one with a registry record. A Local or server-directory workspace has no
// registry entry and needs no credential-map entry at all, and showing it a blank or invented id
// would mislead exactly the person who reads this: whoever is pasting a credential map into a hosting
// dashboard.
//
// The rendering itself (the copy control, its feedback, the surrounding copy) is browser behaviour,
// covered in tests/settings.playwright.test.js; what's asserted here is the decision that gates it.

test('a registered remote workspace shows the id its credential-map entry would be keyed by', async () => {
  await withScratchInstances((instancesDir) => {
    // A real registry record, not a hand-built literal: the id shown must be the one
    // `GANTRY_BOOTSTRAP_PATS`/`GANTRY_WORKSPACE_PATS` are actually keyed by, so this reads it back
    // through the same `listWorkspaces` the Settings screen's own `/api/workspaces` fetch serves.
    const registered = registerWorkspace(
      { provider: 'github', location: { owner: 'octocat', repository: 'fake-repo' }, owner: 'a.architect' },
      { instancesDir }
    )
    const [fromRegistry] = listWorkspaces({ instancesDir })

    assert.equal(workspaceCredentialMapId(fromRegistry), registered.id)
    assert.match(workspaceCredentialMapId(fromRegistry), /\S/)
  })
})

test('a Local / server-directory workspace shows no id — it has no registry record and needs no credential-map entry', () => {
  // Exactly the `workspace.json` record `LocalWorkspaceSettingsPage` renders (CONTEXT.md's "Workspace
  // location": `{ name, description?, kind: 'local', createdAt }`, shared by a browser-local folder
  // and a server workspace directory). No provider, no location, no id — and no empty-string id
  // either, which is the misleading field this guards against.
  const localWorkspace = { name: 'My initiative', kind: 'local', createdAt: '2026-09-22T00:00:00.000Z' }
  assert.equal(workspaceCredentialMapId(localWorkspace), null)
})

test('the flat per-instance workspace shape carries no id of its own and is never shown one', () => {
  // `lib/instanceRegistry.js`'s unrelated, still-flat `instance.workspace` (see `workspaceRepoUrl`'s
  // own doc comment, which serves both shapes) — no `provider`, no id.
  const flat = { kind: 'azureDevOps', organization: 'fake-org', project: 'fake-project', repository: 'fake-repo' }
  assert.equal(workspaceCredentialMapId(flat), null)
})

test('a record with a provider and location but no usable id shows nothing rather than an empty field', () => {
  const base = { provider: 'github', location: { owner: 'octocat', repository: 'fake-repo' } }
  assert.equal(workspaceCredentialMapId({ ...base }), null)
  assert.equal(workspaceCredentialMapId({ ...base, id: '' }), null)
  assert.equal(workspaceCredentialMapId({ ...base, id: '   ' }), null)
  assert.equal(workspaceCredentialMapId({ ...base, id: 42 }), null)
  assert.equal(workspaceCredentialMapId(null), null)
  assert.equal(workspaceCredentialMapId(undefined), null)
})
