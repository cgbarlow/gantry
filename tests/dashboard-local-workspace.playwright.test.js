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
// Workspaces landing page. Local workspaces have no server-side registry
// entry at all (ADR-0029), so every one of these seeds IndexedDB + an OPFS
// directory directly from the page rather than through the server.
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

test('dashboard: a granted local workspace shows a "Local" row with its instances, and clicking one navigates with ?local=&slug=', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })

        await seedGrantedWorkspace(page, { id: 'ws-1', name: 'My Local Workspace', slug: 'alpha' })
        await page.reload()

        await page.waitForSelector('.local-workspace-row', { timeout: 10_000 })
        assert.equal(await page.locator('.local-workspaces-heading').textContent(), 'Local workspaces')
        assert.equal(await page.locator('.local-workspace-head .name').textContent(), 'My Local Workspace')
        assert.equal(await page.locator('.local-badge').textContent(), 'Local')

        await page.waitForSelector('.local-instance-row', { timeout: 10_000 })
        assert.equal(await page.locator('.local-instance-row').count(), 1)
        assert.equal(await page.locator('.local-instance-row .name').textContent(), 'alpha')

        await page.locator('.local-instance-row').click()
        await page.waitForURL(/\/instance\/alpha\?/, { timeout: 10_000 })
        const url = new URL(page.url())
        assert.equal(url.pathname, '/instance/alpha')
        assert.equal(url.searchParams.get('local'), 'ws-1')
        assert.equal(url.searchParams.get('slug'), 'alpha')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: no IndexedDB entries leaves the dashboard identical to today (no Local section)', async () => {
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

test('dashboard: a denied/stale local workspace shows the recovery state, and Remove drops the row and forgets it', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.dashboard-empty', { timeout: 10_000 })

        await seedStaleWorkspace(page, { id: 'ws-stale', name: 'Stale Workspace' })
        await page.reload()

        await page.waitForSelector('.local-workspace-recovery', { timeout: 10_000 })
        assert.match(await page.locator('.local-workspace-recovery').textContent(), /Can't find this folder/)
        assert.equal(await page.locator('.local-instance-row').count(), 0)

        await page.locator('.local-workspace-recovery').getByRole('button', { name: 'Remove' }).click()
        await page.waitForSelector('.local-workspace-row', { state: 'detached', timeout: 10_000 })
        assert.equal(await page.locator('.local-workspaces').count(), 0)
        assert.equal(await remainingIndexedDbCount(page), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('dashboard: local rows are visible with advanced mode both on and off', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'alpha-initiative', { instancesDir })

    await withRunningServer(
      { instancesDir },
      withPage(async (page, base) => {
        await page.goto(base)
        await page.waitForSelector('.master-detail', { timeout: 10_000 })

        await seedGrantedWorkspace(page, { id: 'ws-adv', name: 'Advanced-mode WS', slug: 'beta' })

        // Advanced mode off (default) — the local row still renders.
        await page.reload()
        await page.waitForSelector('.local-workspace-row', { timeout: 10_000 })
        assert.equal(await page.locator('.local-workspace-head .name').textContent(), 'Advanced-mode WS')

        // Advanced mode on — the local row still renders alongside the now-visible ADO surfaces.
        await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
        await page.reload()
        await page.waitForSelector('.local-workspace-row', { timeout: 10_000 })
        assert.equal(await page.locator('.local-workspace-head .name').textContent(), 'Advanced-mode WS')
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
