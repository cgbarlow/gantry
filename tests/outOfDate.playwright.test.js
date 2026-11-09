import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showFields, showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { serializeDecisionsLog } from '../web/lib/decisionsLog.js'
import { wordDocument } from './helpers/sourceFixtures.js'
import { removeCitations } from './helpers/uncite.js'

// #297 (map #238, decided in #249): Fields that drew on a Source document that has since changed are flagged Out of date. The rules are
// covered under node --test in tests/outOfDate.test.js; this is the screen: the "This replaces..." picker, the "replaced by" and "New
// since last interview" marks, the editor banner, the mark on each Field and the Interview page's run plan, on a server workspace.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const SLUG = 'examples'
const docxFile = (name) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(wordDocument()) })
const mdFile = (name, text) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

const openPanel = async (page) => {
  await showSourcesAndDecisions(page)
  const panel = page.locator('[data-testid="source-documents"]')
  await panel.waitFor({ timeout: 15_000 })
  if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
  return panel
}
const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const bannerLines = (page) => page.locator('[data-testid="out-of-date-line"]')

test('server workspace: a replaced, re-read or removed Source document flags exactly the Fields that drew on or cite it', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-297-e2e-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
    rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
    // #310: the example brings its own Source documents, citations and decisions logs; this test starts from none of them.
    for (const folder of ['sources', 'interview', 'reviews']) rmSync(join(instancesDir, SLUG, folder), { recursive: true, force: true })
    removeCitations(join(instancesDir, SLUG))

    await withRunningServer({ slug: SLUG, instancesDir }, (base) =>
      withPage(async (page) => {
        const dir = join(instancesDir, 'default', SLUG)
        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        let panel = await openPanel(page)
        const input = panel.locator('[data-testid="source-documents-input"]')

        // Two documents, uploaded before the interview.
        await input.setInputFiles(docxFile('Client brief.docx'))
        await rowFor(panel, 'Client brief').waitFor()
        await input.setInputFiles(mdFile('Minutes.md', '# Minutes\n\nGo-live is March.\n'))
        await rowFor(panel, 'Minutes').waitFor()
        await pause(30)

        // One Field cites the Client brief by hand; another was drafted by the AI from the Client brief; a third from the Minutes.
        const backgroundFile = join(dir, 'modules', 'background.md')
        const text = readFileSync(backgroundFile, 'utf8')
        const cited = text.replace(/\n## Affected domains/, '\n\nThe platform must support 5000 users [Client brief, p. 1](source:client-brief).\n\n## Affected domains')
        assert.notEqual(cited, text)
        writeFileSync(backgroundFile, cited)
        const draftedAt = new Date().toISOString()
        mkdirSync(join(dir, 'interview'), { recursive: true })
        writeFileSync(
          join(dir, 'interview', 'shape.yaml'),
          serializeDecisionsLog({
            version: 1,
            stage: 'shape',
            status: [{ session: 's-1', who: 'c.barlow', target: 'shape', state: 'done', lastAiSave: draftedAt }],
            fields: {
              'background.affected-domains': { drafted: draftedAt, inputs: [{ source: 'client-brief', title: 'Client brief', range: null, fingerprint: 'x' }], entries: [] },
              'design-basis.assumptions': { drafted: draftedAt, inputs: [{ source: 'minutes', title: 'Minutes', range: null, fingerprint: 'y' }], entries: [] },
            },
            entries: [],
          })
        )
        await pause(30)

        // Nothing has changed yet, so nothing is flagged, and nothing is new since that interview.
        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        panel = await openPanel(page)
        await rowFor(panel, 'Client brief').waitFor()
        await page.waitForTimeout(500)
        assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0)
        assert.equal(await page.locator('[data-testid="field-out-of-date"]').count(), 0)
        assert.equal(await panel.locator('[data-testid="source-new-since"]').count(), 0)

        // Reading a document again to the very same text flags nothing.
        await rowFor(panel, 'Minutes').getByRole('button', { name: 'Extract text again' }).click()
        await page.waitForFunction(() => /Read the text of "Minutes" again/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
        await page.waitForTimeout(500)
        assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0, 'identical text flags nothing')

        // A new document that replaces nothing flags nothing and is New since last interview.
        const input2 = panel.locator('[data-testid="source-documents-input"]')
        await input2.setInputFiles(mdFile('Workshop.md', '# Workshop\n\nA new note.\n'))
        await rowFor(panel, 'Workshop').waitFor()
        await rowFor(panel, 'Workshop').locator('[data-testid="source-new-since"]').waitFor()
        assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0, 'an unlinked new document flags nothing')
        assert.equal(await panel.locator('[data-testid="source-new-since"]').count(), 1)

        // "This replaces…": Client brief v3 replaces the Client brief.
        await panel.locator('[data-testid="source-replaces"]').selectOption({ label: 'This replaces… Client brief' })
        await input2.setInputFiles(docxFile('Client brief v3.docx'))
        const newer = panel.locator('tr[data-source-id="client-brief-v3"]')
        await newer.waitFor()
        const older = panel.locator('tr[data-source-id="client-brief"]')
        await older.locator('[data-testid="source-replaced-by"]').waitFor()
        assert.match(await older.locator('[data-testid="source-replaced-by"]').textContent(), /replaced by Client brief v3/)
        assert.equal(await newer.locator('[data-testid="source-new-since"]').count(), 0, 'a replacement is not "new"')
        const manifest = parseYAML(readFileSync(join(dir, 'sources', 'manifest.yaml'), 'utf8'))
        assert.equal(manifest.find((e) => e.id === 'client-brief-v3').replaces, 'client-brief')
        assert.equal(manifest.find((e) => e.id === 'client-brief').replaces, undefined)

        // The banner, and a mark on each Field that drew on or cites the Client brief (and no other).
        await showFields(page)
        const banner = page.locator('[data-testid="out-of-date-banner"]')
        await banner.waitFor()
        assert.equal(await bannerLines(page).count(), 1)
        assert.match(await bannerLines(page).textContent(), /^2 Fields drew on Client brief, now replaced by Client brief v3:/)
        assert.match(await banner.locator('[data-testid="bring-up-to-date"]').getAttribute('href'), /interview=1/)
        const marks = page.locator('[data-testid="field-out-of-date"]')
        assert.deepEqual(await marks.evaluateAll((els) => els.map((el) => el.dataset.field).sort()), ['background.affected-domains', 'background.problem'])
        assert.match(await marks.first().textContent(), /Out of date: Client brief was replaced by Client brief v3/)

        // Reading the Minutes again to different text flags the Field drafted from them.
        writeFileSync(join(dir, 'sources', 'Minutes.md'), '# Minutes\n\nGo-live moved to June.\n')
        await showSourcesAndDecisions(page)
        await rowFor(panel, 'Minutes').getByRole('button', { name: 'Extract text again' }).click()
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="out-of-date-line"]').length === 2)
        assert.match(await bannerLines(page).nth(1).textContent(), /^1 Field drew on Minutes, now read again with different text:/)
        assert.equal(await marks.count(), 3)

        // Removing it is the more serious change, and replaces that line.
        await rowFor(panel, 'Minutes').getByRole('button', { name: 'Remove' }).click()
        await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
        await page.waitForFunction(() => /Minutes, now removed/.test(document.querySelector('[data-testid="out-of-date-banner"]')?.textContent ?? ''))
        assert.equal(await bannerLines(page).count(), 2)

        // The Interview page marks the run plan's Stages: Shape (it drafted and mounts the cited Module) and HLD define (it mounts the cited Module).
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.locator('[data-testid="run-plan"]').waitFor({ timeout: 15_000 })
        await page.locator('[data-testid="run-plan-out-of-date"]').first().waitFor()
        const rowFlags = await page.locator('[data-testid="run-plan-row"]').evaluateAll((rows) =>
          Object.fromEntries(rows.map((row) => [row.dataset.stageId, row.querySelector('[data-testid="run-plan-out-of-date"]')?.textContent ?? '']))
        )
        assert.match(rowFlags.shape, /^3 Out of date$/)
        assert.match(rowFlags['hld-define'], /^1 Out of date$/)
        assert.equal(rowFlags['detailed-design'], '')

        // #358: in Bring up to date the plan lists the Stages to work through, with their counts, and the one on screen as current. Nothing is
        // a target, and the Stages after it are not struck through as beyond one. HLD define's flagged Field is in a Module Shape mounts too, so
        // it is asked about on Shape, the first Stage that can edit it: HLD define has nothing of its own to bring up to date.
        await page.goto(`${base}/instance/${SLUG}?interview=1&update=1`)
        await page.waitForSelector('[data-testid="run-plan-row"][data-stage-id="shape"][data-state="current"]', { timeout: 15_000 })
        await page.waitForFunction(() => document.querySelector('[data-testid="run-plan-row"][data-stage-id="shape"] .rp-note')?.textContent === 'bringing up to date')
        const plan = await page.locator('[data-testid="run-plan-row"]').evaluateAll((rows) =>
          Object.fromEntries(rows.map((row) => [row.dataset.stageId, [row.dataset.state, row.dataset.target, row.querySelector('.rp-note').textContent, row.querySelector('[data-testid="run-plan-out-of-date"]')?.textContent ?? '']]))
        )
        assert.deepEqual(plan.shape, ['current', 'false', 'bringing up to date', '3 Out of date'])
        assert.deepEqual(plan['hld-define'], ['plain', 'false', '', ''])
        assert.deepEqual(plan['detailed-design'], ['plain', 'false', '', ''])
        assert.equal(await page.locator('.runplan .rp-beyond, .runplan .rp-target').count(), 0)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('local workspace: replacing a Source document flags the Fields that cite it, read through the folder', async () => {
  await withRunningServer({}, (base) =>
    withPage(async (page) => {
      await page.goto(`${base}/settings`)
      const workspaceId = await page.evaluate(async () => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-' + Date.now(), { create: true })
        const instanceDir = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle('local-ood', { create: true })
        const put = async (parent, name, text) => {
          const w = await (await parent.getFileHandle(name, { create: true })).createWritable()
          await w.write(text)
          await w.close()
        }
        await put(instanceDir, 'instance.yaml', 'definition: design\nslug: local-ood\nstage: shape\nassignee: a.architect\ndefinitionVersion: 3\n')
        const modules = await instanceDir.getDirectoryHandle('modules', { create: true })
        await put(
          modules,
          'background.md',
          '---\nmodule: background\nstatus: draft\nowner: a.architect\n---\n# Background and context\n\n## Problem statement\n\nMedian time to payment is 12.4 days [Client brief, p. 1](source:client-brief).\n\n## Affected domains\n\nClaims.\n'
        )
        return rememberWorkspace({ handle: dir, name: 'Local Out of Date Workspace' })
      })
      await page.goto(`${base}/instance/local-ood?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 15_000 })
      const panel = await openPanel(page)
      const input = panel.locator('[data-testid="source-documents-input"]')
      await input.setInputFiles(mdFile('Client brief.md', '# Client brief\n\nMedian time to payment is 12.4 days.\n'))
      await panel.locator('tr[data-source-id="client-brief"]').waitFor()
      await page.waitForTimeout(500)
      assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0, 'nothing has changed yet')

      await panel.locator('[data-testid="source-replaces"]').selectOption({ label: 'This replaces… Client brief' })
      await input.setInputFiles(mdFile('Client brief v2.md', '# Client brief v2\n\nMedian time to payment is 11 days.\n'))
      await panel.locator('tr[data-source-id="client-brief"] [data-testid="source-replaced-by"]').waitFor()
      await showFields(page)
      await page.locator('[data-testid="out-of-date-banner"]').waitFor()
      assert.match(await bannerLines(page).textContent(), /^1 Field drew on Client brief, now replaced by Client brief v2:/)
      assert.deepEqual(await page.locator('[data-testid="field-out-of-date"]').evaluateAll((els) => els.map((el) => el.dataset.field)), ['background.problem'])
    })
  )
})
