import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// #220 (spec #223, ADR-0058): browser coverage for Classification as an Instance setting — chosen
// in the "+ New Workspace" wizard under the "Instance settings" heading (blank, or the Definition's
// default, pre-selected), changed in Instance Settings (server-hosted and Local Workspace), shown in
// the Definitions page's Instance settings section with any problem in its declaration, and gone
// from design v3's stage editor as a "Document handling" section.
// tests/instanceClassification.test.js covers the API, validation and render behind these.

const MODULE_YAML = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
`

const MARKINGS = ['PUBLIC', 'IN-CONFIDENCE', 'SECRET']
const DECLARATION = `instance-settings:\n  classification:\n    choices: [${MARKINGS.join(', ')}]\n`
const DECLARATIONS = {
  marked: DECLARATION,
  defaulted: `${DECLARATION}    default: IN-CONFIDENCE\n`,
  // A draft whose default isn't one of its markings: a Definition problem.
  broken: `instance-settings:\n  classification:\n    choices: [PUBLIC]\n    default: SECRET\n`,
}

function definitionYaml(id, status) {
  return `id: ${id}\nversion: 1\nstatus: ${status}\ntitle: ${id}\ndescription: A one-stage fixture\n${DECLARATIONS[id]}stages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    cover-page: true\n    requires:\n      - summary\n`
}

function writeFixtureDefinition(definitionsDir, id, status = 'published') {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, status))
  writeFileSync(join(dir, 'modules', 'summary.yaml'), MODULE_YAML)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withFixtureServer({ definitions = { marked: 'published', defaulted: 'published' } } = {}, fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-220-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-220-browser-'))
  try {
    for (const [id, status] of Object.entries(definitions)) writeFixtureDefinition(definitionsDir, id, status)
    await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, (base) => fn({ base, definitionsDir, instancesDir }))
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

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

const instanceSettingsSection = (page) => page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Instance settings', exact: true }) })
const instanceYaml = (instancesDir, slug) => parseYAML(readFileSync(join(instancesDir, slug, 'instance.yaml'), 'utf8'))

test('Instance Settings shows Classification under "Instance settings", saves a marking, and choosing None clears it', () =>
  withFixtureServer({}, async ({ base, definitionsDir, instancesDir }) => {
    createInstance('marked', 'marked-demo', { definitionsDir, instancesDir })
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/settings/instance?slug=marked-demo`)
      const section = instanceSettingsSection(page)
      await section.waitFor({ timeout: 10_000 })
      assert.equal(await section.getByRole('heading', { name: 'Classification', exact: true }).count(), 1)
      const select = section.getByLabel('Classification')
      assert.equal(await select.inputValue(), '', 'no marking yet')
      assert.deepEqual(await select.locator('option').allTextContents(), ['None', ...MARKINGS])
      await select.selectOption('SECRET')
      await section.getByRole('button', { name: 'Save' }).click()
      await section.getByText('Saved.').waitFor({ timeout: 5_000 })
      assert.equal(instanceYaml(instancesDir, 'marked-demo').classification, 'SECRET')

      await page.reload()
      await instanceSettingsSection(page).waitFor({ timeout: 10_000 })
      assert.equal(await instanceSettingsSection(page).getByLabel('Classification').inputValue(), 'SECRET', 'survives a reload')
      await instanceSettingsSection(page).getByLabel('Classification').selectOption('')
      await instanceSettingsSection(page).getByRole('button', { name: 'Save' }).click()
      await instanceSettingsSection(page).getByText('Saved.').waitFor({ timeout: 5_000 })
      assert.equal('classification' in instanceYaml(instancesDir, 'marked-demo'), false, 'None stores nothing')
      assert.deepEqual(pageErrors, [])
    })
  }))

// As tests/instanceSettings.playwright.test.js does, the folder picker hands back a fresh Origin
// Private File System directory, since the File System Access API can't be driven headless.
const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`
const FS_MOCK_INIT = `
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('pick-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
  }
