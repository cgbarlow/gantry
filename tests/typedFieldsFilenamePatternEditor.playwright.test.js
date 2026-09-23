import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition } from '../lib/definition.js'

// #89 (ADR-0045): browser coverage for authoring an Artefact's filename: pattern in the
// Definition editor — the eligible-tokens chip list (built-ins plus the artefact's own
// single-valued select/text/date requirements), inline validation naming the offending token,
// and persistence across a reload (server-hosted) / the workspace's own OPFS folder (Local
// Workspace). Covers both twins: web/pages/definition-viewer.js (/definitions) and
// web/pages/local-definition-editor.js (/definitions/local) — see
// tests/typedFieldsFieldEditor.playwright.test.js for the conventions this file follows for each.

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text())
    })
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------
// Server-hosted editor (/definitions)
// ---------------------------------------------------------------------------

function withBlankServerDefinition(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-filenamepattern-e2e-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-filenamepattern-e2e-'))
    try {
      createBlankDefinition('filenamepattern-e2e', { definitionsDir, title: 'Filename Pattern E2E' })
      await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, definitionsDir))
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

test(
  'server-hosted editor: eligible tokens grow with requires, an invalid pattern names the offending token, a valid one clears, and it persists across reload',
  withBlankServerDefinition(async (base, definitionsDir) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      // Stage first (loadDefinition() only picks a module back up on reload via a stage/artefact
      // reference to it — see tests/typedFieldsFieldEditor.playwright.test.js's own comment on this).
      const stagesGroup = page.locator('.defn-outline-group').nth(0)
      await stagesGroup.getByRole('button', { name: 'Add stage' }).click()
      await page.waitForSelector('.defn-focus .kicker', { timeout: 5_000 })

      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      await modulesGroup.getByRole('button', { name: 'Add module' }).click()
      await page.waitForSelector('.defn-focus .kicker', { timeout: 5_000 })

      // Two fields: a single-valued "text" and a single-valued "date" — both eligible tokens once
      // required by the artefact below.
      await page.getByRole('button', { name: '+ Add field' }).click()
      await page.getByRole('button', { name: '+ Add field' }).click()

      const firstRow = page.locator('.defn-field-row-head').nth(0)
      await firstRow.click()
      let openRow = page.locator('.defn-field-row.open')
      await openRow.waitFor({ state: 'visible', timeout: 5_000 })
      await openRow.locator('input').nth(0).fill('Candidate name')
      await openRow.locator('input').nth(1).fill('name')
      await openRow.locator('.defn-field-type').selectOption('text')
      await firstRow.click() // collapse

      const secondRow = page.locator('.defn-field-row-head').nth(1)
      await secondRow.click()
      openRow = page.locator('.defn-field-row.open')
      await openRow.waitFor({ state: 'visible', timeout: 5_000 })
      await openRow.locator('input').nth(0).fill('Start date')
      await openRow.locator('input').nth(1).fill('start-date')
      await openRow.locator('.defn-field-type').selectOption('date')

      // Wire the module into the stage.
      await stagesGroup.locator('.defn-outline-node').first().click()
      const addModuleSelect = page.locator('.defn-focus select').first()
      await addModuleSelect.waitFor({ state: 'visible', timeout: 5_000 })
      await addModuleSelect.selectOption('new-module-1')

      // New artefact — auto-selected on creation.
      const artefactsGroup = page.locator('.defn-outline-group').nth(1)
      await artefactsGroup.getByRole('button', { name: 'Add artefact' }).click()
      await page.waitForSelector('.defn-filename-input', { timeout: 5_000 })

      // No requires yet: only the three built-ins are offered.
      let tokenTexts = await page.locator('.defn-filename-token').allTextContents()
      assert.deepEqual(tokenTexts, ['{instance.name}', '{instance.slug}', '{today}'])

      // Require the text field: it joins the eligible-tokens list.
      const addReqSelect = page.locator('.defn-focus-section').filter({ hasText: 'Requires' }).locator('select')
      await addReqSelect.selectOption({ label: 'New Module · Candidate name' })
      await page.waitForFunction(() => document.querySelectorAll('.defn-filename-token').length === 4, { timeout: 5_000 })
      tokenTexts = await page.locator('.defn-filename-token').allTextContents()
      assert.ok(tokenTexts.includes('{new-module-1.name}'), 'the required text field is offered as a token')
      assert.ok(!tokenTexts.includes('{new-module-1.start-date}'), 'the not-yet-required date field is not offered yet')

      const filenameInput = page.locator('.defn-filename-input')

      // An unknown token names itself in the inline error.
      await filenameInput.fill('{nope} - Offer Pack')
      await page.waitForSelector('.defn-filename-problems li', { timeout: 5_000 })
      let problemText = await page.locator('.defn-filename-problems li').first().textContent()
      assert.match(problemText, /Artefact "new-artefact-1"/)
      assert.match(problemText, /\{nope\}/)
      assert.match(problemText, /not a field or a built-in/)

      // A real, single-valued field the artefact doesn't (yet) require also names itself.
      await filenameInput.fill('{new-module-1.start-date} - Offer Pack')
      await page.waitForFunction(
        () => document.querySelector('.defn-filename-problems li')?.textContent?.includes('start-date'),
        { timeout: 5_000 }
      )
      problemText = await page.locator('.defn-filename-problems li').first().textContent()
      assert.match(problemText, /not in this artefact's own "requires" list/)

      // Requiring it clears the problem and adds its token to the eligible list.
      await addReqSelect.selectOption({ label: 'New Module · Start date' })
      await page.waitForFunction(() => document.querySelectorAll('.defn-filename-token').length === 5, { timeout: 5_000 })
      await page.waitForFunction(() => document.querySelectorAll('.defn-filename-problems li').length === 0, { timeout: 5_000 })

      // Clicking a chip appends its token to whatever the pattern already holds.
      await filenameInput.fill('')
      await page.locator('.defn-filename-token', { hasText: '{new-module-1.name}' }).click()
      assert.equal(await filenameInput.inputValue(), '{new-module-1.name}')
      await page.locator('.defn-filename-token', { hasText: '{today}' }).click()
      assert.equal(await filenameInput.inputValue(), '{new-module-1.name}{today}')

      await filenameInput.fill('{new-module-1.name} - Offer Pack ({today})')
      await page.waitForFunction(() => document.querySelectorAll('.defn-filename-problems li').length === 0, { timeout: 5_000 })

      const saveBtn = page.getByRole('button', { name: 'Save', exact: true })
      await saveBtn.click()
      await page.waitForFunction(() => document.querySelector('button.primary')?.textContent !== 'Saving…', { timeout: 10_000 })

      const definitionYaml = readFileSync(join(definitionsDir, 'filenamepattern-e2e', '1', 'definition.yaml'), 'utf8')
      assert.match(definitionYaml, /filename:.*new-module-1\.name.*Offer Pack.*today/)

      // ---------------------------------------------------------------
      // Reload: the pattern persists.
      // ---------------------------------------------------------------
      await page.reload()
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      await page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').first().click()
      await page.waitForSelector('.defn-filename-input', { timeout: 10_000 })
      assert.equal(await page.locator('.defn-filename-input').inputValue(), '{new-module-1.name} - Offer Pack ({today})')

      // Clearing it also persists.
      await page.locator('.defn-filename-input').fill('')
      await saveBtn.click()
      await page.waitForFunction(() => document.querySelector('button.primary')?.textContent !== 'Saving…', { timeout: 10_000 })
      await page.reload()
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      await page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').first().click()
      await page.waitForSelector('.defn-filename-input', { timeout: 10_000 })
      assert.equal(await page.locator('.defn-filename-input').inputValue(), '')

      assert.deepEqual(pageErrors, [])
    })
  })
)

