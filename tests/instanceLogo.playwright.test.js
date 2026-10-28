import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { LOGO_ALT_TEXT, readHeaderLogo } from '../web/lib/definitionLogo.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { docxPart } from './helpers/wordDocx.js'
import { pngImage } from './helpers/logoImages.js'

// #224 (spec #223, ADR-0058 and ADR-0059 amendments for #224): browser coverage for an Instance's
// own header logo. The "+ New Workspace" wizard offers an optional Logo upload, with a preview and a
// note pointing at the Definition's own Logo control, under the Instance settings heading — only for
// a Definition whose reference documents carry a header logo. Instance Settings (server-hosted and
// Local Workspace) shows the logo the instance's documents use and whose it is, with Download,
// Replace and Remove; the browser's own pandoc-wasm render shows the instance's logo.
// tests/instanceLogo.test.js covers the same behaviour below the browser, every Provider and the
// native render.

const V3_REFERENCE = readFileSync('definitions/design/3/templates/reference.docx')
const CONTOSO = Buffer.from((await readHeaderLogo(V3_REFERENCE)).bytes)
const OUR_LOGO = pngImage(160, 40, [0x20, 0x80, 0x40])
const NOT_AN_IMAGE = { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }

// tests/instanceSettings.playwright.test.js's one-stage fixture: `branded` ships design v3's shared
// reference document (the Contoso logo in its header), `plain` ships none.
function writeFixtureDefinition(definitionsDir, id, { referenceDocx } = {}) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    `id: ${id}\nversion: 1\nstatus: published\ntitle: ${id}\ndescription: A one-stage fixture\nstages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
  )
  writeFileSync(join(dir, 'modules', 'summary.yaml'), 'id: summary\ntitle: Summary\npurpose: What this is\nfields:\n  - id: overview\n    title: Overview\n    type: markdown\n')
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
  if (referenceDocx) writeFileSync(join(dir, 'templates', 'reference.docx'), referenceDocx)
}

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

const instanceSettingsSection = (page) => page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Instance settings', exact: true }) })

// The preview's natural width, once loaded: which image it shows, for a test.
async function previewWidth(scope) {
  const preview = scope.locator('img.instance-logo-preview')
  await preview.waitFor({ state: 'visible', timeout: 10_000 })
  return preview.evaluate((img) => (img.complete && img.naturalWidth ? img.naturalWidth : new Promise((resolve) => img.addEventListener('load', () => resolve(img.naturalWidth)))))
}

async function downloadLogo(page, control) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), control.getByRole('button', { name: 'Download' }).click()])
  return readFileSync(await download.path())
}

test('Instance Settings: the logo starts as the Definition\'s; Replace makes it the instance\'s own, which the browser\'s render shows; Remove goes back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-224-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    // At Detailed Design, as tests/definitionLogo.playwright.test.js has it, so its SAD can be rendered.
    const seededYaml = join(instancesDir, 'examples', 'instance.yaml')
    writeFileSync(seededYaml, readFileSync(seededYaml, 'utf8').replace(/^stage: .*$/m, 'stage: detailed-design'))
    // The server moves a legacy instance into its "default" workspace when it starts.
    const instanceDir = join(instancesDir, 'default', 'examples')

    await withRunningServer({ slug: 'examples', definitionsDir, instancesDir }, (base) =>
      withPage(async (page, pageErrors) => {
        await page.goto(`${base}/settings/instance?slug=examples`)
        const section = instanceSettingsSection(page)
        await section.waitFor({ timeout: 10_000 })
        const control = section.getByRole('group', { name: 'Logo' })
        await control.getByText("The Definition's logo", { exact: true }).waitFor({ timeout: 10_000 })
        assert.equal(await previewWidth(control), 192, 'the Contoso logo is shown')
        assert.deepEqual(await downloadLogo(page, control), CONTOSO)
        assert.equal(await control.getByRole('button', { name: 'Remove' }).isDisabled(), true, 'nothing of its own to remove')

        // A file that isn't a PNG or JPEG is refused, and nothing is written.
        const replace = control.locator('input[aria-label="Replace instance logo"]')
        await replace.setInputFiles(NOT_AN_IMAGE)
        await control.locator('.inline-error').waitFor({ timeout: 10_000 })
        assert.equal(await control.locator('.inline-error').textContent(), 'The logo must be a PNG or JPEG image.')
        assert.equal('logo' in parseYAML(readFileSync(join(instanceDir, 'instance.yaml'), 'utf8')), false)

        await replace.setInputFiles({ name: 'ours.png', mimeType: 'image/png', buffer: OUR_LOGO })
        await control.getByText("This instance's own logo", { exact: true }).waitFor({ timeout: 10_000 })
        await page.waitForFunction(() => document.querySelector('img.instance-logo-preview')?.naturalWidth === 160, null, { timeout: 10_000 })
        assert.deepEqual(await downloadLogo(page, control), OUR_LOGO)
        assert.equal(parseYAML(readFileSync(join(instanceDir, 'instance.yaml'), 'utf8')).logo, 'assets/instance-logo.png')
        assert.deepEqual(readFileSync(join(instanceDir, 'assets', 'instance-logo.png')), OUR_LOGO)

        // The browser's own render (pandoc-wasm) of a v3 Artefact carries the instance's logo.
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
        assert.deepEqual(Buffer.from((await readHeaderLogo(docx)).bytes), OUR_LOGO, 'the rendered header shows the instance\'s logo')
        const headers = docxPart(docx, '\\[Content_Types\\].xml').match(/\/word\/header\d*\.xml/g).map((part) => docxPart(docx, part.slice(1))).join('')
        assert.match(headers, new RegExp(`descr="${LOGO_ALT_TEXT}"`))
        assert.deepEqual(readFileSync(join(definitionsDir, 'design', '3', 'templates', 'reference.docx')), V3_REFERENCE, 'the Definition is untouched')

        await page.goto(`${base}/settings/instance?slug=examples`)
        const again = instanceSettingsSection(page).getByRole('group', { name: 'Logo' })
        await again.getByText("This instance's own logo", { exact: true }).waitFor({ timeout: 10_000 })
        await again.getByRole('button', { name: 'Remove' }).click()
        await again.getByText("The Definition's logo", { exact: true }).waitFor({ timeout: 10_000 })
        assert.equal('logo' in parseYAML(readFileSync(join(instanceDir, 'instance.yaml'), 'utf8')), false)
        assert.equal(existsSync(join(instanceDir, 'assets', 'instance-logo.png')), false)
        assert.deepEqual(pageErrors, [])
      })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// As tests/instanceSettings.playwright.test.js does, the folder picker hands back a fresh Origin
// Private File System directory, since the File System Access API can't be driven headless.
const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`
const FS_MOCK_INIT = `
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('pick-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
  }
`

