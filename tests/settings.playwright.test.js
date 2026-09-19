import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createInstance, readInstance, recordInstanceWorkItemLink } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser smoke tests for the reworked Settings screens (#107): three separate, tab-free top-level routes — `/settings` (Global Settings), `/settings/workspace` (Workspace Settings, scoped to one instance's own workspace) and `/settings/instance` (Instance Settings) — replacing #101/#104's single tabbed `/settings` shell entirely. Mirrors tests/dashboard.playwright.test.js's pattern: a real server, a real Chromium page, asserting no console/page errors alongside the ticket's acceptance criteria.

// `ignoreConsoleErrors` (regexes) exists for exactly one caller below: typing
// a plain owner name into a workspace row's IdentityPicker input fires its
// live identity-search debounce (~250ms) regardless of whether a working PAT
// is configured yet, same as any other character typed there. When no PAT is
// set — as in the owner-save step of that test, which runs before a PAT
// override exists — Azure DevOps genuinely 401s that debounced search, which
// the picker already catches and shows inline; Chromium still logs the
// failed fetch to the console on its own, unprompted by app code. That's a
// real, correctly-surfaced auth failure (unlike the "no ADO workspace at
// all" case, fixed at the source in `/api/identities` to return 200/[]
// instead of a 4xx) — not safe to silence at the server, so it's allowlisted
// here instead, scoped to the one test where it's expected.
function withPage(fn, { ignoreConsoleErrors = [] } = {}) {
  return async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      const isIgnored = (text) => ignoreConsoleErrors.some((re) => re.test(text))
      page.on('pageerror', (err) => {
        if (!isIgnored(err.message)) pageErrors.push(err.message)
      })
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !isIgnored(msg.text())) pageErrors.push(msg.text())
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
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
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

// #113 — the theme toggle used to be duplicated across the Workspaces
// landing header, the Module Editor header, the setup wizard header, and
// this Settings header; it's now removed from the other three (see
// tests/dashboard.playwright.test.js, tests/module-editor.playwright.test.js,
// and tests/setup-wizard.playwright.test.js), leaving exactly this one
// control app-wide.
test('settings: the theme toggle is the one remaining copy, and still cycles the theme', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-header', { timeout: 10_000 })

      const toggle = page.locator('.settings-header .theme-toggle')
      assert.equal(await toggle.count(), 1)
      assert.equal(await page.locator('.theme-toggle').count(), 1)

      assert.equal(await page.getAttribute('html', 'data-theme'), 'light')
      assert.match(await toggle.textContent(), /Theme: light/)

      await toggle.click()
      assert.equal(await page.getAttribute('html', 'data-theme'), 'dark')
      assert.match(await toggle.textContent(), /Theme: dark/)
    })(base)
  })
})

test('settings: "Settings" from the dashboard goes straight to Global Settings, no intermediate step', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(base)
      await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
      await page.getByRole('link', { name: 'Settings' }).click()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/settings')
      assert.equal(await page.locator('.settings-header h1').textContent(), 'Settings')
      // #300 — the ticketing section only exists once advanced mode is enabled.
      await page.getByLabel('Enable advanced mode').check()
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

// #9 (ADR-0038): the old "default PAT can be set/replaced/cleared from Global Settings" test is gone
// along with the Global Defaults PAT tier it exercised — there is no global-default PAT any more, no
// Global Settings PAT section, and no PAT prompt with no workspace behind it. Per-workspace PAT
// management is covered by the Workspace Settings test below, and the removal of the global control
// itself is covered by 'settings: advanced mode is off by default...' below (which now asserts the
// PAT section is absent from Global Settings even with advanced mode on).

test('settings: Global Settings has no PAT section — every workspace manages its own PAT from Workspace Settings instead', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })
      await page.getByLabel('Enable advanced mode').check()
      await page.waitForSelector('.settings-radio-group', { timeout: 10_000 })

      assert.equal(await page.locator('.settings-section', { hasText: 'Personal Access Token' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: /Azure DevOps PAT/ }).count(), 0)
    })(base)
  })
})

test('settings: a global ticketing-system default can be set to azure-devops; jira is disabled with a "coming soon" indication', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })
      // #300 — the ticketing selector is only rendered while advanced mode is on.
      await page.getByLabel('Enable advanced mode').check()
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

