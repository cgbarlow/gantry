import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from '../lib/instance.js'
import { createRepositoryReader } from '../lib/repositorySource.js'
import { resolveContentStore } from '../lib/providerRegistry.js'
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
