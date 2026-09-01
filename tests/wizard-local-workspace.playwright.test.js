import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser tests for WI #295 — the "Workspace location" axis added to the
// "+ New Workspace" wizard's first step (ADR-0029, Feature #290 / A4).
//
// The File System Access API (`window.showDirectoryPicker`) is not driveable
// from a headless test browser (it needs a real user gesture and a native
// folder picker), so every test installs a mock via `page.addInitScript`
// that returns a REAL handle to a fresh subdirectory of the Origin Private
// File System (`navigator.storage.getDirectory()`). An OPFS handle supports
// the full `FileSystemDirectoryHandle` API `web/lib/localWorkspace.js`
// exercises (`getDirectoryHandle`/`getFileHandle`/`entries`/`createWritable`)
// AND is structured-cloneable into IndexedDB, which is what
// `rememberWorkspace` needs. Each test runs its own gantry server on its own
// ephemeral port, so its OPFS origin starts empty.
//
// The scope boundary (A4, not A6): the editor actually LOADING a
// local-workspace instance is #297. These tests assert on the files written
// through the handle and on the editor-route navigation URL (`?local=…`),
// never on the editor rendering.

const FS_MOCK_INIT = `
  window.__nextPickFiles = {}
  window.__mockPickNames = []
  async function __writePath(dir, path, content) {
    const parts = path.split('/')
    const file = parts.pop()
    let d = dir
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
    const fh = await d.getFileHandle(file, { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
  }
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    const name = 'pick-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    window.__mockPickNames.push(name)
    const dir = await root.getDirectoryHandle(name, { create: true })
    const seed = window.__nextPickFiles || {}
    for (const [p, c] of Object.entries(seed)) await __writePath(dir, p, c)
    window.__nextPickFiles = {}
    return dir
  }
`

// Reads every file under the OPFS "pick-*" directory the mock handed out, as
// a flat { 'gantry-workspace/…': text } map — origin OPFS survives the
// wizard's `location.assign` navigation, so this works after the redirect.
async function readPickedTree(page) {
  return page.evaluate(async () => {
    const out = {}
    const root = await navigator.storage.getDirectory()
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix ? prefix + '/' + name : name
        if (handle.kind === 'directory') await walk(handle, path)
        else out[path] = await (await handle.getFile()).text()
      }
    }
    for await (const [name, handle] of root.entries()) {
      if (name.startsWith('pick-') && handle.kind === 'directory') await walk(handle, '')
    }
    return out
  })
}

function withServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-wi295-'))
  return withRunningServer({ instancesDir }, async (gantryBase) => {
    try {
      await fn({ gantryBase })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

test('Local + Register: writes workspace.json, instance.yaml and blank module files, then navigates to the editor with ?local=', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      // Step 1: Workspace location = Local, sub-mode = Register new.
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()

      await page.locator('#local-register-pick').click()
      await page.waitForSelector('#local-ws-name')
      await page.locator('#local-ws-name').fill('My Local Workspace')
      await page.locator('#local-ws-owner').fill('a.architect')
      await page.locator('#local-register-create').click()

      // Step 2: instance fields.
      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Local Claims')
      assert.equal(await page.locator('#instance-directory').inputValue(), 'local-claims')
      await page.locator('#instance-assignee').fill('a.architect')

      await Promise.all([
        page.waitForNavigation(),
        page.getByRole('button', { name: 'Create instance', exact: true }).click(),
      ])

      // Navigated to the editor route with the IndexedDB id threaded through.
      const url = new URL(page.url())
      assert.equal(url.pathname, '/instance/local-claims')
      assert.ok(url.searchParams.get('local'), 'the ?local=<id> param is present')

      // The files were written through the directory handle.
      const tree = await readPickedTree(page)
      const wsJson = JSON.parse(tree['gantry-workspace/workspace.json'])
      assert.deepEqual(wsJson, {
        name: 'My Local Workspace',
        owner: 'a.architect',
        kind: 'local',
        createdAt: wsJson.createdAt,
      })
      assert.match(wsJson.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

      const instanceYaml = tree['gantry-workspace/local-claims/instance.yaml']
      assert.ok(instanceYaml, 'instance.yaml was written')
      assert.match(instanceYaml, /slug: local-claims/)
      assert.match(instanceYaml, /assignee: a\.architect/)
      assert.match(instanceYaml, /stage: /)
      assert.match(instanceYaml, /definitionVersion: \d+/)

      const moduleFiles = Object.keys(tree).filter((p) =>
        p.startsWith('gantry-workspace/local-claims/modules/')
      )
      assert.ok(moduleFiles.length >= 1, 'at least one blank first-stage module file was written')
      for (const p of moduleFiles) {
        assert.match(tree[p], /^---\nmodule: /, `${p} has module frontmatter`)
        assert.match(tree[p], /\n---\n\n# /, `${p} has a document title heading`)
      }

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('Local + Register: a folder that already contains gantry-workspace/ is rejected', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()

      // The next picked folder already holds a gantry workspace.
      await page.evaluate(() => {
        window.__nextPickFiles = {
          'gantry-workspace/workspace.json':
            '{"name":"Existing","kind":"local","createdAt":"2026-08-31T12:00:00.000Z"}',
        }
      })
      await page.locator('#local-register-pick').click()

      await page.waitForSelector('#local-error')
      assert.match(
        await page.locator('#local-error').textContent(),
        /already contains a gantry-workspace/
      )
      // Did not advance to the name/owner step.
      assert.equal(await page.locator('#local-ws-name').count(), 0)
    } finally {
      await browser.close()
    }
  })
})

test('Local + Pick: lists the instances found in the folder and navigates with ?local=&slug=', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Pick existing local workspace', exact: true }).click()

      await page.evaluate(() => {
        window.__nextPickFiles = {
          'gantry-workspace/workspace.json':
            '{"name":"Seeded WS","owner":"o","kind":"local","createdAt":"2026-08-31T12:00:00.000Z"}',
          'gantry-workspace/alpha/instance.yaml': 'definition: d\nslug: alpha\nstage: s\n',
          'gantry-workspace/notes/README.md': 'not an instance\n',
        }
      })
      await page.locator('#local-pick-open').click()

      await page.waitForSelector('#local-instance-picker')
      const slugs = await page.locator('#local-instance-picker .definition-card .name').allTextContents()
      assert.deepEqual(slugs, ['alpha'])

      await Promise.all([
        page.waitForNavigation(),
        page.locator('#local-instance-picker .definition-card', { hasText: 'alpha' }).click(),
      ])
      const url = new URL(page.url())
      assert.equal(url.pathname, '/instance/alpha')
      assert.ok(url.searchParams.get('local'), '?local=<id> present')
      assert.equal(url.searchParams.get('slug'), 'alpha')
    } finally {
      await browser.close()
    }
  })
})

test('Unsupported browser: the Local option is present but disabled with a message; Server-hosted still works', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      // Remove the API before any app script evaluates `isSupported`.
      await page.addInitScript(() => {
        try {
          delete Object.getPrototypeOf(window).showDirectoryPicker
        } catch {}
        try {
          delete window.showDirectoryPicker
        } catch {}
      })

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      // The Local toggle is present.
      const localToggle = page.getByRole('button', { name: 'Local', exact: true })
      assert.equal(await localToggle.count(), 1)
      await localToggle.click()

      await page.waitForSelector('#local-unsupported')
      assert.match(
        await page.locator('#local-unsupported').textContent(),
        /Local workspaces need Chrome or Edge/
      )
      // The action button is disabled.
      const actionBtn = page.locator('.wizard-field button.btn.primary', { hasText: /local workspace/i })
      assert.equal(await actionBtn.first().isDisabled(), true)

      // Server-hosted still works: switch back and reach the register form.
      await page.getByRole('button', { name: 'Server-hosted', exact: true }).click()
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.waitForSelector('#ws-organization')
    } finally {
      await browser.close()
    }
  })
})
