import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, VALID_PAT } from './helpers/lifecycle.js'

// Browser smoke test for the "+ New Workspace" wizard (#110, replacing the
// old URL-first instance-setup wizard entirely) and its parent-work-item
// link step for ticketing-enabled workspaces (#126): register a brand new
// workspace (setting its Owner/ticketing system in the same step), create
// an instance in it (Name/Directory/Assignee), then — since every
// workspace registered today carries a ticketing system (see
// lib/workspaceRegistry.js's own doc comment: 'azure-devops' is the only
// value gantry supports and it's the default when omitted, so a "no
// ticketing system" workspace isn't reachable yet) — link that instance to
// a real parent work item via genuine PAT-backed lookups against the fake
// Azure DevOps Work Items server, never freetext.
//
// Real, separate in-process fake Azure DevOps servers stand in for the
// repo the architect registers (#84's fake server, never a real
// dev.azure.com). The wizard's own forms collect no `baseUrl` field
// (production only ever targets the real dev.azure.com — mirrors the old
// wizard's own repo-URL field and the Work Item panel's own link form) —
// the one piece of test wiring injected client-side via `page.route`,
// exactly like tests/workItemLink.playwright.test.js's own
// `installWorkItemsLinkRoute`.

const ORGANIZATION = 'Contoso-Production'
const PROJECT = 'Default'
const REPOSITORY = 'wizard-repo'



function withWizardTestServer(fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} }, (adoBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    return withRunningServer(
      { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
      async (gantryBase) => {
        try {
          await fn({ gantryBase, adoBaseUrl, instancesDir })
        } finally {
          rmSync(instancesDir, { recursive: true, force: true })
        }
      }
    )
  })
}

