import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for the instance-setup wizard's real (unstubbed) validate(repoUrl)/instance-creation/instance-adoption flow (#94, under #88) — the "progressive single page" variant from web/prototypes/instance-setup-wizard.prototype.html, now driven by the live Azure DevOps repo-check (#90), instance-creation (#93), and instance-adoption (#94) routes instead of #78's original stub (which only ever compared a URL's last path segment against gantry's own already-known instances).
//
// Real, separate in-process fake Azure DevOps servers stand in for real repos the architect might paste a URL to (#84's fake server, never a real dev.azure.com): `EXISTING_REPO` (already has a full instance.yaml + shape-stage modules — the "existing instance found" outcome) and `EMPTY_REPO` (nothing in it yet — the "empty repo" -> create-instance outcome). The wizard's own URL field only ever expresses the standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape (per #94's explicit scope — no on-premises baseUrl support), so each fake server's real `baseUrl` is injected into the browser's own outgoing requests via `page.route` — mirroring how tests/serverAzureDevOpsRepoCheck.test.js/tests/server.test.js inject a test-only `baseUrl` at the HTTP layer, just done here for a real browser tab's traffic instead of a direct `fetch` call.
const ORGANIZATION = 'Contoso-Production'
const PROJECT = 'Default'
const EXISTING_REPO = 'claims-modernisation'
const EMPTY_REPO = 'brand-new-instance'
const VALID_PAT = 'valid-test-pat'

const EXISTING_REPO_FILES = {
  '/instance.yaml': 'definition: design\nslug: claims-modernisation\nstage: shape\n',
  '/modules/context.md': readFileSync('instances/examples/modules/context.md', 'utf8'),
  '/modules/solution-definition.md': readFileSync('instances/examples/modules/solution-definition.md', 'utf8'),
  '/modules/team-and-estimates.md': readFileSync('instances/examples/modules/team-and-estimates.md', 'utf8'),
}

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

// Starts one fake Azure DevOps server per `[repository, files]` pair in `repoConfigs`, then a real gantry server whose `allowedAzureDevOpsBaseUrls` allow-list includes every one of those fake servers' real base URLs (so it's willing to honour a test-supplied `baseUrl` override for any of them) plus `allowAzureDevOpsBaseUrlOverride: true` (so `POST /api/instances`/`POST /api/instances/adopt` accept one too) — real `gantry serve` never sets either option, so a real deployment can never be directed to an arbitrary caller-chosen host this way (see tests/serverAzureDevOpsRepoCheck.test.js's own dedicated coverage of that default-off behaviour). `fn` receives `{ gantryBase, baseUrlsByRepo, instancesDir }`, where `baseUrlsByRepo` maps each configured repository name to its fake server's real base URL.
function withWizardTestServers(repoConfigs, fn) {
  async function startNext(remaining, baseUrlsByRepo) {
    if (remaining.length === 0) {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      return withRunningServer(
        { instancesDir, allowedAzureDevOpsBaseUrls: Object.values(baseUrlsByRepo), allowAzureDevOpsBaseUrlOverride: true },
        async (gantryBase) => {
          try {
            await fn({ gantryBase, baseUrlsByRepo, instancesDir })
          } finally {
            rmSync(instancesDir, { recursive: true, force: true })
          }
        }
      )
    }
    const [repository, files] = remaining[0]
    return withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository, validPat: VALID_PAT, files },
      (baseUrl) => startNext(remaining.slice(1), { ...baseUrlsByRepo, [repository]: baseUrl })
    )
  }
  return startNext(repoConfigs, {})
}

const STANDARD_REPO_CONFIGS = [
  [EXISTING_REPO, EXISTING_REPO_FILES],
  [EMPTY_REPO, {}],
]

function repoUrlFor(repository) {
  return `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_git/${repository}`
}

