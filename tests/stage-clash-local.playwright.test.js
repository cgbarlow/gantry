import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #270 (ADR-0068) — a Local workspace makes the same stage-version check, in the browser: the files are
// read again just before a Save, a change made meanwhile to a different Field is merged in, and a
// change to the same Field gets the Field-by-Field dialog. The change "made meanwhile" is written
// straight into the folder, as another browser tab, a sync client or a text editor would. The File
// System Access API cannot be driven headless, so the workspace is a seeded OPFS directory, exactly as
// tests/editor-local-workspace.playwright.test.js does it.

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

async function seedLocalWorkspace(page, slug) {
  const files = {
    [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n`,
  }
  for (const moduleId of SHAPE_MODULES) files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = exampleModuleText(moduleId)
  return page.evaluate(async ({ files }) => {
    const { rememberWorkspace } = await import('/lib/localWorkspace.js')
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('local-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/')
      const file = parts.pop()
      let d = dir
      for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
      const writable = await (await d.getFileHandle(file, { create: true })).createWritable()
      await writable.write(content)
      await writable.close()
    }
    return rememberWorkspace({ handle: dir, name: 'Local Clash Workspace' })
  }, { files })
}

// Reads a file of the one remembered workspace; with `change` ({ from, to }) also rewrites it first.
function opfsFile(page, path, change = null) {
  return page.evaluate(
    async ({ path, change }) => {
      const { getWorkspaceHandle, readTextFile, writeTextFile } = await import('/lib/localWorkspace.js')
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('gantry-local-workspaces', 1)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const all = await new Promise((resolve, reject) => {
        const req = db.transaction('workspaces', 'readonly').objectStore('workspaces').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      db.close()
      const handle = await getWorkspaceHandle(all[0].id)
      const text = await readTextFile(handle, path)
      if (!change) return text
      const changed = text.replace(change.from, change.to)
      await writeTextFile(handle, path, changed)
      return changed
    },
    { path, change }
  )
}

test('local-workspace instance: a Save checks the stage version; a different Field changed meanwhile is merged in, the same Field asks', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      const slug = 'local-clash'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)
      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module')
      const backgroundPath = `gantry-workspace/${slug}/modules/background.md`
      const editor = (index) => page.locator('.field-markdown').nth(index).locator('.cm-content')
      const dialog = page.locator('.modal[aria-label="Changes saved meanwhile"]')

      // Another writer changes the first Field while this editor is open.
      await opfsFile(page, backgroundPath, { from: '## Problem statement\n\n', to: '## Problem statement\n\nChanged meanwhile. ' })
      // This author changes a different Field (the second Markdown Field of the stage) and saves.
      await editor(1).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.type(' Typed here.')
      await page.keyboard.press('ControlOrMeta+s')
      await page.locator('.stage-save-state', { hasText: 'Saved' }).waitFor({ timeout: 5_000 })
      assert.equal(await dialog.count(), 0, 'a different Field raises no dialog')
      assert.match(await opfsFile(page, backgroundPath), /Changed meanwhile\./, "the other writer's change survived the Save")
      await page.waitForFunction(() => /Changed meanwhile\./.test(document.querySelector('.field-markdown .cm-content')?.textContent ?? ''))
      const everything = []
      for (const id of SHAPE_MODULES) everything.push(await opfsFile(page, `gantry-workspace/${slug}/modules/${id}.md`))
      assert.match(everything.join('\n'), /Typed here\./, "this author's change was saved too")

      // Now both change the same Field: the dialog asks, and Keep mine saves this author's wording.
      await opfsFile(page, backgroundPath, { from: 'Changed meanwhile. ', to: 'Changed again elsewhere. ' })
      await editor(0).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.type(' Typed over it.')
      await page.keyboard.press('ControlOrMeta+s')
      await dialog.waitFor({ timeout: 5_000 })
      assert.match(await dialog.locator('[data-clash-side="theirs"]').textContent(), /Changed again elsewhere\./)
      assert.match(await dialog.locator('[data-clash-side="mine"]').textContent(), /Typed over it\./)
      assert.match(await opfsFile(page, backgroundPath), /Changed again elsewhere\./, 'nothing is written until the author chooses')
      await dialog.getByRole('button', { name: 'Keep mine' }).click()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.stage-save-state', { hasText: 'Saved' }).waitFor({ timeout: 5_000 })
      const after = await opfsFile(page, backgroundPath)
      assert.match(after, /Typed over it\./)
      assert.doesNotMatch(after, /Changed again elsewhere\./)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})
