import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL, PROVIDER } from './bitbucketClient.js'

/**
 * Bitbucket's pull-requests capability (#46/#49, docs/adr/0039/0042) — the Bitbucket twin of
 * `lib/gitlabPullRequestsClient.js`/`lib/githubPullRequestsClient.js`: open a pull request, read it
 * back (status + the data `interpretBitbucketPullRequest` below needs), request a reviewer, and merge
 * it with a merge commit. Same `request()`/error-mapping pattern as `lib/bitbucketClient.js` so a
 * caller working across the content-store and pull-requests clients reads them the same way.
 *
 * Two callers, two scopes, one client: `#49`'s Promote-via-pull-request needs only open/read/request-
 * reviewer (ADR-0036: "gantry proposes, it doesn't merge on their behalf" — a promotion pull request is
 * merged by the library repo's own code owner, on Bitbucket itself, never by gantry), mirroring
 * `lib/githubPullRequestsClient.js`'s own initial scope (#20). `#46`'s sign-off gating needs the fuller
 * surface — `getPullRequestCommits`/`completePullRequest` — the same way GitHub's own `#13` extended
 * `lib/githubPullRequestsClient.js` after `#20` landed it with a narrower scope. Both scopes live in
 * this one file rather than two, since they're the same resource read the same way.
 *
 * Unlike GitLab (a separate Approvals endpoint) and like GitHub (everything rides on the pull
 * request resource itself), Bitbucket Cloud's own pull request resource already carries everything
 * `interpretBitbucketPullRequest` needs in its own `participants` array — no second request needed
 * the way GitLab's `getApprovals`/`getDiscussions` are. Each participant is `{ user, role:
 * 'REVIEWER' | 'PARTICIPANT', approved, state: 'approved' | 'changes_requested' | null }` — a genuine
 * tri-state (ADR-0042's own "no GitLab-style toggle-plus-threads workaround needed here"), read
 * straight off `role === 'REVIEWER'` participants.
 *
 * A Bitbucket Cloud repository is addressed by `{owner}/{repository}` — see `lib/bitbucketClient.js`'s
 * own module doc comment for why (`owner` holds Bitbucket's own "workspace" slug, ADR-0042's reuse of
 * GitHub's location keys) — and every call is Bearer-authenticated (`lib/bitbucketClient.js`'s own
 * "Bearer, not Basic — deliberately" doc comment gives the full reasoning; this client sends the
 * identical header for the identical reason). `baseUrl` defaults to Bitbucket Cloud's own fixed API
 * host but is overridable in tests, to point at `tests/helpers/fakeBitbucketServer.js` instead of
 * `api.bitbucket.org` — there is no self-hosted Bitbucket override in production use (ADR-0042:
 * Cloud-only).
 */
export function createBitbucketPullRequestsClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createBitbucketPullRequestsClient: "${name}" is required`)
  }

  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  const pullRequestsUrl = `${repoUrl}/pullrequests`

  function authHeaders() {
    return { Authorization: `Bearer ${pat}` }
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
      throw new RequestError(`Network error calling Bitbucket API (${method} ${url}): ${err.message}`, { provider: PROVIDER, cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`Bitbucket rejected the supplied token (HTTP ${res.status})`, { provider: PROVIDER, status: res.status })
    }
    if (res.status === 404) {
      throw new NotFoundError(`Bitbucket found no item for ${method} ${url} (HTTP 404)`, { provider: PROVIDER, status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new RequestError(`Bitbucket API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        provider: PROVIDER,
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  // Bitbucket's own `state` ('OPEN'/'MERGED'/'DECLINED'/'SUPERSEDED') onto the same
  // active/completed/abandoned vocabulary every other provider's own pull-requests client returns, so a
  // caller displaying a sign-off's or a promotion's status never has to branch on provider for the word
  // itself. 'DECLINED' (closed without merging) and 'SUPERSEDED' (replaced by another pull request
  // targeting the same branches) both read as `'abandoned'` — neither is a decided approval outcome any
  // more than GitHub's own 'closed'-but-not-merged is.
  function statusOf(pr) {
    if (pr.state === 'MERGED') return 'completed'
    if (pr.state === 'OPEN') return 'active'
    return 'abandoned'
  }

  /**
   * Opens a new pull request from `sourceBranch` into `targetBranch` (plain branch names — Bitbucket's
   * own `source.branch.name`/`destination.branch.name` fields; `source.repository` is omitted
   * entirely, which Bitbucket's own API treats as "same repository," the only kind gantry ever opens).
   */
  async function createPullRequest({ sourceBranch, targetBranch, title, description } = {}) {
    for (const [name, value] of Object.entries({ sourceBranch, targetBranch, title })) {
      if (!value) throw new Error(`createPullRequest: "${name}" is required`)
    }
    const res = await request(pullRequestsUrl, {
      method: 'POST',
      body: {
        title,
        source: { branch: { name: sourceBranch } },
        destination: { branch: { name: targetBranch } },
        ...(description !== undefined ? { description } : {}),
      },
    })
    const pr = await res.json()
    return { pullRequestId: pr.id, status: statusOf(pr) }
  }

  /**
   * Fetches a pull request's current status and its full `participants` array — everything
   * `interpretBitbucketPullRequest` needs, in the one request Bitbucket's own pull request resource
   * already carries it in (see this factory's own doc comment for why no second call is needed here,
   * unlike GitHub's separate reviews endpoint or GitLab's separate approvals endpoint), mirroring
   * `lib/githubPullRequestsClient.js`'s own `getPullRequest`'s "everything a caller needs" contract.
   */
  async function getPullRequest(pullRequestId) {
    const res = await request(`${pullRequestsUrl}/${pullRequestId}`)
    const pr = await res.json()
    return { pullRequestId: pr.id, status: statusOf(pr), participants: pr.participants ?? [] }
  }

  /**
   * Requests review from the given reviewers — `[{ id, required }]`, `id` being a Bitbucket account's
   * `uuid` (`lib/bitbucketIdentityClient.js`'s `resolveIdentity` result carries one). Bitbucket Cloud
   * has no dedicated "add a reviewer to an existing pull request" endpoint — reviewers are set via `PUT
   * .../pullrequests/{id}` with a full-replace `reviewers` array, the same full-replace shape
   * `lib/gitlabPullRequestsClient.js`'s own `addReviewers` (GitLab's `reviewer_ids`) already uses; there
   * is no separate request-reviewer action the way GitHub/GitLab each have, and (as with both of those)
   * no API-level "required reviewer" either — enforcement is the target repo's own branch-
   * permissions/merge-checks configuration. `required` is accepted for shape-parity with every other
   * provider's own `addReviewers` but otherwise unused, per ADR-0040/0041's own "gantry never invents
   * an enforcement mechanism the provider itself doesn't have" stance (ADR-0036's "the library repo's
   * own review process is respected" posture, for the Promote caller specifically).
   *
   * Only ever called once, immediately after `createPullRequest`, with a brand-new pull request
   * carrying no reviewers yet — so replacing the whole `reviewers` array here (rather than reading the
   * current list first and appending) never drops an existing reviewer in practice.
   */
  async function addReviewers(pullRequestId, reviewers = []) {
    const uuids = reviewers.map((r) => r.id).filter(Boolean)
    if (!uuids.length) return null
    const res = await request(`${pullRequestsUrl}/${pullRequestId}`, {
      method: 'PUT',
      body: { reviewers: uuids.map((uuid) => ({ uuid })) },
    })
    return res.json()
  }

  /**
   * Fetches the commits on a pull request (`GET .../pullrequests/{id}/commits`) — Bitbucket's own
   * per-PR commit list, used the same way `lib/gitlabPullRequestsClient.js`'s own
   * `getPullRequestCommits` is: to populate the Work item details card's commit panel
   * (`lib/stageStatus.js`'s `summarizeBitbucketPullRequest`). Bitbucket paginates this endpoint the
   * same way its content-store routes do (`values`, `pagelen`) — unwrapped here to a bare array, so a
   * caller reads it the same shape GitHub/GitLab's own commit lists already are.
   */
  async function getPullRequestCommits(pullRequestId) {
    const res = await request(`${pullRequestsUrl}/${pullRequestId}/commits`)
    const data = await res.json()
    return data.values ?? []
  }

  /**
   * Merges a pull request (`POST .../pullrequests/{id}/merge`) — always `merge_strategy:
   * 'merge_commit'`, never `'squash'` or `'fast_forward'`: the same "stage branches are stacked on the
   * preceding stage's branch while its own pull request is still open" reasoning
   * `lib/githubPullRequestsClient.js`/`lib/gitlabPullRequestsClient.js`'s own doc comments give (ADR-
   * 0014), and `close_source_branch: false` so that stacking is never broken by an auto-deleted source
   * branch. `completionOptions.mergeCommitMessage`, if given, becomes Bitbucket's own `message` field —
   * otherwise Bitbucket picks its own default message.
   *
   * Bitbucket refuses a merge blocked by a branch restriction or a failed merge check with a non-2xx
   * response (typically 409) naming the reason — this function makes no attempt to interpret, retry,
   * or fall back to a different merge strategy on that refusal (mirroring ADR-0040/0041's GitHub/GitLab
   * stance); the thrown `RequestError`'s `.body` carries Bitbucket's own response verbatim for the
   * caller (`lib/stageStatus.js`) to surface as a blocked sign-off.
   */
  async function completePullRequest(pullRequestId, completionOptions = {}) {
    const res = await request(`${pullRequestsUrl}/${pullRequestId}/merge`, {
      method: 'POST',
      body: {
        merge_strategy: 'merge_commit',
        close_source_branch: false,
        ...(completionOptions.mergeCommitMessage !== undefined ? { message: completionOptions.mergeCommitMessage } : {}),
      },
    })
    return res.json()
  }

  return { owner, repository, baseUrl, createPullRequest, getPullRequest, getPullRequestCommits, completePullRequest, addReviewers }
}

