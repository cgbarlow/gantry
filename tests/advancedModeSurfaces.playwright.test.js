import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createInstance, recordInstanceWorkItemLink } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import {
  withRunningServer,
  withScratchInstances,
  ORGANIZATION,
  PROJECT,
  REPOSITORY,
  VALID_PAT,
} from './helpers/lifecycle.js'

// Browser coverage for #301 ("B2: Advanced mode off — hide ADO/ticketing
// surfaces on the dashboard + instance page"). Advanced mode (web/lib/advancedMode.js,
// shipped by #300) is OFF by default: a fresh browser must see only the
// local-only experience. With it off, the dashboard listing hides
// Azure-DevOps-backed rows, the instance card's "Manage" sub-card is gone,
// and the instance page shows neither the "Work item details" card nor the
// "Review / Sign-off" shortcut. Turning it on (a sticky localStorage choice)
// brings every one of those back, unchanged. A real gantry server, a real
// Chromium page, a real (in-process fake) Azure DevOps server — nothing
// mocked at the browser or HTTP layer.

const LOCAL_SLUG = 'local-initiative'
const ADO_SLUG = 'remote-initiative'

// One gantry server serving both a traditional server-side local instance
// and one Azure-DevOps-backed instance, plus a Chromium browser. A PAT is
// seeded into every page's localStorage before it navigates (mirrors
// tests/patPrompt.playwright.test.js) so `GET /api/instances` genuinely
// enriches and returns the Azure-DevOps-backed row — the point being that
// it's the *client-side* advanced-mode filter that hides it, not the row
// silently dropping out server-side for want of a credential.
function withMixedDashboard(fn) {
  return withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        [`/gantry-workspace/${ADO_SLUG}/instance.yaml`]: `definition: design\nslug: ${ADO_SLUG}\nstage: shape\n`,
      },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        createInstance('design', LOCAL_SLUG, { instancesDir, assignee: 'c.barlow' })
        // Gives the local instance's Manage sub-card real content (a Track Work Item link) so the
        // "advanced mode gates the Manage card" test below exercises the toggle itself rather than
        // the separate "Manage is hidden when it has nothing to show" behavior.
        recordInstanceWorkItemLink(
          LOCAL_SLUG,
          { organization: ORGANIZATION, project: PROJECT, workItemType: 'Task', parentId: 99, stages: { shape: 100 } },
          { instancesDir }
        )
        registerInstance(
          ADO_SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (base) => {
            const browser = await launchBrowser()
            try {
              const page = await browser.newPage()
              page.setDefaultTimeout(DEFAULT_TIMEOUT)
              const pageErrors = []
              page.on('pageerror', (err) => pageErrors.push(err.message))
              page.on('console', (msg) => {
                if (msg.type() === 'error') pageErrors.push(msg.text())
              })
              await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
              await fn({ page, base, pageErrors })
              assert.deepEqual(pageErrors, [])
            } finally {
              await browser.close()
            }
          }
        )
      })
    }
  )
}

test('advanced mode off (fresh browser): the dashboard lists only local instances', async () => {
  await withMixedDashboard(async ({ page, base }) => {
    await page.goto(base)
    await page.waitForSelector('.master-detail', { timeout: 10_000 })

    // Only the local instance's row — the Azure-DevOps-backed one is filtered out client-side.
    // `LOCAL_SLUG` is bare (no `workspace.json` of its own), so it migrates into the reserved
    // "default" server workspace on server start (WI #356) — the list-item shown is that
    // workspace's row (WI #357's one-row-per-workspace grouping), not the instance's own slug.
    assert.equal(await page.locator('.instance-list .list-item').count(), 1)
    assert.equal(await page.locator('.instance-list .list-item .name').textContent(), 'default')
    assert.equal(await page.locator('.instance-list .list-item .name', { hasText: REPOSITORY }).count(), 0)

    // Turning advanced mode on (a sticky choice) and reloading brings the ADO row back.
    await page.evaluate(() => localStorage.setItem('gantry:advancedMode', 'true'))
    await page.reload()
    await page.waitForSelector('.master-detail', { timeout: 10_000 })
    assert.equal(await page.locator('.instance-list .list-item').count(), 2)
    const names = await page.locator('.instance-list .list-item .name').allTextContents()
    assert.deepEqual([...names].sort(), [REPOSITORY, 'default'].sort())
  })
})

test('advanced mode off: a local instance card has no "Manage" sub-card; turning it on restores it', async () => {
  await withMixedDashboard(async ({ page, base }) => {
    await page.goto(base)
    await page.waitForSelector('.instance-card', { timeout: 10_000 })

    assert.equal(await page.locator('.instance-card').count(), 1)
    assert.equal(await page.locator('.manage-card').count(), 0)

    await page.evaluate(() => localStorage.setItem('gantry:advancedMode', 'true'))
    await page.reload()
    await page.waitForSelector('.instance-card', { timeout: 10_000 })
    // Local instance is workspace 0 / instance 1 — still selected by default after reload.
    await page.waitForSelector('.manage-card', { timeout: 10_000 })
    assert.equal(await page.locator('.manage-card').count(), 1)
  })
})

test('advanced mode off: an instance page shows no "Work item details" card and no "Review / Sign-off" button', async () => {
  await withMixedDashboard(async ({ page, base }) => {
    // The Azure-DevOps-backed instance, opened directly by URL: the editor
    // itself must still load and work — only its ADO-specific surfaces are hidden.
    await page.goto(`${base}/instance/${ADO_SLUG}`)
    await page.waitForSelector('#modules', { timeout: 10_000 })
    await page.waitForSelector('.toolbar', { timeout: 10_000 })

    assert.equal(await page.locator('.synced-fields-panel').count(), 0)
    assert.equal(await page.locator('#work-item-detail-card').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Review / Sign-off' }).count(), 0)
    assert.equal(await page.locator('.request-approval-btn').count(), 0)
    // The editor proper is present regardless of advanced mode.
    assert.ok((await page.locator('.module').count()) > 0)

    await page.evaluate(() => localStorage.setItem('gantry:advancedMode', 'true'))
    await page.reload()
    await page.waitForSelector('#modules', { timeout: 10_000 })

    await page.waitForSelector('.synced-fields-panel', { timeout: 10_000 })
    assert.equal(await page.locator('.synced-fields-panel').count(), 1)
    assert.equal(await page.locator('#work-item-detail-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Review / Sign-off' }).count(), 1)
  })
})

test('advanced mode off: a local instance page also hides the "Work item details" card, editor still works', async () => {
  await withMixedDashboard(async ({ page, base }) => {
    await page.goto(`${base}/instance/${LOCAL_SLUG}`)
    await page.waitForSelector('#modules', { timeout: 10_000 })

    assert.equal(await page.locator('.synced-fields-panel').count(), 0)
    assert.ok((await page.locator('.module').count()) > 0)

    await page.evaluate(() => localStorage.setItem('gantry:advancedMode', 'true'))
    await page.reload()
    await page.waitForSelector('.synced-fields-panel', { timeout: 10_000 })
    assert.equal(await page.locator('.synced-fields-panel').count(), 1)
    // A local instance is never workspace-backed, so the "Review / Sign-off" shortcut stays absent either way.
    assert.equal(await page.getByRole('button', { name: 'Review / Sign-off' }).count(), 0)
  })
})
