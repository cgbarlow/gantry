import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Coverage for #374 — the Visual view (docs/adr/0033): a Word/Loop-style editing surface drawn over
// the same markdown text. Every assertion here is about what the author sees or what lands on disk,
// never about how the decoration layer is built. The table engine's own byte-level behaviour is
// covered under node --test in tests/markdownCommands.test.js.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'

async function withEditor(fn, { beforeLoad } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })
        if (beforeLoad) await beforeLoad(page, base)
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        await fn({ page, base, pageErrors, instancesDir })
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

async function chooseMode(page, label) {
  await page.locator('.view-mode-dropdown').getByRole('button', { name: /^Mode/ }).click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}

// The raw text of a Markdown-view editor, line by line.
const sourceText = (editor) =>
  editor.locator('.cm-content').evaluate((el) => [...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n'))

async function eventually(fn, timeout = 5000) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeout) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastErr
}

const activeCell = (page) =>
  page.evaluate(() => {
    const el = document.activeElement
    return el?.dataset?.row === undefined ? null : `${el.dataset.row},${el.dataset.col}`
  })

// Seeds the first field of "Background and context" with a known table in Markdown view, then
// returns to Visual. Row 2 is the first body row.
const SEED = 'Lead-in.\n\n| Name | Role | Team |\n| --- | :-: | --- |\n| Ana  | Lead | Core |\n| Ben | Dev | Edge |\n| Cy | QA | Core |\n\nAfter.'

async function seedTable(page) {
  const field = page.locator('.module').first().locator('.field-markdown').first()
  await chooseMode(page, 'Markdown')
  await field.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(SEED)
  await chooseMode(page, 'Visual')
  await field.locator('.vgrid-wrap').waitFor({ timeout: 5_000 })
  return field
}

async function saveBackground(page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Saved', { timeout: 5_000 })
}

const backgroundProblem = (instancesDir) =>
  readModule(loadDefinition('design'), 'examples', 'background', { instancesDir: join(instancesDir, 'default') }).fields.problem

test('Visual is the default view; the Mode dropdown and hotkey run Visual → Split → Markdown (#374)', async () => {
  await withEditor(async ({ page, pageErrors }) => {
    const main = page.locator('#modules')
    assert.equal(await main.getAttribute('data-view-mode'), 'visual')
    const trigger = page.locator('.view-mode-dropdown').getByRole('button', { name: /^Mode/ })
    assert.equal((await trigger.textContent()).trim(), 'Visual ▾')
    await trigger.click()
    assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['Visual', 'Split', 'Markdown'])
    assert.equal(await page.getByRole('menuitemradio', { name: 'Visual' }).getAttribute('aria-checked'), 'true')
    await page.getByRole('menuitemradio', { name: 'Split' }).click()
    assert.equal(await main.getAttribute('data-view-mode'), 'split')
    assert.equal((await trigger.textContent()).trim(), 'Split ▾')

    const field = page.locator('.field-markdown').first()
    assert.equal(await field.locator('.cm-editor').count(), 2, 'Split shows source and Visual side by side')
    await page.keyboard.press('Control+Shift+V')
    assert.equal(await main.getAttribute('data-view-mode'), 'markdown')
    assert.equal(await field.locator('.cm-editor').count(), 1)
    assert.equal(await field.locator('.cm-visual').count(), 0, 'Markdown is the bare text')
    await page.keyboard.press('Control+Shift+V')
    assert.equal(await main.getAttribute('data-view-mode'), 'visual')
    assert.equal(await field.locator('.cm-visual').count(), 1)
    assert.deepEqual(pageErrors, [])
  })
})

// Saves the whole stage with the toolbar's Save (WI #376) and waits for it to confirm.
async function saveAllModules(page) {
  const save = page.locator('.toolbar .stage-save-btn')
  if (await save.isDisabled()) return
  await save.click()
  await page.locator('.stage-save-state', { hasText: 'Saved' }).waitFor({ timeout: 5_000 })
}

async function visitStage(page, i) {
  await page.locator('#stage-nav button').nth(i).click()
  await page.waitForSelector('.module', { timeout: 10_000 })
  await page.waitForTimeout(300)
}

