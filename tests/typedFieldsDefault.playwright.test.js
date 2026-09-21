import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion, loadDefinition } from '../lib/definition.js'
import { createInstance, readModule } from '../lib/instance.js'

// #84 (ADR-0044): browser coverage for default: — pre-selected in the editor on a never-saved
// Field, written to the Module file only once the Stage is saved.

const STRUCTURE = {
  id: 'default-browser-fixture',
  title: 'Default Browser Fixture',
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
      fields: [{ id: 'type', title: 'Engagement type', type: 'select', required: true, default: 'Permanent', options: ['Permanent', 'Fixed term', 'Contractor'] }],
    },
  ],
}

function withFixtureServer(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-default-browser-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-default-browser-'))
    try {
      createBlankDefinition('default-browser-fixture', { definitionsDir })
      writeDefinitionVersion('default-browser-fixture', 1, STRUCTURE, { definitionsDir })
      publishDefinitionVersion('default-browser-fixture', 1, { definitionsDir })
      createInstance('default-browser-fixture', 'default-browser-demo', { definitionsDir, instancesDir })
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
  'a defaulted field shows pre-selected on a never-saved instance, and the first save writes it',
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

      await page.goto(`${base}/instance/default-browser-demo`)
      await page.waitForSelector('.field-select select', { timeout: 10_000 })

      // Pre-selected before anything is saved.
      assert.equal(await page.locator('.field-select select').inputValue(), 'Permanent')

      // Nothing on disk yet — the module file was never touched.
      const definition = loadDefinition('default-browser-fixture', { definitionsDir })
      assert.equal(readModule(definition, 'default-browser-demo', 'engagement', { instancesDir }).fields.type, '')

      // Save without changing the dropdown — the default is what gets written.
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('.save-status')?.textContent?.includes('Saved'),
        { timeout: 5_000 }
      )

      assert.equal(readModule(definition, 'default-browser-demo', 'engagement', { instancesDir }).fields.type, 'Permanent')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
)
