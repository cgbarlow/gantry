import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// #219 (spec #223, ADR-0058): browser coverage for grouping the per-Instance choices a Definition
// declares under one "Instance settings" heading, Target size its first member — in the wizard,
// in Instance Settings (server-hosted and Local Workspace), and as a read-only section on the
// Definitions page. tests/targetSize.playwright.test.js covers Size's own behaviour and passes
// unchanged; this covers the grouping. Same fixture library: `sized` declares word targets on two
// Fields, `plain` is the same Definition with none, which must show no Instance settings anywhere.

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

const PLAIN_MODULE = BUDGETED_MODULE.replace(/ {4}target-words:\n( {6}\w+: \d+\n){3}/g, '')

function writeFixtureDefinition(definitionsDir, id, moduleYaml, status = 'published') {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    `id: ${id}\nversion: 1\nstatus: ${status}\ntitle: ${id}\ndescription: A one-stage fixture\nstages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
  )
  writeFileSync(join(dir, 'modules', 'summary.yaml'), moduleYaml)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withFixtureServer({ definitions = ['sized', 'plain'], status } = {}, fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-219-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-219-browser-'))
  try {
    if (definitions.includes('sized')) writeFixtureDefinition(definitionsDir, 'sized', BUDGETED_MODULE, status)
    if (definitions.includes('plain')) writeFixtureDefinition(definitionsDir, 'plain', PLAIN_MODULE, status)
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

test('Instance Settings groups Size under an "Instance settings" heading, saves it, and shows no such heading for a Definition without word targets', () =>
  withFixtureServer({}, async ({ base, definitionsDir, instancesDir }) => {
    createInstance('sized', 'sized-demo', { definitionsDir, instancesDir })
    createInstance('plain', 'plain-demo', { definitionsDir, instancesDir })
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/settings/instance?slug=sized-demo`)
      const section = instanceSettingsSection(page)
      await section.waitFor({ timeout: 10_000 })
      assert.equal(await section.getByRole('heading', { name: 'Size', exact: true }).count(), 1, 'Size is a member of the group')
      const select = section.getByLabel('Size')
      assert.equal(await select.inputValue(), 'medium')
      assert.deepEqual(await select.locator('option').allTextContents(), ['Small', 'Medium', 'Large'])
      await select.selectOption('small')
      await section.getByRole('button', { name: 'Save' }).click()
      await section.getByText('Saved.').waitFor({ timeout: 5_000 })
      assert.equal(parseYAML(readFileSync(join(instancesDir, 'sized-demo', 'instance.yaml'), 'utf8')).size, 'small')

      await page.goto(`${base}/settings/instance?slug=plain-demo`)
      await page.getByRole('heading', { name: 'Assignee' }).waitFor({ timeout: 10_000 })
      assert.equal(await page.getByRole('heading', { name: 'Instance settings', exact: true }).count(), 0)
      assert.deepEqual(pageErrors, [])
    })
  }))

// As tests/targetSize.playwright.test.js does, the folder picker hands back a fresh Origin Private
// File System directory, since the File System Access API can't be driven headless.
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