`

const readLocalInstanceYaml = (page, slug) =>
  page.evaluate(async (slug) => {
    const root = await navigator.storage.getDirectory()
    for await (const [name, handle] of root.entries()) {
      if (!name.startsWith('pick-')) continue
      const dir = await (await handle.getDirectoryHandle('gantry-workspace')).getDirectoryHandle(slug)
      return (await (await dir.getFileHandle('instance.yaml')).getFile()).text()
    }
    return null
  }, slug)

test('the wizard offers Classification under "Instance settings" — None, or the Definition\'s default, pre-selected — and a Local Workspace\'s Instance Settings changes it', () =>
  withFixtureServer({}, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await page.goto(`${base}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
      await page.locator('#local-register-pick').click()
      await page.locator('#local-ws-name').fill('Classified Workspace')
      await page.locator('#local-register-create').click()

      await page.waitForSelector('#instance-name')
      const group = page.getByRole('region', { name: 'Instance settings' })
      await page.locator('.definition-card', { hasText: '(defaulted)' }).click()
      await group.waitFor({ timeout: 10_000 })
      await page.waitForFunction(() => document.querySelector('#instance-classification')?.value === 'IN-CONFIDENCE', null, { timeout: 10_000 })
      assert.deepEqual(await group.locator('#instance-classification option').allTextContents(), MARKINGS, 'with a default, there is no None')

      await page.locator('.definition-card', { hasText: '(marked)' }).click()
      await page.waitForFunction(() => document.querySelector('#instance-classification')?.value === '', null, { timeout: 10_000 })
      assert.deepEqual(await group.locator('#instance-classification option').allTextContents(), ['None', ...MARKINGS])
      assert.equal(await group.getByText('Classification', { exact: true }).count(), 1)
      await group.locator('#instance-classification').selectOption('PUBLIC')
      await page.locator('#instance-name').fill('Classified Local')

      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Create instance', exact: true }).click()])
      assert.match(await readLocalInstanceYaml(page, 'classified-local'), /^classification: PUBLIC$/m)
      const localId = new URL(page.url()).searchParams.get('local')
      assert.ok(localId, 'the editor opened on the Local Workspace instance')

      await page.goto(`${base}/settings/instance?slug=classified-local&local=${encodeURIComponent(localId)}`)
      const section = instanceSettingsSection(page)
      await section.waitFor({ timeout: 10_000 })
      const select = section.getByLabel('Classification')
      assert.equal(await select.inputValue(), 'PUBLIC')
      await select.selectOption('SECRET')
      await section.getByRole('button', { name: 'Save' }).click()
      await section.getByText('Saved.').waitFor({ timeout: 5_000 })
      assert.match(await readLocalInstanceYaml(page, 'classified-local'), /^classification: SECRET$/m)
      // The Local-workspace editor's own unrelated synced-fields probe 500s for an instance the server
      // has never seen; only an uncaught error would be this ticket's.
      assert.deepEqual(pageErrors.filter((e) => !/Failed to load resource/.test(e)), [])
    })
  }))

async function openClassificationFocus(page, base) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('.defn-outline', { timeout: 10_000 })
  const group = page.locator('.defn-outline-instance-settings')
  await group.waitFor({ timeout: 10_000 })
  await group.locator('.defn-outline-node', { hasText: 'Classification' }).click()
  const focus = page.locator('.defn-instance-settings')
  await focus.waitFor({ timeout: 10_000 })
  return focus
}

test('the Definitions page lists Classification among the Instance settings, with its markings and default', () =>
  withFixtureServer({ definitions: { defaulted: 'published' } }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      const focus = await openClassificationFocus(page, base)
      const classification = focus.locator('.instance-setting-summary[data-setting="classification"]')
      assert.match(await classification.locator('.instance-setting-offered').textContent(), /Offered because the Definition declares 3 markings\./)
      assert.equal(await classification.locator('.instance-setting-choices').textContent(), MARKINGS.join(' · '))
      assert.equal(await classification.locator('.instance-setting-default').textContent(), 'IN-CONFIDENCE')
      assert.equal(await focus.locator('input, select, textarea').count(), 0, 'read-only: editing it is #221')
      assert.deepEqual(pageErrors, [])
    })
  }))

test('on a draft, a malformed Classification declaration is a problem the Definitions page shows where the setting is listed', () =>
  withFixtureServer({ definitions: { broken: 'draft' } }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      const focus = await openClassificationFocus(page, base)
      const problems = focus.locator('.defn-instance-settings-problems')
      await problems.waitFor({ timeout: 10_000 })
      assert.match(await problems.textContent(), /Instance setting "classification" has "default: SECRET", which is not one of its choices/)
      assert.equal(await focus.locator('.instance-setting-summary').count(), 0, 'a malformed setting is offered nowhere')
      assert.match(await page.locator('.defn-problems').textContent(), /1 problem/)
      assert.equal(await page.locator('.defn-outline-instance-settings .defn-problem-dot').count(), 1, 'the outline marks it')
      assert.deepEqual(pageErrors, [])
    })
  }))

test('design v3\'s stage editor shows no Document handling section at any gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-220-stages-'))
  try {
    const instancesDir = join(root, 'instances')
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      await withPage(async (page, pageErrors) => {
        for (const stage of ['shape', 'hld-define', 'detailed-design', 'handover']) {
          await page.goto(`${base}/instance/examples?stage=${stage}`)
          await page.waitForSelector('.module', { timeout: 10_000 })
          const headings = await page.locator('.module h2, .module h3').allTextContents()
          assert.ok(headings.length > 0, stage)
          assert.ok(!headings.some((h) => /Document handling/.test(h)), `${stage}: ${headings.join(' | ')}`)
          assert.equal(await page.getByText('Document handling', { exact: true }).count(), 0, stage)
        }
        assert.deepEqual(pageErrors.filter((e) => !/Failed to load resource/.test(e)), [])
      })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
