import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for the "+ New Workspace" wizard (#110, under #106's
// unified-wizard spec — docs/adr/0013-unified-workspace-creation-wizard.md
// on the `gantry-stage-advancement-and-workspace-wizard-adrs` branch),
// replacing tests/setup-wizard.playwright.test.js's old coverage of the
// URL-first "+ New instance" wizard it fully supersedes.
//
// Real, separate in-process fake Azure DevOps servers stand in for real
// repos (never a real dev.azure.com) — mirrors the old wizard's own test
// convention (tests/helpers/fakeAzureDevOpsServer.js, #84).

const ORGANIZATION = 'Contoso-Production'
const PROJECT = 'Default'
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

// Starts one fake Azure DevOps server per `[repository, files]` pair, then a
// real gantry server with `allowAzureDevOpsBaseUrlOverride: true` (so `POST
// /api/workspaces`/`POST /api/instances` accept a caller-supplied `baseUrl`
// at all) — real `gantry serve` never sets this, so a real deployment can
// never be pointed at an arbitrary caller-chosen host this way.
function withWizardTestServers(repoConfigs, fn) {
  async function startNext(remaining, baseUrlsByRepo) {
    if (remaining.length === 0) {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      return withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (gantryBase) => {
        try {
          await fn({ gantryBase, baseUrlsByRepo, instancesDir })
        } finally {
          rmSync(instancesDir, { recursive: true, force: true })
        }
      })
    }
    const [repository, files] = remaining[0]
    return withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository, validPat: VALID_PAT, files },
      (baseUrl) => startNext(remaining.slice(1), { ...baseUrlsByRepo, [repository]: baseUrl })
    )
  }
  return startNext(repoConfigs, {})
}

function repoUrlFor(repository) {
  return `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_git/${repository}`
}

// The "register new workspace" sub-form has no `baseUrl` field (production
// only ever targets the real dev.azure.com, mirroring the old wizard's own
// repo-URL field) — the one piece of test wiring the real form has no way
// to express itself. Intercepts the outgoing `POST /api/workspaces` request
// client-side and injects the fake server's real `baseUrl` before it
// reaches the real gantry server. Once a workspace is registered this way,
// its own record (persisted with that `baseUrl`) flows straight into every
// later `POST /api/instances` call the wizard makes against it — no
// separate interception needed for instance creation.
function installRegisterWorkspaceRoute(page, baseUrlsByRepo, { failFirst = false } = {}) {
  const authRequiredBody = JSON.stringify({
    error: 'authentication_required',
    message: 'A valid Azure DevOps Personal Access Token is required for this workspace.',
  })
  let alreadyFailed = false
  return page.route('**/api/workspaces', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    if (failFirst && !alreadyFailed) {
      alreadyFailed = true
      await route.fulfill({ status: 401, contentType: 'application/json', body: authRequiredBody })
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    const baseUrl = baseUrlsByRepo[body.repository]
    if (baseUrl) body.baseUrl = baseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })
}

async function signInWithPat(page, pat) {
  const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
  await modal.waitFor({ state: 'visible', timeout: 10_000 })
  await modal.locator('input[type=password]').fill(pat)
  await modal.getByRole('button', { name: 'Continue' }).click()
  await modal.waitFor({ state: 'hidden', timeout: 5_000 })
}

