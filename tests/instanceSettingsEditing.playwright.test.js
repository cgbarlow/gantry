import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// #221 (spec #223, ADR-0058 §4, §7): browser coverage for editing a draft's Instance settings on the
// Definitions page — Target size's default (its choices shown, not editable) and Classification's
// markings and default — through Save and Publish, refused while malformed, read-only once
// published; the same editing in a Local Workspace's Definition editor; and the Definition's default
// size taking effect in the wizard, Instance Settings and the editor's word targets.
// tests/instanceSettings.test.js covers the API and validation behind these. The fixture is
// tests/instanceSettings.playwright.test.js's: `sized` declares word targets on two Fields.

const BUDGETED_MODULE = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
    target-words:
      small: 5
      medium: 10
      large: 20
  - id: risks
    title: Risks
    type: list
    target-words:
      small: 2
      medium: 4
      large: 8
  - id: owner
    title: Owner
    type: text
`

function definitionYaml(id, { status = 'draft', declaration = '' } = {}) {
  return `id: ${id}\nversion: 1\nstatus: ${status}\ntitle: ${id}\ndescription: A one-stage fixture\n${declaration}stages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
}

function writeFixtureDefinition(definitionsDir, id, options) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, options))
  writeFileSync(join(dir, 'modules', 'summary.yaml'), BUDGETED_MODULE)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withFixtureServer(definitions, fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-221-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-221-browser-'))
  try {
    for (const [id, options] of Object.entries(definitions)) writeFixtureDefinition(definitionsDir, id, options)
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

// Fills the "New marking" box in `block` and adds it.
async function addMarking(block, marking) {
  await block.getByRole('textbox', { name: 'New marking' }).fill(marking)
  await block.getByRole('textbox', { name: 'New marking' }).press('Enter')
}

const markingValues = (block) => block.locator('.instance-setting-marking input').evaluateAll((inputs) => inputs.map((input) => input.value))

test('on a draft, the Definitions page edits Size\'s default and Classification\'s markings and default, refuses a malformed edit, keeps them through Save and Publish, and shows them read-only after', () =>
  withFixtureServer({ sized: {} }, async ({ base, definitionsDir }) => {
    const onDisk = () => parseYAML(readFileSync(join(definitionsDir, 'sized', '1', 'definition.yaml'), 'utf8'))['instance-settings']
    await withPage(async (page, pageErrors) => {
      page.on('dialog', (d) => d.accept())
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const group = page.locator('.defn-outline-instance-settings')
      await group.waitFor({ timeout: 10_000 })
      // A draft lists Classification even before it declares any markings, so they can be added.
      assert.match(await group.locator('.defn-outline-group-head').textContent(), /Instance settings · 2/)
      await group.locator('.defn-outline-node', { hasText: 'Target size' }).click()
      const focus = page.locator('.defn-instance-settings')
      await focus.waitFor({ timeout: 10_000 })

      // Size: its choices are shown but can't be edited; its default can.
      const size = focus.locator('.instance-setting-editor[data-setting="size"]')
      assert.equal(await size.locator('.instance-setting-choices').textContent(), 'Small · Medium · Large')
      assert.equal(await size.getByRole('textbox').count(), 0, 'no box edits a size choice')
      const sizeDefault = size.getByRole('combobox', { name: 'Target size default' })
      assert.equal(await sizeDefault.inputValue(), 'medium', 'a Definition that sets none defaults to Medium')
      await sizeDefault.selectOption('large')

      // Classification: declared by its first marking; then added to, renamed, reordered and defaulted.
      const classification = focus.locator('.instance-setting-editor[data-setting="classification"]')
      assert.match(await classification.locator('.instance-setting-offered').textContent(), /Not declared/)
      await addMarking(classification, 'OFFICIAL')
      await addMarking(classification, 'SENSITIVE')
      await addMarking(classification, 'PROTECTED')
      assert.deepEqual(await markingValues(classification), ['OFFICIAL', 'SENSITIVE', 'PROTECTED'])
      await classification.getByRole('textbox', { name: 'Marking 2' }).fill('OFFICIAL: Sensitive')
      await classification.getByRole('button', { name: 'Move marking 3 up' }).click()
      assert.deepEqual(await markingValues(classification), ['OFFICIAL', 'PROTECTED', 'OFFICIAL: Sensitive'])
      await classification.getByRole('combobox', { name: 'Classification default' }).selectOption('OFFICIAL')

      // A repeated marking is a Definition problem, shown in the section, and Save refuses it.
      await addMarking(classification, 'OFFICIAL')
      const problems = focus.locator('.defn-instance-settings-problems')
      await problems.waitFor({ timeout: 10_000 })
      assert.match(await problems.textContent(), /Instance setting "classification" lists the marking "OFFICIAL" more than once/)
      const refused = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/sized/versions/1'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await refused).status(), 422)
      assert.equal(onDisk(), undefined, 'a refused Save writes nothing')

      await classification.getByRole('button', { name: 'Remove marking 4' }).click()
      await problems.waitFor({ state: 'detached', timeout: 10_000 })
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/sized/versions/1'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      const expected = { size: { default: 'large' }, classification: { choices: ['OFFICIAL', 'PROTECTED', 'OFFICIAL: Sensitive'], default: 'OFFICIAL' } }
      assert.deepEqual(onDisk(), expected)

      // Reloaded, the editor shows what was saved.
      await page.reload()
      await page.locator('.defn-outline-instance-settings .defn-outline-node', { hasText: 'Classification' }).click()
      await focus.waitFor({ timeout: 10_000 })
      assert.equal(await sizeDefault.inputValue(), 'large')
      assert.deepEqual(await markingValues(classification), ['OFFICIAL', 'PROTECTED', 'OFFICIAL: Sensitive'])
      assert.equal(await classification.getByRole('combobox', { name: 'Classification default' }).inputValue(), 'OFFICIAL')

      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      assert.deepEqual(onDisk(), expected, 'the declaration survives publish')

      await page.locator('.defn-outline-instance-settings .defn-outline-node', { hasText: 'Target size' }).click()
      await focus.waitFor({ timeout: 10_000 })
      assert.equal(await focus.locator('input, select, textarea').count(), 0, 'read-only once published')
      assert.equal(await focus.locator('.instance-setting-summary[data-setting="size"] .instance-setting-default').textContent(), 'Large')
      assert.equal(await focus.locator('.instance-setting-summary[data-setting="classification"] .instance-setting-choices').textContent(), 'OFFICIAL · PROTECTED · OFFICIAL: Sensitive')
      assert.equal(await focus.locator('.instance-setting-summary[data-setting="classification"] .instance-setting-default').textContent(), 'OFFICIAL')
      // The refused Save's 422 is logged by the browser as a failed resource; only an uncaught error would be this ticket's.
      assert.deepEqual(pageErrors.filter((e) => !/Failed to load resource: the server responded with a status of 422/.test(e)), [])
    })
  }))

test('on a draft, Classification can be undeclared, and Save writes no instance-settings at all', () =>
  withFixtureServer({ marked: { declaration: 'instance-settings:\n  classification:\n    choices: [PUBLIC, SECRET]\n' } }, async ({ base, definitionsDir }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.locator('.defn-outline-instance-settings .defn-outline-node', { hasText: 'Classification' }).click()
      const classification = page.locator('.instance-setting-editor[data-setting="classification"]')
      await classification.waitFor({ timeout: 10_000 })
      assert.equal(await classification.getByRole('combobox', { name: 'Classification default' }).inputValue(), '', 'no default: None')
      await classification.getByRole('button', { name: 'Stop declaring Classification' }).click()
      assert.match(await classification.locator('.instance-setting-offered').textContent(), /Not declared/)
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/marked/versions/1'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      assert.doesNotMatch(readFileSync(join(definitionsDir, 'marked', '1', 'definition.yaml'), 'utf8'), /instance-settings/)
      assert.deepEqual(pageErrors, [])
    })
  }))