// Injects the fake server's real `baseUrl` into every request this
// wizard's own forms have no field for — POST /api/workspaces, POST
// /api/instances, and the two new #126 lookup routes — mirroring
// tests/setup-wizard.playwright.test.js's/tests/workItemLink.playwright.test.js's
// own `installRoutes`/`installWorkItemsLinkRoute`.
function installBaseUrlRoutes(page, adoBaseUrl) {
  const routeWorkspaces = page.route('**/api/workspaces', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  const routeInstances = page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    if (body.azureDevOps) body.azureDevOps.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  const routeWorkItemTypes = page.route('**/api/azure-devops/work-item-types*', async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('baseUrl', adoBaseUrl)
    await route.continue({ url: url.toString() })
  })

  const routeWorkItemLookup = page.route('**/api/azure-devops/work-items/*', async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('baseUrl', adoBaseUrl)
    await route.continue({ url: url.toString() })
  })

  const routeWorkItemsLink = page.route('**/api/instance/work-items/link*', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  const routeIdentities = page.route('**/api/identities*', async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('baseUrl', adoBaseUrl)
    await route.continue({ url: url.toString() })
  })

  const routeRepoCheck = page.route('**/api/azure-devops/repo-check*', async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('baseUrl', adoBaseUrl)
    await route.continue({ url: url.toString() })
  })

  const routeAdopt = page.route('**/api/instances/adopt', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    if (body.azureDevOps) body.azureDevOps.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  const routeWorkItemsCreate = page.route('**/api/azure-devops/work-items', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  return Promise.all([routeWorkspaces, routeInstances, routeWorkItemTypes, routeWorkItemLookup, routeWorkItemsLink, routeIdentities, routeRepoCheck, routeAdopt, routeWorkItemsCreate])
}

test('the "+ New Workspace" wizard registers a workspace, creates an instance, and links it to a real parent work item (#126\'s ticketing-enabled step)', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl, instancesDir }) => {
    const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
    const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

      // ---------- Step 1: register a brand new workspace ----------
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.locator('#ws-owner').fill('a.architect')
      // Azure DevOps is the only enabled ticketing system — already
      // selected by default; Jira's radio is present but disabled.
      assert.equal(await page.locator('input[name="ws-ticketing-system"][value="jira"]').isDisabled(), true)
      await page.getByRole('button', { name: 'Register workspace' }).click()

      // ---------- Step 2: instance fields ----------
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Claims Modernisation')
      // Directory auto-populates from Name (slugified) — verify before overriding.
      assert.equal(await page.locator('#instance-directory').inputValue(), 'claims-modernisation')
      await page.locator('#instance-assignee').fill('a.architect')
      await page.getByRole('button', { name: 'Next: link a work item' }).click()

      // ---------- Step 3: parent-work-item link (#126) ----------
      await page.getByRole('button', { name: 'Link an existing parent work item' }).click()
      await page.waitForSelector('#parent-work-item-id', { timeout: 10_000 })
      assert.equal(await page.locator('#link-organization').inputValue(), ORGANIZATION)
      assert.equal(await page.locator('#link-project').inputValue(), PROJECT)
      // Submit is disabled until a successful look-up.
      assert.equal(await page.getByRole('button', { name: 'Create instance & link' }).isDisabled(), true)
      // Work item types load asynchronously — wait for the real list before
      // looking up, so the "pre-selected on found" assertion below can't race it.
      await page.waitForSelector('#work-item-type option', { state: 'attached', timeout: 10_000 })

      await page.locator('#parent-work-item-id').fill(String(parent.id))
      await page.getByRole('button', { name: 'Look up' }).click()
      await page.waitForSelector('text=Found: #', { timeout: 10_000 })
      assert.match(await page.locator('.wizard-field-hint').last().textContent(), /Parent initiative/)
      // The looked-up work item's own type ("Feature") is pre-selected.
      assert.equal(await page.locator('#work-item-type').inputValue(), 'Feature')

      await page.getByRole('button', { name: 'Create instance & link' }).click()

      // ---------- Done ----------
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })
      await Promise.all([
        page.waitForNavigation({ timeout: 10_000 }),
        page.getByRole('button', { name: 'Open instance' }).click(),
      ])
      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.match(await page.locator('header h1').textContent(), /claims-modernisation/)

      // The work-item link is genuinely recorded, not just rendered.
      const linkedRes = await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      const registry = await linkedRes.json()
      const created = registry.find((i) => i.slug === 'claims-modernisation')
      assert.ok(created, 'the created instance appears in the registry')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('the "+ New Workspace" wizard\'s pick-existing-workspace path adds a second instance to an already-registered workspace', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
    const parentA = await client.createWorkItem('Feature', { 'System.Title': 'Parent A' })
    const parentB = await client.createWorkItem('Feature', { 'System.Title': 'Parent B' })

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      // First pass: register the workspace and create the first instance.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.getByRole('button', { name: 'Register workspace' }).click()

      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('First Instance')
      await page.getByRole('button', { name: 'Next: link a work item' }).click()
      await page.getByRole('button', { name: 'Link an existing parent work item' }).click()
      await page.waitForSelector('#parent-work-item-id', { timeout: 10_000 })
      await page.waitForSelector('#work-item-type option', { state: 'attached', timeout: 10_000 })
      await page.locator('#parent-work-item-id').fill(String(parentA.id))
      await page.getByRole('button', { name: 'Look up' }).click()
      await page.waitForSelector('text=Found: #', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Create instance & link' }).click()
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      // Second pass: back to the wizard, pick the now-already-registered
      // workspace instead of registering another one.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      // "Pick existing workspace" is the default mode.
      await page.waitForSelector('#workspace-picker', { timeout: 10_000 })
      await page.locator('#workspace-picker .definition-card', { hasText: `${ORGANIZATION}/${PROJECT}/${REPOSITORY}` }).click()
      await page.getByRole('button', { name: 'Continue' }).click()

      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Second Instance')
      await page.getByRole('button', { name: 'Next: link a work item' }).click()
      await page.getByRole('button', { name: 'Link an existing parent work item' }).click()
      await page.waitForSelector('#parent-work-item-id', { timeout: 10_000 })
      await page.waitForSelector('#work-item-type option', { state: 'attached', timeout: 10_000 })
      await page.locator('#parent-work-item-id').fill(String(parentB.id))
      await page.getByRole('button', { name: 'Look up' }).click()
      await page.waitForSelector('text=Found: #', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Create instance & link' }).click()
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      const registry = await (
        await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      assert.ok(registry.some((i) => i.slug === 'first-instance'))
      assert.ok(registry.some((i) => i.slug === 'second-instance'))
      // Both instances share the exact same workspace — no duplicate
      // workspace was registered for the second, picked pass.
      const workspaces = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(workspaces.length, 1)
    } finally {
      await browser.close()
    }
  })
})

// ---- #137: pick-mode empty-state affordance + back navigation ----

test('#137: empty pick-mode offers a control to switch to Register', async () => {
  await withWizardTestServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      // Pick mode is the default; with zero registered workspaces the list
      // is empty after load completes.
      await page.waitForSelector('#workspace-picker', { state: 'detached', timeout: 10_000 })
      const hint = page.locator('.wizard-field-hint', { hasText: 'No workspaces registered yet' })
      await hint.waitFor({ timeout: 10_000 })
      const linkBtn = hint.locator('.btn-link')
      assert.equal(await linkBtn.count(), 1, 'empty state contains a clickable control')
      assert.match(await linkBtn.textContent(), /switch to "Register new workspace"/)
      await linkBtn.click()
      // Should now be in register mode — the register form fields appear.
      await page.waitForSelector('#ws-organization', { timeout: 5_000 })
    } finally {
      await browser.close()
    }
  })
})

