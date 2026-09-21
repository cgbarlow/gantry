import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion, loadDefinition } from '../lib/definition.js'
import { createInstance, readModule } from '../lib/instance.js'

// #81 (ADR-0044): browser coverage for type: select — the Stage editor's dropdown control.
// tests/definition.test.js and tests/localDefinitionFiles.test.js cover the engine (round trip,
// validation); this is the one browser-level check the epic's testing decisions call for.

const SELECT_STRUCTURE = {
  id: 'select-fixture',
  title: 'Select Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['engagement'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: ['engagement.type'] }],
  modules: [
    {
      id: 'engagement',
      title: 'Engagement',
      purpose: 'How the engagement is classified',
      fields: [
        { id: 'type', title: 'Engagement type', type: 'select', required: true, options: ['Permanent', 'Fixed term', 'Contractor'] },
      ],
    },
  ],
}

function withSelectFixtureServer(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-select-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-select-'))
    try {
      createBlankDefinition('select-fixture', { definitionsDir })
      writeDefinitionVersion('select-fixture', 1, SELECT_STRUCTURE, { definitionsDir })
      publishDefinitionVersion('select-fixture', 1, { definitionsDir })
      createInstance('select-fixture', 'select-demo', { definitionsDir, instancesDir })
      await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, (base) =>
        fn(base, { definitionsDir, instancesDir })
      )
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

test(
  'a select field renders as a dropdown, opens unselected with no default, and saving writes the chosen string as the section body',
  withSelectFixtureServer(async (base, { definitionsDir, instancesDir }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.goto(`${base}/instance/select-demo`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      const select = page.locator('.field-select select')
      await assert.doesNotReject(select.waitFor({ state: 'visible', timeout: 5_000 }))

      // No default declared — opens unselected.
      assert.equal(await select.inputValue(), '')

      const optionLabels = await select.locator('option').allTextContents()
      assert.deepEqual(
        optionLabels.filter((label) => label !== '— Select —'),
        ['Permanent', 'Fixed term', 'Contractor']
      )

      await select.selectOption('Fixed term')
      assert.equal(await select.inputValue(), 'Fixed term')
      const saveButton = page.getByRole('button', { name: 'Save', exact: true })
      await assert.doesNotReject(saveButton.waitFor({ state: 'visible', timeout: 5_000 }))
      await saveButton.click()
      await page.waitForFunction(
        () => document.querySelector('.save-status')?.textContent?.includes('Saved'),
        { timeout: 5_000 }
      )

      const definition = loadDefinition('select-fixture', { definitionsDir })
      const onDisk = readModule(definition, 'select-demo', 'engagement', { instancesDir })
      assert.equal(onDisk.fields.type, 'Fixed term')

      // Reload: the chosen option is pre-selected from the saved file.
      await page.reload()
      await page.waitForSelector('.field-select select', { timeout: 10_000 })
      assert.equal(await page.locator('.field-select select').inputValue(), 'Fixed term')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
)
