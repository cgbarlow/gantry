// Wraps every request the web form makes to gantry's own API (#87): attaches
// the stored Azure DevOps PAT (web/lib/credential.js) as an Authorization
// header whenever one is stored, and — if the server comes back with the
// structured "authentication required" response (lib/server.js's
// `sendAuthenticationRequired`, built per #86) — prompts the architect for
// one and retries the same request exactly once with it attached.
//
// A request to a local instance's routes never returns
// `authentication_required` in the first place, so this never prompts for
// one — there's nothing here that distinguishes "local" from
// "Azure-DevOps-backed" up front; it only reacts to what the server actually
// says.
import { untracked } from '@preact/signals'
import { authHeader, requestPat } from './credential.js'

function isAuthenticationRequired(body) {
  return body && body.error === 'authentication_required'
}

async function readJsonBody(res) {
  // `res.clone()` so the caller's own `.json()`/`.text()` read of the
  // response still works after this peeks at it — callers throughout
  // web/app.js read the body themselves on both success and failure.
  return res
    .clone()
    .json()
    .catch(() => null)
}

function withAuthHeader(options) {
  // `untracked()` matters here: `apiFetch` is often called synchronously
  // from inside a `@preact/signals` `effect()` (e.g. web/app.js's
  // instance-loading effect runs on every `currentSlug`/`viewedStage`
  // change) — an ordinary `authHeader()` read of `pat.value` at that point
  // would get recorded as a dependency of *that* effect too, since signals'
  // dependency tracking captures any `.value` read reachable from an
  // effect's synchronous call stack, however deeply nested. That would
  // make the effect implicitly re-fire (issuing a redundant request)
  // whenever the PAT changes, on top of this function's own explicit
  // one-time retry below — `untracked` keeps this read anonymous so
  // `apiFetch` never becomes an accidental extra dependency of whatever
  // reactive context happens to be calling it.
  const auth = untracked(() => authHeader())
  if (!auth) return options
  // `new Headers(...)` normalizes a plain object, an existing `Headers`
  // instance, or an array of tuples alike — a plain object-spread would
  // silently drop every header if `options.headers` were ever a `Headers`
  // instance instead of a plain object literal.
  const headers = new Headers(options.headers)
  headers.set('Authorization', auth)
  return { ...options, headers }
}

/**
 * Drop-in replacement for `fetch` for requests to gantry's own `/api/*`
 * routes. Same signature and return value (a `Response`) as `fetch` itself,
 * so existing callers only need their `fetch(...)` calls renamed.
 */
export async function apiFetch(url, options = {}) {
  let res = await fetch(url, withAuthHeader(options))
  if (res.status !== 401) return res

  const body = await readJsonBody(res)
  if (!isAuthenticationRequired(body)) return res

  const granted = await requestPat()
  if (!granted) return res

  return fetch(url, withAuthHeader(options))
}
