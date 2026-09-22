import { test } from 'node:test'
import assert from 'node:assert/strict'

// #126 (parent #109, docs/adr/0047): the new per-workspace "has this credential been confirmed to
// write here" state web/lib/credential.js grows for this ticket — genuinely different from both
// "is a credential stored" (`hasPatForWorkspace`) and "did the Provider reject it"
// (`credentialStatusForWorkspace`). Mirrors tests/credentialWorkspace.test.js's own cache-busted
// fresh-module-per-test convention, for the same reason: this module holds signal state at module
// scope.
async function freshCredentialModule() {
  return import(`../web/lib/credential.js?t=${Math.random()}`)
}

test('hasCheckedWriteAccess/hasConfirmedWriteAccess: unset until a check result is recorded', async () => {
  const { hasCheckedWriteAccess, hasConfirmedWriteAccess } = await freshCredentialModule()
  assert.equal(hasCheckedWriteAccess('workspace-a'), false)
  assert.equal(hasConfirmedWriteAccess('workspace-a'), false)
})

test('setWriteAccessForWorkspace(true) is both checked and confirmed; (false) is checked but not confirmed', async () => {
  const { setWriteAccessForWorkspace, hasCheckedWriteAccess, hasConfirmedWriteAccess } = await freshCredentialModule()

  setWriteAccessForWorkspace('workspace-a', true)
  assert.equal(hasCheckedWriteAccess('workspace-a'), true)
  assert.equal(hasConfirmedWriteAccess('workspace-a'), true)

  setWriteAccessForWorkspace('workspace-b', false)
  assert.equal(hasCheckedWriteAccess('workspace-b'), true)
  assert.equal(hasConfirmedWriteAccess('workspace-b'), false)

  // A read-only-confirmed workspace stays distinguishable from a never-checked one — both report
  // `hasConfirmedWriteAccess === false`, but only the checked one reports `hasCheckedWriteAccess === true`.
  assert.equal(hasCheckedWriteAccess('workspace-c'), false)
  assert.equal(hasConfirmedWriteAccess('workspace-c'), false)
})

test('hasCheckedWriteAccess/hasConfirmedWriteAccess are false for a falsy workspaceId', async () => {
  const { setWriteAccessForWorkspace, hasCheckedWriteAccess, hasConfirmedWriteAccess } = await freshCredentialModule()
  setWriteAccessForWorkspace('workspace-a', true)

  assert.equal(hasCheckedWriteAccess(null), false)
  assert.equal(hasConfirmedWriteAccess(null), false)
  assert.equal(hasCheckedWriteAccess(undefined), false)
  assert.equal(hasConfirmedWriteAccess(undefined), false)
})

test('setWriteAccessForWorkspace is a no-op for a falsy workspaceId', async () => {
  const { setWriteAccessForWorkspace, hasCheckedWriteAccess } = await freshCredentialModule()
  setWriteAccessForWorkspace(null, true)
  setWriteAccessForWorkspace(undefined, true)
  assert.equal(hasCheckedWriteAccess(null), false)
})

test('setPatForWorkspace (a NEW credential) clears any prior write-access answer for that workspace — a new credential always gets a fresh check', async () => {
  const { setPatForWorkspace, setWriteAccessForWorkspace, hasCheckedWriteAccess, hasConfirmedWriteAccess } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'first-pat')
  setWriteAccessForWorkspace('workspace-a', true)
  assert.equal(hasConfirmedWriteAccess('workspace-a'), true)

  // A different credential is entered for the same workspace — the old answer must not silently
  // keep gating the interface as if it still applied to this new, unverified credential.
  setPatForWorkspace('workspace-a', 'second-pat')
  assert.equal(hasCheckedWriteAccess('workspace-a'), false)
  assert.equal(hasConfirmedWriteAccess('workspace-a'), false)
})

test('clearPatForWorkspace clears any recorded write-access answer along with the credential itself', async () => {
  const { setPatForWorkspace, clearPatForWorkspace, setWriteAccessForWorkspace, hasCheckedWriteAccess } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')
  setWriteAccessForWorkspace('workspace-a', true)

  clearPatForWorkspace('workspace-a')
  assert.equal(hasCheckedWriteAccess('workspace-a'), false)
})

test('markCredentialRejected clears any recorded write-access answer — "rejected" and "confirmed read-only" never overlap', async () => {
  const { setPatForWorkspace, setWriteAccessForWorkspace, markCredentialRejected, hasCheckedWriteAccess, hasConfirmedWriteAccess, credentialStatusForWorkspace } =
    await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')
  setWriteAccessForWorkspace('workspace-a', true)

  markCredentialRejected('workspace-a')

  assert.equal(credentialStatusForWorkspace('workspace-a'), 'rejected')
  assert.equal(hasCheckedWriteAccess('workspace-a'), false)
  assert.equal(hasConfirmedWriteAccess('workspace-a'), false)
})

test('write-access state for one workspace never leaks onto another', async () => {
  const { setPatForWorkspace, setWriteAccessForWorkspace, hasConfirmedWriteAccess } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')
  setPatForWorkspace('workspace-b', 'b-pat')
  setWriteAccessForWorkspace('workspace-a', true)
  setWriteAccessForWorkspace('workspace-b', false)

  assert.equal(hasConfirmedWriteAccess('workspace-a'), true)
  assert.equal(hasConfirmedWriteAccess('workspace-b'), false)
})
