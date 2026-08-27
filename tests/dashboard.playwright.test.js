import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { createInstance, recordInstanceWorkItemLink } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for the Workspaces landing page (#77, restructured by #102) — the landing screen at `/`, backed by the multi-instance registry (`GET /api/instances`, #76). Mirrors tests/module-editor.playwright.test.js's pattern: a real server, a real Chromium page, asserting no console/page errors alongside the ticket's acceptance criteria — the "Workspaces" title, master-detail grouping instances by workspace (one row per workspace, a multi-instance workspace's detail column listing every instance it holds), a working toggle to stage swimlanes, the view choice persisting across a reload (via localStorage), and the empty state's "new instance" call to action.
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

test('dashboard: titled "Workspaces", master-detail is the default view, and its detail column shows each instance\'s definition/status/assignee with Check/Edit reachable', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    // Local instances have no workspace (#96 — Workspace is an Azure-DevOps-repo concept only), so each groups on its own, one row per instance — the single-instance case the ticket's own "a workspace with only one instance still displays correctly" criterion describes.
    createInstance('design', 'alpha-initiative', { instancesDir, assignee: 'c.barlow' })
    createInstance('design', 'zebra-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        assert.equal(await page.locator('.dashboard-topbar h1').textContent(), 'Workspaces')
        assert.equal(await page.locator('.instance-list .list-item').count(), 2)
        assert.equal(await page.locator('.view-toggle button.active').textContent(), 'Master-detail')

        // First group (sorted by title: alpha-initiative) is selected by default — its one instance shows up as its own card in the detail column.
        await page.waitForSelector('.instance-card', { timeout: 10_000 })
        assert.equal(await page.locator('.detail-pane h2').textContent(), 'alpha-initiative')
        assert.equal(await page.locator('.instance-card').count(), 1)
        assert.equal(await page.locator('.instance-card .name').textContent(), 'alpha-initiative')
        assert.match(await page.locator('.instance-card .def').textContent(), /design/)
        assert.equal(await page.locator('.instance-card .identity-picker input').inputValue(), 'c.barlow')
        assert.ok(await page.getByRole('button', { name: 'Check' }).isVisible())
        assert.equal(await page.locator('.instance-card').getByRole('button', { name: 'Render' }).count(), 0)
        assert.ok(await page.getByRole('link', { name: 'Edit' }).isVisible())
        assert.equal(await page.locator('.manage-card').count(), 1)
        assert.equal(await page.locator('.manage-card .manage-link').count(), 0)
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
        await page.goto(base)
        await page.waitForSelector('.instance-card', { timeout: 10_000 })

        const manage = page.locator('.manage-card')
        const track = manage.getByRole('link', { name: 'Track Work Item' })
        assert.equal(await track.getAttribute('href'), 'https://dev.azure.com/work-org/work-project/_workitems/edit/42')
        assert.equal(await track.getAttribute('target'), '_blank')
        assert.equal(await manage.getByRole('link', { name: 'Open Repository' }).count(), 0)
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
    '/gantry-workspace/instance-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
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
            // A PAT is required to enrich an Azure-DevOps-backed row (see lib/registry.js's buildAzureDevOpsRow) — seeded into localStorage before navigating, mirroring tests/patPrompt.playwright.test.js's own technique, so GET /api/instances attaches it from the very first request.
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
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
            assert.equal(await page.locator('.instance-card .identity-picker input').count(), 2)
            assert.equal(await page.locator('.instance-card').first().locator('.identity-picker input').inputValue(), 'c.barlow')
            assert.equal(await page.getByRole('button', { name: 'Check' }).count(), 2)
            assert.equal(await page.locator('.instance-card').getByRole('button', { name: 'Render' }).count(), 0)
            assert.equal(await page.getByRole('link', { name: 'Edit' }).count(), 2)
            assert.equal(await page.getByRole('link', { name: 'Open Repository' }).count(), 2)
            for (const link of await page.getByRole('link', { name: 'Open Repository' }).all()) {
              assert.equal(await link.getAttribute('target'), '_blank')
            }
          })
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('dashboard: editing an instance card\'s assignee field saves it, and it survives a reload', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.instance-card', { timeout: 10_000 })

        assert.equal(await page.locator('.identity-picker input').inputValue(), '')

        await page.locator('.identity-picker input').fill('j.smith')
        await page.locator('.identity-picker input').press('Enter')
        await page.waitForFunction(() => document.querySelector('.assignee-save-status')?.textContent?.includes('Saved.'))

        await page.reload()
        await page.waitForSelector('.instance-card', { timeout: 10_000 })
        assert.equal(await page.locator('.identity-picker input').inputValue(), 'j.smith')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: toggling to stage swimlanes groups instances into lanes by current stage, and the choice persists across a reload', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await page.getByRole('button', { name: 'Stage swimlanes' }).click()
        await page.waitForSelector('.swimlanes', { timeout: 10_000 })
        assert.ok(await page.locator('.lane').count() >= 4, 'expected one lane per design stage')
        assert.match(await page.locator('.lane').first().textContent(), /Shape/)
        assert.equal(await page.locator('.chip .name').first().textContent(), 'alpha-initiative')

        // Reload — the view choice (localStorage) survives, so swimlanes renders again without needing to re-toggle.
        await page.reload()
        await page.waitForSelector('.swimlanes', { timeout: 10_000 })
        assert.equal(await page.locator('.view-toggle button.active').textContent(), 'Stage swimlanes')
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
        await page.getByRole('button', { name: 'Stage swimlanes' }).click()
        await page.waitForSelector('.chip', { timeout: 10_000 })

        await page.locator('.chip .menu-btn').click()
        await page.getByRole('link', { name: 'Open' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(page.url(), `${base}/instance/alpha-initiative`)
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
