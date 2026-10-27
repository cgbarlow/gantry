import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #194 (ADR-0052): the Definitions page's per-Artefact front-matter controls — a "Cover page" and a
// "Table of contents" checkbox, both unticked by default, and a "Cover classification" choice of the
// Artefact's own single-valued select or text Fields. Ticking writes `cover-page: true` /
// `table-of-contents: true`, choosing writes `cover-classification`, and all three survive save, a
// reload and publish, after which they are shown read-only. Setup mirrors
// tests/documentControlCheckbox.playwright.test.js, over a draft copy of recruitment-onboarding v2
// (design v1 and v2 have no select or text Fields to classify with).
//
// #205: beside them, a "Cover purpose" text box writes `cover-purpose`, the statement the cover
// prints; emptying it removes the key.

const COVER_PURPOSE = 'This brief sets out the role the hiring manager needs filled.'

async function withDraftRecruitment(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-front-matter-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-front-matter-'))
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

// Opens v2 and focuses its first Artefact (the Requisition Brief), waiting for the controls to render.
async function openFirstArtefact(page, base) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
  await page.locator('#defn-version-select').selectOption('2')
  await page.waitForSelector('.defn-outline', { timeout: 10_000 })
  const artefactNode = page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').first()
  await artefactNode.waitFor({ state: 'visible', timeout: 10_000 })
  await artefactNode.click()
  const coverPage = page.locator('.defn-cover-page input[type="checkbox"]')
  await coverPage.waitFor({ state: 'visible', timeout: 10_000 })
  return { coverPage, tableOfContents: page.locator('.defn-table-of-contents input[type="checkbox"]') }
}

