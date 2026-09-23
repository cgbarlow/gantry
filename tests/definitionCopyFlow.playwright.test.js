import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// WI #382 (Feature #380 phase 2): copying a Stage, Artefact, Module or Field from another
// definition — drag from the docked Library panel, or the "From another definition…" picker next
// to a "+ add" affordance — into a CopyPlanner plan (web/lib/copyPlanner.js) that must be confirmed
// before it lands. Two fixture definitions: "target" (the draft being edited) and "source" (the
// published Library definition being copied from), small and hand-built so every id clash below is
// deliberate rather than incidental.
//
// "target" starts with: stage `shape` (module `background`), artefact `soap` (requires
// `background.problem`), module `background` (field `problem`).
// "source" offers: stage `shape` (clashes; modules `background`+`extra-module`) and stage
// `handover` (no clash; brings module `glossary`), artefact `soap` (clashes) and artefact
// `as-built` (no clash; requires `glossary.terms`, and — WI #385 — its own template plus a
// reference `.docx`, to exercise the artefact-copy "brings" step end to end), module `background`
// (clashes; fields `problem`+`opportunity`) and module `extra-module` (no clash; field `note`),
// module `glossary` (field `terms`).

const REAL_REFERENCE_DOCX = readFileSync('definitions/design/1/templates/reference-soap.docx')

function withCopyFixtures(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-copyflow-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      const targetDir = join(definitionsDir, 'target', '1')
      mkdirSync(join(targetDir, 'modules'), { recursive: true })
      mkdirSync(join(targetDir, 'templates'), { recursive: true })
      writeFileSync(join(targetDir, 'definition.yaml'), yaml.stringify({
        id: 'target', version: 1, status: 'draft', title: 'Target Def', description: '',
        stages: [{ id: 'shape', title: 'Target Shape', purpose: '', gate: 'business-case', modules: ['background'] }],
        artefacts: [{ id: 'soap', title: 'Target SOAP', purpose: '', template: '', gate: 'business-case', requires: ['background.problem'] }],
      }))
      writeFileSync(join(targetDir, 'modules', 'background.yaml'), yaml.stringify({
        id: 'background', title: 'Target Background', purpose: '',
        fields: [{ id: 'problem', title: 'Target Problem', type: 'markdown' }],
      }))
      writeFileSync(join(targetDir, 'CHANGELOG.md'), '## v1\n\nDraft.\n')

      const sourceDir = join(definitionsDir, 'source', '1')
      mkdirSync(join(sourceDir, 'modules'), { recursive: true })
      mkdirSync(join(sourceDir, 'templates'), { recursive: true })
      writeFileSync(join(sourceDir, 'definition.yaml'), yaml.stringify({
        id: 'source', version: 1, status: 'published', title: 'Source Def', description: '',
        stages: [
          { id: 'shape', title: 'Source Shape', purpose: '', gate: 'business-case', modules: ['background', 'extra-module'] },
          { id: 'handover', title: 'Handover', purpose: '', gate: 'ops-gate', modules: ['glossary'] },
        ],
        artefacts: [
          { id: 'soap', title: 'Source SOAP', purpose: '', template: 'templates/soap.md.tmpl', gate: 'business-case', requires: ['background.problem'] },
          { id: 'as-built', title: 'As Built', purpose: '', template: 'templates/as-built.md.tmpl', gate: 'ops-gate', requires: ['glossary.terms'] },
        ],
      }))
      writeFileSync(join(sourceDir, 'modules', 'background.yaml'), yaml.stringify({
        id: 'background', title: 'Source Background', purpose: '',
        fields: [
          { id: 'problem', title: 'Source Problem', type: 'markdown' },
          { id: 'opportunity', title: 'Opportunity', type: 'markdown' },
        ],
      }))
      writeFileSync(join(sourceDir, 'modules', 'extra-module.yaml'), yaml.stringify({
        id: 'extra-module', title: 'Extra Module', purpose: '', fields: [{ id: 'note', title: 'Note', type: 'markdown' }],
      }))
      writeFileSync(join(sourceDir, 'modules', 'glossary.yaml'), yaml.stringify({
        id: 'glossary', title: 'Glossary', purpose: '', fields: [{ id: 'terms', title: 'Terms', type: 'markdown' }],
      }))
      writeFileSync(join(sourceDir, 'templates', 'soap.md.tmpl'), '# Source SOAP\n')
      writeFileSync(join(sourceDir, 'templates', 'as-built.md.tmpl'), '# As Built\n')
      writeFileSync(join(sourceDir, 'templates', 'reference-as-built.docx'), REAL_REFERENCE_DOCX)
      writeFileSync(join(sourceDir, 'CHANGELOG.md'), '## v1\n\nPublished.\n')

      await withRunningServer({ definitionsDir, instancesDir }, fn)
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

async function withPage(base, fn, { acceptDialogs = false } = {}) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    if (acceptDialogs) page.on('dialog', (d) => d.accept())
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

// Shares one DataTransfer across dragstart → dragover → drop → dragend, exactly like
// tests/definition-viewer.playwright.test.js's own helper — needed because the page's drag
// handlers read/write `dataTransfer` directly (web/pages/definition-viewer.js's zoneProps/
// libraryDragHandleProps).
async function htmlDragAndDrop(page, sourceLocator, targetLocator) {
  await sourceLocator.scrollIntoViewIfNeeded()
  await targetLocator.scrollIntoViewIfNeeded()
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await sourceLocator.dispatchEvent('dragstart', { dataTransfer })
  await targetLocator.dispatchEvent('dragover', { dataTransfer })
  await targetLocator.dispatchEvent('drop', { dataTransfer })
  await sourceLocator.dispatchEvent('dragend', { dataTransfer })
}

async function openTargetDefinition(page, base) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
  await page.locator('.defn-switcher [data-dropdown-trigger]').click()
  await page.waitForSelector('.defn-switcher-menu', { timeout: 10_000 })
  await page.locator('.defn-switcher-row').filter({ hasText: 'Target Def' }).click()
  await page.waitForSelector('.defn-workbench', { timeout: 10_000 })
  await page.waitForSelector('.defn-library-tree', { timeout: 10_000 }) // Library panel finished loading "source"
}

