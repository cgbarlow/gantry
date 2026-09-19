import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from './providerErrors.js'

// Every Atlassian error is tagged with the *suite* id, not the product — 'atlassian', the same id
// `lib/providerRegistry.js` registers this capability under and `lib/provider.js`'s location schema
// uses (docs/adr/0042). A future Bitbucket content-store client tags its own errors the same way:
// the split is by product internally (this file only ever talks to Jira), but a catch site sees one
// provider name for the whole suite, exactly like `providerDisplayName('atlassian')` already reports
// "Atlassian", not "Jira" or "Bitbucket".
const PROVIDER = 'atlassian'

export { PROVIDER }

/** Thrown when Jira rejects the supplied token (401, or 403 for a scope/permission problem this client doesn't otherwise distinguish). Mirrors `lib/gitlabClient.js`'s `GitLabAuthenticationError` — extends the provider-neutral `AuthenticationError` (docs/adr/0039) tagged `'atlassian'`. */
export class JiraAuthenticationError extends AuthenticationError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'JiraAuthenticationError'
  }
}

/** Thrown when the Jira *project* itself doesn't exist (or the token can't see it) — distinct from a missing issue within an existing project (`JiraNotFoundError`) and from a rejected token (`JiraAuthenticationError`). Raised by `listIssueTypes()`, the one call this client makes directly against the project resource rather than an issue — mirrors `lib/gitlabClient.js`'s own `getRepo`/`GitLabRepoNotFoundError` split. */
export class JiraProjectNotFoundError extends RepoNotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'JiraProjectNotFoundError'
  }
}

/** Thrown when a requested issue (or a transition on it) doesn't exist within an otherwise-reachable project — distinct from the project itself not existing (`JiraProjectNotFoundError`). */
export class JiraNotFoundError extends NotFoundError {
  constructor(message, { status } = {}) {
    super(message, { status, provider: PROVIDER })
    this.name = 'JiraNotFoundError'
  }
}

/** Catch-all for any other failed call to the Jira Cloud API: a non-2xx response this client doesn't otherwise distinguish (an invalid issue type at creation is one such case — Jira reports it as a 400 naming the `issuetype` field, not a distinct error class of its own), or a network-level failure reaching Jira at all. */
export class JiraRequestError extends RequestError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { status, body, provider: PROVIDER, cause })
    this.name = 'JiraRequestError'
  }
}

/**
 * The message every "this Jira project doesn't exist" error surfaces (`listIssueTypes` below) — one
 * wording shared across the one call site that constructs it, mirroring `lib/gitlabClient.js`'s own
 * `repoNotFoundMessage`.
 *
 * Deliberately does not say only "does not exist": Jira Cloud, like every other provider's
 * project/repo-level 404 in this codebase, returns the same response both for a project that is
 * genuinely missing and for a token whose scopes don't reach an otherwise-real one.
 */
function projectNotFoundMessage(jiraSite, jiraProjectKey) {
  return (
    `Jira project "${jiraProjectKey}" was not found on ${jiraSite}, or this token cannot see it. ` +
    'Jira returns the same "not found" response both when a project genuinely does not exist and when a ' +
    "token is missing a required scope — check the token's scopes before assuming the project key is wrong."
  )
}

/**
 * Renders plain text as the minimal Atlassian Document Format (ADF) structure Jira Cloud's REST API
 * v3 requires for `description`/comment `body` fields — v3 dropped the wiki-markup string every
 * earlier Jira REST version accepted, in favour of a structured document tree. One paragraph node per
 * blank-line-separated block, one plain text run per paragraph — enough to round-trip Gantry's own
 * plain-text stage/issue descriptions through `adfToText` below without data loss, not a general ADF
 * renderer (no headings, lists, links or marks — nothing this codebase's callers ever produce).
 */
function textToAdf(text) {
  const paragraphs = (text ?? '').split(/\n{2,}/).filter((p) => p.length > 0)
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.length
      ? paragraphs.map((paragraph) => ({ type: 'paragraph', content: [{ type: 'text', text: paragraph }] }))
      : [{ type: 'paragraph', content: [] }],
  }
}

/** The inverse of `textToAdf` above — reads back the plain-text runs `textToAdf` itself produces, joining paragraphs with a blank line. `null`/`undefined` (an issue with no description at all) reads back as `''`, matching every other client's own "absent description" convention. */
function adfToText(adf) {
  if (!adf || !Array.isArray(adf.content)) return ''
  return adf.content
    .map((block) => (Array.isArray(block.content) ? block.content.map((node) => node.text ?? '').join('') : ''))
    .join('\n\n')
}

