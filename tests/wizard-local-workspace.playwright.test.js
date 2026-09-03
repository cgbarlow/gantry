import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser tests for WI #295 — the "Workspace location" axis added to the
// "+ New Workspace" wizard's first step (ADR-0029, Feature #290 / A4) — and
// WI #302 (B3) — advanced mode off skips that axis and starts the wizard
// directly in the Local flow.
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
//
// advancedMode.js defaults to off (no `gantry:advancedMode` in localStorage),
// which is B3's whole point — so every test below that exercises A4's full
// "Workspace location" toggle (Server-hosted reachable, Local a deliberate
// choice) sets `gantry:advancedMode`='true' via an init script before
// navigating, to keep that A4 coverage exercising the toggle explicitly
// rather than accidentally relying on a default that B3 changed.
const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`

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

// ---------------------------------------------------------------------------
// WI #306 item 1 — Local mode only: Register renders first and is selected
// by default (Server-hosted's own Pick-first/Pick-default behaviour must
// not change).
// ---------------------------------------------------------------------------

test('WI #306 item 1: switching to Local defaults to and leads with "Register new local workspace"; Server-hosted keeps Pick-first/Pick-default', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      // Server-hosted (the wizard's initial location): Pick first, Pick
      // selected by default — unchanged.
      const sourceButtons = page.locator('.wizard-mode-toggle[aria-label="Workspace source"] button')
      assert.deepEqual(await sourceButtons.allTextContents(), ['Pick existing workspace', 'Register new workspace'])
      assert.match(await sourceButtons.first().getAttribute('class'), /active/)

      // Local: Register leads, and is the one already selected — no click
      // on the Pick/Register toggle itself required.
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      assert.deepEqual(await sourceButtons.allTextContents(), [
        'Register new local workspace',
        'Pick existing local workspace',
      ])
      assert.match(await sourceButtons.first().getAttribute('class'), /active/)
      await page.waitForSelector('#local-register-pick')

      // Back to Server-hosted: still Pick-first/Pick-default, never
      // clobbered by the Local-only default.
      await page.getByRole('button', { name: 'Server-hosted', exact: true }).click()
      assert.deepEqual(await sourceButtons.allTextContents(), ['Pick existing workspace', 'Register new workspace'])
      assert.match(await sourceButtons.first().getAttribute('class'), /active/)
    } finally {
      await browser.close()
    }
  })
})

// ---------------------------------------------------------------------------
// WI #306 item 2 — the Instance step's Assignee field is a plain text input
// for a local-flow instance, not <${IdentityPicker}>: no /api/identities
// network call should fire.
// ---------------------------------------------------------------------------

test('WI #306 item 2: a local-flow instance\'s Assignee field is plain text — no /api/identities request fires', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      const identityRequests = []
      page.on('request', (req) => {
        if (req.url().includes('/api/identities')) identityRequests.push(req.url())
      })

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()

      await page.locator('#local-register-pick').click()
      await page.waitForSelector('#local-ws-name')
      await page.locator('#local-ws-name').fill('Plain Assignee WS')
      await page.locator('#local-register-create').click()

      await page.waitForSelector('#instance-name')
      // A plain <input>, not the IdentityPicker's own wrapper/dropdown.
      assert.equal(await page.locator('.identity-picker').count(), 0)
      const assignee = page.locator('#instance-assignee')
      assert.equal(await assignee.evaluate((el) => el.tagName), 'INPUT')

      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Plain Assignee Instance')
      // Typing triggers IdentityPicker's own debounced search() if this were
      // still that component — give it a real chance to fire before
      // asserting it didn't.
      await assignee.fill('a.architect')
      await page.waitForTimeout(400)

      assert.deepEqual(identityRequests, [])
    } finally {
      await browser.close()
    }
  })
})

test('Local + Register: writes workspace.json, instance.yaml and blank module files, then navigates to the editor with ?local=', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
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

test('Local + Pick: lists the instances found in the folder and navigates with ?local=', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
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
      assert.equal(url.searchParams.get('slug'), null)
    } finally {
      await browser.close()
    }
  })
})

// ---------------------------------------------------------------------------
// WI #307 — "+ New instance" inside an already-opened local workspace
// (openLocalWorkspace previously left `localRegHandle`/`isLocalWorkspace`
// unset and never offered a way back to the Instance step, so a second
// instance in an already-registered local workspace was unreachable).
// ---------------------------------------------------------------------------

test('Local + Pick: "+ New instance" creates a second instance in an already-opened workspace, leaving the first untouched', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
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
        }
      })
      await page.locator('#local-pick-open').click()

      await page.waitForSelector('#local-new-instance')
      const slugsBefore = await page.locator('#local-instance-picker .definition-card .name').allTextContents()
      assert.deepEqual(slugsBefore, ['alpha'])

      // The new-instance affordance sits alongside the existing-instances
      // list, not just in the empty state.
      await page.locator('#local-new-instance').click()

      // Reaches the Instance step in-page (no navigation yet).
      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Beta Claims')
      assert.equal(await page.locator('#instance-directory').inputValue(), 'beta-claims')
      await page.locator('#instance-assignee').fill('a.architect')

      await Promise.all([
        page.waitForNavigation(),
        page.getByRole('button', { name: 'Create instance', exact: true }).click(),
      ])
      const url = new URL(page.url())
      assert.equal(url.pathname, '/instance/beta-claims')
      assert.ok(url.searchParams.get('local'), 'the ?local=<id> param is present')

      // Written into the already-opened workspace's gantry-workspace/, and
      // the pre-existing "alpha" instance is untouched.
      const tree = await readPickedTree(page)
      assert.match(tree['gantry-workspace/beta-claims/instance.yaml'], /slug: beta-claims/)
      assert.equal(tree['gantry-workspace/alpha/instance.yaml'], 'definition: d\nslug: alpha\nstage: s\n')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('Local + Pick: an already-opened workspace with zero instances offers "+ New instance" instead of a dead end', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Pick existing local workspace', exact: true }).click()

      await page.evaluate(() => {
        window.__nextPickFiles = {
          'gantry-workspace/workspace.json':
            '{"name":"Empty WS","kind":"local","createdAt":"2026-08-31T12:00:00.000Z"}',
        }
      })
      await page.locator('#local-pick-open').click()

      await page.waitForSelector('#local-new-instance')
      assert.equal(await page.locator('#local-instance-picker').count(), 0)
      assert.match(
        await page.locator('.wizard-field-hint', { hasText: /no instances yet/ }).textContent(),
        /create the first one below/
      )

      await page.locator('#local-new-instance').click()
      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('First Instance')

      await Promise.all([
        page.waitForNavigation(),
        page.getByRole('button', { name: 'Create instance', exact: true }).click(),
      ])
      const url = new URL(page.url())
      assert.equal(url.pathname, '/instance/first-instance')

      const tree = await readPickedTree(page)
      assert.ok(tree['gantry-workspace/first-instance/instance.yaml'], 'the first instance was written')
    } finally {
      await browser.close()
    }
  })
})

test('Local + Pick: "+ New instance" rejects a slug colliding with an existing instance instead of overwriting it', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Pick existing local workspace', exact: true }).click()

      await page.evaluate(() => {
        window.__nextPickFiles = {
          'gantry-workspace/workspace.json':
            '{"name":"Seeded WS","kind":"local","createdAt":"2026-08-31T12:00:00.000Z"}',
          'gantry-workspace/alpha/instance.yaml': 'definition: d\nslug: alpha\nstage: s\n',
        }
      })
      await page.locator('#local-pick-open').click()
      await page.waitForSelector('#local-new-instance')
      await page.locator('#local-new-instance').click()

      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('Alpha Again')
      // Override the auto-slugified Directory to collide with "alpha".
      await page.locator('#instance-directory').fill('alpha')

      await page.getByRole('button', { name: 'Create instance', exact: true }).click()

      await page.waitForSelector('.inline-error')
      assert.match(
        await page.locator('.inline-error').textContent(),
        /"alpha" already exists in this workspace folder/
      )
      // No navigation happened — still on the wizard.
      assert.equal(new URL(page.url()).pathname, '/new-workspace')

      // The pre-existing instance was not overwritten.
      const tree = await readPickedTree(page)
      assert.equal(tree['gantry-workspace/alpha/instance.yaml'], 'definition: d\nslug: alpha\nstage: s\n')
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
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
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
      // Advanced mode is on, so no "enable advanced mode" hint is needed —
      // Server-hosted is already one click away, above.
      assert.equal(await page.locator('#local-unsupported-advanced-hint').count(), 0)

      // Server-hosted still works: switch back and reach the register form.
      await page.getByRole('button', { name: 'Server-hosted', exact: true }).click()
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.waitForSelector('#ws-organization')
    } finally {
      await browser.close()
    }
  })
})

// ---------------------------------------------------------------------------
// WI #302 (B3) — advanced mode off: the wizard skips the "Workspace
// location" toggle entirely and starts directly in the Local flow.
// ---------------------------------------------------------------------------

test('B3: advanced mode off (default) — opens straight into the Local flow, no "Workspace location" toggle, no Server-hosted option', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      // No ADVANCED_MODE_ON_INIT here — advancedMode.js defaults to off with
      // no `gantry:advancedMode` key at all, which is the case this test
      // covers.
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      // No "Workspace location" toggle — neither "Server-hosted" nor "Local"
      // buttons are reachable, because the axis itself is not rendered.
      assert.equal(await page.getByRole('button', { name: 'Server-hosted', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Local', exact: true }).count(), 0)
      assert.equal(await page.locator('label', { hasText: 'Workspace location' }).count(), 0)

      // The Local Pick/Register sub-toggle is already showing — same wizard
      // step, straight to the Local flow's own toggle, defaulting to
      // "Register new local workspace" (WI #306 item 1 — a first-time
      // local-workspace user has nothing to pick yet).
      await page.waitForSelector('button:has-text("Register new local workspace")')
      assert.equal(await page.locator('#adopt-repo-url').count(), 0, 'no Azure DevOps URL field reachable')

      // Full round-trip through the Local + Register flow works exactly as
      // A4 built it, unchanged — Register is already selected by default,
      // this click is a no-op confirmation of that.
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
      await page.locator('#local-register-pick').click()
      await page.waitForSelector('#local-ws-name')
      await page.locator('#local-ws-name').fill('Default Local Workspace')
      await page.locator('#local-register-create').click()

      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card').first().click()
      await page.locator('#instance-name').fill('B3 Claims')

      // No work-item step exists for the local flow — the primary button
      // reads straight through to instance creation.
      assert.equal(await page.getByRole('button', { name: 'Next: link a work item' }).count(), 0)

      await Promise.all([
        page.waitForNavigation(),
        page.getByRole('button', { name: 'Create instance', exact: true }).click(),
      ])
      const url = new URL(page.url())
      assert.equal(url.pathname, '/instance/b3-claims')
      assert.ok(url.searchParams.get('local'), 'the ?local=<id> param is present')
    } finally {
      await browser.close()
    }
  })
})

test('B3: advanced mode on — the full "Workspace location" toggle is visible and Server-hosted is selectable', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)

      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      // The "Workspace location" toggle is visible, defaulting to
      // Server-hosted, exactly as A4 built it.
      await page.waitForSelector('label:has-text("Workspace location")')
      await page.waitForSelector('#adopt-repo-url')
      const serverBtn = page.getByRole('button', { name: 'Server-hosted', exact: true })
      assert.equal(await serverBtn.count(), 1)
      assert.match(await serverBtn.getAttribute('class'), /active/)

      // Server-hosted is genuinely reachable/selectable, and Local remains a
      // deliberate opt-in via the same toggle.
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.waitForSelector('button:has-text("Register new local workspace")')
      await page.getByRole('button', { name: 'Server-hosted', exact: true }).click()
      await page.waitForSelector('#adopt-repo-url')
    } finally {
      await browser.close()
    }
  })
})

test('B3: advanced mode off + unsupported browser — shows the unsupported message plus the "enable advanced mode" hint, no dead end', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      // No ADVANCED_MODE_ON_INIT — advanced mode stays off (default).
      // Remove the File System Access API before any app script evaluates
      // `isSupported`.
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

      // Straight into the Local flow (no toggle to click through) — and it
      // is unsupported, so the unsupported message shows immediately.
      await page.waitForSelector('#local-unsupported')
      assert.match(
        await page.locator('#local-unsupported').textContent(),
        /Local workspaces need Chrome or Edge/
      )

      // The hint pointing at the way out — enabling advanced mode — is
      // present, since there is no "Switch to Server-hosted above" here.
      await page.waitForSelector('#local-unsupported-advanced-hint')
      assert.match(
        await page.locator('#local-unsupported-advanced-hint').textContent(),
        /Enable advanced mode in Settings to use a server-hosted workspace instead\./
      )

      // No dead end: the action button is disabled (as expected — there's
      // nothing it can do), but the page has not thrown and offers no other
      // unhandled state.
      const actionBtn = page.locator('.wizard-field button.btn.primary', { hasText: /local workspace/i })
      assert.equal(await actionBtn.first().isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Server-hosted', exact: true }).count(), 0)
    } finally {
      await browser.close()
    }
  })
})
