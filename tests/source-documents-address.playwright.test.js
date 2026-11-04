import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showFields, showSourcesAndDecisions } from './helpers/referenceView.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT, withRunningServer, withRunningServerForProvider } from './helpers/lifecycle.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { parseSourceManifest } from '../web/lib/sourceDocuments.js'
import { unzip } from './helpers/reviewedCopyFixture.js'
import { textPdf } from './helpers/sourceFixtures.js'
import { createInstance } from '../lib/instance.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #318 (docs/adr/0071): browser coverage for **Add from address** and **Fetch again** in the Source documents panel. A local site stands in
// for the web, allowed by the Source document setting as an intranet page would be. The page is read to Markdown in the browser with the
// real pandoc-wasm build. The fetch itself is covered in tests/sourceFetch.test.js, the store in tests/sourceDocuments.test.js.

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

// A local site standing in for the web: a page, a PDF and a page behind a sign-in. `pages` holds the page's HTML (a test changes it to
// stand for an edit); `served(path)` is the bytes the site answers with, which a download must hand back byte for byte.
const SPEC_PDF = Buffer.from(textPdf([['The service must answer within two seconds.']]))
async function withSite(fn) {
  const pages = { '/guide': '<html><head><title>Vendor API guide</title><script>window.stolen = 1</script></head><body><h1>Limits</h1><p>Clients may make 100 requests a minute.</p></body></html>' }
  const served = (path) => (path === '/spec.pdf' ? SPEC_PDF : Buffer.from(pages[path]))
  const site = createHttpServer((req, res) => {
    if (req.url === '/private') {
      res.writeHead(401)
      res.end()
      return
    }
    if (req.url === '/spec.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' })
      res.end(SPEC_PDF)
      return
    }
    if (!pages[req.url]) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages[req.url])
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  try {
    await fn(`http://127.0.0.1:${site.address().port}`, pages, served)
  } finally {
    site.closeAllConnections?.()
    site.close()
  }
}

// The background module with a Field citing the page and the PDF by the ids they will be given, so the editor shows each citation as a
// live link once the document is added (and as missing before).
const CITING = 'The vendor allows 100 requests a minute [Vendor API guide](source:vendor-api-guide) and answers within two seconds [the spec](source:spec).'
function citingBackground(text) {
  const cited = text.replace(/\n## Affected domains/, `\n${CITING}\n\n## Affected domains`)
  assert.notEqual(cited, text)
  return cited
}

const openPanel = async (page) => {
  await showSourcesAndDecisions(page)
  const panel = page.locator('[data-testid="source-documents"]')
  await panel.waitFor({ timeout: 15_000 })
  if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
  return panel
}
const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const rowById = (panel, id) => panel.locator(`tr[data-source-id="${id}"]`)
const message = (panel) => panel.locator('[data-testid="source-documents-message"]')
const waitForMessage = (page, pattern) =>
  page.waitForFunction((source) => new RegExp(source).test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''), pattern.source)

/**
 * Criterion 1 of #318, the same on every kind of workspace: a public page and a PDF are added by address, each listed with its origin and
 * its text read, then cited, renamed, downloaded, zipped (Download all) and removed exactly as an upload is. `stored` reads what the
 * workspace keeps: `manifest()` its entries, `bytes(filename)` an original (null once removed) and `text(filename)` its extracted text.
 */
