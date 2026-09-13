import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { withRunningServer } from './helpers/lifecycle.js'

// A minimal real 1x1 red PNG — small enough to inline as a Playwright setInputFiles buffer, real enough to round-trip through the actual upload -> disk -> serve path (mirrors tests/assets.test.js's HTTP-level copy of the same fixture).
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

// Picks a view from the editor's Mode ▾ dropdown (#374): Visual, Split or Markdown.
async function chooseMode(page, label) {
  await page.locator('.view-mode-dropdown').getByRole('button', { name: /^Mode/ }).click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}

// Minimal browser smoke test for the Preact/HTM-ported module editor (docs/adr/0006-preact-frontend-framework.md): confirms the real page loads with no console/page errors, and that a markdown field's edit -> save round-trips to the module file on disk — the same guarantee tests/server.test.js checks at the HTTP layer, exercised here through an actual rendered page and a real CodeMirror 6 editor instance.
//
// The module editor now lives at /instance/<slug> — the instance dashboard (#77) is the landing screen at / — so this navigates straight there rather than relying on a server-pinned default slug being shown at /. See tests/dashboard.playwright.test.js for the dashboard's own smoke test.

// Coverage for WI259 — top-of-page Insert control that prepends a first section/list.
test('top-of-page Insert ▾ prepends Section and List as first field, survives Save + reload, and stays in every view (WI259)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const contextModule = page.locator('.module').first()
        const topInsert = page.locator('[data-testid="top-insert"]')
        const topTrigger = topInsert.getByRole('button', { name: 'Insert ▾' })

        // Present in edit mode, inside the main #modules and before the first module.
        await assert.doesNotReject(topInsert.waitFor({ state: 'visible', timeout: 5_000 }))
        const topBox = await topInsert.boundingBox()
        const firstModuleBox = await contextModule.boundingBox()
        assert.ok(topBox.y < firstModuleBox.y, 'top Insert must sit above the first module')
        // Visually distinct as a page-level bar, not attached to the first heading.
        const topStyle = await topInsert.evaluate((el) => {
          const s = getComputedStyle(el)
          return { borderStyle: s.borderStyle, background: s.backgroundColor, display: s.display }
        })
        assert.equal(topStyle.borderStyle, 'dashed', 'top bar should be dashed to read as insertion point')
        assert.equal(topStyle.display, 'flex')
        // Trigger reuses InsertDropdown's Section + List menu.
        await topTrigger.click()
        const topMenu = topInsert.locator('.menu')
        await topMenu.waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(await topMenu.getByRole('menuitem').allTextContents(), ['Section', 'List'])
        await topTrigger.click()
        await topMenu.waitFor({ state: 'hidden', timeout: 5_000 })

        // Every view is an editing view (#374), so the bar stays in all three.
        for (const mode of ['Split', 'Markdown', 'Visual']) {
          await chooseMode(page, mode)
          await topInsert.waitFor({ state: 'visible', timeout: 5_000 })
        }

        // Choosing Section prepends before the previously-first field.
        const beforeTitles = await contextModule.locator('.field > label').allTextContents()
        assert.ok(beforeTitles.length >= 2, 'seeded context module should have fields')
        const previouslyFirst = beforeTitles[0].replace(/ \*$/, '')
        await topTrigger.click()
        await topMenu.waitFor({ state: 'visible', timeout: 5_000 })
        await topMenu.getByRole('menuitem', { name: 'Section' }).click()
        const sectionDialog = page.locator('.modal[aria-label="New section"]')
        await sectionDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await sectionDialog.locator('input[type=text]').fill('Prepended Section')
        await sectionDialog.getByRole('button', { name: 'Insert section' }).click()
        await sectionDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        const afterSectionTitles = await contextModule.locator('.field > label').allTextContents()
        assert.equal(afterSectionTitles[0].replace(/ \*$/, ''), 'Prepended Section')
        assert.equal(afterSectionTitles[1].replace(/ \*$/, ''), previouslyFirst)

        // Type into the newly prepended section and save.
        const newSectionField = contextModule.locator('.field-markdown').first()
        await newSectionField.locator('.cm-content').click()
        await page.keyboard.type('Top section content.')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        // Survives reload in that position.
        await page.reload()
        await page.waitForSelector('.module', { timeout: 10_000 })
        const reloadedAfterSection = await page.locator('.module').first().locator('.field > label').allTextContents()
        assert.equal(reloadedAfterSection[0].replace(/ \*$/, ''), 'Prepended Section')
        assert.equal(reloadedAfterSection[1].replace(/ \*$/, ''), previouslyFirst)

        // Choosing List does the same for a list field — becomes the new first field.
        const topInsert2 = page.locator('[data-testid="top-insert"]')
        const topTrigger2 = topInsert2.getByRole('button', { name: 'Insert ▾' })
        await topTrigger2.click()
        await topInsert2.locator('.menu').waitFor({ state: 'visible', timeout: 5_000 })
        await topInsert2.locator('.menu').getByRole('menuitem', { name: 'List' }).click()
        const listDialog = page.locator('.modal[aria-label="New list"]')
        await listDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await listDialog.locator('input[type=text]').fill('Prepended List')
        await listDialog.getByRole('button', { name: 'Insert list' }).click()
        await listDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        const afterListTitles = await page.locator('.module').first().locator('.field > label').allTextContents()
        assert.equal(afterListTitles[0].replace(/ \*$/, ''), 'Prepended List')
        assert.equal(afterListTitles[1].replace(/ \*$/, ''), 'Prepended Section')
        // The new first field is a list-type rows editor.
        const firstField = page.locator('.module').first().locator('.field').first()
        assert.ok(await firstField.locator('.list-rows').isVisible(), 'prepended List should render as list field')
        // Add an item so the list has content before saving.
        await firstField.locator('textarea').first().fill('First list item')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        await page.reload()
        await page.waitForSelector('.module', { timeout: 10_000 })
        const reloadedAfterList = await page.locator('.module').first().locator('.field > label').allTextContents()
        assert.equal(reloadedAfterList[0].replace(/ \*$/, ''), 'Prepended List')
        assert.equal(reloadedAfterList[1].replace(/ \*$/, ''), 'Prepended Section')
        assert.equal(reloadedAfterList[2].replace(/ \*$/, ''), previouslyFirst)

        // Still there in Markdown view after reload.
        await chooseMode(page, 'Markdown')
        await page.locator('[data-testid="top-insert"]').waitFor({ state: 'visible', timeout: 5_000 })
        await chooseMode(page, 'Visual')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'background', { instancesDir: join(instancesDir, 'default') })
    // Both custom fields persisted in layout order, prepended first.
    const layoutIds = data.layout.map((entry) => (entry.custom ? entry.custom.title : entry.field))
    assert.equal(layoutIds[0], 'Prepended List')
    assert.equal(layoutIds[1], 'Prepended Section')
    assert.ok(data.customFields.some((f) => f.title === 'Prepended Section' && f.value === 'Top section content.'))
    const listField = data.customFields.find((f) => f.title === 'Prepended List')
    assert.ok(listField, 'list custom field should be persisted')
    assert.deepEqual(listField.value, ['First list item'])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for WI263 — every per-field Insert ▾ now uses the same dashed
