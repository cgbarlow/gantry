import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobServiceClient } from '@azure/storage-blob'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'

// #269 (docs/adr/0070): with a Blob container declared, the "+ New Workspace" wizard asks where to keep the
// workspace. With Advanced mode off the choice is a folder on the architect's computer (Local) or a Blob
// container; with Advanced mode on, "Store in" lists Server disk and the containers. A workspace made in a
// container shows on the dashboard with its Instances, and when its container can't be reached it shows as
// unavailable with the reason while the rest of the dashboard carries on.

const skip = azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context'
after(stopAzurite)

const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`
const ADVANCED_MODE_OFF_INIT = `window.localStorage.removeItem('gantry:advancedMode')`

let counter = 0
async function withBlobServer(fn, { createContainer = true } = {}) {
  await withAzurite(async (emulator) => {
    const name = `w${Date.now().toString(36)}${counter++}`
    const client = BlobServiceClient.fromConnectionString(emulator.connectionString).getContainerClient(name)
    if (createContainer) await client.createIfNotExists()
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      await withRunningServer(
        {
          instancesDir,
          blobContainers: JSON.stringify([{ name: 'main', url: emulator.containerUrl(name), credentialType: 'connection-string', secretEnv: 'GANTRY_TEST_BLOB_CS' }]),
          env: { ...process.env, GANTRY_TEST_BLOB_CS: emulator.connectionString },
          blobRefreshMs: 0,
        },
        async (gantryBase) => {
          // The first request through a fresh SDK client can be slow on a busy machine; the Settings probe gives up after five seconds,
          // so warm the client before a page asks whether the container can be reached.
          await fetch(`${gantryBase}/api/server-workspaces?include=blob`)
          await fn({ gantryBase, instancesDir, client })
        }
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

test('with Advanced mode off and a container declared, the wizard asks Local or Blob container, and a workspace made in the container works', { skip, timeout: 240000 }, async () => {
  await withBlobServer(async ({ gantryBase, instancesDir, client }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_OFF_INIT)
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.waitForSelector('#simple-store-in')

      const options = (await page.locator('#simple-store-in option').allTextContents()).map((t) => t.trim())
      assert.deepEqual(options, ['A folder on my computer (Local)', 'Blob container: main'])
      // Local is still the default and still has its own panel; Server disk is not offered.
      assert.equal(await page.locator('#simple-store-in').inputValue(), 'local')
      assert.doesNotMatch(await page.locator('.wizard-page').textContent(), /Server disk/)

      await page.locator('#simple-store-in').selectOption('blob:main')
      await page.waitForSelector('#server-ws-name')
      assert.equal(await page.locator('.wizard-mode-toggle[aria-label="Workspace source"]').count(), 0, 'no source buttons beside it')
      assert.equal((await page.locator('#server-ws-store option').allTextContents()).map((t) => t.trim()).join('|'), 'Blob container: main')
      assert.match(await page.locator('#server-ws-store-hint').textContent(), /Blob container/)
      await page.locator('#server-ws-name').fill('Cloud Team')
      await page.locator('#server-ws-create').click()

      await page.waitForSelector('#instance-name')
      assert.match(await page.locator('.result-card').first().textContent(), /Server workspace\s*Cloud Team/)
      const blobs = []
      for await (const blob of client.listBlobsFlat({ prefix: 'cloud-team/' })) blobs.push(blob.name)
      assert.deepEqual(blobs, ['cloud-team/workspace.json'])

      await page.locator('#instance-name').fill('Cards')
      await page.getByRole('button', { name: 'Create instance', exact: true }).click()
      await page.waitForSelector('.stamp:has-text("Instance created")')
      const after = []
      for await (const blob of client.listBlobsFlat({ prefix: 'cloud-team/cards/' })) after.push(blob.name)
      assert.ok(after.includes('cloud-team/cards/instance.yaml'))
      assert.deepEqual(readdirSync(instancesDir).filter((entry) => entry.includes('cloud') || entry.startsWith('blob-')), [], 'nothing on the server disk')

      await page.getByRole('button', { name: 'Open instance', exact: true }).click()
      await page.waitForURL(/\/instance\/w\d+i1$/)
      await page.waitForSelector('.stage-position, .stage-navigation')

      // And the dashboard lists it under its workspace, whose subtitle says where it is kept.
      await page.goto(`${gantryBase}/`)
      const row = page.locator('.list-item', { hasText: 'Cloud Team' })
      await row.waitFor()
      assert.match(await row.textContent(), /1 instance/)
      await row.click()
      assert.match(await page.locator('.workspace-detail-head').textContent(), /Blob container: main/)
    } finally {
      await browser.close()
    }
  })
})

test('with Advanced mode on, Store in lists Server disk and the container', { skip, timeout: 240000 }, async () => {
  await withBlobServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      assert.equal(await page.locator('#simple-store-in').count(), 0, 'the Advanced mode wizard has the Store in of the server-workspace panel only')
      await page.getByRole('button', { name: 'New server workspace', exact: true }).click()
      await page.waitForSelector('#server-ws-name')
      assert.deepEqual((await page.locator('#server-ws-store option').allTextContents()).map((t) => t.trim()), ['Server disk', 'Blob container: main'])
    } finally {
      await browser.close()
    }
  })
})

test('with no container declared the wizard has no Store in choice', { timeout: 120000 }, async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (gantryBase) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        await page.addInitScript(ADVANCED_MODE_OFF_INIT)
        await page.goto(`${gantryBase}/new-workspace`)
        await page.waitForSelector('.wizard-mode-toggle[aria-label="Workspace source"]')
        await page.waitForTimeout(300)
        assert.equal(await page.locator('#simple-store-in').count(), 0)
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('a container that cannot be reached is offered but not selectable, and its workspaces show as unavailable with the reason', { skip, timeout: 240000 }, async () => {
  await withBlobServer(async ({ gantryBase, client }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_OFF_INIT)

      const made = await (await fetch(`${gantryBase}/api/server-workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Fragile', storage: 'blob', container: 'main' }) })).json()
      await fetch(`${gantryBase}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: 'design', slug: 'plain' }) })
      await client.delete()

      await page.goto(`${gantryBase}/`)
      const row = page.locator('.list-item', { hasText: 'Fragile' })
      await row.waitFor()
      assert.match(await row.textContent(), /Unavailable/)
      await row.click()
      await page.waitForSelector('[data-testid="workspace-unavailable"]')
      assert.match(await page.locator('[data-testid="workspace-unavailable"]').textContent(), /unavailable: the container does not exist \(404\)/)
      assert.equal(await page.locator('a.btn:has-text("+ New Instance")').count(), 0)
      // The rest of the dashboard carries on.
      await page.locator('.list-item', { hasText: 'default' }).first().waitFor()
      assert.ok(made.id)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('#simple-store-in')
      const optionText = (await page.locator('#simple-store-in option').allTextContents()).map((t) => t.trim())
      assert.match(optionText[1], /Blob container: main \(not reachable now: the container does not exist \(404\)\)/)
      assert.equal(await page.locator('#simple-store-in option').nth(1).isDisabled(), true)
    } finally {
      await browser.close()
    }
  })
})
