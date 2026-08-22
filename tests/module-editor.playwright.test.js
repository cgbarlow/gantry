import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// Minimal browser smoke test for the Preact/HTM-ported module editor
// (docs/adr/0006-preact-frontend-framework.md): confirms the real page
// loads with no console/page errors, and that a markdown field's edit ->
// save round-trips to the module file on disk — the same guarantee
// tests/server.test.js checks at the HTTP layer, exercised here through an
// actual rendered page and a real CodeMirror 6 editor instance.
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

test('the ported module editor page loads with no errors and a markdown field save round-trips', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(base)
        await page.waitForSelector('.module', { timeout: 10_000 })

        assert.equal(await page.locator('header h1').textContent(), 'examples — design')
        assert.deepEqual(pageErrors, [])

        // Edit the Context module's "Business driver" markdown field via its
        // real CodeMirror 6 editor, then save.
        const newText = 'Edited by the Playwright smoke test.'
        await page.locator('.field-markdown .cm-content').first().click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type(newText)
        await page.getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    assert.equal(data.fields.driver, 'Edited by the Playwright smoke test.')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #79 — the Markdown/Split/Rendered toolbar toggle, its
// keyboard hotkey, the state's global/session-only scope, and Rendered's
// enforced read-only behaviour.
test('the 3-way view-mode toggle switches modes, cycles via hotkey, stays global across stage switches, and enforces read-only in Rendered', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(base)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const main = page.locator('#modules')
        const segmented = page.locator('.segmented')

        // Defaults to Split on a fresh visit.
        assert.equal(await main.getAttribute('data-view-mode'), 'split')
        assert.equal(await segmented.locator('button.active').textContent(), 'Split')

        // Toolbar segmented control switches modes.
        await segmented.getByRole('button', { name: 'Markdown' }).click()
        assert.equal(await main.getAttribute('data-view-mode'), 'markdown')
        assert.equal(await segmented.locator('button.active').textContent(), 'Markdown')

        await segmented.getByRole('button', { name: 'Rendered' }).click()
        assert.equal(await main.getAttribute('data-view-mode'), 'rendered')

        // Rendered mode is enforced read-only: typing must not change the
        // underlying CodeMirror doc (the editor pane is hidden, but the
        // enforcement itself must not depend on that — verify the doc is
        // unaffected even though the host element still exists in the DOM).
        const firstField = page.locator('.field-markdown').first()
        const before = await firstField.locator('.cm-content').textContent()
        await firstField.locator('.cm-content').click({ force: true, timeout: 2000 }).catch(() => {})
        await page.keyboard.type('should not land')
        const after = await firstField.locator('.cm-content').textContent()
        assert.equal(after, before, 'Rendered mode must reject direct edits')

        // The hotkey (Ctrl+Shift+V) cycles: rendered -> markdown -> split.
        await page.keyboard.press('Control+Shift+V')
        assert.equal(await main.getAttribute('data-view-mode'), 'markdown')
        await page.keyboard.press('Control+Shift+V')
        assert.equal(await main.getAttribute('data-view-mode'), 'split')

        // Switch to Markdown, then navigate to a different stage via the
        // free-browse stage nav — the view-mode state is global to the
        // whole editor screen, so it must hold steady, not reset per-stage.
        await segmented.getByRole('button', { name: 'Markdown' }).click()
        assert.equal(await main.getAttribute('data-view-mode'), 'markdown')
        const otherStageButton = page.locator('#stage-nav button').nth(1)
        await otherStageButton.click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await main.getAttribute('data-view-mode'), 'markdown')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    // A fresh visit (new page load) resets to Split, not persisted from the
    // previous session.
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(base)
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.locator('#modules').getAttribute('data-view-mode'), 'split')
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
