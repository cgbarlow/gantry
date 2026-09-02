import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renderEngine, setRenderEngine, resetForTests } from '../web/lib/renderEngine.js'

// WI314 — the client-side render-engine toggle ('wasm' default / 'native'): a
// localStorage-backed `@preact/signals` signal, following the exact tested pattern
// tests/advancedMode.test.js already established for web/lib/advancedMode.js. Plain ESM, no
// DOM dependency beyond a guarded `localStorage` access, so covered directly here — the
// Settings-screen integration (the live pandoc-wasm status line) needs a real browser and
// lives in an e2e Playwright test instead.
//
// One static, top-level import shared by every test below. Each test sets up whatever
// `globalThis.localStorage` shape it needs, then calls the module's own `resetForTests()` —
// which re-reads `renderEngine`'s value from that storage, exactly what a fresh page load
// does — rather than a fresh dynamic `import()` per test (this file's earlier approach). See
// web/lib/pandocWasm.js's `resetForTests` doc comment for why: Node's
// `--experimental-test-coverage` reporter doesn't merge branch coverage across the distinct
// compiled-script instances a per-test dynamic re-import produces.
afterEach(() => {
  delete globalThis.localStorage
})

function makeFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

test('no localStorage at all: defaults to "wasm", and setRenderEngine both ignores an unrecognised value and updates in place (safeSetItem is a no-op with nothing to persist to)', () => {
  delete globalThis.localStorage
  resetForTests()
  assert.equal(renderEngine.value, 'wasm')

  setRenderEngine('quantum')
  assert.equal(renderEngine.value, 'wasm', 'an unrecognised value is ignored — the signal keeps its current value')

  setRenderEngine('native')
  assert.equal(renderEngine.value, 'native')
  setRenderEngine('wasm')
  assert.equal(renderEngine.value, 'wasm')
})

test('a valid stored value ("native") is read back on reset, and setRenderEngine persists every subsequent change — a later reset then sees the latest one', () => {
  const storage = makeFakeStorage({ 'gantry:renderEngine': 'native' })
  globalThis.localStorage = storage
  resetForTests()
  assert.equal(renderEngine.value, 'native', 'the pre-seeded valid value is read back')

  setRenderEngine('bogus')
  assert.equal(renderEngine.value, 'native', 'still ignored with a real localStorage present')

  setRenderEngine('wasm')
  assert.equal(renderEngine.value, 'wasm')
  assert.equal(storage.getItem('gantry:renderEngine'), 'wasm')

  // A later reset (standing in for "a fresh page load") reads the same storage's latest value.
  resetForTests()
  assert.equal(renderEngine.value, 'wasm')
})

test('a corrupt / unrecognised stored value yields the "wasm" default rather than throwing', () => {
  globalThis.localStorage = makeFakeStorage({ 'gantry:renderEngine': 'not-json{{' })
  resetForTests()
  assert.equal(renderEngine.value, 'wasm')
})

test('a throwing localStorage yields the default and does not crash, on read or on write', () => {
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
  resetForTests()
  assert.equal(renderEngine.value, 'wasm')
  assert.doesNotThrow(() => setRenderEngine('native'))
  // The signal still updates for the current session even though persistence silently failed.
  assert.equal(renderEngine.value, 'native')
})
