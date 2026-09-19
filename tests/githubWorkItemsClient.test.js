import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError, NotFoundError } from '../lib/providerErrors.js'
import { createGitHubWorkItemsClient } from '../lib/githubWorkItemsClient.js'
import { withFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/lifecycle.js'

// #14 — the GitHub "work items" capability (docs/adr/0039/0040): creating issues, reading/updating
// them, and attaching a child issue under a parent as a native sub-issue or, where that's unavailable,
// a task-list-plus-"Part of" fallback. Exercised over real fetch against the in-process fake GitHub
// server, never a mocked client.

function withFakeServer(overrides, fn) {
  return withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, ...overrides }, fn)
}

function client(baseUrl, overrides = {}) {
  return createGitHubWorkItemsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl, ...overrides })
}

test('createIssue creates an open issue with distinct, incrementing numbers', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const first = await c.createIssue({ title: 'First', body: 'a' })
    const second = await c.createIssue({ title: 'Second', body: 'b' })
    assert.equal(first.state, 'open')
    assert.notEqual(first.number, second.number)
    assert.notEqual(first.id, second.id)
  })
})

test('getIssue reads back a created issue by number, and throws NotFoundError for one that does not exist', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'Parent initiative', body: '' })
    const fetched = await c.getIssue(created.number)
    assert.equal(fetched.title, 'Parent initiative')

    await assert.rejects(() => c.getIssue(999999), NotFoundError)
  })
})

test('updateIssue partially updates an issue, leaving other fields untouched', async () => {
  await withFakeServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const created = await c.createIssue({ title: 'Shape', body: 'original body' })
    const updated = await c.updateIssue(created.number, { state: 'closed', state_reason: 'completed' })
    assert.equal(updated.state, 'closed')
    assert.equal(updated.state_reason, 'completed')
    assert.equal(updated.body, 'original body')
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

test('createChildIssue attaches the child as a native sub-issue when the repository supports it', async () => {
  await withFakeServer({ subIssuesEnabled: true }, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createIssue({ title: 'Parent initiative', body: '' })

    const { issue, hierarchyMode } = await c.createChildIssue(parent.number, 'Shape — my-initiative', 'Tracks the Shape stage.')
    assert.equal(hierarchyMode, 'sub-issue')
    assert.equal(issue.title, 'Shape — my-initiative')
    // Neither body was touched by the fallback machinery.
    assert.equal(issue.body, 'Tracks the Shape stage.')
    const reloadedParent = await c.getIssue(parent.number)
    assert.equal(reloadedParent.body, '')

    // Genuinely attached server-side, not just reported — confirmed against the fake server's own
    // sub-issues listing.
    const res = await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/issues/${parent.number}/sub_issues`, {
      headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
    })
    const subIssues = await res.json()
    assert.deepEqual(subIssues.map((i) => i.number), [issue.number])
  })
})

test('createChildIssue falls back to a task-list entry in the parent and a "Part of" line in the child when sub-issues are unavailable', async () => {
  await withFakeServer({ subIssuesEnabled: false }, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createIssue({ title: 'Parent initiative', body: 'Some existing description.' })

    const { issue, hierarchyMode } = await c.createChildIssue(parent.number, 'Shape — my-initiative', 'Tracks the Shape stage.')
    assert.equal(hierarchyMode, 'task-list')
    assert.match(issue.body, new RegExp(`Part of #${parent.number}`))

    const reloadedParent = await c.getIssue(parent.number)
    assert.match(reloadedParent.body, /Some existing description\./)
    assert.match(reloadedParent.body, /## Stages/)
    assert.match(reloadedParent.body, new RegExp(`- \\[ \\] #${issue.number} Shape — my-initiative`))
  })
})

test('a second stage falling back appends a second checklist item under the same "## Stages" heading, not a duplicate one', async () => {
  await withFakeServer({ subIssuesEnabled: false }, async (baseUrl) => {
    const c = client(baseUrl)
    const parent = await c.createIssue({ title: 'Parent initiative', body: '' })

    const first = await c.createChildIssue(parent.number, 'Shape — my-initiative', '')
    const second = await c.createChildIssue(parent.number, 'HLD — my-initiative', '')

    const reloadedParent = await c.getIssue(parent.number)
    assert.equal((reloadedParent.body.match(/## Stages/g) ?? []).length, 1)
    assert.match(reloadedParent.body, new RegExp(`#${first.issue.number} Shape`))
    assert.match(reloadedParent.body, new RegExp(`#${second.issue.number} HLD`))
  })
})
