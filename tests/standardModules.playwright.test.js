import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #283 (ADR-0065): the Definitions page shows standard modules as Gantry-provided. On a draft an
// author mounts Glossary and Open questions on the Stages they choose, pins the version, adds
// guidance and Interview instructions, and Save writes the mount (never a module file); a published
// version shows the same read-only. A Local Workspace's Definition editor mounts them too.
// tests/standardModules.test.js covers the rules below the browser.

const DEFINITION = `id: std
version: 1
status: draft
title: Standard
description: Mounts standard modules
stages:
  - id: shape
    title: Shape
    purpose: Shape it
    gate: shaped
    modules: [notes]
  - id: design
    title: Design
    purpose: Design it
    gate: designed
    modules: [notes]
artefacts:
  - id: doc
    title: Document
    purpose: The document
    template: templates/doc.md.tmpl
    gate: shaped
    requires: [notes]
  - id: design-doc
    title: Design document
    purpose: The design
    template: templates/doc.md.tmpl
    gate: designed
    requires: [notes]
`

const NOTES = `id: notes
title: Notes
purpose: Notes
fields:
  - id: body
    title: Body
    type: markdown
    required: true
`

function withDefinitions(fn, { status = 'draft' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'standard-modules-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const dir = join(definitionsDir, 'std', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), DEFINITION.replace('status: draft', `status: ${status}`))
  writeFileSync(join(dir, 'modules', 'notes.yaml'), NOTES)
  writeFileSync(join(dir, 'templates', 'doc.md.tmpl'), '# Doc\n')
  return withRunningServer({ definitionsDir, instancesDir: join(root, 'instances') }, (base) => fn(base, dir)).finally(() => rmSync(root, { recursive: true, force: true }))
}

// Save has finished when the draft no longer has unsaved changes.
async function savedDraft(page) {
  await page.waitForFunction(() => !document.body.textContent.includes('Unsaved changes'))
}

async function withPage(fn, { expectedErrors = [] } = {}) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    page.on('dialog', (d) => d.accept())
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page)
    assert.deepEqual(pageErrors.filter((e) => !expectedErrors.some((expected) => e.includes(expected))), [])
  } finally {
    await browser.close()
  }
}

test('Definitions page: a draft mounts Glossary and Open questions, adds guidance and interview instructions, and Save writes the mount, not a module file', async () => {
  await withDefinitions((base, dir) => withPage(async (page) => {
    await page.goto(`${base}/definitions`)
    await page.waitForSelector('.defn-outline')
    const group = page.locator('[data-testid="standard-modules-group"]')
    assert.equal(await group.count(), 0, 'a Definition that mounts none shows no Standard modules group')

    // Mount Glossary from the Outline: it opens, marked Gantry-provided, with its Fields shown read-only.
    await page.getByLabel('Mount a standard module').selectOption('glossary')
    assert.match(await group.locator('.kicker').first().textContent(), /Standard modules · 1/)
    const focus = page.locator('[data-testid="standard-module-focus"]')
    await focus.waitFor({ state: 'visible' })
    assert.match(await focus.locator('h2').textContent(), /Glossary/)
    assert.match(await focus.locator('.defn-provided-badge').textContent(), /Gantry-provided/)
    assert.equal(await focus.locator('#standard-module-version').inputValue(), '1')
    const fields = focus.locator('[data-testid="standard-module-field"]')
    assert.equal(await fields.count(), 1)
    assert.match(await fields.first().textContent(), /Terms and definitions/)
    assert.match(await fields.first().textContent(), /Preferred term \| Definition \| Avoid/)
    assert.equal(await focus.locator('input.defn-focus-title-input').count(), 0, 'the title is Gantry\'s, not editable')

    await focus.locator('#standard-module-guidance').fill('Use New Zealand spellings.')
    await focus.locator('#standard-module-interview').fill('Ask which product names the client still uses.')

    // Mount it on the Shape stage; Open questions is mounted and added in one step from the same menu.
    await page.locator('.defn-outline-node', { hasText: 'Shape' }).first().click()
    const addModule = page.locator('.defn-editor-inline select').first()
    await addModule.selectOption({ label: 'Glossary (Gantry-provided)' })
    await addModule.selectOption({ label: 'Open questions (Gantry-provided, not mounted yet)' })
    const chips = page.locator('.defn-chips.defn-droplist .defn-chip')
    assert.deepEqual((await chips.locator('span[role="button"]').allTextContents()).map((t) => t.trim()).filter((t) => t !== '⠿'), ['Notes', 'Glossary', 'Open questions'])
    assert.equal(await page.locator('.defn-chips.defn-droplist .defn-provided-badge').count(), 2)
    assert.match(await group.locator('.kicker').first().textContent(), /Standard modules · 2/)

    // No problem is reported, and Save writes the mount into definition.yaml with no module file.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await savedDraft(page)
    const saved = parseYAML(readFileSync(join(dir, 'definition.yaml'), 'utf8'))
    assert.deepEqual(saved['standard-modules'], [
      { id: 'glossary', version: 1, guidance: 'Use New Zealand spellings.', interview: 'Ask which product names the client still uses.' },
      { id: 'open-questions', version: 1 },
    ])
    assert.deepEqual(saved.stages[0].modules, ['notes', 'glossary', 'open-questions'])
    assert.deepEqual(saved.stages[1].modules, ['notes'])
    assert.equal(existsSync(join(dir, 'modules', 'glossary.yaml')), false)
    assert.equal(existsSync(join(dir, 'modules', 'open-questions.yaml')), false)

    // After a reload the page shows them again, and Unmount takes one off the draft and off its Stages.
    await page.reload()
    await page.waitForSelector('.defn-outline')
    const reloaded = page.locator('[data-testid="standard-modules-group"]')
    assert.match(await reloaded.locator('.kicker').first().textContent(), /Standard modules · 2/)
    await reloaded.locator('.defn-outline-node', { hasText: 'Open questions' }).click()
    await page.getByRole('button', { name: /Unmount module/ }).click()
    assert.match(await reloaded.locator('.kicker').first().textContent(), /Standard modules · 1/)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await savedDraft(page)
    const afterUnmount = parseYAML(readFileSync(join(dir, 'definition.yaml'), 'utf8'))
    assert.deepEqual(afterUnmount['standard-modules'].map((m) => m.id), ['glossary'])
    assert.deepEqual(afterUnmount.stages[0].modules, ['notes', 'glossary'])
  }))
})