// A file in the picked folder's `gantry-workspace/<slug>/`, as text or base64, or `null` when absent.
const readLocalFile = (page, slug, path, { binary = false } = {}) =>
  page.evaluate(
    async ({ slug, path, binary }) => {
      const root = await navigator.storage.getDirectory()
      for await (const [name, handle] of root.entries()) {
        if (!name.startsWith('pick-')) continue
        try {
          let dir = await (await handle.getDirectoryHandle('gantry-workspace')).getDirectoryHandle(slug)
          const segments = path.split('/')
          for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment)
          const file = await (await dir.getFileHandle(segments.at(-1))).getFile()
          if (!binary) return file.text()
          const bytes = new Uint8Array(await file.arrayBuffer())
          let text = ''
          for (const b of bytes) text += String.fromCharCode(b)
          return btoa(text)
        } catch {
          return null
        }
      }
      return null
    },
    { slug, path, binary }
  )

test('the wizard offers a Logo upload with a preview and a note only for a Definition with a header logo, stores it with a Local Workspace instance, and its Instance Settings changes it', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-224-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-224-browser-'))
  try {
    writeFixtureDefinition(definitionsDir, 'branded', { referenceDocx: V3_REFERENCE })
    writeFixtureDefinition(definitionsDir, 'plain')
    await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, (base) =>
      withPage(async (page, pageErrors) => {
        await page.addInitScript(ADVANCED_MODE_ON_INIT)
        await page.addInitScript(FS_MOCK_INIT)
        await page.goto(`${base}/new-workspace`)
        await page.waitForSelector('h2:has-text("New Workspace")')
        await page.getByRole('button', { name: 'Local', exact: true }).click()
        await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
        await page.locator('#local-register-pick').click()
        await page.locator('#local-ws-name').fill('Branded Workspace')
        await page.locator('#local-register-create').click()

        await page.waitForSelector('#instance-name')
        await page.locator('.definition-card', { hasText: '(plain)' }).click()
        await page.locator('#instance-name').fill('Branded Local')
        // Give the per-selection lookup time to land before asserting there is nothing to show.
        await page.waitForTimeout(500)
        assert.equal(await page.getByRole('heading', { name: 'Instance settings', exact: true }).count(), 0, 'no Logo without a header logo')
        assert.equal(await page.locator('input[aria-label="Instance logo"]').count(), 0)

        await page.locator('.definition-card', { hasText: '(branded)' }).click()
        const group = page.getByRole('region', { name: 'Instance settings' })
        await group.waitFor({ timeout: 10_000 })
        await group.getByText("The Definition's logo", { exact: true }).waitFor()
        const note = group.locator('.instance-logo-note')
        assert.equal(
          (await note.textContent()).trim(),
          "This logo is used for this instance only. To change the logo for every new instance, change the Definition's logo on the Definitions page."
        )
        assert.equal(await note.getByRole('link', { name: 'Definitions page' }).getAttribute('href'), '/definitions?id=branded&version=1')

        const upload = group.locator('input[aria-label="Instance logo"]')
        await upload.setInputFiles(NOT_AN_IMAGE)
        await group.locator('.inline-error').waitFor()
        assert.equal(await group.locator('.inline-error').textContent(), 'The logo must be a PNG or JPEG image.')
        await upload.setInputFiles({ name: 'ours.png', mimeType: 'image/png', buffer: OUR_LOGO })
        assert.equal(await previewWidth(group), 160, 'the preview shows what was picked')
        assert.equal(await group.locator('.inline-error').count(), 0)

        await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Create instance', exact: true }).click()])
        assert.match(await readLocalFile(page, 'branded-local', 'instance.yaml'), /^logo: assets\/instance-logo\.png$/m)
        assert.deepEqual(Buffer.from(await readLocalFile(page, 'branded-local', 'assets/instance-logo.png', { binary: true }), 'base64'), OUR_LOGO)
        const localId = new URL(page.url()).searchParams.get('local')
        assert.ok(localId, 'the editor opened on the Local Workspace instance')

        await page.goto(`${base}/settings/instance?slug=branded-local&local=${encodeURIComponent(localId)}`)
        const control = instanceSettingsSection(page).getByRole('group', { name: 'Logo' })
        await control.getByText("This instance's own logo", { exact: true }).waitFor({ timeout: 10_000 })
        assert.equal(await previewWidth(control), 160)
        await control.getByRole('button', { name: 'Remove' }).click()
        await control.getByText("The Definition's logo", { exact: true }).waitFor({ timeout: 10_000 })
        await page.waitForFunction(() => document.querySelector('img.instance-logo-preview')?.naturalWidth === 192, null, { timeout: 10_000 })
        assert.doesNotMatch(await readLocalFile(page, 'branded-local', 'instance.yaml'), /logo/)
        assert.equal(await readLocalFile(page, 'branded-local', 'assets/instance-logo.png'), null, 'the image is removed with it')

        await control.locator('input[aria-label="Replace instance logo"]').setInputFiles({ name: 'ours.png', mimeType: 'image/png', buffer: OUR_LOGO })
        await control.getByText("This instance's own logo", { exact: true }).waitFor({ timeout: 10_000 })
        assert.match(await readLocalFile(page, 'branded-local', 'instance.yaml'), /^logo: assets\/instance-logo\.png$/m)

        // A render from the Local Workspace sends the logo along, and its document's header shows it.
        await page.goto(`${base}/instance/branded-local?local=${encodeURIComponent(localId)}`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        await page.getByRole('button', { name: 'Render', exact: true }).click()
        const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
        await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await renderDialog.getByRole('button', { name: 'Brief', exact: true }).click()
        await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
        await page.waitForFunction(() => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''), null, { timeout: 90_000 })
        assert.doesNotMatch(await renderDialog.textContent(), /render failed/)
        const rendered = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory()
          for await (const [name, handle] of root.entries()) {
            if (!name.startsWith('pick-')) continue
            const out = await (await (await handle.getDirectoryHandle('gantry-workspace')).getDirectoryHandle('branded-local')).getDirectoryHandle('out')
            for await (const [file, entry] of out.entries()) {
              if (!file.endsWith('.docx')) continue
              const bytes = new Uint8Array(await (await entry.getFile()).arrayBuffer())
              let text = ''
              for (const b of bytes) text += String.fromCharCode(b)
              return btoa(text)
            }
          }
          return null
        })
        assert.ok(rendered, 'a .docx was written to the instance\'s out/ folder')
        assert.deepEqual(Buffer.from((await readHeaderLogo(Buffer.from(rendered, 'base64'))).bytes), OUR_LOGO, 'the rendered header shows the instance\'s logo')
        // The Local-workspace editor's own unrelated synced-fields probe 500s for an instance the server
        // has never seen; only an uncaught error would be this ticket's.
        assert.deepEqual(pageErrors.filter((e) => !/Failed to load resource/.test(e)), [])
      })
    )
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
