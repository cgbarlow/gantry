// #116 — the one clipboard helper in this app, so every "Copy" control degrades the same way.
//
// `navigator.clipboard` is *absent*, not merely restricted, outside a secure context — a
// `gantry serve` reached over plain http:// on a LAN address is exactly that, and is a normal way to
// run this app, so the no-API path is a real one rather than a theoretical one. `writeText` can also
// reject at call time (permission denied, the document not focused), which is indistinguishable from
// the caller's point of view: either way the text did not reach the clipboard.
//
// So this never throws and never assumes: it resolves `true` only when the write genuinely succeeded,
// and `false` otherwise, leaving the caller to say so and to keep the value on screen as selectable
// text. A caller that ignored the result would silently claim "Copied." over an empty clipboard.
//
// `clipboard` is injectable purely so this is testable under plain `node --test` (no DOM, no
// navigator) — the same direct-import unit-test convention web/lib/advancedMode.js and
// web/lib/credential.js already follow.
export async function copyTextToClipboard(text, { clipboard = globalThis.navigator?.clipboard } = {}) {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false
  try {
    await clipboard.writeText(String(text))
    return true
  } catch {
    return false
  }
}
