import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion, loadDefinition } from '../lib/definition.js'
import { createInstance, readModule } from '../lib/instance.js'

// #83 (ADR-0044): browser coverage for select multiple: true — ticking several options.

const STRUCTURE = {
  id: 'multiselect-browser-fixture',
  title: 'MultiSelect Browser Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['vetting'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: ['vetting.checks'] }],
  modules: [
    {
      id: 'vetting',
      title: 'Vetting',
      purpose: 'Which checks were run',
      fields: [
        { id: 'checks', title: 'Checks required', type: 'select', required: true, multiple: true, options: ['Police check', 'Reference check', 'Right-to-work check'] },
      ],
    },
  ],
}

function withFixtureServer(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-multiselect-browser-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-multiselect-browser-'))
    try {
      createBlankDefinition('multiselect-browser-fixture', { definitionsDir })
      writeDefinitionVersion('multiselect-browser-fixture', 1, STRUCTURE, { definitionsDir })
      publishDefinitionVersion('multiselect-browser-fixture', 1, { definitionsDir })
      createInstance('multiselect-browser-fixture', 'multiselect-browser-demo', { definitionsDir, instancesDir })
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
  'ticking several checkboxes on a multi-select field saves them as several values, restored on reload',
  withFixtureServer(async (base, { definitionsDir, instancesDir }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.goto(`${base}/instance/multiselect-browser-demo`)
      await page.waitForSelector('.field-select-multiple', { timeout: 10_000 })

      const rows = page.locator('.select-checkbox-row')
      assert.equal(await rows.count(), 3)

      await page.getByLabel('Police check', { exact: true }).check()
      await page.getByLabel('Right-to-work check', { exact: true }).check()

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('.save-status')?.textContent?.includes('Saved'),
        { timeout: 5_000 }
      )

      const definition = loadDefinition('multiselect-browser-fixture', { definitionsDir })
      const onDisk = readModule(definition, 'multiselect-browser-demo', 'vetting', { instancesDir })
      assert.deepEqual(onDisk.fields.checks, ['Police check', 'Right-to-work check'])

      await page.reload()
      await page.waitForSelector('.field-select-multiple', { timeout: 10_000 })
      assert.equal(await page.getByLabel('Police check', { exact: true }).isChecked(), true)
      assert.equal(await page.getByLabel('Reference check', { exact: true }).isChecked(), false)
      assert.equal(await page.getByLabel('Right-to-work check', { exact: true }).isChecked(), true)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
)
