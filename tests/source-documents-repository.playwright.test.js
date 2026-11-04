import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showFields, showSourcesAndDecisions } from './helpers/referenceView.js'
import { basicAuthHeader, withRunningServer } from './helpers/lifecycle.js'
import { createFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { createFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createFakeGitLabServer } from './helpers/fakeGitLabServer.js'
import { createFakeBitbucketServer } from './helpers/fakeBitbucketServer.js'
import { createInstance } from '../lib/instance.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #319 (docs/adr/0072): browser coverage for **+ Add a code repository** in the Source documents panel and the Interview page's list, on a
// server and a local workspace, with a pointer to each Provider. Fakes stand in for GitHub, Azure DevOps, GitLab and Bitbucket (their
// addresses taken as self-hosted ones, which this server accepts for a workspace). An existing pointer opened by someone without access (a
// teammate, another browser, after storage is cleared) says so, and **Your token** lets them give theirs. Reading the repository is covered
// in tests/repositorySource.test.js, the pure parts in tests/sourceRepository.test.js.

const TOKEN = 'architects-own-token'
const CODE = { 'README.md': '# Billing API\n', 'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 5000\n' }

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors, context)
  } finally {
    await browser.close()
  }
}

// One fake per Provider: a private GitHub repository, a public one, a private Azure DevOps one, a private GitLab one and a private Bitbucket one.
async function withRepositories(fn) {
  const servers = {
    github: createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: CODE }),
    publicGithub: createFakeGitHubServer({ owner: 'acme', repository: 'open-api', validPat: 'nobody', files: CODE, anonymousRead: true }),
    azureDevOps: createFakeAzureDevOpsServer({ organization: 'contoso', project: 'Payments', repository: 'billing', validPat: TOKEN, files: CODE }),
    gitlab: createFakeGitLabServer({ namespace: 'acme/payments', repository: 'ledger', validPat: TOKEN, files: CODE }),
    bitbucket: createFakeBitbucketServer({ owner: 'acme', repository: 'settlements', validPat: TOKEN, files: CODE }),
  }
  const apiRoot = { gitlab: '/api/v4', bitbucket: '/2.0' }
  for (const server of Object.values(servers)) {
    server.keepAliveTimeout = 0
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  }
  try {
    const bases = Object.fromEntries(Object.entries(servers).map(([key, s]) => [key, `http://127.0.0.1:${s.address().port}${apiRoot[key] ?? ''}`]))
    await fn(bases)
  } finally {
    for (const server of Object.values(servers)) server.close()
  }
}

// What a server that reads all four Providers' fakes needs.
const serverOptions = (bases) => ({ allowGitHubBaseUrlOverride: true, allowAzureDevOpsBaseUrlOverride: true, allowGitLabBaseUrlOverride: true, atlassianBitbucketBaseUrl: bases.bitbucket })

const openPanel = async (page) => {
  await showSourcesAndDecisions(page)
  const panel = page.locator('[data-testid="source-documents"]')
  await panel.waitFor({ timeout: 15_000 })
  if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
  return panel
}
const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const messageIn = (scope, pattern) =>
  scope.locator('[data-testid="source-documents-message"]').evaluate(
    (el, source) =>
      new Promise((resolve, reject) => {
        const started = Date.now()
        const tick = () => (new RegExp(source).test(el.textContent ?? '') ? resolve() : Date.now() - started > 20_000 ? reject(new Error(`message was "${el.textContent}", not /${source}/`)) : setTimeout(tick, 50))
        tick()
      }),
    pattern.source
  )
const messageMatches = (page, pattern) => messageIn(page.locator('[data-testid="source-documents"]'), pattern)

