import { signal } from '@preact/signals'

// WI314 — client-side, cross-screen "which Pandoc render engine to use" choice, a
// `@preact/signals` signal backed by localStorage, following the exact pattern
// web/lib/advancedMode.js and web/lib/theme.js already established for a persisted,
// cross-screen preference.
//
// `'wasm'` (the client-side pandoc-wasm module, web/lib/pandocWasm.js) is the default —
// no server round-trip for the conversion itself, both for local workspaces and
// Azure-DevOps-hosted instances. `'native'` routes every render through the existing
// server-side `pandoc` subprocess (`POST /api/local/render` / the Azure-DevOps-hosted
// two-push flow), exactly as gantry rendered before this ticket — kept as a permanent,
// explicit, user-selectable alternative, not a deprecated fallback. Global Settings
// (web/pages/settings.js) is the only place this is changed.
const STORAGE_KEY = 'gantry:renderEngine'
const ENGINES = new Set(['wasm', 'native'])

// `localStorage` can throw on access rather than just being absent — e.g. storage blocked
// by browser privacy settings, or a sandboxed iframe with no `allow-same-origin`. Guarded
// the same way web/lib/advancedMode.js guards its own access, for the same reason: a throw
// here must never take down the rest of the app, just fall back to the default (`'wasm'`).
function safeGetItem(key) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Ignore — see the comment above safeGetItem.
  }
}

// Anything that isn't literally `'wasm'` or `'native'` — a missing key, a hand-corrupted
// value, a stale value from some future third engine — resolves to the `'wasm'` default
// rather than propagating an error or silently picking an engine nothing chose.
function readStoredRenderEngine() {
  const raw = safeGetItem(STORAGE_KEY)
  return ENGINES.has(raw) ? raw : 'wasm'
}

export const renderEngine = signal(readStoredRenderEngine())

/**
 * Switches the selected render engine, updating the signal and persisting to
 * `localStorage` immediately so the choice survives a page reload. Any value other than
 * `'wasm'`/`'native'` is ignored (the signal keeps its current value) rather than storing
 * a value nothing downstream recognises. A throwing/disabled `localStorage` degrades
 * silently — the signal still updates for this session.
 */
export function setRenderEngine(value) {
  if (!ENGINES.has(value)) return
  renderEngine.value = value
  safeSetItem(STORAGE_KEY, value)
}

// Test-only: re-reads `renderEngine`'s value from (whatever the test just set up as)
// `localStorage`, so tests/renderEngine.test.js can exercise a fresh "module just loaded"
// scenario per test against one long-lived module instance, rather than a real fresh
// `import()` per test — see web/lib/pandocWasm.js's own `resetForTests` doc comment for why:
// Node's `--experimental-test-coverage` reporter doesn't merge branch coverage across the
// distinct compiled-script instances a per-test dynamic re-import produces. Never called
// outside a test.
export function resetForTests() {
  renderEngine.value = readStoredRenderEngine()
}
