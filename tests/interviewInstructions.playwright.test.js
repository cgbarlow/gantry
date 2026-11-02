import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #282 (ADR-0062): browser coverage for authoring Interview instructions on the Definitions page — a
// text box on the Definition (its own Outline entry), on each Stage and on each Module of a draft;
// Save writes them to the draft's YAML, a cleared box writes no key, Publish keeps them fixed, and a
// published version shows them read-only (and only where there are some). The same boxes in a Local
// Workspace's Definition editor. tests/interviewInstructions.test.js covers the validator, copying
// and the lifecycle behind this.

const SUMMARY_MODULE = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
`

function definitionYaml(id, { status = 'draft', interview = '' } = {}) {
  return `id: ${id}\nversion: 1\nstatus: ${status}\ntitle: ${id}\ndescription: A one-stage fixture\n${interview}stages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
}

function writeFixtureDefinition(definitionsDir, id, options) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, options))
  writeFileSync(join(dir, 'modules', 'summary.yaml'), SUMMARY_MODULE)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withFixtureServer(definitions, fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-282-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-282-browser-'))
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

const readYaml = (definitionsDir, id, ...path) => parseYAML(readFileSync(join(definitionsDir, id, '1', ...path), 'utf8'))

async function save(page, id) {
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/api/definitions/${id}/versions/1`), { timeout: 10_000 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  assert.equal((await saved).status(), 200)
}

test('on a draft, the Definitions page edits Interview instructions at the Definition, a Stage and a Module, Save writes them, clearing one removes its key, and Publish fixes them', () =>
  withFixtureServer({ steer: {} }, async ({ base, definitionsDir }) => {
    await withPage(async (page, pageErrors) => {
      page.on('dialog', (d) => d.accept())
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const box = page.getByRole('textbox', { name: 'Interview instructions' })

      // The Definition's own, under the Outline's Interview group.
      await page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' }).click()
      await box.waitFor({ timeout: 10_000 })
      assert.equal(await box.inputValue(), '', 'nothing written yet')
      await box.fill('Ask who the sponsor is first.')

      // A Stage's.
      await page.locator('.defn-outline-node', { hasText: 'Draft' }).first().click()
      await box.waitFor({ timeout: 10_000 })
      assert.equal(await box.inputValue(), '', 'the Stage has its own box, not the Definition\'s')
      await box.fill('Probe every integration.')

      // A Module's.
      await page.locator('.defn-outline-node', { hasText: 'Summary' }).first().click()
      await box.waitFor({ timeout: 10_000 })
      await box.fill('Spell "authorisation" with an s.')
      await save(page, 'steer')

      assert.equal(readYaml(definitionsDir, 'steer', 'definition.yaml').interview, 'Ask who the sponsor is first.')
      assert.equal(readYaml(definitionsDir, 'steer', 'definition.yaml').stages[0].interview, 'Probe every integration.')
      assert.equal(readYaml(definitionsDir, 'steer', 'modules', 'summary.yaml').interview, 'Spell "authorisation" with an s.')

      // Reloaded, each box shows what was saved; clearing the Stage's and Save removes its key.
      await page.reload()
      await page.locator('.defn-outline-node', { hasText: 'Draft' }).first().click()
      assert.equal(await box.inputValue(), 'Probe every integration.')
      await box.fill('')
      await save(page, 'steer')
      assert.equal('interview' in readYaml(definitionsDir, 'steer', 'definition.yaml').stages[0], false)
      assert.equal(readYaml(definitionsDir, 'steer', 'definition.yaml').interview, 'Ask who the sponsor is first.', 'the others are untouched')

      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      assert.equal(readYaml(definitionsDir, 'steer', 'definition.yaml').status, 'published')
      assert.equal(readYaml(definitionsDir, 'steer', 'definition.yaml').interview, 'Ask who the sponsor is first.', 'kept through publish')
      assert.equal(readYaml(definitionsDir, 'steer', 'modules', 'summary.yaml').interview, 'Spell "authorisation" with an s.')

      // Published: read-only, and only where there are some.
      await page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' }).click()
      const readOnly = page.getByTestId('interview-instructions')
      await readOnly.waitFor({ timeout: 10_000 })
      assert.equal(await readOnly.textContent(), 'Ask who the sponsor is first.')
      assert.equal(await page.locator('.defn-focus textarea, .defn-focus input').count(), 0, 'no editing controls once published')
      await page.locator('.defn-outline-node', { hasText: 'Draft' }).first().click()
      await page.locator('.defn-focus h2', { hasText: 'Draft' }).waitFor({ timeout: 10_000 })
      assert.equal(await page.getByTestId('interview-instructions').count(), 0, 'the Stage has none, so shows none')
      await page.locator('.defn-outline-node', { hasText: 'Summary' }).first().click()
      await page.getByTestId('interview-instructions').waitFor({ timeout: 10_000 })
      assert.equal(await page.getByTestId('interview-instructions').textContent(), 'Spell "authorisation" with an s.')
      assert.deepEqual(pageErrors, [])
    })
  }))

test('a published Definition with no Interview instructions offers no Interview entry at all', () =>
  withFixtureServer({ plain: { status: 'published' } }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      assert.equal(await page.locator('.defn-outline-interview').count(), 0)
      assert.deepEqual(pageErrors, [])
    })
  }))

test('text that is not a string is a marked problem on the draft until it is replaced with text', () =>
  withFixtureServer({ broken: { interview: 'interview: 5\n' } }, async ({ base, definitionsDir }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      const node = page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' })
      await node.waitFor({ timeout: 10_000 })
      await node.locator('.defn-problem-dot').waitFor({ timeout: 10_000 })
      await node.click()
      await page.locator('.defn-definition-interview .inline-error', { hasText: 'Interview instructions on the Definition are 5' }).waitFor({ timeout: 10_000 })
      await page.getByRole('textbox', { name: 'Interview instructions' }).fill('Fixed.')
      await page.locator('.defn-definition-interview .inline-error').waitFor({ state: 'detached', timeout: 10_000 })
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/broken/versions/1'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      assert.equal(readYaml(definitionsDir, 'broken', 'definition.yaml').interview, 'Fixed.')
      assert.deepEqual(pageErrors, [])
    })
  }))

// The Local Workspace twin of the Definitions page (/definitions/local), seeded through OPFS as
// tests/instanceSettingsEditing.playwright.test.js seeds it.
test('the Local Workspace Definition editor has the same boxes on a draft, and Save writes them to its YAML files', () =>
  withFixtureServer({}, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const files = {
        'definitions/steer/1/definition.yaml': definitionYaml('steer'),
        'definitions/steer/1/modules/summary.yaml': SUMMARY_MODULE,
        'definitions/steer/1/templates/brief.md.tmpl': '# Brief\n',
      }
      const workspaceId = await page.evaluate(async (files) => {
        const { rememberWorkspace, writeTextFile } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-282-' + Date.now(), { create: true })
        for (const [path, text] of Object.entries(files)) await writeTextFile(dir, path, text)
        return rememberWorkspace({ handle: dir, name: 'Interview Instructions Workspace' })
      }, files)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}&id=steer&version=1`)
      const definitionBox = page.locator('.local-def-interview').getByRole('textbox', { name: 'Interview instructions' })
      await definitionBox.waitFor({ timeout: 10_000 })
      await definitionBox.fill('Ask who the sponsor is first.')
      const elements = page.locator('.local-def-element')
      await elements.first().waitFor({ timeout: 10_000 })
      const boxes = page.locator('.local-def-element').getByRole('textbox', { name: 'Interview instructions' })
      assert.equal(await boxes.count(), 2, 'one on the Stage, one on the Module')
      await boxes.nth(0).fill('Probe every integration.')
      await boxes.nth(1).fill('Spell "authorisation" with an s.')

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.save-status', { hasText: 'Saved.' }).waitFor({ timeout: 10_000 })
      const written = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        for await (const [name, handle] of root.entries()) {
          if (!name.startsWith('local-ws-282-')) continue
          const dir = await (await (await handle.getDirectoryHandle('definitions')).getDirectoryHandle('steer')).getDirectoryHandle('1')
          const read = async (d, file) => (await (await d.getFileHandle(file)).getFile()).text()
          return { definition: await read(dir, 'definition.yaml'), module: await read(await dir.getDirectoryHandle('modules'), 'summary.yaml') }
        }
        return null
      })
      const definition = parseYAML(written.definition)
      assert.equal(definition.interview, 'Ask who the sponsor is first.')
      assert.equal(definition.stages[0].interview, 'Probe every integration.')
      assert.equal(parseYAML(written.module).interview, 'Spell "authorisation" with an s.')

      // Cleared, a box writes no key.
      await boxes.nth(0).fill('')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.save-status', { hasText: 'Saved.' }).waitFor({ timeout: 10_000 })
      assert.deepEqual(pageErrors, [])
    })
  }))