// Fills and submits "+ Add a code repository" in `scope` (the panel or the Interview page's list) for any Provider.
async function fillRepository(scope, { provider = 'github', location, token = '', folders = '' }) {
  if ((await scope.locator('[data-testid="source-repository-form"]').count()) === 0) await scope.locator('[data-testid="source-repository-open"]').click()
  const form = scope.locator('[data-testid="source-repository-form"]')
  await form.locator('[data-testid="source-repository-provider"]').selectOption(provider)
  for (const [key, value] of Object.entries(location)) await form.locator(`[data-testid="source-repository-${key}"]`).fill(value)
  await form.locator('[data-testid="source-repository-folders"]').fill(folders)
  await form.locator('[data-testid="source-repository-token"]').fill(token)
  await form.locator('[data-testid="source-repository-add"]').click()
}

test('server workspace: a private repository is added with the architect\'s token, a public one with none, renamed, opened, zipped as links and removed', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-319-e2e-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRepositories((bases) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, ...serverOptions(bases) }, (base) =>
        withPage(async (page, pageErrors, context) => {
          await page.goto(`${base}/instance/my-initiative`)
          await page.waitForSelector('.module', { timeout: 15_000 })
          const panel = await openPanel(page)
          const privateBase = bases.github

          // Without access: a plain message, and nothing is added.
          await fillRepository(panel, { location: { owner: 'acme', repository: 'billing-api', baseUrl: privateBase } })
          await messageMatches(page, /You can't read the GitHub repository acme\/billing-api without a token/)
          assert.equal(await panel.locator('tr[data-source-id]').count(), 0)

          await fillRepository(panel, { location: { owner: 'acme', repository: 'billing-api', baseUrl: privateBase }, token: TOKEN, folders: 'src' })
          const row = rowFor(panel, 'billing-api')
          await row.waitFor()
          await messageMatches(page, /Added "billing-api", the main branch of acme\/billing-api \(src\)\. Nothing from it is kept here/)
          assert.match(await row.textContent(), /READ LIVE/)
          assert.match(await row.textContent(), /main branch · src/)
          assert.equal(await row.getByRole('button', { name: 'Extract text again' }).count(), 0)
          assert.deepEqual(readdirSync(sourcesDir), ['manifest.yaml'], 'nothing from the repository is written to the Instance')
          const [entry] = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
          assert.deepEqual(entry.repository, { provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl: privateBase }, branch: 'main', folders: ['src'] })
          assert.ok(
            await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('gantry:ado-pat-overrides') ?? '{}')).some((k) => k.startsWith('source-repository|github|'))),
            'the token is kept in the browser, as a workspace token is'
          )

          await fillRepository(panel, { location: { owner: 'acme', repository: 'open-api', baseUrl: bases.publicGithub } })
          await rowFor(panel, 'open-api').waitFor()

          // Rename.
          await row.getByRole('button', { name: 'Rename' }).click()
          await panel.locator('[data-testid="source-documents-rename-input"]').fill('Billing API')
          await panel.getByRole('button', { name: 'Save' }).click()
          await rowFor(panel, 'Billing API').waitFor()

          // Download opens the repository on its Provider at its branch.
          const [opened] = await Promise.all([context.waitForEvent('page'), rowFor(panel, 'Billing API').getByRole('button', { name: 'Download' }).click()])
          await opened.waitForLoadState().catch(() => {})
          assert.equal(opened.url(), `${privateBase.replace(/\/+$/, '')}/acme/billing-api/tree/main`)
          await opened.close()

          // Download all: a links file, never the code.
          const [download] = await Promise.all([page.waitForEvent('download'), panel.locator('[data-testid="source-documents-download-all"]').click()])
          const zip = readFileSync(await download.path()).toString('latin1')
          assert.match(zip, /Code repositories\.txt/)
          assert.match(zip, /Address: http:\/\/127\.0\.0\.1:\d+\/acme\/billing-api\/tree\/main/)
          assert.doesNotMatch(zip, /MAX_ORDER_NZD/)

          // Remove: the pointer goes, the repository itself is untouched.
          await rowFor(panel, 'Billing API').getByRole('button', { name: 'Remove' }).click()
          await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
          await messageMatches(page, /The repository itself is untouched/)
          assert.equal(await rowFor(panel, 'Billing API').count(), 0)
          assert.ok(parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))[0].removedAt)
          assert.deepEqual(pageErrors, [])
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: Azure DevOps, GitLab and Bitbucket repositories are added through the panel with the architect\'s token, renamed and removed', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-319-providers-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRepositories((bases) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, ...serverOptions(bases) }, (base) =>
        withPage(async (page, pageErrors) => {
          await page.goto(`${base}/instance/my-initiative`)
          await page.waitForSelector('.module', { timeout: 15_000 })
          const panel = await openPanel(page)
          const cases = [
            { provider: 'azure-devops', label: 'Azure DevOps', name: 'contoso/Payments/billing', id: 'billing', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl: bases.azureDevOps } },
            { provider: 'gitlab', label: 'GitLab', name: 'acme/payments/ledger', id: 'ledger', location: { namespace: 'acme/payments', repository: 'ledger', baseUrl: bases.gitlab } },
            { provider: 'atlassian', label: 'Bitbucket', name: 'acme/settlements', id: 'settlements', location: { owner: 'acme', repository: 'settlements' } },
          ]
          for (const c of cases) {
            // Without access first: the plain sentence, and nothing added.
            await fillRepository(panel, { provider: c.provider, location: c.location })
            await messageMatches(page, new RegExp(`You can't read the ${c.label} repository ${c.name.replace(/\//g, '\\/')} without a token`))
            assert.equal(await panel.locator(`tr[data-source-id="${c.id}"]`).count(), 0)
            await fillRepository(panel, { provider: c.provider, location: c.location, token: TOKEN })
            await messageMatches(page, new RegExp(`Added "${c.id}", the main branch of ${c.name.replace(/\//g, '\\/')}\\. Nothing from it is kept here`))
            const row = panel.locator(`tr[data-source-id="${c.id}"]`)
            await row.waitFor()
            assert.match(await row.textContent(), /READ LIVE/)
          }
          assert.deepEqual(readdirSync(sourcesDir), ['manifest.yaml'], 'nothing from any repository is written to the Instance')
          const manifest = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
          assert.deepEqual(manifest.map((e) => [e.id, e.repository.provider, e.repository.branch]), [['billing', 'azure-devops', 'main'], ['ledger', 'gitlab', 'main'], ['settlements', 'atlassian', 'main']])
          assert.deepEqual(manifest[2].repository.location, { owner: 'acme', repository: 'settlements' })

          for (const c of cases) {
            const row = panel.locator(`tr[data-source-id="${c.id}"]`)
            await row.getByRole('button', { name: 'Rename' }).click()
            await panel.locator('[data-testid="source-documents-rename-input"]').fill(`${c.label} code`)
            await panel.getByRole('button', { name: 'Save' }).click()
            await rowFor(panel, `${c.label} code`).waitFor()
            await rowFor(panel, `${c.label} code`).getByRole('button', { name: 'Remove' }).click()
            await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
            await messageMatches(page, new RegExp(`Removed "${c.label} code"\\. The repository itself is untouched`))
            await panel.locator(`tr[data-source-id="${c.id}"]`).waitFor({ state: 'detached' })
          }
          const after = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
          assert.deepEqual(after.map((e) => [e.title, Boolean(e.removedAt)]), [['Azure DevOps code', true], ['GitLab code', true], ['Bitbucket code', true]])
          assert.deepEqual(readdirSync(sourcesDir), ['manifest.yaml'])
          assert.deepEqual(pageErrors, [])
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// A pointer someone else added (here: through the server's own routes), and a Field that cites a file of it at the commit it was read at.
async function seedPointer(base, repository) {
  const slug = 'my-initiative'
  const added = await fetch(`${base}/api/instance/sources?slug=${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository, uploadedBy: 'a.teammate' }) })
  assert.equal(added.status, 201, await added.clone().text())
  const read = await (
    await fetch(`${base}/api/sources/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(TOKEN) }, body: JSON.stringify({ action: 'read', repository, path: 'src/orders/limits.ts' }) })
  ).json()
  const instance = await (await fetch(`${base}/api/instance?slug=${slug}`)).json()
  const mod = instance.modules.find((m) => m.fields.some((f) => f.type === 'markdown'))
  const field = mod.fields.find((f) => f.type === 'markdown')
  const saved = await fetch(`${base}/api/instance/modules?slug=${slug}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modules: { [mod.id]: { fields: { [field.id]: `Orders are capped at NZD 5,000 ([Billing API, limits](source:billing-api${read.citationQuery})).` } } } }),
  })
  assert.equal(saved.status, 200, await saved.clone().text())
}

test('an existing pointer opened without access (another browser, a teammate): its row says so, Out of date names it, and Your token fixes both', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-319-noaccess-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRepositories((bases) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, ...serverOptions(bases) }, async (base) => {
        await seedPointer(base, { provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl: bases.github }, branch: 'main' })
        // A fresh browser: no token for the repository is held here.
        await withPage(async (page, pageErrors) => {
          await page.goto(`${base}/instance/my-initiative`)
          await page.waitForSelector('.module', { timeout: 15_000 })
          const panel = await openPanel(page)
          const row = panel.locator('tr[data-source-id="billing-api"]')
          await row.waitFor()
          const note = row.locator('[data-testid="source-repository-no-access"]')
          await note.waitFor()
          assert.equal(await note.textContent(), "You can't read the GitHub repository acme/billing-api without a token. If it is private, give a token that can read it.")
          assert.match(await row.locator('[data-testid="source-repository-stamp"]').textContent(), /CAN'T READ/)

          // Out of date can't compare it from here, and says so instead of skipping it in silence.
          await showFields(page)
          const unchecked = page.locator('[data-testid="out-of-date-unchecked"]')
          await unchecked.waitFor({ timeout: 15_000 })
          assert.match(await unchecked.textContent(), /^billing-api was not checked for changes, so the Fields that drew on it may be out of date: You can't read the GitHub repository acme\/billing-api without a token\..*Your token/)

          // A wrong token is refused and not kept; the right one is checked, kept, and both messages go.
          await openPanel(page)
          await row.locator('[data-testid="source-repository-token-open"]').click()
          await row.locator('[data-testid="source-repository-token-input"]').fill('wrong-token')
          await row.locator('[data-testid="source-repository-token-save"]').click()
          await messageMatches(page, /You can't read the GitHub repository acme\/billing-api with the token you gave/)
          assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('gantry:ado-pat-overrides') ?? '{}')).some((k) => k.startsWith('source-repository|'))), false, 'a token that cannot read it is not kept')
          await row.locator('[data-testid="source-repository-token-input"]').fill(TOKEN)
          await row.locator('[data-testid="source-repository-token-save"]').click()
          await messageMatches(page, /You can read acme\/billing-api with this token \(its main branch is at \S{7}\)\. It is kept in this browser/)
          await note.waitFor({ state: 'detached' })
          assert.match(await row.locator('[data-testid="source-repository-stamp"]').textContent(), /READ LIVE/)
          assert.ok(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('gantry:ado-pat-overrides') ?? '{}')).some((k) => k.startsWith('source-repository|github|'))))
          assert.deepEqual(parseYAML(readFileSync(join(instancesDir, 'default', 'my-initiative', 'sources', 'manifest.yaml'), 'utf8')).map((e) => e.title), ['billing-api'], 'giving a token changes nothing in the Instance')

          await showFields(page)
          await page.locator('[data-testid="out-of-date-unchecked"]').waitFor({ state: 'detached', timeout: 15_000 })

          // Opened again in this browser, the token held here reads it: no message.
          await page.reload()
          await page.waitForSelector('.module', { timeout: 15_000 })
          const again = await openPanel(page)
          await again.locator('tr[data-source-id="billing-api"] [data-testid="source-repository-stamp"]').filter({ hasText: 'READ LIVE' }).waitFor()
          assert.equal(await again.locator('[data-testid="source-repository-no-access"]').count(), 0)
          assert.deepEqual(pageErrors, [])
        })
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Interview page: the compact list adds a repository, and one this browser cannot read says so, with Your token right there', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-319-rail-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRepositories((bases) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, ...serverOptions(bases) }, async (base) => {
        await seedPointer(base, { provider: 'github', location: { owner: 'acme', repository: 'billing-api', baseUrl: bases.github }, branch: 'main' })
        await withPage(async (page, pageErrors) => {
          await page.goto(`${base}/instance/my-initiative?interview=1`)
          const rail = page.locator('[data-testid="source-documents-compact"]')
          await rail.waitFor({ timeout: 15_000 })
          const seeded = rail.locator('li[data-source-id="billing-api"]')
          await seeded.waitFor()
          assert.match(await seeded.textContent(), /code repository · main branch/)
          await seeded.locator('[data-testid="source-repository-no-access"]').waitFor()
          assert.match(await seeded.locator('[data-testid="source-repository-no-access"]').textContent(), /You can't read the GitHub repository acme\/billing-api without a token/)

          // The rail's own "+ Add a code repository" adds a pointer.
          await fillRepository(rail, { provider: 'azure-devops', location: { organization: 'contoso', project: 'Payments', repository: 'billing', baseUrl: bases.azureDevOps }, token: TOKEN })
          const added = rail.locator('li[data-source-id="billing"]')
          await added.waitFor()
          await messageIn(rail, /Added "billing", the main branch of contoso\/Payments\/billing\. Nothing from it is kept here/)
          assert.match(await added.textContent(), /code repository · main branch/)
          assert.equal(await added.locator('[data-testid="source-repository-no-access"]').count(), 0)
          assert.deepEqual(readdirSync(sourcesDir), ['manifest.yaml'])
          assert.deepEqual(parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8')).map((e) => [e.id, e.repository.provider]), [['billing-api', 'github'], ['billing', 'azure-devops']])

          // Your token, from the rail.
          await seeded.locator('[data-testid="source-repository-token-open"]').click()
          await seeded.locator('[data-testid="source-repository-token-input"]').fill(TOKEN)
          await seeded.locator('[data-testid="source-repository-token-save"]').click()
          await messageIn(rail, /You can read acme\/billing-api with this token/)
          await seeded.locator('[data-testid="source-repository-no-access"]').waitFor({ state: 'detached' })
          assert.deepEqual(pageErrors, [])
        })
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// --- Local Workspace -----------------------------------------------------------------------------------------------

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

// As tests/source-documents-address.playwright.test.js does: an OPFS folder remembered in IndexedDB stands in for a picked folder. The
// Background cites the public repository the test adds (its id is its name, `open-api`).
async function seedLocalWorkspace(page, slug) {
  const files = { [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n` }
  for (const moduleId of SHAPE_MODULES) {
    let text = exampleModuleText(moduleId)
    if (moduleId === 'background') {
      const cited = text.replace(/\n## Affected domains/, '\nThe limits are in the code [Open API, README](source:open-api?path=README.md).\n\n## Affected domains')
      assert.notEqual(cited, text)
      text = cited
    }
    files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = text
  }
  return page.evaluate(async ({ files }) => {
    const { rememberWorkspace } = await import('/lib/localWorkspace.js')
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('local-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/')
      const file = parts.pop()
      let d = dir
      for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
      const w = await (await d.getFileHandle(file, { create: true })).createWritable()
      await w.write(content)
      await w.close()
    }
    return rememberWorkspace({ handle: dir, name: 'Local Repository Workspace' })
  }, { files })
}

