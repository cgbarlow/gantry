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
import { renderArtefact } from '../lib/render.js'
import { parseKeyDecisions } from '../web/lib/keyDecisions.js'

// #284 (ADR-0065): the Key decisions standard module in the browser. A Definition author mounts it with a
// prefix and a decision style; an architect adds, edits, reorders and removes decisions in either style, and
// each decision keeps its number. tests/keyDecisions.test.js covers the rules below the browser.

const COMMIT = { sha: '0000000000000000000000000000000000000000', shortSha: '0000000', branch: 'main', date: '2026-01-01T00:00:00Z' }

// With no mount the Definition uses a module of its own (`notes`), so a draft can start with nothing mounted.
function definitionYaml({ mount, status }) {
  const modules = mount === '' ? 'notes' : 'key-decisions'
  return `id: dec
version: 1
status: ${status}
title: Decisions
description: Mounts Key decisions
${mount === '' ? '' : `standard-modules:\n${mount}`}stages:
  - id: shape
    title: Shape
    purpose: Shape it
    gate: shaped
    modules: [${modules}]
artefacts:
  - id: doc
    title: Document
    purpose: The document
    template: templates/doc.md.tmpl
    gate: shaped
    requires: [${modules}]
`
}

function withFixture({ mount = '  - id: key-decisions\n    version: 1\n    prefix: AD\n', status = 'published', instance = true } = {}, fn) {
  const root = mkdtempSync(join(tmpdir(), 'key-decisions-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const dir = join(definitionsDir, 'dec', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml({ mount, status }))
  if (mount === '') writeFileSync(join(dir, 'modules', 'notes.yaml'), 'id: notes\ntitle: Notes\npurpose: Notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n')
  writeFileSync(join(dir, 'templates', 'doc.md.tmpl'), "# Doc\n\n## Decisions\n\n<%~ it.modules['key-decisions'].decisions %>\n")
  if (instance) createInstance('dec', 'harbour', { definitionsDir, instancesDir })
  // migrateWorkspacesOnStart must be false: a freshly-seeded instance directory is otherwise migrated to a different on-disk path.
  return withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, (base) => fn(base, { dir, definitionsDir, instancesDir }))
    .finally(() => rmSync(root, { recursive: true, force: true }))
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

const savedDraft = (page) => page.waitForFunction(() => !document.body.textContent.includes('Unsaved changes'))

async function saveStage(page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent?.includes('Saved'), { timeout: 10_000 })
}

const storedDecisions = ({ definitionsDir, instancesDir }) =>
  readModule(loadDefinition('dec', { definitionsDir }), 'harbour', 'key-decisions', { instancesDir }).fields.decisions

test('Definitions page: a draft mounts Key decisions with a prefix and a style, and Save writes both to the mount', async () => {
  await withFixture({ mount: '', status: 'draft', instance: false }, (base, { dir }) => withPage(async (page) => {
    await page.goto(`${base}/definitions`)
    await page.waitForSelector('.defn-outline')
    await page.getByLabel('Mount a standard module').selectOption('key-decisions')
    const focus = page.locator('[data-testid="standard-module-focus"]')
    await focus.waitFor({ state: 'visible' })
    assert.match(await focus.locator('h2').textContent(), /Key decisions/)
    assert.match(await focus.locator('.defn-provided-badge').textContent(), /Gantry-provided/)

    // A new mount names its defaults, and offers both styles.
    const settings = focus.locator('[data-testid="key-decisions-settings"]')
    assert.equal(await settings.locator('#key-decisions-prefix').inputValue(), 'KD')
    assert.equal(await settings.locator('#key-decisions-style').inputValue(), 'default')
    assert.deepEqual(await settings.locator('#key-decisions-style option').allTextContents(), ['Default', 'WH(Y)'])

    await settings.locator('#key-decisions-prefix').fill('ad')
    assert.equal(await settings.locator('#key-decisions-prefix').inputValue(), 'AD', 'a prefix is typed in capitals')
    await settings.locator('#key-decisions-style').selectOption('why')
    await focus.locator('#standard-module-interview').fill('Ask only about decisions that are hard to reverse.')

    await page.locator('.defn-outline-node', { hasText: 'Shape' }).first().click()
    await page.locator('.defn-editor-inline select').first().selectOption({ label: 'Key decisions (Gantry-provided)' })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await savedDraft(page)

    const saved = parseYAML(readFileSync(join(dir, 'definition.yaml'), 'utf8'))
    assert.deepEqual(saved['standard-modules'], [{ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why', interview: 'Ask only about decisions that are hard to reverse.' }])
    assert.deepEqual(saved.stages[0].modules, ['notes', 'key-decisions'])

    // A prefix that is not 1 to 6 capital letters is a problem against the module.
    await page.reload()
    await page.waitForSelector('.defn-outline')
    await page.locator('[data-testid="standard-modules-group"] .defn-outline-node', { hasText: 'Key decisions' }).click()
    const reloaded = page.locator('[data-testid="standard-module-focus"]')
    assert.equal(await reloaded.locator('#key-decisions-prefix').inputValue(), 'AD')
    assert.equal(await reloaded.locator('#key-decisions-style').inputValue(), 'why')
    await reloaded.locator('#key-decisions-prefix').fill('')
    await reloaded.locator('.inline-error').first().waitFor({ state: 'visible' })
    assert.match(await reloaded.locator('.inline-error').first().textContent(), /Standard module "key-decisions" sets prefix "" — a prefix is 1 to 6 capital letters/)
  }))
})

test('Definitions page: a published version shows its prefix and style read-only', async () => {
  await withFixture({ mount: '  - id: key-decisions\n    version: 1\n    prefix: AD\n    style: why\n', instance: false }, (base) => withPage(async (page) => {
    await page.goto(`${base}/definitions`)
    await page.waitForSelector('.defn-outline')
    await page.locator('[data-testid="standard-modules-group"] .defn-outline-node', { hasText: 'Key decisions' }).click()
    const settings = page.locator('[data-testid="key-decisions-settings"]')
    assert.equal((await settings.locator('[data-testid="key-decisions-prefix"]').textContent()).trim(), 'AD')
    assert.equal((await settings.locator('[data-testid="key-decisions-style"]').textContent()).trim(), 'WH(Y)')
    assert.equal(await settings.locator('input, select').count(), 0)
  }))
})

test('Stage editor, default style: decisions are added, edited, reordered and removed, and each keeps its number through Save', async () => {
  await withFixture({ mount: '  - id: key-decisions\n    version: 1\n    prefix: AD\n' }, (base, dirs) => withPage(async (page) => {
    await page.goto(`${base}/instance/harbour`)
    const field = page.locator('[data-testid="key-decisions-field"]')
    await field.waitFor({ state: 'visible' })
    assert.equal(await field.getAttribute('data-style'), 'default')
    assert.match(await field.locator('[data-testid="decision-style"]').textContent(), /Decision style: Default/)
    assert.equal(await field.locator('[data-testid="decision"]').count(), 0)
    assert.match(await field.textContent(), /Target ~\d+ words/)

    // Three decisions, numbered as they are added; the default style has the five parts and no links.
    for (let i = 0; i < 3; i++) await field.locator('[data-testid="add-decision"]').click()
    const cards = field.locator('[data-testid="decision"]')
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD01', 'AD02', 'AD03'])
    assert.equal(await cards.first().locator('textarea').count(), 5)
    assert.equal(await cards.first().locator('[data-testid="decision-links"]').count(), 0)
    await field.getByLabel('Title of AD01').fill('Use PostgreSQL')
    await field.getByLabel('Title of AD02').fill('Cache reads')
    await field.getByLabel('Title of AD03').fill('Queue writes')
    await cards.nth(0).locator('[data-testid="decision-context"]').fill('The ledger needs transactions.')
    await cards.nth(0).locator('[data-testid="decision-decision"]').fill('Postgres 16.')
    await cards.nth(2).locator('[data-testid="decision-why"]').fill('Smooths bursts.')

    // Reordering moves a decision; removing one leaves a gap. Neither renumbers anything.
    await field.getByLabel('Move AD03 up').click()
    await field.getByLabel('Move AD03 up').click()
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD03', 'AD01', 'AD02'])
    await field.getByLabel('Remove AD02').click()
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD03', 'AD01'])
    assert.equal(await field.getByLabel('Title of AD03').inputValue(), 'Queue writes')

    await saveStage(page)
    const text = storedDecisions(dirs)
    assert.deepEqual(parseKeyDecisions(text).decisions.map((d) => [d.number, d.title]), [[3, 'Queue writes'], [1, 'Use PostgreSQL']])
    assert.match(text, /\*\*Context:\*\* The ledger needs transactions\./)
    assert.doesNotMatch(text, /next:/, 'AD03 is still the highest, so nothing needs protecting')

    // After a reload the same decisions come back under the same numbers, and the next one is AD04, not AD02.
    await page.reload()
    await field.waitFor({ state: 'visible' })
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD03', 'AD01'])
    assert.equal(await cards.nth(1).locator('[data-testid="decision-context"]').inputValue(), 'The ledger needs transactions.')
    await field.locator('[data-testid="add-decision"]').click()
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD03', 'AD01', 'AD04'])

    // Removing the newest and adding another does not reuse its number, in the same session or after Save.
    await field.getByLabel('Remove AD04').click()
    await field.locator('[data-testid="add-decision"]').click()
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD03', 'AD01', 'AD05'])
    await field.getByLabel('Remove AD05').click()
    await saveStage(page)
    assert.match(storedDecisions(dirs), /<!-- next: 6 -->$/)
    await page.reload()
    await field.waitFor({ state: 'visible' })
    await field.locator('[data-testid="add-decision"]').click()
    assert.deepEqual(await cards.locator('[data-testid="decision-number"]').allTextContents(), ['AD03', 'AD01', 'AD06'])
  }))
})

test('Stage editor, WH(Y): the six parts and typed links save as written and print in the Word render', async () => {
  await withFixture({ mount: '  - id: key-decisions\n    version: 1\n    prefix: AD\n    style: why\n' }, (base, dirs) => withPage(async (page) => {
    await page.goto(`${base}/instance/harbour`)
    const field = page.locator('[data-testid="key-decisions-field"]')
    await field.waitFor({ state: 'visible' })
    assert.equal(await field.getAttribute('data-style'), 'why')
    assert.match(await field.locator('[data-testid="decision-style"]').textContent(), /Decision style: WH\(Y\)/)

    await field.locator('[data-testid="add-decision"]').click()
    const cards = field.locator('[data-testid="decision"]')
    assert.equal(await cards.first().locator('textarea').count(), 6)
    assert.equal(await cards.first().locator('[data-testid="add-decision-link"]').count(), 0, 'a lone decision has nothing to link to')
    await field.locator('[data-testid="add-decision"]').click()

    await field.getByLabel('Title of AD01').fill('Use PostgreSQL')
    const first = cards.nth(0)
    await first.locator('[data-testid="decision-inContext"]').fill('the ledger')
    await first.locator('[data-testid="decision-facing"]').fill('a need for transactions')
    await first.locator('[data-testid="decision-decided"]').fill('PostgreSQL 16')
    await first.locator('[data-testid="decision-neglected"]').fill('MySQL')
    await first.locator('[data-testid="decision-achieve"]').fill('strong consistency')
    await first.locator('[data-testid="decision-accepting"]').fill('we run a database')

    await field.getByLabel('Title of AD02').fill('Cache reads')
    const second = cards.nth(1)
    await second.locator('[data-testid="decision-inContext"]').fill('read-heavy traffic')
    await second.locator('[data-testid="decision-decided"]').fill('a read-through cache')
    await second.locator('[data-testid="add-decision-link"]').click()
    await second.getByLabel('Link type of AD02').selectOption('depends-on')
    await second.getByLabel('Link target of AD02').selectOption('1')

    await saveStage(page)
    const text = storedDecisions(dirs)
    assert.match(text, /\*\*We decided for:\*\* PostgreSQL 16/)
    assert.match(text, /\*\*Depends on:\*\* AD01$/)
    assert.deepEqual(parseKeyDecisions(text).decisions[1].links, [{ type: 'depends-on', to: 1, raw: 'AD01' }])

    // Back in the editor the link is shown on the decision that holds it.
    await page.reload()
    await field.waitFor({ state: 'visible' })
    assert.equal(await cards.nth(1).getByLabel('Link type of AD02').inputValue(), 'depends-on')
    assert.equal(await cards.nth(1).getByLabel('Link target of AD02').inputValue(), '1')

    // The Word render prints each statement as a sentence, and the link under it.
    const { docxMarkdown } = renderArtefact('harbour', 'doc', { dryRun: true, definitionsDir: dirs.definitionsDir, instancesDir: dirs.instancesDir, commit: COMMIT })
    assert.match(docxMarkdown, /In the context of the ledger, facing a need for transactions, we decided for PostgreSQL 16 and neglected MySQL, to achieve strong consistency, accepting that we run a database\./)
    assert.match(docxMarkdown, /Depends on AD01\./)

    // A link to a decision that has since been removed is flagged, not silently dropped.
    await field.getByLabel('Remove AD01').click()
    await field.locator('[data-testid="decision-problems"]').waitFor({ state: 'visible' })
    assert.match(await field.locator('[data-testid="decision-problems"]').textContent(), /AD02 depends on AD01, which is not in this list/)
    assert.equal(await cards.first().getByLabel('Link target of AD02').inputValue(), '1')
  }))
})

test('Local Workspace editor: mounts Key decisions with a prefix and a style, and writes both to definition.yaml', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(async () => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-key-decisions-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Key Decisions E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/decisions-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('decisions-local-e2e')
      await page.locator('#local-def-title').fill('Decisions Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')

      const standard = editorRoot.locator('[data-testid="local-standard-modules"]')
      await standard.getByLabel('Mount a standard module').selectOption('key-decisions')
      const settings = standard.locator('[data-testid="key-decisions-settings"]')
      await settings.waitFor({ state: 'visible' })
      assert.equal(await settings.locator('#key-decisions-prefix').inputValue(), 'KD')
      assert.equal(await settings.locator('#key-decisions-style').inputValue(), 'default')
      await settings.locator('#key-decisions-prefix').fill('ad')
      await settings.locator('#key-decisions-style').selectOption('why')

      const stagesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Stages' }) })
      await stagesSection.getByRole('button', { name: '+ Add stage' }).click()
      const stage = stagesSection.locator('.local-def-element').first()
      await stage.locator('input[type="text"]').nth(0).fill('s1')
      await stage.locator('input[type="text"]').nth(1).fill('Stage one')
      await stage.getByText('Modules (comma-separated ids)').locator('xpath=following-sibling::input[1]').fill('key-decisions')
      await stage.getByText('Modules (comma-separated ids)').locator('xpath=following-sibling::input[1]').blur()

      await editorRoot.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => /Saved/i.test(document.body.textContent))
      const yaml = parseYAML(await readDefinitionYaml())
      assert.deepEqual(yaml['standard-modules'], [{ id: 'key-decisions', version: 1, prefix: 'AD', style: 'why' }])
      assert.deepEqual(yaml.stages[0].modules, ['key-decisions'])
      assert.doesNotMatch(await editorRoot.locator('.local-def-validation').textContent(), /no such module|prefix/)
    })
  })
})