function libraryNode(page, title) {
  return page.locator('.defn-library-node').filter({ hasText: title }).first()
}

async function confirmCopy(page) {
  const confirmBtn = page.locator('.defn-copy-modal').getByRole('button', { name: 'Confirm copy' })
  await confirmBtn.waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await confirmBtn.isDisabled(), false, 'Confirm should be enabled once every clash is resolved')
  await confirmBtn.click()
  await page.waitForSelector('.defn-copy-modal', { state: 'detached', timeout: 10_000 })
}

async function chooseCollision(page, label) {
  await page.locator('.defn-copy-collision label').filter({ hasText: label }).locator('input[type=radio]').check()
}

test('Dragging a module from the Library with no clash lands it with a provenance badge', withCopyFixtures(async (base) => {
  await withPage(base, async (page, pageErrors) => {
    await openTargetDefinition(page, base)

    const handle = libraryNode(page, 'Extra Module').locator('.defn-drag-handle')
    const modulesGroupHead = page.locator('.defn-outline-group', { has: page.locator('.kicker', { hasText: 'Modules ·' }) }).locator('.defn-outline-group-head')
    await htmlDragAndDrop(page, handle, modulesGroupHead)

    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    assert.match(await page.locator('.defn-copy-modal h3').textContent(), /module "extra-module"/)
    assert.equal(await page.locator('.defn-copy-collision').count(), 0, 'a brand-new id has nothing to resolve')
    await confirmCopy(page)

    const landed = page.locator('.defn-outline-node').filter({ hasText: 'Extra Module' })
    await landed.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await landed.textContent(), /from source v1/)
    assert.deepEqual(pageErrors, [])
  })
}))