/** Reshapes a raw Jira issue resource (`{id, key, fields: {summary, description, issuetype, status, project}}`) into the flatter shape every method below returns — `title`/`body` naming matching every other provider client's own `createIssue`/`getIssue` fields, `issueType`/`status`/`statusCategory` surfacing Jira's own typed/workflow concepts no other provider's Issues API has. */
function normalizeIssue(raw) {
  return {
    id: raw.id,
    key: raw.key,
    title: raw.fields?.summary ?? '',
    body: adfToText(raw.fields?.description),
    issueType: raw.fields?.issuetype?.name ?? null,
    status: raw.fields?.status?.name ?? null,
    statusCategory: raw.fields?.status?.statusCategory?.key ?? null,
    projectKey: raw.fields?.project?.key ?? null,
    // #47 (Request Review): the review-status label an issue carries (`reviewStatusToJiraLabel`/
    // `jiraLabelToReviewStatus`, lib/reviewStatus.js) and the accountId it's assigned to, surfaced the
    // same "flatten Jira's own field shape" way every other field on this object already is. `[]`/`null`
    // for an issue with neither, matching every other absent-field convention on this client.
    labels: raw.fields?.labels ?? [],
    assignee: raw.fields?.assignee?.accountId ?? null,
  }
}

/**
 * Picks the transition that moves an issue into a "Done"-category status — never a hardcoded
 * transition name, since a Jira Cloud site's own workflow configuration names its closing transition
 * however it likes ("Done", "Close Issue", "Resolve", ...). Mirrors `lib/workItemLink.js`'s own
 * `pickPassedState` for Azure DevOps: prefer the state/transition *category* Jira itself reports
 * (`to.statusCategory.key === 'done'`) over any particular name, falling back to the last transition
 * offered when no transition's target category is 'done' (every real Jira workflow has at least one
 * transition out of any non-terminal status, so this always resolves to *something*).
 */
export function pickClosingTransition(transitions) {
  if (!transitions || transitions.length === 0) {
    throw new Error('This issue reports no transitions to close it with')
  }
  return transitions.find((t) => t.to?.statusCategory?.key === 'done') ?? transitions[transitions.length - 1]
}

/**
 * A Jira Cloud Issues REST (v3) client — the "work items" capability (docs/adr/0039) for the
 * Atlassian provider (docs/adr/0042), parallel to `lib/gitlabWorkItemsClient.js` but shaped around
 * Jira's own primitives: a *typed* issue (Jira requires an `issuetype` at creation — unlike GitHub or
 * GitLab's type-less issues, this mirrors Azure DevOps's own typed work items, docs/adr/0042's own
 * "Jira issue type" section) addressed by its human-facing `key` (e.g. "GANTRY-42", the project-scoped
 * number Jira itself shows everywhere — this client's equivalent of GitLab's `iid`, never Jira's
 * separate globally-unique numeric `id`), and workflow *transitions* rather than a bare open/closed
 * `state` field (Jira's own state machine names its statuses and the transitions between them however
 * a site's workflow configures them — there is no universal "close" verb the way GitLab's
 * `state_event: 'close'` is).
 *
 * #42's own scope: create/read/update/comment on an issue, transition/close it, and fetch the Jira
 * project's own live-configured issue types (for the wizard ticket, #48, to build a picker from —
 * mirroring Azure DevOps's existing `listWorkItemTypes()`/`loadWorkItemTypes()` pattern rather than
 * GitHub/GitLab's type-omission). Linking a Gantry instance to a Jira issue hierarchy
 * (`lib/workItemLink.js`'s per-provider linker functions) is a later ticket's job, the same way #30
 * shipped GitLab's own work-items client well before any GitLab-specific linker existed.
 *
 * Authenticated with the workspace's own Jira token via `Authorization: Bearer <token>` — mirrors
 * `lib/githubClient.js`'s own Bearer convention rather than GitLab's `PRIVATE-TOKEN` header or Azure
 * DevOps's empty-username Basic auth. Real Jira Cloud's classic API-token convention is Basic auth
 * with a paired account email (`email:apiToken`), but Gantry's own workspace-credential model (ADR-
 * 0038, extended by ADR-0042 for Atlassian's two-token case) treats every provider's token as one
 * opaque string sent in one HTTP header — there is no second `email` field in that model to carry
 * Jira's classic pairing through, so this client sends the token as a bearer credential instead, the
 * same shape every other single-token provider client in this codebase already assumes.
 *
 * `jiraSite`/`jiraProjectKey` are the two Jira-specific fields of ADR-0042's location schema
 * (`{ owner, repository, jiraSite, jiraProjectKey }`) — `jiraSite` is the tenant's own hostname
 * (`yoursite.atlassian.net`), from which this client derives its own base URL
 * (`https://<jiraSite>`); unlike every other provider's `baseUrl`, there is no public default to fall
 * back to (every Atlassian Cloud tenant has its own site — ADR-0042's "no baseUrl field" in the
 * *stored* location schema). `baseUrl`, if given, overrides that derived URL wholesale — used only by
 * this module's own tests, to point at the in-process fake Jira server
 * (`tests/helpers/fakeJiraServer.js`) instead of a real `*.atlassian.net`.
 */
