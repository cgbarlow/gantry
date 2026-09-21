import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition } from '../lib/definition.js'

// #86 (ADR-0044): browser coverage for authoring a select field's options/multiple/default from
// scratch through the Definition editor — the type picker (markdown/list/select/text/date), the
// options rows (add/edit/reorder/remove), the multiple/default controls appearing only for
// "select", the default control only offering the field's own current options, and the
// window.confirm warning before a type switch discards a select field's options. Covers both
// twins: the server-hosted editor (web/pages/definition-viewer.js, /definitions) and the Local
// Workspace editor (web/pages/local-definition-editor.js, /definitions/local) — see
// tests/typedFieldsSelect.playwright.test.js and tests/definitionEditorPhase4.playwright.test.js
// for the conventions this file follows for each.

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

function optionValues(locator) {
  return locator.evaluateAll((els) => els.map((el) => el.value))
}

// ---------------------------------------------------------------------------
// Server-hosted editor (/definitions)
// ---------------------------------------------------------------------------

function withBlankServerDefinition(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-fieldeditor-e2e-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-fieldeditor-e2e-'))
    try {
      createBlankDefinition('fieldeditor-e2e', { definitionsDir, title: 'Field Editor E2E' })
      await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, definitionsDir))
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

test(
  'server-hosted editor: authoring a dropdown from scratch — type picker, options add/edit/reorder/remove, multiple + default, warn on type switch, persists across reload',
  withBlankServerDefinition(async (base, definitionsDir) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      // A stage referencing the module is what makes loadDefinition() pick the module back up on
      // reload (an orphan module file with no stage/artefact reference is invisible to it) — so
      // create one first, then wire the new module into it below.
      const stagesGroup = page.locator('.defn-outline-group').nth(0)
      await stagesGroup.getByRole('button', { name: 'Add stage' }).click()
      await page.waitForSelector('.defn-focus .kicker', { timeout: 5_000 })

      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      await modulesGroup.getByRole('button', { name: 'Add module' }).click()
      await page.waitForSelector('.defn-focus .kicker', { timeout: 5_000 })

      await page.getByRole('button', { name: '+ Add field' }).click()
      await page.locator('.defn-field-row-head').first().click()
      const openRow = page.locator('.defn-field-row.open')
      await openRow.waitFor({ state: 'visible', timeout: 5_000 })

      // Type picker offers all five types.
      const typeOptions = await openRow.locator('.defn-field-type option').allTextContents()
      assert.deepEqual(typeOptions, ['markdown', 'list', 'select', 'text', 'date'])

      // multiple/default absent for the default "markdown" type.
      assert.equal(await openRow.locator('.defn-field-multiple').count(), 0)
      assert.equal(await openRow.locator('.defn-field-default').count(), 0)
      assert.equal(await openRow.locator('.defn-options-list').count(), 0)

      await openRow.locator('.defn-field-type').selectOption('select')
      assert.ok(await openRow.locator('.defn-field-multiple').count() > 0, 'multiple control appears once type is select')
      assert.ok(await openRow.locator('.defn-field-default').count() > 0, 'default control appears once type is select')

      // Add three options, in order.
      await openRow.locator('.defn-add-option').click()
      await openRow.locator('.defn-add-option').click()
      await openRow.locator('.defn-add-option').click()
      const optionInputs = openRow.locator('.defn-option-input')
      await optionInputs.nth(0).fill('Permanent')
      await optionInputs.nth(1).fill('Contractor')
      await optionInputs.nth(2).fill('Fixed term')
      assert.deepEqual(await optionValues(optionInputs), ['Permanent', 'Contractor', 'Fixed term'])

      // Reorder: move "Fixed term" up one, ahead of "Contractor".
      await openRow.locator('.defn-option-row').nth(2).getByRole('button', { name: 'Move option "Fixed term" up' }).click()
      assert.deepEqual(await optionValues(optionInputs), ['Permanent', 'Fixed term', 'Contractor'])

      // Remove "Contractor".
      const contractorIndex = (await optionValues(optionInputs)).indexOf('Contractor')
      await openRow.locator('.defn-option-row').nth(contractorIndex).getByRole('button', { name: 'Remove option "Contractor"' }).click()
      assert.deepEqual(await optionValues(optionInputs), ['Permanent', 'Fixed term'])

      // Default only offers the field's own current options.
      const defaultOptionTexts = await openRow.locator('.defn-field-default option').allTextContents()
      assert.deepEqual(defaultOptionTexts, ['None', 'Permanent', 'Fixed term'])

      await openRow.locator('.defn-field-multiple input[type="checkbox"]').check()
      await openRow.locator('.defn-field-default').selectOption('Fixed term')

      // Wire the new module into the stage (button route — see "Drag a module onto a stage adds
      // it" in tests/definition-viewer.playwright.test.js for the drag alternative).
      await stagesGroup.locator('.defn-outline-node').first().click()
      const addModuleSelect = page.locator('.defn-focus select').first()
      await addModuleSelect.waitFor({ state: 'visible', timeout: 5_000 })
      await addModuleSelect.selectOption('new-module-1')

      const saveBtn = page.getByRole('button', { name: 'Save', exact: true })
      await saveBtn.click()
      await page.waitForFunction(() => document.querySelector('button.primary')?.textContent !== 'Saving…', { timeout: 10_000 })

      // ---------------------------------------------------------------
      // Reload: everything persisted.
      // ---------------------------------------------------------------
      await page.reload()
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      await page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first().click()
      await page.locator('.defn-field-row-head').first().click()
      const reopened = page.locator('.defn-field-row.open')
      await reopened.waitFor({ state: 'visible', timeout: 10_000 })

      assert.equal(await reopened.locator('.defn-field-type').inputValue(), 'select')
      assert.deepEqual(await optionValues(reopened.locator('.defn-option-input')), ['Permanent', 'Fixed term'])
      assert.equal(await reopened.locator('.defn-field-multiple input[type="checkbox"]').isChecked(), true)
      assert.equal(await reopened.locator('.defn-field-default').inputValue(), 'Fixed term')

      // ---------------------------------------------------------------
      // Switching away from select warns before discarding options — Dismiss keeps it a select.
      // ---------------------------------------------------------------
      let dialogMessage = null
      await Promise.all([
        page.waitForEvent('dialog').then(async (d) => {
          dialogMessage = d.message()
          await d.dismiss()
        }),
        reopened.locator('.defn-field-type').selectOption('text'),
      ])
      assert.match(dialogMessage, /discards its 2 options/)
      assert.equal(await reopened.locator('.defn-option-row').count(), 2, 'dismissing the confirm must not discard the options')

      // Accept discards the options and hides multiple/default.
      await Promise.all([
        page.waitForEvent('dialog').then((d) => d.accept()),
        reopened.locator('.defn-field-type').selectOption('text'),
      ])
      await page.waitForFunction(() => document.querySelector('.defn-field-row.open .defn-field-type')?.value === 'text', { timeout: 5_000 })
      assert.equal(await reopened.locator('.defn-options-list').count(), 0)
      assert.equal(await reopened.locator('.defn-field-multiple').count(), 0)
      assert.equal(await reopened.locator('.defn-field-default').count(), 0)

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('button.primary')?.textContent !== 'Saving…', { timeout: 10_000 })

      const moduleYaml = readFileSync(join(definitionsDir, 'fieldeditor-e2e', '1', 'modules', 'new-module-1.yaml'), 'utf8')
      assert.match(moduleYaml, /type: text/)
      assert.doesNotMatch(moduleYaml, /options:/)
      assert.doesNotMatch(moduleYaml, /multiple:/)
      assert.doesNotMatch(moduleYaml, /default:/)

      assert.deepEqual(pageErrors, [])
    })
  })
)