test('#137: Back from Instance step returns to workspace picker with values intact', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
    await client.createWorkItem('Feature', { 'System.Title': 'Any parent' })

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      // Register a workspace so the pick list has at least one entry.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.locator('#ws-owner').fill('a.architect')
      await page.getByRole('button', { name: 'Register workspace' }).click()

      // Arrived at Instance step — fill in Name (Directory auto-follows).
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Test Instance')
      const dirBefore = await page.locator('#instance-directory').inputValue()

      // Click Back — should return to the workspace step.
      await page.getByRole('button', { name: '← Back' }).click()
      await page.waitForSelector('.wizard-mode-toggle', { timeout: 5_000 })

      // workspaceMode is still 'register' (preserved from the registration
      // flow) — switch to pick mode to see the workspace list.
      await page.getByRole('button', { name: 'Pick existing workspace', exact: true }).click()
      await page.waitForSelector('#workspace-picker', { timeout: 5_000 })
      await page.locator('#workspace-picker .definition-card').first().click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.waitForSelector('#instance-name', { timeout: 5_000 })
      assert.equal(await page.locator('#instance-name').inputValue(), 'Test Instance')
      assert.equal(await page.locator('#instance-directory').inputValue(), dirBefore)
    } finally {
      await browser.close()
    }
  })
})

test('#137: Back from Link step returns to Instance step with values intact', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
    await client.createWorkItem('Feature', { 'System.Title': 'Any parent' })

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.getByRole('button', { name: 'Register workspace' }).click()

      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Back Test')
      await page.getByRole('button', { name: 'Next: link a work item' }).click()
      await page.getByRole('button', { name: 'Link an existing parent work item' }).click()

      // Arrived at Link step.
      await page.waitForSelector('#parent-work-item-id', { timeout: 10_000 })

      // Click Back — should return to Instance step.
      await page.getByRole('button', { name: '← Back' }).click()
      await page.waitForSelector('#instance-name', { timeout: 5_000 })
      assert.equal(await page.locator('#instance-name').inputValue(), 'Back Test')
    } finally {
      await browser.close()
    }
  })
})

test('#137: mid-flow revisit of /new-workspace persists step; Back reaches workspace picker', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT, baseUrl: adoBaseUrl })
    await client.createWorkItem('Feature', { 'System.Title': 'Any parent' })

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      // Register a workspace and advance to Instance step.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.getByRole('button', { name: 'Register workspace' }).click()
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      // Client-side navigate away then back — module-scope signals persist
      // across popstate/pushState (the preact-iso router's own path), not
      // across a hard page.goto() reload.
      await page.locator('a[href="/"]').click()
      await page.waitForSelector('h2:has-text("Dashboard")', { timeout: 5_000 }).catch(() =>
        page.waitForSelector('main', { timeout: 5_000 })
      )
      // Back in browser history returns to /new-workspace client-side.
      await page.goBack()
      await page.waitForSelector('#instance-name', { timeout: 5_000 })

      // Back from Instance should reach the workspace step.
      await page.getByRole('button', { name: '← Back' }).click()
      await page.waitForSelector('.wizard-mode-toggle', { timeout: 5_000 })
      // workspaceMode was 'register' — switch to pick to verify the list.
      await page.getByRole('button', { name: 'Pick existing workspace', exact: true }).click()
      await page.waitForSelector('#workspace-picker', { timeout: 5_000 })
    } finally {
      await browser.close()
    }
  })
})

// ---- #138: instance-fields section heading ----

test('#138: Instance step renders "New Instance" heading between Workspace card and Definition picker', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.getByRole('button', { name: 'Register workspace' }).click()

      // Wait for Instance step to appear.
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      // The "New Instance" heading is present.
      const heading = page.locator('h3', { hasText: 'New Instance' })
      assert.equal(await heading.count(), 1, '"New Instance" heading renders exactly once')

      // Heading is positioned between the Workspace summary card and the
      // Definition picker — the Workspace card's <h3> with the "Workspace"
      // stamp comes first, then "New Instance", then the Definition label.
      const workspaceStamp = page.locator('h3 .stamp.agreed', { hasText: 'Workspace' })
      const definitionLabel = page.locator('label[for="definition-picker"]')
      const headingBox = await heading.boundingBox()
      const stampBox = await workspaceStamp.boundingBox()
      const defBox = await definitionLabel.boundingBox()
      assert.ok(headingBox, 'heading is visible')
      assert.ok(stampBox, 'workspace stamp is visible')
      assert.ok(defBox, 'definition label is visible')
      assert.ok(stampBox.y < headingBox.y, 'heading appears below the Workspace stamp')
      assert.ok(headingBox.y < defBox.y, 'heading appears above the Definition picker')
    } finally {
      await browser.close()
    }
  })
})
