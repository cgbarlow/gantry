import { signal } from '@preact/signals'

// WI314 — the client-side WASM Pandoc render path. Wraps the `pandoc-wasm` npm package
// (pinned in package.json, pandoc 3.9, vendored via `node_modules` and served by the exact
// same `/node_modules/` static route lib/server.js already uses for CodeMirror/preact/etc. —
// see FRONT_END_SPECIFIERS there) so a Render action can convert markdown to a `.docx`
// entirely in the browser, no server round-trip for the conversion itself.
//
// Deliberately does NOT `import 'pandoc-wasm'` (the bare specifier) anywhere, including here
// at module scope — two independent reasons:
//
// 1. Warm-load must be genuinely lazy until `warmLoadPandocWasm()` is actually called (fired
//    once, non-blocking, from web/app.js's boot sequence — never gated behind a user action,
//    but also never a *top-level* `import` of this module's own dependencies, which would
//    defeat the point by eagerly fetching them on every page load regardless of whether
//    warm-load ever runs). This mirrors the exact bug the #310 prototype found and fixed: a
//    naive top-level `import` of pandoc-wasm's JS wrapper eagerly fetches its whole dependency
//    graph even while the WASM binary itself stays lazy behind a `dynamic import()`.
// 2. pandoc-wasm's own bare-specifier entry point is unusable here regardless of laziness.
//    Its package.json `exports` resolves (via lib/importmap.js's `resolveEntry`, which only
//    understands `exports`/`module`/`main` — not the `browser` field bundlers use) to its
//    top-level `index.js`, which environment-sniffs at runtime and, in a real browser,
//    dynamically imports `src/index.browser.js` — which itself does a raw top-level
//    `import("./pandoc.wasm")` of the *binary* as an ES module. That needs a bundler to turn
//    into an asset-URL import (pandoc-wasm's own README says so explicitly); gantry ships no
//    bundler, and no browser here implements the still-experimental WASM/ES-module-integration
//    proposal that would make a raw `.wasm` import work natively. Confirmed by hand: a scratch
//    Playwright page hit "Failed to load module script: Expected a JavaScript-or-Wasm module
//    script but the server responded with a MIME type of application/wasm".
//
//    The fix: import pandoc-wasm's environment-agnostic `src/core.js` directly, by a fixed
//    `/node_modules/...` path — never pandoc-wasm's own broken browser entry — and fetch the
//    `.wasm` binary ourselves as raw bytes via `fetch()`/`arrayBuffer()`, exactly as
//    `src/index.browser.js` would if the WASM-as-ES-module step worked. `core.js` only
//    bare-imports one further dependency (`@bjorn3/browser_wasi_shim`, pure JS, no WASM of its
//    own), added to FRONT_END_SPECIFIERS in lib/server.js so the browser's import map resolves
//    it. Verified end-to-end by hand (module init + a real markdown→docx conversion, including
//    a `--reference-doc` merge) in a scratch Playwright page before wiring this in.
const PANDOC_WASM_CORE_URL = '/node_modules/pandoc-wasm/src/core.js'
const PANDOC_WASM_BINARY_URL = '/node_modules/pandoc-wasm/src/pandoc.wasm'

/**
 * pandoc-wasm's own load-state, live — read by Global Settings (web/pages/settings.js) to
 * show a real status line instead of a static claim, and by the Render action to decide
 * whether an explicit `'wasm'` engine selection can actually be honoured right now:
 *
 * - `'loading'` — warm-load is in flight (or hasn't been kicked off yet). The initial value:
 *   a fresh page load never starts `'ready'`, even though warm-load begins immediately on
 *   boot, because the download/instantiate genuinely takes time (~250ms-plus once the ~59MB
 *   binary itself is cached; the first-ever download can take much longer on a slow link).
 * - `'ready'` — the WASM module is instantiated and `renderDocxWithWasm` will resolve without
 *   waiting on anything further.
 * - `'unavailable'` — covers both an outright load failure (network error, unsupported
 *   browser — no `WebAssembly` global, a sandboxed context that blocks `fetch`) and a
 *   mid-conversion failure severe enough that this module gives up on the current instance.
 *   A render still succeeds in this state — every caller falls back to native Pandoc.
 */
export const pandocWasmState = signal('loading')

// The in-flight/completed load, cached so `warmLoadPandocWasm()` is idempotent — the boot-time
// warm-load and any later `renderDocxWithWasm()` call (before or after warm-load resolves)
// all share the exact same one load, never triggering a second download.
let loadPromise = null

// Test-only: clears the cached load and resets `pandocWasmState` back to its fresh-page-load
// value, so tests/pandocWasm.test.js can exercise a fresh `warmLoadPandocWasm()` scenario per
// test against one long-lived module instance, rather than a real fresh `import()` per test.
// A per-test dynamic re-import (this file's own earlier approach, and the pattern
// web/lib/advancedMode.js/theme.js still use) technically works, but each `import(...?t=…)`
// call is a *distinct* compiled script as far as V8's coverage instrumentation is concerned —
// Node's `--experimental-test-coverage` reporter doesn't merge branch coverage across those
// distinct instances back into one number for this file, so a real, passing test exercising a
// branch via a freshly-imported instance was invisibly not counting towards this file's own
// reported coverage. Never called outside a test.
export function resetForTests() {
  loadPromise = null
  pandocWasmState.value = 'loading'
}

