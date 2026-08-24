import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance, recordInstanceWorkItemLink } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'

// Browser smoke tests for the reworked Settings screens (#107): three separate, tab-free top-level routes — `/settings` (Global Settings), `/settings/workspace` (Workspace Settings, scoped to one instance's own workspace) and `/settings/instance` (Instance Settings) — replacing #101/#104's single tabbed `/settings` shell entirely. Mirrors tests/dashboard.playwright.test.js's pattern: a real server, a real Chromium page, asserting no console/page errors alongside the ticket's acceptance criteria.
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

function withScratchServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir }, (base) => fn(base, instancesDir)).finally(() =>
    rmSync(instancesDir, { recursive: true, force: true })
  )
}

// A local `examples`-backed server (no PAT ever required) — used for every
// test that needs a real instance screen to open Settings from.
function withExamplesServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    return withRunningServer({ slug: 'examples', instancesDir }, (base) => fn(base, instancesDir)).finally(() =>
      rmSync(instancesDir, { recursive: true, force: true })
    )
  } catch (err) {
    rmSync(instancesDir, { recursive: true, force: true })
    throw err
  }
}

// ---------- No tabs anywhere ----------

test('settings: none of the three Settings screens render a tab strip', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      for (const path of ['/settings', '/settings/workspace', '/settings/instance']) {
        await page.goto(`${base}${path}`)
        await page.waitForSelector('.settings-header', { timeout: 10_000 })
        assert.equal(await page.locator('.settings-tabs').count(), 0, `${path} must not render a tab strip`)
      }
    })(base)
  })
})

// ---------- Global Settings, reached directly from Home ----------

test('settings: "Settings" from the dashboard goes straight to Global Settings, no intermediate step', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(base)
      await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/settings')
      assert.equal(await page.locator('.settings-header h1').textContent(), 'Settings')
      assert.ok(await page.locator('.settings-section', { hasText: 'Azure DevOps Personal Access Token' }).isVisible())
      assert.ok(await page.locator('.settings-section', { hasText: 'Default ticketing system' }).isVisible())
    })(base)
  })
})

test('settings: Global Settings\' back control returns Home when opened with no explicit origin', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      await page.getByRole('link', { name: '← Back' }).click()
      await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/')
    })(base)
  })
})

test('settings: the default PAT can be set, replaced, and cleared from Global Settings', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })

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
    })(base)
  })
})

test('settings: a global ticketing-system default can be set to azure-devops; jira is disabled with a "coming soon" indication', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-radio-group', { timeout: 10_000 })

      const adoRadio = page.locator('.settings-radio', { hasText: 'Azure DevOps' }).locator('input[type=radio]')
      const jiraRow = page.locator('.settings-radio', { hasText: 'Jira' })
      const jiraRadio = jiraRow.locator('input[type=radio]')

      assert.ok(await adoRadio.isChecked())
      assert.equal(await adoRadio.isDisabled(), false)

      assert.equal(await jiraRadio.isDisabled(), true)
      assert.match(await jiraRow.textContent(), /Coming soon/)

      await jiraRadio.click({ force: true }).catch(() => {})
      assert.ok(await adoRadio.isChecked())
      assert.equal(await jiraRadio.isChecked(), false)
      assert.equal(await page.evaluate(() => localStorage.getItem('gantry:default-ticketing-system')), 'azure-devops')
    })(base)
  })
})

// ---------- From an instance screen: the Settings dropdown ----------