test('Definitions page: ticking Cover page and Table of contents, choosing a classification and writing a cover purpose writes all four, which survive save, reload and publish, then show read-only', async () => {
  await withDraftRecruitment(async (base, definitionsDir) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      page.on('dialog', (d) => d.accept())
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

      let { coverPage, tableOfContents } = await openFirstArtefact(page, base)
      const artefactId = await page.locator('.defn-focus .defn-focus-row input.mono').first().inputValue()
      assert.equal(artefactId, 'requisition-brief')
      assert.equal(await coverPage.isChecked(), false, 'unticked by default — no cover')
      assert.equal(await tableOfContents.isChecked(), false, 'unticked by default — no table of contents')
      assert.equal(await coverPage.isDisabled(), false, 'editable on a draft')

      const classification = page.locator('select.defn-cover-classification')
      // Only the Artefact's own single-valued select/text Fields are offered: Engagement type is a
      // select in its requires; markdown Fields such as the role summary are not.
      const offered = await classification.locator('option').allTextContents()
      assert.ok(offered.includes('Engagement · Engagement type'), JSON.stringify(offered))
      assert.ok(!offered.includes('Role · Role summary'), JSON.stringify(offered))

      await coverPage.check()
      await tableOfContents.check()
      await classification.selectOption({ label: 'Engagement · Engagement type' })
      const coverPurpose = page.locator('textarea.defn-cover-purpose')
      assert.equal(await coverPurpose.inputValue(), '', 'empty by default — no purpose line on the cover')
      await coverPurpose.fill(COVER_PURPOSE)
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/recruitment-onboarding/versions/2'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      let onDisk = artefactOnDisk(definitionsDir, artefactId)
      assert.equal(onDisk['cover-page'], true)
      assert.equal(onDisk['table-of-contents'], true)
      assert.equal(onDisk['cover-classification'], 'engagement.type')
      assert.equal(onDisk['cover-purpose'], COVER_PURPOSE)
      assert.notEqual(onDisk.purpose, COVER_PURPOSE, 'the author-facing purpose is left as it was')

      await page.reload()
      ;({ coverPage, tableOfContents } = await openFirstArtefact(page, base))
      assert.equal(await coverPage.isChecked(), true, 'survives a reload')
      assert.equal(await tableOfContents.isChecked(), true, 'survives a reload')
      assert.equal(await page.locator('select.defn-cover-classification').inputValue(), 'engagement.type')
      assert.equal(await page.locator('textarea.defn-cover-purpose').inputValue(), COVER_PURPOSE, 'survives a reload')

      // Unticking the table of contents removes the key again rather than writing false.
      await tableOfContents.uncheck()
      const resaved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/recruitment-onboarding/versions/2'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await resaved).status(), 200)
      onDisk = artefactOnDisk(definitionsDir, artefactId)
      assert.equal('table-of-contents' in onDisk, false)

      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      onDisk = artefactOnDisk(definitionsDir, artefactId)
      assert.equal(onDisk['cover-page'], true, 'survives publish')
      assert.equal(onDisk['cover-classification'], 'engagement.type', 'survives publish')
      assert.equal(onDisk['cover-purpose'], COVER_PURPOSE, 'survives publish')

      ;({ coverPage, tableOfContents } = await openFirstArtefact(page, base))
      assert.equal(await coverPage.isChecked(), true)
      assert.equal(await coverPage.isDisabled(), true, 'read-only on a published version')
      assert.equal(await tableOfContents.isChecked(), false)
      assert.equal(await tableOfContents.isDisabled(), true)
      assert.match(await page.locator('.defn-focus').textContent(), /Cover classification\s*engagement\.type/)
      assert.match(await page.locator('.defn-focus').textContent(), new RegExp(`Cover purpose\\s*${COVER_PURPOSE.replace(/\./g, '\\.')}`))
      assert.equal(await page.locator('textarea.defn-cover-purpose').count(), 0, 'not editable on a published version')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

// The Local Workspace twin (/definitions/local), seeded through OPFS the way
// tests/documentControlCheckbox.playwright.test.js does.
test('Local Workspace editor: ticking Cover page and Table of contents and writing a cover purpose saves them to the workspace\'s own folder, and unticking or emptying removes them', async () => {
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
        const dir = await root.getDirectoryHandle('local-ws-front-matter-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Front Matter E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/front-matter-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('front-matter-local-e2e')
      await page.locator('#local-def-title').fill('Front Matter Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })
      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      await artefactEl.locator('input[type="text"]').nth(0).fill('solution-design')
      await artefactEl.locator('input[type="text"]').nth(1).fill('Solution Design')

      const coverPage = artefactEl.locator('.defn-cover-page input[type="checkbox"]')
      const tableOfContents = artefactEl.locator('.defn-table-of-contents input[type="checkbox"]')
      await coverPage.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await coverPage.isChecked(), false)
      assert.equal(await tableOfContents.isChecked(), false)
      assert.equal(await artefactEl.locator('select.defn-cover-classification').count(), 1, 'the classification choice is there too')
      const coverPurpose = artefactEl.locator('textarea.defn-cover-purpose')
      assert.equal(await coverPurpose.inputValue(), '')
      await coverPage.check()
      await tableOfContents.check()
      await coverPurpose.fill(COVER_PURPOSE)

      const save = () => editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await save()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })
      const saved = parseYAML(await readDefinitionYaml()).artefacts[0]
      assert.equal(saved['cover-page'], true)
      assert.equal(saved['table-of-contents'], true)
      assert.equal(saved['cover-purpose'], COVER_PURPOSE)

      // Unticking drops the keys again. "Saved." is still showing from the first save, so wait on
      // the file itself. Mid-save the file can briefly not exist, which reads as "not yet".
      await coverPage.uncheck()
      await tableOfContents.uncheck()
      await coverPurpose.fill('')
      await save()
      await page.waitForFunction(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        try {
          const text = await readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/front-matter-local-e2e/1/definition.yaml')
          return !text.includes('cover-page') && !text.includes('table-of-contents') && !text.includes('cover-purpose')
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
