import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError, NotFoundError } from '../lib/providerErrors.js'
import { createGitLabWorkItemsClient } from '../lib/gitlabWorkItemsClient.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'

// #30 — the GitLab "work items" capability (docs/adr/0039/0041): creating issues, reading/updating
// them, and attaching a child issue under a parent via the task-list-plus-"Part of" convention (GitLab's
// REST v4 API has no native parent/child issue relation to attempt first, unlike GitHub's sub-issues —
// see lib/gitlabWorkItemsClient.js's own doc comment). Exercised over real fetch against the in-process
// fake GitLab server, never a mocked client.

function withFakeServer(overrides, fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, ...overrides }, fn)
}

function client(baseUrl, overrides = {}) {
  return createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl, ...overrides })
}

test('createGitLabWorkItemsClient requires namespace, repository and pat', () => {
  assert.throws(() => createGitLabWorkItemsClient({ repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT }), /"namespace" is required/)
  assert.throws(() => createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, pat: GITLAB_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitLabWorkItemsClient({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY }), /"pat" is required/)
})

test('createIssue creates an open issue with distinct, incrementing iids', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const first = await c.createIssue({ title: 'First', body: 'a' })
    const second = await c.createIssue({ title: 'Second', body: 'b' })
    assert.equal(first.state, 'opened')
    assert.notEqual(first.iid, second.iid)
    assert.notEqual(first.id, second.id)
  })
})

test('getIssue reads back a created issue by iid, and throws NotFoundError for one that does not exist', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'Parent initiative', body: '' })
    const fetched = await c.getIssue(created.iid)
    assert.equal(fetched.title, 'Parent initiative')

    await assert.rejects(() => c.getIssue(999999), NotFoundError)
  })
})

test('updateIssue partially updates an issue via state_event, leaving other fields untouched', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'Shape', body: 'original description' })
    const updated = await c.updateIssue(created.iid, { state_event: 'close' })
    assert.equal(updated.state, 'closed')
    assert.equal(updated.description, 'original description')
    assert.equal(updated.title, 'Shape')
  })
})

test('a rejected PAT surfaces as AuthenticationError', async () => {
  await withFakeServer({}, async (baseUrl) => {
    await assert.rejects(
      () => client(baseUrl, { pat: 'not-a-real-pat' }).createIssue({ title: 'x', body: '' }),
      AuthenticationError
    )
  })
})

test('createChildIssue attaches the child via a task-list entry in the parent and a "Part of" line in the child', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createIssue({ title: 'Parent initiative', body: 'Some existing description.' })

    const { issue, hierarchyMode } = await c.createChildIssue(parent.iid, 'Shape — my-initiative', 'Tracks the Shape stage.')
    assert.equal(hierarchyMode, 'task-list')
    assert.match(issue.description, new RegExp(`Part of #${parent.iid}`))

    const reloadedParent = await c.getIssue(parent.iid)
    assert.match(reloadedParent.description, /Some existing description\./)
    assert.match(reloadedParent.description, /## Stages/)
    assert.match(reloadedParent.description, new RegExp(`- \\[ \\] #${issue.iid} Shape — my-initiative`))
  })
})

test('a second stage falling back appends a second checklist item under the same "## Stages" heading, not a duplicate one', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createIssue({ title: 'Parent initiative', body: '' })

    const first = await c.createChildIssue(parent.iid, 'Shape — my-initiative', '')
    const second = await c.createChildIssue(parent.iid, 'HLD — my-initiative', '')

    const reloadedParent = await c.getIssue(parent.iid)
    assert.equal((reloadedParent.description.match(/## Stages/g) ?? []).length, 1)
    assert.match(reloadedParent.description, new RegExp(`#${first.issue.iid} Shape`))
    assert.match(reloadedParent.description, new RegExp(`#${second.issue.iid} HLD`))
  })
})
