import { test } from 'node:test'
import assert from 'node:assert/strict'

// The client-side credential store (#9, ADR-0038): every workspace holds its own PAT; there is no
// global default and no fallback. `web/lib/credential.js` is plain ESM with no DOM dependency beyond a
// guarded `localStorage` access (absent under plain `node --test`, exactly like
// `web/lib/validateRepo.js`'s own direct-import unit tests) — so its deterministic resolution logic is
// covered directly here, with the reactive PAT-prompt/Settings-UI integration left to
// tests/patPrompt.playwright.test.js and tests/settings.playwright.test.js, which need a real browser.
//
// `credential.js` holds module-level signal state, so each test imports it fresh (a new module instance, via a cache-busting query string) rather than sharing state across tests in this file.
async function freshCredentialModule() {
  return import(`../web/lib/credential.js?t=${Math.random()}`)
}

test('patForWorkspace resolves only a workspace\'s own stored PAT — no fallback of any kind', async () => {
  const { setPatForWorkspace, patForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'workspace-a-pat')

  assert.equal(patForWorkspace('workspace-a'), 'workspace-a-pat')
  // A different workspace with nothing stored for it resolves to null, not some other workspace's PAT.
  assert.equal(patForWorkspace('workspace-b'), null)
})

test('patForWorkspace returns null for a falsy workspaceId — there is no global default to fall back to', async () => {
  const { setPatForWorkspace, patForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'workspace-a-pat')

  assert.equal(patForWorkspace(null), null)
  assert.equal(patForWorkspace(undefined), null)
  assert.equal(patForWorkspace(''), null)
})

test('hasPatForWorkspace reports true only once a PAT is actually set for that workspace', async () => {
  const { setPatForWorkspace, clearPatForWorkspace, hasPatForWorkspace } = await freshCredentialModule()
  assert.equal(hasPatForWorkspace('workspace-a'), false)

  setPatForWorkspace('workspace-a', 'a-pat')
  assert.equal(hasPatForWorkspace('workspace-a'), true)
  // Unrelated workspace, unaffected.
  assert.equal(hasPatForWorkspace('workspace-b'), false)

  clearPatForWorkspace('workspace-a')
  assert.equal(hasPatForWorkspace('workspace-a'), false)
})

test('hasPatForWorkspace is false for a falsy workspaceId', async () => {
  const { hasPatForWorkspace } = await freshCredentialModule()
  assert.equal(hasPatForWorkspace(null), false)
  assert.equal(hasPatForWorkspace(undefined), false)
})

test('setPatForWorkspace/clearPatForWorkspace are no-ops for a falsy workspaceId — there is no slot to write to', async () => {
  const { setPatForWorkspace, patForWorkspace, hasPatForWorkspace } = await freshCredentialModule()

  setPatForWorkspace(null, 'should-not-apply')
  setPatForWorkspace(undefined, 'should-not-apply')

  assert.equal(patForWorkspace(null), null)
  assert.equal(hasPatForWorkspace(null), false)
})