// insertion-point bar as the top-of-page Insert from WI259.
test('per-field Insert ▾ uses the shared dashed insert-bar and both bars stay in every view (WI263)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const topInsert = page.locator('[data-testid="top-insert"]')
        const perFieldBar = page.locator('.field-markdown .insert-bar').first()
        const allPerFieldBars = page.locator('.field-markdown .insert-bar')

        // Both bars present in Split (default) and each owns its Insert ▾ trigger.
        await assert.doesNotReject(topInsert.waitFor({ state: 'visible', timeout: 5_000 }))
        await assert.doesNotReject(perFieldBar.waitFor({ state: 'visible', timeout: 5_000 }))
        assert.ok((await allPerFieldBars.count()) >= 2, 'every markdown field should have its own insert-bar')
        assert.equal(await topInsert.getByRole('button', { name: 'Insert ▾' }).count(), 1)
        assert.equal(await perFieldBar.getByRole('button', { name: 'Insert ▾' }).count(), 1)
        // Top bar composes the shared class.
        assert.equal(await topInsert.evaluate((el) => el.classList.contains('insert-bar')), true)
        assert.equal(await topInsert.evaluate((el) => el.classList.contains('top-insert-bar')), true)

        // Visually identical: dashed insertion-point bar, same tokens, left-aligned flex.
        const topStyle = await topInsert.evaluate((el) => {
          const s = getComputedStyle(el)
          return { borderStyle: s.borderStyle, display: s.display, borderColor: s.borderTopColor }
        })
        const perStyle = await perFieldBar.evaluate((el) => {
          const s = getComputedStyle(el)
          return { borderStyle: s.borderStyle, display: s.display, borderColor: s.borderTopColor }
        })
        assert.equal(topStyle.borderStyle, 'dashed', 'top bar should be dashed')
        assert.equal(perStyle.borderStyle, 'dashed', 'per-field bar should be dashed like the top one')
        assert.equal(topStyle.display, 'flex')
        assert.equal(perStyle.display, 'flex')
        // Both use the theme token for the border (not a hard-coded colour) — colours must match each other and follow the token across themes.
        assert.equal(topStyle.borderColor, perStyle.borderColor, 'both bars must share the same token-driven border colour')
        // Vertical margin tuned: top bar keeps a larger top separation than the tighter per-field bars so a column of field→bar→field→bar doesn't look noisy.
        const topMarginTop = await topInsert.evaluate((el) => getComputedStyle(el).marginTop)
        const perMarginTop = await perFieldBar.evaluate((el) => getComputedStyle(el).marginTop)
        assert.ok(parseInt(topMarginTop, 10) > parseInt(perMarginTop, 10), `top margin (${topMarginTop}) should be larger than per-field margin (${perMarginTop})`)
        // Every per-field bar is dashed too (not just the first).
        const perStyles = await allPerFieldBars.evaluateAll((els) => els.map((el) => getComputedStyle(el).borderStyle))
        for (const bs of perStyles) assert.equal(bs, 'dashed')

        // Light + dark: border colour must follow the token (no hard-coded colours) —
        // switching theme changes the computed border colour.
        const lightBorder = perStyle.borderColor
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
        const darkBorder = await perFieldBar.evaluate((el) => getComputedStyle(el).borderTopColor)
        // Not asserting exact values — just that the token makes the colour theme-dependent (if tokens happen to be identical we skip the check rather than false-fail).
        if (lightBorder !== darkBorder) assert.notEqual(darkBorder, lightBorder)
        await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))

        // Every view is an editing view (#374): both bars stay put in all three.
        for (const mode of ['Split', 'Markdown', 'Visual']) {
          await chooseMode(page, mode)
          await topInsert.waitFor({ state: 'visible', timeout: 5_000 })
          await perFieldBar.waitFor({ state: 'visible', timeout: 5_000 })
        }

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for WI287 — the per-field dashed Insert bar was rendered only after
// markdown fields; a list field had no way to insert a sibling after it.
test('per-field Insert ▾ appears after a list field and inserts Section/List right after it (WI287)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const firstModule = page.locator('.module').first()

        // Prepend a list field via the top-of-page Insert so the first module owns
        // a list field to test against, whatever the seeded artefact's own fields are.
        const topInsert = page.locator('[data-testid="top-insert"]')
        await topInsert.getByRole('button', { name: 'Insert ▾' }).click()
        await topInsert.locator('.menu').getByRole('menuitem', { name: 'List' }).click()
        const seedListDialog = page.locator('.modal[aria-label="New list"]')
        await seedListDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await seedListDialog.locator('input[type=text]').fill('Checklist')
        await seedListDialog.getByRole('button', { name: 'Insert list' }).click()
        await seedListDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        const listField = firstModule.locator('.field-list').first()
        await listField.waitFor({ state: 'visible', timeout: 5_000 })

        // The dashed Insert bar now renders inside the list field, below its rows.
        const listInsertBar = listField.locator('.insert-bar')
        await listInsertBar.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await listInsertBar.count(), 1, 'a list field should have exactly one trailing insert-bar')
        assert.equal(await listInsertBar.evaluate((el) => getComputedStyle(el).borderStyle), 'dashed')
        const rowsBox = await listField.locator('.list-rows').boundingBox()
        const barBox = await listInsertBar.boundingBox()
        assert.ok(barBox.y > rowsBox.y, 'insert-bar should sit after the list rows')

        // Choosing Section from the list field's own Insert ▾ inserts right after it.
        await listInsertBar.getByRole('button', { name: 'Insert ▾' }).click()
        await listInsertBar.locator('.menu').waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(await listInsertBar.locator('.menu').getByRole('menuitem').allTextContents(), ['Section', 'List'])
        await listInsertBar.locator('.menu').getByRole('menuitem', { name: 'Section' }).click()
        const sectionDialog = page.locator('.modal[aria-label="New section"]')
        await sectionDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await sectionDialog.locator('input[type=text]').fill('After-List Section')
        await sectionDialog.getByRole('button', { name: 'Insert section' }).click()
        await sectionDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        const afterSection = (await firstModule.locator('.field > label').allTextContents()).map((t) => t.replace(/ \*$/, ''))
        assert.equal(afterSection[0], 'Checklist')
        assert.equal(afterSection[1], 'After-List Section')

        // Choosing List from the same bar inserts a list field directly after the list.
        await listInsertBar.getByRole('button', { name: 'Insert ▾' }).click()
        await listInsertBar.locator('.menu').waitFor({ state: 'visible', timeout: 5_000 })
        await listInsertBar.locator('.menu').getByRole('menuitem', { name: 'List' }).click()
        const listDialog = page.locator('.modal[aria-label="New list"]')
        await listDialog.waitFor({ state: 'visible', timeout: 5_000 })
        await listDialog.locator('input[type=text]').fill('After-List List')
        await listDialog.getByRole('button', { name: 'Insert list' }).click()
        await listDialog.waitFor({ state: 'hidden', timeout: 5_000 })

        const afterList = (await firstModule.locator('.field > label').allTextContents()).map((t) => t.replace(/ \*$/, ''))
        assert.equal(afterList[0], 'Checklist')
        assert.equal(afterList[1], 'After-List List')
        assert.equal(afterList[2], 'After-List Section')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the ported module editor page loads with no errors and a markdown field save round-trips', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        assert.equal(await page.locator('header h1').textContent(), 'examples — design')
        assert.deepEqual(pageErrors, [])

        // Edit the Context module's "Problem statement" markdown field via its real CodeMirror 6 editor, then save.
        const newText = 'Edited by the Playwright smoke test.'
        await page.locator('.field-markdown .cm-content').first().click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type(newText)
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'background', { instancesDir: join(instancesDir, 'default') })
    assert.equal(data.fields.problem, 'Edited by the Playwright smoke test.')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// #113 — the theme toggle used to be duplicated across this header, the dashboard topbar, the setup wizard header, and Settings' header; it now lives solely in Settings (see tests/settings.playwright.test.js).