// Installs the one set of `page.route` handlers every test below needs — a single handler per pattern (not stacked across tests/helpers), since Playwright runs multiple handlers registered against the same pattern in *reverse* registration order and `route.continue()` sends the request straight to the network rather than falling through to an earlier-registered handler, so layering a second, independently-purposed handler on the same pattern would silently defeat the first one.
//
// Always injects the real fake-server `baseUrl` matching whichever repository name the request names (the one piece of test wiring the real wizard UI has no way to express itself — #94's URL field never collects a `baseUrl`). `failFirstCheck`/`failFirstCreate` additionally make the *first* matching repo-check/instance-creation request look exactly like Azure DevOps rejecting (or gantry never receiving) a usable PAT — the same structured `authentication_required` response `lib/server.js`'s `sendAuthenticationRequired` produces — so the PAT-prompt-and-retry-once path can be exercised deterministically, without depending on real PAT validation timing.
function installRoutes(page, baseUrlsByRepo, { failFirstCheck = false, failFirstCreate = false } = {}) {
  const authRequiredBody = JSON.stringify({
    error: 'authentication_required',
    message: 'A valid Azure DevOps Personal Access Token is required for this instance.',
  })

  let checkAlreadyFailed = false
  const routeRepoCheck = page.route('**/api/azure-devops/repo-check*', async (route) => {
    if (failFirstCheck && !checkAlreadyFailed) {
      checkAlreadyFailed = true
      await route.fulfill({ status: 401, contentType: 'application/json', body: authRequiredBody })
      return
    }
    const url = new URL(route.request().url())
    const baseUrl = baseUrlsByRepo[url.searchParams.get('repository')]
    if (baseUrl) url.searchParams.set('baseUrl', baseUrl)
    await route.continue({ url: url.toString() })
  })

  let createAlreadyFailed = false
  const routeInstances = page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    if (failFirstCreate && !createAlreadyFailed) {
      createAlreadyFailed = true
      await route.fulfill({ status: 401, contentType: 'application/json', body: authRequiredBody })
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    const baseUrl = body.azureDevOps ? baseUrlsByRepo[body.azureDevOps.repository] : undefined
    if (baseUrl) body.azureDevOps.baseUrl = baseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  const routeAdopt = page.route('**/api/instances/adopt', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    const baseUrl = body.azureDevOps ? baseUrlsByRepo[body.azureDevOps.repository] : undefined
    if (baseUrl) body.azureDevOps.baseUrl = baseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })

  return Promise.all([routeRepoCheck, routeInstances, routeAdopt])
}

async function signInWithPat(page, pat) {
  const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
  await modal.waitFor({ state: 'visible', timeout: 10_000 })
  await modal.locator('input[type=password]').fill(pat)
  await modal.getByRole('button', { name: 'Continue' }).click()
  await modal.waitFor({ state: 'hidden', timeout: 5_000 })
}

