import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError, NotFoundError } from '../../lib/providerErrors.js'

/**
 * A contract test suite any provider's four capability interfaces must
 * satisfy (#2 — docs/adr/0039's capability split, carried into the
 * registry's own seam per #1's Testing Decisions: "a single contract test
 * suite that both implementations must satisfy, run against each capability
 * interface. Testing the registry rather than each client means a third
 * provider inherits the suite instead of needing a parallel one."). Every
 * assertion drives a capability object the same way a real caller would —
 * never a specific client's internals — and runs over real `fetch` against a
 * real in-process fake server, per the shared Testing Decisions.
 *
 * `label` prefixes every test name (e.g. 'azure-devops') so a failure is
 * attributable to the provider whose run produced it when this suite is
 * called more than once (one call per registered provider) in the same test
 * run.
 *
 * `providerId` is the registered provider identifier this run exercises —
 * asserted against every neutral error's `.provider` tag.
 *
 * `withServer(fn)` starts that provider's fake server for the duration of
 * `fn(baseUrl)`, mirroring `tests/helpers/fakeAzureDevOpsServer.js`'s own
 * `withFakeAzureDevOpsServer` shape — a fresh server per test, never shared
 * state leaking between assertions.
 *
 * `buildCapabilities(baseUrl, overrides?)` resolves this provider's four
 * capabilities (via lib/providerRegistry.js) against the running fake
 * server, merging `overrides` into the connection config first — used by the
 * authentication-error test to swap in a rejected credential without this
 * suite needing to know the provider's own config shape
 * (organization/project/repository vs. owner/repository).
 *
 * `badCredential` is a value that provider's fake server rejects.
 *
 * `knownIdentityQuery` / `unknownIdentityQuery` are search strings the fake
 * server is seeded to resolve / not resolve, for the identity contract test.
 */
export function runProviderContractTests(
  label,
  { providerId, withServer, buildCapabilities, badCredential, knownIdentityQuery = 'Test User', unknownIdentityQuery = 'Nobody Matches This Query' }
) {
  test(`[${label}] content store: write then read a file back unchanged`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore } = buildCapabilities(baseUrl)
      await contentStore.writeFile('/contract-test.md', 'contract content\n')
      const content = await contentStore.getFileContent('/contract-test.md')
      assert.equal(content, 'contract content\n')
    })
  })

  test(`[${label}] content store: fileExists is true after write, false for an unwritten path`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore } = buildCapabilities(baseUrl)
      await contentStore.writeFile('/exists.md', 'x\n')
      assert.equal(await contentStore.fileExists('/exists.md'), true)
      assert.equal(await contentStore.fileExists('/does-not-exist.md'), false)
    })
  })

  test(`[${label}] content store: getFileContent on a missing path throws the neutral NotFoundError`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore } = buildCapabilities(baseUrl)
      await assert.rejects(() => contentStore.getFileContent('/missing.md'), (err) => {
        assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${err.name}`)
        assert.equal(err.provider, providerId)
        return true
      })
    })
  })

  test(`[${label}] content store: createBranch then branchExists is true, and a branch-only write never leaks into main`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore } = buildCapabilities(baseUrl)
      await contentStore.writeFile('/main-only.md', 'main\n')
      assert.equal(await contentStore.branchExists('contract-branch'), false)
      await contentStore.createBranch('contract-branch')
      assert.equal(await contentStore.branchExists('contract-branch'), true)
      await contentStore.writeFile('/branch-only.md', 'branch\n', { branch: 'contract-branch' })
      assert.equal(await contentStore.fileExists('/branch-only.md', 'main'), false)
      assert.equal(await contentStore.fileExists('/branch-only.md', 'contract-branch'), true)
    })
  })

  test(`[${label}] content store: repoExists is true for a real repo`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore } = buildCapabilities(baseUrl)
      assert.equal(await contentStore.repoExists(), true)
    })
  })

  test(`[${label}] content store: a rejected credential surfaces as the neutral AuthenticationError, tagged with this provider`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore } = buildCapabilities(baseUrl, { pat: badCredential })
      await assert.rejects(() => contentStore.getFileContent('/anything.md'), (err) => {
        assert.ok(err instanceof AuthenticationError, `expected AuthenticationError, got ${err.name}`)
        assert.equal(err.provider, providerId)
        return true
      })
    })
  })

  test(`[${label}] pull requests: open, read back and merge`, async () => {
    await withServer(async (baseUrl) => {
      const { contentStore, pullRequests } = buildCapabilities(baseUrl)
      await contentStore.writeFile('/pr-source.md', 'v1\n')
      await contentStore.createBranch('contract-pr-branch')
      await contentStore.writeFile('/pr-source.md', 'v2\n', { branch: 'contract-pr-branch' })

      const created = await pullRequests.createPullRequest({
        sourceBranch: 'contract-pr-branch',
        targetBranch: 'main',
        title: 'Contract test PR',
      })
      const id = created.pullRequestId ?? created.id
      assert.ok(id !== undefined && id !== null)

      const fetched = await pullRequests.getPullRequest(id)
      assert.ok(fetched)

      const completed = await pullRequests.completePullRequest(id, {})
      assert.ok(completed)
    })
  })

  test(`[${label}] work items: create, update and read back`, async () => {
    await withServer(async (baseUrl) => {
      const { workItems } = buildCapabilities(baseUrl)
      const created = await workItems.createWorkItem('Task', { 'System.Title': 'Contract test work item' })
      assert.ok(created.id)

      const updated = await workItems.updateWorkItem(created.id, { 'System.Title': 'Updated title' })
      assert.equal(updated.fields['System.Title'], 'Updated title')

      const fetched = await workItems.getWorkItem(created.id)
      assert.equal(fetched.fields['System.Title'], 'Updated title')
    })
  })

  test(`[${label}] work items: a child work item links to its parent`, async () => {
    await withServer(async (baseUrl) => {
      const { workItems } = buildCapabilities(baseUrl)
      const parent = await workItems.createWorkItem('Task', { 'System.Title': 'Parent' })
      const child = await workItems.createChildWorkItem(parent.id, 'Task', { 'System.Title': 'Child' })
      assert.ok(child.relations?.some((r) => r.url?.endsWith(`/${parent.id}`)))
    })
  })

  test(`[${label}] identity: resolves a known person, and returns null for one nobody matches`, async () => {
    await withServer(async (baseUrl) => {
      const { identity } = buildCapabilities(baseUrl)
      const known = await identity.resolveIdentity(knownIdentityQuery)
      assert.ok(known, `expected "${knownIdentityQuery}" to resolve to a person`)

      const unknown = await identity.resolveIdentity(unknownIdentityQuery)
      assert.equal(unknown, null)
    })
  })
}