// `importCore`/`fetchImpl` are only ever overridden by tests (this ticket's own "mock/stub
// pandoc-wasm where a real WASM run is impractical in the unit suite" — a real WASM
// instantiate needs a real browser, `node --test` has none). Every real caller — web/app.js's
// boot-time warm-load, web/pages/settings.js, RenderDialog's `renderDocxWithWasm` calls — uses
// the defaults, which are exactly `loadPandocInstance`'s own original, unparameterised body.
async function loadPandocInstance({ importCore = () => import(PANDOC_WASM_CORE_URL), fetchImpl = fetch } = {}) {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('This browser has no WebAssembly support')
  }
  const { createPandocInstance } = await importCore()
  const wasmResponse = await fetchImpl(PANDOC_WASM_BINARY_URL)
  if (!wasmResponse.ok) {
    throw new Error(`Failed to fetch pandoc.wasm (${wasmResponse.status})`)
  }
  const wasmBytes = await wasmResponse.arrayBuffer()
  return createPandocInstance(wasmBytes)
}

/**
 * Kicks off (or, on any later call, simply returns) the one warm-load for this page's
 * lifetime. Called once, unconditionally and non-blocking, from web/app.js's boot sequence —
 * "warm-loaded on gantry open," not gated behind opening Preview or clicking Render — and
 * again by `renderDocxWithWasm` below in case it's ever called before boot got to it (e.g. a
 * unit test exercising this module directly). Never throws synchronously; the returned
 * promise rejects if the load ultimately fails, after first flipping `pandocWasmState` to
 * `'unavailable'` so every reader (Settings, the Render action) sees the real state without
 * needing to `await`/catch this promise themselves.
 *
 * @param {{ importCore?: Function, fetchImpl?: Function }} [testOverrides] test-only — see
 *   `loadPandocInstance`'s own doc comment; every real caller omits this.
 */
export function warmLoadPandocWasm(testOverrides) {
  if (loadPromise) return loadPromise
  loadPromise = loadPandocInstance(testOverrides)
    .then((instance) => {
      pandocWasmState.value = 'ready'
      return instance
    })
    .catch((err) => {
      pandocWasmState.value = 'unavailable'
      throw err
    })
  return loadPromise
}

/**
 * Converts `markdown` to a `.docx` entirely in the browser via pandoc-wasm, optionally merging
 * `referenceDocBytes` (an ArrayBuffer/Uint8Array/Blob — a definition's `reference.docx`,
 * fetched by the caller from the server) the same way native Pandoc's own `--reference-doc`
 * flag does — pandoc-wasm has no such flag, so this injects the bytes into its virtual
 * filesystem instead (the #310 prototype's proven approach) and points the `reference-doc`
 * option at that virtual filename.
 *
 * Awaits `warmLoadPandocWasm()` — if warm-load already finished (the common case: gantry has
 * been open for more than a fraction of a second) this resolves immediately; if it's still in
 * flight (e.g. a slow first-ever download), this waits for that same in-flight load rather
 * than starting a redundant second one, so an explicit `'wasm'` engine selection never
 * hard-fails just because the module hasn't finished loading yet — it renders as soon as the
 * load it shares with everyone else completes. Only an outright load failure, or a failure
 * during the conversion itself, rejects — every caller (web/app.js's Render action) catches
 * that and falls back to native Pandoc rather than surfacing a WASM-specific outage to the
 * user.
 *
 * @param {{ markdown: string, referenceDocBytes?: ArrayBuffer|Uint8Array|Blob|null }} args
 * @param {{ importCore?: Function, fetchImpl?: Function }} [testOverrides] test-only —
 *   see `warmLoadPandocWasm`'s own doc comment
 * @returns {Promise<Uint8Array>} the produced `.docx`'s raw bytes
 */
export async function renderDocxWithWasm({ markdown, referenceDocBytes }, testOverrides) {
  const instance = await warmLoadPandocWasm(testOverrides)

  const options = { from: 'markdown', to: 'docx', 'output-file': 'output.docx' }
  const files = {}
  if (referenceDocBytes) {
    options['reference-doc'] = 'reference.docx'
    files['reference.docx'] = referenceDocBytes instanceof Blob ? referenceDocBytes : new Blob([referenceDocBytes])
  }

  const result = await instance.convert(options, markdown, files)
  const outputFile = result.files?.['output.docx']
  if (!outputFile) {
    const stderr = (result.stderr ?? '').trim()
    throw new Error(`pandoc-wasm did not produce output.docx${stderr ? `: ${stderr}` : ''}`)
  }
  return new Uint8Array(await outputFile.arrayBuffer())
}
