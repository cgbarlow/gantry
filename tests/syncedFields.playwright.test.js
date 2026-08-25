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

// Browser smoke test for #111's synced-fields panel (web/app.js's
// SyncedFieldsPanel): the unlinked "Link to a work item" prompt taking the
// panel's place, and — once the instance is linked (via the same server
// route the "+ New Workspace" wizard calls at creation; #127 removed this
// screen's own freetext link form) — the five distinct fields appearing,
// with a title override genuinely persisted server-side. Driven through a
// real rendered page against a real running gantry server, mirroring
// tests/workItemLink.playwright.test.js's own conventions.

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

test('the synced-fields panel shows the link prompt when unlinked, then the distinct fields once linked', async () => {
  await withFakeAzureDevOpsServer(
    { organization: WI_ORGANIZATION, project: WI_PROJECT, validPat: VALID_PAT },
    async (wiBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        createInstance('design', 'my-initiative', { instancesDir, assignee: 'Ada Lovelace' })

        await withRunningServer(
          {
            slug: 'my-initiative',
            instancesDir,
            allowedAzureDevOpsBaseUrls: [wiBaseUrl],
            allowAzureDevOpsBaseUrlOverride: true,
          },
          async (gantryBase) => {
            const wiClient = createAzureDevOpsWorkItemsClient({
              organization: WI_ORGANIZATION,
              project: WI_PROJECT,
              pat: VALID_PAT,
              baseUrl: wiBaseUrl,
            })

            const browser = await chromium.launch()
            try {
              const page = await browser.newPage()
              const pageErrors = []
              page.on('pageerror', (err) => pageErrors.push(err.message))
              page.on('console', (msg) => {
                if (msg.type() === 'error') pageErrors.push(msg.text())
              })

              // The panel itself needs no PAT while unlinked, but the linked synced-fields reads (work item state, PR state) do — seed one as if already entered in a prior session.
              await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

              await page.goto(`${gantryBase}/instance/my-initiative`)
              const panel = page.locator('.synced-fields-panel')
              await panel.waitFor({ timeout: 10_000 })

              // Unlinked: the prompt takes the fields' place — and #127 removed
              // this screen's own link form along with its whole work-item panel.
              await assert.doesNotReject(panel.locator('text=Link to a work item').waitFor({ timeout: 5_000 }))
              assert.equal(await panel.locator('#synced-title').count(), 0)
              assert.equal(await page.locator('.work-item-panel').count(), 0)

              // Link through the same server route the "+ New Workspace" wizard
              // calls at creation time (the UI surface #127 removed was only
              // ever one of this route's callers), then reload so the panel
              // refetches against its now-linked instance.
              const parentId = (
                await wiClient.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })
              ).id
              const linkRes = await fetch(`${gantryBase}/api/instance/work-items/link?slug=my-initiative`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
                body: JSON.stringify({
                  organization: WI_ORGANIZATION,
                  project: WI_PROJECT,
                  parentId,
                  baseUrl: wiBaseUrl,
                }),
              })
              assert.equal(linkRes.status, 200)
              await page.reload()

              // The synced-fields panel flips to its linked view: five distinct fields, not collapsed together.
              await assert.doesNotReject(page.locator('.synced-fields-panel #synced-title').waitFor({ timeout: 10_000 }))
              assert.equal(await panel.locator('.synced-field').count(), 5)
              assert.equal(await panel.locator('.synced-value >> text=Task').count(), 1)
              assert.equal(await panel.locator('input#synced-title').inputValue(), 'my-initiative — Shape')
              assert.match(await panel.locator('.synced-value').nth(1).innerText(), /#\d+ · New/)
              assert.match(await panel.locator('.synced-value').nth(2).innerText(), /No pull request open/)
              assert.equal(await panel.locator('.identity-picker input').inputValue(), 'Ada Lovelace')

              // Override the title — saved on blur/Enter, persisted server-side.
              await panel.locator('input#synced-title').fill('Custom shape title')
              await panel.locator('input#synced-title').press('Enter')
              await assert.doesNotReject(panel.locator('text=Saved.').waitFor({ timeout: 10_000 }))
              const stored = readInstance('my-initiative', { instancesDir })
              assert.equal(stored.syncedFields.shape.title, 'Custom shape title')
              await assert.doesNotReject(panel.locator('text=Title · overridden').waitFor({ timeout: 5_000 }))

              // Clearing the field reverts to the auto-populated default — the "overridden" marker disappears once the server confirms.
              await panel.locator('input#synced-title').fill('')
              await panel.locator('input#synced-title').press('Enter')
              await assert.doesNotReject(panel.locator('text=Title · overridden').waitFor({ state: 'hidden', timeout: 10_000 }))
              assert.equal(await panel.locator('input#synced-title').inputValue(), 'my-initiative — Shape')

              assert.deepEqual(pageErrors, [])
            } finally {
              await browser.close()
            }
          }
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})
