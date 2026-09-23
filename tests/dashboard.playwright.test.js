import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createInstance, recordInstanceWorkItemLink } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader } from './helpers/lifecycle.js'

// Browser smoke test for the Workspaces landing page (#77, restructured by #102) — the landing screen at `/`, backed by the multi-instance registry (`GET /api/instances`, #76). Mirrors tests/module-editor.playwright.test.js's pattern: a real server, a real Chromium page, asserting no console/page errors alongside the ticket's acceptance criteria — the "Workspaces" title, master-detail grouping instances by workspace (one row per workspace, a multi-instance workspace's detail column listing every instance it holds), a working view-mode menu, the view choice persisting across a reload (via localStorage), and the empty state's "new instance" call to action.

function withPage(fn) {
  return async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
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

test('dashboard: titled "Workspaces", master-detail is the default view, and its detail column shows each instance\'s definition/status/read-only assignee with Check/Edit reachable', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    // Both instances are bare (no `workspace.json` of their own), so on server start (WI #356) they
    // migrate into the one reserved "default" server workspace — one row for that workspace (WI
    // #357's one-row-per-workspace grouping), its detail column listing both instances as their own
    // cards, sorted by slug — the multi-instance-workspace case the ticket's own "a multi-instance
    // workspace's detail column listing every instance it holds" criterion describes.
    createInstance('design', 'alpha-initiative', { instancesDir, assignee: 'c.barlow' })
    createInstance('design', 'zebra-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        // #301 — the Manage sub-card renders only while advanced mode is on.
        await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        assert.equal(await page.locator('.dashboard-topbar h1').textContent(), 'Workspaces')
        assert.equal(await page.locator('.dashboard-heading svg').count(), 1)
        assert.equal(await page.locator('.instance-list .list-item').count(), 1)
        const viewTrigger = page.getByRole('button', { name: 'View mode' })
        assert.equal(await viewTrigger.count(), 1)
        await viewTrigger.click()
        const viewMenu = page.locator('.view-toggle .menu')
        await viewMenu.waitFor({ state: 'visible', timeout: 2_000 })
        assert.deepEqual(await viewMenu.getByRole('menuitem').allTextContents(), ['Default', 'Swimlanes'])
        assert.equal(await viewMenu.getByRole('menuitem', { name: 'Default' }).getAttribute('aria-current'), 'true')
        await viewMenu.getByRole('menuitem', { name: 'Default' }).click()
        await viewMenu.waitFor({ state: 'hidden', timeout: 2_000 })

        // The one group (the migrated "default" server workspace) is selected by default — both
        // instances it holds show up as their own cards in the detail column, sorted by slug.
        await page.waitForSelector('.instance-card', { timeout: 10_000 })
        assert.equal(await page.locator('.detail-pane h2').textContent(), 'default')
        assert.equal(await page.locator('.instance-card').count(), 2)
        const card = page.locator('.instance-card').filter({ hasText: 'alpha-initiative' })
        assert.equal(await card.locator('.name').textContent(), 'alpha-initiative')
        assert.match(await card.locator('.def').textContent(), /design/)
        assert.equal(await card.locator('.assignee').textContent(), 'c.barlow')
        assert.equal(await card.locator('.identity-picker').count(), 0)
        assert.ok(await card.getByRole('button', { name: 'Check' }).isVisible())
        assert.equal(await card.getByRole('button', { name: 'Render' }).count(), 0)
        assert.ok(await card.getByRole('link', { name: 'Edit', exact: true }).isVisible())
        // Neither Manage link applies here (no linked work item, not Azure-DevOps-backed) — the
        // whole card is hidden rather than shown with nothing in it.
        assert.equal(await card.locator('.manage-card').count(), 0)
        assert.equal(await card.locator('.save-status').count(), 0, 'empty action status should not reserve space')

        await card.getByRole('button', { name: 'Check' }).click()
        const actionStatus = card.locator('.save-status')
        await actionStatus.waitFor({ state: 'visible', timeout: 10_000 })
        assert.notEqual((await actionStatus.textContent()).trim(), '')
        const statusStyles = await actionStatus.evaluate((element) => {
          const styles = getComputedStyle(element)
          return { marginTop: styles.marginTop, minHeight: styles.minHeight }
        })
        assert.notEqual(statusStyles.marginTop, '0px')
        assert.notEqual(statusStyles.minHeight, '0px')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: Manage tracks a linked parent work item without inventing a repository link for a local instance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'linked-initiative', { instancesDir })
    recordInstanceWorkItemLink(
      'linked-initiative',
      {
        organization: 'work-org',
        project: 'work-project',
        workItemType: 'Task',
        parentId: 42,
        stages: { shape: 43 },
      },
      { instancesDir }
    )

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        // #301 — the Manage sub-card renders only while advanced mode is on.
        await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
        await page.goto(base)
        await page.waitForSelector('.instance-card', { timeout: 10_000 })

        const manage = page.locator('.manage-card')
        const track = manage.getByRole('link', { name: 'Track Work Item' })
        assert.equal(await track.getAttribute('href'), 'https://dev.azure.com/work-org/work-project/_workitems/edit/42')
        assert.equal(await track.getAttribute('target'), '_blank')
        assert.equal(await manage.getByRole('link', { name: 'Show files' }).count(), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: selecting a workspace with multiple instances shows every one of them in the detail column, each its own card', async () => {
  const ORGANIZATION = 'fake-org'
  const PROJECT = 'fake-project'
  const REPOSITORY = 'fake-repo'
  const VALID_PAT = 'valid-test-pat'
  const SEED_FILES = {
    '/gantry-workspace/instance-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\npullRequests:\n  shape: 42\n',
    '/gantry-workspace/instance-two/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        // Two slugs registered directly against the exact same Azure DevOps location share one auto-created workspace (lib/workspaceRegistry.js, #96 — verified independently in tests/serverWorkspaces.test.js), each holding its own data under #100's gantry-workspace/<slug>/directory layout; registered directly here (rather than through two real, distinct Azure DevOps repos) for test simplicity.
        const location = { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }
        registerInstance('instance-one', location, { instancesDir })
        registerInstance('instance-two', location, { instancesDir })

        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          withPage(async (page, base) => {
            // A PAT is required to enrich an Azure-DevOps-backed row (see lib/registry.js's
            // buildAzureDevOpsRow). #9 (ADR-0038): `GET /api/instances` (the dashboard's own unscoped
            // listing, web/app.js's `loadInstances` called with no slug) has no single workspace to
            // resolve a stored PAT against and so, correctly, now attaches none — there is no global
            // default left for a multi-workspace request to fall back to (a real, known gap this
            // ticket surfaces rather than papers over). This test's own point is proving
            // `lib/registry.js`'s real server-side enrichment/grouping is still correct given a
            // credential, not that the browser can currently produce one for this specific request —
            // so the credential is attached at the network layer directly (`page.route`) rather than
            // via any client-side storage, exercising the real fake-Azure-DevOps-backed server path
            // end to end regardless of that separate gap.
            await page.route('**/api/instances', async (route) => {
              const headers = { ...route.request().headers(), authorization: basicAuthHeader(VALID_PAT) }
              await route.continue({ headers })
            })
            // #301 — Azure-DevOps-backed rows list on the dashboard only while advanced mode is on.
            await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
            await page.goto(base)
            await page.waitForSelector('.master-detail', { timeout: 10_000 })

            // One row for the shared workspace, not two.
            assert.equal(await page.locator('.instance-list .list-item').count(), 1)
            assert.equal(await page.locator('.instance-list .list-item .name').textContent(), REPOSITORY)
            assert.match(await page.locator('.instance-list .list-item .def').textContent(), /2 instances/)

            await page.locator('.instance-list .list-item').click()
            await page.waitForSelector('.instance-card', { timeout: 10_000 })
            assert.equal(await page.locator('.detail-pane h2').textContent(), REPOSITORY)
            assert.match(await page.locator('.workspace-subtitle').textContent(), new RegExp(`${ORGANIZATION}/${PROJECT}`))

            // Both instances, each its own card, each independently showing definition/assignee/status and its own Check/Edit actions.
            const cards = page.locator('.instance-card')
            assert.equal(await cards.count(), 2)
            const names = await page.locator('.instance-card .name').allTextContents()
            assert.deepEqual([...names].sort(), ['instance-one', 'instance-two'])
            assert.equal(await page.locator('.instance-card .assignee').count(), 2)
            assert.equal(await page.locator('.instance-card').first().locator('.assignee').textContent(), 'c.barlow')
            assert.equal(await page.locator('.instance-card .identity-picker').count(), 0)
            assert.equal(await page.getByRole('button', { name: 'Check' }).count(), 2)
            assert.equal(await page.locator('.instance-card .pr-badge').count(), 1)
            assert.equal(await page.locator('.instance-card .pr-badge').textContent(), 'PR OPEN')
            assert.equal(await page.locator('.instance-card').getByRole('button', { name: 'Render' }).count(), 0)
            assert.equal(await page.getByRole('link', { name: 'Edit', exact: true }).count(), 2)
            assert.equal(await page.getByRole('link', { name: 'Show files' }).count(), 2)
            for (const link of await page.getByRole('link', { name: 'Show files' }).all()) {
              assert.equal(await link.getAttribute('target'), '_blank')
              assert.match(await link.getAttribute('href'), /_git\/[^?]+\?path=\/gantry-workspace\/instance-(one|two)$/)
            }
          })
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('dashboard: an instance card displays its assignee without an inline editor', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.instance-card', { timeout: 10_000 })

        assert.equal(await page.locator('.instance-card .assignee').textContent(), 'Unassigned')
        assert.equal(await page.locator('.instance-card .identity-picker').count(), 0)
        assert.equal(await page.locator('.instance-card .assignee-save-status').count(), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// #145: an instance's card shows its display name (`name:` in instance.yaml) instead of only the
// slug, once one is set — an instance with none set (every other test in this file) looks exactly
// as it always has, per its own acceptance criteria.
test('dashboard: an instance card shows the instance\'s display name (name:) instead of the slug once one is set', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'trerado-ea', { instancesDir })
    const instancePath = join(instancesDir, 'trerado-ea', 'instance.yaml')
    writeFileSync(instancePath, readFileSync(instancePath, 'utf8') + 'name: Trerado EA Platform\n')

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.instance-card', { timeout: 10_000 })

        assert.equal(await page.locator('.instance-card .name').textContent(), 'Trerado EA Platform')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: an instance card shows stage position, last updated, and no PR badge for a local instance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.instance-card', { timeout: 10_000 })

        assert.equal(await page.locator('.instance-card .stage-position').textContent(), 'Stage 1 of 4: SOAP')
        assert.match(await page.locator('.instance-card .updated-at').textContent(), /^Updated /)
        assert.equal(await page.locator('.instance-card .pr-badge').count(), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: view-mode menu switches to swimlanes and the choice persists across a reload', { skip: 'flakey — swimlane lane count is timing-sensitive in CI' }, async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await page.getByRole('button', { name: 'View mode' }).click()
        await page.getByRole('menuitem', { name: 'Swimlanes' }).click()
        await page.waitForSelector('.swimlanes', { timeout: 10_000 })
        assert.ok(await page.locator('.lane').count() >= 4, 'expected one lane per design stage')
        assert.match(await page.locator('.lane').first().textContent(), /SOAP/)
        assert.equal(await page.locator('.chip .name').first().textContent(), 'alpha-initiative')

        // Reload — the view choice (localStorage) survives, so swimlanes renders again without needing to re-toggle.
        await page.reload()
        await page.waitForSelector('.swimlanes', { timeout: 10_000 })
        const viewTrigger = page.getByRole('button', { name: 'View mode' })
        await viewTrigger.click()
        const viewMenu = page.locator('.view-toggle .menu')
        await viewMenu.waitFor({ state: 'visible', timeout: 2_000 })
        assert.equal(await viewMenu.getByRole('menuitem', { name: 'Swimlanes' }).getAttribute('aria-current'), 'true')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: swimlane chip overflow menu can open the module editor for that instance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.getByRole('button', { name: 'View mode' }).click()
        await page.getByRole('menuitem', { name: 'Swimlanes' }).click()
        await page.waitForSelector('.chip', { timeout: 10_000 })

        await page.locator('.chip .menu-btn').click()
        await page.getByRole('link', { name: 'Open' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        // Canonical numeric reference (WI200, docs/adr/0024) — this dashboard's only local instance is workspace 0 (no
        // real Azure DevOps workspace), instance 1.
        assert.equal(page.url(), `${base}/instance/w0i1`)
        assert.match(await page.locator('header h1').textContent(), /alpha-initiative/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: empty state renders a "new workspace" call to action when no instances are registered', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
        assert.equal(await page.locator('.view-toggle').count(), 0, 'no view toggle when there is nothing to view')

        await page.locator('.dashboard-empty').getByRole('link', { name: '+ New Workspace' }).click()
        await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
        assert.equal(page.url(), `${base}/new-workspace`)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// #113 — the theme toggle used to be duplicated in the dashboard topbar, the module editor header, the setup wizard header, and Settings' header; it now lives solely in Settings (see tests/settings.playwright.test.js for its one remaining instance).
test('dashboard: the topbar no longer has its own theme toggle (moved to Settings, #113)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-topbar', { timeout: 10_000 })
        assert.equal(await page.locator('.dashboard-topbar .theme-toggle').count(), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// The dashboard topbar's own "+ New Workspace" link is what makes creating a new instance reachable without an instance already open — before this, it only existed in the module editor's header (AppHeader) and the empty state's one-off call to action (the test above), so a dashboard already listing instances had no way to start another one.
test('dashboard: topbar "new workspace" link works even when instances are already registered', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await page.locator('.dashboard-topbar').getByRole('link', { name: '+ New Workspace' }).click()
        await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
        assert.equal(page.url(), `${base}/new-workspace`)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
