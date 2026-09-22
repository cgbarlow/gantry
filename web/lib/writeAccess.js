// #126 (parent #109, docs/adr/0047): the web client's half of "whether someone can write is
// established by an explicit check when they enter a credential, and remembered". The check itself is
// `GET /api/workspaces/:id/write-access` (lib/server.js, gated through the same
// `WITH_PROVIDER_CREDENTIAL` seam every other provider-backed route uses — no `sharedPat` fallback, so
// it only ever answers for the caller's own stored credential); this module is the one place that
// calls it, so it's the one place that decides when a check is due and where its answer is remembered
// (web/lib/credential.js's `hasCheckedWriteAccess`/`setWriteAccessForWorkspace`).
import { authHeaderForWorkspace, hasPatForWorkspace, hasCheckedWriteAccess, setWriteAccessForWorkspace, markCredentialRejected } from './credential.js'

// One in-flight request per workspace at a time — `ensureWriteAccessChecked` is meant to be called
// from a render-time effect that can legitimately re-run several times before the first request lands
// (e.g. every `instanceData` update while a shared instance is still loading its stage content). This
// is what makes "run this check ONCE" true in practice, not just in the common case: a second call
// that arrives while the first is still in flight is a no-op, not a second HTTP request.
const inFlight = new Set()

/**
 * Runs #126's write-access check for `workspaceId`'s *currently stored* credential, exactly once, and
 * remembers the result — a no-op when there's no credential to ask about yet (nothing entered), when
 * this credential has already been asked (`hasCheckedWriteAccess`), or while a check for this
 * workspace is already in flight. Deliberately bypasses `web/lib/apiFetch.js`'s generic 401-retry
 * machinery rather than reusing `apiFetch` itself: a credential this workspace's Provider rejects must
 * never pop the blocking PAT-prompt modal from this background call — that prompt is `apiFetch`'s own
 * job, reserved for an actual read or write the person just asked for. A rejection here is instead
 * folded into the same `markCredentialRejected` state `apiFetch` itself would set, so the interface
 * still shows "rejected", not "confirmed read-only" (#126's own acceptance criterion that the two stay
 * distinguishable) — see web/lib/credential.js's own doc comment on why `markCredentialRejected` also
 * clears any stale write-access answer.
 *
 * Safe to call from a `@preact/signals` effect that re-runs on every render of a shared instance's
 * editor/settings screen — every one of its early-return guards above is what keeps that cheap.
 */
export async function ensureWriteAccessChecked(workspaceId) {
  if (!workspaceId) return
  if (!hasPatForWorkspace(workspaceId)) return
  if (hasCheckedWriteAccess(workspaceId)) return
  if (inFlight.has(workspaceId)) return

  inFlight.add(workspaceId)
  try {
    const auth = authHeaderForWorkspace(workspaceId)
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/write-access`, {
      headers: auth ? { Authorization: auth } : {},
    })
    if (res.status === 401) {
      const body = await res.json().catch(() => null)
      if (body?.error === 'authentication_required' && body?.credentialStatus === 'rejected') {
        markCredentialRejected(workspaceId)
      }
      // A bare (non-"rejected") authentication_required here means this call raced a credential clear
      // — nothing to remember; the next credential entry re-triggers this from scratch.
      return
    }
    if (!res.ok) return
    const body = await res.json().catch(() => null)
    if (body && typeof body.canWrite === 'boolean') setWriteAccessForWorkspace(workspaceId, body.canWrite)
  } catch {
    // Network failure — leave unchecked. Whatever next re-runs `ensureWriteAccessChecked` (a re-render,
    // a later credential change) tries again; there is nothing here worth remembering as a "no".
  } finally {
    inFlight.delete(workspaceId)
  }
}
