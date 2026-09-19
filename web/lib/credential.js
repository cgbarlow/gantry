// Client-side half of the credential-provider seam (#82's spec; the server side is lib/credential.js's `getCredential(req)`, built out per #86). A Provider-backed instance's API routes reject any request with no PAT (or one the Provider itself rejects) with the structured `{ error: "authentication_required" }` response — this module holds the PAT(s) the architect pastes in response to that, so every other request can attach one without re-prompting, and provides the "prompt, then retry" orchestration web/lib/apiFetch.js drives off of.
//
// Local instances (`examples`, `demo-cli`, `demo-web`) never trigger any of this: their routes never return `authentication_required`, so `requestPat` is never called and no prompt ever appears — there's no separate "is this instance local" check anywhere in here.
//
// #9 (ADR-0038): every workspace holds its own PAT; there is no global default and no fallback. A
// credential's blast radius is one workspace, which is what structurally prevents a token for one
// Provider from ever being offered to another. This module used to hold a *global default* PAT
// (`DEFAULT_WORKSPACE_KEY`, set from the Settings screen's old Global Defaults tab) that every
// workspace fell back to until it had its own override — `pat`, `setPat`, `clearPat`, `authHeader()`
// and that default slot are gone entirely, along with the "override vs default" distinction
// everywhere else in this file. `migrateGlobalPatToWorkspaces` below is the one-shot, first-load
// migration that carries a previously-stored global PAT forward into every workspace that was
// relying on it, so nobody re-enters a credential just because this tier was removed.
import { signal, computed } from '@preact/signals'

// The legacy global-default PAT's own storage key (pre-#9) — read exactly once, by
// `migrateGlobalPatToWorkspaces` below, and never written to again by this module.
const LEGACY_GLOBAL_PAT_STORAGE_KEY = 'gantry:ado-pat'

// Every workspace's own PAT, keyed by workspace id — the sole storage tier now that the global
// default is gone. Kept at its pre-#9 key (`gantry:ado-pat-overrides`) deliberately: #9's own spec
// ("existing per-workspace overrides are already correctly shaped and are left alone") means this
// format doesn't change, only what it means — every entry here was already a specific workspace's
// own credential, never a "default", so there's nothing to migrate about the shape itself.
const PATS_STORAGE_KEY = 'gantry:ado-pat-overrides'
const REJECTED_CREDENTIALS_STORAGE_KEY = 'gantry:ado-pat-rejected'

// `localStorage` can throw on access rather than just being absent — e.g. storage blocked by browser privacy settings, or a sandboxed iframe with no `allow-same-origin`. Mirrors web/lib/theme.js's own guarded access, for the same reason: a throw here must never take down the rest of the app.
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

// Tolerates anything unreadable (corrupt JSON, a non-object value, browser storage that's since
// changed shape) as "no PATs stored yet" rather than throwing.
function readStoredPats() {
  const raw = safeGetItem(PATS_STORAGE_KEY)
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

function persistPats(map) {
  if (Object.keys(map).length === 0) {
    safeRemoveItem(PATS_STORAGE_KEY)
    return
  }
  safeSetItem(PATS_STORAGE_KEY, JSON.stringify(map))
}

function readStoredRejectedCredentials() {
  const raw = safeGetItem(REJECTED_CREDENTIALS_STORAGE_KEY)
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed).filter(([, rejected]) => rejected === true))
}

function persistRejectedCredentials(map) {
  if (Object.keys(map).length === 0) {
    safeRemoveItem(REJECTED_CREDENTIALS_STORAGE_KEY)
    return
  }
  safeSetItem(REJECTED_CREDENTIALS_STORAGE_KEY, JSON.stringify(map))
}

// PATs keyed by workspace id — `{}` when nothing is stored at all. Never seeded from the legacy
// global-default key here; that only ever happens through `migrateGlobalPatToWorkspaces`, called
// explicitly and exactly once by web/app.js at startup, not as an import-time side effect (so this
// module stays a plain, network-free, deterministic seam for direct unit-testing).
const patsByWorkspace = signal(readStoredPats())
const rejectedCredentialSlots = signal(readStoredRejectedCredentials())

