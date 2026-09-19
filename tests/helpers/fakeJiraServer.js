import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the Jira Cloud REST API (v3), standing in for a real
 * `*.atlassian.net` site/project in tests (#42) — a real HTTP server on an ephemeral port that
 * `lib/jiraWorkItemsClient.js` talks to over real `fetch` calls, never a mock of `fetch` itself.
 * Mirrors `tests/helpers/fakeGitLabServer.js`'s own shape and conventions so the two fakes read the
 * same way to a caller working across both providers.
 *
 * Covers what `lib/jiraWorkItemsClient.js` implements: the project resource (`GET
 * /rest/api/3/project/:key`, carrying that project's own live-configured `issueTypes`), and the
 * Issues API — create/read/update an issue, add a comment, list/perform a workflow transition.
 *
 * `validPat` is the token (or, if an array, any one of several) accepted as a Bearer credential in
 * the `Authorization` header — anything else, or a missing header, gets a 401, mirroring a rejected
 * token's real shape. `projectExists` (default `true`) controls whether the configured
 * `jiraProjectKey` is found at all; `false` simulates both a genuinely nonexistent project and a
 * token whose permissions can't see an otherwise-real one, the same "both cases look identical"
 * convention every other provider's own project/repo-level 404 in this codebase already follows. Any
 * request naming a project key *other* than the one this fake was configured with also 404s — the
 * more common way a test reaches "project not found", by constructing a client pointed at the wrong
 * key, without needing `projectExists: false` at all.
 *
 * `issueTypes` (default: Task/Story/Bug) seeds the project's own live-configured types — creating an
 * issue with any other `issuetype.name` is refused with Jira's own real 400 shape
 * (`{errorMessages: [], errors: {issuetype: "..."}}`), backing #42's "invalid-issue-type creation
 * attempt" normalized-error test.
 *
 * Every issue starts life in the "To Do" status and follows a small, fixed workflow
 * (`TRANSITIONS_BY_STATUS` below) loosely mirroring Jira's own default software workflow: To Do ->
 * In Progress -> Done, plus a Done -> To Do reopen — enough to exercise
 * `getTransitions`/`transitionIssue`/`closeIssue`'s own "pick the transition whose target status
 * category is 'done'" contract without modelling a real site's fully configurable workflow.
 */
export function createFakeJiraServer({
  jiraProjectKey,
  validPat,
  projectExists = true,
  issueTypes = [
    { id: '10001', name: 'Task', description: 'A task that needs to be done.', subtask: false },
    { id: '10002', name: 'Story', description: 'A user story.', subtask: false },
    { id: '10004', name: 'Bug', description: 'A problem which impairs product functions.', subtask: false },
  ],
} = {}) {
  // Issues, keyed by their human-facing `key` (e.g. "GANTRY-1") — the id
  // `lib/jiraWorkItemsClient.js` addresses every issue by, Jira's own project-scoped issue number
  // (equivalent to GitLab's `iid`). `id` is a separate, globally-unique-across-the-whole-site
  // identifier real Jira also assigns; this fake mints one too so a response shape-checks the same as
  // the real API's, even though nothing in `lib/jiraWorkItemsClient.js` addresses an issue by it.
  const issues = new Map() // key -> { id, key, fields: { summary, description, issuetype, status, project } }
  let issueNumberCounter = 0
  let issueIdCounter = 10000
  let commentIdCounter = 0

  const STATUSES = {
    'To Do': { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    'In Progress': { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    Done: { id: '10001', name: 'Done', statusCategory: { key: 'done' } },
  }

  const TRANSITIONS_BY_STATUS = {
    'To Do': [
      { id: '21', name: 'Start Progress', to: STATUSES['In Progress'] },
      { id: '31', name: 'Done', to: STATUSES.Done },
    ],
    'In Progress': [{ id: '41', name: 'Done', to: STATUSES.Done }],
    Done: [{ id: '51', name: 'Reopen', to: STATUSES['To Do'] }],
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-jira.invalid')
    const pathname = url.pathname
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const noContent = () => {
      res.writeHead(204)
      res.end()
    }

    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    const authHeader = req.headers['authorization'] ?? ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null
    if (!bearerToken || !validPats.includes(bearerToken)) {
      return json(401, { errorMessages: ['401 Unauthorized (fake server: invalid or missing bearer token)'], errors: {} })
    }

    if (!pathname.startsWith('/rest/api/3/')) {
      return json(404, { errorMessages: [`No fake route for ${req.method} ${pathname}`], errors: {} })
    }
    const rest = pathname.slice('/rest/api/3'.length)

    async function readJsonBody() {
      let raw = ''
      for await (const chunk of req) raw += chunk
      return raw ? JSON.parse(raw) : {}
    }

    // GET /rest/api/3/project/:key — lib/jiraWorkItemsClient.js's listIssueTypes().
    const projectMatch = rest.match(/^\/project\/([^/]+)$/)
    if (req.method === 'GET' && projectMatch) {
      const key = decodeURIComponent(projectMatch[1])
      if (!projectExists || key !== jiraProjectKey) {
        return json(404, { errorMessages: [`404 Project Not Found (fake: project "${key}" does not exist, or token lacks permission to see it)`], errors: {} })
      }
      return json(200, { id: '10000', key, name: key, issueTypes })
    }

    // POST /rest/api/3/issue — creates a new issue. Mirrors real Jira's own minimal create response
    // (`{id, key, self}`, no fields) — lib/jiraWorkItemsClient.js's createIssue() re-fetches the full
    // issue afterwards, exactly like a real caller against real Jira must.
    if (req.method === 'POST' && rest === '/issue') {
      const body = await readJsonBody()
      const fields = body.fields ?? {}
      const issueTypeName = fields.issuetype?.name
      const validType = issueTypes.some((t) => t.name === issueTypeName)
      if (!validType) {
        return json(400, {
          errorMessages: [],
          errors: { issuetype: `The issue type selected (${issueTypeName ?? '(none)'}) is invalid.` },
        })
      }
      issueNumberCounter += 1
      issueIdCounter += 1
      const key = `${jiraProjectKey}-${issueNumberCounter}`
      const issue = {
        id: String(issueIdCounter),
        key,
        fields: {
          summary: fields.summary ?? '',
          description: fields.description ?? null,
          issuetype: { id: issueTypes.find((t) => t.name === issueTypeName).id, name: issueTypeName },
          status: STATUSES['To Do'],
          project: { key: jiraProjectKey },
        },
        comments: [],
      }
      issues.set(key, issue)
      return json(201, { id: issue.id, key: issue.key, self: `${url.origin}/rest/api/3/issue/${issue.id}` })
    }

    // GET/PUT /rest/api/3/issue/:key — read, or partially update, an issue by its own project-scoped
    // key. PUT accepts `fields.summary`/`fields.description` and returns 204 with no body, matching
    // real Jira's own contract for this endpoint (lib/jiraWorkItemsClient.js's updateIssue() re-fetches
    // afterwards for exactly this reason).
    const issueMatch = rest.match(/^\/issue\/([^/]+)$/)
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1])
      const issue = issues.get(key)
      if (!issue) return json(404, { errorMessages: [`404 Issue Not Found (fake: "${key}")`], errors: {} })

      if (req.method === 'GET') return json(200, issue)

      if (req.method === 'PUT') {
        const { fields = {} } = await readJsonBody()
        if (fields.summary !== undefined) issue.fields.summary = fields.summary
        if (fields.description !== undefined) issue.fields.description = fields.description
        return noContent()
      }
    }

    // POST /rest/api/3/issue/:key/comment — lib/jiraWorkItemsClient.js's addComment().
    const commentMatch = rest.match(/^\/issue\/([^/]+)\/comment$/)
    if (req.method === 'POST' && commentMatch) {
      const key = decodeURIComponent(commentMatch[1])
      const issue = issues.get(key)
      if (!issue) return json(404, { errorMessages: [`404 Issue Not Found (fake: "${key}")`], errors: {} })
      const body = await readJsonBody()
      commentIdCounter += 1
      const comment = { id: String(commentIdCounter), body: body.body ?? null, created: new Date().toISOString() }
      issue.comments.push(comment)
      return json(201, comment)
    }

    // GET /rest/api/3/issue/:key/transitions — lib/jiraWorkItemsClient.js's getTransitions().
    // POST (same path) — transitionIssue()/closeIssue(), moving the issue to `transition.to`.
    const transitionsMatch = rest.match(/^\/issue\/([^/]+)\/transitions$/)
    if (transitionsMatch) {
      const key = decodeURIComponent(transitionsMatch[1])
      const issue = issues.get(key)
      if (!issue) return json(404, { errorMessages: [`404 Issue Not Found (fake: "${key}")`], errors: {} })
      const available = TRANSITIONS_BY_STATUS[issue.fields.status.name] ?? []

      if (req.method === 'GET') return json(200, { transitions: available })

      if (req.method === 'POST') {
        const body = await readJsonBody()
        const transitionId = body.transition?.id
        const transition = available.find((t) => t.id === transitionId)
        if (!transition) {
          return json(400, { errorMessages: ['Transition id is not valid'], errors: {} })
        }
        issue.fields.status = transition.to
        return noContent()
      }
    }

    return json(404, { errorMessages: [`No fake route for ${req.method} ${pathname}`], errors: {} })
  })
}

/** Starts a `createFakeJiraServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeGitLabServer.js`'s own `withFakeGitLabServer` shape. */
export function withFakeJiraServer({ jiraProjectKey, validPat, projectExists, issueTypes }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeJiraServer({ jiraProjectKey, validPat, projectExists, issueTypes })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

export const JIRA_SITE = 'fake-site.atlassian.net'
export const JIRA_PROJECT_KEY = 'GANTRY'
export const JIRA_VALID_PAT = 'valid-jira-test-token'