// ---------- #300: "Enable advanced mode" toggle ----------
// Fresh browser => advanced mode off => the default-ticketing selector is absent from Global
// Settings entirely. Toggling on reveals it; the choice is sticky across a reload; toggling off
// hides it again. #9: the old PAT section this test also toggled is gone from Global Settings
// permanently (on or off), not merely hidden behind advanced mode — see the dedicated "no PAT
// section" test above.
test('settings: advanced mode is off by default, hiding the ticketing section until toggled on (sticky across reload)', async () => {
  await withScratchServer(async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-header', { timeout: 10_000 })

      const toggle = page.getByLabel('Enable advanced mode')
      assert.equal(await toggle.count(), 1)
      assert.equal(await toggle.isChecked(), false)
      assert.match(
        await page.locator('.settings-section', { hasText: 'Advanced mode' }).textContent(),
        /Shows Azure DevOps repositories, work-item ticketing, and sign-off\. Leave off for local-only use\./
      )

      // Off: the section is not on the page.
      assert.equal(await page.locator('.settings-section', { hasText: 'Default ticketing system' }).count(), 0)

      // On: it appears.
      await toggle.check()
      await page.waitForSelector('.settings-radio-group', { timeout: 5_000 })
      assert.ok(await page.locator('.settings-section', { hasText: 'Default ticketing system' }).isVisible())
      assert.equal(await page.evaluate(() => localStorage.getItem('gantry:advancedMode')), 'true')

      // Sticky across a reload.
      await page.reload()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(await page.getByLabel('Enable advanced mode').isChecked(), true)
      assert.ok(await page.locator('.settings-section', { hasText: 'Default ticketing system' }).isVisible())

      // Off again: hidden again.
      await page.getByLabel('Enable advanced mode').uncheck()
      assert.equal(await page.locator('.settings-section', { hasText: 'Default ticketing system' }).count(), 0)
      assert.equal(await page.evaluate(() => localStorage.getItem('gantry:advancedMode')), 'false')
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

      // Header dropdowns share one open-menu owner: opening the switcher closes Settings, and opening Settings closes the switcher.
      const switcherButton = page.getByRole('button', { name: 'Switch instance' })
      const switcherMenu = page.locator('.instance-switcher .menu')
      await switcherButton.click()
      await switcherMenu.waitFor({ state: 'visible', timeout: 5_000 })
      await menu.waitFor({ state: 'hidden', timeout: 2_000 })
      await settingsButton.click()
      await menu.waitFor({ state: 'visible', timeout: 2_000 })
      await switcherMenu.waitFor({ state: 'hidden', timeout: 2_000 })

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
  const { owner = 'c.barlow', ...locationOverrides } = overrides
  return registerWorkspace(
    {
      location: { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo', ...locationOverrides },
      owner,
    },
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

test('settings: Workspace Settings\' owner, Workspace PAT, and ticketing-system-override controls still work, scoped to this one workspace', async () => {
  await withScratchServer(async (base, instancesDir) => {
    const workspace = seedWorkspace(instancesDir, { owner: 'original-owner' })
    registerInstance('remote-initiative', { kind: 'azureDevOps', workspaceId: workspace.id }, { instancesDir })

    await withPage(async (page) => {
      await page.goto(`${base}/settings/workspace?slug=remote-initiative`)
      const row = page.locator('.workspace-row')
      await row.waitFor({ state: 'visible', timeout: 10_000 })

      assert.equal(await row.locator('.workspace-owner input[type=text]').inputValue(), 'original-owner')
      // #9 (ADR-0038): no global default left to fall back to — a workspace with nothing stored for
      // it yet simply reads as missing, not "using the global default".
      assert.match(await row.locator('.workspace-pat-status').textContent(), /MISSING/)
      assert.match(await row.locator('.workspace-ticketing-state').textContent(), /USING GLOBAL DEFAULT/)

      await row.locator('.workspace-owner input[type=text]').fill('new-owner')
      await row.getByRole('button', { name: 'Save owner' }).click()
      await page.waitForSelector('text=Saved.', { timeout: 5_000 })

      await row.locator('.workspace-pat input[type=password]').fill('workspace-own-pat')
      await row.getByRole('button', { name: 'Set PAT' }).click()
      assert.match(await row.locator('.workspace-pat-status').textContent(), /SET/)
      const stored = await page.evaluate(() => localStorage.getItem('gantry:ado-pat-overrides'))
      assert.match(stored, new RegExp(workspace.id))

      await page.reload()
      const reloadedRow = page.locator('.workspace-row')
      await reloadedRow.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await reloadedRow.locator('.workspace-owner input[type=text]').inputValue(), 'new-owner')
    }, { ignoreConsoleErrors: [/Failed to load resource: the server responded with a status of 401/] })(base)
  })
})

// ---------- Instance Settings (new, #107) ----------

test('settings: Instance Settings hosts an editable Assignee, read-only instance info, and read-only work-item link details', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'default'), assignee: 'c.barlow' })
    recordInstanceWorkItemLink(
      'my-initiative',
      { organization: 'wi-org', project: 'wi-project', workItemType: 'Task', parentId: 42, stages: { shape: 101 } },
      { instancesDir: join(instancesDir, 'default') }
    )

    await withPage(async (page) => {
      await page.goto(`${base}/settings/instance?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })

      // Read-only instance info.
      assert.match(await page.locator('.settings-page').textContent(), /my-initiative/)
      assert.match(await page.locator('.settings-page').textContent(), /design/)
      // A freshly created instance pins to the definition's latest published
      // version at creation time (not necessarily "v1" — see lib/server.js's
      // POST /api/instances), so this only checks the row exists and names
      // *some* version, not which one.
      assert.match(await page.locator('.settings-section', { hasText: 'Instance info' }).textContent(), /Version.*v\d+/s)

      // Editable assignee, pre-filled from the instance's own stored value.
      const assigneeInput = page.locator('section.settings-section', { hasText: 'Assignee' }).locator('input[type=text]')
      assert.equal(await assigneeInput.inputValue(), 'c.barlow')
      await assigneeInput.fill('new-assignee')
      await assigneeInput.blur()
      await page.waitForSelector('text=Saved.', { timeout: 5_000 })
      assert.equal(readInstance('my-initiative', { instancesDir: join(instancesDir, 'default') }).assignee, 'new-assignee')

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
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'default'), assignee: 'c.barlow' })

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

      assert.equal(readInstance('my-initiative', { instancesDir: join(instancesDir, 'default') }).assignee, 'clicked-assignee')
      assert.equal(saveRequestCount, 1)
    })(base)
  })
})

test('settings: Instance Settings reports "not linked" when the instance has no work-item link', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'default') })

    await withPage(async (page) => {
      await page.goto(`${base}/settings/instance?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })
      assert.match(await page.locator('.settings-page').textContent(), /isn't linked to an Azure DevOps work item/)
    })(base)
  })
})

