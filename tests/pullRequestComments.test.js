import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubPullRequestsClient } from '../lib/githubPullRequestsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { basicAuthHeader } from '../lib/azureDevOpsClient.js'
import { NotFoundError } from '../lib/providerErrors.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'
import { ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// #299 (parent #238): the Provider capability the AI interview's revision of a sent-back Stage reads: every comment on a Pull Request, resolved
// or not, on GitHub and Azure DevOps. Read-only: the AI never writes to a Pull Request.

// ---------- GitHub ----------

async function openGitHubPullRequest(client, baseUrl) {
  const content = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
  await content.writeFile('a.md', 'v1\n')
  await content.createBranch('feature')
  await content.writeFile('a.md', 'v2\n', { branch: 'feature' })
  return client.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Test PR' })
}

const withGitHub = (fn) =>
  withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } }, async (baseUrl) => {
    const client = createGitHubPullRequestsClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    await fn({ client, baseUrl })
  })

test('GitHub: getPullRequestComments reads the conversation, the inline comments and the review messages', async () => {
  await withGitHub(async ({ client, baseUrl }) => {
    const created = await openGitHubPullRequest(client, baseUrl)
    const repo = `${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`
    const post = (path, body) => fetch(`${repo}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    await post(`/issues/${created.pullRequestId}/comments`, { body: 'Please name the owner.', login: 'olivia' })
    await post(`/pulls/${created.pullRequestId}/comments`, { body: 'This figure has no source.', path: 'modules/m1.md', line: 4, login: 'olivia' })
    await post(`/pulls/${created.pullRequestId}/reviews`, { event: 'REQUEST_CHANGES', body: 'Two things to fix before I approve.', login: 'olivia' })
    await post(`/pulls/${created.pullRequestId}/reviews`, { event: 'COMMENT', login: 'olivia' }) // no message: not a comment

    const comments = await client.getPullRequestComments(created.pullRequestId)
    assert.deepEqual(comments.map((c) => c.body).sort(), ['Please name the owner.', 'This figure has no source.', 'Two things to fix before I approve.'])
    assert.deepEqual(comments.map((c) => c.kind).sort(), ['conversation', 'inline', 'review'])
    assert.ok(comments.every((c) => c.author === 'olivia'))
    const inline = comments.find((c) => c.kind === 'inline')
    assert.deepEqual([inline.path, inline.line, inline.resolved], ['modules/m1.md', 4, null])
    assert.match(inline.url, /pull\/\d+#discussion_r\d+$/)
    assert.equal((await client.getPullRequestComments(created.pullRequestId)).length, 3, 'reading wrote nothing')
  })
})

test('GitHub: getPullRequestComments is empty for a Pull Request nobody commented on, and not found for one that does not exist', async () => {
  await withGitHub(async ({ client, baseUrl }) => {
    const created = await openGitHubPullRequest(client, baseUrl)
    assert.deepEqual(await client.getPullRequestComments(created.pullRequestId), [])
    await assert.rejects(() => client.getPullRequestComments(9999), NotFoundError)
  })
})

// ---------- Azure DevOps ----------

const withAzureDevOps = (fn) =>
  withFakeServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
    const prs = createAzureDevOpsPullRequestsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl })
    await fn({ prs, baseUrl })
  })

test('Azure DevOps: getPullRequestComments reads every thread, resolved ones included, and skips system comments', async () => {
  await withAzureDevOps(async ({ prs, baseUrl }) => {
    const { pullRequestId } = await prs.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'Scope' })
    const threads = `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/threads?api-version=7.1`
    const post = (body) => fetch(threads, { method: 'POST', headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const owner = { displayName: 'The Owner' }
    await post({ comments: [{ parentCommentId: 0, content: 'Please name the owner.', author: owner }], status: 'active' })
    await post({
      comments: [
        { parentCommentId: 0, content: 'This figure has no source.', author: owner },
        { parentCommentId: 1, content: 'Added a source.', author: { displayName: 'Fake Pusher' } },
      ],
      status: 'fixed',
      threadContext: { filePath: '/gantry-workspace/x/modules/m1.md', rightFileStart: { line: 4 } },
    })
    await post({ comments: [{ parentCommentId: 0, content: 'Policy updated the vote.', commentType: 'system' }], status: 'closed' })

    const comments = await prs.getPullRequestComments(pullRequestId)
    assert.deepEqual(
      comments.map((c) => [c.author, c.body, c.resolved]),
      [
        ['The Owner', 'Please name the owner.', false],
        ['The Owner', 'This figure has no source.', true],
        ['Fake Pusher', 'Added a source.', true],
      ]
    )
    assert.deepEqual([comments[1].kind, comments[1].path, comments[1].line, comments[1].threadId], ['inline', '/gantry-workspace/x/modules/m1.md', 4, 2])
    assert.equal(comments[0].kind, 'conversation')
    assert.equal(comments[2].replyTo, 'thread-2-1')
    assert.equal((await prs.getPullRequestComments(pullRequestId)).length, 3, 'reading wrote nothing')
  })
})

test('Azure DevOps: getPullRequestComments is empty for a Pull Request nobody commented on, and not found for one that does not exist', async () => {
  await withAzureDevOps(async ({ prs }) => {
    const { pullRequestId } = await prs.createPullRequest({ sourceBranch: 'hld-stage', targetBranch: 'main', title: 'Scope' })
    assert.deepEqual(await prs.getPullRequestComments(pullRequestId), [])
    await assert.rejects(() => prs.getPullRequestComments(9999), NotFoundError)
  })
})
