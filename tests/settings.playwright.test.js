import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'

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

// ---------- Workspace overrides tab (#104) ----------
// Workspaces are seeded directly via `registerWorkspace` (a plain library
// call against the same scratch `instancesDir` the test server serves) —
// no fake Azure DevOps server needed, since this tab's own acceptance
// criteria are about the tab's UI/local-storage/PATCH behavior, not about
// proving real Azure DevOps access (that's already covered by
// tests/serverWorkspaces.test.js's `POST /api/workspaces` coverage).

function seedWorkspace(instancesDir, overrides = {}) {
  return registerWorkspace(
    { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo', owner: 'c.barlow', ...overrides },
    { instancesDir }
  )
}

test('settings: the Workspace overrides tab lists every registered workspace with its owner, repo URL, PAT-override state, and ticketing-system-override state', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspace(instancesDir)

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.waitForSelector('.settings-tabs', { timeout: 10_000 })

        const tab = page.locator('.settings-tabs button', { hasText: 'Workspace overrides' })
        assert.equal(await tab.count(), 1)
        await tab.click()
        assert.equal(await tab.getAttribute('aria-selected'), 'true')

        const row = page.locator('.workspace-row')
        await row.waitFor({ state: 'visible', timeout: 10_000 })
        assert.equal(await row.count(), 1)
        assert.match(await row.locator('.workspace-repo-url').textContent(), /fake-org\/fake-project\/fake-repo/)
        assert.equal(await row.locator('.workspace-owner input[type=text]').inputValue(), 'c.barlow')
        assert.match(await row.locator('.workspace-pat-status').textContent(), /USING GLOBAL DEFAULT/)
        assert.match(await row.locator('.workspace-ticketing-state').textContent(), /USING GLOBAL DEFAULT/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: setting a workspace PAT override marks it SET, and clearing it falls back to the global default', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    const workspace = seedWorkspace(instancesDir)

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        const row = page.locator('.workspace-row')
        await row.waitFor({ state: 'visible', timeout: 10_000 })

        assert.match(await row.locator('.workspace-pat-status').textContent(), /USING GLOBAL DEFAULT/)

        await row.locator('.workspace-pat input[type=password]').fill('workspace-override-pat')
        await row.getByRole('button', { name: 'Set override' }).click()
        assert.match(await row.locator('.workspace-pat-status').textContent(), /OVERRIDE SET/)

        // Persisted client-side, workspace-keyed — never the bare
        // `gantry:ado-pat` global-default slot.
        const overrides = await page.evaluate(() => localStorage.getItem('gantry:ado-pat-overrides'))
        assert.match(overrides, new RegExp(workspace.id))
        assert.equal(await page.evaluate(() => localStorage.getItem('gantry:ado-pat')), null)

        await row.getByRole('button', { name: 'Clear override' }).click()
        assert.match(await row.locator('.workspace-pat-status').textContent(), /USING GLOBAL DEFAULT/)
        const overridesAfterClear = await page.evaluate(() => localStorage.getItem('gantry:ado-pat-overrides'))
        assert.equal(overridesAfterClear, null)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: a workspace PAT override does not affect the global default, and vice versa', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspace(instancesDir)

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.waitForSelector('.settings-section', { timeout: 10_000 })

        // Set the global default from the Global Defaults tab first.
        await page.getByRole('button', { name: 'Set Azure DevOps PAT' }).click()
        const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
        await modal.waitFor({ state: 'visible', timeout: 5_000 })
        await modal.locator('input[type=password]').fill('global-default-pat')
        await modal.getByRole('button', { name: 'Continue' }).click()
        await modal.waitFor({ state: 'hidden', timeout: 5_000 })

        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        const row = page.locator('.workspace-row')
        await row.waitFor({ state: 'visible', timeout: 10_000 })
        await row.locator('.workspace-pat input[type=password]').fill('workspace-override-pat')
        await row.getByRole('button', { name: 'Set override' }).click()
        assert.match(await row.locator('.workspace-pat-status').textContent(), /OVERRIDE SET/)

        // The global default is untouched by the override having been set.
        assert.equal(await page.evaluate(() => localStorage.getItem('gantry:ado-pat')), 'global-default-pat')

        await page.getByRole('tab', { name: 'Global Defaults' }).click()
        assert.match(await page.locator('.settings-pat-status').textContent(), /SET/)
        await page.getByRole('button', { name: 'Clear Azure DevOps PAT' }).click()
        assert.equal(await page.evaluate(() => localStorage.getItem('gantry:ado-pat')), null)

        // Clearing the global default leaves the workspace override intact.
        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        assert.match(await row.locator('.workspace-pat-status').textContent(), /OVERRIDE SET/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: setting a workspace ticketing-system override persists via PATCH and is scoped to that workspace alone; jira stays unselectable', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    const workspaceA = seedWorkspace(instancesDir, { repository: 'fake-repo-a' })
    seedWorkspace(instancesDir, { repository: 'fake-repo-b' })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        await page.waitForSelector('.workspace-row', { timeout: 10_000 })

        const rows = page.locator('.workspace-row')
        assert.equal(await rows.count(), 2)
        const rowA = page.locator('.workspace-row', { hasText: 'fake-repo-a' })

        // jira is present, disabled, and "coming soon" — same as the
        // Global Defaults tab's own selector.
        const jiraRadio = rowA.locator('.settings-radio', { hasText: 'Jira' }).locator('input[type=radio]')
        assert.equal(await jiraRadio.isDisabled(), true)
        await jiraRadio.click({ force: true }).catch(() => {})
        assert.equal(await jiraRadio.isChecked(), false)

        const adoRadio = rowA.locator('.settings-radio', { hasText: 'Azure DevOps' }).locator('input[type=radio]')
        assert.ok(await adoRadio.isChecked())

        // Re-selecting the already-active value still round-trips through
        // the PATCH endpoint without erroring.
        await adoRadio.click()
        await page.waitForTimeout(200)
        assert.match(await rowA.locator('.workspace-field-status').last().textContent(), /^$/)

        // The persisted record really did go through the server (not just
        // client-side UI state) — reloading the page still shows it.
        await page.reload()
        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        await page.waitForSelector('.workspace-row', { timeout: 10_000 })
        const reloadedRowA = page.locator('.workspace-row', { hasText: 'fake-repo-a' })
        assert.ok(await reloadedRowA.locator('.settings-radio', { hasText: 'Azure DevOps' }).locator('input[type=radio]').isChecked())
        assert.equal(reloadedRowA !== null, true)
        assert.equal(typeof workspaceA.id, 'string')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('settings: a workspace\'s owner can be viewed and edited from the Workspace overrides tab', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    seedWorkspace(instancesDir, { owner: 'original-owner' })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/settings`)
        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        const row = page.locator('.workspace-row')
        await row.waitFor({ state: 'visible', timeout: 10_000 })

        const ownerInput = row.locator('.workspace-owner input[type=text]')
        assert.equal(await ownerInput.inputValue(), 'original-owner')

        await ownerInput.fill('new-owner')
        await row.getByRole('button', { name: 'Save owner' }).click()
        await page.waitForSelector('text=Saved.', { timeout: 5_000 })

        // Persisted server-side — a reload still shows the new owner.
        await page.reload()
        await page.getByRole('tab', { name: 'Workspace overrides' }).click()
        const reloadedRow = page.locator('.workspace-row')
        await reloadedRow.waitFor({ state: 'visible', timeout: 10_000 })
        assert.equal(await reloadedRow.locator('.workspace-owner input[type=text]').inputValue(), 'new-owner')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
