// Client-side half of the credential-provider seam (#82's spec; the server
// side is lib/credential.js's `getCredential(req)`, built out per #86). An
// Azure-DevOps-backed instance's API routes reject any request with no PAT
// (or one Azure DevOps itself rejects) with the structured `{ error:
// "authentication_required" }` response — this module holds the PAT(s) the
// architect pastes in response to that, so every other request can attach
// one without re-prompting, and provides the "prompt, then retry"
// orchestration web/lib/apiFetch.js drives off of.
//
// Local instances (`examples`, `demo-cli`, `demo-web`) never trigger any of
// this: their routes never return `authentication_required`, so `requestPat`
// is never called and no prompt ever appears — there's no separate
// "is this instance local" check anywhere in here.
//
// Storage was originally keyed by Azure DevOps organization name (a
// primitive for future multi-org support, mirroring how ADR-0007's
// credential-provider seam already keeps an unused-but-ready shape for a
// future Entra ID implementation — see #88, #91) with only one key
// (`DEFAULT_WORKSPACE_KEY`) ever populated. #104 generalizes that same map
// from organization-keyed to **workspace**-keyed: `DEFAULT_WORKSPACE_KEY`
// ('default') now holds the *global default* PAT (set from the Settings
// screen's Global Defaults tab, exactly as before), and any other key is a
// specific workspace id's *override* (set from that same screen's Workspace
// tab) — resolved by `patForWorkspace`/`authHeaderForWorkspace` below,
// which `web/lib/apiFetch.js`'s `apiFetchForInstance` calls with whichever
// workspace id a given instance's slug actually belongs to (looked up via
// `GET /api/instance/workspace`).
import { signal, computed } from '@preact/signals'

const STORAGE_KEY = 'gantry:ado-pat'

// A *second*, separate storage key for workspace-specific overrides — kept
// apart from `STORAGE_KEY` rather than folded into one serialized map,
// so the global default's own on-disk format stays byte-for-byte what it
// always was (a bare string, not JSON) — every existing test/user that
// reads `localStorage.getItem('gantry:ado-pat')` directly is unaffected by
// per-workspace overrides existing at all.
const OVERRIDES_STORAGE_KEY = 'gantry:ado-pat-overrides'

const DEFAULT_WORKSPACE_KEY = 'default'

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

// Overrides are persisted as a JSON object mapping workspace id -> PAT,
// tolerating anything unreadable (corrupt JSON, a non-object value, browser
// storage that's since changed shape) as "no overrides yet" rather than
// throwing. `DEFAULT_WORKSPACE_KEY` is stripped from whatever's read back —
// it belongs solely to `STORAGE_KEY`'s bare-string slot, never to this map,
// so a hand-edited or otherwise corrupted overrides blob can never shadow
// the global default.
function readStoredOverrides() {
  const raw = safeGetItem(OVERRIDES_STORAGE_KEY)
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const { [DEFAULT_WORKSPACE_KEY]: _ignoredDefaultKey, ...overrides } = parsed
  return overrides
}

function persistOverrides(map) {
  const { [DEFAULT_WORKSPACE_KEY]: _ignoredDefaultKey, ...overrides } = map
  if (Object.keys(overrides).length === 0) {
    safeRemoveItem(OVERRIDES_STORAGE_KEY)
    return
  }
  safeSetItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
}

// PATs keyed by workspace id (`DEFAULT_WORKSPACE_KEY` for the global
// default) — `{}` when nothing is stored at all. The default key's value
// still round-trips through `STORAGE_KEY` as a single bare string exactly
// as before #104; every other key round-trips through
// `OVERRIDES_STORAGE_KEY` as a JSON map — see readStoredOverrides/
// persistOverrides above.
const initialPat = safeGetItem(STORAGE_KEY)
const patsByWorkspace = signal({
  ...(initialPat === null ? {} : { [DEFAULT_WORKSPACE_KEY]: initialPat }),
  ...readStoredOverrides(),
})

// The global default PAT — `null` when none is stored, matching
// `getCredential(req)`'s own "no usable credential" return value. This is
// what the Settings screen's Global Defaults tab manages, and what every
// workspace falls back to until it has its own override.
export const pat = computed(() => patsByWorkspace.value[DEFAULT_WORKSPACE_KEY] ?? null)

