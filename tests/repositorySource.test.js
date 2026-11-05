import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { createRepositoryReader } from '../lib/repositorySource.js'
import { describeOutOfDate } from '../lib/outOfDateServer.js'
import { resolveContentStore } from '../lib/providerRegistry.js'
import { RateLimitError, rateLimitFrom } from '../lib/providerErrors.js'
import { createFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { createFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createFakeBitbucketServer } from './helpers/fakeBitbucketServer.js'
import { createFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { basicAuthHeader, withRunningServer, withRunningServerForProvider, withScratchInstances } from './helpers/lifecycle.js'

// #319 (docs/adr/0072): a code repository is a Source document read live through a pointer. The Gantry server reads it through the Provider
// clients it already has, with the caller's own token (or none, for a public repository): it lists, searches and reads at the branch head,
// skips vendored code, build output and binaries, names the commit of every read, and compares the files a Field drew on with the head.

const TOKEN = 'architects-own-token'
// A small code base, with the things that are always skipped beside the code.
const CODE = {
  'README.md': '# Billing API\n\nTakes payments for orders.\n',
  'src/orders/service.ts': 'export class OrderService {\n  // Orders are settled nightly.\n  settle() {}\n}\n',
  'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 5000\n',
  'infra/main.tf': 'resource "azurerm_app_service" "billing" {}\n',
  'node_modules/left-pad/index.js': 'module.exports = function OrderService() {}\n',
  'dist/app.js': 'class OrderService {}\n',
  'docs/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
  'tools/blob.dat2': Buffer.from([1, 2, 0, 3]),
}

// Starts a fake Provider server for one test and closes it after. `apiRoot` is where the fake's API sits (Bitbucket's `/2.0`, GitLab's `/api/v4`).
async function withFake(server, fn, apiRoot = '') {
  server.keepAliveTimeout = 0
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}${apiRoot}`)
  } finally {
    server.close()
    // #336: a stand-in Provider that never answered still holds its connections open.
    server.closeAllConnections()
  }
}

const github = (baseUrl, extra = {}) => ({ provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl }, branch: 'main', ...extra })

// A commit on the code repository's main branch, made the way any of its developers would.
const commit = (provider, location, files, pat = TOKEN) => resolveContentStore(provider, { ...location, pat }).writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })), { branch: 'main', message: 'A developer changes the code' })

describe('reading a repository through the Provider clients', () => {
  test('a private GitHub repository is read with the architect\'s token, and without access the message says so plainly', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const checked = await createRepositoryReader({ provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl } }, TOKEN, { allowBaseUrl: true }).check()
      assert.equal(checked.branch, 'main', 'no branch given: the default branch')
      assert.match(checked.commit, /\S/)

      await assert.rejects(createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true }).check(), (err) => {
        assert.equal(err.code, 'no-access')
        assert.equal(err.message, "You can't read the GitHub repository acme/billing-api without a token. If it is private, give a token that can read it.")
        return true
      })
      await assert.rejects(createRepositoryReader(github(baseUrl), 'someone-elses', { allowBaseUrl: true }).check(), /You can't read the GitHub repository acme\/billing-api with the token you gave\. Check that it exists and that your token can read it\.$/)
      await assert.rejects(createRepositoryReader(github(baseUrl, { branch: 'nope' }), TOKEN, { allowBaseUrl: true }).check(), /has no branch "nope"/)
    }))

  test('a public repository is read with no token at all', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, anonymousRead: true }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true })
      assert.equal((await reader.check()).branch, 'main')
      assert.equal((await reader.read({ path: 'src/orders/limits.ts' })).text, 'export const MAX_ORDER_NZD = 5000\n')
    }))

  // #325: GitHub lets a server read only 60 times an hour without a token, so a public repository must spend little of that, and running
  // out must say so rather than claim the repository can't be read.
  test('a public GitHub repository read with no token takes its files from the raw-file address, and a search lists the repository once', () => {
    const apiLog = []
    const contentLog = []
    return withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, anonymousRead: true, apiLog, contentLog }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true, rawBaseUrl: `${baseUrl}/raw` })
      const read = await reader.read({ path: 'src/orders/limits.ts' })
      assert.equal(read.text, 'export const MAX_ORDER_NZD = 5000\n')
      assert.equal(read.citationQuery, `?path=src/orders/limits.ts&commit=${read.commit}`)
      assert.ok(!apiLog.some((line) => line.includes('/contents/')), 'the file never comes through the API')

      apiLog.length = 0
      const found = await reader.search({ query: 'orderservice' })
      assert.deepEqual(found.matches, [{ path: 'src/orders/service.ts', line: 1, text: 'export class OrderService {' }], 'node_modules and dist are still not searched')
      assert.deepEqual((await reader.search({ query: 'limits' })).matches, [{ path: 'src/orders/limits.ts' }], 'a file name still matches')
      assert.equal(apiLog.filter((line) => line.includes('/git/trees/')).length, 2, 'one listing of the whole repository per search')
      assert.ok(!apiLog.some((line) => line.includes('/contents')), 'no folder is listed and no file is read through the API')
      assert.ok(contentLog.every((entry) => entry.via === 'raw-host'))
      await assert.rejects(reader.read({ path: 'src/orders/missing.ts' }), /There is no file src\/orders\/missing\.ts/)
    })
  })

  test('a search narrowed to folders, or to a path, searches only there when it lists the whole repository at once', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const narrowed = createRepositoryReader(github(baseUrl, { folders: ['src/orders'] }), TOKEN, { allowBaseUrl: true })
      assert.deepEqual((await narrowed.search({ query: 'resource' })).matches, [], 'infra/ is outside the pointer')
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true })
      assert.deepEqual((await reader.search({ query: 'resource', path: 'src' })).matches, [], 'infra/ is outside the path searched')
      assert.deepEqual((await reader.search({ query: 'resource', path: 'infra' })).matches.map((m) => m.path), ['infra/main.tf'])
    }))

  test('a used-up rate limit says so, with when it resets, and is never "you can\'t read it"', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, anonymousRead: true, apiRequestLimit: 2 }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true })
      await reader.check()
      await assert.rejects(reader.list(), (err) => {
        assert.equal(err.code, 'rate-limited')
        assert.equal(err.status, 429)
        assert.equal(
          err.message,
          'GitHub limits how much this Gantry server can read without a token, and that limit is used up until 08:00 UTC. acme/billing-api is fine; a token raises the limit (for a public repository any GitHub token will do), or try again then.'
        )
        return true
      })
      await assert.rejects(createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true }).check(), /GitHub's limit on reads with your token is used up until 08:00 UTC/)
    }))

  test('every Provider\'s rate-limit answer is told apart from a rejected token', () => {
    const answer = (status, headers = {}) => ({ status, headers: new Headers(headers) })
    const github403 = rateLimitFrom(answer(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }), 'github')
    assert.ok(github403 instanceof RateLimitError)
    assert.equal(github403.resetAt.toISOString(), '2027-01-15T08:00:00.000Z')
    assert.ok(rateLimitFrom(answer(403, { 'retry-after': '60' }), 'github'), "GitHub's secondary limit")
    assert.ok(rateLimitFrom(answer(429, { 'ratelimit-reset': '1800000000' }), 'gitlab').resetAt instanceof Date, "GitLab's 429")
    assert.equal(rateLimitFrom(answer(429), 'atlassian').resetAt, null, 'a 429 with no reset time')
    assert.equal(rateLimitFrom(answer(403), 'github'), null, 'a plain 403 is a rejected token')
    assert.equal(rateLimitFrom(answer(403, { 'x-ratelimit-remaining': '12' }), 'github'), null, 'requests left: a rejected token')
    assert.equal(rateLimitFrom(answer(401), 'azure-devops'), null)
  })

  test('a self-hosted address is taken only where this server takes one for a workspace', () => {
    assert.throws(() => createRepositoryReader(github('https://ghe.internal/api/v3'), TOKEN, { allowBaseUrl: false }), /doesn't take a self-hosted GitHub address/)
  })

  test('lists, reads and searches at the branch head, naming the commit, and never touches vendored code, build output or binaries', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true })
      const head = await reader.head()
      const top = await reader.list()
      assert.equal(top.commit, head)
      assert.deepEqual(top.entries.map((e) => e.path), ['docs', 'infra', 'src', 'tools', 'README.md'])
      assert.deepEqual((await reader.list({ path: 'docs' })).entries, [], 'a picture is never listed')

      const read = await reader.read({ path: 'src/orders/service.ts' })
      assert.equal(read.commit, head)
      assert.match(read.text, /settled nightly/)
      assert.equal(read.citationQuery, `?path=src/orders/service.ts&commit=${head}`)
      await assert.rejects(reader.read({ path: 'node_modules/left-pad/index.js' }), /vendored code or build output, which Gantry never reads/)
      await assert.rejects(reader.read({ path: 'docs/logo.png' }), /a binary file, which Gantry never reads/)
      await assert.rejects(reader.read({ path: 'tools/blob.dat2' }), /is a binary file/, 'a binary is caught by its bytes too')
      await assert.rejects(reader.read({ path: '../etc/passwd' }), /not a path inside the repository/)
      await assert.rejects(reader.read({ path: 'src/orders/missing.ts' }), /There is no file src\/orders\/missing\.ts/)

      const found = await reader.search({ query: 'orderservice' })
      assert.deepEqual(found.matches, [{ path: 'src/orders/service.ts', line: 1, text: 'export class OrderService {' }], 'node_modules and dist are not searched')
      assert.equal(found.commit, head)
      assert.deepEqual((await reader.search({ query: 'limits' })).matches, [{ path: 'src/orders/limits.ts' }], 'a file name matches too')
    }))

  test('a pointer narrowed to folders reads only inside them', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl, { folders: ['src/orders'] }), TOKEN, { allowBaseUrl: true })
      assert.deepEqual((await reader.list()).entries.map((e) => e.path), ['src'])
      assert.deepEqual((await reader.list({ path: 'src' })).entries.map((e) => e.path), ['src/orders'])
      await assert.rejects(reader.read({ path: 'README.md' }), /outside the folders this Source document is narrowed to \(src\/orders\)/)
      assert.deepEqual((await reader.search({ query: 'resource' })).matches, [], 'infra/ is outside the pointer')
    }))

  test('Out of date: a commit that changes file A is a change for A only; one that changes only B changes nothing for A', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const location = { owner: 'acme', repository: 'billing-api', baseUrl }
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true })
      const seen = (await reader.read({ path: 'src/orders/limits.ts' })).commit
      const reads = [{ path: 'src/orders/limits.ts', commit: seen }, { path: 'README.md', commit: seen }]
      assert.deepEqual((await reader.compare({ reads })).results.map((r) => r.changed), [false, false])

      await commit('github', location, { 'README.md': '# Billing API\n\nNow with refunds.\n' })
      const afterB = await reader.compare({ reads: [reads[0]] })
      assert.notEqual(afterB.head, seen)
      assert.deepEqual(afterB.results, [{ path: 'src/orders/limits.ts', commit: seen, changed: false, deleted: false }])

      await commit('github', location, { 'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 8000\n' })
      assert.deepEqual((await reader.compare({ reads: [reads[0]] })).results, [{ path: 'src/orders/limits.ts', commit: seen, changed: true, deleted: false }])
    }))

  test('Azure DevOps: a private repository with a token, a public one without, and reads at a recorded commit', () =>
    withFake(createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE, anonymousRead: true }), async (baseUrl) => {
      const repository = { provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl } }
      const withToken = createRepositoryReader(repository, TOKEN, { allowBaseUrl: true })
      assert.equal((await withToken.check()).branch, 'main', 'its default branch, from refs/heads/main')
      const anonymous = createRepositoryReader({ ...repository, branch: 'main' }, null, { allowBaseUrl: true })
      const read = await anonymous.read({ path: 'src/orders/limits.ts' })
      assert.equal(read.text, 'export const MAX_ORDER_NZD = 5000\n')
      assert.deepEqual((await anonymous.list({ path: 'src' })).entries.map((e) => e.path), ['src/orders'])

      await commit('azure-devops', repository.location, { 'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 9000\n' })
      const atCommit = await anonymous.read({ path: 'src/orders/limits.ts', commit: read.commit })
      assert.equal(atCommit.text, 'export const MAX_ORDER_NZD = 5000\n', 'read as it was at the recorded commit')
      assert.deepEqual((await anonymous.compare({ reads: [{ path: 'src/orders/limits.ts', commit: read.commit }, { path: 'README.md', commit: read.commit }] })).results.map((r) => [r.path, r.changed]), [
        ['src/orders/limits.ts', true],
        ['README.md', false],
      ])
    }))

  test('Azure DevOps refuses a private repository to someone without access, with the same plain message', () =>
    withFake(createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const repository = { provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl } }
      await assert.rejects(createRepositoryReader(repository, null, { allowBaseUrl: true }).check(), /You can't read the Azure DevOps repository contoso\/Payments\/billing without a token\./)
    }))

  test('Bitbucket: checked, read and compared at a recorded commit', () =>
    withFake(createFakeBitbucketServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const reader = createRepositoryReader({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' } }, TOKEN, { clientBaseUrl: baseUrl })
      const checked = await reader.check()
      assert.equal(checked.branch, 'main')
      const pointed = createRepositoryReader({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }, TOKEN, { clientBaseUrl: baseUrl })
      const read = await pointed.read({ path: 'README.md' })
      assert.equal(read.commit, checked.commit)
      await commit('atlassian', { owner: 'acme', repository: 'billing-api', baseUrl }, { 'README.md': '# Billing API v2\n' })
      assert.equal((await pointed.read({ path: 'README.md', commit: read.commit })).text, CODE['README.md'])
      assert.deepEqual((await pointed.compare({ reads: [{ path: 'README.md', commit: read.commit }, { path: 'infra/main.tf', commit: read.commit }] })).results.map((r) => r.changed), [true, false])
      await assert.rejects(createRepositoryReader({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' } }, 'wrong', { clientBaseUrl: baseUrl }).check(), /You can't read the Bitbucket repository acme\/billing-api with the token you gave/)
    }, '/2.0'))

  test('GitLab: checked, listed and read', () =>
    withFake(createFakeGitLabServer({ namespace: 'acme/payments', repository: 'billing-api', validPat: TOKEN, files: CODE }), async (baseUrl) => {
      const reader = createRepositoryReader({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api', baseUrl }, branch: 'main' }, TOKEN, { allowBaseUrl: true })
      assert.equal((await reader.check()).branch, 'main')
      assert.deepEqual((await reader.list({ path: 'src/orders' })).entries.map((e) => e.path), ['src/orders/limits.ts', 'src/orders/service.ts'])
      assert.match((await reader.read({ path: 'infra/main.tf' })).text, /azurerm_app_service/)
    }, '/api/v4'))
})

describe('POST /api/sources/repository and adding a pointer to an Instance', () => {
  const SLUG = 'my-initiative'

  test('on a server workspace: the architect\'s token is sent as when connecting a workspace, and only the manifest entry is written', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), (codeBase) =>
      withScratchInstances(async (instancesDir) => {
        createInstance('design', SLUG, { instancesDir })
        await withRunningServer({ slug: SLUG, instancesDir, allowGitHubBaseUrlOverride: true }, async (base) => {
          const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl: codeBase } }
          const ask = (body, token) => fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: basicAuthHeader(token) } : {}) }, body: JSON.stringify(body) })

          const refused = await ask({ action: 'check', repository })
          assert.equal(refused.status, 403)
          assert.deepEqual(await refused.json(), { error: "You can't read the GitHub repository acme/billing-api without a token. If it is private, give a token that can read it.", code: 'no-access' })

          const checked = await (await ask({ action: 'check', repository }, TOKEN)).json()
          assert.equal(checked.branch, 'main')
          const added = await fetch(`${base}/api/instance/sources?slug=${SLUG}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: { ...repository, branch: checked.branch, folders: ['src'] }, uploadedBy: 'a.architect' }) })
          assert.equal(added.status, 201, await added.clone().text())
          const { entry } = await added.json()
          assert.equal(entry.id, 'billing-api')
          assert.deepEqual(entry.repository, { provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl: codeBase }, branch: 'main', folders: ['src'] })
          assert.equal(entry.filename, undefined)

          const folder = join(instancesDir, 'default', SLUG, 'sources')
          assert.deepEqual(readdirSync(folder), ['manifest.yaml'], 'nothing from the repository is stored')
          assert.match(readFileSync(join(folder, 'manifest.yaml'), 'utf8'), /repository:\n\s+provider: github/)

          const listed = await (await fetch(`${base}/api/instance/sources?slug=${SLUG}`)).json()
          assert.deepEqual(listed.entries.map((e) => e.id), ['billing-api'])
          const renamed = await fetch(`${base}/api/instance/sources/billing-api?slug=${SLUG}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Billing service' }) })
          assert.equal((await renamed.json()).entry.title, 'Billing service')
          const content = await fetch(`${base}/api/instance/sources/billing-api/content?slug=${SLUG}`)
          assert.equal(content.status, 400)
          assert.match((await content.json()).error, /is a code repository, read live from its Provider/)
          const removed = await fetch(`${base}/api/instance/sources/billing-api?slug=${SLUG}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removedBy: 'a.architect' }) })
          assert.ok((await removed.json()).entry.removedAt)
          assert.deepEqual(readdirSync(folder), ['manifest.yaml'])

          const read = await (await ask({ action: 'read', repository: { ...repository, branch: 'main' }, path: 'src/orders/limits.ts' }, TOKEN)).json()
          assert.equal(read.text, CODE['src/orders/limits.ts'])
          assert.equal(existsSync(join(folder, '.text')), false)
        })
      })
    ))

  // AC1 on every Provider, not only GitHub: a private Azure DevOps repository with the architect's token and a public one with none, a
  // private GitLab one and a private Bitbucket one. Each is checked through the route, added, listed, renamed and removed, and the
  // Instance's sources folder never holds more than its manifest.
  const providerCases = [
    {
      name: 'Azure DevOps (private, with a token)',
      fake: () => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE }),
      repository: (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl } }),
      options: { allowAzureDevOpsBaseUrlOverride: true },
      token: TOKEN,
      refusal: /^You can't read the Azure DevOps repository contoso\/Payments\/billing without a token\./,
      id: 'billing',
    },
    {
      name: 'Azure DevOps (public, with no token)',
      fake: () => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'open-billing', validPat: 'nobody', files: CODE, anonymousRead: true }),
      repository: (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'open-billing', baseUrl } }),
      options: { allowAzureDevOpsBaseUrlOverride: true },
      token: null,
      id: 'open-billing',
    },
    {
      name: 'GitLab (private, with a token)',
      fake: () => createFakeGitLabServer({ namespace: 'acme/payments', repository: 'billing-api', validPat: TOKEN, files: CODE }),
      apiRoot: '/api/v4',
      repository: (baseUrl) => ({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api', baseUrl } }),
      options: { allowGitLabBaseUrlOverride: true },
      token: TOKEN,
      refusal: /^You can't read the GitLab repository acme\/payments\/billing-api without a token\./,
      id: 'billing-api',
    },
    {
      name: 'Bitbucket (private, with a token)',
      fake: () => createFakeBitbucketServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }),
      apiRoot: '/2.0',
      repository: () => ({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' } }),
      options: (baseUrl) => ({ atlassianBitbucketBaseUrl: baseUrl }),
      token: TOKEN,
      refusal: /^You can't read the Bitbucket repository acme\/billing-api without a token\./,
      id: 'billing-api',
    },
  ]
  for (const c of providerCases) {
    test(`on a server workspace, ${c.name}: checked, added, listed, renamed and removed, with only the manifest written`, () =>
      withFake(c.fake(), (codeBase) =>
        withScratchInstances(async (instancesDir) => {
          createInstance('design', SLUG, { instancesDir })
          const options = typeof c.options === 'function' ? c.options(codeBase) : c.options
          await withRunningServer({ slug: SLUG, instancesDir, ...options }, async (base) => {
            const repository = c.repository(codeBase)
            const ask = (body, token) => fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: basicAuthHeader(token) } : {}) }, body: JSON.stringify(body) })
            const sources = (method, path = '', body) => fetch(`${base}/api/instance/sources${path}?slug=${SLUG}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

            if (c.refusal) {
              const refused = await ask({ action: 'check', repository })
              assert.equal(refused.status, 403)
              const body = await refused.json()
              assert.equal(body.code, 'no-access')
              assert.match(body.error, c.refusal, 'a plain sentence, never a raw Provider error')
            }
            const checkedRes = await ask({ action: 'check', repository }, c.token)
            assert.equal(checkedRes.status, 200, await checkedRes.clone().text())
            const checked = await checkedRes.json()
            assert.equal(checked.branch, 'main')
            assert.match(checked.commit, /^\S{7,}$/)

            const added = await sources('POST', '', { repository: { ...repository, branch: checked.branch }, uploadedBy: 'a.architect' })
            assert.equal(added.status, 201, await added.clone().text())
            const { entry } = await added.json()
            assert.equal(entry.id, c.id)
            assert.deepEqual(entry.repository, { ...repository, branch: 'main' })
            const folder = join(instancesDir, 'default', SLUG, 'sources')
            assert.deepEqual(readdirSync(folder), ['manifest.yaml'], 'nothing from the repository is stored')

            // Read through the route with the same token, at the pointer's branch, naming its commit.
            const read = await (await ask({ action: 'read', repository: entry.repository, path: 'src/orders/limits.ts' }, c.token)).json()
            assert.equal(read.text, CODE['src/orders/limits.ts'])
            assert.equal(read.commit, checked.commit)

            assert.deepEqual((await (await sources('GET')).json()).entries.map((e) => [e.id, e.repository?.provider]), [[c.id, repository.provider]])
            const renamed = await sources('PATCH', `/${c.id}`, { title: 'Billing service' })
            assert.equal((await renamed.json()).entry.title, 'Billing service')
            assert.equal((await (await sources('GET')).json()).entries[0].title, 'Billing service')
            const removed = await sources('DELETE', `/${c.id}`, { removedBy: 'a.architect' })
            const gone = (await removed.json()).entry
            assert.ok(gone.removedAt)
            assert.deepEqual(gone.repository, { ...repository, branch: 'main' }, 'a removed pointer still names its repository')
            assert.deepEqual(readdirSync(folder), ['manifest.yaml'], 'still only the manifest')
          })
        }),
      c.apiRoot ?? ''))
  }

  test('a self-hosted address this server does not take for a workspace is refused for a pointer too', () =>
    withRunningServer({}, async (base) => {
      const res = await fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check', repository: github('http://127.0.0.1:1') }) })
      assert.equal(res.status, 400)
      assert.equal((await res.json()).code, 'base-url-not-allowed')
    }))

  for (const provider of ['github', 'azure-devops']) {
    test(`on a ${provider} workspace: adding a pointer is one commit of the manifest alone, and Out of date compares with the workspace's credential`, () =>
      withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: 'workspace-pat', files: CODE }), (codeBase) =>
        withScratchInstances((instancesDir) =>
          withRunningServerForProvider(provider, { options: { instancesDir, allowGitHubBaseUrlOverride: true, ...(provider === 'azure-devops' ? { allowAzureDevOpsBaseUrlOverride: true } : {}) }, fakeServerOptions: { validPat: ['workspace-pat'] } }, async (ctx) => {
            const auth = { Authorization: basicAuthHeader('workspace-pat') }
            const api = (method, path, body) => fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=acme`, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body === undefined ? undefined : JSON.stringify(body) })
            const location = provider === 'github' ? { github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } } : { azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }
            const created = await fetch(`${ctx.gantryBase}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ definition: 'design', slug: 'acme', ...location }) })
            assert.equal(created.status, 201, await created.clone().text())

            const code = { provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl: codeBase }, branch: 'main' }
            const added = await api('POST', '/api/instance/sources', { repository: code })
            assert.equal(added.status, 201, await added.clone().text())
            const instance = await (await api('GET', '/api/instance')).json()
            const workspace = resolveContentStore(provider, { ...(location.github ?? location.azureDevOps), pat: 'workspace-pat' })
            const files = (await workspace.listFolder('gantry-workspace/acme/sources', { branch: `gantry-workspace/acme/${instance.stage.id}` })).map((f) => f.path.replace(/^\//, ''))
            assert.deepEqual(files, ['gantry-workspace/acme/sources/manifest.yaml'], 'only the manifest: nothing from the repository')

            // A Field cites a file of the repository at the commit it was read at.
            const moduleId = instance.modules[0].id
            const fieldId = instance.modules[0].fields[0].id
            const reader = createRepositoryReader(code, 'workspace-pat', { allowBaseUrl: true })
            const seen = await reader.read({ path: 'src/orders/limits.ts' })
            const saved = await api('PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [fieldId]: `Orders are capped at NZD 5,000 ([Billing API, limits](source:billing-api${seen.citationQuery})).` } } } })
            assert.equal(saved.status, 200, await saved.clone().text())
            assert.deepEqual((await (await api('GET', '/api/instance/out-of-date')).json()).fields, [])

            await commit('github', code.location, { 'README.md': 'Only the README changes.\n' }, 'workspace-pat')
            assert.deepEqual((await (await api('GET', '/api/instance/out-of-date')).json()).fields, [], 'a commit that touches nothing the Field used flags nothing')

            await commit('github', code.location, { 'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 8000\n' }, 'workspace-pat')
            const flagged = await (await api('GET', '/api/instance/out-of-date')).json()
            assert.deepEqual(flagged.fields.map((f) => [f.field, f.flags[0].change, f.flags[0].paths]), [[`${moduleId}.${fieldId}`, 'code-changed', ['src/orders/limits.ts']]])
            assert.match(flagged.fields[0].note, /^Out of date: src\/orders\/limits\.ts in billing-api changed \(now at \S{7}\)$/)

            // Renamed and removed like any Source document, each a change of the manifest alone on the Stage's branch.
            const renamed = await api('PATCH', '/api/instance/sources/billing-api', { title: 'Billing API' })
            assert.equal(renamed.status, 200, await renamed.clone().text())
            assert.equal((await renamed.json()).entry.title, 'Billing API')
            const listed = await (await api('GET', '/api/instance/sources')).json()
            assert.deepEqual(listed.entries.map((e) => [e.id, e.title, e.repository?.branch]), [['billing-api', 'Billing API', 'main']])
            const removed = await api('DELETE', '/api/instance/sources/billing-api', { removedBy: 'a.architect' })
            assert.equal(removed.status, 200, await removed.clone().text())
            assert.ok((await removed.json()).entry.removedAt)
            const after = (await workspace.listFolder('gantry-workspace/acme/sources', { branch: `gantry-workspace/acme/${instance.stage.id}` })).map((f) => f.path.replace(/^\//, ''))
            assert.deepEqual(after, ['gantry-workspace/acme/sources/manifest.yaml'], 'still only the manifest: the repository itself is untouched')
            const manifest = await workspace.getFileContent('gantry-workspace/acme/sources/manifest.yaml', { branch: `gantry-workspace/acme/${instance.stage.id}` })
            for (const part of [/title: Billing API/, /removedAt: /, /removedBy: a\.architect/, /repository:\n\s+provider: github/]) assert.match(manifest, part, 'the removed pointer keeps its name and what it pointed at')
          })
        )
      ))
  }
})

