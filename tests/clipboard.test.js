import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyTextToClipboard } from '../web/lib/clipboard.js'

// #116 — the shared clipboard helper behind Settings' "Copy" control. `web/lib/clipboard.js` is plain
// ESM with no DOM dependency of its own (the clipboard is injectable), so its behaviour is covered
// directly here under plain `node --test`, exactly like web/lib/advancedMode.js's own unit tests —
// with the Settings-screen wiring left to tests/settings.playwright.test.js, which needs a browser.
//
// Every assertion is about the *return value*, because that is the whole contract: the caller shows
// "Copied." only when the text genuinely reached the clipboard, and points at the on-screen selectable
// text otherwise. A helper that swallowed failures as success would make the UI lie.

test('copyTextToClipboard writes the text and reports success', async () => {
  const written = []
  const copied = await copyTextToClipboard('ws-123', { clipboard: { writeText: async (t) => written.push(t) } })
  assert.equal(copied, true)
  assert.deepEqual(written, ['ws-123'])
})

test('copyTextToClipboard reports failure — writing nothing — where there is no clipboard API at all', async () => {
  // The real case, not a theoretical one: `navigator.clipboard` is undefined outside a secure
  // context, which a `gantry serve` reached over plain http:// on a LAN address is.
  assert.equal(await copyTextToClipboard('ws-123', { clipboard: undefined }), false)
  assert.equal(await copyTextToClipboard('ws-123', { clipboard: {} }), false)
  assert.equal(await copyTextToClipboard('ws-123', { clipboard: { writeText: 'not a function' } }), false)
})

test('copyTextToClipboard reports failure rather than throwing when the write is rejected', async () => {
  // Permission denied, or the document not focused — the API exists and still doesn't copy.
  const copied = await copyTextToClipboard('ws-123', {
    clipboard: {
      writeText: async () => {
        throw new Error('NotAllowedError: Write permission denied.')
      },
    },
  })
  assert.equal(copied, false)
})

test('copyTextToClipboard defaults to the ambient navigator clipboard when none is passed', async () => {
  const written = []
  const originalNavigator = globalThis.navigator
  try {
    // `navigator` is a getter-only global in modern Node, so it's replaced wholesale for this test.
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (t) => written.push(t) } },
      configurable: true,
      writable: true,
    })
    assert.equal(await copyTextToClipboard('ws-123'), true)
    assert.deepEqual(written, ['ws-123'])
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true, writable: true })
  }
})

test('copyTextToClipboard reports failure when the ambient environment has no navigator at all', async () => {
  const originalNavigator = globalThis.navigator
  try {
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true })
    assert.equal(await copyTextToClipboard('ws-123'), false)
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true, writable: true })
  }
})
