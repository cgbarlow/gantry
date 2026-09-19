import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL } from './githubClient.js'

const API_VERSION_HEADER = '2022-11-28'
const PROVIDER = 'github'

/**
 * GitHub's identity capability (#10, docs/adr/0040 "The person picker unions collaborators with org
 * members, and gates assignment on access"): resolves a name-as-typed to candidate people the
 * front-end's identity picker presents, scoped to one repository — the union of that repository's
 * collaborators (direct or team-granted — real GitHub's own `affiliation=all` already folds team
 * access into this list) and, when the repository belongs to an organization, that organization's
 * members.
 *
 * Every result still needs a *can this actually be assigned* answer, because GitHub rejects an issue
 * assignee who lacks repository access. A collaborator always can (they're in that list precisely
 * because they have access, however it was granted). An organization member who *isn't* already a
 * collaborator is resolved through the per-user permission endpoint
 * (`GET /repos/{owner}/{repo}/collaborators/{username}/permission`) — this is what makes "access
 * granted through a team" resolve correctly even for someone the collaborators list itself doesn't
 * surface.
 *
 * Same result shape as `lib/azureDevOpsIdentityClient.js`'s own `{ uniqueName, displayName,
 * emailAddress, id }`, plus `canAssign` and, when `false`, `blockedReason` — a caller that never gates
 * on assignability (the workspace Owner field, a library repo's code owner — Gantry-side fields that
 * never become a GitHub assignee, per ADR-0040) simply ignores both and accepts any resolved person.
 */
export function createGitHubIdentityClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createGitHubIdentityClient: "${name}" is required`)
  }

  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '')
  const repoUrl = `${trimmedBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  function authHeaders() {
    return {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION_HEADER,
    }
  }

  async function request(url) {
    let res
    try {
      res = await fetch(url, { headers: authHeaders() })
    } catch (err) {
      throw new RequestError(`Network error calling GitHub API (GET ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitHub rejected the supplied PAT (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`GitHub found no item for GET ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new RequestError(`GitHub API request failed: GET ${url} -> HTTP ${res.status}`, { provider: PROVIDER, status: res.status, body })
    }
    return res
  }

  // Cached for this client's lifetime — every search against the same client is scoped to the same
  // repository, so its owner/owner-type never changes mid-instance.
  let repoInfoPromise
  function getRepoInfo() {
    if (!repoInfoPromise) repoInfoPromise = request(repoUrl).then((res) => res.json())
    return repoInfoPromise
  }

  async function listCollaborators() {
    const url = new URL(`${repoUrl}/collaborators`)
    url.searchParams.set('affiliation', 'all')
    url.searchParams.set('per_page', '100')
    const res = await request(url.toString())
    return res.json()
  }

  async function listOrgMembers(org) {
    const url = new URL(`${trimmedBaseUrl}/orgs/${encodeURIComponent(org)}/members`)
    url.searchParams.set('per_page', '100')
    try {
      const res = await request(url.toString())
      return res.json()
    } catch (err) {
      // A PAT that can see the repo but lacks org-read access reports the member list as 404 — treated
      // as "no other org members visible" rather than failing the whole search over it.
      if (err instanceof NotFoundError) return []
      throw err
    }
  }

  async function getPermission(username) {
    const res = await request(`${repoUrl}/collaborators/${encodeURIComponent(username)}/permission`)
    const data = await res.json()
    return data.permission ?? 'none'
  }

  function toIdentity({ login, id }, canAssign) {
    return {
      uniqueName: login,
      displayName: login,
      emailAddress: '',
      id,
      canAssign,
      ...(canAssign
        ? {}
        : {
            blockedReason: `"${login}" does not have access to ${owner}/${repository} — grant repository access directly or through a team, then retry.`,
          }),
    }
  }

  /**
   * Searches for candidates matching `query` (case-insensitive substring against the GitHub login) —
   * the union of this repository's collaborators and, when it belongs to an organization, that
   * organization's members, de-duplicated by login. `canAssign` is `true` outright for every
   * collaborator; for an organization member who isn't already one, it's resolved via the per-user
   * permission endpoint (`false` when GitHub reports `'none'`).
   */
  async function searchIdentities(query) {
    if (!query || !query.trim()) return []
    const q = query.trim().toLowerCase()

    const [repo, collaborators] = await Promise.all([getRepoInfo(), listCollaborators()])

    const candidates = new Map()
    for (const c of collaborators) {
      candidates.set(c.login, { login: c.login, id: c.id, canAssign: true })
    }

    if (repo.owner?.type === 'Organization') {
      const members = await listOrgMembers(repo.owner.login)
      for (const m of members) {
        if (candidates.has(m.login)) continue
        candidates.set(m.login, { login: m.login, id: m.id, canAssign: undefined })
      }
    }

    const matched = [...candidates.values()].filter((c) => c.login.toLowerCase().includes(q))

    const resolved = await Promise.all(
      matched.map(async (c) => {
        if (c.canAssign === undefined) c.canAssign = (await getPermission(c.login)) !== 'none'
        return c
      })
    )

    return resolved.map((c) => toIdentity(c, c.canAssign)).sort((a, b) => a.uniqueName.localeCompare(b.uniqueName))
  }

  /**
   * Resolves a single login to its full identity, or `null` if nothing matches — mirrors
   * `lib/azureDevOpsIdentityClient.js`'s own `resolveIdentity`, used the same way (re-resolving an
   * effective assignee/reviewer immediately before attaching them to a GitHub issue or PR).
   */
  async function resolveIdentity(value) {
    if (!value || !value.trim()) return null
    const trimmed = value.trim()
    const results = await searchIdentities(trimmed)
    if (results.length === 0) return null
    return results.find((r) => r.uniqueName.toLowerCase() === trimmed.toLowerCase()) ?? results[0]
  }

  return { owner, repository, baseUrl, searchIdentities, resolveIdentity }
}