test('Definitions page: a Definition cannot redefine a standard module as its own, and Save is refused', async () => {
  await withDefinitions(async (base, dir) => {
    const before = readFileSync(join(dir, 'definition.yaml'), 'utf8')
    await withPage(async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline')
      await page.getByLabel('Mount a standard module').selectOption('glossary')
      await page.getByRole('button', { name: 'Add module', exact: true }).click()
      await page.locator('.defn-focus .mono').first().fill('glossary')
      const focus = page.locator('[data-testid="standard-module-focus"]')
      await focus.locator('.inline-error').waitFor({ state: 'visible' })
      assert.match(await focus.locator('.inline-error').textContent(), /Standard module "glossary" is also defined as one of this Definition's own modules/)
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/api/definitions/std/versions/1')),
        page.getByRole('button', { name: 'Save', exact: true }).click(),
      ])
      assert.equal(response.status(), 422)
      assert.match((await response.json()).problems.map((p) => p.message).join('\n'), /Standard module "glossary" is also defined as one of this Definition's own modules/)
    }, { expectedErrors: ['422'] })
    assert.equal(readFileSync(join(dir, 'definition.yaml'), 'utf8'), before, 'a refused Save writes nothing')
  })
})

test('Definitions page: a published version shows its standard modules read-only, with the pinned version and added guidance', async () => {
  await withDefinitions(async (base, dir) => {
    writeFileSync(
      join(dir, 'definition.yaml'),
      DEFINITION.replace('status: draft', 'status: published')
        .replace('stages:', 'standard-modules:\n  - id: open-questions\n    version: 1\n    guidance: Chase every owner weekly.\nstages:')
        .replace('modules: [notes]', 'modules: [notes, open-questions]')
    )
    await withPage(async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline')
      const group = page.locator('[data-testid="standard-modules-group"]')
      assert.match(await group.locator('.kicker').first().textContent(), /Standard modules · 1/)
      assert.equal(await page.getByLabel('Mount a standard module').count(), 0, 'a published version cannot mount more')
      await group.locator('.defn-outline-node', { hasText: 'Open questions' }).click()
      const focus = page.locator('[data-testid="standard-module-focus"]')
      assert.match(await focus.locator('[data-testid="standard-module-version"]').textContent(), /Version 1/)
      assert.match(await focus.locator('[data-testid="standard-module-added-guidance"]').textContent(), /Chase every owner weekly\./)
      assert.equal(await focus.locator('textarea').count(), 0)
      assert.equal(await page.getByRole('button', { name: /Unmount module/ }).count(), 0)
    })
  }, { status: 'published' })
})

test('Local Workspace editor: mounts a standard module, and writes the mount to definition.yaml', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(async () => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-standard-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Standard Modules E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/standard-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('standard-local-e2e')
      await page.locator('#local-def-title').fill('Standard Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')

      const standard = editorRoot.locator('[data-testid="local-standard-modules"]')
      await standard.getByLabel('Mount a standard module').selectOption('open-questions')
      await standard.locator('.local-def-standard-module').waitFor({ state: 'visible' })
      assert.match(await standard.locator('.local-def-standard-module').textContent(), /Gantry-provided/)
      await standard.locator('textarea').nth(0).fill('Chase every owner weekly.')

      const stagesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Stages' }) })
      await stagesSection.getByRole('button', { name: '+ Add stage' }).click()
      const stage = stagesSection.locator('.local-def-element').first()
      await stage.locator('input[type="text"]').nth(0).fill('s1')
      await stage.locator('input[type="text"]').nth(1).fill('Stage one')
      await stage.getByText('Modules (comma-separated ids)').locator('xpath=following-sibling::input[1]').fill('open-questions')
      await stage.getByText('Modules (comma-separated ids)').locator('xpath=following-sibling::input[1]').blur()

      await editorRoot.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => /Saved/i.test(document.body.textContent))
      const yaml = parseYAML(await readDefinitionYaml())
      assert.deepEqual(yaml['standard-modules'], [{ id: 'open-questions', version: 1, guidance: 'Chase every owner weekly.' }])
      assert.deepEqual(yaml.stages[0].modules, ['open-questions'])
      // The validation panel does not complain that the Stage's module is missing.
      assert.doesNotMatch(await editorRoot.locator('.local-def-validation').textContent(), /no such module/)
    })
  })
})
