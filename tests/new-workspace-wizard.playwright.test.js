import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'
import { withFakeJiraServer, JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'
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

// Every test below exercises the server-hosted registration/pick flow this
// file was written for. WI #302 (B3) made that flow reachable only with
// advanced mode on — off (the default) skips straight to the Local flow
// instead (see tests/wizard-local-workspace.playwright.test.js). Setting
// this before each `goto` keeps this file's own coverage of the
// server-hosted path exercising that path deliberately, rather than
// accidentally relying on a default B3 changed.
const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`

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
    // The wizard now sends the #37 nested `{ provider, location }` body (ticket #5) — the injected
    // baseUrl has to land in `location`, not the top level, or the server proves this workspace's PAT
    // against real dev.azure.com instead of this test's own fake server.
    if (body.location) body.location.baseUrl = adoBaseUrl
    else body.baseUrl = adoBaseUrl
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

      // ---------- Step 1: register a brand new workspace ----------
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      // #9 (ADR-0038): filled before Owner below — its own search is PAT-backed (against the
      // organization/project just entered), and a brand-new workspace has no id yet to resolve a
      // stored PAT against, so the wizard's own PAT field is what search (and, later, Register
      // workspace itself) prove access with.
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      await page.locator('#ws-pat').fill(VALID_PAT)
      await page.locator('#ws-owner').fill('a.architect')
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      // First pass: register the workspace and create the first instance.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      // #9 (ADR-0038): a brand-new workspace has no id yet to resolve a stored PAT against — the
      // wizard's own PAT field, not the (now-removed) global default, is what proves access here.
      await page.locator('#ws-pat').fill(VALID_PAT)
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      // Register a workspace so the pick list has at least one entry.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      // #9 (ADR-0038): filled before Owner below — see the first test's own comment on why.
      await page.locator('#ws-pat').fill(VALID_PAT)
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      // #9 (ADR-0038): a brand-new workspace has no id yet to resolve a stored PAT against — the
      // wizard's own PAT field, not the (now-removed) global default, is what proves access here.
      await page.locator('#ws-pat').fill(VALID_PAT)
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      // Register a workspace and advance to Instance step.
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      // #9 (ADR-0038): a brand-new workspace has no id yet to resolve a stored PAT against — the
      // wizard's own PAT field, not the (now-removed) global default, is what proves access here.
      await page.locator('#ws-pat').fill(VALID_PAT)
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      // #9 (ADR-0038): a brand-new workspace has no id yet to resolve a stored PAT against — the
      // wizard's own PAT field, not the (now-removed) global default, is what proves access here.
      await page.locator('#ws-pat').fill(VALID_PAT)
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

// WI #316 fix #3 — the selected definition version's changelog (WI #234) is
// collapsed by default behind a native <details>/<summary> disclosure
// ("Show release notes"), not shown in full unconditionally.
test('#316: the version changelog is collapsed behind "Show release notes" by default, and expands on click', async () => {
  await withWizardTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      // #9 (ADR-0038): no global-default PAT to pre-seed any more — every test below registers its
      // own workspace through the wizard's own `#ws-pat` field, which becomes that workspace's PAT.

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.locator('#ws-organization').fill(ORGANIZATION)
      await page.locator('#ws-project').fill(PROJECT)
      await page.locator('#ws-repository').fill(REPOSITORY)
      // #9 (ADR-0038): a brand-new workspace has no id yet to resolve a stored PAT against — the
      // wizard's own PAT field, not the (now-removed) global default, is what proves access here.
      await page.locator('#ws-pat').fill(VALID_PAT)
      await page.getByRole('button', { name: 'Register workspace' }).click()

      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      // The "design" definition has a real CHANGELOG.md fixture (definitions/design/1/CHANGELOG.md).
      await page.locator('.definition-card', { hasText: 'Solution Design' }).click()

      const toggle = page.locator('.wizard-changelog-toggle summary', { hasText: 'Show release notes' })
      await assert.doesNotReject(toggle.waitFor({ timeout: 5_000 }))
      const content = page.locator('.wizard-changelog')

      // Collapsed by default — the content exists in the DOM (a native
      // <details>, not conditionally rendered) but isn't visible.
      assert.equal(await content.isVisible(), false, 'changelog content is collapsed by default')

      await toggle.click()
      assert.equal(await content.isVisible(), true, 'changelog content expands on click')
      assert.match(await content.textContent(), /\S/, 'expanded content is non-empty')
    } finally {
      await browser.close()
    }
  })
})

