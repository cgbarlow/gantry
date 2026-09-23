// #131 (parent #109, docs/adr/0047): the web client's half of "a credential entered in the browser
// populates the workspace it was entered for".
//
// The gap this closes: `DashboardPage`'s listing request is `GET /api/instances`, which spans every
// workspace at once — so `web/lib/apiFetch.js` has no single workspace to resolve a credential for
// and attaches none (docs/adr/0038 removed the global default deliberately). Uncredentialed, the
// server can neither discover a Provider-backed workspace's instances (discovery needs a credential to
// attempt) nor read them (each row needs one too), so a browser credential alone could never make a
// Provider-backed workspace show anything — only a deployment-held shared credential (#121) could.
//
// The fix is one workspace-scoped listing request per workspace the dashboard holds a credential for
// and cannot otherwise show (`GET /api/workspaces/:id/instances`, lib/server.js), whose rows the
// dashboard merges into the unscoped listing's own. Naming the workspace in the URL is what lets a
// credential be attached at all, and what keeps it scoped: workspace A's credential is only ever sent
// to a URL naming workspace A, and the server scopes both the discovery attempt and the rows it builds
// to that same workspace.
//
// Which workspaces qualify is `web/lib/dashboardWorkspaces.js`'s `workspacesNeedingOwnListing` — a
// pure function over plain data, unit-tested on its own. This module is the impure half: the request,
// the per-page-session bounds on how often it may be issued, and the existing rejected-credential
// state it folds a turned-down credential into.
import { untracked } from '@preact/signals'
import { authHeaderForWorkspace, credentialStatusForWorkspace, markCredentialRejected } from './credential.js'
import { workspacesNeedingOwnListing } from './dashboardWorkspaces.js'

// Every workspace this page-session has already issued a scoped listing request for — the bound that
// makes "no retry loop" true rather than merely unlikely. A workspace whose request failed (rejected
// credential, network error, unreachable Provider) stays in here, so a dashboard that re-renders or
// reloads its listing never re-attempts it; `resetWorkspaceDiscovery` below is the one deliberate way
// back in, called when a NEW credential is entered for that workspace (there is genuinely something
// new to try then).
const attempted = new Set()

// The rows each attempted workspace came back with, so a later reload of the dashboard listing (an
// archive/restore, say) keeps showing them without re-issuing the request — `attempted` alone would
// otherwise make those rows disappear on the second load, which is exactly the "designs appear, then
// vanish" behaviour this ticket exists to avoid.
const rowsByWorkspace = new Map()

// One in-flight request per workspace, for the same reason web/lib/writeAccess.js keeps one: this can
// legitimately be called again before the first request lands.
const inFlight = new Map()

/**
 * Re-arms #131's scoped listing for `workspaceId` — called when a new credential is stored for it
 * (web/pages/settings.js), since the credential that failed, or that wasn't there, is no longer the
 * one that would be tried. Without this, correcting a rejected credential would need a full page
 * reload before the workspace's designs could appear.
 */
export function resetWorkspaceDiscovery(workspaceId) {
  if (!workspaceId) return
  attempted.delete(workspaceId)
  rowsByWorkspace.delete(workspaceId)
}

// `untracked()` for every credential read, for exactly the reason web/lib/apiFetch.js's own
// `withAuthHeader` uses it: these reads can happen inside a reactive context, and an implicit
// dependency on a PAT signal would make that context re-fire (re-issuing requests) on every credential
// change, on top of this module's own explicit bounds above.
function credentialStatus(workspaceId) {
  return untracked(() => credentialStatusForWorkspace(workspaceId))
}

async function fetchWorkspaceRows(workspaceId) {
  const auth = untracked(() => authHeaderForWorkspace(workspaceId))
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/instances`, {
    headers: auth ? { Authorization: auth } : {},
  })
  if (res.status === 401) {
    const body = await res.json().catch(() => null)
    // The existing rejected-credential path, not a new bespoke one — `markCredentialRejected` is the
    // same state web/lib/apiFetch.js sets when any other route turns a credential down, so Settings
    // reports "rejected" and the architect is told what to fix. Deliberately no `requestPat` prompt:
    // this is a background request nobody asked for, and popping the page-wide modal over it would
    // interrupt whatever they were actually doing (web/lib/writeAccess.js makes the same call).
    if (body?.error === 'authentication_required' && body?.credentialStatus === 'rejected') {
      markCredentialRejected(workspaceId)
    }
    return []
  }
  if (!res.ok) return []
  const body = await res.json().catch(() => null)
  return Array.isArray(body) ? body : []
}

/**
 * The rows for every workspace `workspacesNeedingOwnListing` selects, fetched at most once per
 * workspace per page-session and remembered — `instances` is the unscoped `GET /api/instances`
 * listing, `workspaces` the `GET /api/workspaces` one. Returns a flat array of registry rows in the
 * same shape those two already join on, for the dashboard to merge; `[]` when nothing qualifies (a
 * purely local dashboard, a deployment with a shared credential configured, or a browser holding no
 * credentials at all — in every one of those cases no request is issued for any workspace).
 *
 * Never rejects: a workspace whose request fails contributes no rows and is not retried, exactly like
 * a workspace the unscoped listing already couldn't show.
 */
export async function loadWorkspaceScopedInstances(instances, workspaces) {
  // 'set' — not merely "a PAT is stored": a credential this workspace's Provider has already turned
  // down ('rejected') must not be sent again on a background request, which is what keeps a bad
  // credential from being re-attempted on every dashboard load.
  const ids = workspacesNeedingOwnListing(instances, workspaces, (id) => credentialStatus(id) === 'set')
  // Already-remembered rows and an already-in-flight request both still count as "wanted" — the first
  // so a reload keeps showing them, the second so a caller that arrives mid-request waits for the
  // same answer rather than being told there are no rows. Everything else already attempted is out,
  // which is what stops a failed workspace from being retried in a loop.
  const wanted = ids.filter((id) => rowsByWorkspace.has(id) || inFlight.has(id) || !attempted.has(id))
  if (wanted.length === 0) return []

  const perWorkspace = await Promise.all(
    wanted.map((id) => {
      if (rowsByWorkspace.has(id)) return rowsByWorkspace.get(id)
      if (inFlight.has(id)) return inFlight.get(id)
      attempted.add(id)
      const request = fetchWorkspaceRows(id)
        .catch(() => [])
        .then((rows) => {
          // Only a non-empty result is worth remembering: an empty one is either a genuinely empty
          // workspace or a failure, and neither is a row the dashboard needs to keep showing.
          if (rows.length > 0) rowsByWorkspace.set(id, rows)
          return rows
        })
        .finally(() => inFlight.delete(id))
      inFlight.set(id, request)
      return request
    })
  )
  return perWorkspace.flat()
}
