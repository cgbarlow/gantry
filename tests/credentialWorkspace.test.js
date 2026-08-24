import { test } from 'node:test'
import assert from 'node:assert/strict'

// The client-side credential store's workspace-keyed generalization (#104): a global default PAT (unchanged behavior from before this ticket) plus per-workspace overrides that take precedence over it. `web/lib/credential.js` is plain ESM with no DOM dependency beyond a guarded `localStorage` access (absent under plain `node --test`, exactly like `web/lib/validateRepo.js`'s own direct-import unit tests) — so its deterministic resolution logic is covered directly here, with the reactive PAT-prompt/Settings-UI integration left to tests/patPrompt.playwright.test.js and tests/settings.playwright.test.js, which need a real browser.
//
// `credential.js` holds module-level signal state, so each test imports it fresh (a new module instance, via a cache-busting query string) rather than sharing state across tests in this file.
async function freshCredentialModule() {
  return import(`../web/lib/credential.js?t=${Math.random()}`)
}

test('patForWorkspace falls back to the global default when no workspace-specific override is set', async () => {
  const { setPat, patForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  assert.equal(patForWorkspace('workspace-a'), 'global-default-pat')
  // A falsy workspaceId (a local instance, or no workspace context at all) resolves the same way.
  assert.equal(patForWorkspace(null), 'global-default-pat')
  assert.equal(patForWorkspace(undefined), 'global-default-pat')
})

test('patForWorkspace prefers a workspace-specific override over the global default', async () => {
  const { setPat, setWorkspacePatOverride, patForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'workspace-a-override-pat')

  assert.equal(patForWorkspace('workspace-a'), 'workspace-a-override-pat')
  // A different workspace with no override of its own is unaffected.
  assert.equal(patForWorkspace('workspace-b'), 'global-default-pat')
})

test('clearing a workspace override falls back to the global default automatically', async () => {
  const { setPat, setWorkspacePatOverride, clearWorkspacePatOverride, patForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'workspace-a-override-pat')
  assert.equal(patForWorkspace('workspace-a'), 'workspace-a-override-pat')

  clearWorkspacePatOverride('workspace-a')
  assert.equal(patForWorkspace('workspace-a'), 'global-default-pat')
})

test('hasWorkspacePatOverride reports true only once an override is actually set for that workspace', async () => {
  const { setWorkspacePatOverride, clearWorkspacePatOverride, hasWorkspacePatOverride } = await freshCredentialModule()
  assert.equal(hasWorkspacePatOverride('workspace-a'), false)

  setWorkspacePatOverride('workspace-a', 'override-pat')
  assert.equal(hasWorkspacePatOverride('workspace-a'), true)
  // Unrelated workspace, unaffected.
  assert.equal(hasWorkspacePatOverride('workspace-b'), false)

  clearWorkspacePatOverride('workspace-a')
  assert.equal(hasWorkspacePatOverride('workspace-a'), false)
})

test('hasWorkspacePatOverride is false for a falsy workspaceId and for the "default" key itself', async () => {
  const { setPat, hasWorkspacePatOverride } = await freshCredentialModule()
  setPat('global-default-pat')
  assert.equal(hasWorkspacePatOverride(null), false)
  assert.equal(hasWorkspacePatOverride(undefined), false)
  assert.equal(hasWorkspacePatOverride('default'), false)
})

test('setWorkspacePatOverride/clearWorkspacePatOverride are no-ops for a falsy workspaceId or the "default" key', async () => {
  const { setPat, setWorkspacePatOverride, patForWorkspace, hasWorkspacePatOverride } = await freshCredentialModule()
  setPat('global-default-pat')

  setWorkspacePatOverride(null, 'should-not-apply')
  setWorkspacePatOverride(undefined, 'should-not-apply')
  setWorkspacePatOverride('default', 'should-not-override-the-global-default-directly')

  assert.equal(patForWorkspace(null), 'global-default-pat')
  assert.equal(hasWorkspacePatOverride('default'), false)
})

test('setWorkspacePatOverride with a blank value clears any existing override, same as clearWorkspacePatOverride', async () => {
  const { setPat, setWorkspacePatOverride, patForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'override-pat')
  assert.equal(patForWorkspace('workspace-a'), 'override-pat')

  setWorkspacePatOverride('workspace-a', '   ')
  assert.equal(patForWorkspace('workspace-a'), 'global-default-pat')
})

test('authHeaderForWorkspace encodes whichever PAT resolves (override or default) as HTTP Basic auth', async () => {
  const { setPat, setWorkspacePatOverride, authHeaderForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'override-pat')

  assert.equal(authHeaderForWorkspace('workspace-a'), `Basic ${Buffer.from(':override-pat', 'utf8').toString('base64')}`)
  assert.equal(authHeaderForWorkspace('workspace-b'), `Basic ${Buffer.from(':global-default-pat', 'utf8').toString('base64')}`)
  assert.equal(authHeaderForWorkspace(null), `Basic ${Buffer.from(':global-default-pat', 'utf8').toString('base64')}`)
})

test('authHeaderForWorkspace returns null when nothing resolves at all (no default, no override)', async () => {
  const { authHeaderForWorkspace } = await freshCredentialModule()
  assert.equal(authHeaderForWorkspace('workspace-a'), null)
  assert.equal(authHeaderForWorkspace(null), null)
})

test('authHeader() (the legacy, workspace-unaware entry point) still resolves the global default only', async () => {
  const { setPat, setWorkspacePatOverride, authHeader } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'override-pat')

  assert.equal(authHeader(), `Basic ${Buffer.from(':global-default-pat', 'utf8').toString('base64')}`)
})