/**
 * The PAT to use for `workspaceId`, or `null` when nothing resolves — no fallback of any kind. A
 * falsy `workspaceId` (a local instance, or a caller with no workspace context at all) always
 * resolves to `null`, since there is no global default left to fall back to.
 */
export function patForWorkspace(workspaceId) {
  if (!workspaceId) return null
  return patsByWorkspace.value[workspaceId] ?? null
}

/** Whether `workspaceId` has a PAT stored for it — `false` for a falsy `workspaceId`. */
export function hasPatForWorkspace(workspaceId) {
  if (!workspaceId) return false
  return Object.hasOwn(patsByWorkspace.value, workspaceId)
}

/**
 * Sets (or, given a blank value, clears) `workspaceId`'s own PAT. A no-op for a falsy `workspaceId` —
 * there's no slot to write a credential to until a workspace actually exists (see
 * `basicAuthHeaderForValue` below for the one route, registration itself, that has to authenticate
 * before that's true).
 */
export function setPatForWorkspace(workspaceId, value) {
  if (!workspaceId) return
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    clearPatForWorkspace(workspaceId)
    return
  }
  const next = { ...patsByWorkspace.value, [workspaceId]: trimmed }
  patsByWorkspace.value = next
  clearCredentialRejection(workspaceId)
  persistPats(next)
}

/** Clears `workspaceId`'s own PAT — the next request for that workspace gets the structured "authentication required" response and `apiFetch` re-prompts. A no-op for a falsy `workspaceId`. */
export function clearPatForWorkspace(workspaceId) {
  if (!workspaceId) return
  const next = { ...patsByWorkspace.value }
  delete next[workspaceId]
  patsByWorkspace.value = next
  clearCredentialRejection(workspaceId)
  persistPats(next)
}

function clearCredentialRejection(workspaceId) {
  if (!rejectedCredentialSlots.value[workspaceId]) return
  const next = { ...rejectedCredentialSlots.value }
  delete next[workspaceId]
  rejectedCredentialSlots.value = next
  persistRejectedCredentials(next)
}

export function markCredentialRejected(workspaceId) {
  if (!workspaceId) return
  const next = { ...rejectedCredentialSlots.value, [workspaceId]: true }
  rejectedCredentialSlots.value = next
  persistRejectedCredentials(next)
}

/** 'missing' | 'set' | 'rejected' — the Settings screen's own per-workspace credential-state display (#9's own acceptance criterion). A falsy `workspaceId` always reads as 'missing', matching `patForWorkspace`'s own "no fallback" resolution. */
export function credentialStatusForWorkspace(workspaceId) {
  if (!patForWorkspace(workspaceId)) return 'missing'
  return rejectedCredentialSlots.value[workspaceId] ? 'rejected' : 'set'
}

/**
 * HTTP Basic auth (empty username, the PAT as password) for an arbitrary, not-yet-stored PAT value —
 * the Provider's own supported PAT convention (per #82's spec), the same scheme lib/credential.js's
 * `getCredential(req)` decodes on the server. `null` for a blank value or one that can't be encoded
 * (`btoa` throws for any character outside Latin1 — e.g. a stray smart-quote/invisible character
 * from a rich-text paste). Exported for the one route with no workspace in scope — the "+ New
 * Workspace" wizard's own registration call (ADR-0038): it holds the PAT the architect types in
 * memory (this function, not any persisted slot) and only calls `setPatForWorkspace` with it once
 * that call actually succeeds; see web/pages/new-workspace-wizard.js's `registerWorkspace`.
 */
export function basicAuthHeaderForValue(value) {
  if (!value) return null
  try {
    return `Basic ${btoa(`:${value}`)}`
  } catch {
    return null
  }
}

