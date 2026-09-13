import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Coverage for WI #376 — the centralised Save: one disk button for the whole stage, blue only while
// something differs from what's saved, Ctrl/Cmd+S, and Save / Discard / Cancel before leaving the
// stage or running Render / Advance. Assertions are about what the author sees and what lands on
// disk. The dirty rule itself is covered under node --test in tests/stageSave.test.js.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'

async function withEditor(fn, { beforeLoad } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) pageErrors.push(msg.text())
        })
        const saves = []
        page.on('request', (req) => {
          if (req.method() === 'PUT' && /\/api\/instance\/modules/.test(req.url())) saves.push(req.url())
        })
        if (beforeLoad) await beforeLoad(page, base)
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        const moduleFile = (id) => join(instancesDir, 'default', 'examples', 'modules', `${id}.md`)
        await fn({ page, base, pageErrors, saves, moduleFile })
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

async function eventually(fn, timeout = 5000) {
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

const saveButton = (page) => page.locator('.toolbar .stage-save-btn')
const unsavedDialog = (page) => page.locator('.modal[aria-label="Unsaved changes"]')
const problemEditor = (page) => page.locator('.module').first().locator('.field-markdown').first().locator('.cm-content')

async function expectSaveButton(page, state) {
  await eventually(async () => {
    const button = saveButton(page)
    const cls = (await button.getAttribute('class')) ?? ''
    if (state === 'blue') {
      assert.match(cls, /\bprimary\b/)
      assert.equal(await button.isDisabled(), false)
    } else {
      assert.doesNotMatch(cls, /\bprimary\b/)
      assert.equal(await button.isDisabled(), true)
    }
  })
}

async function typeInProblem(page, text) {
  await problemEditor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

test('the Save button sits beside Mode, is ghosted until something changes, and ghosts again after undoing back', async () => {
  await withEditor(async ({ page, pageErrors }) => {
    const toolbarLeft = page.locator('.toolbar-left')
    assert.equal(await toolbarLeft.locator('> *').first().locator('.stage-save-btn').count(), 1, 'Save comes first, left of the Mode dropdown')
    assert.equal(await saveButton(page).getAttribute('aria-label'), 'Save')
    // Level with Mode, Artefact and Navigation, and spaced like the toolbar's other controls (WI #377, #378).
    const save = await saveButton(page).boundingBox()
    const fields = page.locator('.toolbar-left > .toolbar-field')
    const modeField = await fields.nth(0).boundingBox()
    const artefactField = await fields.nth(1).boundingBox()
    for (const selector of ['.view-mode-dropdown button', '.artefact-dropdown > button', '.stage-navigation button']) {
      const control = await page.locator(selector).first().boundingBox()
      assert.ok(Math.abs(save.y - control.y) <= 1 && Math.abs(save.height - control.height) <= 1, `Save lines up with ${selector}`)
    }
    assert.ok(Math.abs((modeField.x - (save.x + save.width)) - (artefactField.x - (modeField.x + modeField.width))) <= 1, 'Save sits one toolbar gap from Mode')
    await expectSaveButton(page, 'ghost')
    assert.match(await saveButton(page).getAttribute('title'), /nothing to save/)

    await typeInProblem(page, 'X')
    await expectSaveButton(page, 'blue')
    assert.match(await saveButton(page).getAttribute('title'), /1 module with changes/)

    await page.keyboard.press('ControlOrMeta+z')
    await expectSaveButton(page, 'ghost')
    assert.deepEqual(pageErrors, [])
  })
})

test('Save writes only the changed modules, updates each card\'s status line, and Ctrl/Cmd+S is a no-op when clean', async () => {
  await withEditor(async ({ page, pageErrors, saves, moduleFile }) => {
    const untouched = readFileSync(moduleFile('introduction'), 'utf8')

    await typeInProblem(page, ' Saved centrally.')
    await expectSaveButton(page, 'blue')
    await page.keyboard.press('ControlOrMeta+s')
    await page.locator('.stage-save-state', { hasText: 'Saved' }).waitFor({ timeout: 5_000 })
    await expectSaveButton(page, 'ghost')

    assert.match(readFileSync(moduleFile('background'), 'utf8'), /Saved centrally\./)
    assert.equal(readFileSync(moduleFile('introduction'), 'utf8'), untouched, 'an unchanged module is not rewritten')
    assert.equal(saves.length, 1)
    assert.match(await page.locator('.module').first().locator('.save-status').textContent(), /^Saved — /)

    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForTimeout(300)
    assert.equal(saves.length, 1, 'nothing to save, so no request')
    assert.deepEqual(pageErrors, [])
  })
})

test('inserted sections, list rows and Clear all fields all count as unsaved changes', async () => {
  await withEditor(async ({ page }) => {
    const firstModule = page.locator('.module').first()
    const listField = firstModule.locator('.field-list').first()
    await listField.locator('textarea').first().fill('A brand new domain')
    await expectSaveButton(page, 'blue')
    await page.keyboard.press('ControlOrMeta+s')
    await expectSaveButton(page, 'ghost')

    const insert = firstModule.locator('.field-markdown').first().getByRole('button', { name: 'Insert ▾' })
    await problemEditor(page).click()
    await insert.click()
    await page.getByRole('menuitem', { name: 'Section' }).click()
    const sectionDialog = page.locator('.modal[aria-label="New section"]')
    await sectionDialog.locator('input[type=text]').fill('Risks')
    await sectionDialog.getByRole('button', { name: 'Insert section' }).click()
    await expectSaveButton(page, 'blue')
    await page.keyboard.press('ControlOrMeta+s')
    await expectSaveButton(page, 'ghost')

    await page.getByRole('button', { name: 'Clear all fields' }).click()
    await expectSaveButton(page, 'blue')
  })
})

test('a failed Save stays blue and says what failed', async () => {
  await withEditor(async ({ page }) => {
    await page.route('**/api/instance/modules?**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk is full' }) })
    )
    await typeInProblem(page, ' will fail')
    await saveButton(page).click()
    await page.locator('.stage-save-state.error', { hasText: 'Save failed: disk is full' }).waitFor({ timeout: 5_000 })
    await expectSaveButton(page, 'blue')

    await page.unroute('**/api/instance/modules?**')
    await saveButton(page).click()
    await expectSaveButton(page, 'ghost')
  })
})

