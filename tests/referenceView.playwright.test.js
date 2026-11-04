import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer, withRunningServerForProvider, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { serializeDecisionsLog } from '../web/lib/decisionsLog.js'

// #320: the module editor's Sources & decisions toggle, to the right of Navigation. Off (on every page load) shows the Fields and the status
// and action panels; on shows only the Source documents, Review comments and Decisions log under the toolbar. The Fields are hidden, not
// unmounted, so an unsaved edit survives any number of switches. tests/referenceView.test.js covers the count and the disabled rule.

const SLUG = 'my-initiative'
const MARKER = 'Typed while switching to the sources and back'

// Two open questions on the Shape Stage, one of them since closed by an answer, and a third still open: the toggle counts 2.
const LOG = serializeDecisionsLog({
  version: 1,
  stage: 'shape',
  status: [],
  fields: {},
  entries: [
    { id: 'q-1', at: '2026-11-01T10:00:00.000Z', who: 'a.architect', kind: 'open-question', question: 'Who is the executive sponsor?', why: 'The brief does not say.', fields: ['background.problem'] },
    { id: 'q-2', at: '2026-11-01T10:01:00.000Z', who: 'a.architect', kind: 'open-question', question: 'Is claims handling in scope?', why: 'Unclear.', fields: ['background.problem'] },
    { id: 'a-1', at: '2026-11-01T10:02:00.000Z', who: 'a.architect', kind: 'answer', question: 'Is claims handling in scope?', answer: ['Yes'], resolves: 'q-2', fields: ['background.problem'] },
    { id: 'q-3', at: '2026-11-01T10:03:00.000Z', who: 'a.architect', kind: 'open-question', question: 'When does it go live?', why: 'No date yet.', fields: ['background.problem'] },
  ],
})

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    // Short enough that the Fields scroll.
    const page = await browser.newPage({ viewport: { width: 1300, height: 700 } })
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

const toggle = (page) => page.getByTestId('reference-toggle')
const pressed = async (page) => (await toggle(page).getAttribute('aria-pressed')) === 'true'
const fields = (page) => page.locator('main#modules')
const panels = (page) => page.getByTestId('reference-panels')
const saveButton = (page) => page.locator('.toolbar button[aria-label="Save"]')
const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY))
const settle = (page) => page.waitForTimeout(150)

// The toggle where the brief puts it, off, with its count, and each side shown alone.
async function assertOffThenOn(page, { count }) {
  await toggle(page).waitFor()
  assert.equal(
    await toggle(page).evaluate((el) => el.previousElementSibling?.classList.contains('stage-navigation')),
    true,
    'immediately to the right of Navigation'
  )
  assert.equal(await pressed(page), false, 'off on every page load')
  assert.equal(await toggle(page).isDisabled(), false)
  await page.getByTestId('reference-count').waitFor()
  assert.match(await page.getByTestId('reference-count').textContent(), new RegExp(`^${count}`))
  assert.match(await toggle(page).textContent(), /Sources & decisions/)

  // Off: the Fields (with the insert bar above them) and nothing of the three panels.
  assert.equal(await fields(page).isVisible(), true)
  assert.equal(await page.getByTestId('top-insert').isVisible(), true)
  assert.equal(await panels(page).isVisible(), false)
  for (const id of ['source-documents', 'decisions-log-panel']) assert.equal(await page.getByTestId(id).isVisible(), false, `${id} is out of sight`)

  // On, with the keyboard: only the three panels, in their order, under the toolbar.
  await toggle(page).focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-testid="reference-toggle"]').getAttribute('aria-pressed') === 'true')
  await page.getByTestId('decisions-log-panel').waitFor()
  assert.equal(await page.getByTestId('source-documents').isVisible(), true)
  assert.equal(await fields(page).isVisible(), false, 'no Modules, Field editors, insert bars or status panels')
  assert.equal(await page.locator('.module').first().isVisible(), false)
  assert.equal(await page.getByTestId('top-insert').isVisible(), false)
  assert.deepEqual(
    await panels(page).evaluate((el) => [...el.querySelectorAll('[data-testid="source-documents"], [data-testid="review-copies-panel"], [data-testid="decisions-log-panel"]')].map((n) => n.dataset.testid)),
    ['source-documents', 'decisions-log-panel']
  )
  assert.equal(
    await panels(page).evaluate((el) => el.previousElementSibling?.classList.contains('toolbar')),
    true,
    'directly under the toolbar'
  )
  assert.match(await page.getByTestId('decisions-open').textContent(), /Open questions \(2\)/)

  // Space switches it back off.
  await page.keyboard.press('Space')
  await page.waitForFunction(() => document.querySelector('[data-testid="reference-toggle"]').getAttribute('aria-pressed') === 'false')
  await fields(page).waitFor()
  assert.equal(await panels(page).isVisible(), false)
}