test('opening every stage in all three views, clicking into tables and saving leaves every module file byte-identical (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const modulesDir = join(instancesDir, 'default', 'examples', 'modules')
    const stages = await page.locator('#stage-nav button').count()
    assert.ok(stages > 1)

    // Baseline: one save of everything from Markdown view — the raw text, no Visual layer — so the
    // snapshot already carries the module writer's own first-save tidying (front matter spacing),
    // which predates Visual view and is not what this test is about.
    await chooseMode(page, 'Markdown')
    for (let i = 0; i < stages; i++) {
      await visitStage(page, i)
      await saveAllModules(page)
    }
    const before = Object.fromEntries(readdirSync(modulesDir).map((f) => [f, readFileSync(join(modulesDir, f))]))

    let gridsVisited = 0
    for (let i = 0; i < stages; i++) {
      await visitStage(page, i)
      for (const mode of ['Visual', 'Split', 'Markdown', 'Visual']) await chooseMode(page, mode)
      const grids = page.locator('.vgrid-wrap')
      const count = await grids.count()
      for (let g = 0; g < count; g++) {
        const cell = grids.nth(g).locator('.vgrid-body [data-row]').first()
        await cell.scrollIntoViewIfNeeded()
        await cell.click()
        await grids.nth(g).locator('.vgrid-handle').first().hover()
        gridsVisited++
      }
      await saveAllModules(page)
    }
    assert.ok(gridsVisited > 0, 'the examples must exercise at least one table')
    for (const [file, bytes] of Object.entries(before)) {
      assert.ok(readFileSync(join(modulesDir, file)).equals(bytes), `${file} changed on a save without edits`)
    }
    assert.deepEqual(pageErrors, [])
  })
})

test('typing in a cell changes exactly that line, keeps the caret, and one Undo takes the word back (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = await seedTable(page)
    const grid = field.locator('.vgrid-wrap')
    assert.deepEqual(await grid.locator('.vgrid-header .vgrid-cell').allTextContents(), ['Name', 'Role', 'Team'])
    assert.equal(await grid.locator('.vgrid-body tr, tr.vgrid-body').count(), 3)

    // Clicking a cell's padding (not its text) still edits that cell, and the cell outlines.
    const cell = grid.locator('tr[data-r="3"] .vgrid-cell').nth(1)
    const box = await cell.boundingBox()
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 3)
    assert.equal(await activeCell(page), '3,1')
    assert.equal(await cell.evaluate((el) => getComputedStyle(el).outlineStyle), 'solid')

    await page.keyboard.type(' ops')
    assert.equal(await activeCell(page), '3,1', 'the caret stays in the cell while typing')
    assert.equal(await cell.textContent(), 'Dev ops')

    await chooseMode(page, 'Markdown')
    const lines = (await sourceText(field)).split('\n')
    const seedLines = SEED.split('\n')
    const changed = lines.filter((line, i) => line !== seedLines[i])
    assert.deepEqual(changed, ['| Ben | Dev ops | Edge |'], 'only the edited row differs, and the other rows keep their padding')

    await field.locator('.cm-line', { hasText: 'After.' }).click()
    await field.locator('.md-toolbar').getByRole('button', { name: 'Undo', exact: true }).click()
    await eventually(async () => assert.equal(await sourceText(field), SEED))
    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
  })
})

test('Tab and Shift-Tab walk the cells, Tab off the end adds a row, Enter never splits one (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = await seedTable(page)
    const grid = field.locator('.vgrid-wrap')
    await grid.locator('[data-row="4"][data-col="1"]').click()
    await page.keyboard.press('Tab')
    assert.equal(await activeCell(page), '4,2')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await activeCell(page), '4,0')
    await page.keyboard.press('Enter')
    assert.equal(await grid.locator('[data-row="4"][data-col="0"]').textContent(), 'Cy')

    // Keys stay in the cell: select-all takes the cell's text, and Ctrl+B bolds it.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+b')
    await eventually(async () => assert.equal(await grid.locator('[data-row="4"][data-col="0"]').textContent(), '**Cy**'))
    assert.equal(await activeCell(page), '4,0', 'the author stays in the cell')
    await page.keyboard.press('ControlOrMeta+z')
    await eventually(async () => assert.equal(await grid.locator('[data-row="4"][data-col="0"]').textContent(), 'Cy'))
    // The screen's view hotkey still works from inside a cell.
    await page.keyboard.press('Control+Shift+V')
    assert.equal(await page.locator('#modules').getAttribute('data-view-mode'), 'split')
    await chooseMode(page, 'Visual')
    await grid.locator('[data-row="4"][data-col="2"]').click()
    await page.keyboard.press('Tab')
    await eventually(async () => assert.equal(await activeCell(page), '5,0'))
    await page.keyboard.type('Di')
    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    assert.match(backgroundProblem(instancesDir), /\| Cy \| QA \| Core \|\n\| Di \|\s+\|\s+\|\n\nAfter\.$/)
  })
})

