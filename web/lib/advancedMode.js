import { signal } from '@preact/signals'

// Client-side, cross-screen "advanced mode" toggle (#300, first child of Feature #291) — a
// `@preact/signals` signal backed by localStorage, following the exact pattern web/lib/theme.js
// and web/lib/ticketingSystem.js already established for a persisted, cross-screen preference.
//
// Advanced mode is OFF by default: a fresh browser (or one with storage disabled/unparseable)
// sees the local-only experience, with all Azure DevOps / work-item ticketing / sign-off UI
// hidden. Turning it on is a deliberate, sticky choice. Later tickets (#301, #302) read this
// signal on other surfaces; this module only owns the setting itself.
const STORAGE_KEY = 'gantry:advancedMode'

// `localStorage` can throw on access rather than just being absent — e.g. storage blocked by
// browser privacy settings, or a sandboxed iframe with no `allow-same-origin`. Guarded the same
// way web/lib/theme.js and web/lib/credential.js guard their own access, for the same reason: a
// throw here must never take down the rest of the app, just fall back to the default (false).
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

// Anything that isn't the literal stored `true` — a missing key, `"false"`, a hand-corrupted
// blob, non-JSON text (which makes `JSON.parse` throw) — resolves to `false` rather than
// propagating an error.
function readStoredAdvancedMode() {
  const raw = safeGetItem(STORAGE_KEY)
  if (raw === null) return false
  try {
    return JSON.parse(raw) === true
  } catch {
    return false
  }
}

export const advancedMode = signal(readStoredAdvancedMode())

/**
 * Turns advanced mode on or off, coercing the argument to a boolean, updating the signal, and
 * persisting to `localStorage` immediately so the choice survives a page reload. A throwing /
 * disabled `localStorage` degrades silently — the signal still updates for this session.
 */
export function setAdvancedMode(value) {
  const next = Boolean(value)
  advancedMode.value = next
  safeSetItem(STORAGE_KEY, JSON.stringify(next))
}
