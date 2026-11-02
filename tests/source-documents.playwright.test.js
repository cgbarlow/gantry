import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import { pngImage, powerPointWithNotes, scannedPdf, spreadsheet, textPdf, wordDocument } from './helpers/sourceFixtures.js'

// #279 (map #238): browser coverage for the Source documents panel in the Instance editor, on a server workspace (disk) and on a Local Workspace. Reading a document's text happens in the page with the real officeparser browser build, so this is also where "nothing is fetched from a CDN" is checked: every request the page makes while documents are read stays on the app's own origin. The lifecycle itself is covered below the browser in tests/sourceDocuments.test.js and the routes in tests/serverSourceDocuments.test.js.

const docxFile = (name = 'Client brief.docx') => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(wordDocument()) })

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

const openPanel = async (page) => {
  const panel = page.locator('[data-testid="source-documents"]')
  await panel.waitFor({ timeout: 15_000 })
  if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
  return panel
}
const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const message = (panel) => panel.locator('[data-testid="source-documents-message"]')

// Every request the page makes from now on, so a test can say none went to another site.
function watchRequests(page, base) {
  const origin = new URL(base).origin
  const outside = []
  const posts = []
  page.on('request', (req) => {
    const url = req.url()
    if (!url.startsWith('data:') && !url.startsWith('blob:') && new URL(url).origin !== origin) outside.push(url)
    if (req.method() === 'POST' || req.method() === 'PUT') posts.push({ url, body: req.postData() ?? '' })
  })
  return { outside, posts }
}