/**
 * Stores a newly-pasted *global default* PAT (trimmed; blank clears it
 * instead). Persisted to `localStorage` immediately so it survives a page
 * reload. Never touches any workspace-specific override — see
 * `setWorkspacePatOverride` for that.
 */
export function setPat(value) {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    clearPat()
    return
  }
  const next = { ...patsByWorkspace.value, [DEFAULT_WORKSPACE_KEY]: trimmed }
  patsByWorkspace.value = next
  safeSetItem(STORAGE_KEY, trimmed)
}

/**
 * Clears the stored *global default* PAT. The very next Azure-DevOps-
 * touching request for a workspace with no override of its own then
 * carries no Authorization header, gets the structured
 * "authentication required" response back, and `apiFetch` re-prompts —
 * this function only needs to forget the credential, not orchestrate the
 * re-prompt itself. A workspace-specific override, if any exist, is left
 * untouched.
 */
export function clearPat() {
  const next = { ...patsByWorkspace.value }
  delete next[DEFAULT_WORKSPACE_KEY]
  patsByWorkspace.value = next
  safeRemoveItem(STORAGE_KEY)
}

/**
 * Whether `workspaceId` has its own PAT override set (distinct from the
 * global default) — the Settings screen's Workspace tab uses this to show
 * each workspace's PAT-override state. `false` for a falsy/`undefined`
 * `workspaceId` (a local instance has none) and for `DEFAULT_WORKSPACE_KEY`
 * itself (that key is the global default, never an "override" of itself).
 */
export function hasWorkspacePatOverride(workspaceId) {
  if (!workspaceId || workspaceId === DEFAULT_WORKSPACE_KEY) return false
  return Object.hasOwn(patsByWorkspace.value, workspaceId)
}

/**
 * Sets (or, given a blank value, clears) `workspaceId`'s own PAT override.
 * A no-op for a falsy `workspaceId` or `DEFAULT_WORKSPACE_KEY` itself —
 * neither is a real, overridable workspace.
 */
export function setWorkspacePatOverride(workspaceId, value) {
  if (!workspaceId || workspaceId === DEFAULT_WORKSPACE_KEY) return
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    clearWorkspacePatOverride(workspaceId)
    return
  }
  const next = { ...patsByWorkspace.value, [workspaceId]: trimmed }
  patsByWorkspace.value = next
  persistOverrides(next)
}

/**
 * Clears `workspaceId`'s own PAT override, falling back to the global
 * default automatically on the very next request for that workspace — the
 * same "just forget it, `apiFetch` handles the rest" shape `clearPat`
 * already has for the global default.
 */
export function clearWorkspacePatOverride(workspaceId) {
  if (!workspaceId || workspaceId === DEFAULT_WORKSPACE_KEY) return
  const next = { ...patsByWorkspace.value }
  delete next[workspaceId]
  patsByWorkspace.value = next
  persistOverrides(next)
}

/**
 * The PAT to use for `workspaceId` — that workspace's own override if one
 * is set, else the global default, else `null` (matching
 * `getCredential(req)`'s own "no usable credential" return value). A falsy
 * `workspaceId` (a local instance, or a caller with no workspace context at
 * all) always resolves straight to the global default — the same behavior
 * `authHeader()` (below) always had, before workspace overrides existed.
 */
export function patForWorkspace(workspaceId) {
  const map = patsByWorkspace.value
  if (workspaceId && Object.hasOwn(map, workspaceId)) return map[workspaceId]
  return map[DEFAULT_WORKSPACE_KEY] ?? null
}

/**
 * The `Authorization` header value to attach to a request targeting
 * `workspaceId` (or the global default, for a falsy `workspaceId`), or
 * `null` when no PAT resolves (or the resolved value can't be encoded as
 * one — see below). HTTP Basic auth with an empty username and the PAT as
 * the password — Azure DevOps's own supported PAT convention (per #82's
 * spec), the same scheme lib/credential.js's `getCredential(req)` decodes
 * on the server.
 */
export function authHeaderForWorkspace(workspaceId) {
  const value = patForWorkspace(workspaceId)
  if (!value) return null
  try {
    // `btoa` throws for any character outside Latin1 — e.g. a stray
    // smart-quote/invisible character from a rich-text paste into the PAT
    // field. Guarded the same way the server-side decode step
    // (lib/credential.js's `getCredential`) guards its own base64 step:
    // treat an unencodable value as "no usable credential" (`null`) rather
    // than letting a `DOMException` escape and surface as a cryptic error
    // in whichever caller happens to trigger this read.
    return `Basic ${btoa(`:${value}`)}`
  } catch {
    return null
  }
}

