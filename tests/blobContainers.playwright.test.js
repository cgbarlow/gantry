import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobServiceClient } from '@azure/storage-blob'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { azuriteAvailable, withAzurite, stopAzurite } from './helpers/azurite.js'

// #267 (docs/adr/0070): Global Settings lists the Blob containers the operator declared, read-only, each
// with whether it can be reached right now, and never a credential. Nothing declared, nothing shown.

const SECRET_SAS = 'sv=2024-11-04&sig=THIS-SAS-TOKEN-MUST-NEVER-BE-ON-THE-PAGE'

function withSettingsPage(options, fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir, ...options }, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-page')
      await fn(page, base)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

after(stopAzurite)

test('Settings shows no Blob containers section when none is declared', async () => {
  await withSettingsPage({ blobContainers: undefined, env: {} }, async (page) => {
    await page.waitForSelector('text=Render engine')
    // The section loads after the rest of the page; give its fetch the chance to (not) render.
    await page.waitForLoadState('networkidle')
    assert.equal(await page.locator('#blob-containers').count(), 0)
    assert.equal(await page.locator('text=Blob containers').count(), 0)
  })
})

test('Settings lists a declared container with its name, URL, credential type and why it cannot be reached', async () => {
  const blobContainers = JSON.stringify([
    { name: 'offline', url: 'http://127.0.0.1:1/devstoreaccount1/gantry', credentialType: 'sas', secretEnv: 'OFFLINE_SAS' },
  ])
  await withSettingsPage({ blobContainers, env: { OFFLINE_SAS: SECRET_SAS } }, async (page) => {
    const row = page.locator('#blob-containers .blob-container[data-container="offline"]')
    await row.waitFor()
    const text = await row.innerText()
    assert.match(text, /offline/)
    assert.match(text, /http:\/\/127\.0\.0\.1:1\/devstoreaccount1\/gantry/)
    assert.match(text, /SAS token/)
    assert.match(text, /Not reachable/)
    assert.match(text, /no answer within 5 seconds|refused the connection|could not be reached|dropped/)
    const pageText = await page.locator('body').innerText()
    assert.ok(!pageText.includes('THIS-SAS-TOKEN'), 'no credential is shown')
    assert.ok(!(await page.content()).includes('THIS-SAS-TOKEN'), 'no credential is in the page')
    // Read-only: nothing on the section is editable.
    assert.equal(await page.locator('#blob-containers input, #blob-containers button, #blob-containers select').count(), 0)
  })
})

test(
  'Settings marks a reachable container Reachable, next to one that is not',
  { skip: azuriteAvailable ? false : 'the azurite devDependency is not installed in this build context', timeout: 240000 },
  async () => {
    await withAzurite(async (emulator) => {
      await BlobServiceClient.fromConnectionString(emulator.connectionString).getContainerClient('gantry').createIfNotExists()
      const blobContainers = JSON.stringify([
        { name: 'emulator', url: emulator.containerUrl('gantry'), credentialType: 'connection-string', secretEnv: 'EMU_CS' },
        { name: 'missing', url: emulator.containerUrl('not-there'), credentialType: 'connection-string', secretEnv: 'EMU_CS' },
      ])
      await withSettingsPage({ blobContainers, env: { EMU_CS: emulator.connectionString } }, async (page) => {
        const up = page.locator('#blob-containers .blob-container[data-container="emulator"]')
        const down = page.locator('#blob-containers .blob-container[data-container="missing"]')
        await up.waitFor()
        assert.match(await up.innerText(), /Reachable/)
        assert.doesNotMatch(await up.innerText(), /Not reachable/)
        assert.match(await up.innerText(), /Connection string/)
        assert.match(await down.innerText(), /Not reachable/)
        assert.match(await down.innerText(), /does not exist/)
        assert.ok(!(await page.content()).includes(emulator.key), 'the account key is not in the page')
      })
    })
  }
)
