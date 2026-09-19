import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL } from './gitlabClient.js'

const PROVIDER = 'gitlab'

// GitLab's own access-level scale (https://docs.gitlab.com/ee/api/members.html#roles):
// 10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner. A field this client gates
// (`enforceAssignability` on web/lib/identityPicker.js) treats Reporter and above as "sufficient
// access to be meaningfully assigned" — GitLab itself requires at least Reporter to be assigned an
// issue or merge request (a Guest can be *mentioned* but not assigned), the closest GitLab analogue
// to GitHub's own "must have repository access at all" gate (#10, docs/adr/0040). Recorded here (and
// in docs/adr/0041-gitlab-as-third-provider.md) as the one place that threshold is decided, since
// later Provider tickets (#33 MR-gated sign-off, #34 Request Review) reuse the same distinction.
const MINIMUM_ASSIGNABLE_ACCESS_LEVEL = 20

/**
 * GitLab's identity capability (#28, mirroring GitHub's own #10/docs/adr/0040 "The person picker
 * unions collaborators with org members, and gates assignment on access"): resolves a name-as-typed
 * to candidate people the front-end's identity picker presents, scoped to one project.
 *
 * Unlike GitHub — which has to union two separate endpoints (repo collaborators, org members) and
 * then resolve each org member's own effective permission — GitLab's Members API already folds
 * inherited group (and subgroup) membership into a project's own member list server-side:
 * `GET /projects/:id/members/all` (the "all" variant, as opposed to `/members`, which is direct
 * members only) returns every person who can act on this project, direct or inherited, each already
 * carrying their own `access_level`. That single response is this client's whole candidate set — no
 * second per-user lookup needed, and no personal-vs-group-owned distinction to branch on.
 *
 * Every result still needs a *can this actually be assigned* answer: `canAssign` is `true` once
 * `access_level >= 20` (Reporter or above — see `MINIMUM_ASSIGNABLE_ACCESS_LEVEL` above), `false` (with
 * a `blockedReason`) for a Guest, mirroring GitHub's `canAssign`/`blockedReason` shape exactly so
 * `web/lib/identityPicker.js` needs no provider-specific branch to render either one.
 *
 * Same result shape as `lib/githubIdentityClient.js`/`lib/azureDevOpsIdentityClient.js`'s own
 * `{ uniqueName, displayName, emailAddress, id }`, plus `canAssign` and, when `false`,
 * `blockedReason` — a caller that never gates on assignability (the workspace Owner field, a library
 * repo's code owner — Gantry-side fields that never become a GitLab assignee) simply ignores both and
 * accepts any resolved person.
 */
export function createGitLabIdentityClient({ namespace, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ namespace, repository, pat })) {
    if (!value) throw new Error(`createGitLabIdentityClient: "${name}" is required`)
  }

  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '')
  const projectId = encodeURIComponent(`${namespace}/${repository}`)
  const projectUrl = `${trimmedBaseUrl}/projects/${projectId}`

  function authHeaders() {
    return { 'PRIVATE-TOKEN': pat }
  }

  async function request(url) {
    let res
    try {
      res = await fetch(url, { headers: authHeaders() })
    } catch (err) {
      throw new RequestError(`Network error calling GitLab API (GET ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitLab rejected the supplied PAT (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`GitLab found no item for GET ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new RequestError(`GitLab API request failed: GET ${url} -> HTTP ${res.status}`, { provider: PROVIDER, status: res.status, body })
    }
    return res
  }

  function toIdentity({ username, id, name, access_level: accessLevel }) {
    const canAssign = (accessLevel ?? 0) >= MINIMUM_ASSIGNABLE_ACCESS_LEVEL
    return {
      uniqueName: username,
      displayName: name || username,
      emailAddress: '',
      id,
      canAssign,
      ...(canAssign
        ? {}
        : {
            blockedReason: `"${username}" does not have sufficient access to ${namespace}/${repository} to be assigned — GitLab requires at least Reporter access, granted directly or through the group, then retry.`,
          }),
    }
  }

  /**
   * Searches for candidates matching `query` against this project's own (and inherited group's)
   * members — GitLab's own `query` parameter on the Members API does the substring match server-side
   * (case-insensitive, against username/name/public email), so this client sends `query` straight
   * through rather than fetching every member and filtering client-side the way
   * `lib/githubIdentityClient.js` has to (GitHub's collaborators/members endpoints have no equivalent
   * search parameter).
   */
  async function searchIdentities(query) {
    if (!query || !query.trim()) return []
    const q = query.trim()
    const url = new URL(`${projectUrl}/members/all`)
    url.searchParams.set('query', q)
    url.searchParams.set('per_page', '100')
    const res = await request(url.toString())
    const members = await res.json()
    return members.map(toIdentity).sort((a, b) => a.uniqueName.localeCompare(b.uniqueName))
  }

  /**
   * Resolves a single username to its full identity, or `null` if nothing matches — mirrors
   * `lib/githubIdentityClient.js`/`lib/azureDevOpsIdentityClient.js`'s own `resolveIdentity`, used the
   * same way (re-resolving an effective assignee/reviewer immediately before attaching them to a
   * GitLab issue or merge request).
   */
  async function resolveIdentity(value) {
    if (!value || !value.trim()) return null
    const trimmed = value.trim()
    const results = await searchIdentities(trimmed)
    if (results.length === 0) return null
    return results.find((r) => r.uniqueName.toLowerCase() === trimmed.toLowerCase()) ?? results[0]
  }

  return { namespace, repository, baseUrl, searchIdentities, resolveIdentity }
}

export { MINIMUM_ASSIGNABLE_ACCESS_LEVEL }
