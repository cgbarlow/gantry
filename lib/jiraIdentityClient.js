import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'

// Tagged 'atlassian', the suite id, not 'jira' — the same convention `lib/jiraWorkItemsClient.js`
// already follows (docs/adr/0042): a catch site sees one provider name for the whole suite, matching
// `providerDisplayName('atlassian')`'s own "Atlassian", never "Jira" or "Bitbucket".
const PROVIDER = 'atlassian'

/**
 * Jira's identity capability (#45, the Jira-backed half of ADR-0042's split identity — #44 covers the
 * Bitbucket-backed half, PR reviewers): resolves a name-as-typed to candidate people the front-end's
 * identity picker presents, scoped to one Jira project — Jira's own counterpart to
 * `lib/gitlabIdentityClient.js`'s "members/all" search, applied to Jira's "Assignable User" permission
 * and `accountId` identifiers instead of GitLab's Reporter role and numeric ids.
 *
 * Unlike GitLab's single `/members/all` endpoint (one response, already carrying each member's own
 * access level), Jira Cloud has no one call that returns a project's candidate assignees *annotated*
 * with whether each one is actually assignable. Two real endpoints exist instead:
 *
 *   - `GET /rest/api/3/user/search?query=` — the Jira *site's* own user directory, unscoped to any
 *     project. This is the client's full candidate set.
 *   - `GET /rest/api/3/user/assignable/search?project=&query=` — the (already-filtered) subset of that
 *     directory who currently hold "Assignable User" for `jiraProjectKey`. Jira itself computes this
 *     filter server-side; this client never re-derives project permissions from role/group data itself.
 *
 * `searchIdentities` calls both with the same query and unions them into one shows-but-blocked result:
 * every site user resolves, `canAssign` is `true` for whoever the assignable-search call also returned
 * (matched by `accountId`), `false` (with a `blockedReason`) for everyone else — the same contract
 * `lib/gitlabIdentityClient.js`/`lib/githubIdentityClient.js` already establish, gating on Jira's own
 * permission model instead of GitLab's access-level scale or GitHub's repository access.
 *
 * Same result shape as every other provider's identity client — `{ uniqueName, displayName,
 * emailAddress, id }`, plus `canAssign` and, when `false`, `blockedReason` — except `uniqueName` and
 * `id` are both Jira's own `accountId`: Jira Cloud's REST API v3 identifies a user solely by this
 * opaque, per-site identifier (its older `username`/`key` identifiers were retired site-wide as part of
 * Atlassian's GDPR-driven user-privacy API changes), so there is no separate human-readable "login" the
 * way GitHub/GitLab have — `accountId` is simultaneously the unique identifier and the value assignment
 * is made with, confirmed against Jira Cloud's current REST API v3 docs
 * (`fields.assignee = { accountId }` on `PUT/POST /rest/api/3/issue`, never a username or email).
 */
export function createJiraIdentityClient({ jiraSite, jiraProjectKey, pat, baseUrl } = {}) {
  for (const [name, value] of Object.entries({ jiraSite, jiraProjectKey, pat })) {
    if (!value) throw new Error(`createJiraIdentityClient: "${name}" is required`)
  }

  const trimmedBaseUrl = (baseUrl ?? `https://${jiraSite}`).replace(/\/+$/, '')
  const apiUrl = `${trimmedBaseUrl}/rest/api/3`

  function authHeaders() {
    return { Authorization: `Bearer ${pat}` }
  }

  async function request(url) {
    let res
    try {
      res = await fetch(url, { headers: authHeaders() })
    } catch (err) {
      throw new RequestError(`Network error calling the Jira API (GET ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`Jira rejected the supplied token (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`Jira found no item for GET ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new RequestError(`Jira API request failed: GET ${url} -> HTTP ${res.status}`, { provider: PROVIDER, status: res.status, body })
    }
    return res
  }

  function toIdentity({ accountId, displayName, emailAddress }, canAssign) {
    const name = displayName || accountId
    return {
      uniqueName: accountId,
      displayName: name,
      emailAddress: emailAddress || '',
      id: accountId,
      canAssign,
      ...(canAssign
        ? {}
        : {
            blockedReason:
              `"${name}" does not have the "Assignable User" permission on ${jiraProjectKey} — grant it ` +
              '(project settings -> People, or whichever project role carries Assignable User on this site), then retry.',
          }),
    }
  }

  /** `GET /rest/api/3/user/search` — every user on this Jira site matching `query` (Jira's own substring match, against display name and email, server-side), unscoped to any project. This client's full candidate set before the assignable-permission gate below narrows `canAssign`. */
  async function searchSiteUsers(query) {
    const url = new URL(`${apiUrl}/user/search`)
    url.searchParams.set('query', query)
    url.searchParams.set('maxResults', '50')
    const res = await request(url.toString())
    return res.json()
  }

  /** `GET /rest/api/3/user/assignable/search` — the subset of `searchSiteUsers`'s own candidates who currently hold "Assignable User" for `jiraProjectKey`, matching the same `query`. Jira computes this filter itself (role/group membership, project permission scheme, …); this client only reads the result, never re-derives it. */
  async function searchAssignableUsers(query) {
    const url = new URL(`${apiUrl}/user/assignable/search`)
    url.searchParams.set('project', jiraProjectKey)
    url.searchParams.set('query', query)
    url.searchParams.set('maxResults', '50')
    const res = await request(url.toString())
    return res.json()
  }

  /**
   * Searches this Jira site's user directory for candidates matching `query`, each carrying its own
   * `canAssign` against `jiraProjectKey` — the union described in this module's own doc comment above.
   */
  async function searchIdentities(query) {
    if (!query || !query.trim()) return []
    const q = query.trim()
    const [siteUsers, assignableUsers] = await Promise.all([searchSiteUsers(q), searchAssignableUsers(q)])
    const assignableIds = new Set(assignableUsers.map((u) => u.accountId))
    return siteUsers
      .map((u) => toIdentity(u, assignableIds.has(u.accountId)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.uniqueName.localeCompare(b.uniqueName))
  }

  /**
   * Resolves a single `accountId` (or, failing that, a display name) to its full identity, or `null` if
   * nothing matches — mirrors `lib/gitlabIdentityClient.js`'s own `resolveIdentity`, used the same way
   * (re-resolving an effective assignee immediately before attaching them to a Jira issue).
   */
  async function resolveIdentity(value) {
    if (!value || !value.trim()) return null
    const trimmed = value.trim()
    const results = await searchIdentities(trimmed)
    if (results.length === 0) return null
    return (
      results.find((r) => r.uniqueName === trimmed) ??
      results.find((r) => r.displayName.toLowerCase() === trimmed.toLowerCase()) ??
      results[0]
    )
  }

  return { jiraSite, jiraProjectKey, baseUrl: trimmedBaseUrl, searchIdentities, resolveIdentity }
}
