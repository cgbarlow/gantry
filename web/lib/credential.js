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
//
// #40 (ADR-0042): an Atlassian workspace holds *two* tokens in its one workspace slot — a Bitbucket
// token and a Jira token, since Bitbucket Cloud and Jira Cloud are different products with their own
// separate token systems. Every other provider keeps storing a bare PAT string, unchanged. This is
// done by branching on *shape*, not by threading a `provider` argument through every function: a
// stored value is either a plain string (single-token provider) or a `{bitbucket, jira}` object
// (Atlassian), and every reader/writer below inspects which it has rather than being told. The one
// function that can't infer this from storage alone — `credentialStatusForWorkspace`, which must
// report per-token missing/set/rejected even before either token has ever been set — takes an
// explicit, optional `provider` argument instead; every other function takes an optional trailing
// `product` (`'bitbucket'` | `'jira'`) that non-Atlassian callers simply never pass. Either way, no
// existing azure-devops/github/gitlab call site needs to change.
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
// #126 (parent #109, docs/adr/0047): whether a workspace's *currently stored* credential has been
// confirmed to have write access — a third piece of per-workspace state, genuinely different from
// both `PATS_STORAGE_KEY` ("is a credential stored") and `REJECTED_CREDENTIALS_STORAGE_KEY` ("did the
// Provider reject it"). A credential can be present, accepted, and still read-only — exactly the case
// this ticket exists to make the UI honest about instead of inferring "has a credential" means "may
// edit". Keyed by workspace id, value `true`/`false` (never stores "unknown" — an absent entry already
// means that); an entry is only ever written by `setWriteAccessForWorkspace` (server.js's `GET
// /api/workspaces/:id/write-access` is the sole real caller, via web/lib/writeAccess.js), which a
// caller runs once per credential and never re-derives itself.
const WRITE_ACCESS_STORAGE_KEY = 'gantry:write-access'

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

// Tolerates anything unreadable the same way readStoredPats/readStoredRejectedCredentials do, and
// (like readStoredRejectedCredentials) drops any entry whose value isn't a real boolean — storage
// written by a future version of this module, or hand-edited, must not resolve as a confirmed answer
// either way.
function readStoredWriteAccess() {
  const raw = safeGetItem(WRITE_ACCESS_STORAGE_KEY)
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed).filter(([, canWrite]) => typeof canWrite === 'boolean'))
}

function persistWriteAccess(map) {
  if (Object.keys(map).length === 0) {
    safeRemoveItem(WRITE_ACCESS_STORAGE_KEY)
    return
  }
  safeSetItem(WRITE_ACCESS_STORAGE_KEY, JSON.stringify(map))
}

// PATs keyed by workspace id — `{}` when nothing is stored at all. Never seeded from the legacy
// global-default key here; that only ever happens through `migrateGlobalPatToWorkspaces`, called
// explicitly and exactly once by web/app.js at startup, not as an import-time side effect (so this
// module stays a plain, network-free, deterministic seam for direct unit-testing).
const patsByWorkspace = signal(readStoredPats())
const rejectedCredentialSlots = signal(readStoredRejectedCredentials())
const writeAccessByWorkspace = signal(readStoredWriteAccess())

// A stored workspace credential is either a plain PAT string (every provider except Atlassian) or a
// `{bitbucket, jira}` object (Atlassian, #40/ADR-0042). Readers/writers below tell the two apart by
// this shape alone, rather than needing a `provider` argument — see the module doc comment above.
function isTwoTokenValue(stored) {
  return Boolean(stored) && typeof stored === 'object' && !Array.isArray(stored)
}

/**
 * The PAT to use for `workspaceId`, or `null` when nothing resolves — no fallback of any kind. A
 * falsy `workspaceId` (a local instance, or a caller with no workspace context at all) always
 * resolves to `null`, since there is no global default left to fall back to.
 *
 * For an Atlassian workspace (#40/ADR-0042), storage holds `{bitbucket, jira}` rather than a bare
 * string — pass `product` (`'bitbucket'` | `'jira'`) to read one token specifically. Every other
 * provider's callers never pass `product`; a plain string simply ignores it.
 */
export function patForWorkspace(workspaceId, product) {
  if (!workspaceId) return null
  const stored = patsByWorkspace.value[workspaceId]
  if (isTwoTokenValue(stored)) return (product && stored[product]) || null
  return stored ?? null
}

