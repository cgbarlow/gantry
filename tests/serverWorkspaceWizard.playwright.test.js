import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #268 (docs/adr/0070): the "+ New Workspace" wizard's "New server workspace" really creates a workspace
// on the server's disk. With Advanced mode on it sits beside "New remote workspace" and "An existing
// workspace" (the renamed Provider-repo options); with Advanced mode off neither Server disk nor the
// Provider-repo options are offered. A created workspace shows on the dashboard, and its Instances can be
// created straight away.

const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`
const ADVANCED_MODE_OFF_INIT = `window.localStorage.removeItem('gantry:advancedMode')`

function withWizardServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServer({ instancesDir }, async (gantryBase) => {
    try {
      await fn({ gantryBase, instancesDir })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

test('with Advanced mode on the wizard offers New server workspace beside the renamed remote options', async () => {
  await withWizardServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      const sourceButtons = page.locator('.wizard-mode-toggle[aria-label="Workspace source"] button')
      assert.deepEqual(await sourceButtons.allTextContents(), ['An existing workspace', 'New remote workspace', 'New server workspace'])

      await page.getByRole('button', { name: 'New server workspace', exact: true }).click()
      await page.waitForSelector('#server-ws-name')
      assert.equal(await page.locator('#server-ws-store option').count(), 1)
      assert.equal((await page.locator('#server-ws-store option').textContent()).trim(), 'Server disk')
      assert.match(await page.locator('.wizard-page').textContent(), /no branches, Pull Requests or\s+approvals/)
      // No Provider fields, no token: nothing to prove access to.
      assert.equal(await page.locator('#ws-provider, #ws-pat, input[type=password]').count(), 0)
      assert.equal(await page.locator('#server-ws-create').isDisabled(), true)
    } finally {
      await browser.close()
    }
  })
})

test('with Advanced mode off neither Server disk nor the Provider-repo options are offered', async () => {
  await withWizardServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_OFF_INIT)
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.waitForSelector('.wizard-mode-toggle[aria-label="Workspace source"]')

      const body = await page.locator('.wizard-page').textContent()
      assert.doesNotMatch(body, /New server workspace/)
      assert.doesNotMatch(body, /New remote workspace/)
      assert.doesNotMatch(body, /An existing workspace/)
      assert.doesNotMatch(body, /Server disk/)
      assert.equal(await page.locator('.wizard-mode-toggle[aria-label="Workspace location"]').count(), 0)
    } finally {
      await browser.close()
    }
  })
})

test('New server workspace creates a workspace on the server disk, then an Instance in it that opens', async () => {
  await withWizardServer(async ({ gantryBase, instancesDir }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      await page.getByRole('button', { name: 'New server workspace', exact: true }).click()
      await page.locator('#server-ws-name').fill('Payments Team')
      await page.locator('#server-ws-create').click()

      // Lands on the Instance step, inside the new workspace.
      await page.waitForSelector('#instance-name')
      assert.match(await page.locator('.result-card').first().textContent(), /Server workspace\s*Payments Team/)
      assert.ok(existsSync(join(instancesDir, 'payments-team', 'workspace.json')))
      assert.equal(JSON.parse(readFileSync(join(instancesDir, 'payments-team', 'workspace.json'), 'utf8')).name, 'Payments Team')

      await page.locator('#instance-name').fill('Cards')
      // No work item to link: the button creates straight away.
      const create = page.getByRole('button', { name: 'Create instance', exact: true })
      await create.click()
      await page.waitForSelector('.stamp:has-text("Instance created")')
      assert.ok(existsSync(join(instancesDir, 'payments-team', 'cards', 'instance.yaml')))

      await page.getByRole('button', { name: 'Open instance', exact: true }).click()
      await page.waitForURL(/\/instance\/w\d+i1$/)
      await page.waitForSelector('.stage-position, .stage-navigation')
    } finally {
      await browser.close()
    }
  })
})

test('a created server workspace with no Instance yet shows on the dashboard, and its New Instance button works', async () => {
  await withWizardServer(async ({ gantryBase, instancesDir }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)

      // Created in the wizard, then abandoned before making an Instance.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'New server workspace', exact: true }).click()
      await page.locator('#server-ws-name').fill('Ledger Team')
      await page.locator('#server-ws-create').click()
      await page.waitForSelector('#instance-name')

      await page.goto(`${gantryBase}/`)
      const row = page.locator('.list-item', { hasText: 'Ledger Team' })
      await row.waitFor()
      assert.match(await row.textContent(), /No instances/)
      await row.click()
      await page.waitForSelector('text=No instances in this workspace yet.')

      await page.getByRole('link', { name: '+ New Instance' }).click()
      await page.waitForURL(/\/new-instance\?workspace=ledger-team/)
      await page.waitForSelector('#instance-name')
      assert.match(await page.locator('.result-card').first().textContent(), /Server workspace\s*Ledger Team/)
      assert.equal(await page.locator('h2').first().textContent(), 'New Instance')

      await page.locator('#instance-name').fill('General Ledger')
      await page.getByRole('button', { name: 'Create instance', exact: true }).click()
      await page.waitForSelector('.stamp:has-text("Instance created")')
      assert.ok(existsSync(join(instancesDir, 'ledger-team', 'general-ledger', 'instance.yaml')))

      // The dashboard now shows the Instance under the workspace, and keeps offering a New Instance.
      await page.goto(`${gantryBase}/`)
      const populated = page.locator('.list-item', { hasText: 'Ledger Team' })
      await populated.waitFor()
      assert.match(await populated.textContent(), /1 instance/)
      await populated.click()
      await page.waitForSelector('a.btn:has-text("+ New Instance")')
    } finally {
      await browser.close()
    }
  })
})

test('New server workspace shows the server\'s refusal of a name already in use', async () => {
  await withWizardServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await fetch(`${gantryBase}/api/server-workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Risk Register' }) })

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'New server workspace', exact: true }).click()
      await page.locator('#server-ws-name').fill('risk register')
      await page.locator('#server-ws-create').click()
      await page.waitForSelector('#server-ws-error')
      assert.match(await page.locator('#server-ws-error').textContent(), /already exists/)
      // Still on the workspace step: nothing was created.
      assert.equal(await page.locator('#instance-name').count(), 0)
    } finally {
      await browser.close()
    }
  })
})
