// Wraps every request the web form makes to gantry's own API (#87): attaches the right Provider PAT (web/lib/credential.js) as an Authorization header whenever one is stored, and — if the server comes back with the structured "authentication required" response (lib/server.js's `sendAuthenticationRequired`, built per #86) — prompts the architect for one and retries the same request exactly once with it attached.
//
// A request to a local instance's routes never returns `authentication_required` in the first place, so this never prompts for one — there's nothing here that distinguishes "local" from "Provider-backed" up front; it only reacts to what the server actually says.
//
// A caller that knows which workspace a request targets passes `{ workspaceId }` as a third argument, and `authHeaderForWorkspace` resolves that workspace's own stored PAT — see web/lib/credential.js's own doc comment. #9 (ADR-0038): there is no global default any more, so a caller with no workspace in mind (or targeting a local instance) simply gets no Authorization header at all rather than falling back to one.
import { untracked } from '@preact/signals'
import { authHeaderForWorkspace, markCredentialRejected, requestPat } from './credential.js'

function isAuthenticationRequired(body) {
  return body && body.error === 'authentication_required'
}

async function readJsonBody(res) {
  // `res.clone()` so the caller's own `.json()`/`.text()` read of the response still works after this peeks at it — callers throughout web/app.js read the body themselves on both success and failure.
  return res
    .clone()
    .json()
    .catch(() => null)
}

function withAuthHeader(options, workspaceId) {
  // `untracked()` matters here: `apiFetch` is often called synchronously from inside a `@preact/signals` `effect()` (e.g. web/app.js's instance-loading effect runs on every `currentSlug`/`viewedStage` change) — an ordinary `authHeaderForWorkspace()` read of `patsByWorkspace.value` at that point would get recorded as a dependency of *that* effect too, since signals' dependency tracking captures any `.value` read reachable from an effect's synchronous call stack, however deeply nested. That would make the effect implicitly re-fire (issuing a redundant request) whenever the relevant PAT changes, on top of this function's own explicit one-time retry below — `untracked` keeps this read anonymous so `apiFetch` never becomes an accidental extra dependency of whatever reactive context happens to be calling it.
  const auth = untracked(() => authHeaderForWorkspace(workspaceId))
  if (!auth) return options
  // `new Headers(...)` normalizes a plain object, an existing `Headers` instance, or an array of tuples alike — a plain object-spread would silently drop every header if `options.headers` were ever a `Headers` instance instead of a plain object literal.
  const headers = new Headers(options.headers)
  headers.set('Authorization', auth)
  return { ...options, headers }
}

/**
 * Drop-in replacement for `fetch` for requests to gantry's own `/api/*` routes. Same signature and return value (a `Response`) as `fetch` itself, so existing callers only need their `fetch(...)` calls renamed. The optional third argument's `workspaceId` selects which workspace's own PAT to attach — omit it (or leave it `undefined`) for a request with no specific workspace in mind (or a local instance), which attaches no Authorization header at all (#9: there is no global default left to fall back to). `silent: true` skips the auto-prompt-and-retry below entirely, returning the bare 401 response instead — for a best-effort background request (e.g. IdentityPicker's debounced search-as-you-type) where a missing/rejected credential is routine and already handled inline; popping the page-wide PAT modal for that would interrupt whatever the architect is actually doing over a request they never asked for.
 */
export async function apiFetch(url, options = {}, { workspaceId, silent } = {}) {
  let res = await fetch(url, withAuthHeader(options, workspaceId))
  if (res.status !== 401) return res

  const body = await readJsonBody(res)
  if (!isAuthenticationRequired(body)) return res
  if (silent) return res

  if (body.credentialStatus === 'rejected') markCredentialRejected(workspaceId)
  // `workspaceId` is threaded through so `requestPat` can tell whether this 401 came from a workspace whose *own* override is the thing that's now invalid — see web/lib/credential.js's own doc comment on `requestPat`/`resolvePromptWith` for why that changes where the architect's submission gets written.
  const granted = await requestPat(workspaceId, body.credentialStatus === 'rejected' ? body : null)
  if (!granted) return res

  const retry = await fetch(url, withAuthHeader(options, workspaceId))
  if (retry.status === 401) {
    const retryBody = await readJsonBody(retry)
    if (isAuthenticationRequired(retryBody) && retryBody.credentialStatus === 'rejected') {
      markCredentialRejected(workspaceId)
    }
  }
  return retry
}

// ---------- Instance-scoped requests (#104) ----------
// Resolves, and caches for the lifetime of the page, which workspace a given instance slug belongs to (`null` for a local instance, or one gantry has never heard of) — a plain, uncredentialed registry lookup (`GET /api/instance/workspace`, no PAT required or consulted), not an Azure DevOps call itself. This has to happen *before* the actual Azure-DevOps-touching request goes out, not merely on a 401 retry: resolving it only after a first, credential-less attempt would mean a workspace whose *override* PAT is the only one that's actually valid would need to fail once (a real 401 round-trip against the caller's Azure DevOps org, not just this server) before this module could even learn which workspace to resolve that override for.
//
// Only a *successful* resolution is cached — a failed attempt (network error, non-2xx response, malformed JSON) is deliberately left uncached, so the very next call for that slug tries again instead of permanently treating a transient hiccup the same as "definitely no workspace" for the rest of the page's life. A review pass on this ticket flagged the earlier "cache every outcome, including failures" version as a real regression risk: one bad lookup would silently and irrecoverably fall back to the global default PAT for that instance until a full page reload, defeating the override this ticket exists to support.
const instanceScopeBySlug = new Map()

const NO_SCOPE = { workspaceId: null, scope: null }

