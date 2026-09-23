import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #150 (ADR-0049): the Definitions page's per-Artefact "Document Control" checkbox — ticked by
// default (the tables are printed), unticking it writes `document-control: false`, and that
// survives save, a reload and publish, after which the box is shown read-only. Setup mirrors
// tests/definition-viewer.playwright.test.js: a draft v2 copy of the design Definition.

async function withDraftDesignV2(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-doc-control-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-doc-control-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    const yamlPath = join(definitionsDir, 'design/2/definition.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('version: 1', 'version: 2').replace('status: published', 'status: draft'))
    await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, definitionsDir))
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function artefactOnDisk(definitionsDir, artefactId) {
  const raw = parseYAML(readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8'))
  return raw.artefacts.find((a) => a.id === artefactId)
}

// Opens design v2 and focuses its first Artefact, waiting for the checkbox to render.
async function openFirstArtefact(page, base) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
  await page.locator('#defn-version-select').selectOption('2')
  await page.waitForSelector('.defn-outline', { timeout: 10_000 })
  const artefactNode = page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').first()
  await artefactNode.waitFor({ state: 'visible', timeout: 10_000 })
  await artefactNode.click()
  const checkbox = page.locator('.defn-document-control input[type="checkbox"]')
  await checkbox.waitFor({ state: 'visible', timeout: 10_000 })
  return checkbox
}

test('Definitions page: unticking an Artefact\'s Document Control box writes document-control: false, which survives save, reload and publish, then shows read-only', async () => {
  await withDraftDesignV2(async (base, definitionsDir) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      page.on('dialog', (d) => d.accept())
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

      let checkbox = await openFirstArtefact(page, base)
      const artefactId = await page.locator('.defn-focus .defn-focus-row input.mono').first().inputValue()
      assert.equal(await checkbox.isChecked(), true, 'ticked by default — the tables are printed')
      assert.equal(await checkbox.isDisabled(), false, 'editable on a draft')
      assert.equal(artefactOnDisk(definitionsDir, artefactId)['document-control'], undefined)

      await checkbox.uncheck()
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/design/versions/2'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      assert.equal(artefactOnDisk(definitionsDir, artefactId)['document-control'], false)

      await page.reload()
      checkbox = await openFirstArtefact(page, base)
      assert.equal(await checkbox.isChecked(), false, 'the opt-out survives a reload')

      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      const published = artefactOnDisk(definitionsDir, artefactId)
      assert.equal(published['document-control'], false, 'the opt-out survives publish')

      checkbox = await openFirstArtefact(page, base)
      assert.equal(await checkbox.isChecked(), false)
      assert.equal(await checkbox.isDisabled(), true, 'read-only on a published version')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

// The Local Workspace twin (/definitions/local), seeded through OPFS the way
// tests/typedFieldsFilenamePatternEditor.playwright.test.js does.
test('Local Workspace editor: unticking an Artefact\'s Document Control box saves document-control: false to the workspace\'s own folder', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(async () => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-doc-control-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Document Control E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/doc-control-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('doc-control-local-e2e')
      await page.locator('#local-def-title').fill('Document Control Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })
      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      await artefactEl.locator('input[type="text"]').nth(0).fill('offer-pack')
      await artefactEl.locator('input[type="text"]').nth(1).fill('Offer Pack')

      const checkbox = artefactEl.locator('.defn-document-control input[type="checkbox"]')
      await checkbox.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await checkbox.isChecked(), true)
      await checkbox.uncheck()

      const save = () => editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await save()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })
      assert.equal(parseYAML(await readDefinitionYaml()).artefacts[0]['document-control'], false)

      // Re-ticking drops the key again. "Saved." is still showing from the first save, so wait on
      // the file itself rather than the status line. Mid-save the file can briefly not exist, which
      // reads as "not yet".
      await checkbox.check()
      await save()
      await page.waitForFunction(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        try {
          const text = await readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/doc-control-local-e2e/1/definition.yaml')
          return !text.includes('document-control')
        } catch {
          return false
        }
      }, workspaceId, { timeout: 5_000 })
      assert.equal(parseYAML(await readDefinitionYaml()).artefacts[0]['document-control'], undefined)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})
