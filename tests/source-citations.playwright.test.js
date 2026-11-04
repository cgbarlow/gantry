import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showFields, showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import { pngImage } from './helpers/sourceFixtures.js'

// #281 (map #238): browser coverage for citing a Source document from module content. In the editor a `[text](source:<id>)` citation opens the document when clicked, a removed document's citation keeps its words and is marked, and **Use as image** copies a picture into the Instance's images as a new, independent Asset. The syntax, the Word text and the Sources appendix are covered under node --test in tests/sourceCitations.test.js.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const NOTES_TEXT = 'Workshop notes. Median time to payment is 12.4 working days.'
const CITATIONS =
  'Median time is 12.4 days [Workshop notes, p. 2](source:notes), as the [old plan](source:old-plan) said, and a [mystery](source:mystery) says.'

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
  } finally {
    await browser.close()
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

// Pages the browser opens (a Source document opened from a citation goes to a new tab).
function watchPopups(page) {
  const popups = []
  page.context().on('page', (popup) => popups.push(popup))
  return popups
}

test('server workspace: a citation opens the document, a removed one keeps its words marked removed, and Use as image copies an independent Asset', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-281-e2e-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const background = join(instancesDir, 'examples', 'modules', 'background.md')
    const before = readFileSync(background, 'utf8')
    const after = before.replace(/\n## Affected domains/, `\n${CITATIONS}\n\n## Affected domains`)
    assert.notEqual(after, before)
    writeFileSync(background, after)
    const sourcesDir = join(instancesDir, 'examples', 'sources')
    mkdirSync(sourcesDir, { recursive: true })
    writeFileSync(join(sourcesDir, 'Notes.txt'), NOTES_TEXT)
    writeFileSync(join(sourcesDir, 'Whiteboard.png'), Buffer.from(pngImage()))
    writeFileSync(
      join(sourcesDir, 'manifest.yaml'),
      stringifyYAML([
        { id: 'notes', filename: 'Notes.txt', title: 'Workshop notes', uploadedBy: 'a.architect', uploadedAt: '2026-03-04T09:30:00.000Z', size: NOTES_TEXT.length },
        { id: 'whiteboard', filename: 'Whiteboard.png', title: 'Whiteboard', uploadedBy: 'a.architect', uploadedAt: '2026-03-04T09:31:00.000Z', size: pngImage().byteLength },
        { id: 'old-plan', filename: 'Old plan.pdf', title: 'Old plan', uploadedBy: 'a.architect', uploadedAt: '2026-01-15T00:00:00.000Z', size: 100, removedBy: 'a.architect', removedAt: '2026-02-01T00:00:00.000Z' },
      ])
    )

    await withRunningServer({ slug: 'examples', instancesDir }, (base) =>
      withPage(async (page, pageErrors) => {
        // Starting the server moves a flat Instance folder into its workspace folder.
        const keptSources = join(instancesDir, 'default', 'examples', 'sources')
        const popups = watchPopups(page)
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 15_000 })

        // The editor draws each citation by what it cites.
        const live = page.locator('.cm-vsource[data-source-id="notes"]').first()
        await live.waitFor({ timeout: 15_000 })
        assert.match(await live.textContent(), /Workshop notes, p\. 2/)
        const removed = page.locator('.cm-vsource-removed[data-source-id="old-plan"]').first()
        await removed.waitFor()
        assert.match(await removed.getAttribute('title'), /"Old plan" was removed/)
        assert.match(await removed.textContent(), /old plan/)
        const missing = page.locator('.cm-vsource-missing[data-source-id="mystery"]').first()
        await missing.waitFor()
        assert.equal(await page.locator('.cm-vsource-removed, .cm-vsource-missing').evaluateAll((els) => els.every((el) => !el.classList.contains('cm-vsource'))), true)

        // A removed or unknown document is not a link: clicking opens nothing.
        await removed.locator('span').first().click()
        await missing.locator('span').first().click()
        await page.waitForTimeout(400)
        assert.equal(popups.length, 0, 'no tab for a removed or unknown document')

        // A live one opens the document in a new tab.
        await live.locator('span').first().click() // the words themselves, as a person clicks them
        await page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null)
        await page.waitForTimeout(200)
        const opened = popups.at(-1)
        assert.ok(opened, 'the document opened in a new tab')
        await opened.waitForLoadState()
        assert.match(opened.url(), /^blob:/)
        assert.equal(await opened.locator('body').innerText(), NOTES_TEXT)
        await opened.close()
        // #320: a citation leads into the Source documents, so Sources & decisions is on.
        assert.equal(await page.getByTestId('reference-toggle').getAttribute('aria-pressed'), 'true')
        assert.equal(await page.locator('main#modules').isVisible(), false)

        // The panel offers the citation to paste, and Use as image for a PNG or JPEG only.
        const panel = await openPanel(page)
        const notes = rowFor(panel, 'Workshop notes')
        await notes.getByRole('button', { name: 'Copy citation' }).click()
        await page.waitForFunction(() => /\[Workshop notes\]\(source:notes\)/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
        assert.equal(await notes.getByRole('button', { name: 'Use as image' }).count(), 0, 'a text file is not an image')
        const whiteboard = rowFor(panel, 'Whiteboard')
        await whiteboard.getByRole('button', { name: 'Use as image' }).click()
        await page.waitForFunction(() => /Copied "Whiteboard" to the images as a new image/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
        assert.match(await message(panel).textContent(), /!\[Whiteboard\]\(asset:[\w-]+\)/)

        // It is a new Asset of its own: the same bytes, named for the document, and its source is where it was copied from.
        const assets = await (await fetch(`${base}/api/instance/assets?slug=examples`)).json()
        const copy = assets.find((a) => a.name === 'Whiteboard')
        assert.ok(copy, 'the Instance has a Whiteboard image')
        assert.equal(copy.source, 'sources/Whiteboard.png')
        const copiedBytes = Buffer.from(await (await fetch(`${base}/api/instance/assets/${copy.id}/file?slug=examples`)).arrayBuffer())
        assert.deepEqual(copiedBytes, Buffer.from(pngImage()))

        // Removing the document leaves the image, and the document's own entry stays marked removed.
        await whiteboard.getByRole('button', { name: 'Remove' }).click()
        await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
        await whiteboard.waitFor({ state: 'detached' })
        assert.equal(existsSync(join(keptSources, 'Whiteboard.png')), false)
        assert.equal(existsSync(join(keptSources, 'Notes.txt')), true)
        const stillThere = await (await fetch(`${base}/api/instance/assets/${copy.id}/file?slug=examples`)).arrayBuffer()
        assert.equal(Buffer.from(stillThere).length, pngImage().byteLength, 'the image survives the document')
        assert.ok(parseYAML(readFileSync(join(keptSources, 'manifest.yaml'), 'utf8')).find((e) => e.id === 'whiteboard').removedAt)

        assert.deepEqual(pageErrors, [])
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: Use as image refuses a type an Asset cannot be, and an upload cannot claim a Source document as its origin', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-281-e2e-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const sourcesDir = join(instancesDir, 'examples', 'sources')
    mkdirSync(sourcesDir, { recursive: true })
    writeFileSync(join(sourcesDir, 'Notes.txt'), NOTES_TEXT)
    writeFileSync(
      join(sourcesDir, 'manifest.yaml'),
      stringifyYAML([{ id: 'notes', filename: 'Notes.txt', title: 'Workshop notes', uploadedBy: '', uploadedAt: '2026-03-04T09:30:00.000Z', size: NOTES_TEXT.length }])
    )
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const refused = await fetch(`${base}/api/instance/sources/notes/as-asset?slug=examples`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(refused.status, 400)
      assert.match((await refused.json()).error, /Only a PNG or JPEG can be used as an image/)
      const missing = await fetch(`${base}/api/instance/sources/nope/as-asset?slug=examples`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(missing.status, 404)
      const wrongMethod = await fetch(`${base}/api/instance/sources/notes/as-asset?slug=examples`)
      assert.equal(wrongMethod.status, 405)
      const forged = await fetch(`${base}/api/instance/assets?slug=examples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'x.png', dataBase64: Buffer.from(pngImage()).toString('base64'), name: 'x', source: 'sources/Notes.txt' }),
      })
      assert.equal(forged.status, 400, 'the usual web address is still required of an upload')
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// --- Local Workspace -----------------------------------------------------------------------------------------------

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

// The File System Access API can't be driven in a headless browser, so the workspace is an OPFS folder remembered in IndexedDB, as tests/source-documents.playwright.test.js does.
async function seedLocalWorkspace(page, slug) {
  const files = { [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n` }
  for (const moduleId of SHAPE_MODULES) {
    let text = exampleModuleText(moduleId)
    if (moduleId === 'background') {
      const cited = text.replace(/\n## Affected domains/, `\nMedian time is 12.4 days [Workshop notes, p. 2](source:notes).\n\n## Affected domains`)
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
    return rememberWorkspace({ handle: dir, name: 'Local Citation Workspace' })
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

test('local workspace: a citation opens the document from the folder, Use as image copies it into assets/, and a render request carries only the cited documents\' titles', async () => {
  await withRunningServer({}, (base) =>
    withPage(async (page, pageErrors) => {
      const slug = 'local-citations'
      const popups = watchPopups(page)
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)
      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 15_000 })

      // Before the document is added, the citation names nothing the Instance has.
      const panel = await openPanel(page)
      await panel.locator('[data-testid="source-documents-empty"]').waitFor()
      await showFields(page)
      await page.locator('.cm-vsource-missing[data-source-id="notes"]').first().waitFor({ timeout: 15_000 })
      await showSourcesAndDecisions(page)

      const marker = 'UNIQUE-CITED-DOCUMENT-MARKER-9921'
      const input = panel.locator('[data-testid="source-documents-input"]')
      await input.setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`${marker}\n`) })
      await rowFor(panel, 'Notes').waitFor()
      await input.setInputFiles({ name: 'Whiteboard sketch.png', mimeType: 'image/png', buffer: Buffer.from(pngImage()) })
      await rowFor(panel, 'Whiteboard sketch').waitFor()
      await input.setInputFiles({ name: 'Unrelated.txt', mimeType: 'text/plain', buffer: Buffer.from('not cited anywhere\n') })
      await rowFor(panel, 'Unrelated').waitFor()

      // Now the same citation is a link, and clicking it opens the document kept in the folder.
      await showFields(page)
      const live = page.locator('.cm-vsource[data-source-id="notes"]').first()
      await live.waitFor({ timeout: 15_000 })
      await live.locator('span').first().click() // the words themselves, as a person clicks them
      await page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null)
      await page.waitForTimeout(200)
      const opened = popups.at(-1)
      assert.ok(opened, 'the document opened in a new tab')
      await opened.waitForLoadState()
      assert.match(await opened.locator('body').innerText(), new RegExp(marker))
      await opened.close()

      // Use as image: a new file in assets/, safe to type into ![alt](assets/<name>), and the document is untouched.
      await rowFor(panel, 'Whiteboard sketch').getByRole('button', { name: 'Use as image' }).click()
      await page.waitForFunction(() => /Copied "Whiteboard sketch" to the images/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
      assert.match(await message(panel).textContent(), /!\[Whiteboard sketch\]\(assets\/Whiteboard-sketch\.png\)/)
      assert.deepEqual(await readLocal(page, `gantry-workspace/${slug}/assets/Whiteboard-sketch.png`, 'bytes'), Array.from(pngImage()))
      assert.deepEqual(await readLocal(page, `gantry-workspace/${slug}/sources/Whiteboard sketch.png`, 'bytes'), Array.from(pngImage()))
      // Used again, the copy never overwrites the first.
      await rowFor(panel, 'Whiteboard sketch').getByRole('button', { name: 'Use as image' }).click()
      await page.waitForFunction(() => /assets\/Whiteboard-sketch-2\.png/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
      // Removing the document leaves the image alone.
      await rowFor(panel, 'Whiteboard sketch').getByRole('button', { name: 'Remove' }).click()
      await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
      await rowFor(panel, 'Whiteboard sketch').waitFor({ state: 'detached' })
      assert.equal(await readLocal(page, `gantry-workspace/${slug}/sources/Whiteboard sketch.png`, 'bytes'), null)
      assert.deepEqual(await readLocal(page, `gantry-workspace/${slug}/assets/Whiteboard-sketch.png`, 'bytes'), Array.from(pngImage()))

      // A render request carries the title, filename and dates of the one document the content cites, and nothing of it or of any other.
      const apiRequests = []
      page.on('request', (req) => {
        if (new URL(req.url()).pathname.startsWith('/api/local/')) apiRequests.push({ url: req.url(), body: req.postData() ?? '' })
      })
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
      assert.ok(apiRequests.length > 0, 'the render went through /api/local/*')
      for (const call of apiRequests) {
        const body = JSON.parse(call.body)
        assert.deepEqual(body.sources?.map((s) => s.id), ['notes'], 'only the cited document\'s entry')
        assert.equal(body.sources[0].title, 'Notes')
        assert.equal(body.sources[0].filename, 'Notes.txt')
        for (const needle of [marker, 'Unrelated', 'Whiteboard', 'sources/', 'manifest.yaml', 'uploadedBy']) {
          assert.ok(!call.body.includes(needle), `${call.url} must not carry "${needle}"`)
        }
      }
      assert.deepEqual(pageErrors, [])
    })
  )
})