/**
 * Whether `workspaceId` has a PAT stored for it — `false` for a falsy `workspaceId`. For an
 * Atlassian workspace, pass `product` to check one token specifically; omitted, it reports whether
 * *either* token has been set.
 */
export function hasPatForWorkspace(workspaceId, product) {
  if (!workspaceId) return false
  const stored = patsByWorkspace.value[workspaceId]
  if (isTwoTokenValue(stored)) {
    return product ? Boolean(stored[product]) : Object.values(stored).some(Boolean)
  }
  return Object.hasOwn(patsByWorkspace.value, workspaceId)
}

/**
 * Sets (or, given a blank value, clears) `workspaceId`'s own PAT. A no-op for a falsy `workspaceId` —
 * there's no slot to write a credential to until a workspace actually exists (see
 * `basicAuthHeaderForValue` below for the one route, registration itself, that has to authenticate
 * before that's true).
 *
 * For an Atlassian workspace, pass `product` (`'bitbucket'` | `'jira'`) to set that one token,
 * leaving the other (if any already set) untouched — this stores `{bitbucket, jira}` in that
 * workspace's slot instead of a bare string. Every other provider's callers never pass `product`.
 */
export function setPatForWorkspace(workspaceId, value, product) {
  if (!workspaceId) return
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    clearPatForWorkspace(workspaceId, product)
    return
  }
  if (product) {
    const current = patsByWorkspace.value[workspaceId]
    const currentTokens = isTwoTokenValue(current) ? current : {}
    const next = { ...patsByWorkspace.value, [workspaceId]: { ...currentTokens, [product]: trimmed } }
    patsByWorkspace.value = next
    clearCredentialRejection(workspaceId)
    clearWriteAccessForWorkspace(workspaceId)
    persistPats(next)
    return
  }
  const next = { ...patsByWorkspace.value, [workspaceId]: trimmed }
  patsByWorkspace.value = next
  clearCredentialRejection(workspaceId)
  clearWriteAccessForWorkspace(workspaceId)
  persistPats(next)
}

/**
 * Clears `workspaceId`'s own PAT — the next request for that workspace gets the structured
 * "authentication required" response and `apiFetch` re-prompts. A no-op for a falsy `workspaceId`.
 *
 * For an Atlassian workspace, pass `product` to clear just that one token, leaving the other (if
 * set) in place. Omitted, it clears the whole slot — both Atlassian tokens, or the one PAT for
 * every other provider.
 */
export function clearPatForWorkspace(workspaceId, product) {
  if (!workspaceId) return
  if (product) {
    const current = patsByWorkspace.value[workspaceId]
    if (!isTwoTokenValue(current) || !(product in current)) return
    const nextTokens = { ...current }
    delete nextTokens[product]
    const next = { ...patsByWorkspace.value }
    if (Object.keys(nextTokens).length === 0) {
      delete next[workspaceId]
    } else {
      next[workspaceId] = nextTokens
    }
    patsByWorkspace.value = next
    clearCredentialRejection(workspaceId)
    clearWriteAccessForWorkspace(workspaceId)
    persistPats(next)
    return
  }
  const next = { ...patsByWorkspace.value }
  delete next[workspaceId]
  patsByWorkspace.value = next
  clearCredentialRejection(workspaceId)
  clearWriteAccessForWorkspace(workspaceId)
  persistPats(next)
}

function clearCredentialRejection(workspaceId) {
  if (!rejectedCredentialSlots.value[workspaceId]) return
  const next = { ...rejectedCredentialSlots.value }
  delete next[workspaceId]
  rejectedCredentialSlots.value = next
  persistRejectedCredentials(next)
}

// #126: a stored write-access answer is only ever meaningful for the *credential it was checked
// against* — the moment that credential changes (a new one set) or goes away (cleared, or the
// Provider rejects it), any prior "confirmed write" or "confirmed read-only" is stale and must not
// keep gating the interface. Every place below that changes what credential is stored for a workspace
// clears this too, so the very next render sees "not yet checked" rather than a leftover answer for a
// PAT that's no longer the one in use — `web/lib/writeAccess.js`'s `ensureWriteAccessChecked` then
// re-runs the check for whatever credential (if any) is there now.
function clearWriteAccessForWorkspace(workspaceId) {
  if (!Object.hasOwn(writeAccessByWorkspace.value, workspaceId)) return
  const next = { ...writeAccessByWorkspace.value }
  delete next[workspaceId]
  writeAccessByWorkspace.value = next
  persistWriteAccess(next)
}

