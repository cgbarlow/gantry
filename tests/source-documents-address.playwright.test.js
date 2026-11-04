import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer } from './helpers/lifecycle.js'
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

async function withSite(fn) {
  const pages = { '/guide': '<html><head><title>Vendor API guide</title><script>window.stolen = 1</script></head><body><h1>Limits</h1><p>Clients may make 100 requests a minute.</p></body></html>' }
  const site = createHttpServer((req, res) => {
    if (req.url === '/private') {
      res.writeHead(401)
      res.end()
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
    await fn(`http://127.0.0.1:${site.address().port}`, pages)
  } finally {
    site.closeAllConnections?.()
    site.close()
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
const message = (panel) => panel.locator('[data-testid="source-documents-message"]')

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

test('with the off switch set, neither the editor nor the Interview page offers adding by address, and uploading still works', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-318-off-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    await withRunningServer({ slug: 'my-initiative', instancesDir, sourceFetchDisabled: true }, (base) =>
      withPage(async (page) => {
        // Each screen asks the server whether it fetches; the answer is awaited, so "no form" is the answer and not a page still loading.
        const statusAnswer = async () => (await page.waitForResponse((res) => new URL(res.url()).pathname === '/api/sources/fetch')).json()
        let answered = statusAnswer()
        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        assert.deepEqual(await answered, { enabled: false, maxBytes: 25 * 1024 * 1024 })
        await panel.locator('[data-testid="source-documents-input"]').waitFor({ state: 'attached' })
        assert.equal(await panel.locator('[data-testid="source-address-form"]').count(), 0)

        answered = statusAnswer()
        await page.goto(`${base}/instance/my-initiative?interview=1`)
        const rail = page.locator('[data-testid="source-documents-compact"]')
        await rail.waitFor({ timeout: 15_000 })
        assert.equal((await answered).enabled, false)
        await rail.locator('[data-testid="source-documents-input"]').waitFor({ state: 'attached' })
        assert.equal(await rail.locator('[data-testid="source-address-form"]').count(), 0)
      })
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
    return rememberWorkspace({ handle: dir, name: 'Local Address Workspace' })
  }, { files })
}

test('local workspace: the server fetches the page and the folder keeps it; with the server unreachable the panel says why', async () => {
  await withSite((site) =>
    withRunningServer({ allowPrivateSourceUrls: true }, (base) =>
      withPage(async (page) => {
        const slug = 'local-address'
        await page.goto(`${base}/`)
        const workspaceId = await seedLocalWorkspace(page, slug)
        await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        const form = panel.locator('[data-testid="source-address-form"]')
        await form.waitFor()
        const uploads = []
        page.on('request', (req) => {
          if (new URL(req.url()).pathname.startsWith('/api/instance/sources')) uploads.push(req.url())
        })
        await form.locator('[data-testid="source-address-input"]').fill(`${site}/guide`)
        await form.locator('[data-testid="source-address-add"]').click()
        await rowFor(panel, 'Vendor API guide').waitFor({ timeout: 60_000 })
        assert.deepEqual(uploads, [], 'the document is stored in the folder, not on the server')
        const manifest = await page.evaluate(async () => {
          const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
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
          return readTextFile(handle, 'gantry-workspace/local-address/sources/manifest.yaml')
        })
        assert.match(manifest, /origin:\n {4}address: http:\/\/127\.0\.0\.1:\d+\/guide/)

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
