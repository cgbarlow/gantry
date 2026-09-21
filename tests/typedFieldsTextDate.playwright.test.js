import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion, loadDefinition } from '../lib/definition.js'
import { createInstance, readModule } from '../lib/instance.js'

// #85 (ADR-0044): browser coverage for `text` (single-line input) and `date` (native date
// picker, storing YYYY-MM-DD) — the Stage editor's two newest field types.

const STRUCTURE = {
  id: 'textdate-browser-fixture',
  title: 'TextDate Browser Fixture',
  description: '',
  version: 1,
  status: 'draft',
  stages: [{ id: 'only', title: 'Only', purpose: 'The one stage', gate: 'g', modules: ['candidate'] }],
  artefacts: [{ id: 'summary', title: 'Summary', purpose: 'Summarise', template: 'templates/summary.md.tmpl', gate: 'g', requires: ['candidate.name', 'candidate.start-date'] }],
  modules: [
    {
      id: 'candidate',
      title: 'Candidate',
      purpose: 'Who and when',
      fields: [
        { id: 'name', title: 'Candidate name', type: 'text', required: true },
        { id: 'start-date', title: 'Start date', type: 'date', required: true },
      ],
    },
  ],
}

function withFixtureServer(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-textdate-browser-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-textdate-browser-'))
    try {
      createBlankDefinition('textdate-browser-fixture', { definitionsDir })
      writeDefinitionVersion('textdate-browser-fixture', 1, STRUCTURE, { definitionsDir })
      publishDefinitionVersion('textdate-browser-fixture', 1, { definitionsDir })
      createInstance('textdate-browser-fixture', 'textdate-browser-demo', { definitionsDir, instancesDir })
      // migrateWorkspacesOnStart MUST be false — a freshly-seeded instance directory otherwise
      // gets silently migrated to a different on-disk path and later disk-level assertions fail
      // mysteriously (cost real debugging time in #81).
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
  'a text field renders a single-line input and a date field offers the native date picker; both store what was typed',
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

      await page.goto(`${base}/instance/textdate-browser-demo`)
      await page.waitForSelector('.field-text input[type="text"]', { timeout: 10_000 })
      await page.waitForSelector('.field-date input[type="date"]', { timeout: 10_000 })

      // Both start empty — no value carried from creation.
      assert.equal(await page.locator('.field-text input[type="text"]').inputValue(), '')
      assert.equal(await page.locator('.field-date input[type="date"]').inputValue(), '')

      await page.locator('.field-text input[type="text"]').fill('Jane Smith')
      await page.locator('.field-date input[type="date"]').fill('2026-11-03')

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('.save-status')?.textContent?.includes('Saved'),
        { timeout: 5_000 }
      )

      const definition = loadDefinition('textdate-browser-fixture', { definitionsDir })
      const onDisk = readModule(definition, 'textdate-browser-demo', 'candidate', { instancesDir })
      assert.equal(onDisk.fields.name, 'Jane Smith')
      assert.equal(onDisk.fields['start-date'], '2026-11-03')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
)