export function markCredentialRejected(workspaceId) {
  if (!workspaceId) return
  const next = { ...rejectedCredentialSlots.value, [workspaceId]: true }
  rejectedCredentialSlots.value = next
  persistRejectedCredentials(next)
  clearWriteAccessForWorkspace(workspaceId)
}

/**
 * 'missing' | 'set' | 'rejected' — the Settings screen's own per-workspace credential-state display
 * (#9's own acceptance criterion). A falsy `workspaceId` always reads as 'missing', matching
 * `patForWorkspace`'s own "no fallback" resolution.
 *
 * For an Atlassian workspace (#40/ADR-0042), pass `provider: 'atlassian'` to get a per-token report
 * instead — `{bitbucket, jira}`, each one of the same three statuses — since a flat status can't say
 * *which* of the two tokens (if either) is missing. This is the one function in this module that
 * can't tell Atlassian-ness from storage shape alone: a brand-new Atlassian workspace with neither
 * token set yet has nothing stored at all, so there's no object shape to read. Every other
 * provider's callers never pass `provider` and get the existing flat status, unchanged.
 */
export function credentialStatusForWorkspace(workspaceId, provider) {
  if (provider === 'atlassian') {
    const rejected = Boolean(rejectedCredentialSlots.value[workspaceId])
    const statusFor = (product) => {
      if (!patForWorkspace(workspaceId, product)) return 'missing'
      return rejected ? 'rejected' : 'set'
    }
    return { bitbucket: statusFor('bitbucket'), jira: statusFor('jira') }
  }
  if (!patForWorkspace(workspaceId)) return 'missing'
  return rejectedCredentialSlots.value[workspaceId] ? 'rejected' : 'set'
}

/**
 * #126: whether `workspaceId`'s *currently stored* credential has already been asked "can you write
 * here" (`web/lib/writeAccess.js`'s `ensureWriteAccessChecked`, the sole real writer of this state) —
 * `false` for a falsy `workspaceId` or one with no entry yet, matching every other reader in this
 * module. Distinct from `hasConfirmedWriteAccess` below: this only says whether an answer exists at
 * all, not what it was — a caller deciding whether to *run* the check wants this one; a caller
 * deciding whether to *enable editing* wants the other.
 */
export function hasCheckedWriteAccess(workspaceId) {
  if (!workspaceId) return false
  return Object.hasOwn(writeAccessByWorkspace.value, workspaceId)
}

/**
 * #126: whether `workspaceId`'s currently stored credential has been confirmed to have write access —
 * `false` (never `true`) for a falsy `workspaceId`, an unchecked workspace, or one whose check came
 * back read-only. This is the one function every editing-affordance gate in the web app reads;
 * `hasCheckedWriteAccess` above is for the checker itself to decide whether there's anything left to
 * do.
 */
export function hasConfirmedWriteAccess(workspaceId) {
  if (!workspaceId) return false
  return writeAccessByWorkspace.value[workspaceId] === true
}

/**
 * Records the answer to #126's write-access check for `workspaceId`'s *currently stored* credential —
 * called exactly once per credential by `web/lib/writeAccess.js`'s `ensureWriteAccessChecked` (the
 * only real caller), never re-derived here. A no-op for a falsy `workspaceId`, matching every other
 * writer in this module.
 */
export function setWriteAccessForWorkspace(workspaceId, canWrite) {
  if (!workspaceId) return
  const next = { ...writeAccessByWorkspace.value, [workspaceId]: Boolean(canWrite) }
  writeAccessByWorkspace.value = next
  persistWriteAccess(next)
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

/**
 * The `Authorization` header value to attach to a request targeting `workspaceId`, or `null` when no
 * PAT resolves for it (including a falsy `workspaceId` — there is nothing left to fall back to). For
 * an Atlassian workspace, pass `product` (`'bitbucket'` | `'jira'`) to select which of its two
 * tokens to encode — every other provider's callers never pass it.
 */
export function authHeaderForWorkspace(workspaceId, product) {
  return basicAuthHeaderForValue(patForWorkspace(workspaceId, product))
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
