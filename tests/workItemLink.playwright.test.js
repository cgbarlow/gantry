import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for #95/#103's Work Item panel (web/app.js's WorkItemPanel): linking an unlinked instance through the real form, and the confirmed gate-pass-then-sync flow (both the confirm and the decline path), driven through a real rendered page against a real running gantry server and the fake in-process Azure DevOps Work Items server — nothing mocked at the browser or HTTP layer.

const WI_ORGANIZATION = 'wi-org'
const WI_PROJECT = 'wi-project'
const VALID_PAT = 'valid-test-pat'

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

function withFakeWorkItemsServer(fn) {
  return withFakeAzureDevOpsServer({ organization: WI_ORGANIZATION, project: WI_PROJECT, validPat: VALID_PAT }, fn)
}

async function createParentWorkItem(baseUrl) {
  const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl })
  const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
  return parent.id
}

// The Work Item panel's link form has no `baseUrl` field (production only ever targets the real dev.azure.com — mirrors the setup wizard's own repo-URL field, per #94's own "no on-premises baseUrl support" note) — the one piece of test wiring the real form has no way to express itself. Mirrors tests/setup-wizard.playwright.test.js's own `installRoutes`: intercept the outgoing request client-side and inject the fake server's `baseUrl` before it reaches the real gantry server, rather than adding a test-only field to production UI.
function installWorkItemsLinkRoute(page, wiBaseUrl) {
  return page.route('**/api/instance/work-items/link*', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = wiBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })
}

// A gantry server backed by a scratch local instance ("my-initiative") whose Shape stage is pre-filled with the `examples` fixture's own real content, so the "Check gate & sync" action's check can genuinely PASS — wired to trust the fake Azure DevOps Work Items server's base URL, the same opt-in every other Azure-DevOps-backed test in this repo uses.
function withLinkableInstanceServer(fn) {
  return withFakeWorkItemsServer(async (wiBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      createInstance('design', 'my-initiative', { instancesDir })
      for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
        cpSync(
          join('instances', 'examples', 'modules', `${moduleId}.md`),
          join(instancesDir, 'my-initiative', 'modules', `${moduleId}.md`)
        )
      }

      await withRunningServer(
        {
          slug: 'my-initiative',
          instancesDir,
          allowedAzureDevOpsBaseUrls: [wiBaseUrl],
          allowAzureDevOpsBaseUrlOverride: true,
        },
        async (gantryBase) => fn(gantryBase, wiBaseUrl, instancesDir)
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

test('the Work Item panel links an unlinked instance through the form, then confirms a gate-pass state push', async () => {
  await withLinkableInstanceServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    const parentId = await createParentWorkItem(wiBaseUrl)

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      // This instance's own data is local (never returns "authentication_required"), but the new work-items/link and work-items/sync routes do require a PAT (Work Items scope) — seed one up front, as if already entered in a prior session, so this test can drive the panel itself rather than the (separately covered, tests/patPrompt.playwright.test.js) PAT-prompt flow.
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
      await installWorkItemsLinkRoute(page, wiBaseUrl)

      await page.goto(`${gantryBase}/instance/my-initiative`)
      await page.waitForSelector('.work-item-panel', { timeout: 10_000 })

      // Unlinked: the inline link form is shown, no "linked to" text yet.
      const panel = page.locator('.work-item-panel')
      await assert.doesNotReject(panel.locator('.link-form').waitFor({ timeout: 5_000 }))
      assert.equal(await panel.locator('text=Linked to parent work item').count(), 0)

      await panel.locator('input[placeholder="Organization"]').fill(WI_ORGANIZATION)
      await panel.locator('input[placeholder="Project"]').fill(WI_PROJECT)
      await panel.locator('input[placeholder="Parent work item id"]').fill(String(parentId))
      await panel.getByRole('button', { name: 'Link instance' }).click()

      // Linking succeeds — the panel flips to the linked view, reporting this stage's own child work item id.
      await assert.doesNotReject(panel.locator(`text=Linked to parent work item #${parentId}`).waitFor({ timeout: 10_000 }))
      await assert.doesNotReject(panel.locator("text=This stage's work item: #").waitFor({ timeout: 5_000 }))

      // Genuinely recorded server-side too, not just rendered client-side.
      const instance = readInstance('my-initiative', { instancesDir })
      assert.equal(instance.workItem.parentId, parentId)

      // "Check gate & sync work item" — the Shape stage's modules were pre-filled, so the check genuinely passes and the confirm modal opens (never auto-pushing without it).
      await panel.getByRole('button', { name: 'Check gate & sync work item' }).click()
      await assert.doesNotReject(page.locator('.modal[aria-label="Confirm work item state update"]').waitFor({ timeout: 10_000 }))

      const modal = page.locator('.modal[aria-label="Confirm work item state update"]')
      await modal.getByRole('button', { name: 'Confirm & push' }).click()
      await assert.doesNotReject(panel.locator('text=Pushed state').waitFor({ timeout: 10_000 }))

      // Confirmed against the fake Azure DevOps server itself: the shape child work item's state genuinely changed there.
      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl: wiBaseUrl })
      const shapeWorkItemId = instance.workItem.stages.shape
      const states = await client.getWorkItemTypeStates('Task')
      const completed = states.find((s) => s.category === 'Completed')
      const updated = await client.updateWorkItem(shapeWorkItemId, {})
      assert.equal(updated.fields['System.State'], completed?.name ?? updated.fields['System.State'])

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('declining the confirmation leaves the linked work item\'s state unchanged', async () => {
  await withLinkableInstanceServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    const parentId = await createParentWorkItem(wiBaseUrl)

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
      await installWorkItemsLinkRoute(page, wiBaseUrl)

      await page.goto(`${gantryBase}/instance/my-initiative`)
      await page.waitForSelector('.work-item-panel', { timeout: 10_000 })
      const panel = page.locator('.work-item-panel')

      await panel.locator('input[placeholder="Organization"]').fill(WI_ORGANIZATION)
      await panel.locator('input[placeholder="Project"]').fill(WI_PROJECT)
      await panel.locator('input[placeholder="Parent work item id"]').fill(String(parentId))
      await panel.getByRole('button', { name: 'Link instance' }).click()
      await panel.locator(`text=Linked to parent work item #${parentId}`).waitFor({ timeout: 10_000 })

      const instance = readInstance('my-initiative', { instancesDir })
      const shapeWorkItemId = instance.workItem.stages.shape

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl: wiBaseUrl })
      const before = await client.updateWorkItem(shapeWorkItemId, {})
      const stateBefore = before.fields['System.State']

      await panel.getByRole('button', { name: 'Check gate & sync work item' }).click()
      const modal = page.locator('.modal[aria-label="Confirm work item state update"]')
      await modal.waitFor({ state: 'visible', timeout: 10_000 })
      await modal.getByRole('button', { name: 'Decline' }).click()
      await assert.doesNotReject(panel.locator('text=Declined — work item state left unchanged.').waitFor({ timeout: 5_000 }))
      await assert.doesNotReject(modal.waitFor({ state: 'hidden', timeout: 5_000 }))

      const after = await client.updateWorkItem(shapeWorkItemId, {})
      assert.equal(after.fields['System.State'], stateBefore)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})
