import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #171: the Local Workspace Definition editor edits a Stage's Modules as a comma-separated text field.
// A Stage's `read-only-modules` must follow it: taking a Module off the Stage drops its read-only entry
// once the author leaves the field (never mid-typing), and a per-Module checkbox marks one read-only.

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

test('Local Workspace editor: read-only-modules follows the Stage\'s Modules text field, pruned on blur and never mid-typing', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(async () => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-read-only-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Read-only Modules E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/read-only-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('read-only-local-e2e')
      await page.locator('#local-def-title').fill('Read-only Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')

      const modulesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Modules' }) })
      for (const id of ['alpha', 'beta']) {
        await modulesSection.getByRole('button', { name: '+ Add module' }).click()
        const mod = modulesSection.locator('.local-def-element').last()
        await mod.locator('input[type="text"]').nth(0).fill(id)
        await mod.locator('input[type="text"]').nth(1).fill(id)
      }

      const stagesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Stages' }) })
      await stagesSection.getByRole('button', { name: '+ Add stage' }).click()
      const stage = stagesSection.locator('.local-def-element').first()
      await stage.locator('input[type="text"]').nth(0).fill('s1')
      await stage.locator('input[type="text"]').nth(1).fill('Stage 1')
      const modulesField = stage.locator('input[type="text"]').nth(3)
      await modulesField.fill('alpha, beta')

      const alphaBox = stage.getByLabel('Read-only at this stage: alpha')
      const betaBox = stage.getByLabel('Read-only at this stage: beta')
      await alphaBox.check()
      await betaBox.check()

      const save = async () => {
        await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })
        return parseYAML(await readDefinitionYaml()).stages[0]
      }
      assert.deepEqual((await save())['read-only-modules'], ['alpha', 'beta'])

      // Mid-typing: "beta" is replaced by a half-typed id while the field still has focus. Its entry
      // must survive until the author finishes (here: types the id back).
      await modulesField.focus()
      await modulesField.fill('alpha, b')
      await modulesField.fill('alpha, beta')
      await modulesField.blur()
      assert.equal(await stage.getByLabel('Read-only at this stage: beta').isChecked(), true, 'a half-typed id did not cost the entry')

      // Taking beta off the Stage drops its read-only entry once the field is left.
      await modulesField.fill('alpha')
      await modulesField.blur()
      assert.equal(await stage.getByLabel('Read-only at this stage: beta').count(), 0)
      let saved = await save()
      assert.deepEqual(saved.modules, ['alpha'])
      assert.deepEqual(saved['read-only-modules'], ['alpha'])

      // Unticking the last one removes the key.
      await alphaBox.uncheck()
      saved = await save()
      assert.equal('read-only-modules' in saved, false, 'a Stage nobody marks read-only carries no key')

      // Save prunes too, so an entry can't be written for a Module taken off while the field is focused.
      await alphaBox.check()
      await modulesField.focus()
      await modulesField.fill('')
      saved = await save()
      assert.equal('read-only-modules' in saved, false)
    })
  })
})