/**
 * The `Authorization` header value for the *global default* PAT only —
 * unchanged from before #104's workspace-keyed generalization. Every call
 * site that has a specific workspace in mind should prefer
 * `authHeaderForWorkspace` instead; this remains for the handful of
 * requests (e.g. `web/lib/validateRepo.js`'s repo-check, made before any
 * workspace exists to belong to) that only ever have the global default to
 * use in the first place.
 */
export function authHeader() {
  return authHeaderForWorkspace(DEFAULT_WORKSPACE_KEY)
}

// ---------- Prompt orchestration ----------
// `apiFetch` calls `requestPat(workspaceId)` whenever a request comes back
// with the structured "authentication required" response; `PatPromptModal`
// (in web/app.js) renders while `promptOpen` is true and calls
// `resolvePromptWith` once the architect submits or cancels. Concurrent
// callers (e.g. several in-flight requests all hitting
// `authentication_required` at once) share the single in-flight prompt
// instead of each opening their own modal — only the *first* caller (the
// one that actually opens the prompt) gets to influence where the
// submission lands; a caller that instead joins an already-open prompt
// (the `pendingResolve` chaining below) just shares that same outcome,
// exactly as it always has.
//
// #104 review fix: whether a submitted PAT lands in the global-default
// slot or a workspace-specific override depends on `workspaceId` — but
// only when that workspace *already has* its own override set.
// `hasWorkspacePatOverride(workspaceId)` is checked once, at the moment the
// prompt actually opens (not later, in `resolvePromptWith` — the override
// could otherwise be cleared/changed by something else while the prompt is
// still open). This distinction matters: the overwhelmingly common case is
// a request with *no* override at all (the workspace-unaware, pre-#104
// behavior every existing test already exercises) — for that case, a
// newly submitted PAT must still become the global default, exactly as
// before, not silently create a brand-new override the architect never
// asked for just because the request happened to know which workspace it
// was for. Only when a workspace's own override is the very thing that's
// (now) invalid does a resubmission repair *that* override instead —
// otherwise the retry would silently keep resending the same rejected
// override PAT forever, since `authHeaderForWorkspace` always prefers an
// existing override over the global default.
export const promptOpen = signal(false)

let pendingResolve = null
let pendingOverrideWorkspaceId = null

/**
 * Opens the PAT prompt (if not already open) and resolves once the
 * architect submits a PAT (`true`) or cancels (`false`). Callers that get
 * `true` back should re-read the relevant PAT (`pat.value`/`authHeader()`,
 * or `patForWorkspace`/`authHeaderForWorkspace` for a specific workspace)
 * and retry their request; callers that get `false` back should surface
 * their original authentication failure rather than retrying.
 *
 * `workspaceId` identifies which workspace the failing request targeted —
 * omit it (or pass a falsy value) for a request with no specific workspace
 * in mind, which always resolves to the global default, unchanged from
 * before workspace overrides existed.
 */
export function requestPat(workspaceId) {
  if (pendingResolve) {
    return new Promise((resolve) => {
      const previous = pendingResolve
      pendingResolve = (result) => {
        previous(result)
        resolve(result)
      }
    })
  }
  // See this section's own comment above for why this only ever targets an
  // *existing* override, never creates a new one from a plain PAT prompt.
  pendingOverrideWorkspaceId = hasWorkspacePatOverride(workspaceId) ? workspaceId : null
  promptOpen.value = true
  return new Promise((resolve) => {
    pendingResolve = resolve
  })
}

/**
 * Called by `PatPromptModal` when the architect submits (`patValue` set) or
 * cancels (`patValue` is `null`/omitted). Writes to whichever slot
 * `requestPat` recorded when the prompt was opened — a workspace's own
 * override if it already had one and that's what triggered the prompt, the
 * global default otherwise.
 */
export function resolvePromptWith(patValue) {
  const overrideWorkspaceId = pendingOverrideWorkspaceId
  pendingOverrideWorkspaceId = null
  if (patValue) {
    if (overrideWorkspaceId) {
      setWorkspacePatOverride(overrideWorkspaceId, patValue)
    } else {
      setPat(patValue)
    }
  }
  promptOpen.value = false
  const resolve = pendingResolve
  pendingResolve = null
  resolve?.(Boolean(patValue))
}
