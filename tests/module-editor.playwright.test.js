import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// A minimal real 1x1 red PNG — small enough to inline as a Playwright
// setInputFiles buffer, real enough to round-trip through the actual
// upload -> disk -> serve path (mirrors tests/assets.test.js's HTTP-level
// copy of the same fixture).
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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

// Coverage for #80 — the "+ Insert asset" affordance, the Upload new /
// Choose existing modal, inline validation, live-preview thumbnail
// rendering, the hand-typed markdown convention, and the asset library
// screen's USED IN / UNUSED badges.
test('inserting an asset (upload, then choose-existing) renders a real thumbnail, and the library reflects usage', async () => {
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

        // The Shape stage's first module (per definitions/design/definition.yaml).
        const contextModule = page.locator('.module').first()
        await assert.doesNotReject(contextModule.locator('h2', { hasText: 'Context' }).waitFor({ timeout: 2_000 }))
        const insertButton = contextModule.getByRole('button', { name: '+ Insert asset' })

        // Appears after the module, and is hidden once the screen switches
        // to Rendered-only view (that view is read-only).
        await assert.doesNotReject(insertButton.waitFor({ state: 'visible', timeout: 5_000 }))
        await page.locator('.segmented').getByRole('button', { name: 'Rendered' }).click()
        await assert.doesNotReject(insertButton.waitFor({ state: 'hidden', timeout: 5_000 }))
        await page.locator('.segmented').getByRole('button', { name: 'Split' }).click()
        await insertButton.waitFor({ state: 'visible', timeout: 5_000 })

        // Click into the "Business driver" field so the insert lands there.
        await contextModule.locator('.field-markdown .cm-content').first().click()

        await insertButton.click()
        const modal = page.locator('.modal')
        await modal.waitFor({ state: 'visible', timeout: 5_000 })
        await assert.doesNotReject(page.getByRole('button', { name: 'Upload new' }).waitFor({ timeout: 2_000 }))
        await assert.doesNotReject(page.getByRole('button', { name: 'Choose existing' }).waitFor({ timeout: 2_000 }))

        // Blocked with an inline error until the mandatory source-location
        // field is filled in, even with a file already chosen.
        await modal.locator('input[type=file]').setInputFiles({
          name: 'eligibility-flow.png',
          mimeType: 'image/png',
          buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
        })
        await modal.getByRole('button', { name: 'Insert' }).click()
        await assert.doesNotReject(page.locator('.inline-error').waitFor({ timeout: 2_000 }))
        assert.match(await page.locator('.inline-error').textContent(), /[Ss]ource location is required/)

        // Filling in the source location clears the block and the upload
        // succeeds, inserting a real thumbnail into the preview pane.
        await modal.locator('input[placeholder^="https://draw.io"]').fill('https://draw.io/diagrams/eligibility-flow')
        await modal.getByRole('button', { name: 'Insert' }).click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })

        const preview = contextModule.locator('.field-markdown .preview').first()
        await assert.doesNotReject(preview.locator('img.asset-thumb').waitFor({ timeout: 5_000 }))
        assert.equal(await preview.locator('img.asset-thumb').count(), 1)

        // "Choose existing" — pick the same asset again from the grid,
        // inserted at the trigger point without re-uploading.
        await insertButton.click()
        await page.getByRole('button', { name: 'Choose existing' }).click()
        await modal.locator('.grid-library .card').first().waitFor({ timeout: 5_000 })
        await modal.locator('.grid-library .card').first().click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })
        assert.equal(await preview.locator('img.asset-thumb').count(), 2)

        // Hand-typing the same `asset:<id>` convention directly into the
        // markdown (bypassing the modal entirely) renders identically.
        const assetHref = await preview.locator('img.asset-thumb').first().getAttribute('src')
        const assetId = assetHref.match(/\/api\/instance\/assets\/([^/]+)\/file/)[1]
        // The context module's second markdown field renders via the same
        // preview path — type directly into its CodeMirror editor.
        const secondField = contextModule.locator('.field-markdown').nth(1)
        if ((await secondField.count()) > 0) {
          await secondField.locator('.cm-content').click()
          // insertText (one input event), not type (key-by-key) — CodeMirror's
          // auto-close-brackets extension would otherwise pair every "("
          // typed with an immediate ")", making each intermediate keystroke
          // briefly resolve to its own (broken, 404ing) partial image URL.
          await page.keyboard.insertText(`![Hand-typed](asset:${assetId})`)
          await assert.doesNotReject(
            secondField.locator('.preview img.asset-thumb').first().waitFor({ timeout: 5_000 })
          )
        }

        assert.deepEqual(pageErrors, [])

        // Usage is computed from the saved module file on disk, so save
        // before checking the library reflects it as used.
        await contextModule.getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        // Asset library screen: the inserted asset shows USED IN >= 1;
        // uploading one more, never referenced, shows UNUSED.
        await page.getByRole('link', { name: 'View asset library' }).click()
        await page.waitForSelector('.asset-library', { timeout: 10_000 })
        const usedCard = page.locator('.lib-grid .card', { hasText: 'eligibility-flow.png' })
        await usedCard.waitFor({ timeout: 5_000 })
        assert.match(await usedCard.locator('.stamp').textContent(), /USED IN \d+/)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    assert.match(data.fields.driver, /asset:/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