test('Dragging a stage with a dependency lists it under "Comes along" and lands both after confirm', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)

    const handle = libraryNode(page, 'Handover').locator('.defn-drag-handle')
    const stagesGroupHead = page.locator('.defn-outline-group', { has: page.locator('.kicker', { hasText: 'Stages ·' }) }).locator('.defn-outline-group-head')
    await htmlDragAndDrop(page, handle, stagesGroupHead)

    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    const bringsText = await page.locator('.defn-copy-section').filter({ hasText: 'Comes along' }).textContent()
    assert.match(bringsText, /glossary/)
    await confirmCopy(page)

    const stageNode = page.locator('.defn-outline-group').first().locator('.defn-outline-node').filter({ hasText: 'Handover' })
    await stageNode.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await stageNode.textContent(), /from source v1/)
    const moduleNode = page.locator('.defn-outline-node').filter({ hasText: 'Glossary' })
    await moduleNode.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await moduleNode.textContent(), /from source v1/)
  })
}))

test('Module id clash — rename keeps both modules, the copy under the new id', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source Background').locator('.defn-library-copy-btn').click()

    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    assert.match(await page.locator('.defn-copy-modal').textContent(), /already in your definition/)
    await chooseCollision(page, 'Keep both')
    const renameInput = page.locator('.defn-copy-rename input')
    await renameInput.waitFor({ state: 'visible' })
    assert.equal(await renameInput.inputValue(), 'background-2')
    await confirmCopy(page)

    await page.locator('.defn-outline-node').filter({ hasText: 'Target Background' }).waitFor({ state: 'visible', timeout: 10_000 })
    const renamed = page.locator('.defn-outline-node').filter({ hasText: 'Source Background' })
    await renamed.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await renamed.textContent(), /from source v1/)
  })
}))

test('Module id clash — replace overwrites the module wholesale', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source Background').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Replace mine')
    await confirmCopy(page)

    assert.equal(await page.locator('.defn-outline-node').filter({ hasText: 'Target Background' }).count(), 0)
    const replaced = page.locator('.defn-outline-node').filter({ hasText: 'Source Background' })
    await replaced.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await replaced.textContent(), /from source v1/)
  })
}))

test('Module id clash — merge adds only the fields the target lacks, leaves its title and existing field untouched', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source Background').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Merge')
    await confirmCopy(page)

    // target's own title survives a merge — no rename, no replace
    const moduleNode = page.locator('.defn-outline-node').filter({ hasText: 'Target Background' })
    await moduleNode.waitFor({ state: 'visible', timeout: 10_000 })
    await moduleNode.click()
    const fieldRows = page.locator('.defn-field-row-title')
    await page.locator('.defn-field-row-title').filter({ hasText: 'Opportunity' }).waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await fieldRows.count(), 2, 'the pre-existing problem field plus the merged-in opportunity field')
    const opportunityRow = page.locator('.defn-field-row').filter({ hasText: 'Opportunity' })
    assert.match(await opportunityRow.textContent(), /from source v1/)
    const problemRow = page.locator('.defn-field-row').filter({ hasText: 'Target Problem' })
    await problemRow.waitFor({ state: 'visible' })
    assert.doesNotMatch(await problemRow.textContent(), /from source/, 'the pre-existing field is untouched by a merge')
  })
}))

test('Field id clash (into a module) — rename keeps both fields', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await page.locator('.defn-outline-node').filter({ hasText: 'Target Background' }).click()
    await page.waitForSelector('.defn-library-picker', { timeout: 10_000 })
    await page.locator('.defn-focus-section', { has: page.locator('.kicker', { hasText: 'Fields' }) }).locator('.defn-library-picker').selectOption({ label: 'Source Background · Source Problem (source)' })

    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Keep both')
    const renameInput = page.locator('.defn-copy-rename input')
    await renameInput.fill('problem-2')
    await confirmCopy(page)

    await page.locator('.defn-field-row-title').filter({ hasText: 'Target Problem' }).waitFor({ state: 'visible', timeout: 10_000 })
    const renamedFieldRow = page.locator('.defn-field-row').filter({ hasText: 'Source Problem' })
    await renamedFieldRow.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await renamedFieldRow.textContent(), /problem-2/)
    assert.match(await renamedFieldRow.textContent(), /from source v1/)
  })
}))

