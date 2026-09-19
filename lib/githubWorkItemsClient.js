import { GitHubAuthenticationError, GitHubNotFoundError, GitHubRequestError, PROVIDER, DEFAULT_BASE_URL } from './githubClient.js'

export { PROVIDER, DEFAULT_BASE_URL }

const API_VERSION_HEADER = '2022-11-28'

// The marker `appendStageChecklistItem` looks for so a second (or third, ...) stage's task-list entry
// is appended under the same "## Stages" heading rather than creating a duplicate section each time a
// child issue's own sub-issue attach falls back to this path.
const STAGES_SECTION_MARKER = '<!-- gantry:stages -->'

/**
 * A GitHub Issues REST client — the "work items" capability (docs/adr/0039) for the GitHub provider,
 * parallel to `lib/azureDevOpsWorkItemsClient.js` but shaped around GitHub's own primitives (issues,
 * not typed work items) rather than forcing Azure DevOps's field-map shape onto them. Covers exactly
 * what #14 needs: creating an instance's per-stage child issues under an existing parent issue,
 * attaching each as a native sub-issue where the repository supports the feature — falling back to a
 * task-list entry in the parent's body plus a "Part of #<n>" line in the child's when it doesn't
 * (docs/adr/0040) — and pushing a gate-passed "state" (closed, as completed) to a stage's own issue.
 *
 * Authenticated the same way as `lib/githubClient.js`: a caller-supplied PAT via
 * `Authorization: Bearer <pat>`. `baseUrl` defaults to the public GitHub API but is overridable for a
 * GitHub Enterprise Server host or, in tests, the fake in-process server
 * (`tests/helpers/fakeGitHubServer.js`).
 */
export function createGitHubWorkItemsClient({ owner, repository, pat, baseUrl = DEFAULT_BASE_URL } = {}) {
  for (const [name, value] of Object.entries({ owner, repository, pat })) {
    if (!value) throw new Error(`createGitHubWorkItemsClient: "${name}" is required`)
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
      throw new GitHubRequestError(`Network error calling GitHub API (${method} ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitHubAuthenticationError(`GitHub rejected the supplied PAT (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new GitHubNotFoundError(`GitHub found no item for ${method} ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new GitHubRequestError(`GitHub API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /** Creates a new issue. Returns the created issue (`number`, `id`, `title`, `body`, `state`, `html_url`, ...), the raw shape GitHub itself returns. */
  async function createIssue({ title, body }) {
    const res = await request(`${repoUrl}/issues`, { method: 'POST', body: { title, body } })
    return res.json()
  }

  /** Fetches a single issue by its repo-scoped number. Throws GitHubNotFoundError if no such issue exists. */
  async function getIssue(number) {
    const res = await request(`${repoUrl}/issues/${number}`)
    return res.json()
  }

  /** Partial update of an issue — `{ title?, body?, state?, state_reason? }`. Fields not mentioned are left as-is, mirroring `azureDevOpsWorkItemsClient.js`'s own `updateWorkItem`. */
  async function updateIssue(number, fields) {
    const res = await request(`${repoUrl}/issues/${number}`, { method: 'PATCH', body: fields })
    return res.json()
  }

  /** Attempts GitHub's native "Add sub-issue" relation — `sub_issue_id` is the child's own internal `id` (not its repo-scoped `number`), which is what this endpoint requires. Throws GitHubNotFoundError when the feature is unavailable for this repository (indistinguishable, by GitHub's own design, from the parent issue not existing — docs/adr/0040's own noted trap). */
  async function addSubIssue(parentNumber, subIssueId) {
    const res = await request(`${repoUrl}/issues/${parentNumber}/sub_issues`, {
      method: 'POST',
      body: { sub_issue_id: subIssueId },
    })
    return res.json()
  }

  // Appends one checklist line for `child` under a "## Stages" heading in the parent issue's own body
  // — creating that heading (once, marked by STAGES_SECTION_MARKER) the first time a fallback is
  // needed, and appending a further line under the existing one for every subsequent stage. This is
  // the "task list in the parent body" half of docs/adr/0040's sub-issues fallback.
  function appendStageChecklistItem(existingBody, child) {
    const body = existingBody ?? ''
    const item = `- [ ] #${child.number} ${child.title}`
    if (body.includes(STAGES_SECTION_MARKER)) {
      return `${body.replace(/\n+$/, '')}\n${item}\n`
    }
    const separator = body.trim() ? `${body.replace(/\n+$/, '')}\n\n` : ''
    return `${separator}${STAGES_SECTION_MARKER}\n## Stages\n\n${item}\n`
  }

  /**
   * Attaches `child` under `parentNumber` as its hierarchy (docs/adr/0040): GitHub's native sub-issue
   * relation where the repository supports it, falling back — on a 404/410 from `addSubIssue`, GitHub's
   * own signal for "feature unavailable" (never disambiguated further from "parent not found", since
   * the caller's own `createChildIssue` just created `child` moments earlier against this same repo) —
   * to a task-list checklist item appended to the parent's body plus a "Part of #<n>" line appended to
   * the child's. When the native relation succeeds, neither body is touched: GitHub's own sub-issue UI
   * already renders that relationship without any text markers.
   *
   * Returns `'sub-issue'` or `'task-list'`, naming which mode was actually used.
   */
  async function attachAsSubIssue(parentNumber, child) {
    try {
      await addSubIssue(parentNumber, child.id)
      return 'sub-issue'
    } catch (err) {
      if (err instanceof GitHubNotFoundError || (err instanceof GitHubRequestError && err.status === 410)) {
        const parent = await getIssue(parentNumber)
        await updateIssue(parentNumber, { body: appendStageChecklistItem(parent.body, child) })
        await updateIssue(child.number, { body: `${(child.body ?? '').replace(/\n+$/, '')}\n\nPart of #${parentNumber}`.trim() })
        return 'task-list'
      }
      throw err
    }
  }

  /**
   * Creates a new issue titled/bodied as given and attaches it under `parentNumber` in one call —
   * create then hierarchy-attach, mirroring `azureDevOpsWorkItemsClient.js`'s `createChildWorkItem`
   * single-call shape. Returns `{ issue, hierarchyMode }` (`lib/workItemLink.js`'s
   * `linkInstanceToWorkItem` uses `issue.number` as the per-stage id it records on the instance).
   */
  async function createChildIssue(parentNumber, title, body) {
    const child = await createIssue({ title, body })
    const hierarchyMode = await attachAsSubIssue(parentNumber, child)
    const issue = hierarchyMode === 'task-list' ? await getIssue(child.number) : child
    return { issue, hierarchyMode }
  }

  return { owner, repository, baseUrl, createIssue, getIssue, updateIssue, createChildIssue }
}
