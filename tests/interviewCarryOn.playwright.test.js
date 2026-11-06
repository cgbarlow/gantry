import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'

// #345 (parent #343): an AI interview turn that ends with nothing to show says so, with Carry on. A real server and relay, a real Chromium
// page and a stand-in for Anthropic on the three-Stage trio. Its first turn either replies with nothing at all, or keeps calling a read
// tool until the per-turn limit; after the architect's "go on" it takes its time and then writes a sentence, so the status line can be seen
// while it works. What the session says when is covered under node --test in tests/interviewCarryOn.test.js; this is the screen.

const SLUG = 'carry-on-test'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const event = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

// `first`: 'empty' answers with no text and no tool call; 'reads' answers every request with a read until the architect writes "go on".
function withQuietAnthropic({ first = 'empty', delayMs = 1500 } = {}, fn) {
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
      const goOn = JSON.stringify(body.messages).includes('go on')
      if (goOn) await wait(delayMs)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      event(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
      let stop = 'end_turn'
      if (goOn) {
        event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Picking up where I stopped.' } })
        event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      } else if (first === 'reads') {
        event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `r${posts.length}`, name: 'read_source_document', input: {} } })
        event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":"tech-lt"}' } })
        event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        stop = 'tool_use'
      }
      event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } })
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

async function withTrio(options, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-345-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withQuietAnthropic(options, (aiBase, ai) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
        const page = await context.newPage()
        page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await seed(page, aiBase)
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await fn({ page, ai })
      })
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// What the one live region under the thread holds: the status line while the AI is busy, the line's announcement once a turn ends quietly.
const liveRegion = (page) => page.$eval('.interview-status[role="status"]', (el) => el.textContent.trim())

test('a reply with nothing in it: the thread says the AI stopped without replying, and Carry on, by keyboard, sends "go on" and the interview resumes', async () => {
  await withTrio({ first: 'empty' }, async ({ page, ai }) => {
    const line = await page.waitForSelector('[data-testid="interview-msg"][data-carry-on="empty"]')
    assert.match(await line.textContent(), /^The AI stopped without replying\./)
    assert.equal(await page.$('[data-testid="interview-status"]'), null, 'the turn is over, so there is no status line')

    // Announced once, through the live region that held the status line; the thread line itself is not a live region.
    assert.equal(await liveRegion(page), 'The AI stopped without replying. Choose Carry on to let it continue.')
    assert.equal(await line.evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')), null)

    // Reachable by keyboard: a real, enabled button in the tab order, which takes the focus and is pressed with Enter.
    const button = await page.$('[data-testid="interview-carry-on"]')
    assert.equal(await button.evaluate((el) => el.tagName === 'BUTTON' && !el.disabled && el.tabIndex >= 0), true)
    await button.focus()
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'interview-carry-on')
    await page.keyboard.press('Enter')

    // The next turn runs with the status line as usual, and "go on" is the architect's message in the thread and to the AI.
    await page.waitForSelector('[data-testid="interview-status"]')
    assert.match(await page.textContent('[data-testid="interview-status-text"]'), /^Waiting for the AI/)
    assert.equal(await page.$('[data-testid="interview-carry-on"]'), null, 'the button goes once it has been used')
    const you = await page.$$eval('[data-testid="interview-msg"][data-who="you"]', (els) => els.map((e) => e.textContent))
    assert.deepEqual(you, ['go on'])
    await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"]')
    assert.equal(await page.textContent('[data-testid="interview-msg"][data-who="ai"]'), 'Picking up where I stopped.')
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
    assert.equal(await page.$('[data-testid="interview-carry-on"]'), null, 'a turn that replied adds no line')
    assert.equal(await page.$$eval('[data-testid="interview-msg"][data-carry-on]', (els) => els.length), 1, 'the first line stays as a record')
    assert.equal(ai.posts.length, 2)
  })
})

test('an AI that keeps calling a read tool until the per-turn limit: the thread says the rounds were used up, with Carry on', async () => {
  await withTrio({ first: 'reads' }, async ({ page, ai }) => {
    const line = await page.waitForSelector('[data-testid="interview-msg"][data-carry-on="rounds"]')
    assert.match(await line.textContent(), /^The AI used up its 24 rounds of tool calls for this turn and stopped\./)
    assert.equal(await page.$$eval('[data-testid="interview-msg"][data-carry-on]', (els) => els.length), 1)
    assert.equal(ai.posts.length, 24)
    await page.click('[data-testid="interview-carry-on"]')
    await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"]')
    assert.equal(ai.posts.length, 25)
  })
})