test('the New Workspace wizard registers a brand-new workspace (setting its Owner) and creates a first instance in it end-to-end', async () => {
  const REPO = 'brand-new-workspace'
  await withWizardTestServers([[REPO, {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await installRegisterWorkspaceRoute(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

      // No workspaces registered yet — "Pick existing workspace" (the
      // default sub-tab) says so rather than showing an empty list.
      await page.waitForSelector('text=No workspaces registered yet', { timeout: 5_000 })

      // ---------- register a brand-new workspace ----------
      await page.getByRole('button', { name: 'Register new workspace' }).click()
      await page.locator('#new-workspace-repo-url').fill(repoUrlFor(REPO))
      await page.locator('#new-workspace-owner').fill('Jordan Lee')
      await page.getByRole('button', { name: 'Register workspace' }).click()

      // ---------- instance fields ----------
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      // The just-registered workspace's own repo/owner are shown.
      assert.match(await page.locator('.result-card').first().textContent(), new RegExp(REPO))
      assert.match(await page.locator('.result-card').first().textContent(), /Jordan Lee/)

      await page.locator('#instance-name').fill('My First Initiative')
      // Directory auto-fills as a slugified version of Name, until touched.
      assert.equal(await page.locator('#instance-directory').inputValue(), 'my-first-initiative')
      await page.locator('#instance-assignee').fill('Alex Rivera')
      await page.getByRole('button', { name: 'Create instance' }).click()
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      // Genuinely written to the fake Azure DevOps repo and registered —
      // not just rendered in the browser.
      const registryAfterCreate = await (
        await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      const created = registryAfterCreate.find((i) => i.slug === 'my-first-initiative')
      assert.ok(created, 'the new instance should be registered')
      assert.equal(created.assignee, 'Alex Rivera')

      const workspacesAfterCreate = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      const workspace = workspacesAfterCreate.find((w) => w.repository === REPO)
      assert.ok(workspace, 'the new workspace should be registered')
      assert.equal(workspace.owner, 'Jordan Lee')
      assert.equal(workspace.ticketingSystem, 'azure-devops')

      await Promise.all([
        page.waitForNavigation({ timeout: 10_000 }),
        page.getByRole('button', { name: 'Open instance' }).click(),
      ])
      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(await page.locator('header h1').textContent(), 'my-first-initiative — design')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('the New Workspace wizard\'s "pick existing workspace" path lists an already-registered workspace and adds a second instance to it', async () => {
  const REPO = 'shared-workspace'
  await withWizardTestServers([[REPO, {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const baseUrl = baseUrlsByRepo[REPO]

    // Pre-register the workspace directly against the real gantry server
    // (as if an earlier session, or #126's future work-item-linked flow,
    // had already created it) and give it a first instance, so this test's
    // own "pick existing" path is adding a *second* instance to a workspace
    // that already has one.
    const registerRes = await fetch(`${gantryBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: REPO, baseUrl, owner: 'Sam Ng' }),
    })
    assert.equal(registerRes.status, 201)

    await fetch(`${gantryBase}/api/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
      body: JSON.stringify({
        definition: 'design',
        slug: 'first-initiative',
        azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: REPO, baseUrl },
      }),
    })

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('#workspace-picker', { timeout: 10_000 })
      const card = page.locator('#workspace-picker [data-workspace-id]')
      assert.equal(await card.count(), 1)
      assert.match(await card.textContent(), new RegExp(REPO))
      assert.match(await card.textContent(), /Sam Ng/)

      await card.click()
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      await page.locator('#instance-name').fill('Second Initiative')
      // Override Directory explicitly rather than accepting the slugified
      // default — it should stick even though Name keeps changing.
      await page.locator('#instance-directory').fill('second-initiative-custom')
      await page.locator('#instance-name').fill('Second Initiative (renamed)')
      assert.equal(await page.locator('#instance-directory').inputValue(), 'second-initiative-custom')

      await page.getByRole('button', { name: 'Create instance' }).click()
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      const registryAfterCreate = await (
        await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      const first = registryAfterCreate.find((i) => i.slug === 'first-initiative')
      const second = registryAfterCreate.find((i) => i.slug === 'second-initiative-custom')
      assert.ok(first, 'the pre-existing first instance is still registered')
      assert.ok(second, 'the newly-created second instance is registered')
      assert.equal(first.workspace.id, second.workspace.id, 'both instances belong to the same workspace')

      // Only one workspace was ever created — picking an existing one and
      // adding a second instance to it must not register a duplicate.
      const workspacesAfterCreate = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(workspacesAfterCreate.filter((w) => w.repository === REPO).length, 1)
    } finally {
      await browser.close()
    }
  })
})

test('a workspace registration made with no usable PAT triggers the PAT-prompt modal, and the original registration completes once a valid PAT is supplied', async () => {
  const REPO = 'pat-prompt-workspace'
  await withWizardTestServers([[REPO, {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await installRegisterWorkspaceRoute(page, baseUrlsByRepo, { failFirst: true })

      await page.goto(`${gantryBase}/new-workspace`)
      await page.getByRole('button', { name: 'Register new workspace' }).click()
      await page.locator('#new-workspace-repo-url').fill(repoUrlFor(REPO))
      await page.getByRole('button', { name: 'Register workspace' }).click()

      await signInWithPat(page, VALID_PAT)
      // The original registration completes once the PAT is supplied — no
      // need to click "Register workspace" a second time.
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      const stored = await page.evaluate(() => localStorage.getItem('gantry:ado-pat'))
      assert.equal(stored, VALID_PAT)
    } finally {
      await browser.close()
    }
  })
})

test('an invalid Directory value is flagged and disables "Create instance"', async () => {
  const REPO = 'directory-validation-workspace'
  await withWizardTestServers([[REPO, {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await installRegisterWorkspaceRoute(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.getByRole('button', { name: 'Register new workspace' }).click()
      await page.locator('#new-workspace-repo-url').fill(repoUrlFor(REPO))
      await page.getByRole('button', { name: 'Register workspace' }).click()
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      await page.locator('#instance-name').fill('Whatever')
      await page.locator('#instance-directory').fill('bad/directory')
      await page.waitForSelector('.inline-error', { timeout: 5_000 })
      assert.ok(await page.getByRole('button', { name: 'Create instance' }).isDisabled())

      await page.locator('#instance-directory').fill('good-directory')
      assert.equal(await page.locator('.inline-error').count(), 0)
      assert.ok(!(await page.getByRole('button', { name: 'Create instance' }).isDisabled()))
    } finally {
      await browser.close()
    }
  })
})

test('an empty Directory is silent while the form is untouched, but explained once Name has been typed into and cleared', async () => {
  const REPO = 'directory-pristine-workspace'
  await withWizardTestServers([[REPO, {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await installRegisterWorkspaceRoute(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.getByRole('button', { name: 'Register new workspace' }).click()
      await page.locator('#new-workspace-repo-url').fill(repoUrlFor(REPO))
      await page.getByRole('button', { name: 'Register workspace' }).click()
      await page.waitForSelector('#instance-name', { timeout: 10_000 })

      // Untouched: Directory is empty (Create is disabled) but nothing has
      // been typed anywhere yet, so no error is shown for it.
      assert.equal(await page.locator('.inline-error').count(), 0)
      assert.ok(await page.getByRole('button', { name: 'Create instance' }).isDisabled())

      // Typing a Name that slugifies to nothing usable (symbols only) is a
      // real, explained error — not silently disabled.
      await page.locator('#instance-name').fill('!!!')
      assert.equal(await page.locator('#instance-directory').inputValue(), '')
      await page.waitForSelector('.inline-error', { timeout: 5_000 })
      assert.match(await page.locator('.inline-error').textContent(), /can't be empty/)

      // Typing a *usable* Name and then clearing it back to empty ends up
      // in the exact same (Name: '', Directory: '') state as the untouched
      // start — but this is not the pristine case, since the user has
      // genuinely engaged with the form, so the same explanation must
      // still appear rather than silently going back to no error at all.
      await page.locator('#instance-name').fill('A Real Name')
      assert.equal(await page.locator('.inline-error').count(), 0)
      await page.locator('#instance-name').fill('')
      await page.waitForSelector('.inline-error', { timeout: 5_000 })
      assert.match(await page.locator('.inline-error').textContent(), /can't be empty/)
      assert.ok(await page.getByRole('button', { name: 'Create instance' }).isDisabled())
    } finally {
      await browser.close()
    }
  })
})

// Regression test for a stale-response race found in review: clicking
// "Create instance" then abandoning it (going back to pick a different
// workspace) before the POST resolved used to be able to silently apply
// that stale create's completion — an "Instance created" card for the
// *abandoned* workspace appearing on top of whatever the user had since
// moved on to. `createNewInstance()` discards a completion superseded by a
// later abandonment (see `sessionToken` in web/pages/new-workspace-wizard.js),
// mirroring the same guard the old, removed setup-wizard.js used for its own
// "Create instance"/"Open instance" flows.
test('abandoning a "Create instance" in flight (by going back to pick a different workspace) does not surface a stale success card for it later', async () => {
  const REPO_A = 'abandon-repo-a'
  const REPO_B = 'abandon-repo-b'
  await withWizardTestServers(
    [
      [REPO_A, {}],
      [REPO_B, {}],
    ],
    async ({ gantryBase, baseUrlsByRepo }) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))

        // Register both workspaces up front (direct API, not through the
        // wizard) so this test can go straight to "pick existing workspace"
        // for both, isolating the create-instance race from the
        // register-workspace flow already covered elsewhere.
        async function registerWorkspace(repo) {
          const res = await fetch(`${gantryBase}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: repo, baseUrl: baseUrlsByRepo[repo] }),
          })
          return res.json()
        }
        const workspaceA = await registerWorkspace(REPO_A)
        const workspaceB = await registerWorkspace(REPO_B)

        // Slow down the first POST /api/instances the browser makes, so
        // there's a real window to abandon it in before it resolves.
        let slowedFirst = false
        await page.route('**/api/instances', async (route) => {
          if (route.request().method() === 'POST' && !slowedFirst) {
            slowedFirst = true
            await new Promise((r) => setTimeout(r, 1000))
          }
          await route.continue()
        })
        await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

        await page.goto(`${gantryBase}/new-workspace`)
        await page.waitForSelector('#workspace-picker', { timeout: 10_000 })

        // Start creating "instance-a" in workspace A (the slowed request).
        await page.locator(`#workspace-picker [data-workspace-id="${workspaceA.id}"]`).click()
        await page.waitForSelector('#instance-name', { timeout: 10_000 })
        await page.locator('#instance-name').fill('Instance A')
        await page.getByRole('button', { name: 'Create instance' }).click()

        // Abandon it before it resolves: go back and pick workspace B instead.
        await page.getByRole('button', { name: 'Choose a different workspace' }).click()
        await page.waitForSelector('#workspace-picker', { timeout: 10_000 })
        await page.locator(`#workspace-picker [data-workspace-id="${workspaceB.id}"]`).click()
        await page.waitForSelector('#instance-name', { timeout: 10_000 })

        // Give the abandoned instance-a create time to resolve in the background.
        await page.waitForTimeout(1_500)

        assert.equal(
          await page.locator('text=Instance created').count(),
          0,
          'a stale "Instance created" card for the abandoned workspace-A create should not appear'
        )
        assert.match(
          await page.locator('.result-card').first().textContent(),
          new RegExp(REPO_B),
          'still showing workspace B, not silently swapped back by the stale response'
        )

        // The abandoned create still genuinely completed server-side (an
        // already-sent HTTP request can't be cancelled) — only the stale
        // *UI* update for it should be suppressed, not the actual effect.
        const registry = await (
          await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
        ).json()
        assert.ok(registry.some((i) => i.slug === 'instance-a'))

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    }
  )
})

// Regression test for stale wizard state surviving a client-side (not full
// page reload) navigation away from and back to the wizard: the module-scope
// signals this page's state lives in (see the header comment) intentionally
// persist across such a navigation while a wizard is still in progress, but
// must not leave a *completed* wizard's "Instance created" card sitting
// there for the next visit.
test('re-opening "+ New Workspace" after a completed creation (via client-side navigation, no full reload) shows a fresh wizard, not the previous result', async () => {
  const REPO = 'remount-reset-workspace'
  await withWizardTestServers([[REPO, {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await installRegisterWorkspaceRoute(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.getByRole('button', { name: 'Register new workspace' }).click()
      await page.locator('#new-workspace-repo-url').fill(repoUrlFor(REPO))
      await page.getByRole('button', { name: 'Register workspace' }).click()
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await page.locator('#instance-name').fill('Remount Test')
      await page.getByRole('button', { name: 'Create instance' }).click()
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      // Navigate home via the wizard's own client-side link (not
      // "Open instance", which does a full page load and so trivially
      // re-initializes everything) then back into the wizard the same way —
      // preact-iso intercepts these same-origin clicks rather than doing a
      // full reload, so this page's module-scope state genuinely survives
      // unless the page itself resets it.
      await page.locator('a', { hasText: '← Workspaces' }).click()
      await page.waitForSelector('.dashboard-topbar', { timeout: 10_000 })
      await page.locator('.dashboard-topbar').getByRole('link', { name: '+ New Workspace' }).click()
      await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

      assert.equal(
        await page.locator('text=Instance created').count(),
        0,
        'the previous completed instance\'s success card must not still be showing'
      )
      assert.ok(
        await page.getByRole('button', { name: 'Pick existing workspace' }).isVisible(),
        'back at the workspace-selection step, not still parked on the instance step'
      )

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})