test('settings: from an instance screen, "Settings" opens a dropdown offering Global/Workspace/Instance Settings, each carrying this instance as explicit back-origin', async () => {
  await withExamplesServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/instance/examples`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      // Not a plain link straight to /settings any more — a dropdown.
      const settingsButton = page.getByRole('button', { name: 'Settings' })
      assert.equal(await settingsButton.count(), 1)
      assert.equal(await page.locator('a', { hasText: 'Settings' }).count(), 0)

      await settingsButton.click()
      const menu = page.locator('.settings-menu .menu')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await menu.locator('a', { hasText: 'Global Settings' }).count(), 1)
      assert.equal(await menu.locator('a', { hasText: 'Workspace Settings' }).count(), 1)
      assert.equal(await menu.locator('a', { hasText: 'Instance Settings' }).count(), 1)

      // Global Settings: opened from this instance, so its back control
      // returns to this exact instance screen, not Home.
      await menu.locator('a', { hasText: 'Global Settings' }).click()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/settings')
      assert.equal(await page.locator('.settings-tabs').count(), 0)
      await page.getByRole('link', { name: '← Back' }).click()
      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/instance/examples')

      // Instance Settings: same explicit-origin back behavior.
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.locator('.settings-menu .menu a', { hasText: 'Instance Settings' }).click()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/settings/instance')
      assert.equal(new URL(page.url()).searchParams.get('slug'), 'examples')
      await page.getByRole('link', { name: '← Back' }).click()
      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/instance/examples')
    })(base)
  })
})

// ---------- Workspace Settings: scoped to one instance's own workspace ----------
// Workspaces are seeded directly via `registerWorkspace` (a plain library call against the same scratch `instancesDir` the test server serves) — no fake Azure DevOps server needed, since this screen's own acceptance criteria are about its UI/local-storage/PATCH behavior, not about proving real Azure DevOps access (that's already covered by tests/serverWorkspaces.test.js's `POST /api/workspaces` coverage).

function seedWorkspace(instancesDir, overrides = {}) {
  return registerWorkspace(
    { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo', owner: 'c.barlow', ...overrides },
    { instancesDir }
  )
}

test('settings: Workspace Settings shows only the one instance-owning workspace — never a picker across every registered workspace', async () => {
  await withScratchServer(async (base, instancesDir) => {
    // Two workspaces registered — only one of them backs the instance this
    // screen is opened for.
    seedWorkspace(instancesDir, { repository: 'other-repo' })
    const ownWorkspace = seedWorkspace(instancesDir, { repository: 'own-repo' })
    registerInstance('remote-initiative', { kind: 'azureDevOps', workspaceId: ownWorkspace.id }, { instancesDir })

    await withPage(async (page) => {
      await page.goto(`${base}/settings/workspace?slug=remote-initiative`)
      await page.waitForSelector('.workspace-row', { timeout: 10_000 })

      const rows = page.locator('.workspace-row')
      assert.equal(await rows.count(), 1)
      assert.match(await rows.locator('.workspace-repo-url').textContent(), /own-repo/)
      assert.doesNotMatch(await page.locator('.settings-page').textContent(), /other-repo/)
    })(base)
  })
})

test('settings: Workspace Settings reports "no workspace" for a local instance, rather than a picker', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    await withPage(async (page) => {
      await page.goto(`${base}/settings/workspace?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })
      assert.equal(await page.locator('.workspace-row').count(), 0)
      assert.match(await page.locator('.workspace-empty').textContent(), /no Azure DevOps workspace/)
    })(base)
  })
})

test('settings: Workspace Settings\' owner, PAT-override, and ticketing-system-override controls still work, scoped to this one workspace', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const workspace = seedWorkspace(instancesDir, { owner: 'original-owner' })
    registerInstance('remote-initiative', { kind: 'azureDevOps', workspaceId: workspace.id }, { instancesDir })

    await withPage(async (page) => {
      await page.goto(`${base}/settings/workspace?slug=remote-initiative`)
      const row = page.locator('.workspace-row')
      await row.waitFor({ state: 'visible', timeout: 10_000 })

      assert.equal(await row.locator('.workspace-owner input[type=text]').inputValue(), 'original-owner')
      assert.match(await row.locator('.workspace-pat-status').textContent(), /USING GLOBAL DEFAULT/)
      assert.match(await row.locator('.workspace-ticketing-state').textContent(), /USING GLOBAL DEFAULT/)

      await row.locator('.workspace-owner input[type=text]').fill('new-owner')
      await row.getByRole('button', { name: 'Save owner' }).click()
      await page.waitForSelector('text=Saved.', { timeout: 5_000 })

      await row.locator('.workspace-pat input[type=password]').fill('workspace-override-pat')
      await row.getByRole('button', { name: 'Set override' }).click()
      assert.match(await row.locator('.workspace-pat-status').textContent(), /OVERRIDE SET/)
      const overrides = await page.evaluate(() => localStorage.getItem('gantry:ado-pat-overrides'))
      assert.match(overrides, new RegExp(workspace.id))

      await page.reload()
      const reloadedRow = page.locator('.workspace-row')
      await reloadedRow.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await reloadedRow.locator('.workspace-owner input[type=text]').inputValue(), 'new-owner')
    })(base)
  })
})

