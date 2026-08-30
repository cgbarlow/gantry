#!/usr/bin/env node
import { cpSync, mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, rmSync as rmSync2 } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from '../lib/server.js'
import { launchBrowser } from '../tests/helpers/launchBrowser.js'

const VIEWPORT = { width: 1280, height: 800 }
const IMAGES_DIR = 'web/user-guide-images'

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gantry-ug-shots-'))
  let server
  let browser
  try {
    // Seed temp instances dir with copies of the committed example fixtures.
    // Mirrors how *.playwright.test.js tests boot a server + copy the fixture.
    cpSync('instances/examples', join(tmpDir, 'examples'), { recursive: true })
    // Remove rendered out/ so the run is deterministic.
    try { rmSync(join(tmpDir, 'examples', 'out'), { recursive: true, force: true }) } catch {}
    if (existsSync('instances/atlas-reference-design')) {
      cpSync('instances/atlas-reference-design', join(tmpDir, 'atlas-reference-design'), { recursive: true })
      try { rmSync(join(tmpDir, 'atlas-reference-design', 'out'), { recursive: true, force: true }) } catch {}
    }

    // Seed a dummy workspace so the New Workspace wizard's "pick existing"
    // list is populated and the instance step (definition picker + changelog)
    // can be reached without exercising the repo-reachability check.
    const wsId = randomUUID()
    const wsRegistry = {
      [wsId]: {
        organization: 'Contoso',
        project: 'Demo',
        repository: 'demo-repo',
        owner: 'a.architect',
        ticketingSystem: 'azure-devops'
      }
    }
    writeFileSync(join(tmpDir, 'workspace-registry.json'), JSON.stringify(wsRegistry, null, 2) + '\n')

    mkdirSync(IMAGES_DIR, { recursive: true })

    server = createServer({ instancesDir: tmpDir })
    const base = await new Promise((resolve, reject) => {
      server.listen(0, () => {
        const { port } = server.address()
        resolve(`http://localhost:${port}`)
      })
      server.on('error', reject)
    })

    browser = await launchBrowser()
    const page = await browser.newPage()
    await page.setViewportSize(VIEWPORT)

    // Helpers
    async function shot(name, locatorOrPage, opts = {}) {
      const out = join(IMAGES_DIR, name)
      if (locatorOrPage && typeof locatorOrPage.screenshot === 'function' && locatorOrPage !== page) {
        await locatorOrPage.screenshot({ path: out, ...opts })
      } else {
        await page.screenshot({ path: out, fullPage: false, ...opts })
      }
      console.log(`captured ${out}`)
    }

    // 1) Workspaces landing page
    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.dashboard-topbar', { timeout: 10_000 })
    // Wait for the master-detail or empty state.
    await page.waitForSelector('.master-detail, .dashboard-empty, .instance-card', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await shot('workspaces-landing.png', page)

    // 2) New Workspace wizard – definition pick step (with changelog)
    await page.goto(`${base}/new-workspace`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
    // Pick the seeded workspace
    const picker = page.locator('#workspace-picker .definition-card')
    await picker.first().waitFor({ state: 'visible', timeout: 10_000 })
    await picker.first().click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForSelector('#instance-name', { timeout: 10_000 })
    // Ensure definition cards and version selector are visible, then wait a bit for changelog fetch.
    await page.waitForSelector('#definition-picker .definition-card', { timeout: 10_000 })
    await page.waitForTimeout(800)
    await shot('new-workspace-definition-step.png', page)

    // 3) Module editor – view-mode toolbar + Navigation dropdown
    await page.goto(`${base}/instance/examples`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.module', { timeout: 10_000 })
    await page.waitForSelector('.toolbar', { timeout: 10_000 })
    await page.waitForSelector('.stage-navigation', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(600)
    await shot('module-editor-toolbar.png', page)

    // 4) Work Item Detail card (header + Reviews/Sign-off sections)
    await page.goto(`${base}/instance/examples`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.module', { timeout: 10_000 })
    await page.waitForSelector('#work-item-detail-card, .synced-fields-panel', { timeout: 10_000 })
    await page.waitForTimeout(500)
    const card = page.locator('#work-item-detail-card').first()
    if (await card.count() > 0) {
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      await shot('work-item-detail-card.png', card)
    } else {
      const fallback = page.locator('.synced-fields-panel').first()
      await fallback.waitFor({ state: 'visible', timeout: 10_000 })
      await shot('work-item-detail-card.png', fallback)
    }

    // 5) Render dialog
    await page.goto(`${base}/instance/examples`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.module', { timeout: 10_000 })
    await page.waitForSelector('.toolbar', { timeout: 10_000 })
    const renderBtn = page.locator('.toolbar').getByRole('button', { name: 'Render', exact: true })
    await renderBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await renderBtn.click()
    const renderModal = page.locator('.modal', { hasText: 'Render' })
    await renderModal.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(400)
    await shot('render-dialog.png', page)

    // 6) Definition Editor (experimental)
    await page.goto(`${base}/definitions`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
    await page.waitForSelector('.defn-viewer-rail', { timeout: 10_000 })
    await page.waitForSelector('.defn-viewer-detail', { timeout: 10_000 })
    await page.waitForTimeout(800)
    await shot('definition-editor.png', page)

    console.log('All screenshots captured.')
  } catch (err) {
    console.error('capture-user-guide-screenshots failed:', err)
    process.exitCode = 1
    throw err
  } finally {
    try { await browser?.close() } catch {}
    try { server?.close() } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