// #335: a search finishes in good time however big the repository and however slow the link to the Provider. It reads several files at
// once, stops at a time limit with the matches found so far (marked cut short, with why), and stops reading once nobody is waiting for it.
describe('a search finishes in good time', () => {
  // 400 searchable files, `src/f000.ts` to `src/f399.ts`; every 40th has a line with "needle" in it.
  const MANY = Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [`src/f${String(i).padStart(3, '0')}.ts`, `export const n${i} = ${i}\n${i % 40 === 0 ? `// needle ${i}\n` : ''}`])
  )
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  test('against a slow Provider, a search over 400 files with no match stops at its time limit, cut short, saying why and how far it got', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY, contentDelayMs: 300 }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, searchTimeLimitMs: 1000, searchParallelReads: 8 })
      const started = Date.now()
      const found = await reader.search({ query: 'nothing-here' })
      const took = Date.now() - started
      assert.ok(took < 1500, `it finishes within its time limit (took ${took} ms)`)
      assert.deepEqual(found.matches, [])
      assert.equal(found.truncated, true)
      assert.equal(found.truncatedBy, 'time-limit')
      assert.ok(found.filesSearched >= 16 && found.filesSearched < 400, `several files are read at once (${found.filesSearched} in a second, at 300 ms each)`)
      assert.equal(found.truncatedReason, `stopped after 1 second, ${found.filesSearched} of 400 files searched`)
    }))

  test('against a fast Provider, the same search still reads all 400 files and returns every match, in order', () =>
    withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY }), async (baseUrl) => {
      const found = await createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true }).search({ query: 'needle' })
      assert.equal(found.filesSearched, 400)
      assert.equal(found.truncated, false)
      assert.equal(found.truncatedReason, undefined)
      assert.deepEqual(found.matches, Array.from({ length: 10 }, (_, k) => ({ path: `src/f${String(k * 40).padStart(3, '0')}.ts`, line: 2, text: `// needle ${k * 40}` })))
    }))

  test('matches come back in the same order and form however many files are read at once, also when they reach their cap', async () => {
    // Every file matches three times, so 60 matches are reached part way through, and file names match too for some.
    const busy = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`lib/needle-${String(i).padStart(2, '0')}.js`, 'a needle\nb\nc needle\nNEEDLE d\n']))
    for (const [fake, apiRoot, repository] of [
      [() => createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: { ...CODE, ...busy } }), '', (baseUrl) => github(baseUrl)],
      [() => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: { ...CODE, ...busy } }), '', (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl }, branch: 'main' })],
    ]) {
      await withFake(fake(), async (baseUrl) => {
        const search = (searchParallelReads, query) => createRepositoryReader(repository(baseUrl), TOKEN, { allowBaseUrl: true, searchParallelReads }).search({ query })
        const oneAtATime = await search(1, 'needle')
        assert.equal(oneAtATime.matches.length, 60)
        assert.equal(oneAtATime.truncated, true)
        assert.equal(oneAtATime.truncatedBy, 'match-limit')
        assert.match(oneAtATime.truncatedReason, new RegExp(`^stopped at 60 matches, ${oneAtATime.filesSearched}( of 55)? files searched$`), 'how many there were to search, where the Provider lists them all at once')
        assert.deepEqual(oneAtATime.matches.slice(0, 4), [{ path: 'lib/needle-00.js' }, { path: 'lib/needle-00.js', line: 1, text: 'a needle' }, { path: 'lib/needle-00.js', line: 3, text: 'c needle' }, { path: 'lib/needle-00.js', line: 4, text: 'NEEDLE d' }])
        assert.deepEqual(await search(8, 'needle'), oneAtATime)
        assert.deepEqual(await search(8, 'orderservice'), await search(1, 'orderservice'))
      }, apiRoot)
    }
  })

  test('once nobody is waiting for the search any more, it makes no further file reads', () => {
    // Counted where the requests are made, not where they arrive: a read asked for just before the abort may reach the fake after it.
    const fetchesMade = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, ...rest) => {
      fetchesMade.push(String(url))
      return realFetch(url, ...rest)
    }
    return withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY, contentDelayMs: 100 }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, searchTimeLimitMs: 10_000, searchParallelReads: 4 })
      const abandon = new AbortController()
      const searching = reader.search({ query: 'nothing-here', signal: abandon.signal })
      await pause(250)
      abandon.abort()
      const atAbandon = fetchesMade.length
      await assert.rejects(searching, (err) => err.code === 'abandoned')
      assert.ok(fetchesMade.filter((url) => url.includes('/contents/')).length > 0 && atAbandon < 400)
      await pause(400)
      assert.deepEqual(fetchesMade.slice(atAbandon), [], 'nothing is asked of the Provider after the search was given up')
    }).finally(() => {
      globalThis.fetch = realFetch
    })
  })

  test('a search given up before it starts, or while it finds the branch head, asks the Provider for nothing more', async () => {
    const apiLog = []
    await withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY, apiLog }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true })
      await assert.rejects(reader.search({ query: 'needle', signal: AbortSignal.abort() }), (err) => err.code === 'abandoned')
      await pause(100)
      assert.deepEqual(apiLog, [], 'nothing at all is asked of the Provider for a caller already gone')
    })
    // The caller leaves while the branch's head is being looked up: the fake gives up the search as that request arrives.
    const abandon = new AbortController()
    const leaving = { push: (entry) => (apiLog.push(entry), entry.includes('/git/ref') && abandon.abort()) }
    apiLog.length = 0
    await withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY, apiLog: leaving }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true })
      await assert.rejects(reader.search({ query: 'needle', signal: abandon.signal }), (err) => err.code === 'abandoned')
      await pause(100)
      assert.deepEqual(apiLog.filter((entry) => !entry.includes('/git/ref')), [], 'the repository is not listed once the caller has gone')
    })
  })

  test('a search whose listing fails asks for the listing once, however many files it reads at once', async () => {
    for (const searchParallelReads of [1, 8]) {
      const apiLog = []
      // The branch head is the one request the limit allows; the listing of the whole repository is refused as over it.
      await withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY, apiRequestLimit: 1, apiLog }), async (baseUrl) => {
        const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, searchParallelReads })
        await assert.rejects(reader.search({ query: 'needle' }), (err) => err.code === 'rate-limited')
        await pause(50)
        assert.equal(apiLog.filter((entry) => entry.includes('/git/trees/')).length, 1, `one listing request with ${searchParallelReads} reads at once`)
      })
    }
    // A folder-by-folder walk (Azure DevOps) over two folders, whose first listing fails: the other folder is not listed after it.
    const folderListings = []
    const fake = createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE })
    const [answer] = fake.listeners('request')
    fake.removeAllListeners('request')
    fake.on('request', (req, res) => {
      const url = new URL(req.url, 'http://fake.invalid')
      if (url.searchParams.get('recursionLevel') !== 'OneLevel') return answer(req, res)
      folderListings.push(url.searchParams.get('scopePath'))
      if (folderListings.length > 1) return answer(req, res)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'The listing failed (fake).' }))
    })
    await withFake(fake, async (baseUrl) => {
      const repository = { provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl }, branch: 'main', folders: ['infra', 'src'] }
      await assert.rejects(createRepositoryReader(repository, TOKEN, { allowBaseUrl: true, searchParallelReads: 8 }).search({ query: 'needle' }))
      await pause(50)
    })
    assert.equal(folderListings.length, 1, `no further folder is listed once a listing failed (${folderListings.join(', ')})`)
  })

  test('POST /api/sources/repository stops reading files for a search once the caller has gone, and is cut short by the server\'s own time limit', () => {
    const contentRequests = []
    return withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: MANY, contentDelayMs: 100, contentRequests }), async (codeBase) => {
      const body = JSON.stringify({ action: 'search', repository: github(codeBase), query: 'nothing-here' })
      const ask = (base, signal) => fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body, signal })

      await withRunningServer({ allowGitHubBaseUrlOverride: true, repositoryReader: { searchTimeLimitMs: 10_000, searchParallelReads: 4 } }, async (base) => {
        const gone = new AbortController()
        const asked = ask(base, gone.signal).catch((err) => err)
        await pause(300)
        gone.abort()
        assert.equal((await asked).name, 'AbortError')
        await pause(150)
        const afterLeaving = contentRequests.length
        assert.ok(afterLeaving > 0 && afterLeaving < 400)
        await pause(400)
        assert.equal(contentRequests.length, afterLeaving, 'the server reads no more files for a search nobody is waiting for')
      })

      await withRunningServer({ allowGitHubBaseUrlOverride: true, repositoryReader: { searchTimeLimitMs: 500 } }, async (base) => {
        const res = await ask(base)
        assert.equal(res.status, 200)
        const found = await res.json()
        assert.equal(found.truncated, true)
        assert.equal(found.truncatedBy, 'time-limit')
        assert.match(found.truncatedReason, /^stopped after 0\.5 seconds, \d+ of 400 files searched$/)
      })
    })
  })
})