export function createJiraWorkItemsClient({ jiraSite, jiraProjectKey, pat, baseUrl } = {}) {
  for (const [name, value] of Object.entries({ jiraSite, jiraProjectKey, pat })) {
    if (!value) throw new Error(`createJiraWorkItemsClient: "${name}" is required`)
  }

  const trimmedBaseUrl = (baseUrl ?? `https://${jiraSite}`).replace(/\/+$/, '')
  const apiUrl = `${trimmedBaseUrl}/rest/api/3`
  const projectUrl = `${apiUrl}/project/${encodeURIComponent(jiraProjectKey)}`
  const issueUrl = `${apiUrl}/issue`

  function authHeaders() {
    return { Authorization: `Bearer ${pat}` }
  }

  // Low-level request for anything *within* the project's own issues (create/read/update an issue, add
  // a comment, list/perform a transition) — a 404 here always means "this issue (or transition) doesn't
  // exist", never "this project doesn't exist" (see listIssueTypes's own dedicated request below, which
  // throws the project-level error instead, mirroring lib/gitlabClient.js's identical getRepo/request
  // split).
  async function request(url, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new JiraRequestError(`Network error calling the Jira API (${method} ${url}): ${err.message}`, { cause: err })
    }

    if (res.status === 401 || res.status === 403) {
      throw new JiraAuthenticationError(`Jira rejected the supplied token (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new JiraNotFoundError(`Jira found no item for ${method} ${url} (HTTP 404)`, { status: res.status })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new JiraRequestError(`Jira API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  /**
   * Fetches this client's own Jira project's live-configured issue types (docs/adr/0042: "Jira
   * requires an issue type at creation" — mirrors `lib/azureDevOpsWorkItemsClient.js`'s
   * `listWorkItemTypes`) — `[{ id, name, description, iconUrl, subtask }, ...]`, Jira's own unfiltered
   * shape, the same "which types are actually usable is for the caller to decide" contract Azure
   * DevOps's own `listWorkItemTypes` doc comment describes. Throws `JiraProjectNotFoundError` if this
   * client's `jiraProjectKey` doesn't exist on `jiraSite` (or the token can't see it) — a dedicated
   * request rather than going through `request()` above, for the same reason `lib/gitlabClient.js`'s
   * `getRepo` is its own dedicated request.
   */
  async function listIssueTypes() {
    let res
    try {
      res = await fetch(projectUrl, { headers: authHeaders() })
    } catch (err) {
      throw new JiraRequestError(`Network error calling the Jira API (GET ${projectUrl}): ${err.message}`, { cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      throw new JiraAuthenticationError(`Jira rejected the supplied token (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 404) {
      throw new JiraProjectNotFoundError(projectNotFoundMessage(jiraSite, jiraProjectKey), { status: res.status })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new JiraRequestError(`Jira API request failed: GET ${projectUrl} -> HTTP ${res.status}`, { status: res.status, body })
    }
    const data = await res.json()
    return data.issueTypes ?? []
  }

  /**
   * Creates a new issue in this client's own `jiraProjectKey`, typed as `issueType` — a plain issue
   * type *name* (e.g. "Task", "Story", "Bug"; one of `listIssueTypes()`'s own `name` fields), never a
   * fixed default: docs/adr/0042's own "parameterized by issue type, never hardcoded" — the one place
   * this client's shape genuinely diverges from GitHub/GitLab's type-less `createIssue`. Jira's own
   * create-issue response is minimal (`{id, key, self}`, no fields at all), so this re-fetches the full
   * issue via `getIssue` before returning, giving every method on this client the same normalized
   * shape rather than a create-shaped response callers would have to special-case.
   *
   * `assigneeAccountId` and `labels` are both optional — #47 (Request Review) is this client's first
   * caller to need either: a review issue is assigned to its reviewer's own Jira `accountId` (#45,
   * never a username or email) and carries one `gantry:review/<status>` label
   * (`reviewStatusToJiraLabel`, lib/reviewStatus.js) from the moment it's created, matching the label
   * GitHub/GitLab's own review issues carry from their own `createIssue` call.
   */
  async function createIssue({ title, body, issueType, assigneeAccountId, labels }) {
    const fields = {
      project: { key: jiraProjectKey },
      summary: title,
      description: textToAdf(body),
      issuetype: { name: issueType },
    }
    if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId }
    if (labels) fields.labels = labels
    const res = await request(issueUrl, { method: 'POST', body: { fields } })
    const { key } = await res.json()
    return getIssue(key)
  }

  /** Fetches a single issue by its human-facing `key` (e.g. "GANTRY-42"). Throws `JiraNotFoundError` if no such issue exists. */
  async function getIssue(key) {
    const res = await request(`${issueUrl}/${encodeURIComponent(key)}`)
    return normalizeIssue(await res.json())
  }

  /**
   * Partial update of an issue — `{ title?, body? }`, mapped onto Jira's own `fields.summary`/
   * `fields.description` (the latter re-encoded through `textToAdf`). Fields not mentioned are left
   * as-is. Jira's own `PUT /issue/:key` returns 204 with no body on success, so this re-fetches the
   * updated issue the same way `createIssue` does, rather than returning nothing.
   */
  async function updateIssue(key, fields = {}) {
    const jiraFields = {}
    if (fields.title !== undefined) jiraFields.summary = fields.title
    if (fields.body !== undefined) jiraFields.description = textToAdf(fields.body)
    await request(`${issueUrl}/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields: jiraFields } })
    return getIssue(key)
  }

  /** Adds a plain-text comment to an issue (re-encoded through `textToAdf`, per Jira REST v3's own ADF-only `body` contract) and returns it as `{ id, body, created }` (`body` decoded back to plain text via `adfToText`, matching every other reader on this client). */
  async function addComment(key, body) {
    const res = await request(`${issueUrl}/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: { body: textToAdf(body) },
    })
    const comment = await res.json()
    return { id: comment.id, body: adfToText(comment.body), created: comment.created ?? null }
  }

  /** Lists the workflow transitions currently available from this issue's own status — `[{ id, name, to: { id, name, statusCategory: { key } } }, ...]`, Jira's own unfiltered shape. Empty for an issue already in a terminal status with no further transitions configured. */
  async function getTransitions(key) {
    const res = await request(`${issueUrl}/${encodeURIComponent(key)}/transitions`)
    const { transitions = [] } = await res.json()
    return transitions
  }

  /**
   * Moves an issue along its workflow via `transitionIdOrName` — matched against `getTransitions`'s
   * own `id` (exact) or `name` (case-insensitive), since a caller may have either a transition id
   * already in hand or only its human-readable name. Throws a plain `Error` naming the issue and
   * every transition actually available, rather than letting Jira's own opaque "invalid transition
   * id" 400 surface, if `transitionIdOrName` matches none of them.
   */
  async function transitionIssue(key, transitionIdOrName) {
    const transitions = await getTransitions(key)
    const transition = transitions.find(
      (t) => t.id === String(transitionIdOrName) || t.name.toLowerCase() === String(transitionIdOrName).toLowerCase()
    )
    if (!transition) {
      throw new Error(
        `Jira issue ${key} has no transition matching "${transitionIdOrName}" — available: ` +
          `${transitions.map((t) => t.name).join(', ') || '(none)'}`
      )
    }
    await request(`${issueUrl}/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transition.id } },
    })
    return getIssue(key)
  }

  /**
   * Transitions an issue into whichever available transition leads to a "Done"-category status
   * (`pickClosingTransition` above) — this client's "gate passed" push, the Jira twin of
   * `lib/gitlabWorkItemsClient.js`'s `updateIssue(iid, { state_event: 'close' })` and
   * `lib/githubWorkItemsClient.js`'s `updateIssue(number, { state: 'closed' })`, adapted to Jira
   * having no bare "closed" state of its own — only transitions between named, per-workflow statuses.
   */
  async function closeIssue(key) {
    const transitions = await getTransitions(key)
    const transition = pickClosingTransition(transitions)
    await request(`${issueUrl}/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transition.id } },
    })
    return getIssue(key)
  }

  return {
    jiraSite,
    jiraProjectKey,
    baseUrl: trimmedBaseUrl,
    listIssueTypes,
    createIssue,
    getIssue,
    updateIssue,
    addComment,
    getTransitions,
    transitionIssue,
    closeIssue,
  }
}
