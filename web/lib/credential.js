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
import { signal, computed } from '@preact/signals'

const STORAGE_KEY = 'gantry:ado-pat'

// Internal storage is a map from Azure DevOps organization name to that
// organization's PAT — a primitive for future multi-org support, mirroring
// how ADR-0007's credential-provider seam already keeps an unused-but-ready
// shape for a future Entra ID implementation (see #88, #91). Only this one
// key is ever populated today: there is no UI anywhere for adding,
// selecting, or switching between organizations, and the server itself
// only ever proxies requests for a single organization per instance. Kept
// as a private constant (not exported) precisely because nothing outside
// this module needs — or should need — to know an organization key exists
// yet; `web/lib/apiFetch.js`'s call sites keep resolving "the" PAT with no
// argument.
const DEFAULT_ORGANIZATION = 'default'

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

// PATs keyed by organization — `{}` when none is stored. Persisted to
// `localStorage` as a single bare value (not a serialized map): only
// `DEFAULT_ORGANIZATION`'s entry is ever read from/written to
// `STORAGE_KEY`, so today's on-disk format is byte-for-byte what it always
// was, even though the in-memory shape is now a map.
const initialPat = safeGetItem(STORAGE_KEY)
const patsByOrganization = signal(initialPat === null ? {} : { [DEFAULT_ORGANIZATION]: initialPat })

// The one stored PAT — `null` when none is stored, matching
// `getCredential(req)`'s own "no usable credential" return value. Derived
// from `patsByOrganization` rather than its own writable signal: today's
// server serves exactly one Azure-DevOps-backed instance per running
// process (see lib/server.js's own comment on `options.azureDevOps`), so
// there is only ever one organization's PAT to expose here, but the
// underlying map is what actually owns the value.
export const pat = computed(() => patsByOrganization.value[DEFAULT_ORGANIZATION] ?? null)

/**
 * Stores a newly-pasted PAT (trimmed; blank clears it instead). Persisted
 * to `localStorage` immediately so it survives a page reload.
 */
export function setPat(value) {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    clearPat()
    return
  }
  const next = { ...patsByOrganization.value, [DEFAULT_ORGANIZATION]: trimmed }
  patsByOrganization.value = next
  safeSetItem(STORAGE_KEY, trimmed)
}

/**
 * Clears the stored PAT. The very next Azure-DevOps-touching request then
 * carries no Authorization header, gets the structured
 * "authentication required" response back, and `apiFetch` re-prompts —
 * this function only needs to forget the credential, not orchestrate the
 * re-prompt itself.
 */
export function clearPat() {
  const next = { ...patsByOrganization.value }
  delete next[DEFAULT_ORGANIZATION]
  patsByOrganization.value = next
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
