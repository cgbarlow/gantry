import { GitLabAuthenticationError, GitLabNotFoundError, GitLabRequestError, PROVIDER, DEFAULT_BASE_URL } from './gitlabClient.js'

export { PROVIDER, DEFAULT_BASE_URL }

// The marker `appendStageChecklistItem` looks for so a second (or third, ...) stage's task-list entry
// is appended under the same "## Stages" heading rather than creating a duplicate section each time a
// child issue is attached under the same parent — mirrors `lib/githubWorkItemsClient.js`'s own marker.
const STAGES_SECTION_MARKER = '<!-- gantry:stages -->'

/**
 * A GitLab Issues REST (v4) client — the "work items" capability (docs/adr/0039) for the GitLab
 * provider, parallel to `lib/githubWorkItemsClient.js` but shaped around GitLab's own primitives.
 * Covers what #30 needs: creating an instance's per-stage child issues under an existing parent
 * issue, and pushing a gate-passed "state" (closed) to a stage's own issue. #34 (Request Review)
 * extends `createIssue` with assignee/label support and adds `ensureLabelsExist`, the same way #15
 * extended `lib/githubWorkItemsClient.js`'s own `createIssue`.
 *
 * Unlike GitHub, GitLab's REST v4 API has no public parent/child issue-hierarchy endpoint — the
 * "Add sub-issue" relation GitHub exposes (`lib/githubWorkItemsClient.js`'s `addSubIssue`) has no v4
 * REST equivalent; the nearest native features (Premium-only Epics, or the newer GraphQL-only "work
 * item" hierarchy widget) are either license-gated or outside the REST surface this client and its
 * fake test server work against. So every child issue here is attached the same way GitHub's own
 * client *falls back* to when sub-issues aren't available: a task-list checklist entry appended to the
 * parent issue's own `description`, plus a "Part of #<n>" line appended to the child's — there is no
 * "try native first" step to attempt, since there is nothing to try.
 *
 * Authenticated the same way as `lib/gitlabClient.js`: a caller-supplied PAT via GitLab's own
 * `PRIVATE-TOKEN` header (also how a Project/Group Access Token authenticates — ADR-0038). `baseUrl`
 * defaults to the public gitlab.com API but is overridable for self-hosted GitLab CE/EE (ADR-0041) or,
 * in tests, the fake in-process server (`tests/helpers/fakeGitLabServer.js`).
 *
 * A GitLab project is addressed by its full `namespace/repository` path, URL-encoded as one opaque
 * `namespace%2Frepository` path segment — the same convention `lib/gitlabClient.js` uses.
 */