// ---------- Instance Settings (new, #107) ----------

test('settings: Instance Settings hosts an editable Assignee, read-only instance info, and read-only work-item link details', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow' })
    recordInstanceWorkItemLink(
      'my-initiative',
      { organization: 'wi-org', project: 'wi-project', workItemType: 'Task', parentId: 42, stages: { shape: 101 } },
      { instancesDir }
    )

    await withPage(async (page) => {
      await page.goto(`${base}/settings/instance?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })

      // Read-only instance info.
      assert.match(await page.locator('.settings-page').textContent(), /my-initiative/)
      assert.match(await page.locator('.settings-page').textContent(), /design/)

      // Editable assignee, pre-filled from the instance's own stored value.
      const assigneeInput = page.locator('section.settings-section', { hasText: 'Assignee' }).locator('input[type=text]')
      assert.equal(await assigneeInput.inputValue(), 'c.barlow')
      await assigneeInput.fill('new-assignee')
      await assigneeInput.blur()
      await page.waitForSelector('text=Saved.', { timeout: 5_000 })
      assert.equal(readInstance('my-initiative', { instancesDir }).assignee, 'new-assignee')

      // Read-only work-item link details — no re-linking form anywhere on
      // this screen.
      assert.match(await page.locator('.settings-page').textContent(), /wi-org/)
      assert.match(await page.locator('.settings-page').textContent(), /wi-project/)
      assert.match(await page.locator('.settings-page').textContent(), /#42/)
      assert.match(await page.locator('.settings-page').textContent(), /#101/)
      assert.equal(await page.getByRole('button', { name: 'Link instance' }).count(), 0)
      assert.equal(await page.locator('input[placeholder="Organization"]').count(), 0)
    })(base)
  })
})

// Regression test for a review-pass finding: clicking the Assignee
// section's "Save" button moves focus away from the input first, so the
// input's own `onBlur` and the button's `onClick` used to both call
// `handleSave` for the same edit — two identical `PUT
// /api/instance/assignee` requests per click (two separate commits for an
// Azure-DevOps-backed instance) instead of one. Exercises the exact
// "type, then click Save" path (never blurring elsewhere first) that the
// earlier blur-only test above didn't cover.
test('settings: clicking the Assignee section\'s Save button issues exactly one save request, not two', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow' })

    await withPage(async (page) => {
      let saveRequestCount = 0
      await page.route('**/api/instance/assignee*', async (route) => {
        if (route.request().method() === 'PUT') saveRequestCount++
        await route.continue()
      })

      await page.goto(`${base}/settings/instance?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })

      const assigneeInput = page.locator('section.settings-section', { hasText: 'Assignee' }).locator('input[type=text]')
      const saveButton = page.locator('section.settings-section', { hasText: 'Assignee' }).getByRole('button', { name: 'Save' })

      await assigneeInput.fill('clicked-assignee')
      await saveButton.click()
      await page.waitForSelector('text=Saved.', { timeout: 5_000 })

      assert.equal(readInstance('my-initiative', { instancesDir }).assignee, 'clicked-assignee')
      assert.equal(saveRequestCount, 1)
    })(base)
  })
})

test('settings: Instance Settings reports "not linked" when the instance has no work-item link', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    await withPage(async (page) => {
      await page.goto(`${base}/settings/instance?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })
      assert.match(await page.locator('.settings-page').textContent(), /isn't linked to an Azure DevOps work item/)
    })(base)
  })
})
