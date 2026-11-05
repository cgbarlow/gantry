import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPOSITORY_LINKS_FILENAME,
  cleanRepositoryPath,
  isRepositorySource,
  normalizeSourceRepository,
  parseSourceAddress,
  repositoryCitationQuery,
  repositoryKey,
  repositoryLinksText,
  repositoryWebAddress,
  skippedRepositoryPath,
  withinRepositoryFolders,
} from '../web/lib/sourceRepository.js'
import { SourceDocumentError, createSourceStore, parseSourceManifest, stringifySourceManifest } from '../web/lib/sourceDocuments.js'
import { buildSourceAppendix, citedCommits, citedSourceIds, findSourceCitations, recitedMarkdown, sourceCitationFor, sourceCitationsForWord } from '../web/lib/sourceCitations.js'
import { citedSourceIds as draftCitedSourceIds, citationSegments } from '../web/lib/interviewDraft.js'
import { findOutOfDateFields, outOfDateBannerLines, outOfDateFieldNote, repositoryReadsOf, uncheckedRepositoryLine } from '../web/lib/outOfDate.js'
import { describeOutOfDate } from '../lib/outOfDateServer.js'
import { loadOutOfDate } from '../web/lib/outOfDateLoad.js'
import { describeInput, inputsForDraft, planSourceAccess, runRepositoryCall } from '../web/lib/interviewSources.js'
import { buildInterviewBrief } from '../web/lib/interviewBrief.js'
import { applyDecisionsDelta, emptyDecisionsLog } from '../web/lib/decisionsLog.js'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'
import { readFileSync } from 'node:fs'
import { repositoryReaderFor } from '../web/lib/sourceRepositoryClient.js'

const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, new URL('../web/interview-skills/', import.meta.url)), 'utf8'))

// #319 (docs/adr/0072): a code repository is a Source document that points at a Provider repository and branch. These are the pure parts:
// the pointer, the paths always skipped, its web addresses, the citation with a path and a commit, the store, the Sources appendix, the links
// file, the AI's tools and inputs, and Out of date's comparison of the files a Field drew on.

