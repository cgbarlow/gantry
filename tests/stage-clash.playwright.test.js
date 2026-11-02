import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #270 (ADR-0068): two browsers editing one stage. Different Fields both save and each browser ends
// up showing both; the same Field gets a dialog for that Field where the second saver picks or edits,
// and Cancel writes nothing. The merge rules themselves are covered under node --test in
// tests/stageVersion.test.js, and the server check for every workspace kind in tests/stageClash.test.js.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'

async function withTwoEditors(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const open = async () => {
          const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
          page.setDefaultTimeout(DEFAULT_TIMEOUT)
          await page.goto(`${base}/instance/examples`)
          await page.waitForSelector('.module', { timeout: 10_000 })
          return page
        }
        const a = await open()
        const b = await open()
        const moduleFile = (id) => join(instancesDir, 'default', 'examples', 'modules', `${id}.md`)
        await fn({ a, b, moduleFile })
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

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

// Two Markdown Fields in different Modules: 0 is the Problem statement (background), 1 the Assumptions (design-basis).
const FIELD_TITLES = ['Problem statement', 'Assumptions']
const editorAt = (page, index) =>
  page.locator('.field-markdown', { has: page.locator('h3.field-heading', { hasText: new RegExp(`^${FIELD_TITLES[index]}`) }) }).locator('.cm-content')
const saveButton = (page) => page.locator('.toolbar .stage-save-btn')
const clashDialog = (page) => page.locator('.modal[aria-label="Changes saved meanwhile"]')

async function typeInto(page, index, text) {
  await editorAt(page, index).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

async function saveAndWait(page) {
  await page.keyboard.press('ControlOrMeta+s')
}

async function expectClean(page) {
  await eventually(async () => {
    assert.equal(await saveButton(page).isDisabled(), true)
    assert.match(await page.locator('.stage-save-state').textContent(), /^(Saved.*)?$/, 'not still saving')
  })
}

test('two browsers editing different Fields both save, neither loses anything, and each ends up showing both', async () => {
  await withTwoEditors(async ({ a, b, moduleFile }) => {
    await typeInto(a, 0, ' Typed in browser A.')
    await typeInto(b, 1, ' Typed in browser B.')

    await saveAndWait(a)
    await expectClean(a)
    await saveAndWait(b)
    await expectClean(b)
    assert.equal(await clashDialog(b).count(), 0, 'different Fields raise no dialog')

    assert.match(readFileSync(moduleFile('background'), 'utf8'), /Typed in browser A\./)
    assert.match(readFileSync(moduleFile('design-basis'), 'utf8'), /Typed in browser B\./)
    // B's editor took A's change in the merge, and kept its own.
    await eventually(async () => assert.match(await editorAt(b, 0).textContent(), /Typed in browser A\./))
    assert.match(await editorAt(b, 1).textContent(), /Typed in browser B\./)
  })
})

test('both changing the same Field gives the second saver a dialog for that Field; Cancel writes nothing, then Keep mine saves it', async () => {
  await withTwoEditors(async ({ a, b, moduleFile }) => {
    await typeInto(a, 0, ' First to save.')
    await saveAndWait(a)
    await expectClean(a)

    await typeInto(b, 0, ' Second to save.')
    await saveAndWait(b)
    const dialog = clashDialog(b)
    await dialog.waitFor({ timeout: 5_000 })
    assert.equal(await dialog.locator('.clash').count(), 1, 'one dialog entry, for the one Field')
    assert.match(await dialog.locator('[data-clash-side="theirs"]').textContent(), /First to save\./)
    assert.match(await dialog.locator('[data-clash-side="mine"]').textContent(), /Second to save\./)
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'nothing is chosen for you')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await clashDialog(b).count(), 0)
    assert.doesNotMatch(readFileSync(moduleFile(await moduleHolding(moduleFile, 'First to save.')), 'utf8'), /Second to save\./, 'Cancel overwrote nothing')
    assert.equal(await saveButton(b).isDisabled(), false, 'B still has its unsaved edit')
    assert.match(await editorAt(b, 0).textContent(), /Second to save\./)

    await saveAndWait(b)
    await clashDialog(b).waitFor()
    await clashDialog(b).getByRole('button', { name: 'Keep mine' }).click()
    await clashDialog(b).getByRole('button', { name: 'Save', exact: true }).click()
    await expectClean(b)
    const holder = await moduleHolding(moduleFile, 'Second to save.')
    assert.doesNotMatch(readFileSync(moduleFile(holder), 'utf8'), /First to save\./)
  })
})

test('Keep theirs takes the saved version into the editor; Edit instead saves the author\'s own wording', async () => {
  await withTwoEditors(async ({ a, b, moduleFile }) => {
    await typeInto(a, 0, ' Theirs.')
    await saveAndWait(a)
    await expectClean(a)

    await typeInto(b, 0, ' Mine.')
    await saveAndWait(b)
    await clashDialog(b).waitFor({ timeout: 5_000 })
    await clashDialog(b).getByRole('button', { name: 'Keep theirs' }).click()
    await clashDialog(b).getByRole('button', { name: 'Save', exact: true }).click()
    await expectClean(b)
    await eventually(async () => {
      const text = await editorAt(b, 0).textContent()
      assert.match(text, /Theirs\./)
      assert.doesNotMatch(text, /Mine\./)
    })
    const holder = await moduleHolding(moduleFile, 'Theirs.')
    assert.doesNotMatch(readFileSync(moduleFile(holder), 'utf8'), /Mine\./)

    // A second round: both edit again, the second author writes their own wording in the dialog.
    await typeInto(a, 0, ' Round two from A.')
    await saveAndWait(a)
    await expectClean(a)
    await typeInto(b, 0, ' Round two from B.')
    await saveAndWait(b)
    await clashDialog(b).waitFor({ timeout: 5_000 })
    await clashDialog(b).getByRole('button', { name: 'Edit instead' }).click()
    const edit = clashDialog(b).locator('textarea.clash-edit')
    await edit.fill('A merged wording from the author.')
    await clashDialog(b).getByRole('button', { name: 'Save', exact: true }).click()
    await expectClean(b)
    const edited = readFileSync(moduleFile(await moduleHolding(moduleFile, 'A merged wording from the author.')), 'utf8')
    assert.doesNotMatch(edited, /Round two from/)
  })
})

// The example's Problem statement lives in `background`, but say so by content rather than by name.
async function moduleHolding(moduleFile, text) {
  for (const id of ['introduction', 'background']) {
    if (readFileSync(moduleFile(id), 'utf8').includes(text)) return id
  }
  return 'background'
}