// ---------------------------------------------------------------------------
// Local Workspace editor (/definitions/local) — File System Access API, via the same OPFS-seeding
// convention tests/definitionEditorPhase4.playwright.test.js already established.
// ---------------------------------------------------------------------------

async function rememberBareLocalWorkspace(page, name) {
  return page.evaluate(async (name) => {
    const { rememberWorkspace } = await import('/lib/localWorkspace.js')
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('local-ws-fieldeditor-' + Date.now() + '-' + Math.random().toString(36).slice(2), {
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

test('Local Workspace editor: authoring a dropdown from scratch — same controls, persisted to the workspace\'s own folder, and the type-switch warning', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const workspaceId = await rememberBareLocalWorkspace(page, 'Field Editor E2E Workspace')
      assert.ok(workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('fieldeditor-local-e2e')
      await page.locator('#local-def-title').fill('Field Editor Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const modulesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Modules' }) })

      await modulesSection.getByRole('button', { name: '+ Add module' }).click()
      const moduleEl = modulesSection.locator('.local-def-element').first()
      await moduleEl.locator('input').nth(0).fill('engagement')
      await moduleEl.locator('input').nth(1).fill('Engagement')

      await moduleEl.getByRole('button', { name: '+ Add field' }).click()
      const fieldRow = moduleEl.locator('.local-def-field-block').first()
      await fieldRow.locator('input').nth(0).fill('type')
      await fieldRow.locator('input').nth(1).fill('Engagement type')

      const typeSelect = fieldRow.locator('.defn-field-type')
      const typeOptions = await typeSelect.locator('option').allTextContents()
      assert.deepEqual(typeOptions, ['markdown', 'list', 'select', 'text', 'date'])
      assert.equal(await fieldRow.locator('.defn-field-multiple').count(), 0)

      await typeSelect.selectOption('select')
      assert.ok(await fieldRow.locator('.defn-field-multiple').count() > 0)
      assert.ok(await fieldRow.locator('.defn-field-default').count() > 0)

      await fieldRow.locator('.defn-add-option').click()
      await fieldRow.locator('.defn-add-option').click()
      const optionInputs = fieldRow.locator('.defn-option-input')
      await optionInputs.nth(0).fill('Permanent')
      await optionInputs.nth(1).fill('Contractor')
      assert.deepEqual(await optionValues(optionInputs), ['Permanent', 'Contractor'])

      // Reorder button route: move "Contractor" up ahead of "Permanent".
      await fieldRow.locator('.local-def-option-row').nth(1).getByRole('button', { name: 'Move option "Contractor" up' }).click()
      assert.deepEqual(await optionValues(optionInputs), ['Contractor', 'Permanent'])

      const defaultOptionTexts = await fieldRow.locator('.defn-field-default option').allTextContents()
      assert.deepEqual(defaultOptionTexts, ['None', 'Contractor', 'Permanent'])

      await fieldRow.locator('.defn-field-multiple input[type="checkbox"]').check()
      await fieldRow.locator('.defn-field-default').selectOption('Contractor')

      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })

      const moduleYaml = await readOpfsFile(page, workspaceId, 'definitions/fieldeditor-local-e2e/1/modules/engagement.yaml')
      assert.match(moduleYaml, /type: select/)
      assert.match(moduleYaml, /- Contractor/)
      assert.match(moduleYaml, /- Permanent/)
      assert.match(moduleYaml, /multiple: true/)
      assert.match(moduleYaml, /default: Contractor/)

      // Switching away from select warns; dismissing keeps the options. Dismissing a
      // window.confirm() leaves the field's own state untouched, so — unlike the accept path
      // below — there is no re-render guaranteed to snap the native <select>'s DOM value back to
      // "select"; assert on the state-driven options list instead of the raw element value.
      let dialogMessage = null
      await Promise.all([
        page.waitForEvent('dialog').then(async (d) => {
          dialogMessage = d.message()
          await d.dismiss()
        }),
        typeSelect.selectOption('date'),
      ])
      assert.match(dialogMessage, /discards its 2 options/)
      assert.equal(await fieldRow.locator('.local-def-option-row').count(), 2)

      await Promise.all([page.waitForEvent('dialog').then((d) => d.accept()), typeSelect.selectOption('date')])
      await page.waitForFunction((el) => el?.value === 'date', await typeSelect.elementHandle(), { timeout: 5_000 })
      assert.equal(await fieldRow.locator('.local-def-options').count(), 0)

      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })

      const moduleYamlAfterSwitch = await readOpfsFile(page, workspaceId, 'definitions/fieldeditor-local-e2e/1/modules/engagement.yaml')
      assert.match(moduleYamlAfterSwitch, /type: date/)
      assert.doesNotMatch(moduleYamlAfterSwitch, /options:/)
      assert.doesNotMatch(moduleYamlAfterSwitch, /multiple:/)
      assert.doesNotMatch(moduleYamlAfterSwitch, /default:/)

      assert.deepEqual(pageErrors, [])
    })
  })
})
