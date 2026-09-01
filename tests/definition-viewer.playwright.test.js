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

        const inputCount = await page.locator('.defn-viewer-detail input, .defn-viewer-detail textarea, .defn-viewer-content input, .defn-viewer-content textarea').count()
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

test('Definition Editor New draft version button adds & selects a version', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-viewer-newdraft-'))
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
        // ensure starting at v2
        await page.locator('#defn-version-select').selectOption('2')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const initialOptions = await page.locator('#defn-version-select option').count()
        assert.equal(initialOptions, 2)
        const newDraftBtn = page.getByRole('button', { name: 'New draft version' })
        await newDraftBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await newDraftBtn.click()
        await page.waitForFunction(() => document.querySelectorAll('#defn-version-select option').length === 3, { timeout: 10_000 })
        const afterCount = await page.locator('#defn-version-select option').count()
        assert.equal(afterCount, 3)
        const selected = await page.locator('#defn-version-select').inputValue()
        assert.equal(selected, '3')
        // verify badge for v3
        const badge = page.locator('.defn-viewer-header .stamp').first()
        await badge.waitFor({ state: 'visible', timeout: 5000 })
        const badgeText = await badge.textContent()
        assert.match(badgeText, /v3 draft/)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor Publish flips draft badge to published and hides Edit', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-viewer-pub-'))
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
        page.on('dialog', async (dialog) => { await dialog.accept() })
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
        await page.locator('#defn-version-select').selectOption('2')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const editBtn = page.getByRole('button', { name: 'Edit', exact: true })
        await editBtn.waitFor({ state: 'visible', timeout: 10_000 })
        const publishBtn = page.getByRole('button', { name: 'Publish', exact: true })
        await publishBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await publishBtn.click()
        // after publish, badge should be published and Edit gone
        await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
        const badge = page.locator('.defn-viewer-header .stamp').first()
        const badgeText = await badge.textContent()
        assert.match(badgeText, /v2 published/)
        assert.equal(await editBtn.count(), 0)
        assert.equal(await publishBtn.count(), 0)
        // version select now shows published
        const opt = page.locator('#defn-version-select option[value="2"]')
        const optText = await opt.textContent()
        assert.match(optText, /published/)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor Archive removes row, Show archived reveals it marked, Restore un-hides it', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-viewer-arch-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
    t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
    writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
    // second def to ensure rail still has something after archiving design? but we just archive design
    cpSync('definitions/design/1', join(definitionsDir, 'other/1'), { recursive: true })
    let raw = readFileSync(join(definitionsDir, 'other/1/definition.yaml'), 'utf8')
    const yamlLocal = await import('yaml')
    let parsed = yamlLocal.parse(raw)
    parsed.id = 'other'
    parsed.title = 'Other Def'
    writeFileSync(join(definitionsDir, 'other/1/definition.yaml'), yamlLocal.stringify(parsed))
    await withRunningServer({ definitionsDir, instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.waitForSelector('.defn-rail-row', { timeout: 10_000 })
        let rows = await page.locator('.defn-rail-row').count()
        assert.equal(rows, 2)
        const designRow = page.locator('.defn-rail-row').filter({ hasText: '(design)' }).first()
        await designRow.waitFor({ state: 'visible', timeout: 5000 })
        const archiveBtn = designRow.getByRole('button', { name: 'Archive', exact: true })
        await archiveBtn.waitFor({ state: 'visible', timeout: 5000 })
        const archiveGetPromise = page.waitForResponse((resp) => resp.url().includes('/api/definitions') && resp.request().method() === 'GET', { timeout: 10000 })
        await archiveBtn.click()
        await archiveGetPromise
        await page.waitForFunction(() => document.querySelectorAll('.defn-rail-row').length === 1, { timeout: 10_000 })
        rows = await page.locator('.defn-rail-row').count()
        assert.equal(rows, 1)
        assert.equal(await page.locator('.defn-rail-row').filter({ hasText: '(design)' }).count(), 0)
        const showArchived = page.getByRole('checkbox', { name: 'Show archived' })
        await showArchived.waitFor({ state: 'visible', timeout: 5000 })
        const showArchivedGetPromise = page.waitForResponse((resp) => resp.url().includes('/api/definitions') && resp.request().method() === 'GET', { timeout: 10000 })
        await showArchived.check()
        await showArchivedGetPromise
        await page.waitForFunction(() => document.querySelectorAll('.defn-rail-row').length === 2, { timeout: 10_000 })
        const archivedRow = page.locator('.defn-rail-row.archived').filter({ hasText: '(design)' })
        await archivedRow.waitFor({ state: 'visible', timeout: 5000 })
        assert.equal(await archivedRow.count(), 1)
        // stamp or archived class ensures visual mark; check archived class
        const restoreBtn = archivedRow.getByRole('button', { name: 'Restore', exact: true })
        await restoreBtn.waitFor({ state: 'visible', timeout: 5000 })
        const restoreResponsePromise = page.waitForResponse((resp) => resp.url().includes('/api/definitions') && resp.request().method() === 'GET', { timeout: 10000 })
        await restoreBtn.click()
        await restoreResponsePromise
        // wait until design row no longer has archived class and shows Archive button again
        await page.waitForFunction(() => {
          const rows = document.querySelectorAll('.defn-rail-row')
          for (const r of rows) if (r.textContent.includes('(design)') && r.classList.contains('archived')) return false
          return document.querySelectorAll('.defn-rail-row').length === 2
        }, { timeout: 10_000 })
        // give React a tick to re-render
        await page.waitForTimeout(500)
        assert.equal(await page.locator('.defn-rail-row.archived').count(), 0)
        const restoredRow = page.locator('.defn-rail-row').filter({ hasText: '(design)' }).first()
        await restoredRow.getByRole('button', { name: 'Archive', exact: true }).waitFor({ state: 'visible', timeout: 5000 })
        // after restore, design row should be back without archived class; still 2 rows with showArchived checked
        // uncheck Show archived still shows design because it's no longer archived
        const uncheckPromise = page.waitForResponse((resp) => resp.url().includes('/api/definitions') && resp.request().method() === 'GET', { timeout: 10000 })
        await showArchived.uncheck()
        await uncheckPromise
        await page.waitForFunction(() => document.querySelectorAll('.defn-rail-row').length === 2, { timeout: 10_000 })
        assert.equal(await page.locator('.defn-rail-row').filter({ hasText: '(design)' }).count(), 1)
        assert.equal(await page.locator('.defn-rail-row.archived').count(), 0)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor reorder stages via Move down persists after Save', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-reorder-stage-'))
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
        // Capture initial stage ids from editor (stage id code inside defn-editor-row only)
        const beforeIds = await page.$$eval('.defn-editor-stages .defn-card', (cards) => cards.map((c) => c.querySelector('.defn-editor-row code').textContent.trim()))
        assert.ok(beforeIds.length >= 2, 'should have at least 2 stages')
        // First stage Move down should be enabled, last stage Move down disabled
        const firstCard = page.locator('.defn-editor-stages .defn-card').first()
        const firstMoveDown = firstCard.getByRole('button', { name: /Move stage.*down/ })
        await firstMoveDown.waitFor({ state: 'visible', timeout: 5000 })
        assert.equal(await firstMoveDown.isDisabled(), false)
        const firstMoveUp = firstCard.getByRole('button', { name: /Move stage.*up/ })
        assert.equal(await firstMoveUp.isDisabled(), true)
        // drag handle exists
        const handle = firstCard.locator('.defn-drag-handle').first()
        assert.equal(await handle.count(), 1)
        await firstMoveDown.click()
        const afterIds = await page.$$eval('.defn-editor-stages .defn-card', (cards) => cards.map((c) => c.querySelector('.defn-editor-row code').textContent.trim()))
        assert.deepEqual(afterIds, [beforeIds[1], beforeIds[0], ...beforeIds.slice(2)], 'stage order should have first two swapped in editor')
        // Save
        const saveBtn = page.getByRole('button', { name: 'Save' }).first()
        await saveBtn.click()
        await page.waitForSelector('.defn-viewer-content:not(.defn-editor)', { timeout: 10_000 })
        // Read-only pane stage order should reflect saved order
        const readOnlyIds = await page.$$eval('.defn-viewer-content:not(.defn-editor) .defn-section:nth-of-type(1) .defn-card .defn-meta', (els) => els.map((e) => e.textContent.trim().split('·')[0].trim()))
        // readOnlyIds should start with afterIds order
        assert.deepEqual(readOnlyIds.slice(0, afterIds.length), afterIds)
        // Published pane should have no reorder controls
        assert.equal(await page.locator('.defn-drag-handle').count(), 0)
        assert.equal(await page.locator('.defn-move-btns').count(), 0)
        // Re-enter edit mode after reselect to confirm persistence across reload of draft
        await page.locator('#defn-version-select').selectOption('2')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        const editBtn2 = page.getByRole('button', { name: 'Edit' })
        await editBtn2.waitFor({ state: 'visible', timeout: 10_000 })
        await editBtn2.click()
        await page.waitForSelector('.defn-editor', { timeout: 10_000 })
        const persistedIds = await page.$$eval('.defn-editor-stages .defn-card', (cards) => cards.map((c) => c.querySelector('.defn-editor-row code').textContent.trim()))
        assert.deepEqual(persistedIds, afterIds)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor reorder fields via Move up persists after Save', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-reorder-field-'))
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
        // Find first module card with at least 2 fields
        const moduleCards = page.locator('.defn-editor-modules .defn-card')
        const moduleCount = await moduleCards.count()
        assert.ok(moduleCount >= 1)
        // locate first module's fields
        let targetModuleIndex = -1
        let beforeFieldIds = []
        for (let mi = 0; mi < moduleCount; mi++) {
          const ids = await page.$$eval(`.defn-editor-modules .defn-card:nth-of-type(${mi + 1}) .defn-editor-field`, (els) =>
            els.map((el) => {
              const inputs = el.querySelectorAll('input')
              // second input is field id
              return inputs[1] ? inputs[1].value : ''
            })
          )
          if (ids.length >= 2) {
            targetModuleIndex = mi
            beforeFieldIds = ids
            break
          }
        }
        assert.ok(targetModuleIndex >= 0, 'should find module with >=2 fields')
        assert.ok(beforeFieldIds.length >= 2)
        // Second field's Move up should be enabled, first's Move up disabled
        const secondField = page.locator(`.defn-editor-modules .defn-card:nth-of-type(${targetModuleIndex + 1}) .defn-editor-field`).nth(1)
        const moveUpSecond = secondField.getByRole('button', { name: /Move field.*up/ })
        await moveUpSecond.waitFor({ state: 'visible', timeout: 5000 })
        assert.equal(await moveUpSecond.isDisabled(), false)
        const firstField = page.locator(`.defn-editor-modules .defn-card:nth-of-type(${targetModuleIndex + 1}) .defn-editor-field`).first()
        const moveUpFirst = firstField.getByRole('button', { name: /Move field.*up/ })
        assert.equal(await moveUpFirst.isDisabled(), true)
        const handle = secondField.locator('.defn-drag-handle').first()
        assert.equal(await handle.count(), 1)
        await moveUpSecond.click()
        const afterFieldIds = await page.$$eval(`.defn-editor-modules .defn-card:nth-of-type(${targetModuleIndex + 1}) .defn-editor-field`, (els) =>
          els.map((el) => {
            const inputs = el.querySelectorAll('input')
            return inputs[1] ? inputs[1].value : ''
          })
        )
        assert.deepEqual(afterFieldIds, [beforeFieldIds[1], beforeFieldIds[0], ...beforeFieldIds.slice(2)])
        // Save and verify read-only pane field order persisted
        const saveBtn = page.getByRole('button', { name: 'Save' }).first()
        await saveBtn.click()
        await page.waitForSelector('.defn-viewer-content:not(.defn-editor)', { timeout: 10_000 })
        // Find corresponding read-only module card by title/id and check field order
        const readOnlyModuleCards = page.locator('.defn-viewer-content:not(.defn-editor) .defn-section:nth-of-type(3) .defn-card')
        // Get module id from before (need original draft module id)
        const draftModuleId = beforeFieldIds.length ? await page.evaluate((mi) => {
          // not available after save; instead re-derive from beforeFieldIds context via DOM after save is not needed; we use the first module's field order
          return null
        }, targetModuleIndex) : null
        // Simpler: check first module's field order in read-only matches afterFieldIds
        const readOnlyFieldIds = await page.$$eval('.defn-viewer-content:not(.defn-editor) .defn-section:nth-of-type(3) .defn-card', (cards) => {
          const first = cards[0]
          if (!first) return []
          // The field id `<code>` sits in `.defn-field-heading`; a field's rendered
          // guidance markdown can also contain `<code>` spans, so scope to the heading.
          return Array.from(first.querySelectorAll('.defn-field > .defn-field-heading > code')).map((c) => c.textContent.trim())
        })
        assert.deepEqual(readOnlyFieldIds.slice(0, afterFieldIds.length), afterFieldIds)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor template editing: draft artefact Edit template round-trips', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-tmpl-edit-'))
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
        const editBtn = page.getByRole('button', { name: 'Edit', exact: true })
        await editBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await editBtn.click()
        await page.waitForSelector('.defn-editor', { timeout: 10_000 })
        // first artefact's Edit template button
        const editTemplateBtn = page.getByRole('button', { name: 'Edit template' }).first()
        await editTemplateBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await editTemplateBtn.click()
        const textarea = page.locator('.defn-template-editor').first()
        await textarea.waitFor({ state: 'visible', timeout: 10_000 })
        const initialSource = await textarea.inputValue()
        assert.ok(initialSource.length > 0, 'textarea should load current source')
        const newSource = 'Hello template ' + Date.now() + '\n<%= \"hi\" %>'
        await textarea.fill(newSource)
        const saveBtn = page.getByRole('button', { name: 'Save template' }).first()
        await saveBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await saveBtn.click()
        // Saved ✓ confirmation
        const saved = page.locator('.defn-template-saved').first()
        await saved.waitFor({ state: 'visible', timeout: 10_000 })
        assert.match(await saved.textContent(), /Saved/)
        // Close and reopen -> new source persisted
        const closeBtn = page.getByRole('button', { name: 'Close' }).first()
        await closeBtn.click()
        await page.waitForTimeout(200)
        // reopen
        await editTemplateBtn.waitFor({ state: 'visible', timeout: 10_000 })
        await editTemplateBtn.click()
        const textarea2 = page.locator('.defn-template-editor').first()
        await textarea2.waitFor({ state: 'visible', timeout: 10_000 })
        assert.equal(await textarea2.inputValue(), newSource)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Definition Editor published version shows no Save template', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-tmpl-pub-'))
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
        await page.locator('#defn-version-select').selectOption('1')
        await page.waitForSelector('.defn-viewer-content', { timeout: 10_000 })
        // published has no Edit button, thus no Edit template
        assert.equal(await page.getByRole('button', { name: 'Edit' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Save template' }).count(), 0)
        // View template source may be present but Save should not
        // ensure no textarea editor visible
        assert.equal(await page.locator('.defn-template-editor').count(), 0)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
