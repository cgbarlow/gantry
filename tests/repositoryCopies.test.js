import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRepositoryReader } from '../lib/repositorySource.js'
import { createRepositoryCopyStore, credentialHash } from '../lib/repositoryCopies.js'
import { CopyTooBigError, namePatternTest, unpackRepositoryArchive } from '../lib/repositoryCopy.js'
import { resolveContentStore } from '../lib/providerRegistry.js'
import { createFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { createFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createFakeBitbucketServer } from './helpers/fakeBitbucketServer.js'
import { createFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { zipOfFiles } from './helpers/fakeArchive.js'
import { basicAuthHeader, withRunningServer } from './helpers/lifecycle.js'

// #338 (docs/adr/0074): a code repository is searched from a Repository copy, its files at one commit downloaded as one archive and held
// in the server's memory. The first call at a commit downloads it; later finds, searches, listings and reads at that commit use it. Results
// are complete and paged. A copy is shared by every caller who can read the repository with their own token, and memory stays within its
// limits. Without a copy (too big, or the download can't be made) reading falls back to file by file, saying why.

const TOKEN = 'architects-own-token'
const OTHER = 'a-colleagues-token'
const CODE = {
  'README.md': '# Billing API\n\nTakes payments for orders.\n',
  'src/orders/service.ts': 'export class OrderService {\n  // Orders are settled nightly.\n  settle() {}\n  refund() {}\n}\n',
  'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 5000\n',
  'src/payments/retry.ts': 'export const RETRY_POLICY = { attempts: 3 }\n// Orders retry three times.\n',
  'infra/main.tf': 'resource "azurerm_app_service" "billing" {}\n',
  'infra/network.tf': 'resource "azurerm_virtual_network" "billing" {}\n',
  'node_modules/left-pad/index.js': 'module.exports = function OrderService() {}\n',
  'dist/app.js': 'class OrderService {}\n',
  'docs/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
  'tools/blob.dat2': Buffer.from([1, 2, 0, 3]),
  'assets/video.mp4.txt': 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n',
}

async function withFake(server, fn, apiRoot = '') {
  server.keepAliveTimeout = 0
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}${apiRoot}`)
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

const github = (baseUrl, extra = {}) => ({ provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl }, branch: 'main', ...extra })
const commit = (provider, location, files, pat = TOKEN) => resolveContentStore(provider, { ...location, pat }).writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })), { branch: 'main', message: 'A developer changes the code' })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A clock a test moves by hand.
function clock(start = Date.parse('2026-11-05T09:00:00Z')) {
  let at = start
  return { now: () => at, advance: (ms) => (at += ms) }
}

// A stand-in GitHub that serves archives, with logs of what was asked of it: `api` (every API request), `files` (every file read) and
// `archives` (every archive made).
function archivingGitHub(options = {}) {
  const logs = { api: [], files: [], archives: [] }
  const server = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, archives: true, apiLog: logs.api, contentRequests: logs.files, archiveLog: logs.archives, ...options })
  return { server, logs }
}

describe('a search over a Repository copy is complete, with one download per commit', () => {
  test('a 2,000-file repository on a Provider slow to answer each file: complete results, one archive request and no file requests', () => {
    const files = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`src/m${String(i).padStart(4, '0')}.ts`, `export const n${i} = ${i}\n${i % 25 === 0 ? `// needle ${i}\n` : ''}`]))
    const { server, logs } = archivingGitHub({ files, contentDelayMs: 500 })
    return withFake(server, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies, searchTimeLimitMs: 1000 })
      const started = Date.now()
      const found = await reader.search({ query: 'needle' })
      assert.ok(Date.now() - started < 5000, 'well within any time limit')
      assert.equal(found.truncated, false)
      assert.equal(found.totalMatches, 80, 'every one of the 80 matches, none cut short')
      assert.equal(found.totalFiles, 80)
      assert.equal(found.filesSearched, 2000)
      assert.deepEqual([found.page, found.pageSize, found.pages, found.nextPage], [1, 50, 2, 2])
      assert.equal(found.matches.length, 50)
      assert.deepEqual(found.matches[0], { path: 'src/m0000.ts', line: 2, text: '// needle 0' })
      assert.equal(found.notCopied, undefined)
      const second = await reader.search({ query: 'needle', page: 2 })
      assert.equal(second.matches.length, 30)
      assert.equal(second.nextPage, undefined)
      assert.deepEqual(second.matches.at(-1), { path: 'src/m1975.ts', line: 2, text: '// needle 1975' })

      assert.deepEqual(logs.archives, [found.commit], 'one archive')
      assert.deepEqual(logs.api, ['GET /repos/acme/billing-api/git/ref/heads/main', `GET /repos/acme/billing-api/zipball/${found.commit}`], 'the head and the archive, nothing else')
      assert.deepEqual(logs.files, [], 'no file is read on its own')
    })
  })

  test('callers asking at once share one download; a second search, a find, a list and a read at that commit ask nothing more but the head, at most once a minute', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, async (baseUrl) => {
      const time = clock()
      const copies = createRepositoryCopyStore({ now: time.now })
      const reader = () => createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies })
      const [searched, found, read] = await Promise.all([reader().search({ query: 'orders' }), reader().find({ pattern: '*.tf' }), reader().read({ path: 'src/orders/limits.ts' })])
      assert.equal(logs.archives.length, 1, 'one download, shared')
      assert.equal(searched.commit, found.commit)
      assert.equal(read.text, CODE['src/orders/limits.ts'])
      assert.equal(read.citationQuery, `?path=src/orders/limits.ts&commit=${read.commit}`, 'the citation form is unchanged')

      logs.api.length = 0
      time.advance(30_000)
      await reader().search({ query: 'settled' })
      await reader().find({ pattern: '**/*.ts' })
      await reader().list({ path: 'src' })
      await reader().read({ path: 'README.md' })
      assert.deepEqual(logs.api, [], 'within the minute: nothing at all')
      assert.deepEqual(logs.files, [])

      time.advance(31_000)
      await reader().search({ query: 'settled' })
      await reader().read({ path: 'README.md' })
      assert.deepEqual(logs.api, ['GET /repos/acme/billing-api/git/ref/heads/main'], 'a minute on: the head once, and the copy is still the one')
      assert.equal(logs.archives.length, 1)
    })
  })

  test('a new commit on the branch makes a new copy, and results never mix two commits', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, async (baseUrl) => {
      const time = clock()
      const copies = createRepositoryCopyStore({ now: time.now })
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies })
      const before = await reader.search({ query: 'MAX_ORDER_NZD' })
      assert.deepEqual(before.matches.map((m) => m.text), ['export const MAX_ORDER_NZD = 5000'])

      await commit('github', github(baseUrl).location, { 'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 8000\n' })
      assert.equal((await reader.search({ query: 'MAX_ORDER_NZD' })).commit, before.commit, 'within the minute the head is as last asked')
      time.advance(61_000)
      const after = await reader.search({ query: 'MAX_ORDER_NZD' })
      assert.notEqual(after.commit, before.commit)
      assert.deepEqual(after.matches.map((m) => m.text), ['export const MAX_ORDER_NZD = 8000'])
      assert.deepEqual(logs.archives, [before.commit, after.commit], 'one copy per commit')

      const old = await reader.read({ path: 'src/orders/limits.ts', commit: before.commit })
      assert.equal(old.text, 'export const MAX_ORDER_NZD = 5000\n', 'a read at the earlier commit comes from that commit\'s copy')
      assert.equal(old.commit, before.commit)
      assert.deepEqual(logs.files, [])
      assert.equal(logs.archives.length, 2)

      // Out of date asks the head fresh, and reads the recorded commit's file from its copy.
      logs.api.length = 0
      const compared = await reader.compare({ reads: [{ path: 'src/orders/limits.ts', commit: before.commit }, { path: 'README.md', commit: before.commit }] })
      assert.equal(compared.head, after.commit)
      assert.deepEqual(compared.results.map((r) => [r.path, r.changed]), [['src/orders/limits.ts', true], ['README.md', false]])
      assert.deepEqual(logs.api, ['GET /repos/acme/billing-api/git/ref/heads/main'], 'the head, fresh; both commits\' files come from their copies')
    })
  })

  test('a copy is never stale: the copy holds what was at its commit, whatever the branch does next', () =>
    withFake(archivingGitHub().server, async (baseUrl) => {
      const copies = createRepositoryCopyStore({ headIntervalMs: 0 })
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies })
      const first = await reader.read({ path: 'README.md' })
      await commit('github', github(baseUrl).location, { 'README.md': 'Rewritten.\n' })
      const second = await reader.read({ path: 'README.md' })
      assert.notEqual(second.commit, first.commit, 'with no re-check interval the head is asked every time')
      assert.equal(second.text, 'Rewritten.\n')
      assert.equal((await reader.read({ path: 'README.md', commit: first.commit })).text, CODE['README.md'])
    }))
})

describe('finding, searching, listing and reading in a copy', () => {
  const reading = (fn, options = {}) =>
    withFake(archivingGitHub(options.fake).server, (baseUrl) => fn(createRepositoryReader(github(baseUrl, options.pointer), TOKEN, { allowBaseUrl: true, copies: createRepositoryCopyStore(), ...options.reader }), baseUrl))

  test('find by name pattern: *, **, ? and {a,b}, within the pointer\'s folders or a path, paged with the total', () =>
    reading(async (reader) => {
      assert.deepEqual((await reader.find({ pattern: '*.tf' })).paths, ['infra/main.tf', 'infra/network.tf'], 'a pattern without a folder matches a file\'s name anywhere')
      assert.deepEqual((await reader.find({ pattern: 'src/**/*.ts' })).paths, ['src/orders/limits.ts', 'src/orders/service.ts', 'src/payments/retry.ts'])
      assert.deepEqual((await reader.find({ pattern: 'src/**/order*' })).paths, [], 'a pattern with a folder matches the whole path')
      assert.deepEqual((await reader.find({ pattern: 'src/*/*' })).paths, ['src/orders/limits.ts', 'src/orders/service.ts', 'src/payments/retry.ts'])
      assert.deepEqual((await reader.find({ pattern: '**/order*/*' })).paths, ['src/orders/limits.ts', 'src/orders/service.ts'])
      assert.deepEqual((await reader.find({ pattern: 'limit?.ts' })).paths, ['src/orders/limits.ts'])
      assert.deepEqual((await reader.find({ pattern: '*.{tf,md}' })).paths, ['infra/main.tf', 'infra/network.tf', 'README.md'].sort((a, b) => a.localeCompare(b)))
      assert.deepEqual((await reader.find({ pattern: '*', path: 'src/orders' })).paths, ['src/orders/limits.ts', 'src/orders/service.ts'])
      assert.deepEqual((await reader.find({ pattern: '*.js' })).paths, [], 'vendored code and build output are never in a copy')
      assert.deepEqual((await reader.find({ pattern: '*.png' })).paths, [], 'nor what is always skipped by its name')
      assert.deepEqual((await reader.find({ pattern: 'blob.*' })).paths, ['tools/blob.dat2'], 'a binary found by its bytes is still named')
      const all = await reader.find({ pattern: '**' })
      assert.deepEqual([all.total, all.page, all.pages, all.pageSize], [8, 1, 1, 200])
      await assert.rejects(reader.find({ pattern: ' ' }), (err) => err.code === 'bad-query')
    }))

  test('find pages 200 paths at a time and says how many there are', () =>
    reading(
      async (reader) => {
        const first = await reader.find({ pattern: '*.ts' })
        assert.deepEqual([first.paths.length, first.total, first.pages, first.nextPage], [200, 450, 3, 2])
        const last = await reader.find({ pattern: '*.ts', page: 3 })
        assert.deepEqual([last.paths.length, last.page, last.nextPage], [50, 3, undefined])
        assert.equal(last.paths.at(-1), 'lib/f449.ts')
      },
      { fake: { files: Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`lib/f${String(i).padStart(3, '0')}.ts`, `export const f = ${i}\n`])) } }
    ))

  test('search: plain text ignores case; a regular expression on request; folder and file-type filters; context lines; matching files only', () =>
    reading(async (reader) => {
      const plain = await reader.search({ query: 'ORDERS' })
      assert.deepEqual(plain.matches.map((m) => [m.path, m.line]), [
        ['README.md', 3],
        ['src/orders/service.ts', 1],
        ['src/orders/service.ts', 2],
        ['src/payments/retry.ts', 2],
      ], '"OrderService" holds "orders" too')
      assert.deepEqual([plain.totalMatches, plain.totalFiles, plain.page, plain.pages, plain.truncated], [4, 3, 1, 1, false])
      assert.ok(plain.matches.every((m) => m.path && m.line && m.text), 'every match keeps its path and line, and the answer its commit')
      assert.match(plain.commit, /\S/)

      const regex = await reader.search({ query: 'MAX_\\w+_NZD|RETRY_\\w+', regex: true })
      assert.equal(regex.regex, true)
      assert.deepEqual(regex.matches.map((m) => m.path), ['src/orders/limits.ts', 'src/payments/retry.ts'])
      assert.deepEqual((await reader.search({ query: 'refund\\(\\)', regex: true })).matches.map((m) => m.text), ['refund() {}'])

      assert.deepEqual((await reader.search({ query: 'orders', path: 'src' })).matches.map((m) => m.path), ['src/orders/service.ts', 'src/orders/service.ts', 'src/payments/retry.ts'], 'a folder')
      assert.deepEqual((await reader.search({ query: 'billing', fileTypes: ['tf'] })).matches.map((m) => m.path), ['infra/main.tf', 'infra/network.tf'], 'a file type')
      assert.deepEqual((await reader.search({ query: 'billing', fileTypes: ['.md', '*.ts'] })).matches.map((m) => m.path), ['README.md'], 'an extension or a name pattern')
      assert.deepEqual((await reader.search({ query: 'orderservice' })).matches.map((m) => m.path), ['src/orders/service.ts'], 'vendored code and build output are not searched')
      assert.deepEqual((await reader.search({ query: 'git-lfs' })).matches, [], 'a Git LFS placeholder is not searched')

      const withContext = await reader.search({ query: 'settled nightly', context: 1 })
      assert.deepEqual(withContext.matches, [
        { path: 'src/orders/service.ts', line: 2, text: '// Orders are settled nightly.', before: [{ line: 1, text: 'export class OrderService {' }], after: [{ line: 3, text: '  settle() {}' }] },
      ])
      const wide = await reader.search({ query: 'settled nightly', context: 99 })
      assert.equal(wide.matches[0].before.length, 1, 'only the lines there are')
      assert.equal(wide.matches[0].after.length, 4, 'at most 5, and only the lines there are (the last is the empty line after the final newline)')

      const filesOnly = await reader.search({ query: 'billing', filesOnly: true })
      assert.deepEqual(filesOnly.matches, [{ path: 'infra/main.tf', count: 1 }, { path: 'infra/network.tf', count: 1 }, { path: 'README.md', count: 1 }])
      assert.equal(filesOnly.pageSize, 200)
      assert.equal(filesOnly.total, 3)
    }))

  test('search pages 50 matching lines at a time, each page stating the totals; nothing is cut short', () =>
    reading(
      async (reader) => {
        const pages = []
        for (let page = 1; ; page++) {
          const answer = await reader.search({ query: 'needle', page })
          pages.push(answer)
          assert.deepEqual([answer.totalMatches, answer.totalFiles, answer.pages, answer.truncated], [130, 65, 3, false])
          if (!answer.nextPage) break
        }
        assert.deepEqual(pages.map((p) => p.matches.length), [50, 50, 30])
        assert.equal(new Set(pages.flatMap((p) => p.matches.map((m) => `${m.path}:${m.line}`))).size, 130, 'every match exactly once')
        assert.deepEqual((await reader.search({ query: 'needle', page: 9 })).matches, [], 'a page past the end is empty, with the totals')
      },
      { fake: { files: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`lib/n${String(i).padStart(2, '0')}.js`, 'a needle\nb\nNEEDLE c\n'])) } }
    ))

  test('a regular expression that backtracks without end stops at its time budget and says so; an over-long or broken one is refused plainly', () =>
    reading(
      async (reader) => {
        const started = Date.now()
        const stuck = await reader.search({ query: '(a+)+$', regex: true })
        const took = Date.now() - started
        assert.ok(took < 2000, `held to its budget (took ${took} ms)`)
        assert.equal(stuck.truncated, true)
        assert.equal(stuck.truncatedBy, 'time-budget')
        assert.match(stuck.truncatedReason, /^the regular expression reached its 0\.2-second time budget, \d+ of \d+ files searched; make it simpler, or search within a folder$/)

        await assert.rejects(reader.search({ query: 'a'.repeat(301), regex: true }), (err) => {
          assert.equal(err.code, 'bad-query')
          assert.equal(err.message, 'A regular expression can be at most 300 characters; this one is 301. Make it shorter, or search for plain text.')
          return true
        })
        await assert.rejects(reader.search({ query: '(unclosed', regex: true }), /^RepositorySourceError: "\(unclosed" isn't a regular expression Gantry can use \(.*Unterminated group\)\.$/)
        await assert.rejects(reader.search({ query: 'x' }), /Search for at least two characters\./)
      },
      { fake: { files: { ...CODE, 'src/evil.txt': `${'a'.repeat(40)}!\n` } }, reader: { regexBudgetMs: 200 } }
    ))

  test('list from the copy; a read by line range; a submodule is a folder that is not followed', () =>
    reading(
      async (reader) => {
        assert.deepEqual((await reader.list()).entries.map((e) => e.path), ['assets', 'infra', 'libs', 'src', 'tools', 'README.md'], 'docs/ holds only a picture, never copied')
        const top = await reader.list()
        assert.deepEqual([top.total, top.page, top.pages], [6, 1, 1])
        assert.deepEqual((await reader.list({ path: 'libs' })).entries, [{ path: 'libs/shared', isFolder: true }])
        assert.deepEqual((await reader.list({ path: 'libs/shared' })).entries, [], 'a submodule: shown, never followed')

        const range = await reader.read({ path: 'src/orders/service.ts', lines: '2-3' })
        assert.equal(range.text, '  // Orders are settled nightly.\n  settle() {}')
        assert.deepEqual(range.lines, { from: 2, to: 3, total: 5 })
        assert.equal(range.citationQuery, `?path=src/orders/service.ts&commit=${range.commit}`)
        assert.deepEqual((await reader.read({ path: 'src/orders/service.ts', lines: { from: 4 } })).lines, { from: 4, to: 5, total: 5 })
        assert.deepEqual((await reader.read({ path: 'src/orders/service.ts', lines: [5, 99] })).text, '}')
        await assert.rejects(reader.read({ path: 'src/orders/service.ts', lines: '9-10' }), /^RepositorySourceError: src\/orders\/service\.ts has 5 lines, so there is no line 9\.$/)
        await assert.rejects(reader.read({ path: 'src/orders/service.ts', lines: '3-1' }), (err) => err.code === 'bad-query')
        await assert.rejects(reader.read({ path: 'tools/blob.dat2' }), /is a binary file, which Gantry never reads/)
        await assert.rejects(reader.read({ path: 'node_modules/left-pad/index.js' }), /vendored code or build output/)
      },
      { fake: { archiveExtra: { 'libs/shared/': new Uint8Array(0) } } }
    ))

  test('a read of a path the copy hasn\'t got (a Git LFS placeholder, say) goes to the Provider, as before', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies: createRepositoryCopyStore() })
      await reader.list()
      assert.deepEqual(logs.files, [])
      const placeholder = await reader.read({ path: 'assets/video.mp4.txt' })
      assert.match(placeholder.text, /^version https:\/\/git-lfs/)
      assert.deepEqual(logs.files, ['assets/video.mp4.txt'], 'read from the Provider')
      await assert.rejects(reader.read({ path: 'src/orders/missing.ts' }), (err) => err.code === 'not-found')
    })
  })
})

describe('sharing a copy, but only with callers who can read the repository', () => {
  test('a caller with no token, or a token that can\'t read it, gets nothing of a private repository from a copy made with someone else\'s token; a caller whose check passes shares it', () => {
    const { server, logs } = archivingGitHub({ validPat: [TOKEN, OTHER] })
    return withFake(server, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      const reader = (pat) => createRepositoryReader(github(baseUrl), pat, { allowBaseUrl: true, copies })
      const made = await reader(TOKEN).read({ path: 'src/orders/limits.ts' })
      assert.equal(logs.archives.length, 1)
      const at = made.commit

      for (const [pat, said] of [[null, /without a token/], ['someone-elses-token', /with the token you gave/]]) {
        for (const ask of [(r) => r.read({ path: 'src/orders/limits.ts', commit: at }), (r) => r.list({ commit: at }), (r) => r.search({ query: 'orders' }), (r) => r.find({ pattern: '*' })]) {
          await assert.rejects(ask(reader(pat)), (err) => {
            assert.equal(err.code, 'no-access')
            assert.match(err.message, said)
            return true
          })
        }
      }
      assert.equal(logs.archives.length, 1, 'no new copy was made either')

      logs.api.length = 0
      const shared = await reader(OTHER).read({ path: 'src/orders/limits.ts', commit: at })
      assert.equal(shared.text, CODE['src/orders/limits.ts'])
      assert.deepEqual(logs.api, ['GET /repos/acme/billing-api/contents'], 'one cheap read of the code, with their own token: the top folder at that commit')
      logs.api.length = 0
      await reader(OTHER).search({ query: 'orders' })
      assert.deepEqual(logs.api, ['GET /repos/acme/billing-api/git/ref/heads/main'], 'once passed, not asked again for a while (their own head, though)')
      assert.equal(logs.archives.length, 1, 'one copy for both')
    })
  })

  // #338: seeing a repository is not reading it. A fine-grained GitHub token with only "Metadata: read" (or a GitLab Guest on a private
  // project) is answered the repository's metadata but refused its code, and a commit is easy to come by: every citation carries one.
  test('a token that can see the repository but not read its code gets nothing from a copy, even naming the commit, and even after a check', () => {
    const SEES_ONLY = 'a-metadata-only-token'
    const { server, logs } = archivingGitHub({ metadataOnlyPat: SEES_ONLY })
    return withFake(server, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      const reader = (pat) => createRepositoryReader(github(baseUrl), pat, { allowBaseUrl: true, copies })
      const at = (await reader(TOKEN).read({ path: 'src/orders/limits.ts' })).commit
      await assert.rejects(reader(SEES_ONLY).check(), (err) => err.code === 'no-access', 'its check is refused at the branch head')
      for (const ask of [(r) => r.read({ path: 'src/orders/limits.ts', commit: at }), (r) => r.list({ commit: at }), (r) => r.search({ query: 'orders', commit: at }), (r) => r.find({ pattern: '*', commit: at }), (r) => r.prepare({ commit: at })]) {
        await assert.rejects(ask(reader(SEES_ONLY)), (err) => {
          assert.equal(err.code, 'no-access')
          assert.match(err.message, /with the token you gave/)
          return true
        })
      }
      await assert.rejects(reader(SEES_ONLY).compare({ reads: [{ path: 'src/orders/limits.ts', commit: at }] }), (err) => err.code === 'no-access')
      assert.equal(logs.archives.length, 1)
    })
  })

  test('a public repository copied with no token is shared outright', () => {
    const { server, logs } = archivingGitHub({ anonymousRead: true })
    return withFake(server, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      const made = await createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true, copies }).search({ query: 'orders' })
      logs.api.length = 0
      await createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies }).read({ path: 'README.md', commit: made.commit })
      await createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true, copies }).read({ path: 'README.md', commit: made.commit })
      assert.deepEqual(logs.api, [], 'no check needed')
      assert.equal(logs.archives.length, 1)
    })
  })

  test('a passed check lasts a few minutes, and a token is remembered only by its hash', async () => {
    const time = clock()
    const copies = createRepositoryCopyStore({ now: time.now })
    const download = async () => ({ files: new Map([['a.ts', 'x']]), leftOut: new Map(), folders: new Set(), bytes: 1 })
    let checks = 0
    const checkAccess = async () => void checks++
    const ensure = (credential) => copies.ensureCopy({ repositoryKey: 'github|x|acme/app', commit: 'c1', credential, download, checkAccess })
    await (await ensure(credentialHash('token-a'))).settled
    assert.equal((await ensure(credentialHash('token-b'))).state, 'ready')
    assert.equal(checks, 1)
    time.advance(4 * 60_000)
    await ensure(credentialHash('token-b'))
    assert.equal(checks, 1, 'still within a few minutes')
    time.advance(2 * 60_000)
    await ensure(credentialHash('token-b'))
    assert.equal(checks, 2, 'asked again after five minutes')
    assert.match(credentialHash('token-a'), /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(copies.stats()).includes('token-a'), 'never the token itself')
    assert.equal(credentialHash(null), null, 'no token, no hash')
  })
})

describe('memory stays within its limits', () => {
  const copyOf = (bytes) => async () => ({ files: new Map([['f.ts', 'x'.repeat(bytes)]]), leftOut: new Map(), folders: new Set(), bytes })
  const ensure = (copies, commit, bytes) => copies.ensureCopy({ repositoryKey: 'github|x|acme/app', commit, credential: null, download: copyOf(bytes), checkAccess: async () => {} }).then((h) => h.settled ?? h)

  test('all copies together stay within the total; the least recently used goes first', async () => {
    const time = clock()
    const copies = createRepositoryCopyStore({ totalBytes: 1000, perRepositoryBytes: 600, now: time.now })
    await ensure(copies, 'c1', 400)
    time.advance(1000)
    await ensure(copies, 'c2', 400)
    time.advance(1000)
    assert.equal((await ensure(copies, 'c1', 400)).state, 'ready', 'c1 used again, so c2 is now the least recently used')
    time.advance(1000)
    await ensure(copies, 'c3', 400)
    assert.deepEqual(copies.stats().copies.map((c) => c.key.split('\n')[1]), ['c1', 'c3'])
    assert.equal(copies.stats().heldBytes, 800)
    assert.ok(copies.stats().heldBytes <= 1000)
  })

  // A download the test finishes by hand: `finish(bytes)` makes it a copy of that size.
  function heldDownload() {
    let finish
    const done = new Promise((resolve) => (finish = resolve))
    const download = async (work) => {
      download.work = work
      const bytes = await done
      return { files: new Map([['f.ts', 'x'.repeat(bytes)]]), leftOut: new Map(), folders: new Set(), bytes }
    }
    download.finish = finish
    return download
  }
  const booksBalance = (copies) => {
    const { heldBytes, copies: held } = copies.stats()
    assert.equal(heldBytes, held.reduce((sum, c) => sum + c.bytes, 0), 'what the store counts is what it holds')
  }

  test('a copy dropped while a caller\'s access check is under way is not put back behind the store\'s back', async () => {
    const copies = createRepositoryCopyStore({ totalBytes: 100, perRepositoryBytes: 80 })
    await copies.ensureCopy({ repositoryKey: 'github|x|acme/app', commit: 'a', credential: credentialHash(TOKEN), download: copyOf(80), checkAccess: async () => {} }).then((h) => h.settled)
    // A caller whose check of copy a takes a while (a slow Provider), with a token the copy was not made with.
    let passCheck
    const checking = copies.ensureCopy({ repositoryKey: 'github|x|acme/app', commit: 'a', credential: credentialHash(OTHER), download: copyOf(80), checkAccess: () => new Promise((resolve) => (passCheck = resolve)) })
    await pause(0)
    // Meanwhile another copy needs the room, and a goes.
    await ensure(copies, 'b', 80)
    assert.deepEqual(copies.stats().copies.map((c) => c.key.split('\n')[1]), ['b'])
    passCheck()
    const handle = await checking
    assert.equal(handle.state, 'ready', 'the caller still gets the copy it was admitted to, this once')
    assert.deepEqual(copies.stats().copies.map((c) => c.key.split('\n')[1]), ['b'], 'but it is not held again')
    booksBalance(copies)
    assert.ok(copies.stats().heldBytes <= 100)
  })

  test('a download under way takes its room in the total before it starts, so copies and downloads together stay within it', async () => {
    const copies = createRepositoryCopyStore({ totalBytes: 300, perRepositoryBytes: 100 })
    await ensure(copies, 'old', 60)
    const downloads = [heldDownload(), heldDownload(), heldDownload()]
    const start = (commit, download, who) => copies.ensureCopy({ repositoryKey: 'github|x|acme/app', commit, credential: credentialHash(who), download, checkAccess: async () => {} })
    assert.equal((await start('c1', downloads[0], 'a')).state, 'preparing')
    assert.equal((await start('c2', downloads[1], 'b')).state, 'preparing')
    assert.equal(copies.stats().reservedBytes, 200)
    assert.equal(copies.stats().heldBytes, 60, 'the old copy still fits')
    assert.equal((await start('c3', downloads[2], 'c')).state, 'preparing')
    assert.deepEqual(copies.stats().copies, [], 'the least recently used copy went, to make room for the third')
    assert.equal(downloads[0].work.archiveLimitBytes, 100, 'an archive is held to the per-repository limit, not the total')

    assert.deepEqual(await start('c4', heldDownload(), 'd'), { state: 'unavailable', reason: 'busy' }, 'no room for a fourth: read file by file this time')
    assert.equal(copies.stats().preparing.length, 3)

    downloads[0].finish(40)
    await (await start('c1', downloads[0], 'a')).settled
    assert.equal(copies.stats().reservedBytes, 200, 'a finished download gives back its room')
    assert.equal(copies.stats().heldBytes, 40, 'and holds only what it is')
    booksBalance(copies)
    assert.equal((await start('c4', heldDownload(), 'd')).state, 'preparing', 'busy is not remembered: once there is room, it starts')
  })

  test('one caller has at most two downloads under way at once', async () => {
    const copies = createRepositoryCopyStore({ totalBytes: 1000, perRepositoryBytes: 100 })
    const start = (commit, who) => copies.ensureCopy({ repositoryKey: 'github|x|acme/app', commit, credential: who ? credentialHash(who) : null, download: heldDownload(), checkAccess: async () => {} })
    assert.equal((await start('c1', 'a')).state, 'preparing')
    assert.equal((await start('c2', 'a')).state, 'preparing')
    assert.deepEqual(await start('c3', 'a'), { state: 'unavailable', reason: 'busy' })
    assert.equal((await start('c3', 'b')).state, 'preparing', 'another caller is not held up by them')
    assert.equal((await start('c4', null)).state, 'preparing')
    assert.equal((await start('c5', null)).state, 'preparing')
    assert.deepEqual(await start('c6', null), { state: 'unavailable', reason: 'busy' }, 'every caller with no token counts as one')
  })

  test('one repository over the per-repository limit is not copied, and is not tried again on every read', async () => {
    const copies = createRepositoryCopyStore({ totalBytes: 1000, perRepositoryBytes: 300 })
    let downloads = 0
    const tooBig = async ({ limitBytes }) => {
      downloads++
      assert.equal(limitBytes, 300)
      throw new CopyTooBigError()
    }
    const ask = (commit) => copies.ensureCopy({ repositoryKey: 'k', commit, credential: null, download: tooBig, checkAccess: async () => {} }).then((h) => h.settled ?? h)
    assert.deepEqual(await ask('c1'), { state: 'unavailable', reason: 'too-big' })
    assert.deepEqual(await ask('c2'), { state: 'unavailable', reason: 'too-big' }, 'nor at its next commit')
    assert.equal(downloads, 1)
    assert.deepEqual((await ensure(copies, 'x', 301)).state, 'unavailable', 'a download that turns out bigger than the limit is not kept')
  })

  test('a copy unused for its idle lifetime is dropped', async () => {
    const time = clock()
    const copies = createRepositoryCopyStore({ idleMs: 2 * 60 * 60_000, now: time.now })
    await ensure(copies, 'c1', 10)
    time.advance(60 * 60_000)
    await ensure(copies, 'c2', 10)
    time.advance(60 * 60_000 + 1)
    copies.sweep()
    assert.deepEqual(copies.stats().copies.map((c) => c.key.split('\n')[1]), ['c2'], 'c1 went unused for two hours')
    time.advance(60 * 60_000)
    copies.sweep()
    assert.deepEqual(copies.stats().copies, [])
    assert.equal(copies.stats().heldBytes, 0)
  })

  test('with no memory for copies at all, every read is file by file, and a search says so', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies: createRepositoryCopyStore({ totalBytes: 0 }) })
      const found = await reader.search({ query: 'orderservice' })
      assert.deepEqual(found.matches, [{ path: 'src/orders/service.ts', line: 1, text: 'export class OrderService {' }])
      assert.equal(found.notCopied.reason, 'off')
      assert.deepEqual(logs.archives, [])
    })
  })

  test('a download under way says how much it has received, and the next caller joins it', () => {
    const { server, logs } = archivingGitHub({ archiveDelayMs: 300 })
    return withFake(server, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies })
      const first = await reader.prepare()
      assert.equal(first.state, 'preparing')
      await pause(150)
      const during = await reader.prepare()
      assert.equal(during.state, 'preparing')
      assert.ok(during.receivedBytes > 0, `some bytes received (${during.receivedBytes})`)
      assert.equal(copies.stats().preparing.length, 1)
      const read = await reader.read({ path: 'README.md' })
      assert.equal(read.text, CODE['README.md'])
      assert.equal((await reader.prepare()).state, 'ready')
      assert.equal(logs.archives.length, 1)
      assert.equal((await reader.prepare({ waitMs: 10 })).state, 'ready')
    })
  })
})

describe('every Provider\'s archive, and what happens without one', () => {
  test('GitLab, Azure DevOps and Bitbucket each give their archive; the top-level folder is stripped (Azure DevOps has none)', async () => {
    for (const [fake, apiRoot, repository, options] of [
      [(log) => createFakeGitLabServer({ namespace: 'acme/payments', repository: 'billing-api', validPat: TOKEN, files: CODE, archives: true, archiveLog: log }), '/api/v4', (baseUrl) => ({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api', baseUrl }, branch: 'main' }), () => ({})],
      [(log) => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE, archives: true, archiveLog: log }), '', (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl }, branch: 'main' }), () => ({})],
      [(log) => createFakeBitbucketServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, archives: true, archiveLog: log }), '/2.0', () => ({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }), (baseUrl) => ({ clientBaseUrl: baseUrl })],
    ]) {
      const log = []
      await withFake(fake(log), async (baseUrl) => {
        const reader = createRepositoryReader(repository(baseUrl), TOKEN, { allowBaseUrl: true, copies: createRepositoryCopyStore(), ...options(baseUrl) })
        const found = await reader.search({ query: 'orders' })
        const provider = repository(baseUrl).provider
        assert.equal(found.notCopied, undefined, provider)
        assert.deepEqual(found.matches.map((m) => m.path), ['README.md', 'src/orders/service.ts', 'src/orders/service.ts', 'src/payments/retry.ts'], provider)
        assert.deepEqual((await reader.find({ pattern: '*.tf' })).paths, ['infra/main.tf', 'infra/network.tf'], provider)
        assert.equal((await reader.read({ path: 'src/orders/limits.ts' })).text, CODE['src/orders/limits.ts'], provider)
        assert.equal(log.length, 1, `${provider}: one archive`)
      }, apiRoot)
    }
  })

  test('too big for a copy, narrowed to folders on GitLab or Azure DevOps: copied for those folders only', async () => {
    const PADDED = { ...CODE, 'docs/handbook.md': 'A long handbook outside the folders.\n'.repeat(70) }
    for (const [fake, apiRoot, repository] of [
      [(log) => createFakeGitLabServer({ namespace: 'acme/payments', repository: 'billing-api', validPat: TOKEN, files: PADDED, archives: true, archiveLog: log }), '/api/v4', (baseUrl) => ({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api', baseUrl }, branch: 'main', folders: ['src/orders', 'infra'] })],
      [(log) => createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: PADDED, archives: true, archiveLog: log }), '', (baseUrl) => ({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl }, branch: 'main', folders: ['src/orders', 'infra'] })],
    ]) {
      const log = []
      await withFake(fake(log), async (baseUrl) => {
        // The whole repository's text is about 3,000 bytes; the two folders' about 300 (their archives, with a zip's own overhead, about 800).
        const copies = createRepositoryCopyStore({ perRepositoryBytes: 1500 })
        const reader = createRepositoryReader(repository(baseUrl), TOKEN, { allowBaseUrl: true, copies })
        const provider = repository(baseUrl).provider
        const found = await reader.search({ query: 'billing' })
        assert.equal(found.notCopied, undefined, `${provider}: copied, for the folders`)
        assert.deepEqual(found.matches.map((m) => m.path), ['infra/main.tf', 'infra/network.tf'], provider)
        assert.deepEqual((await reader.search({ query: 'settled' })).matches.map((m) => m.path), ['src/orders/service.ts'], provider)
        assert.deepEqual((await reader.list()).entries.map((e) => e.path), ['infra', 'src'], provider)
        assert.deepEqual(log.map((entry) => entry.path), [null, 'infra', 'src/orders'], `${provider}: the whole repository, found too big, then each folder`)
        assert.deepEqual(copies.stats().copies.map((c) => c.key.split('\n').slice(2)), [['infra', 'src/orders']], `${provider}: one copy, of the two folders`)
      }, apiRoot)
    }
  })

  test('too big, on a Provider that can\'t download a folder: read file by file, and the AI is told to narrow', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl, { folders: ['src'] }), TOKEN, { allowBaseUrl: true, copies: createRepositoryCopyStore({ perRepositoryBytes: 100 }) })
      const found = await reader.search({ query: 'orders' })
      assert.deepEqual(found.matches, [
        { path: 'src/orders/limits.ts' },
        { path: 'src/orders/service.ts' },
        { path: 'src/orders/service.ts', line: 1, text: 'export class OrderService {' },
        { path: 'src/orders/service.ts', line: 2, text: '// Orders are settled nightly.' },
        { path: 'src/payments/retry.ts', line: 2, text: '// Orders retry three times.' },
      ], 'as file by file has always searched: file names too')
      assert.equal(found.notCopied.reason, 'too-big')
      assert.equal(found.notCopied.message, 'acme/billing-api is too big for Gantry to copy for searching (over 0 MB of text), so it was read file by file, and a search may stop before it has seen every file. Search within a folder (path) to cover all of it.')
      assert.ok(logs.files.length > 0, 'file by file')
      const findings = await reader.find({ pattern: '*.ts' })
      assert.equal(findings.notCopied.reason, 'too-big')
      assert.deepEqual(findings.paths, ['src/orders/limits.ts', 'src/orders/service.ts', 'src/payments/retry.ts'])
      assert.equal(logs.archives.length, 1, 'found too big once, not tried again')
    })
  })

  test('a download that can\'t be made (the host blocked, or refused) falls back to file by file without fuss', async () => {
    // A Provider whose archive address is never reached, as when codeload.github.com isn't allowed outbound.
    const blocked = createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE })
    await withFake(blocked, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies })
      const found = await reader.search({ query: 'orderservice' })
      assert.deepEqual(found.matches, [{ path: 'src/orders/service.ts', line: 1, text: 'export class OrderService {' }])
      assert.equal(found.notCopied.reason, 'unavailable')
      assert.match(found.notCopied.message, /^Gantry couldn't download a copy of acme\/billing-api, so it was read file by file/)
      assert.equal((await reader.read({ path: 'src/orders/limits.ts', lines: '1' })).text, 'export const MAX_ORDER_NZD = 5000')
      assert.equal((await reader.search({ query: 'MAX_\\w+', regex: true, context: 1 })).matches[0].text, 'export const MAX_ORDER_NZD = 5000', 'a regular expression works file by file too')
    })
    // Bitbucket's web host refusing the token.
    const log = []
    await withFake(createFakeBitbucketServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE, archives: true, archiveAuth: false, archiveLog: log }), async (baseUrl) => {
      const reader = createRepositoryReader({ provider: 'atlassian', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }, TOKEN, { clientBaseUrl: baseUrl, copies: createRepositoryCopyStore() })
      assert.equal((await reader.read({ path: 'README.md' })).text, CODE['README.md'])
      assert.equal((await reader.search({ query: 'orders' })).notCopied.reason, 'unavailable')
      assert.deepEqual(log, [])
    }, '/2.0')
  })

  // #338: an egress firewall that drops the connection rather than refusing it costs about ten seconds a try. The archive is tried once,
  // not again after a temporary failure, and an archive host that couldn't be reached is remembered for everyone, not per caller.
  test('an archive host that can\'t be reached is tried once, and not again for a while by anyone', async () => {
    const { server, logs } = archivingGitHub({ validPat: [TOKEN, OTHER] })
    const realFetch = globalThis.fetch
    let archiveTries = 0
    globalThis.fetch = (url, init) => {
      if (/\/zipball\//.test(String(url))) {
        archiveTries++
        return Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }))
      }
      return realFetch(url, init)
    }
    try {
      await withFake(server, async (baseUrl) => {
        const copies = createRepositoryCopyStore()
        const reader = (pat) => createRepositoryReader(github(baseUrl), pat, { allowBaseUrl: true, copies, retries: 2, retryWaitMs: 0 })
        assert.equal((await reader(TOKEN).search({ query: 'orders' })).notCopied.reason, 'unavailable')
        assert.equal(archiveTries, 1, 'not asked again after the first failure')
        assert.equal((await reader(OTHER).search({ query: 'orders' })).notCopied.reason, 'unavailable')
        assert.equal(archiveTries, 1, 'a colleague is not made to wait for it again')
        assert.deepEqual(logs.archives, [])
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a search read file by file stops at its time limit counted from when the request arrived, not from when the search began', () => {
    const { server } = archivingGitHub({ contentDelayMs: 200 })
    return withFake(server, async (baseUrl) => {
      const reader = createRepositoryReader(github(baseUrl), TOKEN, { allowBaseUrl: true, copies: createRepositoryCopyStore({ totalBytes: 0 }), searchTimeLimitMs: 1000 })
      const started = Date.now()
      const found = await reader.search({ query: 'orders', startedAt: Date.now() - 900 })
      assert.equal(found.truncatedBy, 'time-limit')
      assert.ok(Date.now() - started < 600, `answered within what was left of the limit (${Date.now() - started} ms)`)
    })
  })

  test('the errors of #325 and #336 are unchanged with a copy store: rate-limited, no access, no such branch', () => {
    const { server } = archivingGitHub({ anonymousRead: true, apiRequestLimit: 2 })
    return withFake(server, async (baseUrl) => {
      const copies = createRepositoryCopyStore()
      await assert.rejects(createRepositoryReader(github(baseUrl, { branch: 'nope' }), TOKEN, { allowBaseUrl: true, copies }).read({ path: 'README.md' }), (err) => err.code === 'no-branch')
      await assert.rejects(createRepositoryReader(github(baseUrl), 'wrong', { allowBaseUrl: true, copies }).search({ query: 'orders' }), (err) => err.code === 'no-access')
      await assert.rejects(createRepositoryReader(github(baseUrl), null, { allowBaseUrl: true, copies }).search({ query: 'orders' }), (err) => {
        assert.equal(err.code, 'rate-limited')
        assert.match(err.message, /limit is used up until 08:00 UTC/)
        return true
      })
    })
  })
})

describe('the copy behind POST /api/sources/repository', () => {
  test('find, a regular-expression search with context, and a line-range read go through the route, from the server\'s one copy', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, (codeBase) =>
      withRunningServer({ allowGitHubBaseUrlOverride: true }, async (base) => {
        const ask = async (body) => {
          const res = await fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body: JSON.stringify({ repository: github(codeBase), ...body }) })
          assert.equal(res.status, 200, await res.clone().text())
          return res.json()
        }
        assert.deepEqual((await ask({ action: 'find', pattern: '**/*.tf' })).paths, ['infra/main.tf', 'infra/network.tf'])
        const searched = await ask({ action: 'search', query: 'retry\\w*', regex: true, context: 1, fileTypes: ['ts'] })
        assert.deepEqual(searched.matches.map((m) => [m.path, m.line, m.before.length, m.after.length]), [['src/payments/retry.ts', 1, 0, 1], ['src/payments/retry.ts', 2, 1, 1]])
        assert.equal(searched.totalMatches, 2)
        const read = await ask({ action: 'read', path: 'src/orders/service.ts', lines: '2-2' })
        assert.equal(read.text, '  // Orders are settled nightly.')
        assert.equal((await ask({ action: 'list', path: 'src' })).total, 2)
        assert.equal(logs.archives.length, 1, 'every request shares the server\'s copy')
        assert.deepEqual(logs.files, [])
      })
    )
  })

  // #338: a proxy in front of Gantry (a Cloudflare Tunnel gives up at 100 seconds, others sooner) never sees a request held for a download.
  test('a copy slower to download than the route waits is answered "preparing", 202, and a later identical request picks up the same download', () => {
    const { server, logs } = archivingGitHub({ archiveDelayMs: 600 })
    return withFake(server, (codeBase) =>
      withRunningServer({ allowGitHubBaseUrlOverride: true, repositoryPreparingWaitMs: 50 }, async (base) => {
        const ask = async (body) => {
          const started = Date.now()
          const res = await fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body: JSON.stringify({ repository: github(codeBase), ...body }) })
          return { status: res.status, body: await res.json(), took: Date.now() - started }
        }
        const first = await ask({ action: 'search', query: 'orders' })
        assert.equal(first.status, 202, JSON.stringify(first.body))
        assert.equal(first.body.preparing, true)
        assert.equal(first.body.repository, 'acme/billing-api', 'named for the thread, with nothing of the token')
        assert.equal(typeof first.body.receivedBytes, 'number')
        assert.ok(first.body.commit, 'the commit it is preparing')
        assert.ok(first.took < 400, `answered without waiting for the download (${first.took} ms)`)

        let answer = first
        for (let tries = 0; answer.status === 202 && tries < 40; tries++) {
          await pause(50)
          answer = await ask({ action: 'search', query: 'orders' })
          assert.ok(answer.took < 400, `no request is held for the download (${answer.took} ms)`)
        }
        assert.equal(answer.status, 200)
        assert.ok(answer.body.totalMatches > 0)
        assert.equal(answer.body.commit, first.body.commit)
        assert.equal(logs.archives.length, 1, 'every request joined the one download')
        assert.deepEqual(logs.files, [])
      })
    )
  })

  test('"prepare" starts the download and answers at once, without waiting for it; asked again it says how it stands', () => {
    const { server, logs } = archivingGitHub({ archiveDelayMs: 300 })
    return withFake(server, (codeBase) =>
      withRunningServer({ allowGitHubBaseUrlOverride: true }, async (base) => {
        const ask = async (body) => {
          const res = await fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body: JSON.stringify({ repository: github(codeBase), ...body }) })
          assert.equal(res.status, 200)
          return res.json()
        }
        const started = Date.now()
        const prepared = await ask({ action: 'prepare' })
        assert.ok(Date.now() - started < 250, 'answered before the download is done')
        assert.equal(prepared.state, 'preparing')
        await pause(500)
        assert.equal((await ask({ action: 'prepare' })).state, 'ready')
        assert.equal((await ask({ action: 'read', path: 'README.md' })).text, CODE['README.md'])
        assert.equal(logs.archives.length, 1)
      })
    )
  })

  test('GANTRY_REPOSITORY_COPY_MEMORY_MB=0 keeps no copies: the route reads file by file', () => {
    const { server, logs } = archivingGitHub()
    return withFake(server, (codeBase) =>
      withRunningServer({ allowGitHubBaseUrlOverride: true, env: { GANTRY_REPOSITORY_COPY_MEMORY_MB: '0' } }, async (base) => {
        const res = await fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body: JSON.stringify({ action: 'search', repository: github(codeBase), query: 'orderservice' }) })
        const found = await res.json()
        assert.equal(found.notCopied.reason, 'off')
        assert.deepEqual(logs.archives, [])
      })
    )
  })
})

describe('unpacking an archive', () => {
  test('strips the top-level folder, leaves out what Gantry never reads, and puts a folder archive\'s relative paths back under it', () => {
    const store = new Map(Object.entries(CODE).map(([path, content]) => [path, Buffer.isBuffer(content) ? content : Buffer.from(content)]))
    const whole = unpackRepositoryArchive(zipOfFiles(store, { top: 'acme-billing-api-abc1234' }), { provider: 'github' })
    assert.deepEqual([...whole.files.keys()].sort(), ['infra/main.tf', 'infra/network.tf', 'README.md', 'src/orders/limits.ts', 'src/orders/service.ts', 'src/payments/retry.ts'].sort())
    assert.deepEqual([...whole.leftOut].map(([path, why]) => [path, why.reason]).sort(), [['assets/video.mp4.txt', 'lfs'], ['tools/blob.dat2', 'binary']])
    const big = unpackRepositoryArchive(zipOfFiles(new Map([['big.txt', Buffer.alloc(1024 * 1024 + 1, 'a')]]), { top: 'x' }), { provider: 'gitlab' })
    assert.deepEqual(big.leftOut.get('big.txt'), { reason: 'too-large', size: 1024 * 1024 + 1 })
    const relative = unpackRepositoryArchive(zipOfFiles(store, { folder: 'src/orders', relative: true }), { provider: 'azure-devops', folder: 'src/orders' })
    assert.deepEqual([...relative.files.keys()].sort(), ['src/orders/limits.ts', 'src/orders/service.ts'])
    const azure = unpackRepositoryArchive(zipOfFiles(new Map([['src/a.ts', Buffer.from('a')]])), { provider: 'azure-devops' })
    assert.deepEqual([...azure.files.keys()], ['src/a.ts'], 'Azure DevOps has no top-level folder to strip, even when everything sits in one folder')
    assert.throws(() => unpackRepositoryArchive(zipOfFiles(store, { top: 'x' }), { provider: 'github', limitBytes: 50 }), CopyTooBigError)
  })

  test('name patterns', () => {
    assert.equal(namePatternTest('**/*.tf')('infra/main.tf'), true)
    assert.equal(namePatternTest('**/*.tf')('main.tf'), true)
    assert.equal(namePatternTest('src/**/order*')('src/a/b/orders.ts'), true)
    assert.equal(namePatternTest('src/**/order*')('lib/orders.ts'), false)
    assert.equal(namePatternTest('*.TS')('src/a.ts'), true, 'case is ignored')
    assert.equal(namePatternTest('a.b')('aXb'), false, 'a dot is a dot')
  })
})
