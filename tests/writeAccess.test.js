import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkWriteAccess } from '../lib/writeAccess.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { AuthenticationError } from '../lib/providerErrors.js'

// #126 (parent #109, docs/adr/0047): "whether someone can write is established by an explicit check
// ... not inferred from the mere presence of a token". These tests prove `checkWriteAccess` genuinely
// asks the Provider (a push-capable PAT reports true, a read-only one reports false), for all three
// providers `lib/server.js`'s `WITH_PROVIDER_CREDENTIAL` covers, and that a rejected PAT still throws
// (so the server-side route can tell "rejected" apart from "confirmed read-only" — see
// tests/serverWriteAccess.test.js for that split at the route level).

test('checkWriteAccess (github): a PAT with push access reports true, a read-only one reports false', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, viewerPermissions: { admin: false, maintain: false, push: true, triage: true, pull: true } },
    async (providerBaseUrl) => {
      const canWrite = await checkWriteAccess('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITHUB_VALID_PAT })
      assert.equal(canWrite, true)
    }
  )

  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, viewerPermissions: { admin: false, maintain: false, push: false, triage: false, pull: true } },
    async (providerBaseUrl) => {
      const canWrite = await checkWriteAccess('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITHUB_VALID_PAT })
      assert.equal(canWrite, false)
    }
  )
})

test('checkWriteAccess (github): a rejected PAT throws AuthenticationError, not "false"', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (providerBaseUrl) => {
    await assert.rejects(
      () => checkWriteAccess('github', { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl, pat: 'wrong-pat' }),
      (err) => err instanceof AuthenticationError
    )
  })
})

test('checkWriteAccess (gitlab): Developer access (30) and above reports true; Reporter (20) reports false', async () => {
  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, viewerAccessLevel: 30 }, async (providerBaseUrl) => {
    const canWrite = await checkWriteAccess('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT })
    assert.equal(canWrite, true)
  })

  await withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, viewerAccessLevel: 20 }, async (providerBaseUrl) => {
    const canWrite = await checkWriteAccess('gitlab', { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl, pat: GITLAB_VALID_PAT })
    assert.equal(canWrite, false)
  })
})

test('checkWriteAccess (azure-devops): GenericContribute true/false round-trips through the fake Permissions endpoint', async () => {
  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, canWrite: true }, async (providerBaseUrl) => {
    const canWrite = await checkWriteAccess('azure-devops', { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: providerBaseUrl, pat: VALID_PAT })
    assert.equal(canWrite, true)
  })

  await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, canWrite: false }, async (providerBaseUrl) => {
    const canWrite = await checkWriteAccess('azure-devops', { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: providerBaseUrl, pat: VALID_PAT })
    assert.equal(canWrite, false)
  })
})

test('checkWriteAccess: throws for an unsupported provider rather than silently reporting false', async () => {
  await assert.rejects(() => checkWriteAccess('bitbucket', {}), /unsupported provider/)
})