test('Field id clash (into a module) — replace overwrites just that field in place', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await page.locator('.defn-outline-node').filter({ hasText: 'Target Background' }).click()
    await page.waitForSelector('.defn-library-picker', { timeout: 10_000 })
    await page.locator('.defn-focus-section', { has: page.locator('.kicker', { hasText: 'Fields' }) }).locator('.defn-library-picker').selectOption({ label: 'Source Background · Source Problem (source)' })

    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Replace mine')
    await confirmCopy(page)

    assert.equal(await page.locator('.defn-field-row-title').filter({ hasText: 'Target Problem' }).count(), 0)
    const replacedFieldRow = page.locator('.defn-field-row').filter({ hasText: 'Source Problem' })
    await replacedFieldRow.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await replacedFieldRow.textContent(), /from source v1/)
    assert.equal(await page.locator('.defn-field-row-title').count(), 1, 'still exactly one field — replaced in place, not added alongside')
  })
}))

test('Stage id clash — rename keeps both stages', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source Shape').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Keep both')
    await confirmCopy(page)

    await page.locator('.defn-outline-node').filter({ hasText: 'Target Shape' }).waitFor({ state: 'visible', timeout: 10_000 })
    const renamedStage = page.locator('.defn-outline-node').filter({ hasText: 'Source Shape' })
    await renamedStage.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await renamedStage.textContent(), /from source v1/)
  })
}))

test('Stage id clash — replace overwrites the stage, including its module list', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source Shape').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Replace mine')
    await confirmCopy(page)

    assert.equal(await page.locator('.defn-outline-node').filter({ hasText: 'Target Shape' }).count(), 0)
    const replacedStage = page.locator('.defn-outline-node').filter({ hasText: 'Source Shape' })
    await replacedStage.waitFor({ state: 'visible', timeout: 10_000 })
    await replacedStage.click()
    const moduleChips = page.locator('.defn-focus-section', { has: page.locator('.kicker', { hasText: 'Modules in this stage' }) }).locator('.defn-chip')
    await moduleChips.first().waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await moduleChips.count(), 2, 'both of the source stage\'s modules, replacing the target\'s own single module')
  })
}))

test('Stage id clash — merge is the union of module lists; target title survives', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source Shape').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Merge')
    await confirmCopy(page)

    const stageNode = page.locator('.defn-outline-node').filter({ hasText: 'Target Shape' })
    await stageNode.waitFor({ state: 'visible', timeout: 10_000 })
    await stageNode.click()
    const moduleChips = page.locator('.defn-focus-section', { has: page.locator('.kicker', { hasText: 'Modules in this stage' }) }).locator('.defn-chip')
    await moduleChips.filter({ hasText: 'Extra Module' }).waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await moduleChips.count(), 2, 'target already had background; extra-module is the union addition')
  })
}))

test('Artefact id clash — rename keeps both artefacts', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source SOAP').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Keep both')
    await confirmCopy(page)

    await page.locator('.defn-outline-node').filter({ hasText: 'Target SOAP' }).waitFor({ state: 'visible', timeout: 10_000 })
    const renamedArtefact = page.locator('.defn-outline-node').filter({ hasText: 'Source SOAP' })
    await renamedArtefact.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await renamedArtefact.textContent(), /from source v1/)
  })
}))

test('Artefact id clash — replace overwrites the artefact wholesale', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'Source SOAP').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    await chooseCollision(page, 'Replace mine')
    await confirmCopy(page)

    assert.equal(await page.locator('.defn-outline-node').filter({ hasText: 'Target SOAP' }).count(), 0)
    const replaced = page.locator('.defn-outline-node').filter({ hasText: 'Source SOAP' })
    await replaced.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await replaced.textContent(), /from source v1/)
  })
}))