async function addCiteRenameDownloadZipRemove(page, { site, served, stored }) {
  let panel = await openPanel(page)
  const form = panel.locator('[data-testid="source-address-form"]')
  await form.waitFor()

  await form.locator('[data-testid="source-address-input"]').fill(`${site}/guide`)
  await form.locator('[data-testid="source-address-add"]').click()
  const pageRow = rowById(panel, 'vendor-api-guide')
  await pageRow.waitFor({ timeout: 60_000 })
  assert.match(await pageRow.textContent(), /Vendor API guide/)
  assert.match(await pageRow.textContent(), /TEXT READ/)
  assert.equal(await pageRow.locator('[data-testid="source-origin"]').getAttribute('href'), `${site}/guide`)

  await form.locator('[data-testid="source-address-input"]').fill(`${site}/spec.pdf`)
  await form.locator('[data-testid="source-address-add"]').click()
  const pdfRow = rowById(panel, 'spec')
  await pdfRow.waitFor({ timeout: 60_000 })
  assert.match(await pdfRow.textContent(), /TEXT READ/)
  assert.equal(await pdfRow.locator('[data-testid="source-origin"]').getAttribute('href'), `${site}/spec.pdf`)
  assert.match(await message(panel).textContent(), /Added "spec" from .*\/spec\.pdf and read its text/)

  // Kept like uploads, each with its origin and its text.
  const manifest = await stored.manifest()
  assert.deepEqual(manifest.map((e) => [e.id, e.filename, e.origin?.address]), [['vendor-api-guide', 'Vendor API guide.html', `${site}/guide`], ['spec', 'spec.pdf', `${site}/spec.pdf`]])
  assert.match(await stored.text('Vendor API guide.html'), /^# Limits\n\nClients may make 100 requests a minute\.$/m)
  assert.match(await stored.text('spec.pdf'), /answer within two seconds/)
  assert.deepEqual(await stored.bytes('spec.pdf'), served('/spec.pdf'))

  // Cited: the Field's citations of both are live links now, and Copy citation gives one to paste.
  await showFields(page)
  await page.locator('.cm-vsource[data-source-id="vendor-api-guide"]').first().waitFor({ timeout: 15_000 })
  await page.locator('.cm-vsource[data-source-id="spec"]').first().waitFor({ timeout: 15_000 })
  panel = await openPanel(page)
  await rowById(panel, 'vendor-api-guide').getByRole('button', { name: 'Copy citation' }).click()
  await waitForMessage(page, /\(source:vendor-api-guide\)/)

  // Renamed: the title only.
  await rowById(panel, 'vendor-api-guide').getByRole('button', { name: 'Rename' }).click()
  await panel.locator('[data-testid="source-documents-rename-input"]').fill('API guide')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await waitForMessage(page, /^Renamed\. Only the title changed/)
  const renamed = (await stored.manifest()).find((e) => e.id === 'vendor-api-guide')
  assert.equal(renamed.title, 'API guide')
  assert.equal(renamed.filename, 'Vendor API guide.html')
  assert.equal(renamed.origin.address, `${site}/guide`)

  // Downloaded: the bytes the site served, the page as its HTML.
  for (const [id, path] of [['vendor-api-guide', '/guide'], ['spec', '/spec.pdf']]) {
    const [download] = await Promise.all([page.waitForEvent('download'), rowById(panel, id).getByRole('button', { name: 'Download' }).click()])
    assert.deepEqual(readFileSync(await download.path()), served(path), `${id} downloads byte for byte`)
  }

  // Zipped: Download all holds both originals.
  const [archive] = await Promise.all([page.waitForEvent('download'), panel.locator('[data-testid="source-documents-download-all"]').click()])
  const parts = unzip(readFileSync(await archive.path()))
  assert.deepEqual(Object.keys(parts).sort(), ['Vendor API guide.html', 'spec.pdf'])
  assert.deepEqual(parts['Vendor API guide.html'], served('/guide'))
  assert.deepEqual(parts['spec.pdf'], served('/spec.pdf'))
  await waitForMessage(page, /Saved 2 documents/)

  // Removed: the file and its text go, the entry stays with its origin.
  await rowById(panel, 'spec').getByRole('button', { name: 'Remove' }).click()
  await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
  await rowById(panel, 'spec').waitFor({ state: 'detached' })
  assert.equal(await stored.bytes('spec.pdf'), null)
  assert.equal(await stored.text('spec.pdf'), null)
  const removed = (await stored.manifest()).find((e) => e.id === 'spec')
  assert.ok(removed.removedAt)
  assert.equal(removed.origin.address, `${site}/spec.pdf`)
  assert.equal(await page.evaluate(() => window.stolen), undefined, "the page's script never ran")
}

test('server workspace: a page and a PDF added by address are cited, renamed, downloaded, zipped and removed like uploads', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-318-life-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const background = join(instancesDir, 'my-initiative', 'modules', 'background.md')
    writeFileSync(background, citingBackground(readFileSync(background, 'utf8')))
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    const stored = {
      manifest: async () => parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8')),
      bytes: async (filename) => (existsSync(join(sourcesDir, filename)) ? readFileSync(join(sourcesDir, filename)) : null),
      text: async (filename) => (existsSync(join(sourcesDir, '.text', `${filename}.md`)) ? readFileSync(join(sourcesDir, '.text', `${filename}.md`), 'utf8') : null),
    }
    await withSite((site, _pages, served) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, allowPrivateSourceUrls: true }, (base) =>
        withPage(async (page, pageErrors) => {
          await page.goto(`${base}/instance/my-initiative`)
          await page.waitForSelector('.module', { timeout: 15_000 })
          await page.locator('.cm-vsource-missing[data-source-id="vendor-api-guide"]').first().waitFor({ timeout: 15_000 })
          await addCiteRenameDownloadZipRemove(page, { site, served, stored })
          assert.deepEqual(pageErrors, [])
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: a page is added from its address with its origin, and Fetch again adds only a changed page', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-318-e2e-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withSite((site, pages) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, allowPrivateSourceUrls: true }, (base) =>
        withPage(async (page, pageErrors) => {
          await page.goto(`${base}/instance/my-initiative`)
          await page.waitForSelector('.module', { timeout: 15_000 })
          const panel = await openPanel(page)
          const form = panel.locator('[data-testid="source-address-form"]')
          await form.waitFor()

          // A sign-in page is refused with what to do, and nothing is added.
          await form.locator('[data-testid="source-address-input"]').fill(`${site}/private`)
          await form.locator('[data-testid="source-address-add"]').click()
          await page.waitForFunction(() => /needs a sign-in/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
          assert.match(await message(panel).textContent(), /save it as a PDF and upload that instead/)
          assert.equal(await panel.locator('tr[data-source-id]').count(), 0)

          await form.locator('[data-testid="source-address-input"]').fill(`${site}/guide`)
          await form.locator('[data-testid="source-address-add"]').click()
          const row = rowFor(panel, 'Vendor API guide')
          await row.waitFor({ timeout: 60_000 })
          assert.match(await row.textContent(), /TEXT READ/)
          assert.equal(await row.locator('[data-testid="source-origin"]').getAttribute('href'), `${site}/guide`)
          assert.match(await row.textContent(), /fetched /)
          assert.match(await message(panel).textContent(), /Added "Vendor API guide" from .*\/guide and read its text/)
          assert.equal(await page.evaluate(() => window.stolen), undefined, "the page's script never ran")
          assert.match(readFileSync(join(sourcesDir, '.text', 'Vendor API guide.html.md'), 'utf8'), /^# Limits\n\nClients may make 100 requests a minute\.$/m)
          const [entry] = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
          assert.equal(entry.origin.address, `${site}/guide`)

          // The same page again: nothing added.
          await row.locator('[data-testid="source-fetch-again"]').click()
          await page.waitForFunction(() => /unchanged since/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
          assert.equal(await panel.locator('tr[data-source-id]').count(), 1)

          // A changed page: a new document replacing the old one.
          pages['/guide'] = pages['/guide'].replace('100 requests', '50 requests')
          await row.locator('[data-testid="source-fetch-again"]').click()
          await page.waitForFunction(() => /has changed since/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
          await panel.locator('tr[data-source-id]').nth(1).waitFor()
          assert.match(await rowFor(panel, 'Vendor API guide').first().textContent(), /replaced by Vendor API guide/)
          const manifest = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
          assert.equal(manifest[1].replaces, manifest[0].id)
          assert.match(readFileSync(join(sourcesDir, '.text', `${manifest[1].filename}.md`), 'utf8'), /50 requests a minute/)
          assert.equal(await panel.locator('[data-testid="source-fetch-again"]').count(), 1, 'only the newest copy offers Fetch again')
          assert.deepEqual(pageErrors, [])
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('with the off switch set, neither the editor nor the Interview page offers adding by address, and uploading still works on both', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-318-off-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRunningServer({ slug: 'my-initiative', instancesDir, sourceFetchDisabled: true }, (base) =>
      withPage(async (page) => {
        // Each screen asks the server whether it fetches; the answer is awaited, so "no form" is the answer and not a page still loading.
        const statusAnswer = async () => (await page.waitForResponse((res) => new URL(res.url()).pathname === '/api/sources/fetch')).json()
        let answered = statusAnswer()
        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        assert.deepEqual(await answered, { enabled: false, maxBytes: 25 * 1024 * 1024 })
        assert.equal(await panel.locator('[data-testid="source-address-form"]').count(), 0)
        // Uploading is unaffected: a file is added and its text read, with the switch still off.
        await panel.locator('[data-testid="source-documents-input"]').setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Workshop notes.\n') })
        await rowFor(panel, 'Notes').waitFor()
        assert.match(await rowFor(panel, 'Notes').textContent(), /TEXT READ/)
        assert.equal(readFileSync(join(sourcesDir, 'Notes.txt'), 'utf8'), 'Workshop notes.\n')

        answered = statusAnswer()
        await page.goto(`${base}/instance/my-initiative?interview=1`)
        const rail = page.locator('[data-testid="source-documents-compact"]')
        await rail.waitFor({ timeout: 15_000 })
        assert.equal((await answered).enabled, false)
        await rail.locator('li[data-source-id="notes"]').waitFor()
        assert.equal(await rail.locator('[data-testid="source-address-form"]').count(), 0)
        // The Interview page's rail uploads too.
        await rail.locator('[data-testid="source-documents-input"]').setInputFiles({ name: 'Decisions.md', mimeType: 'text/markdown', buffer: Buffer.from('# Decisions\n') })
        await rail.locator('li[data-source-id="decisions"]').waitFor()
        assert.equal(readFileSync(join(sourcesDir, 'Decisions.md'), 'utf8'), '# Decisions\n')
        assert.deepEqual(parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8')).map((e) => [e.id, e.origin ?? null]), [['notes', null], ['decisions', null]])
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('with the switch on, the Interview page\'s rail offers the address form, and a page added from it is kept with its origin', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-318-rail-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withSite((site) =>
      withRunningServer({ slug: 'my-initiative', instancesDir, allowPrivateSourceUrls: true }, (base) =>
        withPage(async (page, pageErrors) => {
          const answered = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/sources/fetch')
          await page.goto(`${base}/instance/my-initiative?interview=1`)
          const rail = page.locator('[data-testid="source-documents-compact"]')
          await rail.waitFor({ timeout: 15_000 })
          assert.equal((await (await answered).json()).enabled, true)
          const form = rail.locator('[data-testid="source-address-form"]')
          await form.waitFor()
          await form.locator('[data-testid="source-address-input"]').fill(`${site}/guide`)
          await form.locator('[data-testid="source-address-add"]').click()
          await rail.locator('li[data-source-id="vendor-api-guide"]').waitFor({ timeout: 60_000 })
          assert.match(await rail.locator('li[data-source-id="vendor-api-guide"] .srcdoc-title').getAttribute('title'), new RegExp(`^${site}/guide, fetched `))
          assert.match(await rail.locator('[data-testid="source-documents-message"]').textContent(), /Added "Vendor API guide" from .*\/guide and read its text/)
          const [entry] = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
          assert.equal(entry.origin.address, `${site}/guide`)
          assert.match(readFileSync(join(sourcesDir, '.text', 'Vendor API guide.html.md'), 'utf8'), /100 requests a minute/)
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

// As tests/source-documents.playwright.test.js does: an OPFS folder remembered in IndexedDB stands in for a picked folder.
async function seedLocalWorkspace(page, slug) {
  const files = { [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n` }
  for (const moduleId of SHAPE_MODULES) files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = moduleId === 'background' ? citingBackground(exampleModuleText(moduleId)) : exampleModuleText(moduleId)
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
    return rememberWorkspace({ handle: dir, name: 'Local Address Workspace' })
  }, { files })
}

// A file in the remembered Local Workspace folder: its text, or with `as` 'bytes' a Buffer; null when it isn't there.
async function readLocal(page, path, as = 'text') {
  const read = await page.evaluate(
    async ({ path, as }) => {
      const { getWorkspaceHandle, readTextFile, readBinaryFile } = await import('/lib/localWorkspace.js')
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('gantry-local-workspaces', 1)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const all = await new Promise((resolve, reject) => {
        const req = db.transaction('workspaces', 'readonly').objectStore('workspaces').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      db.close()
      const handle = await getWorkspaceHandle(all[0].id)
      try {
        const value = as === 'text' ? await readTextFile(handle, path) : await readBinaryFile(handle, path)
        return value === null || value === undefined ? null : as === 'text' ? value : Array.from(value)
      } catch (err) {
        if (err?.name === 'NotFoundError') return null
        throw err
      }
    },
    { path, as }
  )
  return read === null || as === 'text' ? read : Buffer.from(read)
}

test('local workspace: the server fetches a page and a PDF, the folder keeps them to cite, rename, download, zip and remove; with the server unreachable the panel says why', async () => {
  await withSite((site, _pages, served) =>
    withRunningServer({ allowPrivateSourceUrls: true }, (base) =>
      withPage(async (page, pageErrors) => {
        const slug = 'local-address'
        await page.goto(`${base}/`)
        const workspaceId = await seedLocalWorkspace(page, slug)
        await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        await page.locator('.cm-vsource-missing[data-source-id="vendor-api-guide"]').first().waitFor({ timeout: 15_000 })
        const uploads = []
        page.on('request', (req) => {
          if (new URL(req.url()).pathname.startsWith('/api/instance/sources')) uploads.push(req.url())
        })
        const folder = `gantry-workspace/${slug}/sources`
        const stored = {
          manifest: async () => parseYAML(await readLocal(page, `${folder}/manifest.yaml`)),
          bytes: (filename) => readLocal(page, `${folder}/${filename}`, 'bytes'),
          text: (filename) => readLocal(page, `${folder}/.text/${filename}.md`),
        }
        await addCiteRenameDownloadZipRemove(page, { site, served, stored })
        assert.deepEqual(uploads, [], 'the documents are kept in the folder, never on the server')
        assert.match(await readLocal(page, `${folder}/manifest.yaml`), /origin:\n {4}address: http:\/\/127\.0\.0\.1:\d+\/guide/)
        assert.deepEqual(pageErrors, [])

        // The Gantry server goes away: the panel says adding by address needs it, and uploading stays.
        await page.route('**/api/sources/fetch', (route) => route.abort('connectionrefused'))
        await page.reload()
        await page.waitForSelector('.module', { timeout: 15_000 })
        const again = await openPanel(page)
        await again.locator('[data-testid="source-address-unreachable"]').waitFor()
        assert.match(await again.locator('[data-testid="source-address-unreachable"]').textContent(), /needs the Gantry server/)
        assert.equal(await again.locator('[data-testid="source-address-form"]').count(), 0)
        assert.equal(await again.locator('[data-testid="source-documents-input"]').count(), 1)
      })
    )
  )
})

// --- Azure DevOps and GitHub workspaces ------------------------------------------------------------------------------

// As tests/source-documents-remote.playwright.test.js does: a fake Provider holds the Instance, and each change is a commit on the Stage's
// branch (tests/providerSourceDocuments.test.js counts them). What is read back here is what that branch holds.
const REMOTE_SLUG = 'acme'
const REMOTE_ROOT = `gantry-workspace/${REMOTE_SLUG}`
const REMOTE_PROVIDERS = {
  'azure-devops': {
    name: 'Azure DevOps',
    kind: 'azureDevOps',
    pat: VALID_PAT,
    location: (baseUrl) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }),
    client: (baseUrl) => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl, pat: VALID_PAT }),
  },
  github: {
    name: 'GitHub',
    kind: 'github',
    pat: GITHUB_VALID_PAT,
    location: (baseUrl) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }),
    client: (baseUrl) => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl, pat: GITHUB_VALID_PAT }),
  },
}

for (const [providerId, provider] of Object.entries(REMOTE_PROVIDERS)) {
  test(`${provider.name} workspace: a page and a PDF added by address are committed, cited, renamed, downloaded, zipped and removed like uploads`, async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-318-remote-'))
    try {
      const files = {
        [`/${REMOTE_ROOT}/instance.yaml`]: `definition: design\nslug: ${REMOTE_SLUG}\nstage: shape\ndefinitionVersion: 2\n`,
        [`/${REMOTE_ROOT}/modules/background.md`]: citingBackground(exampleModuleText('background')),
      }
      await withSite((site, _pages, served) =>
        withRunningServerForProvider(providerId, { options: { instancesDir, allowPrivateSourceUrls: true }, fakeServerOptions: { files } }, async ({ gantryBase: base, providerBaseUrl }) => {
          registerInstance(REMOTE_SLUG, { kind: provider.kind, ...provider.location(providerBaseUrl) }, { instancesDir })
          const client = provider.client(providerBaseUrl)
          const branch = stageBranchName(REMOTE_SLUG, 'shape')
          const stored = {
            manifest: async () => parseSourceManifest(await client.getFileContent(`${REMOTE_ROOT}/sources/manifest.yaml`, { branch })),
            bytes: async (filename) =>
              (await client.fileExists(`${REMOTE_ROOT}/sources/${filename}`, branch)) ? Buffer.from(await client.getFileBytes(`${REMOTE_ROOT}/sources/${filename}`, { branch })) : null,
            text: async (filename) =>
              (await client.fileExists(`${REMOTE_ROOT}/sources/.text/${filename}.md`, branch)) ? client.getFileContent(`${REMOTE_ROOT}/sources/.text/${filename}.md`, { branch }) : null,
          }
          await withPage(async (page, pageErrors) => {
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), provider.pat)
            await page.goto(`${base}/instance/${REMOTE_SLUG}`)
            await page.waitForSelector('.module', { timeout: 30_000 })
            await page.locator('.cm-vsource-missing[data-source-id="vendor-api-guide"]').first().waitFor({ timeout: 30_000 })
            await addCiteRenameDownloadZipRemove(page, { site, served, stored })
            assert.equal(await client.fileExists(`${REMOTE_ROOT}/sources/manifest.yaml`, 'main'), false, 'main is untouched until the Stage is approved')
            assert.deepEqual(pageErrors, [])
          })
        })
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}