// #336: reading a repository survives a temporary failure. Every request to the Provider has its own time limit, and a read that fails
// for a temporary reason (a dropped connection, a request that ran out of time, a 502, 503 or 504) is tried again, at most twice, with a
// short wait that grows. A definite answer (a used-up rate limit, no access, not found, no such branch) is never tried again.
describe('a read survives a temporary failure', () => {
  // Puts `misbehave(request, n)` in front of a stand-in Provider. It returns 'drop' to cut the connection, 'hang' to never answer, a
  // status (or `[status, headers]`) to answer that, or null to let the stand-in answer. Resolves the `METHOD path` of every request asked.
  function interfere(fake, misbehave) {
    const [answer] = fake.listeners('request')
    fake.removeAllListeners('request')
    const asked = []
    fake.on('request', (req, res) => {
      const url = new URL(req.url, 'http://fake.invalid')
      asked.push(`${req.method} ${url.pathname}`)
      const what = misbehave({ method: req.method, path: url.pathname, url }, asked.length - 1)
      if (what === 'drop') return req.socket.destroy()
      if (what === 'hang') return undefined
      if (what !== null && what !== undefined) {
        const [status, headers] = Array.isArray(what) ? what : [what, {}]
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        return res.end(JSON.stringify({ message: `The stand-in answers ${status}.` }))
      }
      return answer(req, res)
    })
    return asked
  }
  const quick = { allowBaseUrl: true, retryWaitMs: 5, requestTimeLimitMs: 2000 }
  // The first request whose path matches `pattern` gets `what`; every other request is answered as normal.
  const onceAt = (pattern, what) => {
    let done = false
    return ({ path }) => (!done && pattern.test(path) ? ((done = true), what) : null)
  }

  for (const [what, label] of [['drop', 'drops the connection'], [503, 'answers 503'], [502, 'answers 502'], [504, 'answers 504']]) {
    test(`a Provider that ${label} once, then answers: check, list, read, search and compare all succeed as if nothing happened`, async () => {
      for (const [step, pattern, run] of [
        ['check', /^\/repos\/acme\/billing-api$/, (reader) => reader.check()],
        ['list', /\/contents$/, (reader) => reader.list()],
        ['read', /\/contents\/src\/orders\/limits\.ts$/, (reader) => reader.read({ path: 'src/orders/limits.ts' })],
        ['search', /\/contents\/src\/orders\/service\.ts$/, (reader) => reader.search({ query: 'orderservice' })],
        ['compare', /\/git\/ref\//, (reader) => reader.compare({ reads: [{ path: 'README.md', commit: 'not-the-head' }] })],
      ]) {
        const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
        const asked = interfere(fake, onceAt(pattern, what))
        await withFake(fake, async (baseUrl) => {
          const answer = await run(createRepositoryReader(github(baseUrl), TOKEN, quick))
          if (step === 'check') assert.equal(answer.branch, 'main')
          if (step === 'list') assert.deepEqual(answer.entries.map((e) => e.path), ['docs', 'infra', 'src', 'tools', 'README.md'])
          if (step === 'read') assert.equal(answer.text, 'export const MAX_ORDER_NZD = 5000\n')
          if (step === 'search') assert.deepEqual(answer.matches, [{ path: 'src/orders/service.ts', line: 1, text: 'export class OrderService {' }])
          if (step === 'compare') assert.equal(answer.results.length, 1)
          assert.equal(asked.filter((line) => pattern.test(line.split(' ')[1])).length >= 2, true, `${step}: the request that failed was asked again`)
        })
      }
    })
  }

  test('the same holds on Azure DevOps, GitLab and Bitbucket: a dropped connection and a 503 are tried again', async () => {
    for (const [fake, apiRoot, repository, options] of [
      [() => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE }), '', (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl }, branch: 'main' }), () => ({})],
      [() => createFakeGitLabServer({ namespace: 'acme/payments', repository: 'billing-api', validPat: TOKEN, files: CODE }), '/api/v4', (baseUrl) => ({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api', baseUrl }, branch: 'main' }), () => ({})],
      [() => createFakeBitbucketServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), '/2.0', () => ({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }), (baseUrl) => ({ clientBaseUrl: baseUrl })],
    ]) {
      for (const what of ['drop', 503]) {
        const server = fake()
        let n = 0
        interfere(server, () => (n++ === 0 ? what : null))
        await withFake(server, async (baseUrl) => {
          const reader = createRepositoryReader(repository(baseUrl), TOKEN, { ...quick, ...options(baseUrl) })
          assert.equal((await reader.read({ path: 'src/orders/limits.ts' })).text, 'export const MAX_ORDER_NZD = 5000\n', `${repository(baseUrl).provider}, ${what}`)
        }, apiRoot)
      }
    }
  })

  test('a Provider that never answers: the read fails within its time limit and its retries, saying it took too long, on every Provider', async () => {
    for (const [fake, apiRoot, repository, options] of [
      [() => createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), '', (baseUrl) => github(baseUrl), () => ({})],
      [() => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE }), '', (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl }, branch: 'main' }), () => ({})],
      [() => createFakeGitLabServer({ namespace: 'acme/payments', repository: 'billing-api', validPat: TOKEN, files: CODE }), '/api/v4', (baseUrl) => ({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api', baseUrl }, branch: 'main' }), () => ({})],
      [() => createFakeBitbucketServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }), '/2.0', () => ({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }), (baseUrl) => ({ clientBaseUrl: baseUrl })],
    ]) {
      const server = fake()
      const asked = interfere(server, () => 'hang')
      await withFake(server, async (baseUrl) => {
        const reader = createRepositoryReader(repository(baseUrl), TOKEN, { allowBaseUrl: true, requestTimeLimitMs: 150, retries: 2, retryWaitMs: 20, ...options(baseUrl) })
        const started = Date.now()
        await assert.rejects(reader.read({ path: 'src/orders/limits.ts' }), (err) => {
          assert.equal(err.code, 'timed-out')
          assert.equal(err.status, 504)
          assert.match(err.message, /took too long to answer/)
          return true
        })
        const took = Date.now() - started
        assert.ok(took >= 450 && took < 1500, `three tries of 150 ms and two short waits, not a hang (took ${took} ms)`)
        assert.equal(asked.length, 3, 'asked once and tried twice more')
      }, apiRoot)
    }
  })

  test('a Provider that answers part of a file and then stops is a time limit too, and is tried again', async () => {
    const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
    const [answer] = fake.listeners('request')
    fake.removeAllListeners('request')
    let stalled = false
    fake.on('request', (req, res) => {
      if (!stalled && req.url.includes('/contents/src/orders/limits.ts')) {
        stalled = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.write('{"type": "file", ')
      }
      return answer(req, res)
    })
    await withFake(fake, async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { ...quick, requestTimeLimitMs: 150 })
      assert.equal((await reader.read({ path: 'src/orders/limits.ts' })).text, 'export const MAX_ORDER_NZD = 5000\n')
      assert.equal(stalled, true)
    })
  })

  test('a used-up rate limit is not tried again and still says when it resets', async () => {
    const apiLog = []
    await withFake(createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, anonymousRead: true, apiRequestLimit: 1, apiLog }), async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), null, quick)
      await assert.rejects(reader.check(), (err) => err.code === 'rate-limited' && /used up until 08:00 UTC/.test(err.message))
      assert.equal(apiLog.length, 2, 'the repository, then its branch once: the refusal is not asked again')
    })
    const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
    const asked = interfere(fake, ({ path }) => (path.includes('/git/ref/') ? [429, { 'retry-after': '120' }] : null))
    await withFake(fake, async (baseUrl) => {
      await assert.rejects(createRepositoryReader(github(baseUrl), TOKEN, quick).read({ path: 'README.md' }), (err) => {
        assert.equal(err.code, 'rate-limited')
        assert.match(err.message, /^GitHub's limit on reads with your token is used up until \d\d:\d\d UTC/)
        return true
      })
      assert.equal(asked.filter((line) => line.includes('/git/ref/')).length, 1, 'a 429 is asked once')
    })
  })

  test('no access, not found and no such branch are answered once, never tried again', () => {
    const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
    const asked = interfere(fake, () => null)
    return withFake(fake, async (baseUrl) => {
      await assert.rejects(createRepositoryReader(github(baseUrl), null, quick).check(), (err) => err.code === 'no-access')
      assert.deepEqual(asked, ['GET /repos/acme/billing-api'], 'no access: asked once')
      asked.length = 0
      await assert.rejects(createRepositoryReader(github(baseUrl), TOKEN, quick).read({ path: 'src/orders/missing.ts' }), (err) => err.code === 'not-found')
      assert.deepEqual(asked, ['GET /repos/acme/billing-api/git/ref/heads/main', 'GET /repos/acme/billing-api/contents/src/orders/missing.ts'], 'not found: asked once')
      asked.length = 0
      await assert.rejects(createRepositoryReader(github(baseUrl, { branch: 'nope' }), TOKEN, quick).read({ path: 'README.md' }), (err) => err.code === 'no-branch')
      assert.deepEqual(asked, ['GET /repos/acme/billing-api/git/ref/heads/nope'], 'no such branch: asked once')
    })
  })

  test('a Provider still failing after the retries is a temporary failure, said as one', () => {
    const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
    const asked = interfere(fake, () => 503)
    return withFake(fake, async (baseUrl) => {
      await assert.rejects(createRepositoryReader(github(baseUrl), TOKEN, { ...quick, retries: 1 }).check(), (err) => {
        assert.equal(err.code, 'unreachable')
        assert.equal(err.status, 502)
        assert.equal(err.message, "GitHub couldn't answer a read of acme/billing-api just now (HTTP 503). Try again in a moment.")
        return true
      })
      assert.equal(asked.length, 2, 'asked once and tried once more, as set')
    })
  })

  test('Out of date on the server compares again after a temporary failure, and a Provider that keeps failing leaves it not checked, never changed', async () => {
    const definition = { stages: [{ id: 'shape', modules: ['details'] }], modules: new Map([['details', { title: 'Details', fields: [{ id: 'summary', title: 'Summary' }] }]]) }
    for (const [what, unchecked] of [[onceAt(/\/git\/ref\//, 503), false], [() => 503, true]]) {
      const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
      interfere(fake, what)
      await withFake(fake, async (baseUrl) => {
        const sources = [{ id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository: github(baseUrl) }]
        const logs = { shape: { stage: 'shape', fields: { 'details.summary': { drafted: '2026-11-02T00:00:00.000Z', inputs: [{ source: 'billing-api', path: 'README.md', commit: 'an-old-commit', fingerprint: 'x' }] } }, entries: [] } }
        const out = await describeOutOfDate({
          sourceStore: { list: async () => ({ entries: sources }) },
          readLog: async (id) => logs[id],
          definition,
          currentStageId: 'shape',
          readStageModules: async () => [{ id: 'details', fields: [{ id: 'summary', value: 'Takes payments.' }] }],
          compareRepository: (entry, reads) => createRepositoryReader(entry.repository, TOKEN, { ...quick, retries: 1 }).compare({ reads }),
        })
        if (unchecked) {
          assert.deepEqual(out.fields, [], 'not "changed"')
          assert.deepEqual(out.uncheckedRepositories.map((u) => u.id), ['billing-api'])
          assert.match(out.summary[0], /^Billing API was not checked for changes.*GitHub couldn't answer a read of acme\/billing-api just now \(HTTP 503\)/)
        } else {
          assert.equal(out.uncheckedRepositories, undefined, 'the comparison was made, on the second try')
        }
      })
    }
  })

  test('POST /api/sources/repository, which an outside agent over MCP reaches too, tries again and keeps to its time limit', () => {
    const fake = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
    let hang = false
    let dropped = false
    interfere(fake, ({ path }) => (hang ? 'hang' : !dropped && path.includes('/contents/') ? ((dropped = true), 'drop') : null))
    return withFake(fake, (codeBase) =>
      withRunningServer({ allowGitHubBaseUrlOverride: true, repositoryReader: { requestTimeLimitMs: 150, retryWaitMs: 5 } }, async (base) => {
        const ask = () => fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body: JSON.stringify({ action: 'read', repository: github(codeBase), path: 'README.md' }) })
        const read = await ask()
        assert.equal(read.status, 200, 'the dropped connection was tried again')
        assert.match((await read.json()).text, /^# Billing API/)
        hang = true
        const started = Date.now()
        const late = await ask()
        assert.equal(late.status, 504)
        assert.equal((await late.json()).code, 'timed-out')
        assert.ok(Date.now() - started < 2000)
      })
    )
  })
})
