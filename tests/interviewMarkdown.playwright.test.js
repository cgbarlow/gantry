import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'

// #347: the AI interview's thread draws the AI's replies as Markdown, with the module editor's preview (web/lib/markdownPreview.js). A real
// server and relay, a real Chromium page and a stand-in for Anthropic on the three-Stage trio, whose Instance has two Source documents, one
// of them removed. The AI's first reply is the issue's SOAP example and more: a heading, a table, citations of both documents, a fenced code
// block, a Mermaid diagram and markup that must not run. It arrives in three pieces, and stops part-way through the code block for a while
// so the test can look at the thread mid-fence. Which messages are drawn as Markdown is covered under node --test in
// tests/interviewThread.test.js, and the drawing step by step in tests/markdownPreview.test.js; this is the screen.

const SLUG = 'markdown-test'
const NOTES_TEXT = 'Workshop notes: the storage decision is still open.\n'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const event = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

const SOAP_REPLY = `Every Field the sources support is now drafted in the preview, and nothing is saved yet.

- **Your answers:** the Fields they feed are redrafted. The storage answer was "Whichever of the two that gantry now supports is in scope".
- **Open questions:** the table has Q1 to Q10.
- **Warning:** Gantry flagged the year "2027" in Sequencing as unsourced.

Five things in the drafts are worth a check:
- **Azure Files:** the Azure Files and Azure Blob question stays open (Q1).
- **Registry connection:** the release pipeline still has a \`<set-me>\` registry connection placeholder, which I didn't draft into any Field.

Is there anything you want to change before the stage-end card?`

// The first reply, in the pieces it arrives in. The second piece ends inside an unclosed fence.
const PIECES = [
  `${SOAP_REPLY}\n\n### Where it comes from\n\nThe storage question is open [Workshop notes, p. 2](source:notes). The old plan said otherwise [Old plan](source:old-plan). More at [the Gantry site](https://example.com/gantry).\n\n| Question | Status | Owner | Where it was raised | What is still needed |\n| - | - | - | - | - |\n| Q1 storage-account-replication-strategy | Open | Infrastructure-architecture-guild | Workshop-notes-page-two | A-decision-from-the-infrastructure-lead |\n\n`,
  '```yaml\nregistry: <set-me>\n',
  '```\n\n<script>window.__pwned = true</script>\n\n[a bad link](javascript:window.__pwned=true) and <img src="x" onerror="window.__pwned = true">\n\n```mermaid\ngraph TD\n  A[Brief] --> B[Draft]\n```\n\nThat is all for now.',
]

// The stand-in. A fresh interview's first request answers with PIECES, waiting `pauseMs` after the unclosed fence; every later request answers
// with a short sentence.
function withMarkdownAnthropic({ pauseMs = 2500 } = {}, fn) {
  const posts = []
  const upstream = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-small', max_input_tokens: 200000 }] }))
        return
      }
      const body = JSON.parse(raw)
      posts.push(body)
      const fresh = body.messages.length === 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      event(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
      event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (const [i, text] of (fresh ? PIECES : ['Noted.']).entries()) {
        event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        if (fresh && i === 1) await wait(pauseMs)
        else if (fresh) await wait(150)
      }
      event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      event(res, 'message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${upstream.address().port}`, { posts })
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        upstream.close()
      }
    })
  })
}

const seed = (page, aiBase) => {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [{ id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, test: passed }]
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}

async function withTrio(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-347-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    // Two Source documents: Workshop notes, and an Old plan that was removed. Starting the server moves the Instance into its workspace folder.
    const sourcesDir = join(instancesDir, SLUG, 'sources')
    mkdirSync(sourcesDir, { recursive: true })
    writeFileSync(join(sourcesDir, 'Notes.txt'), NOTES_TEXT)
    writeFileSync(
      join(sourcesDir, 'manifest.yaml'),
      stringifyYAML([
        { id: 'notes', filename: 'Notes.txt', title: 'Workshop notes', uploadedBy: 'a.architect', uploadedAt: '2026-11-01T09:30:00.000Z', size: NOTES_TEXT.length },
        { id: 'old-plan', filename: 'Old plan.pdf', title: 'Old plan', uploadedBy: 'a.architect', uploadedAt: '2026-10-15T00:00:00.000Z', size: 100, removedBy: 'a.architect', removedAt: '2026-10-20T00:00:00.000Z' },
      ])
    )
    await withMarkdownAnthropic({}, (aiBase, ai) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
        const page = await context.newPage()
        page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await seed(page, aiBase)
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await fn({ page, ai })
      })
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const reply = (page) => page.locator('[data-testid="interview-msg"][data-who="ai"]').first()

