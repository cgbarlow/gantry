import { test } from 'node:test'
import assert from 'node:assert/strict'

// The client-side "advanced mode" toggle (#300): a localStorage-backed `@preact/signals` signal,
// default false, that later tickets (#301/#302) read to hide Azure DevOps / ticketing UI.
// `web/lib/advancedMode.js` is plain ESM with no DOM dependency beyond a guarded `localStorage`
// access (absent under plain `node --test`, exactly like web/lib/credential.js's own direct-import
// unit tests) — so its resolution logic is covered directly here, with the Settings-screen
// integration left to tests/settings.playwright.test.js, which needs a real browser.
//
// The module reads its stored value once at import time and holds module-level signal state, so
// each test imports it fresh (a new module instance, via a cache-busting query string) after
// arranging `globalThis.localStorage`.
async function freshModule() {
  return import(`../web/lib/advancedMode.js?t=${Math.random()}`)
}

function makeFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

test('advancedMode defaults to false when nothing is stored', async () => {
  delete globalThis.localStorage
  const { advancedMode } = await freshModule()
  assert.equal(advancedMode.value, false)
})

test('setAdvancedMode(true) updates the signal, persists it, and a fresh load reads it back', async () => {
  const storage = makeFakeStorage()
  globalThis.localStorage = storage
  try {
    const { advancedMode, setAdvancedMode } = await freshModule()
    assert.equal(advancedMode.value, false)

    setAdvancedMode(true)
    assert.equal(advancedMode.value, true)
    assert.equal(storage.getItem('gantry:advancedMode'), 'true')

    // A brand-new module instance reading the same storage sees the persisted value.
    const reloaded = await freshModule()
    assert.equal(reloaded.advancedMode.value, true)

    // ...and toggling back off persists false, not a removed key.
    reloaded.setAdvancedMode(false)
    assert.equal(reloaded.advancedMode.value, false)
    assert.equal(storage.getItem('gantry:advancedMode'), 'false')
  } finally {
    delete globalThis.localStorage
  }
})

test('setAdvancedMode coerces any truthy/falsy argument to a real boolean before persisting', async () => {
  const storage = makeFakeStorage()
  globalThis.localStorage = storage
  try {
    const { advancedMode, setAdvancedMode } = await freshModule()
    setAdvancedMode('yes')
    assert.strictEqual(advancedMode.value, true)
    assert.equal(storage.getItem('gantry:advancedMode'), 'true')
    setAdvancedMode(0)
    assert.strictEqual(advancedMode.value, false)
    assert.equal(storage.getItem('gantry:advancedMode'), 'false')
  } finally {
    delete globalThis.localStorage
  }
})

test('a corrupt / unparseable stored value yields false rather than throwing', async () => {
  globalThis.localStorage = makeFakeStorage({ 'gantry:advancedMode': 'not-json{{' })
  try {
    const { advancedMode } = await freshModule()
    assert.equal(advancedMode.value, false)
  } finally {
    delete globalThis.localStorage
  }
})

test('a stored value that parses to anything other than literal `true` yields false', async () => {
  for (const stored of ['false', '1', '0', 'null', '"true"', '{}']) {
    globalThis.localStorage = makeFakeStorage({ 'gantry:advancedMode': stored })
    try {
      const { advancedMode } = await freshModule()
      assert.equal(advancedMode.value, false, `stored ${stored} should read back as false`)
    } finally {
      delete globalThis.localStorage
    }
  }
})

test('a throwing localStorage yields false and does not crash, on read or on write', async () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error('SecurityError: storage is disabled')
    },
    setItem() {
      throw new Error('SecurityError: storage is disabled')
    },
    removeItem() {
      throw new Error('SecurityError: storage is disabled')
    },
  }
  try {
    const { advancedMode, setAdvancedMode } = await freshModule()
    assert.equal(advancedMode.value, false)
    assert.doesNotThrow(() => setAdvancedMode(true))
    // The signal still updates for the current session even though persistence silently failed.
    assert.equal(advancedMode.value, true)
  } finally {
    delete globalThis.localStorage
  }
})