// ---------------------------------------------------------------------------
// Local Workspace editor (/definitions/local) — File System Access API, via the same OPFS-seeding
// convention tests/definitionEditorPhase4.playwright.test.js established.
// ---------------------------------------------------------------------------

async function rememberBareLocalWorkspace(page, name) {
  return page.evaluate(async (name) => {
    const { rememberWorkspace } = await import('/lib/localWorkspace.js')
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('local-ws-filenamepattern-' + Date.now() + '-' + Math.random().toString(36).slice(2), {
      create: true,
    })
    return rememberWorkspace({ handle: dir, name })
  }, name)
}

async function readOpfsFile(page, workspaceId, path) {
  return page.evaluate(
    async ({ workspaceId, path }) => {
      const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
      const handle = await getWorkspaceHandle(workspaceId)
      return readTextFile(handle, path)
    },
    { workspaceId, path }
  )
}

test('Local Workspace editor: eligible tokens, click-to-insert, inline validation naming the token, and the pattern persisted to the workspace\'s own folder', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const workspaceId = await rememberBareLocalWorkspace(page, 'Filename Pattern E2E Workspace')
      assert.ok(workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('filenamepattern-local-e2e')
      await page.locator('#local-def-title').fill('Filename Pattern Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const modulesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Modules' }) })

      // #149: a Stage first, so the Artefact below has a real Stage gate to name — an Artefact gate
      // that names no Stage gate is itself a validation problem.
      const stagesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Stages' }) })
      await stagesSection.getByRole('button', { name: '+ Add stage' }).click()
      const stageEl = stagesSection.locator('.local-def-element').first()
      await stageEl.locator('input').nth(0).fill('offer')
      await stageEl.locator('input').nth(1).fill('Offer')
      // Not GATES[0], so the Artefact's gate list below can only have come from the Stages' own gates.
      await stageEl.locator('select').first().selectOption('design-review')

      await modulesSection.getByRole('button', { name: '+ Add module' }).click()
      const moduleEl = modulesSection.locator('.local-def-element').first()
      await moduleEl.locator('input').nth(0).fill('candidate')
      await moduleEl.locator('input').nth(1).fill('Candidate')

      await moduleEl.getByRole('button', { name: '+ Add field' }).click()
      const fieldRow = moduleEl.locator('.local-def-field-block').first()
      await fieldRow.locator('input').nth(0).fill('name')
      await fieldRow.locator('input').nth(1).fill('Candidate name')
      await fieldRow.locator('.defn-field-type').selectOption('text')

      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })
      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      // #149: the Artefact starts on, and may only pick, a gate some Stage has.
      const artefactGate = artefactEl.locator('select').first()
      assert.equal(await artefactGate.inputValue(), 'design-review')
      assert.deepEqual(await artefactGate.locator('option').evaluateAll((options) => options.map((o) => o.value)), ['', 'design-review'])
      const textInputs = artefactEl.locator('input[type="text"]')
      await textInputs.nth(0).fill('offer-pack')
      await textInputs.nth(1).fill('Offer Pack')

      const requiresInput = textInputs.nth(3)
      const filenameInput = artefactEl.locator('.defn-filename-input')

      // No requires yet: only the three built-ins are offered.
      assert.deepEqual(await artefactEl.locator('.defn-filename-token').allTextContents(), ['{instance.name}', '{instance.slug}', '{today}'])

      await requiresInput.fill('candidate.name')
      await page.waitForFunction((el) => el?.querySelectorAll('.defn-filename-token').length === 4, await artefactEl.elementHandle(), { timeout: 5_000 })
      const tokenTexts = await artefactEl.locator('.defn-filename-token').allTextContents()
      assert.ok(tokenTexts.includes('{candidate.name}'))

      // Click-to-insert.
      await artefactEl.locator('.defn-filename-token', { hasText: '{candidate.name}' }).click()
      assert.equal(await filenameInput.inputValue(), '{candidate.name}')
      await artefactEl.locator('.defn-filename-token', { hasText: '{today}' }).click()
      assert.equal(await filenameInput.inputValue(), '{candidate.name}{today}')

      // An unknown token is flagged, naming itself, in the shared Validation section.
      await filenameInput.fill('{nope}')
      await page.waitForSelector('.local-def-problems li', { timeout: 5_000 })
      let problemText = await page.locator('.local-def-problems li').first().textContent()
      assert.match(problemText, /Artefact "offer-pack"/)
      assert.match(problemText, /\{nope\}/)

      // A valid pattern clears it.
      await filenameInput.fill('{candidate.name} - Offer Pack')
      await page.waitForSelector('.save-status:has-text("No problems found.")', { timeout: 5_000 })

      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })

      const definitionYaml = await readOpfsFile(page, workspaceId, 'definitions/filenamepattern-local-e2e/1/definition.yaml')
      assert.match(definitionYaml, /\{candidate\.name\} - Offer Pack/)

      // Clearing it persists too.
      await filenameInput.fill('')
      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })

      const definitionYamlAfterClear = await readOpfsFile(page, workspaceId, 'definitions/filenamepattern-local-e2e/1/definition.yaml')
      assert.doesNotMatch(definitionYamlAfterClear, /\{candidate\.name\}/)
      assert.match(definitionYamlAfterClear, /filename: ""/)

      assert.deepEqual(pageErrors, [])
    })
  })
})
