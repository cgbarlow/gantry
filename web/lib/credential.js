// Client-side half of the credential-provider seam (#82's spec; the server
// side is lib/credential.js's `getCredential(req)`, built out per #86). An
// Azure-DevOps-backed instance's API routes reject any request with no PAT
// (or one Azure DevOps itself rejects) with the structured `{ error:
// "authentication_required" }` response — this module holds the one PAT the
// architect pastes in response to that, so every other request can attach it
// without re-prompting, and provides the "prompt, then retry" orchestration
// web/lib/apiFetch.js drives off of.
//
// Local instances (`examples`, `demo-cli`, `demo-web`) never trigger any of
// this: their routes never return `authentication_required`, so `requestPat`
// is never called and no prompt ever appears — there's no separate
// "is this instance local" check anywhere in here.
import { signal } from '@preact/signals'

const STORAGE_KEY = 'gantry:ado-pat'

// `localStorage` can throw on access rather than just being absent — e.g.
// storage blocked by browser privacy settings, or a sandboxed iframe with no
// `allow-same-origin`. Mirrors web/lib/theme.js's own guarded access, for
// the same reason: a throw here must never take down the rest of the app.
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

function safeRemoveItem(key) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    // Ignore — see the comment above safeGetItem.
  }
}

// The one stored PAT — `null` when none is stored, matching
// `getCredential(req)`'s own "no usable credential" return value. A single
// signal rather than per-instance storage: today's server serves exactly
// one Azure-DevOps-backed instance per running process (see lib/server.js's
// own comment on `options.azureDevOps`), so there is only ever one PAT to
// remember at a time.
export const pat = signal(safeGetItem(STORAGE_KEY))

/**
 * Stores a newly-pasted PAT (trimmed; blank clears it instead). Persisted
 * to `localStorage` immediately so it survives a page reload.
 */
export function setPat(value) {
  const trimmed = (value ?? '').trim()
  pat.value = trimmed === '' ? null : trimmed
  if (pat.value === null) safeRemoveItem(STORAGE_KEY)
  else safeSetItem(STORAGE_KEY, pat.value)
}

/**
 * Clears the stored PAT. The very next Azure-DevOps-touching request then
 * carries no Authorization header, gets the structured
 * "authentication required" response back, and `apiFetch` re-prompts —
 * this function only needs to forget the credential, not orchestrate the
 * re-prompt itself.
 */
export function clearPat() {
  pat.value = null
  safeRemoveItem(STORAGE_KEY)
}

/**
 * The `Authorization` header value to attach to a request, or `null` when
 * no PAT is stored (or the stored value can't be encoded as one — see
 * below). HTTP Basic auth with an empty username and the PAT as the
 * password — Azure DevOps's own supported PAT convention (per #82's spec),
 * the same scheme lib/credential.js's `getCredential(req)` decodes on the
 * server.
 */
export function authHeader() {
  if (!pat.value) return null
  try {
    // `btoa` throws for any character outside Latin1 — e.g. a stray
    // smart-quote/invisible character from a rich-text paste into the PAT
    // field. Guarded the same way the server-side decode step
    // (lib/credential.js's `getCredential`) guards its own base64 step:
    // treat an unencodable value as "no usable credential" (`null`) rather
    // than letting a `DOMException` escape and surface as a cryptic error
    // in whichever caller happens to trigger this read.
    return `Basic ${btoa(`:${pat.value}`)}`
  } catch {
    return null
  }
}

// ---------- Prompt orchestration ----------
// `apiFetch` calls `requestPat()` whenever a request comes back with the
// structured "authentication required" response; `PatPromptModal` (in
// web/app.js) renders while `promptOpen` is true and calls
// `resolvePromptWith` once the architect submits or cancels. Concurrent
// callers (e.g. several in-flight requests all hitting
// `authentication_required` at once) share the single in-flight prompt
// instead of each opening their own modal.
export const promptOpen = signal(false)

let pendingResolve = null

/**
 * Opens the PAT prompt (if not already open) and resolves once the
 * architect submits a PAT (`true`) or cancels (`false`). Callers that get
 * `true` back should re-read `pat.value`/`authHeader()` and retry their
 * request; callers that get `false` back should surface their original
 * authentication failure rather than retrying.
 */
export function requestPat() {
  if (pendingResolve) {
    return new Promise((resolve) => {
      const previous = pendingResolve
      pendingResolve = (result) => {
        previous(result)
        resolve(result)
      }
    })
  }
  promptOpen.value = true
  return new Promise((resolve) => {
    pendingResolve = resolve
  })
}

/**
 * Called by `PatPromptModal` when the architect submits (`patValue` set) or
 * cancels (`patValue` is `null`/omitted).
 */
export function resolvePromptWith(patValue) {
  if (patValue) setPat(patValue)
  promptOpen.value = false
  const resolve = pendingResolve
  pendingResolve = null
  resolve?.(Boolean(patValue))
}
