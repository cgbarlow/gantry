import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError, RepoNotFoundError, RequestError } from '../lib/providerErrors.js'
import { createJiraWorkItemsClient, pickClosingTransition } from '../lib/jiraWorkItemsClient.js'
import { withFakeJiraServer, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'

// #42 — the Jira Cloud "work items" capability (docs/adr/0039/0042): creating a typed issue, reading
// and partially updating it, adding a comment, and moving it through its own workflow's transitions
// (including "close" — pick whichever transition leads to a Done-category status). Exercised over
// real fetch against the in-process fake Jira server, never a mocked client.

function withFakeServer(overrides, fn) {
  return withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT, ...overrides }, fn)
}

function client(baseUrl, overrides = {}) {
  return createJiraWorkItemsClient({ jiraSite: 'unused.atlassian.net', jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT, baseUrl, ...overrides })
}

test('createJiraWorkItemsClient requires jiraSite, jiraProjectKey and pat', () => {
  assert.throws(() => createJiraWorkItemsClient({ jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT }), /"jiraSite" is required/)
  assert.throws(() => createJiraWorkItemsClient({ jiraSite: 'x.atlassian.net', pat: JIRA_VALID_PAT }), /"jiraProjectKey" is required/)
  assert.throws(() => createJiraWorkItemsClient({ jiraSite: 'x.atlassian.net', jiraProjectKey: JIRA_PROJECT_KEY }), /"pat" is required/)
})

test('listIssueTypes fetches the project\'s own live-configured issue types', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const types = await c.listIssueTypes()
    assert.ok(types.some((t) => t.name === 'Task'))
    assert.ok(types.some((t) => t.name === 'Bug'))
  })
})

test('createIssue creates an issue typed as given, with distinct, incrementing keys', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const first = await c.createIssue({ title: 'First', body: 'a', issueType: 'Task' })
    const second = await c.createIssue({ title: 'Second', body: 'b', issueType: 'Story' })
    assert.equal(first.title, 'First')
    assert.equal(first.issueType, 'Task')
    assert.equal(second.issueType, 'Story')
    assert.notEqual(first.key, second.key)
    assert.notEqual(first.id, second.id)
    assert.equal(first.status, 'To Do')
  })
})

test('createIssue accepts an optional assigneeAccountId and labels, surfaced back on the normalized issue (#47)', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const withBoth = await c.createIssue({
      title: 'Review requested',
      body: '',
      issueType: 'Task',
      assigneeAccountId: 'acc-1',
      labels: ['gantry:review/requested'],
    })
    assert.equal(withBoth.assignee, 'acc-1')
    assert.deepEqual(withBoth.labels, ['gantry:review/requested'])

    // Both are optional — an issue created without them still normalizes to the same absent-field
    // convention every other field on this client already uses.
    const withNeither = await c.createIssue({ title: 'Plain', body: '', issueType: 'Task' })
    assert.equal(withNeither.assignee, null)
    assert.deepEqual(withNeither.labels, [])

    // getIssue re-reads the same normalized shape, not just the create response.
    const reread = await c.getIssue(withBoth.key)
    assert.equal(reread.assignee, 'acc-1')
    assert.deepEqual(reread.labels, ['gantry:review/requested'])
  })
})

test('getIssue reads back a created issue by key, round-tripping a multi-paragraph body, and throws NotFoundError for one that does not exist', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'Parent initiative', body: 'First paragraph.\n\nSecond paragraph.', issueType: 'Task' })
    const fetched = await c.getIssue(created.key)
    assert.equal(fetched.title, 'Parent initiative')
    assert.equal(fetched.body, 'First paragraph.\n\nSecond paragraph.')

    await assert.rejects(() => c.getIssue(`${JIRA_PROJECT_KEY}-999999`), (err) => {
      assert.equal(err.name, 'JiraNotFoundError')
      return true
    })
  })
})

test('updateIssue partially updates an issue, leaving other fields untouched', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'Shape', body: 'original description', issueType: 'Task' })
    const updated = await c.updateIssue(created.key, { title: 'Shape (renamed)' })
    assert.equal(updated.title, 'Shape (renamed)')
    assert.equal(updated.body, 'original description')
    assert.equal(updated.issueType, 'Task')
  })
})

test('addComment posts a comment and returns it decoded back to plain text', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'x', body: '', issueType: 'Task' })
    const comment = await c.addComment(created.key, 'Reviewed, looks good.')
    assert.equal(comment.body, 'Reviewed, looks good.')
    assert.ok(comment.id)
  })
})

test('getTransitions/transitionIssue move an issue through its own workflow by transition name', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'x', body: '', issueType: 'Task' })

    const transitions = await c.getTransitions(created.key)
    assert.ok(transitions.some((t) => t.name === 'Start Progress'))

    const inProgress = await c.transitionIssue(created.key, 'Start Progress')
    assert.equal(inProgress.status, 'In Progress')
    assert.equal(inProgress.statusCategory, 'indeterminate')

    const done = await c.transitionIssue(created.key, 'Done')
    assert.equal(done.status, 'Done')
    assert.equal(done.statusCategory, 'done')
  })
})

test('transitionIssue throws a clear error naming the issue and its available transitions, for one that does not match', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'x', body: '', issueType: 'Task' })
    await assert.rejects(() => c.transitionIssue(created.key, 'Not A Real Transition'), /has no transition matching "Not A Real Transition"/)
  })
})

test('closeIssue picks whichever transition leads to a Done-category status, regardless of its name', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'x', body: '', issueType: 'Task' })
    const closed = await c.closeIssue(created.key)
    assert.equal(closed.status, 'Done')
    assert.equal(closed.statusCategory, 'done')
  })
})

test('pickClosingTransition prefers a Done-category transition over the last one offered, and throws for an empty list', () => {
  const transitions = [
    { id: '1', name: 'Start Progress', to: { statusCategory: { key: 'indeterminate' } } },
    { id: '2', name: 'Done', to: { statusCategory: { key: 'done' } } },
    { id: '3', name: 'Cancel', to: { statusCategory: { key: 'new' } } },
  ]
  assert.equal(pickClosingTransition(transitions).id, '2')
  assert.throws(() => pickClosingTransition([]), /no transitions to close it with/)
})

// Normalized-error coverage (docs/adr/0039): project not found, auth failure, and an
// invalid-issue-type creation attempt.

test('listIssueTypes throws the neutral RepoNotFoundError, tagged atlassian, for a project that does not exist', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl, { jiraProjectKey: 'NOSUCHPROJECT' })
    await assert.rejects(() => c.listIssueTypes(), (err) => {
      assert.ok(err instanceof RepoNotFoundError)
      assert.equal(err.name, 'JiraProjectNotFoundError')
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('a rejected token surfaces as the neutral AuthenticationError, tagged atlassian', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl, { pat: 'not-a-real-token' })
    await assert.rejects(() => c.createIssue({ title: 'x', body: '', issueType: 'Task' }), (err) => {
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.name, 'JiraAuthenticationError')
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('creating an issue with an invalid issue type surfaces as the neutral RequestError, naming the bad type', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    await assert.rejects(() => c.createIssue({ title: 'x', body: '', issueType: 'Epic Saga' }), (err) => {
      assert.ok(err instanceof RequestError)
      assert.equal(err.name, 'JiraRequestError')
      assert.equal(err.status, 400)
      assert.match(err.body, /issuetype/)
      return true
    })
  })
})