test('column handles appear on the top edge, open a menu, and drag to move a column (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = await seedTable(page)
    const grid = field.locator('.vgrid-wrap')
    const handles = grid.locator('.vgrid-colh .vgrid-handle')
    const opacity = (loc) => loc.evaluate((el) => Number(getComputedStyle(el).opacity))

    const box = await grid.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4)
    await eventually(async () => assert.equal(await opacity(handles.first()), 0, 'hidden away from the top edge'))
    await page.mouse.move(box.x + box.width / 2, box.y + 6)
    await eventually(async () => assert.equal(await opacity(handles.first()), 1, 'shown at the top edge'))

    // A press that barely moves is a click: the column highlights and its menu opens.
    const second = await handles.nth(1).boundingBox()
    await page.mouse.move(second.x + second.width / 2, second.y + 5)
    await page.mouse.down()
    await page.mouse.move(second.x + second.width / 2 + 2, second.y + 5)
    await page.mouse.up()
    const menu = page.locator('.vgrid-menu')
    await menu.waitFor({ timeout: 5_000 })
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [
      'Insert column left',
      'Insert column right',
      'Cycle alignment (now centre)',
      'Delete column',
    ])
    assert.equal(await grid.locator('.vgrid-cell.selected').count(), 4, 'the whole Role column highlights')

    await menu.getByRole('menuitem', { name: 'Insert column right' }).click()
    await eventually(async () => assert.equal(await grid.locator('.vgrid-colh').count(), 4))

    // Delete it again from its own menu.
    await page.mouse.move(box.x + box.width / 2, box.y + 6)
    await grid.locator('.vgrid-colh .vgrid-handle').nth(2).click()
    await page.locator('.vgrid-menu').getByRole('menuitem', { name: 'Delete column' }).click()
    await eventually(async () => assert.equal(await grid.locator('.vgrid-colh').count(), 3))

    // A real drag: "Team" onto the first column, with the drop target shown on the way.
    await page.mouse.move(box.x + box.width / 2, box.y + 6)
    const from = await grid.locator('.vgrid-colh .vgrid-handle').nth(2).boundingBox()
    const to = await grid.locator('.vgrid-colh').nth(0).boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + 5)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + 5, { steps: 8 })
    assert.equal(await grid.locator('.vgrid-colh.drop').count(), 1)
    await page.mouse.up()
    await eventually(async () =>
      assert.deepEqual(await field.locator('.vgrid-header .vgrid-cell').allTextContents(), ['Team', 'Name', 'Role'])
    )

    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    assert.equal(
      backgroundProblem(instancesDir),
      'Lead-in.\n\n| Team | Name | Role |\n| --- | --- | :-: |\n| Core | Ana  | Lead |\n| Edge | Ben | Dev |\n| Core | Cy | QA |\n\nAfter.'
    )
  })
})

