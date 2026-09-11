// A slug must name a single path segment — never a path traversal token (`..`, `.`) or anything containing a path separator. This matters wherever a slug can arrive from request input rather than only a trusted CLI argument at server startup: without this check, a slug like `../../etc` would flow straight into `join(instancesDir, slug, ...)` (lib/instance.js's local-filesystem paths) or `gantry-workspace/${slug}/...` (its Azure-DevOps-backed paths, #100), reading or writing files outside the intended directory entirely.
//
// Shared by lib/server.js (every slug arriving via request input — a `?slug=` query param, a request body's `slug` field) and lib/repoCheck.js (a slug *discovered* from a remote repo's own instance.yaml — untrusted third-party content, not something gantry itself wrote — before it's used to build a migration or lookup path) so exactly one definition of "valid slug" is ever enforced, rather than each caller maintaining its own copy that could silently drift.
const SINGLE_SEGMENT_RE = /^[^\\/]+$/

export function isValidSlug(slug) {
  return typeof slug === 'string' && slug !== '' && slug !== '.' && slug !== '..' && SINGLE_SEGMENT_RE.test(slug)
}

// WI #366: the workspace-qualified address form the deprecation notice in lib/instanceRegistry.js
// asks callers to use — "<workspace>/<slug>". Deliberately a *separate* parser rather than a looser
// `isValidSlug`: both halves are still validated as single segments by the same rule above, so the
// traversal guard that protects `join(instancesDir, slug, ...)` is unchanged and a slug that reaches
// the filesystem is still never a path. Returns `{ workspace, slug }` for a qualified address,
// `{ workspace: undefined, slug }` for a plain one, or `undefined` if either half is not a valid
// segment (including the "a/b/c" case, which is not an address this grammar has a meaning for).
export function parseInstanceAddress(address) {
  if (typeof address !== 'string' || address === '') return undefined
  const separator = address.indexOf('/')
  if (separator === -1) return isValidSlug(address) ? { workspace: undefined, slug: address } : undefined
  const workspace = address.slice(0, separator)
  const slug = address.slice(separator + 1)
  if (!isValidSlug(workspace) || !isValidSlug(slug)) return undefined
  return { workspace, slug }
}
