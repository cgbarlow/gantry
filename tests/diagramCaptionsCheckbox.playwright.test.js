import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #195 (ADR-0053): the Definitions page's per-Artefact "Diagram captions" checkbox, the
// `diagram-captions` engine option shown and edited the way #194's cover-page one is (ADR-0049's
// pattern). Unticked by default; ticking writes `diagram-captions: true`, unticking removes the
// key, and the setting survives save, a reload and publish, after which it is shown read-only.
// Setup mirrors tests/coverPageCheckbox.playwright.test.js, over a draft copy of
// recruitment-onboarding v2, which no bundled Artefact opts in on.

const CHECKBOX = '.defn-diagram-captions input[type="checkbox"]'

async function withDraftRecruitment(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-diagram-captions-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-diagram-captions-'))
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
  const diagramCaptions = page.locator(CHECKBOX)
  await diagramCaptions.waitFor({ state: 'visible', timeout: 10_000 })
  return diagramCaptions
}

async function save(page) {
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/recruitment-onboarding/versions/2'), { timeout: 10_000 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  assert.equal((await saved).status(), 200)
}

test('Definitions page: ticking Diagram captions writes diagram-captions: true, which survives save, reload and publish, then shows read-only', async () => {
  await withDraftRecruitment(async (base, definitionsDir) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      page.on('dialog', (d) => d.accept())
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

      let diagramCaptions = await openFirstArtefact(page, base)
      const artefactId = await page.locator('.defn-focus .defn-focus-row input.mono').first().inputValue()
      assert.equal(artefactId, 'requisition-brief')
      assert.equal(await diagramCaptions.isChecked(), false, 'unticked by default — diagrams unnumbered')
      assert.equal(await diagramCaptions.isDisabled(), false, 'editable on a draft')

      await diagramCaptions.check()
      await save(page)
      assert.equal(artefactOnDisk(definitionsDir, artefactId)['diagram-captions'], true)

      await page.reload()
      diagramCaptions = await openFirstArtefact(page, base)
      assert.equal(await diagramCaptions.isChecked(), true, 'survives a reload')

      // Unticking removes the key again rather than writing false.
      await diagramCaptions.uncheck()
      await save(page)
      assert.equal('diagram-captions' in artefactOnDisk(definitionsDir, artefactId), false)

      await diagramCaptions.check()
      await save(page)
      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      assert.equal(artefactOnDisk(definitionsDir, artefactId)['diagram-captions'], true, 'survives publish')

      diagramCaptions = await openFirstArtefact(page, base)
      assert.equal(await diagramCaptions.isChecked(), true)
      assert.equal(await diagramCaptions.isDisabled(), true, 'read-only on a published version')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

// The Local Workspace twin (/definitions/local), seeded through OPFS the way
// tests/coverPageCheckbox.playwright.test.js does.
test('Local Workspace editor: ticking Diagram captions saves diagram-captions: true to the workspace\'s own folder, and unticking removes it', async () => {
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
        const dir = await root.getDirectoryHandle('local-ws-diagram-captions-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Diagram Captions E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/diagram-captions-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('diagram-captions-local-e2e')
      await page.locator('#local-def-title').fill('Diagram Captions Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })
      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      await artefactEl.locator('input[type="text"]').nth(0).fill('solution-design')
      await artefactEl.locator('input[type="text"]').nth(1).fill('Solution Design')

      const diagramCaptions = artefactEl.locator(CHECKBOX)
      await diagramCaptions.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await diagramCaptions.isChecked(), false)
      await diagramCaptions.check()

      const saveLocal = () => editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await saveLocal()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })
      assert.equal(parseYAML(await readDefinitionYaml()).artefacts[0]['diagram-captions'], true)

      // Unticking drops the key again. "Saved." is still showing from the first save, so wait on
      // the file itself. Mid-save the file can briefly not exist, which reads as "not yet".
      await diagramCaptions.uncheck()
      await saveLocal()
      await page.waitForFunction(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        try {
          const text = await readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/diagram-captions-local-e2e/1/definition.yaml')
          return !text.includes('diagram-captions')
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