test('row handles insert, delete and drag body rows; the header row does not drag (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = await seedTable(page)
    const grid = field.locator('.vgrid-wrap')
    const box = await grid.boundingBox()
    const showRows = () => page.mouse.move(box.x + 8, box.y + box.height / 2)
    const rowHandle = (r) => grid.locator(`tr[data-r="${r}"] .vgrid-rowh .vgrid-handle`)

    await showRows()
    await rowHandle(0).click()
    const menu = page.locator('.vgrid-menu')
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [
      'Insert row below',
      'Delete header row (the next row becomes the header)',
    ])
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.equal(await grid.locator('.vgrid-cell.selected').count(), 0, 'Escape clears the selection')

    // Dragging the header does nothing but open its menu.
    await showRows()
    const header = await rowHandle(0).boundingBox()
    const lastRow = await rowHandle(4).boundingBox()
    await page.mouse.move(header.x + 5, header.y + header.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastRow.x + 5, lastRow.y + lastRow.height / 2, { steps: 8 })
    await page.mouse.up()
    assert.deepEqual(await grid.locator('.vgrid-header .vgrid-cell').allTextContents(), ['Name', 'Role', 'Team'])
    await page.keyboard.press('Escape')

    // Insert below Ben, then delete that new row again.
    await showRows()
    await rowHandle(3).click()
    await page.locator('.vgrid-menu').getByRole('menuitem', { name: 'Insert row below' }).click()
    await eventually(async () => assert.equal(await grid.locator('tr.vgrid-body').count(), 4))
    await showRows()
    await rowHandle(4).click()
    await page.locator('.vgrid-menu').getByRole('menuitem', { name: 'Delete row' }).click()
    await eventually(async () => assert.equal(await grid.locator('tr.vgrid-body').count(), 3))

    // Drag Cy above Ana.
    await showRows()
    const cy = await rowHandle(4).boundingBox()
    const ana = await rowHandle(2).boundingBox()
    await page.mouse.move(cy.x + 5, cy.y + cy.height / 2)
    await page.mouse.down()
    await page.mouse.move(ana.x + 5, ana.y + ana.height / 2, { steps: 8 })
    await page.mouse.up()
    await eventually(async () =>
      assert.deepEqual(await grid.locator('tr.vgrid-body .vgrid-cell:nth-child(2)').allTextContents(), ['Cy', 'Ana', 'Ben'])
    )

    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    // A moved row is the same line in a new place — every line is byte-identical to the seed.
    const saved = backgroundProblem(instancesDir)
    assert.deepEqual(saved.split('\n').sort(), SEED.split('\n').sort())
    assert.match(saved, /\| :-: \| --- \|\n\| Cy \| QA \| Core \|\n\| Ana  \| Lead \| Core \|/)
  })
})

test('the corner selects the whole table; deleting it can be undone from Markdown view and redone (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = await seedTable(page)
    const grid = field.locator('.vgrid-wrap')
    const box = await grid.boundingBox()
    await page.mouse.move(box.x + 8, box.y + 6)
    await grid.locator('.vgrid-corner .vgrid-handle').click()
    assert.equal(await grid.evaluate((el) => el.classList.contains('sel-all')), true)
    assert.equal(await grid.locator('.vgrid-cell.selected').count(), 0)
    await page.locator('.vgrid-menu').getByRole('menuitem', { name: 'Delete table' }).click()
    await eventually(async () => assert.equal(await field.locator('.vgrid-wrap').count(), 0))

    await chooseMode(page, 'Markdown')
    assert.equal(await sourceText(field), 'Lead-in.\n\nAfter.')
    await field.locator('.cm-content').click()
    const toolbar = field.locator('.md-toolbar')
    await toolbar.getByRole('button', { name: 'Undo', exact: true }).click()
    await eventually(async () => assert.equal(await sourceText(field), SEED))
    await toolbar.getByRole('button', { name: 'Redo', exact: true }).click()
    await eventually(async () => assert.equal(await sourceText(field), 'Lead-in.\n\nAfter.'))
    await page.keyboard.press('ControlOrMeta+z')
    await eventually(async () => assert.equal(await sourceText(field), SEED))

    await chooseMode(page, 'Visual')
    await field.locator('.vgrid-wrap').waitFor({ timeout: 5_000 })
    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    assert.equal(backgroundProblem(instancesDir), SEED)
  })
})

test('the toolbar Table picker lands the author in the new grid; a ragged pipe run gets no grid (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = page.locator('.module').first().locator('.field-markdown').first()
    await chooseMode(page, 'Markdown')
    await field.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText('| a | b |\n| - |\n| c |\n\nEnd.')
    await chooseMode(page, 'Visual')
    assert.equal(await field.locator('.vgrid-wrap').count(), 0, 'a malformed run stays plain text')
    assert.equal(await field.locator('.vgrid-handle').count(), 0)

    await field.locator('.cm-line', { hasText: 'End.' }).click()
    await page.keyboard.press('End')
    await field.locator('.md-toolbar').getByRole('button', { name: 'Table', exact: true }).click()
    await field.locator('.table-picker-grid [data-row="2"][data-col="2"]').click()
    await eventually(async () => assert.equal(await activeCell(page), '2,0'))
    // Visual and Split have no contextual strip — the grid's handles replace it.
    assert.equal(await field.locator('.table-toolbar').count(), 0)
    await page.keyboard.type('first')

    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    assert.equal(
      backgroundProblem(instancesDir),
      '| a | b |\n| - |\n| c |\n\nEnd.\n\n| Header 1 | Header 2 |\n| -------- | -------- |\n| first |          |'
    )
  })
})