test('the setup wizard walks through empty, existing, and error validate(repoUrl) outcomes against real (fake-server-backed) Azure DevOps repos', async () => {
  await withWizardTestServers(STANDARD_REPO_CONFIGS, async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await installRoutes(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      // ---------- error outcome: a URL that doesn't parse ----------
      await page.goto(`${gantryBase}/setup`)
      await page.waitForSelector('#repo-url', { timeout: 10_000 })
      await page.locator('#repo-url').fill('not a valid repo url')
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('.dismiss-banner', { timeout: 5_000 })
      assert.match(await page.locator('.dismiss-banner').textContent(), /Error/)
      // Dismissing the banner never clears the URL field.
      await page.locator('.dismiss-banner button[aria-label="Dismiss"]').click()
      await assert.rejects(page.waitForSelector('.dismiss-banner', { timeout: 500 }))
      assert.equal(await page.locator('#repo-url').inputValue(), 'not a valid repo url')
      // No definition picker appears for a failed check.
      assert.equal(await page.locator('#definition-picker').count(), 0)

      // A well-formed but non-dev.azure.com base URL is the same explicit, known-gap error, not a crash or silent no-op.
      await page.locator('#repo-url').fill('https://ado.internal.example.com/org/project/_git/repo')
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('.dismiss-banner', { timeout: 5_000 })
      assert.match(await page.locator('.dismiss-banner').textContent(), /dev\.azure\.com/)

      // ---------- empty outcome ----------
      await page.locator('#repo-url').fill(repoUrlFor(EMPTY_REPO))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Empty repo', { timeout: 5_000 })
      await page.waitForSelector('#definition-picker', { timeout: 5_000 })
      await page.getByRole('button', { name: 'Create instance' }).click()
      await page.waitForSelector('text=Instance created', { timeout: 5_000 })

      // Genuinely written to the fake Azure DevOps repo — not just rendered in the browser — and registered via the listing API (#93), which is what makes it show up where the dashboard (#77) will read from.
      const registryAfterCreate = await (
        await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      assert.ok(registryAfterCreate.some((i) => i.slug === EMPTY_REPO))

      await Promise.all([
        page.waitForNavigation({ timeout: 10_000 }),
        page.getByRole('button', { name: 'Open instance' }).click(),
      ])
      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(await page.locator('header h1').textContent(), `${EMPTY_REPO} — design`)

      // ---------- existing outcome ----------
      await page.goto(`${gantryBase}/setup`)
      await page.locator('#repo-url').fill(repoUrlFor(EXISTING_REPO))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Existing instance found', { timeout: 5_000 })
      const resultCard = page.locator('.result-card')
      assert.match(await resultCard.textContent(), /claims-modernisation/)
      assert.match(await resultCard.textContent(), /design/)
      assert.match(await page.locator('.compare').textContent(), /Found in repo/)
      assert.match(await page.locator('.compare').textContent(), /You're about to use/)

      await Promise.all([
        page.waitForNavigation({ timeout: 10_000 }),
        page.getByRole('button', { name: 'Open instance' }).click(),
      ])
      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(await page.locator('header h1').textContent(), 'claims-modernisation — design')

      // "Open instance" doesn't just load the module editor — it genuinely allows editing this (adopted, Azure-DevOps-backed) instance's modules end-to-end: an edit here round-trips through PUT /api/instance/modules/:id to the real fake Azure DevOps repo.
      const editedText = 'Edited via the setup wizard\'s "Open instance" on an adopted, existing instance.'
      await page.locator('.field-markdown .cm-content').first().click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type(editedText)
      await page.getByRole('button', { name: 'Save Context' }).click()
      await page.waitForSelector('text=Saved', { timeout: 5_000 })

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('a repo check or instance creation made with no usable PAT triggers the PAT-prompt modal, and the original action completes once a valid PAT is supplied', async () => {
  await withWizardTestServers(STANDARD_REPO_CONFIGS, async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      // The *first* repo-check and *first* instance-creation request each look exactly like gantry's structured "authentication required" response — deterministically exercising apiFetch's prompt-and-retry-once path, without depending on real PAT validation timing (see installRoutes' own comment).
      await installRoutes(page, baseUrlsByRepo, { failFirstCheck: true, failFirstCreate: true })

      await page.goto(`${gantryBase}/setup`)
      await page.waitForSelector('#repo-url', { timeout: 10_000 })

      // ---------- repo check ----------
      await page.locator('#repo-url').fill(repoUrlFor(EXISTING_REPO))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await signInWithPat(page, VALID_PAT)
      // The original check completes once the PAT is supplied — no need to click "Check repo" a second time.
      await page.waitForSelector('text=Existing instance found', { timeout: 10_000 })
      const stored = await page.evaluate(() => localStorage.getItem('gantry:ado-pat'))
      assert.equal(stored, VALID_PAT)

      // ---------- instance creation ----------
      await page.locator('#repo-url').fill(repoUrlFor(EMPTY_REPO))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Empty repo', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Create instance' }).click()
      await signInWithPat(page, VALID_PAT)
      // The original create completes once the PAT is supplied — no need to click "Create instance" a second time.
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })
    } finally {
      await browser.close()
    }
  })
})

