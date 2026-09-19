import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL, PROVIDER } from './gitlabClient.js'

/**
 * GitLab's pull-requests capability (#33, docs/adr/0039/0041) — the GitLab twin of
 * `lib/githubPullRequestsClient.js`: open a Merge Request, read it back (status + the data
 * `interpretGitLabMergeRequest` below needs), merge it with a merge commit, and request a reviewer.
 * Same `request()`/error-mapping pattern as `lib/gitlabClient.js` so a caller working across the
 * content-store and pull-requests clients reads them the same way.
 *
 * A GitLab project is addressed by its full `namespace/repository` path, URL-encoded as one opaque
 * `namespace%2Frepository` path segment — the same convention `lib/gitlabClient.js` uses.
 *
 * `baseUrl` defaults to the public gitlab.com API but is overridable — self-hosted GitLab CE/EE
 * (ADR-0041), or (in tests) `tests/helpers/fakeGitLabServer.js`.
 */
export function createGitLabPullRequestsClient({ namespace, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ namespace, repository, pat })) {
    if (!value) throw new Error(`createGitLabPullRequestsClient: "${name}" is required`)
  }

  const projectId = encodeURIComponent(`${namespace}/${repository}`)
  const projectUrl = `${baseUrl.replace(/\/+$/, '')}/projects/${projectId}`

  function authHeaders() {
    return { 'PRIVATE-TOKEN': pat }
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
      throw new RequestError(`Network error calling GitLab API (${method} ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitLab rejected the supplied PAT (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`GitLab found no item for ${method} ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new RequestError(`GitLab API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        provider: PROVIDER,
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  // GitLab's own `state` ('opened'/'closed'/'locked'/'merged') onto the same active/completed/abandoned
  // vocabulary `lib/githubPullRequestsClient.js`'s own `statusOf` returns, so a caller displaying a
  // sign-off's status never has to branch on provider for the word itself. 'locked' (a merge is in
  // progress) still reads as `'active'` — it isn't a decided outcome yet.
  function statusOf(mr) {
    if (mr.state === 'merged') return 'completed'
    if (mr.state === 'closed') return 'abandoned'
    return 'active'
  }

  /**
   * Opens a new Merge Request from `sourceBranch` into `targetBranch` (plain branch names — GitLab's
   * own `source_branch`/`target_branch` fields).
   */
  async function createPullRequest({ sourceBranch, targetBranch, title, description } = {}) {
    for (const [name, value] of Object.entries({ sourceBranch, targetBranch, title })) {
      if (!value) throw new Error(`createPullRequest: "${name}" is required`)
    }
    const res = await request(`${projectUrl}/merge_requests`, {
      method: 'POST',
      body: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        ...(description !== undefined ? { description } : {}),
      },
    })
    const mr = await res.json()
    return { pullRequestId: mr.iid, status: statusOf(mr) }
  }

  /**
   * GitLab's own Merge Request Approvals endpoint — `{ approved, approved_by, approvals_left, ... }`.
   * `approved` already accounts for whatever enforced Approval Rules exist on a Premium/Ultimate
   * instance (ADR-0041: "honours enforced Approval Rules on Premium/Ultimate instances where they
   * exist"); on Free/CE, with no rules configured, it reflects the plain Approve/unapprove toggle
   * instead — either way, this one field is the single source of truth `interpretGitLabMergeRequest`
   * below reads, with no separate CE-vs-Premium branch needed here.
   */
  async function getApprovals(pullRequestId) {
    const res = await request(`${projectUrl}/merge_requests/${pullRequestId}/approvals`)
    return res.json()
  }

  /**
   * GitLab's own Discussions API for a Merge Request — used only to answer "is there an unresolved
   * discussion thread" (ADR-0041's own not-approved-plus-unresolved-thread reading), never to render
   * discussion content itself.
   */
  async function getDiscussions(pullRequestId) {
    const res = await request(`${projectUrl}/merge_requests/${pullRequestId}/discussions`)
    return res.json()
  }

  /**
   * Fetches a Merge Request's current status, its approvals summary and its discussions — everything
   * `interpretGitLabMergeRequest` needs in one call, mirroring `lib/githubPullRequestsClient.js`'s own
   * `getPullRequest`'s "everything a caller needs" contract. `approvals`/`discussions` ride along raw;
   * turning them into gantry's pending/approved/changes-requested vocabulary is
   * `interpretGitLabMergeRequest`'s job, not this client's.
   */
  async function getPullRequest(pullRequestId) {
    const [mrRes, approvals, discussions] = await Promise.all([
      request(`${projectUrl}/merge_requests/${pullRequestId}`),
      getApprovals(pullRequestId),
      getDiscussions(pullRequestId),
    ])
    const mr = await mrRes.json()
    return { pullRequestId: mr.iid, status: statusOf(mr), approvals, discussions }
  }

  /**
   * Requests review from the given reviewers — `[{ id, required }]`, `id` being GitLab's own numeric
   * user id (`lib/gitlabIdentityClient.js`'s `resolveIdentity` result carries one). GitLab has no
   * API-level "required reviewer" any more than GitHub does — `reviewer_ids` only ever *requests*
   * review; `required` is accepted for shape-parity with the GitHub/Azure DevOps clients but otherwise
   * unused, same limitation `lib/githubPullRequestsClient.js`'s own `addReviewers` documents.
   */
  async function addReviewers(pullRequestId, reviewers = []) {
    const ids = reviewers.map((r) => r.id).filter(Boolean)
    if (!ids.length) return null
    const res = await request(`${projectUrl}/merge_requests/${pullRequestId}`, {
      method: 'PUT',
      body: { reviewer_ids: ids },
    })
    return res.json()
  }

  /**
   * Fetches the commits on a Merge Request (`GET .../merge_requests/:iid/commits`) — GitLab's own
   * per-MR commit list, used the same way `lib/githubPullRequestsClient.js`'s own
   * `getPullRequestCommits` is: to populate the Work item details card's commit panel
   * (`lib/stageStatus.js`'s `summarizeGitLabPullRequest`).
   */
  async function getPullRequestCommits(pullRequestId) {
    const res = await request(`${projectUrl}/merge_requests/${pullRequestId}/commits`)
    return res.json()
  }

  /**
   * Merges a Merge Request (`PUT .../merge_requests/:iid/merge`) — `squash: false` and
   * `should_remove_source_branch: false` explicitly, so a merge always lands as a real merge commit
   * with the source branch left in place, mirroring `lib/githubPullRequestsClient.js`'s own
   * `merge_method: 'merge'` rationale: stage branches stack on the preceding stage's branch while its
   * own Merge Request is still open (ADR-0014), and a squash merge (or an auto-deleted source branch)
   * would break that. `completionOptions.mergeCommitMessage`, if given, becomes GitLab's own
   * `merge_commit_message` — otherwise GitLab picks its own default message.
   *
   * GitLab refuses a merge blocked by a protected-branch rule, an unresolved discussion required to
   * be resolved, or the Merge Request simply not being in a mergeable state, with a non-2xx response
   * (typically 405) naming the reason — this function makes no attempt to interpret, retry, or fall
   * back to a different merge method on that refusal (mirroring ADR-0040's GitHub stance, ADR-0041's
   * "full capability parity"); the thrown `RequestError`'s `.body` carries GitLab's own response
   * verbatim for the caller (`lib/stageStatus.js`) to surface as a blocked sign-off.
   */
  async function completePullRequest(pullRequestId, completionOptions = {}) {
    const res = await request(`${projectUrl}/merge_requests/${pullRequestId}/merge`, {
      method: 'PUT',
      body: {
        squash: false,
        should_remove_source_branch: false,
        ...(completionOptions.mergeCommitMessage !== undefined ? { merge_commit_message: completionOptions.mergeCommitMessage } : {}),
      },
    })
    return res.json()
  }

  return { namespace, repository, baseUrl, createPullRequest, getPullRequest, getPullRequestCommits, completePullRequest, addReviewers }
}

/**
 * Turns a Merge Request's raw approvals summary and discussion list into gantry's own
 * pending/approved/changes-requested vocabulary, per ADR-0041's own mapping:
 *
 * - **approved** — GitLab's own `approvals.approved` is `true` (already honouring enforced Approval
 *   Rules on Premium/Ultimate where they exist, or the plain Approve toggle on Free/CE).
 * - **changes-requested** (the `CHANGES_REQUESTED` equivalent) — not approved, and at least one
 *   discussion carries an unresolved, resolvable note (a reviewer left feedback and hasn't marked it
 *   resolved).
 * - **pending** (the `COMMENTED` equivalent) — not approved, and no unresolved thread either: nobody
 *   has raised an explicit objection yet.
 *
 * GitLab has no formal "request changes" review verb to read directly (ADR-0041) — this is the whole
 * inference this function exists to make, mirroring `lib/githubPullRequestsClient.js`'s own
 * `interpretGitHubReviews`.
 */
export function interpretGitLabMergeRequest({ approvals, discussions } = {}) {
  if (approvals?.approved) return 'approved'
  const hasUnresolvedThread = (discussions ?? []).some((discussion) =>
    (discussion.notes ?? []).some((note) => note.resolvable && !note.resolved)
  )
  return hasUnresolvedThread ? 'changes-requested' : 'pending'
}
