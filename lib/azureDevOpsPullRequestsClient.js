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
  DEFAULT_BASE_URL,
  DEFAULT_API_VERSION,
}

function normalizeRef(branch) {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`
}

/**
 * A general-purpose Azure DevOps Pull Requests REST client — parallel to
 * lib/azureDevOpsClient.js's Git Items/Refs/Pushes client (#84) and
 * lib/azureDevOpsWorkItemsClient.js's Work Items client (#99), covering
 * the Pull Requests endpoints instead (#120, under #106's stage-
 * advancement-via-Pull-Request spec — see docs/adr/0014-pull-request-
 * stage-approval.md). Gantry has had no Pull Request capability of any
 * kind before this. Kept as its own client/module rather than folded into
 * the Git client, mirroring #99's own precedent of one client per Azure
 * DevOps REST area rather than one do-everything client — while still
 * reusing that client's authentication helper and error-class taxonomy,
 * so callers can catch one consistent set of error types regardless of
 * which client raised them.
 *
 * Covers the Pull Request capabilities ADR-0014 and ADR-0018 call for:
 * create a pull request, read its reviewers' votes and commits, reset a stale
 * reviewer vote, post a fallback comment, and complete (merge) it. Casting an
 * approval vote is deliberately not exposed here — that's the Owner's own
 * action, performed directly in Azure DevOps's UI (ADR-0014).
 *
 * Pull requests are scoped to a repository (like the Git client, unlike
 * the Work Items client) — this client takes `organization`, `project`
 * and `repository`, all required, the same as lib/azureDevOpsClient.js.
 *
 * Authenticated the same way as the other two clients: a caller-supplied
 * PAT via HTTP Basic auth (empty username, PAT as password).
 *
 * `baseUrl` defaults to the real Azure DevOps API but is overridable, so
 * tests can point it at the same fake in-process server the other two
 * clients' tests use (see tests/helpers/fakeAzureDevOpsServer.js, extended
 * by #120 to also fake these Pull Request endpoints) instead of
 * `dev.azure.com`.
 */
export function createAzureDevOpsPullRequestsClient({
  organization,
  project,
  repository,
  pat,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_API_VERSION,
} = {}) {
  for (const [name, value] of Object.entries({ organization, project, repository, pat })) {
    if (!value) throw new Error(`createAzureDevOpsPullRequestsClient: "${name}" is required`)
  }

  // Every path segment is encoded for the same reason as the other two
  // clients: organisation/project/repository names are free text and can
  // contain characters ("#", "?", " ") that would otherwise be misparsed.
  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`

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
   * Opens a new pull request from `sourceBranch` into `targetBranch` (both
   * plain branch names, e.g. "hld-stage" / "main" — normalized to the full
   * `refs/heads/...` form Azure DevOps's API requires internally, mirroring
   * how lib/azureDevOpsClient.js's `writeFile`/`getFileContent` accept a
   * plain `branch` name rather than requiring callers to build the ref
   * themselves). Returns the created pull request (pullRequestId, status,
   * reviewers, etc.), mirroring the shape Azure DevOps itself returns.
   *
   * Gating *when* this is called (only once a stage's gate has genuinely
   * passed, per ADR-0014) is the caller's responsibility (#124) — this
   * client has no notion of gates or stages, only Azure DevOps's own API
   * surface.
   */
  async function createPullRequest({ sourceBranch, targetBranch, title, description } = {}) {
    for (const [name, value] of Object.entries({ sourceBranch, targetBranch, title })) {
      if (!value) throw new Error(`createPullRequest: "${name}" is required`)
    }

    const url = new URL(`${repoUrl}/pullrequests`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sourceRefName: normalizeRef(sourceBranch),
        targetRefName: normalizeRef(targetBranch),
        title,
        ...(description !== undefined ? { description } : {}),
      }),
    })
    return res.json()
  }

  /**
   * Fetches a pull request's current state by id, including its
   * `reviewers` array — each entry's `vote` is Azure DevOps's own signed
   * scale (10 approved, 5 approved-with-suggestions, 0 no vote, -5
   * waiting-for-author, -10 rejected). This is the "read reviewer votes"
   * capability ADR-0014 calls for: the vote data rides along on the pull
   * request object itself in Azure DevOps's API, rather than living behind
   * a separate endpoint, so no separate "get votes" function is needed.
   * Interpreting those votes (distinguishing an explicit rejection from a
   * merely-still-pending review) is left to the caller (#125) — this
   * client only fetches and returns Azure DevOps's own raw shape.
   */
  async function getPullRequest(pullRequestId) {
    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    return res.json()
  }

  /**
   * Fetches every commit currently reachable from a pull request's source
   * branch. Azure DevOps exposes this separately from the pull request
   * itself; its timestamps are used by ADR-0018 to detect a commit that
   * landed after an approval vote.
   */
  async function getPullRequestCommits(pullRequestId) {
    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}/commits`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const body = await res.json()
    return body.value ?? []
  }

  /**
   * Completes (merges) an existing pull request. `completionOptions` is
   * passed through to Azure DevOps largely as-is (e.g. `mergeStrategy`,
   * `deleteSourceBranch`, `transitionWorkItems`, `mergeCommitMessage`) —
   * this client makes no policy choice about which merge strategy or
   * source-branch-deletion behaviour to use; that's for the caller (#125)
   * to decide.
   *
   * Azure DevOps's completion API requires the pull request's current
   * `lastMergeSourceCommit` echoed back in the PATCH body (its own
   * optimistic-concurrency check that the source branch hasn't moved
   * since the caller last looked at it — the same shape
   * lib/azureDevOpsClient.js's `writeFile` already handles for pushes via
   * `oldObjectId`). Rather than requiring every caller to first fetch the
   * pull request itself just to thread that value through, this function
   * fetches it internally so callers can simply call
   * `completePullRequest(id, { mergeStrategy: 'squash' })` once they've
   * decided to merge.
   */
  async function completePullRequest(pullRequestId, completionOptions = {}) {
    const current = await getPullRequest(pullRequestId)

    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        lastMergeSourceCommit: current.lastMergeSourceCommit,
        completionOptions,
      }),
    })
    return res.json()
  }

  /**
   * Adds reviewers to a pull request, optionally marking them as required.
   * Each entry in `reviewers` is `{ id, required }` where `id` is an Azure
   * DevOps identity GUID and `required` (default `true`) controls whether
   * the review is mandatory for the PR to be completable. This is the PR-side
   * enforcement of #145's "required reviewer" concept — the identity is
   * resolved server-side at request-approval time, then attached here as a
   * required reviewer on the opened Pull Request.
   *
   * Azure DevOps's own POST /pullrequests/{id}/reviewers endpoint accepts
   * `[{ id: 'guid', vote: 0, isRequired: true }]` — we mirror that shape
   * on the wire, but callers pass `required` (vote is the reviewer's own
   * action in the Azure DevOps UI, never something gantry sets).
   */
  async function addReviewers(pullRequestId, reviewers = []) {
    if (!reviewers.length) return []

    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}/reviewers`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(
        reviewers.map((r) => ({
          id: r.id,
          vote: 0,
          isRequired: r.required !== false,
        }))
      ),
    })
    return res.json()
  }

  /**
   * Withdraws a reviewer's vote. This is used only for an approval made stale
   * by a later commit; normal approval votes still happen in Azure DevOps.
   */
  async function updateReviewerVote(pullRequestId, reviewerId, vote = 0) {
    if (!reviewerId) throw new Error('updateReviewerVote: "reviewerId" is required')

    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}/reviewers/${encodeURIComponent(reviewerId)}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ vote }),
    })
    return res.json()
  }

  /**
   * Posts an automated thread comment when Azure DevOps refuses a vote reset
   * for the service identity (ADR-0018's permission-gated fallback).
   */
  async function commentOnPullRequest(pullRequestId, content) {
    if (!content) throw new Error('commentOnPullRequest: "content" is required')

    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}/threads`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ comments: [{ parentCommentId: 0, content }], status: 'active' }),
    })
    return res.json()
  }

  /**
   * Removes a reviewer from a pull request by their identity GUID.
   */
  async function removeReviewer(pullRequestId, reviewerId) {
    const url = new URL(`${repoUrl}/pullrequests/${pullRequestId}/reviewers/${reviewerId}`)
    url.searchParams.set('api-version', apiVersion)

    await request(url.toString(), { method: 'DELETE' })
  }

  return {
    organization,
    project,
    repository,
    baseUrl,
    createPullRequest,
    getPullRequest,
    getPullRequestCommits,
    completePullRequest,
    addReviewers,
    updateReviewerVote,
    commentOnPullRequest,
    removeReviewer,
  }
}
