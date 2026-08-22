import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// Minimal browser smoke test for the Preact/HTM-ported module editor
// (docs/adr/0006-preact-frontend-framework.md): confirms the real page
// loads with no console/page errors, and that a markdown field's edit ->
// save round-trips to the module file on disk — the same guarantee
// tests/server.test.js checks at the HTTP layer, exercised here through an
// actual rendered page and a real CodeMirror 6 editor instance.
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

test('the ported module editor page loads with no errors and a markdown field save round-trips', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(base)
        await page.waitForSelector('.module', { timeout: 10_000 })

        assert.equal(await page.locator('header h1').textContent(), 'examples — design')
        assert.deepEqual(pageErrors, [])

        // Edit the Context module's "Business driver" markdown field via its
        // real CodeMirror 6 editor, then save.
        const newText = 'Edited by the Playwright smoke test.'
        await page.locator('.field-markdown .cm-content').first().click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.type(newText)
        await page.getByRole('button', { name: 'Save Context' }).click()
        await page.waitForSelector('text=Saved', { timeout: 5_000 })

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    const definition = loadDefinition('design')
    const data = readModule(definition, 'examples', 'context', { instancesDir })
    assert.equal(data.fields.driver, 'Edited by the Playwright smoke test.')
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
