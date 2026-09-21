import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { loadDefinition } from '../lib/definition.js'
import { createInstance, writeModule, writeInstanceStage, readModule } from '../lib/instance.js'

// #90 (epic #77): browser coverage for the real bundled `recruitment-onboarding/2` definition —
// unlike tests/typedFields*.playwright.test.js, which each build a throwaway single-purpose
// fixture, this drives the actual shipped Stage editor for the actual shipped Definition, per
// this ticket's own acceptance criterion ("An Instance created against v2 shows dropdowns, a
// date picker and a text field").
//
// `appointment` is the one stage in v2 that mounts a select (`engagement.type`, `offer.status`,
// `vetting.outcome`), a text field (`selection.candidate-name`) and a date field
// (`contract.start-date`) together, so the first test below fast-forwards a fresh Instance
// straight there with `writeInstanceStage` rather than walking every gate. The Stage editor's
// artefact filter (CONTEXT.md's "Field visibility per artefact") shows only the fields the
// selected artefact's own `requires` names, and neither artefact gated at `appointment`
// (`appointment-case`, `offer-pack`) requires `vetting.checks-required` — so the multi-select
// coverage below uses the earlier `selection` stage instead, where `selection-report` requires
// it. The definition itself, every stage, is already covered end to end in
// tests/typedFieldsRecruitmentOnboardingV2.test.js; this file's job is the Stage editor's actual
// rendering and save round trip.
//
// `definitionsDir` is deliberately omitted from `withRunningServer`'s options below: with no
// override, `createServer` resolves it to this repo's own real `definitions/` directory
// (lib/server.js), which is what makes this a test of the shipped content rather than a copy of
// it. Only `instancesDir` is a scratch temp dir — never the real `instances/`.

function withRealDefinitionServer(slug, stageId, moduleIds, fn) {
  return async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-ro-v2-browser-'))
    try {
      createInstance('recruitment-onboarding', slug, { instancesDir, version: 2 })
      const definition = loadDefinition('recruitment-onboarding', { version: 2 })
      for (const moduleId of moduleIds) {
        writeModule(definition, slug, moduleId, { status: 'draft', owner: '', fields: {} }, { instancesDir })
      }
      writeInstanceStage(slug, stageId, { instancesDir })
      // migrateWorkspacesOnStart MUST be false — a freshly-seeded instance directory otherwise
      // gets silently migrated to a different on-disk path and later disk-level assertions fail
      // mysteriously (cost real debugging time in #81).
      await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, (base) => fn(base, { instancesDir, definition }))
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

test(
  'an Instance created against the draft recruitment-onboarding/2 shows a dropdown, a date picker and a text field at the appointment stage, and saves what was chosen',
  withRealDefinitionServer(
    'ro-v2-appointment-demo',
    'appointment',
    ['role', 'engagement', 'role-evaluation', 'advertising', 'selection', 'vetting', 'offer', 'contract', 'payroll', 'open-questions'],
    async (base, { instancesDir, definition }) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/ro-v2-appointment-demo`)
        await page.waitForSelector('.field-select', { timeout: 10_000 })
        await page.waitForSelector('.field-text input[type="text"]', { timeout: 10_000 })
        await page.waitForSelector('.field-date input[type="date"]', { timeout: 10_000 })

        // engagement.type: a single-choice select, opens unselected (no default: in v2).
        const engagementType = page.locator('.field-select:not(.field-select-multiple) select').first()
        await engagementType.selectOption('Fixed term')

        // selection.candidate-name: a plain single-line text input.
        await page.locator('.field-text input[type="text"]').first().fill('Jane Smith')

        // contract.start-date: the native date picker.
        await page.locator('.field-date input[type="date"]').first().fill('2026-11-03')

        // Several modules on this stage are dirty at once (engagement, selection, contract), so
        // the per-module `.save-status` element the single-module typedFields*.playwright.test.js
        // fixtures wait on isn't reliably the one that updates first — the toolbar's own
        // single `.stage-save-state` status (StageSaveButton, web/app.js) is unambiguous.
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForFunction(
          () => document.querySelector('.stage-save-state')?.textContent?.includes('Saved'),
          { timeout: 5_000 }
        )

        const engagement = readModule(definition, 'ro-v2-appointment-demo', 'engagement', { instancesDir })
        assert.equal(engagement.fields.type, 'Fixed term')

        const selection = readModule(definition, 'ro-v2-appointment-demo', 'selection', { instancesDir })
        assert.equal(selection.fields['candidate-name'], 'Jane Smith')

        const contract = readModule(definition, 'ro-v2-appointment-demo', 'contract', { instancesDir })
        assert.equal(contract.fields['start-date'], '2026-11-03')

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    }
  )
)

test(
  'at the selection stage, vetting.checks-required and advertising.channels render as checkboxes and save several ticked values',
  withRealDefinitionServer(
    'ro-v2-selection-demo',
    'selection',
    ['role', 'advertising', 'selection', 'vetting', 'open-questions'],
    async (base, { instancesDir, definition }) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/ro-v2-selection-demo`)
        await page.waitForSelector('.field-select-multiple', { timeout: 10_000 })
        assert.equal(await page.locator('.field-select-multiple').count(), 2, 'vetting.checks-required and advertising.channels')

        await page.getByLabel('Right to work', { exact: true }).check()
        await page.getByLabel('Criminal record', { exact: true }).check()
        await page.getByLabel('Job boards', { exact: true }).check()

        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForFunction(
          () => document.querySelector('.stage-save-state')?.textContent?.includes('Saved'),
          { timeout: 5_000 }
        )

        const vetting = readModule(definition, 'ro-v2-selection-demo', 'vetting', { instancesDir })
        assert.deepEqual(vetting.fields['checks-required'], ['Right to work', 'Criminal record'])

        const advertising = readModule(definition, 'ro-v2-selection-demo', 'advertising', { instancesDir })
        assert.deepEqual(advertising.fields.channels, ['Job boards'])

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    }
  )
)
