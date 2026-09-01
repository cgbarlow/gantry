import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser tests for WI #303 (Feature #290 / A8, ADR-0029) — the Settings
// dropdown's "Workspace Settings" / "Instance Settings" links stop pointing
// a local-workspace instance at the old server-side registry routes (which
// don't exist for it) and instead render a local-workspace-aware branch of
// each screen (option (b) from the ticket): read straight from the picked
// folder's own `workspace.json` / `instance.yaml` through the remembered
// `FileSystemDirectoryHandle`, exactly the way the dashboard's own recovery
// UI (web/app.js's LocalGroupResolver, #296/A5, reworked by #306) and the
// editor's local-save path (#297/A6) already do — never a broken fetch.
//
// The File System Access API is not driveable from a headless test browser
// (see tests/wizard-local-workspace.playwright.test.js's own doc comment),
// so this seeds a real OPFS directory directly via the app's own
// web/lib/localWorkspace.js (dynamic-imported in-page) and remembers it in
// IndexedDB with rememberWorkspace — the same technique
// tests/editor-local-workspace.playwright.test.js and
// tests/dashboard-local-workspace.playwright.test.js already use.

// Only `pageerror` (uncaught exceptions), not console errors — the same
// choice tests/editor-local-workspace.playwright.test.js and
// tests/dashboard-local-workspace.playwright.test.js already make for a
// local-workspace instance's editor route: it logs a console error for the
// asset-library listing fetch (`GET /api/instance/assets`), a pre-existing
// gap in a route unrelated to Settings and out of scope for WI #303. A
// `pageerror` — an uncaught exception — would still fail these tests.
function withPage(fn) {
  return async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await fn(page, base)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }
}

// Seeds an OPFS directory holding both `gantry-workspace/workspace.json`
// (Workspace Settings' own source) and `gantry-workspace/<slug>/instance.yaml`
// (Instance Settings' own source), and remembers it in IndexedDB via the
// app's own `rememberWorkspace` — the exact shape `getWorkspaceHandle` reads
// back. Returns `{ workspaceId, dirName }` — `dirName` is the OPFS root's own
// child directory name, independent of the IndexedDB "recent workspaces"
// entry, so a test can still reach the folder directly after Removing it
// (which deletes exactly that IndexedDB entry, per web/lib/localWorkspace.js's
// `forgetWorkspace` — the folder itself is never touched) to prove the
// folder and its files really did survive.
async function seedLocalWorkspace(page, { slug, name, owner, assignee }) {
  return page.evaluate(
    async ({ slug, name, owner, assignee }) => {
      const { rememberWorkspace } = await import('/lib/localWorkspace.js')
      const dirName = 'local-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(dirName, { create: true })
      const gw = await dir.getDirectoryHandle('gantry-workspace', { create: true })

      const wsFile = await gw.getFileHandle('workspace.json', { create: true })
      const wsWritable = await wsFile.createWritable()
      await wsWritable.write(
        JSON.stringify({ name, owner, kind: 'local', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2) + '\n'
      )
      await wsWritable.close()

      const instDir = await gw.getDirectoryHandle(slug, { create: true })
      const instFile = await instDir.getFileHandle('instance.yaml', { create: true })
      const instWritable = await instFile.createWritable()
      await instWritable.write(`definition: design\nslug: ${slug}\nstage: shape\nassignee: ${assignee}\ndefinitionVersion: 1\n`)
      await instWritable.close()

      const workspaceId = await rememberWorkspace({ handle: dir, name })
      return { workspaceId, dirName }
    },
    { slug, name, owner, assignee }
  )
}

// A remembered workspace whose stored handle is a plain (structured-clone-
// able) object with none of the FileSystemDirectoryHandle permission methods
// — ensurePermission()'s optional-chained calls resolve to `undefined` for
// each, which its own contract maps to a non-'granted' state. Stands in for
// a real denied/stale handle without needing a browser permission prompt to
// drive (same technique tests/dashboard-local-workspace.playwright.test.js's
// own seedStaleWorkspace uses).
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

async function readOpfsInstanceYaml(page, workspaceId, slug) {
  return page.evaluate(
    async ({ workspaceId, slug }) => {
      const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
      const handle = await getWorkspaceHandle(workspaceId)
      return readTextFile(handle, `gantry-workspace/${slug}/instance.yaml`)
    },
    { workspaceId, slug }
  )
}

// Reads straight off OPFS by the root's own child directory name — bypasses
// the IndexedDB "recent workspaces" registry entirely, so this still works
// after that entry has been forgotten (`forgetWorkspace`/"Remove workspace"),
// proving the folder itself was never touched by that action.
async function readOpfsInstanceYamlByDirName(page, dirName, slug) {
  return page.evaluate(
    async ({ dirName, slug }) => {
      const { readTextFile } = await import('/lib/localWorkspace.js')
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(dirName)
      return readTextFile(dir, `gantry-workspace/${slug}/instance.yaml`)
    },
    { dirName, slug }
  )
}

async function indexedDbCount(page) {
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

test('settings: from a local-workspace instance, the Settings dropdown\'s Workspace/Instance Settings links open local-workspace-aware screens, not a broken fetch', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      const slug = 'local-settings-demo'
      await page.goto(`${base}/`)
      const { workspaceId } = await seedLocalWorkspace(page, {
        slug,
        name: 'Local Settings Workspace',
        owner: 'c.barlow',
        assignee: 'a.architect',
      })

      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}&slug=${slug}`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      // The dropdown's own links must carry `local=` for a local-workspace instance (the actual bug/fix).
      await page.getByRole('button', { name: 'Settings' }).click()
      const menu = page.locator('.settings-menu .menu')
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      const workspaceHref = await menu.locator('a', { hasText: 'Workspace Settings' }).getAttribute('href')
      const instanceHref = await menu.locator('a', { hasText: 'Instance Settings' }).getAttribute('href')
      assert.match(workspaceHref, /[?&]local=/)
      assert.match(instanceHref, /[?&]local=/)

      // ---- Workspace Settings: reads workspace.json through the handle, no server-side registry fetch ----
      await menu.locator('a', { hasText: 'Workspace Settings' }).click()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/settings/workspace')
      assert.equal(new URL(page.url()).searchParams.get('local'), workspaceId)
      assert.equal(await page.locator('.load-error').count(), 0, 'must not show a broken-fetch error')

      const resultCard = page.locator('.result-card')
      await resultCard.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await resultCard.textContent(), /Local Settings Workspace/)
      assert.match(await resultCard.textContent(), /c\.barlow/)
      assert.equal(await page.getByRole('button', { name: 'Remove workspace' }).count(), 1)

      // Back to the instance, then into Instance Settings.
      await page.getByRole('link', { name: '← Back' }).click()
      await page.waitForSelector('.module', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.locator('.settings-menu .menu a', { hasText: 'Instance Settings' }).click()
      await page.waitForSelector('.settings-header', { timeout: 10_000 })
      assert.equal(new URL(page.url()).pathname, '/settings/instance')
      assert.equal(await page.locator('.load-error').count(), 0, 'must not show a broken-fetch error')

      // ---- Instance Settings: reads instance.yaml through the handle; assignee is a plain field, no Azure DevOps identity search ----
      assert.equal(await page.locator('.workspace-field-row input[type=text]').inputValue(), 'a.architect')
      assert.match(await page.locator('.settings-section', { hasText: 'Instance info' }).textContent(), new RegExp(slug))
      assert.match(await page.locator('.settings-section', { hasText: 'Instance info' }).textContent(), /design/)
      assert.match(
        await page.locator('.settings-section', { hasText: 'Azure DevOps work item' }).textContent(),
        /don't support Azure DevOps ticketing/
      )
      // No required-reviewer / archive sections — neither concept applies to a local workspace instance.
      assert.equal(await page.locator('text=Required reviewer').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Archive instance' }).count(), 0)
    })(base)
  })
})

test('settings: Instance Settings saves an edited Assignee straight through the directory handle', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      const slug = 'local-settings-assignee'
      await page.goto(`${base}/`)
      const { workspaceId } = await seedLocalWorkspace(page, {
        slug,
        name: 'Assignee Workspace',
        owner: '',
        assignee: '',
      })

      await page.goto(`${base}/settings/instance?slug=${slug}&local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.settings-header', { timeout: 10_000 })

      const input = page.locator('.workspace-field-row input[type=text]')
      await input.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await input.inputValue(), '')
      await input.fill('new.assignee')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.workspace-field-status:has-text("Saved.")', { timeout: 5_000 })

      const onDisk = await readOpfsInstanceYaml(page, workspaceId, slug)
      assert.match(onDisk, /assignee: new\.assignee/)
    })(base)
  })
})