test('switching stage with unsaved changes asks: Cancel stays, Discard drops the edit, Save saves then goes', async () => {
  await withEditor(async ({ page, moduleFile }) => {
    const stageButton = (name) => page.locator('#stage-nav button', { hasText: name })

    await typeInProblem(page, ' Kept by cancel.')
    await stageButton('Detailed Design').click()
    await unsavedDialog(page).getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await unsavedDialog(page).count(), 0)
    assert.match(await problemEditor(page).textContent(), /Kept by cancel\./)
    await expectSaveButton(page, 'blue')

    await stageButton('Detailed Design').click()
    await unsavedDialog(page).getByRole('button', { name: 'Discard' }).click()
    await eventually(async () => assert.match(await stageButton('Detailed Design').getAttribute('class'), /\bactive\b/))
    await stageButton('SOAP').click()
    await page.waitForSelector('.module', { timeout: 10_000 })
    await eventually(async () => assert.doesNotMatch(await problemEditor(page).textContent(), /Kept by cancel/))
    assert.doesNotMatch(readFileSync(moduleFile('background'), 'utf8'), /Kept by cancel/)

    await typeInProblem(page, ' Saved on the way out.')
    await stageButton('Detailed Design').click()
    await unsavedDialog(page).getByRole('button', { name: 'Save' }).click()
    await eventually(async () => assert.match(await stageButton('Detailed Design').getAttribute('class'), /\bactive\b/))
    assert.match(readFileSync(moduleFile('background'), 'utf8'), /Saved on the way out\./)
  })
})

test('in-app links and browser back ask before leaving; the Artefact selector and Mode do not', async () => {
  await withEditor(async ({ page, base }) => {
    await typeInProblem(page, ' Unsaved.')
    await expectSaveButton(page, 'blue')

    // Changing what's shown is not leaving.
    await page.locator('.view-mode-dropdown').getByRole('button', { name: /^Mode/ }).click()
    await page.getByRole('menuitemradio', { name: 'Markdown', exact: true }).click()
    const artefact = page.locator('.artefact-dropdown').getByRole('button', { name: /^Artefact/ })
    await artefact.click()
    await page.getByRole('menuitemradio', { name: 'Full Solution on a Page', exact: true }).click()
    await artefact.click()
    await page.getByRole('menuitemradio', { name: 'Solution on a Page', exact: true }).click()
    assert.equal(await unsavedDialog(page).count(), 0)

    await page.getByRole('link', { name: '← Workspaces' }).click()
    await unsavedDialog(page).waitFor({ timeout: 5_000 })
    await unsavedDialog(page).getByRole('button', { name: 'Cancel' }).click()
    assert.equal(new URL(page.url()).pathname, '/instance/examples')

    await page.getByRole('link', { name: 'User Guide' }).click()
    await unsavedDialog(page).getByRole('button', { name: 'Discard' }).click()
    await eventually(async () => assert.equal(new URL(page.url()).pathname, '/user-guide'))

    // Browser Back asks too. Arrive in the editor through an in-app link, so Back is a
    // same-page history step rather than a page load.
    await page.goto(`${base}/user-guide`)
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.href = '/instance/examples'
      link.textContent = 'Open the editor'
      document.body.prepend(link)
    })
    await page.getByRole('link', { name: 'Open the editor' }).click()
    await page.waitForSelector('.module', { timeout: 10_000 })
    await typeInProblem(page, ' Unsaved again.')
    await expectSaveButton(page, 'blue')
    await page.evaluate(() => history.back())
    await unsavedDialog(page).waitFor({ timeout: 5_000 })
    await unsavedDialog(page).getByRole('button', { name: 'Cancel' }).click()
    assert.equal(new URL(page.url()).pathname, '/instance/examples')
    assert.match(await problemEditor(page).textContent(), /Unsaved again\./)
  })
})