export function createGitLabWorkItemsClient({ namespace, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ namespace, repository, pat })) {
    if (!value) throw new Error(`createGitLabWorkItemsClient: "${name}" is required`)
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
      throw new GitLabRequestError(`Network error calling GitLab API (${method} ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitLabAuthenticationError(`GitLab rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitLabNotFoundError(`GitLab found no item for ${method} ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new GitLabRequestError(`GitLab API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /**
   * Creates a new issue. Returns the created issue (`iid`, `id`, `title`, `description`, `state`,
   * `web_url`, `labels`, ...), the raw shape GitLab itself returns — `iid` (the project-scoped
   * "internal id") is what every other method here, and `lib/workItemLink.js`'s own recorded `stages`
   * map, addresses an issue by; GitLab's separate, globally-unique `id` is never used.
   *
   * `assigneeIds` (#34, Request Review) is GitLab's own `assignee_ids` — an array of numeric user ids
   * (`lib/gitlabIdentityClient.js`'s own resolved `id`, not a username: GitLab's Issues API has no
   * assign-by-username field, unlike GitHub's `assignees` array of logins). `labels` is an array of
   * plain label name strings, joined into the comma-separated string GitLab's own API accepts — this
   * is what lets a caller create an already-assigned, already-labelled issue in one round trip rather
   * than a create-then-patch pair, mirroring `lib/githubWorkItemsClient.js`'s own `createIssue`.
   */
  async function createIssue({ title, body, assigneeIds, labels }) {
    const res = await request(`${projectUrl}/issues`, {
      method: 'POST',
      body: {
        title,
        description: body,
        ...(assigneeIds ? { assignee_ids: assigneeIds } : {}),
        ...(labels ? { labels: labels.join(',') } : {}),
      },
    })
    return res.json()
  }

  /** Fetches a single issue by its project-scoped `iid`. Throws GitLabNotFoundError if no such issue exists. */
  async function getIssue(iid) {
    const res = await request(`${projectUrl}/issues/${iid}`)
    return res.json()
  }

  /**
   * Partial update of an issue — `{ title?, description?, state_event? }`. GitLab only ever accepts a
   * state *transition* (`state_event: 'close'`/`'reopen'`), never a bare `state` field directly — the
   * one place this client's shape genuinely diverges from `lib/githubWorkItemsClient.js`'s own
   * `updateIssue({ state: 'closed', ... })`, since GitHub's REST API does accept `state` directly.
   * Fields not mentioned are left as-is.
   */
  async function updateIssue(iid, fields) {
    const res = await request(`${projectUrl}/issues/${iid}`, { method: 'PUT', body: fields })
    return res.json()
  }

  // Appends one checklist line for `child` under a "## Stages" heading in the parent issue's own
  // description — creating that heading (once, marked by STAGES_SECTION_MARKER) the first time a child
  // is attached, and appending a further line under the existing one for every subsequent stage. This
  // is GitLab's whole hierarchy story here (see this module's own doc comment on why there is no native
  // relation to attempt first).
  function appendStageChecklistItem(existingDescription, child) {
    const description = existingDescription ?? ''
    const item = `- [ ] #${child.iid} ${child.title}`
    if (description.includes(STAGES_SECTION_MARKER)) {
      return `${description.replace(/\n+$/, '')}\n${item}\n`
    }
    const separator = description.trim() ? `${description.replace(/\n+$/, '')}\n\n` : ''
    return `${separator}${STAGES_SECTION_MARKER}\n## Stages\n\n${item}\n`
  }

  /**
   * Attaches `child` under `parentIid`'s own task-list (this module's doc comment explains why this is
   * the only hierarchy mode GitLab's REST v4 API supports here, unlike GitHub's native-relation-first
   * `attachAsSubIssue`) — appends a checklist entry to the parent's `description` and a "Part of #<n>"
   * line to the child's. Always returns `'task-list'`, the one hierarchy mode this client has.
   */
  async function attachAsChildIssue(parentIid, child) {
    const parent = await getIssue(parentIid)
    await updateIssue(parentIid, { description: appendStageChecklistItem(parent.description, child) })
    await updateIssue(child.iid, { description: `${(child.description ?? '').replace(/\n+$/, '')}\n\nPart of #${parentIid}`.trim() })
    return 'task-list'
  }

  /**
   * Creates a new issue titled/described as given and attaches it under `parentIid` in one call —
   * create then hierarchy-attach, mirroring `lib/githubWorkItemsClient.js`'s own `createChildIssue`
   * single-call shape and return value: `{ issue, hierarchyMode }` (`lib/workItemLink.js`'s
   * `linkInstanceToGitLabIssue` uses `issue.iid` as the per-stage id it records on the instance).
   */
  async function createChildIssue(parentIid, title, body) {
    const child = await createIssue({ title, body })
    const hierarchyMode = await attachAsChildIssue(parentIid, child)
    const issue = await getIssue(child.iid)
    return { issue, hierarchyMode }
  }

  /**
   * Ensures each of `labels` (`{ name, color, description }`, e.g. `lib/reviewStatus.js`'s
   * `allGitLabReviewLabels()`) exists on the project, creating any that don't — #34's "Gantry creates
   * those labels on demand", mirroring `lib/githubWorkItemsClient.js`'s own `ensureLabelsExist`.
   * Tolerates GitLab's own "already exists" validation error for one a prior request (or another
   * gantry instance against the same project) already created — real GitLab's Labels API responds
   * `400` with a `{ message: { title: ["has already been taken"] } }`-shaped body for a duplicate
   * name, unlike GitHub's `422 already_exists`; any other failure propagates.
   */
  async function ensureLabelsExist(labels) {
    for (const label of labels) {
      try {
        await request(`${projectUrl}/labels`, { method: 'POST', body: label })
      } catch (err) {
        if (err instanceof GitLabRequestError && err.status === 400 && /already been taken/i.test(err.body ?? '')) continue
        throw err
      }
    }
  }

  return { namespace, repository, baseUrl, createIssue, getIssue, updateIssue, createChildIssue, ensureLabelsExist }
}