test('Split: one toolbar row acts on the pane in use, edits reach the other pane, one undo timeline (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    const field = await seedTable(page)
    await chooseMode(page, 'Split')
    const source = field.locator('.editor-pane')
    const visual = field.locator('.visual-pane')

    // An edit in a Visual cell reaches the source.
    await visual.locator('[data-row="2"][data-col="0"]').click()
    await page.keyboard.type('-Maria')
    await eventually(async () => assert.match(await sourceText(source), /\| Ana-Maria \| Lead \| Core \|/))
    assert.equal(await field.locator('.md-toolbar').count(), 1, 'a single row of formatting controls')

    // An edit in the source reaches the Visual pane.
    await source.locator('.cm-line', { hasText: 'After.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Done')
    await eventually(async () => assert.ok((await visual.locator('.cm-content').textContent()).includes('After. Done')))

    // The toolbar acts on the pane in use: Bold in the Visual pane's cell wraps that cell's selection.
    const cell = visual.locator('[data-row="4"][data-col="1"]')
    await cell.click()
    await page.keyboard.press('ControlOrMeta+a')
    await field.locator('.md-toolbar').getByRole('button', { name: 'Bold', exact: true }).click()
    await eventually(async () => assert.match(await sourceText(source), /\| Cy \| \*\*QA\*\* \| Core \|/))

    // One history: undo from the Visual pane walks back the source-pane edit too.
    for (let i = 0; i < 3; i++) {
      await field.locator('.md-toolbar').getByRole('button', { name: 'Undo', exact: true }).click()
    }
    await eventually(async () => assert.equal(await sourceText(source), SEED))
    await eventually(async () => assert.equal(await visual.locator('[data-row="2"][data-col="0"]').textContent(), 'Ana'))

    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    assert.equal(backgroundProblem(instancesDir), SEED)
  })
})

test('the pane being edited is unmistakable: a thick focus frame, and in Split the other pane recedes (#374)', async () => {
  await withEditor(async ({ page, pageErrors }) => {
    const field = await seedTable(page)
    const frame = (loc) =>
      loc.evaluate((el) => {
        const s = getComputedStyle(el)
        return { shadow: s.boxShadow, opacity: Number(s.opacity) }
      })
    const framed = (f) => f.shadow !== 'none' && /2px/.test(f.shadow)

    // Visual: clicking into the text frames the editor. Seeding the table can leave focus in the
    // field (a grid cell may take it), so start from nothing focused.
    const host = field.locator('.editor-pane .editor-host')
    await page.evaluate(() => document.activeElement?.blur())
    await eventually(async () => assert.equal(framed(await frame(host)), false, 'no frame while the field is not in use'))
    await field.locator('.cm-line', { hasText: 'After.' }).click()
    await eventually(async () => assert.equal(framed(await frame(host)), true))

    await chooseMode(page, 'Split')
    const source = field.locator('.editor-pane .editor-host')
    const visual = field.locator('.visual-pane .editor-host')

    // Editing the source: the source is framed, the Visual pane recedes.
    await source.locator('.cm-line', { hasText: 'After.' }).click()
    await eventually(async () => {
      const [s, v] = [await frame(source), await frame(visual)]
      assert.equal(framed(s), true, 'source pane framed')
      assert.equal(framed(v), false, 'Visual pane not framed')
      assert.ok(v.opacity < 1 && s.opacity === 1, 'the pane not being edited recedes')
    })

    // A Visual table cell counts as editing the Visual pane.
    await visual.locator('[data-row="2"][data-col="0"]').click()
    await eventually(async () => {
      const [s, v] = [await frame(source), await frame(visual)]
      assert.equal(framed(v), true, 'Visual pane framed while a cell is being edited')
      assert.equal(framed(s), false)
      assert.ok(s.opacity < 1 && v.opacity === 1)
    })

    // Leaving the field clears both.
    await page.locator('header h1').click()
    await eventually(async () => {
      const [s, v] = [await frame(source), await frame(visual)]
      assert.equal(framed(s) || framed(v), false)
      assert.equal(s.opacity, 1)
      assert.equal(v.opacity, 1)
    })
    assert.deepEqual(pageErrors, [])
  })
})

