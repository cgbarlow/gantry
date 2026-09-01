import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// Browser tests for WI #297 (ADR-0029, Feature #290 / A6) — the module
// editor loading, saving, gate-checking, advancing and rendering a
// **local-workspace** instance (`/instance/<slug>?local=<id>&slug=<slug>`)
// straight through a `FileSystemDirectoryHandle`, per ADR-0029.
//
// The File System Access API is not driveable from a headless test browser
// (see tests/wizard-local-workspace.playwright.test.js's own doc comment for
// why), so this seeds a real OPFS directory directly — via the app's own
// `web/lib/localWorkspace.js` (dynamic-imported in-page, since it has no
// bare-specifier imports of its own) — and remembers it in IndexedDB with
// `rememberWorkspace`, the exact same shape `getWorkspaceHandle` reads back.
// That lets the test open the editor route directly, with no wizard flow
// in between.
//
// Seed content is the "shape" stage's own module files from the curated
// `instances/examples` fixture (the same content `readModule`/existing tests
// already trust as gate-passing for the `business-case` gate) — copied
// as-is except `instance.yaml`'s `slug`.

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

function readExampleFile(relPath) {
  return readFileSync(join('instances/examples', relPath), 'utf8')
}

async function seedLocalWorkspace(page, slug) {
  const files = {
    [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n`,
  }
  for (const moduleId of SHAPE_MODULES) {
    files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = readExampleFile(`modules/${moduleId}.md`)
  }
  return page.evaluate(async ({ files, name }) => {
    const { rememberWorkspace } = await import('/lib/localWorkspace.js')
    async function writePath(dir, path, content) {
      const parts = path.split('/')
      const file = parts.pop()
      let d = dir
      for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
      const fh = await d.getFileHandle(file, { create: true })
      const w = await fh.createWritable()
      await w.write(content)
      await w.close()
    }
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('local-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
    for (const [path, content] of Object.entries(files)) await writePath(dir, path, content)
    const id = await rememberWorkspace({ handle: dir, name })
    return id
  }, { files, name: 'Local Editor Workspace' })
}

async function readOpfsFile(page, path) {
  return page.evaluate(async (path) => {
    const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
    // The one remembered workspace — this suite only ever seeds one at a time.
    async function firstWorkspaceId() {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('gantry-local-workspaces', 1)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const tx = db.transaction('workspaces', 'readonly')
      const all = await new Promise((resolve, reject) => {
        const req = tx.objectStore('workspaces').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      db.close()
      return all[0]?.id
    }
    const id = await firstWorkspaceId()
    const handle = await getWorkspaceHandle(id)
    return readTextFile(handle, path)
  }, path)
}

test('local-workspace instance: loads, saves offline-safe, gate-checks, advances and renders through the directory handle', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      const slug = 'local-claims'
      // Navigate first so the page has a real http(s) origin — OPFS/IndexedDB need one.
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)
      assert.ok(workspaceId, 'seeded a local workspace id')

      // ---- Load: the editor reads instance.yaml + module files through the handle ----
      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}&slug=${slug}`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      const contextModule = page.locator('.module').first()
      await assert.doesNotReject(contextModule.getByRole('button', { name: /^Save /, exact: false }).first().waitFor({ timeout: 5_000 }))

      // A real field value from the seeded module file shows in the editor.
      const problemField = page.locator('.field-markdown .cm-content').first()
      const before = await problemField.textContent()
      assert.ok(before && before.trim().length > 0, 'a seeded field renders non-empty content')

      // Never shown for a local-workspace instance (ADR-0029: no ticketing, no Workspace-backed ceremony).
      assert.equal(await page.locator('[data-testid="stage-sync-banner"]').count(), 0)
      assert.equal(await page.locator('[data-testid="reopen-stage-button"]').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Request Sign-off', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Request Sign-off again', exact: true }).count(), 0)

      // ---- Save: edits the first field and writes straight through the handle, no server round-trip ----
      await problemField.click()
      await page.keyboard.type(' — edited locally.')
      await page.locator('.module').first().getByRole('button', { name: 'Save Background and context' }).click()
      await page.waitForSelector('.save-status:has-text("Saved")', { timeout: 5_000 })

      const backgroundOnDisk = await readOpfsFile(page, `gantry-workspace/${slug}/modules/background.md`)
      assert.match(backgroundOnDisk, /— edited locally\./, 'the edit landed in the on-disk module file')

      // ---- Render: writes .md and .docx into gantry-workspace/<slug>/out/ through the handle. Rendered while still on "shape" (its own seeded modules cover the "soap" artefact's own requires) — before advancing, so the next stage's own (unseeded) modules are never needed. ----
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 20_000 }
      )
      const renderStatusText = await renderDialog.textContent()
      assert.doesNotMatch(renderStatusText, /render failed/, `render must not fail: ${renderStatusText}`)
      await page.keyboard.press('Escape')
      await renderDialog.waitFor({ state: 'hidden', timeout: 5_000 })

      const outEntries = await page.evaluate(async () => {
        const { getWorkspaceHandle, listDir } = await import('/lib/localWorkspace.js')
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('gantry-local-workspaces', 1)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const tx = db.transaction('workspaces', 'readonly')
        const all = await new Promise((resolve, reject) => {
          const req = tx.objectStore('workspaces').getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        db.close()
        const handle = await getWorkspaceHandle(all[0].id)
        return listDir(handle, `gantry-workspace/local-claims/out`).catch(() => [])
      })
      const names = outEntries.map((e) => e.name)
      assert.ok(names.some((n) => n.endsWith('.md')), `expected a rendered .md in out/, got: ${names.join(', ')}`)
      assert.ok(names.some((n) => n.endsWith('.docx')), `expected a rendered .docx in out/, got: ${names.join(', ')}`)
      const renderedMd = await readOpfsFile(page, `gantry-workspace/${slug}/out/${names.find((n) => n.endsWith('.md'))}`)
      assert.ok(renderedMd.trim().length > 0, 'the rendered .md has real content')

      // ---- Gate check + Advance: /api/local/check against the real running server, then instance.yaml rewritten through the handle ----
      const advancePanel = page.locator('.advance-stage-panel')
      await advancePanel.waitFor({ state: 'visible', timeout: 5_000 })
      await advancePanel.getByRole('button', { name: 'Advance to next stage' }).click()
      await page.waitForSelector('.modal[aria-label="Confirm stage advancement"]', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Confirm & advance' }).click()
      await page.waitForFunction(
        () => document.querySelector('.advance-stage-panel .save-status')?.textContent?.includes('Advanced to'),
        { timeout: 10_000 }
      )

      const instanceYamlAfterAdvance = await readOpfsFile(page, `gantry-workspace/${slug}/instance.yaml`)
      assert.match(instanceYamlAfterAdvance, /stage: hld-define/, 'instance.yaml stage advanced on disk')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('local-workspace instance: offline degradation — /api/local/check unreachable shows a clear message, saving still works', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)

      const slug = 'local-offline'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)

      // Simulate the server being unreachable for /api/local/* — a real network error, not a 4xx/5xx.
      await page.route('**/api/local/**', (route) => route.abort('connectionrefused'))

      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}&slug=${slug}`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      const advancePanel = page.locator('.advance-stage-panel')
      await advancePanel.waitFor({ state: 'visible', timeout: 5_000 })
      await advancePanel.getByRole('button', { name: 'Advance to next stage' }).click()
      await page.waitForFunction(
        () => document.querySelector('.advance-stage-panel .save-status')?.textContent?.includes('Connect to the gantry server'),
        { timeout: 10_000 }
      )

      // Editing and saving must still work with the server unreachable (ADR-0029's Offline section) — no /api/local/* involved.
      const problemField = page.locator('.field-markdown .cm-content').first()
      await problemField.click()
      await page.keyboard.type(' — saved while offline.')
      await page.locator('.module').first().getByRole('button', { name: 'Save Background and context' }).click()
      await page.waitForSelector('.save-status:has-text("Saved")', { timeout: 5_000 })

      const backgroundOnDisk = await readOpfsFile(page, `gantry-workspace/${slug}/modules/background.md`)
      assert.match(backgroundOnDisk, /— saved while offline\./, 'save succeeded with the server unreachable')
    } finally {
      await browser.close()
    }
  })
})

// WI #304 — opening a local-workspace instance's editor must never reach the
// server-side `GET /api/instance/assets` route: assets live entirely
// client-side (`gantry-workspace/<slug>/assets/`, read via `fetchAssets`'s
// `instance?.isLocalWorkspace` branch). That branch reads `instanceData.value`,
// which is still `null` the instant `currentSlug`/`viewedStage` are pinned
// (ModuleEditorPage's mount effect batches `localWorkspaceParam`/`currentSlug`
// together, but `instanceData` itself is only set later, once the async
// `loadLocalInstance()` promise resolves) — a race the module-level
// `assetSources` effect (fires on every `currentSlug` change, to prime
// citation text) loses on the very first paint, falling through to the
// server route for a slug the server has never heard of and getting a 500
// back (caught silently, so no page error — see the reproduction below for
// why the existing test above doesn't already catch this).
test('local-workspace instance: opening the editor never calls the server-side asset route', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)

      const assetRequests = []
      page.on('response', (response) => {
        const url = new URL(response.url())
        if (url.pathname === '/api/instance/assets') {
          assetRequests.push({ status: response.status(), url: response.url() })
        }
      })

      const slug = 'local-assets-race'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)

      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}&slug=${slug}`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      // Give the module-level assetSources effect (fires immediately on slug pin) a moment to settle.
      await page.waitForTimeout(500)

      assert.deepEqual(
        assetRequests,
        [],
        `expected no server-side /api/instance/assets calls for a local-workspace instance, got: ${JSON.stringify(assetRequests)}`
      )
    } finally {
      await browser.close()
    }
  })
})

