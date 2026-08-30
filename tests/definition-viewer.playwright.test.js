import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

test('Definition Editor viewer renders definitions with badges and detail pane is read-only', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/`)
        await page.waitForSelector('.dashboard', { timeout: 10_000 })
        const editorLink = page.getByRole('link', { name: 'Definition Editor' })
        await editorLink.waitFor({ state: 'visible', timeout: 10_000 })
        await editorLink.click()
        await page.waitForURL('**/definitions', { timeout: 10_000 })
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.waitForSelector('.defn-rail-row', { timeout: 10_000 })
        const badgeCount = await page.locator('.defn-rail-badges .stamp').count()
        assert.ok(badgeCount > 0, 'design row should show version badge')

        const designRow = page.locator('.defn-rail-row').filter({ hasText: 'design' }).first()
        await designRow.click()

        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const stageHeading = page.locator('.defn-section h3').filter({ hasText: 'Stages' })
        assert.equal(await stageHeading.count(), 1)
        await page.waitForSelector('.defn-card', { timeout: 10_000 })
        const requiresEntry = page.locator('.defn-requires-list code').first()
        await requiresEntry.waitFor({ state: 'visible', timeout: 5_000 })
        const fieldRow = page.locator('.defn-field').first()
        await fieldRow.waitFor({ state: 'visible', timeout: 5_000 })

        const inputCount = await page.locator('.defn-viewer input, .defn-viewer textarea').count()
        assert.equal(inputCount, 0, 'right pane should have no editable inputs')

        assert.deepEqual(pageErrors, [])

        // Also verify /definition-editor alias renders same
        await page.goto(`${base}/definition-editor`)
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        assert.ok((await page.locator('.defn-rail-row').count()) > 0)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