test('the wizard shows Size under an "Instance settings" heading, none for a Definition without word targets, and a Local Workspace\'s Instance Settings groups it the same way', () =>
  withFixtureServer({}, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await page.goto(`${base}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
      await page.locator('#local-register-pick').click()
      await page.locator('#local-ws-name').fill('Grouped Workspace')
      await page.locator('#local-register-create').click()

      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card', { hasText: '(plain)' }).click()
      await page.locator('#instance-name').fill('Grouped Local')
      // Give the per-selection lookup time to land before asserting there is nothing to show.
      await page.waitForTimeout(500)
      assert.equal(await page.getByRole('heading', { name: 'Instance settings', exact: true }).count(), 0)

      await page.locator('.definition-card', { hasText: '(sized)' }).click()
      const group = page.getByRole('region', { name: 'Instance settings' })
      await group.waitFor({ timeout: 10_000 })
      assert.equal(await group.locator('#instance-size').inputValue(), 'medium', 'the Definition\'s default is pre-selected')
      assert.equal(await group.getByText('Size', { exact: true }).count(), 1)
      await group.locator('#instance-size').selectOption('large')

      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Create instance', exact: true }).click()])
      assert.match(await readLocalInstanceYaml(page, 'grouped-local'), /^size: large$/m)
      const localId = new URL(page.url()).searchParams.get('local')
      assert.ok(localId, 'the editor opened on the Local Workspace instance')

      await page.goto(`${base}/settings/instance?slug=grouped-local&local=${encodeURIComponent(localId)}`)
      const section = instanceSettingsSection(page)
      await section.waitFor({ timeout: 10_000 })
      const select = section.getByLabel('Size')
      assert.equal(await select.inputValue(), 'large')
      await select.selectOption('small')
      await section.getByRole('button', { name: 'Save' }).click()
      await section.getByText('Saved.').waitFor({ timeout: 5_000 })
      assert.match(await readLocalInstanceYaml(page, 'grouped-local'), /^size: small$/m)
      // The Local-workspace editor's own unrelated synced-fields probe 500s for an instance the server
      // has never seen; only an uncaught error would be this ticket's.
      assert.deepEqual(pageErrors.filter((e) => !/Failed to load resource/.test(e)), [])
    })
  }))

async function openInstanceSettingsFocus(page) {
  const group = page.locator('.defn-outline-instance-settings')
  await group.waitFor({ timeout: 10_000 })
  assert.match(await group.locator('.defn-outline-group-head').textContent(), /Instance settings · 1/)
  await group.locator('.defn-outline-node', { hasText: 'Target size' }).click()
  const focus = page.locator('.defn-instance-settings')
  await focus.waitFor({ timeout: 10_000 })
  return focus
}

for (const status of ['published', 'draft']) {
  test(`the Definitions page shows a read-only Instance settings section for a ${status} Definition with word targets: why Size is offered, its choices and its default`, () =>
    withFixtureServer({ definitions: ['sized'], status }, async ({ base }) => {
      await withPage(async (page, pageErrors) => {
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('.defn-outline', { timeout: 10_000 })
        const focus = await openInstanceSettingsFocus(page)
        assert.equal(await focus.getByRole('heading', { name: 'Instance settings', exact: true }).count(), 1)
        const size = focus.locator('.instance-setting-summary[data-setting="size"]')
        assert.match(await size.locator('h3').textContent(), /Target size/)
        assert.match(await size.locator('.instance-setting-offered').textContent(), /Offered because 2 Fields declare word targets\./)
        assert.equal(await size.locator('.instance-setting-choices').textContent(), 'Small · Medium · Large')
        assert.equal(await size.locator('.instance-setting-default').textContent(), 'Medium')
        assert.equal(await focus.locator('input, select, textarea').count(), 0, 'read-only, on a draft as on a published version')

        // The Map view offers the same section.
        await page.getByRole('button', { name: 'Map', exact: true }).click()
        await page.locator('.defn-map-col-instance-settings .defn-map-chip', { hasText: 'Target size' }).click()
        await page.locator('.defn-instance-settings').waitFor({ timeout: 10_000 })
        await page.getByRole('button', { name: 'Outline', exact: true }).click()
        assert.deepEqual(pageErrors, [])
      })
    }))
}

test('the Definitions page shows no Instance settings section for a Definition without word targets', () =>
  withFixtureServer({ definitions: ['plain'] }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      await page.locator('.defn-outline-node').first().waitFor({ timeout: 10_000 })
      assert.equal(await page.locator('.defn-outline-instance-settings').count(), 0)
      await page.getByRole('button', { name: 'Map', exact: true }).click()
      await page.locator('.defn-map').waitFor({ timeout: 10_000 })
      assert.equal(await page.locator('.defn-map-col-instance-settings').count(), 0)
      await page.getByRole('button', { name: 'Outline', exact: true }).click()
      assert.deepEqual(pageErrors, [])
    })
  }))

// The Local Workspace twin of the Definitions page (/definitions/local), with both fixture
// Definitions seeded into the workspace's own folder through OPFS, as
// tests/coverPageCheckbox.playwright.test.js seeds its workspace.
test('the Local Workspace Definition editor shows the same read-only Instance settings section, and none for a Definition without word targets', () =>
  withFixtureServer({ definitions: [] }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const files = {}
      for (const [id, moduleYaml] of [['sized', BUDGETED_MODULE], ['plain', PLAIN_MODULE]]) {
        files[`definitions/${id}/1/definition.yaml`] =
          `id: ${id}\nversion: 1\nstatus: draft\ntitle: ${id}\ndescription: A one-stage fixture\nstages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
        files[`definitions/${id}/1/modules/summary.yaml`] = moduleYaml
        files[`definitions/${id}/1/templates/brief.md.tmpl`] = '# Brief\n'
      }
      const workspaceId = await page.evaluate(async (files) => {
        const { rememberWorkspace, writeTextFile } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-instance-settings-' + Date.now(), { create: true })
        for (const [path, text] of Object.entries(files)) await writeTextFile(dir, path, text)
        return rememberWorkspace({ handle: dir, name: 'Instance Settings E2E Workspace' })
      }, files)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}&id=sized&version=1`)
      const section = page.locator('.local-def-instance-settings')
      await section.waitFor({ timeout: 10_000 })
      assert.equal(await section.getByRole('heading', { name: 'Instance settings', exact: true }).count(), 1)
      const size = section.locator('.instance-setting-summary[data-setting="size"]')
      assert.match(await size.locator('.instance-setting-offered').textContent(), /Offered because 2 Fields declare word targets\./)
      assert.equal(await size.locator('.instance-setting-choices').textContent(), 'Small · Medium · Large')
      assert.equal(await size.locator('.instance-setting-default').textContent(), 'Medium')
      assert.equal(await section.locator('input, select, textarea').count(), 0, 'read-only, even on a draft')

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}&id=plain&version=1`)
      await page.waitForSelector('.local-definition-editor', { timeout: 10_000 })
      assert.equal(await page.locator('.local-def-instance-settings').count(), 0)
      assert.deepEqual(pageErrors, [])
    })
  }))
