import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createInstance } from '../lib/instance.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser tests for WI #296 (Feature #290 / A5) — the client-side merge of
// "recent local workspaces" (web/lib/localWorkspace.js, IndexedDB) into the
// Workspaces landing page — reworked by WI #306 to blend these rows into the
// exact same list `groupInstancesByWorkspace` drives (MasterDetailView's own
// list pane), sorted to the top, rather than a separate "Local workspaces"
// card. Local workspaces have no server-side registry entry at all
// (ADR-0029), so every one of these seeds IndexedDB + an OPFS directory
// directly from the page rather than through the server.
//
// The dashboard reads `recentLocalWorkspaces()` once, on mount — so each
// test seeds IndexedDB/OPFS, then `page.reload()`s (same origin, so both
// survive the reload) rather than trying to race the app's own first read.

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

// Creates an OPFS directory holding gantry-workspace/<slug>/instance.yaml
// (when `slug` is given) and remembers it in the same IndexedDB store
// web/lib/localWorkspace.js's rememberWorkspace() writes to — the exact
// shape `recentLocalWorkspaces()`/`getWorkspaceHandle()` read back.
async function seedGrantedWorkspace(page, { id, name, slug }) {
  await page.evaluate(
    async ({ id, name, slug }) => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('lws-' + id, { create: true })
      if (slug) {
        const gw = await dir.getDirectoryHandle('gantry-workspace', { create: true })
        const instDir = await gw.getDirectoryHandle(slug, { create: true })
        const fh = await instDir.getFileHandle('instance.yaml', { create: true })
        const w = await fh.createWritable()
        await w.write(`definition: design\nslug: ${slug}\nstage: soap\n`)
        await w.close()
      }
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('gantry-local-workspaces', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' })
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('workspaces', 'readwrite')
          tx.objectStore('workspaces').put({ id, handle: dir, name, lastOpened: new Date().toISOString(), seq: 1 })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    },
    { id, name, slug }
  )
}

// A remembered workspace whose stored handle is a plain (structured-clone-
// able) object with none of the FileSystemDirectoryHandle permission methods
// — ensurePermission()'s optional-chained calls resolve to `undefined` for
// each, which its own contract maps to 'denied'. Stands in for a real
// denied/stale handle without needing a browser permission prompt to drive.
async function seedStaleWorkspace(page, { id, name }) {
  await page.evaluate(
    async ({ id, name }) => {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('gantry-local-workspaces', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' })
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('workspaces', 'readwrite')
          tx.objectStore('workspaces').put({ id, handle: {}, name, lastOpened: new Date().toISOString(), seq: 1 })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    },
    { id, name }
  )
}

async function remainingIndexedDbCount(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('gantry-local-workspaces', 1)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('workspaces', 'readonly')
          const all = tx.objectStore('workspaces').getAll()
          all.onsuccess = () => {
            db.close()
            resolve(all.result.length)
          }
          all.onerror = () => reject(all.error)
        }
        req.onerror = () => reject(req.error)
      })
  )
}

// Every group — local or server-hosted — renders through the exact same
// `.list-item` markup (WI #306: no dedicated "local row" selector any more,
// no per-row "Local" badge either) — resolved by its visible name instead.
function listItemNamed(page, name) {
  return page.locator('.instance-list .list-item', { hasText: name })
}

