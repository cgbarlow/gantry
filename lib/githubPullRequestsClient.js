import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL, PROVIDER } from './githubClient.js'

const API_VERSION_HEADER = '2022-11-28'

/**
 * GitHub's pull-requests capability (#20, docs/adr/0039): open a Pull Request, read it back (status
 * + reviews) and request a reviewer — the subset Promote needs (ADR-0036: "gantry proposes, it
 * doesn't merge on their behalf" — a promotion Pull Request is merged by the library repo's own code
 * owner, in GitHub itself, never by gantry). Mirrors `lib/azureDevOpsPullRequestsClient.js`'s own
 * shape and conventions (same `request()`/error-mapping pattern as `lib/githubClient.js`) so a
 * caller working across both providers reads them the same way.
 *
 * Sign-off's fuller pull-requests surface — merge with a merge commit, branch-protection-refusal
 * handling (ADR-0040) — is a later ticket's job (#13); this client exposes only what a caller with no
 * merge concept needs, and has no `completePullRequest` for exactly that reason.
 *
 * `baseUrl` defaults to the public GitHub API but is overridable — a GitHub Enterprise Server host,
 * or (in tests) `tests/helpers/fakeGitHubServer.js` — same convention as `lib/githubClient.js`.
 */
export function createGitHubPullRequestsClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createGitHubPullRequestsClient: "${name}" is required`)
  }

  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  function authHeaders() {
    return {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION_HEADER,
    }
  }

  async function request(url, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new RequestError(`Network error calling GitHub API (${method} ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitHub rejected the supplied PAT (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`GitHub found no item for ${method} ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new RequestError(`GitHub API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        provider: PROVIDER,
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  // GitHub's own `state` ('open'/'closed') plus `merged` onto the same active/completed/abandoned
  // vocabulary `lib/azureDevOpsPullRequestsClient.js` already returns, so a caller displaying a
  // promotion's status never has to branch on provider for the word itself.
  function statusOf(pr) {
    if (pr.state === 'open') return 'active'
    return pr.merged ? 'completed' : 'abandoned'
  }

  /**
   * Opens a new pull request from `sourceBranch` into `targetBranch` (plain branch names — GitHub's
   * own `head`/`base` fields, no `refs/heads/...` prefix needed the way Azure DevOps requires).
   */
  async function createPullRequest({ sourceBranch, targetBranch, title, description } = {}) {
    for (const [name, value] of Object.entries({ sourceBranch, targetBranch, title })) {
      if (!value) throw new Error(`createPullRequest: "${name}" is required`)
    }
    const res = await request(`${repoUrl}/pulls`, {
      method: 'POST',
      body: { title, head: sourceBranch, base: targetBranch, ...(description !== undefined ? { body: description } : {}) },
    })
    const pr = await res.json()
    return { pullRequestId: pr.number, status: statusOf(pr) }
  }

  async function listReviews(pullRequestId) {
    const res = await request(`${repoUrl}/pulls/${pullRequestId}/reviews`)
    return res.json()
  }

  /**
   * Fetches a pull request's current status and its full review list. Unlike Azure DevOps, where a
   * reviewer's vote rides along on the pull request object itself, GitHub exposes reviews via a
   * separate endpoint — fetched here so a caller (`lib/definitionPromote.js`'s `checkPromotionStatus`)
   * gets both in one call, mirroring `getPullRequest`'s "everything a caller needs" contract on the
   * Azure DevOps client. `reviews` is GitHub's own raw list; `interpretGitHubReviews` below turns it
   * into gantry's pending/approved/changes-requested vocabulary.
   */
  async function getPullRequest(pullRequestId) {
    const [prRes, reviews] = await Promise.all([request(`${repoUrl}/pulls/${pullRequestId}`), listReviews(pullRequestId)])
    const pr = await prRes.json()
    return { pullRequestId: pr.number, status: statusOf(pr), reviews }
  }

  /**
   * Requests review from the given reviewers — `[{ login, required }]`. GitHub identifies a reviewer
   * by login, not an internal id (Azure DevOps's own `addReviewers` shape), so
   * `lib/definitionPromote.js` passes a resolved identity's `uniqueName` as `login` here.
   *
   * GitHub has no API-level "required reviewer": enforcement is the target repo's own branch
   * protection / CODEOWNERS configuration. `required` is accepted for shape-parity with Azure
   * DevOps's `addReviewers` but otherwise unused — this only ever requests review, per ADR-0040 ("the
   * library repo's own review process is respected" — gantry never invents an enforcement mechanism
   * GitHub itself doesn't have).
   */
  async function addReviewers(pullRequestId, reviewers = []) {
    const logins = reviewers.map((r) => r.login).filter(Boolean)
    if (!logins.length) return []
    const res = await request(`${repoUrl}/pulls/${pullRequestId}/requested_reviewers`, {
      method: 'POST',
      body: { reviewers: logins },
    })
    return res.json()
  }

  return { owner, repository, baseUrl, createPullRequest, getPullRequest, addReviewers }
}

/**
 * Turns a GitHub pull request's raw review list into gantry's own pending/approved/changes-requested
 * vocabulary (docs/adr/0040: "APPROVED and CHANGES_REQUESTED map to their gantry equivalents ...
 * COMMENTED and DISMISSED read as still-pending"). Only APPROVED/CHANGES_REQUESTED reviews are
 * actionable; a COMMENTED or DISMISSED review neither sets nor clears a reviewer's standing — exactly
 * as GitHub's own UI treats them, never resetting an existing approval to pending. Where a reviewer
 * has submitted more than one actionable review, only their latest (by `submitted_at`) counts, mirroring
 * how a fresh vote supersedes a stale one on Azure DevOps.
 */
export function interpretGitHubReviews(reviews) {
  const actionable = (reviews ?? []).filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
  const latestByUser = new Map()
  for (const review of actionable) {
    const login = review.user?.login ?? review.user
    const existing = latestByUser.get(login)
    if (!existing || new Date(review.submitted_at) >= new Date(existing.submitted_at)) {
      latestByUser.set(login, review)
    }
  }
  const states = [...latestByUser.values()].map((r) => r.state)
  if (states.includes('CHANGES_REQUESTED')) return 'changes-requested'
  if (states.includes('APPROVED')) return 'approved'
  return 'pending'
}
