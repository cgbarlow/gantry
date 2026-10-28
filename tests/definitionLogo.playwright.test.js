import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOGO_ALT_TEXT, readHeaderLogo } from '../web/lib/definitionLogo.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { docxPart } from './helpers/wordDocx.js'
import { pngImage } from './helpers/logoImages.js'

// #222 (docs/adr/0059): the Definitions page's Logo control. On a draft it shows the header logo of
// the Definition's reference documents with Download and Replace; Replace writes a new PNG or JPEG
// into every one of them, and the browser's own pandoc-wasm render afterwards shows it. A published
// version offers Download only, and a Local Workspace's Definition editor has the same control.
// tests/definitionLogo.test.js and tests/serverDefinitionLogo.test.js cover the same behaviour
// below the browser, and the native render.

const CONTOSO = Buffer.from((await readHeaderLogo(readFileSync('definitions/design/3/templates/reference.docx'))).bytes)
const NEW_LOGO = pngImage(120, 120, [0xc0, 0x30, 0x30])

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

async function openVersion(page, base, version) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
  await page.locator('#defn-version-select').selectOption(String(version))
  await page.waitForSelector('.defn-outline', { timeout: 10_000 })
  const logo = page.locator('section.defn-logo')
  await logo.waitFor({ state: 'visible', timeout: 10_000 })
  return logo
}

// The preview's natural width, once the image has loaded: which image it is, for a test.
async function previewWidth(logo) {
  const preview = logo.locator('img.defn-logo-preview')
  await preview.waitFor({ state: 'visible', timeout: 10_000 })
  return preview.evaluate((img) => (img.complete ? img.naturalWidth : new Promise((resolve) => img.addEventListener('load', () => resolve(img.naturalWidth)))))
}

async function downloadLogo(page, logo) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), logo.getByRole('button', { name: 'Download' }).click()])
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) }
}

