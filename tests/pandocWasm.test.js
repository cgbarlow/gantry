import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { pandocWasmState, warmLoadPandocWasm, renderDocxWithWasm, resetForTests } from '../web/lib/pandocWasm.js'

// WI314 — the client-side WASM Pandoc render module (web/lib/pandocWasm.js). A real WASM
// instantiate needs a real browser (module init + conversion were verified end-to-end by hand
// in a scratch Playwright page before this ticket's code was wired in — see the module's own
// top-of-file comment), so this unit suite mocks/stubs pandoc-wasm itself via the module's
// `testOverrides` seam (`importCore`/`fetchImpl`) rather than attempting a real WASM run —
// exactly what this ticket's own spec calls for. tests/pandocWasmRender.playwright.test.js
// covers a real conversion through this same module in an actual browser.
//
// One static, top-level import shared by every test below, reset between tests via the
// module's own `resetForTests()` rather than a fresh dynamic `import()` per test (this file's
// earlier approach, and the pattern web/lib/advancedMode.js/theme.js still use for their own
// tests). A per-test dynamic re-import technically isolates module state too, but each
// `import(...?t=…)` call is a *distinct* compiled script as far as V8's coverage
// instrumentation is concerned — Node's `--experimental-test-coverage` reporter doesn't merge
// branch coverage across those distinct instances back into one number for the file, so a
// real, passing test exercising a branch via a freshly-imported instance was invisibly not
// counting towards this file's own reported coverage. See `resetForTests`'s own doc comment.
beforeEach(() => {
  resetForTests()
})

function fakeWasmResponse({ ok = true, status = 200 } = {}) {
  return { ok, status, arrayBuffer: async () => new ArrayBuffer(8) }
}

function fakeCore(convertImpl) {
  return {
    importCore: async () => ({
      createPandocInstance: async (wasmBytes) => {
        assert.ok(wasmBytes instanceof ArrayBuffer, 'createPandocInstance should receive the fetched bytes')
        return { convert: convertImpl }
      },
    }),
  }
}

test('pandocWasmState starts at "loading" before any load is kicked off', () => {
  assert.equal(pandocWasmState.value, 'loading')
})

test('warmLoadPandocWasm resolves and flips state to "ready" on a successful load, and is idempotent', async () => {
  let createCalls = 0
  const importCore = async () => ({
    createPandocInstance: async () => {
      createCalls++
      return { convert: async () => ({ files: {} }) }
    },
  })
  const fetchImpl = async () => fakeWasmResponse()

  const first = warmLoadPandocWasm({ importCore, fetchImpl })
  const second = warmLoadPandocWasm({ importCore, fetchImpl })
  assert.equal(first, second, 'both calls should return the exact same promise')
  const instance = await first
  assert.equal(pandocWasmState.value, 'ready')
  assert.equal(typeof instance.convert, 'function')
  assert.equal(createCalls, 1, 'the loader should run exactly once no matter how many times warmLoadPandocWasm is called')
})

test('warmLoadPandocWasm flips state to "unavailable" and rejects when the core module fails to load', async () => {
  const importCore = async () => {
    throw new Error('network error')
  }
  await assert.rejects(() => warmLoadPandocWasm({ importCore, fetchImpl: async () => fakeWasmResponse() }), /network error/)
  assert.equal(pandocWasmState.value, 'unavailable')
})

test('warmLoadPandocWasm flips state to "unavailable" and rejects when the wasm binary fetch fails', async () => {
  const { importCore } = fakeCore(async () => ({ files: {} }))
  await assert.rejects(
    () => warmLoadPandocWasm({ importCore, fetchImpl: async () => fakeWasmResponse({ ok: false, status: 500 }) }),
    /Failed to fetch pandoc\.wasm \(500\)/
  )
  assert.equal(pandocWasmState.value, 'unavailable')
})

test('a browser with no WebAssembly support is reported as "unavailable"', async () => {
  const originalWebAssembly = globalThis.WebAssembly
  delete globalThis.WebAssembly
  try {
    await assert.rejects(
      () =>
        warmLoadPandocWasm({
          importCore: async () => ({ createPandocInstance: async () => ({}) }),
          fetchImpl: async () => fakeWasmResponse(),
        }),
      /no WebAssembly support/
    )
    assert.equal(pandocWasmState.value, 'unavailable')
  } finally {
    globalThis.WebAssembly = originalWebAssembly
  }
})

test('renderDocxWithWasm converts markdown to docx bytes with no reference doc', async () => {
  const outputBytes = new Uint8Array([1, 2, 3, 4])
  const convertImpl = async (options, stdin, files) => {
    assert.deepEqual(options, { from: 'markdown', to: 'docx', 'output-file': 'output.docx' })
    assert.equal(stdin, '# Hello')
    assert.deepEqual(files, {})
    return { files: { 'output.docx': new Blob([outputBytes]) } }
  }
  const { importCore } = fakeCore(convertImpl)
  const result = await renderDocxWithWasm({ markdown: '# Hello' }, { importCore, fetchImpl: async () => fakeWasmResponse() })
  assert.deepEqual([...result], [...outputBytes])
})

