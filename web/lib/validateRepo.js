// Stubbed validate(repoUrl) contract for the instance-setup wizard (Azure
// DevOps #78). The real Azure DevOps sync/auth mechanism — git clone vs
// REST API, credentials/service connections — is deliberately deferred,
// per docs/adr/0005-instance-data-in-external-ado-repo.md ("the actual
// sync/auth mechanism is deliberately *not* decided here"). Every variant
// in web/prototypes/instance-setup-wizard.prototype.html stood this call in
// with a "simulate:" dropdown; this is the real (if stubbed) contract that
// UI ends up wired to.
//
// Rather than a pure fake, this treats the repo's name (the last path
// segment of its URL) as an instance slug, and checks it against gantry's
// *own* multi-instance registry (`GET /api/instances`, #76) — not against
// Azure DevOps itself. That's still an honest stand-in: a slug already
// registered there is `existing` (returning that instance's real
// definition/stage/status/owner for the wizard's found-vs-picked
// comparison); an unregistered-but-well-formed URL is `empty`; a URL
// gantry can't even parse a repo name out of, or a registry lookup that
// fails outright, is `error` — the same failure mode a real
// unreachable-repo network error would eventually replace this with.

const REPO_URL_RE = /\/([^/]+?)(?:\.git)?\/?$/

/** The last path segment of a repo URL, treated as the instance slug — '' if none can be parsed out. */
export function repoSlug(repoUrl) {
  const match = typeof repoUrl === 'string' ? repoUrl.trim().match(REPO_URL_RE) : null
  return match ? match[1] : ''
}

/**
 * @param {string} repoUrl
 * @returns {Promise<
 *   | { result: 'empty', slug: string }
 *   | { result: 'existing', slug: string, instance: { slug: string, definition: string, stage: string, status: string, owner: string } }
 *   | { result: 'error', message: string }
 * >}
 */
export async function validateRepo(repoUrl) {
  const slug = repoSlug(repoUrl)
  if (!slug) {
    return {
      result: 'error',
      message: "Couldn't parse a repo name from this URL — check it's a full Azure DevOps repo URL.",
    }
  }

  let registry
  try {
    const res = await fetch('/api/instances')
    if (!res.ok) throw new Error(`registry lookup failed (${res.status})`)
    registry = await res.json()
  } catch {
    return { result: 'error', message: "Couldn't reach this repo — check the URL and that gantry has access." }
  }

  const instance = registry.find((i) => i.slug === slug)
  return instance ? { result: 'existing', slug, instance } : { result: 'empty', slug }
}