// The File System Access API can't be driven headless, so — as tests/targetSize.playwright.test.js
// does — the folder picker hands back a fresh Origin Private File System directory.
const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`
const FS_MOCK_INIT = `
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('pick-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
  }
`

test('a Definition\'s default size is what the wizard pre-selects, and what an instance with none stored works to in Instance Settings and the editor', () =>
  withFixtureServer({ 'small-first': { status: 'published', declaration: 'instance-settings:\n  size:\n    default: small\n' } }, async ({ base, definitionsDir, instancesDir }) => {
    createInstance('small-first', 'unsized', { definitionsDir, instancesDir })
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/settings/instance?slug=unsized`)
      const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Instance settings', exact: true }) })
      await section.waitFor({ timeout: 10_000 })
      assert.equal(await section.getByLabel('Size').inputValue(), 'small', 'no stored size: the Definition\'s default')
      await page.goto(`${base}/instance/unsized`)
      await page.waitForSelector('.field-target-words', { timeout: 10_000 })
      assert.match(await page.locator('.field-target-words').first().textContent(), /Target ~5 words \(Small\)/)

      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await page.goto(`${base}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
      await page.locator('#local-register-pick').click()
      await page.locator('#local-ws-name').fill('Default Size Workspace')
      await page.locator('#local-register-create').click()
      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card', { hasText: '(small-first)' }).click()
      await page.waitForSelector('#instance-size')
      assert.equal(await page.locator('#instance-size').inputValue(), 'small', 'the wizard pre-selects the Definition\'s default')
      assert.deepEqual(pageErrors, [])
    })
  }))

// The Local Workspace twin of the Definitions page (/definitions/local), seeded through OPFS as
// tests/instanceSettings.playwright.test.js seeds it.
test('the Local Workspace Definition editor edits the same Instance settings on a draft, and Save writes them to its definition.yaml', () =>
  withFixtureServer({}, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const files = {
        'definitions/sized/1/definition.yaml': definitionYaml('sized'),
        'definitions/sized/1/modules/summary.yaml': BUDGETED_MODULE,
        'definitions/sized/1/templates/brief.md.tmpl': '# Brief\n',
      }
      const workspaceId = await page.evaluate(async (files) => {
        const { rememberWorkspace, writeTextFile } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-221-' + Date.now(), { create: true })
        for (const [path, text] of Object.entries(files)) await writeTextFile(dir, path, text)
        return rememberWorkspace({ handle: dir, name: 'Instance Settings Editing Workspace' })
      }, files)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}&id=sized&version=1`)
      const section = page.locator('.local-def-instance-settings')
      await section.waitFor({ timeout: 10_000 })
      const size = section.locator('.instance-setting-editor[data-setting="size"]')
      assert.equal(await size.locator('.instance-setting-choices').textContent(), 'Small · Medium · Large')
      await size.getByRole('combobox', { name: 'Target size default' }).selectOption('small')
      const classification = section.locator('.instance-setting-editor[data-setting="classification"]')
      await addMarking(classification, 'PUBLIC')
      await addMarking(classification, 'SECRET')
      await classification.getByRole('combobox', { name: 'Classification default' }).selectOption('PUBLIC')

      // An emptied marking is shown as a problem in the section, as on the server's page.
      await classification.getByRole('textbox', { name: 'Marking 2' }).fill('')
      const problems = section.locator('.local-def-instance-settings-problems')
      await problems.waitFor({ timeout: 10_000 })
      assert.match(await problems.textContent(), /Instance setting "classification" has a blank or non-text marking/)
      await classification.getByRole('textbox', { name: 'Marking 2' }).fill('SECRET')
      await problems.waitFor({ state: 'detached', timeout: 10_000 })

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.save-status', { hasText: 'Saved.' }).waitFor({ timeout: 10_000 })
      const written = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        for await (const [name, handle] of root.entries()) {
          if (!name.startsWith('local-ws-221-')) continue
          const dir = await (await (await handle.getDirectoryHandle('definitions')).getDirectoryHandle('sized')).getDirectoryHandle('1')
          return (await (await dir.getFileHandle('definition.yaml')).getFile()).text()
        }
        return null
      })
      assert.deepEqual(parseYAML(written)['instance-settings'], { size: { default: 'small' }, classification: { choices: ['PUBLIC', 'SECRET'], default: 'PUBLIC' } })
      assert.deepEqual(pageErrors, [])
    })
  }))
