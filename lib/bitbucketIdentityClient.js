import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL } from './bitbucketClient.js'

// Tagged 'atlassian', never 'bitbucket' — see lib/bitbucketClient.js's own module doc comment for why:
// the registered Provider (ADR-0037/ADR-0039) is 'atlassian' regardless of which half of the
// split-suite (Bitbucket or Jira) a given client implements.
const PROVIDER = 'atlassian'

// Bitbucket Cloud's own repository-permission scale
// (https://developer.atlassian.com/cloud/bitbucket/rest/api-group-workspaces/#api-workspaces-workspace-permissions-repositories-repo-slug-get):
// "read", "write" or "admin" — a genuine three-level scale, unlike GitHub's binary has-access-or-not
// (docs/adr/0040) and coarser than GitLab's five-level Guest/Reporter/Developer/Maintainer/Owner scale
// (docs/adr/0041). This ticket (#44) confirmed against Bitbucket's current docs, rather than assuming
// GitLab's Reporter-or-above framing carries over unchanged, that "write" is the minimum a person needs
// to be a meaningful pull-request reviewer: Bitbucket Cloud lets any user with "read" access view a
// pull request and leave a general comment, but only "write" (or "admin") access lets someone actually
// submit a review outcome (approve / request changes) — the same "must have repository access at all"
// gate #10/ADR-0040 draws for GitHub, translated onto the one rung of Bitbucket's scale that maps to
// it. Recorded here (and in docs/adr/0042's own "Person-picker assignability gate" section) as the one
// place that threshold is decided, since the pull-requests ticket (#46, reviewer attachment) and Request
// Review reuse the same distinction.
const PERMISSION_RANK = { read: 1, write: 2, admin: 3 }
const MINIMUM_ASSIGNABLE_PERMISSION = 'write'

function permissionRank(permission) {
  return PERMISSION_RANK[permission] ?? 0
}

/**
 * Bitbucket's identity capability (#44, mirroring GitLab's own #28/docs/adr/0041 "The person picker
 * unions collaborators with org members, and gates assignment on access", itself following GitHub's
 * #10/docs/adr/0040): resolves a name-as-typed to candidate people the front-end's identity picker
 * presents, scoped to one Bitbucket Cloud repository — this ticket's own half of ADR-0042's split-suite
 * identity model (a PR reviewer is picked from Bitbucket's own member list; a work-item assignee is
 * picked from Jira's own user directory, via the sibling `lib/jiraIdentityClient.js`, #45 — the two are
 * never unified).
 *
 * Candidates come from Bitbucket's own workspace/repository permissions API
 * (`GET /workspaces/{workspace}/permissions/repositories/{repo_slug}`) — every person (or group member)
 * with an explicit "read"/"write"/"admin" permission on this repository, each entry already carrying
 * its own `permission`. Like GitLab's Members API (unlike GitHub's own two-endpoint union), this is a
 * single response with no second per-user lookup needed. `owner` here holds Bitbucket's own "workspace"
 * slug (ADR-0042's own reuse of GitHub's `owner`/`repository` location keys for Bitbucket's identical
 * addressing) — note this permissions endpoint is one of the few Bitbucket routes addressed under
 * `/workspaces/{workspace}/...` rather than `/repositories/{workspace}/{repo_slug}/...`, unlike every
 * route `lib/bitbucketClient.js` itself calls.
 *
 * `canAssign` is `true` once `permission` is "write" or "admin" (see `MINIMUM_ASSIGNABLE_PERMISSION`
 * above), `false` (with a `blockedReason`) for "read" — mirroring GitHub's/GitLab's own `canAssign`/
 * `blockedReason` shape exactly so `web/lib/identityPicker.js` needs no provider-specific branch to
 * render either one. `id` holds the account's `uuid` — Bitbucket Cloud identifies a user by UUID (or
 * `account_id`) everywhere in its API, including the pull-requests reviewer-attachment payload #46
 * builds on this client, never by a login-style username (Bitbucket retired public usernames from its
 * API years ago); `uniqueName` holds the closest thing Bitbucket still has to a human-typeable handle,
 * the account's `nickname`, falling back to `display_name` for an account with no nickname set.
 *
 * Bitbucket's own filtering query language (BBQL) exists for this endpoint, but its documented grammar
 * covers filtering by `permission`, not by matching text against a nested user's own fields — so unlike
 * `lib/gitlabIdentityClient.js`'s own server-side `query` param, this client fetches the (one-page,
 * `pagelen=100` — depths beyond one page are a later concern, not exercised by any current caller,
 * mirroring `lib/bitbucketClient.js`'s own `listFolder`) permissions list and filters client-side by
 * substring against `nickname`/`display_name`/`uuid`, the same shape `lib/githubIdentityClient.js` uses
 * for GitHub's own two endpoints with no equivalent server-side text search.
 */
export function createBitbucketIdentityClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createBitbucketIdentityClient: "${name}" is required`)
  }

  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '')
  const permissionsUrl = `${trimmedBaseUrl}/workspaces/${encodeURIComponent(owner)}/permissions/repositories/${encodeURIComponent(repository)}`

  function authHeaders() {
    return { Authorization: `Bearer ${pat}` }
  }

  async function request(url) {
    let res
    try {
      res = await fetch(url, { headers: authHeaders() })
    } catch (err) {
      throw new RequestError(`Network error calling Bitbucket API (GET ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`Bitbucket rejected the supplied token (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`Bitbucket found no item for GET ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new RequestError(`Bitbucket API request failed: GET ${url} -> HTTP ${res.status}`, { provider: PROVIDER, status: res.status, body })
    }
    return res
  }

  function toIdentity({ user, permission }) {
    const canAssign = permissionRank(permission) >= permissionRank(MINIMUM_ASSIGNABLE_PERMISSION)
    const uniqueName = user.nickname || user.display_name
    return {
      uniqueName,
      displayName: user.display_name || uniqueName,
      emailAddress: '',
      id: user.uuid,
      canAssign,
      ...(canAssign
        ? {}
        : {
            blockedReason: `"${uniqueName}" only has "${permission}" access to ${owner}/${repository} — Bitbucket requires at least "write" access to review a pull request, so grant write access, then retry.`,
          }),
    }
  }

  async function listPermissions() {
    const url = new URL(permissionsUrl)
    url.searchParams.set('pagelen', '100')
    const res = await request(url.toString())
    const data = await res.json()
    return data.values ?? []
  }

  /**
   * Searches for candidates matching `query` (case-insensitive substring against the account's
   * nickname, display name, or uuid) among everyone with an explicit permission on this repository.
   */
  async function searchIdentities(query) {
    if (!query || !query.trim()) return []
    const q = query.trim().toLowerCase()
    const entries = await listPermissions()
    const matched = entries.filter(({ user }) => {
      const nickname = (user.nickname ?? '').toLowerCase()
      const displayName = (user.display_name ?? '').toLowerCase()
      const uuid = (user.uuid ?? '').toLowerCase()
      return nickname.includes(q) || displayName.includes(q) || uuid.includes(q)
    })
    return matched.map(toIdentity).sort((a, b) => a.uniqueName.localeCompare(b.uniqueName))
  }

  /**
   * Resolves a single nickname/display-name to its full identity, or `null` if nothing matches —
   * mirrors `lib/gitlabIdentityClient.js`'s own `resolveIdentity`, used the same way (re-resolving an
   * effective reviewer immediately before attaching them to a Bitbucket pull request, #46).
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

export { MINIMUM_ASSIGNABLE_PERMISSION }
