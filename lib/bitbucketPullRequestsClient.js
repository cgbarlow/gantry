import { AuthenticationError, NotFoundError, RequestError } from './providerErrors.js'
import { DEFAULT_BASE_URL, PROVIDER } from './bitbucketClient.js'

/**
 * Bitbucket's pull-requests capability (#49, docs/adr/0039/0042) — open a pull request, read it back
 * (status + reviewer participant state) and request a reviewer: the subset Promote needs (ADR-0036:
 * "gantry proposes, it doesn't merge on their behalf" — a promotion pull request is merged by the
 * library repo's own code owner, on Bitbucket itself, never by gantry). Mirrors
 * `lib/githubPullRequestsClient.js`'s own initial scope (#20 — open/read/request-reviewer, no merge
 * yet) and `lib/gitlabPullRequestsClient.js`'s shape, adapted to Bitbucket Cloud's actual pull-requests
 * API rather than assuming either one's shape carries over unchanged.
 *
 * Sign-off's fuller pull-requests surface — merge, branch-protection-refusal handling, wiring into
 * `lib/stageApproval.js`/`lib/stageStatus.js` — is `#46`'s own job (`completePullRequest`,
 * `getPullRequestCommits`), extending this same file exactly the way GitHub's own `#13` extended
 * `lib/githubPullRequestsClient.js` after `#20` landed it with a narrower scope.
 *
 * A Bitbucket Cloud repository is addressed by `{owner}/{repository}` (ADR-0042 — reusing GitHub's
 * own location keys), and every call is Bearer-authenticated (`lib/bitbucketClient.js`'s own "Bearer,
 * not Basic — deliberately" doc comment gives the full reasoning; this client sends the identical
 * header for the identical reason).
 *
 * `baseUrl` defaults to the public Bitbucket Cloud API but is overridable in tests, to point at
 * `tests/helpers/fakeBitbucketServer.js` instead of `api.bitbucket.org` — there is no self-hosted
 * override in production use (ADR-0042: Cloud-only).
 */
export function createBitbucketPullRequestsClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createBitbucketPullRequestsClient: "${name}" is required`)
  }

  const repoUrl = `${baseUrl.replace(/\/+$/, '')}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

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

  // Bitbucket Cloud's own `state` ('OPEN'/'MERGED'/'DECLINED'/'SUPERSEDED') onto the same
  // active/completed/abandoned vocabulary every other provider's own pull-requests client returns,
  // so a caller displaying a promotion's status never has to branch on provider for the word itself.
  function statusOf(pr) {
    if (pr.state === 'OPEN') return 'active'
    return pr.state === 'MERGED' ? 'completed' : 'abandoned'
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
    const res = await request(`${repoUrl}/pullrequests`, {
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
   * Fetches a pull request's current status and its full `participants` list — everything
   * `interpretBitbucketPullRequest` below needs in one call, mirroring
   * `lib/githubPullRequestsClient.js`'s own `getPullRequest`'s "everything a caller needs" contract.
   * Unlike GitHub (a separate reviews endpoint) or GitLab (a separate approvals endpoint), Bitbucket
   * rides reviewer state along on the pull request resource itself, in `participants` — no second
   * request needed.
   */
  async function getPullRequest(pullRequestId) {
    const res = await request(`${repoUrl}/pullrequests/${pullRequestId}`)
    const pr = await res.json()
    return { pullRequestId: pr.id, status: statusOf(pr), participants: pr.participants ?? [] }
  }

  /**
   * Requests review from the given reviewers — `[{ id, required }]`, `id` being Bitbucket's own
   * account `uuid` (`lib/bitbucketIdentityClient.js`'s `resolveIdentity` result carries one in `id`,
   * that client's own doc comment already flagging this exact use). Bitbucket's own `PUT
   * .../pullrequests/{id}` with a `reviewers` array is simultaneously how a reviewer is added *and*
   * Bitbucket's only "request review" verb — there is no separate request-reviewer action the way
   * GitHub/GitLab each have, and (as with both of those) no API-level "required reviewer" either:
   * enforcement is the target repo's own branch-permissions/merge-checks configuration. `required` is
   * accepted for shape-parity with every other provider's `addReviewers` but otherwise unused, per
   * ADR-0036's own "the library repo's own review process is respected" posture.
   *
   * Only ever called once, immediately after `createPullRequest` (`lib/definitionPromote.js`), with a
   * brand-new pull request carrying no reviewers yet — so replacing the whole `reviewers` array here
   * (rather than reading the current list first and appending) never drops an existing reviewer in
   * practice.
   */
  async function addReviewers(pullRequestId, reviewers = []) {
    const uuids = reviewers.map((r) => r.id).filter(Boolean)
    if (!uuids.length) return null
    const res = await request(`${repoUrl}/pullrequests/${pullRequestId}`, {
      method: 'PUT',
      body: { reviewers: uuids.map((uuid) => ({ uuid })) },
    })
    return res.json()
  }

  return { owner, repository, baseUrl, createPullRequest, getPullRequest, addReviewers }
}

/**
 * Turns a Bitbucket pull request's raw `participants` list into gantry's own
 * pending/approved/changes-requested vocabulary, per ADR-0042's own mapping: "each reviewer's
 * participant state is a genuine tri-state — approved, changes_requested, or no action yet —
 * mapping directly onto gantry's approved / CHANGES_REQUESTED / still-pending, the same shape
 * GitHub's own APPROVED/CHANGES_REQUESTED/COMMENTED mapping already uses. Unlike GitLab Free/CE,
 * there is no toggle-plus-discussion-threads reading to construct." A participant's `state` is one
 * of `'approved'`, `'changes_requested'`, or `null` (no action yet); `approved` (a boolean) rides
 * along too but `state` alone is authoritative and sufficient here.
 */
export function interpretBitbucketPullRequest(pr) {
  const participants = pr?.participants ?? []
  if (participants.some((p) => p.state === 'changes_requested')) return 'changes-requested'
  if (participants.some((p) => p.state === 'approved')) return 'approved'
  return 'pending'
}