test('Definitions page: a draft shows the Contoso logo, Replace writes a new one into every reference document, and the browser\'s render shows it; a published version offers Download only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-logo-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    // The bundled design v3 example, at Detailed Design so its SAD can be rendered.
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    const instanceYaml = join(instancesDir, 'examples', 'instance.yaml')
    writeFileSync(instanceYaml, readFileSync(instanceYaml, 'utf8').replace(/^stage: .*$/m, 'stage: detailed-design'))
    const templates = join(definitionsDir, 'design', '3', 'templates')
    const v3Docs = readdirSync(templates).filter((f) => f.endsWith('.docx'))

    await withRunningServer({ slug: 'examples', definitionsDir, instancesDir }, (base) => withPage(async (page) => {
      let logo = await openVersion(page, base, 3)
      assert.equal(await previewWidth(logo), 192, 'the Contoso logo is shown')
      assert.match(await logo.textContent(), /every Artefact's reference document/)
      const before = await downloadLogo(page, logo)
      assert.equal(before.name, 'logo.png')
      assert.deepEqual(before.bytes, CONTOSO)

      // A file that isn't a PNG or JPEG is refused, and nothing changes.
      const replace = logo.locator('input[aria-label="Replace logo"]')
      await replace.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
      await logo.locator('.inline-error').waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await logo.locator('.inline-error').textContent(), 'The logo must be a PNG or JPEG image.')
      for (const file of v3Docs) assert.deepEqual(readFileSync(join(templates, file)), readFileSync(join('definitions/design/3/templates', file)), file)

      await replace.setInputFiles({ name: 'our-logo.png', mimeType: 'image/png', buffer: NEW_LOGO })
      await logo.locator('.defn-logo-status.save-status').waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await logo.locator('.defn-logo-status.save-status').textContent(), 'Logo replaced in 7 reference documents.')
      await page.waitForFunction(() => document.querySelector('img.defn-logo-preview')?.naturalWidth === 120, null, { timeout: 10_000 })
      assert.deepEqual((await downloadLogo(page, logo)).bytes, NEW_LOGO)
      for (const file of v3Docs) {
        const found = await readHeaderLogo(readFileSync(join(templates, file)))
        assert.deepEqual(Buffer.from(found.bytes), NEW_LOGO, `${file} has the new logo`)
      }

      // A published version: Download, no Replace.
      logo = await openVersion(page, base, 2)
      assert.equal(await previewWidth(logo), 192)
      assert.equal(await logo.locator('input[aria-label="Replace logo"]').count(), 0)
      assert.equal(await logo.getByRole('button', { name: 'Download' }).isEnabled(), true)

      // The browser's own render (pandoc-wasm) of a v3 Artefact carries the new logo in its header.
      const requested = []
      page.on('request', (req) => requested.push(new URL(req.url()).pathname))
      await page.goto(`${base}/instance/examples`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution Architecture Document', exact: true }).click()
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90_000 }),
        renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click(),
      ])
      assert.ok(requested.some((p) => p.startsWith('/api/instance/render-wasm-finish/')), 'pandoc-wasm did the conversion')
      const docx = readFileSync(await download.path())
      const rendered = await readHeaderLogo(docx)
      assert.deepEqual(Buffer.from(rendered.bytes), NEW_LOGO, 'the rendered document\'s header shows the new logo')
      const headerParts = docxPart(docx, '\\[Content_Types\\].xml').match(/\/word\/header\d*\.xml/g)
      const headers = headerParts.map((part) => docxPart(docx, part.slice(1))).join('')
      assert.match(headers, new RegExp(`descr="${LOGO_ALT_TEXT}"`))
      assert.doesNotMatch(headers, /Contoso/i)
    }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Local Workspace editor: the Logo control shows a reference document\'s header logo, follows a reference docx upload, and Replace writes a new one into each', async () => {
  await withRunningServer({}, (base) => withPage(async (page) => {
    await page.goto(`${base}/`)
    const workspaceId = await page.evaluate(async () => {
      const { rememberWorkspace } = await import('/lib/localWorkspace.js')
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('local-ws-logo-' + Date.now(), { create: true })
      return rememberWorkspace({ handle: dir, name: 'Logo E2E Workspace' })
    })
    await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
    await page.waitForSelector('#local-def-id')
    await page.locator('#local-def-id').fill('logo-local-e2e')
    await page.locator('#local-def-title').fill('Logo Local E2E')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForSelector('.local-definition-editor')

    let logo = page.locator('.local-definition-editor section.defn-logo')
    await logo.locator('.defn-logo-none').waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await logo.textContent(), /no reference documents/)

    // A reference docx uploaded for an Artefact shows its logo in the control straight away.
    const artefactsSection = page.locator('.local-definition-editor section').filter({ has: page.getByRole('heading', { name: 'Artefacts' }) })
    await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
    await artefactsSection.locator('input[placeholder="artefact-id"]').fill('sad')
    await artefactsSection.getByRole('button', { name: 'Edit template' }).click()
    await artefactsSection.locator('.local-def-template input[type="file"]').setInputFiles('definitions/design/3/templates/reference-sad.docx')
    await artefactsSection.getByText('Reference document saved.').waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await previewWidth(logo), 192, 'the uploaded reference document\'s Contoso logo is shown')

    // Give the definition design v3's shared reference document, as copying it into templates/ would.
    await page.evaluate(async ({ workspaceId, bytes }) => {
      const { getWorkspaceHandle, writeBinaryFile } = await import('/lib/localWorkspace.js')
      await writeBinaryFile(await getWorkspaceHandle(workspaceId), 'definitions/logo-local-e2e/1/templates/reference.docx', new Uint8Array(bytes))
    }, { workspaceId, bytes: [...readFileSync('definitions/design/3/templates/reference.docx')] })
    await page.reload()
    await page.waitForSelector('.local-definition-editor')
    logo = page.locator('.local-definition-editor section.defn-logo')
    assert.equal(await previewWidth(logo), 192, 'the Contoso logo is shown')

    await logo.locator('input[aria-label="Replace logo"]').setInputFiles({ name: 'our-logo.png', mimeType: 'image/png', buffer: NEW_LOGO })
    await logo.locator('.defn-logo-status.save-status').waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await logo.locator('.defn-logo-status.save-status').textContent(), 'Logo replaced in 2 reference documents.')
    await page.waitForFunction(() => document.querySelector('img.defn-logo-preview')?.naturalWidth === 120, null, { timeout: 10_000 })

    for (const name of ['reference.docx', 'reference-sad.docx']) {
      const saved = await page.evaluate(async ({ workspaceId, name }) => {
        const { getWorkspaceHandle, readBinaryFile } = await import('/lib/localWorkspace.js')
        return [...(await readBinaryFile(await getWorkspaceHandle(workspaceId), `definitions/logo-local-e2e/1/templates/${name}`))]
      }, { workspaceId, name })
      assert.deepEqual(Buffer.from((await readHeaderLogo(Buffer.from(saved))).bytes), NEW_LOGO, `the workspace's own ${name} has the new logo`)
    }
  }))
})
