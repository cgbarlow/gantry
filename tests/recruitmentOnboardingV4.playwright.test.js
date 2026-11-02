import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #309: the Definitions page shows the bundled recruitment-onboarding v4 as published, with Glossary
// and Open questions marked Gantry-provided and its Interview instructions read-only. v4 is the only
// version in the scratch Definitions directory, so the page opens on it.

async function withV4Server(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-309-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-309-browser-'))
  try {
    cpSync('definitions/recruitment-onboarding/4', join(definitionsDir, 'recruitment-onboarding', '4'), { recursive: true })
    await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, fn)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('Definitions page: recruitment-onboarding v4 is published, mounts Glossary and Open questions as Gantry-provided, and shows its Interview instructions read-only', () =>
  withV4Server(async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      assert.equal(await page.getByLabel('Mount a standard module').count(), 0, 'a published version cannot mount more')

      const group = page.locator('[data-testid="standard-modules-group"]')
      assert.match(await group.locator('.kicker').first().textContent(), /Standard modules · 2/)
      const focus = page.locator('[data-testid="standard-module-focus"]')

      await group.locator('.defn-outline-node', { hasText: 'Glossary' }).click()
      assert.match(await focus.locator('.defn-provided-badge').textContent(), /Gantry-provided/)
      assert.match(await focus.locator('[data-testid="standard-module-version"]').textContent(), /Version 1/)
      assert.match(await focus.locator('[data-testid="standard-module-field"]').first().textContent(), /Terms and definitions/)
      assert.match(await focus.locator('[data-testid="standard-module-interview"]').textContent(), /Glossary row/)

      await group.locator('.defn-outline-node', { hasText: 'Open questions' }).click()
      assert.match(await focus.locator('.defn-provided-badge').textContent(), /Gantry-provided/)
      assert.match(await focus.locator('[data-testid="standard-module-added-guidance"]').textContent(), /real and common outcome/)
      assert.equal(await group.locator('.defn-outline-node', { hasText: 'Key decisions' }).count(), 0)

      // The Definition's own Interview instructions are there, and read-only on a published version.
      await page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' }).click()
      assert.match(await page.locator('.defn-definition-interview').textContent(), /HR personal data/)
      assert.equal(await page.locator('.defn-definition-interview textarea').count(), 0)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }))