// #223 — archive / restore an instance from Instance Settings, then see it surface in (and leave
// via) the dashboard's "Archived instances" panel.
test('settings: an instance can be archived from Instance Settings and restored from the dashboard archived panel', async () => {
  await withScratchServer(async (base, instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir: join(instancesDir, 'default') })

    await withPage(async (page) => {
      page.on('dialog', (dialog) => dialog.accept())

      // Archive from Instance Settings.
      await page.goto(`${base}/settings/instance?slug=my-initiative`)
      await page.waitForSelector('.settings-section', { timeout: 10_000 })
      const archiveSection = page.locator('section.settings-section', { hasText: 'Archive' })
      await archiveSection.getByRole('button', { name: 'Archive instance' }).click()
      await page.waitForSelector('text=Archived.', { timeout: 5_000 })
      assert.equal(await archiveSection.getByRole('button', { name: 'Restore instance' }).count(), 1)

      // Gone from the default dashboard listing, present in the Archived panel.
      await page.goto(base)
      await page.waitForSelector('.dashboard', { timeout: 10_000 })
      const archivedPanel = page.locator('details.archived-panel')
      await archivedPanel.waitFor({ timeout: 5_000 })
      assert.match(await archivedPanel.textContent(), /my-initiative/)

      // Restore from the panel — row disappears.
      await archivedPanel.click()
      await archivedPanel.getByRole('button', { name: 'Restore' }).click()
      await page.waitForFunction(() => !document.querySelector('details.archived-panel'), { timeout: 5_000 })
    })(base)
  })
})