async function resolveInstanceScopeForSlug(slug) {
  if (!slug) return NO_SCOPE
  if (instanceScopeBySlug.has(slug)) return instanceScopeBySlug.get(slug)
  const res = await fetch(`/api/instance/workspace?slug=${encodeURIComponent(slug)}`).catch(() => null)
  if (!res || !res.ok) return NO_SCOPE
  // `undefined` (never a real parsed JSON value — valid JSON can't parse to `undefined`) distinguishes "the response body itself was malformed" from a well-formed `{ workspaceId: null }` (a genuinely local/unknown slug) — only the latter is a real, cacheable answer; the former is just another flavor of failed lookup and must not be cached either.
  const body = await res.json().catch(() => undefined)
  if (body === undefined) return NO_SCOPE
  const resolved = { workspaceId: body?.workspaceId ?? null, scope: body?.scope ?? null }
  // Cache only now, once the lookup is known-good — see this function's own doc comment above.
  instanceScopeBySlug.set(slug, resolved)
  return resolved
}

/**
 * The cached workspace token for `slug`, or `null` when nothing has looked it up yet (WI #366).
 * Synchronous on purpose: it serves the URLs the *browser* fetches rather than this module —
 * an `<img src>` or a citation link (`assetFileUrl` in web/app.js) — which have to be built during
 * render with no chance to await. Anything the module editor displays has already been loaded
 * through `apiFetchForInstance`, so by then the entry is warm; a miss just yields the bare-slug URL,
 * which still resolves and still warns, exactly as before.
 */
export function cachedScopeForSlug(slug) {
  return instanceScopeBySlug.get(slug)?.scope ?? null
}

// WI #366: carries the instance's workspace on the request, so the server resolves the slug within
// that one workspace rather than searching every workspace for it (the deprecated path, which warns
// on every call and breaks outright once two workspaces share a slug). Done here, once, rather than
// at each of this module's ~27 instance-scoped call sites — every one of them already routes through
// `apiFetchForInstance`, and every one of them wants the same answer. An existing `scope=` on the URL
// is left alone so a deliberate caller-supplied one always wins.
function withScope(url, scope) {
  if (!scope || /[?&]scope=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}scope=${encodeURIComponent(scope)}`
}

/**
 * `apiFetch`, but resolving which workspace `slug` belongs to first, so a workspace-specific PAT override (set from the Settings screen's Workspace tab, #104) is used from the very first request rather than only after an initial 401 against the wrong credential. Every call site that already knows which instance slug a request targets (loading/saving/rendering/checking an instance) should use this instead of calling `apiFetch` directly.
 */
export async function apiFetchForInstance(slug, url, options = {}, { silent } = {}) {
  const { workspaceId, scope } = await resolveInstanceScopeForSlug(slug)
  // #9 (ADR-0038): a genuinely local instance resolves no real `workspaceId` (there is no workspace
  // record at all) — but a local instance can still be linked to a remote Provider's work item
  // (CONTEXT.md's "Check gate & sync work item": "Available for any instance with a linked work item,
  // local or Workspace-backed alike"), and *that* still needs a credential to reach it. With the
  // global-default tier gone there is nowhere else for one to live, so this falls back to the
  // instance's own `slug` as its credential key — its own, stable, single-instance-scoped "workspace"
  // for exactly this purpose. A local instance's own content routes never return
  // `authentication_required` in the first place (they need no Provider at all), so this fallback is
  // inert for them; it only matters for the work-item sub-routes that do.
  return apiFetch(withScope(url, scope), options, { workspaceId: workspaceId ?? slug, silent })
}

// `resolveInstanceScopeForSlug`'s own sibling for a numeric reference (WI200/docs/adr/0024,
// `w<workspaceNumber>i<instanceNumber>` etc.) rather than a slug — a separate cache, since the two are
// different keys into the same underlying scope. #9 (ADR-0038): before this existed, resolving a
// numeric ref (web/app.js's `resolveInstanceRef`, used by the instance switcher and any bookmarked
// `wNiM` URL) went straight through plain `apiFetch` with no workspace in mind at all — harmless while
// a global-default PAT existed to fall back to, but with no fallback left this ticket's own removal of
// that tier would otherwise leave a Provider-backed instance's numeric-ref navigation with no way to
// attach a credential even after prompting for one (the prompt has no workspace to persist the
// submission against, and the retry has nothing to attach either). `GET /api/instance/workspace`
// already accepts `?ref=` server-side (`resolveSlugParam`'s own doc comment) — this just calls it the
// same uncredentialed-lookup-first way `resolveInstanceScopeForSlug` does for a slug.
const instanceScopeByRef = new Map()

async function resolveInstanceScopeForRef(ref) {
  if (!ref) return NO_SCOPE
  if (instanceScopeByRef.has(ref)) return instanceScopeByRef.get(ref)
  const res = await fetch(`/api/instance/workspace?ref=${encodeURIComponent(ref)}`).catch(() => null)
  if (!res || !res.ok) return NO_SCOPE
  const body = await res.json().catch(() => undefined)
  if (body === undefined) return NO_SCOPE
  const resolved = { workspaceId: body?.workspaceId ?? null, scope: body?.scope ?? null }
  instanceScopeByRef.set(ref, resolved)
  return resolved
}

/**
 * `apiFetch`, but resolving which workspace a numeric `ref` (not yet a known slug) belongs to first —
 * the `ref`-keyed counterpart to `apiFetchForInstance` above, for the one call site (`resolveInstanceRef`)
 * that only has a `ref` to address an instance by.
 */
export async function apiFetchForInstanceRef(ref, url, options = {}, { silent } = {}) {
  const { workspaceId, scope } = await resolveInstanceScopeForRef(ref)
  return apiFetch(withScope(url, scope), options, { workspaceId, silent })
}