/** The `Authorization` header value to attach to a request targeting `workspaceId`, or `null` when no PAT resolves for it (including a falsy `workspaceId` — there is nothing left to fall back to). */
export function authHeaderForWorkspace(workspaceId) {
  return basicAuthHeaderForValue(patForWorkspace(workspaceId))
}

/**
 * The one-shot migration (#9, ADR-0038): copies a previously-stored *global default* PAT into every
 * workspace id in `workspaceIds` that doesn't already have its own PAT — an existing per-workspace
 * PAT is left untouched, exactly as the spec requires — then deletes the legacy global key
 * regardless (there is nothing left for it to do once every currently-registered workspace has had
 * its chance to inherit it). A no-op, including the delete, when no global PAT was ever stored.
 *
 * Called explicitly and exactly once, from web/app.js at startup (after fetching the registered
 * workspace list from `GET /api/workspaces`, which needs no credential itself) — never as an
 * import-time side effect of this module, so this file stays network-free and directly unit-testable
 * (tests/credentialWorkspace.test.js calls this with an explicit id list, no server involved).
 */
export function migrateGlobalPatToWorkspaces(workspaceIds) {
  const legacyGlobalPat = safeGetItem(LEGACY_GLOBAL_PAT_STORAGE_KEY)
  if (legacyGlobalPat === null) return
  const current = patsByWorkspace.value
  const additions = {}
  for (const id of workspaceIds ?? []) {
    if (id && !Object.hasOwn(current, id)) additions[id] = legacyGlobalPat
  }
  if (Object.keys(additions).length > 0) {
    const next = { ...current, ...additions }
    patsByWorkspace.value = next
    persistPats(next)
  }
  safeRemoveItem(LEGACY_GLOBAL_PAT_STORAGE_KEY)
}

// ---------- Prompt orchestration ----------
// `apiFetch` calls `requestPat(workspaceId)` whenever a request comes back with the structured "authentication required" response; `PatPromptModal` (in web/app.js) renders while `promptOpen` is true and calls `resolvePromptWith` once the architect submits or cancels. Concurrent callers (e.g. several in-flight requests all hitting `authentication_required` at once) share the single in-flight prompt instead of each opening their own modal.
//
// #9: every prompt now targets a specific, already-registered workspace — there is no global-default
// slot left for a submission to fall back to. The one flow with no workspace yet at all (registering
// a brand-new one) doesn't go through this shared modal any more; see `basicAuthHeaderForValue`'s own
// doc comment above.
export const promptOpen = signal(false)
export const promptContext = signal(null)

let pendingResolve = null
let pendingWorkspaceId = null

/**
 * Opens the PAT prompt (if not already open) and resolves once the architect submits a PAT (`true`) or cancels (`false`). Callers that get `true` back should re-read the relevant PAT (`patForWorkspace`/`authHeaderForWorkspace` for `workspaceId`) and retry their request; callers that get `false` back should surface their original authentication failure rather than retrying.
 */
export function requestPat(workspaceId, context = null) {
  if (pendingResolve) {
    return new Promise((resolve) => {
      const previous = pendingResolve
      pendingResolve = (result) => {
        previous(result)
        resolve(result)
      }
    })
  }
  pendingWorkspaceId = workspaceId || null
  promptContext.value = context
  promptOpen.value = true
  return new Promise((resolve) => {
    pendingResolve = resolve
  })
}

/**
 * Called by `PatPromptModal` when the architect submits (`patValue` set) or cancels (`patValue` is `null`/omitted). Writes the submission to whichever workspace `requestPat` was opened for; a prompt opened with no workspace in mind (shouldn't happen post-#9 — every caller of `requestPat` now names one) simply has nowhere to persist to, and only unblocks its caller.
 */
export function resolvePromptWith(patValue) {
  const workspaceId = pendingWorkspaceId
  pendingWorkspaceId = null
  if (patValue && workspaceId) {
    setPatForWorkspace(workspaceId, patValue)
  }
  promptOpen.value = false
  promptContext.value = null
  const resolve = pendingResolve
  pendingResolve = null
  resolve?.(Boolean(patValue))
}