// An edit survives switching on and off twice, the Save button says so throughout, and it saves. Then the Fields come back where they were
// left, and Navigation goes from the panels to a Field.
async function assertEditsScrollAndNavigation(page, readSaved) {
  const editor = page.locator('main#modules .cm-content').first()
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(` ${MARKER}`)
  await page.waitForFunction(() => !document.querySelector('.toolbar button[aria-label="Save"]').disabled)
  for (let i = 0; i < 2; i++) {
    await toggle(page).click()
    await panels(page).waitFor()
    assert.equal(await saveButton(page).isEnabled(), true, 'unsaved changes, with the Fields out of sight')
    await toggle(page).click()
    await fields(page).waitFor()
    assert.equal(await saveButton(page).isEnabled(), true, 'unsaved changes, with the Fields back')
  }
  assert.match(await editor.textContent(), new RegExp(MARKER))
  await saveButton(page).click()
  await page.waitForFunction(() => document.querySelector('.toolbar button[aria-label="Save"]').classList.contains('ghost'), null, { timeout: 15_000 })
  assert.match(await readSaved(), new RegExp(MARKER), 'the edit was saved')

  // Switching back returns to the place in the Fields that was left.
  await page.evaluate(() => window.scrollTo(0, 900))
  await settle(page)
  const left = await scrollY(page)
  assert.ok(left > 300, `the Fields scroll (${left})`)
  await toggle(page).click()
  await panels(page).waitFor()
  await settle(page)
  // The page is shorter now: the panels sit right under the toolbar, in view, wherever the Fields were scrolled to.
  assert.equal(
    await panels(page).evaluate((el) => {
      const top = el.getBoundingClientRect().top
      return top >= document.querySelector('.toolbar').getBoundingClientRect().bottom - 1 && top < window.innerHeight / 2
    }),
    true,
    'the panels come up under the toolbar'
  )
  await toggle(page).click()
  await fields(page).waitFor()
  await settle(page)
  assert.ok(Math.abs((await scrollY(page)) - left) <= 2, `back at ${left}, not ${await scrollY(page)}`)

  // Choosing a Field from Navigation while on switches it off and goes to that Field.
  await page.evaluate(() => window.scrollTo(0, 0))
  await toggle(page).click()
  await panels(page).waitFor()
  await page.getByRole('button', { name: 'Navigation' }).click()
  const item = page.locator('.stage-navigation [role="menuitem"].nav-item-h3').nth(3)
  const label = (await item.textContent()).trim()
  await item.click()
  await fields(page).waitFor()
  assert.equal(await pressed(page), false)
  await page.waitForFunction(
    (text) => {
      const heading = [...document.querySelectorAll('main#modules h3')].find((h) => h.textContent.trim() === text)
      const top = heading?.getBoundingClientRect().top
      return top !== undefined && top >= -2 && top < window.innerHeight / 2
    },
    label,
    { timeout: 5_000 }
  )
}

function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}