/**
 * Turns a pull request's raw `participants` into gantry's own pending/approved/changes-requested
 * vocabulary, per ADR-0042's own mapping: each `role === 'REVIEWER'` participant's `state` is already
 * exactly `'approved'`, `'changes_requested'` or `null` (no action yet) — a genuine tri-state read
 * directly off the participant, unlike GitLab's own inferred not-approved-plus-unresolved-thread
 * reading (`interpretGitLabMergeRequest`). `'changes_requested'` wins over `'approved'` when reviewers
 * disagree, mirroring `interpretGitHubReviews`'s identical precedence — a single "send this back" from
 * any reviewer is never masked by another reviewer's approval. `role === 'PARTICIPANT'` entries (the
 * author, or anyone who commented without being asked to review) never count towards this reading —
 * only `REVIEWER`s carry a real, review-shaped vote.
 *
 * Accepts either shape its two callers already pass: `lib/stageStatus.js`'s `bitbucketReviewSummary`
 * hands over the bare `participants` array it already has in hand (`getPullRequest`'s own return
 * shape), while `lib/definitionPromote.js` hands over the whole pull request object and this reads
 * `.participants` off it (empty/missing reads as no participants yet, same "pending" result either
 * way) — one function, no second copy for the second call shape.
 */
export function interpretBitbucketPullRequest(prOrParticipants) {
  const participants = Array.isArray(prOrParticipants) ? prOrParticipants : (prOrParticipants?.participants ?? [])
  const reviewers = participants.filter((p) => p.role === 'REVIEWER')
  if (reviewers.some((r) => r.state === 'changes_requested')) return 'changes-requested'
  if (reviewers.some((r) => r.state === 'approved')) return 'approved'
  return 'pending'
}
