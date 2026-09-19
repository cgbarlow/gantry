import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProviderCapabilities,
  registeredProviders,
  resolveContentStore,
  resolvePullRequests,
  resolveWorkItems,
  resolveIdentity,
} from '../lib/providerRegistry.js'
import { AuthenticationError } from '../lib/providerErrors.js'
import { withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withFakeJiraServer, JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'
import { ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { runProviderContractTests, runContentStoreContractTests } from './helpers/providerContractTests.js'

function withFakeAzureDevOpsServer(fn) {
  return withFakeServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, fn)
}

test('registeredProviders lists azure-devops', () => {
  assert.ok(registeredProviders().includes('azure-devops'))
})

test('getProviderCapabilities resolves azure-devops to its four capability factories', () => {
  const capabilities = getProviderCapabilities('azure-devops')
  assert.equal(typeof capabilities.contentStore, 'function')
  assert.equal(typeof capabilities.pullRequests, 'function')
  assert.equal(typeof capabilities.workItems, 'function')
  assert.equal(typeof capabilities.identity, 'function')
})

test('getProviderCapabilities throws a clear error naming the registered providers, for an unregistered provider id', () => {
  assert.throws(() => getProviderCapabilities('nonexistent'), /no provider registered for "nonexistent"/)
  assert.throws(() => getProviderCapabilities('nonexistent'), /azure-devops/)
})

// #11/#10/#14/#20: github joins the registry one capability per ticket as each lands (content
// store, then identity, then work items, then pull requests — scoped to what Promote needs, no
// merge) — registered here the same incremental way this file's own doc comment describes for
// Azure DevOps's own four clients.
test('registeredProviders lists github once its content store is registered', () => {
  assert.ok(registeredProviders().includes('github'))
})

test('getProviderCapabilities resolves github to its content-store, identity, work-items and pull-requests factories', () => {
  const capabilities = getProviderCapabilities('github')
  assert.equal(typeof capabilities.contentStore, 'function')
  assert.equal(typeof capabilities.identity, 'function')
  assert.equal(typeof capabilities.workItems, 'function')
  assert.equal(typeof capabilities.pullRequests, 'function')
})

// #14: resolveWorkItems instantiates GitHub's Issues-backed client through the registry, the same
// seam `lib/workItemLink.js` uses — not the Azure-DevOps-shaped field-map API
// `runProviderContractTests` below exercises (GitHub issues have no typed fields to map), so this is
// asserted directly here rather than folded into that shared suite.
test('resolveWorkItems instantiates github\'s work-items client', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT },
    async (baseUrl) => {
      const workItems = resolveWorkItems('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const created = await workItems.createIssue({ title: 'Registry smoke test', body: '' })
      assert.ok(created.number)
    }
  )
})

test('resolveIdentity instantiates github\'s identity client', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, collaborators: [{ login: 'ana', id: 1 }] },
    async (baseUrl) => {
      const identity = resolveIdentity('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const resolved = await identity.resolveIdentity('ana')
      assert.equal(resolved.uniqueName, 'ana')
      assert.equal(resolved.canAssign, true)
    }
  )
})

test('resolvePullRequests instantiates github\'s pull-requests client and opens a real pull request', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } },
    async (baseUrl) => {
      const contentStore = resolveContentStore('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      await contentStore.createBranch('feature')
      await contentStore.writeFile('/x.md', 'x\n', { branch: 'feature' })

      const pullRequests = resolvePullRequests('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const pr = await pullRequests.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Registry smoke test' })
      assert.equal(typeof pr.pullRequestId, 'number')
      assert.equal(pr.status, 'active')

      const fetched = await pullRequests.getPullRequest(pr.pullRequestId)
      assert.equal(fetched.pullRequestId, pr.pullRequestId)
      assert.deepEqual(fetched.reviews, [])
    }
  )
})

// #26/#28/#30/#33: gitlab joins the registry the same incremental way github did — content store
// (#26), identity (#28), work items (#30) and pull requests (#33), completing ADR-0041's own scope
// list at full parity with GitHub.
test('registeredProviders lists gitlab once its content store is registered', () => {
  assert.ok(registeredProviders().includes('gitlab'))
})

test('getProviderCapabilities resolves gitlab to all four capability factories', () => {
  const capabilities = getProviderCapabilities('gitlab')
  assert.equal(typeof capabilities.contentStore, 'function')
  assert.equal(typeof capabilities.identity, 'function')
  assert.equal(typeof capabilities.workItems, 'function')
  assert.equal(typeof capabilities.pullRequests, 'function')
})