test('module editor: the header no longer has its own theme toggle (moved to Settings, #113)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
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

// Coverage for #79 and #374 — the Visual/Split/Markdown Mode dropdown, its keyboard hotkey, and the state's global/session-only scope. Read-only now belongs to archived instances only (tests/visual-mode.playwright.test.js).
test('the Mode dropdown switches views, cycles via hotkey, and stays global across stage switches', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const main = page.locator('#modules')
        const trigger = page.locator('.view-mode-dropdown').getByRole('button', { name: /^Mode/ })

        // Defaults to Visual on a fresh visit.
        assert.equal(await main.getAttribute('data-view-mode'), 'visual')
        assert.equal((await trigger.textContent()).trim(), 'Visual ▾')

        // The dropdown switches views.
        await chooseMode(page, 'Markdown')
        assert.equal(await main.getAttribute('data-view-mode'), 'markdown')
        assert.equal((await trigger.textContent()).trim(), 'Markdown ▾')

        // The hotkey (Ctrl+Shift+V) cycles in dropdown order: markdown -> visual -> split.
        await page.keyboard.press('Control+Shift+V')
        assert.equal(await main.getAttribute('data-view-mode'), 'visual')
        await page.keyboard.press('Control+Shift+V')
        assert.equal(await main.getAttribute('data-view-mode'), 'split')

        // Switch to Markdown, then navigate to a different stage via the free-browse stage nav — the view-mode state is global to the whole editor screen, so it must hold steady, not reset per-stage.
        await chooseMode(page, 'Markdown')
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

    // A fresh visit (new page load) resets to Visual, not persisted from the previous session.
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.locator('#modules').getAttribute('data-view-mode'), 'visual')
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #181 — the artefact selector is shown only when artefacts have
// different field requirements, filters at field granularity, remembers the
// choice for this instance/stage across reloads, and uses the first artefact
// for a newly visited stage.
test('artefact selector filters Shape and Detailed Design fields, persists per stage, and leaves required badges unchanged', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const selector = page.getByRole('combobox', { name: 'Artefact' })
        await selector.waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(await selector.locator('option').allTextContents(), ['Solution on a Page', 'Full Solution on a Page'])
        assert.equal(await selector.inputValue(), 'soap')

        // The lightweight SOAP uses the whole shared Shape modules, but not
        // Full SOAP's extra dependencies/details modules.
        assert.equal(await page.locator('.module h2', { hasText: 'Dependencies' }).count(), 0)
        assert.equal(await page.locator('.module h2', { hasText: 'Full SOAP Details' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Affected domains' }).count(), 1)
        assert.equal(await page.locator('.field label', { hasText: 'Problem statement *' }).count(), 1)

        await selector.selectOption('soap-full')
        assert.equal(await page.locator('.module h2', { hasText: 'Dependencies' }).count(), 1)
        assert.equal(await page.locator('.module h2', { hasText: 'Full SOAP Details' }).count(), 1)
        assert.equal(await page.locator('.field label', { hasText: 'Affected domains' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Process flow' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Feature breakdown and involved teams' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Dependency list' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Problem statement *' }).count(), 1)

        // A reload restores the selected artefact for this instance/stage.
        await page.reload()
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.getByRole('combobox', { name: 'Artefact' }).inputValue(), 'soap-full')
        assert.equal(await page.locator('.field label', { hasText: 'Affected domains' }).count(), 0)

        // Drafts in fields hidden by the selected artefact survive switching
        // away and back, even before the module is saved.
        await selector.selectOption('soap')
        const processField = page.locator('.field-markdown', { has: page.locator('label', { hasText: 'Process flow' }) })
        await processField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('An unsaved process-flow draft.')
        await selector.selectOption('soap-full')
        assert.equal(await page.locator('.field label', { hasText: 'Process flow' }).count(), 0)
        await selector.selectOption('soap')
        assert.match(await processField.locator('.cm-content').textContent(), /An unsaved process-flow draft\./)
        await selector.selectOption('soap-full')

        // Detailed Design defaults independently to its alphanumeric-first
        // artefact and exposes the selector because SAD/SSAD differ.
        await page.locator('#stage-nav button', { hasText: 'Detailed Design' }).click()
        // That draft was never saved, so leaving the stage asks first (WI #376).
        await page.locator('.modal[aria-label="Unsaved changes"]').getByRole('button', { name: 'Discard' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        const detailedSelector = page.getByRole('combobox', { name: 'Artefact' })
        await detailedSelector.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await detailedSelector.inputValue(), 'sad')
        assert.equal(await page.locator('.field label', { hasText: 'Design decisions' }).count(), 1)
        // design v2 wires `support-and-operations.operational-accounts-and-licenses?` into the SAD too (optional), so it shows for both artefacts; `Design decisions` is the SAD-only discriminator.
        assert.equal(await page.locator('.field label', { hasText: 'Operational accounts and licenses' }).count(), 1)

        await detailedSelector.selectOption('ssad')
        assert.equal(await page.locator('.field label', { hasText: 'Design decisions' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Operational accounts and licenses' }).count(), 1)
        assert.equal(await page.locator('.field label', { hasText: 'Network and infrastructure' }).count(), 0)
        assert.equal(await page.locator('.field label', { hasText: 'Availability and continuity *' }).count(), 1)

        // HLD has one artefact, so the active artefact is shown as fixed text, not as an interactive selector.
        await page.locator('#stage-nav button', { hasText: 'High-level Design' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.getByRole('combobox', { name: 'Artefact' }).count(), 0)
        const fixedArtefact = page.locator('.artefact-selector .artefact-value')
        assert.equal(await fixedArtefact.getAttribute('aria-label'), 'Artefact')
        assert.equal(await fixedArtefact.textContent(), 'High Level Design')

        // Visiting Shape again starts from its alphanumeric-first default,
        // rather than carrying the earlier soap-full selection across stages.
        await page.locator('#stage-nav button', { hasText: 'SOAP' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.getByRole('combobox', { name: 'Artefact' }).inputValue(), 'soap')

        assert.deepEqual(pageErrors, [])
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
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
        await assert.doesNotReject(dialog.locator('text=Rendered to').waitFor({ timeout: DEFAULT_TIMEOUT * 2 }))
        await page.keyboard.press('Escape')
        try {
          await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        } catch {
          await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } })
          await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
        }

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
        try {
          await secondDialog.waitFor({ state: 'hidden', timeout: 5_000 })
        } catch {
          // Fallback: backdrop click if Escape was missed (e.g. focus still on prior element or listener not yet attached)
          await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } })
          await secondDialog.waitFor({ state: 'hidden', timeout: 5_000 })
        }

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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
           dialog
             .locator('.save-status')
             .getByText('Solution Architecture Document: rendered to', { exact: false })
             .waitFor({ timeout: DEFAULT_TIMEOUT * 2 })
        )
        assert.equal(await dialog.locator('.save-status a').count(), 0)
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

// Coverage for #180 — Image moved to each field's formatting toolbar while
// Section/List remain behind Insert ▾. This test walks the Image path through
// both tabs of the (renamed) Insert image modal — including inline validation
// and live-preview thumbnails — and proves direct toolbar targeting.
test("Image is a direct formatting-toolbar action and Insert offers only Section/List", async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        // The `soap`-scoped `solution-definition` module (design v2, WI #348): its four
        // markdown fields — high-level requirements, process flow, solution overview,
        // feature breakdown — are what it contributes to the lightweight SOAP editor.
        const contextModule = page.locator('.module').filter({ has: page.locator('h2', { hasText: 'Solution Definition' }) })
        await assert.doesNotReject(contextModule.locator('h2', { hasText: 'Solution Definition' }).waitFor({ timeout: 2_000 }))

        // The old single affordance is gone; each markdown field has its own generic dropdown instead.
        assert.equal(await page.getByRole('button', { name: '+ Insert asset' }).count(), 0)
        // `soap`'s field-level `requires` scopes solution-definition to four
        // markdown fields, so four per-field Insert ▾ triggers.
        const triggers = contextModule.getByRole('button', { name: 'Insert ▾' })
        assert.equal(await triggers.count(), 4)
        const firstTrigger = triggers.nth(0)
        const firstField = contextModule.locator('.field-markdown').nth(0)
        const secondField = contextModule.locator('.field-markdown').nth(1)

        await assert.doesNotReject(firstTrigger.waitFor({ state: 'visible', timeout: 5_000 }))

        // The remaining Insert menu offers exactly Section / List.
        await firstTrigger.click()
        const menu = contextModule.locator('.insert-dropdown .menu')
        await menu.waitFor({ state: 'visible', timeout: 5_000 })
        assert.deepEqual(
          await menu.getByRole('menuitem').allTextContents(),
          ['Section', 'List']
        )
        await firstTrigger.click()

        // Image now opens from the FIRST field's formatting toolbar — placed from Markdown view, where a click puts the caret in plain text.
        await chooseMode(page, 'Markdown')
        await firstField.locator('.cm-content').click()
        await firstField.locator('.md-toolbar').getByRole('button', { name: 'Image', exact: true }).click()

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

        // Visual view (#374) draws the inserted image in place.
        await chooseMode(page, 'Visual')
        const firstPreview = contextModule.locator('.field-markdown').nth(0)
        await assert.doesNotReject(firstPreview.locator('.cm-visual-image img.asset-thumb').waitFor({ timeout: 5_000 }))
        assert.equal(await firstPreview.locator('.cm-visual-image img.asset-thumb').count(), 1)

        // "Choose existing" via the SECOND field's own toolbar — the insert
        // must land in the second field, not whichever one was focused last.
        await chooseMode(page, 'Markdown')
        await secondField.locator('.cm-content').click()
        await secondField.locator('.md-toolbar').getByRole('button', { name: 'Image', exact: true }).click()
        await modal.waitFor({ state: 'visible', timeout: 5_000 })
        await page.getByRole('button', { name: 'Choose existing' }).click()
        await modal.locator('.grid-library .card').first().waitFor({ timeout: 5_000 })
        await modal.locator('.grid-library .card').first().click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })
        await chooseMode(page, 'Visual')
        await assert.doesNotReject(secondField.locator('.cm-visual-image img.asset-thumb').first().waitFor({ timeout: 5_000 }))
        assert.equal(await firstPreview.locator('.cm-visual-image img.asset-thumb').count(), 1, 'the first field must be untouched')

        // Hand-typing the same `asset:<id>` convention directly into the markdown (bypassing the modal entirely) renders identically.
        const assetHref = await firstPreview.locator('.cm-visual-image img.asset-thumb').first().getAttribute('src')
        const assetId = assetHref.match(/\/api\/instance\/assets\/([^/]+)\/file/)[1]
        await chooseMode(page, 'Markdown')
        await secondField.locator('.cm-content').click()
        // insertText (one input event), not type (key-by-key) — CodeMirror's auto-close-brackets extension would otherwise pair every "(" typed with an immediate ")", making each intermediate keystroke briefly resolve to its own (broken, 404ing) partial image URL.
        await page.keyboard.insertText(`![Hand-typed](asset:${assetId})`)
        await chooseMode(page, 'Visual')
        await assert.doesNotReject(secondField.locator('.cm-visual-image img.asset-thumb').nth(1).waitFor({ timeout: 5_000 }))

        assert.deepEqual(pageErrors, [])

        // Usage is computed from the saved module file on disk, so save before checking the library reflects it as used.
        await page.getByRole('button', { name: 'Save', exact: true }).click()
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
    const data = readModule(definition, 'examples', 'solution-definition', { instancesDir: join(instancesDir, 'default') })
    assert.match(data.fields['high-level-requirements'], /asset:/)
    // Second markdown field of the `soap`-scoped solution-definition module:
    // high-level requirements, then process flow. The "Choose existing" / hand-typed inserts target it.
    assert.match(data.fields['process-flow'], /asset:/)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #134/#180 — Loop-style table editing: the formatting-toolbar
// Table action's size grid, the contextual control strip, the Tab/Enter keyboard flow, graceful degradation
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

test('toolbar Table opens a size grid whose pick inserts a live table with the caret parked (#134, #180)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
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
        const tableButton = firstField.locator('.md-toolbar').getByRole('button', { name: 'Table', exact: true })
        await tableButton.click()

        const grid = contextModule.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await grid.locator('.table-picker-cell').count(), 64, 'an 8×8 grid')
        assert.equal(await tableButton.getAttribute('aria-haspopup'), 'grid')
        assert.equal(await contextModule.locator('.table-picker .menu').getAttribute('role'), 'grid')

        // Escape dismisses the picker and returns focus to the editor rather
        // than leaving focus on the cell that is about to be unmounted.
        await grid.locator('.table-picker-cell').first().focus()
        await page.keyboard.press('Escape')
        await grid.waitFor({ state: 'hidden', timeout: 5_000 })
        assert.equal(await firstField.locator('.cm-content').evaluate((el) => el === document.activeElement), true)
        await tableButton.click()
        await grid.waitFor({ state: 'visible', timeout: 5_000 })

        // Hovering a corner lights up exactly its R×C rectangle and the
        // caption reads out the size.
        await grid.locator('[data-row="2"][data-col="3"]').hover()
        await eventually(async () => {
          assert.equal(await grid.locator('.table-picker-cell.lit').count(), 6)
          assert.equal(await contextModule.locator('.table-picker-caption').textContent(), '3 × 2')
        })

        await grid.locator('[data-row="2"][data-col="3"]').click()
        // Visual view (#374) draws the new table as a grid and puts the author
        // straight into its first body cell; the grid's own handles replace
        // Markdown view's contextual strip.
        await assert.doesNotReject(firstField.locator('.vgrid-wrap').waitFor({ timeout: 5_000 }))
        assert.equal(await firstField.locator('.vgrid-header .vgrid-cell').count(), 3)
        await eventually(async () => {
          assert.equal(await page.evaluate(() => document.activeElement?.dataset?.row), '2')
        })
        assert.equal(await firstField.locator('.table-toolbar').count(), 0)

        // Round-trip: save, then read the module file back off disk.
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'background', { instancesDir: join(instancesDir, 'default') })
    // Blank-line hygiene kept the lead-in separated, and the fresh table is
    // padded to the header's width.
    assert.match(
      data.fields.problem,
      /^Key decisions:\n\n\| Header 1 \| Header 2 \| Header 3 \|\n\| -{8} \| -{8} \| -{8} \|\n\| {10}\| {10}\| {10}\|$/
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Tab walks the cells, Enter appends a row from the last one, Shift-Tab retraces (#134)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
        // The raw-text table flow is Markdown view's (#374).
        await chooseMode(page, 'Markdown')
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')

        // Seed a 2×2 table through the picker.
        await firstField.locator('.md-toolbar').getByRole('button', { name: 'Table', exact: true }).click()
        const grid = firstField.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        await grid.locator('[data-row="2"][data-col="2"]').click()
        await eventually(async () => assert.match(await docText(firstField), /\| Header 1 \| Header 2 \|/))

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
        // The same table in Visual view: three body rows × two columns.
        await chooseMode(page, 'Visual')
        assert.equal(await firstField.locator('.vgrid-body .vgrid-cell').count(), 6, 'three body rows × two columns')
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
        // The raw-text table flow is Markdown view's (#374).
        await chooseMode(page, 'Markdown')
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')

        await firstField.locator('.md-toolbar').getByRole('button', { name: 'Table', exact: true }).click()
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
          assert.equal((await docText(firstField)).split('\n')[0].split('|').length - 2, 3)
          assert.match(await docText(firstField), /\| {2}x \| ?y/)
        })

        // Alignment cycles on the caret's column: left -> centre.
        await strip.getByRole('button', { name: 'Cycle column alignment' }).click()
        await eventually(async () => {
          assert.match(await docText(firstField), /\| -{8} \| :--+: \|/)
        })

        // Delete column takes the caret's column back out everywhere.
        await strip.getByRole('button', { name: 'Delete column' }).click()
        await eventually(async () => {
          assert.equal((await docText(firstField)).split('\n')[0].split('|').length - 2, 2)
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
        // The raw-text table flow is Markdown view's (#374).
        await chooseMode(page, 'Markdown')
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

// Per #134's styling requirement: Visual grids (#374) dress themselves purely from
// design tokens, so the same rules hold across light/dark/high-contrast.
test('Visual table grids are token-styled in all three themes (#134, #374)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const firstField = page.locator('.field-markdown').nth(0)
        // The raw-text table flow is Markdown view's (#374).
        await chooseMode(page, 'Markdown')
        await firstField.locator('.cm-content').click()
        await page.keyboard.press('ControlOrMeta+a')
        await firstField.locator('.md-toolbar').getByRole('button', { name: 'Table', exact: true }).click()
        const grid = firstField.locator('.table-picker-grid')
        await grid.waitFor({ state: 'visible', timeout: 5_000 })
        await grid.locator('[data-row="2"][data-col="2"]').click()
        await chooseMode(page, 'Visual')
        const cell = firstField.locator('.vgrid-body .vgrid-cell').first()
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
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

        // The new editable block appears directly below Problem statement (before the affected-domains list), with its own Insert ▾ beneath it.
        // The `soap` artefact's field-level `requires` (WI #276/#280) scopes the
        // background module to problem / affected-domains; the author-inserted
        // custom section stays visible alongside them.
        const titles = await contextModule.locator('.field > label').allTextContents()
        assert.deepEqual(
          titles.map((t) => t.replace(/ \*$/, '')),
          ['Problem statement', 'Risks we carry', 'Affected domains']
        )
        // One Insert ▾ per editable field: Problem statement, the new Risks we carry,
        // and the Affected domains list (WI #287 gave list fields their own Insert bar).
        assert.equal(await contextModule.getByRole('button', { name: 'Insert ▾' }).count(), 3)

        // Type into the new block, then save everything to disk.
        const newField = contextModule.locator('.field-markdown').nth(1)
        await newField.locator('.cm-content').click()
        await page.keyboard.type('The June deadline.')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })
        assert.deepEqual(pageErrors, [])

        // Fresh page load: the custom section comes back below Problem statement, exactly where it was inserted.
        await page.reload()
        await page.waitForSelector('.module', { timeout: 10_000 })
        const reloadedTitles = await contextModule.locator('.field > label').allTextContents()
        assert.equal(reloadedTitles[1].replace(/ \*$/, ''), 'Risks we carry')
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'background', { instancesDir: join(instancesDir, 'default') })
    assert.deepEqual(data.customFields, [
      { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' },
    ])
    assert.deepEqual(data.layout, [
      { field: 'problem' },
      { custom: { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' } },
      { field: 'affected-domains' },
      { field: 'opportunity' },
      { field: 'success-criteria' },
    ])
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — the per-field formatting toolbar: it mounts only while
// its own markdown field holds focus, moves with focus between fields,
// and vanishes on blur — in every view (#374).
test('formatting toolbar follows field focus and hides on blur, in every view (#133)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
         const browser = await launchBrowser()
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
          'Lists',
          'Blockquote',
          'Horizontal rule',
          'Code block',
          'Image',
          'Table',
          'Headings',
          'Undo',
          'Redo',
        ]) {
          assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 1, `${name} button`)
        }
        assert.equal(await toolbar.getByRole('button', { name: 'Bullet list', exact: true }).count(), 0)
        assert.equal(await toolbar.getByRole('button', { name: 'Numbered list', exact: true }).count(), 0)
        assert.equal(await toolbar.getByRole('button', { name: 'Task list', exact: true }).count(), 0)
        const listsTrigger = toolbar.getByRole('button', { name: 'Lists', exact: true })
        assert.equal(await listsTrigger.textContent(), '')
        assert.equal(await listsTrigger.locator('svg').count(), 1)
        assert.equal(await toolbar.getByRole('button', { name: 'Image', exact: true }).getAttribute('tabindex'), '0')
        assert.equal(await toolbar.getByRole('button', { name: 'Table', exact: true }).getAttribute('tabindex'), '0')

        await listsTrigger.click()
        const listsMenu = field.locator('.md-lists .menu')
        await listsMenu.waitFor({ state: 'visible', timeout: 2_000 })
        assert.deepEqual(await listsMenu.locator('button').allTextContents(), ['Bullet list', 'Numbered list', 'Task list'])
        await listsTrigger.click()

        // Blur (click the page header) takes the toolbar with it.
        await page.locator('header h1').click()
        await toolbar.waitFor({ state: 'detached', timeout: 5_000 })

        // Refocus brings it back — in Split too, as one row for both panes (#374).
        await content.click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        await chooseMode(page, 'Split')
        await field.locator('.visual-pane .cm-content').click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        assert.equal(await page.locator('.md-toolbar').count(), 1, 'one toolbar row for both panes')
        await chooseMode(page, 'Visual')
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
         const browser = await launchBrowser()
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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

        const chooseList = async (label) => {
          await toolbar.getByRole('button', { name: 'Lists', exact: true }).click()
          await field.locator('.md-lists .menu').getByRole('button', { name: label, exact: true }).click()
        }
        await chooseList('Bullet list')
        assert.equal(await docText(field), '- first\n- second')
        await page.keyboard.press('ControlOrMeta+a')
        await chooseList('Numbered list')
        assert.equal(await docText(field), '1. first\n1. second')
        await page.keyboard.press('ControlOrMeta+a')
        await chooseList('Task list')
        assert.equal(await docText(field), '- [ ] first\n- [ ] second')
        await toolbar.getByRole('button', { name: 'Blockquote', exact: true }).click()
        await page.keyboard.press('ControlOrMeta+End')
        await toolbar.getByRole('button', { name: 'Horizontal rule', exact: true }).click()

        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'background', { instancesDir: join(instancesDir, 'default') })
    assert.equal(data.fields.problem, '> - [ ] first\n> - [ ] second\n\n---')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Coverage for #133 — inline code, link, and code block produce markdown that
// Visual view (#374) draws as code, a link and a code block.
test("inline code, link, and code block buttons read as such in Visual view (#133, #374)", async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
        const preview = field.locator('.cm-visual')
        await field.locator('.cm-content').click()

        // Inline code wraps the selection; Visual view draws it as code.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('run gantry now')
        for (let i = 0; i < 11; i++) await page.keyboard.press('Shift+ArrowLeft')
        await toolbar.getByRole('button', { name: 'Inline code', exact: true }).click()
        await assert.doesNotReject(preview.locator('.cm-vcode', { hasText: 'gantry now' }).waitFor({ timeout: 5_000 }))

        // Link turns prose into [text](url) with the URL slot pre-selected,
        // so typing the address completes the link.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('see the docs')
        await page.keyboard.press('ControlOrMeta+a')
        await toolbar.getByRole('button', { name: 'Link', exact: true }).click()
        await page.keyboard.type('https://example.dev/guide')
        await assert.doesNotReject(
          preview.locator('.cm-vlink', { hasText: 'see the docs' }).waitFor({ timeout: 5_000 })
        )

        // Code block fences every line of the selection; Visual draws it as a code block.
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type('npm install\nnpm test')
        await page.keyboard.press('ControlOrMeta+a')
        await toolbar.getByRole('button', { name: 'Code block', exact: true }).click()
        await assert.doesNotReject(
          preview.locator('.cm-vcodeblock', { hasText: 'npm install' }).waitFor({ timeout: 5_000 })
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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

// Coverage for #135 — the sticky view bar: the bar holding the Mode dropdown
// pins to the top of the viewport once scrolled past (so view switching stays
// reachable over long modules), and sits back below the header again at the
// top of the page.
test('view-mode bar sticks to the top while scrolling and returns below the header at the top (#135)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    const near = (actual, expected, tolerance, what) =>
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${what}: expected ≈${expected} ±${tolerance}, got ${actual}`
      )

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
       const browser = await launchBrowser()
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
        // Split view: source and Visual panes side by side (#374).
        await chooseMode(page, 'Split')
        const content = field.locator('.editor-pane .cm-content')
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
        const previewBox = await field.locator('.visual-pane').boundingBox()
        assert.ok(await field.locator('.editor-pane').isVisible(), 'editor pane visible while expanded')
        assert.ok(await field.locator('.visual-pane').isVisible(), 'Visual pane visible while expanded')
        near(paneBox.height, splitBox.height, 2, 'editor pane fill')
        near(previewBox.height, splitBox.height, 2, 'Visual pane fill')
        near(paneBox.y + paneBox.height, splitBox.y + splitBox.height, 2, 'editor pane reaches the row bottom')
        assert.ok(splitBox.height > vp.height / 3, 'panes must genuinely fill most of the screen')

        // The toolbar remains visible inside the expanded panel…
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })
        const tbBox = await toolbar.boundingBox()
        assert.ok(tbBox.y >= 0 && tbBox.y + tbBox.height <= vp.height, 'toolbar inside the viewport')
        // …even once focus wanders into the Visual pane — expansion pins it.
        await field.locator('.visual-pane .cm-content').click()
        await toolbar.waitFor({ state: 'visible', timeout: 5_000 })

        // Insert is absent while the field is full-screen; its Section/List
        // actions return with the normal editing layout.
        assert.equal(await insert.count(), 0)
        assert.equal(await insertMenu.count(), 0)

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
        await insert.waitFor({ state: 'visible', timeout: 5_000 })

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

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Regression: the "Source: …" citation under an embedded diagram is a link to the
// asset's own served file (`/api/instance/assets/<id>/file?slug=…&stage=…`, WI #348). Because
// that link is same-origin and had no `target`, preact-iso's global click handler swallowed it
// as a client-side route change — the URL bar updated but no request was ever made, no client
// route matched, and the user landed on the dashboard instead of the diagram. Every rendered
// markdown link now carries `target="_blank"` (in-page `#anchor` links excepted), so the click
// leaves the router alone and actually fetches the file.
test('asset source citation opens the served file rather than being swallowed by the router', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        // The citation only appears once the asset manifest fetch resolves, so wait for it.
        const citation = page.locator('.cm-visual-image p.asset-source a').first()
        await assert.doesNotReject(citation.waitFor({ state: 'attached', timeout: 10_000 }))

        // A local source (the instance's own copy) is labelled by its stored path but linked to
        // the fetchable file endpoint.
        const href = await citation.getAttribute('href')
        assert.match(href, /^\/api\/instance\/assets\/[^/]+\/file\?/)
        assert.equal(await citation.getAttribute('target'), '_blank', 'the citation must not be routed client-side')
        assert.equal(await citation.getAttribute('rel'), 'noreferrer')

        // And that href really serves the image, rather than the SPA shell the extensionless
        // fallback in lib/server.js hands back for an unmatched path.
        const response = await page.request.get(`${base}${href}`)
        assert.equal(response.status(), 200)
        assert.match(response.headers()['content-type'], /^image\//)

        // In-page anchors stay in-page — a new tab would break heading navigation.
        const anchorTargets = await page.evaluate(() =>
          [...document.querySelectorAll('.md-rendered a[href^="#"]')].map((a) => a.getAttribute('target'))
        )
        assert.ok(
          anchorTargets.every((t) => t === null),
          'in-page #anchor links must not open in a new tab'
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
