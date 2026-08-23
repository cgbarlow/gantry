import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'

// Browser smoke test for the instance dashboard (#77) — the landing screen
// at `/`, backed by the multi-instance registry (`GET /api/instances`, #76).
// Mirrors tests/module-editor.playwright.test.js's pattern: a real server,
// a real Chromium page, asserting no console/page errors alongside the
// ticket's acceptance criteria — master-detail default, a working toggle
// to stage swimlanes, the view choice persisting across a reload (via
// localStorage), and the empty state's "new instance" call to action.
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
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
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

test('dashboard: master-detail is the default view, lists instances, and its detail pane shows stage/gate/status/owner', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir, owner: 'c.barlow' })
    createInstance('design', 'zebra-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        assert.equal(await page.locator('.dashboard-topbar h1').textContent(), 'Instances')
        assert.equal(await page.locator('.instance-list .list-item').count(), 2)
        assert.equal(await page.locator('.view-toggle button.active').textContent(), 'Master-detail')

        // First instance (sorted: alpha-initiative) is selected by default.
        await page.waitForSelector('.detail-ledger', { timeout: 10_000 })
        assert.equal(await page.locator('.detail-pane h2').textContent(), 'alpha-initiative')
        assert.match(await page.locator('.detail-ledger .stage').textContent(), /Shape/)
        assert.match(await page.locator('.detail-ledger').textContent(), /business-case/)
        assert.match(await page.locator('.detail-ledger').textContent(), /c\.barlow/)
        assert.ok(await page.getByRole('button', { name: 'Check' }).isVisible())
        assert.ok(await page.getByRole('button', { name: 'Render' }).isVisible())
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: toggling to stage swimlanes groups instances into lanes by current stage, and the choice persists across a reload', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await page.getByRole('button', { name: 'Stage swimlanes' }).click()
        await page.waitForSelector('.swimlanes', { timeout: 10_000 })
        assert.ok(await page.locator('.lane').count() >= 4, 'expected one lane per design stage')
        assert.match(await page.locator('.lane').first().textContent(), /Shape/)
        assert.equal(await page.locator('.chip .name').first().textContent(), 'alpha-initiative')

        // Reload — the view choice (localStorage) survives, so swimlanes
        // renders again without needing to re-toggle.
        await page.reload()
        await page.waitForSelector('.swimlanes', { timeout: 10_000 })
        assert.equal(await page.locator('.view-toggle button.active').textContent(), 'Stage swimlanes')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: swimlane chip overflow menu can open the module editor for that instance', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.getByRole('button', { name: 'Stage swimlanes' }).click()
        await page.waitForSelector('.chip', { timeout: 10_000 })

        await page.locator('.chip .menu-btn').click()
        await page.getByRole('link', { name: 'Open' }).click()
        await page.waitForSelector('.module', { timeout: 10_000 })
        assert.equal(page.url(), `${base}/instance/alpha-initiative`)
        assert.match(await page.locator('header h1').textContent(), /alpha-initiative/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: empty state renders a "new instance" call to action when no instances are registered', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
        assert.equal(await page.locator('.view-toggle').count(), 0, 'no view toggle when there is nothing to view')

        await page.locator('.dashboard-empty').getByRole('link', { name: '+ New instance' }).click()
        await page.waitForSelector('h2:has-text("New instance")', { timeout: 10_000 })
        assert.equal(page.url(), `${base}/setup`)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// The dashboard topbar's own "+ New instance" link is what makes creating a
// new instance reachable without an instance already open — before this, it
// only existed in the module editor's header (AppHeader) and the empty
// state's one-off call to action (the test above), so a dashboard already
// listing instances had no way to start another one.
test('dashboard: topbar "new instance" link works even when instances are already registered', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await page.locator('.dashboard-topbar').getByRole('link', { name: '+ New instance' }).click()
        await page.waitForSelector('h2:has-text("New instance")', { timeout: 10_000 })
        assert.equal(page.url(), `${base}/setup`)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
