import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// A minimal real 1x1 red PNG — small enough to inline as a Playwright setInputFiles buffer, real enough to round-trip through the actual upload -> disk -> serve path (mirrors tests/assets.test.js's HTTP-level copy of the same fixture).
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

// Minimal browser smoke test for the Preact/HTM-ported module editor (docs/adr/0006-preact-frontend-framework.md): confirms the real page loads with no console/page errors, and that a markdown field's edit -> save round-trips to the module file on disk — the same guarantee tests/server.test.js checks at the HTTP layer, exercised here through an actual rendered page and a real CodeMirror 6 editor instance.
//
// The module editor now lives at /instance/<slug> — the instance dashboard (#77) is the landing screen at / — so this navigates straight there rather than relying on a server-pinned default slug being shown at /. See tests/dashboard.playwright.test.js for the dashboard's own smoke test.
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        assert.equal(await page.locator('header h1').textContent(), 'examples — design')
        assert.deepEqual(pageErrors, [])

        // Edit the Context module's "Business driver" markdown field via its real CodeMirror 6 editor, then save.
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

// #113 — the theme toggle used to be duplicated across this header, the dashboard topbar, the setup wizard header, and Settings' header; it now lives solely in Settings (see tests/settings.playwright.test.js).
test('module editor: the header no longer has its own theme toggle (moved to Settings, #113)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.locator('header .theme-toggle').count(), 0)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #79 — the Markdown/Split/Rendered toolbar toggle, its keyboard hotkey, the state's global/session-only scope, and Rendered's enforced read-only behaviour.
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

        await page.goto(`${base}/instance/examples`)
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

        // Rendered mode is enforced read-only: typing must not change the underlying CodeMirror doc (the editor pane is hidden, but the enforcement itself must not depend on that — verify the doc is unaffected even though the host element still exists in the DOM).
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

        // Switch to Markdown, then navigate to a different stage via the free-browse stage nav — the view-mode state is global to the whole editor screen, so it must hold steady, not reset per-stage.
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

    // A fresh visit (new page load) resets to Split, not persisted from the previous session.
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${base}/instance/examples`)
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

// Coverage for #114 — "Clear all fields" and the Render dialog, both moved into the view-toggle bar: a single "Render" button (replacing the old one-button-per-artefact layout) opens a dialog listing every artefact the current stage can produce, using the same dialog for Shape's two SOAP variants and Detailed Design's sad/ssad pair.
test('Render and Clear all fields live in the view-toggle bar; Render opens a dialog listing every artefact for the current stage', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const toolbar = page.locator('.toolbar')

        // Both buttons sit in the view-toggle bar, "Clear all fields" immediately left of "Render" — not per-artefact buttons buried below the modules, and not a separate "stage actions" bar.
        const clearButton = toolbar.getByRole('button', { name: 'Clear all fields' })
        const renderButton = toolbar.getByRole('button', { name: 'Render', exact: true })
        await assert.doesNotReject(clearButton.waitFor({ state: 'visible', timeout: 5_000 }))
        await assert.doesNotReject(renderButton.waitFor({ state: 'visible', timeout: 5_000 }))
        assert.equal(await page.locator('.artefacts').count(), 0, 'the old per-artefact section must be gone')
        assert.equal(await page.locator('.stage-actions').count(), 0, 'the old separate stage-actions bar must be gone')

        // Shape stage (the default) produces both SOAP variants.
        await renderButton.click()
        const dialog = page.locator('.modal', { hasText: 'Render' })
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(
          await dialog.locator('.render-artefact-list button').allTextContents(),
          ['Solution on a Page', 'Full Solution on a Page']
        )

        // The per-artefact button toggles selection — it does not render immediately.
        const soapToggle = dialog.getByRole('button', { name: 'Solution on a Page', exact: true })
        await soapToggle.click()
        assert.equal(await soapToggle.evaluate((el) => el.classList.contains('toggled')), true)

        // The dialog's own bottom action (relabelled from "Close" to "Render") renders every toggled artefact.
        const dialogRenderButton = dialog.getByRole('button', { name: 'Render', exact: true })
        await dialogRenderButton.click()
        await assert.doesNotReject(dialog.locator('text=Rendered to').waitFor({ timeout: 10_000 }))
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })

        // Navigate to the Detailed Design stage, which shares one gate between two artefacts (sad, ssad) — the dialog lists both.
        await page.locator('#stage-nav button', { hasText: 'Detailed Design' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })

        await page.locator('.toolbar').getByRole('button', { name: 'Render', exact: true }).click()
        const secondDialog = page.locator('.modal', { hasText: 'Render' })
        await secondDialog.waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(
          await secondDialog.locator('.render-artefact-list button').allTextContents(),
          ['Solution Architecture Document', 'Solution Support Architecture Document']
        )
        await page.keyboard.press('Escape')
        await secondDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        // "Clear all fields" clears the currently mounted stage's own fields, wired via the registry now owned above StageScreen.
        const firstField = page.locator('.field-markdown .cm-content').first()
        await firstField.click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('some content to clear')
        assert.match(await firstField.textContent(), /some content to clear/)
        await page.locator('.toolbar').getByRole('button', { name: 'Clear all fields' }).click()
        assert.equal(await firstField.textContent(), '')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage specifically for the render dialog's toggle-and-batch behavior: multiple artefacts can be toggled on before rendering, one "Render" action renders all of them, and toggling back off before rendering excludes an artefact from the batch.
test('Render dialog: toggling multiple artefacts renders them as one batch; untoggling excludes an artefact', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        // Detailed Design shares one gate between two artefacts (sad, ssad) — the case that actually exercises a multi-item batch.
        await page.locator('#stage-nav button', { hasText: 'Detailed Design' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })

        await page.locator('.toolbar').getByRole('button', { name: 'Render', exact: true }).click()
        const dialog = page.locator('.modal', { hasText: 'Render' })
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })

        const sadToggle = dialog.getByRole('button', { name: 'Solution Architecture Document' })
        const ssadToggle = dialog.getByRole('button', { name: 'Solution Support Architecture Document' })
        const renderButton = dialog.getByRole('button', { name: 'Render', exact: true })

        // Nothing toggled yet: the batch action is disabled.
        assert.equal(await renderButton.isDisabled(), true)

        // Toggle both on.
        await sadToggle.click()
        await ssadToggle.click()
        assert.equal(await sadToggle.evaluate((el) => el.classList.contains('toggled')), true)
        assert.equal(await ssadToggle.evaluate((el) => el.classList.contains('toggled')), true)

        // Toggle ssad back off before rendering — it must be excluded from the batch.
        await ssadToggle.click()
        assert.equal(await ssadToggle.evaluate((el) => el.classList.contains('toggled')), false)

        assert.equal(await renderButton.isDisabled(), false)
        await renderButton.click()

        await assert.doesNotReject(
          dialog.locator('text=Solution Architecture Document: rendered to').waitFor({ timeout: 10_000 })
        )
        // Give ssad's non-render a moment to definitely not appear, rather than racing the assertion against sad's own in-flight request.
        await page.waitForTimeout(500)
        assert.doesNotMatch(await dialog.locator('.save-status').textContent(), /Solution Support Architecture Document/)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #132 — every markdown field carries its own generic "Insert ▾" dropdown (Image / Table / Section), replacing #80's single per-module "+ Insert asset" button. This test walks the Image path through both tabs of the (renamed) Insert image modal — including inline validation and live-preview thumbnails — proves per-field targeting (the second field's own dropdown inserts into the second field), that the dropdowns vanish in Rendered view, and that the library screen still reflects usage. Table and Section get their own tests below.
test("each markdown field has an Insert ▾ dropdown whose Image flow uploads, inserts, and reflects usage; wording says Image, never Asset", async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        // The Shape stage's first module (per definitions/design/definition.yaml).
        const contextModule = page.locator('.module').first()
        await assert.doesNotReject(contextModule.locator('h2', { hasText: 'Context' }).waitFor({ timeout: 2_000 }))

        // The old single affordance is gone; each of the context module's four markdown fields has its own generic dropdown instead.
        assert.equal(await page.getByRole('button', { name: '+ Insert asset' }).count(), 0)
        const triggers = contextModule.getByRole('button', { name: 'Insert ▾' })
        assert.equal(await triggers.count(), 4)
        const firstTrigger = triggers.nth(0)

        // Hidden once the screen switches to Rendered-only view (that view is read-only).
        await assert.doesNotReject(firstTrigger.waitFor({ state: 'visible', timeout: 5_000 }))
        await page.locator('.segmented').getByRole('button', { name: 'Rendered' }).click()
        await assert.doesNotReject(firstTrigger.waitFor({ state: 'hidden', timeout: 5_000 }))
        await page.locator('.segmented').getByRole('button', { name: 'Split' }).click()
        await firstTrigger.waitFor({ state: 'visible', timeout: 5_000 })

        // Open the FIRST field's dropdown: the menu offers exactly Image / Table / Section, and choosing Image opens the renamed modal.
        await firstTrigger.click()
        const menu = contextModule.locator('.insert-dropdown .menu')
        await menu.waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(
          await menu.getByRole('menuitem').allTextContents(),
          ['Image', 'Table', 'Section', 'List']
        )
        await menu.getByRole('menuitem', { name: 'Image' }).click()

        const modal = page.locator('.modal')
        await modal.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await modal.getAttribute('aria-label'), 'Insert image')
        assert.equal(await modal.locator('h3').textContent(), 'Insert image')
        await assert.doesNotReject(page.getByRole('button', { name: 'Upload new' }).waitFor({ timeout: 2_000 }))
        await assert.doesNotReject(page.getByRole('button', { name: 'Choose existing' }).waitFor({ timeout: 2_000 }))

        // Blocked with an inline error until the mandatory source-location field is filled in, even with a file already chosen.
        await modal.locator('input[type=file]').setInputFiles({
          name: 'eligibility-flow.png',
          mimeType: 'image/png',
          buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
        })
        await modal.getByRole('button', { name: 'Insert' }).click()
        await assert.doesNotReject(page.locator('.inline-error').waitFor({ timeout: 2_000 }))
        assert.match(await page.locator('.inline-error').textContent(), /[Ss]ource location is required/)

        // Filling in the source location clears the block and the upload succeeds, inserting a real thumbnail into the FIRST field's preview pane.
        await modal.locator('input[placeholder^="https://draw.io"]').fill('https://draw.io/diagrams/eligibility-flow')
        await modal.getByRole('button', { name: 'Insert' }).click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })

        const firstPreview = contextModule.locator('.field-markdown .preview').nth(0)
        await assert.doesNotReject(firstPreview.locator('img.asset-thumb').waitFor({ timeout: 5_000 }))
        assert.equal(await firstPreview.locator('img.asset-thumb').count(), 1)

        // "Choose existing" via the SECOND field's own dropdown — the insert must land in the second field, proving the dropdowns target their own field rather than whichever one was focused last.
        await triggers.nth(1).click()
        await contextModule.locator('.insert-dropdown .menu').getByRole('menuitem', { name: 'Image' }).click()
        await modal.waitFor({ state: 'visible', timeout: 5_000 })
        await page.getByRole('button', { name: 'Choose existing' }).click()
        await modal.locator('.grid-library .card').first().waitFor({ timeout: 5_000 })
        await modal.locator('.grid-library .card').first().click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })
        const secondField = contextModule.locator('.field-markdown').nth(1)
        await assert.doesNotReject(secondField.locator('.preview img.asset-thumb').first().waitFor({ timeout: 5_000 }))
        assert.equal(await firstPreview.locator('img.asset-thumb').count(), 1, 'the first field must be untouched')

        // Hand-typing the same `asset:<id>` convention directly into the markdown (bypassing the modal entirely) renders identically.
        const assetHref = await firstPreview.locator('img.asset-thumb').first().getAttribute('src')
        const assetId = assetHref.match(/\/api\/instance\/assets\/([^/]+)\/file/)[1]
        await secondField.locator('.cm-content').click()
        // insertText (one input event), not type (key-by-key) — CodeMirror's auto-close-brackets extension would otherwise pair every "(" typed with an immediate ")", making each intermediate keystroke briefly resolve to its own (broken, 404ing) partial image URL.
        await page.keyboard.insertText(`![Hand-typed](asset:${assetId})`)
        await assert.doesNotReject(secondField.locator('.preview img.asset-thumb').nth(1).waitFor({ timeout: 5_000 }))

        assert.deepEqual(pageErrors, [])

        // Usage is computed from the saved module file on disk, so save before checking the library reflects it as used.
        await contextModule.getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        // Asset library screen: the inserted asset shows USED IN >= 1; uploading one more, never referenced, shows UNUSED. Navigated to directly — the toolbar's "View asset library" link was removed as redundant once assets are insertable inline from the editor.
        await page.goto(`${base}/assets?slug=examples`)
        await page.waitForSelector('.asset-library', { timeout: 10_000 })
        assert.equal(await page.locator('.asset-library h1').textContent(), 'Image library')
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
    assert.match(data.fields.opportunity, /asset:/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #134 — Loop-style table editing: the Insert ▾ size grid, the
// contextual control strip, the Tab/Enter keyboard flow, graceful degradation
// on malformed input, and themed preview rendering.

// CodeMirror renders one .cm-line per document line with no separators, so
// textContent alone can't distinguish lines; join them explicitly.
const docText = (field) =>
  field.locator('.cm-content').evaluate((el) => [...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n'))

// Editor state settles across microtasks (preact render, CM transactions);
// poll rather than assume immediacy.
async function eventually(fn, timeout = 3000) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeout) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastErr
}

test('Insert ▾ → Table opens a size grid whose pick inserts a live table with the caret parked (#134)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const contextModule = page.locator('.module').first()
        const firstField = contextModule.locator('.field-markdown').nth(0)

        // Replace the seeded content with a lead-in line, then open the grid.
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('Key decisions:')
        await firstField.getByRole('button', { name: 'Insert ▾' }).click()
        await contextModule.locator('.insert-dropdown .menu').getByRole('menuitem', { name: 'Table' }).click()

        const grid = contextModule.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await grid.locator('.table-picker-cell').count(), 64, 'an 8×8 grid')

        // Hovering a corner lights up exactly its R×C rectangle and the
        // caption reads out the size.
        await grid.locator('[data-row="2"][data-col="3"]').hover()
        await eventually(async () => {
          assert.equal(await grid.locator('.table-picker-cell.lit').count(), 6)
          assert.equal(await contextModule.locator('.table-picker-caption').textContent(), '3 × 2')
        })

        await grid.locator('[data-row="2"][data-col="3"]').click()
        await assert.doesNotReject(firstField.locator('.preview table').waitFor({ timeout: 5_000 }))
        assert.equal(await firstField.locator('.preview table th').count(), 3)

        // The caret landed in the first body cell, so the contextual strip
        // is up without any further interaction.
        await assert.doesNotReject(firstField.locator('.table-toolbar').waitFor({ state: 'visible', timeout: 5_000 }))

        // Round-trip: save, then read the module file back off disk.
        await contextModule.getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    // Blank-line hygiene kept the lead-in separated, and the fresh table is
    // padded to the header's width.
    assert.match(
      data.fields.driver,
      /^Key decisions:\n\n\| Header 1 \| Header 2 \| Header 3 \|\n\| -{8} \| -{8} \| -{8} \|\n\| {10}\| {10}\| {10}\|$/
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Tab walks the cells, Enter appends a row from the last one, Shift-Tab retraces (#134)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const firstField = page.locator('.field-markdown').nth(0)
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')

        // Seed a 2×2 table through the picker.
        await firstField.getByRole('button', { name: 'Insert ▾' }).click()
        await firstField.locator('.insert-dropdown .menu').getByRole('menuitem', { name: 'Table' }).click()
        const grid = firstField.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        await grid.locator('[data-row="2"][data-col="2"]').click()
        await assert.doesNotReject(firstField.locator('.preview table').waitFor({ timeout: 5_000 }))

        // Walk the four cells with Tab, dropping a letter in each; the walk
        // skips the delimiter row by construction.
        for (const letter of ['a', 'b', 'c']) {
          await page.keyboard.type(letter)
          await page.keyboard.press('Tab')
        }
        await page.keyboard.type('d')
        // Off the last cell Enter appends a row instead of splitting a line…
        await page.keyboard.press('Enter')
        await page.keyboard.type('e')
        // …and Shift-Tab retraces into the previous cell, selecting it.
        await page.keyboard.press('Shift+Tab')
        await page.keyboard.type('D')

        const text = await eventually(() => docText(firstField))
        assert.match(
          text,
          /\| Header 1 \| Header 2 \|\n\| -{8} \| -{8} \|\n\| {5}a {5}\| {5}b {5}\|\n\| {2}c \| {2}D \|\n\| {2}e \| {3}\|$/
        )
        assert.equal(await firstField.locator('.preview td').count(), 6, 'three body rows × two columns')
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the contextual strip adds/removes rows and columns and cycles alignment (#134)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const firstField = page.locator('.field-markdown').nth(0)
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')

        await firstField.getByRole('button', { name: 'Insert ▾' }).click()
        await firstField.locator('.insert-dropdown .menu').getByRole('menuitem', { name: 'Table' }).click()
        const grid = firstField.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        await grid.locator('[data-row="2"][data-col="2"]').click()
        await assert.doesNotReject(firstField.locator('.table-toolbar').waitFor({ state: 'visible', timeout: 5_000 }))
        const strip = firstField.locator('.table-toolbar')

        // Park some content so row operations have something to act on.
        await page.keyboard.type('a')

        // Add row below lands an empty row under the caret's row.
        await strip.getByRole('button', { name: 'Add row below' }).click()
        await page.keyboard.type('x')
        await eventually(async () => {
          assert.match(await docText(firstField), /\n\| {2}x \| {3}\|$/)
        })

        // Add column right grows every row and parks the caret in the new one
        // (its padding borrows the neighbour's width — an empty neighbour
        // means a narrow cell, which is cosmetically uneven but valid GFM).
        await strip.getByRole('button', { name: 'Add column right' }).click()
        await page.keyboard.type('y')
        await eventually(async () => {
          assert.equal(await firstField.locator('.preview table th').count(), 3)
          assert.match(await docText(firstField), /\| {2}x \| ?y/)
        })

        // Alignment cycles on the caret's column: left -> centre.
        await strip.getByRole('button', { name: 'Cycle column alignment' }).click()
        await eventually(async () => {
          assert.equal(await firstField.locator('.preview table th').nth(1).getAttribute('style'), 'text-align:center')
          assert.match(await docText(firstField), /\| -{8} \| :--+: \|/)
        })

        // Delete column takes the caret's column back out everywhere.
        await strip.getByRole('button', { name: 'Delete column' }).click()
        await eventually(async () => {
          assert.equal(await firstField.locator('.preview table th').count(), 2)
        })

        // Delete row removes the caret's row (the one holding x/y).
        await strip.getByRole('button', { name: 'Delete row' }).click()
        await eventually(async () => {
          const text = await docText(firstField)
          assert.doesNotMatch(text, /x/)
          assert.match(text, /\| Header 1 \| Header 2 \|\n\| -{8} \| -{8} \|/)
        })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a malformed pseudo-table degrades gracefully: no strip, no corruption (#134)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const firstField = page.locator('.field-markdown').nth(0)
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')
        // Ragged: two pipes up top, one below, no valid delimiter run.
        await page.keyboard.insertText('| a | b |\n| - |')

        // Put the caret inside the pseudo-table's second line.
        await firstField.locator('.cm-line', { hasText: '| - |' }).click()

        // No strip may appear — the caret is outside a well-formed table.
        await eventually(async () => {
          assert.equal(await firstField.locator('.table-toolbar').count(), 0)
        })
        const before = await docText(firstField)
        // Tab indents and Shift-Tab outdents outside a table (#146).
        await page.keyboard.press('Tab')
        const afterTab = await docText(firstField)
        assert.notEqual(afterTab, before, 'Tab indents outside a table')
        await page.keyboard.press('Shift+Tab')
        assert.equal(await docText(firstField), before, 'Shift-Tab outdents back to the original')

        // Enter still just splits a line.
        await page.keyboard.press('Enter')
        await eventually(async () => {
          assert.equal((await docText(firstField)).split('\n').length, 3)
        })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Per #134's styling requirement: preview tables dress themselves purely from
// design tokens, so the same rules hold across light/dark/high-contrast.
test('preview tables are token-styled in all three themes (#134)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const firstField = page.locator('.field-markdown').nth(0)
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')
        await firstField.getByRole('button', { name: 'Insert ▾' }).click()
        await firstField.locator('.insert-dropdown .menu').getByRole('menuitem', { name: 'Table' }).click()
        const grid = firstField.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        await grid.locator('[data-row="2"][data-col="2"]').click()
        const cell = firstField.locator('.preview td').first()
        await cell.waitFor({ timeout: 5_000 })

        let lightBorder = null
        for (const theme of ['light', 'dark', 'hc']) {
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
          // hc intentionally thickens --hairline to 2px, so assert against the
          // token rather than a hardcoded pixel value.
          const hairline = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--hairline').trim()
          )
          const style = await cell.evaluate((el) => {
            const s = getComputedStyle(el)
            return { width: s.borderTopWidth, style: s.borderTopStyle, color: s.borderTopColor }
          })
          assert.equal(style.style, 'solid', `${theme}: td edges must be ruled`)
          assert.equal(style.width, hairline, `${theme}: rules follow the --hairline token`)
          if (theme === 'light') lightBorder = style.color
          if (theme === 'dark') assert.notEqual(style.color, lightBorder, 'border colour follows the theme tokens')
        }
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #132's Section item: a titled custom block is appended BELOW the requesting field, survives save/reload as a preserved custom section, and comes back on a fresh page load in the right place.
test('Insert ▾ → Section adds a titled custom field below the requesting field that survives save/reload', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const contextModule = page.locator('.module').first()
        const firstField = contextModule.locator('.field-markdown').nth(0)

        // Insert ▾ → Section opens the title prompt.
        await firstField.getByRole('button', { name: 'Insert ▾' }).click()
        await contextModule.locator('.insert-dropdown .menu').getByRole('menuitem', { name: 'Section' }).click()
        const dialog = page.locator('.modal[aria-label="New section"]')
        await dialog.waitFor({ state: 'visible', timeout: 5_000 })

        // A blank title is allowed (optional); give this one a real title instead.
        await dialog.locator('input[type=text]').fill('Risks we carry')
        await dialog.getByRole('button', { name: 'Insert section' }).click()
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 })

        // The new editable block appears directly below Business driver (before the list and out-of-scope fields), with its own Insert ▾ beneath it.
        const titles = await contextModule.locator('.field > label').allTextContents()
        assert.deepEqual(
          titles.map((t) => t.replace(/ \*$/, '')),
          ['Business driver', 'Risks we carry', 'Affected domains', 'Opportunity', 'In scope', 'Explicitly out of scope']
        )
        assert.equal(await contextModule.getByRole('button', { name: 'Insert ▾' }).count(), 5)

        // Type into the new block, then save everything to disk.
        const newField = contextModule.locator('.field-markdown').nth(1)
        await newField.locator('.cm-content').click()
        await page.keyboard.type('The June deadline.')
        await contextModule.getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })
        assert.deepEqual(pageErrors, [])

        // Fresh page load: the custom section comes back below Business driver, exactly where it was inserted.
        await page.reload()
        await page.waitForSelector('.module', { timeout: 10_000 })
        const reloadedTitles = await contextModule.locator('.field > label').allTextContents()
        assert.equal(reloadedTitles[1].replace(/ \*$/, ''), 'Risks we carry')
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    assert.deepEqual(data.customFields, [
      { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' },
    ])
    assert.deepEqual(data.layout, [
      { field: 'driver' },
      { custom: { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' } },
      { field: 'affected-domains' },
      { field: 'opportunity' },
      { field: 'in-scope' },
      { field: 'out-of-scope' },
    ])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — the per-field formatting toolbar: it mounts only while
// its own markdown field holds focus, moves with focus between fields,
// vanishes on blur, and never appears in Rendered mode.
test('formatting toolbar follows field focus, hides on blur, and never shows in Rendered (#133)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        const content = field.locator('.cm-content')

        // No field focused yet -> no toolbar anywhere.
        assert.equal(await page.locator('.md-toolbar').count(), 0)

        // Focusing the field mounts its toolbar, carrying the full button set.
        await content.click()
        const toolbar = field.locator('.md-toolbar')
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        for (const name of [
          'Bold',
          'Italic',
          'Strikethrough',
          'Inline code',
          'Link',
          'Bullet list',
          'Numbered list',
          'Task list',
          'Blockquote',
          'Horizontal rule',
          'Code block',
          'Headings',
        ]) {
          assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 1, `${name} button`)
        }

        // Blur (click the page header) takes the toolbar with it.
        await page.locator('header h1').click()
        await toolbar.waitFor({ state: 'detached', timeout: 5_000 })

        // Refocus brings it back; Rendered mode keeps it away even though the
        // hidden editor still exists in the DOM.
        await content.click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        await page.locator('.segmented').getByRole('button', { name: 'Rendered' }).click()
        await toolbar.waitFor({ state: 'detached', timeout: 5_000 })
        await field.locator('.cm-content').click({ force: true }).catch(() => {})
        await page.keyboard.type('no toolbar here')
        assert.equal(await page.locator('.md-toolbar').count(), 0)

        await page.locator('.segmented').getByRole('button', { name: 'Split' }).click()
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — smart toggling parity between buttons and shortcuts:
// the Bold button bolds selected prose, Ctrl/Cmd+B strips it back off (same
// engine, opposite direction), and an empty cursor lays down a marker pair
// whose middle swallows the next typed characters.
test('bold round-trips via button then shortcut, and empty-cursor markers wrap typed text (#133)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        const content = field.locator('.cm-content')
        await content.click()

        // Select just the word "beta" and bold it with the toolbar button.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('alpha beta')
        for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
        await field.locator('.md-toolbar').getByRole('button', { name: 'Bold', exact: true }).click()
        assert.equal(await content.textContent(), 'alpha **beta**')

        // The selection now covers the marked region; the shortcut toggles it
        // back off — proving buttons and shortcuts share one code path.
        await page.keyboard.press('ControlOrMeta+b')
        assert.equal(await content.textContent(), 'alpha beta')

        // Empty document, cursor at position 0: bold lays down a doubled pair
        // with the caret between the halves, and typing lands inside it.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.press('Delete')
        await page.keyboard.press('ControlOrMeta+b')
        assert.equal(await content.textContent(), '****')
        await page.keyboard.type('core')
        assert.equal(await content.textContent(), '**core**')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — the Headings dropdown offers H3–H6 only (author content
// starts at ### per ADR-0016), sets a level, re-levels directly, and strips
// when the current level is re-invoked.
test('headings dropdown applies H3-H6, re-levels, and strips on re-invoke (#133)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        const content = field.locator('.cm-content')
        await content.click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('Plan the work.')

        const headingsTrigger = field.locator('.md-toolbar').getByRole('button', { name: 'Headings', exact: true })
        const menuItem = (label) => field.locator('.md-headings .menu button', { hasText: label })

        // Exactly H3-H6 in the menu — H1/H2 belong to the structural scale.
        await headingsTrigger.click()
        await menuItem('Heading 3').waitFor({ state: 'visible', timeout: 2_000 })
        assert.deepEqual(
          await field.locator('.md-headings .menu button').allTextContents(),
          ['Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']
        )

        await menuItem('Heading 3').click()
        assert.equal(await content.textContent(), '### Plan the work.')
        assert.equal(await field.locator('.md-headings .menu').count(), 0, 'menu closes after choosing a level')

        // Re-opening re-levels straight from H3 to H6 without stripping first.
        await headingsTrigger.click()
        await menuItem('Heading 6').click()
        assert.equal(await content.textContent(), '###### Plan the work.')

        // Re-invoking the current level removes the marker entirely.
        await headingsTrigger.click()
        await menuItem('Heading 6').click()
        assert.equal(await content.textContent(), 'Plan the work.')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — the remaining block buttons end-to-end: task list,
// blockquote stacking over it, horizontal-rule blank-line hygiene at the end
// of the document. Verified against the saved module file on disk, since
// CodeMirror's multi-line textContent drops newlines.
test('task list, blockquote, and horizontal rule write real markdown to disk (#133)', async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        const toolbar = field.locator('.md-toolbar')
        await field.locator('.cm-content').click()

        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('first\nsecond')
        await page.keyboard.press('ControlOrMeta+a')

        await toolbar.getByRole('button', { name: 'Task list', exact: true }).click()
        await toolbar.getByRole('button', { name: 'Blockquote', exact: true }).click()
        await page.keyboard.press('ControlOrMeta+End')
        await toolbar.getByRole('button', { name: 'Horizontal rule', exact: true }).click()

        await page.locator('.module').first().getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    assert.equal(data.fields.driver, '> - [ ] first\n> - [ ] second\n\n---')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — inline code, link, and code block produce previews the
// renderer understands (the user-visible point of the raw markers).
test("inline code, link, and code block buttons render real preview output (#133)", async () => {
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

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        const toolbar = field.locator('.md-toolbar')
        const preview = field.locator('.preview')
        await field.locator('.cm-content').click()

        // Inline code wraps the selection; the preview shows it as <code>.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('run gantry now')
        for (let i = 0; i < 11; i++) await page.keyboard.press('Shift+ArrowLeft')
        await toolbar.getByRole('button', { name: 'Inline code', exact: true }).click()
        await assert.doesNotReject(preview.locator('code', { hasText: 'gantry now' }).waitFor({ timeout: 5_000 }))

        // Link turns prose into [text](url) with the URL slot pre-selected,
        // so typing the address completes the link.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('see the docs')
        await page.keyboard.press('ControlOrMeta+a')
        await toolbar.getByRole('button', { name: 'Link', exact: true }).click()
        await page.keyboard.type('https://example.dev/guide')
        await assert.doesNotReject(
          preview.locator('a[href="https://example.dev/guide"]').waitFor({ timeout: 5_000 })
        )

        // Code block fences every line of the selection; preview shows <pre>.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('npm install\nnpm test')
        await page.keyboard.press('ControlOrMeta+a')
        await toolbar.getByRole('button', { name: 'Code block', exact: true }).click()
        await assert.doesNotReject(
          preview.locator('pre', { hasText: 'npm install' }).waitFor({ timeout: 5_000 })
        )

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — the B/I/S letters demonstrate their own effect in every
// theme (computed styles, not just class presence), per the ticket's
// self-demonstrating requirement across light/dark/high-contrast.
test('B/I/S toolbar letters are visually self-demonstrating across all three themes (#133)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        await field.locator('.cm-content').click()
        const toolbar = field.locator('.md-toolbar')
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })

        for (const theme of ['light', 'dark', 'hc']) {
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
          const bold = await toolbar.locator('.md-letter-bold').evaluate((el) => getComputedStyle(el).fontWeight)
          const italic = await toolbar.locator('.md-letter-italic').evaluate((el) => getComputedStyle(el).fontStyle)
          const strike = await toolbar
            .locator('.md-letter-strike')
            .evaluate((el) => getComputedStyle(el).textDecorationLine)
          assert.ok(Number(bold) >= 700, `${theme}: B must render bold, got font-weight ${bold}`)
          assert.equal(italic, 'italic', `${theme}: I must render italic`)
          assert.ok(strike.includes('line-through'), `${theme}: S must render struck through`)
        }
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #135 — the sticky view bar: the Markdown/Split/Rendered bar
// pins to the top of the viewport once scrolled past (so view switching stays
// reachable over long modules), and sits back below the header again at the
// top of the page.
test('view-mode bar sticks to the top while scrolling and returns below the header at the top (#135)', async () => {
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

        // A short viewport guarantees the fixture page can actually scroll.
        await page.setViewportSize({ width: 1280, height: 500 })
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const toolbar = page.locator('.toolbar')
        assert.equal(await toolbar.evaluate((el) => getComputedStyle(el).position), 'sticky')

        // Scroll deep into the page: the bar must ride along pinned at y≈0.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        const maxScroll = await page.evaluate(() => window.scrollY)
        assert.ok(maxScroll > 100, 'fixture page must be scrollable for stickiness to be observable')
        const pinned = await toolbar.boundingBox()
        assert.ok(Math.abs(pinned.y) <= 1, `bar must pin to the viewport top, got y=${pinned.y}`)

        // Back at the top it yields its natural place under the header.
        await page.evaluate(() => window.scrollTo(0, 0))
        const atTop = await toolbar.boundingBox()
        assert.ok(atTop.y > 1, `bar must sit below the header at the top of the page, got y=${atTop.y}`)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #135 — full-screen field expansion: the ⤢ button at the right
// end of each field's toolbar expands that field panel via the Fullscreen
// API with the formatting toolbar staying visible inside it; split mode
// fills the screen with BOTH panes; Esc and the same button exit; the sticky
// view bar is suppressed while expanded and returns after.
test('⤢ expands a field full-screen with both split panes and its toolbar; Esc and ⤢ exit; sticky bar yields meanwhile (#135)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    const near = (actual, expected, tolerance, what) =>
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${what}: expected ≈${expected} ±${tolerance}, got ${actual}`
      )

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const field = page.locator('.field-markdown').first()
        const content = field.locator('.cm-content')
        const toolbar = field.locator('.md-toolbar')

        // The toolbar (and hence ⤢) mounts on focus.
        await content.click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await toolbar.getByRole('button', { name: 'Full screen', exact: true }).count(), 1)

        // With normal document flow there is room below this field's Insert
        // trigger, so the menu keeps its existing downward placement.
        const insert = field.getByRole('button', { name: 'Insert ▾' })
        await insert.click()
        const insertMenu = field.locator('.insert-dropdown .menu')
        await insertMenu.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await insertMenu.evaluate((el) => el.classList.contains('menu-up')), false)
        await insert.click()

        // Expand: the native Fullscreen API takes the field wrapper itself.
        // Waits cover BOTH the platform state and the page's own reaction to
        // it (the data-field-fullscreen stamp) — fullscreenchange is queued
        // asynchronously, so observing fullscreenElement alone can outrun
        // the handler that writes the stamp.
        await toolbar.getByRole('button', { name: 'Full screen', exact: true }).click()
        await page.waitForFunction(
          () =>
            !!document.fullscreenElement &&
            document.documentElement.hasAttribute('data-field-fullscreen'),
          null,
          { timeout: 5_000 }
        )
        assert.equal(
          await page.evaluate(() => document.fullscreenElement?.classList.contains('field-markdown')),
          true,
          'the field panel itself must be the full-screen element'
        )
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-field-fullscreen')), true)

        // The expanded panel fills the viewport exactly.
        const vp = page.viewportSize()
        const box = await field.boundingBox()
        near(box.x, 0, 1, 'expanded x')
        near(box.y, 0, 1, 'expanded y')
        near(box.width, vp.width, 2, 'expanded width')
        near(box.height, vp.height, 2, 'expanded height')

        // Split mode: BOTH panes visible, each filling the expanded row's
        // height (the panes expand together). Inside the editor pane the
        // formatting toolbar legitimately occupies the top strip, so the
        // pane is what must match the row — with the editor host reaching
        // all the way down to the row's bottom edge beneath it.
        const splitBox = await field.locator('.split').boundingBox()
        const paneBox = await field.locator('.editor-pane').boundingBox()
        const previewBox = await field.locator('.preview').boundingBox()
        assert.ok(await field.locator('.editor-pane').isVisible(), 'editor pane visible while expanded')
        assert.ok(await field.locator('.preview').isVisible(), 'preview pane visible while expanded')
        near(paneBox.height, splitBox.height, 2, 'editor pane fill')
        near(previewBox.height, splitBox.height, 2, 'preview pane fill')
        near(paneBox.y + paneBox.height, splitBox.y + splitBox.height, 2, 'editor pane reaches the row bottom')
        assert.ok(splitBox.height > vp.height / 3, 'panes must genuinely fill most of the screen')

        // The toolbar remains visible inside the expanded panel…
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        const tbBox = await toolbar.boundingBox()
        assert.ok(tbBox.y >= 0 && tbBox.y + tbBox.height <= vp.height, 'toolbar inside the viewport')
        // …even once focus wanders into the preview pane — expansion pins it.
        await field.locator('.preview').click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })

        // In full-screen mode the trigger is at the bottom of the viewport;
        // the complete Insert menu therefore flips above it instead of being
        // clipped below the viewport.
        await insert.click()
        await insertMenu.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await insertMenu.evaluate((el) => el.classList.contains('menu-up')), true)
        await insert.click()

        // The sticky view bar is suppressed while full-screen.
        assert.equal(
          await page.locator('.toolbar').evaluate((el) => getComputedStyle(el).position),
          'static',
          'view-mode bar must not stick during full-screen'
        )

        // Esc exits; the sticky bar reappears after exit. Esc-to-exit is
        // handled by the browser's own full-screen UI layer — every real
        // browser does it with zero page code, which is why the feature
        // builds on the native Fullscreen API at all — but headless
        // Chromium ships no such layer and swallows the key entirely, so
        // where it doesn't take effect we drive the very exit call that
        // layer makes (document.exitFullscreen) and assert the identical
        // post-conditions: the change event fires either way.
        await page.keyboard.press('Escape')
        try {
          await page.waitForFunction(
            () =>
              !document.fullscreenElement &&
              !document.documentElement.hasAttribute('data-field-fullscreen'),
            null,
            { timeout: 1_000 }
          )
        } catch {
          await page.evaluate(() => document.exitFullscreen())
          await page.waitForFunction(
            () =>
              !document.fullscreenElement &&
              !document.documentElement.hasAttribute('data-field-fullscreen'),
            null,
            { timeout: 5_000 }
          )
        }
        assert.equal(await page.locator('.toolbar').evaluate((el) => getComputedStyle(el).position), 'sticky')

        // The same button exits too.
        await content.click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        await toolbar.getByRole('button', { name: 'Full screen', exact: true }).click()
        await page.waitForFunction(
          () =>
            !!document.fullscreenElement &&
            document.documentElement.hasAttribute('data-field-fullscreen'),
          null,
          { timeout: 5_000 }
        )
        await toolbar.getByRole('button', { name: 'Exit full screen', exact: true }).click()
        await page.waitForFunction(
          () =>
            !document.fullscreenElement &&
            !document.documentElement.hasAttribute('data-field-fullscreen'),
          null,
          { timeout: 5_000 }
        )

        // Rendered mode stays exactly as before: no formatting/full-screen
        // affordances anywhere, read-only rules untouched.
        await page.locator('.segmented').getByRole('button', { name: 'Rendered' }).click()
        assert.equal(await page.locator('.md-toolbar').count(), 0)
        await page.locator('.segmented').getByRole('button', { name: 'Split' }).click()

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