test('server workspace: Sources & decisions sits right of Navigation, counts what needs attention, and swaps the Fields for the reference panels without losing an edit', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-320-e2e-'))
  try {
    createInstance('design', SLUG, { instancesDir })
    await withRunningServer({ slug: SLUG, instancesDir }, (base) =>
      withPage(async (page) => {
        const folder = instanceFolder(instancesDir)
        mkdirSync(join(folder, 'interview'), { recursive: true })
        writeFileSync(join(folder, 'interview', 'shape.yaml'), LOG)
        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        await assertOffThenOn(page, { count: 2 })
        await assertEditsScrollAndNavigation(page, async () =>
          readdirSync(join(folder, 'modules'))
            .map((f) => readFileSync(join(folder, 'modules', f), 'utf8'))
            .join('\n')
        )

        // A fresh load starts off again: it is not remembered.
        await toggle(page).click()
        await panels(page).waitFor()
        await page.reload()
        await page.waitForSelector('.module', { timeout: 15_000 })
        assert.equal(await pressed(page), false)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('local workspace: the same toggle, reading the decisions log and saving through the folder', async () => {
  await withRunningServer({}, (base) =>
    withPage(async (page) => {
      const slug = 'local-reference'
      await page.goto(`${base}/settings`)
      const workspaceId = await page.evaluate(
        async ({ slug, log }) => {
          const { rememberWorkspace } = await import('/lib/localWorkspace.js')
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('local-ws-' + Date.now(), { create: true })
          const instanceDir = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle(slug, { create: true })
          const put = async (parent, name, text) => {
            const w = await (await parent.getFileHandle(name, { create: true })).createWritable()
            await w.write(text)
            await w.close()
          }
          await put(instanceDir, 'instance.yaml', `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 3\n`)
          await put(await instanceDir.getDirectoryHandle('interview', { create: true }), 'shape.yaml', log)
          return rememberWorkspace({ handle: dir, name: 'Local Reference Workspace' })
        },
        { slug, log: LOG }
      )
      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 15_000 })
      await assertOffThenOn(page, { count: 2 })
      await assertEditsScrollAndNavigation(page, () =>
        page.evaluate(
          async ({ id, slug }) => {
            const { getWorkspaceHandle, readTextFile, listDir } = await import('/lib/localWorkspace.js')
            const handle = await getWorkspaceHandle(id)
            const names = (await listDir(handle, `gantry-workspace/${slug}/modules`)).map((e) => e.name)
            return (await Promise.all(names.map((n) => readTextFile(handle, `gantry-workspace/${slug}/modules/${n}`)))).join('\n')
          },
          { id: workspaceId, slug }
        )
      )
    })
  )
})

test('a citation of a Source document switches the toggle on and goes to the Source documents', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-320-e2e-'))
  try {
    createInstance('design', SLUG, { instancesDir })
    await withRunningServer({ slug: SLUG, instancesDir }, (base) =>
      withPage(async (page) => {
        const folder = instanceFolder(instancesDir)
        const sources = join(folder, 'sources')
        mkdirSync(sources, { recursive: true })
        writeFileSync(join(sources, 'Notes.txt'), 'Workshop notes.\n')
        writeFileSync(join(sources, 'manifest.yaml'), `- id: notes\n  filename: Notes.txt\n  title: Workshop notes\n  uploadedBy: a.architect\n  uploadedAt: 2026-11-01T00:00:00.000Z\n  size: 16\n`)
        const background = join(folder, 'modules', 'background.md')
        const text = readFileSync(background, 'utf8')
        const cited = text.replace(/\n## Affected domains/, '\nClaims take 12 days [Workshop notes](source:notes).\n\n## Affected domains')
        assert.notEqual(cited, text)
        writeFileSync(background, cited)

        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        assert.equal(await pressed(page), false)
        assert.equal(await page.locator('[data-testid="reference-count"]').count(), 0, 'nothing waiting, so no count')
        const citation = page.locator('.cm-vsource[data-source-id="notes"]').first()
        await citation.waitFor({ timeout: 15_000 })
        await citation.locator('span').first().click()
        await page.waitForFunction(() => document.querySelector('[data-testid="reference-toggle"]').getAttribute('aria-pressed') === 'true')
        await page.getByTestId('source-documents').waitFor()
        await settle(page)
        assert.equal(await fields(page).isVisible(), false)
        assert.equal(
          await page.getByTestId('source-documents-section').evaluate((el) => Math.abs(el.getBoundingClientRect().top - document.querySelector('.toolbar').offsetHeight) <= 2 || el.getBoundingClientRect().top >= 0),
          true,
          'the Source documents are in view'
        )
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('GitLab workspace: with no Source documents, Reviewed copy or decisions, the toggle is disabled and says there is nothing here yet', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-320-e2e-'))
  const root = `gantry-workspace/${SLUG}`
  try {
    await withRunningServerForProvider(
      'gitlab',
      { options: { instancesDir }, fakeServerOptions: { files: { [`/${root}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` } } },
      async ({ gantryBase: base, providerBaseUrl }) => {
        registerInstance(SLUG, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
        await withPage(async (page) => {
          await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), GITLAB_VALID_PAT)
          await page.goto(`${base}/instance/${SLUG}`)
          await page.waitForSelector('.module', { timeout: 30_000 })
          await toggle(page).waitFor()
          await page.waitForFunction(() => document.querySelector('[data-testid="reference-toggle"]').disabled)
          assert.match(await toggle(page).getAttribute('title'), /Nothing here yet/)
          assert.equal(await pressed(page), false)
          assert.equal(await page.locator('[data-testid="reference-count"]').count(), 0)
          assert.equal(await fields(page).isVisible(), true)
        })
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
