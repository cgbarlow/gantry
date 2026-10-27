import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance, readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// #202 (spec #192, ADR-0054): browser coverage for Target size — the editor's per-field target and
// live word count (amber once over, never blocking Save), Instance Settings' Size control, the
// wizard's Size choice, and a field's word targets on the Definitions page. The fixture library is
// the one tests/targetSize.test.js uses: `sized` sets budgets on two fields, `plain` is the same
// Definition with none, which must show nothing new anywhere.

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
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-202-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-202-browser-'))
  try {
    if (definitions.includes('sized')) writeFixtureDefinition(definitionsDir, 'sized', BUDGETED_MODULE, status)
    if (definitions.includes('plain')) writeFixtureDefinition(definitionsDir, 'plain', PLAIN_MODULE, status)
    // migrateWorkspacesOnStart: false keeps the seeded instances where these tests read them back.
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

const targetLines = (page) => page.locator('.field-target-words')

test('the editor shows each budgeted field\'s target at the instance\'s size with a live word count, amber once over, and Save still saves', () =>
  withFixtureServer({}, async ({ base, definitionsDir, instancesDir }) => {
    createInstance('sized', 'sized-demo', { definitionsDir, instancesDir, size: 'small' })
    createInstance('plain', 'plain-demo', { definitionsDir, instancesDir })
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/instance/sized-demo`)
      await page.waitForSelector('.field-target-words', { timeout: 10_000 })
      assert.equal(await targetLines(page).count(), 2, 'only the two budgeted fields carry a target')
      const overview = page.locator('.field-markdown').filter({ has: page.locator('.field-target-words') }).first()
      const overviewTarget = overview.locator('.field-target-words')
      assert.match(await overviewTarget.textContent(), /Target ~5 words \(Small\)\s*· 0 words/)
      assert.equal(await overviewTarget.getAttribute('data-over'), 'false')
      assert.match(await page.locator('.field-list .field-target-words').textContent(), /Target ~2 words \(Small\)/)

      await overview.locator('.cm-content').click()
      await page.keyboard.type('Four words so far')
      await page.waitForFunction(() => /· 4 words/.test(document.querySelector('.field-markdown .field-target-words')?.textContent ?? ''))
      assert.equal(await overviewTarget.getAttribute('data-over'), 'false')

      await page.keyboard.type(' and now well over target')
      await page.waitForFunction(() => document.querySelector('.field-markdown .field-target-words')?.getAttribute('data-over') === 'true')
      assert.match(await overviewTarget.getAttribute('class'), /\bover\b/)
      assert.match(await overviewTarget.textContent(), /· 9 words/)

      // Advisory only: the over-budget text saves like any other.
      await page.locator('.toolbar .stage-save-btn').click()
      await page.locator('.stage-save-state', { hasText: 'Saved' }).waitFor({ timeout: 5_000 })
      const definition = loadDefinition('sized', { definitionsDir, version: 1 })
      assert.match(readModule(definition, 'sized-demo', 'summary', { instancesDir }).fields.overview, /now well over target/)

      await page.goto(`${base}/instance/plain-demo`)
      await page.waitForSelector('.field-markdown .cm-content', { timeout: 10_000 })
      assert.equal(await targetLines(page).count(), 0, 'a Definition without budgets shows no targets')
      assert.deepEqual(pageErrors, [])
    })
  }))

test('Instance Settings shows a Size control only for a Definition with budgets, and saving it changes the instance\'s size', () =>
  withFixtureServer({}, async ({ base, definitionsDir, instancesDir }) => {
    createInstance('sized', 'sized-demo', { definitionsDir, instancesDir })
    createInstance('plain', 'plain-demo', { definitionsDir, instancesDir })
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/settings/instance?slug=sized-demo`)
      const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Size', exact: true }) })
      await section.waitFor({ timeout: 10_000 })
      const select = section.getByLabel('Size')
      assert.equal(await select.inputValue(), 'medium', 'an instance with no stored size works to Medium')
      await select.selectOption('large')
      await section.getByRole('button', { name: 'Save' }).click()
      await section.getByText('Saved.').waitFor({ timeout: 5_000 })
      assert.equal(parseYAML(readFileSync(join(instancesDir, 'sized-demo', 'instance.yaml'), 'utf8')).size, 'large')

      await page.goto(`${base}/instance/sized-demo`)
      await page.waitForSelector('.field-target-words', { timeout: 10_000 })
      assert.match(await targetLines(page).first().textContent(), /Target ~20 words \(Large\)/)

      await page.goto(`${base}/settings/instance?slug=plain-demo`)
      await page.getByRole('heading', { name: 'Assignee' }).waitFor({ timeout: 10_000 })
      assert.equal(await page.getByRole('heading', { name: 'Size', exact: true }).count(), 0)
      assert.deepEqual(pageErrors, [])
    })
  }))