test('Copying an artefact with no id clash brings its template text and reference .docx along, not just the plan', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await libraryNode(page, 'As Built').locator('.defn-library-copy-btn').click()
    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    const bringsText = await page.locator('.defn-copy-section').filter({ hasText: 'Comes along' }).textContent()
    assert.match(bringsText, /templates\/as-built\.md\.tmpl/)
    assert.match(bringsText, /templates\/as-built reference \.docx/)
    assert.equal(await page.locator('.defn-copy-collision').count(), 0, 'a fresh id copies straight through, nothing to resolve')
    await confirmCopy(page)

    const landed = page.locator('.defn-outline-node').filter({ hasText: 'As Built' })
    await landed.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await landed.textContent(), /from source v1/)

    // The plan landing the artefact is one thing; the .md.tmpl *content* and its paired reference
    // .docx are separate files, written through the template and reference-docx routes right after
    // (web/pages/definition-viewer.js's applyCopyFlow) — assert both actually arrived, not just that
    // the confirm panel promised them.
    const templateRes = await fetch(`${base}/api/definitions/target/versions/1/templates/as-built.md.tmpl`)
    assert.equal(templateRes.status, 200)
    assert.equal((await templateRes.json()).source, '# As Built\n')

    const docxRes = await fetch(`${base}/api/definitions/target/versions/1/artefacts/as-built/reference-docx`)
    assert.equal(docxRes.status, 200)
    const docxBytes = Buffer.from(await docxRes.arrayBuffer())
    assert.deepEqual(docxBytes, REAL_REFERENCE_DOCX)
  })
}))

test('Dropping a field onto an artefact adds a module.field requirement and brings the missing module along', withCopyFixtures(async (base) => {
  await withPage(base, async (page) => {
    await openTargetDefinition(page, base)
    await page.locator('.defn-outline-node').filter({ hasText: 'Target SOAP' }).click()
    await page.waitForSelector('.defn-focus-section .defn-library-picker', { timeout: 10_000 })
    const requiresSection = page.locator('.defn-focus-section', { has: page.locator('.kicker', { hasText: 'Requires' }) })
    await requiresSection.locator('.defn-library-picker').first().selectOption({ label: 'Glossary · Terms (source)' })

    await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
    assert.match(await page.locator('.defn-copy-modal h3').textContent(), /glossary\.terms.*SOAP/i)
    const bringsText = await page.locator('.defn-copy-section').filter({ hasText: 'Comes along' }).textContent()
    assert.match(bringsText, /module.*glossary/)
    assert.equal(await page.locator('.defn-copy-collision').count(), 0, 'the requirement itself cannot clash — soap did not already require it')
    await confirmCopy(page)

    const glossaryChip = page.locator('.defn-requires-group').filter({ hasText: 'Glossary' })
    await glossaryChip.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await glossaryChip.textContent(), /terms/)
    const moduleNode = page.locator('.defn-outline-node').filter({ hasText: 'Glossary' })
    await moduleNode.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await moduleNode.textContent(), /from source v1/)
  })
}))

// #161: with the Map expanded the Library panel is hidden, but the Map's own "From another
// definition…" pickers are still there — a copy started from one must still show its confirm step
// (the modal can't live inside the hidden panel) and land in the Map without collapsing it.
test('A copy started from the expanded Map still shows its confirm step and lands in the Map', withCopyFixtures(async (base) => {
  await withPage(base, async (page, pageErrors) => {
    await openTargetDefinition(page, base)
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    await page.waitForSelector('.defn-workbench-map', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Expand map' }).click()
    await page.locator('.defn-bottom').waitFor({ state: 'hidden' })

    await page.locator('.defn-map-add-row').getByLabel('From another definition: module').selectOption({ label: 'Extra Module (source)' })
    await confirmCopy(page)

    await page.locator('.defn-map-chip').filter({ hasText: 'Extra Module' }).waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await page.getByRole('button', { name: 'Expand map' }).getAttribute('aria-pressed'), 'true', 'the Map stays expanded')
    assert.deepEqual(pageErrors, [])
  })
}))