test('Render and Advance ask to save first; the tab-close warning is armed only while unsaved', async () => {
  await withEditor(async ({ page, moduleFile }) => {
    const beforeUnloadArmed = () =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })
    assert.equal(await beforeUnloadArmed(), false)

    await typeInProblem(page, ' Before render.')
    await expectSaveButton(page, 'blue')
    assert.equal(await beforeUnloadArmed(), true)

    await page.getByRole('button', { name: 'Render', exact: true }).click()
    await unsavedDialog(page).getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await page.locator('.modal[aria-label="Render an artefact"]').count(), 0)

    await page.getByRole('button', { name: 'Render', exact: true }).click()
    await unsavedDialog(page).getByRole('button', { name: 'Save' }).click()
    await page.locator('.modal[aria-label="Render an artefact"]').waitFor({ timeout: 5_000 })
    assert.match(readFileSync(moduleFile('background'), 'utf8'), /Before render\./)
    assert.equal(await beforeUnloadArmed(), false)
    await page.keyboard.press('Escape')

    await typeInProblem(page, ' Before advance.')
    await page.locator('.advance-stage-panel').getByRole('button', { name: 'Advance to next stage' }).click()
    await unsavedDialog(page).waitFor({ timeout: 5_000 })
    await unsavedDialog(page).getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await page.locator('.advance-stage-panel .save-status').textContent(), '')
  })
})

test('an archived instance has no Save button', async () => {
  await withEditor(
    async ({ page }) => {
      await page.waitForSelector('.archived-banner', { timeout: 10_000 })
      assert.equal(await page.locator('.stage-save-btn').count(), 0)
    },
    {
      beforeLoad: async (page, base) => {
        const res = await page.request.post(`${base}/api/instance/archive`, { data: { slug: 'examples' } })
        assert.equal(res.status(), 200)
      },
    }
  )
})

test('Mode, Artefact and Navigation open the same kind of menu at one font size, and only one is open at a time (WI #379)', async () => {
  await withEditor(async ({ page, pageErrors }) => {
    const triggers = {
      Mode: page.locator('.view-mode-dropdown > button'),
      Artefact: page.locator('.artefact-dropdown > button'),
      Navigation: page.locator('.stage-navigation-dropdown > button'),
    }
    const css = (locator, prop) => locator.evaluate((el, p) => getComputedStyle(el)[p], prop)
    const openMenus = page.locator('.toolbar .menu')
    const triggerSizes = new Set()
    const itemSizes = new Set()

    for (const [name, trigger] of Object.entries(triggers)) {
      triggerSizes.add(await css(trigger, 'fontSize'))
      await trigger.click()
      await eventually(async () => assert.equal(await openMenus.count(), 1, `opening ${name} leaves only ${name} open`))
      const button = await trigger.boundingBox()
      const menu = await openMenus.first().boundingBox()
      assert.ok(menu.y - (button.y + button.height) >= 4, `${name}'s menu opens below its button with a gap`)
      itemSizes.add(await css(openMenus.first().locator('.nav-item').first(), 'fontSize'))
    }
    assert.equal(triggerSizes.size, 1, `one button font size, got ${[...triggerSizes]}`)
    assert.equal(itemSizes.size, 1, `one menu font size, got ${[...itemSizes]}`)

    // Navigation is open from the loop; opening Mode closes it.
    await triggers.Mode.click()
    await eventually(async () => {
      assert.equal(await openMenus.count(), 1)
      assert.equal(await page.locator('.stage-navigation-dropdown .menu').count(), 0)
    })
    await page.keyboard.press('Escape')
    await eventually(async () => assert.equal(await openMenus.count(), 0))
    assert.deepEqual(pageErrors, [])
  })
})