async function readLocalSources(page, slug) {
  return page.evaluate(async (s) => {
    const { getWorkspaceHandle, listDir, readTextFile } = await import('/lib/localWorkspace.js')
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('gantry-local-workspaces', 1)
      req.onsuccess = () => resolve(req.result)
    })
    const all = await new Promise((resolve) => {
      const req = db.transaction('workspaces', 'readonly').objectStore('workspaces').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    db.close()
    const handle = await getWorkspaceHandle(all[0].id)
    return { manifest: await readTextFile(handle, `gantry-workspace/${s}/sources/manifest.yaml`), files: (await listDir(handle, `gantry-workspace/${s}/sources`)).map((e) => e.name) }
  }, slug)
}

test('local workspace: the Gantry server checks the repository, only the pointer is kept in the folder, it is renamed and removed there, and a render carries it', async () => {
  await withRepositories((bases) =>
    withRunningServer(serverOptions(bases), (base) =>
      withPage(async (page, pageErrors) => {
        const slug = 'local-repository'
        await page.goto(`${base}/`)
        const workspaceId = await seedLocalWorkspace(page, slug)
        await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        const stored = []
        page.on('request', (req) => {
          if (new URL(req.url()).pathname.startsWith('/api/instance/sources')) stored.push(req.url())
        })
        await fillRepository(panel, { location: { owner: 'acme', repository: 'open-api', baseUrl: bases.publicGithub } })
        await rowFor(panel, 'open-api').waitFor()
        // A private one too, with the architect's token.
        await fillRepository(panel, { provider: 'gitlab', location: { namespace: 'acme/payments', repository: 'ledger', baseUrl: bases.gitlab }, token: TOKEN })
        await rowFor(panel, 'ledger').waitFor()
        let folder = await readLocalSources(page, slug)
        assert.deepEqual(folder.files, ['manifest.yaml'])
        assert.match(folder.manifest, /repository:\n {4}provider: github\n {4}location:\n {6}owner: acme\n {6}repository: open-api/)
        assert.match(folder.manifest, /repository:\n {4}provider: gitlab\n {4}location:\n {6}namespace: acme\/payments\n {6}repository: ledger/)

        // Renamed and removed in the folder.
        await rowFor(panel, 'ledger').getByRole('button', { name: 'Rename' }).click()
        await panel.locator('[data-testid="source-documents-rename-input"]').fill('Ledger service')
        await panel.getByRole('button', { name: 'Save' }).click()
        await rowFor(panel, 'Ledger service').waitFor()
        assert.match((await readLocalSources(page, slug)).manifest, /title: Ledger service/)
        await rowFor(panel, 'Ledger service').getByRole('button', { name: 'Remove' }).click()
        await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
        await messageMatches(page, /Removed "Ledger service"\. The repository itself is untouched/)
        await rowFor(panel, 'Ledger service').waitFor({ state: 'detached' })
        folder = await readLocalSources(page, slug)
        assert.deepEqual(folder.files, ['manifest.yaml'])
        assert.match(folder.manifest, /- id: ledger\n(?: {2}.*\n)*? {2}removedAt: /)
        assert.deepEqual(stored, [], 'the pointers are kept in the folder, not on the server')

        // A render of content that cites the repository carries its pointer (no filename), and the server takes it.
        const computeBodies = []
        page.on('request', (req) => {
          if (new URL(req.url()).pathname.startsWith('/api/local/')) computeBodies.push(req.postData() ?? '')
        })
        await showFields(page)
        await page.getByRole('button', { name: 'Render', exact: true }).click()
        const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
        await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
        await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
        await page.waitForFunction(() => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''), { timeout: 60_000 })
        assert.doesNotMatch(await renderDialog.textContent(), /render failed/)
        assert.ok(computeBodies.length > 0, 'the render went through /api/local/*')
        for (const body of computeBodies.map((b) => JSON.parse(b))) {
          assert.deepEqual(body.sources?.map((s) => s.id), ['open-api'], 'only the cited pointer')
          assert.equal(body.sources[0].filename, undefined)
          assert.deepEqual(body.sources[0].repository, { provider: 'github', location: { owner: 'acme', repository: 'open-api', baseUrl: bases.publicGithub }, branch: 'main' })
        }
        assert.deepEqual(pageErrors, [])
      })
    )
  )
})