// Regression test for a stale-response race found in review: clicking "Create instance" then abandoning it (editing the URL, checking a different repo) before the POST resolved used to still apply that stale create's completion — an "Instance created" card for the *abandoned* repo appearing on top of whatever the user had since moved on to checking. `createNewInstance()` discards a completion superseded by a later edit (see `sessionToken` in web/pages/setup-wizard.js).
test('abandoning a "Create instance" in flight does not surface a stale success card for it later', async () => {
  await withWizardTestServers([...STANDARD_REPO_CONFIGS, ['repo-a', {}], ['repo-b', {}]], async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await installRoutes(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      let slowNextPost = true
      await page.route('**/api/instances', async (route) => {
        if (route.request().method() === 'POST' && slowNextPost) {
          slowNextPost = false
          await new Promise((r) => setTimeout(r, 1000))
        }
        const body = JSON.parse(route.request().postData() ?? '{}')
        const baseUrl = body.azureDevOps ? baseUrlsByRepo[body.azureDevOps.repository] : undefined
        if (baseUrl) body.azureDevOps.baseUrl = baseUrl
        await route.continue({ postData: JSON.stringify(body) })
      })

      await page.goto(`${gantryBase}/setup`)
      await page.waitForSelector('#repo-url', { timeout: 10_000 })

      // Start creating "repo-a", then abandon it before the (slowed) POST resolves by switching to a different, unrelated "repo-b" check.
      await page.locator('#repo-url').fill(repoUrlFor('repo-a'))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Empty repo', { timeout: 5_000 })
      await page.getByRole('button', { name: 'Create instance' }).click()

      await page.locator('#repo-url').fill(repoUrlFor('repo-b'))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Empty repo', { timeout: 5_000 })

      // Give the abandoned repo-a create() time to resolve in the background.
      await page.waitForTimeout(1_500)

      assert.equal(await page.locator('#repo-url').inputValue(), repoUrlFor('repo-b'))
      assert.equal(
        await page.locator('text=Instance created').count(),
        0,
        'a stale "Instance created" card for the abandoned repo-a create should not appear'
      )

      // The abandoned create still genuinely completed server-side (an already-sent HTTP request can't be cancelled) — only the stale *UI* update for it should be suppressed, not the actual effect.
      const registry = await (
        await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      assert.ok(registry.some((i) => i.slug === 'repo-a'))
    } finally {
      await browser.close()
    }
  })
})

// Regression test for the same class of race in the "existing instance found" -> "Open instance" path: editing the URL mid-adopt must abandon that stale in-flight adopt, exactly as the "empty repo" -> "Create instance" path already does above.
test('editing the URL while "Open instance" is adopting an existing instance abandons that stale in-flight request', async () => {
  await withWizardTestServers(STANDARD_REPO_CONFIGS, async ({ gantryBase, baseUrlsByRepo }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await installRoutes(page, baseUrlsByRepo)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      let slowNextAdopt = true
      await page.route('**/api/instances/adopt', async (route) => {
        if (slowNextAdopt) {
          slowNextAdopt = false
          await new Promise((r) => setTimeout(r, 1000))
        }
        const body = JSON.parse(route.request().postData() ?? '{}')
        const baseUrl = body.azureDevOps ? baseUrlsByRepo[body.azureDevOps.repository] : undefined
        if (baseUrl) body.azureDevOps.baseUrl = baseUrl
        await route.continue({ postData: JSON.stringify(body) })
      })

      await page.goto(`${gantryBase}/setup`)
      await page.waitForSelector('#repo-url', { timeout: 10_000 })

      await page.locator('#repo-url').fill(repoUrlFor(EXISTING_REPO))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Existing instance found', { timeout: 5_000 })
      await page.getByRole('button', { name: 'Open instance' }).click()

      // Abandon it before the (slowed) adopt resolves.
      await page.locator('#repo-url').fill(repoUrlFor(EMPTY_REPO))
      await page.getByRole('button', { name: 'Check repo' }).click()
      await page.waitForSelector('text=Empty repo', { timeout: 5_000 })

      // No navigation away from /setup happened as a side effect of the abandoned adopt resolving in the background.
      await page.waitForTimeout(1_500)
      assert.match(page.url(), /\/setup$/)
      assert.equal(await page.locator('#repo-url').inputValue(), repoUrlFor(EMPTY_REPO))
    } finally {
      await browser.close()
    }
  })
})
