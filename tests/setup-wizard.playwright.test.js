import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'

// Browser smoke test for the instance-setup wizard (#78) — the "progressive
// single page" variant from web/prototypes/instance-setup-wizard.prototype.html.
// Exercises all three validate(repoUrl) outcomes through the real page and
// real server, not a mocked stub: `empty` (an unregistered repo name),
// `existing` (a repo name matching the real `examples` fixture, already
// registered via the multi-instance registry, #76), and `error` (a URL
// gantry's stub can't even parse a repo name out of).
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

test('the setup wizard walks through empty, existing, and error validate(repoUrl) outcomes', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        // ---------- error outcome ----------
        await page.goto(`${base}/setup`)
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

        // ---------- empty outcome ----------
        await page.locator('#repo-url').fill('https://dev.azure.com/Contoso-Production/Default/_git/brand-new-instance')
        await page.getByRole('button', { name: 'Check repo' }).click()
        await page.waitForSelector('text=Empty repo', { timeout: 5_000 })
        await page.waitForSelector('#definition-picker', { timeout: 5_000 })
        await page.getByRole('button', { name: 'Create instance' }).click()
        await page.waitForSelector('text=Instance created', { timeout: 5_000 })

        // Registered via the listing API (#76) — genuinely landed where the
        // dashboard (#77) will read from, not just rendered in the browser.
        const registryAfterCreate = await (await fetch(`${base}/api/instances`)).json()
        assert.ok(registryAfterCreate.some((i) => i.slug === 'brand-new-instance'))

        await Promise.all([
          page.waitForNavigation({ timeout: 10_000 }),
          page.getByRole('button', { name: 'Open instance' }).click(),
        ])
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.locator('header h1').textContent(), 'brand-new-instance — design')

        // ---------- existing outcome ----------
        await page.goto(`${base}/setup`)
        await page.locator('#repo-url').fill('https://dev.azure.com/Contoso-Production/Default/_git/examples')
        await page.getByRole('button', { name: 'Check repo' }).click()
        await page.waitForSelector('text=Existing instance found', { timeout: 5_000 })
        const resultCard = page.locator('.result-card')
        assert.match(await resultCard.textContent(), /examples/)
        assert.match(await resultCard.textContent(), /design/)
        assert.match(await page.locator('.compare').textContent(), /Found in repo/)
        assert.match(await page.locator('.compare').textContent(), /You're about to use/)

        await Promise.all([
          page.waitForNavigation({ timeout: 10_000 }),
          page.getByRole('button', { name: 'Open instance' }).click(),
        ])
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(await page.locator('header h1').textContent(), 'examples — design')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// Regression test for a stale-response race found in review: clicking
// "Create instance" then abandoning it (editing the URL, checking a
// different repo) before the POST resolved used to still apply that stale
// create's completion — an "Instance created" card for the *abandoned*
// repo appearing on top of whatever the user had since moved on to
// checking. `createNewInstance()` now discards a completion superseded by
// a later edit (see `sessionToken` in web/pages/setup-wizard.js).
test('abandoning a "Create instance" in flight does not surface a stale success card for it later', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer({ instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()

        let slowNextPost = true
        await page.route('**/api/instances', async (route) => {
          if (route.request().method() === 'POST' && slowNextPost) {
            slowNextPost = false
            await new Promise((r) => setTimeout(r, 1000))
          }
          await route.continue()
        })

        await page.goto(`${base}/setup`)
        await page.waitForSelector('#repo-url', { timeout: 10_000 })

        // Start creating "repo-a", then abandon it before the (slowed) POST
        // resolves by switching to a different, unrelated "repo-b" check.
        await page.locator('#repo-url').fill('https://dev.azure.com/Contoso-Production/Default/_git/repo-a')
        await page.getByRole('button', { name: 'Check repo' }).click()
        await page.waitForSelector('text=Empty repo', { timeout: 5_000 })
        await page.getByRole('button', { name: 'Create instance' }).click()

        await page.locator('#repo-url').fill('https://dev.azure.com/Contoso-Production/Default/_git/repo-b')
        await page.getByRole('button', { name: 'Check repo' }).click()
        await page.waitForSelector('text=Empty repo', { timeout: 5_000 })

        // Give the abandoned repo-a create() time to resolve in the background.
        await page.waitForTimeout(1_500)

        assert.equal(
          await page.locator('#repo-url').inputValue(),
          'https://dev.azure.com/Contoso-Production/Default/_git/repo-b'
        )
        assert.equal(
          await page.locator('text=Instance created').count(),
          0,
          'a stale "Instance created" card for the abandoned repo-a create should not appear'
        )

        // The abandoned create still genuinely completed server-side (an
        // already-sent HTTP request can't be cancelled) — only the stale
        // *UI* update for it should be suppressed, not the actual effect.
        const registry = await (await fetch(`${base}/api/instances`)).json()
        assert.ok(registry.some((i) => i.slug === 'repo-a'))
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