test('resolveContentStore instantiates gitlab\'s content-store client and reads/writes through it', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (baseUrl) => {
    const contentStore = resolveContentStore('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
    assert.equal(await contentStore.repoExists(), true)
    await contentStore.writeFile('/registry-smoke-test.md', 'x\n')
    assert.equal(await contentStore.getFileContent('/registry-smoke-test.md'), 'x\n')
  })
})

// #33: the GitLab twin of the GitHub `resolvePullRequests` smoke test above.
test('resolvePullRequests instantiates gitlab\'s pull-requests client and opens a real merge request', async () => {
  await withFakeGitLabServer(
    { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: { 'README.md': '# repo' } },
    async (baseUrl) => {
      const contentStore = resolveContentStore('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
      await contentStore.createBranch('feature')
      await contentStore.writeFile('/x.md', 'x\n', { branch: 'feature' })

      const pullRequests = resolvePullRequests('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
      const mr = await pullRequests.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Registry smoke test' })
      assert.equal(typeof mr.pullRequestId, 'number')
      assert.equal(mr.status, 'active')

      const fetched = await pullRequests.getPullRequest(mr.pullRequestId)
      assert.equal(fetched.pullRequestId, mr.pullRequestId)
      assert.equal(fetched.approvals.approved, false)
      assert.deepEqual(fetched.discussions, [])
    }
  )
})

test('resolveContentStore\'s gitlab client surfaces a rejected PAT as the neutral AuthenticationError, tagged gitlab', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (baseUrl) => {
    const contentStore = resolveContentStore('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => contentStore.getFileContent('/anything.md'), (err) => {
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'gitlab')
      return true
    })
  })
})

function withFakeGitLabServerForContract(fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, fn)
}

// #29: the content-store slice of the shared contract suite, run against gitlab's registered
// content-store capability — the same "createBranch/branchExists isolation" and "branch created from
// a ref carries that ref's current content" contract `lib/gitlabStageBranch.js`'s
// findGitLabStageBranch/resolveGitLabStageBranch (and #33's re-open path) are themselves built on.
// `runProviderContractTests` (the four-capability suite, shaped around Azure DevOps's own field-typed
// work items) isn't run for gitlab, same as it isn't for github — gitlab's own work-items/pull-requests
// shape is exercised by the dedicated tests around this one instead — so this stays the narrower
// `runContentStoreContractTests` slice (see that function's own doc comment in
// tests/helpers/providerContractTests.js), not a parallel suite.
runContentStoreContractTests('gitlab', {
  providerId: 'gitlab',
  withServer: withFakeGitLabServerForContract,
  buildContentStore: (baseUrl, overrides = {}) =>
    resolveContentStore('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl, ...overrides }),
  badCredential: 'wrong-pat',
})

// #30: gitlab's work-items capability, registered the same way as its content store above.
test('resolveWorkItems instantiates gitlab\'s work-items client and creates/reads an issue through it', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT }, async (baseUrl) => {
    const workItems = resolveWorkItems('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl })
    const created = await workItems.createIssue({ title: 'Registry smoke test', body: '' })
    const fetched = await workItems.getIssue(created.iid)
    assert.equal(fetched.title, 'Registry smoke test')
  })
})

// #42: atlassian's workItems capability (Jira Cloud) joins the registry — the first Atlassian
// capability registered (#40 registered the provider identifier and its two-token credential schema
// only, per its own scope, shipping no capability at all).
test('registeredProviders lists atlassian once its workItems capability is registered', () => {
  assert.ok(registeredProviders().includes('atlassian'))
})

test('getProviderCapabilities resolves atlassian to its workItems factory only, so far', () => {
  const capabilities = getProviderCapabilities('atlassian')
  assert.equal(typeof capabilities.workItems, 'function')
  assert.equal(capabilities.contentStore, undefined)
  assert.equal(capabilities.pullRequests, undefined)
  assert.equal(capabilities.identity, undefined)
})

test('resolveWorkItems instantiates atlassian\'s Jira-backed work-items client and creates/reads an issue through it', async () => {
  await withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT }, async (baseUrl) => {
    const workItems = resolveWorkItems('atlassian', { jiraSite: JIRA_SITE, jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT, baseUrl })
    const created = await workItems.createIssue({ title: 'Registry smoke test', body: '', issueType: 'Task' })
    const fetched = await workItems.getIssue(created.key)
    assert.equal(fetched.title, 'Registry smoke test')
  })
})

