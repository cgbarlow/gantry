import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createFakeGitHubServer } from './helpers/fakeGitHubServer.js'
import { createInstance } from '../lib/instance.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #319 (docs/adr/0072): browser coverage for **+ Add a code repository** in the Source documents panel, on a server workspace. A fake GitHub
// stands in for the Provider (its address taken as a self-hosted one, which this server accepts for a workspace). Reading the repository
// is covered in tests/repositorySource.test.js, the pure parts in tests/sourceRepository.test.js.

const TOKEN = 'architects-own-token'

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

async function withRepositories(fn) {
  const code = { 'README.md': '# Billing API\n', 'src/orders/limits.ts': 'export const MAX_ORDER_NZD = 5000\n' }
  const servers = [
    createFakeGitHubServer({ owner: 'acme', repository: 'billing-api', validPat: TOKEN, files: code }),
    createFakeGitHubServer({ owner: 'acme', repository: 'open-api', validPat: 'nobody', files: code, anonymousRead: true }),
  ]
  for (const server of servers) {
    server.keepAliveTimeout = 0
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  }
  try {
    await fn(...servers.map((s) => `http://127.0.0.1:${s.address().port}`))
  } finally {
    for (const server of servers) server.close()
  }
}

const openPanel = async (page) => {
  await showSourcesAndDecisions(page)
  const panel = page.locator('[data-testid="source-documents"]')
  await panel.waitFor({ timeout: 15_000 })
  if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
  return panel
}
const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const messageMatches = (page, pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''), pattern.source)

async function fillRepository(panel, { owner, repository, baseUrl, token = '', folders = '' }) {
  if ((await panel.locator('[data-testid="source-repository-form"]').count()) === 0) await panel.locator('[data-testid="source-repository-open"]').click()
  const form = panel.locator('[data-testid="source-repository-form"]')
  await form.locator('[data-testid="source-repository-provider"]').selectOption('github')
  await form.locator('[data-testid="source-repository-owner"]').fill(owner)
  await form.locator('[data-testid="source-repository-repository"]').fill(repository)
  await form.locator('[data-testid="source-repository-baseUrl"]').fill(baseUrl)
  await form.locator('[data-testid="source-repository-folders"]').fill(folders)
  await form.locator('[data-testid="source-repository-token"]').fill(token)
  await form.locator('[data-testid="source-repository-add"]').click()
}

test('server workspace: a private repository is added with the architect\'s token, a public one with none, renamed, opened, zipped as links and removed', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-319-e2e-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRepositories((privateBase, publicBase) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, allowGitHubBaseUrlOverride: true }, (base) =>
        withPage(async (page, pageErrors, context) => {
          await page.goto(`${base}/instance/my-initiative`)
          await page.waitForSelector('.module', { timeout: 15_000 })
          const panel = await openPanel(page)

          // Without access: a plain message, and nothing is added.
          await fillRepository(panel, { owner: 'acme', repository: 'billing-api', baseUrl: privateBase })
          await messageMatches(page, /You can't read the GitHub repository acme\/billing-api without a token/)
          assert.equal(await panel.locator('tr[data-source-id]').count(), 0)

          await fillRepository(panel, { owner: 'acme', repository: 'billing-api', baseUrl: privateBase, token: TOKEN, folders: 'src' })
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

          await fillRepository(panel, { owner: 'acme', repository: 'open-api', baseUrl: publicBase })
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

// --- Local Workspace -----------------------------------------------------------------------------------------------

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

// As tests/source-documents-address.playwright.test.js does: an OPFS folder remembered in IndexedDB stands in for a picked folder.
async function seedLocalWorkspace(page, slug) {
  const files = { [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n` }
  for (const moduleId of SHAPE_MODULES) files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = exampleModuleText(moduleId)
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

test('local workspace: the Gantry server checks the repository, and only the pointer is kept in the folder', async () => {
  await withRepositories((_privateBase, publicBase) =>
    withRunningServer({ allowGitHubBaseUrlOverride: true }, (base) =>
      withPage(async (page) => {
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
        await fillRepository(panel, { owner: 'acme', repository: 'open-api', baseUrl: publicBase })
        await rowFor(panel, 'open-api').waitFor()
        assert.deepEqual(stored, [], 'the pointer is kept in the folder, not on the server')
        const folder = await page.evaluate(async (s) => {
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
        assert.deepEqual(folder.files, ['manifest.yaml'])
        assert.match(folder.manifest, /repository:\n {4}provider: github\n {4}location:\n {6}owner: acme\n {6}repository: open-api/)
      })
    )
  )
})