// The File System Access API can't be driven headless, so — as tests/wizard-local-workspace.playwright.test.js
// does — the folder picker hands back a fresh Origin Private File System directory.
const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`
const FS_MOCK_INIT = `
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('pick-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
  }
`

test('the new-instance wizard offers a Size, default Medium, only for a Definition with budgets, and the chosen size is stored and shown in the editor', () =>
  withFixtureServer({}, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await page.goto(`${base}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')
      await page.getByRole('button', { name: 'Local', exact: true }).click()
      await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
      await page.locator('#local-register-pick').click()
      await page.locator('#local-ws-name').fill('Sized Workspace')
      await page.locator('#local-register-create').click()

      await page.waitForSelector('#instance-name')
      await page.locator('.definition-card', { hasText: '(plain)' }).click()
      await page.locator('#instance-name').fill('Sized Local')
      // Give the per-selection budget lookup time to land before asserting there is no Size.
      await page.waitForTimeout(500)
      assert.equal(await page.locator('#instance-size').count(), 0, 'no Size for a Definition without budgets')

      await page.locator('.definition-card', { hasText: '(sized)' }).click()
      await page.waitForSelector('#instance-size')
      assert.equal(await page.locator('#instance-size').inputValue(), 'medium')
      await page.locator('#instance-size').selectOption('small')
      assert.deepEqual(pageErrors, [])

      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Create instance', exact: true }).click()])
      const instanceYaml = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        for await (const [name, handle] of root.entries()) {
          if (!name.startsWith('pick-')) continue
          const dir = await (await handle.getDirectoryHandle('gantry-workspace')).getDirectoryHandle('sized-local')
          return (await (await dir.getFileHandle('instance.yaml')).getFile()).text()
        }
        return null
      })
      assert.match(instanceYaml, /^size: small$/m)

      // The Local-workspace editor reads the same size and targets as a server-hosted one.
      await page.waitForSelector('.field-target-words', { timeout: 10_000 })
      assert.match(await targetLines(page).first().textContent(), /Target ~5 words \(Small\)/)
      // The Local-workspace editor's own unrelated synced-fields probe 500s for an instance the server
      // has never seen; only an uncaught error would be this ticket's.
      assert.deepEqual(pageErrors.filter((e) => !/Failed to load resource/.test(e)), [])
    })
  }))

test('the Definitions page edits a field\'s word targets on a draft, keeps them through Save and Publish, and shows them read-only after', () =>
  withFixtureServer({ definitions: ['sized'], status: 'draft' }, async ({ base, definitionsDir }) => {
    const onDisk = () => parseYAML(readFileSync(join(definitionsDir, 'sized', '1', 'modules', 'summary.yaml'), 'utf8')).fields[0]['target-words']
    const openOverview = async (page) => {
      const moduleNode = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await moduleNode.waitFor({ state: 'visible', timeout: 10_000 })
      await moduleNode.click()
      const row = page.locator('.defn-field-row').filter({ hasText: 'Overview' })
      await row.waitFor({ timeout: 10_000 })
      // The row stays open across a Save or Publish; clicking its head again would close it.
      if ((await row.locator('.defn-field-row-body').count()) === 0) await row.locator('.defn-field-row-head').click()
      return row
    }
    await withPage(async (page, pageErrors) => {
      page.on('dialog', (d) => d.accept())
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      let row = await openOverview(page)
      const medium = row.getByLabel('Medium word target')
      assert.equal(await row.getByLabel('Small word target').inputValue(), '5')
      assert.equal(await medium.inputValue(), '10')
      assert.equal(await row.getByLabel('Large word target').inputValue(), '20')

      await medium.fill('12')
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/sized/versions/1'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      assert.deepEqual(onDisk(), { small: 5, medium: 12, large: 20 })

      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      assert.deepEqual(onDisk(), { small: 5, medium: 12, large: 20 }, 'the budget survives publish')

      row = await openOverview(page)
      await row.locator('.defn-target-words-summary').waitFor({ timeout: 10_000 })
      assert.match(await row.locator('.defn-target-words-summary').textContent(), /Small ~5 · Medium ~12 · Large ~20/)
      assert.equal(await row.locator('.defn-target-words-input').count(), 0, 'read-only once published')
      assert.deepEqual(pageErrors, [])
    })
  }))