test('resolveWorkItems\' atlassian client surfaces a rejected token as the neutral AuthenticationError, tagged atlassian', async () => {
  await withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT }, async (baseUrl) => {
    const workItems = resolveWorkItems('atlassian', { jiraSite: JIRA_SITE, jiraProjectKey: JIRA_PROJECT_KEY, pat: 'wrong-token', baseUrl })
    await assert.rejects(() => workItems.listIssueTypes(), (err) => {
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('resolveContentStore/resolvePullRequests/resolveWorkItems/resolveIdentity instantiate azure-devops\'s existing clients', async () => {
  await withFakeAzureDevOpsServer(async (baseUrl) => {
    const config = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }

    const contentStore = resolveContentStore('azure-devops', config)
    assert.equal(await contentStore.repoExists(), true)

    const workItems = resolveWorkItems('azure-devops', config)
    const workItem = await workItems.createWorkItem('Task', { 'System.Title': 'Registry smoke test' })
    assert.ok(workItem.id)

    const pullRequests = resolvePullRequests('azure-devops', config)
    assert.equal(typeof pullRequests.createPullRequest, 'function')

    const identity = resolveIdentity('azure-devops', config)
    const resolved = await identity.resolveIdentity('Test User')
    assert.ok(resolved)
  })
})

// The contract test suite (#2, docs/adr/0039): the same assertions any
// future provider's four capabilities must satisfy, run here against
// Azure DevOps's registered implementation.
runProviderContractTests('azure-devops', {
  providerId: 'azure-devops',
  withServer: withFakeAzureDevOpsServer,
  buildCapabilities: (baseUrl, overrides = {}) => {
    const config = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl, ...overrides }
    return {
      contentStore: resolveContentStore('azure-devops', config),
      pullRequests: resolvePullRequests('azure-devops', config),
      workItems: resolveWorkItems('azure-devops', config),
      identity: resolveIdentity('azure-devops', config),
    }
  },
  badCredential: 'wrong-pat',
  knownIdentityQuery: 'Test User',
  unknownIdentityQuery: 'Nobody Matches This Query',
})

// #13: github's pull-requests capability gains completePullRequest/getPullRequestCommits (merge with
// a merge commit; read back its commits) — asserted directly here, the same way this file already
// asserts resolveWorkItems/resolveIdentity/resolvePullRequests's own github-specific shape, rather
// than folded into `runProviderContractTests` above: that shared suite's own work-items assertions are
// Azure-DevOps-field-map-shaped (`createWorkItem`/`updateWorkItem`/`getWorkItem`), which GitHub's
// Issues-backed client genuinely doesn't implement (see this file's own comment on
// `resolveWorkItems instantiates github's work-items client` above) — running the full shared suite
// against github would fail on that mismatch, not on anything #13 itself got wrong.
test('resolvePullRequests instantiates github\'s pull-requests client and merges a real pull request', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': '# repo' } },
    async (baseUrl) => {
      const contentStore = resolveContentStore('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      await contentStore.createBranch('feature')
      await contentStore.writeFile('/x.md', 'x\n', { branch: 'feature' })

      const pullRequests = resolvePullRequests('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const pr = await pullRequests.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Registry merge test' })

      const commits = await pullRequests.getPullRequestCommits(pr.pullRequestId)
      assert.ok(Array.isArray(commits))

      const merged = await pullRequests.completePullRequest(pr.pullRequestId, {})
      assert.equal(merged.merged, true)

      const fetched = await pullRequests.getPullRequest(pr.pullRequestId)
      assert.equal(fetched.status, 'completed')
    }
  )
})

test('resolvePullRequests\' github completePullRequest surfaces a branch-protection refusal verbatim, unmerged', async () => {
  await withFakeGitHubServer(
    {
      owner: GITHUB_OWNER,
      repository: GITHUB_REPOSITORY,
      validPat: GITHUB_VALID_PAT,
      files: { 'README.md': '# repo' },
      mergeRefusal: { status: 405, message: 'At least 1 approving review is required by reviewers with write access.' },
    },
    async (baseUrl) => {
      const contentStore = resolveContentStore('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      await contentStore.createBranch('feature')
      await contentStore.writeFile('/x.md', 'x\n', { branch: 'feature' })

      const pullRequests = resolvePullRequests('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const pr = await pullRequests.createPullRequest({ sourceBranch: 'feature', targetBranch: 'main', title: 'Refused merge test' })

      await assert.rejects(() => pullRequests.completePullRequest(pr.pullRequestId, {}), (err) => {
        assert.ok(JSON.parse(err.body).message.includes('approving review'))
        return true
      })

      const fetched = await pullRequests.getPullRequest(pr.pullRequestId)
      assert.equal(fetched.status, 'active')
    }
  )
})
