import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// WI #381: the Definitions page rebuilt as a first-class editor — one '/definitions' route, an
// Outline/Map view switch over one focus pane and a docked (read-only for now) Library panel, drag
// and drop with a button-route fallback for every drag, live validation markers, and the stageSave.js
// Save/Discard/leave-guard convention. See web/prototypes/definition-editor.prototype.html (primary
// layout source) and CONTEXT.md (Element, Field visibility per artefact) for vocabulary.

function withDraftDesignV2(extraSetup) {
  return async (fn) => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-viewer-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
      cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
      let t = readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8')
      t = t.replace('version: 1', 'version: 2').replace('status: published', 'status: draft')
      writeFileSync(join(definitionsDir, 'design/2/definition.yaml'), t)
      if (extraSetup) extraSetup(definitionsDir)
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

// Simulates a real HTML5 drag-and-drop sequence (dragstart → dragover → drop → dragend) sharing one
// DataTransfer across all four events, the way a real browser drag does — needed because the page's
// own drag handlers read/write `dataTransfer` directly (see web/pages/definition-viewer.js's
// dragHandleProps/zoneProps).
async function htmlDragAndDrop(page, sourceLocator, targetLocator) {
  await sourceLocator.scrollIntoViewIfNeeded()
  await targetLocator.scrollIntoViewIfNeeded()
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await sourceLocator.dispatchEvent('dragstart', { dataTransfer })
  await targetLocator.dispatchEvent('dragover', { dataTransfer })
  await targetLocator.dispatchEvent('drop', { dataTransfer })
  await sourceLocator.dispatchEvent('dragend', { dataTransfer })
}

async function openSwitcher(page) {
  await page.locator('.defn-switcher [data-dropdown-trigger]').click()
  await page.waitForSelector('.defn-switcher-menu, .defn-newdef-panel', { timeout: 10_000 })
}

test('Definitions page renders the switcher with badges; published detail is read-only', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/`)
      await page.waitForSelector('.dashboard', { timeout: 10_000 })
      const link = page.getByRole('link', { name: 'Definitions', exact: true })
      await link.waitFor({ state: 'visible', timeout: 10_000 })
      await link.click()
      await page.waitForURL('**/definitions', { timeout: 10_000 })
      await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })

      await openSwitcher(page)
      const badgeCount = await page.locator('.defn-switcher-row .defn-rail-badges .stamp').count()
      assert.ok(badgeCount > 0, 'design row should show version badges')
      await page.keyboard.press('Escape')

      await page.waitForSelector('.defn-workbench', { timeout: 10_000 })
      const inputCount = await page.locator('.defn-focus-pane input, .defn-focus-pane textarea').count()
      assert.equal(inputCount, 0, 'a published version should have no editable inputs')
      assert.equal(await page.locator('.defn-drag-handle').count(), 0, 'a published version should have no drag handles')

      assert.deepEqual(pageErrors, [])
    })
  })
})

test('Definitions page drops the old /definition-editor route', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      const res = await page.goto(`${base}/definition-editor`)
      // preact-iso serves the SPA shell for unknown paths; assert the old route no longer resolves
      // to the definition editor content specifically.
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.defn-viewer').count(), 0)
    })
  })
})

test('A draft version is directly editable; switching to the published version removes the inputs', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('1')
      await page.waitForSelector('.defn-workbench', { timeout: 10_000 })
      assert.equal(await page.locator('.defn-focus-pane input').count(), 0)

      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-focus-title-input', { timeout: 10_000 })
      assert.ok(await page.locator('.defn-focus-pane input').count() > 0, 'a draft version should be directly editable')
      assert.ok(await page.locator('.defn-drag-handle').count() > 0, 'a draft version should offer drag handles')
    })
  })
})

test('Editing a field title and Save persists it, including across a reload', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const firstModuleNode = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await firstModuleNode.click()
      const firstFieldHead = page.locator('.defn-field-row-head').first()
      await firstFieldHead.waitFor({ state: 'visible', timeout: 10_000 })
      await firstFieldHead.click()

      const titleInput = page.locator('.defn-field-row.open .defn-field-row-body input').first()
      await titleInput.waitFor({ state: 'visible', timeout: 10_000 })
      const newTitle = 'Edited Field Title ' + Date.now()
      await titleInput.fill(newTitle)

      const saveBtn = page.getByRole('button', { name: 'Save', exact: true })
      await saveBtn.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await saveBtn.isDisabled(), false, 'Save should be enabled once the draft is dirty')
      await saveBtn.click()
      await page.waitForFunction(() => document.querySelector('button.primary')?.textContent !== 'Saving…', { timeout: 10_000 })

      const persisted = page.locator('.defn-field-row-title').filter({ hasText: newTitle })
      await persisted.waitFor({ state: 'visible', timeout: 10_000 })

      await page.reload()
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const moduleNodeAfterReload = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await moduleNodeAfterReload.click()
      const persistedAfterReload = page.locator('.defn-field-row-title').filter({ hasText: newTitle })
      await persistedAfterReload.waitFor({ state: 'visible', timeout: 10_000 })
    })
  })
})

test('New draft version button adds and selects a version', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-workbench', { timeout: 10_000 })
      const initialOptions = await page.locator('#defn-version-select option').count()
      assert.equal(initialOptions, 2)

      const newDraftBtn = page.getByRole('button', { name: 'New draft version' })
      await newDraftBtn.click()
      await page.waitForFunction(() => document.querySelectorAll('#defn-version-select option').length === 3, { timeout: 10_000 })
      assert.equal(await page.locator('#defn-version-select').inputValue(), '3')
      const badge = page.locator('.defn-toolbar .stamp').last()
      await badge.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await badge.textContent(), /v3 draft/)
    })
  })
})

test('Publish flips the badge to published and removes editing', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-focus-title-input', { timeout: 10_000 })

      const publishBtn = page.getByRole('button', { name: 'Publish', exact: true })
      await publishBtn.click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      const badge = page.locator('.defn-toolbar .stamp').last()
      assert.match(await badge.textContent(), /v2 published/)
      assert.equal(await page.locator('.defn-focus-pane input').count(), 0)
      assert.equal(await publishBtn.count(), 0)

      const opt = page.locator('#defn-version-select option[value="2"]')
      assert.match(await opt.textContent(), /published/)
    }, { acceptDialogs: true })
  })
})

test('Archive hides a definition from the switcher; Show archived reveals it; Restore un-hides it', async () => {
  const yamlLocal = await import('yaml')
  await withDraftDesignV2((definitionsDir) => {
    cpSync('definitions/design/1', join(definitionsDir, 'other/1'), { recursive: true })
    const raw = readFileSync(join(definitionsDir, 'other/1/definition.yaml'), 'utf8')
    const parsed = yamlLocal.parse(raw)
    parsed.id = 'other'
    parsed.title = 'Other Def'
    writeFileSync(join(definitionsDir, 'other/1/definition.yaml'), yamlLocal.stringify(parsed))
  })(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
      await openSwitcher(page)
      let rows = await page.locator('.defn-switcher-row').count()
      assert.equal(rows, 2)

      const designRow = page.locator('.defn-switcher-row').filter({ hasText: 'design' }).first()
      const archiveGetPromise = page.waitForResponse((r) => r.url().includes('/api/definitions') && r.request().method() === 'GET', { timeout: 10_000 })
      await designRow.getByRole('button', { name: 'Archive', exact: true }).click()
      await archiveGetPromise
      await page.waitForFunction(() => document.querySelectorAll('.defn-switcher-row').length === 1, { timeout: 10_000 })

      const showArchivedGetPromise = page.waitForResponse((r) => r.url().includes('/api/definitions') && r.request().method() === 'GET', { timeout: 10_000 })
      await page.getByRole('checkbox', { name: 'Show archived' }).check()
      await showArchivedGetPromise
      await page.waitForFunction(() => document.querySelectorAll('.defn-switcher-row').length === 2, { timeout: 10_000 })
      const archivedRow = page.locator('.defn-switcher-row.archived').filter({ hasText: 'design' })
      await archivedRow.waitFor({ state: 'visible', timeout: 5000 })

      const restorePromise = page.waitForResponse((r) => r.url().includes('/api/definitions') && r.request().method() === 'GET', { timeout: 10_000 })
      await archivedRow.getByRole('button', { name: 'Restore', exact: true }).click()
      await restorePromise
      await page.waitForFunction(() => document.querySelectorAll('.defn-switcher-row.archived').length === 0, { timeout: 10_000 })
    })
  })
})

test('Outline / Map view switch changes the layout and is remembered across a reload', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-workbench-outline', { timeout: 10_000 })

      await page.getByRole('button', { name: 'Map', exact: true }).click()
      await page.waitForSelector('.defn-workbench-map', { timeout: 10_000 })
      assert.equal(await page.locator('.defn-map-col').count() > 0, true)

      await page.reload()
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-workbench-map', { timeout: 10_000 })

      await page.getByRole('button', { name: 'Outline', exact: true }).click()
      await page.waitForSelector('.defn-workbench-outline', { timeout: 10_000 })
    })
  })
})

test('Field rows are compact, expanding one at a time', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const moduleNode = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await moduleNode.click()
      await page.waitForSelector('.defn-field-row', { timeout: 10_000 })

      const rows = page.locator('.defn-field-row')
      const count = await rows.count()
      assert.ok(count >= 2, 'test module should have at least 2 fields')

      await rows.nth(0).locator('.defn-field-row-head').click()
      assert.equal(await page.locator('.defn-field-row.open').count(), 1)
      await rows.nth(1).locator('.defn-field-row-head').click()
      assert.equal(await page.locator('.defn-field-row.open').count(), 1, 'only one field row should be expanded at a time')
      const openTitle = await page.locator('.defn-field-row.open .defn-field-row-title').textContent()
      const secondRowTitle = await rows.nth(1).locator('.defn-field-row-title').textContent()
      assert.equal(openTitle, secondRowTitle)
    })
  })
})

test('Reorder: dragging a stage persists after Save (and the button route works too)', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const stageRows = page.locator('.defn-outline-group').nth(0).locator('.defn-outline-node')
      const beforeLabels = await stageRows.locator('.defn-outline-label').allTextContents()
      assert.ok(beforeLabels.length >= 2)

      assert.equal(await stageRows.nth(0).getByRole('button', { name: /Move stage.*up/ }).isDisabled(), true)
      assert.equal(await stageRows.nth(0).getByRole('button', { name: /Move stage.*down/ }).isDisabled(), false)

      // Drag route: swap the first two rows
      const handle = stageRows.nth(0).locator('.defn-drag-handle')
      assert.equal(await handle.count(), 1)
      await htmlDragAndDrop(page, handle, stageRows.nth(1))
      const afterDragLabels = await stageRows.locator('.defn-outline-label').allTextContents()
      const expectedAfterDrag = [beforeLabels[1], beforeLabels[0], ...beforeLabels.slice(2)]
      assert.deepEqual(afterDragLabels, expectedAfterDrag, 'dragging the first row onto the second should swap them')

      // Button route: move the third row (now at index 2) up, composing with the drag above into an
      // order that differs from the original in more than one way, then Save and confirm it persists.
      await stageRows.nth(2).getByRole('button', { name: /Move stage.*up/ }).click()
      const expectedFinal = [expectedAfterDrag[0], expectedAfterDrag[2], expectedAfterDrag[1], ...expectedAfterDrag.slice(3)]
      const afterButtonLabels = await stageRows.locator('.defn-outline-label').allTextContents()
      assert.deepEqual(afterButtonLabels, expectedFinal)

      const saveBtn = page.getByRole('button', { name: 'Save', exact: true })
      await saveBtn.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await saveBtn.isDisabled(), false)
      await saveBtn.click()
      await page.waitForFunction(() => !document.querySelector('.defn-toolbar')?.textContent.includes('Unsaved changes'), { timeout: 10_000 })
      assert.deepEqual(await page.locator('.defn-load-error, .load-error').allTextContents(), [])

      await page.reload()
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const persistedLabels = await page.locator('.defn-outline-group').nth(0).locator('.defn-outline-node .defn-outline-label').allTextContents()
      assert.deepEqual(persistedLabels, expectedFinal)
    })
  })
})

test('Drag a module onto a stage adds it (and the "+ Add module" button route does too)', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      // Focus a stage that does not yet use the "risks" module
      const stageNode = page.locator('.defn-outline-node').filter({ hasText: 'SOAP' }).first()
      await stageNode.click()
      const chipsBefore = await page.locator('.defn-focus-section').first().locator('.defn-chip').count()

      // Button route: "+ Add module…" select
      const addModuleSelect = page.locator('.defn-focus select').first()
      await addModuleSelect.waitFor({ state: 'visible', timeout: 5000 })
      const optionValue = await addModuleSelect.locator('option').nth(1).getAttribute('value')
      await addModuleSelect.selectOption(optionValue)
      await page.waitForFunction((n) => document.querySelectorAll('.defn-focus-section')[0].querySelectorAll('.defn-chip').length === n, chipsBefore + 1, { timeout: 5000 })

      // Drag route: drag a different, still-unused module from the outline onto the stage node
      const usedNow = await page.locator('.defn-focus-section').first().locator('.defn-chip').allTextContents()
      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      const candidateModules = await modulesGroup.locator('.defn-outline-label').allTextContents()
      const draggableModuleLabel = candidateModules.find((label) => !usedNow.some((u) => u.includes(label)))
      assert.ok(draggableModuleLabel, 'expected at least one module not already in this stage')
      const moduleRow = modulesGroup.locator('.defn-outline-node').filter({ hasText: draggableModuleLabel }).first()
      const moduleDragHandle = moduleRow.locator('[title="Drag onto a stage or artefact"]')
      await htmlDragAndDrop(page, moduleDragHandle, stageNode)
      await page.waitForFunction((n) => document.querySelectorAll('.defn-focus-section')[0].querySelectorAll('.defn-chip').length === n, chipsBefore + 2, { timeout: 5000 })

      const finalChips = await page.locator('.defn-focus-section').first().locator('.defn-chip').allTextContents()
      assert.ok(finalChips.some((c) => c.includes(draggableModuleLabel)))
    })
  })
})

test('Drag a field onto an artefact adds a requirement (and the "+ Add requirement" button route does too)', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const artefactNode = page.locator('.defn-outline-node').filter({ hasText: 'Solution on a Page' }).first()
      await artefactNode.click()
      await page.waitForSelector('.defn-requires-group', { timeout: 10_000 })
      const requiresBefore = await page.locator('.defn-droplist .defn-chip').count()

      // Button route
      const addReqSelect = page.locator('.defn-focus-section').filter({ hasText: 'Requires' }).locator('select')
      const reqOptionValue = await addReqSelect.locator('option').nth(1).getAttribute('value')
      await addReqSelect.selectOption(reqOptionValue)
      await page.waitForFunction((n) => document.querySelector('.defn-droplist').querySelectorAll('.defn-chip').length === n, requiresBefore + 1, { timeout: 5000 })

      // Drag route: the artefact stays focused (so `.defn-droplist` stays the drop target) while a
      // module's own drag handle — visible in the outline regardless of what's focused — is dragged
      // onto it; this adds every one of that module's fields as a requirement.
      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      const riskModuleRow = modulesGroup.locator('.defn-outline-node').filter({ hasText: 'Risks' }).first()
      const riskModuleDragHandle = riskModuleRow.locator('[title="Drag onto a stage or artefact"]')
      const requiresBefore2 = await page.locator('.defn-droplist .defn-chip').count()
      await htmlDragAndDrop(page, riskModuleDragHandle, page.locator('.defn-droplist'))
      await page.waitForFunction((n) => document.querySelector('.defn-droplist').querySelectorAll('.defn-chip').length > n, requiresBefore2, { timeout: 5000 })
    })
  })
})

test('Drag a field to a different module moves it (and the "Move to module" button route does too)', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      const backgroundModule = modulesGroup.locator('.defn-outline-node').filter({ hasText: 'Background and context' }).first()
      await backgroundModule.click()
      await page.waitForSelector('.defn-field-row', { timeout: 10_000 })
      const fieldsBefore = await page.locator('.defn-field-row-title').allTextContents()
      const movingField = fieldsBefore[fieldsBefore.length - 1]

      // Button route: open the last field, use "Move to module"
      await page.locator('.defn-field-row-head').last().click()
      const moveSelect = page.locator('.defn-field-row.open .defn-move-to-module')
      await moveSelect.waitFor({ state: 'visible', timeout: 5000 })
      const targetOption = await moveSelect.locator('option').nth(1).getAttribute('value')
      await moveSelect.selectOption(targetOption)
      await page.getByRole('button', { name: 'Move', exact: true }).click()
      await page.waitForFunction((removed) => ![...document.querySelectorAll('.defn-field-row-title')].some((el) => el.textContent.includes(removed)), movingField, { timeout: 5000 })

      // Drag route: drag a field row's handle from this module onto a different module in the outline
      const remainingFields = await page.locator('.defn-field-row-title').allTextContents()
      assert.ok(remainingFields.length >= 1, 'module should still have fields left to drag')
      const fieldHandle = page.locator('.defn-field-row .defn-drag-handle').first()
      const otherModule = modulesGroup.locator('.defn-outline-node').filter({ hasText: 'Risks' }).first()
      const fieldLabelBefore = await page.locator('.defn-field-row-title').first().textContent()
      await htmlDragAndDrop(page, fieldHandle, otherModule)
      await page.waitForFunction((moved) => ![...document.querySelectorAll('.defn-field-row-title')].some((el) => el.textContent === moved), fieldLabelBefore, { timeout: 5000 })
      await otherModule.click()
      const movedIntoOther = await page.locator('.defn-field-row-title').allTextContents()
      assert.ok(movedIntoOther.some((t) => t === fieldLabelBefore))
    })
  })
})

test('Live validation markers appear when the draft references something that no longer exists', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      assert.match(await page.locator('.defn-no-problems').textContent(), /No problems/)

      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      const moduleRow = modulesGroup.locator('.defn-outline-node').filter({ hasText: 'Background and context' }).first()
      await moduleRow.click()
      const idInput = page.locator('.defn-focus-row input.mono').first()
      await idInput.waitFor({ state: 'visible', timeout: 5000 })
      await idInput.fill('background-renamed')

      const problemsBtn = page.locator('.defn-problems')
      await problemsBtn.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await problemsBtn.textContent(), /problem/)

      assert.equal(await page.locator('.defn-outline-group').nth(0).locator('.defn-problem-dot').count() > 0, true, 'the stage referencing the renamed module should show a problem marker')

      await problemsBtn.click()
      await page.waitForSelector('.defn-focus h2', { timeout: 5000 })
      assert.equal(await page.locator('.defn-focus .kicker').first().textContent(), 'Stage', 'jumping to the first problem should focus the stage that references the renamed module')
      assert.equal(await page.locator('.defn-focus-row input.mono').first().inputValue(), 'shape')
    })
  })
})

test('Template editing round-trips through the CodeMirror focus-pane view', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const artefactNode = page.locator('.defn-outline-node').filter({ hasText: 'Solution on a Page' }).first()
      await artefactNode.click()
      await page.getByRole('button', { name: 'Edit template' }).click()
      await page.waitForSelector('.defn-template-editor .cm-content', { timeout: 10_000 })
      const initialSource = await page.locator('.defn-template-editor .cm-content').innerText()
      assert.ok(initialSource.length > 0, 'should load the current template source')

      await page.locator('.defn-template-editor .cm-content').click()
      await page.keyboard.press('Control+A')
      const newSource = 'Hello template ' + Date.now()
      await page.keyboard.type(newSource)
      await page.getByRole('button', { name: 'Save template', exact: true }).click()
      const saved = page.locator('.defn-template-saved')
      await saved.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await saved.textContent(), /Saved/)

      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.waitForTimeout(150)
      await artefactNode.click()
      await page.getByRole('button', { name: 'Edit template' }).click()
      await page.waitForSelector('.defn-template-editor .cm-content', { timeout: 10_000 })
      const reopened = await page.locator('.defn-template-editor .cm-content').innerText()
      assert.equal(reopened, newSource)
    })
  })
})

test('A published version has no template editing controls', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('1')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      assert.equal(await page.getByRole('button', { name: 'Edit template' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Save template' }).count(), 0)

      const artefactNode = page.locator('.defn-outline-node').filter({ hasText: 'Solution on a Page' }).first()
      await artefactNode.click()
      await page.getByRole('button', { name: 'View template' }).click()
      await page.waitForSelector('.defn-template-editor .cm-content', { timeout: 10_000 })
      assert.equal(await page.getByRole('button', { name: 'Save template' }).count(), 0)
    })
  })
})

test('Leaving a dirty draft asks Save / Discard / Cancel', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const moduleRow = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await moduleRow.click()
      const purposeField = page.locator('.defn-focus-row textarea').first()
      await purposeField.waitFor({ state: 'visible', timeout: 5000 })
      await purposeField.fill('a dirty edit')
      assert.match(await page.locator('.defn-toolbar').textContent(), /Unsaved changes/)

      // Cancel: guard shows, choosing Cancel aborts the navigation and keeps the edit
      await page.locator('#defn-version-select').selectOption('1')
      const guard = page.locator('.defn-leave-guard')
      await guard.waitFor({ state: 'visible', timeout: 5000 })
      await guard.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.waitForTimeout(200)
      assert.equal(await page.locator('#defn-version-select').inputValue(), '2', 'Cancel should keep the version selection unchanged')
      assert.equal(await purposeField.inputValue(), 'a dirty edit', 'Cancel should keep the unsaved edit')

      // Discard: guard shows again, choosing Discard drops the edit and completes the navigation
      await page.locator('#defn-version-select').selectOption('1')
      await guard.waitFor({ state: 'visible', timeout: 5000 })
      await guard.getByRole('button', { name: 'Discard', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#defn-version-select')?.value === '1', { timeout: 5000 })

      // Save: dirty again, choosing Save persists then completes the navigation
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const moduleRow2 = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await moduleRow2.click()
      const purposeField2 = page.locator('.defn-focus-row textarea').first()
      await purposeField2.waitFor({ state: 'visible', timeout: 5000 })
      await purposeField2.fill('a saved-on-leave edit')
      await page.locator('#defn-version-select').selectOption('1')
      await guard.waitFor({ state: 'visible', timeout: 5000 })
      await guard.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#defn-version-select')?.value === '1', { timeout: 10_000 })

      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      const moduleRow3 = page.locator('.defn-outline-group').nth(2).locator('.defn-outline-node').first()
      await moduleRow3.click()
      const purposeField3 = page.locator('.defn-focus-row textarea').first()
      await purposeField3.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await purposeField3.inputValue(), 'a saved-on-leave edit')
    })
  })
})

test('New definition: Blank creates and selects an empty draft', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
      await openSwitcher(page)
      await page.getByRole('button', { name: '+ New definition…' }).click()
      await page.locator('#defn-newdef-blank-id').fill('brand-new-def')
      await page.locator('#defn-newdef-blank-title').fill('Brand New Def')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Brand New Def', { timeout: 10_000 })
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      assert.equal(await page.locator('.defn-outline-node').count(), 0, 'a blank definition should start with no elements')
    })
  })
})

test('New definition: Clone current creates a copy selectable from the switcher', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
      await openSwitcher(page)
      await page.getByRole('button', { name: '+ New definition…' }).click()
      await page.getByRole('button', { name: 'Clone current', exact: true }).click()
      await page.locator('#defn-newdef-clone-id').fill('design-clone')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defn-id')?.textContent === 'design-clone', { timeout: 10_000 })
      await page.waitForSelector('.defn-outline-node', { timeout: 10_000 })
      assert.ok(await page.locator('.defn-outline-node').count() > 0, 'a clone should carry over the source definition\'s elements')
    })
  })
})

test('The "+" on each outline group creates a brand-new stage, artefact and module', async () => {
  await withDraftDesignV2()(async (base) => {
    await withPage(base, async (page) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
      await page.locator('#defn-version-select').selectOption('2')
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })

      const stagesGroup = page.locator('.defn-outline-group').nth(0)
      const beforeStages = await stagesGroup.locator('.defn-outline-node').count()
      await stagesGroup.getByRole('button', { name: 'Add stage' }).click()
      await page.waitForFunction((n) => document.querySelectorAll('.defn-outline-group')[0].querySelectorAll('.defn-outline-node').length === n, beforeStages + 1, { timeout: 5000 })
      assert.equal(await page.locator('.defn-focus .kicker').first().textContent(), 'Stage', 'the new stage should be focused')

      const artefactsGroup = page.locator('.defn-outline-group').nth(1)
      const beforeArtefacts = await artefactsGroup.locator('.defn-outline-node').count()
      await artefactsGroup.getByRole('button', { name: 'Add artefact' }).click()
      await page.waitForFunction((n) => document.querySelectorAll('.defn-outline-group')[1].querySelectorAll('.defn-outline-node').length === n, beforeArtefacts + 1, { timeout: 5000 })
      assert.equal(await page.locator('.defn-focus .kicker').first().textContent(), 'Artefact')

      const modulesGroup = page.locator('.defn-outline-group').nth(2)
      const beforeModules = await modulesGroup.locator('.defn-outline-node').count()
      await modulesGroup.getByRole('button', { name: 'Add module' }).click()
      await page.waitForFunction((n) => document.querySelectorAll('.defn-outline-group')[2].querySelectorAll('.defn-outline-node').length === n, beforeModules + 1, { timeout: 5000 })
      assert.equal(await page.locator('.defn-focus .kicker').first().textContent(), 'Module')
    })
  })
})
