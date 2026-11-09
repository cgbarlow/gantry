import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { designV3Examples } from './helpers/designExamples.js'

// #308: design v3 in the browser. The Definitions page shows it as published, with Glossary, Open questions and
// Key decisions marked Gantry-provided (Key decisions with the AD prefix and the WH(Y) style), its Interview
// instructions read-only and the Sources appendix ticked on each Artefact; and the Stage editor shows the
// bundled example's Key decisions as numbered WH(Y) cards. v3 is the only version in the scratch Definitions
// directory, so the page opens on it.

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

async function withV3Server(fn) {
  const root = mkdtempSync(join(tmpdir(), 'design-308-browser-'))
  try {
    const definitionsDir = join(root, 'definitions')
    const instancesDir = join(root, 'instances')
    cpSync('definitions/design/3', join(definitionsDir, 'design', '3'), { recursive: true })
    // #359: the bundled examples are on v4, so this v3-only server reads them as they were on v3.
    cpSync(designV3Examples(), join(instancesDir, 'examples'), { recursive: true })
    await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, fn)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Definitions page: design v3 mounts the three standard modules as Gantry-provided, with Key decisions as AD and WH(Y)', () =>
  withV3Server((base) => withPage(async (page) => {
    await page.goto(`${base}/definitions`)
    await page.waitForSelector('.defn-outline', { timeout: 10_000 })
    assert.equal(await page.getByLabel('Mount a standard module').count(), 0, 'a published version cannot mount more')

    const group = page.locator('[data-testid="standard-modules-group"]')
    assert.match(await group.locator('.kicker').first().textContent(), /Standard modules · 3/)
    const focus = page.locator('[data-testid="standard-module-focus"]')

    await group.locator('.defn-outline-node', { hasText: 'Glossary' }).click()
    assert.match(await focus.locator('.defn-provided-badge').textContent(), /Gantry-provided/)
    assert.match(await focus.locator('[data-testid="standard-module-field"]').first().textContent(), /Terms and definitions/)
    assert.match(await focus.locator('[data-testid="standard-module-added-guidance"]').textContent(), /Contracted name/)
    assert.match(await focus.locator('[data-testid="standard-module-interview"]').textContent(), /Glossary row/)

    await group.locator('.defn-outline-node', { hasText: 'Open questions' }).click()
    assert.match(await focus.locator('[data-testid="standard-module-added-guidance"]').textContent(), /Full SOAP/)

    await group.locator('.defn-outline-node', { hasText: 'Key decisions' }).click()
    assert.match(await focus.locator('.defn-provided-badge').textContent(), /Gantry-provided/)
    const settings = page.locator('[data-testid="key-decisions-settings"]')
    assert.equal((await settings.locator('[data-testid="key-decisions-prefix"]').textContent()).trim(), 'AD')
    assert.equal((await settings.locator('[data-testid="key-decisions-style"]').textContent()).trim(), 'WH(Y)')
    assert.match(await focus.locator('[data-testid="standard-module-added-guidance"]').textContent(), /ADRYYY/)
    assert.match(await focus.locator('[data-testid="standard-module-interview"]').textContent(), /ADR candidate/)
    // Used on Detailed Design and Operational Handover, and by the SAD and As-built.
    const chips = await focus.locator('.defn-chip').allTextContents()
    assert.ok(chips.some((c) => /Detailed Design/.test(c)) && chips.some((c) => /Operational Handover/.test(c)), chips.join(' | '))
  })))

test('Definitions page: design v3 shows its Interview instructions read-only, and the Sources appendix ticked on an Artefact', () =>
  withV3Server((base) => withPage(async (page) => {
    await page.goto(`${base}/definitions`)
    await page.waitForSelector('.defn-outline', { timeout: 10_000 })

    await page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' }).click()
    assert.match(await page.locator('.defn-definition-interview').textContent(), /New Zealand spelling/)
    assert.equal(await page.locator('.defn-definition-interview textarea').count(), 0)

    await page.locator('.defn-outline-node', { hasText: 'Solution Architecture Document' }).first().click()
    const appendix = page.locator('.defn-source-appendix input[type="checkbox"]')
    await appendix.waitFor({ state: 'visible' })
    assert.equal(await appendix.isChecked(), true)
    assert.equal(await appendix.isDisabled(), true, 'read-only on a published version')
  })))

test('Stage editor: the example\'s Key decisions are numbered WH(Y) cards with their links, in the order written', () =>
  withV3Server((base) => withPage(async (page) => {
    await page.goto(`${base}/instance/kiwi-cover-mutual`)
    await page.getByText('Detailed Design', { exact: true }).first().click()
    const field = page.locator('[data-testid="key-decisions-field"]')
    await field.waitFor({ state: 'visible' })
    assert.equal(await field.getAttribute('data-style'), 'why')
    assert.equal(await field.getAttribute('data-prefix'), 'AD')
    assert.match(await field.locator('[data-testid="decision-style"]').textContent(), /Decision style: WH\(Y\)/)
    const cards = field.locator('[data-testid="decision"]')
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD01', 'AD02', 'AD03', 'AD04', 'AD05', 'AD06', 'AD07', 'AD08'])
    assert.equal(await field.getByLabel('Title of AD01').inputValue(), 'Shared services, not point-to-point (ADR031)')
    assert.equal(await cards.first().locator('textarea').count(), 6, 'the six parts of a WH(Y) decision')
    assert.equal(await cards.nth(1).locator('[data-testid="decision-link"]').count(), 1, 'AD02 relates to AD01')
  })))
