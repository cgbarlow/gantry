import {
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
  DEFAULT_BASE_URL,
  DEFAULT_API_VERSION,
  basicAuthHeader,
} from './azureDevOpsClient.js'

export {
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
}

/**
 * Azure DevOps identity search client (#145 Part 2) — hits the Identities
 * REST API to resolve a name-as-typed against the organization's actual
 * user directory, returning candidate identities the front-end's identity
 * picker can present as a pick-list. This is the backing endpoint for every
 * "person field" in gantry (workspace Owner, per-instance required-reviewer
 * override, instance Assignee) — all of which must resolve through lookup
 * rather than accepting free text, per #145's acceptance criteria.
 *
 * Scoped to organization + project (like the Work Items client, unlike the
 * Git/PR clients which are also repository-scoped). Takes the same
 * `{ organization, project, pat, baseUrl?, apiVersion? }` shape.
 */
export function createAzureDevOpsIdentityClient({
  organization,
  project,
  pat,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_API_VERSION,
} = {}) {
  for (const [name, value] of Object.entries({ organization, project, pat })) {
    if (!value) throw new Error(`createAzureDevOpsIdentityClient: "${name}" is required`)
  }

  const orgUrl = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(organization)}`

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: basicAuthHeader(pat), ...headers },
        body,
      })
    } catch (err) {
      throw new AzureDevOpsRequestError(`Network error calling Azure DevOps API (${method} ${url}): ${err.message}`, {
        cause: err,
      })
    }

    if (res.status === 401 || res.status === 403) {
      throw new AzureDevOpsAuthenticationError(`Azure DevOps rejected the supplied PAT (HTTP ${res.status})`, {
        status: res.status,
      })
    }
    if (res.status === 404) {
      throw new AzureDevOpsNotFoundError(`Azure DevOps found no item for ${method} ${url} (HTTP 404)`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new AzureDevOpsRequestError(`Azure DevOps API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /**
   * Searches for identities matching a query string. Returns an array of
   * resolved identities, each with `{ uniqueName, displayName, emailAddress,
   * id }`. `query` is the name-as-typed; results are Azure DevOps's own
   * identity resolution, not a simple substring match — "Chris" will find
   * "Chris Barlow" even if the display name is "Barlow, Chris".
   *
   * Results are scoped to the organization and project. The search is
   * deliberately lenient: partial matches are fine (the identity picker
   * component filters the dropdown as the user types), and legacy free-text
   * values are resolved leniently at point of use rather than silently
   * trusted (#145 acceptance criteria).
   */
  async function searchIdentities(query) {
    if (!query || !query.trim()) return []

    const url = new URL(`${orgUrl}/${encodeURIComponent(project)}/_apis/identities`)
    url.searchParams.set('api-version', apiVersion)
    // `searchFilter` names *which field* Azure DevOps matches against
    // ('General' searches display name, account name and email together) —
    // it is not the query text itself. The actual text goes in
    // `filterValue`. Passing the query text as `searchFilter` (as this code
    // used to) makes Azure DevOps try to parse it as that fixed enum, fail,
    // and report "Identity not found" (HTTP 404) for every real search.
    url.searchParams.set('searchFilter', 'General')
    url.searchParams.set('filterValue', query.trim())
    url.searchParams.set('subjectTypes', 'msa,aad')

    let res
    try {
      res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    } catch (err) {
      // A genuine zero-match search is a normal, expected outcome of this
      // API — Azure DevOps reports it as an "Identity not found" HTTP 404
      // (a legacy quirk of this endpoint, unlike a typical list API's 200
      // with an empty array), not an application error. Treat it the same
      // as any other empty result rather than letting it propagate as a raw
      // "no item found" error above a resolver that expects `[]`/`null` for
      // "nobody matched", not a thrown exception.
      if (err instanceof AzureDevOpsNotFoundError) return []
      throw err
    }
    const data = await res.json()

    if (!data?.value) return []

    return data.value
      .filter((identity) => identity.uniqueName)
      .map((identity) => ({
        uniqueName: identity.uniqueName,
        displayName: identity.displayName || identity.uniqueName,
        emailAddress: identity.mailAddress || '',
        id: identity.id,
      }))
  }

  /**
   * Resolves a single identity by its unique name. Returns the full identity
   * object `{ uniqueName, displayName, emailAddress, id }` if found, or
   * `null` if the unique name doesn't resolve to a known identity (e.g. the
   * person left the org, or the value was never a valid unique name).
   *
   * Used at request-approval time to re-resolve the effective reviewer
   * against Azure DevOps before attaching them to the Pull Request. Legacy
   * free-text values (which may be display names rather than unique names)
   * are handled by searching for them first and taking the first result.
   */
  async function resolveIdentity(value) {
    if (!value || !value.trim()) return null

    const trimmed = value.trim()

    // First, try an exact match on uniqueName
    const results = await searchIdentities(trimmed)
    if (results.length > 0) {
      // Prefer an exact uniqueName match
      const exact = results.find((r) => r.uniqueName.toLowerCase() === trimmed.toLowerCase())
      if (exact) return exact
      // Otherwise, fall back to the first result (which may be a display-name match)
      return results[0]
    }

    return null
  }

  return { organization, project, baseUrl, searchIdentities, resolveIdentity }
}