test('server workspace: upload, list, rename, read again, download and remove Source documents', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-279-e2e-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRunningServer({ slug: 'my-initiative', instancesDir }, (base) =>
      withPage(async (page, pageErrors) => {
        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        await panel.locator('[data-testid="source-documents-empty"]').waitFor()
        const { outside, posts } = watchRequests(page, base)
        const input = panel.locator('[data-testid="source-documents-input"]')

        // Word: the text is read in the browser and stored beside the original.
        await input.setInputFiles(docxFile())
        const word = rowFor(panel, 'Client brief')
        await word.waitFor()
        assert.match(await word.textContent(), /TEXT READ/)
        assert.match(await message(panel).textContent(), /Added "Client brief" and read its text/)
        const wordText = readFileSync(join(sourcesDir, '.text', 'Client brief.docx.md'), 'utf8')
        assert.match(wordText, /The platform must support \*\*5000\*\* users\./)
        assert.deepEqual(readFileSync(join(sourcesDir, 'Client brief.docx')), Buffer.from(wordDocument()))

        // PowerPoint with speaker notes, a spreadsheet, a text PDF, a scanned PDF and a picture.
        await input.setInputFiles({ name: 'Kick-off.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from(powerPointWithNotes()) })
        await rowFor(panel, 'Kick-off').waitFor()
        assert.match(readFileSync(join(sourcesDir, '.text', 'Kick-off.pptx.md'), 'utf8'), /The sponsor wants go-live before March\./)

        await input.setInputFiles({ name: 'Budget.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(await spreadsheet([{ name: 'Costs', rows: [['item', 'cost'], ['Licence', 1000]] }])) })
        await rowFor(panel, 'Budget').waitFor()
        assert.match(readFileSync(join(sourcesDir, '.text', 'Budget.xlsx.md'), 'utf8'), /\| Licence \| 1000 \|/)

        await input.setInputFiles({ name: 'Requirements.pdf', mimeType: 'application/pdf', buffer: Buffer.from(textPdf([['Requirement one: the platform must support 5000 users.', 'Requirement two: data is kept for seven years.']])) })
        await rowFor(panel, 'Requirements').waitFor()
        assert.match(await rowFor(panel, 'Requirements').textContent(), /TEXT READ/)
        assert.match(readFileSync(join(sourcesDir, '.text', 'Requirements.pdf.md'), 'utf8'), /## Page 1\n\nRequirement one/)

        await input.setInputFiles({ name: 'Scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(scannedPdf()) })
        await rowFor(panel, 'Scan').waitFor()
        assert.match(await rowFor(panel, 'Scan').textContent(), /NO TEXT/)
        assert.equal(existsSync(join(sourcesDir, '.text', 'Scan.pdf.md')), false, 'a scanned PDF gets no text file')
        assert.match(await message(panel).textContent(), /looks scanned/)

        await input.setInputFiles({ name: 'Whiteboard.png', mimeType: 'image/png', buffer: Buffer.from(pngImage()) })
        await rowFor(panel, 'Whiteboard').waitFor()
        assert.match(await rowFor(panel, 'Whiteboard').textContent(), /NO TEXT/)
        assert.equal(existsSync(join(sourcesDir, '.text', 'Whiteboard.png.md')), false, 'an image gets no text file')

        // Nothing was fetched from another site while documents (a PDF among them) were read.
        assert.deepEqual(outside, [], 'no request left the app\'s own origin')
        assert.ok(posts.every((p) => p.url.startsWith(`${base}/api/instance/sources`)), 'uploads went to the Source documents route only')

        // The manifest holds what #245 lists.
        const manifest = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8'))
        assert.deepEqual(manifest.map((e) => e.id), ['client-brief', 'kick-off', 'budget', 'requirements', 'scan', 'whiteboard'])
        assert.deepEqual(Object.keys(manifest[0]), ['id', 'filename', 'title', 'uploadedBy', 'uploadedAt', 'size', 'text'])

        // A document named like an existing one is a new document.
        await input.setInputFiles(docxFile())
        await rowFor(panel, 'Client brief').nth(1).waitFor()
        assert.equal(await rowFor(panel, 'Client brief').count(), 2)
        assert.ok(existsSync(join(sourcesDir, 'Client brief-2.docx')))

        // Rename changes only the title.
        await rowFor(panel, 'Whiteboard').getByRole('button', { name: 'Rename' }).click()
        await panel.locator('[data-testid="source-documents-rename-input"]').fill('Whiteboard photo')
        await panel.getByRole('button', { name: 'Save', exact: true }).click()
        await rowFor(panel, 'Whiteboard photo').waitFor()
        assert.ok(existsSync(join(sourcesDir, 'Whiteboard.png')), 'the stored file keeps its name')
        const renamed = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8')).find((e) => e.id === 'whiteboard')
        assert.equal(renamed.title, 'Whiteboard photo')
        assert.equal(renamed.filename, 'Whiteboard.png')

        // Extract text again re-runs the reading and rewrites the text file.
        const textPath = join(sourcesDir, '.text', 'Client brief.docx.md')
        writeFileSync(textPath, 'stale')
        await rowFor(panel, 'Client brief').first().getByRole('button', { name: 'Extract text again' }).click()
        await page.waitForFunction(() => /Read the text of/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
        assert.equal(readFileSync(textPath, 'utf8'), wordText, 'the text was read again from the original')

        // Download hands back the original bytes.
        const [download] = await Promise.all([page.waitForEvent('download'), rowFor(panel, 'Whiteboard photo').getByRole('button', { name: 'Download' }).click()])
        assert.deepEqual(readFileSync(await download.path()), Buffer.from(pngImage()))

        // Remove deletes the file and text, and keeps the entry marked removed.
        await rowFor(panel, 'Kick-off').getByRole('button', { name: 'Remove' }).click()
        await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
        await rowFor(panel, 'Kick-off').waitFor({ state: 'detached' })
        assert.equal(existsSync(join(sourcesDir, 'Kick-off.pptx')), false)
        assert.equal(existsSync(join(sourcesDir, '.text', 'Kick-off.pptx.md')), false)
        const removedEntry = parseYAML(readFileSync(join(sourcesDir, 'manifest.yaml'), 'utf8')).find((e) => e.id === 'kick-off')
        assert.ok(removedEntry.removedAt)
        assert.equal(removedEntry.title, 'Kick-off')
        await panel.locator('[data-testid="source-documents-removed"] summary').click()
        assert.match(await panel.locator('[data-testid="source-documents-removed"]').textContent(), /Kick-off/)

        // The list survives a reload.
        await page.reload()
        const again = await openPanel(page)
        await rowFor(again, 'Whiteboard photo').waitFor()
        assert.equal(await again.locator('tr[data-source-id]').count(), 6)

        // Source documents are not Assets.
        const assets = await (await fetch(`${base}/api/instance/assets?slug=my-initiative`)).json()
        assert.deepEqual(assets, [])
        assert.deepEqual(pageErrors, [])
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: a 26 MB document is refused in the browser, and past 100 MB the Instance shows a warning', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-279-e2e-'))
  try {
    createInstance('design', 'my-initiative', { instancesDir })
    const sourcesDir = join(instancesDir, 'default', 'my-initiative', 'sources')
    await withRunningServer({ slug: 'my-initiative', instancesDir }, (base) =>
      withPage(async (page, pageErrors) => {
        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        await panel.locator('[data-testid="source-documents-empty"]').waitFor()
        assert.equal(await panel.locator('[data-testid="source-documents-warning"]').count(), 0)
        const { posts } = watchRequests(page, base)

        const hugePath = join(instancesDir, 'Huge.pdf')
        writeFileSync(hugePath, Buffer.alloc(26 * 1024 * 1024, 1))
        await panel.locator('[data-testid="source-documents-input"]').setInputFiles(hugePath)
        await page.waitForFunction(() => /over the 25 MB limit/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
        assert.match(await message(panel).textContent(), /"Huge\.pdf" is 26 MB, over the 25 MB limit/)
        assert.deepEqual(posts, [], 'the document was never sent to the server')
        assert.equal(existsSync(sourcesDir), false)

        // A type Gantry cannot read is refused too, with a hint.
        await panel.locator('[data-testid="source-documents-input"]').setInputFiles({ name: 'Old.doc', mimeType: 'application/msword', buffer: Buffer.from('x') })
        await page.waitForFunction(() => /Save it as \.docx/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))

        // Five 25 MB documents already in the Instance (their entries are enough for the total).
        mkdirSync(sourcesDir, { recursive: true })
        writeFileSync(
          join(sourcesDir, 'manifest.yaml'),
          stringifyYAML(Array.from({ length: 5 }, (_, i) => ({ id: `pack-${i}`, filename: `pack-${i}.pdf`, title: `Pack ${i}`, uploadedBy: '', uploadedAt: '2026-11-02T00:00:00.000Z', size: 25 * 1024 * 1024 })))
        )
        await page.reload()
        const again = await openPanel(page)
        await again.locator('[data-testid="source-documents-warning"]').waitFor()
        assert.match(await again.locator('[data-testid="source-documents-warning"]').textContent(), /125 MB, past about 100 MB/)
        assert.deepEqual(pageErrors, [])
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// --- Local Workspace -----------------------------------------------------------------------------------------------

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

// The File System Access API can't be driven in a headless browser, so the workspace is an OPFS folder remembered in IndexedDB, as tests/editor-local-workspace.playwright.test.js does.
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
    return rememberWorkspace({ handle: dir, name: 'Local Source Workspace' })
  }, { files })
}

async function readLocal(page, path, as = 'text') {
  return page.evaluate(async ({ path, as }) => {
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
      return as === 'text' ? await readTextFile(handle, path) : Array.from(await readBinaryFile(handle, path))
    } catch (err) {
      if (err?.name === 'NotFoundError') return null
      throw err
    }
  }, { path, as })
}

test('local workspace: Source documents are kept in the folder, and a render request carries none of them', async () => {
  await withRunningServer({}, (base) =>
    withPage(async (page, pageErrors) => {
      const slug = 'local-sources'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)
      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 15_000 })
      const panel = await openPanel(page)
      await panel.locator('[data-testid="source-documents-empty"]').waitFor()
      const { outside, posts } = watchRequests(page, base)
      const apiRequests = []
      page.on('request', (req) => {
        if (new URL(req.url()).pathname.startsWith('/api/')) apiRequests.push({ url: req.url(), method: req.method(), body: req.postData() ?? '' })
      })
      const input = panel.locator('[data-testid="source-documents-input"]')

      const marker = 'UNIQUE-SOURCE-MARKER-4471'
      await input.setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`Meeting notes. ${marker}\n`) })
      await rowFor(panel, 'Notes').waitFor()
      await input.setInputFiles(docxFile())
      await rowFor(panel, 'Client brief').waitFor()
      await input.setInputFiles({ name: 'Requirements.pdf', mimeType: 'application/pdf', buffer: Buffer.from(textPdf([['Requirement one: the platform must support 5000 users.', 'Requirement two: data is kept for seven years.']])) })
      await rowFor(panel, 'Requirements').waitFor()
      assert.match(await rowFor(panel, 'Requirements').textContent(), /TEXT READ/)
      await input.setInputFiles({ name: 'Whiteboard.png', mimeType: 'image/png', buffer: Buffer.from(pngImage()) })
      await rowFor(panel, 'Whiteboard').waitFor()

      // Everything is in the Instance's own folder, and nothing went to the server or anywhere else.
      assert.deepEqual(outside, [])
      assert.deepEqual(posts, [], 'no upload request: a Local Workspace never sends Source documents to the server')
      const folder = `gantry-workspace/${slug}/sources`
      const manifest = parseYAML(await readLocal(page, `${folder}/manifest.yaml`))
      assert.deepEqual(manifest.map((e) => e.id), ['notes', 'client-brief', 'requirements', 'whiteboard'])
      assert.deepEqual(manifest.map((e) => e.uploadedBy), ['a.architect', 'a.architect', 'a.architect', 'a.architect'])
      assert.match(await readLocal(page, `${folder}/.text/Client brief.docx.md`), /The platform must support \*\*5000\*\* users\./)
      assert.match(await readLocal(page, `${folder}/.text/Requirements.pdf.md`), /## Page 1\n\nRequirement one/)
      assert.equal(await readLocal(page, `${folder}/.text/Whiteboard.png.md`), null)
      assert.deepEqual(await readLocal(page, `${folder}/Whiteboard.png`, 'bytes'), Array.from(pngImage()))

      // Rename, read again and remove all work in the folder.
      await rowFor(panel, 'Notes').getByRole('button', { name: 'Rename' }).click()
      await panel.locator('[data-testid="source-documents-rename-input"]').fill('Workshop notes')
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await rowFor(panel, 'Workshop notes').waitFor()
      const renamed = parseYAML(await readLocal(page, `${folder}/manifest.yaml`)).find((e) => e.id === 'notes')
      assert.equal(renamed.title, 'Workshop notes')
      assert.equal(renamed.filename, 'Notes.txt')
      await rowFor(panel, 'Workshop notes').getByRole('button', { name: 'Extract text again' }).click()
      await page.waitForFunction(() => /Read the text of "Workshop notes" again/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
      await rowFor(panel, 'Whiteboard').getByRole('button', { name: 'Remove' }).click()
      await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
      await rowFor(panel, 'Whiteboard').waitFor({ state: 'detached' })
      assert.equal(await readLocal(page, `${folder}/Whiteboard.png`, 'bytes'), null)
      assert.ok(parseYAML(await readLocal(page, `${folder}/manifest.yaml`)).find((e) => e.id === 'whiteboard').removedAt)

      // Render (the browser's own pandoc-wasm path when it is ready, the server's otherwise): a request that carries the Instance's files carries no Source documents.
      apiRequests.length = 0
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 30_000 }
      )
      assert.doesNotMatch(await renderDialog.textContent(), /render failed/)
      const localCalls = apiRequests.filter((r) => r.url.includes('/api/local/'))
      assert.ok(localCalls.length > 0, 'the render went through /api/local/*')
      const forbidden = [marker, Buffer.from(marker).toString('base64').slice(0, 20), 'sources/', 'manifest.yaml', 'Client brief', 'Whiteboard', 'Requirement one']
      for (const call of localCalls) {
        for (const needle of forbidden) assert.ok(!call.body.includes(needle), `${call.url} must not carry "${needle}"`)
      }
      assert.deepEqual(pageErrors, [])
    })
  )
})
