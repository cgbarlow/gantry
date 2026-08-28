import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for the module editor's instance switcher (#112) — a
// workspace-scoped switcher in AppHeader letting an author jump straight
// to a sibling instance, or explicitly cross into a different workspace's
// instances, without returning to the Workspaces landing page. Mirrors
// tests/dashboard.playwright.test.js's own multi-instance-workspace setup
// (two slugs registered against the same fake Azure DevOps repo share one
// auto-created workspace, per #96) alongside a separate local instance
// (Workspace is an Azure-DevOps-repo concept only, #96 — a local instance
// groups on its own, per lib/registry.js/web/app.js's groupInstancesByWorkspace).
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

function withPage(fn) {
  return async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await fn(page, base)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }
}

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SEED_FILES = {
  '/gantry-workspace/instance-one/instance.yaml': 'definition: design\nstage: shape\n',
  '/gantry-workspace/instance-two/instance.yaml': 'definition: design\nstage: shape\n',
}

test('instance switcher: defaults to the current workspace\'s other instances, and switching never returns to the Workspaces landing page', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        const location = { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }
        registerInstance('instance-one', location, { instancesDir })
        registerInstance('instance-two', location, { instancesDir })
        createInstance('design', 'local-initiative', { instancesDir })

        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          withPage(async (page, base) => {
            // A PAT is required for the Azure-DevOps-backed instances — seeded
            // into localStorage before navigating, mirroring
            // tests/dashboard.playwright.test.js's own technique.
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

            await page.goto(`${base}/instance/instance-one`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            await page.getByRole('button', { name: 'Switch instance' }).click()
            const menu = page.locator('.instance-switcher .menu')
            await menu.waitFor({ state: 'visible', timeout: 5_000 })

            // Defaults to this workspace's own other instances — its one
            // sibling, instance-two, not instance-one itself.
            assert.equal(await menu.locator('.switcher-heading').first().textContent(), REPOSITORY)
            assert.equal(await menu.locator('.switcher-item').count(), 1)
            assert.equal(await menu.locator('.switcher-item .name').textContent(), 'instance-two')

            // Following it switches instances without ever navigating through
            // the Workspaces landing page ("/").
            await menu.locator('.switcher-item').click()
            await page.waitForSelector('.module', { timeout: 10_000 })
            // Canonical numeric reference (WI200, docs/adr/0024): the workspace shared by instance-one/instance-two is
            // the first (and only) real Azure DevOps workspace registered, so it's workspace 1 — instance-two is its
            // second instance in alphabetical listing order.
            assert.equal(page.url(), `${base}/instance/w1i2`)
            assert.match(await page.locator('header h1').textContent(), /instance-two/)

            // Re-opened on instance-two: its own sibling is instance-one, and
            // the escape hatch into other workspaces is offered since
            // local-initiative's workspace also exists.
            await page.getByRole('button', { name: 'Switch instance' }).click()
            await menu.waitFor({ state: 'visible', timeout: 5_000 })
            assert.equal(await menu.locator('.switcher-item .name').textContent(), 'instance-one')
            const escapeButton = menu.getByRole('button', { name: 'Browse other instances →' })
            await assert.doesNotReject(escapeButton.waitFor({ timeout: 2_000 }))

            // The explicit escape hatch crosses into a different workspace's
            // instances — local-initiative's own (single-instance) group.
            await escapeButton.click()
            await assert.doesNotReject(
              menu.locator('.switcher-group', { hasText: 'local-initiative' }).waitFor({ timeout: 2_000 })
            )
            await menu.locator('.switcher-item', { hasText: 'local-initiative' }).click()
            await page.waitForSelector('.module', { timeout: 10_000 })
            // local-initiative has no real Azure DevOps workspace of its own — workspace 0 (LOCAL_WORKSPACE_NUMBER),
            // instance 1 (the only local instance registered).
            assert.equal(page.url(), `${base}/instance/w0i1`)
            assert.match(await page.locator('header h1').textContent(), /local-initiative/)
          })
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('instance switcher: a local instance (no workspace) says so without claiming a workspace, and clicking outside the panel closes it', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })
    createInstance('design', 'zebra-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(`${base}/instance/alpha-initiative`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        await page.getByRole('button', { name: 'Switch instance' }).click()
        const menu = page.locator('.instance-switcher .menu')
        await menu.waitFor({ state: 'visible', timeout: 5_000 })

        // A local instance has no workspace siblings of its own — and the
        // empty-state copy must not claim "workspace" for it (Workspace is
        // a reserved, Azure-DevOps-repo-only entity, docs/adr/0009).
        assert.equal(await menu.locator('.switcher-heading').first().textContent(), 'Local instance')
        assert.match(await menu.locator('.switcher-empty').textContent(), /not part of a workspace/)
        // But zebra-initiative's own (separate, local) group is still
        // reachable via the escape hatch — worded generically ("Browse
        // other instances", not "Switch workspace") since the destination
        // here is another local instance, not a real Workspace.
        await menu.getByRole('button', { name: 'Browse other instances →' }).click()
        await assert.doesNotReject(
          menu.locator('.switcher-group', { hasText: 'zebra-initiative' }).waitFor({ timeout: 2_000 })
        )

        // Clicking outside the panel closes it.
        await page.locator('body').click({ position: { x: 5, y: 5 } })
        await menu.waitFor({ state: 'hidden', timeout: 2_000 })
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Regression coverage: the switcher must attach the *viewed instance's own*
// workspace PAT override (#104), not only the global default, when it
// fetches `GET /api/instances` to build its own listing. Without that, a
// workspace whose override PAT differs from the global default (the exact
// scenario #104 exists for) would have every one of its rows — including
// the very instance whose own page is asking — silently fail to
// authenticate and drop out of the response, leaving the switcher
// incorrectly reporting "Local instance"/no siblings for a real,
// multi-instance workspace. Here the global default is deliberately left
// unset (and, if it were used, would be be rejected outright) — only a
// workspace-specific override is seeded — so this only passes if the
// switcher resolves and attaches that override itself.
test('instance switcher: still shows the current workspace\'s real siblings when only a workspace-specific PAT override (not the global default) is set', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        const location = { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }
        registerInstance('instance-one', location, { instancesDir })
        registerInstance('instance-two', location, { instancesDir })

        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          withPage(async (page, base) => {
            // Look up the real workspace id this slug resolves to (the same
            // credential-free lookup web/lib/apiFetch.js's own
            // `resolveWorkspaceIdForSlug` performs) so the override can be
            // seeded under the right key.
            const { workspaceId } = await (await fetch(`${base}/api/instance/workspace?slug=instance-one`)).json()
            assert.ok(workspaceId, 'expected instance-one to resolve to a real workspace id')

            // Only a workspace-specific override is seeded — the global
            // default (`gantry:ado-pat`) is left unset entirely.
            await page.addInitScript(
              ({ key, pat }) => localStorage.setItem('gantry:ado-pat-overrides', JSON.stringify({ [key]: pat })),
              { key: workspaceId, pat: VALID_PAT }
            )

            await page.goto(`${base}/instance/instance-one`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            await page.getByRole('button', { name: 'Switch instance' }).click()
            const menu = page.locator('.instance-switcher .menu')
            await menu.waitFor({ state: 'visible', timeout: 5_000 })

            // Correctly identified as the real workspace (not misreported
            // as "Local instance"), with its real sibling listed.
            assert.equal(await menu.locator('.switcher-heading').first().textContent(), REPOSITORY)
            assert.equal(await menu.locator('.switcher-item').count(), 1)
            assert.equal(await menu.locator('.switcher-item .name').textContent(), 'instance-two')
          })
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})
