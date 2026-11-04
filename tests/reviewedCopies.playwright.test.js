import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'
import { RENDER_PROPERTIES, reviewedCopy } from './helpers/reviewedCopyFixture.js'

// #302 (ADR-0066): browser coverage for bringing a Reviewed copy in and reading its comments back. The
// header's "Bring in review comments" reads the chosen Word files with Gantry's own reader, refuses any that
// are not this Instance's renders (an untagged document, another Instance's), and keeps the rest; the
// editor then lists each copy's threads by Field, read-only. tests/reviewedCopy.test.js covers the reader
// and tests/reviewsServer.test.js the storage and every Provider.

const SLUG = 'acme'
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const word = (name, buffer) => ({ name, mimeType: WORD, buffer })

// A `background` module whose Fields hold the wording the fixture documents were "rendered" from, so a
// copy that has lost its Field bookmarks can be placed by matching text.
const BACKGROUND = `---
module: background
status: draft
owner: ""
---

# Background and context

## Problem statement

We need a new payments platform.

It must support card schemes.

## Opportunity

Reduce cost per transaction.

## Success criteria

Payments Engineering
`

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

// Opens the dialog, offers two documents that must be refused, then two that are accepted, and brings those in.
async function bringInTwoCopies(page) {
  await page.getByTestId('bring-in-review-comments').click()
  const dialog = page.locator('.modal[aria-label="Bring in review comments"]')
  await dialog.waitFor({ state: 'visible' })
  const input = dialog.getByTestId('review-file-input')

  await input.setInputFiles([
    word('plain.docx', reviewedCopy({ properties: {} })),
    word('globex.docx', reviewedCopy({ properties: { ...RENDER_PROPERTIES, instance: 'globex', stage: 'build' } })),
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  ])
  const rows = dialog.locator('[data-testid="review-import-list"] li')
  await rows.nth(2).waitFor()
  assert.deepEqual(await rows.evaluateAll((els) => els.map((el) => [el.dataset.ok, el.dataset.code])), [
    ['false', 'untagged'],
    ['false', 'other-instance'],
    ['false', 'not-word'],
  ])
  assert.match(await rows.nth(0).textContent(), /Upload it as a Source document instead/)
  assert.match(await rows.nth(1).textContent(), /Instance "globex", Artefact "hld", Stage "build"/)
  assert.equal(await dialog.getByTestId('review-bring-in').isDisabled(), true, 'nothing acceptable to bring in')

  await input.setInputFiles([
    word('HLD - word.docx', reviewedCopy({ kind: 'word', properties: { ...RENDER_PROPERTIES, instance: SLUG } })),
    word('HLD - google.docx', reviewedCopy({ kind: 'google', properties: { ...RENDER_PROPERTIES, instance: SLUG } })),
  ])
  await dialog.locator('[data-testid="review-import-list"] li[data-ok="true"]').nth(1).waitFor()
  assert.match(await dialog.locator('[data-testid="review-import-list"] li').first().textContent(), /8 comment threads and 3 tracked changes from Ana Reviewer, Ben Commenter/)
  await dialog.getByTestId('review-bring-in').click()
  await dialog.getByTestId('review-import-done').waitFor()
  assert.match(await dialog.getByTestId('review-import-done').textContent(), /Brought in 2 Reviewed copies/)
  await dialog.getByRole('button', { name: 'Close' }).click()
}

const copyNamed = (page, name) => page.locator('[data-testid="review-copy"]').filter({ has: page.getByRole('heading', { name, exact: true }) })
const groupOf = (copy, field) => copy.locator(`[data-testid="review-group"][data-field="${field}"]`)