test('renderDocxWithWasm injects reference-doc bytes (a raw Uint8Array) into the virtual filesystem as a Blob, and sets the option', async () => {
  const refBytes = new Uint8Array([9, 9, 9])
  const convertImpl = async (options, stdin, files) => {
    assert.equal(options['reference-doc'], 'reference.docx')
    assert.ok(files['reference.docx'] instanceof Blob)
    const roundTripped = new Uint8Array(await files['reference.docx'].arrayBuffer())
    assert.deepEqual([...roundTripped], [...refBytes])
    return { files: { 'output.docx': new Blob([new Uint8Array([1])]) } }
  }
  const { importCore } = fakeCore(convertImpl)
  await renderDocxWithWasm(
    { markdown: '# Hello', referenceDocBytes: refBytes },
    { importCore, fetchImpl: async () => fakeWasmResponse() }
  )
})

test('renderDocxWithWasm uses an already-real Blob reference doc as-is, not double-wrapped', async () => {
  const refBlob = new Blob([new Uint8Array([7, 7])])
  const convertImpl = async (options, stdin, files) => {
    assert.equal(files['reference.docx'], refBlob)
    return { files: { 'output.docx': new Blob([new Uint8Array([6])]) } }
  }
  const { importCore } = fakeCore(convertImpl)
  await renderDocxWithWasm({ markdown: '# Hello', referenceDocBytes: refBlob }, { importCore, fetchImpl: async () => fakeWasmResponse() })
})

test('renderDocxWithWasm throws a clear error, naming pandoc-wasm\'s own stderr, when it produces no output file', async () => {
  const convertImpl = async () => ({ files: {}, stderr: 'pandoc: something went wrong' })
  const { importCore } = fakeCore(convertImpl)
  await assert.rejects(
    () => renderDocxWithWasm({ markdown: '# Hello' }, { importCore, fetchImpl: async () => fakeWasmResponse() }),
    /did not produce output\.docx: pandoc: something went wrong/
  )
})

test('renderDocxWithWasm\'s missing-output error still reads cleanly when pandoc-wasm reports no stderr at all', async () => {
  const convertImpl = async () => ({ files: {} })
  const { importCore } = fakeCore(convertImpl)
  await assert.rejects(
    () => renderDocxWithWasm({ markdown: '# Hello' }, { importCore, fetchImpl: async () => fakeWasmResponse() }),
    /did not produce output\.docx$/
  )
})

test('warmLoadPandocWasm called with no testOverrides at all uses the real default importCore/fetchImpl (production shape), and still degrades to "unavailable" gracefully in this non-browser test environment', async () => {
  // No second argument at all — exercises loadPandocInstance's own default parameter values
  // (`importCore = () => import(PANDOC_WASM_CORE_URL)`, `fetchImpl = fetch`), the exact shape
  // every real caller (web/app.js's boot warm-load) uses. There's no dev server or bundler
  // here to actually resolve `/node_modules/pandoc-wasm/src/core.js`, so this rejects — the
  // point is exercising the default-argument branch itself, not a successful load (already
  // covered above via explicit testOverrides).
  await assert.rejects(() => warmLoadPandocWasm())
  assert.equal(pandocWasmState.value, 'unavailable')
})

test('renderDocxWithWasm surfaces a clean error when the converted result has no `files` object at all — the `result.files?.[...]` optional-chaining short-circuit, distinct from a `files: {}` with a merely-missing key', async () => {
  const { importCore } = fakeCore(async () => ({}))
  await assert.rejects(
    () => renderDocxWithWasm({ markdown: '# Hello' }, { importCore, fetchImpl: async () => fakeWasmResponse() }),
    /did not produce output\.docx$/
  )
})

test('renderDocxWithWasm reuses an already-warm-loaded instance without loading again', async () => {
  let importCoreCalls = 0
  const importCore = async () => {
    importCoreCalls++
    return {
      createPandocInstance: async () => ({
        convert: async () => ({ files: { 'output.docx': new Blob([new Uint8Array([7])]) } }),
      }),
    }
  }
  const fetchImpl = async () => fakeWasmResponse()
  await warmLoadPandocWasm({ importCore, fetchImpl })
  // No overrides passed this time — if renderDocxWithWasm tried to load again with the real
  // (browser-only) defaults, this would reject; instead it must reuse the cached instance.
  const result = await renderDocxWithWasm({ markdown: '# Hello' })
  assert.deepEqual([...result], [7])
  assert.equal(importCoreCalls, 1)
})