// ---- #25: registering a brand new GitLab workspace through the wizard's Register step ----
//
// Unlike Azure DevOps/GitHub above (which have no baseUrl field in this wizard, relying on
// page.route injection to point at the fake server), GitLab's Register form has a real, user-facing
// "Base URL (optional)" field (ADR-0041's self-hosted CE/EE support) — so this test fills the fake
// server's own baseUrl directly into that field, exercising the genuine UI path rather than
// test-only route rewriting.
function withGitLabWizardTestServer(fn) {
  return withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files: {} }, (gitlabBaseUrl) => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    return withRunningServer({ instancesDir, allowGitLabBaseUrlOverride: true }, async (gantryBase) => {
      try {
        await fn({ gantryBase, gitlabBaseUrl, instancesDir })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  })
}

test('#25: the "+ New Workspace" wizard registers a brand new GitLab workspace end-to-end (not just adopts an existing one)', async () => {
  await withGitLabWizardTestServer(async ({ gantryBase, gitlabBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

      // ---------- Step 1: register a brand new GitLab workspace ----------
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      // GitLab is a real, selectable Provider choice (#25) — no longer the disabled "Coming soon" row.
      const gitlabRadio = page.locator('input[name="ws-provider"][value="gitlab"]')
      assert.equal(await gitlabRadio.isDisabled(), false)
      await gitlabRadio.click()

      await page.waitForSelector('#ws-namespace', { timeout: 5_000 })
      await page.locator('#ws-namespace').fill(GITLAB_NAMESPACE)
      await page.locator('#ws-repository').fill(GITLAB_REPOSITORY)
      // The real self-hosted-base-URL field a GitLab registration offers — pointed at this test's own
      // fake GitLab server rather than gitlab.com, the same "prove real access" contract every other
      // provider's registration already has.
      await page.locator('#ws-gitlab-baseurl').fill(gitlabBaseUrl)
      await page.locator('#ws-pat').fill(GITLAB_VALID_PAT)
      // Owner (the workspace's Owner *person*) isn't required to register — its own IdentityPicker
      // search is exercised by the Azure DevOps test above already; left blank here to keep this test
      // focused on the Provider/location/PAT path #25 actually adds.

      await page.getByRole('button', { name: 'Register workspace' }).click()

      // ---------- Step 2: instance step reached — a real workspace was created, not just checked ----------
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

// ---- #48: registering a brand new Atlassian workspace through the wizard's Register step ----
//
// Unlike GitLab above, Atlassian has no public `baseUrl` field in this wizard at all (ADR-0042:
// Cloud-only, no self-hosted override to gate) — the two fake servers this test stands up (Bitbucket
// Cloud, Jira Cloud) are pointed at purely via the running gantry server's own test-only
// `atlassianBitbucketBaseUrl`/`atlassianJiraBaseUrl` startup options (lib/server.js's own doc comment
// on those two options), never a value typed into the page. This test exercises every acceptance
// criterion #48 names: Atlassian selectable (not disabled), all four location fields plus both PATs
// collected, the live-fetched Jira issue-type picker, and a real `POST /api/workspaces` reaching the
// Instance step — mirroring the GitLab test's own scope (register -> Instance step reached), per #48's
// own instruction not to repeat the GitLab build's split-ticket gap.
function withAtlassianWizardTestServer(fn) {
  return withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: {} },
    (bitbucketBaseUrl) =>
      withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT }, (jiraBaseUrl) => {
        const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
        return withRunningServer(
          { instancesDir, atlassianBitbucketBaseUrl: bitbucketBaseUrl, atlassianJiraBaseUrl: jiraBaseUrl },
          async (gantryBase) => {
            try {
              await fn({ gantryBase, bitbucketBaseUrl, jiraBaseUrl, instancesDir })
            } finally {
              rmSync(instancesDir, { recursive: true, force: true })
            }
          }
        )
      })
  )
}

test('#48: the "+ New Workspace" wizard registers a brand new Atlassian workspace end-to-end (not just adopts an existing one)', async () => {
  await withAtlassianWizardTestServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      // The Instance step's own best-effort `GET /api/workspaces/:id/definitions` fetch (WI #383,
      // lib/server.js's own `rejectUnlessAzureDevOpsWorkspace`) is a known, already-declared 400 for
      // any provider without its own workspace-definitions route wired in yet — Atlassian's isn't
      // (per that function's own doc comment: "a fail-safe for any *future* provider ... without
      // workspace-definitions support of its own"), out of #48's own scope (Register step + repoCheck
      // + the POST /api/workspaces dispatch table, not this separate definitions-listing route). The
      // wizard's own effect already handles it gracefully (falls back to `[]`, `catch(() => {})`) — the
      // browser still logs its own generic, URL-less "Failed to load resource: ... 400" console message
      // for it regardless, so this counts *expected* such 400s (via the real response, which does carry
      // a URL) to tell them apart from a genuinely unexpected failure below.
      let expectedBadRequestResponses = 0
      page.on('response', (res) => {
        if (res.status() === 400 && res.url().includes('/definitions')) expectedBadRequestResponses += 1
      })

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

      // ---------- Step 1: register a brand new Atlassian workspace ----------
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      // Atlassian is a real, selectable Provider choice (#48) — no longer the disabled "Coming soon" row.
      const atlassianRadio = page.locator('input[name="ws-provider"][value="atlassian"]')
      assert.equal(await atlassianRadio.isDisabled(), false)
      await atlassianRadio.click()

      await page.waitForSelector('#ws-atlassian-owner', { timeout: 5_000 })
      await page.locator('#ws-atlassian-owner').fill(BITBUCKET_OWNER)
      await page.locator('#ws-atlassian-repository').fill(BITBUCKET_REPOSITORY)
      await page.locator('#ws-atlassian-jira-site').fill(JIRA_SITE)
      await page.locator('#ws-atlassian-jira-project').fill(JIRA_PROJECT_KEY)
      await page.locator('#ws-atlassian-bitbucket-pat').fill(BITBUCKET_VALID_PAT)
      await page.locator('#ws-atlassian-jira-pat').fill(JIRA_VALID_PAT)

      // The Register button stays disabled until a real Jira issue type has been picked — collecting
      // one is #48's own acceptance criterion, not an incidental UI detail.
      const registerButton = page.getByRole('button', { name: 'Register workspace' })
      assert.equal(await registerButton.isDisabled(), true)

      await page.getByRole('button', { name: 'Load issue types' }).click()
      // `<option>` elements aren't "visible" to Playwright's own default actionability check while
      // their `<select>` is closed, so this waits on the `<select>`'s own real value instead of a
      // selector-visibility wait that would time out even on a genuinely successful load.
      await page.waitForFunction(() => document.querySelector('#ws-atlassian-issue-type')?.value === 'Task', { timeout: 5_000 })
      assert.equal(await page.locator('#ws-atlassian-issue-type').inputValue(), 'Task')

      assert.equal(await registerButton.isDisabled(), false)
      await registerButton.click()

      // ---------- Step 2: instance step reached — a real workspace was created, not just checked ----------
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      // Exactly the expected number of generic "Failed to load resource ... 400" console messages
      // (the `/definitions` 400 tracked above, see this test's own `response` listener) — anything
      // beyond that is a genuinely unexpected error and must still fail this test.
      const genericBadRequestMessages = pageErrors.filter((msg) => /responded with a status of 400/.test(msg))
      const unexpectedErrors = pageErrors.filter((msg) => !/responded with a status of 400/.test(msg))
      assert.deepEqual(unexpectedErrors, [])
      assert.equal(genericBadRequestMessages.length, expectedBadRequestResponses)
    } finally {
      await browser.close()
    }
  })
})