// What the editor shows of each copy: the Word-saved one placed by its bookmarks, the Google-exported
// one by matching text, and the notice that says so.
async function assertCopiesListed(page) {
  await showSourcesAndDecisions(page)
  const panel = page.getByTestId('review-copies-panel')
  await panel.waitFor()
  assert.equal(await panel.locator('[data-testid="review-copy"]').count(), 2)

  const saved = copyNamed(page, 'HLD - word.docx')
  assert.equal(await saved.getByTestId('review-notice').count(), 0, 'placed by bookmarks, so nothing to say about text matching')
  const problem = groupOf(saved, 'background.problem')
  assert.match(await problem.locator('h4').textContent(), /Background and context › Problem statement/)
  const which = problem.locator('[data-testid="review-thread"]').filter({ hasText: 'Which card schemes?' })
  assert.equal(await which.getAttribute('data-resolved'), 'true')
  assert.match(await which.textContent(), /Visa and Mastercard\./)
  assert.match(await which.textContent(), /Resolved/)
  assert.match(await which.locator('.review-anchor').textContent(), /new payments platform/)
  assert.match(await problem.locator('[data-testid="review-thread"]').filter({ hasText: 'Say who signs this off' }).textContent(), /Also runs into Opportunity/)
  assert.deepEqual(await problem.locator('[data-testid="review-change"]').evaluateAll((els) => els.map((el) => el.dataset.kind)), ['deletion', 'insertion'])
  assert.equal(await groupOf(saved, 'background.opportunity').locator('[data-testid="review-change"]').count(), 1)
  const aboutDocument = saved.locator('[data-testid="review-group"][data-kind="document"]')
  assert.match(await aboutDocument.textContent(), /About the document/)
  assert.match(await aboutDocument.textContent(), /Put the date on the cover/)
  assert.match(await aboutDocument.textContent(), /Is this the right version\?/)
  assert.match(await aboutDocument.textContent(), /Why is this here\?/)

  const exported = copyNamed(page, 'HLD - google.docx')
  assert.match(await exported.getByTestId('review-notice').textContent(), /bookmarks were lost.*matching their text against today's content/is)
  assert.match(await groupOf(exported, 'background.problem').textContent(), /Say who signs this off/)
  assert.match(await groupOf(exported, 'background.success-criteria').textContent(), /Add the team/)
  assert.match(await exported.locator('[data-testid="review-group"][data-kind="unplaced"]').textContent(), /Rename to Purpose/)
}

test('server workspace: refuses documents that are not this Instance\'s renders, keeps the rest, and lists their threads by Field', async () => {
  await withScratchInstances((instancesDir) =>
    withRunningServer({ instancesDir }, async (base) => {
      const created = await fetch(`${base}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: 'design', slug: SLUG }) })
      assert.equal(created.status, 201)
      const folder = join(instancesDir, 'default', SLUG)
      mkdirSync(join(folder, 'modules'), { recursive: true })
      writeFileSync(join(folder, 'modules', 'background.md'), BACKGROUND)

      await withPage(async (page) => {
        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('.module')
        assert.equal(await page.getByTestId('review-copies-panel').count(), 0, 'nothing to list until a copy is brought in')

        await bringInTwoCopies(page)
        await assertCopiesListed(page)

        // Kept with the Instance, listed in the manifest.
        const files = readdirSync(join(folder, 'reviews'))
        assert.equal(files.length, 3)
        const manifest = parseYAML(readFileSync(join(folder, 'reviews', 'manifest.yaml'), 'utf8'))
        assert.deepEqual(manifest.map((m) => m.name), ['HLD - word.docx', 'HLD - google.docx'])
        assert.deepEqual(manifest.map((m) => m.commentsAnswered), [0, 0])

        // And still there after a reload.
        await page.reload()
        await page.waitForSelector('.module')
        await assertCopiesListed(page)
      })
    })
  )
})

test('Local workspace: the same dialog writes the copy and the manifest into the folder, and the editor lists the threads', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(
        async ({ files }) => {
          const { rememberWorkspace } = await import('/lib/localWorkspace.js')
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('local-ws-' + Date.now(), { create: true })
          for (const [path, content] of Object.entries(files)) {
            const parts = path.split('/')
            const name = parts.pop()
            let d = dir
            for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
            const writable = await (await d.getFileHandle(name, { create: true })).createWritable()
            await writable.write(content)
            await writable.close()
          }
          return rememberWorkspace({ handle: dir, name: 'Local Reviews' })
        },
        {
          files: {
            [`gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 3\n`,
            [`gantry-workspace/${SLUG}/modules/background.md`]: BACKGROUND,
          },
        }
      )
      await page.goto(`${base}/instance/${SLUG}?local=${workspaceId}`)
      await page.waitForSelector('.module')

      await page.getByTestId('bring-in-review-comments').click()
      const dialog = page.locator('.modal[aria-label="Bring in review comments"]')
      const input = dialog.getByTestId('review-file-input')
      await input.setInputFiles([word('plain.docx', reviewedCopy({ properties: {} }))])
      await dialog.locator('[data-testid="review-import-list"] li').first().waitFor()
      assert.match(await dialog.locator('[data-testid="review-import-list"] li').first().textContent(), /Source document/)
      assert.equal(await dialog.getByTestId('review-bring-in').isDisabled(), true)

      await input.setInputFiles([word('HLD - word.docx', reviewedCopy({ kind: 'word', properties: { ...RENDER_PROPERTIES, instance: SLUG } }))])
      await dialog.locator('li[data-ok="true"]').waitFor()
      await dialog.getByTestId('review-bring-in').click()
      await dialog.getByTestId('review-import-done').waitFor()
      assert.match(await dialog.getByTestId('review-import-done').textContent(), /workspace folder/)
      await dialog.getByRole('button', { name: 'Close' }).click()

      // #320: behind Sources & decisions, which counts the seven threads not resolved in Word.
      await page.getByTestId('reference-count').waitFor()
      assert.match(await page.getByTestId('reference-count').textContent(), /^7/)
      await showSourcesAndDecisions(page)
      const copy = copyNamed(page, 'HLD - word.docx')
      await copy.waitFor()
      assert.equal(await copy.getByTestId('review-notice').count(), 0)
      assert.match(await groupOf(copy, 'background.problem').textContent(), /Which card schemes\?/)

      // The folder holds the file and the manifest, written by the browser.
      const kept = await page.evaluate(async ({ id, slug }) => {
        const { getWorkspaceHandle, readTextFile, listDir } = await import('/lib/localWorkspace.js')
        const handle = await getWorkspaceHandle(id)
        const entries = (await listDir(handle, `gantry-workspace/${slug}/reviews`)).map((e) => e.name).sort()
        return { entries, manifest: await readTextFile(handle, `gantry-workspace/${slug}/reviews/manifest.yaml`) }
      }, { id: workspaceId, slug: SLUG })
      const manifest = parseYAML(kept.manifest)
      assert.equal(manifest.length, 1)
      assert.equal(manifest[0].artefact, 'hld')
      assert.equal(manifest[0].renderId, RENDER_PROPERTIES['render-id'])
      assert.deepEqual(kept.entries, [`${manifest[0].id}.docx`, 'manifest.yaml'].sort())

      await page.reload()
      await showSourcesAndDecisions(page)
      await copyNamed(page, 'HLD - word.docx').waitFor()
    })
  })
})