const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'
const OLD = '0ld0ld1234567890abcdef1234567890abcdef12'
const pointer = (extra = {}) => ({ provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main', ...extra })

// The tiny file interface the store is written against, in memory.
function memoryIo() {
  const files = new Map()
  return {
    files,
    async readText(path) {
      return files.has(path) ? { text: files.get(path), version: files.get(path) } : null
    },
    async readBytes(path) {
      return files.has(path) ? files.get(path) : null
    },
    async writeText(path, text, { ifVersion } = {}) {
      if (ifVersion !== undefined && (files.get(path) ?? null) !== ifVersion) throw Object.assign(new Error('moved'), { code: 'STORAGE_CONFLICT' })
      files.set(path, text)
    },
    async writeBytes(path, bytes) {
      files.set(path, bytes)
    },
    async remove(path) {
      files.delete(path)
    },
  }
}

describe('the pointer', () => {
  test('is a Provider, a location in the shape a workspace takes, a branch and optional folders, keys in a fixed order', () => {
    assert.deepEqual(normalizeSourceRepository({ folders: ['src/', './infra', 'src'], branch: ' main ', location: { repository: 'billing-api', owner: 'acme', project: 'stray' }, provider: 'github' }), {
      provider: 'github',
      location: { owner: 'acme', repository: 'billing-api' },
      branch: 'main',
      folders: ['src', 'infra'],
    })
    assert.deepEqual(normalizeSourceRepository({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl: 'https://ado.internal/tfs' }, branch: 'develop' }).location, {
      organization: 'contoso',
      project: 'Payments',
      repository: 'billing',
      baseUrl: 'https://ado.internal/tfs',
    })
    assert.deepEqual(normalizeSourceRepository({ provider: 'atlassian', location: { owner: 'acme', repository: 'web', jiraSite: 'x', baseUrl: 'y' }, branch: 'main' }).location, { owner: 'acme', repository: 'web' }, 'Bitbucket is Cloud-only and needs no Jira half')
    assert.equal(normalizeSourceRepository({ provider: 'github', location: { owner: 'acme' }, branch: 'main' }), null)
    assert.equal(normalizeSourceRepository({ provider: 'svn', location: { repository: 'x' }, branch: 'main' }), null)
    assert.equal(normalizeSourceRepository({ ...pointer(), branch: '' }), null)
    assert.equal(isRepositorySource({ id: 'x', filename: 'brief.docx' }), false)
    assert.equal(isRepositorySource({ id: 'x', repository: pointer() }), true)
  })

  test('a path is plain and never climbs out', () => {
    assert.equal(cleanRepositoryPath('/src//orders/./service.ts/'), 'src/orders/service.ts')
    assert.equal(cleanRepositoryPath('src\\orders'), 'src/orders')
    assert.equal(cleanRepositoryPath('../etc/passwd'), null)
  })

  test('vendored code, build output and binaries are always skipped', () => {
    for (const path of ['node_modules/x/index.js', 'web/vendor/lib.js', 'dist/app.js', 'build/out.js', 'api/bin/Debug/app.dll', 'target/classes/A.class', '.git/config', 'app/__pycache__/x.pyc']) {
      assert.equal(skippedRepositoryPath(path), 'vendored code or build output', path)
    }
    for (const path of ['docs/logo.png', 'fonts/a.woff2', 'release.zip', 'web/app.min.js', 'web/app.js.map', 'docs/Spec.pdf']) assert.equal(skippedRepositoryPath(path), 'a binary file', path)
    for (const path of ['src/orders/service.ts', 'infra/main.tf', 'README.md', 'Dockerfile', 'build.gradle', 'distribution/notes.md']) assert.equal(skippedRepositoryPath(path), null, path)
  })

  test('folders narrow what is read, and the folders on the way down to them can be listed', () => {
    const narrowed = pointer({ folders: ['services/orders'] })
    assert.equal(withinRepositoryFolders(narrowed, 'services/orders/a.ts'), true)
    assert.equal(withinRepositoryFolders(narrowed, 'services/payments/a.ts'), false)
    assert.equal(withinRepositoryFolders(narrowed, 'services', { orAbove: true }), true)
    assert.equal(withinRepositoryFolders(narrowed, '', { orAbove: true }), true)
    assert.equal(withinRepositoryFolders(pointer(), 'anything/at/all'), true)
  })

  test('the token is kept under a key of the repository and its Provider host, whatever branch or folders the pointer has', () => {
    assert.equal(repositoryKey(pointer()), repositoryKey(pointer({ branch: 'develop', folders: ['src'] })))
    assert.notEqual(repositoryKey(pointer()), repositoryKey({ ...pointer(), location: { owner: 'acme', repository: 'billing-api', baseUrl: 'https://ghe.internal/api/v3' } }))
  })

  test('opens on each Provider at its branch, or a file as it was at a commit', () => {
    assert.equal(repositoryWebAddress(pointer()), 'https://github.com/acme/billing-api/tree/main')
    assert.equal(repositoryWebAddress(pointer(), { path: 'src/orders/a b.ts', commit: HEAD }), `https://github.com/acme/billing-api/blob/${HEAD}/src/orders/a%20b.ts`)
    assert.equal(repositoryWebAddress({ ...pointer(), location: { owner: 'acme', repository: 'billing-api', baseUrl: 'https://ghe.internal/api/v3' } }), 'https://ghe.internal/acme/billing-api/tree/main')
    assert.equal(
      repositoryWebAddress({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Pay ments', repository: 'billing' }, branch: 'main' }),
      'https://dev.azure.com/contoso/Pay%20ments/_git/billing?version=GBmain'
    )
    assert.equal(
      repositoryWebAddress({ provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing' }, branch: 'main' }, { path: 'src/a.ts', commit: HEAD }),
      `https://dev.azure.com/contoso/Payments/_git/billing?path=%2Fsrc%2Fa.ts&version=GC${HEAD}`
    )
    assert.equal(repositoryWebAddress({ provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'billing-api' }, branch: 'main' }), 'https://gitlab.com/acme/payments/billing-api/-/tree/main')
    assert.equal(repositoryWebAddress({ provider: 'atlassian', location: { owner: 'acme', repository: 'web' }, branch: 'main' }, { path: 'README.md', commit: HEAD }), `https://bitbucket.org/acme/web/src/${HEAD}/README.md`)
  })
})

describe('citing a repository', () => {
  const cite = `[Billing API, limits](source:billing-api?path=src/orders/limits.ts&commit=${HEAD})`

  test('a citation carries the path and the commit, and every other citation is unchanged', () => {
    assert.equal(repositoryCitationQuery({ path: 'src/a (copy).ts', commit: HEAD }), `?path=src/a%20%28copy%29.ts&commit=${HEAD}`)
    assert.deepEqual(parseSourceAddress(`source:billing-api?path=src/a%20%28copy%29.ts&commit=${HEAD}`), { id: 'billing-api', path: 'src/a (copy).ts', commit: HEAD })
    assert.deepEqual(parseSourceAddress('source:client-brief'), { id: 'client-brief' })
    const text = `Capped at NZD 5,000 ${cite}, per [Client brief, p. 4](source:client-brief).`
    assert.deepEqual(findSourceCitations(text), [
      { id: 'billing-api', text: 'Billing API, limits', path: 'src/orders/limits.ts', commit: HEAD },
      { id: 'client-brief', text: 'Client brief, p. 4' },
    ])
    assert.deepEqual(citedSourceIds(text), ['billing-api', 'client-brief'])
    assert.deepEqual(draftCitedSourceIds(text), ['billing-api', 'client-brief'])
    assert.deepEqual(citationSegments(cite), [{ cite: 'Billing API, limits', id: 'billing-api' }])
    assert.deepEqual(citedCommits(`${text} ${cite}`, 'billing-api'), [HEAD])
    assert.equal(sourceCitationsForWord(text), 'Capped at NZD 5,000 (Billing API, limits), per (Client brief, p. 4).')
    assert.equal(sourceCitationFor({ id: 'billing-api', title: 'Billing API' }, { path: 'src/orders/limits.ts', commit: HEAD }), `[Billing API, src/orders/limits.ts](source:billing-api?path=src/orders/limits.ts&commit=${HEAD})`)
    assert.equal(sourceCitationFor({ id: 'client-brief', title: 'Client brief' }), '[Client brief](source:client-brief)')
    assert.equal(recitedMarkdown(cite, 'billing-api', { id: 'billing-v2', title: 'Billing v2' }), '[Billing v2](source:billing-v2)')
  })

  test('the Sources appendix gives a repository its title, address, branch and the commits cited', () => {
    const entries = [
      { id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository: pointer() },
      { id: 'client-brief', title: 'Client brief', filename: 'brief.docx', uploadedAt: '2026-03-04T00:00:00.000Z' },
    ]
    const appendix = buildSourceAppendix(`${cite} and [Billing API](source:billing-api?path=README.md&commit=${OLD}) and [b](source:client-brief)`, entries)
    assert.equal(
      appendix,
      '# Sources\n\n| Document | File | Added |\n| --- | --- | --- |\n| Billing API | https://github.com/acme/billing-api/tree/main | branch main, commits c0ffee1, 0ld0ld1 |\n| Client brief | brief.docx | 4 Mar 2026 |\n'
    )
  })

  test('Download all adds a links file of each repository, its branch and the commits cited, never the code', () => {
    const text = repositoryLinksText([{ id: 'billing-api', title: 'Billing API', repository: pointer({ folders: ['src'] }) }, { id: 'brief', filename: 'brief.docx' }], () => [HEAD])
    assert.equal(REPOSITORY_LINKS_FILENAME, 'Code repositories.txt')
    assert.match(text, /^Billing API \(GitHub, acme\/billing-api\)$/m)
    assert.match(text, /^ {2}Address: https:\/\/github\.com\/acme\/billing-api\/tree\/main$/m)
    assert.match(text, /^ {2}Branch: main$/m)
    assert.match(text, /^ {2}Folders: src$/m)
    assert.match(text, new RegExp(`^  Commits cited: ${HEAD}$`, 'm'))
    assert.equal(repositoryLinksText([{ id: 'brief', filename: 'brief.docx' }]), '')
  })
})

describe('the store keeps the pointer and nothing else', () => {
  test('adds, renames and removes a pointer, writing only the manifest; kept files behave as before beside it', async () => {
    const io = memoryIo()
    const store = createSourceStore(io, { now: () => '2026-11-04T09:00:00.000Z' })
    const { entry } = await store.addRepository({ repository: pointer({ folders: ['src'] }), uploadedBy: 'a.architect' })
    assert.deepEqual(entry, { id: 'billing-api', title: 'billing-api', uploadedBy: 'a.architect', uploadedAt: '2026-11-04T09:00:00.000Z', repository: pointer({ folders: ['src'] }) })
    assert.deepEqual([...io.files.keys()], ['sources/manifest.yaml'])
    assert.equal((await store.addRepository({ repository: pointer(), title: 'Second' })).entry.id, 'billing-api-2')
    await assert.rejects(store.addRepository({ repository: { provider: 'github', location: {} } }), /needs its Provider, its location/)

    // An upload beside it still gets its own file and text.
    await store.upload({ filename: 'brief.md', bytes: new TextEncoder().encode('# Brief'), text: '# Brief' })
    assert.deepEqual([...io.files.keys()].sort(), ['sources/.text/brief.md.md', 'sources/brief.md', 'sources/manifest.yaml'])

    assert.equal((await store.rename('billing-api', 'Billing API')).title, 'Billing API')
    await assert.rejects(store.readOriginal('billing-api'), (err) => err instanceof SourceDocumentError && /is a code repository, read live from its Provider: nothing of it is kept here to download/.test(err.message))
    await assert.rejects(store.setText('billing-api', 'x'), /nothing of it is kept here to read again/)
    await assert.rejects(store.fetchAgain('billing-api', { bytes: new Uint8Array([1]) }), /nothing of it is kept here to fetch again/)
    assert.equal(await store.readText('billing-api'), null)
    const removed = await store.remove('billing-api', { removedBy: 'a.architect' })
    assert.equal(removed.removedBy, 'a.architect')
    assert.deepEqual(removed.repository, pointer({ folders: ['src'] }), 'a removed pointer still names its repository')

    const manifest = io.files.get('sources/manifest.yaml')
    assert.deepEqual(parseSourceManifest(manifest).map((e) => e.id), ['billing-api', 'billing-api-2', 'brief'])
    assert.equal(stringifySourceManifest(parseSourceManifest(manifest)), manifest, 'the manifest round-trips byte for byte')
  })
})

describe('the AI reads a repository with tools, and every read names its commit', () => {
  const sources = [{ id: 'billing-api', title: 'Billing API', repository: pointer() }, { id: 'brief', title: 'Client brief', filename: 'brief.md', text: 'Five thousand users.' }]
  const reader = () => ({
    list: async ({ path }) => ({ commit: HEAD, path: path ?? '', entries: [{ path: 'src', isFolder: true }, { path: 'README.md', isFolder: false }] }),
    search: async ({ query }) => ({ commit: HEAD, query, matches: [{ path: 'src/orders/limits.ts', line: 1, text: 'export const MAX_ORDER_NZD = 5000' }], filesSearched: 4, truncated: false }),
    read: async ({ path }) => ({ commit: HEAD, path, text: 'export const MAX_ORDER_NZD = 5000\n' }),
  })
  const lookup = (id) => sources.find((s) => s.id === id)

  test('a repository is read with its own tools, never in the brief', () => {
    assert.deepEqual(planSourceAccess({ sources, provider: { type: 'anthropic' } }).get('billing-api'), { how: 'repository', kind: 'repository' })
    const definition = { stages: [{ id: 's', title: 'S', gate: 'g', modules: ['m'] }], artefacts: [{ id: 'a', gate: 'g', requires: [] }], modules: [{ id: 'm', title: 'M', fields: [{ id: 'f', title: 'F', type: 'markdown' }] }] }
    const brief = buildInterviewBrief({ definition, stageId: 's', artefactId: 'a', sources, skills, readerTool: true })
    assert.match(brief.text, /One Source document is a code repository, read live from its Provider at its branch\. Nothing of it is shown here\./)
    assert.match(brief.text, /- \*\*Billing API\*\* \(id `billing-api`, GitHub repository acme\/billing-api, branch main\)/)
    assert.match(brief.text, /list_repository_folder/)
    assert.doesNotMatch(brief.text, /Billing API.*UNREADABLE/)
    assert.deepEqual(brief.sources.repositories, ['billing-api'])
    assert.match(brief.text, /<source-document id="brief"/, 'the other documents are as before')
  })

  test('list, search and read go back to the AI with the commit, and a read is recorded as an input with its path and commit', async () => {
    const listed = await runRepositoryCall('list_repository_folder', { id: 'billing-api' }, { lookup, reader })
    assert.equal(listed.content, `[Billing API · top of the repository · commit ${HEAD}]\n\n- src/\n- README.md`)
    const found = await runRepositoryCall('search_repository', { id: 'billing-api', query: 'MAX_ORDER' }, { lookup, reader })
    assert.match(found.content, /- src\/orders\/limits\.ts:1: export const MAX_ORDER_NZD = 5000/)
    const read = await runRepositoryCall('read_repository_file', { id: 'billing-api', path: 'src/orders/limits.ts' }, { lookup, reader })
    assert.equal(read.ok, true)
    assert.match(read.content, new RegExp(`Cite it as \\[Billing API, src/orders/limits\\.ts\\]\\(source:billing-api\\?path=src/orders/limits\\.ts&commit=${HEAD}\\)`))
    assert.deepEqual({ ...read.read, fingerprint: undefined }, { source: 'billing-api', title: 'Billing API', range: 'src/orders/limits.ts', path: 'src/orders/limits.ts', commit: HEAD, fingerprint: undefined, chars: 33 })
    assert.equal(describeInput(read.read), 'Billing API (src/orders/limits.ts at c0ffee1)')

    const refused = await runRepositoryCall('read_repository_file', { id: 'billing-api', path: 'node_modules/x.js' }, { lookup, reader: () => ({ read: async () => Promise.reject(new Error('node_modules/x.js is vendored code or build output, which Gantry never reads.')) }) })
    assert.deepEqual(refused, { ok: false, content: 'Billing API: node_modules/x.js is vendored code or build output, which Gantry never reads.' })
    assert.match((await runRepositoryCall('read_repository_file', { id: 'brief', path: 'x' }, { lookup, reader })).content, /is not a code repository/)

    const inputs = inputsForDraft({ reads: [read.read], value: `Capped [Billing API](source:billing-api?path=README.md&commit=${OLD}).`, sources })
    assert.deepEqual(inputs.map((i) => [i.source, i.path, i.commit]), [['billing-api', 'src/orders/limits.ts', HEAD], ['billing-api', 'README.md', OLD]])
  })

  // #335: a search on a big repository, or over a slow link, can stop early. The AI is told it was cut short, why, and what will do better.
  test('a search that was cut short says so, and says how to do better', async () => {
    const cutShort = () => ({ search: async ({ query }) => ({ commit: HEAD, query, matches: [{ path: 'src/orders/limits.ts', line: 1, text: 'export const MAX_ORDER_NZD = 5000' }], filesSearched: 180, truncated: true, truncatedBy: 'time-limit', truncatedReason: 'stopped after 30 seconds, 180 of 400 files searched' }) })
    const found = await runRepositoryCall('search_repository', { id: 'billing-api', query: 'MAX_ORDER' }, { lookup, reader: cutShort })
    assert.equal(found.ok, true)
    assert.match(found.content, /- src\/orders\/limits\.ts:1: export const MAX_ORDER_NZD = 5000/)
    assert.match(
      found.content,
      /\n\n\[This search was cut short \(stopped after 30 seconds, 180 of 400 files searched\), so these are only the matches found so far\. To do better, search under a folder \(with "path"\) or for something more exact, or read a file you expect to matter with `read_repository_file`\.\]$/
    )
    const complete = await runRepositoryCall('search_repository', { id: 'billing-api', query: 'MAX_ORDER' }, { lookup, reader })
    assert.doesNotMatch(complete.content, /cut short/)
  })

  test('the decisions log keeps an input\'s path and commit', () => {
    const log = applyDecisionsDelta(emptyDecisionsLog('s'), { fields: { 'm.f': { drafted: '2026-11-04T09:00:00.000Z', inputs: [{ source: 'billing-api', title: 'Billing API', range: 'src/a.ts', path: 'src/a.ts', commit: HEAD, fingerprint: 'abc' }] } } })
    assert.deepEqual(log.fields['m.f'].inputs, [{ source: 'billing-api', title: 'Billing API', range: 'src/a.ts', path: 'src/a.ts', commit: HEAD, fingerprint: 'abc' }])
  })
})

describe('Out of date for a repository: only a real change to a file a Field drew on flags it', () => {
  const sources = [{ id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-01T00:00:00.000Z', repository: pointer() }]
  const logs = { shape: { stage: 'shape', fields: { 'details.summary': { drafted: '2026-11-02T00:00:00.000Z', inputs: [{ source: 'billing-api', path: 'src/orders/limits.ts', commit: OLD, fingerprint: 'x' }] } }, entries: [] } }
  const modules = [{ id: 'details', fields: [{ id: 'summary', value: 'Capped at NZD 5,000.' }, { id: 'notes', value: `See [Billing API](source:billing-api?path=README.md&commit=${OLD}).` }] }]
  const compared = (changed) => ({ 'billing-api': { head: HEAD, results: [{ path: 'src/orders/limits.ts', commit: OLD, changed: changed.includes('limits'), deleted: false }, { path: 'README.md', commit: OLD, changed: changed.includes('readme'), deleted: false }] } })

  test('the files to compare are what the drafts read and the citations name', () => {
    assert.deepEqual(repositoryReadsOf({ sources, logs, modules }), { 'billing-api': [{ path: 'src/orders/limits.ts', commit: OLD }, { path: 'README.md', commit: OLD }] })
  })

  test('a change to file A flags the Field that drew on A, and not the one that drew only on B', () => {
    const flags = findOutOfDateFields({ sources, logs, modules, repositoryChanges: compared(['limits']) })
    assert.deepEqual(flags.map((f) => [f.field, f.change, f.paths, f.via]), [['details.summary', 'code-changed', ['src/orders/limits.ts'], ['drafted']]])
    assert.equal(outOfDateFieldNote(flags), 'Out of date: src/orders/limits.ts in Billing API changed (now at c0ffee1)')
    assert.equal(outOfDateBannerLines(flags)[0].text, '1 Field drew on Billing API, whose files have since changed')
    assert.deepEqual(findOutOfDateFields({ sources, logs, modules, repositoryChanges: compared([]) }), [], 'a new commit that touches neither flags nothing')
    assert.deepEqual(findOutOfDateFields({ sources, logs, modules }), [], 'nothing compared, nothing said')
    assert.deepEqual(findOutOfDateFields({ sources, logs, modules, repositoryChanges: compared(['readme']) }).map((f) => [f.field, f.via]), [['details.notes', ['cited']]])
  })

  test('the architect\'s answer at the branch head clears it until that file changes again', () => {
    const answered = { shape: { ...logs.shape, entries: [{ id: 'e1', kind: 'source-update', source: 'billing-api', fields: ['details.summary'], paths: ['src/orders/limits.ts'], commit: HEAD, outcome: 'keep', at: '2026-11-04T00:00:00.000Z' }] } }
    assert.deepEqual(repositoryReadsOf({ sources, logs: answered, modules })['billing-api'].map((r) => r.commit), [OLD, HEAD, OLD])
    const sinceAnswer = { 'billing-api': { head: HEAD, results: [...compared(['limits'])['billing-api'].results, { path: 'src/orders/limits.ts', commit: HEAD, changed: false, deleted: false }] } }
    assert.deepEqual(findOutOfDateFields({ sources, logs: answered, modules, repositoryChanges: sinceAnswer }), [])
    const changedAgain = { 'billing-api': { head: 'later', results: [...compared(['limits'])['billing-api'].results, { path: 'src/orders/limits.ts', commit: HEAD, changed: true, deleted: false }] } }
    assert.deepEqual(findOutOfDateFields({ sources, logs: answered, modules, repositoryChanges: changedAgain }).map((f) => f.field), ['details.summary'])
  })

  test('loading asks the comparison only for the files drawn on, and a repository that can\'t be read is left unchecked', async () => {
    const asked = []
    const sourceStore = { list: async () => ({ entries: sources }) }
    const decisionsStore = { read: async (id) => logs[id] }
    const result = await loadOutOfDate({
      sourceStore,
      decisionsStore,
      stages: [{ id: 'shape' }],
      currentStageId: 'shape',
      currentModules: modules,
      loadStageModules: async () => [],
      compareRepository: async (entry, reads) => {
        asked.push([entry.id, reads])
        return compared(['limits'])['billing-api']
      },
    })
    assert.deepEqual(asked, [['billing-api', [{ path: 'src/orders/limits.ts', commit: OLD }, { path: 'README.md', commit: OLD }]]])
    assert.deepEqual(result.flags.map((f) => f.field), ['details.summary'])
    assert.deepEqual(result.unchecked, [])
    const refusal = "You can't read the GitHub repository acme/billing-api without a token. If it is private, give a token that can read it."
    const noAccess = Object.assign(new Error(refusal), { code: 'no-access' })
    const unreadable = await loadOutOfDate({ sourceStore, decisionsStore, stages: [{ id: 'shape' }], currentStageId: 'shape', currentModules: modules, loadStageModules: async () => [], compareRepository: async () => Promise.reject(noAccess) })
    assert.deepEqual(unreadable.flags, [], 'no evidence either way, so nothing is flagged')
    // ...but the architect is told it was not checked, and why, rather than it being skipped in silence.
    assert.deepEqual(unreadable.unchecked, [{ source: 'billing-api', title: sources.find((s) => s.id === 'billing-api').title, code: 'no-access', reason: refusal }])
    const line = uncheckedRepositoryLine(unreadable.unchecked[0])
    assert.match(line, /was not checked for changes, so the Fields that drew on it may be out of date: You can't read the GitHub repository acme\/billing-api without a token\./)
    assert.match(line, /Give a token that can read it with "Your token" on its row in Source documents\./)
    assert.doesNotMatch(uncheckedRepositoryLine({ title: 'Billing API', code: 'server-unreachable', reason: 'The server is down.' }), /Your token/, 'a token is offered only when access is the problem')
    // #325: a used-up rate limit offers a token too, as what raises the limit.
    assert.match(uncheckedRepositoryLine({ title: 'Billing API', code: 'rate-limited', reason: 'GitHub limits how much…' }), /A token given with "Your token" on its row in Source documents raises the limit\.$/)
  })

  // #336: the browser asks the Gantry server to compare once more when the request is cut off; cut off again, nothing is flagged, and the
  // repository is named as not checked, never as changed.
  test('a comparison cut off once is asked again; cut off twice, the repository is "not checked", never "changed"', async () => {
    const sourceStore = { list: async () => ({ entries: sources }) }
    const decisionsStore = { read: async (id) => logs[id] }
    const gantry = (cuts) => {
      let asked = 0
      return async (_url, init) => {
        if (asked++ < cuts) throw new TypeError('Failed to fetch')
        assert.equal(JSON.parse(init.body).action, 'compare')
        return new Response(JSON.stringify(compared(['limits'])['billing-api']), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    const load = (fetchImpl) =>
      loadOutOfDate({ sourceStore, decisionsStore, stages: [{ id: 'shape' }], currentStageId: 'shape', currentModules: modules, loadStageModules: async () => [], compareRepository: (entry, reads) => repositoryReaderFor(entry.repository, { fetchImpl, token: null, retryWaitMs: 0 }).compare(reads) })
    const once = await load(gantry(1))
    assert.deepEqual(once.flags.map((f) => f.field), ['details.summary'])
    assert.deepEqual(once.unchecked, [])
    const twice = await load(gantry(2))
    assert.deepEqual(twice.flags, [], 'no evidence either way, so nothing is flagged')
    assert.deepEqual(twice.unchecked.map((u) => [u.source, u.code]), [['billing-api', 'server-unreachable']])
    assert.match(uncheckedRepositoryLine(twice.unchecked[0]), /^Billing API was not checked for changes/)
  })

  test("over MCP, get_instance's Out of date names a repository it could not compare, with the reason", async () => {
    const definition = { stages: [{ id: 'shape', modules: ['details'] }], modules: new Map([['details', { title: 'Details', fields: [{ id: 'summary', title: 'Summary' }] }]]) }
    const noAccess = Object.assign(new Error("You can't read the Azure DevOps repository acme/Billing/billing-api with the token you gave."), { code: 'no-access' })
    const out = await describeOutOfDate({
      sourceStore: { list: async () => ({ entries: sources }) },
      readLog: async (id) => logs[id],
      definition,
      currentStageId: 'shape',
      readStageModules: async () => modules,
      compareRepository: async () => Promise.reject(noAccess),
    })
    assert.deepEqual(out.fields, [])
    assert.deepEqual(out.uncheckedRepositories, [{ id: 'billing-api', title: sources.find((s) => s.id === 'billing-api').title, reason: noAccess.message }])
    assert.equal(out.summary.length, 1)
    assert.match(out.summary[0], /was not checked for changes.*with the token you gave/)
  })
})