test('settings: Workspace Settings\' "Remove workspace" forgets it from this browser only, leaving the folder untouched', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      page.on('dialog', (dialog) => dialog.accept())
      const slug = 'local-settings-forget'
      await page.goto(`${base}/`)
      const { workspaceId, dirName } = await seedLocalWorkspace(page, {
        slug,
        name: 'Forgettable Workspace',
        owner: 'c.barlow',
        assignee: '',
      })
      assert.equal(await indexedDbCount(page), 1)

      await page.goto(`${base}/settings/workspace?slug=${slug}&local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.result-card', { timeout: 10_000 })

      await page.getByRole('button', { name: 'Remove workspace' }).click()
      await page.waitForSelector('text=Removed from this browser.', { timeout: 5_000 })
      assert.equal(await indexedDbCount(page), 0)

      // The folder itself (and its instance.yaml) is untouched — reached
      // directly off OPFS now, since the IndexedDB entry that
      // `getWorkspaceHandle` would otherwise use is gone by design.
      const onDisk = await readOpfsInstanceYamlByDirName(page, dirName, slug)
      assert.match(onDisk, /slug: local-settings-forget/)
    })(base)
  })
})

test('settings: a lapsed local-workspace permission shows "Grant access" on both screens, not a broken/erroring one', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/`)
      await seedStaleWorkspace(page, { id: 'stale-ws', name: 'Stale Workspace' })

      for (const path of ['/settings/workspace', '/settings/instance']) {
        await page.goto(`${base}${path}?slug=stale-instance&local=stale-ws`)
        await page.waitForSelector('.settings-header', { timeout: 10_000 })
        assert.equal(await page.locator('.load-error').count(), 0, `${path} must not show a raw load error`)
        await page.getByRole('button', { name: 'Grant access' }).waitFor({ state: 'visible', timeout: 5_000 })
      }
    })(base)
  })
})