test('setPatForWorkspace with a blank value clears any existing PAT, same as clearPatForWorkspace', async () => {
  const { setPatForWorkspace, patForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')
  assert.equal(patForWorkspace('workspace-a'), 'a-pat')

  setPatForWorkspace('workspace-a', '   ')
  assert.equal(patForWorkspace('workspace-a'), null)
})

test('authHeaderForWorkspace encodes a workspace\'s own PAT as HTTP Basic auth', async () => {
  const { setPatForWorkspace, authHeaderForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')

  assert.equal(authHeaderForWorkspace('workspace-a'), `Basic ${Buffer.from(':a-pat', 'utf8').toString('base64')}`)
  assert.equal(authHeaderForWorkspace('workspace-b'), null)
  assert.equal(authHeaderForWorkspace(null), null)
})

test('basicAuthHeaderForValue encodes an arbitrary, not-yet-stored PAT the same way — the wizard\'s own no-workspace-yet registration call', async () => {
  const { basicAuthHeaderForValue } = await freshCredentialModule()
  assert.equal(basicAuthHeaderForValue('freshly-typed-pat'), `Basic ${Buffer.from(':freshly-typed-pat', 'utf8').toString('base64')}`)
  assert.equal(basicAuthHeaderForValue(''), null)
  assert.equal(basicAuthHeaderForValue(null), null)
})

test('clearPatForWorkspace clears only the named workspace, leaving others untouched', async () => {
  const { setPatForWorkspace, clearPatForWorkspace, patForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')
  setPatForWorkspace('workspace-b', 'b-pat')

  clearPatForWorkspace('workspace-a')
  assert.equal(patForWorkspace('workspace-a'), null)
  assert.equal(patForWorkspace('workspace-b'), 'b-pat')
})

test('credentialStatusForWorkspace reports missing/set/rejected per workspace, independently', async () => {
  const { setPatForWorkspace, markCredentialRejected, credentialStatusForWorkspace } = await freshCredentialModule()
  assert.equal(credentialStatusForWorkspace('workspace-a'), 'missing')

  setPatForWorkspace('workspace-a', 'a-pat')
  assert.equal(credentialStatusForWorkspace('workspace-a'), 'set')
  assert.equal(credentialStatusForWorkspace('workspace-b'), 'missing')

  markCredentialRejected('workspace-a')
  assert.equal(credentialStatusForWorkspace('workspace-a'), 'rejected')
  assert.equal(credentialStatusForWorkspace('workspace-b'), 'missing')
})

test('setPatForWorkspace after a rejection clears that rejection', async () => {
  const { setPatForWorkspace, markCredentialRejected, credentialStatusForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'a-pat')
  markCredentialRejected('workspace-a')
  assert.equal(credentialStatusForWorkspace('workspace-a'), 'rejected')

  setPatForWorkspace('workspace-a', 'a-new-pat')
  assert.equal(credentialStatusForWorkspace('workspace-a'), 'set')
})

// ---------- requestPat/resolvePromptWith: workspace-scoped prompt resolution ----------

test('requestPat/resolvePromptWith: writes the submitted PAT to the workspace the prompt was opened for', async () => {
  const { requestPat, resolvePromptWith, patForWorkspace } = await freshCredentialModule()

  const granted = requestPat('workspace-a')
  resolvePromptWith('fresh-pat')
  assert.equal(await granted, true)

  assert.equal(patForWorkspace('workspace-a'), 'fresh-pat')
  // No other workspace is affected.
  assert.equal(patForWorkspace('workspace-b'), null)
})

test('requestPat/resolvePromptWith: cancelling (no patValue) writes nothing', async () => {
  const { setPatForWorkspace, requestPat, resolvePromptWith, patForWorkspace } = await freshCredentialModule()
  setPatForWorkspace('workspace-a', 'existing-pat')

  const granted = requestPat('workspace-a')
  resolvePromptWith(null)
  assert.equal(await granted, false)

  assert.equal(patForWorkspace('workspace-a'), 'existing-pat')
})

test('requestPat: concurrent callers share the single in-flight prompt, resolved once against the first caller\'s own workspace', async () => {
  const { requestPat, resolvePromptWith, patForWorkspace } = await freshCredentialModule()

  // First caller opens the prompt for workspace-a.
  const firstGranted = requestPat('workspace-a')
  // A second, concurrent caller for a *different* workspace joins the same already-open prompt rather than opening a second one.
  const secondGranted = requestPat('workspace-b')

  resolvePromptWith('shared-pat')
  assert.equal(await firstGranted, true)
  assert.equal(await secondGranted, true)

  // The submission was applied once, to whichever workspace the *first* caller (the one that actually opened the prompt) named — not workspace-b, which never gets a PAT of its own just by having called requestPat while a prompt was already open.
  assert.equal(patForWorkspace('workspace-a'), 'shared-pat')
  assert.equal(patForWorkspace('workspace-b'), null)
})

// ---------- migrateGlobalPatToWorkspaces: the one-shot #9 migration ----------
// Exercises the migration against the module's real `localStorage` shim rather than the in-memory
// signal alone, since the whole point is the legacy `gantry:ado-pat` key's own on-disk lifecycle
// (present beforehand, gone afterward) — `globalThis.localStorage` is stubbed per test rather than
// relying on one being present under plain `node --test` (mirrors web/lib/theme.js's own guarded
// access pattern this module's safeGetItem/safeSetItem build on).
function fakeLocalStorage(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  }
}

test('migrateGlobalPatToWorkspaces fans a stored legacy global PAT out to every given workspace id, then deletes it', async () => {
  const originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = fakeLocalStorage({ 'gantry:ado-pat': 'legacy-global-pat' })
  try {
    const { migrateGlobalPatToWorkspaces, patForWorkspace } = await freshCredentialModule()
    migrateGlobalPatToWorkspaces(['workspace-a', 'workspace-b'])

    assert.equal(patForWorkspace('workspace-a'), 'legacy-global-pat')
    assert.equal(patForWorkspace('workspace-b'), 'legacy-global-pat')
    assert.equal(globalThis.localStorage.getItem('gantry:ado-pat'), null)
  } finally {
    globalThis.localStorage = originalLocalStorage
  }
})

test('migrateGlobalPatToWorkspaces leaves an existing per-workspace PAT untouched', async () => {
  const originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = fakeLocalStorage({ 'gantry:ado-pat': 'legacy-global-pat' })
  try {
    const { migrateGlobalPatToWorkspaces, setPatForWorkspace, patForWorkspace } = await freshCredentialModule()
    setPatForWorkspace('workspace-a', 'already-set-pat')

    migrateGlobalPatToWorkspaces(['workspace-a', 'workspace-b'])

    assert.equal(patForWorkspace('workspace-a'), 'already-set-pat')
    assert.equal(patForWorkspace('workspace-b'), 'legacy-global-pat')
  } finally {
    globalThis.localStorage = originalLocalStorage
  }
})

test('migrateGlobalPatToWorkspaces is a no-op when no legacy global PAT was ever stored', async () => {
  const originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = fakeLocalStorage({})
  try {
    const { migrateGlobalPatToWorkspaces, patForWorkspace } = await freshCredentialModule()
    migrateGlobalPatToWorkspaces(['workspace-a'])

    assert.equal(patForWorkspace('workspace-a'), null)
  } finally {
    globalThis.localStorage = originalLocalStorage
  }
})

test('migrateGlobalPatToWorkspaces still deletes the legacy key even with no workspaces registered yet', async () => {
  const originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = fakeLocalStorage({ 'gantry:ado-pat': 'legacy-global-pat' })
  try {
    const { migrateGlobalPatToWorkspaces } = await freshCredentialModule()
    migrateGlobalPatToWorkspaces([])

    assert.equal(globalThis.localStorage.getItem('gantry:ado-pat'), null)
  } finally {
    globalThis.localStorage = originalLocalStorage
  }
})