test('images and Mermaid diagrams draw in Visual; the Source line is never stored; the pop-over edits only the diagram text (#374)', async () => {
  await withEditor(async ({ page, pageErrors, instancesDir }) => {
    // The example's own asset references draw as images with their automatic citation.
    const image = page.locator('.cm-visual-image img.asset-thumb').first()
    await image.waitFor({ timeout: 10_000 })
    await page.locator('.cm-visual-image p.asset-source').first().waitFor({ timeout: 10_000 })
    // In Visual an image fills the text width, as it will in the .docx (#148), not the 260px thumbnail cap.
    await eventually(async () => assert.ok((await image.boundingBox()).width > 260, 'Visual image wider than the thumbnail cap'))

    const field = page.locator('.module').first().locator('.field-markdown').first()
    const fence = 'Intro.\n\n```mermaid\nflowchart LR\n  Author --> Gantry\n```\n\nOutro.'
    await chooseMode(page, 'Markdown')
    await field.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(fence)
    await chooseMode(page, 'Visual')
    const diagram = field.locator('.cm-visual-mermaid')
    await diagram.locator('figure.mermaid-diagram svg').waitFor({ timeout: 30_000 })

    await diagram.getByRole('button', { name: 'Edit diagram text' }).click()
    const pop = page.locator('.vgrid-popover')
    const textarea = pop.locator('textarea')
    assert.equal(await textarea.inputValue(), 'flowchart LR\n  Author --> Gantry')
    await textarea.fill('flowchart LR\n  Author --> Gantry --> Artefact')
    await pop.getByRole('button', { name: 'Apply' }).click()
    await eventually(async () => assert.match(await diagram.innerHTML(), /Artefact/), 30_000)

    await saveBackground(page)
    assert.deepEqual(pageErrors, [])
    assert.equal(backgroundProblem(instancesDir), fence.replace('Gantry\n', 'Gantry --> Artefact\n'))
    const onDisk = readdirSync(join(instancesDir, 'default', 'examples', 'modules'))
      .map((f) => readFileSync(join(instancesDir, 'default', 'examples', 'modules', f), 'utf8'))
      .join('\n')
    assert.doesNotMatch(onDisk, /Source: /, 'the drawn citation is never written to the markdown')
  })
})

test('an archived instance is read-only in Visual view: no toolbar, no editable cells, no handles (#374)', async () => {
  await withEditor(
    async ({ page, pageErrors }) => {
      await page.waitForSelector('.archived-banner', { timeout: 10_000 })
      const grid = page.locator('.vgrid-wrap').first()
      await grid.waitFor({ timeout: 10_000 })
      assert.equal(await grid.locator('.vgrid-handle').count(), 0)
      assert.equal(await grid.locator('[contenteditable]').count(), 0)
      const field = page.locator('.field-markdown').first()
      const before = await field.locator('.cm-content').textContent()
      await field.locator('.cm-content').click()
      await page.keyboard.type('nope')
      assert.equal(await field.locator('.cm-content').textContent(), before)
      assert.equal(await page.locator('.md-toolbar').count(), 0)
      assert.equal(await page.locator('.insert-bar:visible').count(), 0)
      assert.equal(await page.locator('.stage-save-btn').count(), 0)
      assert.deepEqual(pageErrors, [])
    },
    {
      beforeLoad: async (page, base) => {
        const res = await page.request.post(`${base}/api/instance/archive`, { data: { slug: 'examples' } })
        assert.equal(res.status(), 200)
      },
    }
  )
})

test('a horizontal rule shows as a rule in Visual view, and as --- on the caret\'s own line (#376)', async () => {
  await withEditor(async ({ page, pageErrors }) => {
    const field = page.locator('.module').first().locator('.field-markdown').first()
    await chooseMode(page, 'Markdown')
    await field.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText('Above.\n\n---\n\nBelow.')
    await chooseMode(page, 'Visual')
    await field.locator('.cm-line', { hasText: 'Below.' }).click()
    await field.locator('.cm-visual-hr').waitFor({ timeout: 5_000 })
    assert.doesNotMatch(await field.locator('.cm-content').textContent(), /---/)

    await field.locator('.cm-line', { hasText: 'Above.' }).click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await eventually(async () => assert.match(await field.locator('.cm-content').textContent(), /---/))
    assert.equal(await field.locator('.cm-visual-hr').count(), 0)
    assert.deepEqual(pageErrors, [])
  })
})
