import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withFakeJiraServer, JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'

// HTTP-boundary tests for `GET /api/atlassian/issue-types` (#48, ADR-0042) — the "+ New Workspace"
// wizard's Register step's live-fetched Jira issue-type picker, mirroring
// tests/serverAzureDevOpsWorkItemLookup.test.js's own `GET /api/azure-devops/work-item-types`
// coverage. Unlike that route (whose `organization`/`project`/`baseUrl` are all caller-supplied, so it
// needs its own SSRF-guarded `baseUrl` allow-list), this route carries no `baseUrl` at all — Atlassian
// is Cloud-only (ADR-0042) — so the fake Jira server here is pointed at only via the running gantry
// server's own test-only `atlassianJiraBaseUrl` startup option, never a request parameter.

function withFakeAndGantryServer(options, fn) {
  return withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT, ...options }, async (jiraBaseUrl) => {
    await withRunningServer({ atlassianJiraBaseUrl: jiraBaseUrl }, async (gantryBase) => fn(gantryBase))
  })
}

function issueTypesUrl(gantryBase, overrides = {}) {
  const url = new URL(`${gantryBase}/api/atlassian/issue-types`)
  url.searchParams.set('jiraSite', overrides.jiraSite ?? JIRA_SITE)
  url.searchParams.set('jiraProjectKey', overrides.jiraProjectKey ?? JIRA_PROJECT_KEY)
  return url.toString()
}

test('GET /api/atlassian/issue-types reports 400 for a missing jiraSite/jiraProjectKey query parameter', async () => {
  await withFakeAndGantryServer({}, async (gantryBase) => {
    const res = await fetch(`${gantryBase}/api/atlassian/issue-types`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /Missing required query parameter/)
  })
})

test('GET /api/atlassian/issue-types with no PAT returns the structured "authentication required" response', async () => {
  await withFakeAndGantryServer({}, async (gantryBase) => {
    const res = await fetch(issueTypesUrl(gantryBase))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('GET /api/atlassian/issue-types with a PAT Jira itself rejects returns the same structured response', async () => {
  await withFakeAndGantryServer({}, async (gantryBase) => {
    const res = await fetch(issueTypesUrl(gantryBase), {
      headers: { Authorization: basicAuthHeader('not-the-right-jira-pat') },
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'authentication_required')
  })
})

test('GET /api/atlassian/issue-types reports 400 for a nonexistent Jira project', async () => {
  await withFakeAndGantryServer({ projectExists: false }, async (gantryBase) => {
    const res = await fetch(issueTypesUrl(gantryBase), {
      headers: { Authorization: basicAuthHeader(JIRA_VALID_PAT) },
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /not found/)
  })
})

test('GET /api/atlassian/issue-types with a valid PAT returns the project\'s own configured, non-subtask issue types', async () => {
  await withFakeAndGantryServer({}, async (gantryBase) => {
    const res = await fetch(issueTypesUrl(gantryBase), {
      headers: { Authorization: basicAuthHeader(JIRA_VALID_PAT) },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(
      body.map((t) => t.name),
      ['Task', 'Story', 'Bug']
    )
  })
})
