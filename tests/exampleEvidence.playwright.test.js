import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningExamplesServer } from './helpers/lifecycle.js'
import { unzip } from './helpers/reviewedCopyFixture.js'

// #310 (map #238): the bundled `kiwi-cover-mutual` example shows the AI interview's evidence in the app: its Source documents (which can be
// downloaded as a pack), the citations in its content, a decisions log on its first Stage, and a Reviewed copy with its comments answered.
// tests/exampleEvidence.test.js checks the files are true to the content; this checks they show.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true })
    page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

test('the example’s Source documents, citations, decisions log and Reviewed copy show in the editor, and the pack downloads as one zip', async () => {
  await withRunningExamplesServer({}, (base) =>
    withPage(async (page) => {
      await page.goto(`${base}/instance/examples`)
      await page.waitForSelector('.module', { timeout: 30_000 })

      // Citations in the content are drawn by what they cite, and each opens its document.
      const cited = page.locator('.cm-vsource[data-source-id="client-brief"]').first()
      await cited.waitFor({ timeout: 30_000 })
      assert.match(await cited.textContent(), /Client brief, p\. 1/)
      assert.equal(await page.locator('.cm-vsource-removed, .cm-vsource-missing').count(), 0, 'every citation names a document in the pack')

      // The Source documents are listed with their text read.
      const panel = page.locator('[data-testid="source-documents"]')
      await panel.waitFor()
      if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
      const rows = panel.locator('tr[data-source-id]')
      await rows.nth(3).waitFor()
      assert.deepEqual(await rows.evaluateAll((els) => els.map((el) => el.dataset.sourceId)), ['client-brief', 'requirements-register', 'design-workshop-notes', 'claim-registration-screen'])
      assert.equal(await panel.locator('.stamp.agreed').count(), 3, 'three have their text read')
      assert.equal(await panel.locator('.stamp.review', { hasText: 'NO TEXT' }).count(), 1, 'the screenshot has none')
      assert.equal(await panel.locator('[data-testid="source-new-since"]').count(), 0, 'nothing is marked New since last interview')

      // The pack comes down as one zip of the originals.
      const [download] = await Promise.all([page.waitForEvent('download'), panel.locator('[data-testid="source-documents-download-all"]').click()])
      assert.equal(download.suggestedFilename(), 'Kiwi Cover Mutual - Source documents.zip')
      const kept = mkdtempSync(join(tmpdir(), 'gantry-310-'))
      try {
        const saved = join(kept, 'pack.zip')
        await download.saveAs(saved)
        const parts = unzip(readFileSync(saved))
        assert.deepEqual(Object.keys(parts).sort(), ['Claim registration screen.png', 'Client brief.pdf', 'Design workshop notes.docx', 'Requirements register.xlsx'])
        for (const name of Object.keys(parts)) assert.deepEqual(Buffer.compare(parts[name], readFileSync(join(EXAMPLE, 'sources', name))), 0, `${name} is the original, byte for byte`)
      } finally {
        rmSync(kept, { recursive: true, force: true })
      }
      assert.match(await panel.locator('[data-testid="source-documents-message"]').textContent(), /Saved 4 documents/)

      // The first Stage has a decisions log, read-only, with its open questions called out.
      const log = page.locator('[data-testid="decisions-log-panel"]')
      await log.waitFor()
      assert.match(await log.textContent(), /Median 12\.4 working days, from the Client brief/)
      assert.match(await log.locator('[data-testid="decisions-open"]').textContent(), /Open questions \(3\)/)
      assert.equal(await log.locator('input, textarea').count(), 0)

      // The Reviewed copy lists its four threads by Field, all answered.
      const review = page.locator('[data-testid="review-copies-panel"]')
      await review.waitFor()
      assert.match(await review.locator('[data-testid="review-copy"] h3').textContent(), /Full Solution on a Page \(reviewed\)/)
      assert.equal(await review.locator('[data-testid="review-thread"]').count(), 4)
      assert.equal(await review.locator('[data-testid="review-change"]').count(), 1)
      assert.ok(await review.locator('[data-testid="review-response-download"]').isVisible(), 'the Review response list is offered')
      const [list] = await Promise.all([page.waitForEvent('download'), review.locator('[data-testid="review-response-download"]').click()])
      assert.match(list.suggestedFilename(), /Review response list\.docx$/)
    })
  )
})

test('the Interview page lists the pack and counts the Stage’s decisions', async () => {
  await withRunningExamplesServer({}, (base) =>
    withPage(async (page) => {
      await page.goto(`${base}/instance/examples?interview=1`)
      const sources = page.locator('[data-testid="source-documents-compact"]')
      await sources.waitFor({ timeout: 30_000 })
      await sources.locator('li[data-source-id]').nth(3).waitFor()
      assert.deepEqual(await sources.locator('.srcdoc-title').allTextContents(), ['Client brief', 'Requirements register', 'Design workshop notes', 'Claim registration screen'])
      const count = page.locator('[data-testid="interview-decisions-count"]')
      await count.waitFor()
      assert.ok(Number(await count.textContent()) >= 8, 'the answers, the fact and the open questions of the Stage')
      assert.match(await page.textContent('[data-testid="interview-decisions-open"]'), /3 open questions/)
    })
  )
})
