import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion, loadDefinition } from '../lib/definition.js'
import { createInstance, writeModule, readModule } from '../lib/instance.js'

// #82 (ADR-0044): browser coverage for an off-list select value — it must survive a full
// editor load-and-save cycle unchanged, and show as a marked, still-selected extra entry
// rather than reverting to blank. The engine side (check warning, Gate not blocked) is
// covered by tests/typedFieldsOffList.test.js.

const STRUCTURE = {
  id: 'offlist-browser-fixture',
  title: 'OffList Browser Fixture',
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
        { id: 'type', title: 'Engagement type', type: 'select', required: true, options: ['Permanent', 'Fixed term'] },
        { id: 'note', title: 'Note', type: 'markdown', required: false },
      ],
    },
  ],
}

function withOffListFixtureServer(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-offlist-browser-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-offlist-browser-'))
    try {
      createBlankDefinition('offlist-browser-fixture', { definitionsDir })
      writeDefinitionVersion('offlist-browser-fixture', 1, STRUCTURE, { definitionsDir })
      publishDefinitionVersion('offlist-browser-fixture', 1, { definitionsDir })
      createInstance('offlist-browser-fixture', 'offlist-browser-demo', { definitionsDir, instancesDir })
      const definition = loadDefinition('offlist-browser-fixture', { definitionsDir })
      writeModule(definition, 'offlist-browser-demo', 'engagement', {
        status: 'draft',
        owner: '',
        fields: { type: 'Contractor (grandfathered)' },
      }, { instancesDir })

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
  'an off-list select value shows as a marked, still-selected extra entry, and survives a load-and-save cycle unchanged',
  withOffListFixtureServer(async (base, { definitionsDir, instancesDir }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.goto(`${base}/instance/offlist-browser-demo`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      const select = page.locator('.field-select select')
      await assert.doesNotReject(select.waitFor({ state: 'visible', timeout: 5_000 }))

      // Still selected, not reverted to blank.
      assert.equal(await select.inputValue(), 'Contractor (grandfathered)')

      // Marked as an extra entry, distinguishable from the real options.
      const selectedOptionText = await select.locator('option:checked').textContent()
      assert.match(selectedOptionText, /not in option list/)
      await assert.doesNotReject(page.locator('.field-select-warning').waitFor({ state: 'visible', timeout: 2_000 }))

      // Touch the module's other field to make Save available — the select control itself is
      // never touched, proving a save this field had no part in still writes it back unchanged
      // rather than reverting it to blank or the first option.
      await page.locator('.field-markdown .cm-content').first().click()
      await page.keyboard.type('Confirmed via full-time review.')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('.save-status')?.textContent?.includes('Saved'),
        { timeout: 5_000 }
      )

      const definition = loadDefinition('offlist-browser-fixture', { definitionsDir })
      const onDisk = readModule(definition, 'offlist-browser-demo', 'engagement', { instancesDir })
      assert.equal(onDisk.fields.type, 'Contractor (grandfathered)')

      await page.reload()
      await page.waitForSelector('.field-select select', { timeout: 10_000 })
      assert.equal(await page.locator('.field-select select').inputValue(), 'Contractor (grandfathered)')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
)
