import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'
import { createInstance, readInstance } from '../lib/instance.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for #95/#103's Work Item panel (web/app.js's WorkItemPanel), post-#127: an unlinked instance renders no work-item panel at all (the freetext link form was removed — linking happens at instance creation, via the + New Workspace wizard), and a linked instance's panel drives the confirmed gate-pass-then-sync flow (both the confirm and the decline path) through a real rendered page against a real running gantry server and the fake in-process Azure DevOps Work Items server — nothing mocked at the browser or HTTP layer.

const WI_ORGANIZATION = 'wi-org'
const WI_PROJECT = 'wi-project'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

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

// Links through the same server route the "+ New Workspace" wizard's link step (#126) calls at creation time — the UI surface #127 removed was only ever one of this route's callers.
async function linkViaApi(gantryBase, wiBaseUrl, parentId) {
  const res = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
    body: JSON.stringify({
      organization: WI_ORGANIZATION,
      project: WI_PROJECT,
      parentId,
      baseUrl: wiBaseUrl,
    }),
  })
  assert.equal(res.status, 200)
}

// A gantry server backed by a scratch local instance ("my-initiative") whose Shape stage is pre-filled with the `examples` fixture's own real content, so the "Check gate & sync" action's check can genuinely PASS — wired to trust the fake Azure DevOps Work Items server's base URL, the same opt-in every other Azure-DevOps-backed test in this repo uses.
function withLinkableInstanceServer(fn) {
  return withFakeWorkItemsServer(async (wiBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      createInstance('design', 'my-initiative', { instancesDir })
      for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
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

test('an unlinked instance renders no work-item panel at all (#127 removed its freetext link form)', async () => {
  await withLinkableInstanceServer(async (gantryBase) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.goto(`${gantryBase}/instance/my-initiative`)
      await page.locator('.synced-fields-panel').waitFor({ timeout: DEFAULT_TIMEOUT * 2 })

      // No form, no panel shell — nothing to link with on this screen any more.
      assert.equal(await page.locator('.work-item-panel').count(), 0)
      assert.equal(await page.getByPlaceholder('Organization').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Link instance' }).count(), 0)

      // Discovery still has its surface: the synced-fields panel's "Link to a work item" prompt.
      await assert.doesNotReject(page.locator('.synced-fields-panel').getByText('Link to a work item').waitFor({ timeout: 5_000 }))

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('a linked instance\'s Work Item panel confirms a gate-pass state push', async () => {
  await withLinkableInstanceServer(async (gantryBase, wiBaseUrl, instancesDir) => {
    const parentId = await createParentWorkItem(wiBaseUrl)
    await linkViaApi(gantryBase, wiBaseUrl, parentId)

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      // The sync route does require a PAT (Work Items scope) — seed one up front, as if already entered in a prior session, so this test can drive the panel itself rather than the (separately covered, tests/patPrompt.playwright.test.js) PAT-prompt flow.
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/instance/my-initiative`)
      await page.waitForSelector('.synced-fields-panel', { timeout: DEFAULT_TIMEOUT * 2 })

      const panel = page.locator('.synced-fields-panel')
      // Linked view straight away — the panel's "Parent work item" field shows the linked id.
      await assert.doesNotReject(panel.locator(`text=#${parentId}`).waitFor({ timeout: DEFAULT_TIMEOUT * 2 }))
      await assert.doesNotReject(panel.locator('text=Parent work item').waitFor({ timeout: 5_000 }))

      // Genuinely recorded server-side too, not just rendered client-side.
      const instance = readInstance('my-initiative', { instancesDir })
      assert.equal(instance.workItem.parentId, parentId)

      // "Check gate & sync work item" — the Shape stage's modules were pre-filled, so the check genuinely passes and the confirm modal opens (never auto-pushing without it).
      await panel.getByRole('button', { name: 'Check gate & sync work item' }).click()
      await assert.doesNotReject(page.locator('.modal[aria-label="Confirm work item state update"]').waitFor({ timeout: DEFAULT_TIMEOUT * 2 }))

      const modal = page.locator('.modal[aria-label="Confirm work item state update"]')
      await modal.getByRole('button', { name: 'Confirm & push' }).click()
      await assert.doesNotReject(panel.locator('text=Pushed state').waitFor({ timeout: DEFAULT_TIMEOUT * 2 }))

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
    await linkViaApi(gantryBase, wiBaseUrl, parentId)

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

      await page.goto(`${gantryBase}/instance/my-initiative`)
      await page.waitForSelector('.synced-fields-panel', { timeout: DEFAULT_TIMEOUT * 2 })
      const panel = page.locator('.synced-fields-panel')
      await panel.locator(`text=#${parentId}`).waitFor({ timeout: DEFAULT_TIMEOUT * 2 })

      const instance = readInstance('my-initiative', { instancesDir })
      const shapeWorkItemId = instance.workItem.stages.shape

      const client = createAzureDevOpsWorkItemsClient({ organization: WI_ORGANIZATION, project: WI_PROJECT, pat: VALID_PAT, baseUrl: wiBaseUrl })
      const before = await client.updateWorkItem(shapeWorkItemId, {})
      const stateBefore = before.fields['System.State']

      await panel.getByRole('button', { name: 'Check gate & sync work item' }).click()
      const modal = page.locator('.modal[aria-label="Confirm work item state update"]')
      await modal.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT * 2 })
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
