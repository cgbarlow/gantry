import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { designV3Examples } from './helpers/designExamples.js'

// #362: "Move to v<N>" in Instance Settings, in the browser: under the Version row of a design v3 Instance, "v4 is available" and
// Move to v4…, a dialog listing References as removed with v4's CHANGELOG section, and the move itself — on a server-hosted
// workspace (the server writes it, tests/definitionVersionMoveServer.test.js) and on a Local workspace (this browser writes the
// folder, through web/lib/definitionMoveView.js). The Instance is the Kiwi Cover Mutual example as it was on v3
// (tests/helpers/designExamples.js); after the move its files are the bundled v4 example's.

const SLUG = 'kiwi-cover-mutual'
const MODULE = 'modules/team-and-estimates.md'
const V4_EXAMPLE = join('workspaces', 'examples', SLUG)
const V3_EXAMPLE = () => join(designV3Examples(), SLUG)

async function withV3Server(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-362-browser-'))
  try {
    cpSync(V3_EXAMPLE(), join(instancesDir, SLUG), { recursive: true })
    await withRunningServer({ instancesDir, migrateWorkspacesOnStart: false }, (base) => fn({ base, dir: join(instancesDir, SLUG) }))
  } finally {
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
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

const versionRow = (page) => page.locator('.result-row').filter({ has: page.locator('.k', { hasText: /^Version$/ }) })

async function openDialog(page) {
  const row = page.getByTestId('definition-move')
  await row.waitFor({ timeout: 15_000 })
  assert.match(await row.textContent(), /v4 is available/)
  await row.getByRole('button', { name: 'Move to v4…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move to v4' })
  await dialog.waitFor()
  assert.match(await dialog.textContent(), /This Instance is on design v3/)
  const removed = dialog.getByTestId('definition-move-removed')
  assert.deepEqual(await removed.locator('li').allTextContents(), ['References (Teams, contact persons, and high-level estimates)'])
  assert.equal(await dialog.getByTestId('definition-move-added').count(), 0, 'v4 adds and requires nothing new')
  await dialog.locator('summary', { hasText: 'What changed in v4' }).click()
  assert.match(await dialog.locator('.definition-move-changelog').textContent(), /References is gone/)
  return dialog
}

test('a server-hosted design v3 Instance moves to v4 from its Settings: the dialog lists References as removed, and after the move it is on v4', () =>
  withV3Server(async ({ base, dir }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/settings/instance?slug=${SLUG}`)
      await versionRow(page).waitFor({ timeout: 15_000 })
      assert.equal(await versionRow(page).locator('.v').textContent(), 'v3')
      const dialog = await openDialog(page)
      assert.match(await dialog.textContent(), /one save/)
      await dialog.getByRole('button', { name: 'Move to v4', exact: true }).click()
      await page.getByTestId('definition-move-status').getByText('Moved to v4.').waitFor({ timeout: 15_000 })
      assert.equal(await dialog.count(), 0, 'the dialog closes')
      assert.equal(await versionRow(page).locator('.v').textContent(), 'v4')
      assert.equal(await page.getByTestId('definition-move').count(), 0, 'nothing more to move to')
      assert.equal(readFileSync(join(dir, MODULE), 'utf8'), readFileSync(join(V4_EXAMPLE, MODULE), 'utf8'))
      assert.equal(parseYAML(readFileSync(join(dir, 'instance.yaml'), 'utf8')).definitionVersion, 4)
      assert.deepEqual(pageErrors, [])
    })
  }))

test('a failed move keeps the dialog open with the reason, and a Stage awaiting approval shows why the move waits', () =>
  withV3Server(async ({ base, dir }) => {
    await withPage(async (page) => {
      const before = readFileSync(join(dir, MODULE), 'utf8')
      await page.route('**/api/instance/definition-move**', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Nothing was changed: the move to v4 could not be written (the disk is full). Try again.' }) })
          : route.continue()
      )
      await page.goto(`${base}/settings/instance?slug=${SLUG}`)
      const dialog = await openDialog(page)
      await dialog.getByRole('button', { name: 'Move to v4', exact: true }).click()
      await dialog.getByRole('alert').getByText(/the disk is full/).waitFor()
      assert.equal(await dialog.getByRole('button', { name: 'Move to v4', exact: true }).isEnabled(), true, 'it can be tried again')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      assert.equal(await versionRow(page).locator('.v').textContent(), 'v3')
      assert.equal(readFileSync(join(dir, MODULE), 'utf8'), before)

      // The Provider's answer for a Stage awaiting approval: the move is offered, its button off, with the sentence.
      await page.unroute('**/api/instance/definition-move**')
      const blocked = 'SOAP is awaiting approval, so this Instance can\'t move to v4 yet: the move would change content its Pull Request asks the Owner to approve. Move it once the Pull Request is approved or closed.'
      await page.route('**/api/instance/definition-move**', async (route) => {
        const res = await route.fetch()
        await route.fulfill({ response: res, json: { ...(await res.json()), blocked } })
      })
      await page.reload()
      await page.getByTestId('definition-move-blocked').waitFor({ timeout: 15_000 })
      assert.equal(await page.getByTestId('definition-move-blocked').textContent(), blocked)
      assert.equal(await page.getByRole('button', { name: 'Move to v4…' }).isDisabled(), true)
    })
  }))

test('a Local workspace\'s design v3 Instance moves to v4 in its own folder', () =>
  withV3Server(async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const source = V3_EXAMPLE()
      const files = {}
      for (const path of ['instance.yaml', MODULE, 'modules/background.md', 'interview/shape.yaml']) {
        files[`gantry-workspace/${SLUG}/${path}`] = readFileSync(join(source, path), 'utf8')
      }
      const workspaceId = await page.evaluate(async (files) => {
        const { rememberWorkspace, writeTextFile } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-362-' + Date.now(), { create: true })
        for (const [path, text] of Object.entries(files)) await writeTextFile(dir, path, text)
        window.__moveFolder = dir.name
        return rememberWorkspace({ handle: dir, name: 'Move E2E Workspace' })
      }, files)
      const folderName = await page.evaluate(() => window.__moveFolder)
      const readLocal = (path) =>
        page.evaluate(
          async ({ folderName, path }) => {
            const { readTextFile } = await import('/lib/localWorkspace.js')
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName)
            return readTextFile(dir, path)
          },
          { folderName, path }
        )

      await page.goto(`${base}/settings/instance?slug=${SLUG}&local=${encodeURIComponent(workspaceId)}`)
      const dialog = await openDialog(page)
      assert.match(await dialog.textContent(), /in this workspace's folder/)
      await dialog.getByRole('button', { name: 'Move to v4', exact: true }).click()
      await page.getByTestId('definition-move-status').getByText('Moved to v4.').waitFor({ timeout: 15_000 })
      assert.equal(await versionRow(page).locator('.v').textContent(), 'v4')

      assert.equal(await readLocal(`gantry-workspace/${SLUG}/${MODULE}`), readFileSync(join(V4_EXAMPLE, MODULE), 'utf8'))
      assert.equal(await readLocal(`gantry-workspace/${SLUG}/instance.yaml`), readFileSync(join(V4_EXAMPLE, 'instance.yaml'), 'utf8'))
      assert.equal(await readLocal(`gantry-workspace/${SLUG}/modules/background.md`), files[`gantry-workspace/${SLUG}/modules/background.md`])
      const log = parseYAML(await readLocal(`gantry-workspace/${SLUG}/interview/shape.yaml`))
      assert.equal(log.entries.at(-1).note, 'Moved from v3 to v4. Removed: References (Teams, contact persons, and high-level estimates).')
      assert.deepEqual(pageErrors, [])
    })
  }))