test('dashboard: a granted local workspace leads the blended list (position, not a badge), and its instance link navigates with ?local=&slug=', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'server-instance', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await seedGrantedWorkspace(page, { id: 'ws-1', name: 'My Local Workspace', slug: 'alpha' })
        await page.reload()

        // Doesn't block on the local workspace's own folder read — the
        // blended list itself is already up.
        await page.waitForSelector('.master-detail', { timeout: 10_000 })
        await page.waitForSelector('.instance-list .list-item', { timeout: 10_000 })

        // Eventually both rows are present, local leading — no separate
        // section/heading and no per-row "Local" badge (WI #306's resolved
        // design: position plus the subtitle-text difference is enough).
        await page.waitForFunction(
          () => document.querySelectorAll('.instance-list .list-item').length === 2,
          { timeout: 10_000 }
        )
        const names = await page.locator('.instance-list .list-item .meta .name').allTextContents()
        assert.deepEqual(names, ['My Local Workspace', 'server-instance'])
        assert.equal(await page.locator('.local-badge').count(), 0)
        assert.equal(await page.locator('.local-workspaces-heading').count(), 0)
        assert.equal(await page.locator('.local-workspaces').count(), 0)

        await listItemNamed(page, 'My Local Workspace').click()
        assert.equal(await page.locator('.workspace-subtitle').textContent(), 'Local workspace')

        await page.waitForSelector('.local-instance-row', { timeout: 10_000 })
        assert.equal(await page.locator('.local-instance-row').count(), 1)
        assert.equal(await page.locator('.local-instance-row .name').textContent(), 'alpha')

        await page.locator('.local-instance-row').click()
        await page.waitForURL(/\/instance\/alpha\?/, { timeout: 10_000 })
        const url = new URL(page.url())
        assert.equal(url.pathname, '/instance/alpha')
        assert.equal(url.searchParams.get('local'), 'ws-1')
        assert.equal(url.searchParams.get('slug'), 'alpha')

        // The unrelated, legacy server-side "local instance" concept
        // (ADR-0029) keeps its own distinct, renamed label (WI #306 item
        // 4) — never confusable with the new local *workspace* above. A
        // fresh navigation back to the dashboard (not page.goBack(), which
        // would leave the editor route's own instance/asset state
        // mid-teardown) keeps this assertion scoped to the dashboard.
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })
        await listItemNamed(page, 'server-instance').click()
        assert.equal(await page.locator('.workspace-subtitle').textContent(), 'Server instance')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: no IndexedDB entries leaves the dashboard identical to today (no local rows in the blended list)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })
        assert.equal(await page.locator('.local-workspaces').count(), 0)
        assert.equal(await page.locator('.instance-list .list-item').count(), 1)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: a denied/stale local workspace shows "Reconnect" recovery (not "Grant access") with no instance list, and Remove drops the row and forgets it', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })

        await seedStaleWorkspace(page, { id: 'ws-stale', name: 'Stale Workspace' })
        await page.reload()

        await page.waitForSelector('.master-detail', { timeout: 10_000 })
        await listItemNamed(page, 'Stale Workspace').click()

        await page.waitForSelector('.local-workspace-recovery', { timeout: 10_000 })
        assert.match(await page.locator('.local-workspace-recovery').textContent(), /Can't find this folder/)
        assert.equal(await page.locator('.local-instance-row').count(), 0)

        // WI #306's resolved relabel: "Reconnect", not "Grant access" —
        // access was already granted once; this is a repeat confirmation.
        assert.equal(
          await page.locator('.local-workspace-recovery').getByRole('button', { name: 'Reconnect' }).count(),
          1
        )
        assert.equal(
          await page.locator('.local-workspace-recovery').getByRole('button', { name: 'Grant access' }).count(),
          0
        )

        await page.locator('.local-workspace-recovery').getByRole('button', { name: 'Remove' }).click()
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })
        assert.equal(await remainingIndexedDbCount(page), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: local groups blend into the list with advanced mode both on and off', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await seedGrantedWorkspace(page, { id: 'ws-adv', name: 'Advanced-mode WS', slug: 'beta' })

        // Advanced mode off (default) — the local group still leads the list.
        await page.reload()
        await page.waitForFunction(
          () => document.querySelectorAll('.instance-list .list-item').length === 2,
          { timeout: 10_000 }
        )
        let names = await page.locator('.instance-list .list-item .meta .name').allTextContents()
        assert.equal(names[0], 'Advanced-mode WS')

        // Advanced mode on — the local group still leads, alongside the now-visible ADO surfaces.
        await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
        await page.reload()
        await page.waitForFunction(
          () => document.querySelectorAll('.instance-list .list-item').length === 2,
          { timeout: 10_000 }
        )
        names = await page.locator('.instance-list .list-item .meta .name').allTextContents()
        assert.equal(names[0], 'Advanced-mode WS')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: zero server-hosted instances but a remembered local workspace still renders the blended list, not the empty state', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })

        await seedGrantedWorkspace(page, { id: 'ws-only', name: 'Only Local Workspace', slug: 'solo' })
        await page.reload()

        await page.waitForSelector('.master-detail', { timeout: 10_000 })
        assert.equal(await page.locator('.dashboard-empty').count(), 0)
        assert.equal(await page.locator('.instance-list .list-item').count(), 1)
        assert.equal(await page.locator('.instance-list .list-item .meta .name').textContent(), 'Only Local Workspace')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