// WI #308 — the mirror-image race of WI #304's mount-time one, at teardown
// instead: `ModuleEditorPage`'s own mount effect (web/app.js) re-pins
// `currentSlug`/`localWorkspaceParam`/`viewedStage` on every route-slug
// change, and for a *non*-local route it used to clear `localWorkspaceParam`
// with its own standalone write, ahead of (not batched with) the
// `currentSlug` write that follows. A lone signal write fires every
// subscriber synchronously, on the spot — so for the one instant between
// those two statements, `localWorkspaceParam` already reflects the new
// (non-local) route while `currentSlug` still holds the *previous* route's
// slug. The module-level `assetSources` effect (primes citation text,
// fires on every `currentSlug` change) is subscribed to both — transitively
// to `localWorkspaceParam`, via `fetchAssets`'s own `isLocalWorkspaceSlug`
// check, which that effect calls synchronously — so it can catch this exact
// instant and re-run its `fetchAssets()` call for the *previous* slug now
// reading `isLocalWorkspaceSlug` as `false`. For a local-workspace instance
// (ADR-0029: no server-side registry entry at all) that sends the stale slug
// down the server-side `GET /api/instance/assets` route, which has never
// heard of it — a 500 pre-WI #304, a clean-but-still-wrong 400 post-WI #304.
//
// Reliably landing on that instant needs two things this test sets up
// deliberately: (1) two *different* instance routes adjacent in the same
// browser-history stack — one real (server-tracked), one local, so a single
// Back pops straight from one to the other with no dashboard visit between
// them to reset anything — and (2) the transition being driven by the
// browser's own native Back button rather than an in-app click: a `history
// .back()`-triggered `popstate` runs `ModuleEditorPage`'s mount effect
// outside whatever implicit batching wraps a same-page click's own state
// updates, so the two signal writes land as two genuinely separate,
// independently-observable steps instead of one. There's no in-app link from
// a real instance straight to a local one to click through for step (1), so
// this seeds that history adjacency the same way this suite already seeds
// what a headless browser can't otherwise drive (OPFS instead of a real
// `showDirectoryPicker` — see this file's own top comment): a plain injected
// `<a>` click, which preact-iso's router intercepts exactly like a real one.
test('local-workspace instance: Back-navigating off the editor never surfaces a stale fetchAssets() network error', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', 'sibling-instance', { instancesDir })

    await withRunningServer({ instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)

        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        const badApiResponses = []
        page.on('response', (response) => {
          const url = new URL(response.url())
          if (url.pathname.startsWith('/api/') && response.status() >= 400) {
            badApiResponses.push({ status: response.status(), url: response.url() })
          }
        })

        const slug = 'local-goback'

        // ---- History entry 1: a real, server-tracked instance ----
        await page.goto(`${base}/instance/sibling-instance`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        const workspaceId = await seedLocalWorkspace(page, slug)

        // ---- History entry 2: the local-workspace instance, reached by a client-side pushState (see doc comment above for why) ----
        await page.evaluate((href) => {
          const a = document.createElement('a')
          a.href = href
          document.body.appendChild(a)
          a.click()
        }, `/instance/${slug}?local=${encodeURIComponent(workspaceId)}&slug=${slug}`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        // ---- Leave the local instance via the browser's own Back button, not an in-app link ----
        await page.goBack()
        await page.waitForSelector('.module', { timeout: 10_000 })
        // Give any effect re-run's stale fetchAssets() response a moment to land.
        await page.waitForTimeout(1_000)

        assert.deepEqual(
          badApiResponses,
          [],
          `expected no /api error responses after Back-navigating off the local instance, got: ${JSON.stringify(badApiResponses)}`
        )
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