test('clearPat clears only the global default, leaving workspace overrides untouched', async () => {
  const { setPat, clearPat, setWorkspacePatOverride, patForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'override-pat')

  clearPat()
  assert.equal(patForWorkspace('workspace-a'), 'override-pat')
  assert.equal(patForWorkspace('workspace-b'), null)
})

// ---------- requestPat/resolvePromptWith: workspace-aware prompt resolution ----------
// A review pass on #104 flagged the original version of this orchestration as entirely workspace-unaware: whatever the architect submitted always became the global default, even when the 401 that triggered the prompt came from a workspace whose *own* override was the thing actually rejected — silently leaving that stale override in place and dooming the very next retry to fail the same way. These tests exercise the fix directly against the module's real signal state (no browser needed).

test('requestPat/resolvePromptWith: repairs an existing workspace override, rather than creating/overwriting the global default, when that override is what the prompt was opened for', async () => {
  const { setPat, setWorkspacePatOverride, requestPat, resolvePromptWith, patForWorkspace } = await freshCredentialModule()
  setPat('global-default-pat')
  setWorkspacePatOverride('workspace-a', 'stale-override-pat')

  const granted = requestPat('workspace-a')
  resolvePromptWith('fresh-override-pat')
  assert.equal(await granted, true)

  // The override was repaired in place...
  assert.equal(patForWorkspace('workspace-a'), 'fresh-override-pat')
  // ...and the global default (and any other workspace) is untouched.
  assert.equal(patForWorkspace('workspace-b'), 'global-default-pat')
})

test('requestPat/resolvePromptWith: sets the global default (not a new override) when the target workspace has no override of its own yet — the common case', async () => {
  const { requestPat, resolvePromptWith, patForWorkspace, hasWorkspacePatOverride } = await freshCredentialModule()

  // No PAT at all yet for workspace-a — the same "first-time setup" case every pre-#104 test already exercised.
  const granted = requestPat('workspace-a')
  resolvePromptWith('brand-new-pat')
  assert.equal(await granted, true)

  assert.equal(patForWorkspace('workspace-a'), 'brand-new-pat')
  // Became the *global* default, not a workspace-specific override — every other workspace sees it too, and workspace-a has no override of its own recorded.
  assert.equal(patForWorkspace('workspace-b'), 'brand-new-pat')
  assert.equal(hasWorkspacePatOverride('workspace-a'), false)
})

test('requestPat/resolvePromptWith: a falsy/omitted workspaceId still sets the global default, unchanged from before workspace overrides existed', async () => {
  const { requestPat, resolvePromptWith, pat } = await freshCredentialModule()

  const granted = requestPat()
  resolvePromptWith('plain-pat')
  assert.equal(await granted, true)
  assert.equal(pat.value, 'plain-pat')
})

test('requestPat/resolvePromptWith: cancelling (no patValue) writes nothing, whether or not the target workspace has an override', async () => {
  const { setWorkspacePatOverride, requestPat, resolvePromptWith, patForWorkspace, hasWorkspacePatOverride } = await freshCredentialModule()
  setWorkspacePatOverride('workspace-a', 'existing-override-pat')

  const granted = requestPat('workspace-a')
  resolvePromptWith(null)
  assert.equal(await granted, false)

  assert.equal(patForWorkspace('workspace-a'), 'existing-override-pat')
  assert.equal(hasWorkspacePatOverride('workspace-a'), true)
})

test('requestPat: concurrent callers share the single in-flight prompt, resolved once — the second caller\'s own workspaceId does not retroactively change where the first caller\'s prompt writes', async () => {
  const { setWorkspacePatOverride, requestPat, resolvePromptWith, patForWorkspace } = await freshCredentialModule()
  setWorkspacePatOverride('workspace-a', 'stale-override-pat')

  // First caller opens the prompt for workspace-a (which has an override).
  const firstGranted = requestPat('workspace-a')
  // A second, concurrent caller for a *different* workspace (no override of its own) joins the same already-open prompt rather than opening a second one — exactly the existing (pre-#104) sharing behavior.
  const secondGranted = requestPat('workspace-b')

  resolvePromptWith('shared-pat')
  assert.equal(await firstGranted, true)
  assert.equal(await secondGranted, true)

  // The submission was applied once, to whichever slot the *first* caller (the one that actually opened the prompt) determined — workspace-a's pre-existing override, not workspace-b (which never gets its own override created just by having called requestPat while a prompt was already open).
  assert.equal(patForWorkspace('workspace-a'), 'shared-pat')
  assert.equal(patForWorkspace('workspace-b'), null)
})