test("an AI reply is formatted, part-way through a fence included; its citation opens the Source document; nothing in it runs; the architect's message stays as typed", async () => {
  await withTrio(async ({ page, ai }) => {
    await page.click('[data-testid="interview-start"]')

    // Part-way: the reply is formatted as it arrives, the unclosed fence is code so far, the status line is up, and no diagram is drawn yet.
    await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"].streaming pre > code.language-yaml')
    const midway = reply(page)
    assert.match(await midway.locator('pre > code.language-yaml').textContent(), /^registry: <set-me>\n?$/)
    assert.equal(await midway.locator('ul').count(), 2)
    assert.equal(await page.locator('[data-testid="interview-status"]').count(), 1, 'the status line is still there')
    assert.equal(await midway.locator('figure.mermaid-diagram').count(), 0)

    // Finished: rendered in full.
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
    const done = reply(page)
    assert.equal(await done.evaluate((el) => el.classList.contains('streaming')), false)
    // The issue's example: two bulleted lists with bold labels, separate paragraphs, and <set-me> as inline code, shown literally.
    const lists = await done.locator(':scope > ul').evaluateAll((uls) => uls.map((ul) => [...ul.querySelectorAll(':scope > li > strong')].map((s) => s.textContent)))
    assert.deepEqual(lists, [['Your answers:', 'Open questions:', 'Warning:'], ['Azure Files:', 'Registry connection:']])
    const paragraphs = await done.locator(':scope > p').allTextContents()
    assert.equal(paragraphs[0], 'Every Field the sources support is now drafted in the preview, and nothing is saved yet.')
    assert.ok(paragraphs.includes('Five things in the drafts are worth a check:'))
    assert.ok(paragraphs.includes('Is there anything you want to change before the stage-end card?'))
    assert.equal(await done.locator('li code').textContent(), '<set-me>')
    // A heading, a table and the fenced code block, closed now; no raw Markdown is left.
    assert.equal(await done.locator('h3').textContent(), 'Where it comes from')
    assert.equal(await done.locator('table td').first().textContent(), 'Q1 storage-account-replication-strategy')
    assert.equal(await done.locator('pre > code.language-yaml').textContent(), 'registry: <set-me>\n')
    const text = await done.textContent()
    for (const raw of ['**', '### ', '| - |', '```', '](source:']) assert.ok(!text.includes(raw), `no raw ${raw}`)

    // The Mermaid fence is drawn as a diagram once the reply has finished.
    await done.locator('figure.mermaid-diagram svg').waitFor()

    // Nothing in the reply runs: no script, no javascript: link, no event handler, and the page's own state is untouched.
    assert.equal(await done.locator('script').count(), 0)
    assert.equal(await done.locator('a[href^="javascript:"]').count(), 0)
    assert.equal(await done.locator('[onerror]').count(), 0)
    assert.equal(await page.evaluate(() => window.__pwned), undefined)
    // Every other link opens in a new tab, as it does everywhere rendered Markdown appears.
    assert.equal(await done.locator('a[href="https://example.com/gantry"]').getAttribute('target'), '_blank')

    // The removed document keeps the AI's words, marked removed, and is not a link.
    const removed = done.locator('.source-citation.removed[data-source-id="old-plan"]')
    assert.equal(await removed.textContent(), 'Old plan (removed)')
    assert.equal(await removed.evaluate((el) => el.tagName), 'SPAN')
    assert.match(await removed.getAttribute('title'), /"Old plan" was removed/)

    // The live citation is a link that opens the Source document, in a new tab.
    const citation = done.locator('a.source-citation[data-source-id="notes"]')
    assert.equal(await citation.textContent(), 'Workshop notes, p. 2')
    assert.equal(await citation.getAttribute('title'), 'Open the Source document "Workshop notes"')
    const [opened] = await Promise.all([page.context().waitForEvent('page'), citation.click()])
    await opened.waitForLoadState()
    assert.match(opened.url(), /^blob:/)
    assert.equal(await opened.locator('body').innerText(), NOTES_TEXT)
    await opened.close()
    assert.equal(await page.locator('[data-testid="interview-cite-error"]').count(), 0)

    // The architect's own message is shown exactly as typed.
    const typed = '**not bold** and `not code`, with a [link](source:notes)'
    await page.fill('[data-testid="interview-chat"]', typed)
    await page.click('[data-testid="interview-send"]')
    const you = page.locator('[data-testid="interview-msg"][data-who="you"]').last()
    await you.waitFor()
    assert.equal(await you.textContent(), typed)
    assert.equal(await you.evaluate((el) => el.children.length), 0, 'plain text, no formatting')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]').length === 2)
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
    assert.equal(await page.locator('[data-testid="interview-msg"][data-who="ai"]').last().textContent(), 'Noted.')
    assert.equal(ai.posts.length, 2)
  })
})

test('at phone width a wide table and a code block scroll within the reply, and the thread does not scroll sideways', async () => {
  await withTrio(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached', timeout: 60_000 })
    const done = reply(page)
    await done.locator('table').waitFor()
    const sizes = await page.evaluate(() => {
      const msg = document.querySelector('[data-testid="interview-msg"][data-who="ai"]')
      const thread = document.querySelector('[data-testid="interview-thread"]')
      const table = msg.querySelector('table')
      const pre = msg.querySelector('pre')
      return { msg: [msg.scrollWidth, msg.clientWidth], thread: [thread.scrollWidth, thread.clientWidth], table: [table.scrollWidth, table.clientWidth], overflow: getComputedStyle(table).overflowX, code: getComputedStyle(pre).overflowX }
    })
    assert.ok(sizes.table[0] > sizes.table[1], `the table is wider than the reply and scrolls: ${sizes.table}`)
    assert.equal(sizes.overflow, 'auto')
    assert.equal(sizes.code, 'auto', 'a long line of code scrolls within its block')
    assert.ok(sizes.msg[0] <= sizes.msg[1], `the reply itself does not overflow: ${sizes.msg}`)
    assert.ok(sizes.thread[0] <= sizes.thread[1], `the thread does not scroll sideways: ${sizes.thread}`)
  })
})
