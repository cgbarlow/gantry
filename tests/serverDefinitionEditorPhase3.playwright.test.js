import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { MIGRATED_DEFAULT_WORKSPACE_FOLDER } from '../lib/instanceRegistry.js'

// WI #383 (Definition Editor phase 3, ADR-0036) — a workspace can hold its own definitions. This
// covers the "Done when" e2e bar: creating and using a workspace definition in a server workspace.

function withServerWorkspace(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p3-e2e-lib-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p3-e2e-ws-'))
  return (async () => {
    try {
      // Named "Acme" but at the *reserved* `default` folder (`MIGRATED_DEFAULT_WORKSPACE_FOLDER`):
      // `POST /api/instances`'s local branch always creates a new instance there, so "using" the
      // workspace definition (below) needs it to be the workspace an instance can actually land in.
      cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
      mkdirSync(join(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER), { recursive: true })
      writeWorkspaceJson(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER, { name: 'Acme', kind: 'local', createdAt: new Date().toISOString() })
      await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, instancesDir))
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })()
}

async function withPage(base, fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    page.on('dialog', (d) => d.accept())
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

async function openSwitcher(page) {
  await page.locator('.defn-switcher [data-dropdown-trigger]').click()
  await page.waitForSelector('.defn-switcher-menu, .defn-newdef-panel', { timeout: 10_000 })
}

test('creating and using a workspace definition in a server workspace', async () => {
  await withServerWorkspace(async (base, instancesDir) => {
    await withPage(base, async (page, pageErrors) => {
      // ---- Create: a brand-new definition, homed in the "acme" server workspace ----
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
      await openSwitcher(page)
      await page.getByRole('button', { name: '+ New definition…' }).click()
      await page.locator('#defn-newdef-blank-id').fill('acme-onboarding')
      await page.locator('#defn-newdef-blank-title').fill('Acme Onboarding')
      await page.locator('#defn-newdef-blank-home').selectOption({ label: 'Workspace: Acme' })
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Acme Onboarding', { timeout: 10_000 })

      // The switcher groups the new definition under "Workspace: Acme", not the server library.
      await openSwitcher(page)
      const workspaceGroup = page.locator('.defn-switcher-group').filter({ has: page.locator('.kicker', { hasText: 'Workspace: Acme' }) })
      await workspaceGroup.locator('.defn-switcher-row', { hasText: 'Acme Onboarding' }).waitFor({ state: 'visible', timeout: 10_000 })
      // Close it again (the trigger toggles) so the outline underneath is clickable.
      await page.locator('.defn-switcher [data-dropdown-trigger]').click()
      await page.locator('.defn-switcher-menu').waitFor({ state: 'hidden', timeout: 10_000 })

      // Add one stage so the definition is a real, instance-creatable definition (createInstance
      // requires at least one stage), then Save and Publish — all through the ordinary editor UI, no
      // different from a library definition, proving the workspace and library homes share one
      // lifecycle end to end.
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const stagesGroup = page.locator('.defn-outline-group').nth(0)
      await stagesGroup.getByRole('button', { name: 'Add stage' }).click()
      await page.waitForSelector('.defn-focus-title-input', { timeout: 10_000 })

      const saveBtn = page.getByRole('button', { name: 'Save', exact: true })
      await saveBtn.waitFor({ state: 'visible', timeout: 5_000 })
      await saveBtn.click()
      await page.waitForFunction(() => document.querySelector('button.primary')?.textContent !== 'Saving…', { timeout: 10_000 })

      const publishBtn = page.getByRole('button', { name: 'Publish', exact: true })
      await publishBtn.click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })

      // Same on-disk layout and lifecycle as the server library: definitions/<id>/<n>/definition.yaml,
      // just rooted under the workspace's own folder.
      assert.ok(existsSync(join(instancesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER, 'definitions', 'acme-onboarding', '1', 'definition.yaml')))

      // ---- Use: an instance built against the workspace definition resolves and renders it ----
      const createRes = await fetch(`${base}/api/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: 'acme-onboarding', slug: 'acme-onboarding-instance' }),
      })
      assert.equal(createRes.status, 201, await createRes.text())

      await page.goto(`${base}/instance/acme-onboarding-instance`)
      await page.waitForSelector('#modules', { timeout: 10_000 })
      await page.waitForSelector('.toolbar', { timeout: 10_000 })
      const bodyText = await page.locator('body').innerText()
      assert.match(bodyText, /New Stage/, "the instance page should render the workspace definition's own stage")
      assert.deepEqual(pageErrors, [])
    })
  })
})
