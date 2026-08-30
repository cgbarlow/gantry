import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'yaml'
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

test('Definition Editor shows Edit for draft and not for published', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-viewer-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.waitForSelector('.defn-rail-row', { timeout: 10_000 })
        // Select published v1 then draft v2
        const versionSelect = page.locator('#defn-version-select')
        await versionSelect.waitFor({ state: 'visible', timeout: 10_000 })
        await versionSelect.selectOption('1')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const editBtnV1 = page.getByRole('button', { name: 'Edit' })
        assert.equal(await editBtnV1.count(), 0, 'published should have no Edit button')
        await versionSelect.selectOption('2')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const editBtn = page.getByRole('button', { name: 'Edit' })
        await editBtn.waitFor({ state: 'visible', timeout: 10_000 })
        assert.equal(await editBtn.count(), 1)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor edit mode change field title and Save persists', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-viewer2-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
        await page.locator('#defn-version-select').selectOption('2')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const editBtn = page.getByRole('button', { name: 'Edit' })
        await editBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await editBtn.click()
        await page.waitForSelector('.defn-editor', { timeout: 10_000 })
        // Find first field title input inside defn-editor-modules and change it
        const firstFieldTitleInput = page.locator('.defn-editor-modules .defn-editor-field').first().locator('input').first()
        await firstFieldTitleInput.waitFor({ state: 'visible', timeout: 10_000 })
        const newTitle = 'Edited Field Title ' + Date.now()
        await firstFieldTitleInput.fill('')
        await firstFieldTitleInput.fill(newTitle)
        const saveBtn = page.getByRole('button', { name: 'Save' }).first()
        await saveBtn.click()
        await page.waitForSelector('.defn-viewer-content:not(.defn-editor)', { timeout: 10_000 })
        // Verify read-only pane shows new title
        const fieldTitle = page.locator('.defn-field strong').filter({ hasText: newTitle })
        await fieldTitle.waitFor({ state: 'visible', timeout: 10_000 })
        assert.equal(await fieldTitle.count(), 1)
        // Fresh load still shows it
        await page.reload()
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
        // After reload, default may be published; select draft again
        await page.locator('#defn-version-select').selectOption('2')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const persisted = page.locator('.defn-field strong').filter({ hasText: newTitle })
        await persisted.waitFor({ state: 'visible', timeout: 10_000 })
        assert.equal(await persisted.count(), 1)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
