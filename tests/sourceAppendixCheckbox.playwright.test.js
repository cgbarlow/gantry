import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #281 (map #238): the Definitions page's per-Artefact "Sources appendix" checkbox, the
// `source-appendix` engine option shown and edited the way #195's diagram-captions one is (ADR-0049's
// pattern). Unticked by default; ticking writes `source-appendix: true`, unticking removes the
// key, and the setting survives save, a reload and publish, after which it is shown read-only.
// Setup mirrors tests/coverPageCheckbox.playwright.test.js, over a draft copy of
// recruitment-onboarding v2, which no bundled Artefact opts in on.

const CHECKBOX = '.defn-source-appendix input[type="checkbox"]'

async function withDraftRecruitment(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-source-appendix-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-source-appendix-'))
  try {
    const root = join(definitionsDir, 'recruitment-onboarding')
    cpSync('definitions/recruitment-onboarding/2', join(root, '1'), { recursive: true })
    cpSync('definitions/recruitment-onboarding/2', join(root, '2'), { recursive: true })
    const v1 = join(root, '1/definition.yaml')
    writeFileSync(v1, readFileSync(v1, 'utf8').replace(/^version: 2$/m, 'version: 1'))
    const v2 = join(root, '2/definition.yaml')
    writeFileSync(v2, readFileSync(v2, 'utf8').replace(/^status: published$/m, 'status: draft'))
    await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, definitionsDir))
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function artefactOnDisk(definitionsDir, artefactId) {
  const raw = parseYAML(readFileSync(join(definitionsDir, 'recruitment-onboarding/2/definition.yaml'), 'utf8'))
  return raw.artefacts.find((a) => a.id === artefactId)
}

// Opens v2 and focuses its first Artefact (the Requisition Brief), waiting for the checkbox.
async function openFirstArtefact(page, base) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
  await page.locator('#defn-version-select').selectOption('2')
  await page.waitForSelector('.defn-outline', { timeout: 10_000 })
  const artefactNode = page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').first()
  await artefactNode.waitFor({ state: 'visible', timeout: 10_000 })
  await artefactNode.click()
  const sourceAppendix = page.locator(CHECKBOX)
  await sourceAppendix.waitFor({ state: 'visible', timeout: 10_000 })
  return sourceAppendix
}

async function save(page) {
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/recruitment-onboarding/versions/2'), { timeout: 10_000 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  assert.equal((await saved).status(), 200)
}

test('Definitions page: ticking Sources appendix writes source-appendix: true, which survives save, reload and publish, then shows read-only', async () => {
  await withDraftRecruitment(async (base, definitionsDir) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      page.on('dialog', (d) => d.accept())
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

      let sourceAppendix = await openFirstArtefact(page, base)
      const artefactId = await page.locator('.defn-focus .defn-focus-row input.mono').first().inputValue()
      assert.equal(artefactId, 'requisition-brief')
      assert.equal(await sourceAppendix.isChecked(), false, 'unticked by default — no Sources list')
      assert.equal(await sourceAppendix.isDisabled(), false, 'editable on a draft')

      await sourceAppendix.check()
      await save(page)
      assert.equal(artefactOnDisk(definitionsDir, artefactId)['source-appendix'], true)

      await page.reload()
      sourceAppendix = await openFirstArtefact(page, base)
      assert.equal(await sourceAppendix.isChecked(), true, 'survives a reload')

      // Unticking removes the key again rather than writing false.
      await sourceAppendix.uncheck()
      await save(page)
      assert.equal('source-appendix' in artefactOnDisk(definitionsDir, artefactId), false)

      await sourceAppendix.check()
      await save(page)
      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      assert.equal(artefactOnDisk(definitionsDir, artefactId)['source-appendix'], true, 'survives publish')

      sourceAppendix = await openFirstArtefact(page, base)
      assert.equal(await sourceAppendix.isChecked(), true)
      assert.equal(await sourceAppendix.isDisabled(), true, 'read-only on a published version')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

// The Local Workspace twin (/definitions/local), seeded through OPFS the way
// tests/coverPageCheckbox.playwright.test.js does.
test('Local Workspace editor: ticking Sources appendix saves source-appendix: true to the workspace\'s own folder, and unticking removes it', async () => {
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
        const dir = await root.getDirectoryHandle('local-ws-source-appendix-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Source Appendix E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/source-appendix-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('source-appendix-local-e2e')
      await page.locator('#local-def-title').fill('Source Appendix Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })
      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      await artefactEl.locator('input[type="text"]').nth(0).fill('solution-design')
      await artefactEl.locator('input[type="text"]').nth(1).fill('Solution Design')

      const sourceAppendix = artefactEl.locator(CHECKBOX)
      await sourceAppendix.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await sourceAppendix.isChecked(), false)
      await sourceAppendix.check()

      const saveLocal = () => editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await saveLocal()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })
      assert.equal(parseYAML(await readDefinitionYaml()).artefacts[0]['source-appendix'], true)

      // Unticking drops the key again. "Saved." is still showing from the first save, so wait on
      // the file itself. Mid-save the file can briefly not exist, which reads as "not yet".
      await sourceAppendix.uncheck()
      await saveLocal()
      await page.waitForFunction(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        try {
          const text = await readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/source-appendix-local-e2e/1/definition.yaml')
          return !text.includes('source-appendix')
        } catch {
          return false
        }
      }, workspaceId, { timeout: 5_000 })

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})
