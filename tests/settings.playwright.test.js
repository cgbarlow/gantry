import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'

// Browser smoke test for the new top-level Settings screen (#101): a
// tabbed shell at `/settings` whose only tab today is Global Defaults —
// global Azure DevOps PAT management (moved off the per-instance editor
// header entirely; see tests/patPrompt.playwright.test.js for the
// corresponding "no PAT buttons in the editor header" coverage and the
// replace/clear flows exercised from this new screen) and a global
// ticketing-system default selector (`azure-devops` working, `jira`
// visibly disabled as "coming soon"). Mirrors
// tests/dashboard.playwright.test.js's pattern: a real server, a real
// Chromium page, asserting no console/page errors alongside the ticket's
// acceptance criteria.
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

function withPage(fn) {
  return async (base) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await fn(page, base)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }
}

test('settings: /settings shows a tabbed screen with a working Global Defaults tab', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.waitForSelector('.settings-tabs', { timeout: 10_000 })

        assert.equal(await page.locator('.settings-header h1').textContent(), 'Settings')
        const tab = page.locator('.settings-tabs button', { hasText: 'Global Defaults' })
        assert.equal(await tab.count(), 1)
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
        assert.ok(await page.locator('.settings-section', { hasText: 'Azure DevOps Personal Access Token' }).isVisible())
        assert.ok(await page.locator('.settings-section', { hasText: 'Default ticketing system' }).isVisible())
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: the default PAT can be set, replaced, and cleared from the Global Defaults tab', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.waitForSelector('.settings-section', { timeout: 10_000 })

        // No PAT stored yet: a "Set" action, not "Replace"/"Clear".
        assert.match(await page.locator('.settings-pat-status').textContent(), /NOT SET/)
        assert.equal(await page.getByRole('button', { name: 'Set Azure DevOps PAT' }).count(), 1)
        assert.equal(await page.getByRole('button', { name: 'Replace Azure DevOps PAT' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Clear Azure DevOps PAT' }).count(), 0)

        await page.getByRole('button', { name: 'Set Azure DevOps PAT' }).click()
        const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
        await modal.waitFor({ state: 'visible', timeout: 5_000 })
        await modal.locator('input[type=password]').fill('a-fresh-pat')
        await modal.getByRole('button', { name: 'Continue' }).click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })

        assert.match(await page.locator('.settings-pat-status').textContent(), /SET/)
        assert.equal(await page.evaluate(() => localStorage.getItem('gantry:ado-pat')), 'a-fresh-pat')
        assert.equal(await page.getByRole('button', { name: 'Set Azure DevOps PAT' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Replace Azure DevOps PAT' }).count(), 1)

        await page.getByRole('button', { name: 'Clear Azure DevOps PAT' }).click()
        assert.equal(await page.evaluate(() => localStorage.getItem('gantry:ado-pat')), null)
        assert.match(await page.locator('.settings-pat-status').textContent(), /NOT SET/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: a global ticketing-system default can be set to azure-devops; jira is disabled with a "coming soon" indication', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.waitForSelector('.settings-radio-group', { timeout: 10_000 })

        const adoRadio = page.locator('.settings-radio', { hasText: 'Azure DevOps' }).locator('input[type=radio]')
        const jiraRow = page.locator('.settings-radio', { hasText: 'Jira' })
        const jiraRadio = jiraRow.locator('input[type=radio]')

        // azure-devops is the default and is selectable/working.
        assert.ok(await adoRadio.isChecked())
        assert.equal(await adoRadio.isDisabled(), false)

        // jira is visibly present, disabled, and flagged "coming soon".
        assert.equal(await jiraRadio.isDisabled(), true)
        assert.match(await jiraRow.textContent(), /Coming soon/)

        // Clicking the disabled jira control changes nothing.
        await jiraRadio.click({ force: true }).catch(() => {})
        assert.ok(await adoRadio.isChecked())
        assert.equal(await jiraRadio.isChecked(), false)
        assert.equal(await page.evaluate(() => localStorage.getItem('gantry:default-ticketing-system')), 'azure-devops')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: the "Settings" link is reachable from the dashboard', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
        await page.getByRole('link', { name: 'Settings' }).click()
        await page.waitForSelector('.settings-tabs', { timeout: 10_000 })
        assert.equal(new URL(page.url()).pathname, '/settings')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
